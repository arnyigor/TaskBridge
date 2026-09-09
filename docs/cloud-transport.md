# TaskBridge Cloud Transport

Remote control for local TaskBridge/Pi tasks through a Vercel-compatible cloud
control plane. Implements `Tech_next_version.md`.

Two hard rules from the specification drive the whole design:

> Realtime delivery is an optimization. Durable state and replay provide
> correctness. (`§115`)

> Vercel must never own the lifecycle of a local Pi process. (`§116`)

## Architecture

```text
Browser / PWA ──HTTPS/SSE──► Vercel (or cloud/server.mjs)
                                 ▲            │
                                 │            │ commands
                          events │            ▼
                                 └──── TaskBridge Local Runtime
                                        CloudWorker
                                          ├── EventMux → EventBuffer → Outbox → Uploader
                                          ├── Heartbeat
                                          ├── CommandDispatcher (polling)
                                          ├── ApprovalManager
                                          └── TaskManager → Pi RPC → local project
```

* Task lifetime, connection lifetime and UI session lifetime are independent
  (`§2`). A running Pi task survives a closed browser, a lost Internet
  connection, a new Vercel deployment and a cloud outage.
* The machine only makes **outbound** connections. No port forwarding, public IP
  or inbound firewall rule is required (`§111`).
* Local-only mode (`§6.1`) is the default and keeps working with no cloud
  configuration at all.

## Local side (this repository)

| File | Responsibility |
| --- | --- |
| `src/domain/task-event.mjs` | Event/state vocabulary, transition table, priority classes |
| `src/domain/cloud-command.mjs` | Command envelope, validation, priority ordering |
| `src/domain/machine-state.mjs` | Machine heartbeat payload and capabilities |
| `src/events/event-sequence.mjs` | Durable per-task seq allocation, UUIDv7 event ids |
| `src/events/event-normalizer.mjs` | Pi RPC frames / local events → protocol events |
| `src/events/event-snapshot.mjs` | Assistant snapshot policy |
| `src/events/event-mux.mjs` | The single publishing point: seq + id + sanitize |
| `src/cloud/cloud-config.mjs` | config.json + env resolution and validation |
| `src/cloud/machine-auth.mjs` | Bearer/HMAC machine auth, constant-time compare |
| `src/cloud/cloud-client.mjs` | Outbound HTTP client, typed errors, retryability |
| `src/cloud/sanitize.mjs` | Secret redaction and path aliasing (`§68`, `§69`) |
| `src/cloud/event-buffer.mjs` | Batching, delta coalescing, HIGH-priority flush |
| `src/cloud/outbox.mjs` | Durable local outbox with backpressure policy |
| `src/cloud/event-uploader.mjs` | Batch upload with retry, never silently drops |
| `src/cloud/reconnect-manager.mjs` | 1s→30s backoff ramp |
| `src/cloud/heartbeat.mjs` | Periodic machine state publication |
| `src/cloud/command-dispatcher.mjs` | Command idempotency ledger + routing |
| `src/cloud/approval-manager.mjs` | Pending approvals resolved asynchronously |
| `src/cloud/cloud-transport.mjs` | `LocalTransport` / `CloudTransport` / `CompositeTransport` |
| `src/cloud/cloud-worker.mjs` | Wires everything: start, poll, reconcile, diagnostics |
| `src/metrics.mjs` | Counters/gauges/observations + Prometheus export (§89) |
| `src/tool-output.mjs` | Rolling tool-output window and bounded tail (§38) |
| `src/approvals/policy.mjs` | Destructive-command / outside-workspace approval policy (§52) |
| `pi-extension/taskbridge-approval.js` | Pi `tool_call` hook that blocks until an operator answers |

### Enabling it

`config.json` (or environment variables, which win):

```jsonc
{
  "cloud": {
    "enabled": true,
    "url": "https://taskbridge.example.app",
    "machineId": "home-pc-01",
    "machineSecret": "<high-entropy secret>",
    "machineDisplayName": "Main Windows Workstation"
  }
}
```

