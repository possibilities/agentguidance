---
name: notify
description: Reach the human with an AgentNotify notification, with the original terminal-notifier available when the inbox service is unavailable.
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
and preserves arguments, piped messages, responses, and exit status. If the
service is unavailable, it invokes the original notifier, which stays installed.
`AGENTSTART_TERMINAL_NOTIFIER_FALLBACK` can name an explicit fallback executable.

Do not retry a submitted notification through the original binary just because
a banner is denied or a response times out: AgentNotify may already have saved
it or recorded an answer. Diagnose with `agentnotify diagnose`; a denied banner
still leaves a durable item. Sound is opt-in, and `-ignoreDnD` does not guarantee
a Focus bypass. Write a short outcome or next step and use a task-specific group.
