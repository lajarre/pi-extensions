# namenag

Auto-name unnamed Pi sessions with structured, hierarchical names.

## How It Works

### Structured Naming Pipeline

Names are built from segments ordered by decreasing scope:

```
project : worktree : branch : pr : subfolder : description
  12        12        12     free     12          20      (char caps)
```

| Segment | Source | Example |
|---------|--------|---------|
| **Project** | Git remote repo name, or `project.org`/`area.org` dirname, or cwd basename | `system` |
| **Worktree** | Linked worktree leaf name (prefix-stripped) | `new-app` |
| **Branch** | `git branch --show-current`, stripped prefix, skip if = worktree or main | `7-live-price…` |
| **PR** | `gh pr view` with 3s timeout | `pr70` |
| **Subfolder** | Relative path from project root, slugified | `pkg-worker` |
| **Description** | LLM (cheapest model), 1–3 words from recent messages | `review-triage` |

**Examples:**
- `system:new-app:7-live-price…:pr70:review-triage`
- `system:pr60:ordering-fix`
- `system:debug-worker-cache`
- `butter-docs:shaping-api`

### Triggers

| Trigger | Threshold | Action |
|---------|-----------|--------|
| **Soft** | ≥10 user turns | Toast: "Session unnamed — `/name` to set one." |
| **Hard** | ≥50 user turns | Structured name pipeline → `setSessionName()` |
| **Hard** | Compaction | Structured name pipeline → `setSessionName()` |
| **Command** | `/name-auto` | Force re-derive (works even if already named) |

### Fallback

If the structured pipeline produces an empty name (all resolvers fail AND LLM
fails), falls back to old-style 2–4 word kebab-case LLM naming.

### Safety

- Guards `ctx.hasUI` — silent in detached sessions and sub-agents
- `/name-auto` ignores `named` flag; auto-triggers respect it
- All git/gh calls fail silently with graceful degradation
- `gh` calls use 3s timeout — no blocking

## Install

Symlink into your extensions directory:

```bash
ln -s /path/to/pi-extensions/namenag ~/.pi/agent/extensions/namenag
```

## Test

```bash
cd pi-extensions/namenag && npx tsx --test test/namenag.test.ts
```
