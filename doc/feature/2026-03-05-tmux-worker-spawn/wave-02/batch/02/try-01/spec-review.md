# pass

scope: wave-02 batch-02 tasks 4,5,6,7 only.

## requirement matrix

| requirement | pass/fail | evidence |
|---|---|---|
| 4.1 `/workers` command registered | pass | e1 |
| 4.2 uses registry + frozen namespace | pass | e2 |
| 4.3 order: current ns, then others | pass | e3 |
| 4.4 line has name/pane/slot/age | pass | e4 |
| 4.5 empty state points to `/spawn` | pass | e5 |
| 5.1 exported resolver exists | pass | e6 |
| 5.2 resolve order exact->token->slot | pass | e7 |
| 5.3 unknown target lists known names | pass | e8 |
| 6.1 exported bridge sender exists | pass | e9 |
| 6.2 uses `pi.exec("pi", args)` | pass | e10 |
| 6.3 required bridge args present | pass | e11 |
| 6.4 bridge failure returns fallback | pass | e12 |
| 6.5 message passed as-is to bridge | pass | e13 |
| 7.1 `/send-worker` command registered | pass | e14 |
| 7.2 parser: first token + rest msg | pass | e15 |
| 7.3 resolver + bridge wired in cmd | pass | e16 |
| 7.4 errors surfaced to user | pass | e17 |
| coupling: workers text mentions orchestration | pass | e18 |
| coupling: send-worker says bridge-first | pass | e19 |

## evidence map

- e1: `spawn-worker.ts:937`
- e2: `spawn-worker.ts:941-943`
- e3: `spawn-worker.ts:331-359`
- e4: `spawn-worker.ts:312-318`, `spawn-worker.ts:286-309`
- e5: `spawn-worker.ts:328`
- e6: `spawn-worker.ts:386`
- e7: `spawn-worker.ts:401-402`, `414-422`, `424-432`
- e8: `spawn-worker.ts:435-436`
- e9: `spawn-worker.ts:472`
- e10: `spawn-worker.ts:496`
- e11: `spawn-worker.ts:440-454`
- e12: `spawn-worker.ts:458-468`, `508-509`, `517-518`
- e13: `spawn-worker.ts:449-450`, `spawn-worker.ts:971`
- e14: `spawn-worker.ts:948-950`
- e15: `spawn-worker.ts:372`, `377-378`
- e16: `spawn-worker.ts:964`, `spawn-worker.ts:971`
- e17: `spawn-worker.ts:966-968`, `spawn-worker.ts:977`
- e18: `spawn-worker.ts:939`
- e19: `spawn-worker.ts:950`

## file/command references

files read:
- `doc/feature/2026-03-05-tmux-worker-spawn/spec-wave02.md`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/plan.md`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batches.md`
- `doc/feature/2026-03-05-tmux-worker-spawn/LOOP.md`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batch/02/`
  `try-01/implementer.md`
- `spawn-worker.ts`

commands run:
- `grep -n 'registerCommand("workers"' spawn-worker.ts`
  - hit: `937`
- `grep -n 'registerCommand("send-worker"' spawn-worker.ts`
  - hit: `948`
- `grep -n 'parseSendWorkerCommandArgs' spawn-worker.ts`
  - hit: `366`
- `grep -n 'resolveWorkerTarget' spawn-worker.ts`
  - hit: `386`
- `grep -n 'buildSendWorkerBridgeArgs' spawn-worker.ts`
  - hit: `440`
- `grep -n 'Fallback (existing session-control utility path)'`
  `spawn-worker.ts`
  - hit: `463`
- `npx tsx --test test/spawn-worker.test.ts`
  - `# tests 19`, `# suites 11`, `# pass 19`, `# fail 0`

## required fixes

none.
