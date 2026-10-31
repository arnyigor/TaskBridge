# CMP-01 / CMP-02 — MCP scoping, tool exclusion and named context numbers

Audit input: the compact/MCP audit of 2026-10-30 (three confirmed MCP defects, plus
`chars/4` telemetry that cannot distinguish measured from estimated).

## Confirmed defects (before)

1. `TaskManager.#mcpArgs` took `this.mcp.launch()` and never looked at
   `task.mcp.mode`: `#normalizeMcp` parsed and stored a per-task mode that no launch
   path used. In `off` mode a per-task `disabledServers` list was even worse — the
   derived file was built from the **managed** config (`this.mcp.read()`), so
   `--mcp-config` pointed at a copy with every server enabled again.
2. `context-report.mcpDeclarations` skipped disabled servers but not
   `server.excludeTools`: a tool excluded in the UI was still counted as context.
   The adapter cache (`~/.pi/agent/mcp-cache.json`) is a list of known tools, not
   proof they are registered in the running process, and nothing said so.
3. Nothing distinguished «stored» from «reached the running Pi». Pi takes
   `--mcp-config` and `PI_MCP_CONFIG_MODE` at spawn (`env`/`args` are fixed at
   `spawn`), so a live process keeps its old registry; the API answered as if the
   change had been applied.

## Change

- `McpManager.launchFor(taskMcp, { taskDir })` is now the single decision for a
  launch: it resolves the effective mode (per task over the global one), returns
  `args`, `env`, `mode`, `scope`, `path`, a `fingerprint` of the served server map,
  and `ignored` when a per-task override cannot apply (`inherit`, `off`).
  - `inherit` → no args/env; a dropped `disabledServers` list is reported, not hidden.
  - `off` → always the empty config; no derived copy is written (regression covered).
  - `managed` → the shared file, or a derived `<taskDir>/mcp.json` when the task
    disables servers; pinned settings are kept.
- `TaskManager.#mcpLaunch` uses it for both args and env (`#piEnv(launch)`), so a
  per-task mode also reaches `PI_MCP_CONFIG_MODE`. The runtime records
  `{ mode, scope, path, fingerprint }` of what it was actually started with, and
  `MCP_SCOPE_IGNORED` is emitted when an override was silently unusable before.
- `TaskManager.mcpStatus()` adds `apply: { state: 'applied' | 'pending_restart',
  pending: [{ taskId, mode, fingerprint, wanted }], detail }`, computed by
  comparing each live runtime's fingerprint with what it would get now
  (`launchFor(..., { write: false })`: a status read never writes a file). All MCP
  mutation endpoints return it.
- `McpManager.status()` adds `controllable` (`false` in `inherit`),
  `fingerprint`, and marks every cached tool `enabled: false` when its server is
  disabled or the tool is excluded.
- `mcpDeclarations` skips excluded tools and `enabled === false` entries; the
  `mcp-tools` source reports `excluded` and `controllable`.
- `buildContextReport` adds `breakdown` with separate numbers and their source:
  `systemTokens`, `appendSystemTokens`, `instructionsTokens`, `skillsTokens`,
  `toolSchemaTokens`, `historyTokens` and `summaryTokens` (from the Pi session file
  when `session` is passed), `excludedTokens`, `estimatedTotalTokens`,
  `providerInputTokens` (always `null`: `get_session_stats.tokens.input` is a
  per-session sum, not the current request size), and `unattributedTokens`.
  Unknown sizes stay `null`, never `0`.
- Web `renderMcp` appends the `pending_restart` sentence to the hint.

## Verification

- `node --test --test-force-exit tests/mcp-manager.test.mjs` — **15 PASS** (4 new:
  per-task mode wins and reaches args/env/fingerprint; off mode keeps the empty
  config with `disabledServers` and writes no derived file; managed derived copy
  keeps pinned settings and leaves the shared file alone; status marks excluded
  tools and `inherit` as not controllable).
- `node --test --test-force-exit tests/context-report.test.mjs` — **22 PASS** (4 new:
  `mcpDeclarations` skips excluded/`enabled:false` tools and the source reports
  `excluded`/`controllable`; `breakdown` separates measured, estimated and
  unattributed values; unknown sizes stay `null`).
