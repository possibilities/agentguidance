---
name: tend
description: Watch inactive Git worktrees after their agents stop, wherever those worktrees live, then notify the human with a read-only minisketch for removing landed worktrees, catching divergent branches up to their repository's trunk, or inspecting ambiguous leftovers. Parks an agent and its worktree durably in an Obsidian document — worktree, branch, commit, session id, and a snapshot of uncommitted work — so the worktree can be deleted now and the whole thing rebuilt and resumed later. Reads a carried fork's declared branch model from its own supervisor config, so an integration-based repository is judged against integration and its carry heads are never proposed for removal. Use for /tend, when asked to watch and triage inactive agent worktrees, or when asked to park an agent and its worktree for later; the survey itself is read-only and every lifecycle action waits for the human.
disable-model-invocation: true
---

# Tend worktrees

Keep inactive agent worktrees from becoming forgotten directories or stale
branches. Tend surveys, proposes, and then works the list down with the human
one item at a time, until there is nothing left to tend. The survey itself is
read-only, and nothing rebases, removes a worktree, deletes a branch, merges,
pushes, or edits a file until the human says to do that specific item.

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
trunk; Herdr answers whether any agent is still in one; the parked document
answers which of them a human has already decided about, and is read on every
run.

Each proposal's `session_slug` is Herdr's generated conversation name from
`tokens.conversation`, retained after that agent exits. The retention is durable
and shared: a temp-directory store keeps each agent's slug, harness and native
session id, so they survive a watcher restart, `--once` can read them, and
every run contributes what it saw. That matters more than it sounds,
because a worktree with a live agent is protected and never becomes a proposal —
a proposal's slug can therefore only ever be a remembered one, and before the
store existed `session_slug` was structurally always null in snapshot mode and
every bullet read "an older unattributed session". A worktree Herdr never
managed still has no slug, and never will. Treat `ownership_available: false` as a failed safety check, never as an
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

The helper considers every linked worktree its repositories register below the
home directory, wherever under it that worktree lives: in `~/.herdr/worktrees`,
in a fan-out under `~/worktrees`, beside the checkout in `~/src`. A worktree is
a lifecycle candidate because Git registers it and no agent is in it, not
because of which of those directories it sits in, and a directory Herdr never
created still becomes a forgotten directory.

Home is the boundary because what lies outside it is transient by
construction rather than forgotten. A checkout under the system temp dir is an
installer's working copy that will delete itself; one on a removable volume
disappears and returns with the volume, and every worktree on it would read as
appearing and vanishing rather than as anything a human should decide about.
Neither is a directory anyone loses track of, which is the whole subject of
this skill. The cost is real and worth stating: a genuinely long-lived
worktree parked on such a volume is now invisible to the walk, and tend will
never mention it. Pass `--worktree-root PATH` (repeatable) to survey those
roots instead — it replaces the home default outright rather than adding to
it — and `--worktree PATH` to judge one exact path, which ignores the
restriction entirely because a caller gating a removal must never read "no
proposal" as "nothing to worry about". `counts.linked_worktrees` is the whole
considered set and `counts.herdr_worktrees` the Herdr-managed part of it.

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
repository's own default. That default is `main` wherever a local `main`
exists; failing that it is whatever `origin/HEAD` names, and failing that
`master`. The order matters: a name Git itself reports beats a convention, and
both beat assuming the repository is broken. Before this fallback existed a
`master`-based repository was reported as unassessable and none of its
worktrees were surveyed at all, so a forgotten worktree in one was never
proposed.

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

When a survey has proposals the human has not already parked, or Herdr
ownership is unavailable and the watch is therefore blind, load the `notify`
skill and post one grouped notification (`tend-worktrees`) saying what needs a
decision. A survey whose every proposal is parked needs no notification: the
decision was already made, and reporting it back is the machine nagging. Then
respond in this shape:

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
- Parked `<session-slug>` (`<repository>`, worktree `<worktree>`) since
  `<parked-at>`: `<reason>`. Still `<action>` when you want it back.
