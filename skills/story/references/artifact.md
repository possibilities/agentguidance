# The interactive artifact

An optional presentation phase of the same workflow — never a second skill,
because skill-to-skill composition cannot be assumed across harnesses.

## The offer

One question, asked exactly once, after the prose is saved: whether the human
wants the story as an interactive artifact. Declining is the default and
costs nothing. Never build it unasked, never ask earlier — a human who wants
only prose should never have paid for the render.

## The format

One self-contained HTML file:

- Inline CSS and JS, zero external requests, any assets as data URIs.
- Theme-aware: light and dark both styled, following the viewer's preference.
- Responsive down to phone width; reduced motion respected (autoplaying
  animation pauses, not merely loses its transitions).

Those constraints satisfy strict artifact CSPs, offline reading, and plain
file-opening equally, so one build serves every harness.

## Presentation, never content

The render may add: a sticky table of contents, the map as a real diagram, a
filterable coverage table, working source links. Every claim in the HTML must
be present in the Markdown — the artifact is a render of the story, not a
rewrite with opinions.

## Storage: the source/render pair, kept honest

At render time, snapshot the story body as it was rendered and publish the
pair per cli.md § Artifact-phase publishing: the snapshot under
`--kind evidence`, the HTML under `--kind render`. Both are content-addressed,
so each `/a/<name>/v/<hash>/` URL keeps naming exactly the bytes it was
published from even after the story document moves on. Cite the version URL,
never the latest pointer.

## The serving caveat

State it plainly when delivering: `agentwiki serve` sends
`Content-Security-Policy: sandbox allow-scripts`, so the render does run from
there, but in a unique opaque origin — no cookies, no `localStorage`, no
same-origin fetch. A render that needs any of those is interactive only when
opened as a file, or when published through a harness that can publish pages
(for example the Claude Artifact tool, when present — offer that only when
the tool actually exists in the session). Where no publishing tool exists,
the file is the deliverable, full stop.
