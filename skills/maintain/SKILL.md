---
name: maintain
description: Run one maintenance cycle of a fork the machine carries, from its workshop repository — reconcile current upstream with every behavior the workshop's MAINTAIN.md requires, gate a candidate, publish the integration branch under a lease, hand it to its consumer, and record the state. Use for /maintain or "maintain the <project> fork" from a workshop checkout; installation without maintenance is the workshop's own consumer step, not this.
disable-model-invocation: true
---

# Maintain a fork

A workshop repository owns one fork of someone else's project: the behavior
the fork must carry, the way it is kept current on upstream, and the state
between cycles. This skill is the operating procedure for one cycle of that
work. It knows how a cycle goes; it knows nothing about the project. Every
project fact — the checkout, the remotes, the branch names, the gate, who
consumes the result — comes from the workshop's `MAINTAIN.md`, read at the
start and never assumed.

Treat ordinary reconciliation, feature repair, gating, publication, and the
hand-over as the authorized work of a `/maintain` invocation. Ask the human
only when an upstream change creates a consequential product choice that the
spec and the existing implementation do not resolve.

## The workshop

Three files, one job each:

- `MAINTAIN.md` — the specification: what the fork is for, the upstream it
  tracks and how we relate to it, the branch model, the feature inventory
  that must remain true, the gate, the consumer, and how to notify. This is
  the contract the cycle executes.
- `SCRATCHPAD.md` — current state: the delivered upstream and integration
  baseline, the separately named audited-upstream frontier, one entry per
  carried feature, notes that can change a later decision, and a compact dated
  history. Updated during the cycle, never a second specification or an
  unbounded transcript. Delivery work may advance the first baseline; only a
  complete maintenance audit advances the frontier.
- `scripts/` — the workshop's thin entrypoints: `reconcile-branches.sh`
  exporting the declared branch model into this skill's shared script, the
  gate runner, and the consumer command.

`MAINTAIN.md` has fixed sections, and the cycle reads each by name:

| Section | What it declares |
| --- | --- |
| `## Purpose` | What the fork is for and what it is not. |
| `## Upstream` | The bound checkout, the `fork` and upstream remotes with their repositories, the upstream's contribution conventions and what they mean for us, what we offer upstream and how "landed" is recognized. |
| `## Branch model` | The mirror branch, the integration branch, the composition model — `carry/<feature>` heads composed onto upstream, or one linear stack rebased whole — the explicit deletion-marker prefix, whether open pull-request heads are validated, and whether rerere is relied on. |
| `## Features` | The inventory: every behavior the fork must carry, as behavior, with its scope line. Absence is work, never a status note. |
| `## Gate` | The exact commands, fenced, run verbatim from the candidate worktree, and any external proof (hosted CI, a ship gate) the publication requires. |
| `## Consumer` | Who consumes the published integration branch and the command that hands it over — an installer, a pin, a rebuild. |
| `## Notify` | The notification title and group. |

A workshop whose spec lacks a section has not said what the cycle should
do there; stop and say so rather than improvise.

## The declared model as data

<!-- fragment: fork-supervision.md -->

Converge supervision whenever the declared model changes, and expect
`--check-supervision` to pass at the end of a cycle: an advisory tool reading
a stale trunk would propose lifecycle work against the wrong branch.

## Invariants

These hold for every workshop, whatever its spec says:

- The bound checkout is where the fork lives, not where work happens. Every
  feature repair and every integration candidate is built in its own
  worktree. Never leave the bound checkout dirty or mid-rebase.
- Local and fork mirror branches are kept at the exact upstream commit and
  never hold downstream-only work. The integration branch is the only thing
  a consumer builds from and is nobody's review context.
- Capture the fork's integration tip before the first fetch of the cycle and
  use that exact value as the publication lease. Never recompute it after a
  fetch or just before the push.
- Gate and publish an exact commit, never an ambient branch name.
- The previously published integration tip and the consumer's binding stay
  intact until the new candidate has passed its gate; a failed rebase,
  build, test, review, CI run, or gate publishes nothing and hands nothing
  over.
- Upstream pull requests, issues, and their branches are evidence only —
  never live dependencies, publication targets, or work queues — and the
  cycle never mutates them. When the spec says so, reconciliation validates
  an open request's exact head while it remains open; closing it does not
  authorize changing or deleting the branch.
