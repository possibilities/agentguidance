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
- `SCRATCHPAD.md` — current state: the last completed baseline, one entry per
  carried feature, notes that can change a later decision, a compact dated
  history. Updated during the cycle, never a second specification or an
  unbounded transcript.
- `scripts/` — the workshop's thin entrypoints: `reconcile-branches.sh`
  exporting the declared branch model into this skill's shared script, the
  gate runner, and the consumer command.

`MAINTAIN.md` has fixed sections, and the cycle reads each by name:

| Section | What it declares |
| --- | --- |
| `## Purpose` | What the fork is for and what it is not. |
| `## Upstream` | The bound checkout, the `fork` and upstream remotes with their repositories, the upstream's contribution conventions and what they mean for us, what we offer upstream and how "landed" is recognized. |
| `## Branch model` | The mirror branch, the integration branch, the composition model — `carry/<feature>` heads composed onto upstream, or one linear stack rebased whole — the quarantine prefix, whether open pull-request heads are preserved, and whether rerere is relied on. |
| `## Features` | The inventory: every behavior the fork must carry, as behavior, with its scope line. Absence is work, never a status note. |
| `## Gate` | The exact commands, fenced, run verbatim from the candidate worktree, and any external proof (hosted CI, a ship gate) the publication requires. |
| `## Consumer` | Who consumes the published integration branch and the command that hands it over — an installer, a pin, a rebuild. |
| `## Notify` | The notification title and group. |

A workshop whose spec lacks a section has not said what the cycle should
do there; stop and say so rather than improvise.

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
  cycle never mutates them. An open request's exact head is preserved on
  the fork, when the spec says so, only while it is open.
- The fork's branch namespace is owned completely: the only live heads are
  the mirror, the integration branch, the current carry heads (under the
  carry model), and preserved open-request heads. Every other head is moved
  at the same commit to the quarantine prefix, never deleted; quarantine is
  permanent and a name collision is a hard refusal. `reconcile-branches.sh`
  is the deterministic owner of this policy: `--check` is read-only and
  works from a disposable snapshot, `--apply` pushes the whole plan in one
  atomic, exact-leased push. Never reproduce its mutation by hand.
- Carried work must be an ancestor of the published integration branch —
  every carry head under the carry model, every stack commit under the
  linear model.
- A recorded rerere resolution, where the spec relies on rerere, is
  evidence, not proof: after upstream changes, reread the affected behavior
  before accepting it.
- Reconciliation runs again after the hand-over, so the cycle's temporary
  candidate branch is quarantined and the fork ends with no unexplained
  live head.

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

   Stop on any divergence, a missing or moved preserved head, a carry
   outside integration, a quarantine collision, a lease failure, or an
   unexpected remote identity. Before the first live apply on a fork, look
   at what the fork's hosted CI (if any) triggers on branch creation:
   quarantine creates heads.
4. Fetch both remotes. Compare upstream and integration with the last
   completed baseline in the scratchpad. Read every upstream commit in that
   interval, grouping related changes before deciding whether they affect a
   carried feature.
5. For each carried feature, inspect current upstream code and any
   historical upstream reference in the scratchpad for a replacement or an
   interaction. Evidence only: do not rebase or push their branches, or
   comment on, label, close, or edit the requests.

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

The final check should report only the mirror, the integration branch,
current carries, preserved open-request heads, and permanent quarantine.
Do not hand-delete a candidate or any other branch after the cycle.

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
does not tend open offers; `watch-requests` does. When the spec's reading
says an offer has landed, the matching carried work is retired at the next
cycle — by reading the upstream code, as `## Reconcile the fork` requires,
never because the request closed.

## Maintain the scratchpad

Update `SCRATCHPAD.md` during the cycle, not as an afterthought:

- replace the completed baseline with the exact upstream and integration
  SHAs, and whatever the consumer recorded (a receipt, a pin);
- keep one current entry per carried feature: where it lives (carry head or
  stack commits), its exact integration commit, the historical upstream
  reference or verified replacement, the verification evidence, and its
  retirement condition;
- keep noteworthy upstream replacement opportunities without tracking
  request review health or implying the workshop maintains those requests;
- retain rerere or conflict context only while it can change a later
  decision;
- remove superseded state and append one compact dated history entry;
- record the final branch reconciliation and the candidate's quarantine
  name; do not list every permanent quarantine head unless one affects
  maintenance.

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

Finish with the published integration SHA, the consumer's result, feature
disposition, checks run, the scratchpad commit, upstream replacements
considered, and anything deliberately left for the human. After a
successful hand-over and scratchpad publication, confirm no live process
uses a cycle-owned worktree, then remove only the clean worktrees this
cycle created; keep their branches and exact commits available for the next
reconciliation, and never remove an unrelated or pre-existing worktree in
passing. Silence is appropriate when no noteworthy capability or decision
was found.

<!-- extension-prompt: SYSTEM.md -->

<!-- extension-prompt: GUIDELINES.md -->

<!-- extension-prompt: TOOLS.md -->
