# Context

**Extension prompt** — a Markdown file with a recognized name under
`~/.config/agentguidance/` that `scripts/render` splices into a skill template
at its matching render point (an HTML comment naming the file). `SYSTEM.md`,
`GUIDELINES.md`, and `TOOLS.md` are the recognized names; an absent file
renders to nothing. The files are the operator's, linked there by AgentStart.
_Avoid_: extension guidance, plugin, override.

**Fragment** — a Markdown file under `fragments/` that `scripts/render`
splices into a skill template at its matching render point. Repo-owned shared
doctrine, unlike an extension prompt (operator-owned); a missing fragment
fails the render instead of rendering to nothing.
_Avoid_: snippet, partial, include.

**Post-sync hook** — `scripts/post-sync`, run by AgentStart's sync-skills after
this checkout's templates ship, so installed copies are always rendered. Here
it execs the render; the name is the fleet convention, the render is this
repo's use of it.
_Avoid_: build step, postinstall.

**Tend** — the advisory lifecycle loop for inactive Herdr worktrees: observe
Git and the Surface, notify the human, and propose cleanup or catch-up without
performing it. It is neither fork maintenance nor authority to integrate or
reap peer work.
_Avoid_: maintain, supervise, reap.

**Parked document** — `~/obsidian/work/Parked.md`, the Markdown record of
agents and worktrees put away for later: enough per entry to rebuild the
worktree and resume the agent, entries separated by a Markdown rule. Tend is
its only writer and reads it on every survey.
_Avoid_: park file, parking lot, backlog.

**Park** — recording an agent and its worktree durably enough that the worktree
can be deleted and the work reconstituted, including a snapshot of whatever was
never committed. Not a deferral: an item nobody wrote down is unresolved, not
parked.
_Avoid_: defer, snooze, shelve, skip.

**Model invocation policy** — the portable fact recorded by
`disable-model-invocation` in a skill template's `SKILL.md` frontmatter;
absent or false means model-invocable. AgentStart derives Codex's inverse
product field when it renders the common capability pack.
_Avoid_: OpenAI policy (that is a rendered representation, not source).

**Surface** — the shared runtime coding-agent sessions are placed on and run
in the open: the human can watch, join, or steer a placed session. herdr is
the reference implementation.
_Avoid_: ADE, runner, backend, launcher.
