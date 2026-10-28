# COMPACT-01/02 — isolated real-Pi reproduction

## Environment and commands

2026-10-28; source HEAD `8985bf42e604e34c390c739905327094445859d4` plus pre-existing local changes. No production code changed in this stage.

| TaskBridge | Node | Pi CLI tested | KMP app version | API |
| --- | --- | --- | --- | --- |
| 1.3.0 | 24.16.0 | 1.4.0 | 1.3.0 | Existing RPC surface; no API version change |

This is a tested local matrix, not the pinned Node 22 distribution matrix. Installed Pi 1.4.0 is the candidate for packaging; redistribution/licensing and clean-install acceptance remain pending.

Executed existing stands:

```sh
node experiments/pi-hooks/compat-check.mjs --model deepseek/deepseek-flash --timeout 60000 --out .local/stabilization-baseline/pi-compat
node experiments/pi-hooks/follow-plan-compat.mjs --model deepseek/deepseek-flash --timeout 60000 --out .local/stabilization-baseline/follow-plan-compat
node .local/stabilization-baseline/restore-probe.mjs
node .local/stabilization-baseline/compact-probe.mjs
node .local/stabilization-baseline/export-compact-fixtures.mjs
node --test --test-force-exit --test-name-pattern='successful compaction separates|compaction summary is placed' tests/chat.test.mjs
```

Scratch probes, raw events and reports are local ignored artifacts, not release runtime code. Each Pi process used its own workspace/session directory and PI_CODING_AGENT_DIR under `.local/stabilization-baseline/`. Only public generated sample content was read. The live TaskBridge server and user sessions were not modified or restarted.

## BASE-02 RPC results

- Existing compatibility stand: 7 PASS, 1 unconfirmed. get_state, prompt, set_model, steer, follow_up, compact and abort passed. restart_saved_session accepted get_state and prompt but did not observe agent_settled within 60 seconds.
- Narrow restore probe re-opened that same scratch session, registered its waiter before prompt, and sent a short no-tool request. get_state and prompt succeeded; agent_settled arrived with aborted=false; final isStreaming=false. This confirms a successful restore, but does not explain the first timeout (no claim that the original stand is fixed or entirely green).
- Follow Plan compatibility stand: all 8 reported checks passed, covering extension-tool arguments over RPC, turn/hooks, follow-up queue, audit continuation, abort and resumption. Fixture extension was used; production controller end-to-end acceptance was not repeated.
- Reports: `pi-compat/report.json`, `restore-probe.json`, `follow-plan-compat/report.json` under the local baseline directory.

## A — automatic compact inside a real turn

Probe: public sample.txt with repeated test lines; prompt requests BEFORE, a read, then AFTER. Initial threshold 12000 did not trigger automatic compact; this is a control, not a reproduction. Lowering the isolated threshold to 4000 did trigger it. Model get_state reported contextWindow=1000000; settings used reserveTokens=996000 and keepRecentTokens=200. This deliberately aggressive test configuration is not a production recommendation.

Pi emitted `compaction_start` / `compaction_end` with `reason: threshold`, not `auto_compaction_start` / `auto_compaction_end`. Consumers must support both spellings already accepted by ChatState.

Relevant original RPC sequence offsets:

| seq | Event |
| --- | --- |
| 7–37 | First assistant message, including text and tool call |
| 38–39 | read tool start/end |
| 43–44 | threshold compaction start/end with successful result |
| 45–46 | next turn_start and assistant message_start |
| 229–230 | continuation message_end / turn_end |
| 231 | agent_end |
| 232–233 | second successful threshold compact |
| 234 | agent_settled |

There is real continuation after the first compact and no new user message. The second compact happens after agent_end and before agent_settled, with no continuation. It must not create an empty visual segment. Raw token estimates are retained in the normalized fixture, but are not treated as authoritative measured context sizes.

## Confirmed Web defect

Replaying the normalized real events through the actual `web/chat-state.mjs` produces:

```text
user-initial
assistant-initial: BEFORE + AFTER, tool-1
note-44
note-233
```

Required visual order is first assistant segment → note-44 → continuation segment → note-233, while preserving one canonical assistant response. This is a client reducer/projection defect independent of any DOM sorting.

Cause in `ChatState.apply`:

- compaction_end appends the note when current already has content, but does not capture a segment boundary.
- later message_start continues to assign messageTurn and executionTurn to the same current object.
- textPrefix and message_end rebuild that object's accumulated text; tools also append to it.

The RPC order is correct in this capture. The TaskBridge server pipeline and persisted SSE/history order have not yet been checked with this session; normalized fixture envelopes are synthesized, not presented as a server log.

