# Stabilization / installation baseline — BASE-01

## Scope and source state

Measured 2026-10-28 against HEAD `8985bf42e604e34c390c739905327094445859d4`, branch `master`, with pre-existing uncommitted changes. This is a working-tree baseline, not a claim that HEAD alone passes. Source plan: `docs/TASKBRIDGE_STABILIZATION_INSTALL_PLAN.md`.

Existing changes were left untouched: deleted `TEST_PLAN.md`, `Tech_next_version.md`; modified KMP README, MessageListScrollTest, config.example.json, docs/p0-ab-results.md, chat/follow-plan-recovery/turn-instructions/web-follow-plan-view tests and web/app.js; additional untracked plans and local artifacts. In particular, the compact regression and the scroll test edits existed before this baseline. No commit or staging was performed.

## Versions

| Component | Observed version / source |
| --- | --- |
| TaskBridge Node package | 1.3.0 (`package.json`) |
| KMP | 1.3.0 (`clients/kmp/gradle.properties`, taskbridgeVersion) |
| Android | versionName inherits taskbridgeVersion; versionCode 12 (`androidApp/build.gradle.kts`) |
| Desktop | resource `taskbridge-version.txt` = 1.3.0; Gradle validates it against taskbridgeVersion |
| Node | v24.16.0 (`node --version`); package requires >=22.13.0 |
| npm | 11.13.0 (`npm --version`) |
| Installed Pi CLI | 1.4.0 (`pi --version`) |
| Supported Pi range | >=0.85.0 <1.5.0 (`src/pi-version.mjs`) |

The installed CLI is in range. This does not establish the version of an already running Pi child or pin a distribution runtime. Fresh RPC and Follow Plan compatibility checks (BASE-02) remain pending. Existing compatibility evidence is described in src/pi-version.mjs, including Pi 1.4.0 and docs/follow-plan-pi-1.4.0-contract.md; it was not re-executed here.

## Executed checks

Logs are ignored local artifacts under `.local/stabilization-baseline/`.

| Command | Actual result |
| --- | --- |
| `npm run check` | Exit 0; syntax checks and secret scanner passed (`check.log`) |
| `npm test` | Exit 1; 1687 tests, 1682 PASS, 1 FAIL, 4 SKIP (`node-tests.log`) |
| `cd clients/kmp && ./gradlew.bat :shared:jvmTest --console=plain` | BUILD SUCCESSFUL; XML: 310 tests, 310 PASS, 0 FAIL, 0 SKIP (`shared-tests.log`) |
| `cd clients/kmp/core && ../gradlew.bat :api:jvmTest :client:jvmTest --console=plain` | BUILD SUCCESSFUL; API 69 PASS, client 110 PASS, no failures or skips (`core-tests.log`) |

Counts for JVM were summed from `build/test-results/jvmTest/TEST-*.xml` in the three modules. Both Gradle runs executed their jvmTest tasks (not merely UP-TO-DATE).

### Known failures / classifications

- `tests/chat.test.mjs:201`, `successful compaction separates existing work from continuation`: assertion `expected work → success note → continuation` failed. This test was already present in the dirty working tree. The failure is baseline evidence for COMPACT-01/03, not a regression introduced by this run. No production fix has been made yet, and synthetic failure alone does not satisfy real-Pi reproduction.
- `RC-06: two clients pressing Resume produce at most one new turn`: PASS in npm test. Previously reported CI failure did not recur locally.
- `MessageListScrollTest[jvm]`: 1 PASS. Its existing local edits are included; this is not proof that the committed version or CI environment passes.
- Core compilation emitted existing warnings about unused expressions and an unnecessary non-null assertion; build passed.

## GitHub Actions

Read with `gh run list --limit 3 --json databaseId,headSha,status,conclusion,name` and `gh run view 40642186309 --json jobs`.

At this HEAD:

- security-policy run `40642186361`: success.
- ci run `40642186309`: failure. Both Node jobs (Windows and Ubuntu) failed at Unit tests; KMP failed at KMP JVM tests (shared).

Job metadata is in `.local/stabilization-baseline/ci-jobs.json`; failed logs were downloaded with `gh run view 40642186309 --log-failed` to `ci-failed.log`. Observed failures: Windows Node — `a file named the way bash names a drive is served, not reported missing`; Ubuntu Node — RC-06; KMP — `MessageListScrollTest.readingAboveIsNotMovedByChunksOrNewItems`, assertion at line 60. These are pre-existing CI failures, distinct from the local compact regression. All three corresponding local suites ran; the local Node suite failed only the compact test. Underlying causes of CI-only failures remain unconfirmed.

## Server launch and data

- `npm start` invokes `node scripts/start-lan.mjs run`; the existing launcher owns app + proxy, uses process.execPath and explicit repository cwd.
- Launcher storage is TASKBRIDGE_DATA_DIR when set, otherwise `<repository>/data` (scripts/start-lan.mjs).
- `loadConfig(rootDir)` reads `<rootDir>/config.json` (src/config.mjs). Local repository config exists; configured pi.command is `pi`. No private configuration content is copied here.
- Read-only `node scripts/start-lan.mjs status` confirmed app PID 10296 up on 127.0.0.1:52583, proxy PID 896 up on port 8787, public face answering. Repository `data/lan.json` exists with launcher state.
- Existing process environment/data-root override and original parent command line were not independently inspected. Repository launcher state plus status is evidence of the active managed pair, not a full inventory of every external process.
- No start/stop/restart, user session mutation or runtime upgrade was performed.

## Verdict and next gate

**BASE-01: PARTIAL.** Local baseline checks are recorded; Node has one reproducible compact regression. Exact running-process provenance remains open; remote failing tests have been identified, but their underlying causes remain unconfirmed. **BASE-02: pending** fresh isolated RPC smoke and the tested distribution compatibility table. No commit (deferred by user).

## Follow-on isolated verification

BASE-02 / COMPACT-01 progress is recorded in `docs/compact-reproduction.md`: real Pi 1.4.0 RPC checks, all 8 Follow Plan smoke checks passed, real threshold and manual compact captured as normalized fixtures. The original compatibility stand had a restore timeout; a narrow repeat successfully restored the same scratch session, without establishing the timeout cause. Node 22 distribution matrix, explicit API version and production-controller acceptance remain open.

Real automatic events replayed through ChatState reproduce continuation above the compaction notice. The narrow two-test regression run has 1 PASS / 1 FAIL. New fixture sequence/boundary checks and `npm run check:secrets` passed. No production fix yet.

Next: complete server-pipeline / context-limit reproduction and implement the canonical-response visual segment projection (COMPACT-03), without modifying the user's live server or sessions. Do not declare Compact fixed based on this baseline.
