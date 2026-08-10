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
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck --shell=bash scripts/post-sync tests/validate.sh
fi

# Every skill ships whole: template, manifest for the agents that read one,
# and the openai.yaml interface card the fleet convention requires.
for skill in build collab resource-create resource-update story; do
    [ -f "skills/$skill/SKILL.md" ] \
        || fail "skill template is missing: skills/$skill/SKILL.md"
    [ -f "skills/$skill/agents/openai.yaml" ] \
        || fail "skill manifest is missing: skills/$skill/agents/openai.yaml"
done
# The resource skills document their schema as living beside them; the
# update side carries it as a symlink so there is exactly one source.
for manifest_skill in resource-create resource-update; do
    [ -f "skills/$manifest_skill/MANIFEST.md" ] \
        || fail "resource schema does not resolve: skills/$manifest_skill/MANIFEST.md"
done

[ -x scripts/render ] || fail "the renderer is not executable"
[ -x scripts/post-sync ] || fail "the post-sync hook is not executable"
grep -F '/render' scripts/post-sync >/dev/null \
    || fail "the post-sync hook does not exec the renderer"
[ -s LICENSE ] || fail "public repository is missing its LICENSE"
[ "$(readlink CLAUDE.md)" = "AGENTS.md" ] \
    || fail "CLAUDE.md must be a symlink to AGENTS.md"

# Public-repo hygiene: nothing here may assume an account name.
if grep -rn '/Users/' skills fragments scripts README.md AGENTS.md CONTEXT.md 2>/dev/null; then
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
mkdir -p "$render_home/.config/agentguidance"
printf '## Tools\n\nvalidate-extension-splice\n' \
    >"$render_home/.config/agentguidance/TOOLS.md"
mkdir -p "$render_home/.agents/skills/retired-validate"
printf '<!-- Rendered from %s/skills/retired-validate/SKILL.md — do not edit; change the template or extension prompts and re-run scripts/render. -->\nstale\n' \
    "$root" >"$render_home/.agents/skills/retired-validate/SKILL.md"

HOME="$render_home" scripts/render >/dev/null \
    || fail "the render failed against a fixture HOME"

rendered="$render_home/.agents/skills/collab/SKILL.md"
[ -f "$rendered" ] || fail "the render did not install collab"
grep -F "Rendered from $root/skills/collab/SKILL.md" "$rendered" >/dev/null \
    || fail "the rendered skill is missing its provenance banner"
if grep -E '<!-- (fragment|extension-prompt):' "$rendered" >/dev/null; then
    fail "the rendered skill still contains raw render points"
fi
grep -F 'validate-extension-splice' "$rendered" >/dev/null \
    || fail "the render did not splice a present extension prompt"
[ ! -w "$rendered" ] || fail "the rendered skill is not read-only"
[ -f "$render_home/.agents/skills/collab/agents/openai.yaml" ] \
    || fail "the render did not ship the skill's sibling files"
[ -f "$render_home/.agents/skills/resource-update/MANIFEST.md" ] \
    || fail "the rendered resource-update manifest symlink does not resolve"
[ ! -e "$render_home/.agents/skills/retired-validate" ] \
    || fail "the render did not prune a retired skill it once produced"

printf 'ok\n'
