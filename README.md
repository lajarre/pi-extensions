# pi-extensions

Personal [Pi](https://github.com/badlogic/pi) extension bundle used for feed ergonomics, session handling, orchestration, safety gates, and small workflow shortcuts.

There is no single bundle entry point. Each file or directory is an independent extension; load only the pieces needed for a given setup.

## catalog

| extension | interface | purpose |
|---|---|---|
| [`anycopy-shortcut.ts`](anycopy-shortcut.ts) | `Ctrl+Shift+T` | Resolve the installed `pi-anycopy` package and open its picker. |
| [`blaz/`](blaz/) | automatic | Replace the footer with cwd, branch, model, token, context, and cost data; show the session name above the editor. |
| [`bref.ts`](bref.ts) | `/bref`, `Ctrl+Shift+B` | Switch between regular, detail, and condensed feed rendering. |
| [`codex-fast.ts`](codex-fast.ts) | `/fast` | Toggle OpenAI Codex priority processing for supported ChatGPT-authenticated models. |
| [`copy-session-id.ts`](copy-session-id.ts) | `/sid`, `/session-id`, `F8` | Copy the current session ID and show temporary feedback. |
| [`feed-timestamps.ts`](feed-timestamps.ts) | automatic | Add right-aligned timestamps and visual rules to feed rows. |
| [`fork-rename.ts`](fork-rename.ts) | automatic | Rename forked sessions with incrementing `-forkN` suffixes. |
| [`github-write-approval/`](github-write-approval/) | automatic | Classify `gh` commands, allow supported private-repo writes, and require review for supported public-repo writes. See its [policy and limits](github-write-approval/README.md). |
| [`move-session.ts`](move-session.ts) | `/move-session` | Move a session into another cwd bucket, preserve session control, and relaunch Pi there. |
| [`nym/`](nym/) | `/nym` | Derive structured session names and remind or auto-name long unnamed sessions. See the [nym guide](nym/README.md). |
| [`post-compact-reminder.ts`](post-compact-reminder.ts) | automatic | After compaction, inject a reminder to reload project instructions and inspect current state. |
| [`protect-paths.ts`](protect-paths.ts) | `/no-protect`, `move_to_trash` | Guard protected paths and deletion flows; provide Finder-backed Trash handling on macOS. |
| [`session-recap.ts`](session-recap.ts) | automatic, CLI flags | Generate focus-return, idle, and resume recaps using the active model or an override. |
| [`spawn-worker.ts`](spawn-worker.ts) | `/spawn`, `/workers`, `/send-worker`, `spawn_worker` | Spawn tmux workers and coordinate them through Pi session control. |
| [`todos.ts`](todos.ts) | `/todos`, `todo` | Manage project-scoped `.pi/todos` through a tool and TUI overlay. |
| [`wiggum/`](wiggum/) | `/wiggum` | Run iterative quality loops with repository gates, optional review guidance, and spec binding. |

## loading

Load selected entry points through Pi's `extensions` setting or symlink them under `~/.pi/agent/extensions`. Directory extensions use their `index.ts` entry point.

Some extensions have external requirements:

- `anycopy-shortcut.ts` requires `pi-anycopy`.
- `github-write-approval/` requires the GitHub CLI.
- `spawn-worker.ts` requires tmux and Pi session control.
- `nym/`, `session-recap.ts`, and `wiggum/` require suitable model credentials.
- `protect-paths.ts` uses macOS-specific Finder integration for Trash behavior.

Extensions execute with the user's permissions. Safety extensions are guardrails, not a sandbox.

## bref

`bref.ts` provides three feed modes:

```text
/bref
/bref picker
/bref regular
/bref detail
/bref condensed
/bref cycle
```

The default shortcut is `Ctrl+Shift+B`. Override it with `bref.toggle` in `~/.pi/agent/keybindings.json`; the legacy `extension.bref.toggle` key remains accepted.

Condensed mode keeps selected lanes expanded and collapses the rest to one-line `↳...` rows. Default expanded lanes are `user`, `assistant`, and `custom`. `/bref picker` changes the active lanes; `Ctrl+S` saves defaults to `~/.pi/agent/bref.json`.

Thinking follows Pi's `Ctrl+T` display toggle rather than appearing in the picker. Visible thinking renders as label-only `↳thinking` rows without thought content; hidden thinking renders no row.

Condensed mode also removes spacer-only gaps and hides Pi update/package-update notice blocks. Regular and detail modes retain normal notice rendering.

`bref.ts` and `feed-timestamps.ts` currently patch Pi's private feed components. Re-test both after Pi upgrades that change interactive rendering internals.

## codex fast

`codex-fast.ts` supports:

```text
/fast
/fast on
/fast off
/fast auto
/fast status
```

When enabled, eligible OpenAI Codex Responses requests include `service_tier: "priority"`. The extension only applies this to ChatGPT-authenticated models on its exact verified allowlist:

- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.6-sol`
- `gpt-6-astra`
- `gpt-6-sol`
- `gpt-6-luna`
- `gpt-6.1-sol`
- `gpt-6.1-terra`

As verified on 2026-10-27, OpenAI's [Codex Speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed) lists Fast for the current GPT-6 Astra, Sol, Luna, 6.1 Sol, and 6.1 Terra models. Its [API Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode) explicitly documents `gpt-5.6-sol` and says `service_tier: "priority"` and `"fast"` are equivalent. This extension retains `"priority"` for compatibility, along with its existing legacy `gpt-5.4` and `gpt-5.5` entries.

The same Codex Speed documentation describes GPT-5.6 Fast as 1.5x faster and states that Fast consumes ChatGPT subscription allowance at 2.5x the Standard rate and purchased credits at 2x. Check the source before enabling it if usage matters.

Auto mode is off by default. Enable it per process with `PI_CODEX_FAST=1`, globally with `~/.pi/agent/settings.json`, or per project with `.pi/settings.json`:

```json
{ "codexFast": { "enabled": true } }
```

Legacy `openai-fast.json` files remain readable when the Pi settings key is absent. After changing configuration, run `/reload`, then `/fast status` to confirm the effective mode and current-model eligibility.

Unknown or future model IDs, variants, and Spark models remain denied until individually verified and added. This local denial means only that the extension has not verified the exact ID; it does not establish upstream incompatibility. Pi's model metadata does not expose Codex `additional_speed_tiers`, so the extension deliberately does not auto-discover or automatically accept models.

Pi's `before_provider_request` hook exposes the serialized request but not its actual model/provider identity. The extension therefore validates the active session model, exact provider and API, ChatGPT OAuth, and the provider payload shape, but cannot prove exact identity for every possible concurrent request. Existing non-null `service_tier` values are left unchanged.

## development

Install dependencies and run the root gates:

```bash
npm ci
npm run lint
npm run check
npm test
npm run test:fixtures
```

Focused tests also live beside `blaz/`, `nym/`, and `wiggum/`; run the owning tests when changing those extensions.

## specs

Feature specs, plans, review reports, and loop artifacts live in the local sibling `pi-extensions.spec` companion repository under `feature/`.
