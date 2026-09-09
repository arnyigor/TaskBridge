# TaskBridge Cloud Transport via Vercel

## Technical Specification for Remote Access, Streaming, Tool Callbacks, Durable Events, and Long-Running Agent Tasks

**Project:** TaskBridge
**Target system:** Existing TaskBridge local runtime + new optional Vercel cloud control plane
**Primary runtime:** Windows workstation running TaskBridge and Pi Agent
**Primary remote client:** Mobile/desktop browser, preferably installable as PWA
**Architecture type:** Local execution + cloud control plane
**Status:** Development specification
**Language:** English

---

# 1. Purpose

The goal of this development is to extend TaskBridge so that a user can remotely control and observe local AI-agent tasks from any device over the Internet without:

* exposing the local TaskBridge HTTP server directly;
* requiring port forwarding;
* requiring a public IP address;
* requiring a VPN;
* keeping a Vercel Function alive for the entire duration of an agent task;
* moving local project files, credentials, Pi configuration, or local AI models to Vercel.

The existing TaskBridge local runtime must remain responsible for actual task execution.

Vercel must act only as a:

* remote web application host;
* authentication layer;
* command broker;
* event broker;
* task-state store;
* durable event/replay layer;
* optional real-time transport layer.

A task may run locally for minutes or hours without requiring any long-lived Vercel HTTP request.

---

# 2. Core Design Principle

The architecture must explicitly separate:

1. **Task lifetime**
2. **Network connection lifetime**
3. **UI session lifetime**

These must be independent.

A running Pi task must continue even if:

* the phone browser is closed;
* the Internet connection disappears;
* the WebSocket reconnects;
* a Vercel Function invocation ends;
* the user opens the UI on another device;
* Vercel deploys a new frontend version.

The local TaskBridge process is the execution authority.

The cloud is only a transport and persistence layer.

---

# 3. High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                      Remote Client                           │
│                                                             │
│  Browser / PWA                                              │
│                                                             │
│  - task list                                                │
│  - task creation                                            │
│  - streaming assistant output                              │
│  - tool execution cards                                     │
│  - STOP                                                     │
│  - follow-up                                                │
│  - compact                                                  │
│  - approvals                                                │
│  - reconnect/replay                                         │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTPS / WebSocket / SSE
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                       Vercel Cloud                           │
│                                                             │
│  Frontend / PWA                                             │
│  API                                                        │
│  Authentication                                             │
│                                                             │
│  Task Store                                                 │
│  Command Store / Queue                                      │
│  Durable Event Store                                        │
│  Machine Registry                                           │
│  Approval Store                                             │
│                                                             │
│  Optional realtime transport                                │
│                                                             │
└────────────────────────────┬────────────────────────────────┘
                             │
                             │ outbound HTTPS / WS
                             │ initiated by local machine
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                   TaskBridge Local Runtime                   │
│                                                             │
│  CloudTransport                                             │
│  TaskManager                                                │
│  EventMux                                                   │
│  CommandDispatcher                                          │
│  ApprovalManager                                            │
│  PiRpc                                                      │
│                                                             │
│  Git / Worktrees                                            │
│  Projects                                                   │
│  Local logs                                                 │
│                                                             │
│                       pi --mode rpc                          │
└─────────────────────────────────────────────────────────────┘
```

---

# 4. Non-Goals

The first implementation must NOT attempt to:

* execute Pi inside Vercel;
* execute local shell commands inside Vercel;
* upload entire local repositories to Vercel;
* expose a local HTTP port directly to the Internet;
* replace the existing local TaskBridge execution engine;
* depend exclusively on a persistent WebSocket;
* persist every generated token as an individual database row;
* use the cloud as the primary source of Pi session state;
* require cloud mode for LAN/local usage;
* replace local Git/worktree logic.

---

# 5. Existing Functionality That Must Remain Intact

The extension must preserve existing TaskBridge capabilities.

At minimum:

* task creation;
* local task queue;
* project selection;
* working-directory selection;
* Pi RPC execution;
* local model usage;
* Claude/Codex delegation where supported;
* task cancellation;
* process-tree termination fallback;
* follow-up messages;
* compaction;
* model changes if supported;
* thinking/reasoning settings if supported;
* Git operations;
* worktree management;
* local logs;
* local UI/API;
* local LAN operation.

Cloud support must be implemented as an additional transport layer, not as a rewrite of the local runtime.

---

# 6. Required Operating Modes

TaskBridge must support three modes.

## 6.1 Local-Only Mode

```text
Phone/Desktop
      │
      ▼
Local TaskBridge
      │
      ▼
Pi
```

No Vercel dependency.

Use case:

* same LAN;
* testing;
* offline development.

---

## 6.2 Cloud-Only Remote Transport

```text
Remote Client
      │
      ▼
Vercel
      │
      ▼
TaskBridge Worker
      │
      ▼
Pi
```

The local machine creates outbound connections only.

---

## 6.3 Hybrid Mode

Local access and Vercel access may operate simultaneously.

Example:

```text
Desktop browser ─── LAN ──┐
                          │
                          ▼
                    TaskBridge Core
                          ▲
                          │
Phone ── Internet ─ Vercel┘
```

Both interfaces must observe the same running tasks.

---

# 7. Main Architectural Components

## 7.1 TaskBridge Core

Must remain transport-independent.

Responsibilities:

* task lifecycle;
* Pi lifecycle;
* session lifecycle;
* task state machine;
* tool events;
* cancellation;
* follow-up commands;
* compaction;
* Git/worktree behavior;
* local persistence;
* project mapping.

The Core must not directly depend on Vercel APIs.

---

# 8. New Local Components

Recommended structure:

```text
src/
  cloud/
    cloud-transport.mjs
    cloud-client.mjs
    cloud-worker.mjs
    command-dispatcher.mjs
    event-buffer.mjs
    event-uploader.mjs
    event-normalizer.mjs
    reconnect-manager.mjs
    heartbeat.mjs
    approval-manager.mjs
    machine-auth.mjs
    cloud-config.mjs

  events/
    event-mux.mjs
    event-sequence.mjs
    event-snapshot.mjs

  domain/
    task-event.mjs
    cloud-command.mjs
    machine-state.mjs
