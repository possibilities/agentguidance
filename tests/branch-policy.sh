#!/bin/bash

set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/skills/maintain/scripts/reconcile-branches.sh"

fail() {
    printf 'branch-policy: %s\n' "$*" >&2
    exit 1
}

test_root=$(mktemp -d "${TMPDIR:-/tmp}/maintain-branch-policy.XXXXXX")
cleanup_test() {
    local status=$?
    trap - EXIT
    rm -rf -- "$test_root"
    exit "$status"
}
trap cleanup_test EXIT

seed="$test_root/seed"
fork_repo="$test_root/fork.git"
upstream_repo="$test_root/upstream.git"
checkout="$test_root/checkout"
open_pr_heads="$test_root/open-pr-heads"
workshop="$test_root/workshop"

# A workshop is its specification plus the entrypoint that declares the same
# model to a machine; the supervision checks below prove the two agree.
mkdir -p "$workshop"
cat >"$workshop/MAINTAIN.md" <<'SPEC'
# Fork workshop fixture

## Branch model

- Mirror branch: `main`, an exact mirror of upstream.
- Integration branch: `integration`, every carried feature composed together.
- Composition: published `carry/<feature>` heads.
- Deletion marker prefix: `DELETEME/`.

## Features
SPEC

git init --quiet --initial-branch=main "$seed"
git -C "$seed" config user.name maintain-test
git -C "$seed" config user.email maintain@example.invalid

printf 'base\n' >"$seed/state"
git -C "$seed" add state
git -C "$seed" commit --quiet -m base
old_main_sha=$(git -C "$seed" rev-parse HEAD)

printf 'upstream\n' >>"$seed/state"
git -C "$seed" commit --quiet -am upstream
upstream_main_sha=$(git -C "$seed" rev-parse HEAD)

printf 'future upstream\n' >>"$seed/state"
git -C "$seed" commit --quiet -am future-upstream
future_upstream_sha=$(git -C "$seed" rev-parse HEAD)
git -C "$seed" switch --quiet --detach "$upstream_main_sha"

git -C "$seed" switch --quiet -c future/topic
printf 'future topic\n' >"$seed/future-topic"
git -C "$seed" add future-topic
git -C "$seed" commit --quiet -m future-topic
future_topic_sha=$(git -C "$seed" rev-parse HEAD)
git -C "$seed" switch --quiet --detach "$upstream_main_sha"

git -C "$seed" switch --quiet -c carry/alpha
printf 'carry\n' >"$seed/carry"
git -C "$seed" add carry
git -C "$seed" commit --quiet -m carry
carry_sha=$(git -C "$seed" rev-parse HEAD)

git -C "$seed" switch --quiet -c integration
printf 'integration\n' >"$seed/integration"
git -C "$seed" add integration
git -C "$seed" commit --quiet -m integration
integration_sha=$(git -C "$seed" rev-parse HEAD)

git -C "$seed" switch --quiet --detach "$old_main_sha"
git -C "$seed" switch --quiet -c pr/open
printf 'open PR\n' >"$seed/pr"
git -C "$seed" add pr
git -C "$seed" commit --quiet -m pr
pr_sha=$(git -C "$seed" rev-parse HEAD)

git -C "$seed" switch --quiet --detach "$old_main_sha"
git -C "$seed" switch --quiet -c stale/topic
printf 'stale\n' >"$seed/stale"
git -C "$seed" add stale
git -C "$seed" commit --quiet -m stale
stale_sha=$(git -C "$seed" rev-parse HEAD)

git -C "$seed" switch --quiet --detach "$old_main_sha"
git -C "$seed" switch --quiet -c quarantined
printf 'quarantined\n' >"$seed/quarantined"
git -C "$seed" add quarantined
git -C "$seed" commit --quiet -m quarantined
quarantine_sha=$(git -C "$seed" rev-parse HEAD)

git init --quiet --bare "$fork_repo"
git init --quiet --bare "$upstream_repo"
git -C "$seed" push --quiet "$fork_repo" \
    "$old_main_sha:refs/heads/main" \
    "$integration_sha:refs/heads/integration" \
    "$pr_sha:refs/heads/pr/open" \
    "$stale_sha:refs/heads/stale/topic" \
    "$quarantine_sha:refs/heads/already" \
    "$quarantine_sha:refs/heads/DELETEME/already"
