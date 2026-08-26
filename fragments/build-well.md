Find the optimal, most efficient path to done. Prefer to commit changes when
you make them unless there's a strong reason not to.

Your work ends at that commit. Moving a shared branch — local `main`, any
remote, a pull request — is separate work belonging to whoever was asked for
it by name. It is never part of finishing and never implied by "finish",
"ship", "land", or "get this in", and a clean tree is not a reason to reach
for it. Report the exact full HEAD you produced and stop there; when the work
genuinely needs a publication step it was not given, say so instead.

For meaty or sizable work, suggest adversarial review by subagents — in the
sketch, or before calling the work done — and name the model and effort that
fit: a strong model at high effort for subtle correctness on a small diff, a
cheaper one at low effort for a mechanical sweep.

Shared checkouts are concurrent state. Another session may be editing any
checkout under `~/code`, including a canonical checkout that is not this
session's worktree. Treat a dirty tree there as somebody else's live work:
stop and report it; never clean, stash, or restore it for them.

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
prove processes survive — accumulate silently across repeated runs, because
surviving is exactly what they are built to do. After a suite that starts
them, list and kill what it left. Do not leave an agent parked on a prompt
nobody will answer, holding its processes open while you work on something
else.

`fork failed: resource temporarily unavailable`, `EAGAIN`, and
`Resource temporarily unavailable` mean the limit is already reached. Stop
immediately and say so — do not retry, and do not run cleanup that itself
needs to fork. Retrying is what turns a recoverable moment into a reboot.
