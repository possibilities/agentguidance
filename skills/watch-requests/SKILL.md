---
name: watch-requests
description: Survey the open pull requests we have sent to upstream repositories — inferred from this machine's checkouts, never a kept list — then, on approval, run a standing watch that keeps each one moving; routing failing CI, reviews, and stale branches back to the session that opened the request, and carrying out the recorded follow-up when one lands. Use when asked to check on our PRs, watch or babysit upstream contributions, to recheck what is out there, or when a sent pull request needs tending until merge.
---

# Watch requests

A pull request sent to someone else's repository stalls without tending:
CI breaks against a moved base, reviewers ask for changes, the branch
falls behind. This skill is the standing watch — first a survey of what
is out there, then, with approval, a loop that keeps every open request
moving and knows what to do when one lands.

## Survey

Find the requests rather than asking for them:

- Enumerate the git checkouts on this machine — the operator's own
  projects and the clones of other people's kept for patches and
  research. The machine's conventions say where both live; infer from
  them rather than keeping a list here.
- For each checkout, resolve the upstream repository from its remotes:
  a remote owned by someone else is the upstream directly, and a remote
  that is our fork points at its parent
  (`gh api repos/{owner}/{repo} --jq .parent.full_name`). Dedupe across
  checkouts.
- List the open requests we authored against each upstream:
  `gh pr list --repo UPSTREAM --author @me --state open`. A global
  `gh search prs --author @me --state open` is a useful cross-check for
  upstreams with no local checkout, but the checkout walk is the source
  of truth.

## Report and get approval

Before watching anything, present the survey: one line per request —
repository, number, title, CI state, review state, mergeability, and
when a maintainer last touched it. Note any request already covered by
a dedicated watch elsewhere (a standing memory, another session) and
leave those to their owner. Then wait for plain-text approval to start
watching; the survey alone is a complete, useful answer.

## The watch

Poll through the harness's scheduling facility — never a busy loop.
Match the cadence to the activity: an active review conversation is
worth checking every few minutes; a maintainer silent for weeks is a
daily glance. Silence is the steady state and is not reportable.

Each poll compares against the last known state and acts by event. The
watch is a watch: it diagnoses, it does not author. Anything that would
change the branch is handed back (below) rather than done here.

- **CI failing** — read the failure and pull out the diagnosis: the job,
  the failing step, the log excerpt that names the cause. A failure that
  smells like a flake earns one re-run before anything else. A real
  failure becomes a handoff.
- **Comment** — answer it here only when the answer is information the
  watch already holds and no commit follows. Anything needing a code
  change is a handoff.
- **Changes requested** — never make the change here. Summarize what was
  asked, note whether the branch is also stale, and hand it back.
- **Fallen behind or conflicting** — a handoff; the rebase belongs to
  the session that owns the branch.
- **Merge or close** — notify the human, then check for recorded
  follow-up (below).
- **Anything else** — a situation these rules do not cover means
  notifying the human, not improvising.

## Hand the work back

Work on a request belongs to the session that opened it — that session
holds the reasoning, the worktree, and the branch. The watch's job is to
find it and aim it, never to fix the branch itself and never to push.

- **Find the origin.** The head branch and its commits name the
  checkout; `git worktree list` in that repository (and in our fork's
  checkout when we carry patches there) finds the worktree the branch
  lives in. Then find the session with the `chats` skill — cass over the
  branch name, the request number, or the worktree path as workspace —
  and take its `source_path`, agent, and workspace from the hit.
- **Get the resume command from the tool, not from memory:**
  `cass resume <source_path> --shell` prints the native invocation for
  that session's harness. Hand it over; never run a nested agent
  yourself.
- **Write the steering prompt.** One block the human can paste into the
  resumed session, carrying everything it needs and nothing it can look
  up: which request (repository, number, URL), the branch and head sha,
  what happened in the words of the event — the failing job and log
  excerpt, or the reviewer's request quoted — what needs to happen, and
  where it lands when done.
- **Reach the human** through the notify skill with the outcome in one
  line, then put the resume command and the steering prompt in the
  transcript for them.
- **When no origin session can be found**, say so plainly and hand over
  the steering prompt anyway, naming the repository and worktree the
  branch lives in. A missing session log makes the handoff colder, not
  optional.

## Rechecking on demand

"Check on our requests" against a running watch is two jobs, and both
are re-runs of what has already been established rather than new
invention:

- **Re-survey.** Run the survey again from the checkouts to catch
  requests opened since the watch started, and requests that have left
  the open set.
- **Reconcile.** Re-run the status check on every watched request and
  compare it against the state the watch believes it is in. Report the
  drift as drift — a request the watch thinks is green that is failing,
  or one it thinks is open that merged — and treat each difference as
  its event above. Correct the watch's recorded state so the next poll
  compares against reality.

Then report the whole picture, watched and new alike, in the survey's
one-line-per-request shape.

## After a merge

A merged request sometimes has consequences on this machine — the
classic case is a fork carried only for the patch, which collapses back
to a plain upstream install once the patch lands. Check the machine's
records — memory, the wiki, the affected repository's own guidance —
for a recorded follow-up process. When one is recorded, do the work and
report it. When none is, say the request landed and stop; never invent
cleanup.

## Reaching the human

Route anything that needs the human through the notify skill so it
lands even when they are away from the terminal, and write it as the
outcome in one line.
