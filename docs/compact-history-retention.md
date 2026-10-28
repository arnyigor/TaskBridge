# Compact history retention — server-side prerequisite

## Confirmed defect

A successful compact between message_start and message_end makes the preceding deltas necessary to reconstruct the visual boundary. Previously both `trimStreamingDeltas` (history response) and `TaskStore.pruneStreamingDeltas` (SQLite cleanup) removed them. The final message text alone does not retain the offset of that boundary.

Minimal tests failed before the fix: SQLite deleted two required deltas, and live/replayed ChatState projections differed after response trimming.

## Change

- Preserve deltas only for closed messages containing a successful compaction_end or auto_compaction_end.
- Continue pruning unrelated completed messages and leave in-progress messages untouched.
- No schema change, migration, runtime upgrade or user data rewrite.
- Context-limit regression asserts a persisted compact result without an extra agent_start or user message.

## Verification

`node --test --test-force-exit tests/store.test.mjs tests/event-trim.test.mjs tests/context-limit.test.mjs`: **24 PASS, 0 FAIL, 0 SKIP**.

Working-tree integration checks (also include not-yet-committed Web projection): real-Pi normalized fixture persisted through SQLite, reopened and history-trimmed — matching live projection; prior `npm run check` passed; prior full `npm test` passed **1695/1699**, with **4 SKIP** and no failures. Two subsequent standalone trimming cases were then added and passed in the 24-test command above.

## Limits

This commit is the server-side retention prerequisite, not the complete Compact fix. Web projection is separate; KMP, real server/SSE acceptance, pagination and large-history performance remain open. The live user server was not restarted. Earlier already-pruned deltas cannot be reconstructed by this change.
