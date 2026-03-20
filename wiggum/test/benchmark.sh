#!/usr/bin/env bash
set -euo pipefail

# ── paths ────────────────────────────────────────────────────────
TEMPLATE_REPO="/Users/alex/workspace/aidev/_tmp/wigetest-template"
REFERENCE_REPO="/Users/alex/workspace/aidev/_tmp/wigtest"
REFERENCE_BRANCH="review/self-review-cleanup"
REFERENCE_COMMIT="709abac"
TEMPLATE_COMMIT="558dd3a"

STAMP="$(date +%Y%m%d-%H%M%S)"
WORKDIR="_tmp/wigtest-bench-${STAMP}"

info() { echo "▸ $*" >&2; }

# ── phase 1: setup ──────────────────────────────────────────────
info "phase 1 — setup"

mkdir -p "$WORKDIR"
WORKDIR="$(cd "$WORKDIR" && pwd)"
info "workdir: $WORKDIR"

info "cloning template repo"
git clone "$TEMPLATE_REPO" "$WORKDIR/run" --quiet

info "writing doc/review-guidelines.md (committed)"
mkdir -p "$WORKDIR/run/doc"
cat > "$WORKDIR/run/doc/review-guidelines.md" << 'GUIDELINES_EOF'
# Review Guidelines

<EXTREMELY-IMPORTANT>
You MUST read ALL source files in their entirety, not just the
diff. The diff shows what changed, but many issues are only
visible by reading the full file. Read every .rs file in src/
before making any judgment.

You MUST fix every item in the project-specific checklist below.
Do NOT just note issues — fix them in the code. If an item says
"add X", add it. If it says "remove Y", remove it. Noting an
issue without fixing it is a failed review.
</EXTREMELY-IMPORTANT>

## Review criteria

Fix issues that:
- Impact accuracy, performance, security, or maintainability
- Are discrete and actionable
- The author would fix if aware of them

Do NOT fix:
- Style preferences enforced by formatters/linters

### Priority levels

Tag each fix:
- [P0] Blocking — fix immediately
- [P1] Urgent — fix in this pass
- [P2] Normal — fix in this pass
- [P3] Low — fix if time permits

### General review priorities

- Remove dead code, unused state, unreachable branches
- Check error handling (codes not messages, no silent swallow)
- Prefer simple solutions over unnecessary abstractions
- Favor fail-fast over logging-and-continue

## Project-specific checklist

You MUST address ALL of the following. Read the full source
files to find and fix each one.

1. **CLI / data-path**: `main.rs` hardcodes `"todo-data.json"`.
   FIX: add `--data <path>` CLI arg and `WIGTEST_DATA_PATH` env
   var support. Default to `"todo-data.json"` when neither set.

2. **Title storage**: `add_todo` validates with `trim()` but
   stores the raw untrimmed string. FIX: store the trimmed title.

3. **CLI notes support**: the `TodoItem` struct has a `notes`
   field but the CLI has no way to set it. FIX: add
   `--note <text>` option to the `add` command.

4. **Demo behavior**: the `demo` command hardcodes `complete(1)`.
   FIX: complete the item that was just created (use its
   returned id), not a hardcoded id.

5. **Graceful shutdown**: `watch` uses `abort()` to kill the
   reminder task. FIX: use cooperative shutdown via a channel
   (e.g., `tokio::sync::mpsc` or `tokio::sync::oneshot`).

6. **Persistence safety**: `persist()` writes directly to the
   data file. FIX: write to a temp file first, then rename
   (atomic). Rollback in-memory state if the write fails.

7. **Reminder filter**: `reminder_report` includes completed
   items. FIX: filter to pending items only (`!todo.done`).
   Also fix list sort: change from `(done, title.len(), id)` to
   `(done, id)`.

8. **Dead state**: look for fields/state that is written but
   never read. FIX: remove them entirely (not just comment out).

9. **Hook bait**: `main.rs` has rustfmt drift and an unused
   local variable. FIX: format the code and remove the unused
   variable.

10. **Error rendering**: if `main` returns `Result` directly, the
    output shows `Error: Usage("...")`. FIX: catch errors and
    print clean user-facing messages via `Display`, then exit
    with non-zero code.

11. **Docs / tests**: README and REVIEWER_EXPECTATIONS.md may not
    match actual behavior after fixes. FIX: update them. Also
    add tests for reminder filtering, ordering, and any new CLI
    features.
GUIDELINES_EOF
(cd "$WORKDIR/run" && git add doc/review-guidelines.md && \
  git commit -m "add review guidelines" --quiet)

info "verifying fixture is broken"
FIXTURE_OK=true
if (cd "$WORKDIR/run" && cargo fmt --all --check >/dev/null 2>&1); then
  info "ABORT: cargo fmt --check passed (expected failure)"
  FIXTURE_OK=false
fi
if (cd "$WORKDIR/run" && cargo clippy -- -D warnings >/dev/null 2>&1); then
  info "ABORT: cargo clippy passed (expected failure)"
  FIXTURE_OK=false
fi
if (cd "$WORKDIR/run" && cargo test >/dev/null 2>&1); then
  info "ABORT: cargo test passed (expected failure)"
  FIXTURE_OK=false
fi
if [ "$FIXTURE_OK" = false ]; then
  info "fixture is not properly broken — aborting"
  exit 1
fi
info "fixture confirmed broken ✓"