```

Exact paths may be adapted to the existing repository structure.

---

# 9. CloudTransport Interface

Create a transport abstraction.

Example:

```ts
interface TaskTransport {
    start(): Promise<void>;
    stop(): Promise<void>;

    publishEvents(events: TaskEvent[]): Promise<void>;

    publishTaskState(state: TaskStateUpdate): Promise<void>;

    publishHeartbeat(heartbeat: MachineHeartbeat): Promise<void>;

    onCommand(
        callback: (command: CloudCommand) => Promise<void>
    ): void;

    isConnected(): boolean;
}
```

Possible implementations:

```text
LocalTransport
CloudTransport
CompositeTransport
```

`TaskManager` must not contain Vercel-specific code.

---

# 10. Machine Registration

Every TaskBridge installation must have a stable machine identity.

Example:

```json
{
  "machineId": "home-pc-01",
  "displayName": "Main Windows Workstation"
}
```

The machine ID must not expose:

* username;
* absolute filesystem path;
* Windows account;
* hostname unless explicitly configured.

---

# 11. Machine Authentication

Recommended configuration:

```env
TASKBRIDGE_CLOUD_ENABLED=true
TASKBRIDGE_CLOUD_URL=https://taskbridge.example.app
TASKBRIDGE_MACHINE_ID=home-pc-01
TASKBRIDGE_MACHINE_SECRET=<secret>
```

Authentication:

```http
Authorization: Bearer <machine-secret>
```

or equivalent HMAC-based authentication.

The machine secret must:

* be high entropy;
* be stored locally;
* never be exposed to frontend JavaScript;
* never appear in logs;
* be revocable;
* support rotation.

---

# 12. Local Project Mapping

Vercel must not need to know absolute local project paths.

Example cloud representation:

```json
{
  "projectId": "llama-server",
  "name": "LlamaServer"
}
```

Local mapping:

```json
{
  "llama-server": "G:\\Android\\AndroidStudioProjects\\LlamaServer",
  "taskbridge": "G:\\Android\\AndroidStudioProjects\\TaskBridge"
}
```

The cloud must receive only `projectId`.

The path resolution occurs locally.

---

# 13. Task Lifecycle

Required states:

```text
CREATED
QUEUED
WAITING_MACHINE
STARTING
RUNNING
WAITING_USER
COMPACTING
STOPPING
COMPLETED
FAILED
ABORTED
```

Optional:

```text
PAUSED
RECONNECTING
RECOVERING
```

State transitions must be explicit.

Example:

```text
CREATED
  ↓
QUEUED
  ↓
WAITING_MACHINE
  ↓
STARTING
  ↓
RUNNING
  ├── WAITING_USER
  ├── COMPACTING
  ├── STOPPING → ABORTED
  ├── FAILED
  └── COMPLETED
```

---

# 14. Creating a Task

Example:

```http
POST /api/tasks
```

Request:

```json
{
  "machineId": "home-pc-01",
  "projectId": "llama-server",
  "prompt": "Inspect the current implementation and fix the failing tests.",
  "options": {
    "model": null,
    "thinking": null,
    "worktree": true
  }
}
```

Response:

```json
{
  "taskId": "task_01H...",
  "status": "QUEUED",
  "createdAt": "..."
}
```

The HTTP request must finish immediately.

It must not wait for Pi.

Recommended status:

```text
202 Accepted
```

---

# 15. Cloud Command Model

Commands sent from the cloud to TaskBridge must use a durable command envelope.

```ts
interface CloudCommand {
    commandId: string;
    machineId: string;
    taskId?: string;

    seq: number;

    type:
        | "START_TASK"
        | "ABORT_TASK"
        | "FOLLOW_UP"
        | "COMPACT"
        | "SET_MODEL"
        | "SET_THINKING"
        | "APPROVAL_RESPONSE";

    payload: unknown;

    createdAt: string;
}
```

---

# 16. Command Idempotency

Commands must be safe against duplicate delivery.

TaskBridge must persist:

```text
lastProcessedCommandSeq
```

and/or:

```text
processed commandId set
```

If the same command is received twice, it must not execute twice.

Example:

```text
START_TASK command_123
START_TASK command_123
```

must result in one local task.

---

# 17. Command Acknowledgement

Local TaskBridge must acknowledge commands.

Example:

```http
POST /api/bridge/commands/{commandId}/ack
```

Payload:

```json
{
  "status": "ACCEPTED"
}
```

Possible values:

```text
ACCEPTED
REJECTED
DUPLICATE
FAILED
```

---

# 18. Command Delivery

Cloud commands must support two delivery mechanisms.

## Primary

Realtime transport where available.

Example:

```text
WebSocket
```

## Fallback

Polling.

Example:

```http
GET /api/bridge/commands?after=123
```

Polling must guarantee correctness even when realtime transport is unavailable.

The system must never rely exclusively on WebSocket delivery.

---

# 19. Polling Strategy

Suggested intervals:

### Idle machine

```text
3–10 seconds
```

### Running task

```text
1–3 seconds
```

### WebSocket connected

Polling may be reduced substantially but should remain available for recovery.

Use exponential backoff on failures.

Example:

```text
1s
2s
4s
8s
15s
30s
```

Maximum retry delay should be configurable.

---

# 20. Heartbeat

Local TaskBridge must periodically publish machine state.

Example:

```http
POST /api/bridge/heartbeat
```

Payload:

```json
{
  "machineId": "home-pc-01",
  "timestamp": "...",
  "version": "0.2.0",
  "status": "ONLINE",
  "activeTaskId": "task_123",
  "capabilities": {
    "pi": true,
    "git": true,
    "worktree": true,
    "claude": true,
    "codex": true
  }
}
```

Recommended interval:

```text
15–30 seconds
```

Cloud machine states:

```text
ONLINE
BUSY
OFFLINE
ERROR
```

---

# 21. Offline Machine Behavior

A user must be able to submit a task when the workstation is offline.

Example:

```text
Phone:
START TASK

