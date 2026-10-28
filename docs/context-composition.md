# CTX-02 — what the model still sees after compaction

## What was missing

`readPiSession` already rebuilt Pi's compacted context (summary + `firstKeptEntryId` slice + everything after), but nothing exposed *that* as a composition: the diagnostics screen only showed source estimates and a token total. The operator could not tell how much history survived, how large the summary is, or how much was dropped from the active context while remaining in the file.

## Change

- `readPiSession` additionally returns `compaction` metadata: `firstKeptEntryId`, whether that marker was found, `tokensBefore`, `reason`, timestamp and `ignoredEntries` (branch entries that fell out of the active context). Existing fields are unchanged.
- New pure module `src/context-composition.mjs` → `summarizeSessionContext`: counts and sizes for the active context, the kept slice and the excluded part, split by role, with tool-call/tool-result counts. It returns **no message or summary text at all**, and states that it is a projection of the session file, not Pi's own `buildSessionContext()`.
- `TaskManager.contextReport()` attaches `session: { available: true, ...composition }`, or `{ available: false, reason }` when there is no Pi file, no workspace, the file belongs to another project, or it is unreadable. The reason is passed through instead of hiding the failure.
- Web context panel gained three lines: how many messages/chars are in context after compaction, the summary size with `tokensBefore`, and how much was excluded but still lies in the session file.

## Verification

- `node --test --test-force-exit tests/context-composition.test.mjs` — **4 PASS**: section split (summary / kept / after, with tool results), a session without compaction, the latest of two compactions defining the boundary, and the manager wiring — including that neither summary nor message text appears anywhere in the payload (`JSON.stringify(...)` checked) and that a session belonging to another project yields `available: false` with the reason.
- `node --test --test-force-exit tests/pi-session-index.test.mjs` — **9 PASS**, so the added metadata did not disturb parsing, branch selection or the 64 MiB bound.
- `node --test --test-force-exit tests/chat.test.mjs` — DOM test asserts the new lines render (`В контексте после сжатия: 4 сообщ.`, `Сводка сжатия: 321 симв.`, `Исключено из контекста …: 7 сообщ.`).
- Full `npm test` — **1736 PASS, 0 FAIL, 4 SKIP** (1740 tests); `npm run check` — PASS.

## Not done / limits

- `context_edit` and system-checkpoint semantics are still not modelled: the composition is a file projection, and the payload says so. Against a live Pi session this could differ.
- The full composition screen (CTX-04), on-demand summary text, and the KMP presentation of these fields are not implemented yet; KMP keeps showing the existing context section.
- `CTX-01` (the real 51K/78.8K discrepancy) and `CTX-05` (compaction effectiveness on three real histories) remain open.

## Follow-up: KMP parity

The Compose context sheet now shows the same three facts as the web: messages and characters kept in the active context, the summary size with `tokensBefore`, and how much history was excluded but still lies in the session file. Sizes are formatted by a dedicated `charCount` (characters), never by `tokenCount` — "250K симв." and "250K ток." are different quantities.

Modelled in `SessionComposition` / `CompositionActive` / `CompositionTotals` / `CompositionCompaction` / `CompositionHistory`; `SessionContextReport.session` is nullable, so an older server simply shows nothing.

Verification: `:shared:jvmTest` — **330 PASS**, including `ContextCompositionLinesTest` (5 PASS: kept counts, large character counts labelled as characters, summary line, excluded-only-when-present, and an unavailable composition rendering nothing instead of zeros) and `ContextSectionProvenanceTest` (3 PASS). `:desktopApp:compileKotlin` and `:androidApp:compileDebugKotlin` succeed; `npm test` — **1736 PASS, 0 FAIL, 4 SKIP**; `npm run check` — PASS.

Still open: the rebuilt composition screen (CTX-04), on-demand summary text, `context_edit`/checkpoint semantics, and CTX-01/CTX-05 on real sessions.

## The number that looked like the current size

Live report, 2026-10-29: the operator read the task card as "the session compacted but still takes 482K". That number was `tokensBefore` — the **measured** size *before* the compaction, printed as `1 · 482700→36107` with no units and no direction. The session's actual state at that moment was `usage.tokens = 53 345` of a 1 048 576 window (5.1%), and the compaction's own estimate was `estimatedTokensAfter = 36 107`.

The row now reads `1 · до 482 700 → ≈36 107 ток.`, with a tooltip stating that the right-hand side is Pi's estimate and that the current measured size lives in the context panel. Compose shows `Последнее сжатие: было 482K → ≈36K ток. · ручное`.

Where the 482 700 tokens came from (same session file, 1 326 messages):

| Part | Characters | ≈Tokens (chars/4) | Share |
|---|---|---|---|
| tool results | 941 046 | 235 261 | 59.7 % |
| tool-call arguments | 478 023 | 119 505 | 30.3 % |
| assistant thinking | 132 505 | 33 126 | 8.4 % |
| assistant text | 22 118 | 5 529 | 1.4 % |
| user text | 2 305 | 576 | 0.1 % |

A single tool result reached 266 025 bytes and another 242 052; by tool, call arguments were 314 `bash` (186 945 chars), 38 `write` (146 975), 75 `edit` (123 474). So the growth is technical payload — full command output and whole-file bodies passed to `write`/`edit` — not conversation. The compaction summary itself is 10 598 characters, and the context that survived it is 114 entries (≈96 165 characters ≈ 24 K tokens by the same estimate), which is why the practical size dropped to Pi's 53 K measurement.

Verification: `tests/chat.test.mjs` — 161 tests, 1 skip, **160 PASS**, including a new DOM test that fixes the row's text and tooltip and checks that a task without a known pair shows just the count instead of zeros. `:shared:jvmTest` — **332 PASS** (new `CompactionChangeLineTest`, 2 PASS), `:androidApp:compileDebugKotlin` and `:desktopApp:compileKotlin` succeed. `npm test` — **1744 PASS, 0 FAIL, 4 SKIP**; `npm run check` — PASS.

Limit: the 24 K figure is a `chars/4` projection of the session file, not Pi's own `buildSessionContext()`. It is the same projection CTX-02 exposes, and it stays deliberately separate from the measured 53 K.

## Live acceptance on the installed build

After the operator applied the staged update (`clients/kmp/dist/TaskBridge`, `TaskBridge.exe` at 01:44, `shared-jvm-72bafb8f…jar`), the running server was checked without touching it:

- `GET /api/tasks/<id>/context` on the internal port now returns `session: {available: true, method: 'session-file-projection', …}` with real numbers — `active.kept = 248 сообщ. · 119 947 симв. · 116 результатов инструментов`, `compaction.summaryChars = 10 598`, `history.excludedMessages = 1 216 · 1 047 157 симв.` The endpoint is not just unit-tested any more.
- A headless Chromium opened the installed web UI, selected the running task and read the panel: `Compaction 1 · до 482 700 → ≈36 107 ток.` with the direction tooltip, and the panel lines `Всего в запросе: 84 617 токенов из 1 048 576 · 8.1 %`, `Контекст после сжатия: ≈36 107 (оценка Pi)`, `В контексте после сжатия: …`, `Сводка сжатия: …`, `Исключено из контекста …`. No page errors.

That run also exposed a rendering defect the tests had missed: the share of the window printed as `7.807445526123047 %`. It is now rounded to one decimal (`Math.round(pct * 10) / 10`), and the DOM test asserts `· 80%` for a `percent: 80.00000000001` report and refuses three-or-more decimals anywhere in the panel. Re-checked live afterwards: `· 8.1 %`.