- Parked and gone: `<session-slug>` (`<repository>`, branch `<branch>`) —
  `<summary>`. Rebuild it with the recorded command when you want it back.

No actions have been taken.
```

A removal bullet says what the removal costs. When the worktree holds ignored
content, name it: the branch retains the tracked bytes and nothing retains
these. Say "the branch will be retained" only where it is the whole truth.

Parked bullets go last and are reports, not questions. List a parked proposal
once, so the human can see the item is still there and change their mind; do
not re-argue it. A `parked_unmatched` record with status `absent` is worth a
bullet of its own precisely because nothing else on the machine mentions it —
the worktree is gone and this record is what remains. An `occupied` record
means somebody unparked by hand: offer to drop the entry.

Use one bullet per proposal and always lead with `session_slug`; the random
worktree name is only parenthetical location context for that named session.
Never substitute the worktree name for a missing slug: identify it as an older
unattributed session and include the repository, branch, and worktree only as
diagnostic context. Include the evidence the helper returned, name the trunk
a fork repository was judged against rather than implying `main`, and say
plainly when ownership was unavailable or a repository could not be assessed.
Do not inflate an empty survey into a report: say there is nothing to tend.

The minisketch is the overview, not the end: it is where the wizard below
starts. Carrying out any single bullet is ordinary work under the session's
own approval and safety guidance, never authority inherited from `/tend`.

## Work the list with the human

Having shown the categorized overview, work it down one item at a time. The
goal of a run is a fully tended machine, reached collaboratively — not a report
the human is left holding.

Present one proposal: what it is, the evidence that decides it, and a concrete
recommendation. Then wait. The human answers for that item alone — do it, do
part of it, skip it for now, or rule on it permanently. Never batch several
items into one question, and never carry an approval from one item to the next.
Each worktree is its own decision, and the one thing an approval never grants
is authority over the item after it.

Order the list so the cheap certainties come first: removals, then catch-ups,
then the inspects that need a human eye. The list visibly shortens, and the
ambiguous cases get attention when fewer of them are left.

Re-gate each item immediately before presenting it, not once at the start. A
survey is a snapshot, and the item about to be described may have moved while
the previous one was being resolved — say what changed rather than presenting
stale evidence. This matters most right after a catch-up, whose own writes land
inside the activity window and will downgrade the next proposals in the list;
that is tend seeing itself, and it is not evidence of another owner.

An item the human parks is done for this run — do not raise it again, here or
in a later run, until they unpark it. Its record is in the parked document
below, and a proposal that carries one is reported rather than asked about.

Keep going until every proposal is either done or explicitly parked. Then close
the run by saying what remains and why: parked items with their reasons,
repositories that could not be assessed, and anything a downgrade held back. A
run that ends with items neither done nor parked has not finished tending.

A human who stops answering ends the loop. Do not proceed through the remainder
on the strength of earlier approvals.

## Park what will not be finished now

Parking is how a run ends with nothing left dangling. A parked item is not a
skipped one: it is recorded durably enough that the worktree can be deleted and
the whole thing — worktree, uncommitted work, and the agent that was doing it —
reconstituted later. That is the difference between putting work away and
losing it, and it is why parking is worth more than remembering to ask again
next time.

`~/obsidian/work/Parked.md` is that record, and tend is its only writer:

```sh
bun scripts/watch.ts --park PATH \
  --summary "one sentence on what this agent and worktree are" \
  --reason "why it is being put away"
