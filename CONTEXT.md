# Context

**Resource** — a directory under `~/resources/<slug>/` holding a gathered body of
material on one question: a seam, a report, the full source documents, and a
manifest. A resource is durable and refreshable; it outlives the session that
made it.
_Avoid_: collection, bundle, dump.

**Seam** — the `README.md` at a resource root. Its job is to get a reader into
the documents, not to summarize them: a pull-quote, a few routed entry points,
the index below the fold. Minimal by design.
_Avoid_: index, landing page, overview.

**Manifest** — the `MANIFEST.json` at a resource root. The contract between
`resource-create` and `resource-update`: what was gathered, from which queries,
what was deliberately left out, and what was wanted but unavailable. It records
provenance, not history.
_Avoid_: metadata, lockfile, index.

**Gap** — material a resource wants but could not include, recorded in the
manifest with a check that tells a later session whether it has since become
available.
_Avoid_: TODO, missing.

**Extension prompt** — a Markdown file with a recognized name under
`~/.config/agentguidance/` that `scripts/render` splices into a skill template
at its matching render point (an HTML comment naming the file). `SYSTEM.md`,
`GUIDELINES.md`, and `TOOLS.md` are the recognized names; an absent file
renders to nothing. The files are the operator's, linked there by AgentStart.
_Avoid_: extension guidance, plugin, override.

**Fragment** — a Markdown file under `fragments/` that `scripts/render`
splices into a skill template at its matching render point. Repo-owned shared
doctrine, unlike an extension prompt (operator-owned); a missing fragment
fails the render instead of rendering to nothing.
_Avoid_: snippet, partial, include.

**Post-sync hook** — `scripts/post-sync`, run by AgentStart's sync-skills after
this checkout's templates ship, so installed copies are always rendered. Here
it execs the render; the name is the fleet convention, the render is this
repo's use of it.
_Avoid_: build step, postinstall.