git -C "$seed" push --quiet "$upstream_repo" \
    "$upstream_main_sha:refs/heads/main" \
    "$future_upstream_sha:refs/fixtures/future-upstream" \
    "$future_topic_sha:refs/fixtures/future-topic"
git --git-dir="$fork_repo" symbolic-ref HEAD refs/heads/main
git --git-dir="$upstream_repo" symbolic-ref HEAD refs/heads/main

# One cycle captures Main before its only upstream fetch. If Main and a topic
# advance before that fetch, asking for the captured object imports only that
# commit and its ancestors: neither moving head, its object, nor a tracking ref
# may enter the cycle.
fetch_checkout="$test_root/exact-fetch-checkout"
git init --quiet --initial-branch=integration "$fetch_checkout"
git -C "$fetch_checkout" remote add upstream "$upstream_repo"
captured_upstream_sha=$(
    git -C "$fetch_checkout" ls-remote --exit-code --heads upstream \
        refs/heads/main | awk 'NR == 1 { print $1 }'
)
[ "$captured_upstream_sha" = "$upstream_main_sha" ] \
    || fail "exact-fetch fixture captured the wrong upstream Main"
git --git-dir="$upstream_repo" update-ref refs/heads/main "$future_upstream_sha"
git --git-dir="$upstream_repo" update-ref refs/heads/future/topic "$future_topic_sha"
git -C "$fetch_checkout" fetch --quiet --no-tags upstream \
    "$captured_upstream_sha" \
    || fail "could not fetch the captured upstream object"
[ "$(git -C "$fetch_checkout" rev-parse FETCH_HEAD)" = "$captured_upstream_sha" ] \
    || fail "exact upstream fetch wrote a different FETCH_HEAD"
git -C "$fetch_checkout" cat-file -e "$captured_upstream_sha^{commit}" \
    || fail "exact upstream fetch omitted the captured commit"
for excluded_sha in "$future_upstream_sha" "$future_topic_sha"; do
    if git -C "$fetch_checkout" cat-file -e "$excluded_sha^{commit}" 2>/dev/null; then
        fail "exact upstream fetch imported a later upstream object: $excluded_sha"
    fi
done
if git -C "$fetch_checkout" for-each-ref --format='%(refname)' \
    refs/remotes/upstream/ | grep -q .; then
    fail "exact upstream fetch populated moving upstream tracking refs"
fi
git --git-dir="$upstream_repo" update-ref refs/heads/main "$upstream_main_sha"
git --git-dir="$upstream_repo" update-ref -d refs/heads/future/topic

git clone --quiet --origin fork --branch integration "$fork_repo" "$checkout"
git -C "$checkout" remote add upstream "$upstream_repo"
git -C "$checkout" branch main "$old_main_sha"
git -C "$checkout" branch carry/alpha "$carry_sha"
printf 'pr/open\t%s\t123\n' "$pr_sha" >"$open_pr_heads"

# Create a fork branch only after cloning, so its commit is genuinely absent
# from the bound checkout when branch reconciliation starts.
git -C "$seed" switch --quiet --detach "$old_main_sha"
git -C "$seed" switch --quiet -c late/topic
printf 'late\n' >"$seed/late"
git -C "$seed" add late
git -C "$seed" commit --quiet -m late
late_sha=$(git -C "$seed" rev-parse HEAD)
git -C "$seed" push --quiet "$fork_repo" \
    "$late_sha:refs/heads/late/topic"
if git -C "$checkout" cat-file -e "$late_sha^{commit}" 2>/dev/null; then
    fail "late-branch fixture object is already in the bound checkout"
fi

run_policy() {
    MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
    MAINTAIN_CHECKOUT="$checkout" \
    MAINTAIN_UPSTREAM_SHA="$upstream_main_sha" \
    MAINTAIN_OPEN_PR_HEADS_FILE="$open_pr_heads" \
    bash "$script" "$@"
}

ref_sha() {
    git --git-dir="$fork_repo" rev-parse --verify "refs/heads/$1" 2>/dev/null
}

