---
name: resource-update
description: Resume a resource under ~/resources — re-run its recorded queries, show a diff of what changed since it was built, and refresh its documents, report, and seam on approval.
---

# Resource Update

Pick up a resource where `resource-create` left it. The manifest holds the
queries, the documents, the exclusions, and the gaps; re-run that gather against
today's world and show what moved before writing anything.

The schema lives in `MANIFEST.md` beside this file.

## Find the resource

The invocation may name a slug, a path, or nothing. With nothing, list
`~/resources/*/MANIFEST.json` with titles and `updated` dates and ask which. With
an ambiguous partial, ask rather than guess — updating the wrong resource
rewrites a report.

A directory without a manifest is not a resource this skill can resume. Say so,
and offer `resource-create` to adopt it instead.

## Re-gather

Run every recorded source through its own refresh path:

- **`agentbrain`** — two passes, both required.

  *Replay* — re-run each recorded query verbatim with `agentbrain search`. This
  catches documents ingested since the resource was built. For each document
  already in the manifest, `agentbrain get --document-id N --full --json` and
  compare `updated_at` and content length against the recorded `ingested` and
  `chars`.

  *Widen* — write three or four **new** queries the recorded set doesn't cover
  and run those too. Recall is query-sensitive: agentbrain ranks by FTS5 over
  chunk text, so a phrasing that misses a document's vocabulary misses the
  document entirely, however on-topic it is. Replay alone inherits the original
  gather's blind spots permanently. Draw the new angles from what the resource
  has since taught you — the vocabulary of the documents already collected, the
  authors who recur, the counterargument nobody made, the adjacent failure mode.
  A document that was always in the database and never surfaced is a find, and
  should be reported as one.
- **`web`** — re-fetch each URL.
- **`file`** — re-read each path.
- **`session`** — nothing to re-run. Preserve as-is.

Then check the gaps: run each `check` command and see whether the material has
landed.

## Diff before writing

Report what you found, and stop. This is the beat that makes the skill worth
having — an update that silently rewrites a report is worse than no update.

- **New** — documents the manifest doesn't list, with title, `document_id`, and
  ingest date. Split them: *newly ingested* (dated after the resource's
  `updated`) versus *newly surfaced* (older documents the widen pass found that
  the original queries missed). The second kind is a correction to the resource's
  coverage and deserves saying so. For each, say whether it looks on-topic; the
  user decides.
- **Changed** — recorded documents whose `updated_at` or `chars` moved. A size
  jump with no date change usually means the original fetch was truncated.
- **Gaps closed** — a `check` that now returns the thing.
- **Unchanged** — a count, not a list.
- **Excluded** — named, with their recorded reasons, so the user can overturn
  one. Do not silently re-include.

Anything the user leaves unmentioned stays as it is. A fragment answering one
line ("add 902, skip the rest") is a decision — act on it without another round.

## Refresh

On approval:

- Rewrite changed documents in full; add new ones with the next numbers, or
  renumber if reading order genuinely changed — renumbering is a judgement call,
  so say you did it.
- Update `REPORT.md` around the change rather than regenerating it. A ranking
  the user approved once should not silently reshuffle; if new material displaces
  a direct hit, say so in the closing summary.
- Update `README.md` only where the change reaches it — the index always, the
  routed entry points only when the front of the collection actually moved.
- Preserve `session` sections verbatim. Append to them; never regenerate them.
- Rewrite `MANIFEST.json`: bump `updated`, keep `created`, fold in new documents,
  new sizes, resolved gaps, and any exclusion the user overturned. **Add the
  widen-pass queries to `queries`** — every productive angle becomes part of the
  recorded gather, so the next update replays it and widens past it. A widen
  query that found nothing is still worth keeping; it records ground already
  covered.

## Close

State what changed, what did not, and what is still missing. When the re-gather
found nothing new, say that plainly — a resource that is still current is a
useful result, and the manifest's `updated` date should still move to record the
check.
