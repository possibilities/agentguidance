---
name: tend
description: Watch Herdr-created Git worktrees after their agents stop, then notify the human with a read-only minisketch for removing landed worktrees, catching divergent branches up to local main, or inspecting ambiguous leftovers. Use for /tend or when asked to watch and triage inactive agent worktrees; it proposes lifecycle work but does not perform it.
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
scripts/watch.ts --once
```

The one JSON object is the current `tend_survey`. Git answers which linked
worktrees exist and how each branch relates to its repository's local `main`;
Herdr answers whether any agent is still in one. Each proposal's
`session_slug` is Herdr's generated conversation name from
`tokens.conversation`, retained by the long-running watcher after that agent
exits. Treat `ownership_available: false` as a failed safety check, never as an
empty agent list.

Every agent row whose `cwd` or `foreground_cwd` is the worktree or lies inside
it protects that worktree. Status does not weaken the protection: `idle`,
`done`, `blocked`, `working`, and `unknown` all mean an agent is still there.

The helper only considers linked worktrees below
`~/.herdr/worktrees`. Its proposals are deliberately conservative:

- `remove_worktree` — clean, inactive, on a branch other than `main`, and the
  worktree HEAD is already contained in local `main`. The branch is explicitly
  retained. This includes a worktree where no commit was ever made.
- `catch_up_to_main` — clean and inactive, with commits on both sides of local
  `main`. The proposed operation is a rebase in that worktree, never an update
  to `main`.
- `inspect` — inactive but dirty, detached, ahead-only, or otherwise too
  ambiguous for either proposal above.

No local `main` means no ancestry decision. A repository with the existing
`supervisor.trunk` configuration set to a non-`main` branch is also outside
Tend's main-based policy. Report either issue; do not substitute a remote ref,
fetch, or guess another trunk.

## Notify and minisketch

When a survey has proposals, or Herdr ownership is unavailable and the watch is
therefore blind, load the `notify` skill and post one grouped notification
(`tend-worktrees`) saying what needs a decision. Then respond in this shape:

```markdown
## Tend

- Remove `<session-slug>` (`<repository>`, worktree `<worktree>`); `<branch>` at
  `<short-head>` is clean and contained in local `main` at `<short-main>`. The
  branch will be retained.
- Catch up `<session-slug>` (`<repository>`, worktree `<worktree>`) by rebasing
  `<branch>` onto local `main`; it is `<ahead>` ahead and `<behind>` behind,
  clean, and has no live Herdr agent.
- Inspect `<session-slug>` (`<repository>`, worktree `<worktree>`) before
  lifecycle work: `<reason>`.

No actions have been taken.
```

Use one bullet per proposal and always lead with `session_slug`; the random
worktree name is only parenthetical location context for that named session.
Never substitute the worktree name for a missing slug: identify it as an older
unattributed session and include the repository, branch, and worktree only as
diagnostic context. Include the evidence the helper returned, and say plainly
when ownership was unavailable or a repository could not be assessed. Do not
inflate an empty survey into a report: say there is nothing to tend.

This first version ends at the minisketch. A later explicit request to carry
out one of its bullets is new work under the session's ordinary approval and
safety guidance, not authority inherited from `/tend`.

## Keep watch

After reporting the snapshot, run one copy of the watcher through the
harness's managed long-lived process facility:

```sh
scripts/watch.ts --wake-self
```

Do not raw-background it. Its first stdout record is the initial survey. It
then watches Git worktree registrations and loose branch refs, subscribes to
Herdr pane/workspace lifecycle events, and performs a five-minute recovery
sweep. It emits only when the actionable picture changes.

`--wake-self` addresses this pane's current agent session through AgentSurface,
so the same path works for Claude and Codex. The wake contains the complete
survey JSON. On a wake, run `scripts/watch.ts --once` again before notifying or
writing the minisketch: an event is a reason to look, not a lease on state that
may already have changed. When an event proposal's worktree and HEAD still
match the refreshed proposal, preserve its `session_slug`; the one-shot query
may no longer see the agent row from which the watcher retained that identity.

If the watcher reports that it cannot subscribe, cannot query ownership, or
cannot address this session, diagnose that failure rather than replacing the
event stream with a busy loop. When the human stops Tend, terminate the managed
watcher and reap the process.
