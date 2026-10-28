# Follow Plan: resume after the time budget expires

## Confirmed defect

On 2026-10-29, repeated Android Resume requests produced `PLAN_PAUSED` events
with `code: PLAN_BUDGET_EXCEEDED`. The attached plan was PAUSED, revision 11,
cycle 16, with 11/73 steps done. Requests reached the server; this was not a dead
button or a missing plan. The follower enforced its six-hour wall-clock limit,
but the service returned HTTP 200 with the unchanged status and lost the reason.

## Change

- Start/resume now report exhausted budgets as `PLAN_BUDGET_EXCEEDED` errors,
  after publishing the existing pause event.
- `POST /api/tasks/:id/plan/resume` accepts optional `renewTimeBudget: true`.
  Only an explicit operator request on a PAUSED plan renews the time window.
- Cycle count, no-progress count, plan contents/revision, and command identity
  sequence are preserved. The 20-cycle cap cannot be bypassed by time renewal.
- Android/Desktop and Web ask for confirmation before granting more time.
  A failed renewal remains visible rather than looping through confirmations.

## Verification

- Follower/service/API/Web DOM suites: 247 PASS, 1 SKIP, 0 FAIL (248 tests).
- New service regressions reproduce the expired-budget refusal, confirm c-16 to
  c-17 after renewal, verify no plan-file changes or counter reset, forbid a
  second dispatch during an active step, and enforce the cycle cap.
- Web resume confirmation regressions: 3 PASS (confirm, decline, exhausted cycle cap).
- `npm run check`: PASS.
- KMP `FollowPlanResumeApiTest`: 2 PASS, checking opt-in serialization, expected
  revision, and propagation of the HTTP 409 error code.
- Targeted shared FollowPlan tests: 21 PASS; Desktop compilation and Android APK: Gradle PASS.
- APK installed on OnePlus 6T with `adb install -r`: Success; installed bytes match
  the built APK and the secrets-store checksum is unchanged.

## Limits

The live server has not been restarted by the agent, and the user's real plan
has not been resumed/reset for testing. The new confirmation flow still needs
end-to-end phone acceptance after the operator restarts the development server.
