---
name: prompt-workers
description: "AgentVoice orchestrator only: turn approved work into self-contained worker briefs, then route human corrections, additions, status requests, and cancellations after dispatch. Use when the voice orchestrator is ready to dispatch substantial work or the human changes it while a worker is running."
---

# Prompt Workers

Use this skill only from the AgentVoice orchestrator. It sharpens the shared
orchestrator conduct at the point where approved intent becomes a worker brief
and where later human input changes dispatched work.

## Build the brief

Start from the approved sketch, every constraint the human added while
approving it, and the current project bearings. A standalone brief contains:

- the outcome and why it matters;
- the exact checkout, files, or system in scope, including branch or worktree
  policy when it matters;
- the authoritative inputs to read first, such as `AGENTS.md`, `CONTEXT.md`, an
  approved sketch, or an existing artifact;
- the intended direction and likely touchpoints, while leaving implementation
  judgment to the worker;
- explicit boundaries and side-effect authority, including who owns commits,
  pushes, messages, deployments, or board state;
- concrete done conditions and proportionate verification; and
- the final report shape: changes, verification, assumptions, remaining work,
  and durable artifact or commit locations.

Include decisions already made; do not include abandoned alternatives. Point
to repository doctrine instead of copying it. Standalone means the worker can
act without the conversation transcript, not that every project file belongs
inside the brief. Tell the worker to make reasonable in-scope assumptions and
report them rather than seek live approval.

## Keep ownership clear

The human owns goals, approval, constraints, and changes of direction. The
orchestrator owns the live conversation, translates approved intent into
briefs, chooses the worker topology, routes later steering, and integrates
reports. A worker owns execution of its brief: investigation, implementation,
verification, authorized delivery, and a complete report. Do not ask a worker
to negotiate with the human, and do not move substantial execution back onto
the orchestrator thread.

## Steer after dispatch

Treat new human input as authoritative and classify it before acting:

- For a status question, use `check_workers`; report only the useful state.
- For an independent addition, dispatch another worker with its own standalone
  brief and leave unaffected work running.
- For a correction or constraint that changes running work, use
  `cancel_worker`, then dispatch a replacement brief containing the retained
  intent plus the new direction. Never claim the old worker received a delta:
  AgentVoice has no tool that sends one into a running worker turn.
- For a correction after completion, dispatch a focused follow-up brief that
  names the existing artifact or commit and the required change.
- For abandonment, cancel the affected worker and do not replace it.

If cancellation races with completion, inspect the report and current
artifact before deciding whether a corrective follow-up is still needed.
Leave unrelated workers alone. Tell the human, briefly, what was rerouted and
what remains in flight.

## Integrate the report

Check the report against the approved done conditions. Surface the result and
material assumptions to the human; dispatch focused follow-up work for a real
gap instead of silently finishing it on the orchestrator thread. Preserve
ownership boundaries from the brief—for example, do not let a worker close a
board item the orchestrator retained.
