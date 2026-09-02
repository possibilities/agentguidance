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
- `catch_up_to_trunk` — clean and inactive, with commits on both sides of the
  local trunk. The proposed operation is a rebase in that worktree, never an
  update to the trunk.
- `inspect` — inactive but dirty, detached, ahead-only, holding a branch the
  declared model keeps, or otherwise too ambiguous for either proposal above.

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
- Catch up `<session-slug>` (`<repository>`, worktree `<worktree>`) by rebasing
  `<branch>` onto local `<trunk>`; it is `<ahead>` ahead and `<behind>` behind,
  clean, and has no live Herdr agent.
- Inspect `<session-slug>` (`<repository>`, worktree `<worktree>`) before
  lifecycle work: `<reason>`.

No actions have been taken.
```

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
