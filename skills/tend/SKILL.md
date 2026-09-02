---
name: tend
description: Watch inactive Git worktrees after their agents stop, wherever those worktrees live, then notify the human with a read-only minisketch for removing landed worktrees, catching divergent branches up to their repository's trunk, or inspecting ambiguous leftovers. Reads a carried fork's declared branch model from its own supervisor config, so an integration-based repository is judged against integration and its carry heads are never proposed for removal. Use for /tend or when asked to watch and triage inactive agent worktrees; it proposes lifecycle work but does not perform it.
disable-model-invocation: true
---

# Tend worktrees

Keep inactive agent worktrees from becoming forgotten directories or stale
branches. Tend observes and proposes. It never rebases, removes a worktree,
deletes a branch, merges, pushes, or edits a file.

`maintain` reconciles a carried fork. Tend is the lighter advisory loop around
ordinary worktrees whose agents have left; integration and publication remain
with the agent explicitly asked to do them.

## Start with a snapshot

Tend requires a Herdr-managed pane: verify `HERDR_ENV=1` before querying the
surface. Resolve this skill's directory and run:

```sh
bun scripts/watch.ts --once
```

The one JSON object is the current `tend_survey`. Git answers which linked
worktrees exist and how each branch relates to its repository's declared
trunk; Herdr answers whether any agent is still in one. Each proposal's
`session_slug` is Herdr's generated conversation name from
`tokens.conversation`, retained by the long-running watcher after that agent
exits. Treat `ownership_available: false` as a failed safety check, never as an
empty agent list.

Every agent row whose `cwd` or `foreground_cwd` is the worktree or lies inside
it protects that worktree. Status does not weaken the protection: `idle`,
`done`, `blocked`, `working`, and `unknown` all mean an agent is still there.

The roster is not the only witness, because it has been observed to omit an
agent that was demonstrably alive while still reporting
`ownership_available: true` — a worktree read as unowned on that evidence alone
is one a removal would take out from under a working process. So a worktree no
agent row claims is also checked against the machine: one `lsof -d cwd` sweep,
matched against every worktree considered.

There is a third witness, because the first two share a blind spot: an agent
driving a worktree through a shell, an editor or a subprocess registers no
agent row and may hold no descriptor there between commands, yet is plainly
working. What it cannot avoid leaving is an mtime. So every proposal carries
`last_activity_seconds` — how long ago something last wrote the worktree's
index, HEAD or reflog — and a lifecycle proposal on a worktree written inside
the quiet window (`--activity-window`, 900s by default) is reduced to
`inspect`, counted in `counts.downgraded_by_recent_activity`. Treat a non-zero
count as the roster under-reporting, not as noise: two live agents on this
machine have been observed mutating worktrees no roster row explained.

Recency cannot say *whose* write it was, and tend's own catch-up rebase moves
those same timestamps. So a removal pass straight after a catch-up will find
its own work in the window and hold off; either wait it out, or pass
`--activity-window 0`, which is a deliberate assertion that the caller has
established by other means that nothing is working there.

A fourth check asks a different question from the other three: not who is
present, but what removal destroys. `clean` and containment together say every
*tracked* byte is held by a branch. Neither says anything about ignored
content — Git excludes it from status by design, and `git worktree remove`
deletes it without a word, held by nothing. So every proposal reports
`ignored_paths`, and a proposal that ends in a removal is reduced to `inspect`
when any of them is not obviously reproducible (`ignored_unrecognized`,
counted in `counts.downgraded_by_ignored_content`). A dependency tree or build
output never blocks; a receipt, a ledger or a gate cache does. The judgement
distinguishes two kinds of name, because they behave differently as ancestors.
A tool-owned directory — `node_modules`, `.venv`, `.pytest_cache` — is
unambiguous wherever it appears, so everything beneath one is reproducible
too; Git does not always collapse an ignored directory, and a `.pytest_cache`
carrying its own `.gitignore` is reported file by file, whose names alone
("README.md") would otherwise read as irreplaceable. A generic name —
`build`, `dist`, `target` — counts only as the entry itself, because
`evidence/build/receipt.json` is a receipt that happens to live under a
directory called build, and letting that name claim its descendants is exactly
how the work is lost.
Only removals are gated: a catch-up rebase deletes no files.

