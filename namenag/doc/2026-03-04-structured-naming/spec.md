---
shaping: true
---

# Structured Session Naming — Spec

## Summary

Rewrite namenag's auto-naming to produce structured, hierarchical session names
using deterministic environment signals (git branch, `gh` PR, subfolder) plus
LLM only for the activity description. Add `/name-auto` on-demand command.

**Source:** `doc/2026-03-04-structured-naming/shaping.md` (Shape A — Heaviness Stack)

## Scope

**Extension:** `pi-extensions/namenag/index.ts`
**Tests:** `pi-extensions/namenag/test/namenag.test.ts`

### What changes

1. **Segment resolvers** — new pure functions that derive name segments from environment.
   Each resolver takes `cwd` and an `exec` function as params (mockable, testable):
   - `resolveBranch(cwd, exec)` — git branch, stripped prefix, skip if = worktree or main
   - `resolvePR(cwd, exec)` — `gh pr view` with 3s timeout, returns `pr<N>` or null
   - `resolveSubfolder(cwd, exec)` — relative path from project root, slugified
   - `resolveDescription(messages, model, apiKey)` — LLM on recent messages, 1–3 words

2. **Worktree detection** — determine if inside a linked worktree, extract worktree
   leaf name for branch comparison.

3. **Assembler** — join non-empty segments with `:`, per-segment truncation, soft
   total target ~60 chars.

4. **Updated LLM prompt** — constrain to 1–3 word activity description only (not a
   full session name).

5. **`/name-auto` command** — runs the full pipeline on demand, works even if already
   named (ignores `named` flag). Auto-triggers (compaction, ≥50 turns) still respect
   the `named` flag — they won't overwrite.

6. **Fallback** — if the structured pipeline produces an empty name (all resolvers
   return null AND LLM fails), fall back to old-style full LLM naming (2–4 word
   kebab-case session name from conversation context).

7. **Existing triggers preserved** — compaction and ≥50 turns still auto-name, but
   using the new structured pipeline. Soft nag at ≥10 turns unchanged.

### What doesn't change

- Extension lifecycle (session_start, session_switch, session_fork resets)
- hasUI guard
- Cheapest-model resolution
- Generating flag / idempotency

## Segment rules

### Branch segment
- `git branch --show-current` via `pi.exec("git", [...], { cwd })`
- Strip prefix: `feat/`, `fix/`, `pr/`, `hotfix/` (regex: `/^(feat|fix|pr|hotfix)\//`)
- Skip if: branch = main/master, or branch slug = worktree leaf name (after both are prefix-stripped)
- Keep complete (issue IDs live in branch names)
- **Max 12 chars**, truncate with `…`

### Worktree detection
- `git rev-parse --show-toplevel` vs `git rev-parse --git-common-dir`
- If git-common-dir resolves outside toplevel → linked worktree
- Worktree leaf name: basename of toplevel (e.g., `/path/.tree/feat-new-app` → `feat-new-app`)
- **Strip same prefixes** (`feat-`, `fix-`, `pr-`, `hotfix-`) from worktree leaf
  before comparing to branch slug. Note: worktree uses `-` separator (directory name),
  branch uses `/` separator — strip both patterns.

### PR resolver
- `gh pr view --json number -q .number` via `pi.exec()` with 3s timeout
- Returns `pr<N>` string or null
- Fail silently: `gh` not installed, no PR for branch, timeout, network error
- **No caching** — always query on each trigger (fires infrequently)

### Subfolder segment
- Project root: git root (`git rev-parse --show-toplevel`), or walk up for
  `project.org`/`area.org`, stop before `~/`
- Relative path from root to cwd
- Skip if at root (depth = 0)
- Slugify: replace `/` with `-`
- **Max 12 chars**, truncate with `…`

### LLM description
- Input: last 3 user messages from session branch (most recent first), max ~500 chars total
- Prompt: "1–3 words, kebab-case, describing the current activity"
- Same cheapest-model resolution as current
- **Max 20 chars**, truncate with `…`

### Assembly
- Order: `[branch, pr, subfolder, description]`
- Filter out nulls/empty
- Each segment individually truncated per caps above
- Join with `:`
- If assembled name is empty → fallback to old-style full LLM naming

### Per-segment caps summary

| Segment | Max chars | Truncation |
|---------|-----------|------------|
| Branch | 12 | `…` |
| PR | uncapped | naturally short (`pr<N>`) |
| Subfolder | 12 | `…` |
| Description | 20 | `…` |

## QA

### Commands

```bash
cd /Users/alex/workspace/aidev/pi-extensions/namenag
npx tsx --test test/namenag.test.ts
```

### Pass criteria

- All existing tests pass (behavior unchanged for basic lifecycle)
- New tests cover:
  - Branch resolution: prefix stripping, main/master skip, worktree-same skip,
    truncation at 12 chars
  - Worktree detection: linked vs main worktree, prefix stripping for comparison
  - PR resolution: success, timeout, gh unavailable
  - Subfolder resolution: at root (skip), nested, no git fallback, truncation
  - LLM description: truncation at 20 chars
  - Assembly: segment joining, empty segments skipped, colon separator
  - Fallback: empty structured name → old-style LLM naming
  - `/name-auto` command: registered, triggers pipeline, works when already named
  - `/name-auto` vs auto-triggers: auto-triggers respect `named` flag, command doesn't
  - Integration: structured name produced from mock exec context

### Failure policy

- Test failure → fix and retry (max 2 retries per batch)
- All git/gh calls mocked via injected `exec` param — never rely on real git/gh in tests

## Constraints

- No new dependencies (use `pi.exec()` for git/gh commands)
- Resolvers are pure functions taking `(cwd, exec)` — testable without mocks where possible
- Extension file stays under ~500 LOC — extract resolvers to separate file if needed
- Follow AGENTS.md commit conventions
