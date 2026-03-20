# wiggum loops — progress & takeaways

Session: `b50699d4` (aidev:pi-wiggum:vogue)
Date: 2026-03-18 → 2026-03-20

## What shipped

### V1: quality loop (7 commits)

Fresh-agent review loop. Each iteration spawns a new pi process
with no shared context. Three-layer exit gate: agent stop signal
+ test command + exit script.

```
d238037 fix(wiggum): post-mortem gate hardening
6d38b09 fix(wiggum): make /wiggum max N work mid-loop
426aaf5 fix(wiggum): log error iterations, not just summary
b2d60b6 fix(wiggum): file list, dead import, error handling
5abe82a fix(wiggum): move log file to session directory
01d0350 feat(wiggum): add iteration log, tool completion, last-run status
7df9ce8 feat(wiggum): add fresh-agent quality review loop
```

55 tests. 5 modules (engine, gate, context, settings, index).
Widget progress bar. JSONL iteration log with agent output.

### V1.1: spec binding + guidelines (5 commits)

Hard gate requiring `doc/review-guidelines.md`. Template with
review criteria baked in. Precedence: explicit `--spec` →
`/wiggum guide` binding → auto-loaded guidelines. TUI overlay
for template creation.

```
f23cd39 feat(wiggum): sharpen review prompt and benchmark guidelines
a36bdb7 fix(wiggum): remove dead specify branch, helpful tool error
661d060 feat(wiggum): add hard gate TUI overlay for missing guidelines
0a805d6 feat(wiggum): wire guidelines precedence chain and hard gate
90316d4 feat(wiggum): add spec binding (guide, --spec, tool param, status)
c4d1a48 feat(wiggum): add guidelines template, context, loading, state
```

66 tests. Automated benchmark script.

## Benchmark results

Wigtest fixture: async Rust todo app with 11 deliberate
review-worthy issues (semantic, CLI, persistence, docs).
Reference: manual deep review session (cf2ebc33) that caught
all 11.

| Run | Checklist | vs Reference | Key variable |
|-----|-----------|-------------|-------------|
| V1 no guidelines | 3/11 | — | diff-only, generic prompt |
| V1.1 passive | 5/11 | — | "flag issues" language |
| Run 3 prescriptive | **11/11** | 3 better, **4 worse** | "you MUST fix", aggressive |
| Run 4 w/ constraints | **11/11** | 0 better, **6 worse** | + "do NOT change" section |
| **Run 5 design principles** | **11/11** | **3 better, 1 worse** | positive framing, specific fix shapes |

Run 5 validated 3x in parallel — 100% marker consistency.

cf2ebc33's final verdict on 3x run 5a: **5 wiggum better,
0 reference better, 6 same.** Quote: "not only comparable to
the manual cleanup, but better overall due to stronger CLI
behavior, persistence safety, and test coverage."

Note: the original run 5 (135623) scored 3/1/7. The 3x run 5a
(141401) scored 5/0/6 — same guidelines, different random seed,
better outcome. This variance is expected with LLM agents.

cf2ebc33's corrected assessment: run 4 is "materially better
than run 3" despite 0 wiggum-better categories. The constraints
eliminated over-correction (created_at_ms, ExitCode, dead state,
helper extraction), producing a cleaner codebase even though
the raw "better" count dropped. Reference still wins 6
categories, but the losses are now legitimate gaps (ReminderTask,
note parsing, parent-dir creation) rather than self-inflicted
regressions.

Comparison vs manual reference (verified by cf2ebc33):

Wiggum's output scored 11/11 on the category checklist, but the
reference session judged the reference `todo.rs` as **better
overall** for design discipline:

- **Wiggum better:** persistence hardening (sync_data, unique
  temp paths, fuller rollback), more tests
- **Reference better:** preserved `created_at_ms` (wiggum
  removed it = schema regression), kept `ReminderTask`
  abstraction (wiggum pushed shutdown into main.rs = less
  library-friendly), less API churn overall

Full comparison by cf2ebc33 (who wrote the manual reference):

| # | Category | Verdict |
|---|----------|---------|
| 1 | CLI/data-path | wiggum better (--data= support) |
| 2 | Title trim | reference better (no schema churn) |
| 3 | CLI notes | wiggum better (--note=, dedup, normalize) |
| 4 | Demo behavior | reference better (cleaner helper) |
| 5 | Graceful shutdown | reference better (ReminderTask abstraction) |
| 6 | Persistence | wiggum better (full rollback, sync_data) |
| 7 | Reminder/order | equal |
| 8 | Dead state | reference better (wiggum removed created_at_ms) |
| 9 | Hook bait | equal |
| 10 | Error rendering | reference better (ExitCode vs exit(1)) |
| 11 | Docs/tests | equal |

Score: wiggum better in 3, reference better in 4, equal in 4.

cf2ebc33's verdict: "automated output is not fully comparable to
the manual deep review; it has notable wins, but the reference
cleanup is still the better final implementation."

Key finding: **wiggum can over-correct.** It removed
`created_at_ms` (schema regression) and `ReminderTask`
(API churn) — neither was on the checklist. The review prompt
says "question everything: does each line need to exist?" which
encourages aggressive removal beyond the intended scope.

## Takeaways

### 1. Guidelines quality is everything

