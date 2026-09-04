#!/bin/bash

set -euo pipefail

# Reconcile a fork's branch namespace against its declared model. Shipped
# with the maintain skill; a workshop calls it through a thin entrypoint
# that exports the values its MAINTAIN.md declares:
#
#   MAINTAIN_CHECKOUT            the bound checkout (required)
#   MAINTAIN_FORK_REPO           owner/name of our fork on GitHub (required)
#   MAINTAIN_UPSTREAM_REPO       owner/name of upstream on GitHub (required)
#   MAINTAIN_FORK_REMOTE         remote name for the fork (default: fork)
#   MAINTAIN_UPSTREAM_REMOTE     remote name for upstream (default: origin)
#   MAINTAIN_UPSTREAM_SHA        exact upstream commit selected once for this
#                                maintenance cycle (required for --check and
#                                --apply); reconciliation reads it from the
#                                bound checkout and never refreshes or follows
#                                the upstream branch
#   MAINTAIN_MAIN_BRANCH         the mirror branch (default: main)
#   MAINTAIN_INTEGRATION_BRANCH  the published build source (default: integration)
#   MAINTAIN_CARRY_PREFIX        carried-feature branch prefix (default: carry/;
#                                empty for a linear stack with no carry heads)
#   MAINTAIN_QUARANTINE_PREFIX   explicit deletion-marker namespace
#                                (default: DELETEME/); reconciliation reports
#                                these heads but never creates or removes them
#   MAINTAIN_PRESERVE_OPEN_PRS   1 to freeze the exact heads of open upstream
#                                pull requests from the fork (default: 1)
#   MAINTAIN_WORKSHOP            the workshop checkout holding MAINTAIN.md,
#                                recorded so a tool reading the fork's own
#                                repository can find the spec (optional)
#   MAINTAIN_OPEN_PR_HEADS_FILE  a fixture replacing the GitHub query (tests)
#   MAINTAIN_ALLOW_LOCAL_REMOTES 1 to accept non-GitHub remote URLs (tests)
#
# --check plans and mutates nothing, not even the bound checkout's tracking
# refs: it works from a disposable bare snapshot. --apply pushes the whole
# plan in one atomic, exact-leased push and then repairs local tracking.
#
# The declaration above is also the fork's answer to any tool that must know
# how the repository is shaped without reading its prose. --print-model emits
# it as JSON and touches nothing. --configure-supervision converges it into
# the bound checkout's own git config under `supervisor.*`, so a tool holding
# only the repository can resolve the trunk and the branch namespaces the
# fork keeps; --check-supervision verifies that convergence, and that
# MAINTAIN.md still names the same branches.

die() {
    printf 'maintain branches: %s\n' "$*" >&2
    exit 1
}

usage() {
    printf 'Usage: reconcile-branches.sh --check|--apply|--print-model|--configure-supervision|--check-supervision\n'
}

case "${1:-}" in
    --check)
        mode=check
        ;;
    --apply)
        mode=apply
        ;;
    --print-model)
        mode=print-model
        ;;
    --configure-supervision)
        mode=configure-supervision
        ;;
    --check-supervision)
        mode=check-supervision
        ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        usage >&2
        exit 64
        ;;
esac
[ "$#" -eq 1 ] || {
    usage >&2
    exit 64
}

checkout="${MAINTAIN_CHECKOUT:?MAINTAIN_CHECKOUT is required}"
fork_remote="${MAINTAIN_FORK_REMOTE:-fork}"
origin_remote="${MAINTAIN_UPSTREAM_REMOTE:-origin}"
upstream_sha="${MAINTAIN_UPSTREAM_SHA:-}"
allow_local_remotes="${MAINTAIN_ALLOW_LOCAL_REMOTES:-0}"
if [ "$allow_local_remotes" -eq 1 ]; then
    fork_repo="${MAINTAIN_FORK_REPO:-local/fork}"
    upstream_repo="${MAINTAIN_UPSTREAM_REPO:-local/upstream}"
else
    fork_repo="${MAINTAIN_FORK_REPO:?MAINTAIN_FORK_REPO is required}"
    upstream_repo="${MAINTAIN_UPSTREAM_REPO:?MAINTAIN_UPSTREAM_REPO is required}"