- Reconciliation owns only the refs the workshop declares: the mirror, the
  integration branch, and current carry heads under the carry model. Every
  other fork head is left unchanged. A `DELETEME/<original>` head records an
  explicit human decision about that branch; maintenance reports it but never
  creates, moves, or removes it implicitly. `reconcile-branches.sh --check` is
  read-only and works from a disposable snapshot; `--apply` publishes the
  declared refs in one atomic, exact-leased push.
- Carried work must be an ancestor of the published integration branch —
  every carry head under the carry model, every stack commit under the
  linear model.
- A recorded rerere resolution, where the spec relies on rerere, is
  evidence, not proof: after upstream changes, reread the affected behavior
  before accepting it.
- The audited-upstream frontier is not the upstream commit underlying the
  currently delivered Integration branch. Feature work between maintenance
  cycles may replay and publish the fork on newer upstream, but that does not
  prove every intervening upstream commit was considered as a replacement for
  every carried feature. Never advance the frontier from a feature delivery,
  a clean replay, or a green gate.
- Reconciliation runs again after the hand-over so the mirror and declared
  carry heads agree with the completed cycle. Temporary or obsolete branches
  remain until a human explicitly decides their disposition.

## Establish the state

1. Read the workshop's `AGENTS.md`, `CONTEXT.md`, `MAINTAIN.md`, and
   `SCRATCHPAD.md`. Read the bound checkout's own `AGENTS.md` completely
   before touching the project.
2. Confirm the workshop is clean on its main branch. Confirm the bound
   checkout is clean and its remotes are the ones `## Upstream` names.
   Inventory `git worktree list --porcelain` before creating cycle
   worktrees, so cleanup can tell the bound checkout, unrelated active
   worktrees, and this cycle's own apart. Before fetching, capture and
   validate the exact remote integration tip for the publication lease:

   ```sh
   starting_integration_sha=$(
     git -C "$checkout" ls-remote --exit-code --heads fork \
       "refs/heads/$integration_branch" | awk 'NR == 1 { print $1 }'
   ) || exit 1
   printf '%s\n' "$starting_integration_sha" |
     grep -Eq '^[0-9a-f]{40}$' || exit 1
   ```

3. Reconcile the branch namespace before feature work. Inspect the whole
   plan, then apply it, through the workshop's entrypoint:

   ```sh
   scripts/reconcile-branches.sh --check
   scripts/reconcile-branches.sh --apply
   ```

   Stop on any divergence, a missing or moved validated head, a carry outside
   integration, a lease failure, or an unexpected remote identity.
4. Fetch both remotes. Read two distinct facts from the scratchpad: the
   delivered baseline, which says what the consumer currently runs, and the
   audited-upstream frontier, which is the exact upstream commit through which
   the last complete maintenance audit assigned every carried feature a
   disposition. Set the audit interval from that frontier to current upstream,
   even when some or all of those commits are already in Integration because
   intervening feature work replayed the fork. Read every upstream commit in
   that aggregate interval and group related changes before judging features.
   Build the human-facing upstream summary from those groups as the audit
   proceeds: describe capabilities, fixes, removals, and migrations rather
   than dumping commit subjects. Capture stable changelog, release-note,
   compare, or commit links when the upstream provides them; pin links to the
   audited range rather than ambient HEAD.
   If an older scratchpad does not name a frontier separately, reconstruct it
   from the last completed maintenance entry and repository history; do not
   silently substitute the newer delivered baseline. Record the migration.
5. For each carried feature, inspect current upstream code and any historical
   upstream reference in the scratchpad, then assign exactly one disposition:
   retire because upstream now satisfies the contract; repair because the
   feature remains carried but upstream interacts with it; or keep unchanged
   because upstream neither replaces nor affects it. A replay or conflict list
   is not this semantic review. Keep the disposition ledger until the
   scratchpad and final report carry its result. Separately assess whether the
   upstream change alters our stance toward the behavior: it may complement or
   simplify a carry without replacing it, narrow the remaining downstream
   contract, make the carry redundant, increase its maintenance cost, or create
   a consequential product choice. A repair disposition does not imply that
   the stance stayed the same. Evidence only: do not rebase or push historical
   branches, or comment on, label, close, or edit requests.

## Reconcile the fork

- Walk every feature in `## Features`; absence is work.
- Prefer an upstream implementation when it fully satisfies the required
  behavior. Retire carried work only after reading the upstream code and
  exercising its path — never because a request merged or closed. Where
  `## Upstream` says the maintainer lands contributions by rewriting them
  onto their main, "landed" is decided by that reading alone.
