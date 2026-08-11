---
name: watch-requests
description: Survey the open pull requests we have sent to upstream repositories — inferred from this machine's checkouts, never a kept list — then, on approval, run a standing watch that keeps each one moving; routing failing CI, reviews, and stale branches back to the session that opened the request, and routing a merge's aftermath to the repository that owns the wiring. Use when asked to check on our PRs, watch or babysit upstream contributions, to recheck what is out there, or when a sent pull request needs tending until merge.
---

# Watch requests

A pull request sent to someone else's repository stalls without tending:
CI breaks against a moved base, reviewers ask for changes, the branch
falls behind. This skill is the standing watch — first a survey of what
is out there, then, with approval, a loop that keeps every open request
moving and knows what to do when one lands. The watch watches: every
piece of work it finds leaves as a prompt for the session or repository
that owns it, never as a commit of its own.

## Scope

Where the session started decides how wide the survey goes, unless the
request says otherwise:

- **Machine-wide** — started outside any git checkout, or inside the
  checkout that administers this machine's fleet (`~/code/agentstart`),
  which owns the machine's toolchain rather than one project. Walk every
  checkout.
- **This project only** — started in any other checkout. Survey that
  repository alone: its own upstream, its own requests. A project
  session asking about its requests does not want the machine's.

Say which scope is in play in the report, so a narrow survey is never
mistaken for the whole picture.

## Survey

Find the requests rather than asking for them:

- Enumerate the git checkouts in scope. Machine-wide, that is every
  checkout on the machine — the operator's own projects and the clones
  of other people's kept for patches and research; the machine's
  conventions say where both live, so infer from them rather than
  keeping a list here. Project scope is the one checkout, plus the
  worktrees and sibling checkouts of that same repository.
- For each checkout, resolve the upstream repository from its remotes:
  a remote owned by someone else is the upstream directly, and a remote
  that is our fork points at its parent
  (`gh api repos/{owner}/{repo} --jq .parent.full_name`). Dedupe across
  checkouts.
- List the open requests we authored against each upstream:
  `gh pr list --repo UPSTREAM --author @me --state open`. A global
  `gh search prs --author @me --state open` is a useful cross-check for
  upstreams with no local checkout, but the checkout walk is the source
  of truth — and under project scope the cross-check is filtered to that
  upstream, not a back door to the machine-wide list.

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
- **Put the working standard in the prompt**, because the resumed
  session is the one doing the work and the watch is not there to
  supervise it. State, in the prompt itself: rebase onto the current
  base first when the branch is stale; reproduce the failure locally
  when the logs alone do not explain it; adversarially self-review the
  change before pushing when the change merits it; answer the feedback
  in the commits and, where prose is owed, a reply comment — an
  automated reviewer usually needs none; then push and watch the run to
  green rather than stopping at the push.
- **Reach the human** through the notify skill with the outcome in one
  line, then put the delivery and the prompt in the transcript for them
  (below).
- **When no origin session can be found**, say so plainly and hand the
  prompt over as fresh-agent work in the worktree the branch lives in,
  naming the repository and the branch. A missing session log makes the
  handoff colder, not optional.

## The shape of a handoff

Everything the watch produces is a prompt for someone else to run, and
each one arrives with its delivery attached. The watch never executes
the work, in this repository or any other.

Two deliveries, and a handoff may carry both:

- **Resume an existing session** — the right delivery when the work
  continues something a session already holds: the branch, the
  reasoning, the review conversation. Give the exact command from
  `cass resume <source_path> --shell`, then the prompt to paste into it.
- **Start a new agent in a directory** — the right delivery when the
  work belongs to a repository rather than to a conversation. Give the
  working directory plainly, then a prompt written for someone with no
  history at all: what happened, what to do, how to verify it, and every
  fact it would otherwise have to reconstruct.

When several prompts come out of one poll, present them as a set — one
per piece of work, each labelled with its delivery — rather than a
paragraph the human has to disentangle.

## Rechecking on demand

"Check on our requests" against a running watch is two jobs, and both
are re-runs of what has already been established rather than new
invention:

- **Re-survey.** Run the survey again from the checkouts, at the scope
  the watch was started with, to catch requests opened since then and
  requests that have left the open set.
- **Reconcile.** Re-run the status check on every watched request and
  compare it against the state the watch believes it is in. Report the
  drift as drift — a request the watch thinks is green that is failing,
  or one it thinks is open that merged — and treat each difference as
  its event above. Correct the watch's recorded state so the next poll
  compares against reality.

Then report the whole picture, watched and new alike, in the survey's
one-line-per-request shape.

## After a merge

A merged request usually has consequences on this machine, and they
rarely land in the repository the patch was written against. A fork
carried only for the patch collapses back to a plain upstream install; a
pinned version moves once the fix ships in a release; an installer stops
provisioning something. That work belongs to whichever repository owns
the wiring — often the one that administers the machine's toolchain,
sometimes the fleet repo whose installer does the provisioning — and the
watch hands it over exactly like everything else.

- **Find the recorded follow-up.** Check the machine's records — memory,
  the wiki, the owning repository's own guidance — for the process. When
  none is recorded, say the request landed and stop; never invent
  cleanup.
- **Find the owner.** The repository whose installer, pin, or guidance
  encodes the thing that must change. That is the working directory the
  aftermath prompt is aimed at, and it is usually not where the patch
  was written.
- **Write it as fresh-agent work in that directory**, not as a resume:
  the aftermath is a new job in another repository, and the session that
  wrote the patch has nothing useful to contribute to it. The prompt
  carries which request merged and where, the release or version that
  now carries the fix when there is one, the recorded procedure quoted
  or cited by page, the files known to encode the old arrangement, and
  the check that proves it converged — the repository's own validation
  command, and a rerun of its installer where that is how it converges.
- **Notify and hand over** the directory and the prompt, alongside the
  merge itself.

## Reaching the human

Route anything that needs the human through the notify skill so it
lands even when they are away from the terminal, and write it as the
outcome in one line.
