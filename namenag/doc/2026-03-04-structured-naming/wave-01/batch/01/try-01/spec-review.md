FAIL-MINOR

Requirement matrix

| Requirement | PASS/FAIL | Evidence |
|---|---|---|
| Task 1: `resolve.ts` defines segment caps (branch 12, subfolder 12, description 20) | PASS | `resolve.ts:19-23` (`SEGMENT_CAPS`) |
| Task 1: `truncateSegment` exists, null-safe, truncates with `…` | PASS | `resolve.ts:26-29` |
| Task 1 tests: short/exact/empty/null/truncation cases covered | PASS | `test/namenag.test.ts:248-268` |
| Task 2: `detectWorktree` uses `git rev-parse --show-toplevel` + `--git-common-dir` and returns linked-worktree leaf via basename | PASS | `resolve.ts:43-64` |
| Task 2 tests: linked vs main worktree, non-git, absolute common-dir | PASS | `test/namenag.test.ts:270-320` |
| Task 3: branch/worktree prefix stripping implemented (`feat|fix|pr|hotfix`) | PASS | `resolve.ts:71-81` |
| Task 3: `resolveBranch` skips `main`/`master`, skips branch==worktree slug, truncates branch segment | PASS | `resolve.ts:92-113`; truncation via `SEGMENT_CAPS.branch` |
| Task 3 tests: prefix stripping, main/master skip, worktree-same skip, truncation | PASS | `test/namenag.test.ts:322-423` |
| Task 4: `resolvePR` runs `gh pr view --json number -q .number` with 3s timeout, returns `pr<N>` or null | PASS | `resolve.ts:124-139` (includes `timeout: 3000`) |
| Task 4 tests: success, timeout, gh unavailable, non-numeric output, timeout wiring | PASS | `test/namenag.test.ts:425-475` |
| Task 5: `resolveSubfolder` computes relative slug from git root, skips root, truncates at 12 | PASS | `resolve.ts:148-159` |
| Task 5 spec requirement: non-git project root fallback via upward walk for `project.org`/`area.org` (stop before `~/`) | FAIL | Spec requires this at `spec.md:81-82`. Implementation only calls git root and returns null on failure (`resolve.ts:150-151`). `grep resolve.ts "project\.org|area\.org"` => no matches. |
| Task 5 tests cover spec scenarios incl. marker fallback | FAIL | Existing test explicitly states no marker fallback: `test/namenag.test.ts:496` (“no project.org fallback in tests”). No test for `project.org`/`area.org` upward-walk behavior. |
| Task 6: `assembleSegments` filters null/empty, joins with `:` | PASS | `resolve.ts:170-171` |
| Task 6 tests: colon join, null/empty filtering, single/all-empty cases | PASS | `test/namenag.test.ts:509-539` |
| Task 7: description prompt constrained to 1–3 words kebab-case | PASS | `resolve.ts:178-184` (`DESCRIPTION_PROMPT`) |
| Task 7: `resolveDescription` sanitizes + truncates at 20 + null on failure/empty | PASS | `resolve.ts:192-211` |
| Task 7 tests: truncation at 20, kebab-case sanitize, error/empty handling | PASS | `test/namenag.test.ts:541-571` |
| Required command executed: `cd /Users/alex/workspace/aidev/pi-extensions/namenag && npx tsx --test test/namenag.test.ts` | PASS | Command run in this review. Output summary: `# tests 65`, `# pass 65`, `# fail 0`. |
| All gates pass (requested gate command) | PASS | Same command output: zero failures. |

File/command references

- Spec: `/Users/alex/workspace/aidev/pi-extensions/namenag/doc/2026-03-04-structured-naming/spec.md` (notably lines with subfolder fallback requirement: `spec.md:81-82`).
- Plan: `/Users/alex/workspace/aidev/pi-extensions/namenag/doc/2026-03-04-structured-naming/wave-01/plan-approved.md` (Tasks 1–7 definitions).
- Implementer report: `/Users/alex/workspace/aidev/pi-extensions/namenag/doc/2026-03-04-structured-naming/wave-01/batch/01/try-01/implementer.md`.
- Implementation reviewed: `/Users/alex/workspace/aidev/pi-extensions/namenag/resolve.ts`.
- Tests reviewed: `/Users/alex/workspace/aidev/pi-extensions/namenag/test/namenag.test.ts`.
- Gate command run:
  - `cd /Users/alex/workspace/aidev/pi-extensions/namenag && npx tsx --test test/namenag.test.ts`
  - Result: all 65 tests passed.

Required fixes

1. Implement Task 5 marker fallback required by spec:
   - In `resolveSubfolder`, when git root resolution fails, walk up from `cwd` to find `project.org` or `area.org`.
   - Stop upward traversal before user home boundary (`~/`).
   - Use discovered marker directory as project root, then keep current behavior (relative path -> `/` to `-` -> truncate to 12 with `…`).
2. Add tests for marker fallback scenarios:
   - Finds `project.org` in ancestor and returns expected slug.
   - Finds `area.org` in ancestor and returns expected slug.
   - Stops before `~/` and returns `null` when no marker found.
   - Root-depth skip behavior still works for marker-derived root.
