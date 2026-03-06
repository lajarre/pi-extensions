# batch 01 quality review

## verdict
fail

upstream spec gate failed; quality cannot pass.

evidence:
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/spec-review.md:3`
  shows `## verdict` and `fail`.
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/spec-review.md:15`
  shows task `t1-a1 all functions named-exported | fail`.
- `spawn-worker.ts:507` shows non-export helper
  `const warnOnDrift = (ctx: ExtensionContext) => {`.

## quality checklist

| criterion | pass/fail | evidence |
|---|---|---|
| minimality | pass | batch 1 scope is tasks 1-3 in one file: `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batches.md:3`. diff confirms one added implementation file: `git diff --no-index --stat -- /dev/null spawn-worker.ts` => `1 file changed, 600 insertions(+)`. |
| evidence clarity | pass | spec-review has a full requirement matrix with direct refs: `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/spec-review.md:7-38`, plus explicit blocker refs at `:15` and `:40`. implementer report lists commands and key outputs clearly: `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/implementer.md:20-50`. |
| process hygiene | pass | command list is relevant and low-noise (`read`, `write`, import check, grep spot-check, status): `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/implementer.md:20-48`. no destructive ops in listed commands. |

## file/command references

files:
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batches.md:3`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/spec-review.md:3,15,40,49-54`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/implementer.md:20-51`
- `spawn-worker.ts:507`

commands used in this review:
- `cd /Users/alex/workspace/aidev/pi-extensions && git status --short`
  output: `M protect-paths.ts`, `?? .pi/`, `?? doc/`,
  `?? namenag/.pi/`, `?? spawn-worker.ts`.
- `cd /Users/alex/workspace/aidev/pi-extensions && git diff --no-index --stat -- /dev/null spawn-worker.ts`
  output: `/dev/null => spawn-worker.ts | 600 ...`,
  `1 file changed, 600 insertions(+)`.

## required fixes

1. satisfy task 1 acceptance exactly: all functions exported.
   start by exporting `warnOnDrift`.
   evidence: `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/spec-review.md:15,49-50`,
   `spawn-worker.ts:507`.
2. rerun spec review and require PASS before any quality PASS.
