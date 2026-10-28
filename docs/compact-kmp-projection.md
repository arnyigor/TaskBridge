# COMPACT-04 — KMP response projection

## Change

- ChatReducer retains canonical internal answers and records successful compact boundaries at text/thinking/tool offsets.
- ChatSnapshot projects visual Assistant segments with stable IDs. newestAnswerId stays canonical.
- ChatItem.Assistant carries canonicalId/canonicalText and segmentActions. ChatScreen routes Edit, Fork, Regenerate, Continue and Delete through canonical IDs; only the last nonempty segment exposes history actions/variants.
- Existing per-segment copy/selection/transcript code keeps visual order without copying the full answer repeatedly.
- Distinct compact events are not deduplicated by summary text; replay of the same seq is still deduplicated. The older regression test now replays the same event ID instead of labelling a different seq as a duplicate.
- No ChatSession rewrite, protocol change or new ChatItem subtype.

## Verified

Commands and results:

- `cd clients/kmp/core && ../gradlew.bat :api:jvmTest :client:jvmTest --console=plain`: API **69 PASS**, client **117 PASS**, no failures or skips. Includes common Web/KMP auto/manual Golden files, replay, stable canonical identity, STOP, variant switching, full message_end reconciliation and unsuccessful compact.
- Earlier `cd clients/kmp && ./gradlew.bat :shared:jvmTest :desktopApp:compileKotlin --console=plain`: shared **311 PASS**, Desktop compilation succeeded. Includes the new transcript/selection test; existing user scroll-test edits are present in this working-tree run but excluded from this commit.
- `:desktopApp:portable`: staged successfully, verifyPortableRoot passed. A running installation was detected, so no direct overwrite or forced restart was performed.
- User subsequently applied the tray update and restarted the server. Installed `shared-jvm-2f50893769d3f79e68ba44524aa4eea8.jar` SHA256 matches the staged build: `870e8c6444862b6663527ec69904e21fada48aa1e954bcd6bb845335eee0934e`.
- Read-only server check after the user's restart: app/proxy up, HTTP /api/health 200. This is not a visual Compact acceptance test.

The only later KMP changes were additional regression tests, not application code; no additional EXE replacement is needed for those tests.

## Remaining / verdict

**PARTIAL**, not full COMPACT acceptance. Still open: page cuts inside a single exchange, large-history performance, visual Desktop/Android controls/scroll behavior, and an installed multi-client session with new live automatic compact. KMP keeps its existing compaction-start notices; cross-client Golden comparison normalizes those progress notices out and compares successful boundaries, text and tool placement.

No changes to the three future-plan documents or live user sessions. No Android install or server restart was performed by the agent.