Same engine, same gate, same agent. The difference between 5/11
and 11/11 was entirely in how the guidelines were written:

- "flag issues" → agent notes problems but doesn't fix them
- "you MUST fix every item" → agent fixes everything
- "review the diff" → misses issues only visible in full files
- "read ALL source files" → catches everything

**Implication:** the review-guidelines.md template matters more
than any engine feature. Invest in template quality.

### 2. Wiggum can over-correct

The agent removed `created_at_ms` and `ReminderTask` — neither
was on the checklist. This changed the public API/schema
unnecessarily. The review prompt says "question everything: does
each line need to exist?" which encourages aggressive removal.

**Implication:** the guidelines need a "do NOT change" section
as well as a "fix these" section. Constraining scope is as
important as directing it. Future guidelines template should
include: "Do not change the public API/data schema unless
explicitly listed above."

After adding scope constraints (V1.2, run 4): **11/11 on
checklist, but 0 wiggum-better and 5 reference-better** — worse
than run 3 (which had 3 wiggum-better, 4 reference-better).

The "do NOT change" section fixed created_at_ms and ExitCode
but made the agent too conservative: notes parsing regressed
(no `--`, no duplicate rejection), persistence lost parent-dir
creation, and CLI still falls through to Demo on empty argv.

### 2a. Constraints are a blunt instrument

Adding "do NOT change" constraints is a double-edged sword.
They prevent over-correction but also dampen the beneficial
aggressiveness that produces wins like run 3's persistence
hardening and notes handling.

**But:** cf2ebc33 judges run 4 as materially better overall.
The raw "wiggum better" count is misleading — run 3's wins
(persistence, notes) came with self-inflicted regressions
(schema removal, API churn) that run 4 avoids. Fewer wins
but also fewer wounds.

**The remaining 6 reference-better categories** split into:
- 4 legitimate gaps (ReminderTask, note parsing, parent-dir,
  explicit-command) — need more specific checklist items
- 2 style preferences (demo helper, CLI structure) — arguably
  acceptable variation

Run 5 proved this right: inline fix shapes in checklist items
("preserve ReminderTask", "add --note with --/duplicates/blanks")
combined with positive design principles produced 3 better /
1 worse / 7 same.

### 2b. Positive framing > negative framing

The winning insight across 5 runs:

| Approach | Effect |
|----------|--------|
| No guardrails | Agent is creative but destructive |
| "Do NOT change X" | Agent is safe but timid |
| "Good code looks like X" | Agent is creative AND disciplined |

Negative constraints ("do NOT") are read as "be cautious" and
kill beneficial aggressiveness. Positive principles ("public
types are API contracts — refactor internals, don't delete them")
channel aggressiveness without dampening it.

### 3. Fresh eyes catch bugs in fixes

Iteration 2 in the benchmark found a real correctness bug in
iteration 1's rollback logic (`complete()` unconditionally set
`done = false` on failure, even for already-completed items).
A same-context reviewer would have been biased by its own work.

**Implication:** the ralph/wiggum pattern (fresh agent per
iteration) has measurable value beyond just "avoiding context
rot."

### 4. The three-layer gate works

- Layer 1 (tests): catches regressions every iteration
- Layer 2 (agent signal): WIGGUM_STOP is reliable with
  `<EXTREMELY-IMPORTANT>` framing
- Layer 3 (exit script): not yet tested with a real script
  (V1 falls back to lefthook)

minIterations=2 prevented premature 1-pass exits.

### 5. Observability was the hardest part

The loop worked from the first run. Making it observable took
4 rounds of fixes:
- Error notifications (silent failures)
- Widget progress bar (no visual feedback)
- JSONL iteration log (no post-mortem trail)
- Session-scoped log path (cwd pollution)
- Agent output in JSONL (review content trail)

### 6. The `pi -p` invocation has quirks

- `--no-session` means wiggum log goes to tmpdir, not session dir
- All user extensions load (including conflicting ones)
- The agent gets the full AGENTS.md context, which affects behavior
- Benchmark timeout needs explicit management (pi can run long)

### 7. Session-control API has limits

The test session (cf2ebc33) was invaluable for automated testing
but couldn't observe TUI widgets, got stuck returning cached
responses, and couldn't restart itself to pick up extension
changes. Human-in-the-loop TUI testing remains necessary.

## Open work

| Item | Status | Blocked on |
|------|--------|-----------|
| V2: plan loop | open | nothing |
| Merge-base for branch scope | open | nothing |
| Benchmark timeout fix | open | nothing |

## Artifacts

```
doc/feature/2026-03-18-wiggum-loops/
├── frame.md
├── shaping.md
├── slices.md
├── V1-spec.md
├── V1.1-spec.md
├── LOOP.md
├── widget-mini-spec.md
├── observability-mini-spec.md
├── progress.md (this file)
├── adr/
├── wave-01/
│   ├── input.md
│   ├── plan.md
│   └── widget-plan.md
└── wave-02/
    ├── input.md
    └── plan.md

pi-extensions/wiggum/
├── context.ts
├── engine.ts
├── gate.ts
├── index.ts
├── settings.ts
└── test/
    ├── benchmark.sh
    ├── context.test.ts
    ├── gate.test.ts
    └── settings.test.ts

_tmp/wigetest-template/     (benchmark fixture)
_tmp/wigtest/               (reference cleanup branch)
```
