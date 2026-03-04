---
shaping: true
---

# Structured Session Naming — Shaping

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Names encode context that the session folder path doesn't already carry | Core goal |
| R1 | Deterministic segments derived from env (git, gh) — no LLM | Must-have |
| R2 | LLM used only for activity description (rightmost segment) | Must-have |
| R3 | Works without git (plain directories) | Must-have |
| R4 | Captures PR number via `gh pr view` (with timeout, async) | Must-have |
| R5 | Branch name kept complete; appears only when ≠ worktree name or ≠ main | Must-have |
| R6 | Subfolder captured when not at project root | Nice-to-have |
| R7 | Description based on recent messages (recency-weighted) | Must-have |
| R8 | Colon `:` separator between segments | Must-have |
| R9 | `/name-auto` command triggers structured naming on-demand | Must-have |
| R10 | No hard max length; truncation from right if needed (~60 char soft target) | Must-have |

---

## A: Heaviness Stack ✅ selected

Session folder already encodes cwd (= repo + worktree). The name only carries
what the folder path doesn't tell you. Segments ordered by decreasing stability:

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **A1** | **Branch segment** — `git branch --show-current`. Strip conventional prefix (`feat/`, `fix/`, `pr/`, `hotfix/`). Include only when: (a) inside a linked worktree AND branch ≠ worktree slug, OR (b) not in a worktree AND branch ≠ main/master. Branch names carry issue IDs — kept complete. | |
| **A2** | **PR resolver** — `gh pr view --json number -q .number` with 3s timeout. Async, non-blocking. Prefix result: `pr<N>`. Fail silently if `gh` unavailable or no PR. Cache per session. | |
| **A3** | **Subfolder segment** — relative path from project root (git root, or nearest `project.org`/`area.org` dir) to cwd, if depth > 0. Slugify (`pkg/worker` → `pkg-worker`). | |
| **A4** | **LLM description** — last ~3 user messages (most recent = most relevant). 1–3 words, kebab-case. Cheap model. | |
| **A5** | **Assembler** — join non-empty segments with `:`. No hard max; soft target ~60 chars. If over, truncate from right (sacrifice description first). | |
| **A6** | **`/name-auto` command** — on-demand trigger that runs A1–A5 and applies result. Works even if already named (re-derives fresh). | |

### Heaviness order (left → right)

```
branch : pr : subfolder : description
  A1     A2      A3          A4
```

### What the folder already provides (NOT in the name)

- Repo / project name (encoded in session directory path)
- Worktree name (encoded in session directory path)
- Full cwd (shown in `/resume` "All" scope right side)

### Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Drop repo + worktree from name | Session folder path already encodes cwd → redundant |
| D2 | `gh pr view` with 3s timeout, async | Namenag fires infrequently; network cost acceptable |
| D3 | Branch kept complete, no ID extraction | Issue IDs live in branch names; PR is separate via `gh` |
| D4 | Truncate from right | Branch/PR are most stable; description is cheapest to lose |
| D5 | No hard max length | `/resume` truncates at render; ~60 char soft target |
| D6 | `/name-auto` command | On-demand, works even when already named |

### Examples

| Situation | Folder context | Segments | Name |
|-----------|---------------|----------|------|
| WT=feat-new-app, HEAD=pr/7-live-prices, PR#70 | system/.tree/feat-new-app | branch, pr, description | `7-live-prices:pr70:review-triage` |
| WT=feat-new-app, HEAD=feat/new-app (same), PR#60 | system/.tree/feat-new-app | pr, description | `pr60:ordering-fix` |
| On main, no PR, debugging | system/ | description | `debug-worker-cache` |
| Feature branch, no WT, PR#42 | system/ | branch, pr, description | `42-auth-refactor:pr42:token-handler` |
| Subfolder, PR | system/.tree/feat-new-app | pr, subfolder, description | `pr70:pkg-worker:cache-refactor` |
| No git, plain dir | butter-docs/ | description | `shaping-api` |

---

## Fit Check: R × A

| Req | Requirement | Status | A |
|-----|-------------|--------|---|
| R0 | Names carry only what folder doesn't | Core goal | ✅ |
| R1 | Deterministic segments from env | Must-have | ✅ |
| R2 | LLM only for description | Must-have | ✅ |
| R3 | Works without git | Must-have | ✅ |
| R4 | Captures PR number via `gh` | Must-have | ✅ |
| R5 | Branch when ≠ worktree/main, kept complete | Must-have | ✅ |
| R6 | Subfolder captured | Nice-to-have | ✅ |
| R7 | Description from recent messages | Must-have | ✅ |
| R8 | Colon separator | Must-have | ✅ |
| R9 | `/name-auto` command | Must-have | ✅ |
| R10 | No hard max; truncate from right | Must-have | ✅ |
