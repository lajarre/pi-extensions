# Plan Review — Wave 01: Structured Session Naming

**Plan:** `wave-01/plan.md`
**Spec:** `spec.md`
**Shaping:** `shaping.md`
**Reviewed:** 2026-03-04

---

## Requirements Coverage Matrix

| Req | Requirement | Covered | Plan Tasks | Notes |
|-----|-------------|:-------:|------------|-------|
| R0 | Names encode context folder path doesn't carry | ✅ | All | Branch, PR, subfolder, description — none duplicate folder-path info |
| R1 | Deterministic segments from env (no LLM) | ✅ | 2–5 | `detectWorktree`, `resolveBranch`, `resolvePR`, `resolveSubfolder` — all pure exec-based |
| R2 | LLM only for activity description | ✅ | 7 | `resolveDescription` uses injected LLM callback; all other resolvers are LLM-free |
| R3 | Works without git (plain directories) | ✅ | 5, 8, 10 | Resolvers return null on git failure → description-only or fallback path fires |
| R4 | PR number via `gh pr view` with timeout | ✅ | 4 | 3s timeout, silent failure for all error conditions, non-numeric guard |
| R5 | Branch kept complete; appears only when ≠ worktree/main | ✅ | 3 | Prefix stripping (branch `/` and worktree `-`), main/master skip, worktree-match skip |
| R6 | Subfolder captured when not at root | ✅ | 5 | Relative path from git root, slugified, truncated at 12 |
| R7 | Description from recent messages (recency-weighted) | ✅ | 7, 9 | `gatherContext` refactored to last-3-user-messages most-recent-first |
| R8 | Colon `:` separator between segments | ✅ | 6 | `assembleSegments` joins with `:`, filters nulls/empties |
| R9 | `/name-auto` command | ✅ | 11 | Registered command, ignores `named` flag, re-derives fresh |
| R10 | No hard max; soft ~60 char target via per-segment caps | ✅ | 1, 3–7 | Branch 12, subfolder 12, description 20. Max theoretical ≈55 chars. No hard overall cap. |

### Spec Feature Coverage

| Feature | Covered | Notes |
|---------|:-------:|-------|
| Segment resolvers as pure `(cwd, exec)` functions | ✅ | `ExecFn` type injected, mockable |
| Worktree detection (linked vs main) | ✅ | Compares `--show-toplevel` vs `--git-common-dir` |
| Assembler with colon-join | ✅ | Null/empty filtering |
| Updated LLM prompt (1–3 word description only) | ✅ | `DESCRIPTION_PROMPT` in resolve.ts |
| `/name-auto` command | ✅ | `forceAutoName` bypasses `named` flag |
| Fallback to old-style LLM naming | ✅ | When structured pipeline produces empty string |
| Existing triggers preserved | ✅ | Compaction, ≥50 turns, soft nag at ≥10 |
| hasUI guard unchanged | ✅ | `isActive` check preserved |
| Cheapest-model resolution unchanged | ✅ | `resolveModel` untouched |
| Generating flag / idempotency | ✅ | Preserved in refactored `autoName` |

---

## Guidelines Compliance (AGENTS.md)

| Guideline | Status | Notes |
|-----------|:------:|-------|
| Files < ~500 LOC | ✅ | resolve.ts ~175, index.ts ~220 — both well under limit |
| Commit convention: `<gitmoji> <imperative>` | ✅ | All 12 tasks use correct format |
| Atomic commits with explicit paths | ✅ | Each commit lists specific files |
| No destructive ops | ✅ | No resets, force pushes, deletions |
| No file proliferation | ✅ | One new file (resolve.ts), one modified (index.ts) |
| Singular directory names | ✅ | `test/` (existing) |
| No new dependencies | ✅ | Uses existing `@mariozechner/pi-ai`, `node:path` |
| TDD: red-green-refactor | ✅ | Every task follows write-test → verify-fail → implement → verify-pass |
| Split refactor from behavior | ✅ | Task 9 (refactor gatherContext) is separate from Task 10 (new behavior) |