Cloud:
QUEUED
Machine:
OFFLINE
```

When the machine reconnects:

```text
TaskBridge
    ↓
heartbeat
    ↓
fetch pending commands
    ↓
START_TASK
```

The task then starts automatically.

---

# 22. Streaming Requirements

The remote UI must support live display of:

* assistant text;
* reasoning/thinking if exposed;
* tool invocation;
* tool progress;
* tool completion;
* shell output;
* file edits;
* task status;
* compaction;
* approvals;
* errors.

Streaming must be resilient to reconnects.

---

# 23. Event Normalization

Raw Pi RPC events must be translated into a stable TaskBridge cloud event protocol.

The cloud API must not directly depend on the exact Pi implementation.

Example normalized type:

```ts
interface TaskEvent {
    eventId: string;

    machineId: string;
    taskId: string;

    seq: number;

    timestamp: string;

    type:
        | "task_started"
        | "task_state"
        | "turn_started"
        | "assistant_delta"
        | "assistant_snapshot"
        | "assistant_end"
        | "thinking_delta"
        | "thinking_snapshot"
        | "tool_started"
        | "tool_updated"
        | "tool_finished"
        | "tool_failed"
        | "approval_required"
        | "approval_resolved"
        | "compaction_started"
        | "compaction_finished"
        | "turn_finished"
        | "task_finished"
        | "task_failed"
        | "task_aborted";

    payload: unknown;
}
```

---

# 24. Event Sequence Numbers

Every task must have a strictly monotonic local sequence number.

Example:

```text
1
2
3
4
...
18542
```

Sequence allocation must happen on the local machine before cloud transmission.

Properties:

* unique within task;
* monotonically increasing;
* persistent enough to survive temporary transport disconnects;
* never reused.

---

# 25. Why `seq` Is Mandatory

Suppose the client receives:

```text
1480
1481
1482
```

Then connection is lost.

During disconnection:

```text
1483
...
1550
```

are generated.

After reconnect:

```http
GET /api/tasks/task_123/events?after=1482
```

Cloud returns:

```text
1483 ... 1550
```

Then realtime resumes at:

```text
1551
```

No output is lost.

---

# 26. Event ID

In addition to `seq`, every event should have a globally unique ID.

Recommended:

```text
UUIDv7
```

or equivalent sortable unique identifier.

Example:

```text
eventId = "019..."
```

This enables:

* deduplication;
* debugging;
* tracing;
* replay validation.

---

# 27. Streaming Text

Raw token-level or chunk-level Pi output must be streamed locally as soon as possible.

Example:

```json
{
  "type": "assistant_delta",
  "seq": 100,
  "payload": {
    "text": "Checking "
  }
}
```

Then:

```json
{
  "type": "assistant_delta",
  "seq": 101,
  "payload": {
    "text": "the tests..."
  }
}
```

---

# 28. Delta Batching

Do not issue a separate cloud HTTP request for every delta.

Introduce `EventBuffer`.

Suggested flush rules:

```text
flush every 50–150 ms
OR
flush when buffer reaches configured size
OR
flush immediately for priority event
```

Example:

```json
{
  "events": [
    {
      "seq": 100,
      "type": "assistant_delta",
      "payload": {"text": "Checking "}
    },
    {
      "seq": 101,
      "type": "assistant_delta",
      "payload": {"text": "the tests..."}
    }
  ]
}
```

---

# 29. Delta Coalescing

For high-frequency assistant output, optional coalescing is allowed.

Input:

```text
"Checking "
"the "
"tests..."
```

Cloud batch may contain:

```json
{
  "seqFrom": 100,
  "seqTo": 102,
  "type": "assistant_delta_batch",
  "payload": {
    "text": "Checking the tests..."
  }
}
```

However, sequence continuity must remain recoverable.

---

# 30. Durable Versus Ephemeral Events

Events must be divided into two categories.

## Durable Events

Must always be persisted.

Examples:

```text
task_started
task_state
tool_started
tool_finished
tool_failed
assistant_end
approval_required
approval_resolved
compaction_started
compaction_finished
turn_finished
task_finished
task_failed
task_aborted
```

## High-Frequency Events

May be coalesced.

Examples:

```text
assistant_delta
thinking_delta
tool_updated
terminal output chunks
```

---

# 31. Assistant Snapshots

Do not rely only on thousands of text deltas.

Generate periodic durable snapshots.

Example:

```json
{
  "type": "assistant_snapshot",
  "seq": 1200,
  "payload": {
    "messageId": "msg_12",
    "text": "Complete assistant text generated so far..."
  }
}
```

Suggested policy:

```text
snapshot every 500–1500 ms
```

or:

```text
snapshot every 2–8 KB
```

whichever happens later/earlier according to implementation needs.

The final assistant message must always have a durable full representation.

---

# 32. Tool Execution Lifecycle

Tool execution must use a stable three-phase protocol.

```text
tool_started
     ↓
tool_updated*
     ↓
tool_finished
```

or:

```text
tool_started
     ↓
tool_updated*
     ↓
