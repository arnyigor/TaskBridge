// The published HTTP contract of TaskBridge — the machine-readable half of
// docs/api-contract.md.
//
// Why this file exists: the API is hand-routed (node:http, no framework), so
// nothing stops a route from being renamed or dropped while a client — the PWA
// today, a KMP/Android app tomorrow — keeps calling the old shape. This list is
// what makes the contract *checkable*: tests/api-contract.test.mjs boots a real
// server and fails if any route here stops answering, so the doc cannot drift
// from the code silently.
//
// Rules for changing it:
//   - adding a route: add it here AND to docs/api-contract.md; no version bump.
//   - changing an existing route's shape or meaning: bump API_VERSION below and
//     say what changed in docs/api-contract.md. Clients key off `apiVersion`
//     from GET /api/info.
//
// `sse` marks a stream that never ends on its own (it is excluded from the
// existence probe, which would otherwise wait forever).

export const API_VERSION = 1;

export const API_ROUTES = [
  // --- host / status --------------------------------------------------------
  { method: 'GET', path: '/api/health', summary: 'liveness, no auth' },
  { method: 'GET', path: '/api/info', summary: 'name, build, apiVersion, addresses, engine, system, limits' },
  { method: 'GET', path: '/api/metrics', summary: 'counters as JSON, or Prometheus with ?format=prometheus' },
  { method: 'GET', path: '/debug/cloud', summary: 'cloud transport diagnostics' },

  // --- auth -----------------------------------------------------------------
  { method: 'GET', path: '/api/auth', summary: 'whether the caller is authenticated' },
  { method: 'POST', path: '/api/auth/pair', summary: 'exchange a pairing code for a session cookie' },
  { method: 'GET', path: '/api/auth/pairing', summary: 'current pairing code (PC only: loopback peer and Host)' },

  // --- projects / files -----------------------------------------------------
  { method: 'GET', path: '/api/projects', summary: 'registered projects' },
  { method: 'DELETE', path: '/api/projects/:id', summary: 'remove a project' },
  { method: 'GET', path: '/api/project-browser', summary: 'folders under projectBrowser.roots' },
  { method: 'POST', path: '/api/project-browser/register', summary: 'register a project from a folder path' },
  { method: 'GET', path: '/api/projects/:id/pi-sessions', summary: 'existing Pi session files of a project' },
  { method: 'POST', path: '/api/uploads', summary: 'streamed multipart upload; returns a token + file ids' },

  // --- sessions / models ----------------------------------------------------
  { method: 'GET', path: '/api/native-sessions', summary: 'Pi sessions of every project, grouped' },
  { method: 'GET', path: '/api/native-sessions/preview', summary: 'model, thinking, size and last messages of one' },
  { method: 'GET', path: '/api/models', summary: "Pi's model catalogue (?refresh=1 to re-ask)" },

  // --- tasks ----------------------------------------------------------------
  { method: 'GET', path: '/api/tasks', summary: 'all sessions' },
  { method: 'POST', path: '/api/tasks', summary: 'create a task (commandId/clientId make it idempotent)' },
  { method: 'POST', path: '/api/tasks/from-session', summary: 'import a Pi session (clone by default)' },
  { method: 'GET', path: '/api/tasks/:id', summary: 'one task' },
  { method: 'PATCH', path: '/api/tasks/:id', summary: 'rename' },
  { method: 'DELETE', path: '/api/tasks/:id', summary: 'delete the task and everything it owns' },

  // --- tasks: events and live stream ---------------------------------------
  { method: 'GET', path: '/api/tasks/:id/events', summary: 'events; ?after, ?limit, or ?tail/&before for turn-aligned pages' },
  { method: 'GET', path: '/api/tasks/:id/stream', summary: 'SSE live events, resumable via Last-Event-ID', sse: true },
  { method: 'GET', path: '/api/tasks/:id/state', summary: "Pi's get_state snapshot" },
  { method: 'GET', path: '/api/tasks/:id/runs', summary: 'run history of the session' },

  // --- tasks: control -------------------------------------------------------
  { method: 'POST', path: '/api/tasks/:id/message', summary: 'follow-up / steering; now:true interrupts the current turn' },
  { method: 'POST', path: '/api/tasks/:id/cancel', summary: 'STOP' },
  { method: 'POST', path: '/api/tasks/:id/compact', summary: 'COMPACT' },
  { method: 'POST', path: '/api/tasks/:id/auto-compaction', summary: 'toggle auto compaction' },
  { method: 'POST', path: '/api/tasks/:id/model', summary: 'switch the session model' },
  { method: 'POST', path: '/api/tasks/:id/thinking', summary: 'set the thinking level' },
  { method: 'POST', path: '/api/tasks/:id/pending/send', summary: 'deliver the queued prompt now' },
  { method: 'DELETE', path: '/api/tasks/:id/pending', summary: 'drop the queued prompt' },

  // --- tasks: history rewriting --------------------------------------------
  { method: 'POST', path: '/api/tasks/:id/undo-last-turn', summary: 'retract the last clean turn' },
  { method: 'POST', path: '/api/tasks/:id/clear', summary: 'erase every message of a session, keeping the session (confirm:true)' },
  { method: 'POST', path: '/api/tasks/:id/turns/:turnId/edit', summary: 'rewrite an operator line and re-run from there' },
  { method: 'POST', path: '/api/tasks/:id/turns/:turnId/delete', summary: 'drop a turn and everything after it' },
  { method: 'POST', path: '/api/tasks/:id/regenerate', summary: 'ask for the latest answer again' },
  { method: 'POST', path: '/api/tasks/:id/fork', summary: 'branch the conversation into a new session' },

  // --- tasks: approvals -----------------------------------------------------
  { method: 'POST', path: '/api/tasks/:id/approval', summary: 'Pi extension asks whether a tool call may run' },
  { method: 'GET', path: '/api/tasks/:id/approval/:approvalId', summary: 'the extension polls the operator decision' },
  { method: 'GET', path: '/api/tasks/:id/approvals', summary: 'pending approvals of the session' },
  { method: 'POST', path: '/api/tasks/:id/approvals/:approvalId', summary: 'answer a pending approval' },

  // --- tasks: artifacts and files ------------------------------------------
  { method: 'GET', path: '/api/tasks/:id/artifacts', summary: 'result.md, diff.patch, logs' },
  { method: 'GET', path: '/api/tasks/:id/artifacts/:name', summary: 'download one artifact', binary: true },
  { method: 'GET', path: '/api/tasks/:id/files/:fileId', summary: 'download an upload', binary: true },
  { method: 'GET', path: '/api/tasks/:id/workspace-file', summary: 'read a file from the task workspace (?path=)', binary: true },
  // Opening on the machine: localhost only, body {confirm:true, reveal?}. These
  // launch an OS application, so the contract probe must never be able to run
  // them — the confirm flag is what keeps it harmless.
  { method: 'POST', path: '/api/tasks/:id/files/:fileId/open', summary: 'open an upload with its OS application (or reveal it); the machine itself only' },
  { method: 'POST', path: '/api/tasks/:id/artifacts/:name/open', summary: 'open an artifact with its OS application (or reveal it); the machine itself only' },
  { method: 'POST', path: '/api/tasks/:id/workspace-file/open', summary: 'open a workspace file with its OS application (or reveal it); the machine itself only' },
  { method: 'POST', path: '/api/tasks/:id/files/:fileId/run', summary: 'run an upload as a script and return its output; the machine or an authenticated client (confirm:true)' },
  { method: 'POST', path: '/api/tasks/:id/artifacts/:name/run', summary: 'run an artifact as a script and return its output; the machine or an authenticated client (confirm:true)' },
  { method: 'POST', path: '/api/tasks/:id/workspace-file/run', summary: 'run a workspace file as a script and return its output; the machine or an authenticated client (confirm:true)' },
  { method: 'POST', path: '/api/tasks/:id/shell', summary: 'run a shell command line in the session workspace and return its output; the machine or an authenticated client (confirm:true)' },
  { method: 'GET', path: '/api/tasks/:id/tools/:toolCallId/output', summary: 'full tool output kept on the machine' },
  { method: 'POST', path: '/api/tasks/:id/apply', summary: 'apply diff.patch to the source checkout' },
  { method: 'DELETE', path: '/api/tasks/:id/worktree', summary: 'remove the task worktree' },

  // --- local runtime --------------------------------------------------------
  { method: 'GET', path: '/api/runtime', summary: 'legacy single-profile runtime status' },
  { method: 'POST', path: '/api/runtime/start', summary: 'start the legacy profile' },
  { method: 'POST', path: '/api/runtime/restart', summary: 'restart the legacy profile' },
  { method: 'GET', path: '/api/local', summary: 'llama.cpp router state and models' },
  { method: 'POST', path: '/api/local/load', summary: 'load a router model' },
  { method: 'POST', path: '/api/local/unload', summary: 'unload a router model' },
  { method: 'POST', path: '/api/local/stop', summary: 'stop a TaskBridge-started router' },
  { method: 'POST', path: '/api/local/start', summary: 'start the router' },
  { method: 'GET', path: '/api/local/events', summary: 'SSE router status and load progress', sse: true },

  // --- server administration ------------------------------------------------
  { method: 'POST', path: '/api/server/restart', summary: 'restart the TaskBridge process (body {confirm:true}); answers 202, the relaunch is detached' },

  // --- mcp ------------------------------------------------------------------
  { method: 'GET', path: '/api/mcp', summary: 'MCP servers and mode' },
  { method: 'POST', path: '/api/mcp/mode', summary: 'inherit / managed / off' },
  { method: 'POST', path: '/api/mcp/import', summary: 'import the Pi MCP config' },
  { method: 'POST', path: '/api/mcp/servers', summary: 'enable or disable one server' },
  { method: 'POST', path: '/api/mcp/tools', summary: 'enable or disable one tool' },

  // --- push -----------------------------------------------------------------
  { method: 'GET', path: '/api/push/key', summary: 'VAPID public key (browser push only)' },
  { method: 'POST', path: '/api/push/subscribe', summary: 'register a browser subscription' },
  { method: 'POST', path: '/api/push/unsubscribe', summary: 'drop a browser subscription' },
  { method: 'POST', path: '/api/push/test', summary: 'send a test notification' },

  // --- cloud (server-side only; off by default) -----------------------------
  { method: 'GET', path: '/api/cloud/config', summary: 'cloud settings as the server sees them' },
  { method: 'POST', path: '/api/cloud/config', summary: 'update cloud settings' },
  { method: 'POST', path: '/api/cloud/test', summary: 'probe the configured cloud' },
  { method: 'POST', path: '/api/cloud/pair', summary: 'pair a phone with the cloud' },
  { method: 'GET', path: '/api/cloud/devices', summary: 'paired devices' },
  { method: 'DELETE', path: '/api/cloud/devices/:id', summary: 'revoke a paired device' },

  // --- command ledger -------------------------------------------------------
  { method: 'GET', path: '/api/commands/:commandId', summary: 'outcome of a command id (idempotency contract)' },
];
