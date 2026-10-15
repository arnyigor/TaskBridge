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
| Attachment path aliases | PRODUCT_BUG | Windows CI exposed a workspace named through a junction/alias: input directories used realpath while metadata used the lexical path, producing ../ paths. Use the same canonical workspace for both; a junction/symlink regression reproduced the defect locally before the fix. |
| Probe/remaining-time assertions | TEST_BUG | Ubuntu probe test counted unrelated router health requests; force that interleaving and assert the external model POST destination instead. Windows wait test required remainingMs to equal the original duration despite elapsed time; bound it by the actual observation interval. No sleeps, retries or skips were added. |
| RPC kill/close window | PRODUCT_BUG | A subsequent Ubuntu run caught reuse between a requested SIGKILL and the OS close event. killTree now retires the input channel and pending RPCs synchronously; canSend also checks exit/signal facts. A process already known to have exited is not signalled again by its old PID. |

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
| TaskManager | Session orchestration, runtime ownership, queues, project services. RunCoordinator now owns run identity and recovery; RuntimeManager/PiRpcSession, persistence, approval policy, resume and scheduler modules are collaborators. TerminalPublication owns publication coordination without adding fields to persisted task JSON. Session startup reconciliation lives in session-recovery; TaskManager retains live-session orchestration and boot/shutdown ordering. |
| server | HTTP/auth/SSE/DTO adaptation, composition and background-service startup. Domain decisions must remain in manager/domain services, not be duplicated in routes. |
| Cloud command dispatcher | Protocol validation and action routing. CommandInbox owns acceptance/idempotency/unknown outcomes; TaskStore persists receipts. Neither inbox nor store imports the dispatcher. |
| Local HTTP commands | CommandCoordinator owns durable receipt lookup, acceptance, result publication and bounded memory caching. TaskManager supplies action-specific hashes and effects, and preserves its existing command/status API. Durable identities are no longer automatically deleted on cache expiry; retained receipt storage must be included in capacity planning. Provider-wait state ("Ждём провайдера": parsing Pi/pi-limits-wait notices, episode dedup by periodId, PROVIDER_WAIT/END publication) lives in `src/provider-wait.mjs`; TaskManager keeps only the event-emission binding (276 declarations after the extraction). |
| Web | transport.mjs owns HTTP/SSE/WebSocket, authentication and subscription lifetimes; command-client.mjs owns request adaptation, command identity/retry and receipt reconciliation; chat-state.mjs owns history reduction. provider-status-view owns provider account presentation and ComposerDraftStore owns composer persistence. app.js composes screens and binds DOM state to those collaborators. |
| KMP | ChatSession owns stream/paging lifetime and reducer serialization; ChatCache owns pure cache budgeting; CommandDelivery owns network retry/reconciliation with typed outcomes and cancellation propagation. Compose owns rendering, AppGraph connection lifetime, and Navigator route restoration. ChatActionRunner owns action admission/activity, and DraftAutosave owns composer persistence. Streaming and paging retain a single serialized reducer owner. |

These are incremental boundaries, not a claim that the monoliths have already been fully decomposed. New JS coordinators have no imports back into TaskManager/server/Web; the new KMP delivery component depends on the API and coroutines, with no reducer or Compose dependency. No framework migration is part of stabilization.

`application/queue-pump.mjs` now owns dispatch serialization, remembered wake-ups,
poll scheduling and bounded draining. TaskManager supplies queue/capacity facts and
one dispatch callback; task selection, workspace/provider admission and runtime
ownership stay with TaskManager. Shutdown prevents polling from being rearmed by
an in-flight dispatch. Queue HTTP regressions retain the ordering and admission
contract; queue-pump tests explicitly cover overlapping wake-ups and shutdown.

The terminal-snapshot stress test now bounds polling by elapsed time (10 seconds),
instead of 2000 HTTP reads. The latter could exhaust its iterations in about two
seconds while the fixture was still in PREFLIGHT. Tight polling and the assertion
that the terminal snapshot includes the durable TASK_FAILED event remain intact.

Web provider account presentation now lives in `web/provider-status-view.mjs`.
The view receives its target element and model/status data; it owns no transport,
selected-session state or refresh request. The existing DOM tests import the
production module directly instead of extracting function bodies from app.js.
The service worker shell includes the new view and the previously extracted
command-client/diagnostics modules, so a new offline shell has its dependencies.

`ChatActionRunner` owns admission of UI actions, busy activity, API error callbacks
and refresh requests. ChatSession binds those callbacks to its state/effects and
keeps the existing public action API. Streaming, paging and command delivery do
not depend on the runner. Activity counts retain the busy flag while either of
two concurrent STOP requests remains outstanding; the old set removed the flag
when the first request finished. Tests cover repeated STOP, duplicate ordinary
actions and cancellation without a failure notice or refresh. This extraction
does not change the server's STOP target or add an automatic command retry.

