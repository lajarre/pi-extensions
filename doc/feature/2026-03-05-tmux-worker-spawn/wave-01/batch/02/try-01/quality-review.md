fail

quality checklist
criterion | pass/fail | evidence
minimality | pass | `spec-review.md:41` marks no out-of-scope changes
as pass. Scoped status shows only test + try artifacts:
`git status --short -- test/spawn-worker.test.ts doc/feature/
2026-03-05-tmux-worker-spawn/wave-01/batch/02/try-01`
-> `?? .../try-01/`, `?? test/spawn-worker.test.ts`. Diff stat:
`git diff --no-index --stat /dev/null test/spawn-worker.test.ts`
-> `1 file changed, 551 insertions(+)`.
evidence clarity | fail | upstream spec-review verdict is fail
(`spec-review.md:1`). Missing direct inherit-mode evidence for
required group 10 (`spec-review.md:26-30,32-33`). In test file,
`inherit` appears only in title (`test/spawn-worker.test.ts:479`)
and assertions cover default mode/omit only
(`test/spawn-worker.test.ts:480-486`).
process hygiene | pass | commands are relevant and concise:
exact qa command repeated + status snapshot
(`implementer.md:7-38`). Retry cap handling is documented as
respected (`spec-review.md:39`).

file/command references
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/02/
  try-01/spec-review.md:1,26-33,39,41`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/02/
  try-01/implementer.md:7-13,15-23,25-33,37-38`
- `test/spawn-worker.test.ts:478-486`
- command: `git status --short -- test/spawn-worker.test.ts`
  `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/02/`
  `try-01`
  output: `?? .../try-01/`, `?? test/spawn-worker.test.ts`
- command: `git diff --no-index --stat /dev/null`
  `test/spawn-worker.test.ts`
  output: `1 file changed, 551 insertions(+)`

required fixes
1) add direct inherit-mode policy coverage for required group 10
   (not only default omit + explicit provided session-dir include).
2) rerun qa and refresh evidence:
   `cd /Users/alex/workspace/aidev/pi-extensions &&`
   `npx tsx --test test/spawn-worker.test.ts`.
