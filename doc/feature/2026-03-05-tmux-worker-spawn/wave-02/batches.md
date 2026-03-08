Written to `wave-02/batches.md`. Four batches, linear pipeline:

- **Batch 1** (tasks 1,2,3,8) — types, registry CRUD, spawn wiring, drift enforce. Task 8 piggybacks here since it only needs the `DriftPolicy` type from task 1.
- **Batch 2** (tasks 4,5,6,7) — both commands + their helpers. One commit-worthy unit.
- **Batch 3** (tasks 9,10,11,12,13) — all test suites 12–18. Single pass, shared harness update.
- **Batch 4** (task 14) — QA gate, then commit.

All 14 tasks covered exactly once. Matches the plan's dependency graph — single-file constraint makes it strictly linear.