assert_ref() {
    local branch="$1" expected="$2" actual
    actual=$(ref_sha "$branch") || fail "missing fork branch $branch"
    [ "$actual" = "$expected" ] \
        || fail "$branch is $actual, expected $expected"
}

assert_missing_ref() {
    if ref_sha "$1" >/dev/null; then
        fail "unexpected fork branch $1"
    fi
}

set +e
unpinned_output=$(
    MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
    MAINTAIN_CHECKOUT="$checkout" \
    MAINTAIN_OPEN_PR_HEADS_FILE="$open_pr_heads" \
    bash "$script" --check 2>&1
)
unpinned_status=$?
set -e
[ "$unpinned_status" -ne 0 ] \
    || fail "accepted branch reconciliation without a one-shot upstream target"
printf '%s\n' "$unpinned_output" \
    | grep -F 'MAINTAIN_UPSTREAM_SHA is required' >/dev/null \
    || fail "did not explain the missing one-shot upstream target"

before_check=$(git --git-dir="$fork_repo" for-each-ref \
    --format='%(refname)%09%(objectname)' refs/heads | LC_ALL=C sort)
local_refs_before=$(git -C "$checkout" show-ref)
local_config_before=$(git -C "$checkout" config --local --list)
check_output=$(run_policy --check)
after_check=$(git --git-dir="$fork_repo" for-each-ref \
    --format='%(refname)%09%(objectname)' refs/heads | LC_ALL=C sort)
[ "$before_check" = "$after_check" ] \
    || fail "--check changed fork refs"
[ "$(git -C "$checkout" show-ref)" = "$local_refs_before" ] \
    || fail "--check changed local refs"
[ "$(git -C "$checkout" config --local --list)" = "$local_config_before" ] \
    || fail "--check changed local config"
if git -C "$checkout" cat-file -e "$late_sha^{commit}" 2>/dev/null; then
    fail "--check imported remote objects into the bound checkout"
fi
if git -C "$checkout" rev-parse --verify --quiet \
    refs/remotes/upstream/main >/dev/null; then
    fail "--check created upstream/main tracking state"
fi
printf '%s\n' "$check_output" \
    | grep -F "MAIN main $old_main_sha -> $upstream_main_sha" >/dev/null \
    || fail "--check omitted the main mirror plan"
printf '%s\n' "$check_output" \
    | grep -F "KEEP-PR #123 pr/open $pr_sha" >/dev/null \
    || fail "--check omitted the open PR head"
printf '%s\n' "$check_output" \
    | grep -F "KEEP-OTHER stale/topic $stale_sha" \
        >/dev/null \
    || fail "--check omitted an undeclared branch"
printf '%s\n' "$check_output" \
    | grep -F "KEEP-OTHER late/topic $late_sha" \
        >/dev/null \
    || fail "--check omitted a late-created undeclared branch"
printf '%s\n' "$check_output" \
    | grep -F "KEEP-DELETEME DELETEME/already $quarantine_sha" \
        >/dev/null \
    || fail "--check omitted an explicit deletion marker"

# Upstream movement after the cycle target was selected belongs to the next
# invocation. Reconciliation remains pinned even if the remote branch advances.
git --git-dir="$upstream_repo" update-ref refs/heads/main "$future_upstream_sha"
pinned_output=$(run_policy --check)
printf '%s\n' "$pinned_output" \
    | grep -F "MAIN main $old_main_sha -> $upstream_main_sha" >/dev/null \
    || fail "reconciliation chased upstream beyond the cycle's pinned target"
git --git-dir="$upstream_repo" update-ref refs/heads/main "$upstream_main_sha"

# A required local-main move is refused while another worktree has main checked
# out, before any fork ref is changed.
main_worktree="$test_root/main-worktree"
git -C "$checkout" worktree add --quiet "$main_worktree" main
set +e
checked_out_output=$(run_policy --apply 2>&1)
checked_out_status=$?
set -e
[ "$checked_out_status" -ne 0 ] \
    || fail "moved a main branch checked out in another worktree"
printf '%s\n' "$checked_out_output" \
    | grep -F 'local main is checked out in another worktree' >/dev/null \
    || fail "did not explain the checked-out main refusal"
