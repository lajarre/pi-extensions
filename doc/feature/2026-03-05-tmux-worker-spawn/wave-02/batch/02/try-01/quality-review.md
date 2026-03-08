# fail

## quality checklist

| criterion | pass/fail | evidence |
|---|---|---|
| minimality (no unnecessary churn) | fail | batch scope is tasks 4,5,6,7 only (`doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batches.md:4`), and implementer claims same (`.../try-01/implementer.md:3`). but diff contains drift-policy/task-8 edits: `+DriftPolicy`, `+driftEnforcedMessage`, `+pi.setSessionName(...)` from `git diff -- spawn-worker.ts | grep -n 'DriftPolicy\|driftEnforcedMessage\|setSessionName\|driftPolicy'` => lines `9,63,394,421,444,455`. |
| evidence clarity (concise + verifiable logs) | pass | spec review includes matrix + evidence map + file/command refs (`.../try-01/spec-review.md:5`, `:29`, `:51`). implementer report includes explicit commands and output snippets (`.../try-01/implementer.md:12-58`). |
| process hygiene (relevant commands, low noise) | pass | logged commands are focused: targeted `grep`, one test gate `npx tsx --test test/spawn-worker.test.ts` (`.../try-01/implementer.md:49-54`), and `git status` (`.../try-01/implementer.md:56-60`). no avoidable noisy commands shown. |

## file/command references

- `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batches.md:3-4`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batch/02/try-01/`
  `implementer.md:3,12-60`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batch/02/try-01/`
  `spec-review.md:1,5,29,51`
- `cd /Users/alex/workspace/aidev/pi-extensions && git diff -- spawn-worker.ts`
- `cd /Users/alex/workspace/aidev/pi-extensions && git diff -- spawn-worker.ts |
  grep -n 'DriftPolicy\|driftEnforcedMessage\|setSessionName\|driftPolicy'`

## required fixes

1. trim batch-02 diff to scoped tasks only; remove drift-policy/task-8
   hunks from this try (or formally re-scope batch docs).
2. rerun spec-review + quality-review on the corrected scoped diff.
