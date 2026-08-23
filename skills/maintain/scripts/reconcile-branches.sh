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
#   MAINTAIN_MAIN_BRANCH         the mirror branch (default: main)
#   MAINTAIN_INTEGRATION_BRANCH  the published build source (default: integration)
#   MAINTAIN_CARRY_PREFIX        carried-feature branch prefix (default: carry/;
#                                empty for a linear stack with no carry heads)
#   MAINTAIN_QUARANTINE_PREFIX   where other heads are moved (default: DELETEME/)
#   MAINTAIN_PRESERVE_OPEN_PRS   1 to freeze the exact heads of open upstream
#                                pull requests from the fork (default: 1)
#   MAINTAIN_OPEN_PR_HEADS_FILE  a fixture replacing the GitHub query (tests)
#   MAINTAIN_ALLOW_LOCAL_REMOTES 1 to accept non-GitHub remote URLs (tests)
#
# --check plans and mutates nothing, not even the bound checkout's tracking
# refs: it works from a disposable bare snapshot. --apply pushes the whole
# plan in one atomic, exact-leased push and then repairs local tracking.

die() {
    printf 'maintain branches: %s\n' "$*" >&2
    exit 1
}

usage() {
    printf 'Usage: reconcile-branches.sh --check|--apply\n'
}

case "${1:-}" in
    --check)
        mode=check
        ;;
    --apply)
        mode=apply
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
carry_prefix="${MAINTAIN_CARRY_PREFIX-carry/}"
quarantine_prefix="${MAINTAIN_QUARANTINE_PREFIX:-DELETEME/}"
preserve_open_prs="${MAINTAIN_PRESERVE_OPEN_PRS:-1}"
open_pr_heads_override="${MAINTAIN_OPEN_PR_HEADS_FILE:-}"

case "$main_branch" in */*) die "the mirror branch may not contain a slash: $main_branch" ;; esac
case "$integration_branch" in */*) die "the integration branch may not contain a slash: $integration_branch" ;; esac
[ "$main_branch" != "$integration_branch" ] || die "the mirror and integration branches must differ"
if [ -n "$carry_prefix" ]; then
    case "$carry_prefix" in */) ;; *) die "the carry prefix must end with a slash: $carry_prefix" ;; esac
fi
case "$quarantine_prefix" in */) ;; *) die "the quarantine prefix must end with a slash: $quarantine_prefix" ;; esac
[ "$carry_prefix" != "$quarantine_prefix" ] || die "the carry and quarantine prefixes must differ"

# Branch classification by the declared model.
is_carry() { [ -n "$carry_prefix" ] && [ "${1#"$carry_prefix"}" != "$1" ]; }
is_quarantined() { [ "${1#"$quarantine_prefix"}" != "$1" ]; }

command -v git >/dev/null 2>&1 || die "git is required"
command -v awk >/dev/null 2>&1 || die "awk is required"
command -v cmp >/dev/null 2>&1 || die "cmp is required"
if [ -z "$open_pr_heads_override" ] && [ "$preserve_open_prs" -eq 1 ]; then
    command -v gh >/dev/null 2>&1 || die "gh is required"
fi
git -C "$checkout" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "$checkout is not a git worktree"
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
quarantine_plan="$scratch_root/quarantine-plan"
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
git --git-dir="$snapshot_repo" fetch --quiet --no-tags "$origin_url" \
    "+refs/heads/$main_branch:refs/maintain/origin/main" \
    || die "could not snapshot $origin_remote/$main_branch"
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

: >"$quarantine_plan"
# lookup_sha opens the same immutable snapshot independently; neither reader
# writes it. ShellCheck otherwise mistakes the nested read for a pipeline race.
# shellcheck disable=SC2094
while IFS=$'\t' read -r branch sha; do
    [ -n "$branch" ] || continue
    if [ "$branch" = "$main_branch" ] || [ "$branch" = "$integration_branch" ] \
        || is_quarantined "$branch"; then
        continue
    elif is_carry "$branch"; then
        if has_branch "$local_carries" "$branch"; then
            continue
        fi
    elif has_branch "$open_pr_heads" "$branch"; then
        continue
    fi
    target="$quarantine_prefix$branch"
    if target_sha=$(lookup_sha "$remote_heads" "$target" 2>/dev/null); then
        [ "$target_sha" = "$sha" ] \
            || die "quarantine target $target already names another commit"
    fi
    printf '%s\t%s\t%s\n' "$branch" "$sha" "$target" \
        >>"$quarantine_plan"
done <"$remote_heads"

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
        printf 'KEEP-QUARANTINE %s %s\n' "$branch" "$sha"
    fi
done <"$remote_heads"
while IFS=$'\t' read -r branch sha target; do
    [ -n "$branch" ] || continue
    printf 'QUARANTINE %s %s -> %s\n' "$branch" "$sha" "$target"
done <"$quarantine_plan"

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
while IFS=$'\t' read -r branch sha target; do
    [ -n "$branch" ] || continue
    leases+=("--force-with-lease=refs/heads/$branch:$sha")
    if target_sha=$(lookup_sha "$remote_heads" "$target" 2>/dev/null); then
        leases+=("--force-with-lease=refs/heads/$target:$target_sha")
        refspecs+=("$target_sha:refs/heads/$target")
    else
        leases+=("--force-with-lease=refs/heads/$target:")
        refspecs+=("$sha:refs/heads/$target")
    fi
    refspecs+=(":refs/heads/$branch")
done <"$quarantine_plan"

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

printf 'Applied the branch model: %s mirrored, carries published, other heads quarantined under %s.\n' \
    "$main_branch" "$quarantine_prefix"