Targeted existing tests: **1 PASS, 1 FAIL**. `compaction summary is placed before the answer that follows it` passes; `successful compaction separates existing work from continuation` fails. Log: `.local/stabilization-baseline/compact-targeted.log`.

## B — manual compact after completion

The control run at threshold 12000 settled normally. A subsequent manual compact succeeded and emitted exactly compaction_start/compaction_end, reason=manual. No unsolicited agent_start was observed during the additional 1.5-second observation window. Its original offsets, when concatenated with the preceding completed run, are 53–54.

A separate manual compact after the aggressive automatic run returned success=false. It is not used as the successful manual fixture and must not be classified as successful merely because a compaction_end event exists.

## Fixtures and privacy

- `tests/fixtures/compaction/pi-1.4.0-auto.json`: normalized real automatic stream, including both successful threshold boundaries.
- `tests/fixtures/compaction/pi-1.4.0-manual.json`: completed real run followed by successful manual compact.

Both contain explicit provenance. Output/summary text is replaced by public markers; thinking and non-rendered message payloads are omitted; tool IDs are normalized. Original relative RPC order and sequence gaps remain. They contain no credentials, private prompts, absolute workspace paths or session IDs. They are not full-fidelity provider recordings and do not prove delta/message_end reconciliation for arbitrary text.

## Contract and remaining acceptance

COMPACT-02 contract is the one in the source plan: canonical response identity must remain stable; visual segments are projections, not server turns; boundaries must survive replay; successful compact only; no empty continuation segment; actions use canonical IDs. Do not implement the failing test by simply creating independent assistant turns.

Still open:

- Scenario C: TaskBridge #enforceContextLimit after-turn behavior.
- Server event persistence/SSE/history ordering and timestamp/turn correlation.
- Real Web/KMP UI comparison and Android/Desktop visuals.
- Full Web/KMP segment implementation, common golden assertions and action compatibility.
- Restore timeout root cause; Node 22 runtime matrix; exact API version declaration for distribution.

## Follow-up: Web projection and history retention

`web/chat-state.mjs` now projects successful compact boundaries as visual segments while retaining the canonical answer; `web/app.js` renders those segments and routes actions to the canonical answer. Real-fixture replay and a DOM test check ordering, stable tool state and canonical edit identity. User changes already present in `web/app.js` and `tests/chat.test.mjs` were preserved.

A targeted test additionally demonstrated that `trimStreamingDeltas` and SQLite `pruneStreamingDeltas` lost the split when compact falls inside a still-open message: message_end does not retain the boundary offset. Both now keep deltas for that specific case; ordinary completed messages remain prunable. An isolated fake-Pi context-limit test confirmed a stored successful compaction without a second agent_start.

Checks after these changes: `node --test --test-force-exit tests/chat-compaction.test.mjs tests/store.test.mjs tests/event-trim.test.mjs tests/context-limit.test.mjs` — 32 PASS; `npm run check` — PASS; `npm test` — 1695 PASS, 0 FAIL, 4 SKIP. An earlier full run transiently failed media-recovery-09E, then its isolated file passed 9/9; the later full run passed. Cause of that earlier failure is unconfirmed.

## Follow-up: actual HTTP/SSE server pipeline

Server retention prerequisite is committed as `35552da`. `tests/compact-server.test.mjs` now drives the actual isolated TaskBridge server with the anonymized captured Pi event sequence, delivered by an explicit fake-Pi recording mode. It verifies ordered SSE, matching HTTP history, reconnect after the first successful boundary, server restart, no duplicate segments/terminal events, and one agent_start. This is a real server/SQLite/SSE check with recorded Pi frames, not a new live-provider model request.

`node --test --test-force-exit tests/chat-compaction.test.mjs tests/chat.test.mjs tests/compact-server.test.mjs`: **171 PASS, 0 FAIL, 1 SKIP** (172 tests). Includes STOP, variant switching, shared Golden fixtures, real-store reopen, DOM order, retained expanded tool state and canonical edit text.

After the user's Desktop update and server restart, read-only status confirmed the managed app/proxy were up and `/api/health` returned HTTP 200. The user's sessions were not used for acceptance. Application process liveness alone is not Compact acceptance.

**Verdict: PARTIAL.** Web and the isolated recorded-event server pipeline pass. KMP projection is implemented/tested separately; visual Desktop/Android and real cross-client acceptance, page cuts inside an exchange and large-history performance remain open. No claim that the entire stabilization/install plan is complete. Pre-existing Follow Plan edits in web/app.js are excluded from the Compact commit.
