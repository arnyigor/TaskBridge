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
* `cloud/api/index.mjs` + `cloud/vercel.json` — Vercel entry point (project root
  must be `cloud/`).
* `cloud/web/` — installable PWA: machine dashboard, task list/creation, live
  conversation, tool cards, activity log, STOP / follow-up / compact / approvals,
  connection indicators, replay after reconnect.

Run it locally:

```powershell
$env:TASKBRIDGE_CLOUD_USER_TOKEN="…"
$env:TASKBRIDGE_CLOUD_MACHINES='[{"id":"home-pc-01","secret":"…","ownerId":"owner"}]'
npm run cloud            # http://127.0.0.1:8788  (sqlite in cloud/data/)
```

`CLOUD_STORE=memory:` runs without a database; `CLOUD_PORT` changes the port.
The Vercel function reads `TASKBRIDGE_CLOUD_STORE` (with `CLOUD_STORE` as a
fallback) and defaults to `memory:` — which is *not* durable, so a serverless
deployment must point it at a persistent adapter.

### API

```text
Human (bearer user token)
  POST   /api/tasks                        → 202 { taskId, status: QUEUED, machineStatus }
  GET    /api/tasks
  GET    /api/tasks/:id
  DELETE /api/tasks/:id
  GET    /api/tasks/:id/events?after=&limit=
  GET    /api/tasks/:id/approvals
  POST   /api/tasks/:id/commands           { type: ABORT_TASK | FOLLOW_UP | COMPACT |
                                             SET_MODEL | SET_THINKING | APPROVAL_RESPONSE }
  GET    /api/machines                     GET /api/machines/:id
  GET    /api/tasks/stream?taskId=&after=&token=   (dev server SSE fast path)

Machine (X-TaskBridge-Machine + bearer secret or HMAC signature)
  POST   /api/bridge/heartbeat
  GET    /api/bridge/commands?after=&limit=
  POST   /api/bridge/commands/:id/ack      { status: ACCEPTED | REJECTED | DUPLICATE | FAILED }
  POST   /api/bridge/events                { machineId, events: [] }
  POST   /api/bridge/reconcile
```

Errors use one envelope (`§93`):

```json
{ "error": { "code": "MACHINE_OFFLINE", "message": "…", "details": {} } }
```

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
npm test            # all suites, including cloud
npm run test:cloud  # only tests/cloud-*.test.mjs
```

Covered: normalization and snapshots, sequence durability across restart,
buffer flush/coalescing/priority/backpressure, outbox recovery and limits,
upload retry, reconnect ramp, command idempotency, approval lifecycle, cloud API
(auth, offline queue, machine scope, event dedupe, replay, reconcile repair,
approvals) on both memory and SQLite stores, `/debug/cloud`, the client-side
event reducer (delta append, snapshot replace, coalesced batches, replay dedupe,
out-of-order seq ordering), and a full end-to-end run where a cloud-created task
executes locally through Pi RPC and streams its events back (including remote
STOP).

## Known gaps / follow-ups

1. **Approvals are not intercepted yet.** `ApprovalManager`, the
   `approval_required`/`approval_resolved` events, the `APPROVAL_RESPONSE`
   command and the cloud approval records are implemented and tested, but the
   Pi RPC client in this repository has no tool-approval callback, so nothing
   calls `request()` automatically. Hooking it into the Pi tool pipeline is the
   remaining step (Phase 2, `§112`).
2. **No WebSocket fast path.** Polling is authoritative and correct; SSE is an
   optional latency improvement on the dev server. A WebSocket/SSE fast path for
   Vercel is Phase 2 (`§112`) and must not be added before replay semantics work.
3. **No Postgres adapter.** `SqliteStore` covers single-node deployments. Vercel's
   filesystem is ephemeral, so a serverless deployment needs a Postgres adapter
   implementing the same `store` interface (`cloud/lib/store.mjs`).
4. **HMAC raw-body signature.** In the Vercel adapter the body is re-serialized
   from `req.body`; if exact-byte HMAC verification matters, send the raw body
   or use bearer mode.
5. `SET_MODEL` / `SET_THINKING` are rejected with `COMMAND_REJECTED` until Pi
   RPC exposes runtime model/thinking changes; the frontend should disable those
   controls based on `commandCapabilities`.