after_refusal=$(git --git-dir="$fork_repo" for-each-ref \
    --format='%(refname)%09%(objectname)' refs/heads | LC_ALL=C sort)
[ "$before_check" = "$after_refusal" ] \
    || fail "checked-out main refusal changed fork refs"
git -C "$checkout" worktree remove "$main_worktree"

# A PR that opens after planning but before the atomic push aborts the whole
# policy. The second fixture line models late/topic becoming an open PR head.
real_git=$(command -v git)
race_bin="$test_root/race-bin"
mkdir "$race_bin"
ln -s "$root/tests/fixtures/race-git.sh" "$race_bin/git"
pr_race_lock="$test_root/pr-race-lock"
set +e
pr_race_output=$(
    PATH="$race_bin:$PATH" \
    MAINTAIN_REAL_GIT="$real_git" \
    MAINTAIN_RACE_TRIGGER=worktree \
    MAINTAIN_RACE_ACTION=write-pr-fixture \
    MAINTAIN_RACE_LOCK="$pr_race_lock" \
    MAINTAIN_RACE_PR_FILE="$open_pr_heads" \
    MAINTAIN_RACE_PR_LINES=$'pr/open\t'"$pr_sha"$'\t123\nlate/topic\t'"$late_sha"$'\t124' \
    run_policy --apply 2>&1
)
pr_race_status=$?
set -e
[ "$pr_race_status" -ne 0 ] \
    || fail "ignored an open-PR inventory change"
printf '%s\n' "$pr_race_output" \
    | grep -F 'open pull-request heads changed since planning; rerun' \
        >/dev/null \
    || fail "did not explain the open-PR inventory change"
after_pr_race=$(git --git-dir="$fork_repo" for-each-ref \
    --format='%(refname)%09%(objectname)' refs/heads | LC_ALL=C sort)
[ "$before_check" = "$after_pr_race" ] \
    || fail "open-PR inventory refusal changed fork refs"
printf 'pr/open\t%s\t123\n' "$pr_sha" >"$open_pr_heads"

# A concurrent main update after inventory trips the exact lease and leaves the
# whole core-and-carry atomic push unapplied.
race_lock="$test_root/race-lock"
set +e
raced_output=$(
    PATH="$race_bin:$PATH" \
    MAINTAIN_REAL_GIT="$real_git" \
    MAINTAIN_RACE_LOCK="$race_lock" \
    MAINTAIN_RACE_REPO="$fork_repo" \
    MAINTAIN_RACE_REF=refs/heads/main \
    MAINTAIN_RACE_SHA="$pr_sha" \
    run_policy --apply 2>&1
)
raced_status=$?
set -e
[ "$raced_status" -ne 0 ] || fail "accepted a stale main lease"
printf '%s\n' "$raced_output" \
    | grep -F 'could not atomically apply the fork branch policy' >/dev/null \
    || fail "did not explain the stale lease refusal"
assert_ref main "$pr_sha"
assert_missing_ref carry/alpha
assert_ref stale/topic "$stale_sha"
assert_ref late/topic "$late_sha"
git --git-dir="$fork_repo" update-ref refs/heads/main "$old_main_sha"

run_policy --apply >/dev/null
assert_ref main "$upstream_main_sha"
assert_ref integration "$integration_sha"
assert_ref carry/alpha "$carry_sha"
assert_ref pr/open "$pr_sha"
assert_ref stale/topic "$stale_sha"
assert_ref late/topic "$late_sha"
assert_ref already "$quarantine_sha"
assert_ref DELETEME/already "$quarantine_sha"
for excluded_sha in "$future_upstream_sha" "$future_topic_sha"; do
    if git -C "$checkout" cat-file -e "$excluded_sha^{commit}" 2>/dev/null; then
        fail "branch reconciliation imported a later upstream object: $excluded_sha"
    fi
done
if git -C "$checkout" rev-parse --verify --quiet \
    refs/remotes/upstream/future/topic >/dev/null; then
    fail "branch reconciliation imported a later upstream topic ref"
fi
expected_heads=$(printf '%s\n' \
    already \
    DELETEME/already \
    carry/alpha \
    integration \
    late/topic \
    main \
    pr/open \
    stale/topic | LC_ALL=C sort)
