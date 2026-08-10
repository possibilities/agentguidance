# Manifest schema

`MANIFEST.json` at a resource root. Written by `resource-create`, read and
rewritten by `resource-update`. It records provenance — enough for a cold
session to reproduce the gather — not a history of edits.

```json
{
  "schema_version": 1,
  "slug": "prompt-simplification-strong-models",
  "title": "Less Prompt, Better Model",
  "question": "One sentence: what this resource is a body of material about.",
  "created": "2026-08-07",
  "updated": "2026-08-07",
  "layout": {
    "seam": "README.md",
    "report": "REPORT.md",
    "docs_dir": "docs"
  },
  "sources": [],
  "excluded": [],
  "gaps": []
}
```

## `sources[]`

Each entry is typed. The type determines whether `resource-update` can refresh
it.

### `agentbrain` — refreshable

```json
{
  "type": "agentbrain",
  "db": "~/.local/share/agentbrain/research.db",
  "queries": [
    "less prompting smarter models trust the model",
    "context engineering CLAUDE.md simplify skills"
  ],
  "documents": [
    {
      "document_id": 837,
      "file": "docs/01-new-rules-context-engineering-claude-5.md",
      "title": "The new rules of context engineering for Claude 5 models",
      "source_uri": "https://x.com/i/status/2080710971228918066",
      "ingested": "2026-08-07",
      "chars": 10410
    }
  ]
}
```

`queries` are the exact strings passed to `agentbrain search`, and the list
**accumulates**. Update replays them verbatim and then adds fresh angles of its
own; the productive new ones are appended here, so coverage widens with each
pass instead of repeating one gather's blind spots. Editing or deleting an
existing query changes what the resource means — treat that as a decision, not a
tidy-up.

`ingested` is the document's `updated_at`, and `chars` the length of the fetched
body. Together they tell update whether a document moved underneath the
resource.

### `session` — not refreshable

```json
{
  "type": "session",
  "description": "Comparison against a prior agentbrain run, from conversation only.",
  "files": ["REPORT.md"]
}
```

Prose derived from a conversation has no source to re-read. Update preserves and
appends to these sections; it never regenerates them.

### `web` — refreshable by fetch

```json
{
  "type": "web",
  "url": "https://example.com/post",
  "file": "docs/11-example.md",
  "fetched": "2026-08-07"
}
```

### `file` — refreshable by copy

```json
{
  "type": "file",
  "path": "~/code/thing/NOTES.md",
  "file": "docs/12-notes.md",
  "copied": "2026-08-07"
}
```

## `excluded[]`

Things considered and deliberately left out, so update does not re-litigate
them.

```json
{
  "ref": "agentbrain:871",
  "title": "Token Smarter, not Harder",
  "reason": "Stored content is the HumanLayer product homepage, not an article."
}
```

## `gaps[]`

Material the resource wants but could not include. `check` is a command a later
session can run to learn whether the gap has closed.

```json
{
  "title": "The Bitter Lesson of Agent Harnesses",
  "uri": "https://browser-use.com/posts/bitter-lesson-agent-harnesses",
  "reason": "Not ingested; appears only as an outbound link in document_id=226.",
  "check": "agentbrain search \"bitter lesson agent harnesses\" --json"
}
```

## Rules

- Dates are `YYYY-MM-DD`, absolute, never relative.
- Paths under `file` are relative to the resource root.
- A `document_id` appears in `documents` or in `excluded`, never both.
- Update rewrites the whole manifest and bumps `updated`. `created` never
  changes.