A process found there does **not** protect the worktree, because a live agent
the roster missed and a helper some harness leaked and never reaped are
indistinguishable from outside — pid, parent, and age all fail to separate
them, and suppressing on the weaker reading would make exactly the worktrees
that most need cleaning permanently unremovable. Instead the proposal is
reduced to `inspect` and names the pid, so no proposed operation ever runs
underneath a process without a human having looked. `counts.downgraded_by_process`
says how often that happened; a non-zero count is worth reading as a question
about the roster, not only about the worktrees.

The helper considers every linked worktree its repositories register, wherever
that worktree lives: below `~/.herdr/worktrees`, in a fan-out under
`~/worktrees`, on a Scratch volume, beside the checkout in `~/src`. A worktree
is a lifecycle candidate because Git registers it and no agent is in it, not
because of where it sits, and a directory Herdr never created still becomes a
forgotten directory. Pass `--worktree-root PATH` (repeatable) to restrict the
survey to particular roots; `counts.linked_worktrees` is the whole considered
set and `counts.herdr_worktrees` the Herdr-managed part of it.

Repositories are found one level below each project root, and then through
every checkout those repositories declare in `supervisor.checkout` — the fork
a workshop keeps inside itself is deeper than that walk reaches. Declarations
are followed to a fixed point and deduped by Git common directory, so one
workshop may bind several forks and a fork reached both ways is one
repository. A declared checkout that is relative, absent, or not a repository
is reported as an issue rather than skipped silently. The key is optional:
absent, discovery is the plain walk it always was.

A repository's main checkout is never a candidate, whatever its ancestry says.

Its proposals are deliberately conservative:

Any proposal may be reduced to `inspect` by the process check above, whatever
its evidence otherwise says.

- `remove_worktree` — clean, inactive, on a branch the declared model does not
  keep, and the worktree HEAD is already contained in the local trunk. The
  branch is explicitly retained. This includes a worktree where no commit was
  ever made.
- `catch_up_and_remove` — the same shape as `catch_up_to_trunk`, but every
  commit the branch carries is already upstream, so the rebase replays nothing
  and ends with the branch sitting on trunk. That is precisely the state
  `remove_worktree` is for, so the two are proposed together rather than making
  the human run a catch-up and wait for the next survey to be told the obvious
  consequence. The branch is retained, as in any removal.
- `catch_up_to_trunk` — clean and inactive, with commits on both sides of the
  local trunk, and at least one of them not yet upstream. The proposed
  operation is a rebase in that worktree, never an update to the trunk.
- `inspect` — inactive but dirty, detached, ahead-only, holding a branch the
  declared model keeps, or otherwise too ambiguous for any proposal above.

Whether a catch-up collapses is read from Git's own already-upstream filter,
never from a trial rebase: the helper touches no worktree. A branch whose work
reached trunk by another route — squashed, or reworked until the patch no
longer matches — reads as not collapsing and keeps the plain
`catch_up_to_trunk` proposal. The error therefore falls towards proposing less,
which is the only acceptable direction: `catch_up_and_remove` must never
describe a rebase as a formality when it would really stop on a conflict.
Because the combined proposal ends in a removal, it clears the same
publication backstop `remove_worktree` clears — a published branch keeps its
worktree, and is offered the catch-up alone.

Each proposal carries the `trunk` it was judged against and `fork_model`,
which says whether that trunk came from a declared fork model or from the
ordinary `main` default.

## Repositories that carry a fork

<!-- fragment: fork-supervision.md -->