- `node --test --test-force-exit tests/mcp-apply.test.mjs` — **1 PASS** against a
  fixture server with `pi.mcp.mode = managed`: after a turn, adding a server makes
  `/api/mcp` answer `apply.state = "pending_restart"` naming that task with
  `fingerprint != wanted`; a session created afterwards is never in `pending`.
- `node --test --test-force-exit tests/context-limit.test.mjs tests/web-context-state.test.mjs
  tests/compact-server.test.mjs tests/chat-compaction.test.mjs` — **30 PASS**;
  `tests/chat.test.mjs` — **166 PASS, 1 SKIP**.

## Second round (after the 2026-10-30 follow-up audit)

### Confirmed: a compaction entry replays a frozen system prompt

Pi 1.4.0 stores `CompactionEntry.systemMessage` – a copy of the system message (sections +
`toolsAdded`) at compaction time – and replays it as real context:
`session-manager.js:189` (`entry.systemMessage ? [entry.systemMessage, summary] : [summary]`),
and `convertToLlm` passes `role: "system"` through to the provider.

Measured on the operator's own session files (623 scanned, 6 with a compaction):
snapshot = **60 586 chars ≈ 15 147 tokens**, of which `project_context` 12 217, `skills` 10 503,
`preamble` 2 228, `cwd` 28 and `toolsAdded` 34 898 (36 tool declarations, MCP included).
So a post-compaction context of ~46K is summary 1.5K + this snapshot ~15K + retained tail ~19K +
the rest. That is why CMP-01/02 could not make it smaller.

### Change

- `summarizeSessionContext(session, { availableTools })` adds `systemSnapshot`:
  `{ chars, sections, tools, toolChars, staleTools }`. `staleTools` names declarations of
  MCP tools that the adapter knows but that are no longer allowed (server disabled or tool
  excluded) – the stale option is `null` when the tool inventory is unknown, never an empty claim.
- `buildContextReport.breakdown` adds `snapshotTokens`, `snapshotSections`, `snapshotTools`,
  `snapshotStaleTools` and `sources.snapshot`.
- `TaskManager.contextReport()` passes the MCP inventory (`managed` = everything the adapter
  cached, `enabled` = allowed now) into the composition.
- `scripts/pi-compaction-probe.mjs` – reproducible probe of the installed Pi's compaction
  policy (no model call, no session written).

### CMP-03 gate: measured, not guessed

`node scripts/pi-compaction-probe.mjs --keep 20000,0 <session.jsonl>` on 4 real sessions:

| session | keepRecentTokens 20000 | keepRecentTokens 0 |
|---|---|---|
| 1707 entries | 38 entries / 19 637 tok | 1 entry / 2 616 tok |
| 2566 entries | 28 / 20 097 | 2 / 0 |
| 826 entries | 63 / 19 308 | 1 / 790 |
| 285 entries | 31 / 19 103 | 1 / 161 |

So `keepRecentTokens: 0` collapses the tail from ~20K to one message and summarizes everything
before it – the mechanism the audit wanted exists in Pi itself. Two facts still block wiring it
into TaskBridge for a running session:

1. Pi reads `compaction.*` from settings **in memory at start** (`settings-manager.getCompactionSettings`
   over the loaded `this.settings`); writing `settings.json` after spawn changes nothing.
2. There is no per-launch settings override: `pi --help` on 1.4.0 has no `--settings`/`--config`,
   and the only relocation is `PI_CODING_AGENT_DIR`, which carries `auth.json` and the whole
   extension/skill set with it. Writing `<project>/.pi/settings.json` would change compaction for
   every session in that project, including the operator's own.

Therefore CMP-03A needs a decision (dedicated agent dir per task vs. an extension that summarizes
on its own), and CMP-03B (extension returning `firstKeptEntryId: null`) must also summarize the
message Pi would otherwise keep – `firstKeptEntryId ?? id` is used verbatim
(`session-manager.js:889`), so a retain-none entry with Pi's default summary would silently drop
that message.

### Verification (second round)

- `tests/context-composition.test.mjs` — **23 PASS** (3 new: snapshot measured with real Pi section
  names, `staleTools` from the MCP inventory, no snapshot → `null`).
- `tests/context-report.test.mjs` — **23 PASS** (1 new: `snapshotTokens` 15 147 for the measured
  60 586-char snapshot, stale tools named).
