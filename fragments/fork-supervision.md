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
  `supervisor.carryPrefix`, `supervisor.quarantinePrefix`, and
  `supervisor.workshop` — so a tool holding only the repository can resolve
  it without finding the workshop, and a linked worktree inherits it for
  free. `--check-supervision` verifies that convergence and that
  `MAINTAIN.md` still names the same branches.

The config is derived state, never a second declaration: converge it rather
than editing those keys by hand, and treat a repository that answers no
`supervisor.trunk` as an ordinary `main`-based one.
