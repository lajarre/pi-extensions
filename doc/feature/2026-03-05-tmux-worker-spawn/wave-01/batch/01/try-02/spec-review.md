PASS

## requirement matrix

| requirement | pass/fail | evidence |
|---|---|---|
| scope: batch 01 = tasks 1-3 only | pass | `.../wave-01/batches.md:3` |
| t1-r1 types + config constant | pass | `spawn-worker.ts:12-15` (`SpawnState`), `:73` (`sessionDirMode`) |
| t1-r2 suffix sanitizer rules | pass | `spawn-worker.ts:143-149,151-153`; `:69` (`MAX_SUFFIX_LENGTH=64`) |
| t1-r3 `/spawn` parser rules | pass | `spawn-worker.ts:94-106,109,115` |
| t1-r4 persistence helpers | pass | `spawn-worker.ts:180-183` (latest custom wins), `:191` (`appendEntry`) |
| t1-r5 naming model + counter | pass | `spawn-worker.ts:214-221,229` (frozen ns + next slot), `:204,206` (name forms), `:381` (persist incremented state) |
| t1-a1 all functions exported (prior gap) | pass | prior fail: `.../try-01/spec-review.md:15,49-50`; fixed: `spawn-worker.ts:503` (`export function warnOnDrift`); top-level decls all exported: `spawn-worker.ts:75-503` via `grep "^(export )?(async )?function|^(export )?class"` |
| t1-a2 no module side effects | pass | module has declarations; wiring calls are inside default export `spawn-worker.ts:525-599`; top-level `^pi\.` grep: no matches |
| t2-r1 tmux runtime validation | pass | `spawn-worker.ts:234-237` (`TMUX` check), `:246-253` (`tmux -V` check), called in `:363-364` |
| t2-r2 parent-name precondition + guidance | pass | `spawn-worker.ts:194-198` (`/name` guidance), called before split in `:366-370` |
| t2-r3 split-window args + pane targeting | pass | `spawn-worker.ts:271-276` (`split-window -d -{v|h} -P -F`), `:272-275` (`TMUX_PANE` targeting) |
| t2-r4 child launch payload + session-control | pass | `spawn-worker.ts:322-325` (`PI_WORKER_*`), `:328` (`pi --session-control`), `:333` (`cd -- <cwd>`), `:341-346` (`tmux send-keys`) |
| t2-r5 persist state + confirmation | pass | `spawn-worker.ts:380-381` (send then save), `:391-392` (pane id + child name message) |
| t2-r6 session-dir policy default/inherit | pass | `spawn-worker.ts:73` (default), `:314-315` (inherit gate), `:330` (append `--session-dir`) |
| t2-r7 required error cases | pass | `spawn-worker.ts:109,125` (invalid split), `:153` (empty suffix), `:197` (unnamed parent), `:237` (not in tmux), `:250-253` (tmux unavailable), `:295` (split fail), `:352` (dispatch fail) |
| t2-r8 `/spawn` command wiring | pass | `spawn-worker.ts:546-567` |
| t2-r9 `spawn_worker` tool wiring | pass | `spawn-worker.ts:569-599` |
| t2-a1 default export wires command + tool | pass | `spawn-worker.ts:525,546,569` |
| t2-a2 command/tool share core logic | pass | both paths call `runSpawnWorker`: `spawn-worker.ts:559,591` |
| t2-a3 coupling stated in help text | pass | command text `spawn-worker.ts:548`; tool text `:572-574` |
| t2-r10 `pi.exec` + quoting usage | pass | tmux via `pi.exec`: `spawn-worker.ts:246,292,341`; quoting helper + use: `:306,322-333` |
| t3-r1 managed worker auto-name on start | pass | managed env read `spawn-worker.ts:436`; set name on `session_start`: `:529-531` |
| t3-r2 managed metadata custom entry | pass | entry builder `spawn-worker.ts:450-460`; append on start `:534-536` |
| t3-r3 drift detection on relevant events | pass | event hooks `spawn-worker.ts:529,542`; managed gate `:509`; namespace-family check `:477-478`; warning path `:519` |
| t3-a1 warn-only drift policy | pass | message explicitly warn-only `spawn-worker.ts:498-499`; behavior warns only `:519`; only rename call is startup env apply `:531` |

## file/command references

files read:
- `doc/feature/2026-03-05-tmux-worker-spawn/spec.md`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/plan.md`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batches.md`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-02/implementer.md`
- `spawn-worker.ts`
- `doc/feature/2026-03-05-tmux-worker-spawn/wave-01/batch/01/try-01/spec-review.md`

commands used (key snippets):
- `grep` prior gap: `.../try-01/spec-review.md:15` shows
  `t1-a1 ... fail` for non-export `warnOnDrift`.
- `grep` current fix: `spawn-worker.ts:503` shows
  `export function warnOnDrift(`.
- `grep` top-level declarations: all matched declarations in
  `spawn-worker.ts:75-503` are exported.
- `grep '^pi\\.' spawn-worker.ts` -> `No matches found`.

full tasks 1-3 compliance holds. prior gap is fixed. c'est bon.
