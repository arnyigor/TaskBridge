# DIST-04 — choosing the Node that runs the server

## What changed

`DesktopServerLauncher` no longer assumes `node` from `PATH`. `resolveNodeCommand` picks, in order:

1. `TASKBRIDGE_NODE` — an explicit path (developer override, or an operator pinning a build);
2. a bundled runtime, only when the layout really is the packaged product: `<dist>/server/node.exe` and `<dist>/runtime/node/node.exe`, where `<dist>` also contains `TaskBridge.exe` and `app/`;
3. `runtime/node/<node|node.exe>` inside the server root itself (covered by tests, e.g. a ZIP that ships the runtime beside the server copy);
4. `node` from `PATH` — the historical behaviour, so a repository checkout and every current installation keep working.

The executable name follows the platform (`node.exe` on Windows, `node` elsewhere). A parent directory that merely happens to contain `runtime/node` is not trusted unless it looks like a TaskBridge distribution, so a checkout under an unrelated folder cannot silently run a stranger's Node.

A missing binary used to surface as a bare `IOException`. It now raises a message naming the command that was tried and the three ways to fix it.

Desktop's `server.node` preference was **not** added: the launcher's store is DPAPI-backed and reading it before the GUI is ready would have meant a new async path. The environment variable covers the same need without inventing a second settings channel.

## Verification

`cd clients/kmp && ./gradlew.bat :shared:jvmTest :desktopApp:compileKotlin --console=plain` — BUILD SUCCESSFUL:

- `NodeCommandTest` — **8 PASS**: bundled runtime wins over PATH, `server/node.exe` is found, no runtime falls back to `node`, explicit override wins and a blank one is ignored, an unrelated parent runtime is rejected, a runtime inside the server root is honoured, and the binary name follows the platform.
- Shared JVM suite — **319 PASS, 0 failures** (this includes the operator's existing `MessageListScrollTest` edits, which are not part of this commit).

Sandboxes live under the repository's `.local/`, and their fake `node.exe`/`TaskBridge.exe` are text markers, not executables — the selection logic is what is under test, not process startup.

## Not done

- No Node binary is shipped yet: bundling a verified 22.x build is a packaging step (download, licence files, hashes in the release manifest).
- Empty-`PATH` startup of the packaged app was not executed end to end; only the command selection is proven.
- Pi is still resolved from its own configured command (DIST-05), and the GUI was not restarted with a bundled runtime.
