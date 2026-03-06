# batch 01 spec review

## verdict
fail

## requirement matrix

| requirement | pass/fail | evidence |
|---|---|---|
| t1-r1 types + config constant | pass | plan.md:20; spawn-worker.ts:10-13,16-19,73 |
| t1-r2 suffix sanitizer rules | pass | plan.md:22-24; spawn-worker.ts:141-156,69,143-149 |
| t1-r3 `/spawn` parser rules | pass | plan.md:25-27; spawn-worker.ts:92-115,95,99,102,106 |
| t1-r4 persistence helpers | pass | plan.md:28-30; spawn-worker.ts:176-191,180,183 |
| t1-r5 naming model + counter | pass | plan.md:31-35; spawn-worker.ts:202-229,215,220,229,380-381 |
| t1-a1 all functions named-exported | fail | plan.md:38-39; non-export fn `warnOnDrift`: spawn-worker.ts:507 |
| t1-a2 no module side effects | pass | plan.md:40; `spawnWorkerExtension` only declared: spawn-worker.ts:503 |
| t2-r1 tmux runtime validation | pass | plan.md:47; spawn-worker.ts:234-253,237,246,250,253 |
| t2-r2 parent name precondition | pass | plan.md:49-50; spawn-worker.ts:194-199,366 |
| t2-r3 split-window args + targeting | pass | plan.md:51-52; spawn-worker.ts:267-276,274,276,292 |
| t2-r4 launch payload + session-control | pass | plan.md:53-56; spawn-worker.ts:320-333,322-325,328,380 |
| t2-r5 persist + confirmation | pass | plan.md:57-58; spawn-worker.ts:381,391-393 |
| t2-r6 session-dir policy | pass | plan.md:59-61; spawn-worker.ts:73,311-317,330 |
| t2-r7 error cases handled | pass | plan.md:62-65; spawn-worker.ts:109,125,153,237,250,295,352,417-420 |
| t2-r8 `/spawn` command wiring | pass | plan.md:66-67; spawn-worker.ts:541-562,547,554 |
| t2-r9 `spawn_worker` tool wiring | pass | plan.md:68-70; spawn-worker.ts:564-597,565,571-572,577,586 |
| t2-a1 shared core logic + coupling text | pass | plan.md:75-77; spawn-worker.ts:543,569,554,586 |
| t3-r1 session_start auto-name | pass | plan.md:83-84; spawn-worker.ts:524-527 |
| t3-r2 managed metadata entry | pass | plan.md:85-86; spawn-worker.ts:68,450-460,529-531 |
| t3-r3 drift detection warn-only | pass | plan.md:87-91; spawn-worker.ts:470-500,520,537-538,526 |
| t3-a1 visible drift warning only | pass | plan.md:94-95; spawn-worker.ts:499-500,520,526 |

## file/command references

- read:
  - doc/feature/2026-03-05-tmux-worker-spawn/spec.md
  - doc/feature/2026-03-05-tmux-worker-spawn/wave-01/plan.md
  - doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/implementer.md
  - spawn-worker.ts
- grep snippets used for evidence:
  - `spawn-worker.ts:507 const warnOnDrift = (ctx: ExtensionContext) => {`
  - `spawn-worker.ts:541 pi.registerCommand("spawn", {`
  - `spawn-worker.ts:565 name: "spawn_worker",`
  - `spawn-worker.ts:328 const childArgs: string[] = ["pi", "--session-control"];`
  - `spawn-worker.ts:381 saveState(pi, planned.nextState);`

## required fixes

1. satisfy plan task 1 acceptance literally (`all functions are exported`).
2. export current non-export helper(s), starting with `warnOnDrift`
   (`spawn-worker.ts:507`), as named exports.
3. if keeping inline callbacks, update plan/spec acceptance text first;
   otherwise extract callbacks to named exported functions.

strict verdict stays fail until task 1 acceptance is unambiguous and met.
voilà.