fi
main_branch="${MAINTAIN_MAIN_BRANCH:-main}"
integration_branch="${MAINTAIN_INTEGRATION_BRANCH:-integration}"
carry_prefix_list="${MAINTAIN_CARRY_PREFIX-carry/}"
carry_refs_list="${MAINTAIN_CARRY_REFS:-}"
workshop_checkouts_list="${MAINTAIN_WORKSHOP_CHECKOUTS:-}"
# The first declared prefix is the primary one: what a new carry is named.
carry_prefix="${carry_prefix_list%% *}"
quarantine_prefix="${MAINTAIN_QUARANTINE_PREFIX:-DELETEME/}"
preserve_open_prs="${MAINTAIN_PRESERVE_OPEN_PRS:-1}"
open_pr_heads_override="${MAINTAIN_OPEN_PR_HEADS_FILE:-}"
workshop="${MAINTAIN_WORKSHOP:-}"

case "$main_branch" in */*) die "the mirror branch may not contain a slash: $main_branch" ;; esac
case "$integration_branch" in */*) die "the integration branch may not contain a slash: $integration_branch" ;; esac
[ "$main_branch" != "$integration_branch" ] || die "the mirror and integration branches must differ"
for prefix in $carry_prefix_list; do
    case "$prefix" in */) ;; *) die "a carry prefix must end with a slash: $prefix" ;; esac
done
for ref in $carry_refs_list; do
    case "$ref" in */) die "a carry ref is an exact branch name, not a prefix: $ref" ;; esac
done
case "$quarantine_prefix" in */) ;; *) die "the quarantine prefix must end with a slash: $quarantine_prefix" ;; esac
for prefix in $carry_prefix_list; do
    [ "$prefix" != "$quarantine_prefix" ] || die "the carry and quarantine prefixes must differ"
done
if [ "$mode" = check ] || [ "$mode" = apply ]; then
    [ -n "$upstream_sha" ] \
        || die "MAINTAIN_UPSTREAM_SHA is required; capture one upstream target before the cycle's only fetch"
    [ "${#upstream_sha}" -eq 40 ] \
        || die "MAINTAIN_UPSTREAM_SHA must be one exact 40-character lowercase commit SHA"
    case "$upstream_sha" in
        *[!0-9a-f]*) die "MAINTAIN_UPSTREAM_SHA must be one exact 40-character lowercase commit SHA" ;;
    esac
fi

# Branch classification by the declared model.
# A carry is any branch under a declared prefix, or one named exactly by a
# declared ref. The refs exist because a real carry can predate the naming
# convention: renaming a published branch is a publication, so the model must
# be able to describe what is there rather than what it wishes were there.
is_carry() {
    local candidate="$1" prefix ref
    for prefix in $carry_prefix_list; do
        [ -n "$prefix" ] || continue
        [ "${candidate#"$prefix"}" = "$candidate" ] || return 0
    done
    for ref in $carry_refs_list; do
        [ "$candidate" != "$ref" ] || return 0
    done
    return 1
}
is_quarantined() { [ "${1#"$quarantine_prefix"}" != "$1" ]; }

