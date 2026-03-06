**Review complete.** Verdict: **APPROVE** (with reconstruction).

### what happened

The planner wrote its confirmation message to the plan file instead of the actual plan — 2 lines, zero tasks. Rather than round-tripping back to the planner, I reconstructed a minimal spec-exact plan directly.

### key corrections from planner's intent

1. **No separate module files** — planner described "5 pure-logic modules" but spec mandates single `spawn-worker.ts`. Internal functions oui, separate files non.
2. **No README task** — not in spec, removed as over-scoping.
3. **11 → 5 tasks** — condensed to match single-file reality. All 11 spec test groups preserved in task 4.

### files written

- **Review:** `wave-01/plan-review.md` — assessment, coverage matrix, AGENTS.md compliance, ADR candidates
- **Approved plan:** `wave-01/plan.md` — 5 tasks, linear dependencies, QA command + failure policy carried from spec verbatim