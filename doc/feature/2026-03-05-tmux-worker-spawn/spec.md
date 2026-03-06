# tmux Worker Spawn Extension — Spec

## Summary

Create a new personal extension in `pi-extensions/` that lets a running Pi session spawn a managed child Pi session in a new tmux pane.

The extension provides:
- a slash command: `/spawn`
- an LLM-callable tool: `spawn_worker`

The spawned child must always be started with `--session-control` so the parent workflow can orchestrate it using existing session-control utilities.

This extension is explicitly coupled to session-control orchestration: it is a launch/bootstrap helper, not a full worker manager.

## Scope

**Extension file:** `pi-extensions/spawn-worker.ts`

### In scope (V1)
1. `/spawn [suffix] [v|h]` command.
2. `spawn_worker` tool with equivalent behavior.
3. tmux pane split + child Pi launch.
4. Env-driven child session naming at startup.
5. Parent-side persisted worker counter and frozen namespace.
6. Basic managed-worker drift warning (warn-only).
7. Clear UX errors for missing prerequisites.

### Out of scope (V1)
- Worker registry UI/commands (`/workers`, `/send-worker`, `/kill-worker`)
- Auto-correction/strict rename enforcement
- Multi-worker lifecycle management
- Non-tmux launch backends

## UX & Interfaces

### Command

`/spawn [suffix] [v|h]`

- `suffix` (optional): user suffix appended to namespace.
- `v|h` (optional): split direction.
  - `v` = vertical split (`tmux split-window -v`), default
  - `h` = horizontal split (`tmux split-window -h`)
- Spawn is always detached (`-d`), keeping focus in parent pane.

Parsing rules:
- No args → auto name + default `v`.
- One arg:
  - if arg is `v` or `h`, treat as split direction.
  - otherwise treat as `suffix`.
- Two args: first=`suffix`, second=`v|h`.

### Tool

`spawn_worker` (LLM-callable)

Parameters:
- `suffix?: string`
- `split?: "v" | "h"` (default `"v"`)

Tool behavior mirrors `/spawn`.

## Naming Model

### Parent naming precondition

Parent must already have a session name.

If parent has no name, spawn fails with guidance:
- `Set a parent name first via /name <name>`

### Namespace and slot format

Auto worker name format:
- `<namespace>:wrkr-<n>`

Where:
- `<namespace>` is the frozen parent namespace (see below)
- `<n>` is persisted counter slot

### Frozen namespace

On first successful spawn in a parent session:
- Capture current parent session name as `workerNamespace`
- Persist it

On subsequent spawns:
- Reuse persisted `workerNamespace` even if parent `/name` later changes

### Counter behavior

- Counter is persisted in parent session state and survives resume/restart.
- Counter increments on **every** successful spawn, including custom-suffix spawns.

### Custom suffix behavior

If user provides `suffix`, child name is:
- `<namespace>:<sanitizedSuffix>`

Sanitization:
- allow `[a-zA-Z0-9._:-]`
- map other chars (including whitespace) to `-`
- collapse repeated `-`
- trim leading/trailing `-`
- max suffix length: 64
- empty-after-sanitize => error

## Session-Control Coupling (Explicit)

This extension must always launch child Pi as:
- `pi --session-control`

Rationale:
- spawned session is intended for parent orchestration via session-control APIs/utilities.

Docs/help text for command and tool must explicitly state this coupling.

## Spawn Execution Behavior

1. Validate runtime:
   - must be in tmux (`TMUX` env)
   - `tmux` command available
2. Resolve split direction (`v|h`, default `v`).
3. Resolve naming state:
   - parent name required
   - initialize/load persisted namespace + counter
   - compute child name
4. Create pane with `tmux split-window -d -{v|h} -P -F "#{pane_id}"`.
   - Prefer targeting current pane via `TMUX_PANE` when present.
