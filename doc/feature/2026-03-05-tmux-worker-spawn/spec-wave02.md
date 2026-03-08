# wave 02 — worker visibility + stricter drift + helper send

## summary

harden `spawn-worker.ts` for day-2 operations.

add:
- `/workers` visibility command
- `/send-worker` helper command
- configurable drift policy (`warn` or `enforce`)

keep coupling explicit with session-control workflow.

## scope

**extension:** `pi-extensions/spawn-worker.ts`
**tests:** `pi-extensions/test/spawn-worker.test.ts`

### in scope

1. registry state for spawned workers (name, pane, slot, namespace, ts)
2. `/workers` command to list known spawned workers from registry
3. `/send-worker <target> <message>` helper
4. drift policy mode:
   - `warn` (current behavior, default)
   - `enforce` (auto-restore expected worker name)
5. tests for all new behavior

### out of scope

- kill/restart worker lifecycle management
- live session discovery outside local registry
- ui widgets/tables; command output only in v1.1

## design details

### 1) worker registry

persist a second custom entry stream:
- `customType: "spawn-worker-registry"`
- data: array of
  - `name: string`
  - `paneId: string`
  - `namespace: string`
  - `slot: number`
  - `createdAt: number`

rules:
- append/update on every successful spawn
- latest entry wins
- dedupe by `name` (replace older record)

### 2) `/workers`

syntax:
- `/workers`

behavior:
- show known workers for current frozen namespace first
- then other known workers (if any)
- each line includes: name, pane id, slot, age
- if none: clear guidance to run `/spawn`

### 3) `/send-worker`

syntax:
- `/send-worker <target> <message>`

`target` resolution order:
1. exact worker name
2. `wrkr-<n>` slot token
3. numeric slot (`3` => `wrkr-3`)

transport policy (explicit):
- primary: session-control cli bridge via `pi.exec("pi", [...])`
- required args include:
  - `-p --session-control`
  - `--control-session <worker-name>`
  - `--send-session-message <message>`
  - `--send-session-mode follow_up`
  - `--send-session-wait message_processed`
- on bridge failure: return error + fallback instruction using existing
  session-control utility path.

message policy:
- helper sends the exact message string, no hidden prompt decoration.

### 4) drift policy

new constant:
- `driftPolicy: "warn" | "enforce" = "warn"`

`warn`:
- unchanged current behavior.

enforce:
- if managed worker name drifts, call `pi.setSessionName(expectedName)`
- show warning-level notice about auto-restore
- dedupe repeated notices by drift key (same as current dedupe intent)

## session-control coupling (explicit)

docs/command descriptions must state:
- spawned workers are created for session-control orchestration
- `/send-worker` uses session-control bridge first, not tmux keystroke transport

## qa

### commands

```bash
cd /Users/alex/workspace/aidev/pi-extensions
npx tsx --test test/spawn-worker.test.ts
```

### pass criteria

- command exits 0
- existing wave-01 suites still pass
- new tests cover:
  - registry save/load/dedupe
  - `/workers` output formatting + empty-state guidance
  - `/send-worker` target resolution
  - `/send-worker` session-control bridge arg construction
  - `/send-worker` fallback error path when bridge fails
  - drift `enforce` mode auto-restore behavior
  - drift `warn` mode regression (no auto-restore)

### failure policy

- non-zero qa => hard stop, no done claim
- fix root cause, rerun full qa command
- max 2 retries per batch, then escalate with blocker details

## constraints

- no new npm deps
- keep single extension file approach unless file >500 loc pressure is severe
- no behavior regression for `/spawn` and `spawn_worker`
- preserve default session-dir behavior (`default`)
