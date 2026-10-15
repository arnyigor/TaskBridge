# Stabilization baseline — 2026-10-15

Base commit: `5e8e957`. Results below describe the changed working tree, not an already published release. Windows is the primary acceptance platform; Linux is an additional compatibility gate because the original failure occurred in Ubuntu CI.
Original evidence: [CI run 38667985170](https://github.com/arnyigor/TaskBridge/actions/runs/38667985170), inspected with `gh run view --log-failed`.

## Failure classification

| Area | Classification | Cause and change |
| --- | --- | --- |
| access-machine | TEST_BUG | Fixed LAN address assumed to belong to every runner. Mock networkInterfaces; also reject forwarded loopback from an untrusted peer. |
| cloud-approvals | PRODUCT_BUG | POSIX treats Windows drive paths as relative. Classify foreign absolute writes as outside-workspace; cover UNC and native absolute paths within workspace. |
| instance-lock | PRODUCT_BUG | Windows inspection tools on POSIX failed and conservatively classified any live PID as the server. Use ps for POSIX image/command inspection, retaining fail-closed errors. |
| process-protection | PRODUCT_BUG | POSIX killed only the parent. Signal already checked descendants before parent and allow a bounded reaping interval. Test cleanup also kills its own child. |
| project-browser | TEST_BUG | Windows-only absolute path in NOT_CONFIGURED test yielded INPUT_INVALID on Linux. Supply a native absolute path. |
| project-dashboard | PRODUCT_BUG | Mixed Cyrillic/Latin order depended on host locale. Explicit Russian collation stabilizes API title sorting. |
| rpc-pipe-recovery | PRODUCT_BUG | Child process error handling missed stdin Writable errors. Reject pending requests, invalidate pipe and emit diagnostic on stdin error. Injected EPIPE regression verifies no subsequent prompt is sent through the failed pipe. |
| send-flow teardown | TEST_BUG | Cleanup raced background work. Close TaskManager before store; bound retries for transient removal failures including ENOTEMPTY. |
| transport-timeout | TEST_BUG | Mock fetch owns no socket; AbortSignal.timeout does not keep Node 22 alive. Test owns a referenced handle and always clears it. Cancellation reproduced before fix. |
| EventMux | PRODUCT_BUG | Synchronous try/catch missed rejected publishEvents Promise. Observe rejection and log it while other transports/listeners continue; add sync/async failure regressions. |
| terminal snapshot | PRODUCT_BUG | Tight HTTP polling reproduced SUCCEEDED before TURN_STATE/RUNTIME_STATE/TASK_SUCCEEDED were persisted. TerminalPublication retains the preceding public snapshot until the terminal append completes. TaskStore commits the terminal event and corresponding task snapshot in one SQLite transaction; an injected snapshot-write failure rolls both back. Tight-poll tests cover success, failure and cancellation. |
| Web cloud reconnect | PRODUCT_BUG | A new WebSocket received ATTACH/SYNC before opening/authentication. Reattach after AUTH_OK, reject stale socket callbacks, release disconnected session timers and bound duplicate tracking. A lost command ACK is not an instruction to replay. |
| Cloud command recovery | PRODUCT_BUG | A crash after an effect but before its ACK could repeat the effect after reconnect. Persist a command intent receipt before dispatch, share concurrent duplicates and refuse unknown outcomes after restart. Receipt retention is independent of the recent-ID memory cache and the generic command TTL. |
| Cloud upload order | PRODUCT_BUG | Independent asynchronous disk writes let a later batch overtake an earlier one. Serialize enqueue before drain; retain failed batches until acknowledgement. Failed deletion must not decrement outbox byte accounting. |
| KMP history lifetime | PRODUCT_BUG | An older-page request could complete after closing its chat; repeated pages falsely indicated the start of history. Cancel the owned page job on close and use the server's reachedStart flag. |
| KMP cache sizing | PRODUCT_BUG | Cache weight omitted top-level message text and JSON escaping. Calculate both without allocating the entire encoded JSON; discard oversized events and preserve the need to page older history. |
| Android recreation | PRODUCT_BUG | A remember-only Navigator lost the selected chat and Back stack when Activity was recreated. Save typed routes and draft command identity with rememberSaveable, scope restoration to the connection, and avoid replaying an already handled notification launch intent. |
| Run lifecycle | PRODUCT_BUG | A Pi failure left its run RUNNING; late writes could reopen or replace terminal outcomes. RunCoordinator owns active identities, preserves the identity across approval waits, and finishes a run inside the terminal event/task transaction. Restart closes abandoned runs with UNKNOWN_AFTER_CRASH; a resumed turn gets a fresh ID. |
| Local command durability | PRODUCT_BUG | An automatic 24-hour receipt purge allowed an old HTTP command ID to execute again; a final receipt-write failure was hidden behind a successful response. CommandCoordinator now owns local acceptance/replay, expires only the memory cache, and reports UNKNOWN_OUTCOME if an effect's result cannot be saved. Web and KMP retain the ambiguous state and reconcile against history. |

The POSIX fixes passed an isolated Linux run. Handling EventMux rejection isolates failures; durable delivery belongs to the SQLite event store and the Cloud outbox, not to the synchronous multiplexer.

## Reproduction

```powershell
npm test
npm run check
npm run check:policy
npx --yes --package=node@22 node --test --test-concurrency=4 --test-force-exit tests/*.test.mjs
cd clients/kmp
.\gradlew.bat :shared:jvmTest --rerun --console=plain
cd core
..\gradlew.bat :api:jvmTest --rerun :client:jvmTest --rerun --console=plain
```

Windows Node 24.16.0 baseline: 1088 tests, 1083 passed, 0 failed/cancelled, 5 skipped. Node 22 reproduced the cancelled timeout tests. Intermediate checks exposed the terminal snapshot race, two missing run invariants and the local receipt lifetime/result-write defects; each was reproduced before fixing it. Latest full Windows Node 22.23.3 run including all coordinator and Web changes: **1109 tests, 1104 passed, 0 failed, 0 cancelled, 5 skipped**, 105.3 seconds. The run/store/runtime/send subset passed 98 tests; local coordinator/send/run checks passed 87. A separate tight-poll stress completed 25 turns without a cursor mismatch.

An earlier full Linux Node 22.23.2 run passed **1088 tests, 0 failed/cancelled, 3 skipped** (1091 total). That run predates the subsequent durable-inbox and atomic-terminal changes; it does not prove the latest tree or replace CI on a new SHA. Linux used a dedicated temporary WSL distribution; the user's server and Windows desktop were not moved into it.

Syntax/security checks and explicit-path repo-policy checks passed for changed sources, tests and this document. Root plan_full.md is a user-requested local file outside the publication allowlist; the policy itself was not widened.

Five Windows skips are pre-existing: disabled DOM cloud-status scenario, PostgreSQL without database URL, two POSIX-only Pi scenarios, TLS proxy without openssl. No additional skips introduced.

KMP shared/api/client JVM tasks were actually rerun successfully. Client tests after the cache/paging/delivery changes: 97 passed across 22 suites. API/client tasks passed again with UNKNOWN_OUTCOME classification and reconciliation. Shared JVM tests include navigation restoration, cross-server isolation, malformed saved state and draft command identity. Android debug and Windows staged portable builds passed before the final delivery extraction. That staged update was consumed through the normal updater: a new installed-process PID, changed executable timestamp and responding chat window were verified. Final client packaging must include the subsequent delivery changes.

Pixel_5 emulator against a disposable fake-Pi server: session list, history, reconnect after fixture restart, follow-up and second answer, STOP confirmation followed by durable CANCELLED. Paging a 120-turn short-message history reached question 1 and the server-confirmed start; a separate 120-turn history has about 1.3 MB of answer text. After paging, app PSS was 119181 KB (Java 24052 KB, native 23028 KB). One accessibility-dump process crashed in UIAutomator; the application process remained alive. This is a long-history smoke, not the user's deferred mixed-block/reasoning performance scenario.

With the rebuilt APK, portrait/landscape recreation retained the selected chat; switching away from the notification-opened session and rotating did not reopen the stale notification target. Removing only the emulator's fixture port mapping for about 60 seconds showed the offline/saved-history state; restoring it returned to the same chat. The test fixture was then closed and its port mapping removed. Windows desktop processes were left running.

## Scenario coverage and ownership

The executable map is `node scripts/regression-suite.mjs --list`. The new `delivery` section adds durable inbox/crash recovery, upload ordering, buffering/backpressure, connector reconnect and command queue coverage. [testing-coverage.md](testing-coverage.md) records the broader existing API and client corpus; its older performance and relay gaps are not evidence of current acceptance.

| Invariant / trigger | Regression evidence |
| --- | --- |
| Initial prompt, follow-up, steering, queues and accepted command replay | send-flow, send-e2e, queue-http, runtime-faults |
| STOP and terminal publication | runs, turn-state, runtime-faults, web-stop-target |
| Pi crash, EPIPE and timeout | runtime-faults, pi-rpc-faults, rpc-pipe-recovery, transport-timeout |
| PID reuse, protected process, owned descendants | instance-lock, process-protection |
| Durable receipt before effect, crash after effect, no automatic retry | cloud-command-inbox (including a child that abruptly exits after its side effect) |
| Event failure isolation, replay and gaps, durable backpressure | event-mux-failures, event-stream, event-window, cloud-buffer, cloud-worker |
| Two subscriptions, lost ACK, stale socket, 150k events | web-reconnect, web-transport |
| Atomic terminal event/snapshot, legacy schema, reopen integrity | store, turn-state, store-identity |
| Resume provenance, preview races, no mutation of source run | resume, work-item-sessions |
| Cross-client interpretation of event history | chat fixtures, ChatReducerGoldenTest, api-contract |
| Page cancellation, overlaps, repeated cursors and cache budget | ChatHistoryPagingTest, CacheWeightTest |

File names in this table are relative to tests/ unless they name a Kotlin class. The table is an inventory of assertions, not a claim that every manual fault scenario has been exercised on both devices.

### Runtime and command contracts

- Run records are execution facts; a follow-up creates another run. A terminal run is not converted back into a working run by transport reconnect.
- Runtime state is derived from process/session facts by `runtime-state.mjs`. WORKING, WAITING_USER and ABORTING describe the runtime; they do not replace a run's persisted terminal outcome. The allowed-transition table is the shared vocabulary.
- Command acceptance, runtime acknowledgement, first progress and terminal persistence are separate stages. TURN_STATE progresses through DISPATCHING, ACKED, PROGRESS and a terminal phase; an RPC timeout alone does not prove whether an effect occurred.
- EPIPE makes the channel unwritable and rejects outstanding requests. Process exit, lost channel and unsent request remain separate observations. A successful STOP confirms cancellation of the addressed turn; reconnect alone does not resend it.
- Cloud CommandInbox persists DISPATCHING before effects. Concurrent equal intents share the same operation; an ID with another payload is CONFLICT. Incomplete durable receipts after restart yield UNKNOWN_AFTER_CRASH. An effect whose result could not be saved yields UNKNOWN_OUTCOME. Both require explicit reconciliation rather than automatic execution.
- EventMux publishes local observations and isolates transport failures. SQLite is the authority for persisted events; outbox files own pending cloud delivery. Normal replay is at least once with sequence/cursor deduplication, not an exactly-once network guarantee.

### Sources of truth

| Information | Authority | Derived data |
| --- | --- | --- |
| Command intent, acceptance and result | SQLite commands / CommandInbox | bounded in-memory receipt cache, ACK frames |
| Session metadata and run outcomes | SQLite tasks and runs | HTTP snapshots, runtime activity, client state |
| Durable history and sequence | SQLite events | SSE/cloud replay, chat reducers and caches |
| Work goal, status and session associations | work_items / work_item_sessions | project dashboard counts |
| Project memory | selected project-memory provider with provenance | resume memory excerpts and suggestions |
| Resume context | derived from the above and current workspace facts | prompt/preview; never a replacement run or memory authority |

## Architecture boundaries

Current hotspots remain TaskManager (~376 KB), Web app (~336 KB), server (~142 KB) and ChatScreen (~140 KB). Size alone is not an extraction criterion. The baseline script records exact sizes, including changed untracked source modules.

An AST inventory (ast-grep, method_definition/function_declaration, before local command extraction) found 296 method/function declarations in TaskManager, 24 in server and 283 in Web app. TaskManager families: session admission/lifetime; queue/capacity; runtime/model/MCP adapters; project/work-item/memory/resume; recipes/schedules/invocations; history edits/variants; command identity; run identity; event publication and UI requests. Server remains the HTTP/SSE/auth composition boundary. Web groups screen rendering, composer, history, projects, model/runtime screens and transport wiring. Kotlin ast-index outlines identify ChatSession stream/paging/delivery/actions/cache and ChatScreen rendering/effects. These inventories guided the extractions below rather than a line-count target.

| Entry point | Responsibilities / current boundary |
| --- | --- |
| TaskManager | Session orchestration, runtime ownership, queues, project services. RunCoordinator now owns run identity and recovery; RuntimeManager/PiRpcSession, persistence, approval policy, resume and scheduler modules are collaborators. TerminalPublication owns publication coordination without adding fields to persisted task JSON. Further session-lifecycle extraction remains open. |
| server | HTTP/auth/SSE/DTO adaptation, composition and background-service startup. Domain decisions must remain in manager/domain services, not be duplicated in routes. |
| Cloud command dispatcher | Protocol validation and action routing. CommandInbox owns acceptance/idempotency/unknown outcomes; TaskStore persists receipts. Neither inbox nor store imports the dispatcher. |
| Local HTTP commands | CommandCoordinator owns durable receipt lookup, acceptance, result publication and bounded memory caching. TaskManager supplies action-specific hashes and effects, and preserves its existing command/status API. Durable identities are no longer automatically deleted on cache expiry; retained receipt storage must be included in capacity planning. |
| Web | transport.mjs owns HTTP/SSE/WebSocket, authentication and subscription lifetimes; command-client.mjs owns request adaptation, command identity/retry and receipt reconciliation; chat-state.mjs owns history reduction. app.js owns screen wiring/rendering and still has non-chat screen integrations to extract. |
| KMP | ChatSession owns stream/paging lifetime and reducer serialization; ChatCache owns pure cache budgeting; CommandDelivery owns network retry/reconciliation with typed outcomes and cancellation propagation. Compose owns rendering, AppGraph connection lifetime, and Navigator route restoration. More separation of chat actions/drafts from session lifetime remains open. |

These are incremental boundaries, not a claim that the monoliths have already been fully decomposed. New JS coordinators have no imports back into TaskManager/server/Web; the new KMP delivery component depends on the API and coroutines, with no reducer or Compose dependency. No framework migration is part of stabilization.

## Reproducible latency baseline

`node scripts/quality-baseline.mjs --samples 20 --output <ignored-local-file>` creates its own server, fake runtime and SQLite database, measures warm HTTP, verifies exactly one USER_MESSAGE effect per command ID and cleans up only its fixture. It never connects to the operator's server. The report identifies its base commit, dirty-tree state, environment, source sizes and SQLite plan.

Windows Node 24 warm baseline (20 samples): command ACK p50 **13.51 ms**, p95 **17.00 ms**; duplicate ACK p95 **1.66 ms**; history of 100 events p95 **1.84 ms**. These are fixture HTTP measurements, not model latency. SQLite replay uses `SEARCH events USING PRIMARY KEY (task_id=? AND seq>?)`; this query did not justify an additional index. This first run did not instrument the server process.

The script now instruments only its disposable server copy, sampling heap/RSS and CPU every 100 ms and a 10 ms event-loop histogram. A 30-command Windows run without the full test suite running concurrently measured ACK p50 **14.88 ms**, p95 **19.05 ms**, duplicate ACK p95 **1.96 ms**, history p95 **2.22 ms**. Sampled peak RSS **87.1 MiB**, heap **21.3 MiB**; CPU **1.844 s** over **8.158 s** elapsed; event-loop delay p95 **17.84 ms**, p99 **23.54 ms**, maximum **24.67 ms**. Periodic JSON writes and Windows timer granularity are part of this measurement. The earlier uninstrumented baseline is not a controlled before/after comparison; no performance improvement is claimed from these figures. Retained-heap/soak measurements remain open.

## Outstanding gates

- Node 22/Linux CI on the resulting commit. Windows success cannot close this gate.
- PID identity between inspection and signal: current process panel retains an OS time-of-check/time-of-use window.
- Additional lifecycle/coordinator and Web/KMP responsibility extractions, preserving contracts and regression coverage.
- Cross-platform desktop smoke on the staged build after applying it through tray; Android rotation/session switch and a 60-second fixture network outage were exercised.
- Retained-heap/soak profiling and controlled comparable measurements after any performance optimization.
- The user additions (real free providers, >200k reasoning mixed with many tools, then Codex-style UI) follow original stages 00–06. They are not acceptance evidence for those original stages.

CI on the resulting commit remains a required gate. Local plan, raw reports, scratch files and pre-existing untracked files must not be swept into a commit. The root plan remains local because it is outside the repository publication allowlist.