# The declaration as data. A tool that must know the shape of the fork asks
# for this rather than reading MAINTAIN.md's prose, so there is one source
# and a mis-read is impossible rather than merely unlikely.
json_string() {
    printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

print_model() {
    printf '{\n'
    printf '  "checkout": %s,\n' "$(json_string "$checkout")"
    printf '  "workshop": %s,\n' "$(json_string "$workshop")"
    printf '  "mirror_branch": %s,\n' "$(json_string "$main_branch")"
    printf '  "integration_branch": %s,\n' "$(json_string "$integration_branch")"
    printf '  "carry_prefix": %s,\n' "$(json_string "$carry_prefix")"
    printf '  "carry_prefixes": ['
    sep=''
    for prefix in $carry_prefix_list; do
        printf '%s%s' "$sep" "$(json_string "$prefix")"; sep=', '
    done
    printf '],\n'
    printf '  "carry_refs": ['
    sep=''
    for ref in $carry_refs_list; do
        printf '%s%s' "$sep" "$(json_string "$ref")"; sep=', '
    done
    printf '],\n'
    printf '  "workshop_checkouts": ['
    sep=''
    for path in ${workshop_checkouts_list:-$checkout}; do
        printf '%s%s' "$sep" "$(json_string "$path")"; sep=', '
    done
    printf '],\n'
    printf '  "quarantine_prefix": %s,\n' "$(json_string "$quarantine_prefix")"
    printf '  "fork_repo": %s,\n' "$(json_string "$fork_repo")"
    printf '  "upstream_repo": %s,\n' "$(json_string "$upstream_repo")"
    printf '  "fork_remote": %s,\n' "$(json_string "$fork_remote")"
    printf '  "upstream_remote": %s,\n' "$(json_string "$origin_remote")"
    printf '  "preserve_open_prs": %s\n' "$preserve_open_prs"
    printf '}\n'
}

if [ "$mode" = print-model ]; then
    print_model
    exit 0
fi

command -v git >/dev/null 2>&1 || die "git is required"
command -v awk >/dev/null 2>&1 || die "awk is required"
command -v cmp >/dev/null 2>&1 || die "cmp is required"
if [ -z "$open_pr_heads_override" ] && [ "$preserve_open_prs" -eq 1 ]; then
    command -v gh >/dev/null 2>&1 || die "gh is required"
fi
git -C "$checkout" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "$checkout is not a git worktree"

# Supervision: the same declaration, converged into the fork's own repository
# so a tool holding only the checkout can resolve its trunk and the branch
# namespaces this model keeps. Derived state, never a second declaration —
# --check-supervision is what keeps it honest.
normalize_words() {
    local out='' word
    for word in $1; do out="$out$word "; done
    printf '%s' "${out% }"
}

# Multi-valued convergence: replace the whole set every time rather than
# adding to it, so a value dropped from the declaration disappears from the
# config instead of lingering as a stale entry nothing declares.
write_multi() {
    local repo="$1" key="$2" values="$3" empty_is_a_value="${4:-}" first=1 value
    git -C "$repo" config --unset-all "$key" 2>/dev/null || true
    # An empty carry prefix is a real declaration — a linear stack carries no
    # branches — and must stay distinguishable from a key nobody converged.
    if [ -z "$(normalize_words "$values")" ] && [ -n "$empty_is_a_value" ]; then
        git -C "$repo" config --replace-all "$key" ""
        return 0
    fi
    for value in $values; do
        [ -n "$value" ] || continue
        if [ "$first" = 1 ]; then
            git -C "$repo" config --replace-all "$key" "$value"; first=0
        else
            git -C "$repo" config --add "$key" "$value"
        fi
    done
}

apply_supervision() {
    git -C "$checkout" config supervisor.trunk "$integration_branch"
    git -C "$checkout" config supervisor.mirror "$main_branch"
    write_multi "$checkout" supervisor.carryPrefix "$carry_prefix_list" empty-is-a-value
    write_multi "$checkout" supervisor.carryRef "$carry_refs_list"
    git -C "$checkout" config supervisor.quarantinePrefix "$quarantine_prefix"
    # The workshop-to-fork direction. Everything above points a checkout at
    # itself; this points the workshop at every fork it binds, so a tool that
    # discovers the workshop can follow it to forks nested anywhere without
    # walking the filesystem for them.
    if [ -n "$workshop" ] && [ -d "$workshop/.git" ]; then
        write_multi "$workshop" supervisor.checkout "${workshop_checkouts_list:-$checkout}"
    fi
    if [ -n "$workshop" ]; then
        git -C "$checkout" config supervisor.workshop "$workshop"
    else
        git -C "$checkout" config --unset-all supervisor.workshop 2>/dev/null || true
    fi
}

# A multi-valued key matches when the configured set is exactly the declared
# set, in order. Comparing sets rather than membership is what makes a value
# nobody declares any more fail here instead of surviving unnoticed.

expect_multi() {
    local repo="$1" key="$2" want="$3" have declared
    have=$(normalize_words "$(git -C "$repo" config --get-all "$key" 2>/dev/null | tr '\n' ' ')")
    declared=$(normalize_words "$want")
    [ "$have" = "$declared" ] \
        || die "$repo configures $key=[$have], but the model declares [$declared]; run --configure-supervision"
}

expect_config() {
    local key="$1" want="$2" have
    have=$(git -C "$checkout" config --get "$key" 2>/dev/null) \
        || die "$checkout does not configure $key; run --configure-supervision"
    [ "$have" = "$want" ] \
        || die "$checkout configures $key=$have, but the model declares $want"
}

# The spec is the human contract and the entrypoint is the machine one; a
# workshop whose prose no longer names the branches it exports has drifted,
# and that is worth failing on while both are still cheap to reconcile.
check_spec() {
    [ -n "$workshop" ] || return 0
    local spec="$workshop/MAINTAIN.md" section
    [ -f "$spec" ] || die "the declared workshop has no MAINTAIN.md: $spec"
    section=$(awk '/^## Branch model$/ { inside = 1; next } /^## / { inside = 0 } inside' "$spec")
    [ -n "$section" ] || die "$spec has no '## Branch model' section"
    printf '%s\n' "$section" | grep -Fq -- "$main_branch" \
        || die "$spec does not name the mirror branch $main_branch in its Branch model"
    printf '%s\n' "$section" | grep -Fq -- "$integration_branch" \
        || die "$spec does not name the integration branch $integration_branch in its Branch model"
    for prefix in $carry_prefix_list; do
        [ -n "$prefix" ] || continue
        printf '%s\n' "$section" | grep -Fq -- "$prefix" \
            || die "$spec does not name the carry prefix $prefix in its Branch model"
    done
    for ref in $carry_refs_list; do
        printf '%s\n' "$section" | grep -Fq -- "$ref" \
            || die "$spec does not name the declared carry head $ref in its Branch model"
    done
    printf '%s\n' "$section" | grep -Fq -- "$quarantine_prefix" \
        || die "$spec does not name the deletion-marker prefix $quarantine_prefix in its Branch model"
}

if [ "$mode" = configure-supervision ]; then
    check_spec
    apply_supervision
    printf 'Configured supervision in %s: trunk %s, mirror %s.\n' \
        "$checkout" "$integration_branch" "$main_branch"
    exit 0
fi

if [ "$mode" = check-supervision ]; then
    check_spec
    expect_config supervisor.trunk "$integration_branch"
    expect_config supervisor.mirror "$main_branch"
    expect_multi "$checkout" supervisor.carryPrefix "$carry_prefix_list"
    expect_multi "$checkout" supervisor.carryRef "$carry_refs_list"
    if [ -n "$workshop" ] && [ -d "$workshop/.git" ]; then
        expect_multi "$workshop" supervisor.checkout "${workshop_checkouts_list:-$checkout}"
    fi
    expect_config supervisor.quarantinePrefix "$quarantine_prefix"
    [ -z "$workshop" ] || expect_config supervisor.workshop "$workshop"
    printf 'Supervision configuration in %s matches the declared model.\n' "$checkout"
    exit 0
fi

[ -z "$(git -C "$checkout" status --porcelain)" ] \
    || die "$checkout has local changes"

verify_remote() {
    local remote="$1" repo="$2" actual="$3"
    [ "$allow_local_remotes" -eq 1 ] && return 0
    case "$actual" in
        "https://github.com/$repo" | "https://github.com/$repo.git" \
            | "git@github.com:$repo.git") return 0 ;;
        *) die "$checkout remote $remote points at $actual" ;;
    esac
}

