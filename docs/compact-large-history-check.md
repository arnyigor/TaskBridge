# COMPACT C14 — large tool-event reducer check

## Scope

Add deterministic synthetic cases with 1000 and 10000 completed read tools, one successful compact halfway through, before/after text, periodic projection snapshots, and a size-cut tail followed by prefix reconstruction. No model calls or real tools execute.

Both reducers must retain two ordered segments with half the tools each, DONE tool states, unique tool IDs, no active segment after settlement, canonical assistant-initial identity and an identical reconstructed snapshot. Replaying all event IDs again must be a no-op. The Web check also verifies release of the resolved prefix event buffer.

Production code is unchanged in this step.

## Verification

- `node --test --test-force-exit tests/chat-compaction-large.test.mjs`: **2 PASS**.
- `cd clients/kmp/core && ../gradlew.bat :client:jvmTest --tests '*ChatCompactionTest.largeToolHistoriesKeepSegmentStateAndCanonicalIdentity*' --console=plain`: **1 PASS**, covering both sizes.
- Full core `:api:jvmTest :client:jvmTest`: **BUILD SUCCESSFUL**; API 69 and client 126 tests, no failures/skips.
- `node --test --test-force-exit tests/chat-compaction-large.test.mjs tests/chat-compaction.test.mjs tests/chat.test.mjs tests/compact-server.test.mjs`: **182 PASS, 0 FAIL, 1 SKIP** (183 tests).

Single isolated-run observations on the developer machine, not time-limit assertions:

| Reducer / tools | Events | Apply + periodic projections | Largest sampled projection | Prefix reconstruction |
| --- | ---: | ---: | ---: | ---: |
| Web / 1000 | 2008 | 3.30 ms | 0.16 ms | 2.60 ms |
| Web / 10000 | 20008 | 10.26 ms | 0.04 ms | 17.78 ms |
| KMP JVM / 1000 | 2008 | 33.68 ms | 4.87 ms | 4.96 ms |
| KMP JVM / 10000 | 20008 | 55.22 ms | 0.88 ms | 35.32 ms |

Timings include construction of reducer state and snapshots, not rendering. The smaller case runs first; JIT/warmup affects comparisons. There is deliberately no flaky fixed millisecond gate. Raw local logs are `.local/stabilization-baseline/compact-c14-*`; Kotlin diagnostics are also in the generated JVM test XML.

## Limits / verdict

**Reducer invariants PASS at 10000 tools; full C14 acceptance PARTIAL.** This does not establish Android heap/GC behavior, Compose or browser frame latency, sustained memory retention, or SQLite cleanup performance on very large histories.

The physical phone was connected but asleep during this step. Mobile visual acceptance remains pending; the Pocket Mode/lock-screen blocker from the previous attempt was not bypassed. No EXE/APK rebuild, install, server restart, live task or user-data modification was needed for these test-only changes.
