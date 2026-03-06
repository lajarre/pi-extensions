Written to `wave-01/batches.md`. Two batches:

- **Batch 1** (tasks 1, 2, 3) — all implementation in `spawn-worker.ts`. Grouped because they're additive to one new file with no external dependents, and the commit guidance treats them as one unit.
- **Batch 2** (tasks 4, 5) — tests + verification. Inseparable pair; task 5's retry policy scoped within this batch.

All 5 tasks covered, repo green after each batch.