```

Never write or edit the document by hand. The helper reads the branch, the
exact commit, and the session identity from Git and the Surface rather than
from recollection; a park whose sha or session id is misremembered is a park
that cannot be unparked, which is the only way this feature fails. It writes:
the worktree path, its repository, the branch and full sha1, the harness and
native session id, the agent's cwd when it differs from the worktree, a
snapshot ref when there was uncommitted work, and the command chain that
rebuilds all of it.

The summary is the one field nothing can derive, and it is what the document
is for. Months later the worktree is a path that no longer exists and the
branch name says nothing; write the sentence a stranger would need to decide
whether to bring it back. The reason is separate and answers a different
question — not what this is, but why it is sitting still.

**Parking captures uncommitted work, so removal stops destroying it.** Before
writing the entry, the helper commits everything Git is willing to track —
modifications, untracked files, deletions — under `refs/tend-park/<name>`,
using a separate index so nothing in the worktree or its index moves. That
matters because the interesting worktree to park is an agent's half-finished
one, and `git worktree remove` deletes uncommitted work without a word once
the worktree is clean enough to go. Ignored content is deliberately not
captured; the ignored-content downgrade still holds those worktrees back.

Parking does not remove anything and does not require the worktree to be
inactive — a human may park an agent that is still working. Removal after a
park is still ordinary lifecycle work under every gate in the next section:
the park establishes that removal would lose nothing, never that it is
permitted.

**Every survey reads the document back.** A proposal whose worktree is parked
carries the record in `parked`, counted in `counts.parked`. A record matching
no proposal appears in `parked_unmatched` with one of three statuses, and each
asks the human something different:

- `absent` — the worktree is gone. This is parking having worked, and the
  record is now the only thing on the machine that knows the work existed.
- `occupied` — an agent is in there again, so somebody unparked it by hand and
  the record is stale. Offer to drop it.
- `settled` — the worktree is present and this survey proposes nothing for it.

Unparking is the recorded command chain, run as ordinary work, followed by
`bun scripts/watch.ts --unpark PATH` to drop the entry. Run them in that order:
`--unpark` deletes the snapshot ref once the worktree is back, and deliberately
keeps it when the worktree is still absent, because then the ref is the only
copy of that uncommitted work. It says so when it keeps one.

## Before acting on a proposal

Everything above produces evidence. The moment a human asks for one of these
bullets to be carried out, it becomes ordinary work under the session's own
approval and safety guidance — and that is where this session's hazards live,
so they are named here rather than left to be rediscovered.

**Gate one path without surveying the machine.** `--worktree PATH`
(repeatable) resolves each path's repository directly and judges only those
worktrees, producing the identical proposal the full walk would. It exists
because the dominant per-worktree cost is the already-upstream check, which
must patch-id the whole upstream side — roughly 0.8s against a branch hundreds
of commits behind, against 0.03s for everything else put together. That cost
cannot be made cheap without weakening the answer, so the saving is to judge
fewer worktrees rather than to judge them worse. A targeted path that is
missing, outside a repository, or inside a checkout rather than being one is
reported as an issue instead of yielding nothing: a caller gating a removal
must never read "no proposal" as "nothing to worry about".

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

**Enforce every check you print, and prefer the helper's verdict to your own
re-derivation.** A gate that computes a condition, reports it, and then removes
anyway is worse than no gate: it produces a transcript that looks careful and an
action that was not. This has happened twice in one session — once printing a
worktree's ignored content and removing it regardless, destroying a vendored
dependency the survey had already flagged as unrecognized; once printing
`contained in main: NO` and removing on the strength of a different argument
made earlier. Both were recoverable by luck rather than by design.

The specific correction: do not hand-roll the gate. The survey already decided,
and its `action` and `downgrade` fields carry that decision — a proposal reduced
to `inspect` by ignored content or a process is not a removal you may perform
because your own checks came back clean.

`--assert-action` makes that mechanical rather than advisory:

```sh
bun scripts/watch.ts --once --worktree PATH --assert-action remove_worktree \
  || exit 1
