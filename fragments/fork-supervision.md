A repository the machine carries as a fork does not answer to `main`. Its
mirror branch tracks upstream exactly, its integration branch is what a
consumer builds, and its carried features live under a declared prefix. A
tool that assumes otherwise reads a landed carry head as finished work.

That shape is declared once, in the workshop's
`scripts/reconcile-branches.sh`, which exports what its `MAINTAIN.md`
`## Branch model` says. From there it travels two ways:

- `reconcile-branches.sh --print-model` emits the declaration as JSON and
  touches nothing.
- `reconcile-branches.sh --configure-supervision` converges it into the
  bound checkout's own git config — `supervisor.trunk`, `supervisor.mirror`,
  `supervisor.carryPrefix`, `supervisor.carryRef`,
  `supervisor.quarantinePrefix`, and `supervisor.workshop` — so a tool holding
  only the repository can resolve it without finding the workshop, and a
  linked worktree inherits it for free. `--check-supervision` verifies that
  convergence and that `MAINTAIN.md` still names the same branches.

  `carryPrefix` and `carryRef` are both multi-valued. A prefix names a
  namespace; a ref names one exact branch, for a carry that predates the
  convention — renaming a published branch is a publication, so the model
  describes what is there rather than what it wishes were there.

  Declare a prefix only for a namespace the fork **owns**, and exact refs for
  everything else. Widening a prefix to cover a stray carry silently claims
  every future branch under it — including the namespace upstream offers use —
  and the failure mode is invisible, because over-holding shows up only as
  proposals that never appear.

  The same run converges `supervisor.checkout` onto the **workshop** repository:
  one absolute path per bound fork, multi-valued. That is the opposite
  direction from everything above, and it exists because a fork kept inside its
  workshop is not reachable by a shallow walk of the project roots. A tool
  finds the workshop, reads the declaration, and follows it to the forks
  wherever they sit — including a workshop that binds several. Values are
  replaced as a set, never added to, so a fork dropped from the declaration
  disappears rather than lingering as a path nothing declares.

The config is derived state, never a second declaration: converge it rather
than editing those keys by hand, and treat a repository that answers no
`supervisor.trunk` as an ordinary `main`-based one.
