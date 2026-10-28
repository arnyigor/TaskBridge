# CTX-03 — separating measurements, estimates and stale numbers

## Confirmed defect

`#handlePiEvent` overwrote `task.lastUsage.totalTokens` with Pi's `estimatedTokensAfter` after every successful compaction. That value means "the last model response really used N tokens"; after the assignment it held an estimate of the *next* prompt. Consequences beyond the diagnostics panel: session export (`session-history.mjs`), invocation summaries and any client reading `lastUsage` would report an estimated number as measured usage, and the pre-compaction measurement was lost entirely.

## Change

- The overwrite is gone. The estimate stays where it belongs — `compaction.last.estimatedTokensAfter`.
- `buildContextReport` now takes `measuredAt`/`measurementSession` and adds:
  - `usage.measuredAt`, `usage.sessionId`, `usage.stale`, `usage.unavailableReason`;
  - `postCompaction { tokens, source: 'pi-estimate', measuredAt, reason, tokensBefore }`;
  - `compaction.last` (previously dropped from the report);
  - a note that distinguishes "measurement is older than the last compaction", "no measurement, estimate shown" and the older overestimation wording.
- `stale` is computed by comparing the measurement time with the last compaction time, so a number taken before compaction is never presented as current.
- `task-manager.contextReport()` passes the measurement time, the Pi session file and `task.compaction.last`.
- Web (`renderContextReport`) and Compose (`ContextSection`) show: the reason a measurement is missing, `Контекст после сжатия: ≈N (оценка Pi)`, and a line saying the last measurement predates the compaction.
- KMP models gained `ContextUsage.measuredAt/sessionId/stale/unavailableReason` and `ContextPostCompaction`; unknown-field tolerance is unchanged.

## Verification

- `node --test --test-force-exit tests/context-report.test.mjs` — **18 PASS**, including four CTX-03 cases: estimate-only after compact, stale measurement, fresh measurement, and no compaction block at all.
- `node --test --test-force-exit tests/context-limit.test.mjs` — **3 PASS** against a real fixture server: after a limit-triggered compaction the report carries `postCompaction.tokens = 500` with `source = pi-estimate`, `compaction.last.estimatedTokensAfter = 500`, and `usage.source` is `pi` only when a token count exists. `tests/server.test.mjs` now asserts the opposite of the old behaviour: `lastUsage.totalTokens` stays **1100** after a compaction that estimated 500, so no consumer sees the estimate as usage.
- `node --test --test-force-exit tests/chat.test.mjs` — includes a new DOM test: a report without a measurement renders "Текущий размер недоступен: …" plus "Контекст после сжатия: ≈78 800 (оценка Pi)", and a stale report renders both the stale sentence and the estimate, never claiming the old number is current.
- `cd clients/kmp && ./gradlew :shared:jvmTest :desktopApp:compileKotlin` — BUILD SUCCESSFUL; shared **325 PASS**, including the new `ContextSectionProvenanceTest` (3 PASS).
- Full `npm test` — **1732 PASS, 0 FAIL, 4 SKIP**; `npm run check` — PASS.

One full-suite run failed `follow-plan-api: a repeated settle … does not start another cycle` after 31 s, while the file alone passed **20/20** and the next full run was green. That is the same load-related flakiness already recorded for `media-recovery-09E`; it is not established as a regression and not fixed here.

## Not done

- No live provider run: numbers were checked through the fixture Pi and unit tests, not against a real compacted session with the operator's model.
- `CTX-01` (the 51K/78.8K discrepancy on a real session), `CTX-02` (what remains inside the compacted context, `firstKeptEntryId`, excluded history) and `CTX-04` (redesigned "where the context comes from" screen) are still open.
- The engine's own prompt telemetry is not wired into the report; only Pi's measurement and Pi's post-compaction estimate are distinguished so far.