tool_failed
```

Every event must contain:

```text
toolCallId
```

---

# 33. Tool Start Event

Example:

```json
{
  "eventId": "...",
  "taskId": "task_123",
  "seq": 1400,
  "type": "tool_started",
  "payload": {
    "toolCallId": "call_42",
    "toolName": "bash",
    "args": {
      "command": "./gradlew test"
    }
  }
}
```

Tool-start events must be transmitted with high priority.

---

# 34. Tool Update Event

Example:

```json
{
  "type": "tool_updated",
  "seq": 1401,
  "payload": {
    "toolCallId": "call_42",
    "output": "> Task :compileKotlin"
  }
}
```

---

# 35. Snapshot Versus Delta Tool Output

TaskBridge must explicitly know whether a tool update contains:

```text
DELTA
```

or:

```text
SNAPSHOT
```

Example:

```json
{
  "mode": "snapshot"
}
```

The frontend must then:

```text
delta    → append
snapshot → replace
```

This prevents duplicate output.

---

# 36. Tool Completion Event

Example:

```json
{
  "type": "tool_finished",
  "seq": 1410,
  "payload": {
    "toolCallId": "call_42",
    "exitCode": 0,
    "durationMs": 18231,
    "summary": "BUILD SUCCESSFUL"
  }
}
```

---

# 37. Tool Failure

Example:

```json
{
  "type": "tool_failed",
  "payload": {
    "toolCallId": "call_42",
    "error": {
      "code": "PROCESS_EXIT_NONZERO",
      "message": "Process exited with code 1"
    }
  }
}
```

---

# 38. Large Tool Output

Large outputs must remain primarily local.

Do not automatically upload multi-megabyte terminal logs to cloud storage.

Recommended cloud policy:

```text
live rolling output:
32–128 KB
```

Final event:

```json
{
  "toolCallId": "call_42",
  "exitCode": 1,
  "tail": "...last 64KB...",
  "fullLogAvailable": true,
  "localLogId": "log_123"
}
```

The frontend may expose:

```text
Load full output
```

as a separate explicit operation.

---

# 39. Event Buffer Priorities

Define at least two event priority classes.

## HIGH

Immediate transmission:

```text
task_started
task_failed
task_finished
task_aborted
tool_started
tool_finished
tool_failed
approval_required
approval_resolved
```

## NORMAL

Batchable:

```text
assistant_delta
thinking_delta
tool_updated
terminal output
```

---

# 40. Realtime Transport

Preferred real-time paths:

```text
TaskBridge → Vercel:
WebSocket if stable
or HTTP event batches

Vercel → Browser:
WebSocket
or SSE
```

The actual Vercel transport implementation may evolve.

The domain architecture must not depend on WebSocket-specific semantics.

---

# 41. Realtime Is Only a Fast Path

The following design is prohibited:

```text
Pi
 ↓
WebSocket
 ↓
Browser

disconnect = lost events
```

Required design:

```text
              ┌── realtime
TaskBridge ───┤
              └── durable events
                     │
                     ▼
                  Browser
```

Realtime improves latency.

Durable events guarantee correctness.

---

# 42. Browser Reconnection

The client must persist:

```text
lastReceivedSeq
```

When reconnecting:

```text
1. Connect
2. Request all events after lastReceivedSeq
3. Apply missing events
4. Resume realtime
```

---

# 43. Event API

Example:

```http
GET /api/tasks/{taskId}/events?after=1234&limit=500
```

Response:

```json
{
  "taskId": "task_123",
  "fromSeq": 1235,
  "toSeq": 1400,
  "events": [],
  "hasMore": false
}
```

---

# 44. Event Upload API

Example:

```http
POST /api/bridge/events
```

Request:

```json
{
  "machineId": "home-pc-01",
  "events": []
}
```

The server must perform deduplication using:

```text
taskId + seq
```

and/or:

```text
eventId
```

---

# 45. Event Upload Retry

Local EventUploader must handle:

* timeout;
* HTTP 429;
* HTTP 500;
* temporary network loss;
* Vercel deployment;
* DNS failure.

Failed event batches must remain in a local retry queue.

Events must not be silently dropped.

---

# 46. Local Outbox

Implement a local durable or semi-durable cloud outbox.

Recommended:

```text
data/cloud-outbox/
```

or local database.

State:

```text
PENDING
SENDING
ACKNOWLEDGED
FAILED_RETRY
```

Critical events must survive TaskBridge process restart where practical.

---

# 47. Backpressure

If cloud connectivity disappears while Pi continues generating events, TaskBridge must not crash or block Pi indefinitely.

Required behavior:

```text
Pi continues
      ↓
local event queue grows
      ↓
coalesce non-critical output
      ↓
retain all critical state
```

Introduce configurable limits.

Example:

```text
MAX_OUTBOX_SIZE_MB=100
```

When the limit is reached:

1. preserve lifecycle events;
2. preserve final message state;
3. preserve tool start/end;
4. coalesce or discard intermediate progress events;
5. emit diagnostic warning.

---

# 48. Task Cancellation

Remote UI must provide:

```text
STOP
```

Cloud action:

```http
POST /api/tasks/{taskId}/commands
```

Payload:

```json
{
  "type": "ABORT_TASK"
}
```

Local execution must use the existing TaskBridge abort behavior.

Expected sequence:

```text
ABORT_TASK
     ↓
clear queued Pi input
     ↓
abort current Pi operation
     ↓
wait grace period
     ↓
kill process tree if necessary
     ↓
task_aborted
```

Cancellation must be idempotent.

---

# 49. Follow-Up Messages

While a task is running, the user must be able to send additional instructions.

Example:

```json
{
  "type": "FOLLOW_UP",
  "payload": {
    "text": "Do not change the database layer. Only fix the UI."
  }
}
```

TaskBridge must route this to the active Pi session.

The message must be durable and ordered relative to other commands.

---

# 50. Compaction

Remote UI must expose compaction where supported.

Command:

```json
{
  "type": "COMPACT"
}
```

Events:

```text
compaction_started
compaction_finished
```

Optional payload:

```json
{
  "beforeTokens": 50190,
  "afterTokens": 11742
}
```

The cloud implementation must not perform compaction itself.

---

# 51. Model and Thinking Changes

If local Pi supports runtime changes, cloud commands may expose:

```text
SET_MODEL
SET_THINKING
```

Example:

```json
{
  "type": "SET_THINKING",
  "payload": {
    "level": "medium"
  }
}
```

Unsupported changes must return an explicit error.

---

# 52. Tool Approval System

The architecture must support interactive tool approval.

Use cases:

* destructive Git operations;
* deletion;
* dangerous shell commands;
* operations outside configured workspace;
* privilege escalation;
* sensitive network operations.

---

# 53. Approval Lifecycle

```text
Pi requests tool
      ↓
TaskBridge interception
      ↓
approval_required
      ↓
