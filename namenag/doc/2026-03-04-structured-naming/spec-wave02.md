# Wave 02 — Add project + worktree segments for global uniqueness

## Problem

Session names must be unique across concurrent live sessions (referenced by
name via `list_sessions` / `send_to_session`). Current structured naming
omits project and worktree segments, creating collision risk between repos.

## Changes

1. **`resolveProject(cwd, exec)`** — walk cwd upward: (1) git remote → extract
   repo name from URL, (2) nearest `project.org`/`area.org` → dirname, (3) stop
   before `~/`. Fallback: cwd basename. Cap 12 chars, truncate with `…`.

2. **`resolveWorktreeName(cwd, exec)`** — if `detectWorktree` reports linked
   worktree, return the worktree leaf name (prefix-stripped via existing
   `stripWorktreePrefix`). Cap 12 chars. Return null if not a linked worktree.

3. **Update `structuredName`** — prepend project and worktree segments:
   `[project, worktree, branch, pr, subfolder, description]`

4. **Update assembler call** — no changes to `assembleSegments` itself, just
   pass 6 segments instead of 4.

5. **Update tests** — new resolver tests + update all integration tests that
   assert on assembled names (they now have project prefix).

## Segment order (final)

```
project : worktree : branch : pr : subfolder : description
  12        12        12     free     12          20
```

## QA

```bash
cd /Users/alex/workspace/aidev/pi-extensions/namenag && npx tsx --test test/namenag.test.ts
```

Pass: all tests green. Failure: fix and retry.

## Constraints

- No new files — add resolvers to existing `resolve.ts`
- Update existing integration tests, don't duplicate
- `resolveProject` must handle: git remote parse, no-git fallback, bare URL formats
  (`git@github.com:org/repo.git`, `https://github.com/org/repo.git`, `https://github.com/org/repo`)