- Regression set `context-composition`, `context-report`, `context-limit`, `web-context-state`,
  `mcp-manager`, `mcp-apply`, `compact-server`, `chat-compaction` — **92 PASS**.
- `scripts/pi-compaction-probe.mjs` run on the operator's sessions — numbers above.

### Live A/B on the installed Pi 1.4.0 (`experiments/compact-00/run-zero-tail.mjs`)

Isolated stand: own agent dir (`PI_CODING_AGENT_DIR`), own workspace/session dir, provider key from
the environment, no extensions. Identical history (~31K tokens), only `keepRecentTokens` differs:

| keepRecentTokens | compact | tokensBefore → после | контекст после перезапуска | хвост |
|---|---|---|---|---|
| 20000 (default) | **НЕ выполнен**: `Nothing to compact (session too small)` | — | 31 198 | вся история |
| 0 | выполнен | 31 140 → 3 416 | 3 754 | 1 сообщение |

Findings:

1. `keepRecentTokens: 0` работает на живом Pi с реальной моделью: сжатие выполняется, сводка
   2 698 символов, после перезапуска сессии активный контекст 3 754 токена вместо 31 198.
2. Literal retain-none is not what happens: `firstKeptEntryId` is the last cut point, so exactly one
   message is kept (and not summarized). Safe, but not zero entries.
3. With the default 20 000 a ~31K session is **not compacted at all** – Pi answers «Nothing to
   compact (session too small)». `findProjectedCutPoint` walks backwards and, once the budget is
   already exceeded at the oldest cut point, `cutPoints.find(c >= i)` points at the beginning: the
   whole history is «kept», `messagesToSummarize` is empty, nothing is summarized. That is what
   «сжатие не уменьшает контекст» looks like on a medium session.
4. The floor after a full compaction is the system snapshot, not the summary: on the stand it is
   11 233 chars ≈ 2 800 tokens (tools only); on the operator's machine it is 60 586 chars ≈ 15 147
   tokens (AGENTS.md + skills + 36 tools). So `keepRecentTokens: 0` on a real TaskBridge session
   gives ≈ 15–18K, not 3.7K.

### What it would take to ship this in TaskBridge

Still one decision: Pi reads `compaction.*` from the agent dir at start, and TaskBridge launches Pi
with `cwd` = the shared project. Options: (a) per-task agent dir (`PI_CODING_AGENT_DIR`) that carries
`settings.json` plus the operator's `auth.json` – secret duplication into the data root, and
skills/extensions discovery has to be mirrored; (b) project `.pi/settings.json` written by TaskBridge
– changes compaction for the operator's own sessions in that project; (c) an extension that
summarizes the whole branch itself and returns `firstKeptEntryId: null` – needs its own model call
and must cover the message Pi would otherwise keep.

The audit's desired `keepRecentTokens: 0` is therefore verified as a Pi mechanism and **not yet**
wired into TaskBridge.

## Not done

- **CMP-03 (full manual compaction with zero retained tail) is not implemented.**
  Verified against the installed Pi 1.4.0 (`@earendil-works/pi-coding-agent`):
  - `compact` RPC has only `customInstructions` — no tail budget
    (`docs/rpc-commands.md`, `CompactOptions`).
  - `keepRecentTokens` is read from settings **in memory, at start** — a settings
    file written after spawn does not affect a running session, and
    `PI_CODING_AGENT_DIR` (the only settings relocation) would take credentials with it.
  - `session_before_compact` exists and `appendCompaction` uses the returned
    `firstKeptEntryId` verbatim, with `firstKeptEntryId ?? id` giving a retain-none
    entry. But the hook only receives `messagesToSummarize` + `turnPrefixMessages`
    (up to the cut point): summarising the tail as well needs a model call from the
    extension, which is a new feature to build and verify on a real Pi run, not a fix.
- CMP-04 (local archival cleanup), CMP-05 (semantic policy), CMP-06 (KMP/Web UI for
  the three modes) are untouched.
- No live provider run: all numbers come from the fixture Pi and unit tests.
- The live check the audit asks for (`/api/mcp` `apply`, `breakdown`, active projection) has not been
  run against the operator's server: it still runs the previous build, and restarting it is the
  operator's call.
- Session files are a sample (623 scanned); the snapshot numbers come from several multi-compaction
  sessions, not from a provider-exact token count.
