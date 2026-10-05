#!/bin/bash

set -euo pipefail

root=$(cd -P -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

fail() {
    printf 'validate: %s\n' "$*" >&2
    exit 1
}

/bin/bash -n scripts/post-sync
/bin/bash -n tests/validate.sh
/bin/bash -n skills/maintain/scripts/reconcile-branches.sh
/bin/bash -n tests/branch-policy.sh
/bin/bash -n tests/fixtures/race-git.sh
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck --shell=bash scripts/post-sync tests/validate.sh \
        skills/maintain/scripts/reconcile-branches.sh tests/branch-policy.sh \
        tests/fixtures/race-git.sh
fi

# The maintain skill ships the shared branch-namespace script; its contract
# (read-only check, one atomic leased push, undeclared refs unchanged, both
# composition models) is proven against throwaway repositories.
tests/branch-policy.sh

# A maintenance cycle fetches only its preselected upstream object. A broad
# upstream fetch would import a later Main or topic and defeat one-shot scope.
# shellcheck disable=SC2016 # Match the literal documented shell variables.
grep -F 'git -C "$checkout" fetch --no-tags "$upstream_remote" "$cycle_upstream_sha"' \
    skills/maintain/references/fork-maintenance.md >/dev/null \
    || fail "maintain does not fetch the exact captured upstream object"
if grep -Eq 'fetch --no-tags upstream[[:space:]]*$' skills/maintain/references/fork-maintenance.md; then
    fail "maintain still documents a broad moving upstream fetch"
fi

# Every skill ships whole: template, manifest for the agents that read one,
# and the openai.yaml interface card the fleet convention requires.
for skill in domain-modeling email improve-codebase-architecture maintain notify retro writing-for-agents zero-tech-debt; do
    [ -f "skills/$skill/SKILL.md" ] \
        || fail "skill template is missing: skills/$skill/SKILL.md"
    [ -f "skills/$skill/agents/openai.yaml" ] \
        || fail "skill manifest is missing: skills/$skill/agents/openai.yaml"
done
# Complete upstream skills retain their attribution and license in the copied
# resource tree as well as in this source checkout.
for skill in domain-modeling writing-for-agents; do
    [ -s "skills/$skill/LICENSE" ] && [ -s "skills/$skill/UPSTREAM.md" ] \
        || fail "$skill is missing its source attribution or license"
done
# The vendored retro remains attributable and explicit-only after rendering.
[ -s skills/retro/LICENSE ] || fail "retro is missing its upstream license"
grep -F '24fe0ef7737efae15c87225755e9f6f5965e4888' skills/retro/UPSTREAM.md >/dev/null \
    || fail "retro is missing its pinned upstream source"
grep -F 'disable-model-invocation: true' skills/retro/SKILL.md >/dev/null \
    || fail "retro must remain user-invoked"

# The imported architecture skill keeps its source pin, license and explicit invocation.
[ -s skills/improve-codebase-architecture/LICENSE ] \
    || fail "architecture skill is missing its upstream license"
grep -F '24fe0ef7737efae15c87225755e9f6f5965e4888' \
    skills/improve-codebase-architecture/UPSTREAM.md >/dev/null \
    || fail "architecture skill is missing its pinned upstream source"
grep -F 'disable-model-invocation: true' \
    skills/improve-codebase-architecture/SKILL.md >/dev/null \
    || fail "architecture skill must remain user-invoked"

# The unlicensed upstream skill is referenced at one immutable revision.
grep -F '1bf05dcedaae03dcbfbe2621b5af8382c2bacb9c' \
    skills/zero-tech-debt/SKILL.md >/dev/null \
    || fail "zero-tech-debt is missing its pinned source"
grep -F 'disable-model-invocation: true' skills/zero-tech-debt/SKILL.md >/dev/null \
    || fail "zero-tech-debt must remain user-invoked"

# Model invocability is one portable fact in SKILL.md. AgentStart renders the
# inverse OpenAI field into its copied common pack; keeping that product field
# here would create the second source of truth this contract removes.
if grep -H '^  allow_implicit_invocation:' skills/*/agents/openai.yaml; then
    fail "source OpenAI manifests contain rendered invocation policy"
fi
explicit_model_skills=$(
    for skill_file in skills/*/SKILL.md; do
        grep -q '^disable-model-invocation: true$' "$skill_file" || continue
        skill_dir=${skill_file%/SKILL.md}
        printf '%s\n' "${skill_dir##*/}"
    done | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'
)
[ "$explicit_model_skills" = \
    "improve-codebase-architecture maintain retro zero-tech-debt" ] \
    || fail "explicit-only skill policy drifted: $explicit_model_skills"

[ -x scripts/render ] || fail "the renderer is not executable"
[ -x scripts/post-sync ] || fail "the post-sync hook is not executable"
grep -F '/render' scripts/post-sync >/dev/null \
    || fail "the post-sync hook does not exec the renderer"
[ -s LICENSE ] || fail "public repository is missing its LICENSE"
[ -s AGENTS.md ] \
    || fail "the repository guidance entrypoint is missing or empty: AGENTS.md"

# Public-repo hygiene: nothing here may assume an account name.
if grep -rn '/Users/' skills fragments prompts scripts README.md AGENTS.md GLOSSARY.md 2>/dev/null; then
    fail "a literal /Users/ path assumes an account name; resolve from \$HOME instead"
fi

# The render is the product, so it is validated by running it against a
# fixture HOME: fragments must splice, a present extension prompt must
# splice, absent ones must vanish without leaving markers, output must be
# read-only and banner-stamped, sibling files must ship, and a previously
# rendered skill whose template is gone must be pruned.
command -v bun >/dev/null 2>&1 || fail "bun is required to validate the render"

