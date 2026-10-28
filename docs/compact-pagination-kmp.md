# COMPACT C11 — KMP prefix reconstruction and overlap

## Confirmed defects

Three initial JVM regressions failed before the change: page-cut Compact history did not reconstruct the full snapshot/canonical ID; completion after a steer was lost; a snapshot-cancelled window remained duplicated instead of resolving to one cancelled answer.

The read-only reviewer then identified two more concrete cases. Both were executed and failed before correction:

- A newer turn's tool index was replaced with a scratch tool absent from the retained visible turn, leaving the visible tool RUNNING after completion.
- A partially overlapping older page included a newer USER_MESSAGE, selecting the wrong exchange to reconstruct and losing a late aborted orphan completion.

The overlap case also reproduced in Web (late AB remained A). The newer-tool Web regression already passed because its mutable tool identity was retained.

## Changes

- KMP buffers reducer-relevant events while the earliest exchange prefix is unknown, including late message/tool/orphan completions after steering.
- prependOlder reconstructs that exchange in scratch, rewires its private live routing pointers and restores canonical identity without changing the live cursor or replacing newer visible turns.
- Task-snapshot terminal state is preserved. Compaction notes, Pi-user pairing, tool progress and edit previews survive reconstruction. Tool bodies, progress snapshots and conversation echoes are excluded from the replay buffer.
- Tools belonging to retained newer turns retain their indexed object identity.
- Both reducers track the oldest loaded seq and exclude overlapping events before reconstructing a prefix.

## Verification

- `cd clients/kmp/core && ../gradlew.bat :api:jvmTest :client:jvmTest --console=plain`: API **69 PASS**, client **125 PASS**, no failures/skips. Includes every cut of the common automatic-compact fixture, three pages, open-message reconciliation, snapshot cancellation, late steer/orphan completion, overlap and subsequent tool completion.
- `cd clients/kmp && ./gradlew.bat :shared:jvmTest :desktopApp:portable :androidApp:assembleDebug --console=plain`: **BUILD SUCCESSFUL**; shared XML **311 PASS**, no failures/skips. Desktop staging and Android debug packaging succeeded.
- `node --test --test-force-exit tests/chat-compaction.test.mjs tests/chat.test.mjs tests/compact-server.test.mjs`: **180 PASS, 0 FAIL, 1 SKIP**.
- `npm run check`: PASS. `git diff --check`: no whitespace errors.
- Latest full Node run remains the preceding Web-pagination run: **1708 PASS, 0 FAIL, 4 SKIP**; it was not repeated after this small overlap follow-up. New overlap behavior was verified by the targeted Node command above.

Raw logs remain ignored under `.local/stabilization-baseline/kmp-pagination-*` and `web-pagination-overlap-before.log`.

## Update and limits

Prepared `clients/kmp/dist/.staging/TaskBridge/TaskBridge.exe` (461312 bytes). Installed TaskBridge is running; no installed files were overwritten and no forced restart was performed. Apply through tray: `Установить обновление и перезапустить`.

Debug APK: `clients/kmp/androidApp/build/outputs/apk/debug/androidApp-debug.apk` (17475426 bytes). Installed on the user's OnePlus 6T with `adb install -r` (Success), without uninstall/clear-data. Installed base.apk SHA256 matches the build. Package UID and firstInstallTime stayed unchanged; taskbridge-secrets preferences checksum stayed unchanged. Ordinary preferences and chat-cache checksums changed, so byte-for-byte preservation of those is not claimed.

The updated MainActivity is the resumed activity, but visual acceptance is blocked by the system Pocket Mode/lock screen. The screen was initially asleep; after WAKEUP it displayed `Карманный режим включён`. User action to uncover the proximity sensor and unlock is required. No lock bypass or input into private chat sessions was attempted. Screenshots/checksum logs are ignored local artifacts, not repository fixtures.

**Regression gates PASS; overall COMPACT acceptance PARTIAL.** Still open: installed Desktop/Android visual and scroll acceptance, a new live multi-client automatic-compact session, and sustained large-history memory/performance measurements. JVM checks include the user's pre-existing MessageListScrollTest edits, which are excluded from this commit. No user sessions or future-plan documents were changed. No server restart is needed for these client-only production changes.
