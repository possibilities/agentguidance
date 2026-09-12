---
name: notify
description: Reach the human through AgentNotify's durable inbox or AgentStart's AgentNotify-only terminal-notifier router.
---

# Notify

Use AgentNotify's `notifications` skill for durable completion notices,
actionable prompts, replies, and diagnosis. The AgentNotify MCP and CLI own
that workflow; `agentnotify guide --json` is the operation contract.

For an existing terminal-notifier caller, use AgentStart's installed router:

```sh
"$HOME/.local/bin/terminal-notifier" -title TITLE -message TEXT -group TASK_ID
```

The router checks AgentNotify before submitting, starts the inbox if needed,
and preserves arguments, piped messages, responses, and exit status. If
AgentNotify remains unavailable, it exits 127 before submitting a notification;
it never falls back to the original terminal-notifier.

Do not retry a submitted notification through another delivery path just because
a response times out: AgentNotify may already have saved it or recorded an
answer. Diagnose with `agentnotify diagnose`. AgentNotify's own arrival is the
only presentation; legacy sound and `-ignoreDnD` inputs do not enable macOS
banners. Write a short outcome or next step and use a task-specific group.
