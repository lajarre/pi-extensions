# 0001. accept single extension file past 500 loc

date: 2026-03-08

## status

accepted

## context

AGENTS.md guideline: "Files < ~500 LOC; split/refactor when
exceeded." Wave-01 shipped `spawn-worker.ts` at ~605 LOC.
Wave-02 adds worker registry, `/workers`, `/send-worker`,
drift enforce mode, and supporting helpers — pushing the
file to ~1000 LOC (~2x the guideline).

The spec anticipated this: "keep single extension file
approach unless file >500 loc pressure is severe."

Splitting during active feature development adds module
boundary complexity (export surface, import wiring, test
harness changes) while the internal API is still evolving
across waves.

## decision

Keep `spawn-worker.ts` as a single file through wave-02.
Plan a split as post-wave cleanup when the API stabilizes.

## alternatives considered

### split now into domain modules

- Pros: respects 500 LOC guideline immediately;
  clearer separation of concerns (registry, commands,
  drift, spawn core).
- Cons: adds module boundary churn mid-feature; test
  harness needs rework for multi-file imports; internal
  API still evolving — premature boundaries may need
  re-drawing in later waves.

### accept and defer split

- Pros: fast iteration; no boundary decisions while API
  is in flux; single import for tests.
- Cons: growing maintenance burden; harder to navigate;
  risk of "temporary" becoming permanent.

## consequences

- Positive: wave-02 shipped without structural churn.
  All 18 test suites pass against a single import.
- Negative: file is now ~1000 LOC. Next wave or
  post-wave cleanup must split (e.g. registry, commands,
  drift, core spawn) or document why not.
- Risk: if split keeps getting deferred, the file becomes
  harder to decompose as internal coupling grows.
