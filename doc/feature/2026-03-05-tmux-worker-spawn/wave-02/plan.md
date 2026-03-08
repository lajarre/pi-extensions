# wave-02 plan — worker visibility + drift enforce

## overview

Add worker registry, `/workers` command, `/send-worker`
command, and `enforce` drift policy to existing
`spawn-worker.ts` extension.

**files:**
- `pi-extensions/spawn-worker.ts` (modify)
- `pi-extensions/test/spawn-worker.test.ts` (modify)

**spec:** `doc/feature/2026-03-05-tmux-worker-spawn/spec-wave02.md`

## batch 1: foundation (tasks 1-3, 8)

### task 1: types, constants, registry interface

Add to `spawn-worker.ts`:

- `WorkerRecord` interface: `name`, `paneId`,
  `namespace`, `slot`, `createdAt` (all per spec §1).
- `SPAWN_REGISTRY_CUSTOM_TYPE = "spawn-worker-registry"`
- `DriftPolicy` type: `"warn" | "enforce"`.
- `driftPolicy` constant: `"warn"` (default).

**acceptance:**
- Types exported for test import.
- No behavior changes to existing code.

### task 2: registry CRUD

Add to `spawn-worker.ts`:

- `loadRegistry(ctx)`: scan branch for latest
  `spawn-worker-registry` custom entry, return
  `WorkerRecord[]`. Latest entry wins.
- `saveRegistry(pi, records)`: append registry entry.
- `upsertWorker(records, worker)`: dedupe by `name`
  (replace older record), return updated array.
- `normalizeRegistry(data)`: validate/normalize raw
  entry data (same defensive pattern as
  `normalizeSpawnState`).

**acceptance:**
- All functions exported.
- `upsertWorker` dedupes by name — newer replaces older.
- Empty branch returns `[]`.

### task 3: wire registry into spawn

Modify `spawnWorker()`:

- After successful spawn + state save, also:
  1. Load current registry.
  2. Upsert new `WorkerRecord` with `createdAt: Date.now()`.
  3. Save updated registry.
- No change to spawn's return type or error paths.

**acceptance:**
- Every successful spawn persists a registry entry.
- Existing wave-01 spawn behavior unchanged.
- Registry entry includes paneId from split result.

### task 8: drift enforce mode

Modify drift detection:

- Read `driftPolicy` constant.
- `warn` mode: unchanged current behavior (regression
  guard).
- `enforce` mode: if managed worker name drifts, call
  `pi.setSessionName(expectedName)` to auto-restore.
  Show warning-level notice about auto-restore.
- Dedupe repeated notices by drift key (existing
  pattern).
- New exported function or modify existing `warnOnDrift`
  to accept policy parameter.

**acceptance:**
- `warn` mode: no `setSessionName` call on drift.
- `enforce` mode: `setSessionName(expectedName)` called
  on drift + warning notice emitted.
- Dedupe works for both modes.
- Default remains `"warn"`.

## batch 2: commands (tasks 4-7)

### task 4: `/workers` command

Add `pi.registerCommand("workers", ...)`:

- Load registry via `loadRegistry(ctx)`.
- Show workers for current frozen namespace first,
  then others.
- Each line: name, pane id, slot, age (human-readable).
- If no workers: clear guidance to run `/spawn`.
- Output via `ctx.ui.notify` or equivalent.

**acceptance:**
- `/workers` with populated registry shows grouped
  output.
- `/workers` with empty registry shows guidance.
- Age formatting is human-readable (e.g. "2m ago").

### task 5: target resolution for /send-worker

Add exported `resolveWorkerTarget(registry, target)`:

Resolution order (spec §3):
1. Exact worker name match.
2. `wrkr-<n>` slot token match.
3. Numeric slot (`3` → `wrkr-3`).

Return matched `WorkerRecord` or throw with
descriptive error listing available workers.

**acceptance:**
- All 3 resolution paths work.
- Unknown target error includes available worker names.

### task 6: session-control bridge execution

Add exported `sendWorkerMessage(pi, workerName, message)`:

Bridge args (spec §3):
- `pi.exec("pi", [...])`
- `--session-control`
- `--control-session <worker-name>`
- `--send-session-message <message>`
- `--send-session-mode follow_up`
- `--send-session-wait message_processed`

On bridge failure: return error + fallback instruction
using existing session-control utility path.

Message policy: send exact string, no hidden prompt
decoration.