task state = WAITING_USER
      ↓
remote UI
      ↓
ALLOW / DENY
      ↓
approval_response command
      ↓
local callback resolved
      ↓
Pi continues
```

---

# 54. Approval Event

Example:

```json
{
  "type": "approval_required",
  "payload": {
    "approvalId": "approval_123",
    "toolCallId": "call_42",
    "toolName": "bash",
    "args": {
      "command": "git reset --hard"
    },
    "risk": "destructive"
  }
}
```

---

# 55. Approval Response

Example:

```json
{
  "type": "APPROVAL_RESPONSE",
  "payload": {
    "approvalId": "approval_123",
    "decision": "ALLOW_ONCE"
  }
}
```

Allowed values:

```text
ALLOW_ONCE
DENY
```

Optional later:

```text
ALLOW_SESSION
ALLOW_RULE
```

Do not implement persistent broad approval rules in the MVP unless explicitly needed.

---

# 56. Approval Must Not Keep Cloud Request Open

Never implement:

```js
await waitForUserApproval();
```

inside a Vercel request handler.

Instead:

```text
approval database state:
PENDING
```

A later HTTP request changes it to:

```text
APPROVED
```

The local machine receives the decision asynchronously.

---

# 57. Local Approval Timeout

Approval timeout must be configurable.

Example:

```env
TASKBRIDGE_APPROVAL_TIMEOUT_MINUTES=1440
```

Possible policies:

```text
DENY
KEEP_WAITING
ABORT_TASK
```

Recommended default:

```text
KEEP_WAITING
```

with a maximum administrative retention timeout.

---

# 58. Browser Task UI

Each task screen should show:

```text
Task title
Project
Machine
Status
Start time
Duration
Current model
Current activity
```

Main sections:

```text
Conversation
Tools
Task Events
Logs
Controls
```

---

# 59. Streaming Assistant UI

Assistant output must render incrementally.

Do not recreate the entire message DOM on every delta.

Use append/update logic.

Each logical message should have:

```text
messageId
startedAt
completedAt
status
text
```

States:

```text
STREAMING
COMPLETE
INTERRUPTED
```

---

# 60. Tool Cards

Tool call representation:

```text
▶ bash
  ./gradlew test

  > Task :compileKotlin
  > Task :test

  running...
```

After success:

```text
✓ bash
  ./gradlew test

  BUILD SUCCESSFUL

  18.2 s
```

On error:

```text
✗ bash
  ./gradlew test

  Process exited with code 1
```

---

# 61. Tool UI Requirements

Each tool card should expose:

* name;
* arguments;
* status;
* start time;
* duration;
* streaming output;
* final result;
* error;
* `toolCallId`.

For file edit tools, optionally show:

```text
+12 -4
```

if such information is available.

---

# 62. Connection Indicator

The frontend must distinguish:

```text
Cloud connected
Machine online
Task running
Realtime connected
```

These are separate states.

Example:

```text
Cloud: Online
Machine: Online
Realtime: Reconnecting
Task: Running
```

Task must not appear stopped simply because realtime transport reconnects.

---

# 63. Machine Dashboard

Display:

```text
Main Windows Workstation

Status: ONLINE
Active task: 1
Queued tasks: 2
TaskBridge: 0.x.x
Last heartbeat: 4 sec ago
```

Optional capabilities:

```text
Pi
Claude
Codex
Git
Worktrees
Local LLM
```

---

# 64. Authentication for Human Users

Cloud frontend must require authentication.

Minimum requirement:

* single-user authentication;
* secure session;
* no anonymous task access.

Possible implementation:

* Vercel-compatible auth provider;
* passwordless email;
* OAuth;
* custom single-user account.

Exact provider may be decided during implementation.

---

# 65. Authorization

Every request must verify that the authenticated user owns or is authorized to access:

```text
machineId
taskId
event stream
approvalId
```

Never trust IDs supplied by frontend alone.

---

# 66. Machine Scope

A machine credential may only:

* read commands addressed to itself;
* upload events for itself;
* heartbeat as itself;
* acknowledge its commands.

It must not query another machine's data.

---

# 67. Secret Handling

Never upload:

* local AI API keys;
* Claude credentials;
* Codex credentials;
* local model endpoint credentials;
* Git credentials;
* SSH keys;
* Windows environment variables;
* unrestricted filesystem paths.

---

# 68. Sensitive Tool Arguments

Before cloud upload, support redaction.

Patterns to redact:

```text
Authorization headers
API keys
Bearer tokens
password=
token=
secret=
private keys
```

Implement:

```text
sanitizeForCloud(...)
```

before event upload.

---

# 69. Path Redaction

Absolute local paths should optionally be mapped to aliases.

Instead of:

```text
G:\Android\AndroidStudioProjects\TaskBridge\src\...
```

cloud may receive:

```text
${PROJECT_ROOT}\src\...
```

This must be configurable.

---

# 70. Cloud Data Retention

Define configurable retention.

Example:

```text
task metadata: 90 days
event log: 30 days
large tool logs: local only
```

Allow manual deletion of completed task history.

---

# 71. Local Source of Truth

For execution state, local TaskBridge remains authoritative.

Cloud task state is a replicated representation.

Example mismatch:

```text
Cloud: RUNNING
Machine restarted
```

After reconnect, local state reconciliation must correct cloud state.

---

# 72. Reconciliation

On startup, TaskBridge sends:

```json
{
  "machineId": "...",
  "activeTasks": [...],
  "lastEventSeqByTask": {...}
}
```

The cloud compares state.

Possible recovery cases:

* cloud thinks task is running, local task missing;
* local task completed while network was offline;
* pending cloud command already executed;
* events uploaded only partially.

---

# 73. Restart Recovery

After local TaskBridge restart:

1. load local task state;
2. load cloud outbox;
3. restore sequence numbers;
4. reconnect;
5. send heartbeat;
6. reconcile tasks;
7. upload pending events;
8. fetch missing commands.

No sequence number may restart at zero for an existing task.

---

# 74. Cloud Deployment Recovery

A new Vercel deployment must not invalidate running tasks.

State must live outside individual Function memory.

Do not use process memory as durable state.

---

# 75. Database Entities

Recommended conceptual schema.

## Machine

```text
id
ownerId
displayName
status
lastHeartbeatAt
version
capabilities
createdAt
```

## Task

```text
id
ownerId
machineId
projectId
status
prompt
createdAt
startedAt
finishedAt
lastEventSeq
```

## Command

```text
id
machineId
taskId
seq
type
payload
status
createdAt
acknowledgedAt
```

## Event

```text
id
taskId
machineId
seq
type
payload
createdAt
```

## Approval

```text
id
taskId
toolCallId
status
requestPayload
decision
createdAt
resolvedAt
```

---

# 76. Database Uniqueness Constraints

At minimum:

```text
UNIQUE(taskId, seq)
UNIQUE(eventId)
UNIQUE(commandId)
```

Command sequence should be unique within machine scope.

---

# 77. Task Event Ordering

Frontend rendering must use:

```text
seq
```

not database insertion time.

Network arrival order cannot be trusted.

---

# 78. Rate Control

The CloudTransport must avoid excessive requests.

Recommended starting values:

```text
delta flush interval:      75 ms
normal event batch max:    100 events
batch max payload:         128–512 KB
heartbeat:                 20 sec
idle command polling:      5 sec
active polling fallback:   1 sec
```

All values must be configurable.

---

# 79. Optional Compression

Large event batches may support HTTP compression.

Recommended:

```text
gzip
```

Do not add custom compression in the MVP unless necessary.

---

# 80. Realtime Failure Strategy

Example:

```text
WebSocket connected
      ↓
