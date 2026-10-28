# DIST-01 — distribution audit

## Scope

Read-only audit of packaging/runtime code plus isolated probes under `.local/stabilization-baseline/`. No live server restart, installed-file replacement, runtime upgrade or user database access. The inspected source has the preceding stabilization commits plus existing user changes, which were not modified here.

## Observed portable tree

Staging had already been consumed; its absence is not a missing-build defect. Read-only inventory of the installed `clients/kmp/dist/TaskBridge`:

```text
TaskBridge/
  TaskBridge.exe
  app/
  runtime/
    bin/server/jvm.dll
  update.log
  app-start.log
  app-out.log
```

`server/`, `node.exe` and `manifest.json` are absent. `runtime/bin/java.exe` is absent, but the embedded JVM DLL is present; this is a trimmed jpackage runtime, not evidence that Java must be installed separately.

`portable` in desktopApp/build.gradle.kts copies the Compose app image only. `standalonePortable` additionally copies scripts/, src/, web/, pi-extension/, package.json and config.example.json, explicitly excluding node_modules and logs. package-lock.json, Node and Pi runtimes are not included. No release manifest/hash validation is part of these tasks.

## Plan hypotheses checked

| Hypothesis | Evidence / result |
| --- | --- |
| portable has no backend | Confirmed by Gradle source and installed tree. |
| standalone omits node_modules and lockfile | Confirmed copy specification. A matching isolated source copy also had neither. This does **not** prove LAN startup failure; see smoke below. |
| Desktop requires Node in PATH | DesktopServerLauncher.start uses ProcessBuilder("node", "scripts/start-lan.mjs", "start") with root cwd and no packaged-runtime override. Actual GUI launch with an empty PATH was not attempted. |
| Pi depends on external installation | PiRpc defaults to command pi, inherits environment, uses Windows shell; TaskManager passes configured pi.command or pi. No private Pi runtime is supplied. |
| Config is tied to code root | loadConfig(rootDir) and saveConfig(rootDir) use rootDir/config.json. Server passes its source root. Isolated loadConfig created config in that root, not the selected data root. |
| CLI backup uses wrong store | Confirmed with two sentinel databases: TASKBRIDGE_DATA_DIR pointed to user-state, but backup contained code-root-sentinel and lacked user-state-sentinel. |
| Docs drift | README says Pi <1.4.0 and pins installation to 1.0.4; src/pi-version.mjs supports <1.5.0 and current tested CLI is 1.4.0. start.cmd says Node20+ although package and node:sqlite require >=22.13.0. README's Node>=22.13 requirement is already correct. |
| No release pipeline | Only ci.yml and security.yml; no release/artifact/publish step found. ci runs Node22 and shared/core JVM tests, not portable/Setup/clean-install packaging. |

## Runtime components and dependencies

- Desktop: packaged app and trimmed JVM; OS integration uses Windows PowerShell. Desktop launcher root resolution prefers a configured server.root, then repository ancestors, then bundled server.
- Backend/LAN proxy: Node >=22.13.0 with built-in node:sqlite. start-lan uses process.execPath for both children, but Desktop/start.cmd must first locate the initial Node in PATH.
- Agent execution: separately configured Pi CLI, its own Node/npm installation dependencies, model/provider authorization, extensions and session support. Packaging/licenses and external shell tools remain DIST-05 work.
- Git: external git executable for repository/worktree/history features. A failed startup version probe is caught; absent Git does not prevent the tested health/Web endpoints. Repository actions without Git were not exercised.
- TLS certificate generation and optional local-model tooling require a separate feature-specific inventory; no claim that the main smoke covers them.

Declared package dependencies and root lockfile resolutions:

| Package | Manifest | Locked | Role in audit |
| --- | --- | --- | --- |
| dompurify | 3.4.15 | 3.4.15 | Web imports the checked-in vendor/purify.mjs copy |
| marked | 17.0.3 | 17.0.3 | Web imports checked-in vendor/marked.js |
| fzstd | ^0.1.1 | 0.1.1 | Declared; no bare import found in src/scripts |
| kiwi-schema | ^0.5.0 | 0.5.0 | Declared; no bare import found in src/scripts |
| pako | ^3.0.2 | 3.0.2 | Declared; no bare import found in src/scripts |
| pg (optional) | ^8.23.0 | 8.23.0 | Dynamic import in cloud/lib/store-postgres.mjs; not exercised by LAN smoke |

linkedom is a development/test dependency, not a demonstrated LAN runtime requirement. Searches of src/scripts found no direct bare-package import/require matching the audited patterns. This static observation and the smoke do not establish all optional/dynamic feature dependencies. Do not blindly add production dependencies or remove declared ones based only on this audit.

## Actual isolated probes

`node .local/stabilization-baseline/distribution-audit-probe.mjs` copied only the standalone include set into an isolated source root. Used a separate user-state DB, blank Pi settings, empty PATH, a deliberately missing Pi command and an absolute **host** Node v24.16.0. Secrets were excluded from the child environment. Only that test server PID was stopped.

Results:

