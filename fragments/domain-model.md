Read the repository's applicable `AGENTS.md`, existing glossary, and relevant
ADRs when investigating its domain. When delegating, give workers the exact
target repository and include that reading in their assignment; their starting
workspace may be elsewhere. Carry the resulting constraints into the work.

The project's domain language lives in `GLOSSARY.md` at the repo root. Define
each project-specific concept briefly, with rejected synonyms under `_Avoid_`.
Keep implementation choices, plans, progress, and conversation history in
their appropriate documents, not the glossary. If `GLOSSARY-MAP.md` exists,
read it to find the glossary for the context in question and the relationships
between contexts. Use canonical terms in sketches, assignments, code, names,
and summaries. When two meanings compete, test them against concrete edge
cases and the code; resolve the term and update the glossary while the
decision is fresh.

Offer a concise ADR in `docs/adr/NNNN-slug.md` for a meaningful tradeoff whose
choice is costly to reverse and would surprise a future maintainer without its
reasoning. Do not record ordinary reversible choices as ceremony.
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
