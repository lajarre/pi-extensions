# wave-01 ADR note — no ADRs needed

Date: 2026-03-06

## rationale

No ADR-worthy architectural decisions emerged during wave-01
implementation. The spec was prescriptive enough to cover all
non-obvious design choices:

- **naming model** (frozen namespace, persisted counter,
  slot-consuming custom suffixes) — spec §Naming Model
- **persistence via `appendEntry` latest-entry-wins** —
  spec §Persistence Model
- **two-phase tmux flow** (split-window → send-keys) —
  spec §Spawn Execution steps 4-5
- **warn-only drift policy** — spec §Worker Managed-Mode
- **`sessionDirMode` as compile-time constant** —
  spec §Session-dir Policy
- **inline env vars in `send-keys` payload** — only
  viable option; `tmux set-environment` is session-scoped

## review iterations

Batch-01 try-01 failed on a compliance gap
(`warnOnDrift` not exported per plan acceptance criteria).
Batch-02 try-01 failed on missing direct inherit-mode test
coverage. Both were specification-compliance corrections,
not architectural pivots.

## existing ADR directory

No `adr/` directory exists for this feature yet; none
created because no decisions warranted recording.
