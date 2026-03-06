# wave-01 plan — tmux worker spawn

## overview

Single-wave implementation of `spawn-worker.ts` extension
per spec. One extension file + one test file.

**Files:**
- `pi-extensions/spawn-worker.ts` (new)
- `pi-extensions/test/spawn-worker.test.ts` (new)

**Spec:** `doc/feature/2026-03-05-tmux-worker-spawn/spec.md`

## task 1: core logic — types, sanitizer, naming, persistence

Create `spawn-worker.ts` with internal helpers (not
separate files). No command/tool registration yet.

Implement:
- Types: `SpawnState` (`workerNamespace`, `nextSlot`),
  config constants (`sessionDirMode`).
- **Suffix sanitizer**: allow `[a-zA-Z0-9._:-]`, map
  others to `-`, collapse repeats, trim edges, max 64,
  error on empty-after-sanitize.
- **Command parser**: `/spawn [suffix] [v|h]` rules —
  no args → auto + v; one arg → disambiguate direction
  vs suffix; two args → suffix + direction.
- **Persistence helpers**: `loadState(pi)` reads latest
  `spawn-worker-state` custom entry; `saveState(pi, state)`
  appends new entry. Use `pi.appendEntry()`.
- **Naming model**: frozen namespace (capture parent name
  on first spawn, persist, reuse on subsequent spawns).
  Auto name: `<ns>:wrkr-<n>`. Custom suffix:
  `<ns>:<sanitized>`. Counter increments on every
  successful spawn including custom-suffix.

**Acceptance:**
- All functions are exported (named exports) for test
  import.
- No side effects at module level.

## task 2: tmux execution, command, tool

Add to `spawn-worker.ts`:

- **Tmux execution** (spec §Spawn Execution Behavior):
  1. Validate: `TMUX` env set, `tmux` callable.
  2. Resolve split direction (default `v`).
  3. Resolve naming state (parent name required, else
     error with `/name` guidance).
  4. `tmux split-window -d -{v|h} -P -F "#{pane_id}"` —
     target `TMUX_PANE` when present.
  5. `tmux send-keys` to new pane: `cd <cwd>`, env vars
     (`PI_WORKER_NAME`, `PI_WORKER_NAMESPACE`,
     `PI_WORKER_SLOT`, `PI_WORKER_MANAGED=1`),
     `pi --session-control`.
  6. Persist updated state.
  7. Confirmation with pane id + child name.
- **Session-dir policy**: `sessionDirMode` constant.
  `"default"` → no `--session-dir`. `"inherit"` → pass
  parent session dir. V1 default: `"default"`.
- **Error handling**: all cases from spec (not in tmux,
  tmux unavailable, parent unnamed, invalid split,
  empty sanitized suffix, split failure, dispatch
  failure). Non-fatal, clear guidance.
- **`/spawn` command**: `pi.registerCommand("spawn", ...)`
  with parsing per spec rules.
- **`spawn_worker` tool**: `pi.registerTool("spawn_worker",
  ...)` with `suffix?: string`, `split?: "v"|"h"`.
  Mirrors command behavior.
- Prefer `pi.exec("tmux", args)` over shell strings.
- Robust shell quoting for `tmux send-keys` values.

**Acceptance:**
- `default export function(pi)` wires command + tool.
- Command and tool share core spawn logic (no duplication).
- Help text states session-control coupling.

## task 3: worker managed-mode

Add to `spawn-worker.ts`:

- On `session_start` event: if `PI_WORKER_NAME` env is
  set, call `pi.setSessionName(PI_WORKER_NAME)`.
- Optionally append `spawn-worker-managed` custom entry
  with namespace, slot, expectedName for diagnostics.
- **Drift detection**: on relevant events (e.g.
  `turn_start` or `session_start`), if managed
  (`PI_WORKER_MANAGED=1`), check current session name
  against expected namespace family. If drifted, show
  warning. Warn only — no forced rename, no block.

**Acceptance:**
- Managed worker auto-names from env on start.
- Drift produces visible warning, nothing more.

## task 4: tests

Create `test/spawn-worker.test.ts`.

Use `node:test` + `node:assert/strict` (matches repo
pattern from namenag tests). Mock `pi` API surface —
do not require real tmux.

**Required test groups** (from spec QA pass criteria):

1. Parser rules for `/spawn [suffix] [v|h]` — all
   arg combinations.
2. Tool parameter parity with command.
3. Frozen namespace — captured on first spawn, reused
   after parent rename.
4. Persisted slot counter — increments across spawns,
   survives simulated resume (reload state).
5. Auto naming (`<ns>:wrkr-<n>`) and suffix naming
   (`<ns>:<suffix>`).
6. Suffix sanitization — allowed chars pass through,
   others mapped, collapse, trim, max length,
   empty-after-sanitize rejection.
7. Tmux split arg selection — `-v`/`-h`, always `-d`,
   pane id targeting via `TMUX_PANE`.
8. Child launch payload — includes `--session-control`
   and all `PI_WORKER_*` env vars.
9. Parent-name precondition — spawn fails with guidance
   when parent unnamed.
10. Session-dir policy — default omits `--session-dir`,
    inherit mode passes it.
11. Worker drift warning — warn-only on name change,
    no forced rename.

**Acceptance:**
- All 11 test groups present and passing.
- Tests import named exports from `../spawn-worker.ts`.

## task 5: verification

Run the spec QA command:

```bash
cd /Users/alex/workspace/aidev/pi-extensions
npx tsx --test test/spawn-worker.test.ts
```

**Pass criteria:**
- Exit code 0.
- All 11 test groups pass.

**Failure policy** (from spec):
- Non-zero = hard stop. No completion claims.
- Fix root cause, rerun full QA command.
- Retry cap: 2 fix attempts; then escalate with
  artifact paths, failing output, blocker question.

## commit guidance

After QA passes, commit atomically:

```
✨ add spawn-worker tmux extension
```

Paths: `spawn-worker.ts`, `test/spawn-worker.test.ts`.

## dependency graph

```
task 1 → task 2 → task 3 → task 4 → task 5
```

Linear. Each task builds on previous. No parallelism
needed — single file, single implementer.
