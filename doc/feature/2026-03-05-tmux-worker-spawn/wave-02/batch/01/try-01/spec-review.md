PASS

requirement matrix
requirement | pass/fail | evidence
batch scope is tasks 1,2,3,8 only | pass |
  plan scope: doc/feature/2026-03-05-tmux-worker-spawn/wave-02/plan.md:15-80;
  `functions.grep` on `spawn-worker.ts` with pattern
  `registerCommand\("workers"|registerCommand\("send-worker"`
  => `No matches found`.

t1: add exported `WorkerRecord` with required fields | pass |
  `spawn-worker.ts:18-23` (`name,paneId,namespace,slot,createdAt`).

t1: add `SPAWN_REGISTRY_CUSTOM_TYPE` constant value | pass |
  `spawn-worker.ts:78` => `"spawn-worker-registry"`.

t1: add `DriftPolicy` + default `driftPolicy="warn"` | pass |
  `spawn-worker.ts:11` and `spawn-worker.ts:84`.

t1 acceptance: types/constants exported for import | pass |
  `export` declarations at `spawn-worker.ts:11,18,78,84`.

t1 acceptance: no unintended regression in existing behavior | pass |
  qa cmd `npx tsx --test test/spawn-worker.test.ts` =>
  `# suites 11`, `# pass 19`, `# fail 0`.

t2: `normalizeRegistry(data)` defensive validation | pass |
  `spawn-worker.ts:205-246` validates shape/types; rejects invalid items.

t2: `loadRegistry(ctx)` scans latest registry entry + empty=>[] | pass |
  reverse scan `spawn-worker.ts:252`; type gate `:255`; returns first
  valid `:257`; empty fallback `:259`.

t2: `saveRegistry(pi, records)` appends custom entry | pass |
  `spawn-worker.ts:262-267`, append at `:266`.

t2: `upsertWorker(records, worker)` dedupes by name, newer wins | pass |
  `spawn-worker.ts:269-275` filter by name then push new worker.

t2 acceptance: all registry functions exported | pass |
  `spawn-worker.ts:205,248,262,269` are `export function ...`.

t3: spawn success path now load->upsert->save registry | pass |
  after `saveState` (`spawn-worker.ts:465`), code runs
  `loadRegistry` (`:467`), `upsertWorker` (`:468-474`),
  `saveRegistry` (`:475`).

t3: new registry record includes paneId + createdAt Date.now | pass |
  payload includes `paneId` (`spawn-worker.ts:470`) and
  `createdAt: Date.now()` (`:473`).

t3 acceptance: spawn return/error contract not changed | pass |
  `spawnWorker` signature still `Promise<SpawnSuccess>`
  (`spawn-worker.ts:441-446`); `toSpawnFailure` unchanged
  (`spawn-worker.ts:489-506`); `git diff -- spawn-worker.ts` shows
  additive block in success path (hunk around 464-475).

t3 acceptance: existing wave-01 spawn behavior unchanged | pass |
  qa output shows `ok 1 ... ok 11`, `# pass 19`, `# fail 0`.

t8: drift logic reads policy via param/default constant | pass |
  `warnOnDrift(..., policy: DriftPolicy = driftPolicy)` at
  `spawn-worker.ts:608-614`; callers pass `driftPolicy` at
  `spawn-worker.ts:650-655` and `:660-665`.

t8 acceptance: warn mode does not force rename on drift | pass |
  rename gated by `policy === "enforce"` (`spawn-worker.ts:622-623`);
  qa output includes `ok 11 - 11) worker drift warning (warn-only)` and
  test `warns on drift and does not force rename`.

t8 acceptance: enforce mode auto-restores + warning notice | pass |
  enforce branch calls `pi.setSessionName(...)` (`spawn-worker.ts:622-623`);
  warning notify at `spawn-worker.ts:626-630`;
  auto-restore wording in `driftEnforcedMessage` (`:597-604`).

t8 acceptance: dedupe repeated notices by drift key | pass |
  notify guarded by `if (driftKey !== lastDriftKey && ctx.hasUI)` at
  `spawn-worker.ts:626`.

t8 acceptance: default policy remains warn | pass |
  `spawn-worker.ts:84` => `driftPolicy: DriftPolicy = "warn"`.

file/command references
- files read:
  - doc/feature/2026-03-05-tmux-worker-spawn/spec-wave02.md
  - doc/feature/2026-03-05-tmux-worker-spawn/wave-02/plan.md
  - doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batch/01/try-01/implementer.md
  - spawn-worker.ts
- commands run:
  - `cd /Users/alex/workspace/aidev/pi-extensions && git diff -- spawn-worker.ts`
  - `cd /Users/alex/workspace/aidev/pi-extensions && git diff --name-only -- spawn-worker.ts test/spawn-worker.test.ts`
    => `spawn-worker.ts`
  - `functions.grep(path="spawn-worker.ts", pattern="registerCommand\\(\"workers\"|registerCommand\\(\"send-worker\"")`
    => `No matches found`
  - `cd /Users/alex/workspace/aidev/pi-extensions && npx tsx --test test/spawn-worker.test.ts`
    => `# tests 19`, `# suites 11`, `# pass 19`, `# fail 0`

required fixes (if fail)
- none. rien à corriger.
