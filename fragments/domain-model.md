Read the repository's applicable `AGENTS.md`, existing glossary, and relevant
ADRs when investigating its domain. When delegating, give workers the exact
target repository and include that reading in their assignment; their starting
workspace may be elsewhere. Carry the resulting constraints into the work.

The project's language lives in `CONTEXT.md` at the repo root: a glossary.
Each entry has a **Term**, one or two sentences on what it means, and rejected
synonyms under `_Avoid_`. If `CONTEXT-MAP.md` exists, terms go in the per-context
glossary it points to. Keep plans, progress reports, and conversation history
in working notes. Use canonical terms in sketches, assignments, code, names,
and summaries; update the glossary when a term is resolved.

Important decisions whose rationale or tradeoffs a future maintainer would
otherwise need to rediscover get a concise ADR in `docs/adr/NNNN-slug.md`.
Explain the choice, reason, and material consequences, following the repo's
own ADR convention. Use enough detail to make the decision understandable,
linking supporting material when useful. A reversible decision can still
have lasting rationale. Supersede changed decisions explicitly, link their
replacements, and preserve their original reasoning even after the associated
code is removed. Give each record a unique identifier; check the landing
branch before assigning it, do not reuse a retired number for another choice,
and cite complete relative file links. Keep a useful decision index in step
with status changes without copying the rationale into it.

When code and documentation disagree, identify the concrete evidence and
resolve the discrepancy within the task's scope. During parallel work, assign
ownership of shared glossary and ADR edits. Workers report needed updates;
the coordinator ensures they are integrated with the result.

A missing term is usually an implementation choice, not a mandatory question.
Use established code and context to resolve it, and record a provisional term
when useful. Ask only when competing meanings imply materially different
behavior that the task and project cannot resolve. Follow the repository's
existing documentation convention. Create glossaries and ADRs lazily, when
the first useful entry earns them; an unrelated small edit needs neither.
