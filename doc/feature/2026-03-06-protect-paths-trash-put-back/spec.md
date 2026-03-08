# protect-paths: Trash integrity + Put Back semantics

## Summary

Some sessions bypass `move_to_trash` and run:

- `mv <path> ~/.Trash`

This bypasses extension guardrails and can weaken Finder `Put Back`
behavior. We need one canonical deletion-to-Trash path.

## Problem

Current behavior allows two paths:

1. Preferred: `move_to_trash` tool (Finder first, fs fallback)
2. Bypass: direct bash `mv ... ~/.Trash`

Risks:

- bypasses workspace/path validation in `move_to_trash`
- bypasses extension policy intent (`use move_to_trash`)
- inconsistent `Put Back` metadata/UX
- operational drift across sessions

## Goals

1. Block manual Trash moves in bash.
2. Preserve Finder-native `Put Back` semantics.
3. Keep delete flow predictable and recoverable.

## Non-goals

- Build a restore tool.
- Intercept every `mv` command.
- Support non-macOS Trash semantics in this change.

## Scope (V1)

### In scope

1. Detect and block bash commands that move content into macOS Trash.
2. Force deletion-to-Trash through `move_to_trash` only.
3. Make `move_to_trash` Finder-only (fail closed if Finder delete fails).
4. Add/adjust tests for direct and wrapped Trash-move bypasses.

### Out of scope

- New slash commands.
- New UI flows for restore.
- Multi-platform Trash abstraction.

## Functional requirements

### FR-1: Block manual Trash moves in bash

On macOS (`MACOS_TRASH_SUPPORTED`), block commands whose effective
operation is `mv` into Trash path forms, including:

- `~/.Trash`
- `$HOME/.Trash`
- `${HOME}/.Trash`
- absolute `${HOME}/.Trash`
- children of those paths

Cover direct + wrapped/nested forms already parsed by existing logic:

- wrapper chains (`env`, `sudo`, `command`, `exec`, etc.)
- `xargs` execution
- `find -exec` execution

Return block reason:

- `Manual Trash moves are blocked. Use move_to_trash.`

### FR-2: Keep non-Trash mv behavior unchanged

Do not block normal `mv` operations that do not target Trash.

### FR-3: Finder-only move_to_trash

`move_to_trash` must:

- validate target as today (workspace, root/home/cwd guards, protected)
- use Finder delete path
- if Finder delete fails, return error (no fs rename fallback)

Rationale: preserve Finder metadata required for reliable `Put Back`.

### FR-4: Guidance consistency

All block reasons and prompts should point users to `move_to_trash` as
single deletion path.

## Acceptance criteria

1. `bash: mv file ~/.Trash` is blocked on macOS.
2. `bash: mv file "$HOME/.Trash"` is blocked on macOS.
3. wrapped form `env mv file ~/.Trash` is blocked.
4. indirect form via `xargs`/`find -exec` into Trash is blocked.
5. `bash: mv file ./backup` is not blocked by Trash-specific rule.
6. `move_to_trash` succeeds via Finder when Finder is available.
7. if Finder delete fails, tool returns explicit error and does not
   fallback to filesystem rename.

## QA plan

- Add targeted tests under `pi-extensions/test/` for:
  - direct Trash destination forms
  - wrapper/xargs/find-exec forms
  - non-Trash control cases
  - Finder failure path (assert no fs fallback path taken)

- Run project checks used for this repo (lint/type/test as available).

## Risks

- Finder-only tool may fail in restricted automation environments.
- Stricter blocking could surprise flows relying on `mv ~/.Trash`.

Mitigation:

- clear error text with next step
- keep scope tight to explicit Trash destinations

## Rollout notes

- Implement in `protect-paths.ts` only.
- Keep changes atomic and behavior-focused.
- Update extension docs/comments if wording changes.