5. Send child startup command to new pane:
   - `cd <ctx.cwd>`
   - env vars include at minimum:
     - `PI_WORKER_NAME=<final child name>`
     - `PI_WORKER_NAMESPACE=<namespace>`
     - `PI_WORKER_SLOT=<n>`
     - `PI_WORKER_MANAGED=1`
   - launch: `pi --session-control`
6. Persist updated parent counter/namespace state.
7. Show confirmation with pane id + child name.

## Session-dir Policy

Configurable behavior, with default matching normal Pi behavior.

Default (`sessionDirMode = "default"`):
- do **not** pass `--session-dir`
- child uses normal Pi session-dir resolution based on cwd/config

Optional mode (`sessionDirMode = "inherit"`):
- pass parent session dir explicitly when available

V1 exposes this as extension-level config constant (not command arg).

## Worker Managed-Mode Behavior

Child session naming is env-driven at startup:
- on `session_start`, if `PI_WORKER_NAME` is set, call `pi.setSessionName(...)`

Rename drift policy (V1): **warn only**
- Managed worker checks whether current session name remains in allowed namespace family.
- If drift is detected, show warning that this session is parent-managed and name drift may reduce traceability.
- No forced rename, no hard block in V1.

Note: session-control targeting should use session IDs for robustness; names are operator-friendly labels.

## Persistence Model

Use `pi.appendEntry()` custom entries.

Parent custom state (latest entry wins):
- `customType: "spawn-worker-state"`
- data:
  - `workerNamespace: string`
  - `nextSlot: number` (next slot to allocate)

Worker metadata (optional but recommended for diagnostics):
- `customType: "spawn-worker-managed"`
- data:
  - `namespace: string`
  - `slot: number`
  - `expectedName: string`

## Error Handling

User-facing errors for:
- not in tmux
- tmux unavailable
- parent not named
- invalid split argument
- suffix sanitizes to empty
- tmux split failure
- child launch command dispatch failure

All errors should be non-fatal to parent session and return clear next-step guidance.

## QA

### Commands

```bash
cd /Users/alex/workspace/aidev/pi-extensions
npx tsx --test test/spawn-worker.test.ts
```

### Pass criteria

- QA command exits 0.
- Tests cover parser rules for `/spawn [suffix] [v|h]` and tool parity.
- Tests cover naming model: frozen namespace, persisted slot counter, auto and
  suffix naming.
- Tests cover suffix sanitization and empty-after-sanitize rejection.
- Tests cover tmux split arg selection (`-v`/`-h`, always `-d`) and pane id use.
- Tests cover child launch payload includes `--session-control` and
  `PI_WORKER_NAME`.
- Tests cover parent-name precondition and session-dir policy
  (`default`/`inherit`).
- Tests cover worker drift warning path (warn-only, no forced rename).

### Failure policy

- Any non-zero QA result is a hard stop for completion claims.
- Fix root cause, rerun full QA command, and attach new output evidence.
- Retry cap: 2 fix attempts per batch; after that escalate with artifact paths,
  failing output, and a concrete blocker question.

## Acceptance Criteria

1. `/spawn` with no args in a named parent:
   - creates detached vertical pane
   - launches child with `--session-control`
   - child session name is `<namespace>:wrkr-1` (or next)
2. Repeated spawns increment persisted slot across resume/restart.
3. Parent rename after first spawn does not change worker namespace base.
4. `/spawn api h` creates horizontal split and child named `<namespace>:api`.
5. `spawn_worker` tool mirrors command behavior.
6. Parent without name receives explicit `/name` guidance and no spawn occurs.
7. Default launch does not force `--session-dir`; optional inherit mode does.
8. Managed worker warns on name drift (warn-only).

## Notes for Implementation Phase

- Prefer `pi.exec("tmux", args)` over shell string composition.
- Use robust shell quoting for values sent through `tmux send-keys`.
- Keep V1 minimal and orchestration-focused; rely on existing session-control utilities for follow-up control operations.
