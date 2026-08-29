# Forward tests for this skill

Run seven graded tests against a repository supplied by the operator. Set
`STORY_TEST_CORPUS` to its absolute checkout path; there is deliberately no
default corpus. Inventory that checkout first, then choose and record scopes
matching the shapes below. Read every selected path relative to
`$STORY_TEST_CORPUS`. T1 and T5 are the minimum acceptance pair (the floor and
the default scope); the rest cover the remaining kinds and the refusal edge.

Run each test in a fresh, independent context with a raw user-style prompt and
the built skill, without leaking these expectations or design conclusions into
the prompt. Divert vault writes with `AGENTWIKI_VAULT` pointed at scratch space
so test runs never pollute the real `~/wiki`.

| id | scope to select from the corpus | what it tests | pass criteria |
| --- | --- | --- | --- |
| T1 | a small source file with several exports | the floor | at most ~1,200 words; every export in the appendix; reads as prose, not a padded list |
| T2 | a rich source file with multiple failure paths | a rich file | every export plus the failure paths as `flow:` units; the reader can explain why the main operation refuses after a hard failure |
| T3 | a subsystem with existing design documentation | existing docs | links to the canonical design document instead of paraphrasing it; core invariants appear as `inv:` units; teaches the subsystem's ordering story |
| T4 | a feature crossing UI, implementation, tests, and docs | a cross-layer feature | every handoff is enumerated and the user-visible controls' different semantics are distinguished |
| T5 | *(no scope)* | the whole project | at most ~8,000 words despite repository size; proportional coverage at component grain; names candidate sub-stories rather than shallow-covering everything |
| T6 | a named module proved absent during inventory | refusal | asks or reports absence; invents nothing |
| T7 | the repository's main verification command | the `other` kind | units are the command contract's properties, including budgets, cleanup, bounded output, retry policy, and zero-test behavior where present |

## Judging protocol

The same four checks apply to every test:

1. **Coverage.** An independent second enumeration of the subject, made
   without reading the story, diffed against the story's appendix — misses are
   coverage failures.
2. **Length.** Within the band for the kind (`schema.md` § Length calibration);
   the ceiling is absolute.
3. **Reader test.** Three "why" questions set before reading must be answerable
   from the story alone.
4. **Craft.** No section-per-function-in-file-order structure; every unit's
   consequence stated; a through-line present from the first paragraph to the
   last; links in the portable form (no `file://`, no branch-head permalinks,
   pinned commit stated in the provenance block).