actual_heads=$(git --git-dir="$fork_repo" for-each-ref \
    --format='%(refname:strip=2)' refs/heads | LC_ALL=C sort)
[ "$actual_heads" = "$expected_heads" ] \
    || fail "fork changed an undeclared head"

[ "$(git -C "$checkout" rev-parse main)" = "$upstream_main_sha" ] \
    || fail "local main was not fast-forwarded"
[ "$(git -C "$checkout" config branch.main.remote)" = upstream ] \
    || fail "local main does not pull from upstream"
[ "$(git -C "$checkout" config branch.main.merge)" = refs/heads/main ] \
    || fail "local main does not pull upstream/main"
[ "$(git -C "$checkout" config branch.main.pushRemote)" = fork ] \
    || fail "local main does not push to fork"
[ "$(git -C "$checkout" config branch.carry/alpha.remote)" = fork ] \
    || fail "carry branch does not track fork"
[ "$(git -C "$checkout" config branch.carry/alpha.merge)" \
    = refs/heads/carry/alpha ] \
    || fail "carry branch tracks a non-carry ref"
[ "$(git -C "$checkout" config branch.carry/alpha.pushRemote)" = fork ] \
    || fail "carry branch does not push to fork"

# Reapplying an already converged policy is safe, including when main is checked
# out elsewhere and no longer needs to move.
git -C "$checkout" worktree add --quiet "$main_worktree" main
run_policy --apply >/dev/null
git -C "$checkout" worktree remove "$main_worktree"

# A carry branch not present in integration is never published.
git -C "$checkout" branch carry/not-integrated "$pr_sha"
set +e
bad_carry_output=$(run_policy --check 2>&1)
bad_carry_status=$?
set -e
[ "$bad_carry_status" -ne 0 ] \
    || fail "accepted a carry branch outside integration"
printf '%s\n' "$bad_carry_output" \
    | grep -F 'carry/not-integrated is not included in fork/integration' \
        >/dev/null \
    || fail "did not explain the rejected carry branch"
git -C "$checkout" branch --delete --force carry/not-integrated >/dev/null
assert_missing_ref carry/not-integrated

# Open PR heads are frozen to the exact commit returned by GitHub.
printf 'pr/open\t%s\t123\n' "$stale_sha" >"$open_pr_heads"
set +e
bad_pr_output=$(run_policy --check 2>&1)
bad_pr_status=$?
set -e
[ "$bad_pr_status" -ne 0 ] || fail "accepted a moved open PR head"
printf '%s\n' "$bad_pr_output" \
    | grep -F 'open PR #123 head pr/open moved during inventory' >/dev/null \
    || fail "did not explain the moved open PR head"
printf 'pr/open\t%s\t123\n' "$pr_sha" >"$open_pr_heads"
assert_ref pr/open "$pr_sha"

# An ordinary branch and an explicit deletion marker may coexist. Reconciliation
# reports and preserves both because neither is an inferred transition.
git --git-dir="$fork_repo" update-ref refs/heads/collision "$stale_sha"
git --git-dir="$fork_repo" update-ref refs/heads/DELETEME/collision "$pr_sha"
collision_output=$(run_policy --check)
printf '%s\n' "$collision_output" \
    | grep -F "KEEP-OTHER collision $stale_sha" \
        >/dev/null \
    || fail "did not report the ordinary collision branch"
printf '%s\n' "$collision_output" \
    | grep -F "KEEP-DELETEME DELETEME/collision $pr_sha" \
        >/dev/null \
    || fail "did not report the explicit deletion marker"
run_policy --apply >/dev/null
assert_ref collision "$stale_sha"
assert_ref DELETEME/collision "$pr_sha"
git --git-dir="$fork_repo" update-ref -d refs/heads/collision
git --git-dir="$fork_repo" update-ref -d refs/heads/DELETEME/collision

# A tracking ref for a fork branch someone else deleted is pruned, not left
# behind. Applying the policy is the only thing that refreshes the bound
# checkout's view of the fork, and a stale remote-tracking ref outlives the
# branch it tracks: a tool reading publication as evidence that a branch is
# somebody's carry would hold its worktree out of lifecycle work forever.
git --git-dir="$fork_repo" update-ref refs/heads/departed "$stale_sha"
git -C "$checkout" fetch --quiet fork \
    || fail "could not fetch the fork branch to be pruned"
