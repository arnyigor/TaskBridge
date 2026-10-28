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
