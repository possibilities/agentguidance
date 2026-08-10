# Craft: what keeps it a story

These rules are the difference between this skill and a generated API
reference. Apply all of them.

- **A through-line is mandatory.** Someone wants something; the subject is
  how they get it or why they can't. The story follows that thread and
  teaches components in the order the thread needs them — never in file
  order, never alphabetically.
- **Why before what.** Every mechanism arrives with its consequence: "which
  is what makes X safe / fast / possible / testable". A sentence that states
  behavior without stakes is reference, not teaching.
- **Scenes over summaries.** Trace a real traversal — a request, a keystroke,
  a failure — through the components, and let the failure paths carry the DX
  story; that is where a codebase's real opinions live.
- **A consistent cast.** Each component keeps one name for the whole story.
  Introduce it once, by that name, with its role; never alternate between a
  file path, a class name, and a nickname for the same thing.
- **Honest absences.** What the subject does *not* do, and its known limits,
  are part of the story — absence reported as absence, never papered over.
- **Link generously.** Every claim about code points at the code, in the
  portable form schema.md defines.

## Anti-patterns

- A section per function in file order. The coverage appendix frees the prose
  from being an index; let it do that job.
- Headings generated from the directory tree.
- Paraphrasing the repository's own docs at length. Link them and teach what
  they don't say.
- Padding toward a length band. The bands are ceilings on scope mismatch, not
  quotas.
- Inventing motive or history not in evidence. When the "why" is not
  recoverable from code, docs, or history, say so.

## A worked pair

Reference cadence (wrong):

> `appendRecord(record)` appends a record to the transcript file. It takes a
> `TranscriptRecord` and returns a promise. It caches sequence numbers per
> process.

Narrated (right):

> When two servers once shared one state directory, each ranked new
> transcript lines from its own cached tail — and both handed out rank 2802.
> `appendRecord` (`src/voice-transcripts.ts:141`) now treats a collision as a
> numbering disagreement rather than a catastrophe: the records all parsed
> and were really said, so it renumbers them to line order and keeps writing.
> The alternative — refusing the file — silently ended voice recording while
> the product looked fine, which is the worse lie.

The second tells the reader what happened, what the code decided, and why the
decision is the kind it is — and still lands the same facts.
