---
name: watch-requests
description: Survey the open pull requests we have sent to upstream repositories — inferred from this machine's checkouts, never a kept list — then, on approval, run a standing watch that keeps each one moving; fixing failing CI, answering reviews, rebasing, and carrying out the recorded follow-up when one lands. Use when asked to check on our PRs, watch or babysit upstream contributions, or when a sent pull request needs tending until merge.
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

Each poll compares against the last known state and acts by event:

- **CI failing** — fix it in the loop: read the failure, reproduce it
  where the logs are not enough, push the fix, and keep watching until
  the run is green. A failure that smells like a flake earns one re-run
  before a fix.
- **Comment** — take the action if one is available and report what was
  done; surface it to the human only when it genuinely needs them.
- **Changes requested** — rebase first if the branch is stale, make the
  change, and when the change merits it, adversarially self-review it
  before pushing. Answer the feedback in the commits and/or a reply
  comment — an automated reviewer usually needs no prose reply.
- **Fallen behind or conflicting** — rebase onto the current base and
  push.
- **Merge or close** — notify the human, then check for recorded
  follow-up (below).
- **Anything else** — a situation these rules do not cover means
  notifying the human, not improvising.

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