disconnect
      ↓
mark REALTIME_RECONNECTING
      ↓
enable HTTP polling
      ↓
retry WS
      ↓
fetch missing events
      ↓
switch back to realtime
```

The user task continues throughout.

---

# 81. Cloud Outage

If Vercel becomes unavailable:

```text
TaskBridge local task continues
```

The system must:

* queue critical events locally;
* coalesce streaming deltas;
* continue Pi;
* allow local UI control;
* retry cloud connection.

After recovery:

```text
upload missing events
update state
resume remote control
```

---

# 82. Internet Failure on Mobile

If only the client loses network:

```text
Pi continues
TaskBridge continues
Cloud continues
```

After reconnect:

```text
fetch events after lastSeq
```

---

# 83. Internet Failure on Workstation

If workstation loses Internet:

```text
Pi continues
local TaskBridge continues
```

Cloud shows:

```text
Machine: OFFLINE
Task: last known RUNNING
```

Prefer displaying:

```text
RUNNING — machine connection lost
```

instead of incorrectly marking task failed.

---

# 84. STOP During Machine Offline

If the user requests STOP while the machine is offline:

```text
ABORT_TASK
```

must remain queued.

When the workstation reconnects, abort should be delivered before lower-priority queued interactions where appropriate.

---

# 85. Command Priority

Recommended priorities:

```text
1. ABORT_TASK
2. APPROVAL_RESPONSE
3. FOLLOW_UP
4. COMPACT
5. SET_*
6. START_TASK
```

Actual command ordering must still preserve correctness.

---

# 86. Observability

Local logs must include:

```text
cloud connected
cloud disconnected
commands received
command ack
event batch upload
retry
queue size
last uploaded seq
heartbeat state
reconciliation
```

Never log secrets.

---

# 87. Structured Logging

Prefer structured entries.

Example:

```json
{
  "level": "info",
  "component": "CloudTransport",
  "taskId": "task_123",
  "event": "batch_uploaded",
  "fromSeq": 1200,
  "toSeq": 1260
}
```

---

# 88. Diagnostic Endpoint

Local development mode may expose:

```http
GET /debug/cloud
```

Example:

```json
{
  "connected": true,
  "realtime": false,
  "lastHeartbeat": "...",
  "pendingEvents": 12,
  "lastUploadedSeq": {
    "task_123": 1820
  },
  "lastCommandSeq": 93
}
```

Must not expose credentials.

---

# 89. Metrics

Recommended metrics:

```text
cloud_event_upload_latency_ms
cloud_event_batch_size
cloud_event_retry_count
cloud_outbox_size
cloud_command_latency_ms
realtime_reconnect_count
task_event_lag
heartbeat_failure_count
```

---

# 90. Configuration

Example:

```env
TASKBRIDGE_CLOUD_ENABLED=true

TASKBRIDGE_CLOUD_URL=https://taskbridge.example.app

TASKBRIDGE_MACHINE_ID=home-pc-01
TASKBRIDGE_MACHINE_SECRET=...

TASKBRIDGE_CLOUD_REALTIME=true

TASKBRIDGE_EVENT_FLUSH_MS=75
TASKBRIDGE_EVENT_BATCH_MAX=100
TASKBRIDGE_EVENT_BATCH_MAX_KB=256

TASKBRIDGE_HEARTBEAT_SECONDS=20

TASKBRIDGE_IDLE_POLL_SECONDS=5
TASKBRIDGE_ACTIVE_POLL_SECONDS=1

TASKBRIDGE_MAX_OUTBOX_MB=100

TASKBRIDGE_CLOUD_REDACT_PATHS=true
```

---

# 91. Local Configuration UI

TaskBridge should eventually provide a configuration screen:

```text
Cloud Access

[✓] Enable Vercel cloud transport

Cloud URL
[................................]

Machine ID
[home-pc-01]

Machine secret
[••••••••••••••]

[ Test Connection ]

Status:
Connected
```

MVP may use environment variables only.

---

# 92. Suggested API Surface

## Human API

```text
POST   /api/tasks
GET    /api/tasks
GET    /api/tasks/:id
GET    /api/tasks/:id/events
POST   /api/tasks/:id/commands

GET    /api/machines
GET    /api/machines/:id
```

## Machine API

```text
POST   /api/bridge/heartbeat

GET    /api/bridge/commands
POST   /api/bridge/commands/:id/ack

