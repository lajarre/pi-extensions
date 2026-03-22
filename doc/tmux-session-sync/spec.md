# tmux-session-sync — spec

## purpose

sync pi session UUID into tmux pane metadata so
`cspotcode/tmux-resurrect-metadata` can persist it across
reboot. enables later restore of pi sessions by UUID.

## events

### `session_start`

fired on initial session load.

### `session_switch`

fired on `/new` or `/resume`.

### `session_fork`

fired after `/fork`. new session file with new UUID is created;
pane metadata must update to the forked session's UUID.

## behavior

on all three events, if running inside tmux (`$TMUX` is set):

1. extract session UUID from session file path
   - path format: `<timestamp>_<uuid>.jsonl`
   - parse: `basename(path).replace(/\.jsonl$/, '').split('_').pop()`
   - validate extracted value matches UUID format
     (`/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i`)
   - if no session file or UUID extraction/validation fails → no-op

2. set pane option for resurrect-metadata persistence:
   ```
   tmux set-option -p @resurrect-metadata-pi-session <uuid>
   ```

3. set pane title for human visibility:
   ```
   tmux select-pane -T "pi:<first-8-chars-of-uuid>"
   ```

## non-goals (v1)

- no restore script (future: part 3 of the 3-part system)
- no shell hooks / zshrc fallback
- no `/rename` command
- no LLM calls
- no custom tools
- no session persistence via `pi.appendEntry()`

## error handling

- not in tmux → skip silently (check `$TMUX`)
- no session file → skip silently
- UUID extraction fails → skip silently
- `tmux` command fails → ignore (fire-and-forget)

## file

`tmux-session-sync.ts` in `pi-extensions/` root.

## prior art

- `pi-tmux-window-name` — closest reference for tmux +
  extension API patterns. uses `pi.exec("tmux", [...])`.
- `copy-session-id.ts` — existing extension in this repo.

## API surface used

- `pi.on("session_start", handler)`
- `pi.on("session_switch", handler)`
- `pi.on("session_fork", handler)`
- `ctx.sessionManager.getSessionFile()` — returns path or undefined
- `pi.exec("tmux", [...])` — run tmux commands

## implementation notes

- `getSessionFile()` returns absolute path like
  `~/.pi/agent/sessions/--path--/2026-03-22T14-30-45-123Z_7870c155-abc1-4def-8901-234567890abc.jsonl`
- UUID is the standard 36-char format (8-4-4-4-12)
- pane title prefix `pi:` chosen for grep-ability and
  disambiguation from other pane titles
- 8-char prefix is enough for visual identification while
  keeping the pane border label short