The branch model comes from that config and nothing else: never a workshop's
prose, never a fetch, never a guess. Every declaration is optional, and a
workshop that has converged none of them is read exactly as it was before they
existed.

Only the repository's own config is read — `--local`, never the global or
system scope. A declaration converged anywhere else is invisible, and that is
deliberate: read at the default scope, one stray `supervisor.trunk` in a
user's `~/.gitconfig` would make every repository on the machine a fork.

In such a repository the mirror branch, the integration branch, every branch
under any declared carry prefix, every declared carry ref, and every deletion
marker are `inspect` and never `remove_worktree`, whatever ancestry says. A published carry head is an ancestor of integration by design, so
containment there is not evidence that its worktree is finished — those
worktrees are the fork's standing working set, and integration and
publication belong to `maintain`.

Declarations cannot cover what nobody declared, so in a fork repository
containment is never sufficient on its own: a branch holding a
remote-tracking ref is somebody's carry whatever it is named, and it is
`inspect`. That reads local refs the repository already has — evidence about a
branch, never a source for the model, and never a network call. Removal
survives only for the genuinely ephemeral worktree, whose branch was never
published.

A remote-tracking ref outlives the branch it tracks until someone prunes, so
in a repository that never prunes this holds worktrees whose branches are long
gone upstream. That is the safe direction and it is deliberate, but it is why
a fork's declarations still matter: they say which branches are carries, where
the backstop only says which were ever pushed.

A missing local trunk means no ancestry decision, and so does a declared
trunk with no such local branch. A declared workshop that is not on disk is
reported too: the model can no longer be reconciled with the specification it
was derived from. Report these issues; do not substitute a remote ref, fetch,
or guess another trunk.

## Notify and minisketch

When a survey has proposals, or Herdr ownership is unavailable and the watch is
therefore blind, load the `notify` skill and post one grouped notification
(`tend-worktrees`) saying what needs a decision. Then respond in this shape:

```markdown
## Tend

- Remove `<session-slug>` (`<repository>`, worktree `<worktree>`); `<branch>` at
  `<short-head>` is clean and contained in local `<trunk>` at `<short-trunk>`.
  The branch will be retained.
- Catch up and remove `<session-slug>` (`<repository>`, worktree `<worktree>`);
  rebasing `<branch>` onto local `<trunk>` replays nothing, because all
  `<ahead>` of its commits are already upstream, so it lands on `<trunk>` and
  the worktree is then removable. The branch will be retained.
- Catch up `<session-slug>` (`<repository>`, worktree `<worktree>`) by rebasing
  `<branch>` onto local `<trunk>`; it is `<ahead>` ahead and `<behind>` behind,
  clean, and has no live Herdr agent.
- Inspect `<session-slug>` (`<repository>`, worktree `<worktree>`) before
  lifecycle work: `<reason>`.

No actions have been taken.
```

A removal bullet says what the removal costs. When the worktree holds ignored
content, name it: the branch retains the tracked bytes and nothing retains
these. Say "the branch will be retained" only where it is the whole truth.

Use one bullet per proposal and always lead with `session_slug`; the random
worktree name is only parenthetical location context for that named session.
Never substitute the worktree name for a missing slug: identify it as an older
unattributed session and include the repository, branch, and worktree only as
diagnostic context. Include the evidence the helper returned, name the trunk
a fork repository was judged against rather than implying `main`, and say
plainly when ownership was unavailable or a repository could not be assessed.
Do not inflate an empty survey into a report: say there is nothing to tend.

This first version ends at the minisketch. A later explicit request to carry
out one of its bullets is new work under the session's ordinary approval and
safety guidance, not authority inherited from `/tend`.

## Before acting on a proposal

Everything above produces evidence. The moment a human asks for one of these
bullets to be carried out, it becomes ordinary work under the session's own
approval and safety guidance — and that is where this session's hazards live,
so they are named here rather than left to be rediscovered.