```env
TASKBRIDGE_CLOUD_ENABLED=true
TASKBRIDGE_CLOUD_URL=https://taskbridge.example.app
TASKBRIDGE_MACHINE_ID=home-pc-01
TASKBRIDGE_MACHINE_SECRET=<secret>
TASKBRIDGE_CLOUD_AUTH_MODE=bearer        # or hmac

TASKBRIDGE_EVENT_FLUSH_MS=75
TASKBRIDGE_EVENT_BATCH_MAX=100
TASKBRIDGE_EVENT_BATCH_MAX_KB=256

TASKBRIDGE_HEARTBEAT_SECONDS=20
TASKBRIDGE_IDLE_POLL_SECONDS=5
TASKBRIDGE_ACTIVE_POLL_SECONDS=1

TASKBRIDGE_MAX_OUTBOX_MB=100
TASKBRIDGE_CLOUD_REDACT_PATHS=true
TASKBRIDGE_APPROVAL_TIMEOUT_MINUTES=1440
TASKBRIDGE_APPROVAL_TIMEOUT_POLICY=KEEP_WAITING   # DENY | ABORT_TASK
```

If `machineId` is omitted a stable non-identifying id (`machine-<hash>`) is
derived from the data directory, so no user name, hostname or absolute path is
published (`§10`).

Diagnostics: `GET /debug/cloud` (requires the normal local auth) returns
connection state, buffer/outbox counters, last uploaded seq per task, last
processed command seq and the last poll error. It never returns the secret.

## Cloud side (`cloud/`)

* `cloud/lib/store.mjs` — `MemoryStore` (tests, ephemeral) and `SqliteStore`
  (single-node/self-hosted). Schema and uniqueness constraints follow `§75`/`§76`:
  `UNIQUE(taskId, seq)`, `UNIQUE(eventId)`, `UNIQUE(commandId)`,
  `UNIQUE(machineId, seq)`.
* `cloud/lib/router.mjs` — the whole API, framework-free, so the Vercel function
  and the local dev server share one tested contract.
* `cloud/lib/auth.mjs` — single-user (or `TASKBRIDGE_CLOUD_USERS` list) bearer
  auth plus machine-scoped credentials and rate limiting.
* `cloud/server.mjs` — local/self-hosted host with static PWA files and an SSE
  fast path.
* `cloud/lib/store-postgres.mjs` — Postgres adapter (required on serverless).
* `api/index.mjs` + `vercel.json` — Vercel entry point and project config
  (project root = repository root, static output = `cloud/web`).
* `cloud/web/` — installable PWA: machine dashboard, task list/creation, live
  conversation, tool cards, activity log, STOP / follow-up / compact / approvals,
  connection indicators, replay after reconnect.

## Deploying (Vercel + Postgres)

Полная пошаговая версия (автодеплой, ручной путь, диагностика, ротация) —
[`docs/cloud-deploy-vercel.md`](cloud-deploy-vercel.md). Ниже — краткая выжимка.

Одна команда (генерирует креды, ставит env, деплоит, проверяет health и durable):

```powershell
npm run cloud:deploy -- --project taskbridge-cloud --database-url "postgres://…"
npm run cloud:deploy -- --project taskbridge-cloud --dry-run   # только показать план
```

Дальше — ручной путь, если нужен контроль над каждым шагом.

### 1. Generate the secrets

```powershell
npm run cloud:secrets -- --url https://<your-project>.vercel.app
```

It prints (nothing is written to disk):

* `TASKBRIDGE_CLOUD_USER_TOKEN` — what you paste into the PWA;
* `TASKBRIDGE_CLOUD_MACHINES` — the machine id + secret the cloud accepts;
* the matching `config.json` `cloud` block for this machine.

Keep the machine secret out of git; `config.json` is git-ignored already.

### 2. Create the Vercel project

1. Import the repository. **Root Directory: repository root** (not `cloud/`) —
   the router imports shared protocol helpers from `src/domain/`.
2. Framework preset: **Other**. Build command: leave empty (`npm install` is
   enough; `pg` is an optional dependency and is installed by default).
   Output directory comes from `vercel.json` (`cloud/web`).
3. Add a database: **Vercel Postgres** or Neon. It sets `POSTGRES_URL`.
4. Environment variables (Production + Preview):

```env
TASKBRIDGE_CLOUD_USER_TOKEN=<from step 1>
TASKBRIDGE_CLOUD_USER_ID=owner
TASKBRIDGE_CLOUD_MACHINES=[{"id":"home-pc-xxxx","secret":"…","ownerId":"owner","displayName":"…"}]
POSTGRES_URL=<set automatically by the database integration>
```

`POSTGRES_URL` (or `DATABASE_URL` / `TASKBRIDGE_CLOUD_STORE=postgres://…`) is
what makes the store durable. Without it the function falls back to an
in-memory store, which loses every task on the next invocation — the health
endpoint still answers, so this is easy to miss.

