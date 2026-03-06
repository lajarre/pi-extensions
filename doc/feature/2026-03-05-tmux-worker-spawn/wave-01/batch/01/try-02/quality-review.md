PASS

spec gate: pass (`.../try-02/spec-review.md:1`).

## quality checklist

| criterion | pass/fail | evidence |
|---|---|---|
| minimality | pass | one scoped fix in one file (`.../try-02/implementer.md:11-15,44-46`). prior blocker was non-export helper (`.../try-01/spec-review.md:40`); now exported (`spawn-worker.ts:503`). size delta stayed small vs prior snapshot (`.../try-01/quality-review.md:37-38` shows 600 insertions; current `wc -l spawn-worker.ts` is 605). |
| evidence clarity | pass | spec review provides full matrix with line refs (`.../try-02/spec-review.md:5-31`) and command refs (`:43-50`). implementer report lists concrete commands with key outputs, incl. failing checks (`.../try-02/implementer.md:17-43`). |
| process hygiene | pass | relevant, low-noise command set: artifact reads, targeted edit, checks, grep (`.../try-02/implementer.md:5-43`). no destructive ops in listed commands. workspace snapshot is informational (`git status --short` output: `M protect-paths.ts`, `?? doc/`, `?? spawn-worker.ts`). |

## file/command references

files
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-02/spec-review.md:1,5-31,43-50`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-02/implementer.md:5-15,17-46`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/spec-review.md:40`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/quality-review.md:37-38`
- `spawn-worker.ts:503`

commands
- `grep "const warnOnDrift =" doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/spec-review.md`
  -> `spec-review.md:40: ... const warnOnDrift ...`
- `grep "export function warnOnDrift(" spawn-worker.ts`
  -> `spawn-worker.ts:503: export function warnOnDrift(`
- `wc -l spawn-worker.ts`
  -> `605 spawn-worker.ts`
- `git diff --no-index --stat -- /dev/null spawn-worker.ts`
  -> `1 file changed, 605 insertions(+)`
- `git status --short`
  -> `M protect-paths.ts`, `?? .pi/`, `?? doc/`,
     `?? namenag/.pi/`, `?? spawn-worker.ts`
