# Merge-only maintenance

Use this branch procedure when the current workshop's `MAINTAIN.md` explicitly
declares merge-only maintained history. Selection is automatic on bare
`/maintain`; branch names and ownership come entirely from the workshop.
This procedure replaces the rebased workflow's state-establishment commands,
rewrite/mirror transaction, and `--apply` reconciliation. Do not invoke the
shared branch script: it implements rebased carry and linear models.

## Establish and audit

Read the workshop and fork guidance, inspect clean/dirty state, and inventory
existing worktrees before creating owned candidates. Preserve the bound
checkout and any unpublished commits. A declared absence of an owned mirror
means no mirror is created or moved, including on a shared fork repository.
The workshop's published consumer branch fills the integration role regardless
of its literal name. No branch rename is needed to run maintenance.

Capture all fork heads and one upstream target before the first fetch. Retain
the starting value of every publication target. Fetch that exact upstream
object once, using the declared checkout and remotes:

```sh
git -C "$checkout" fetch --no-tags "$upstream_remote" "$cycle_upstream_sha"
```

Fetch the fork separately as declared. Never replace the captured upstream
target during this cycle. Run the workshop's read-only branch check. If its
scratchpad already identifies a pin containing unpublished local commits,
verify that exact relationship and carry those commits into the candidate;
the expected publication-check failure is delivery work for this cycle, not
permission to reset, skip the gate, or publish early. Stop on unexplained
divergence, wrong remote identities, or missing work needed by the candidate.

Perform the semantic review in
[Establish the state, steps 4–5](fork-maintenance.md#establish-the-state):
read the full interval since the audited frontier and assign every required
behavior a retire, repair, or unchanged disposition. For a workshop with no
established frontier, use its declared first-audit range and record that this
is an initial audit. Never substitute the most recent merge base for proof
that the intervening upstream history was reviewed.

## Compose, gate, and publish

Prepare an owned, named candidate worktree descended from the maintained
history selected by the workshop. Merge the captured upstream commit. Repair
interactions in new commits and remove retired code forward; never rebase or
force-update the published history. A clean merge or reused resolution does
not replace reviewing the behavior.

Run the workshop's entire Gate on the exact committed candidate, including
required terminal or external evidence. Failed validation publishes nothing
and does not advance the consumer. Keep useful evidence and owned candidate
work for recovery.

Before publication, prove the starting public head is an ancestor of the
gated candidate and re-read every declared publication target. A change from
the starting snapshot ends this publication attempt. Follow the workshop's
history-preserving push procedure, without force options; never add a mirror,
carry, offer, or undeclared ref to make the generic graph look complete. An
ordinary fast-forward push preserves history but is not an exact starting-SHA
lease. Its server check rejects non-fast-forward movement; re-read the exact
published target before consumer handover, including after a no-op push. Do
not claim stronger concurrency protection than the actual procedure provides.

## Hand over and record

Run the declared Consumer only after the exact gated commit is published.
For a submodule consumer, publish the inner commit before publishing the outer
pin. Run only the workshop's declared post-handover checks; a read-only branch
checker need not implement `--apply`. Verify supervision using its own
entrypoint and preserve every unrelated head.

Use the shared [scratchpad](fork-maintenance.md#maintain-the-scratchpad),
[offer](fork-maintenance.md#offers), and
[report](fork-maintenance.md#notify-and-close) requirements. Record delivery,
publication, installation, and the audited frontier separately. Publish the
workshop state after the fork and consumer facts it describes are real, under
the invocation's scope. Cleanup removes only owned clean worktrees with no
live process using them. A failed cycle still reports its precise remaining
work; it does not require the human to retry with a longer invocation.