git -C "$checkout" rev-parse --verify --quiet refs/remotes/fork/departed \
    >/dev/null || fail "could not establish the tracking ref to be pruned"
git --git-dir="$fork_repo" update-ref -d refs/heads/departed
run_policy --apply >/dev/null
if git -C "$checkout" rev-parse --verify --quiet refs/remotes/fork/departed \
    >/dev/null; then
    fail "a tracking ref for a deleted fork branch survived reconciliation"
fi

# Neither local nor fork main may contain commits outside upstream main.
git --git-dir="$fork_repo" update-ref refs/heads/main "$pr_sha"
set +e
diverged_output=$(run_policy --check 2>&1)
diverged_status=$?
set -e
[ "$diverged_status" -ne 0 ] || fail "accepted a diverged fork main"
printf '%s\n' "$diverged_output" \
    | grep -F 'fork/main has commits outside upstream/main' >/dev/null \
    || fail "did not explain the diverged fork main"
git --git-dir="$fork_repo" update-ref refs/heads/main "$upstream_main_sha"

# The linear-stack model publishes no carries and validates no pull-request
# heads. Carry-named, former-request, and offer branches all remain unchanged.
linear_fork="$test_root/linear-fork.git"
linear_checkout="$test_root/linear-checkout"
git clone --quiet --bare "$fork_repo" "$linear_fork"
git --git-dir="$linear_fork" update-ref refs/heads/offer/fix "$pr_sha"
git clone --quiet --origin fork --branch integration "$linear_fork" "$linear_checkout"
git -C "$linear_checkout" remote add upstream "$upstream_repo"
git -C "$linear_checkout" branch main "$upstream_main_sha"
linear_output=$(
    MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
    MAINTAIN_CHECKOUT="$linear_checkout" \
    MAINTAIN_UPSTREAM_SHA="$upstream_main_sha" \
    MAINTAIN_CARRY_PREFIX='' \
    MAINTAIN_PRESERVE_OPEN_PRS=0 \
    bash "$script" --check
)
printf '%s\n' "$linear_output" \
    | grep -F "KEEP-OTHER carry/alpha $carry_sha" >/dev/null \
    || fail "linear model omitted a carry-named ordinary head"
printf '%s\n' "$linear_output" \
    | grep -F "KEEP-OTHER pr/open $pr_sha" >/dev/null \
    || fail "linear model omitted a former pull-request head"
printf '%s\n' "$linear_output" \
    | grep -F "KEEP-OTHER offer/fix $pr_sha" >/dev/null \
    || fail "linear model omitted an offered branch"
if printf '%s\n' "$linear_output" | grep -E '^(PUBLISH|KEEP-PR)' >/dev/null; then
    fail "linear model published a carry or froze a pull-request head"
fi
MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
MAINTAIN_CHECKOUT="$linear_checkout" \
MAINTAIN_UPSTREAM_SHA="$upstream_main_sha" \
MAINTAIN_CARRY_PREFIX='' \
MAINTAIN_PRESERVE_OPEN_PRS=0 \
    bash "$script" --apply >/dev/null
linear_heads=$(git --git-dir="$linear_fork" for-each-ref \
    --format='%(refname:strip=2)' refs/heads | LC_ALL=C sort)
expected_linear=$(printf '%s\n' \
    already \
    DELETEME/already \
    carry/alpha \
    integration \
    late/topic \
    main \
    offer/fix \
    pr/open \
    stale/topic | LC_ALL=C sort)
[ "$linear_heads" = "$expected_linear" ] \
    || fail "linear model changed an undeclared head: $linear_heads"

# Declared names are validated before anything is read.
set +e
bad_prefix_output=$(
    MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
    MAINTAIN_CHECKOUT="$checkout" \
    MAINTAIN_QUARANTINE_PREFIX=DELETEME \
    bash "$script" --check 2>&1
)
bad_prefix_status=$?
set -e
[ "$bad_prefix_status" -ne 0 ] || fail "accepted a quarantine prefix without a slash"
printf '%s\n' "$bad_prefix_output" \
    | grep -F 'the quarantine prefix must end with a slash' >/dev/null \
    || fail "did not explain the bad quarantine prefix"