- Under the carry model: repair or add each absent or incomplete behavior on
  its own `carry/<feature>` branch in its own worktree, based on current
  upstream; compose only committed, reviewed carry heads into a scratch
  integration candidate, in dependency order. Under the linear model: rebase
  the stack as a whole onto current upstream in a scratch worktree, repairing
  commits in place and keeping each commit's subject as the feature marker
  the inventory refers to.
- When upstream changes code a carried patch calls, reread that interaction
  even when Git reports a clean rebase. Accept a rerere resolution only after
  the same semantic review.
- For a substantial repair, conflict resolution, or cross-cutting change,
  obtain an independent adversarial review when another agent is available.
  Adversarial review means subagents told to refute the work, on a model
  and at an effort that fit it: a strong model at high effort for subtle
  correctness, a cheaper one at low effort for a mechanical sweep. Repair
  every concrete finding or record why it does not apply.
- Never merge upstream into the previously published integration history and
  never force-update it in place while reconciling; the candidate is a new
  history on current upstream, and the leased rewrite is expected.

## Gate and publish

From the candidate worktree, run `## Gate` verbatim — every command, in
order — then focused checks for every changed feature, exercising each
changed happy path with that worktree's freshly built binary. Where the
spec requires external proof (hosted CI for the exact SHA, a ship-gate
script), push the exact candidate commit to a newly named temporary branch
on the fork, without touching the integration branch or any preserved
head, and obtain that proof for that SHA. A stale, partial, skipped,
cancelled, or merely local result is not proof.

Re-read the fork's integration tip immediately before publication, then use
the exact starting tip recorded before the first fetch as the lease. Publish
the gated commit, never the branch name:

```sh
git -C "$candidate_worktree" push fork \
  "$candidate_sha:refs/heads/$integration_branch" \
  --force-with-lease="refs/heads/$integration_branch:$starting_integration_sha"
```

If rebase, gate, or publication fails, leave the previous integration branch
and the consumer's binding in place. Report the exact failed gate and retain
a useful worktree when it is needed for follow-up.

## Hand over

After the leased push succeeds, run `## Consumer` — the workshop's own
command, which may bind the bound checkout to the published commit,
rebuild and install a binary, or move a pin in a consuming repository. Only
that command binds anything. Then reconcile the namespace again, and check:

```sh
scripts/reconcile-branches.sh --check
scripts/reconcile-branches.sh --apply
scripts/reconcile-branches.sh --check
```

The final check reports the mirror, Integration, current carries, validated
open-request heads, explicit `DELETEME/*` markers, and every other untouched
fork head. Do not infer that an unrecognized head is obsolete.

## Offers

An offer to upstream is a fresh branch cut from current upstream main and
written as upstream would write it, with no workshop-specific concept in it
— never a carry head or stack commit moved across. The carried patch and the
offered patch share a behavior, not a history. `## Upstream` says what is
offered and how landing is recognized.

Nothing offered is pushed unreviewed. Before the branch that opens a pull
request goes up, and before any follow-up commit answering review, the
work gets adversarial review by subagents: independent reviewers told to
refute it — wrong behavior, a missed race, a regression, poor upstream fit.
Say which model and effort fit the task: a strong model at high effort for
subtle correctness on a small diff, a cheaper one at low effort for a
mechanical sweep. Findings are fixed first; the push comes after.

Every message sent to upstream — opening the request, its body, comments,
replies to reviewers — is approved by the human first. Two things are
autonomous: responding to a review with code changes when the required
change is clear, and, once that is settled and the commits are pushed, a
recap comment of the form "I responded with commits for X; for Y I did Z
because W. Ready for another look." Everything else waits for approval.

The branch is pushed to the fork when its request opens, and from then on
it is an open-request head, preserved as `## Branch model` says. The cycle
does not tend open offers. When the spec's reading says an offer has landed,
the matching carried work is retired at the next
cycle — by reading the upstream code, as `## Reconcile the fork` requires,
never because the request closed.

## Maintain the scratchpad

Update `SCRATCHPAD.md` during the cycle, not as an afterthought:

- replace the delivered baseline with the exact upstream and integration SHAs,
  and whatever the consumer recorded (a receipt, a pin);
