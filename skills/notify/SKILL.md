---
name: notify
description: Post a macOS notification with terminal-notifier to reach the human when they are away from the terminal — and diagnose one that never appeared.
---

# Notify

Post a macOS notification with `terminal-notifier`. The human is not
watching the terminal; this is how something reaches them before they
next look.

## Send one

```sh
terminal-notifier -title TITLE -message TEXT -ignoreDnD
```

Title and message are the only required parts. `-ignoreDnD` is worth
keeping by default — something worth notifying is worth surfacing through
Do Not Disturb.

- `-group ID` replaces the previous notification carrying that ID instead
  of stacking another beside it. One ID per recurring subject.
- `-open URL` opens a URL when clicked. `-execute COMMAND` runs a command
  headlessly, so its output goes nowhere a reader will see.
- `-sound default` for something that should interrupt rather than wait.

Write the message as the outcome, not a report: the human reads a banner,
so one line saying what finished or what is needed.

## When it does not appear

macOS refuses to surface a notification from an application bundle it has
not registered, and a Homebrew upgrade relocates the bundle — so delivery
can stop after an unrelated upgrade. `terminal-notifier` still exits 0,
which makes this silent.

`terminal-notifier -list ALL` prints what was actually delivered, with
timestamps, and settles whether the problem is delivery or the call.

Re-registering the bundle fixes it:

```sh
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$lsregister" -f "$(brew --prefix)/opt/terminal-notifier/terminal-notifier.app"
```

Re-register before a post, rather than only after noticing silence, if
notifications keep going missing on this machine.
