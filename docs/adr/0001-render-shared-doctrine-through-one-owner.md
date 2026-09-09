# 0001: Render shared doctrine through one owner

Status: retrospective, recorded 2026-09-08 from the existing renderer contract.

Skill entrypoints and their Markdown references are authored templates. Shared
meaning lives in `fragments/`; operator extensions belong to AgentStart and are
supplied through its installed prompt links. AgentStart's normal sync copies
the skill directories, invokes this repository's post-sync render, and delivers
the rendered resources to the harnesses. This repository has no second installer.

Rendering shared fragments keeps build and collaboration doctrine aligned while
allowing short entrypoints to defer detailed procedures to relevant references.
A missing fragment fails the render rather than shipping incomplete guidance.
Rendered files are disposable, marked and read-only; editing them would leave
an apparent fix that the next sync overwrites. Operator extensions remain
optional, so their absence does not turn a portable template into an error.

The consequence is that authored changes become live through the owning sync,
not a local renderer run against an invented destination. Keep the supported
path singular and verify the rendered references when shared doctrine changes.

Evidence: [repository contract](../../AGENTS.md),
[renderer](../../scripts/render), [post-sync hook](../../scripts/post-sync),
and [domain-model fragment](../../fragments/domain-model.md).