**A survey is a snapshot, not a lease.** Worktrees on this machine have been
observed flipping between clean and dirty within minutes, so a proposal
minutes old may already be wrong. Every proposal therefore carries
`state_digest`, a hash of HEAD plus the full porcelain status with ignored
entries included. Re-run the survey immediately before acting and compare: if
the digest moved, the worktree moved, and the proposal must be re-derived
rather than executed. Verify per worktree, not per survey.

**An absent agent row is not an absent owner.** An agent that drives a
worktree from somewhere else never appears as its owner, so when a proposal is
downgraded — or when anything nearby is churning — ask the owner rather than
inferring one. Address by session id, not by name:
`agentsurface agents --all` is the authoritative listing — name, session,
harness, place and cwd — and `agentsurface message <session-id> "text"` then
needs no name resolution at all and reaches Claude and Codex alike. Names are
the trap, because a Claude session has two: its cross-session peer name and
its surface name, taken from the conversation title and changing whenever that
is renamed. A question addressed by the wrong one resolves to nothing, and
some senders then guess at the nearest live session, so the answer arrives in
somebody else's transcript. That misroute is indistinguishable from silence,
and silence reads as "nobody claims it" — which is how a removal proceeds
against an owner who did in fact answer. Read the listing before theorising
about the topology.

**Remove with `git worktree remove <exact path>` and no `--force`**, so Git
itself refuses on any dirt that appeared since the survey. Never fall back to
`rm -rf`: a removal is supposed to be recoverable because the branch is
retained, and that property holds only for a registered worktree. Confirm the
target is one — `rev-parse --show-toplevel` equals the path — rather than
trusting a name, and audit ignored content before deleting anything, since a
`remove_worktree` proposal has not established that nothing unrecoverable is
there beyond the reproducible-artefact rule above.

**Back a catch-up out, do not push through it.** Record each branch head under
`refs/tend-backup/<timestamp>/` and verify the ref resolves before rebasing;
abort on any non-zero exit and assert HEAD returned to the recorded head with
no rebase in progress.

**Verifying that a rebase lost nothing is easy to get wrong, in both
directions.** A rebase legitimately drops commits already upstream, so a
branch collapsing onto trunk is usually correct rather than alarming — but
proving it needs a check that measures the right thing. `git log --format=%H |
git patch-id` yields nothing, because that stream carries no diff; it needs
`git log -p`. `git cherry` silently skips merge commits. `git merge-tree` of a
stale tip against trunk conflicts from staleness rather than from unique work,
and so does replaying one commit whose neighbourhood trunk has since changed.
What answers the question is per-commit patch-id against
`git log -p --no-merges <merge-base>..<trunk>`, falling back to
`git log -S<distinctive string> <trunk>` when a patch-id misses because context
shifted. Check the check before reporting loss.

## Keep watch

After reporting the snapshot, run one copy of the watcher through the
harness's managed long-lived process facility:

```sh
bun scripts/watch.ts --wake-self
```

Do not raw-background it. Its first stdout record is the initial survey. It
then watches Git worktree registrations and loose branch refs, subscribes to
Herdr pane/workspace lifecycle events, and performs a five-minute recovery
sweep. It emits only when the actionable picture changes.

`--wake-self` addresses this pane's current agent session through AgentSurface,
so the same path works for Claude and Codex. The wake contains the complete
survey JSON. On a wake, run `bun scripts/watch.ts --once` again before
notifying or writing the minisketch: an event is a reason to look, not a lease
on state that may already have changed. When an event proposal's worktree and
HEAD still match the refreshed proposal, preserve its `session_slug`; the
one-shot query may no longer see the agent row from which the watcher retained
that identity.

If the watcher reports that it cannot subscribe, cannot query ownership, or
cannot address this session, diagnose that failure rather than replacing the
event stream with a busy loop. When the human stops Tend, terminate the managed
watcher and reap the process.
