# Agentguidance agent guidance

Skill directories under `skills/` are templates. The installed copies under
`~/.agents/skills/` are rendered artifacts — never edit them. After changing
any skill template, a fragment in `fragments/`, or an extension prompt in
`~/.config/agentguidance/`, run `scripts/render` to rebuild them.

Two kinds of render point, spliced by `scripts/render`:

- `<!-- fragment: NAME.md -->` — repo-owned shared doctrine from
  `fragments/`, so the skills that share a spine (collab and build share
  classification, the sketch contract, build norms, and the domain-model
  discipline) cannot drift apart. A missing fragment fails the render.
- `<!-- extension-prompt: NAME.md -->` — operator-owned machine voice from
  `~/.config/agentguidance/` (linked there by Agentdots from its
  `prompts/agentguidance/`). An absent file renders to nothing.

This checkout is an ordinary agent* scan participant: Agentdots' sync-skills
ships `skills/<name>/` whole, then runs `scripts/post-sync` — the render —
so the raw templates it just shipped are immediately replaced by rendered
artifacts. That hook is why the templates may live in `skills/` at all;
without it, every six-hour sync would strip the extensions until the next
render. Do not add an installer here and do not bypass the hook.

Retiring a skill is deleting its directory: the render prunes the installed
copy it once produced (banner-matched, so other tools' skills are untouched).
`collab` and `build` replaced `hack` — the same doctrine forked only on
whether a human answers mid-run. Keep that fork honest: shared meaning
belongs in a fragment, not copied into both templates.

A tool-specific runbook normally lives with its tool, but `notify` and
`email` wrap `terminal-notifier` and `gog` — third-party binaries with no
fleet repo to live in, so they live here. That is the whole exception; a
runbook for a fleet tool still belongs in that tool's checkout. `email` is
deliberately unadvertised and reached through its own description alone.

`AGENTS.md` is the canonical guidance file; `CLAUDE.md` is a symlink to it.
Run `tests/validate.sh` before committing.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship globally through Agentdots' scan
  (`~/code/agentdots/scripts/sync-skills`, run six-hourly by Funk's
  updater): a SKILL.md edit is live within six hours, or on demand by
  running that script. Whether a new skill earns a TOOLS.md advertisement
  line is a deliberate decision — `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentdots/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, story, the resource skills — is
  `~/code/agentguidance`; tool-specific runbooks stay here.