- keep a separately named audited-upstream frontier with its exact SHA and
  completion date. Advance it only after every commit since the prior frontier
  was read and every carried feature received a disposition; an incomplete
  audit leaves the old frontier intact even if delivery moved;
- keep one current entry per carried feature: where it lives (carry head or
  stack commits), its exact integration commit, the historical upstream
  reference or verified replacement, the verification evidence, and its
  retirement condition;
- keep noteworthy upstream replacement opportunities without tracking
  request review health or implying the workshop maintains those requests;
- retain rerere or conflict context only while it can change a later
  decision;
- remove superseded state and append one compact dated history entry. For a
  completed audit, include the aggregate upstream range, commit count, notable
  releases or capabilities, stable upstream detail links when available, the
  retire/repair/unchanged disposition totals plus any non-unchanged features,
  and every material change in stance toward a carried behavior;
- record the final branch reconciliation; list an explicit `DELETEME/*` marker
  only when it affects maintenance.

Do not duplicate the spec's feature inventory, paste command logs, or store
secrets. Commit and push scratchpad changes on the workshop's main branch
after the fork and consumer state they describe are real.

## Notify and close

An interesting new upstream capability, a blocked gate, or a product
decision needing the human gets both a transcript report and a macOS
notification when `terminal-notifier` is available, with the title and
group `## Notify` declares:

```sh
terminal-notifier -title "<title>" -message "<concise outcome>" -group "<group>"
```

After a successful hand-over and scratchpad publication, confirm no live
process uses a cycle-owned worktree, then remove only the clean worktrees this
cycle created; keep their branches and exact commits available for the next
reconciliation, and never remove an unrelated or pre-existing worktree in
passing.

Every invocation ends with a self-contained, human-facing completion report
in the final transcript response, whether the cycle shipped, made no changes,
or stopped blocked. A scratchpad commit, notification, machine receipt, or
agent-to-agent handoff does not replace this report. Lead with the outcome,
then use these sections in plain language. Never omit a section because its
answer is empty; say `None` or `No material change` explicitly.

- **Outcome.** Say successful, no-op, or blocked. Name the delivered upstream,
  Integration, and consumer identity; for a blocked cycle, say explicitly
  that the prior publication and consumer binding were retained.
- **Upstream reviewed.** Give the aggregate audited range and commit count,
  and summarize meaningful user-facing, internal, and carry-relevant change
  groups inline. Link authoritative changelog or release notes when they cover
  the interval, and link the exact compare range or commits when the hosting
  provider permits. Say explicitly when there was no upstream delta or no
  authoritative link. A changelog supplements rather than replaces reading
  the interval, and a raw commit list does not stand in for the summary.
- **Fork accommodations.** Name each carried behavior that changed because of
  upstream, the interaction that required it, the adaptation, the observable
  behavior retained, and focused proof. Distinguish semantic repairs from
  clean replays or mechanical conflict resolution, and say `None beyond
  replay` when true. Put unrelated defects discovered by review or gating in
  follow-ups rather than presenting them as upstream accommodations.
- **Stance and carry impact.** State `Material stance changed` or `No
  material stance change`, give the retire/repair/unchanged totals and every
  non-unchanged feature, and explain whether upstream left each relevant carry
  necessary as-is, complemented or simplified it, narrowed its remaining
  scope, made it redundant or retired, increased its maintenance cost, or
  exposed a product decision. Call out corresponding `MAINTAIN.md` contract
  changes, new retirement or upstream-offer opportunities, and decisions still
  owed by the human. Never infer redundancy merely from a merged or closed
  upstream request.
- **Evidence and attention.** Report the published Integration identity,
  consumer result, meaningful gate and focused-check evidence, scratchpad
  commit and new audited frontier, nonblocking proof still running, residual
  risks or follow-ups, retained cycle worktrees or explicit deletion markers,
  and anything deliberately left for the human.

Keep the report proportional to the cycle and readable before presenting
low-level evidence. A compact table is useful when several carries changed.
Put exhaustive SHA graphs, leases, file inventories, and command receipts
after the readable report or behind a durable link when they are needed; do
not make the human reconstruct the outcome from them. Report the aggregate
range from the prior audited frontier even when intervening feature work had
already delivered its endpoint; never summarize only the final zero-delta
repair. A quiet cycle may omit the macOS notification, but never the
completion report.

<!-- extension-prompt: SYSTEM.md -->

<!-- extension-prompt: GUIDELINES.md -->

<!-- extension-prompt: TOOLS.md -->
