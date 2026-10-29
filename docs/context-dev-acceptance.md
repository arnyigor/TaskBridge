# Context diagnostics — dev acceptance, 2026-10-29

This report supersedes the earlier "context_edit not modelled" limitations in
`context-composition.md`. It does **not** declare the entire stabilization plan done.

## CTX-04: screen and summary

Web and shared Compose now separate:

1. Pi-reported usage, its provenance/time, and the post-compaction estimate/time;
2. the active branch, retained history, new messages, summary size, excluded history,
   and the serialized system checkpoint (JSON characters, not tokens);
3. static sources, their chars/4 estimates, and an explicitly approximate residual;
4. last compaction/reason and potentially freed context (an estimate, not measured savings).

`GET /api/tasks/:id/context/summary` is an explicit, read-only summary request under
the existing authorization gate. The ordinary context report does not include the
summary body, including `compaction.last.summary`. Existing task/event payloads
are unchanged for compatibility. File reads retain project ownership, symlink,
size and parent-chain checks.

Web uses `textContent`; Compose uses selectable plain `Text`. Tests cover opt-in
loading, HTML not becoming DOM, late summary responses after a session switch,
unavailable summaries and older servers without a composition field.

**Live browser check:** Chromium, 1440x1000 and 390x844, opened the running task's
session-details overlay and context panel. All four sections and the summary
were visible. No summary request before expansion; exactly one after; 10,598
summary characters; no page errors. This confirms Web, not native Compose pixels.

## CTX-06: native projection, branch and provenance

The projection was checked against the published
`@earendil-works/pi-coding-agent@1.4.0` implementation of
`buildSessionProjection`/`buildSessionContext`. The `session-manager.js` source
SHA256 was `046b6a1109ac3f0ed893bb85bf0648709362fa926a5da75761216cf2fcf9d926`.

Eight synthetic golden cases generated with those native functions are committed
in `tests/fixtures/context/pi-1.4.0-projection.json`. They cover last-edit-wins,
omission/replacement, assistant/tool string normalization, system checkpoint,
older compactions in the retained range, edits outside the retained range, explicit
non-tail leaf, empty leaf, and missing system content across the cases. No operator
session text or vendor package dump is committed.

Live reports validate the runtime's session file and request `get_entries` with
`since` equal to the disk tail to obtain `leafId` without fetching the entire tree.
The projection follows that leaf. A missing leaf/RPC failure gives an explicit
unavailable reason; closed runtimes use a labelled `file-tail` projection instead
of pretending to know the active Pi leaf.

Regressions also cover another session's stats, a session switch during both stats
and leaf RPC, retained vs added counts, no text in metadata, project mismatch, no
writes to the original session and two consecutive compactions. Structured system
checkpoints with empty `content` are measured as serialized JSON, not shown as an
empty prompt.

**Live API check:** the running session returned `available: true`,
`branchSource: pi-leaf`, `projectionVersion: pi-1.4.0` and a concrete active leaf.
The current backend process predates the last checkpoint-size adjustment; that
adjustment is confirmed by regression tests, not live acceptance after restart.

## CTX-05: three real Pi/model scenarios

Reproducible stand: `experiments/pi-hooks/context-efficiency-check.mjs`. It uses
separate agent/workspace/session directories inside `.local`, synthetic text only,
manual compaction, disabled automatic compaction and no operator settings. Provider:
`deepseek/deepseek-flash`, installed Pi 1.4.0. Counts below are reported by Pi, not
independent exact tokenization.

| Scenario | Before | Pi estimate after | Next response context | Essential facts |
|---|---:|---:|---:|---|
| Small history | 1,870 | none: session too small | 1,922 | retained |
| Large tool payload | 22,475 | 1,823 | 2,078 | retained |
| Large static instructions/declarations | 39,326 | 27,428 | 18,939 | retained |

The static case explicitly appends a synthetic AGENTS file and registers 16 large
MCP-like tool declarations; it does not connect a real MCP server. Three facts
(codeword, source-file policy, next checksum action) were checked in the answer.
No repeat compact was observed, but this is **not** an auto-overflow test, since
automatic compaction is disabled in this stand.

The current two discovered AGENTS files total 7,966 characters (3,039 global and
4,927 project), approximately 1,992 tokens by chars/4. This does not reproduce the
historical 45K estimate. No instructions were removed and no quality A/B claim is
made.

## Final checks

- Full Node suite: **1,774 PASS, 0 FAIL, 4 SKIP** (1,778 tests).
- Native/session narrow suites: **29 PASS**, including eight native golden cases.
- Shared JVM: **334 PASS**; core API: **74 PASS**; core client: **126 PASS**.
- Desktop compilation and Android debug APK: Gradle PASS.
- `npm run check`: PASS.
- Follow Plan read-only acceptance: live state advanced to **14/73**, cycle 25,
  `RUNNING_STEP`, no conflict. The agent did not dispatch work to that project.

## Still open — not hidden by green tests

- Native Android/Desktop visual acceptance and CTX-07 full reopen cycle. The
  physical phone screenshot was black/asleep; no lock-screen bypass was attempted.
- A real run on the target local Qwen model. The managed local engine was reachable,
  but no model was loaded; the agent did not switch/load the user's shared engine.
- Quality A/B after changing AGENTS instructions; no such changes were made.
- Real-engine telemetry correlated with the same session, and repeat-overflow
  acceptance. The synthetic DeepSeek checks do not replace those checks.
- The latest source changes require a new server process/native-client update for
  final installed-build acceptance. Compilation and DOM checks are not that proof.