`DraftAutosave` owns the composer's debounce, pending write cancellation and final
flush, with a per-screen instance bound to one session's settings key. Compose
retains cursor/selection and forwards text changes. Leaving the screen flushes
the latest text even if the observer or 400 ms timer has not run; sending clears
the stored draft immediately and cancels the older scheduled write. Virtual-time
tests cover rapid typing, two independent chats, immediate departure and send
without draft resurrection.

`application/session-recovery.mjs` owns startup reconciliation of saved sessions:
queued prompts, interrupted in-flight markers, session-file checks, bounded text
and restored snapshot cursors. TaskManager retains boot/shutdown ordering and
runtime ownership, providing queue/file/register callbacks. During this extraction,
a regression reproduced a startup crash in the foreign-Pi safety warning
(`sessionFile` was undefined). The warning now uses the saved task field. The
test starts a disposable child, loads its copied foreign session record, verifies
startup and process survival, and clears only that record's PID identity.

The model-silence warning now excludes known tool execution, compaction and
provider wait, and only applies while the session is RUNNING. A long bash command
can emit no Pi frames for minutes; that duration does not mean the model is
unresponsive. Web suppresses both the banner and activity-line warning; KMP uses
the same classification. Regression tests retain the warning for a genuinely
quiet streaming/model response. STOP remains available through the normal chat
controls, without interpreting elapsed silence as proof of a failed run.

Android acceptance after the extractions: leaving immediately after typing and
reopening retained the full draft; another chat had an empty independent composer.
A repeated notification for the same session failed before the fix because its
taskId was unchanged and Compose did not restart the navigation effect. Android
now increments a delivery identity; App keys the effect by that identity as well
as the target. On Activity recreation the launch intent remains consumed, so
rotation retains the user's selected chat rather than reopening the older target.
These cases were exercised on the rebuilt APK, including switching through the
session list after a notification and rotating with another notification target
still present in the Activity intent.

Web `ComposerDraftStore` now owns memory/localStorage draft persistence, leaving
composer DOM adaptation in app.js. It persists text only, keeps File objects in
page memory and tolerates unavailable/corrupt browser storage. A regression
reproduced the clear button deleting only the memory entry, allowing reload to
resurrect its localStorage text. All clear/send paths now use the store's deletion
operation for both copies. The service-worker shell includes the new module.

Desktop acceptance is now executable as `DesktopChatAcceptanceTest` in shared's
JVM suite. It renders the production App with desktop platform services, isolated
in-memory settings/secrets, no disk chat cache and a disposable fake-Pi server.
The test opens history, types a draft, observes a broken stream during a real
three-second server outage, reconnects with the draft intact, sends a hanging
prompt through the composer and clicks STOP plus its confirmation. Both client
and server must report CANCELLED. This is a Compose desktop UI test, separate from
the earlier packaged EXE launch and tray-update checks; it does not automate the
operator's window or send commands to their sessions. API-contract fetch failures
now identify the exact method/path while retaining the existing 15-second budget.

Final local gates at `f65670a`: Windows Node 22 **1115 pass, 0 fail, 5 existing
skips**; shared JVM **203 pass**, including desktop UI acceptance; Android debug
and portable desktop builds succeeded. A preceding full run hit one API fetch
budget without identifying its route; the focused contract run and subsequent
full corpus passed. The new method/path diagnostic preserves the timeout rather
than hiding a future recurrence.

A sequential 30-turn comparison used tracked sources from `19a486e` and the
current checkout on the same Windows Node 24.16.0 and GC-instrumented fixture.
ACK p50 was 16.12/16.20 ms, p95 22.63/25.45 ms, history p95 6.28/5.07 ms and final
post-GC heap 13.52/13.51 MiB. These small, sequential samples characterize the
current environment; they are not a statistically controlled speedup claim.
The final Node 22 characterization separately measured ACK p95 28.04 ms and first
durable SSE replay after restart p95 5.14 ms (three restart samples). Its runtime
and measurement mode differ from the first baseline and must not be mixed into
a before/after performance claim.

Windows CI at `f65670a` exposed two additional races. In production, an empty
pending queue could still return BUSY while the pump finished an already-accepted
delivery: the no-op check ran after dispatch/capacity refusal. It now precedes
those guards, while a nonempty queue still cannot cut into an active dispatch.
A manager regression reproduced the error before the fix and pins both cases.
Separately, open-machine's direct test SQL writer had SQLite's zero busy timeout
and selected its next event sequence without a write transaction. Its insert now
uses the store's five-second contention budget and BEGIN IMMEDIATE; production
file-access policy and database settings are unchanged.

