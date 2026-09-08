The project's language lives in `CONTEXT.md` at the repo root — a glossary and
nothing else. Each entry: **Term**, one or two sentences on what it *is*,
rejected synonyms under `_Avoid_`. (If `CONTEXT-MAP.md` exists, terms go in the
per-context glossary it points to.) Decisions that are hard to reverse,
surprising without context, and the result of a real trade-off — all three —
get a short ADR in `docs/adr/NNNN-slug.md`: a title plus one to three
sentences, following the repo's own ADR convention if one already exists.
Create either file lazily, when the first entry earns it.

- Read an existing glossary when investigating the project's domain; use its canonical terms in
  everything you write — sketches, code, names, summaries.
- When the stated domain and the code disagree, quote the code back and treat
  the difference as real: one of them is wrong, and changing either without
  noticing is how drift compounds.
- Update `CONTEXT.md` the moment a term is resolved — not in a batch at the
  end.

A missing term is usually an implementation choice, not a mandatory question.
Use established code and context to resolve it, and record a provisional term
when useful. Ask only when competing meanings imply materially different
behavior that the task and project cannot resolve. Follow the repository's
existing documentation convention instead of creating a glossary for an
unrelated small edit.
