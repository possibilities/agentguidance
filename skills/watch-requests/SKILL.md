---
name: watch-requests
description: Survey the open pull requests we have sent to upstream repositories — inferred from this machine's checkouts, never a kept list — then, on approval, run a standing watch that keeps each one moving; routing failing CI, reviews, and stale branches back to the session that opened the request, and routing a merge's aftermath to the repository that owns the wiring. Use when asked to check on our PRs, watch or babysit upstream contributions, to recheck what is out there, or when a sent pull request needs tending until merge.
disable-model-invocation: true
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
  checkouts, and drop any upstream that is archived — `.archived` on the
  same response — at resolution rather than filtering its requests
  later. An archived repository can never merge or close anything, so a
  request against one is unactionable rather than pending; excluding it
  where the set is built keeps every stage downstream free of a special
  case for it.
- In a fork we carry patches on, read the branches by the machine's fork
  convention rather than by guesswork: `integration` is what the machine
  installs and is nobody's review context, and every other branch beside it
  is a patch offered upstream. A request's head branch is therefore always
  one of the latter, and a survey that reports `integration` as a pull
  request has misread the checkout.
- List the open requests we authored against each upstream:
  `gh pr list --repo UPSTREAM --author @me --state open`. A global
  `gh search prs --author @me --state open` is a useful cross-check for
  upstreams with no local checkout, but the checkout walk is the source
  of truth — and under project scope the cross-check is filtered to that
  upstream, not a back door to the machine-wide list.

## Report and get approval

Before watching anything, present the survey: one line per request —
repository, number, title, CI state, review state, mergeability, and
when a maintainer last touched it — read against how active the
repository itself is, never on its own, because the same silence means
different things from an absent maintainer and a busy one. Note any
request already covered by a dedicated watch elsewhere (a standing
memory, another session) and leave those to their owner. Then wait for
plain-text approval to start watching; the survey alone is a complete,
useful answer.

## The watch

Poll through the harness's scheduling facility — never a busy loop.
Match the cadence to the activity: an active review conversation is
worth checking every few minutes; a maintainer silent for weeks is a
daily glance. Silence is the steady state and is not reportable — and
most of what a poll turns up is silence wearing a different hat.

Judge maintainer activity from the repository, not from our request. A
maintainer who has not replied to us in three weeks while merging other
PRs daily is passing us over, not absent — a different situation, with a
nudge as a live option. Report the two differently.

Each poll compares against the last known state and acts by event. The
watch is a watch: it diagnoses, it does not author. Anything that would
change the branch is handed back (below) rather than done here.

A difference is not an event. The list below is the whole set of things
worth reporting; a poll that diffs raw API fields will fire on changes
that map to none of them.

- `mergeable` returns `UNKNOWN` whenever the base branch moves, until
  the merge commit is recomputed. Treat `UNKNOWN` as missing data, never
  as a state: re-read after a pause, carry the last verdict forward if
  still unresolved, and trust `mergeStateStatus` (`CLEAN`, `BEHIND`,
  `DIRTY`) over it.
- A CI rollup mid-run reads pending or partial. Let the run settle
  before calling it a failure.
- The head sha and comment count move for non-events — a rebase we asked
  for, an automated reviewer editing its summary in place. Most often of
  all, they move for our own activity: a comment count that counts our
  replies fires the watch on the sound of its own voice. Count only what
  someone other than us wrote.

The first comparison needs a baseline, and a guessed one is a false alarm
already loaded. Seed it by running one throwaway poll that records the
real state, then poll again and confirm the second is silent — only then
arm the watch. A watch that fires on its first tick is reporting that its
baseline was wrong, not that anything happened, and it costs nothing to
learn that before the watch is armed rather than after.

Confirm before reporting: re-read the request and name the event in this
skill's vocabulary. If the second read cannot name one, there was no
event, and the correct output is silence.

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
  follow-up (below). A merge does not always end the watch: when the
  aftermath waits on a release, the watch moves to the release.
- **Anything else** — a situation these rules do not cover means
  notifying the human, not improvising.

## The survey is not a one-time act

A watch that only ever polls the requests it was armed with goes stale
the moment another one is opened — and the session that opens it is
rarely the session doing the watching. So the survey runs on a schedule
of its own, mechanically, through the same scheduling facility as the
status poll and from the same checkout walk that produced it: enumerate
the checkouts in scope, resolve each upstream, list our open requests
against each with `gh pr list --repo UPSTREAM --author @me --state open`,
and diff that set against the watched set.

Sweep on the same cadence as the status poll. A request found ten
minutes after it was opened is still found before anyone has answered
it, and a slower sweep only widens the window where a live request is
invisible to the watch. Resolving upstreams is the expensive half of the
walk, so cache the resolved set in the scratchpad and re-resolve it only
when a checkout appears or disappears; the cheap half, listing our
requests per upstream, is what runs every sweep.

A sweep that could not reach an upstream has missing data, not an empty
one. Diffing a partial sweep against the watched set reports every
request on the unreachable upstream as merged or closed — so let the
sweep fail whole and try again rather than act on half of it.

Two differences come out of it, and both are events:

- **A request the watch has never seen** — report it in the survey's
  one-line shape, seed its baseline by the calibration above, and fold
  it into the watch. It arrives mid-flight and may already carry a
  review or a red run, so read its current state rather than assuming a
  new request is a quiet one.
- **A request that has left the open set** — merged or closed while the
  watch was not looking. Treat it as the merge-or-close event it is,
  aftermath and all, then prune its file from the state directory.

