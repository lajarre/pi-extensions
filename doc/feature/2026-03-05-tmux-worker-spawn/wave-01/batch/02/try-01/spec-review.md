fail

requirement matrix
requirement | pass/fail | evidence
scope tasks 4-5 loaded | pass | wave-01/plan.md:97-150; spec.md:205-224
harness: node:test + assert, mock pi | pass | plan.md:99-103;
  test/spawn-worker.test.ts:1,4,88-156
1) parser rules | pass | plan.md:107-108;
  test/spawn-worker.test.ts:223-234
2) tool parity | pass | plan.md:109;
  test/spawn-worker.test.ts:237-288
3) frozen namespace | pass | plan.md:110-111;
  test/spawn-worker.test.ts:290-313
4) persisted slot counter/resume | pass | plan.md:112-113;
  test/spawn-worker.test.ts:315-352
5) auto + suffix naming | pass | plan.md:114-115;
  test/spawn-worker.test.ts:354-376
6) suffix sanitization | pass | plan.md:116-118;
  test/spawn-worker.test.ts:378-396
7) tmux split args | pass | plan.md:119-120;
  test/spawn-worker.test.ts:398-420
8) child launch payload | pass | plan.md:121-122;
  test/spawn-worker.test.ts:422-462
9) parent-name precondition | pass | plan.md:123-124;
  test/spawn-worker.test.ts:464-476
10) session-dir default + inherit | fail | plan.md:125-126 requires
  both. default omit tested at test/spawn-worker.test.ts:480-486.
  include-on-provided tested at :444-460. but no direct inherit-mode
  policy assertion ("inherit" appears only in test title at :479).
11) drift warning warn-only | pass | plan.md:127-128;
  test/spawn-worker.test.ts:490-549
all 11 groups present/passing | fail | plan.md:131. oui, suite count is
  green, but group 10 lacks preuve directe for inherit policy path.
named exports imported from ../spawn-worker.ts | pass | plan.md:132;
  test/spawn-worker.test.ts:57-69
qa command executed with pass evidence | pass | plan.md:136-145;
  implementer.md:28-33; review run shows `# suites 11`, `# pass 18`,
  `# fail 0`.
retry cap respected | pass | plan.md:150; implementer.md:7,15,25
  (2 fails, then pass on run 3).
no out-of-scope changes | pass | implementer.md:40,43-45.
  only test file + chain artifacts listed; no implementation file.

file/command references
- doc/feature/2026-03-05-tmux-worker-spawn/spec.md
- doc/feature/2026-03-05-tmux-worker-spawn/wave-01/plan.md
- doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/02/try-01/
  implementer.md
- test/spawn-worker.test.ts
- spawn-worker.ts (policy context check)
- command run (review):
  `cd /Users/alex/workspace/aidev/pi-extensions &&
  npx tsx --test test/spawn-worker.test.ts`
  key output: `# suites 11`, `# pass 18`, `# fail 0`

required fixes
1) add direct coverage for inherit-mode policy path, pas seulement
   provided-session-dir builder behavior.
2) rerun exact qa command and attach fresh pass output.
