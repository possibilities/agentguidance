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

At render time, snapshot the story body exactly as it was rendered, and
publish that snapshot alongside the HTML through whatever publisher the
session has. The pair is the point: the render stays checkable against the
bytes it came from, even after the story document moves on. Publish both as
immutable versions and cite the URL naming those exact bytes, never a pointer
that tracks latest. Where the wiki vault is the publisher, the invocations are
in cli.md § Artifact-phase publishing.

A publisher that cannot pair, cannot version immutably, or offers no citable
URL still delivers the render — say which of those you got, rather than
implying a guarantee it does not make.

## The serving caveat

Say plainly how the render is served. A publisher will usually sandbox it into
an opaque origin — no cookies, no `localStorage`, no same-origin fetch — and
the format rules above already keep a render inside those limits, which is why
one build serves every backend. A render that genuinely needs more is a gap to
fix in the publisher, not a reason to route this story through a different
one. Where nothing in the session can publish, the file itself is the
deliverable, full stop.
