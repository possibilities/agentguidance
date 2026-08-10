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

`AGENTS.md` is the canonical guidance file; `CLAUDE.md` is a symlink to it.
Run `tests/validate.sh` before committing.
