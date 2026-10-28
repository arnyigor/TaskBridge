# COMPACT C11 — Web pagination across an exchange

## Reproduced defects

The real-Pi normalized fixture, loaded after seq 44 and then backfilled, lost AFTER entirely: prependOlder appended a separate historical answer while the tail remained in a detached window-start sink. A DOM case with existing notices additionally placed the reconstructed continuation above its notice.

A read-only independent review identified two more cases, both subsequently reproduced by Node tests before fixing:

- A message_end received after a steer was absent from prefix replay, changing completed AB back to A.
- A CANCELLED task snapshot was overwritten by reconstructed RUNNING state, reviving the answer.

## Change

- Buffer reducer-relevant events for the unresolved first exchange, including late completions still addressing its message/execution/tool sinks after a newer USER_MESSAGE.
- Replay its prefix in scratch and update the same live sink object. Keep cursor, tool/note identity, authoritative terminal state and message reconciliation state.
- Release the buffer once the exchange prefix is known. Tool bodies, write contents, progress snapshots and whole-conversation echoes are not retained for replay; existing live tool progress is reused.
- Reveal a size-cut tail as a partial answer before backfill; resolve it to the canonical ID when its prefix arrives.
- Insert newly projected parts using existing timeline anchors, rather than sorting DOM. Remove obsolete partial nodes and reconcile existing nodes after backfill.

## Verification

- Before-fix logs: `.local/stabilization-baseline/pagination-before.log` and `pagination-review-before.log` (ignored).
- `node --test --test-force-exit tests/chat-compaction.test.mjs tests/chat.test.mjs tests/compact-server.test.mjs`: **178 PASS, 0 FAIL, 1 SKIP**. Includes every two-page cut of the compact fixture, a three-page reconstruction, DOM insertion around pre-existing notices, open-message message_end, late steer completion, terminal snapshot and payload retention checks.
- `npm run check`: PASS.
- `npm test`: **1708 PASS, 0 FAIL, 4 SKIP** (1712 tests).

## Limits / next step

**Web regression checks PASS; overall C11 PARTIAL.** KMP still needs equivalent prefix reconstruction and tests. Browser/mobile visual acceptance and sustained large-history performance are not established by Node/DOM tests. The remaining prefix buffer necessarily retains assistant text needed for reconstruction; large-scale memory behavior still needs measurement.

No EXE rebuild or server restart in this step. Existing Follow Plan edits in web/app.js and the user's future-plan documents are excluded from the commit.