```

It exits non-zero unless every proposal in that survey carries the named action,
naming what the survey proposes instead and which downgrade produced it. It also
fails when the survey proposed *nothing*, because a targeted path that is
missing, outside a repository, or no longer a candidate yields no proposal, and
a caller must never read that silence as permission. Gate on this rather than on
your own recomputation, and where a genuine argument overrides the helper's
verdict, say so out loud before acting rather than letting an unenforced line
scroll past. Commit-level containment is also the wrong question after a
fast-forward: a sibling commit adding identical content reads as uncontained
while losing nothing, so decide on trees and blobs, and say which you used.

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

**A catch-up that conflicts on its first replay is usually a reworked landing,
not a divergence.** Git's already-upstream filter matches patch-ids, so work
that reached trunk by recomposition — squashed, rebased, or replayed into a
file trunk has since moved — reads as unlanded and gets a plain
`catch_up_to_trunk`. The rebase then replays a change whose destination already
changed, and stops. The tell is several branches in one repository conflicting
on the same file and the same commit subject, and diffstats on the branch and
trunk copies that match exactly while their patch-ids differ.

Establish that per commit rather than assuming it from the pattern. For each
commit the rebase would replay, look for a commit on trunk carrying the same
subject; where one exists, confirm the content actually arrived — by patch-id
where it matches, otherwise by `git log -S<distinctive string> <trunk>`, which
finds a string that entered trunk's history even after later edits moved it.
Do not test an intermediate commit's added lines against trunk's current tree:
a line the branch itself later revised is legitimately absent there, and reads
as loss when it is not. Where no trunk commit carries the subject and no
distinctive string is found, that commit is genuine unlanded work — stop and
hand it back rather than skipping it.

`git rebase --skip` is then the resolution for each confirmed-landed commit,
and the branch ends sitting on trunk, which is the `catch_up_and_remove` state
arrived at the long way. Two cautions on reading that result. The final tree
matching trunk's proves nothing by itself, because it follows automatically
from having skipped every commit — the evidence that nothing was lost is the
per-commit check above, run over every commit actually skipped, not the tree
comparison. And a worktree is detached for the duration of a rebase, so a
survey landing mid-run reports `branch: null` and `detached`; confirm
attachment after the run rather than believing a snapshot taken during it.

## Keep watch

After reporting the snapshot, run one copy of the watcher through the
harness's managed long-lived process facility:

```sh
bun scripts/watch.ts --wake-self
```

Do not raw-background it. Its first stdout record is the initial survey. It
then watches Git worktree registrations and loose branch refs, subscribes to
Herdr pane/workspace lifecycle events, and performs a five-minute recovery
sweep. It emits only when the actionable picture changes, and "actionable" is
narrower than "different": a record is compared on the judgement and the
worktree's content — its action, its `reason_code`, any `downgrade`, its
branch, HEAD, trunk, ahead/behind, cleanliness, `state_digest` and unrecognized
ignored content. Evidence that moves on its own is deliberately excluded, and
each exclusion is a wake that would otherwise be spurious:
`last_activity_seconds` is a clock and advances every sweep, the `reason` prose
interpolates the pid of a short-lived helper and the quiet-window count, and
`session_slug` follows roster rows that come and go. That is why the judgement
carries a `reason_code` beside the prose at all — a proposal changing category
under an unchanged `inspect` is a real change and must still wake, while a
helper respawning under a new pid must not.

A parked proposal never wakes anyone: the human decided and wrote it down, so
a machine whose every remaining proposal is parked goes quiet. That is the
property that makes parking worth doing rather than skipping an item each run.

`--wake-self` addresses this pane's current agent session through AgentSurface,
so the same path works for Claude and Codex. The wake does not carry the survey
inline: it writes the complete JSON to a file under the temp directory and the
message names that path, because a survey of a machine with dozens of worktrees
runs to tens of kilobytes and pasting that into the conversation on every
change buries the human's own work in payload. Read the named file when the
summary line says something worth reading; the watcher keeps the last few and
prunes the rest. On a wake, run `bun scripts/watch.ts --once` again before
notifying or writing the minisketch: an event is a reason to look, not a lease
on state that may already have changed. When an event proposal's worktree and
HEAD still match the refreshed proposal, preserve its `session_slug`; the
one-shot query may no longer see the agent row from which the watcher retained
that identity.

If the watcher reports that it cannot subscribe, cannot query ownership, or
cannot address this session, diagnose that failure rather than replacing the
event stream with a busy loop. When the human stops Tend, terminate the managed
watcher and reap the process.
