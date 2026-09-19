# Проект: pi-app | Срез от 2026-09-15 21:04

## pi-app 0.5.8 — audit fix session (delivery/recovery A–C)
Base: doc/AUDIT-IMPLEMENTATION-STATUS-2026-09-15.ru.md. Working tree, uncommitted.

### Bugs fixed this session
1. **Delivery journal persistence (P0, scenario A)** — `src/main/prompt-idempotency.ts`: outcomes now persist to disk (`userData/prompt-delivery.json`) via `initPromptDeliveryJournal` (wired in `src/main/ipc.ts`). New `accepted` phase via `markPromptAccepted` (called in `ipc/handlers/prompt.ts` after worker ack). After Main restart, accepted/completed IDs are NOT re-run (replay guard returns `{alreadyDelivered:true}`); confirmed `rejected` allows same-ID retry. Renderer treats `accepted` as delivered; unknown delivery shows a "Check delivery" toast action (`composer:toast.checkDelivery`, en+zh).
2. **Draft restore on sandbox session.new failure (P0/P1, scenario B)** — `use-composer-send.ts`: added `blankViewUnchanged` guard. Sandbox/placeholder sends start from blank view; `setWorkspace` nulls `currentSessionId` so old `sameView` was false and draft wasn't restored on pre-acceptance failure.

### E2E fixture modes added (`src/main/e2e-worker-fixture.ts`)
- `PI_E2E_SESSION_NEW_FAIL=1` (reject first session.new)
- `PI_E2E_SESSION_NEW_DELAY_MS=n`
- `PI_E2E_MODEL_SET_FAIL=1`
- `PI_E2E_WORKER_EXIT=1` (crash after partial delta, sends ipc:worker-exit)
- `PI_E2E_SKIP_SEQ=1` (skip one seq → reconcile)

### Tests green (final)
typecheck, lint, build OK; unit 1147/1147; contract 273/273; E2E composer-delivery(9)+composer(3)=12 passed.

### NOT done (doc sections)
- D (P2) manual/a11y matrix — attachments-only path verified sound in code (payload carries @path refs), not E2E'd.
- E (P3) perf measurement — needs instrumentation/repeated runs.
- F (release gate) Windows packaging — electron-builder hang is open release blocker, needs VM.
Real-provider E2E (`PI_REAL_E2E=1`) needs local llama.cpp + qwen-27b-q3.