fork_url=$(git -C "$checkout" remote get-url "$fork_remote" 2>/dev/null) \
    || die "$checkout has no $fork_remote remote"
origin_url=$(git -C "$checkout" remote get-url "$origin_remote" 2>/dev/null) \
    || die "$checkout has no $origin_remote remote"
verify_remote "$fork_remote" "$fork_repo" "$fork_url"
verify_remote "$origin_remote" "$upstream_repo" "$origin_url"

scratch_root=$(mktemp -d "${TMPDIR:-/tmp}/maintain-branches.XXXXXX")
remote_heads="$scratch_root/remote-heads"
open_pr_heads="$scratch_root/open-pr-heads"
local_carries="$scratch_root/local-carries"
open_pr_heads_recheck="$scratch_root/open-pr-heads-recheck"
snapshot_repo="$scratch_root/snapshot.git"

cleanup() {
    local status=$?
    trap - EXIT
    rm -rf -- "$scratch_root"
    exit "$status"
}
trap cleanup EXIT

lookup_sha() {
    local file="$1" branch="$2"
    awk -F '\t' -v branch="$branch" '
        $1 == branch { print $2; found = 1; exit }
        END { if (!found) exit 1 }
    ' "$file"
}

has_branch() {
    local file="$1" branch="$2"
    awk -F '\t' -v branch="$branch" '
        $1 == branch { found = 1; exit }
        END { exit(found ? 0 : 1) }
    ' "$file"
}

git init --quiet --bare "$snapshot_repo" \
    || die "could not create a temporary branch snapshot"
git --git-dir="$snapshot_repo" fetch --quiet --no-tags "$checkout" \
    "+$upstream_sha:refs/maintain/origin/main" \
    || die "the bound checkout does not contain pinned upstream commit $upstream_sha"