# The declaration is also data. --print-model must answer without touching the
# repository, because a tool asking how a fork is shaped is not doing
# maintenance and may be watching a checkout it must not disturb.
model_refs_before=$(git -C "$checkout" show-ref)
model_config_before=$(git -C "$checkout" config --local --list)
model_output=$(
    MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
    MAINTAIN_CHECKOUT="$checkout" \
    MAINTAIN_WORKSHOP="$workshop" \
    bash "$script" --print-model
)
for field in \
    "\"checkout\": \"$checkout\"" \
    "\"workshop\": \"$workshop\"" \
    '"mirror_branch": "main"' \
    '"integration_branch": "integration"' \
    '"carry_prefix": "carry/"' \
    '"quarantine_prefix": "DELETEME/"'
do
    printf '%s\n' "$model_output" | grep -F -- "$field" >/dev/null \
        || fail "--print-model omitted $field"
done
[ "$(git -C "$checkout" show-ref)" = "$model_refs_before" ] \
    || fail "--print-model changed local refs"
[ "$(git -C "$checkout" config --local --list)" = "$model_config_before" ] \
    || fail "--print-model changed local config"

# Supervision converges that declaration into the fork's own config, which is
# how a tool holding only the repository learns its trunk.
set +e
unconfigured_output=$(
    MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
    MAINTAIN_CHECKOUT="$checkout" \
    MAINTAIN_WORKSHOP="$workshop" \
    bash "$script" --check-supervision 2>&1
)
unconfigured_status=$?
set -e
[ "$unconfigured_status" -ne 0 ] || fail "--check-supervision passed before convergence"
printf '%s\n' "$unconfigured_output" | grep -F 'run --configure-supervision' >/dev/null \
    || fail "--check-supervision did not name the remedy"

MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
MAINTAIN_CHECKOUT="$checkout" \
MAINTAIN_WORKSHOP="$workshop" \
    bash "$script" --configure-supervision >/dev/null
for pair in \
    "supervisor.trunk integration" \
    "supervisor.mirror main" \
    "supervisor.carryPrefix carry/" \
    "supervisor.quarantinePrefix DELETEME/" \
    "supervisor.workshop $workshop"
do
    key=${pair%% *}
    want=${pair#* }
    have=$(git -C "$checkout" config --get "$key") \
        || fail "supervision did not set $key"
    [ "$have" = "$want" ] || fail "$key is $have, expected $want"
done
[ "$(git -C "$checkout" show-ref)" = "$model_refs_before" ] \
    || fail "--configure-supervision changed local refs"
MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
MAINTAIN_CHECKOUT="$checkout" \
MAINTAIN_WORKSHOP="$workshop" \
    bash "$script" --check-supervision >/dev/null \
    || fail "--check-supervision rejected its own convergence"

# An empty carry prefix is a real declaration, not a missing one.
MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
MAINTAIN_CHECKOUT="$linear_checkout" \
MAINTAIN_CARRY_PREFIX='' \
    bash "$script" --configure-supervision >/dev/null
linear_carry=$(git -C "$linear_checkout" config --get supervisor.carryPrefix) \
    || fail "an empty carry prefix was left undeclared"
[ -z "$linear_carry" ] || fail "empty carry prefix became $linear_carry"

# The spec is the human contract; drifting from it fails while both are cheap
# to reconcile.
printf '# Fork\n\n## Branch model\n\n- Mirror branch: main.\n' >"$workshop/MAINTAIN.md"
set +e
drift_output=$(
    MAINTAIN_ALLOW_LOCAL_REMOTES=1 \
    MAINTAIN_CHECKOUT="$checkout" \
    MAINTAIN_WORKSHOP="$workshop" \
    bash "$script" --check-supervision 2>&1
)
drift_status=$?
set -e
[ "$drift_status" -ne 0 ] || fail "accepted a MAINTAIN.md that omits the integration branch"
printf '%s\n' "$drift_output" \
    | grep -F 'does not name the integration branch integration' >/dev/null \
    || fail "did not explain the specification drift"

printf 'branch policy validation passed.\n'
