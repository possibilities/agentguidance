# The story schema, the coverage proof, and link portability

## The document

One story is one Markdown document by default. Its body has six parts, in this
order:

1. **Title and hook.** An honest, evocative title with the subject named
   plainly in a subtitle. The opening paragraphs put a person on stage — a
   user mid-task or a developer mid-change — and state what is at stake for
   them. UX for product surfaces, DX for internals; most subjects have both,
   so open with whichever dominates.
2. **`## About this story` — the provenance block.** A short deterministic
   section containing: the scope instruction verbatim (or "none — the whole
   project"), the subject kind, the repository and remote, the commit the
   story was written against, the date, the inventory counts in the form
   `N units — M narrated, P named, K waived`, and one sentence stating how to
   resolve the story's code links (see *Source links* below). This block is
   the story's contract with its reader: what was covered, as of what, and how
   to check.
3. **`## The map`.** Orientation before narrative: a compact table of the
   subject's components with a one-line purpose and a link each. A Mermaid
   diagram may accompany the table but must read sensibly as text. This is the
   section a returning reader lands on.
4. **The chapters.** The narrative itself. Headings are chosen for the story,
   never generated from the file tree.
5. **`## Coverage` — the appendix.** The proof table described below.
6. **`## Further reading`.** Repository docs, external resources, and related
   stories.

**Every story-specific fact lives in the body, never in frontmatter.**
Frontmatter is the vault's namespace — title, tags, and its tombstone stamps —
and a re-run overwrites the file wholesale. Anything story-specific put there
is a fact the next run has to remember to carry, which is exactly the kind of
bookkeeping the provenance block and the coverage appendix exist to make
unnecessary.

## The coverage ledger and its unit grammar

The ledger is a working file in scratch space — not part of the deliverable;
its content survives as the coverage appendix. Unit ids:

- `sym:<path>#<name>` — an exported or top-level symbol: function, class,
  type, interface, constant.
- `path:<path>` — a file or module treated as one unit (the grain for
  subsystem, feature, and project scopes).
- `flow:<name>` — a handoff or traversal: a request path, a lifecycle, a
  failure path, a cross-seam call.
- `inv:<name>` — an invariant or contract, harvested from tests and the
  repository's own docs.
- `ext:<name>` — an external touchpoint: a CLI command, an HTTP route, an
  environment variable, a port, a storage path.

**Enumeration method by kind.** For a `file`: read the whole file; ledger
every export and top-level declaration (grep for `export` or the language's
equivalent as a mechanical cross-check; use LSP symbol listing when the
harness offers it), and ledger meaningful internal paths — error handling,
guards, fallbacks, retry/no-retry decisions — as `flow:` units, because a
file's DX story usually lives in its failure paths. For larger scopes: walk
the tree; every module gets a `path:` unit, every entry point an `ext:`,
every cross-module handoff a `flow:`, every documented invariant an `inv:`.
For `other`: the units are the contract's own properties, drawn from its
implementation and its documentation.

**Proportionality rule.** Every unit earns at least a name, a purpose, and a
UX-or-DX consequence — one sentence minimum. Load-bearing units get scenes.
The appendix records the depth each unit actually received:

- `narrated` — a scene or substantial passage
- `named` — the one-sentence minimum
- `waived` — excluded, with a reason from the closed set below

## The proof

Three mechanisms, all required:

1. **The ledger precedes the prose** (workflow phase 2), so "what must be
   covered" is fixed by enumeration, not by what the narrative happened to
   mention.
2. **The re-sweep.** After writing, enumerate the subject again *from
   scratch* — not by rereading the ledger — and diff. This guards against the
   ledger itself being incomplete; a proof that only checks the writer's own
   list proves nothing. Cover or waive anything new before delivery.
3. **Waivers come from a closed set.** `re-export` (no behavior of its own),
   `generated` (point at the generator instead), `vestigial` (with the
   evidence it is dead), `boundary` (belongs to a different story, which is
   named), `alias` (a trivial rename of a covered unit). No free-text waivers:
   they are how omission dresses up as judgment.

The appendix is one table — unit id, depth, anchor link to the section that
teaches it, or the waiver reason — so the proof is auditable by the reader,
not just asserted by the writer. State the enumeration method in or beside
the table: the proof covers the inventory, and the reader judges the
inventory by how it was made.

## Source links

A story outlives its checkout, so no link may depend on the machine or the
branch it was written on:

- **With a published remote:** permalinks in blob-at-commit form —
  `https://<host>/<org>/<repo>/blob/<commit>/<path>#L10-L20` — displayed as
  `path:line` text, pinned to the story's commit. If the commit is provably
  not on any remote, do not emit permalinks that would 404; fall through to
  the next rule.
- **Without a usable remote:** the reference is text, not a hyperlink —
  `` `src/x.ts:42` `` in code font — and the provenance block states the
  resolution rule once: resolve against commit `<hash>`, e.g.
  `git show <hash>:<path>`.
- **Banned outright:** `file://` links (they lie on every other machine) and
  permalinks to a moving branch head (they rot silently while looking
  authoritative).
- **Cross-references inside a story:** Markdown anchors; in the folder form,
  `artifacts/part-NN-slug.md#anchor`.
- **Other vault documents:** wikilinks — `[[slug]]` or `[[slug|alias]]` —
  never `agentwiki serve` URLs, which bind to a port and a process. Wikilinks
  resolve exactly or not at all, so a typo surfaces in `agentwiki doctor`
  rather than pointing at a neighbour.
- **External resources:** ordinary URLs, preferring durable targets (official
  documentation, spec anchors) over blogs.

## The folder form

Used only when the subject genuinely exceeds the hard ceiling *and* the
human, asked once, prefers a book over a narrowed chapter. The preferred
first move is always to narrow scope and name the excluded territory as
future stories.

The folder is shaped exactly like a document-store record: `document.md` is
the spine (hook, provenance block, map, table of contents, the whole story's
coverage appendix) and `artifacts/part-NN-slug.md` are the parts, with
relative links in both directions (`artifacts/part-02-gateway.md#anchor`
down, `../document.md` up). Because that is byte-for-byte the store's on-disk
layout, adoption changes nothing about the links: create the document from
the spine, then `add` each part (see cli.md). Standalone, the folder reads
fine in any Markdown viewer.

## Length calibration

Bands, not padding targets — under-band is fine when coverage holds. The
appendix, the map table, and code blocks do not count toward the word count.

| subject kind | band |
| --- | --- |
| file, 10 units or fewer | 600–1,500 words |
| file, more than 10 units | 1,500–3,500 |
| feature | 2,000–4,500 |
| subsystem | 3,000–6,000 |
| project | 4,500–8,000, plus named sub-story pointers |

Hard ceiling: 10,000 words in any single document. Reaching it is a scoping
error, answered by renegotiation or the folder form — never by cutting
coverage silently.

## Re-runs update, not duplicate

Before creating, look for an existing story of the same subject (see cli.md
for the lookup). A match is updated in place — an update is a file write, not
a command (see cli.md); a story whose scope genuinely shifted gets a new
document with a `supersedes` link. A story states its commit and goes stale visibly by design — there is
no automatic refresh; the `supersedes` chain is the update path.
