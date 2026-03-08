PASS

## requirement matrix

requirement | pass/fail | evidence
---|---|---
scope = batch-02 tasks 4,5,6,7 only; drift task-8 already accepted in batch-01 | pass | `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batches.md:3-4`; `.../batch/01/try-01/spec-review.md:5,61-81`
t4: `/workers` command is registered | pass | `spawn-worker.ts:937`
t4: `/workers` loads registry + frozen namespace, then notifies output | pass | `spawn-worker.ts:941-944`
t4: workers list shows current namespace first, then others | pass | current bucket then other bucket logic in `spawn-worker.ts:330-345`; output sections `:348-359`
t4: each worker line has name, pane id, slot, age | pass | line format in `spawn-worker.ts:312-318`
t4: age is human-readable | pass | `just now`, `s/m/h/d ago` in `spawn-worker.ts:297-309`
t4: empty registry shows `/spawn` guidance | pass | `spawn-worker.ts:328`; used by `/workers` handler `:943-944`
t5: exported `resolveWorkerTarget(registry, target)` exists | pass | `spawn-worker.ts:386`
t5: resolution order = exact name, `wrkr-<n>`, numeric slot | pass | exact `spawn-worker.ts:401-402`; slot token `:414-421`; numeric `:424-431`
t5: unknown target error lists available worker names | pass | names list `spawn-worker.ts:434`; error text `:436`
t6: exported `sendWorkerMessage(pi, workerName, message)` exists | pass | `spawn-worker.ts:472`
t6: bridge uses `pi.exec("pi", args)` with required flags | pass | args builder `spawn-worker.ts:440-454`; exec call `:496`
t6: bridge failure returns error + fallback via existing utility path | pass | failure returns `spawn-worker.ts:508-509,517-518`; fallback text `:463-468`
t6: helper sends exact message string (no decoration) | pass | message passed directly in args/fallback: `spawn-worker.ts:449-450,494`
t7: `/send-worker` command registered with session-control coupling text | pass | command + description `spawn-worker.ts:948-950`
t7: command parses first token target + rest message | pass | `parseSendWorkerCommandArgs` in `spawn-worker.ts:372,377-378`; wired in command `:954`
t7: command integrates resolver + bridge helper | pass | resolve call `spawn-worker.ts:964`; send call `:971`
t7: resolution/bridge errors are shown to user | pass | resolution/parse errors `spawn-worker.ts:957,967`; bridge error+fallback `:977`
true batch-02 spec gaps remain | pass | all task 4-7 requirements above have direct code evidence; no uncovered requirement

## file/command references

- requirement source:
  - `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/plan.md:89-167`
  - `doc/feature/2026-03-05-tmux-worker-spawn/spec-wave02.md:53-86,101-105`
- drift accepted out-of-scope for this review:
  - `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batches.md:3-4`
  - `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batch/01/try-01/spec-review.md:5,61-81`
- regression sanity command (re-run):
  - `cd /Users/alex/workspace/aidev/pi-extensions && npx tsx --test test/spawn-worker.test.ts`
  - output: `# tests 19`, `# suites 11`, `# pass 19`, `# fail 0`

## required fixes (if fail)

none
