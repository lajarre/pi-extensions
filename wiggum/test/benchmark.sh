#!/usr/bin/env bash
set -euo pipefail

# ── paths ────────────────────────────────────────────────────────
TEMPLATE_REPO="/Users/alex/workspace/aidev/_tmp/wigetest-template"
REFERENCE_REPO="/Users/alex/workspace/aidev/_tmp/wigtest"
REFERENCE_BRANCH="review/self-review-cleanup"
REFERENCE_COMMIT="709abac"
TEMPLATE_COMMIT="220893f"

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

info "writing doc/review-guidelines.md"
mkdir -p "$WORKDIR/run/doc"
cat > "$WORKDIR/run/doc/review-guidelines.md" << 'GUIDELINES_EOF'
# Review Guidelines

## review criteria

Flag issues that:
- Meaningfully impact accuracy, performance, security, or
  maintainability
- Are discrete and actionable
- Were introduced in the changes being reviewed
- The author would likely fix if aware of them

Do NOT flag:
- Pre-existing issues outside the current changes
- Style preferences enforced by formatters/linters
- Speculative impact without provable affected code

### Priority levels

Tag each finding:
- [P0] Blocking. Drop everything.
- [P1] Urgent. Next cycle.
- [P2] Normal. Fix eventually.
- [P3] Low. Nice to have.

### Review priorities

- Call out new dependencies and justify them
- Prefer simple solutions over unnecessary abstractions
- Favor fail-fast over logging-and-continue
- Flag dead code, unused state, unreachable branches
- Check error handling (codes not messages, no silent swallow)
- Check untrusted input (SQL injection, open redirects, SSRF)

## Project-specific

1. **CLI / data-path** — binary uses a fixed `todo-data.json` in
   cwd with no CLI option or env override for the data path.
2. **Explicit command** — `add_todo` validates `trim()` but stores
   the raw string, so titles keep accidental leading/trailing
   whitespace.
3. **CLI notes support** — CLI lacks a way to attach notes or
   descriptions to todo items beyond the title.
4. **Demo behavior** — `reminder_report` reminds about items with
   `done == true`, which is backwards for a todo reminder loop.
5. **Graceful shutdown** — `watch` aborts the spawned task rather
   than shutting it down through an explicit cancellation path.
6. **Persistence** — rewrites the whole JSON file on every
   mutation; reviewer should call out the scaling trade-off.
7. **Title / reminder / order** — `list` orders by
   `(done, title.len(), id)` instead of a stated product rule;
   visible order is surprising and unstable.
8. **Dead state** — flag dead code, unused state, unreachable
   branches in the codebase.
9. **CLI parse tightening** — rustfmt drift and unused locals in
   `main.rs` that `cargo clippy -- -D warnings` should reject.
10. **Error rendering** — check error handling, codes not messages,
    no silent swallow.
11. **Docs alignment** — tests cover the happy path only; no
    exercise for reminder behavior, no check for ordering
    semantics, and no ctrl-c/watch test.
GUIDELINES_EOF

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
pi -p --no-session \
  "$PI_PROMPT" \
  > "$WORKDIR/wiggum-output.txt" 2>&1 \
  || true

info "pi finished, output saved to wiggum-output.txt"

# try to grab the most recent wiggum log
WIGGUM_LOG="$(find ~/.pi/agent/sessions -name 'wiggum-log.jsonl' \
  -newer "$WORKDIR/wiggum-output.txt" -o \
  -name 'wiggum-log.jsonl' 2>/dev/null \
  | xargs ls -t 2>/dev/null | head -1 || true)"

if [ -n "$WIGGUM_LOG" ]; then
  cp "$WIGGUM_LOG" "$WORKDIR/wiggum-log.jsonl"
  info "copied wiggum log"
else
  # fallback: grab the most recent one period
  WIGGUM_LOG="$(find ~/.pi/agent/sessions -name 'wiggum-log.jsonl' \
    2>/dev/null | xargs ls -t 2>/dev/null | head -1 || true)"
  if [ -n "$WIGGUM_LOG" ]; then
    cp "$WIGGUM_LOG" "$WORKDIR/wiggum-log.jsonl"
    info "copied wiggum log (fallback: most recent)"
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

diff -rq "$WORKDIR/run/src" "$WORKDIR/reference/reference/src" \
  > "$WORKDIR/wiggum-changes.txt" 2>&1 || true

diff -ru "$WORKDIR/reference/reference/src" "$WORKDIR/run/src" \
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
