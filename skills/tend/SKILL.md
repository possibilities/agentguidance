---
name: tend
description: Survey inactive Git worktrees and carry out specifically authorized removal, catch-up, parking, or reconstruction with fresh ownership and content checks. Use for /tend, worktree triage, or parking an agent and its worktree for later; the survey is read-only and lifecycle scope comes from the user.
disable-model-invocation: true
---

# Tend worktrees

Survey inactive Git worktrees, explain what can be removed or caught up, and
carry out the lifecycle work the human authorizes. Parking records work and
session identity for later reconstruction; it does not itself authorize
removal. Use `maintain` for a carried fork's integration and publication.

Read the [survey and lifecycle procedure](references/survey-and-lifecycle.md)
before a survey, parking, removal, catch-up, or resume. Resolve this skill's
directory before running its shipped helper:

```sh
bun scripts/watch.ts --once
```

The helper uses Git, the Herdr roster, local processes, recent repository
activity, ignored-content checks, and the parked document. Its existing CLI
subprocesses are supported implementation details; there is no MCP survey or
park producer to substitute for it. A Herdr-managed caller is required by the
helper. If its ownership evidence is unavailable, report the failed check.

## Choose the scope

Start with the requested repository or exact worktrees when known. Use
`--worktree PATH` for an exact target or `--worktree-root PATH` for an explicit
survey boundary; the reference explains defaults and proposal fields.

An advisory `/tend` survey is read-only. An instruction to act on specific
items or an explicit batch supplies that scope; honor it without asking for
the same approval again. When scope or ownership remains unclear, prepare a
concrete proposal and ask for the missing decision. A proposal is evidence,
not permission. Do not carry an item's approval to unrelated worktrees.

Lead with the session's human-readable name and the proposed action. Include
paths, ancestry, digests, and exact identities in written evidence as needed.
Explain parked items and unassessable repositories without repeatedly asking
about a decision already made. Notify only when the procedure's notification
trigger applies.

## Enforce the lifecycle checks

Before each action, re-read the exact target and require the helper's current
verdict. Compare `state_digest`; a changed digest requires a fresh proposal.
Use `--assert-action` as control flow, not a status message printed before an
unconditional removal. Read the reference before overriding any downgrade.

A missing agent row is not proof of absent ownership. A process, recent
activity, ignored content, a protected fork branch, or incomplete evidence
may reduce a proposal to `inspect`. Preserve those gates. Use the `bus` MCP
workflow for authorized owner coordination and address a verified session ID.

Remove only an authorized, currently eligible registered worktree with
`git worktree remove <exact path>` and no `--force`; retain its branch. Never
replace that with `rm -rf`. Ignored files may be the only copy even when Git
reports a clean tree. Catch-up and removal are separate actions with separate
checks unless the user's scope explicitly includes both.

Use the helper for parking and unparking; never hand-edit its records.
Recreate the recorded worktree and uncommitted snapshot before resuming the
session. Preserve snapshots until reconstruction is verified. Read the full
park procedure for absent worktrees, shared checkouts, and multiple sessions.

Report completed work, parked items, and outstanding decisions or failed
checks. Keep already authorized work moving while another decision is
pending. Silence supplies no new lifecycle authority.
