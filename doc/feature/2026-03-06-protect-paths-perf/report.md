# protect-paths perf impact report

Date: 2026-03-06
Scope: `protect-paths.ts`

## Method

Microbench via a mocked `ExtensionAPI` harness:
- load extension
- register hooks/tools
- invoke `tool_call` handlers directly
- measure per-call latency (warm + cold)

Runtime notes:
- machine: local macOS dev box
- `just-bash` missing in this environment
- extension ran in fallback heuristic mode (no AST parser)
- local `@sinclair/typebox` test stub was patched in harness

So numbers are directional, not production absolute.

## Results

### 1) Bash guard overhead (tool_call path)

Warm latency per call:
- safe short command (`echo hello world`): ~0.0045–0.0082 ms
- safe complex pipeline: ~0.0190–0.0262 ms
- dynamic command blocked path (`$CMD target`): ~0.0035–0.0051 ms

Cold first bash call (lazy parser load attempt):
- ~2.88 ms first call
- subsequent cold-ish calls near ~0.03–0.06 ms

### 2) File-tool path guard overhead

Warm latency per call:
- `read` plain path: ~0.021–0.040 ms
- `grep` with glob candidate: ~0.058–0.061 ms

### 3) move_to_trash tool overhead

Single-file benchmark (8 runs, new temp file each run):
- avg: 136.117 ms
- min: 132.012 ms
- max: 141.203 ms

Interpretation: dominated by Finder/OS-level trash operation, not guard logic.

## Impact summary

- Guard logic overhead for normal tool calls is tiny (sub-0.1 ms).
- First bash call pays one-time lazy-load cost (~3 ms in this env).
- `move_to_trash` is orders of magnitude slower (~136 ms/file),
  expected for OS trash semantics.

## Risk notes

Because this run used fallback mode (no `just-bash`), do one extra run
with `just-bash` installed to confirm AST-mode overhead in your real setup.

Expected trend: AST mode should be somewhat slower than fallback heuristics,
but still negligible compared to shell process execution time.
