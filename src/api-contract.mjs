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
  { method: 'GET', path: '/api/info', summary: 'name, build, apiVersion, addresses, engine, system, limits, last known provider balances/subscriptions (no provider requests on the poll)' },
  { method: 'POST', path: '/api/providers/refresh', summary: 'fresh provider balances/subscriptions now (operator action, cooldown-guarded)' },
  { method: 'GET', path: '/api/metrics', summary: 'counters as JSON, or Prometheus with ?format=prometheus' },
  { method: 'GET', path: '/debug/cloud', summary: 'cloud transport diagnostics' },

  // --- auth -----------------------------------------------------------------
  { method: 'GET', path: '/api/auth', summary: 'whether the caller is authenticated' },
  { method: 'POST', path: '/api/auth/pair', summary: 'exchange a pairing code for a device token: HttpOnly cookie for browsers, `token` in the body for clientKind android|desktop|cli' },
  { method: 'GET', path: '/api/auth/pairing', summary: 'current pairing code and the QR payload (PC only: loopback peer, Host and X-Forwarded-For)' },
  { method: 'GET', path: '/api/auth/devices', summary: 'paired devices (no tokens), `current` marks the caller' },
  { method: 'DELETE', path: '/api/auth/devices/:deviceId', summary: 'revoke a device (PC only)' },

  // --- projects / files -----------------------------------------------------
  { method: 'GET', path: '/api/projects', summary: 'registered projects' },
  { method: 'GET', path: '/api/quick-actions', summary: 'Pi slash quick actions for clients (skills, prompts and built-ins)' },
  { method: 'DELETE', path: '/api/projects/:id', summary: 'remove a project' },
  { method: 'GET', path: '/api/project-browser', summary: 'folders under projectBrowser.roots' },
  { method: 'POST', path: '/api/project-browser/register', summary: 'register a project from a folder path' },
  { method: 'POST', path: '/api/projects/local-register', summary: 'register any existing folder on the server machine (localhost only)' },
  { method: 'GET', path: '/api/projects/:id/pi-sessions', summary: 'existing Pi session files of a project' },
  { method: 'POST', path: '/api/uploads', summary: 'streamed multipart upload; returns a token + file ids' },

  // --- sessions / models ----------------------------------------------------
  { method: 'GET', path: '/api/native-sessions', summary: 'Pi sessions of every project, grouped' },
  { method: 'GET', path: '/api/native-sessions/preview', summary: 'model, thinking, size and last messages of one' },
  { method: 'GET', path: '/api/models', summary: "Pi's model catalogue (?refresh=1 to re-ask and sync modelSync.providers' model lists first)" },

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
  { method: 'POST', path: '/api/tasks/:id/session/restart', summary: 'kill the session\'s Pi process; the next message restarts it from the saved session file — the routine exit for a hung session (a server restart is the emergency one)' },
  { method: 'GET', path: '/api/tasks/:id/context', summary: 'where the model context comes from: system prompt, project instructions, skills, MCP tools with estimated sizes, plus Pi\'s own totals' },
  { method: 'POST', path: '/api/tasks/:id/context', summary: 'set the session context limit in tokens ({"limit": N} or null); over it TaskBridge compacts the history at the end of a turn' },
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
  { method: 'GET', path: '/api/tasks/:id/workspace-files', summary: 'list files in the task workspace (relative paths for @-references)' },
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
  { method: 'GET', path: '/api/local', summary: 'llama.cpp router state and models; router entries carry loadRatio 0..1 while status=loading (llama.cpp reports load stages), external engines load in one go and leave it null; router preset rows also carry filesPresent/missingFile, vision, visionEditable and removable from their models.ini section; external rows carry removable (own config entry) or hideable (auto-discovered), and the response lists hidden row ids' },
  { method: 'POST', path: '/api/local/load', summary: 'load a router model' },
  { method: 'POST', path: '/api/local/unload', summary: 'unload a router model' },
  { method: 'POST', path: '/api/local/context', summary: 'load-time context of an external local server (Strata): writes --max-context into the server config, applies on the next load' },
  { method: 'POST', path: '/api/local/vision', summary: 'vision of a llama.cpp router preset: writes mmproj (no-mmproj off) or no-mmproj = true into its models.ini section, applies after the router restarts; answers {file, vision, previous, mmproj, changed, restartRequired}' },
  { method: 'POST', path: '/api/local/forget', summary: 'drop one row from the list: an external server from config.json (localRuntime.externalServers), a router preset section from models.ini, or an auto-discovered row (Pi provider + install dir) which is only hidden; the model, its files and the engine config are left alone; answers {removed, ...localStatus}' },
  { method: 'POST', path: '/api/local/unhide', summary: 'bring a hidden auto-discovered row back into the list (removes it from localRuntime.externalHidden); answers localStatus with the hidden ids in `hidden`' },
  { method: 'POST', path: '/api/local/stop', summary: 'stop a TaskBridge-started router' },
  { method: 'POST', path: '/api/local/start', summary: 'start the router' },
  { method: 'GET', path: '/api/local/events', summary: 'SSE router status and load progress', sse: true },
  { method: 'GET', path: '/api/processes', summary: 'processes of the server machine (pid, name, memoryBytes, startedAt, commandLine); ?fresh=1 skips the 5 s cache' },
  { method: 'POST', path: '/api/processes/kill', summary: 'force-kill one process by pid + name (name must match the list, system and TaskBridge processes are refused)' },
  { method: 'POST', path: '/api/processes/kill-group', summary: 'force-kill visible node, python or java processes; body {runtime:"node"|"python"|"java"}; protected processes are skipped and failures are reported' },

  // --- model library / hugging face -----------------------------------------
  { method: 'GET', path: '/api/hf/search?q=', summary: 'search Hugging Face model repositories (GGUF by default)' },
  { method: 'GET', path: '/api/hf/repo?repo=&revision=', summary: 'repository file tree split into quant variants, vision projectors and other files' },
  { method: 'POST', path: '/api/hf/download', summary: 'start a download job (body {repo, revision?, files:[path]}); file sizes are taken from the hub tree, not from the client' },
  { method: 'GET', path: '/api/hf/downloads', summary: 'download jobs with progress, speed and state; jobs survive a server restart (interrupted ones need a retry)' },
  { method: 'POST', path: '/api/hf/downloads/clear', summary: 'drop finished download jobs (INSTALLED/FAILED/CANCELLED/INTERRUPTED) from the queue listing; downloaded model files stay in the library; answers {removed}' },
  { method: 'POST', path: '/api/hf/downloads/cancel', summary: 'cancel a running download job' },
  { method: 'POST', path: '/api/hf/downloads/retry', summary: 'resume a failed/interrupted/cancelled job; already-complete files are skipped by size' },
  { method: 'GET', path: '/api/library', summary: 'installed model library (registry entries with file-presence check + standalone .gguf scan of modelLibrary.root)' },
  { method: 'POST', path: '/api/library/scan', summary: 'rescan modelLibrary.root for standalone .gguf files' },
  { method: 'POST', path: '/api/library/forget', summary: 'remove a model entry from the library registry (files on disk are left alone)' },
  { method: 'POST', path: '/api/library/register', summary: 'register an installed library model with the llama.cpp router: write its preset into models.ini (--models-preset), so Pi lists it after the router restarts; body {id, ctxSize?}' },
  { method: 'POST', path: '/api/library/run', summary: 'run an installed library model: registers it if needed, restarts the MANAGED router when it does not know the preset yet (an externally started router is refused), and loads it; answers with localStatus' },
  { method: 'POST', path: '/api/library/delete', summary: 'delete a downloaded library model: removes its preset from models.ini and its files EXCEPT ones referenced by other library entries (a shared vision projector stays); refuses while the model is loaded; answers {removed, kept, freedBytes, presetRemoved}' },

  // --- server administration ------------------------------------------------
  { method: 'POST', path: '/api/server/restart', summary: 'restart the TaskBridge process (body {confirm:true}); answers 202, the relaunch is detached — works even while a session is running, it is the escape hatch for a stuck state' },
  { method: 'POST', path: '/api/system/shutdown', summary: 'power off the machine the server runs on (body {confirm:true}); answers 200 {shuttingDown:true} right before the OS command runs — the cancel countdown is the client\'s job, not the server\'s' },
  { method: 'POST', path: '/api/system/reboot', summary: 'reboot the machine the server runs on (body {confirm:true}); same cancel-countdown contract as shutdown' },

  // --- mcp ------------------------------------------------------------------
  { method: 'GET', path: '/api/mcp', summary: 'MCP servers and mode' },
  { method: 'POST', path: '/api/mcp/mode', summary: 'inherit / managed / off' },
  { method: 'POST', path: '/api/mcp/import', summary: 'import the Pi MCP config' },
  { method: 'POST', path: '/api/mcp/servers', summary: 'enable or disable one server' },
  { method: 'POST', path: '/api/mcp/tools', summary: 'enable or disable one tool' },
  { method: 'POST', path: '/api/mcp/health', summary: 'probe configured MCP servers with bounded timeouts' },
  { method: 'POST', path: '/api/mcp/definitions', summary: 'create, update, or remove a managed MCP server definition' },

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
