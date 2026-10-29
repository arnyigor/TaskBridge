# Follow Plan: pause reasons and long-running plans

## Current policy (2026-10-29)

Confirmed plans have no default time or cycle-count cap: `maxCycles: null`,
`budgetMs: null`. Explicit numeric caps in `followPlan.limits` remain supported.
Lifetime cycle IDs/progress never reset. STOP, file conflicts, unknown outcomes,
blocking decisions and three cycles without measurable progress still stop work.
No-progress uses `PLAN_NO_PROGRESS`, not the misleading budget-renewal dialog.
Pause reasons survive service recreation in the existing binding budget JSON.

A regression resumes a 32-day-old plan with 100 previous cycles and executes 25
productive steps (alternating immediate/deferred dispatch) without budget prompts.
The full Node run at this stage: 1767 PASS, 4 SKIP; shared JVM: 332 PASS. Android
was installed with `-r`, APK hashes match and the secrets-store hash is unchanged.
The running Desktop was not overwritten; the update is staged.

Another reproduced defect: a checkpoint updated the plan, then hit a dispatch cap
without advancing the binding revision/hash. Its own write looked like an external
conflict. The binding now records a successful CAS before dispatch guards run.

## Malformed extra evidence: one correction, not silent acceptance

The live S-014 checkpoint was rejected with `подтверждение «command» без ссылки
(ref)` despite the model's prose saying it was done. S-015 was therefore never
scheduled. Validation remains strict. When the only problems are missing refs and
other referenced evidence exists, the existing single audit slot can now ask for
fresh verification and a corrected checkpoint. No plan writes or DONE occur before
validation. A second malformed checkpoint pauses with its reason persisted. The
correction instruction forbids new work and invented tool references.

Follow Plan suites after this change: 256 PASS. New tests cover both successful
correction and a repeated invalid checkpoint, including deferred dispatch. Live
continuation of the user's real plan still requires acceptance after a server
restart; the agent has not marked S-014 done or dispatched S-015.

## Historical six-hour-budget incident

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