POST   /api/bridge/events
POST   /api/bridge/reconcile
```

Realtime endpoint:

```text
/api/realtime
```

exact implementation may vary.

---

# 93. API Error Format

Use a consistent format.

```json
{
  "error": {
    "code": "MACHINE_OFFLINE",
    "message": "The selected TaskBridge machine is offline.",
    "details": {}
  }
}
```

Common codes:

```text
UNAUTHORIZED
FORBIDDEN
TASK_NOT_FOUND
MACHINE_NOT_FOUND
MACHINE_OFFLINE
COMMAND_REJECTED
TASK_ALREADY_FINISHED
APPROVAL_NOT_FOUND
INVALID_STATE
RATE_LIMITED
INTERNAL_ERROR
```

---

# 94. Versioning

Cloud protocol must have a version.

Example:

```http
X-TaskBridge-Protocol: 1
```

or payload:

```json
{
  "protocolVersion": 1
}
```

The machine heartbeat must expose supported protocol version.

---

# 95. Capability Negotiation

A machine may advertise:

```json
{
  "capabilities": {
    "followUp": true,
    "abort": true,
    "compact": true,
    "approvals": true,
    "setModel": true,
    "setThinking": true,
    "toolStreaming": true
  }
}
```

Frontend should disable unsupported controls.

---

# 96. Testing Strategy

Testing must include:

1. unit tests;
2. integration tests;
3. reconnect tests;
4. offline tests;
5. duplicate-delivery tests;
6. long-running simulation;
7. high-frequency streaming tests;
8. tool callback tests;
9. security tests.

---

# 97. Unit Tests

Required examples:

### EventSequence

```text
generates monotonically increasing sequence numbers
restores sequence after restart
does not duplicate sequence numbers
```

### EventBuffer

```text
flushes after interval
flushes on max size
high-priority event forces flush
coalesces deltas
does not drop durable events
```

### CommandDispatcher

```text
routes START_TASK
routes ABORT_TASK
rejects invalid task
deduplicates commandId
```

### ApprovalManager

```text
creates pending approval
resolves allow
resolves deny
rejects duplicate resolution
```

---

# 98. Integration Test: Normal Task

Scenario:

```text
1. Cloud creates task
2. Machine receives START_TASK
3. Pi starts
4. assistant_delta events arrive
5. tool_started arrives
6. tool_updated arrives
7. tool_finished arrives
8. assistant_end arrives
9. task_finished arrives
```

Verify exact ordering.

---

# 99. Integration Test: Browser Reconnect

```text
1. Receive events 1–100
2. Disconnect browser
3. Generate events 101–250
4. Reconnect
5. Request after=100
6. Receive 101–250
7. Resume realtime at 251
```

No duplicates or gaps allowed.

---

# 100. Integration Test: Workstation Network Failure

```text
1. Task running
2. Disable workstation Internet
3. Generate 500 events locally
4. Restore Internet
5. Upload backlog
6. Verify cloud receives complete durable state
7. Verify output reconstruction
```

Pi must continue during disconnection.

---

# 101. Integration Test: Vercel Failure

Simulate:

```text
HTTP 500
HTTP timeout
HTTP 429
WebSocket disconnect
```

Verify:

* no task crash;
* retries occur;
* local queue persists;
* durable events eventually arrive.

---

# 102. Integration Test: Duplicate Command

Send identical:

```text
commandId=abc
START_TASK
```

twice.

Expected:

```text
one Pi task
```

---

# 103. Integration Test: STOP

```text
1. Start long shell operation
2. Send ABORT_TASK
3. TaskBridge calls abort
4. process terminates
5. task_aborted emitted
```

Verify no orphan child processes remain.

---

# 104. Integration Test: Offline STOP

```text
1. Machine offline
2. user presses STOP
3. command stored
4. machine reconnects
5. abort delivered
```

---

# 105. Integration Test: Approval

```text
1. tool requests destructive action
2. approval_required emitted
3. Pi waits locally
4. cloud Function exits
5. user approves 5 minutes later
6. machine receives APPROVAL_RESPONSE
7. Pi resumes
```

This proves no long-running cloud request is required.

---

# 106. Stress Test: Streaming

Simulate:

```text
100 events/sec
```

for at least:

```text
30 minutes
```

Verify:

* event buffering;
* stable memory usage;
* manageable request count;
* correct final reconstructed transcript.

---

# 107. Stress Test: Large Tool Log

Simulate:

```text
100 MB stdout
```

Expected:

* full log remains local;
* cloud receives bounded rolling output;
* TaskBridge memory remains bounded;
* final tool event is delivered.

---

# 108. Long-Running Task Test

Run simulated task for:

```text
2–8 hours
```

During execution:

* reconnect browser repeatedly;
* restart frontend;
* disconnect workstation Internet;
* reconnect;
* restart cloud deployment if test environment permits.

Task state must remain coherent.

---

# 109. Security Tests

Verify:

* invalid machine token rejected;
* machine A cannot read machine B commands;
* user A cannot read user B task;
* secrets redacted;
* path traversal rejected;
* invalid projectId rejected;
* replayed command does not execute twice;
* approval ID cannot be guessed and reused.

---

# 110. MVP Scope

The first usable cloud MVP should include only:

### Local

* CloudTransport;
* heartbeat;
* command polling;
* event batching;
* reconnect;
* local outbox;
* START_TASK;
* ABORT_TASK;
* FOLLOW_UP;
* basic tool events;
* assistant streaming.

### Cloud

* authentication;
* machine registry;
* task creation;
* task state;
* command storage;
* event storage;
* basic task UI;
* reconnect/replay.

### Not required in MVP

* advanced approval rules;
* full remote filesystem browser;
* remote terminal;
* multiple human users;
* cloud-based LLM routing;
* complex workflow orchestration;
* permanent WebSocket dependence.

---

# 111. MVP Acceptance Criteria

The MVP is accepted only if all conditions below pass.

## Remote launch

From a phone outside the local LAN:

```text
Create task
      ↓
Task appears locally
      ↓