5. Deploy, then check:

```powershell
curl https://<your-project>.vercel.app/api/health
# {"status":"ok","protocolVersion":1,"machines":0,"store":"postgres","durable":true}
```

### 3. Point this machine at it

Either through the UI (**☁ → адрес, ID машины, секрет → Проверить соединение →
Сохранить**) or in `config.json`:

```jsonc
"cloud": {
  "enabled": true,
  "url": "https://<your-project>.vercel.app",
  "machineId": "home-pc-xxxx",
  "machineSecret": "…"
}
```

Restart TaskBridge (`start.cmd`). Logs show `cloud transport enabled`, and
`GET /debug/cloud` shows `connected: true`.

### 4. Open it on the phone

Open `https://<your-project>.vercel.app`, paste the user token, then "Add to
Home Screen" for the PWA. The machine appears under **Machines** within a
heartbeat (~20 s).

### 5. Verify the acceptance path

1. Create a task from the phone → it starts locally and streams back.
2. Close the browser mid-task, reopen → the transcript is reconstructed.
3. Disconnect the workstation's network → Pi keeps running; reconnect → the
   backlog uploads.
4. Press **STOP** → the local task is aborted.
5. Enable `approvals.enabled` → a destructive tool call waits for your answer.

### Rotating a secret

Re-run `npm run cloud:secrets`, replace the secret in the Vercel variable and in
the local config, restart TaskBridge. The old secret stops working immediately.

### Limits to know

* No WebSocket/SSE on Vercel: the client polls (1.5 s while a task runs). The
  local `cloud/server.mjs` does expose SSE.
* Vercel functions cap at 30 s (`maxDuration`); that is fine because no request
  is ever held open for a task, an approval or a stream.
* Cold starts add ~1 s to the first request; heartbeats keep the machine warm.

### Running the cloud locally instead

```powershell
$env:TASKBRIDGE_CLOUD_USER_TOKEN="…"
$env:TASKBRIDGE_CLOUD_MACHINES='[{"id":"home-pc-01","secret":"…","ownerId":"owner"}]'
npm run cloud            # http://127.0.0.1:8788  (sqlite in cloud/data/)
```

`CLOUD_STORE=memory:` runs without a database; `CLOUD_STORE=postgres://…` uses
Postgres; `CLOUD_PORT` changes the port.

### API

```text
Public
  GET    /api/health                       → { status, protocolVersion, machines,
                                               store: memory|sqlite|postgres,
                                               durable: true|false }

Human (bearer user token)
  POST   /api/tasks                        → 202 { taskId, status: QUEUED, machineStatus }
  GET    /api/tasks
  GET    /api/tasks/:id
  DELETE /api/tasks/:id
  GET    /api/tasks/:id/events?after=&limit=
  GET    /api/tasks/:id/approvals
  POST   /api/tasks/:id/commands           { type: ABORT_TASK | FOLLOW_UP | COMPACT |
                                             SET_MODEL | SET_THINKING |
                                             APPROVAL_RESPONSE | FETCH_TOOL_OUTPUT }
  GET    /api/machines                     GET /api/machines/:id
  GET    /api/metrics
  GET    /api/tasks/stream?taskId=&after=&token=   (dev server SSE fast path)

Machine (X-TaskBridge-Machine + bearer secret or HMAC signature)
  POST   /api/bridge/heartbeat
  GET    /api/bridge/commands?after=&limit=
  POST   /api/bridge/commands/:id/ack      { status: ACCEPTED | REJECTED | DUPLICATE | FAILED }
  POST   /api/bridge/events                { machineId, events: [] }
  POST   /api/bridge/reconcile

Local API (session cookie / LAN auth)
  GET    /api/cloud/config                 masked effective configuration
  POST   /api/cloud/config                 validate + persist + apply live
  POST   /api/cloud/test                   heartbeat test, nothing saved
  GET    /debug/cloud                      diagnostics (no secret)
  GET    /api/metrics[?format=prometheus]
  GET    /api/tasks/:id/approvals          pending approvals for the local UI
  POST   /api/tasks/:id/approvals/:id      { decision: ALLOW_ONCE | DENY }
  POST   /api/tasks/:id/approval           internal, per-task token (Pi extension)
  GET    /api/tasks/:id/approval/:id       internal, per-task token (Pi extension)
  GET    /api/tasks/:id/tools/:toolCallId/output[?maxKb=]
  POST   /api/tasks/:id/model              { provider, modelId }
  POST   /api/tasks/:id/thinking           { level }
```

