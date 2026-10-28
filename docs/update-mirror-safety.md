# PKG-03 — the update must not erase operator state

## Confirmed hazard

`DesktopUpdater` applies a staged portable build with `robocopy /MIR`. `/MIR` deletes everything in the target that the source does not contain, and the target is the install directory — where `config.json`, `data/`, `logs/` and `backups/` lived. A single update could therefore remove the operator's settings and history.

The first attempted fix — excluding absolute paths (`/XD <install>/server/data`) — was **measured** and does not work: with several absolute paths robocopy protected only the first level (`<install>/data`) while `<install>/server/data` was still deleted, and the same happened with `/XF <install>/config.json` versus `<install>/server/config.json`.

## Fix

`UpdateMirror` (shared JVM) now defines the preserved entries by **name**: directories `data`, `logs`, `backups`, `config` and the file `config.json`. `DesktopUpdater` passes them to the PowerShell script as `-ExcludeDirs`/`-ExcludeFiles`, and the script turns each into `/XD`/`/XF` and writes what it preserved into `update.log`. Names apply at any depth, so `server/data` and `server/config.json` are covered as well as the legacy top-level ones.

Program directories (`app`, `runtime`, `server/src`, `server/web`, `pi-extension`, `scripts`) are not excluded and update normally. The trade-off is explicit: the product may not ship a directory literally named `data`/`logs`/`backups`/`config`, and the bundle builder never does.

## Verification

- Real robocopy experiment (Windows, sandbox under `.local/`): before the fix `server/data/t.db` and `server/config.json` were deleted; with the name-based specification all of `server/data/t.db`, `data/x.db`, `server/logs/a.log`, `server/config.json` survived, `app/n.txt` was updated, and a `data` directory present in staging did not reach the install.
- The generated PowerShell argument builder was executed: `robocopy S T /MIR … /XD data /XD logs /XD backups /XD config /XF config.json`.
- `cd clients/kmp && ./gradlew :shared:jvmTest :desktopApp:compileKotlin` — BUILD SUCCESSFUL; `UpdateMirrorTest` **3 PASS**, shared JVM suite **322 PASS, 0 failures**.
- Desktop compilation proves the updater and the shared policy still build together.

## Not done

- The full update flow (stopping the app, mirroring, relaunching through PowerShell) was **not** executed: it would restart the operator's running TaskBridge and overwrite the installed files. The robocopy semantics and the argument generation are verified; the end-to-end script is not.
- Still open for PKG-03: manifest/hash check before installing, backup+rollback around schema changes, detecting active agent tasks, stopping only TaskBridge processes, health verification after start, and clearing staging only after success.
