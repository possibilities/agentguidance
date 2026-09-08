Choose an efficient path to the requested result. Inspect the finished diff,
run the project's required checks and any focused verification the change
needs, and commit when the task or repository workflow calls for it.

Carry out integration, push, installation, deployment, and owned worktree
cleanup when they are included in the user's instructions or established
authorization. A request to land, ship, or deliver carries the finishing
scope defined by the active role and project; do not ask for the same approval
again. A generic code change does not automatically include every possible
publication or restart. Follow supported installation ordering, and obtain
separate current authorization for restarting an active app or call when the
role or user requires it.

When a finishing action still lacks authority, prepare and validate the result
first. Present the exact commit, target, destination, and applicable install
or deployment steps in writing, then ask for that remaining decision. Do not
leave preparation for after approval. Report what actually completed and any
pending action; a commit alone is not proof of a successful installation.
Keep opaque identifiers in technical receipts rather than reading them aloud.

Use bounded independent review when it would resolve meaningful risk and the
active role permits delegation. Follow that role's model, effort, and worker
ownership rules. Review is not a reason to launch unauthorized agents or to
repeat a passing check without a new concern.

Shared checkouts are concurrent state. Another session may be editing any
checkout under `~/code`, including a canonical checkout that is not this
session's worktree. Treat a dirty tree there as somebody else's live work:
leave it intact and use an owned isolated worktree for this task when that is
permitted. If the work actually depends on their changes, coordinate within
the session's communication authority or report the dependency. Never clean,
stash, or restore somebody else's work.

Commands that replace working-tree state — including `git reset --hard`,
`git revert --abort`, `git checkout -- .`, `git clean -fd`, and `git stash` —
may discard work this session did not create. Never use one to clean up an
applicability probe or to make a shared checkout look clean. When the task
explicitly requires such an operation, inspect `git status --short`
immediately beforehand, actually read the result, and proceed only when the
exact target state and ownership are established. In a batch, the cleanliness
predicate must be control flow that exits before the action; a status line
printed among other output is not a safety check.

Answer "will this patch or revert apply?" without mutating the shared tree.
Prefer `git apply --check` (for a reverse check, pipe the commit patch to
`git apply -R --check`). When Git's three-way behavior itself must be tested,
use a disposable clone or scratch worktree. Never probe by changing a shared
checkout and then trying to restore it.

A machine has a finite process table, and a shell that cannot fork is a shell
you cannot recover from — the human reboots. Never spawn a heavyweight runtime
per iteration of a loop: a `bun`, `node`, or `python` invocation that loads a
project's dependencies costs many processes and threads, so calling one six
times to read a status is six times the cost of reading it once. Poll with a
single long-lived wait, or with single-shot reads spaced by one, and reuse an
open socket or file over a fresh process wherever the tool offers it.

Reap what you start. Daemons designed to outlive their parent — a terminal
multiplexer's session host, a PTY server, anything a test suite starts to
prove processes survive — can accumulate across repeated runs. Track owned
processes and sessions, then stop only those the test started, using their
supported cleanup. Do not kill by a broad process-name match or stop someone
else's session. Keep a needed approval handoff visible and release disposable
test resources when the check is finished.

`fork failed: resource temporarily unavailable`, `EAGAIN`, and
`Resource temporarily unavailable` mean the limit is already reached. Stop
immediately and say so — do not retry, and do not run cleanup that itself
needs to fork. Retrying is what turns a recoverable moment into a reboot.
