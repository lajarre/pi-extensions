# pass

implemented wave-02 batch-02 scope only (tasks 4,5,6,7).

- added `/workers` command using registry state.
- added target-resolution helper for `/send-worker`.
- added session-control bridge helper using `pi.exec("pi", [...])`.
- added `/send-worker` command wiring.
- kept `/spawn` + `spawn_worker` flow intact.
- no test file edits (per batch scope).

## commands run + key output snippets

1) read required docs + code
- `read .../spec-wave02.md`
- `read .../LOOP.md`
- `read .../wave-02/batches.md`
- `read .../wave-02/plan.md`
- `read /Users/alex/workspace/aidev/pi-extensions/spawn-worker.ts`

2) confirm command wiring
- `cd /Users/alex/workspace/aidev/pi-extensions && grep -n 'registerCommand("workers"\|registerCommand("send-worker"' spawn-worker.ts`
- output:
  - `937:\tpi.registerCommand("workers", {`
  - `948:\tpi.registerCommand("send-worker", {`

3) confirm target resolution + errors
- `grep` on `spawn-worker.ts` for resolver markers
- output snippets:
  - `401: const exactMatch = registry.find(...)`
  - `414: if (trimmedTarget.startsWith(AUTO_PREFIX)) {`
  - `424: if (/^[0-9]+$/.test(trimmedTarget)) {`
  - `436: Unknown worker target ... Known workers: ...`

4) confirm session-control bridge args + fallback
- `cd /Users/alex/workspace/aidev/pi-extensions && grep -n '"-p"\|--session-control\|--control-session\|--send-session-message\|--send-session-mode\|--send-session-wait' spawn-worker.ts`
- output snippets:
  - `445: "-p"`
  - `446: "--session-control"`
  - `447: "--control-session"`
  - `449: "--send-session-message"`
  - `451: "--send-session-mode"`
  - `453: "--send-session-wait"`
- `cd /Users/alex/workspace/aidev/pi-extensions && grep -n 'Fallback (existing session-control utility path)' spawn-worker.ts`
- output:
  - `463: "Fallback (existing session-control utility path): run "`

5) regression gate for existing behavior
- `cd /Users/alex/workspace/aidev/pi-extensions && npx tsx --test test/spawn-worker.test.ts`
- output tail:
  - `# tests 19`
  - `# suites 11`
  - `# pass 19`
  - `# fail 0`

6) workspace status
- `cd /Users/alex/workspace/aidev/pi-extensions && git status --short`
- output snippet includes:
  - `M spawn-worker.ts`
  - plus unrelated pre-existing workspace files.

## files changed

- `/Users/alex/workspace/aidev/pi-extensions/spawn-worker.ts`
- `/Users/alex/workspace/aidev/pi-extensions/doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batch/02/try-01/implementer.md`
- `/var/folders/l8/y_wkl1_505v5zdr0p5qf_r7r0000gp/T/pi-chain-runs/4eec05ee/progress.md`

## commit sha

- not committed

## remaining risk/follow-up

- no wave-02 suites (12-18) yet; batch-03 will add coverage for new helpers and
  commands.
- resolver currently breaks slot ties by latest `createdAt`; if cross-namespace
  slot collisions need stricter disambiguation, add explicit rule in tests/spec.