Pi starts
```

---

## Live response

Assistant output begins appearing remotely before the task finishes.

---

## Live tools

Tool executions are visible as separate entities:

```text
START
UPDATE
END
```

---

## Long execution

A task may run for at least:

```text
60 minutes
```

without relying on a single 60-minute Vercel request.

---

## Client reconnect

Close the browser.

Wait.

Open again.

The full missing output must be reconstructed.

---

## Workstation reconnect

Disconnect workstation Internet.

Pi must continue.

Reconnect Internet.

Cloud output must catch up.

---

## STOP

Remote STOP must terminate the local task.

---

## Follow-up

Remote follow-up must reach the active Pi session.

---

## Offline queue

Create task while workstation is offline.

When workstation reconnects, task must start.

---

## No incoming network requirement

The workstation must work without:

* port forwarding;
* public IP;
* inbound firewall rule.

---

# 112. Phase 2

After the MVP is stable, add:

* WebSocket fast path;
* PWA installation;
* push notifications;
* interactive approval UI;
* tool-output expansion;
* multiple machines;
* task scheduling;
* better task search;
* artifact/file transfer;
* model selector;
* reasoning selector;
* compact controls;
* notifications for completion/failure.

---

# 113. Phase 3

Possible future features:

* multi-agent task routing;
* Claude/Codex/local-model delegation;
* task dependency graph;
* queued workflows;
* user approvals between workflow stages;
* persistent agent sessions;
* automatic retries;
* provider fallback;
* resource monitoring;
* GPU/model state;
* mobile notifications;
* machine wake integration where technically possible;
* multiple TaskBridge workers.

---

# 114. Recommended Implementation Order

## Step 1

Refactor local TaskBridge events into a normalized `TaskEvent`.

Do not implement cloud yet.

---

## Step 2

Introduce:

```text
EventMux
EventSequence
```

Ensure all local Pi events receive stable sequence numbers.

---

## Step 3

Implement:

```text
CloudTransport
```

with heartbeat only.

Verify machine appears online remotely.

---

## Step 4

Implement command polling:

```text
START_TASK
```

---

## Step 5

Implement state synchronization.

---

## Step 6

Implement event batches.

Start with durable events.

---

## Step 7

Add assistant streaming.

---

## Step 8

Add tool execution streaming.

---

## Step 9

Add reconnect and replay.

This step is mandatory before declaring cloud streaming stable.

---

## Step 10

Add:

```text
ABORT_TASK
FOLLOW_UP
```

---

## Step 11

Implement local outbox and offline recovery.

---

## Step 12

Add WebSocket/SSE as latency optimization.

Do not add it before replay semantics work.

---

## Step 13

Add approval callbacks.

---

## Step 14

Perform long-running and network-failure tests.

---

# 115. Architectural Rule for Realtime

A critical project rule:

> Realtime delivery is an optimization. Durable state and replay provide correctness.

This rule must not be violated during implementation.

---

# 116. Architectural Rule for Vercel

A second critical rule:

> Vercel must never own the lifecycle of a local Pi process.

Vercel may request:

```text
START
STOP
FOLLOW_UP
COMPACT
APPROVE
```

but TaskBridge owns execution.

---

# 117. Architectural Rule for Local Data

A third critical rule:

> Local project files and execution credentials remain local unless an explicit future feature intentionally transfers specific data.

Cloud functionality must not accidentally evolve into repository synchronization.

---

# 118. Architectural Rule for Event Loss

A fourth critical rule:

> It is acceptable to coalesce intermediate visual progress. It is not acceptable to lose final semantic state.

Always preserve:

* final assistant message;
* tool start;
* tool result;
* task state;
* task result;
* approval state;
* errors.

---

# 119. Definition of Done

The cloud integration is considered production-ready when:

* local mode still works without Vercel;
* cloud mode works without inbound networking;
* Pi tasks survive browser disconnects;
* Pi tasks survive cloud transport disconnects;
* assistant text streams remotely;
* tool calls stream remotely;
* missing events are replayable;
* STOP works;
* follow-up works;
* duplicate commands are harmless;
* queued offline tasks work;
* local secrets stay local;
* cloud event volume is bounded;
* multi-hour tasks are supported;
* no Vercel Function must stay alive for the full task duration;
* automated tests cover all major recovery scenarios.

---

# 120. Final Target Architecture

```text
                               ┌─────────────────────┐
                               │   Browser / PWA     │
                               │                     │
                               │ Tasks               │
                               │ Streaming           │
                               │ Tools               │
                               │ STOP                │
                               │ Follow-up           │
                               │ Approvals           │
                               └─────────┬───────────┘
                                         │
                         HTTPS / WS / SSE│
                                         ▼
┌────────────────────────────────────────────────────────────┐
│                         VERCEL                             │
│                                                            │
│ Authentication                                             │
│ Task API                                                   │
│ Machine API                                                │
│                                                            │
│ Commands              Durable Events                       │
│     │                       ▲                              │
│     │                       │                              │
│     └──────────────┐   ┌────┘                              │
│                    │   │                                   │
└────────────────────┼───┼───────────────────────────────────┘
                     │   │
             outbound│   │outbound
                     ▼   │
┌────────────────────────────────────────────────────────────┐
│                    TASKBRIDGE LOCAL                         │
│                                                            │
│ CloudTransport                                             │
│     │                                                      │
│ CommandDispatcher                                          │
│     │                                                      │
│ TaskManager ◄──── EventMux ─── EventBuffer                 │
│     │                             │                         │
│     │                             └──── Cloud Outbox        │
│     │                                                      │
│ ApprovalManager                                            │
│     │                                                      │
│ PiRpc                                                      │
│     │                                                      │
│ pi --mode rpc                                              │
│     │                                                      │
│ Local project / Git / tools / models                       │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

The result should behave like a lightweight remote agent control system while keeping execution fully local.

The architecture should provide most of the remote-control functionality that would otherwise require a larger agent platform, while preserving direct control over Pi, local models, compaction, project files, Git operations, and the TaskBridge runtime itself.