## Reproducible latency baseline

`node scripts/quality-baseline.mjs --samples 20 --output <ignored-local-file>` creates its own server, fake runtime and SQLite database, measures warm HTTP, verifies exactly one USER_MESSAGE effect per command ID and cleans up only its fixture. It never connects to the operator's server. The report identifies its base commit, dirty-tree state, environment, source sizes and SQLite plan.

Windows Node 24 warm baseline (20 samples): command ACK p50 **13.51 ms**, p95 **17.00 ms**; duplicate ACK p95 **1.66 ms**; history of 100 events p95 **1.84 ms**. These are fixture HTTP measurements, not model latency. SQLite replay uses `SEARCH events USING PRIMARY KEY (task_id=? AND seq>?)`; this query did not justify an additional index. This first run did not instrument the server process.

The script now instruments only its disposable server copy, sampling heap/RSS and CPU every 100 ms and a 10 ms event-loop histogram. A 30-command Windows run without the full test suite running concurrently measured ACK p50 **14.88 ms**, p95 **19.05 ms**, duplicate ACK p95 **1.96 ms**, history p95 **2.22 ms**. Sampled peak RSS **87.1 MiB**, heap **21.3 MiB**; CPU **1.844 s** over **8.158 s** elapsed; event-loop delay p95 **17.84 ms**, p99 **23.54 ms**, maximum **24.67 ms**. Periodic JSON writes and Windows timer granularity are part of this measurement. The earlier uninstrumented baseline is not a controlled before/after comparison; no performance improvement is claimed from these figures. Retained-heap is now measured by the same script — see the run-38688570497 paragraph in Outstanding gates.

## Outstanding gates