render_home=$(mktemp -d "${TMPDIR:-/tmp}/agentguidance-validate.XXXXXX")
trap 'rm -rf "$render_home"' EXIT
# The render takes its install root from the seam, never from a default of its
# own — that refusal is what keeps this fixture from drifting away from the
# tree sessions load, which is how the target silently rotted once before.
rendered_skills="$render_home/skills"
if HOME="$render_home" scripts/render >/dev/null 2>&1; then
    fail "the render must refuse to run without AGENTGUIDANCE_SKILLS_ROOT"
fi
mkdir -p "$render_home/.config/agentguidance"
printf '## System\n\nvalidate-system-extension\n' \
    >"$render_home/.config/agentguidance/SYSTEM.md"
printf '## Guidelines\n\nvalidate-extension-splice\n\ngh gist create FILE --desc "…" --web\n\ngh gist view GIST_ID --web\n' \
    >"$render_home/.config/agentguidance/GUIDELINES.md"
mkdir -p "$rendered_skills/stale-validate"
printf '<!-- Rendered from %s/skills/stale-validate/SKILL.md — do not edit; change the template or extension prompts and re-run ~/code/agentstart/scripts/sync-skills. -->\nstale\n' \
    "$root" >"$rendered_skills/stale-validate/SKILL.md"
HOME="$render_home" AGENTGUIDANCE_SKILLS_ROOT="$rendered_skills" scripts/render >/dev/null \
    || fail "the render failed against a fixture HOME"

rendered="$rendered_skills/maintain/SKILL.md"
[ -f "$rendered" ] || fail "the render did not install maintain"
grep -F "Rendered from $root/skills/maintain/SKILL.md" "$rendered" >/dev/null \
    || fail "the rendered skill is missing its provenance banner"
if grep -E '<!-- (fragment|extension-prompt):' "$rendered" >/dev/null; then
    fail "the rendered skill still contains raw render points"
fi
grep -F 'validate-extension-splice' "$rendered_skills/maintain/references/fork-maintenance.md" >/dev/null \
    || fail "the render did not splice a present extension prompt"
[ ! -w "$rendered" ] || fail "the rendered skill is not read-only"
[ -f "$rendered_skills/maintain/agents/openai.yaml" ] \
    || fail "the render did not ship the skill's sibling files"
[ ! -e "$rendered_skills/stale-validate" ] \
    || fail "the render did not prune a stale generated skill"

# A maintenance run's machine receipt and notification do not replace its
# human closeout. Assert the required report shape on the rendered product,
# including the explicit no-change path, and reject the former silence rule.
rendered_maintain="$rendered_skills/maintain/references/fork-maintenance.md"
for report_section in \
    '**Outcome.**' \
    '**Upstream reviewed.**' \
    '**Fork accommodations.**' \
    '**Stance and carry impact.**' \
    '**Evidence and attention.**'
do
    grep -F -- "$report_section" "$rendered_maintain" >/dev/null \
        || fail "the rendered maintain skill omits $report_section"
done
grep -F 'Never omit a section because its' "$rendered_maintain" >/dev/null \
    || fail "the rendered maintain skill can silently omit an empty report section"
grep -F 'No material change' "$rendered_maintain" >/dev/null \
    || fail "the rendered maintain skill can silently omit an empty report section"
if grep -F 'Silence is appropriate' "$rendered_maintain" >/dev/null; then
    fail "the rendered maintain skill still permits a silent closeout"
fi

# The remaining extension consumer keeps operator publication guidance.
grep -F 'gh gist create FILE --desc "…" --web' "$rendered_maintain" >/dev/null \
    || fail "the rendered maintain skill omits Gist create-and-open guidance"
grep -F 'gh gist view GIST_ID --web' "$rendered_maintain" >/dev/null \
    || fail "the rendered maintain skill omits existing-Gist open guidance"

# Progressive references are rendered products too: shared fragments and
# extension prompts must resolve, ship read-only, and retain their provenance.
for reference in \
    maintain/references/fork-maintenance.md \
    maintain/references/merge-only-maintenance.md \
    improve-codebase-architecture/HTML-REPORT.md
do
    rendered_reference="$rendered_skills/$reference"
    [ -f "$rendered_reference" ] || fail "missing rendered reference: $reference"
    [ ! -w "$rendered_reference" ] || fail "reference is not read-only: $reference"
    grep -F "Rendered from $root/skills/$reference" "$rendered_reference" >/dev/null \
        || fail "reference has no source provenance: $reference"
    if grep -E '<!-- (fragment|extension-prompt):' "$rendered_reference" >/dev/null; then
        fail "reference still contains raw render points: $reference"
    fi
done

# A missing fragment must also fail when it is referenced only by a detail
# file. Exercise the actual renderer from a disposable source checkout.
fixture_source="$render_home/source"
mkdir -p "$fixture_source/scripts"
cp scripts/render "$fixture_source/scripts/render"
cp -R skills fragments "$fixture_source/"
printf '\n<!-- fragment: missing-reference-fixture.md -->\n' \
    >>"$fixture_source/skills/maintain/references/fork-maintenance.md"
if HOME="$render_home" AGENTGUIDANCE_SKILLS_ROOT="$render_home/broken-skills" \
    "$fixture_source/scripts/render" >/dev/null 2>&1; then
    fail "a missing reference-only fragment did not fail the render"
fi

printf 'ok\n'