Errors use one envelope (`§93`):

```json
{ "error": { "code": "MACHINE_OFFLINE", "message": "…", "details": {} } }
```

## Interactive tool approvals

Approvals are implemented end to end (§52–§57), not stubbed:

1. `pi-extension/taskbridge-approval.js` is loaded with `pi --extension` and hooks
   `tool_call` (Pi's blocking pre-execution hook).
2. The extension asks the local TaskBridge (`POST /api/tasks/:id/approval`,
   authenticated with a per-task token passed through the child process
   environment) whether the call may proceed.
3. TaskBridge owns the policy (`src/approvals/policy.mjs`): destructive shell
   commands, writes outside the task workspace and any operator-defined regex
   require approval. Benign calls are allowed instantly.
4. A pending approval sets the task to `WAITING_USER`, emits `approval_required`
   and waits. The operator answers from the local UI banner or the remote PWA;
   the answer travels as a normal `APPROVAL_RESPONSE` command.
5. `approval_resolved` is published and the task returns to `RUNNING`. Cancelling
   the task resolves pending approvals as `DENY`, and the extension fails closed
   if the endpoint is unreachable (`approvals.failsafe`).

```jsonc
"approvals": {
  "enabled": false,
  "timeoutMinutes": 1440,
  "timeoutPolicy": "KEEP_WAITING",   // DENY | ABORT_TASK
  "failsafe": "block",               // block | allow when TaskBridge is unreachable
  "approveShell": true,
  "approveOutsideWorkspace": true,
  "approveRead": false,
  "extraPatterns": []
}
```

## Tool output bounding (§38)

Large tool output stays local. `artifacts/tool-<toolCallId>.log` holds the full
log; the cloud receives a rolling window (deltas under the limit, periodic
bounded snapshots over it, intermediate progress may be dropped) and the final
`tool_finished`/`tool_failed` event always carries a bounded `tail`,
`fullLogAvailable`, `localLogId` and `truncated`.

The remote UI shows a **Load full output** button for such tools: it sends
`FETCH_TOOL_OUTPUT`, and the machine uploads one bounded, redacted
`tool_output_full` event. Locally the same data is available at
`GET /api/tasks/:id/tools/:toolCallId/output`.

```jsonc
"cloud": {
  "toolOutput": { "rollingKb": 64, "tailKb": 64, "snapshotMs": 500, "maxFullMb": 4 }
}
```

## Model and thinking changes (§51)

`SET_MODEL` and `SET_THINKING` are real commands backed by Pi RPC
(`set_model` / `set_thinking_level`), not rejections. They apply to a live Pi
session, persist the result on the task and publish `MODEL_CHANGED` /
`THINKING_CHANGED`. The local UI exposes them at
`POST /api/tasks/:id/model` and `POST /api/tasks/:id/thinking`; the machine
heartbeat advertises `commandCapabilities.setModel` / `setThinking` so the remote
UI can disable controls that a build cannot honour.

## Metrics (§89)

* Local: `GET /api/metrics` (JSON) and `GET /api/metrics?format=prometheus`.
  Names follow the specification: `cloud_event_upload_latency_ms`,
  `cloud_event_batch_size`, `cloud_event_retry_count`, `cloud_outbox_size`,
  `cloud_command_latency_ms`, `realtime_reconnect_count`, `task_event_lag`,
  `heartbeat_failure_count`, plus `cloud_buffer_pending_events`.
* Cloud: `GET /api/metrics` summarises machines by status, tasks by status,
  pending commands and event lag, derived from the store (so it stays correct
  across serverless invocations).

## Local settings screen (§91)

`GET /api/cloud/config` returns the effective configuration with the secret
masked (only a 12-character fingerprint); `POST /api/cloud/config` validates the
candidate before persisting it to `config.json` and applies it live;
`POST /api/cloud/test` sends a heartbeat without saving anything. The UI exposes
this behind the ☁ button. Environment variables always win and are reported in
`envLocked`.

## Guarantees

| Scenario | Behaviour |
| --- | --- |
| Browser closed / reloaded | Client persists `lastReceivedSeq` per task and re-fetches `?after=`; deltas append, snapshots replace, so nothing is lost or duplicated |
| Machine loses Internet | Pi keeps running; events queue in the durable outbox; on reconnect the backlog uploads in order |
| Cloud outage / 5xx / 429 | Batch stays in the outbox, retried with backoff; durable state is never dropped |
| Machine restarts | `seq` cursors and the processed-command ledger are persisted; startup reconciles local truth against the cloud replica (`§71`–`§73`) |
| Duplicate command delivery | `commandId` + `seq` ledger makes redelivery a no-op (`§16`) |
| Task created while machine is offline | Command is stored as `PENDING` and delivered on the next poll (`§21`, `§84`) |
| Task runs for hours | No Vercel request is held open; the machine polls/heartbeats |
| Backpressure | Outbox limit drops only non-durable progress events, never lifecycle/final state (`§47`, `§118`) |
| Huge tool output | Full log stays on the machine; only a bounded window plus an on-demand, capped slice is uploaded (`§38`) |
| Risky tool call | Pi blocks until an operator answers locally or remotely; the answer never keeps a cloud request open (`§53`–`§56`) |

## Security

* Machine secret stays local: never sent to the browser, never logged (only a
  12-char fingerprint appears in startup logs), revocable by rotating it in the
  cloud machine list.
* `sanitizeForCloud` redacts Authorization headers, `password=`/`token=`/
  `secret=`/`api_key=` patterns, `sk-…`, `ghp_…`, `xox…`, JWTs, AWS keys and
  PEM private keys before upload; absolute project paths can be aliased to
  `${PROJECT_ID}`.
* Machine credentials are scoped: a machine can only read its own commands,
  upload its own events and ack its own commands (`§66`).
* User requests verify ownership of machine/task/approval ids (`§65`).
* No local files, repositories, API keys or model endpoints are uploaded (`§67`).

## Testing

```powershell
npm test                # all suites, including cloud
npm run test:cloud      # only tests/cloud-*.test.mjs
npm run stress          # bounded stress/soak suite
npm run check:secrets   # no secret can leave the machine (deploy set + git)
```

The stress suite runs bounded versions in CI and scales up through environment
variables so a real soak is a one-liner:

```powershell
$env:TASKBRIDGE_STRESS_EVENTS="30000"   # event-rate test (default 3000)
$env:TASKBRIDGE_STRESS_LOG_MB="100"     # large tool log (default 16)
$env:TASKBRIDGE_STRESS_SECONDS="1800"   # 30-minute soak (default: short)
npm run stress
```

Covered: approvals (policy, manager, command routing, and an end-to-end run
where Pi's extension hook blocks until the operator answers), tool-output
bounding and the on-demand full-output fetch, model/thinking changes, metrics,
the cloud settings API, normalization and snapshots, sequence durability across
restart,
buffer flush/coalescing/priority/backpressure, outbox recovery and limits,
upload retry, reconnect ramp, command idempotency, approval lifecycle, cloud API
(auth, offline queue, machine scope, event dedupe, replay, reconcile repair,
approvals) on both memory and SQLite stores, `/debug/cloud`, the client-side
event reducer (delta append, snapshot replace, coalesced batches, replay dedupe,
out-of-order seq ordering), and a full end-to-end run where a cloud-created task
executes locally through Pi RPC and streams its events back (including remote
STOP).

## Known gaps / follow-ups

1. **No WebSocket fast path.** Polling is authoritative and correct; SSE is an
   optional latency improvement on the dev server. A WebSocket/SSE fast path for
   Vercel is Phase 2 (`§112`) and must not be added before replay semantics work.
2. **Postgres adapter is not verified against a live server here.** It is
   implemented to the same interface and covered by
   `tests/cloud-postgres.test.mjs`, which runs only when
   `TASKBRIDGE_TEST_DATABASE_URL` points at a throw-away database. Run it once
   against your Vercel/Neon database before trusting a deployment.
3. **HMAC raw-body signature.** In the Vercel adapter the body is re-serialized
   from `req.body`; if exact-byte HMAC verification matters, send the raw body
   or use bearer mode.
4. **Approval interception is opt-in.** It requires `approvals.enabled` and Pi
   loading the extension; the extension is not installed globally, it is passed
   per process with `--extension`. Local-only setups that never enable approvals
   behave exactly as before.
5. **Long soak is opt-in.** CI runs bounded stress tests (see above); a 30-minute
   or multi-hour run must be started explicitly with the environment variables.
