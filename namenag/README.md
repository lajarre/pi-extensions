# namenag

Auto-name unnamed Pi sessions before they get lost in `/resume`.

## How It Works

| Trigger | Threshold | Action |
|---------|-----------|--------|
| **Soft** | ≥10 user turns | Toast: "Session unnamed — `/name` to set one." |
| **Hard** | ≥50 user turns | LLM generates name → `setSessionName()` → toast |
| **Hard** | Compaction | LLM generates name → `setSessionName()` → toast |

Once a session is named (manually or auto), all reminders stop.

### LLM Naming

Automatically picks the cheapest available model (by input token cost)
and sends it the first ~500 characters of user message text. Generates a
2–4 word kebab-case name. Falls back to the session's current model if
no cheaper alternative is found.

Zero configuration required.

### Safety

- Guards `ctx.hasUI` — silent in detached sessions and sub-agents
- Never blocks — uses `notify()` only, no modal dialogs
- Idempotent — generating flag prevents concurrent LLM calls
- Lightweight — sends ≤500 chars of text, not the full conversation

## Install

Symlink into your extensions directory:

```bash
ln -s /path/to/pi-extensions/namenag/namenag.ts ~/.pi/agent/extensions/namenag.ts
```

Or run directly:

```bash
pi --extension /path/to/pi-extensions/namenag/namenag.ts
```

## Test

```bash
npx tsx --test test/namenag.test.ts
```
