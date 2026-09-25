# Context

**Extension prompt** — a Markdown file with a recognized name under
`~/.config/agentguidance/` that `scripts/render` splices into a skill template
at its matching render point (an HTML comment naming the file). `SYSTEM.md`
and `GUIDELINES.md` are the recognized names; an absent file renders to
nothing. The files are the operator's, linked there by AgentStart.
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

**Model invocation policy** — the portable fact recorded by
`disable-model-invocation` in a skill template's `SKILL.md` frontmatter;
absent or false means model-invocable. AgentStart derives Codex's inverse
product field when it renders the fixed private resource set.
_Avoid_: OpenAI policy (that is a rendered representation, not source).
