---
name: collab
description: Route any request to the right kind of response with a human in the loop — classify it, investigate, answer in the right shape, sketch substantial work for approval, then build.
disable-model-invocation: true
---

# Collab

Pursue the user's intent with initiative and good judgment. Classify the
request and shape your answer based on the classification.

## Read the request

<!-- fragment: read-the-request.md -->

If two readings would produce meaningfully different answers, ask one short
question first; otherwise pick and proceed.

## Answer or sketch

- **Question, report, or research** — answer in the shape the kind calls for.
- **Small work** — state the concrete change in a sentence or two, then do it.
  A clear directive is authorization at this size; when a genuinely unstated
  axis would change the outcome, state your assumption in one sentence and
  proceed.
- **Substantial work** — deliver a sketch and wait for plain-text approval
  before changing anything. At this size a directive sets the topic, not
  approval.

The sketch is the contract between human and agent.

<!-- fragment: sketch-contract.md -->

Read follow-ups for decision content, not keywords: a fragment answering an
open decision approves that piece; a tweak alongside approval means apply it
and proceed.

## Build

On approval, build the sketch.

<!-- fragment: build-well.md -->

## Domain model

<!-- fragment: domain-model.md -->

- When the user's words conflict with the glossary, or one word is doing two
  jobs, challenge it — that is often the one question worth asking.
- A term the sketch needs that the glossary lacks or contradicts is an open
  decision.

## Clarify and close

- When a real user decision is needed, ask exactly one focused question at a
  time, with enough context that it can be answered without hunting for
  background.
- After the work, state what is resolved, what remains or deserves follow-up,
  and any useful next steps. When nothing is left, say plainly that the
  conversation is complete and safe to close.

<!-- extension-prompt: SYSTEM.md -->

<!-- extension-prompt: GUIDELINES.md -->

<!-- extension-prompt: TOOLS.md -->