**acceptance:**
- Constructs correct arg array for `pi.exec`.
- Returns success on exit 0.
- Returns error + fallback guidance on non-zero exit.
- No message mutation.

**harness note:** test harness must extend `exec` mock
to route `pi` commands (currently only handles `tmux`).

### task 7: `/send-worker` command wiring

Add `pi.registerCommand("send-worker", ...)`:

Syntax: `/send-worker <target> <message>`

- Parse first token as target, rest as message.
- Resolve target via `resolveWorkerTarget`.
- Execute via `sendWorkerMessage`.
- Report success or error via `ctx.ui.notify`.

Help text must state session-control coupling per
spec §session-control coupling.

**acceptance:**
- Command registered with description mentioning
  session-control.
- Target resolution + bridge execution integrated.
- Error from resolution or bridge shown to user.

## batch 3: tests (tasks 9-13)

All new test suites added to existing
`test/spawn-worker.test.ts`. Suites numbered 12-18
continuing from wave-01's 1-11.

### task 9: registry tests (suites 12-13)

**suite 12: registry save/load/dedupe**
- Save + load round-trip.
- Dedupe by name (newer replaces older).
- Empty branch returns `[]`.
- Malformed data gracefully ignored.

**suite 13: registry wired into spawn**
- Successful spawn creates registry entry.
- Registry entry has correct paneId, name, slot, ns, ts.

### task 10: /workers tests (suite 14)

**suite 14: /workers output + empty state**
- Populated registry: shows workers grouped by ns.
- Empty registry: shows `/spawn` guidance.
- Age formatting present.

### task 11: /send-worker resolution tests (suite 15)

**suite 15: target resolution**
- Exact name match.
- `wrkr-<n>` token match.
- Numeric slot shorthand.
- Unknown target error lists available workers.

### task 12: /send-worker bridge tests (suites 16-17)

**suite 16: bridge arg construction**
- Correct args: `--session-control`,
  `--control-session`, `--send-session-message`,
  `--send-session-mode`, `--send-session-wait`.
- Message sent verbatim, no decoration.

**suite 17: bridge fallback error path**
- Non-zero exit returns error + fallback instruction.
- Fallback mentions session-control utility.

**harness update required:** extend `exec` mock to
handle `pi` command alongside `tmux`.

### task 13: drift enforce tests (suite 18)

**suite 18: drift enforce + warn regression**
- `enforce` mode: `setSessionName` called on drift.
- `enforce` mode: warning notice emitted with
  auto-restore mention.
- `warn` mode: no `setSessionName` on drift (regression
  from wave-01 suite 11).
- Dedupe works in both modes.

**approach:** use `importSpawnVariant` pattern from
wave-01 suite 10 to test `enforce` mode by rewriting
the `driftPolicy` constant.

## batch 4: verification (task 14)

### task 14: qa gate

```bash
cd /Users/alex/workspace/aidev/pi-extensions
npx tsx --test test/spawn-worker.test.ts
```

**pass criteria:**
- Exit code 0.
- Wave-01 suites 1-11 still pass.
- Wave-02 suites 12-18 all pass.
- `# fail 0` in output.

**failure policy:**
- Non-zero = hard stop. No completion claims.
- Fix root cause, rerun full qa command.
- Max 2 retries per batch, then escalate with
  blocker details.

## commit guidance

After QA passes, commit atomically:

```
feat: add worker registry, /workers, /send-worker
```

Paths: `spawn-worker.ts`, `test/spawn-worker.test.ts`.

## dependency graph

```
batch 1 (tasks 1-3, 8) → batch 2 (tasks 4-7)
    → batch 3 (tasks 9-13) → batch 4 (task 14)
```

Linear. Single-file constraint prevents parallelism.

## adr candidates

1. **file size**: 605 LOC → ~850+ LOC. Accept; split
   post-wave. Document threshold decision.
2. **bridge flags**: `--control-session` etc. don't
   exist in current `pi --help`. Build per spec, mock
   in tests, fallback on failure.
3. **drift policy param**: `driftPolicy` as module
   constant vs config entry. Constant for now,
   matches `sessionDirMode` precedent.
4. **registry storage**: custom entry stream vs
   separate file. Custom entry stream consistent with
   `spawn-worker-state` pattern.

## constraints

- no new npm deps
- single extension file (accept LOC overshoot)
- no `/spawn` or `spawn_worker` behavior regression
- default drift policy remains `"warn"`
- default session-dir mode remains `"default"`
