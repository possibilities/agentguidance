---
name: maintain
description: Run one maintenance cycle of a fork from its workshop repository — bind one upstream snapshot, reconcile required behavior, gate and publish under the declared branch model, hand over to the consumer, and record the state. Use for bare /maintain in a workshop or a request to maintain a named fork; installation without maintenance is the workshop's consumer step, not this.
disable-model-invocation: true
---

# Maintain a fork

With no arguments, use the current repository as the workshop and read its
`AGENTS.md`, `CONTEXT.md`, `MAINTAIN.md`, and `SCRATCHPAD.md`. The human does
not need to repeat its name, branch model, or exceptions in the invocation.
An explicitly named workshop changes the target, not the procedure.

Run one maintenance cycle of the fork declared by that workshop. Read the
specification and the
[full cycle procedure](references/fork-maintenance.md) before fetching,
reconciling refs, repairing a feature, or publishing a candidate. Resolve
script paths from this skill's directory and use the workshop's declared
entrypoints; all project facts come from the workshop.

Select the composition model from `MAINTAIN.md` before running any branch
command. Carry heads and rebased linear stacks use the shared branch script
through their workshop entrypoint. An explicitly declared merge-only history
uses [merge-only maintenance](references/merge-only-maintenance.md) and its
workshop's own branch procedure. It may name an existing public branch for the
integration role and declare no owned mirror. Never send that model through
the shared rewrite/mirror script or ask the human to repeat the declaration.

A `/maintain` invocation authorizes its ordinary reconciliation, feature
repair, gates, publication, and consumer handover within the workshop's
existing scope. Honor narrower user constraints and prior authorization.
A consequential product choice unresolved by the spec or implementation
needs a human decision; complete independent preparation before that handoff.

## Follow one captured cycle

1. Establish clean workshop and bound-checkout state and inventory existing
   worktrees. Read the workshop and fork guidance. Capture the fork heads for
   exact publication leases, then one immutable upstream target.
2. Fetch exactly that upstream object once. Read the full interval since the
   audited frontier, and assign every carried behavior a retire, repair, or
   unchanged disposition. A clean replay or merged request is not proof of
   semantic coverage or retirement.
3. Make repairs and compose a candidate in owned worktrees. Preserve the
   bound checkout, previous publication, unrelated heads, and consumer
   binding. Follow the declared carry, linear, or merge-only model.
4. Gate the exact committed candidate using every required command and any
   required external proof. Publish only declared refs using the selected
   model: one atomic leased transaction for rebased mirror/Integration/carry
   refs, or the workshop's history-preserving publication for merge-only.
   Re-read the published graph before the consumer step; never retry a race
   with freshly captured starting state.
5. Verify the consumer, reconcile the published branch model, and update the
   scratchpad. Advance the audited frontier only after a complete audit.
   Clean up only owned, clean cycle worktrees with no live process using them.

The reference contains the fixed spec sections, supervised branch model,
exact-object fetch, atomic publication recipe, upstream-offer rules, and
report requirements. Missing declarations or required proof are an explicit
incomplete gate, not a reason to improvise a broader publication scope.

## Preserve boundaries

Upstream requests and historical heads are evidence. Do not mutate their
branches, comments, or status as incidental maintenance. Read the offer rules
before preparing a contribution; communication still needs authorization.
Use native harness delegation only as allowed by the active role.

If a rebase, review, gate, publication, or consumer check fails, report the
exact failure and the state that remains in place. Keep useful evidence and
owned work needed for recovery. Never claim successful delivery from a green
local gate when a required publication or consumer check is still pending.

## Close the cycle

Always give a self-contained report: outcome, upstream reviewed, changed fork
accommodations, stance and carry impact, and evidence or remaining attention.
Use the [report contract](references/fork-maintenance.md#notify-and-close),
including explicit no-change results. Keep exact hashes and receipts in
written evidence; follow the active role's speech conventions. A machine
receipt, notification, or worker handoff does not replace the human report.