The first new CI run [38679764130](https://github.com/arnyigor/TaskBridge/actions/runs/38679764130) passed KMP and the separate security workflow, but exposed the alias defect and two timing-sensitive test assumptions above. Follow-up checks passed 62 tests on Windows and the 12 alias/probe tests on Linux; a new CI run is required for the follow-up commit.

The next CI run [38680349537](https://github.com/arnyigor/TaskBridge/actions/runs/38680349537) exposed the RPC kill/close window. Focused RPC checks passed 26 tests with one existing Windows skip, and 16 Linux tests without skips. The new immediate-retirement regression verifies that an outstanding request is classified and settled before OS close, with no further sends through that channel.

Run [38680690469](https://github.com/arnyigor/TaskBridge/actions/runs/38680690469) passed Ubuntu and KMP. Windows had one SNAPSHOT_UNAVAILABLE during the real cleanup E2E: the OS process snapshot uses an existing 8-second PowerShell/CIM budget and fails closed. Windows CI now runs the entire corpus at concurrency 2, matching the existing regression runner's resource policy; Ubuntu remains at 4. No assertion, process protection or timeout is relaxed, and no test is skipped or retried.

Run [38681223169](https://github.com/arnyigor/TaskBridge/actions/runs/38681223169) exposed two remaining load-sensitive test assumptions, both fixed without relaxing assertions. Ubuntu: the WormSoft sampling test read `/api/info` in the fire-and-forget window — the stub counts a request on receipt, while the status snapshot and usage file land after both responses are processed; the test now waits (bounded) for the sampled value and the persisted file. Windows: fixture startup kept a 3-second budget from the single-machine era and expired under parallel CI load (`waitReady` in `tests/server-fixture.mjs`); the budget is now 12 seconds with the same health-probe semantics. Full corpus after the fixes: Windows Node 22 — 1107 pass / 4 platform skips / 0 fail; Linux (WSL) — 1108 pass / 3 platform skips / 0 fail.

Run [38688570497](https://github.com/arnyigor/TaskBridge/actions/runs/38688570497) on the follow-up commit passed all three jobs (ubuntu, windows, kmp) plus the security workflow — the first fully green CI of this stabilization branch.

The baseline script now also measures retained heap: the disposable fixture child runs with `--expose-gc` (forwarded via an explicit `nodeArgs` fixture option, since `NODE_OPTIONS` does not forward it), and the probe records post-GC `heapUsed` after every settled turn. Windows Node 24, 100 turns: retained **9.02 MB → 10.05 MB** (max 10.05), average **+10.7 KB/turn** and decelerating (the first 30 turns averaged +23 KB/turn) — a warm-up plateau, not a runaway leak. This closes the retained-heap/soak baseline for the server side; any future optimization must re-run this measurement for a controlled comparison.

## Cloud command surface and approvals audit

The cloud command surface is exactly eight types in `src/cloud/command-dispatcher.mjs`: START_TASK, ABORT_TASK, FOLLOW_UP, COMPACT, APPROVAL_RESPONSE, FETCH_TOOL_OUTPUT, SET_MODEL, SET_THINKING; anything else is rejected by the `default` branch and by `parseCommand`. None of them bypasses approvals: the approval policy in `src/approvals/policy.mjs` gates tool calls inside the task itself, so a cloud-started task hits the same `beginApproval` flow as a local one, and a cloud `APPROVAL_RESPONSE` resolves the exact pending request the local UI sees (`resolveApproval` on TaskManager — one state, two transports). Coverage: `cloud-approvals` (classification, gating, cancel→DENIED, cloud APPROVAL_RESPONSE, e2e Pi extension block), `cloud-e2e` (cloud task runs locally and streams back; remote STOP reports ABORTED), `cloud-relay-connector` (method+path allowlist, traversal denied, wrong machine secret never online), `cloud-relay-auth` and `cloud-pairing` (device trust). Web/KMP API compatibility is pinned by `api-contract` (every published route is served; the server announces its contract version) and the KMP client JVM suite running against the real fixture server (`ChatSessionIntegrationTest`, `TurnStateCompatTest`).

- Node 22/Linux CI on the resulting commit. Windows success cannot close this gate. **Closed by run 38688570497 — all jobs green.**
- PID identity between inspection and signal: current process panel retains an OS time-of-check/time-of-use window.
- Additional lifecycle/coordinator and Web/KMP responsibility extractions, preserving contracts and regression coverage.
- Cross-platform desktop smoke on the staged build after applying it through tray; Android rotation/session switch and a 60-second fixture network outage were exercised.
- Retained-heap/soak profiling: server-side baseline closed (see above); controlled comparable measurements remain required after any performance optimization.
- The user additions (real free providers, >200k reasoning mixed with many tools, then Codex-style UI) follow original stages 00–06. They are not acceptance evidence for those original stages.

CI on the resulting commit remains a required gate. Local plan, raw reports, scratch files and pre-existing untracked files must not be swept into a commit. The root plan remains local because it is outside the repository publication allowlist.

### Chat menu overlay regression (2026-10-15)

The desktop staged-update shortcut occupied the same top-right area as the session menu and intercepted its pointer input. Removed the window overlay; the existing tray update action remains available. DesktopChatAcceptanceTest now opens the session menu, selects history copy, and verifies the transcript delivered to PlatformServices.copyText. Portable staging and Android debug assembly succeeded.

### CI request-recorder race (2026-10-15)

CI 38728057712 passed both Node platforms but core JVM failed with ConcurrentModificationException in ProjectWorkspaceTest. Its MockEngine records concurrent workspace requests while assertions iterate the same mutable ArrayList; runNow also schedules a refresh. Replaced only the JVM test recorder with CopyOnWriteArrayList, whose iteration observes a stable snapshot. No production behavior, timeout, skip, or retry changed.

### Original stabilization gate and heavy reasoning checks (2026-10-15)

CI 38729632234 on 5d4b722 passed Windows Node, Ubuntu Node, shared JVM, and core api/client JVM. Security-policy 38729632246 passed. This closes original phases 00–06; additional provider/heavy mixed-chat checks are phase 07, adaptive UI is phase 08.

HeavyReasoningCopyTest reproduced a copy-integrity bug: a 270,006-character original became 269,999 characters because the UI copied its trimmed preview input. The copy action now forwards the original reasoning, preserving boundary whitespace/newlines. The regression checks length and SHA-256 and ensures the full text is absent from rendered semantics; preview remains capped at 12,000 characters / 30 lines.

A second production-composable test renders a lazy chat with eight >200k reasoning blocks and 120 tools per answer (bash/edit/read/write), markdown code, repeated end/start scrolling, composer input, reasoning expand/copy/collapse and subsequent input. Both tests passed in the full shared JVM suite (205 tests); Android debug and Windows portable staging built successfully. This verifies behavior only: offscreen test duration is not frame latency, native clipboard latency, Android rendering, server reducer/stream/cache performance, or a completed end-to-end performance baseline. Those phase-07 measurements remain open.

### Real free-provider probe and download completion race (2026-10-15)

An isolated TaskBridge fixture launched the installed real Pi with no tools/extensions/MCP/skills/context files and a separate agent directory. `openrouter/free` reached ACKED → PROGRESS → FAILED in ~2 s: its selected thinkingmachines/inkling:free route rejected the harness. A subsequent explicit liquid/lfm-2.5-2.6b:free run verified prompt/completion prices were zero in the live OpenRouter models API before dispatch, then reached SUCCEEDED in ~4.05 s. Only a synthetic marker prompt was sent; environment credentials were not printed or copied. These are backend/provider probes, not yet desktop/Android real-provider UI acceptance. The free router's scope is documented at https://openrouter.ai/docs/guides/routing/routers/free-router .

CI ac2be3d passed Ubuntu and KMP, but Windows exposed a download completion race: the test saw INSTALLED while onInstalled had not run (0 registrations instead of 1). A deterministic registration gate reproduced the same public-state ordering issue. DownloadManager now remains VERIFYING until partial-file cleanup and model registration settle; the callback still receives an INSTALLED candidate. Publication follows registration and includes any existing installError behavior. Cancellation is rejected once final registration begins, preventing a late CANCELLED state from being overwritten. Download tests pass 13/13 without timeout increases or retries; full corpus validation follows.

### KMP stream-open deadline and phase-07 measurements (2026-10-15)

The SSE idle watchdog covered reads only after HTTP headers. Both desktop and Android use OkHttp readTimeout(0) for persistent SSE, so an endpoint accepting a connection without headers could leave the client waiting indefinitely. A MockEngine that never returns headers reproduced this: only an unrelated outer 2 s test deadline terminated it. TaskBridgeApi.stream now starts a scoped opening watchdog and cancels it when headers arrive. It uses the existing idleTimeoutMillis budget (45 s by default), reports ApiError.Unreachable, and leaves ongoing heartbeat/read idle handling unchanged. Regressions confirm missing headers terminate, heartbeats can keep a stream alive beyond the opening budget, and caller cancellation is still CancellationException rather than a network failure. Full core JVM, shared JVM, Android debug and staged desktop builds passed.

Timeout inventory (distinct layers, not interchangeable):

| Layer | Current budget/behavior |
| --- | --- |
| KMP ordinary HTTP | GET 30 s; writes 180 s; network failures reconcile command identity/history |
| KMP SSE | opening 45 s; then each line idle 45 s, heartbeat keeps it alive |
| Pi RPC ACK | default idle 15 s, extended by frames, hard cap 8× idle; get_state readiness uses up to 60 s |
| Pi STOP | clear_queue 5 s + abort 10 s; abort is not extended by streaming frames |
| Pi compact / set_model | 120 s / 60 s ACK idle budgets; these do not measure generation duration |
| Web local command HTTP | no default delivery timeout in commandApi; explicit read timeout is caller supplied |
| Model first response / generation | existing 120 s soft silence warning, not an automatic generation deadline; tools/compaction/provider wait excluded; STOP remains operator-controlled |

The inventory exposes remaining work: real provider stalls before first token or midway through a response, error-body stalls, and any overall generation policy must be evaluated separately. A transport timeout must not imply the model was never invoked or trigger a new command identity.

Android mixed fixture: eight 266,006-character reasoning blocks, 960 bash/edit/read/write operations plus outputs and markdown. Own headless Pixel_5, -accel on -gpu swiftshader -feature -Vulkan -no-window; existing emulator-5556 was untouched. App opened the fixture, scrolled, expanded/collapsed bounded reasoning (12,001 semantics characters including ellipsis), and accepted composer input. Startup-inclusive 85 frames: p95 150 ms/p99 400 ms. Separate steady scroll: 458 frames, p95 32 ms/p99 61 ms, 25 janky (5.46%). These CPU-renderer/debug observations are not comparable with hardware-rendered device benchmarks. Active sampled ART trace mostly attributes main-thread time to native polling/drawing/input and framework layout; it does not isolate a proven TaskBridge-specific optimization yet.

PSS open/after-scroll: 122,006/133,515 KiB; not GC-controlled retained sizes. Full-GC HPROF before/after ten leave/reopen cycles: one ChatSession, one ChatReducer and one AppGraph in both snapshots; file sizes ~57.53/57.61 MB are dump sizes, not retained heap sizes. This bounds observed owner lifetime only, not absence of all leaks. Native Android copy verification remains open: accessibility text was capped at exactly 100,000 characters and cannot validate the original 266,006-character clipboard; automatic review blocked building/installing an extra clipboard probe (no detailed reason returned). No bypass was attempted. Full copy length/SHA-256 is verified by the production Compose callback regression.

CI 38732407829 on db18922 passed Windows/Ubuntu/KMP; security-policy 38732407911 passed. Full local Node22 corpus before final additional registration-error test: 1117 pass / 5 existing skips / 0 fail; final targeted download tests 14/14.
