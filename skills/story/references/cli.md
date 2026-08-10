# Delivering through the wiki vault

Stories are saved with `agentwiki`, the durable document vault. The vault is
a directory of plain markdown files — `~/wiki` by default — and the CLI is how
you find a document, not how you write one. `--vault <path>` (or
`AGENTWIKI_VAULT`) retargets it; use that only when the user or the session
directs it.

## Finding the CLI — fail closed

1. `agentwiki` on `PATH`. That is the ordinary case and needs no resolution.
2. A checkout the user has named: `bun run --cwd <checkout> src/main.ts <args>`.
3. Ask the user where AgentWiki is.

If none works, fall back to plain files (below) and say plainly that the story
was not stored. Never hand-write into `~/wiki`: a file dropped in without
going through the CLI is indexed on the next read, but the slug, frontmatter,
and link graph are the store's to derive, not yours to guess.

Every command takes `--json` and answers with
`{"schema_version":1,"ok":…,"error":…,"data":…}`. Branch on `error.code`;
`recovery` is written to be run verbatim.

## Look for a prior story first

Re-runs update rather than duplicate (schema.md § Re-runs):

```bash
agentwiki search "<subject>" --tag stories --limit 5 --json
agentwiki list --tag stories --limit 20 --json
```

A match for the same subject is an **update**, and an update is a file write,
not a command — there is no `update` verb and that is deliberate:

```bash
agentwiki path <slug>          # absolute path to the document's file
# …overwrite that file with the new story, keeping its frontmatter…
agentwiki get <slug> --json    # the change is already visible; nothing to sync
```

Keep the existing frontmatter block when you overwrite; the tags and title
live there. A story whose scope genuinely shifted is a new document instead —
create it, then write `[[<old-slug>]]` into its body so the thread survives.

## Create

Write the story to a file first, then capture it:

```bash
agentwiki add <story.md> \
    --title "<story title>" \
    --tags stories,<kind>,<project-name> \
    --json
```

`add` never fails on a slug clash — it slides to `<slug>-2` — which is why the
search above is not optional. Report the returned slug and path to the user.

Provenance that the old store carried as typed links is carried by the
document itself: the provenance block names the repository, remote, and
commit (schema.md), and `[[<slug>]]` wikilinks relate a story to its
neighbours. Confirm the edges landed rather than assuming they did:

```bash
agentwiki links <slug> --json      # outgoing, with dangling[] and reasons
agentwiki backlinks <slug> --json  # incoming
```

## The folder form

Each part is its own document, and the spine links them by wikilink rather
than by relative path:

```bash
agentwiki add document.md --title "<title>" --tags stories,<kind> --json
agentwiki add part-01-<slug>.md --title "<title> — <part>" --tags stories,part --json
```

One `add` per part. Write `[[<part-slug>]]` into the spine for each, then
check `agentwiki links <spine-slug> --json` to prove every part resolved.

## Artifact-phase publishing

The interactive render is published as an immutable artifact, paired with a
snapshot of the story body it was rendered from — the pair and its rationale
are in artifact.md:

```bash
agentwiki publish <story.snapshot.md> --name <story-slug> --kind evidence \
    --title "<story title>" --tag stories --json
agentwiki publish <story.html> --name <story-slug> --kind render \
    --title "<story title>" --tag stories --json
```

`data.version_url` (`/a/<name>/v/<hash>/`) is immutable and is the one to
cite. `data.url` tracks latest and will move under a later publish. Publishing
also writes a stub document into the vault, which is what puts the render into
the searchable graph; repeat `--tag` on every publish, because tags are
per-version and do not carry over.

`agentwiki serve` answers artifacts on their own loopback origin, so a render
gets storage and can load and fetch its own files, while reaching neither the
vault's documents nor the network. Both URLs above are paths, so they are
cited as-is; the document port redirects to the artifact origin.

## Fallback, and the rule that beats everything

- **No CLI reachable:** write the story to a path the user names, or to
  `./<slug>.story.md` in the current directory, and state that it was not
  stored.
- **An explicit path from the user always wins**, in every mode: "write it to
  `~/notes/x.md`" means that file, not a document in the vault.
