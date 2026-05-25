# pi-extensions

Personal [pi](https://github.com/badlogic/pi) extensions bundle — coherent set of extensions used in my daily workflow.

## Extensions

| Name | Description |
|------|-------------|
| `vim-bindings/` | Vim-like modal editing with system clipboard integration |
| `nym/` | Auto-name unnamed sessions before they get lost in `/resume` |
| `bref.ts` | Toggle condensed display via `/bref` |
| `feed-timestamps.ts` | Add right-aligned `yyyy-mm-dd hh:mm:ss` feed timestamps via upstream-compatible monkey patches |
| `compaction-model.ts` | Use a cheaper model for context compaction |
| `codex-fast.ts` | Toggle OpenAI Codex Fast mode via `/fast` |
| `fork-rename.ts` | Auto-rename forked sessions |
| `post-compact-reminder.ts` | Remind after compaction events |
| `protect-paths.ts` | Guard `.git` paths, block dangerous delete flows, and add macOS `move_to_trash` |
| `github-write-approval/` | Gate public GitHub CLI writes from `bash` tool calls |
| `move-session.ts` | Move a session to another directory and relaunch pi there |
| `copy-session-id.ts` | Copy current session ID via `/sid` or `F8` |
| `spawn-worker.ts` | Tmux worker spawn + session-control orchestration |
| `todos.ts` | Todo management extension |

## Codex Fast

`codex-fast.ts` adds `/fast` for ChatGPT-authenticated OpenAI Codex models that support Fast mode (`gpt-5.5` and `gpt-5.4`). When enabled, eligible provider requests include `service_tier: "priority"`.

```text
/fast
/fast on
/fast off
/fast auto
/fast status
```

Auto mode is off by default. Enable it per process with `PI_CODEX_FAST=1`, globally with `~/.pi/agent/extensions/openai-fast.json`, or per project with `.pi/openai-fast.json`:

```json
{ "enabled": true }
```

The extension checks the active model's OAuth state and only rewrites payloads matching Pi's OpenAI Codex Responses request shape. Pi's `before_provider_request` hook currently exposes the provider payload but not the actual request model/provider, so exact provider-auth verification for every possible concurrent request would require an upstream hook change.
