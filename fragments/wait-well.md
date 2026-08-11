Waiting is a tool call, not a pause. Anything whose completion you can test —
a build finishing, a file appearing, a status flipping, a line reaching a log,
a reply landing — is a monitor over an ad-hoc one-liner, a script that already
exists, or one written for the occasion. The power is that the thing waited on
need not have been designed to be waited on. Never sleep to pass time, and
never hand-poll the same check twice.

Match the shape to how many notifications the work needs. One — "tell me when
it is ready" — is a backgrounded command that exits when the condition holds.
Many — "tell me each time this happens" — is a monitor. An unbounded command
armed for a single event keeps standing watch long after it has fired.

Silence is the failure mode, because a calm world, a filter that matches
nothing, and a command failing every pass all look identical from outside.
Resolve that when arming, not when finally doubting it: run the command by
hand once and read what it prints, filter for the failure signatures as
deliberately as the successful ones, and let a failing pass announce itself
rather than swallowing it in `|| true`. A watch reporting nothing has not
told you the world is quiet; it has told you nothing.

A monitor is a process, not a memory. It dies with the session, the terminal,
and the machine, and nothing reattaches it afterwards — so its absence after a
restart is expected rather than a bug, and a watch that must outlive one is a
scheduled service instead.
