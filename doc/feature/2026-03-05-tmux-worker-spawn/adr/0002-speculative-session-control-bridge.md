# 0002. build /send-worker against speculative session-control bridge

date: 2026-03-08

## status

accepted

## context

The `/send-worker` command needs a transport to deliver
messages to spawned worker sessions. The spec defines a
session-control CLI bridge using flags:

```
pi -p --session-control \
  --control-session <worker-name> \
  --send-session-message <message> \
  --send-session-mode follow_up \
  --send-session-wait message_processed
```

These flags (`--control-session`, `--send-session-message`,
`--send-session-mode`, `--send-session-wait`) do not exist
in the current `pi --help` output. The bridge call will
fail at runtime until pi implements them.

The plan explicitly noted: "Build per spec, mock in tests,
fallback on failure."

## decision

Build `sendWorkerMessage()` against the speculative bridge
API. Mock the `pi` exec call in tests. On bridge failure
(non-zero exit), return an error plus a human-readable
fallback instruction containing the exact CLI invocation
the user can run manually.

## alternatives considered

### wait for pi to ship the bridge flags

- Pros: no dead code; feature works immediately on ship.
- Cons: blocks the entire `/send-worker` feature; can't
  test or iterate on the command UX until flags land.

### use tmux send-keys as primary transport

- Pros: works today; no dependency on unshipped pi CLI.
- Cons: couples worker messaging to the terminal layer;
  send-keys is fragile (input race conditions, shell
  escaping); diverges from session-control architecture
  the spec is building toward.

### stub the command with no transport

- Pros: placeholder ready for wiring.
- Cons: no test coverage for arg construction or error
  paths; false sense of feature completeness.

## consequences

- Positive: bridge arg construction is tested (suite 16);
  fallback error path is tested (suite 17); feature
  "lights up" automatically when pi ships the flags.
- Negative: the bridge effectively always fails today —
  the fallback instruction becomes the de facto UX until
  pi implements `--control-session` et al.
- Coupling: the extension is now coupled to a specific
  pi CLI flag contract. If pi ships different flag names,
  `buildSendWorkerBridgeArgs` and
  `buildSendWorkerFallback` need updating.