The sweep inherits the survey's scope and needs no exceptions bolted on
to it. Walking checkouts that exist and upstreams that are somebody
else's is what keeps the set small and every member of it actionable;
a request we cannot reach from a local checkout is not the watch's to
carry, and reaching for the global search to find one is how requests
nobody can act on end up in the report.

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
- **Reach the human** through the `notify` skill with the outcome in one
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

## Remembering across invocations

A watch outlives the session that armed it, and the session scratchpad
does not. Anything the watch must still know tomorrow lives in
`${XDG_STATE_HOME:-~/.local/state}/watch-requests/`, created on demand —
never in a session-scoped temporary directory, which loses the baseline
the moment the session ends and leaves the next one unable to tell drift
from a cold start.

It is a scratchpad and holds only state: one file per watched request,
named for its upstream and number, carrying the last known state in this
skill's event vocabulary rather than raw API fields; the watched set
itself; the cached upstream resolution; and any cursor a gate depends
on, such as the published version a release-gated aftermath waits for.
What does not belong there: secrets of any kind; handoff prose, which
belongs in the transcript where the human can act on it; and the pollers
themselves, which ship with this skill under `scripts/`.

That split is what keeps the pollers reusable. A watched set written
into the script is machine state masquerading as code — it goes stale
the moment a request is opened, and it makes the script unshippable.
`scripts/resurvey.sh` maintains the set in the scratchpad and
`scripts/poll.sh` reads it, so a request found by a sweep is watched by
the next poll without either script being edited. Run them with
`bash <path>`; both take no arguments, and both accept
`WATCH_REQUESTS_INTERVAL` for cadence.

The state directory holds only what is mechanical and regenerable.
Two other homes take what it cannot, and reaching for them is a
judgement call, not ceremony — write only what a later session would
otherwise have to reconstruct or would get wrong.

- **Memory** holds the arrangement: that a watch exists at all, the
  scope it was armed at, the escalation the operator asked for, which
  requests another session already owns, and any obligation this watch
  took on — a ping owed elsewhere when a merge lands is a promise, and a
  promise no one recorded is a promise broken by the next context
  window. None of this is derivable from the API, and all of it decides
  what the next session does before it polls anything.
- **The wiki** holds what outlives the machine and belongs to no single
  repository: how a fork is wired and what condition retires it, why a
  patch was carried, a standing decision about an upstream. Point at the
  page from wherever it constrains, so the aftermath can cite the
  recorded procedure instead of improvising one.

Keep each fact in one of the three and link rather than copy. The same
fact in two homes drifts, and a watch that believes a stale copy is
worse than one that had to go and look.

Treat the directory as a cache and never as the source of truth. The
checkouts and the API are authoritative; state on disk only spares us a
false alarm. A missing or stale file means re-survey and re-seed by the
calibration above — it never means there are no requests, and a watch
that reports an empty survey because its state directory was empty has
reported the directory, not the world. Prune a request's file when it
leaves the open set, so the directory stays a picture of what is being
watched rather than an archive of what once was.

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

A merged request has consequences on this machine, they rarely land in
the repository the patch was written against, and they arrive at two
different times. Immediately: the fork carrying that patch no longer
needs to carry it, so it rebases onto upstream's current head and the
merged commit falls out of the stack. Eventually: when the merged patch
was the last one the fork carried, the fork itself stops being needed
and the machine goes back to a plain upstream install — and with it move
the pinned version, the installer that provisions the fork, and the map
that describes it. That work belongs to whichever repository owns the
wiring — often the one that administers the machine's toolchain,
sometimes the fleet repo whose installer does the provisioning — and the
watch hands all of it over exactly like everything else.

The merge alone does not always license the second step. A fork
installed from a git checkout collapses as soon as the patch is
upstream. A fork standing in for a published package collapses only when
a release carrying the fix is published — merged but unreleased means
the registry still ships the bug, and unwiring early reinstalls it.
Which one is in play is decided by how the thing is installed, not by
how it was patched.

- **Rebase the fork, as a handoff.** Every merge, patches remaining or
  not: the fork's `integration` branch rebases onto upstream's head, the
  merged commit drops, and whatever the machine installs from that fork
  is rebuilt. Name that branch in the handoff — `integration`, not the
  request's own head branch, which is the review context and is not what
  the machine installs. The watch does not do this — it aims it at the
  fork's checkout, with the merge commit named so the resumed session can
  tell a dropped patch from a lost one.
- **When patches remain**, that is the whole aftermath. Say which
  patches the fork still carries — read them off `integration`, which is
  the merged stack — and stop; the collapse is not due yet.
- **When it was the last patch and the collapse is merge-gated**, hand
  over the unwiring now, by the rules below.
- **When it was the last patch and the collapse is release-gated**, do
  not hand over the unwiring yet — the watch stays alive on the
  registry instead of the request. Poll the published version at a
  cadence matched to that project's release rhythm, and confirm the
  merge is actually in the release — a changelog entry, a tag containing
  the commit, or the diff — because a version bump is not by itself
  evidence the fix shipped. Report the wait once when it begins, stay
  silent through it, and hand the unwiring over naming the release that
  carries the fix.
- **Find the recorded follow-up.** Check the machine's records — memory,
  the wiki, the owning repository's own guidance — for the process. When
  none is recorded, say the request landed and stop; never invent
  cleanup.
- **Find the owner.** The repository whose installer, pin, or guidance
  encodes the thing that must change. That is the working directory the
  aftermath prompt is aimed at, and it is usually not where the patch
  was written. For a fork, the owner is whichever installer declares the
  binding, and the collapse is that declaration flipped off and the
  installer re-run — never an edit to the installed shim, which the next
  install rewrites.
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

Route anything that needs the human through the `notify` skill so it
lands even when they are away from the terminal, and write it as the
outcome in one line.