# ── phase 2: run wiggum ─────────────────────────────────────────
info "phase 2 — running wiggum"

PI_PROMPT="Use the wiggum_loop tool to start a quality review loop with scope 'uncommitted'. Max iterations 15. Wait for it to complete. When done, report the full LoopResult JSON and read the wiggum log file."

info "launching pi (this may take a while)…"
(cd "$WORKDIR/run" && pi -p --no-session \
  "$PI_PROMPT" \
  > "$WORKDIR/wiggum-output.txt" 2>&1) \
  || true

info "pi finished, output saved to wiggum-output.txt"

# grab the wiggum log — check TMPDIR, /tmp, and session dirs
# macOS TMPDIR is /var/folders/..., not /tmp
SEARCH_DIRS="${TMPDIR:-/tmp} /tmp ${HOME}/.pi/agent/sessions"
WIGGUM_LOG="$(find $SEARCH_DIRS -maxdepth 4 \
  -name 'wiggum-log.jsonl' 2>/dev/null \
  | xargs ls -t 2>/dev/null | head -1 || true)"

if [ -n "$WIGGUM_LOG" ]; then
  cp "$WIGGUM_LOG" "$WORKDIR/wiggum-log.jsonl"
  info "copied wiggum log: $WIGGUM_LOG"
else
  # try to extract path from pi output
  LOG_FROM_OUTPUT="$(grep -o '/[^ ]*wiggum-log.jsonl' "$WORKDIR/wiggum-output.txt" | head -1 || true)"
  if [ -n "$LOG_FROM_OUTPUT" ] && [ -f "$LOG_FROM_OUTPUT" ]; then
    cp "$LOG_FROM_OUTPUT" "$WORKDIR/wiggum-log.jsonl"
    info "copied wiggum log from pi output: $LOG_FROM_OUTPUT"
  else
    info "warning: wiggum-log.jsonl not found"
  fi
fi

# ── phase 3: verification ───────────────────────────────────────
info "phase 3 — verification gates"

{
  echo "=== cargo fmt --all --check ==="
  (cd "$WORKDIR/run" && cargo fmt --all --check 2>&1) && \
    echo "PASS" || echo "FAIL (exit $?)"
  echo ""

  echo "=== cargo clippy -- -D warnings ==="
  (cd "$WORKDIR/run" && cargo clippy -- -D warnings 2>&1) && \
    echo "PASS" || echo "FAIL (exit $?)"
  echo ""

  echo "=== cargo test ==="
  (cd "$WORKDIR/run" && cargo test 2>&1) && \
    echo "PASS" || echo "FAIL (exit $?)"
} > "$WORKDIR/verification.txt" 2>&1

info "verification results saved"

# ── phase 4: comparison ─────────────────────────────────────────
info "phase 4 — comparison with reference"

cd "$REFERENCE_REPO"
git archive "$REFERENCE_BRANCH" --prefix=reference/ \
  | tar -xC "$WORKDIR"
cd - >/dev/null

diff -rq "$WORKDIR/run/src" "$WORKDIR/reference/src" \
  > "$WORKDIR/wiggum-changes.txt" 2>&1 || true

diff -ru "$WORKDIR/reference/src" "$WORKDIR/run/src" \
  > "$WORKDIR/diff-vs-reference.txt" 2>&1 || true

info "diffs generated"

# ── phase 5: scorecard ──────────────────────────────────────────
info "phase 5 — scorecard"

# extract loop summary from wiggum log if available
LOOP_SUMMARY="(wiggum-log.jsonl not found)"
if [ -f "$WORKDIR/wiggum-log.jsonl" ]; then
  LOOP_SUMMARY="$(tail -1 "$WORKDIR/wiggum-log.jsonl")"
fi

# extract verification summary
VERIFY_SUMMARY="(verification.txt not found)"
if [ -f "$WORKDIR/verification.txt" ]; then
  VERIFY_SUMMARY="$(cat "$WORKDIR/verification.txt")"
fi

cat > "$WORKDIR/scorecard.md" << SCORECARD_EOF
# Wiggum Benchmark Scorecard

Date: $(date)
Template: wigetest-template @ ${TEMPLATE_COMMIT}
Reference: wigtest ${REFERENCE_BRANCH} @ ${REFERENCE_COMMIT}

## Wiggum Loop Result

\`\`\`json
${LOOP_SUMMARY}
\`\`\`

## Verification Gates

\`\`\`
${VERIFY_SUMMARY}
\`\`\`

## Category Scoring

(placeholder — scored by reviewing diff-vs-reference.txt)

| # | Category | Status | Notes |
|---|----------|--------|-------|
| 1 | CLI/data-path | | |
| 2 | Explicit command | | |
| 3 | CLI notes support | | |
| 4 | Demo behavior | | |
| 5 | Graceful shutdown | | |
| 6 | Persistence | | |
| 7 | Title/reminder/order | | |
| 8 | Dead state | | |
| 9 | CLI parse tightening | | |
| 10 | Error rendering | | |
| 11 | Docs alignment | | |

## Files

- wiggum-output.txt — full pi output
- wiggum-log.jsonl — iteration log
- verification.txt — cargo fmt/clippy/test
- diff-vs-reference.txt — detailed diff against reference
- wiggum-changes.txt — summary of changed files
SCORECARD_EOF

info "done ✓"
echo "$WORKDIR/scorecard.md"
