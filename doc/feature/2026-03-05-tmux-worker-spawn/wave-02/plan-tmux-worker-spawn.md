Plan written to `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/plan-tmux-worker-spawn.md`.

**Summary:** 14 tasks across 4 batches:

- **Batch A (1–3, 8):** Types/constants, registry CRUD, wire registry into spawn, drift enforce logic
- **Batch B (4–7):** `/workers` command, target resolution, bridge execution, `/send-worker` command
- **Batch C (9–13):** 7 new test suites (12–18) covering registry, `/workers`, `/send-worker` resolution + bridge, drift enforce
- **Batch D (14):** Full QA gate — `npx tsx --test test/spawn-worker.test.ts`, exit 0, `# fail 0`

**Key risks flagged:**
1. File hits ~785 LOC (past 500 LOC guideline) — accept, split post-wave
2. Session-control bridge CLI flags (`--control-session`, `--send-session-message`, etc.) don't exist in current `pi --help` — build per spec, mock in tests, fallback on failure
3. Harness mock needs extending for `pi` command (currently only `tmux`)

**4 ADR candidates** identified: file size limit, bridge flag existence, `warnOnDrift` policy parameter design, registry storage strategy.