---

## Security / Robustness Check

| Concern | Status | Notes |
|---------|:------:|-------|
| Shell injection | ✅ | `pi.exec()` uses array args, never string interpolation |
| Timeout on network call | ✅ | `gh pr view` gets 3s timeout |
| LLM output sanitization | ✅ | `resolveDescription` strips non-kebab chars; fallback has same sanitization |
| Error handling | ✅ | Every resolver has try/catch → null; orchestrator catches all |
| No sensitive data | ✅ | Branch/PR names are not secrets |
| Graceful degradation | ✅ | Non-git dirs, missing `gh`, LLM failure — all handled silently |

---

## ADR Candidates Validation

| ADR | Valid? | Notes |
|-----|:------:|-------|
| ADR-1: ExecFn minimal vs full pi.exec | ✅ | Reasonable; minimal interface is correct for testability. Recommendation is sound. |
| ADR-2: git-common-dir resolution against cwd | ✅ | `pathResolve(cwd, raw)` works for both relative and absolute paths. Implementation is correct. |
| ADR-3: Description-only = valid structured result | ✅ | Confirmed by spec: fallback only when assembled name is empty. Description-only is valid. |
| ADR-4: Colons allowed in structured names | ✅ | Important decision — segments are individually sanitized, colon is the structural separator. No further sanitization on assembly. |
| ADR-5: Shared gatherContext for both paths | ✅ | Same 3 recent messages. Consistent behavior, simpler code. |
| ADR-6: pi.exec capture at init | ✅ | `ExtensionAPI.exec()` is available on the `pi` object. Capture once, wrap once. |
| ADR-7: Command handler context type | ⚠️ | Plan correctly flags this needs verification during implementation. Low risk — `ExtensionCommandContext` likely extends `ExtensionContext`. |

All 7 ADR candidates are legitimate implementation decisions. The plan provides reasonable default recommendations for each.

---

## Issues Found

### Minor (incorporated into approved plan)

1. **Missing `ExecFn` import in Task 10.** The `piExec` wrapper is typed as `ExecFn` but the import block only shows `structuredName`, `DESCRIPTION_PROMPT`, `DescriptionLLMFn`. Must also import `type ExecFn`.

2. **Task 2/3/4/5 test imports incomplete.** Test snippets reference `ExecFn` type in mock definitions but don't show the import. Implementer will need to ensure `type ExecFn` is imported alongside each resolver. Not a blocker — pattern is clear from Task 8 which does include it.

3. **Task 12 integration tests are skeletal.** Only comment outlines, no actual assertions. Acceptable for a plan — implementer fills in — but less prescriptive than Tasks 1–8. The key scenarios are identified.

### Observations (no fix needed)

4. **`project.org`/`area.org` fallback not implemented** in `resolveSubfolder`. Plan acknowledges this in "Spec Ambiguities" §2. Git-root covers the majority case. Non-git directories simply get no subfolder segment (description-only or fallback). Acceptable for wave-01; can be added later.

5. **`--show-toplevel` called twice** — once in `detectWorktree`, once in `resolveSubfolder`. Minor inefficiency; both run in parallel after worktree detection so no latency impact. Not worth complicating the code for.

6. **Shaping examples use untruncated branch names** (e.g., `7-live-prices` = 13 chars) but spec explicitly caps at 12. Plan correctly follows the spec cap. The shaping was pre-spec; no issue.

7. **Shaping A2 says "Cache per session"** for PR, but spec says "No caching". Plan follows spec. Correct.

---

## Verdict: **APPROVE**

The plan comprehensively covers all spec requirements (R0–R10), follows AGENTS.md conventions, maintains TDD discipline throughout, and identifies the right ADR candidates. The dependency graph is correct and enables parallel execution of independent tasks. Minor issues (missing import, skeletal integration tests) are incorporated into the approved plan below.

No structural or architectural concerns. Proceed to execution.
