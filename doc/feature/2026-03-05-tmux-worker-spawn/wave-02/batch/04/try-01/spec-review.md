PASS

## requirement matrix

requirement | pass/fail | evidence
task 14 exact qa command defined | pass | r1
try-01 shows exact command | pass | r2
pass evidence includes `# fail 0` | pass | r3
exit code 0 criterion met | pass | r4
suites 1-11 and 12-18 pass | pass | r5

## file/command references

r1: `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/plan.md`
    `:236-237`
r2: `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batch/04/`
    `try-01/implementer.md:9-10`
r3: `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batch/04/`
    `try-01/implementer.md:16-20`
    values: `1..18`, `# suites 18`, `# pass 30`, `# fail 0`
r4: `doc/feature/2026-03-05-tmux-worker-spawn/wave-02/batch/04/`
    `try-01/implementer.md:28`
    rerun output: `exit_code=0`
r5: rerun output lists `ok 1` ... `ok 18`, then `1..18`
    and `# fail 0`

command refs:
`cd /Users/alex/workspace/aidev/pi-extensions &&
 npx tsx --test test/spawn-worker.test.ts`
`cd /Users/alex/workspace/aidev/pi-extensions &&
 npx tsx --test test/spawn-worker.test.ts >/tmp/task14-qa.out &&
 status=$?; echo "exit_code=$status"; tail -n 12 /tmp/task14-qa.out`

## required fixes (if fail)

none