git --git-dir="$snapshot_repo" fetch --quiet --no-tags "$fork_url" \
    '+refs/heads/*:refs/maintain/fork/*' \
    || die "could not snapshot $fork_remote branches"
git --git-dir="$snapshot_repo" fetch --quiet --no-tags "$checkout" \
    '+refs/heads/*:refs/maintain/local/*' \
    || die "could not snapshot local branches"

git --git-dir="$snapshot_repo" for-each-ref \
    --format='%(refname:strip=3)%09%(objectname)' refs/maintain/fork/ \
    | LC_ALL=C sort >"$remote_heads"

if [ -n "$carry_prefix" ]; then
    git -C "$checkout" for-each-ref \
        --format='%(refname:short)%09%(objectname)' "refs/heads/$carry_prefix" \
        | LC_ALL=C sort >"$local_carries"
else
    : >"$local_carries"
fi

inventory_open_pr_heads() {
    local output="$1"
    if [ "$preserve_open_prs" -ne 1 ]; then
        : >"$output"
    elif [ -n "$open_pr_heads_override" ]; then
        [ -f "$open_pr_heads_override" ] \
            || die "open-PR head fixture does not exist: $open_pr_heads_override"
        awk 'NF { if (NF < 2) exit 2; print $1 "\t" $2 "\t" (NF >= 3 ? $3 : "?") }' \
            "$open_pr_heads_override" | LC_ALL=C sort >"$output" \
            || die "open-PR head fixture is invalid"
    else
        gh api --paginate \
            "repos/$upstream_repo/pulls?state=open&per_page=100" \
            --jq '.[] | [.head.ref, .head.sha, (.head.repo.full_name // ""), .number] | @tsv' \
            | awk -F '\t' -v fork_repo="$fork_repo" \
                '$3 == fork_repo { print $1 "\t" $2 "\t" $4 }' \
            | LC_ALL=C sort >"$output" \
            || die "could not inventory open pull-request heads"
    fi
}

inventory_open_pr_heads "$open_pr_heads"

origin_main_sha=$(git --git-dir="$snapshot_repo" rev-parse refs/maintain/origin/main)
fork_main_sha=$(lookup_sha "$remote_heads" "$main_branch") \
    || die "$fork_remote/$main_branch is missing"
integration_sha=$(lookup_sha "$remote_heads" "$integration_branch") \
    || die "$fork_remote/$integration_branch is missing"
local_integration_sha=$(git -C "$checkout" rev-parse \
    "refs/heads/$integration_branch" 2>/dev/null) \
    || die "local $integration_branch is missing"
[ "$local_integration_sha" = "$integration_sha" ] \
    || die "local $integration_branch does not match $fork_remote/$integration_branch; bind the published branch first"

if git -C "$checkout" rev-parse --verify --quiet \
    "refs/heads/$main_branch" >/dev/null; then
    local_main_sha=$(git -C "$checkout" rev-parse "refs/heads/$main_branch")
    git --git-dir="$snapshot_repo" merge-base --is-ancestor \
        "$local_main_sha" "$origin_main_sha" \
        || die "local $main_branch has commits outside $origin_remote/$main_branch"
else
    local_main_sha=missing
fi
git --git-dir="$snapshot_repo" merge-base --is-ancestor \
    "$fork_main_sha" "$origin_main_sha" \
    || die "$fork_remote/$main_branch has commits outside $origin_remote/$main_branch"

while IFS=$'\t' read -r branch sha pr_number; do
    [ -n "$branch" ] || continue
    if [ "$branch" = "$main_branch" ] || [ "$branch" = "$integration_branch" ] \
        || is_carry "$branch" || is_quarantined "$branch"; then
        die "open PR #$pr_number uses reserved maintenance branch $branch"
    fi
    remote_sha=$(lookup_sha "$remote_heads" "$branch") \
        || die "open PR #$pr_number head $branch is missing from $fork_remote"
    [ "$remote_sha" = "$sha" ] \
        || die "open PR #$pr_number head $branch moved during inventory"
done <"$open_pr_heads"

while IFS=$'\t' read -r branch sha; do
    [ -n "$branch" ] || continue
    git check-ref-format "refs/heads/$branch" >/dev/null \
        || die "invalid carry branch: $branch"
    git --git-dir="$snapshot_repo" merge-base --is-ancestor \
        "$sha" "$integration_sha" \
        || die "$branch is not included in $fork_remote/$integration_branch"
done <"$local_carries"

