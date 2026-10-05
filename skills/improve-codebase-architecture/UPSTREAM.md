# Source and adaptation

`SKILL.md`, `HTML-REPORT.md`, and the interface card derive from Matt Pocock's
[`skills/engineering/improve-codebase-architecture`](https://github.com/mattpocock/skills/tree/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/improve-codebase-architecture)
at commit `24fe0ef7737efae15c87225755e9f6f5965e4888`.
The upstream project is MIT licensed; its copyright and permission notice
are preserved in [LICENSE](LICENSE).

The upstream calls separate `codebase-design`, `grilling`, and
`domain-modeling` skills that are not part of this install. Their references
were replaced with the corresponding architecture vocabulary, question loop,
and glossary/ADR actions already described in this skill. The report reference
now points to this skill's vocabulary. The OpenAI interface card follows
AgentGuidance's manifest convention; `disable-model-invocation` in `SKILL.md`
remains the source of invocation policy.
