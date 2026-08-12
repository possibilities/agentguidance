---
name: resource-create
description: Turn research — an agentbrain search, a session's findings, a set of links — into a durable resource directory under ~/resources with a seam, a report, full source documents, and a manifest.
---

# Resource Create

Gather a body of material on one question into `~/resources/<slug>/` so it
survives the session that found it. The manifest you write is what
`resource-update` reads later; write it as a contract, not a log.

The schema lives in `MANIFEST.md` beside this file. Read it before writing a
manifest.

## Read the corpus

The invocation names what to gather — "from our agentbrain search", "from
everything we learned in this session", "from these links". Resolve it to
concrete sources before doing anything else:

- **An agentbrain search** — the queries already run in this conversation, plus
  several more angles on the same question. Search ranks by FTS5 over chunk
  text, so recall follows vocabulary: one phrasing silently misses documents
  whose words differ, however on-topic they are. Vary the angle — the author's
  framing, the opposing position, the failure mode, the tool rather than the
  idea — until new queries stop returning new documents. Keep the exact query
  strings; they go in the manifest and become the baseline every later update
  replays.
- **A session** — the findings, comparisons, and judgements from the
  conversation. These have no source to re-read, so they become `session`
  sources and live in the report.
- **Links or files** — fetch or copy each one.

Most resources mix types. When the invocation is ambiguous about scope — one
search or every search this session, the whole topic or the part just discussed
— ask, once, with the two readings named.

## Gather

- **Fetch documents in full.** `agentbrain get --document-id N --full --json`.
  Without `--full` the CLI head/tail truncates at 20,000 chars and says nothing
  about it. A 90K paper arrives as 20K and reads as complete.
- Name each file `NN-slug.md`, numbered in the order a reader should meet them,
  not the order you found them.
- Head each file with a provenance comment: `<!-- agentbrain document_id=837 |
  <source_uri> | ingested YYYY-MM-DD -->`.
- Verify what you fetched. A document whose stored content is a product
  homepage, a paywall, or a nav shell is not a document — exclude it and record
  why.

## Write

Four things, in this order:

`docs/NN-*.md` — the full sources, unedited.

`REPORT.md` — the survey. Direct hits first with the quotes that earn the
ranking, then adjacent material, then what you checked and discarded and why,
then gaps. Cite `document_id` and source URI throughout. This is where the
reader goes to decide what to read; it can be long.

`README.md` — the seam. Its job is to get a reader through a door, so it
advertises rather than summarizes: something that makes the question feel worth
an hour, a line on what the collection is, a few doors with a sentence each on
why that one, and the full index below the fold. The doors are the design
problem — pick them so each offers a different reason to enter, and the reader
can tell from the outside which one is theirs.

A seam that explains the documents has become the report. Length is the tell.

`MANIFEST.json` — per `MANIFEST.md` beside this skill. Record the queries verbatim, every
included document with its `document_id`/`ingested`/`chars`, every exclusion with
its reason, and every gap with a `check` command.

## Close

State the path, the file count, and the size. Name anything you excluded and
anything still missing — a resource that hides its gaps is worse than a short
one. Then say plainly that the `resource-update` skill, given the resource's
slug, will refresh it.
