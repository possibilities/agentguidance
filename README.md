# AgentGuidance

[![CI](https://github.com/possibilities/agentguidance/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentguidance/actions/workflows/ci.yml)

The general agent-guidance skills — `collab`, `build`, `maintain`, `tend`,
`resource-create`, `resource-update`, `story`, and `watch-requests` — and the
system that composes them.

Each skill is a template. The renderer splices in shared doctrine from
`fragments/` and the operator's own voice from `~/.config/agentguidance/`, then
writes the read-only artifacts every configured agent loads.

These skills are the *general* layer of the agent\* fleet: how to read a
request, when to sketch and wait, how to build well, how research becomes a
durable resource, how a codebase becomes a story, how a carried fork is kept
current from its workshop, and how inactive agent worktrees are tended without
changing them. Tool-specific runbooks live
with their tools — `agentboard` ships `board`, `agentwiki` ships `wiki`. This
repo carries only the doctrine that applies everywhere.

## Install

AgentStart owns installation. Its skills scan ships `skills/<name>/` whole
into the fixed fleet resource set, then runs `scripts/post-sync` — the
render — so the installed copies arrive already composed with the operator's
extension prompts. Nothing here is installed by hand:

```sh
~/code/agentstart/scripts/sync-skills   # the only path that reaches a session
```

`scripts/render` is that seam's composer, not an entry point: it refuses to run
without `AGENTGUIDANCE_SKILLS_ROOT`, which sync-skills supplies. A machine
without the AgentStart seam renders into a tree of its own choosing:

```sh
AGENTGUIDANCE_SKILLS_ROOT=/path/to/skills scripts/render
```

## Layout

- `skills/<name>/` — one template per skill: `SKILL.md` (with fragment and
  extension-prompt render points), `agents/openai.yaml`, and any reference
  files, shipped whole.
- `fragments/` — doctrine shared between templates; a missing fragment
  fails the render.
- `scripts/render` — the composer, driven by the seam; `scripts/post-sync` — the fleet hook
  that execs it.
- `tests/validate.sh` — the gate; run it before committing.

The extension prompts themselves are not here: they are the operator's,
kept in AgentStart (`prompts/agentguidance/`) and linked into
`~/.config/agentguidance/`. That split is the point — these templates are
public doctrine, the extensions are one machine's voice, and the render is
where they meet.