- /api/health — 200.
- /api/tasks — 200, reading the isolated sentinel task through SQLite.
- / — 200.
- /vendor/marked.js and /vendor/purify.mjs — 200.
- SQLite initialized in the configured user-state directory.
- No model request, Pi task or SSE stream was started.
- CLI backup selected the wrong database as described above; TaskStore.backup itself is not implicated.

Supporting existing tests:

- `node --test --test-force-exit tests/backup.test.mjs`: **2 PASS** (consistent SQLite snapshot, pragma options).
- `cd clients/kmp && ./gradlew.bat :shared:jvmTest --tests '*TaskBridgeRootFinderTest' --tests '*ServerDiagnosticsTest' --console=plain`: **17 PASS**, no failures/skips (12 root-finder, 5 diagnostics).

Local artifacts: distribution-audit-probe.log, portable-inventory.json, distribution-backup-api.log, distribution-root-tests.log and the generated distribution-audit-*/report.json/server.log. The first backup probe attempt stopped on the expected missing sentinel; the corrected probe explicitly handles NOT_FOUND and produced the complete report.

## Updater/data risks

DesktopUpdater currently mirrors staging over the install with robocopy /MIR. It validates exe presence/time and four-second process survival, not a release manifest/hash, backend health or client/server compatibility. It can stop processes at the exact target EXE path, not by image name; no such action was invoked by this audit.

Crucially, a standalone backend defaulting to <install>/server/data and <install>/server/config.json would put mutable state beneath the mirrored target. Current installed portable has no bundled backend, so this is a confirmed architectural hazard, not a reproduced loss of the user's data. Separate data/config roots are required before shipping standalone updates. Active-task handling, backup/rollback and migration acceptance remain unverified.

## Verdict / next step

**DIST-01 audit complete; autonomous distribution NOT READY.** Highest-priority next checks/fixes: CLI backup must honor TASKBRIDGE_DATA_DIR; separate code/config/data roots; choose and verify bundled Node/Pi; add backend and release manifests without depending on repository discovery.

The probe stays inside the repository boundary. It therefore does **not** satisfy the plan's required outside-repository or clean-Windows acceptance, does not prove no-global-Node operation, and is not a final portable/Setup test. Visual Compact acceptance also remains open independently.

## DIST-02 follow-up — backup data-root fix

After the audit, scripts/backup.mjs was changed to resolve TASKBRIDGE_DATA_DIR exactly as src/server.mjs and scripts/start-lan.mjs do, falling back to <code-root>/data when unset/empty. No public CLI flags or API were added; filename/retention/checkpoint behavior is unchanged.

Three hermetic CLI regressions copy only the backup script and TaskStore into a sandbox under .local. They cover the default root plus absolute/relative external data paths with spaces and Cyrillic. The external-root cases failed before the fix (no backup in the selected store). After the fix, they restore the selected sentinel and pre-backup events from an open WAL database, exclude subsequent writes, leave the live store intact and create no backup in the shadow code-root store.

`node --test --test-force-exit tests/backup.test.mjs tests/store.test.mjs`: **16 PASS, 0 FAIL, 0 SKIP**. Logs: `.local/stabilization-baseline/backup-cli-before.log` / `backup-cli-after.log`.

This fixes only the backup portion of DIST-02; external configuration paths, read-only program files, update separation, full restore/migration and retention-policy acceptance remain open. The real user's backup command/database was not used to verify this change.

## DIST-02 follow-up — explicit configuration directory

`src/config.mjs` now exports `configDir(rootDir, env)`: `TASKBRIDGE_CONFIG_DIR` when set and non-blank (resolved), otherwise the program root as before. `loadConfig`/`saveConfig` accept an optional env and create the target directory on first write. `loadConfig` still reads `config.example.json` from the program root, so the shipped template does not have to be copied. `scripts/strata-providers.mjs` and `scripts/cloud-local.mjs` read/write the same location instead of a hard-coded `<root>/config.json`.

Proof before/after, using the HEAD version of `src/config.mjs` in a copied program tree:

- Before: `TASKBRIDGE_CONFIG_DIR` was ignored, `config.json` was created inside the program directory, the operator's settings file was unused and the server listened on the example port 8787.
- After: settings are read from the configured directory, a new project is saved there, nothing is written into the program tree and session data lands in `TASKBRIDGE_DATA_DIR`.

Tests:

- `node --test --test-force-exit tests/config-dir.test.mjs`: **4 PASS** (historical layout, explicit directory, blank value treated as unset, real server started from a program tree without settings).
- `node --test --test-force-exit tests/strata-providers.test.mjs`: **2 PASS** after the fixture copies `src/config.mjs` and clears an inherited `TASKBRIDGE_CONFIG_DIR`.
- Full `npm test`: **1719 PASS, 0 FAIL, 4 SKIP** (1723 tests). `npm run check`: PASS.

The hermetic tests delete `TASKBRIDGE_*`/`PI_*` variables inherited from a live session; without that, the child tried to bind the operator server's `TASKBRIDGE_PORT` (no bind succeeded, no data changed).

Still open for DIST-02: proving a genuinely write-protected program directory (the tests assert that nothing is written, not that the OS forbids it), GUI/launcher propagation of the new variable, default user-profile locations for an installed build, and update/migration acceptance.