printf 'MAIN %s %s -> %s\n' "$main_branch" "$fork_main_sha" "$origin_main_sha"
printf 'KEEP %s %s\n' "$integration_branch" "$integration_sha"
while IFS=$'\t' read -r branch sha; do
    [ -n "$branch" ] || continue
    if remote_sha=$(lookup_sha "$remote_heads" "$branch" 2>/dev/null); then
        printf 'PUBLISH %s %s -> %s\n' "$branch" "$remote_sha" "$sha"
    else
        printf 'PUBLISH %s missing -> %s\n' "$branch" "$sha"
    fi
done <"$local_carries"
while IFS=$'\t' read -r branch sha pr_number; do
    [ -n "$branch" ] || continue
    printf 'KEEP-PR #%s %s %s\n' "$pr_number" "$branch" "$sha"
done <"$open_pr_heads"
while IFS=$'\t' read -r branch sha; do
    [ -n "$branch" ] || continue
    if is_quarantined "$branch"; then
        printf 'KEEP-DELETEME %s %s\n' "$branch" "$sha"
    fi
done <"$remote_heads"
while IFS=$'\t' read -r branch sha; do
    [ -n "$branch" ] || continue
    if [ "$branch" = "$main_branch" ] || [ "$branch" = "$integration_branch" ] \
        || is_quarantined "$branch" \
        || has_branch "$local_carries" "$branch" \
        || has_branch "$open_pr_heads" "$branch"; then
        continue
    fi
    printf 'KEEP-OTHER %s %s\n' "$branch" "$sha"
done <"$remote_heads"

[ "$mode" = apply ] || exit 0

if [ "$local_main_sha" != "$origin_main_sha" ] \
    && git -C "$checkout" worktree list --porcelain \
        | awk -v ref="refs/heads/$main_branch" \
            '$1 == "branch" && $2 == ref { found = 1 }
             END { exit(found ? 0 : 1) }'; then
    die "local $main_branch is checked out in another worktree"
fi

inventory_open_pr_heads "$open_pr_heads_recheck"
cmp -s "$open_pr_heads" "$open_pr_heads_recheck" \
    || die "open pull-request heads changed since planning; rerun"

leases=("--force-with-lease=refs/heads/$main_branch:$fork_main_sha")
leases+=("--force-with-lease=refs/heads/$integration_branch:$integration_sha")
refspecs=("$origin_main_sha:refs/heads/$main_branch")
refspecs+=("$integration_sha:refs/heads/$integration_branch")
while IFS=$'\t' read -r branch sha; do
    [ -n "$branch" ] || continue
    if remote_sha=$(lookup_sha "$remote_heads" "$branch" 2>/dev/null); then
        leases+=("--force-with-lease=refs/heads/$branch:$remote_sha")
    else
        leases+=("--force-with-lease=refs/heads/$branch:")
    fi
    refspecs+=("$sha:refs/heads/$branch")
done <"$local_carries"
git --git-dir="$snapshot_repo" push --quiet --atomic \
    "${leases[@]}" "$fork_url" "${refspecs[@]}" \
    || die "could not atomically apply the fork branch policy"

git -C "$checkout" fetch --quiet --no-tags "$snapshot_repo" \
    "+refs/maintain/origin/main:refs/remotes/$origin_remote/$main_branch" \
    || die "could not refresh $origin_remote/$main_branch tracking"
git -C "$checkout" fetch --quiet --prune "$fork_remote" \
    || die "could not refresh $fork_remote tracking refs"

if [ "$local_main_sha" != "$origin_main_sha" ]; then
    git -C "$checkout" branch --force "$main_branch" "$origin_main_sha" \
        || die "could not fast-forward local $main_branch"
fi
git -C "$checkout" branch --set-upstream-to="$origin_remote/$main_branch" "$main_branch" \
    >/dev/null || die "could not make local $main_branch pull from $origin_remote/$main_branch"
git -C "$checkout" config "branch.$main_branch.pushRemote" "$fork_remote"

while IFS=$'\t' read -r branch sha; do
    [ -n "$branch" ] || continue
    git -C "$checkout" branch --set-upstream-to="$fork_remote/$branch" \
        "$branch" >/dev/null \
        || die "could not track published $fork_remote/$branch"
    git -C "$checkout" config "branch.$branch.pushRemote" "$fork_remote"
done <"$local_carries"

printf 'Applied the branch model: %s mirrored and declared carries published; all other heads were left unchanged.\n' \
    "$main_branch"
