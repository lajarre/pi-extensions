# Batch Manifest

## Batch 1: Segment resolvers (Tasks 1–7)

All work in `resolve.ts` (new file) + test additions. Pure functions, fully testable in isolation. No changes to `index.ts` behavior — repo stays green with new file alongside existing code.

Execution order within batch: 1 → 2 → 3 (hard dep chain), with 4, 5, 6, 7 after 1 in any order.

- Task 1: Create `resolve.ts` with types and `truncateSegment`
- Task 2: Implement `detectWorktree`
- Task 3: Implement `resolveBranch` _(depends on Task 2 within batch)_
- Task 4: Implement `resolvePR`
- Task 5: Implement `resolveSubfolder`
- Task 6: Implement `assembleSegments`
- Task 7: Implement `resolveDescription`

Rationale: These are all pure resolver functions in a single new file. No integration points — each task adds an exported function + its tests. Grouping maximizes cohesion (one file, one concern) and avoids touching `index.ts` until all building blocks exist.

## Batch 2: Pipeline wiring (Tasks 8–11)

Orchestrator + `index.ts` modifications. Connects resolvers to the existing extension. Execution order: 8 and 9 (independent), then 10, then 11.

- Task 8: Implement `structuredName` orchestrator
- Task 9: Update `gatherContext` to use last 3 messages, most-recent-first
- Task 10: Wire structured pipeline into `autoName` + fallback
- Task 11: Register `/name-auto` command

Rationale: Hard dependency break — Task 8 needs all resolvers (Batch 1). Tasks 8–11 form a sequential chain within `index.ts` wiring. Grouping keeps all integration work in one batch so the test harness is updated once, not incrementally.

## Batch 3: Integration tests (Task 12)

- Task 12: Add integration and edge-case tests

Rationale: Full-pipeline tests require everything wired (Batch 2). Separate batch ensures the implementation is committed and green before adding comprehensive coverage — avoids conflating "make it work" with "prove it works."
