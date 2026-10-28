# DIST-03 — self-contained server bundle

## What was built

`scripts/build-server-bundle.mjs` assembles a runtime-only server tree:

```text
server/
  src/            server, task manager, store, events, cloud modules
  scripts/        start-lan, backup, policy checks
  web/            UI plus the vendored browser modules
  pi-extension/   the Pi extensions the server passes with -e
  package.json
  package-lock.json
  config.example.json
  release-manifest.json
```

`./gradlew :desktopApp:standalonePortable` now calls that script instead of duplicating the include list in Gradle, so a manual build and a Gradle build cannot drift apart.

## Manifest

`release-manifest.json` records product, version (from package.json), build time, the `engines.node` requirement, the Node used to build, entrypoints, the settings/data environment variable names, the vendored browser modules, and a SHA256 for every shipped file. `config.json`, `data/`, `node_modules`, `.git`, `.gradle`, `build`, `dist` and `*.log` are never copied — a resource leak of exactly that kind reached origin once before.

## Runtime dependencies

The audited local path (health, task list, Web, vendor assets) uses only Node built-ins and the vendored browser modules; the smoke below proves it runs with `node_modules` absent and `PATH` empty. Cloud PostgreSQL stays optional and is deliberately not bundled: the included `package-lock.json` is what `npm ci --omit=dev` needs. The manifest states `nodeModulesBundled: false` so this is a recorded decision, not an accident.

Node itself is still not shipped (DIST-04) and Pi is still external (DIST-05); the launcher also needs `node` in `PATH` before it can hand over to a bundled runtime.

## Verification

- `node --test --test-force-exit tests/server-bundle.test.mjs`: **1 PASS**. It builds twice into separate sandboxes, compares all hashes, verifies every manifest entry against the shipped bytes, asserts that no `node_modules`/`data`/`config.json`/`.git`/log file is present, then starts `src/server.mjs` from the bundle with `PATH=''`, a deliberately failing Pi command, settings in `TASKBRIDGE_CONFIG_DIR` and state in `TASKBRIDGE_DATA_DIR`. Health and `/api/tasks` answered 200, every vendored asset answered 200, SQLite was created only in the configured state directory.
- Related suites together: `node --test --test-force-exit tests/server-bundle.test.mjs tests/config-dir.test.mjs tests/backup.test.mjs` — **10 PASS, 0 FAIL**.
- Real Gradle build: `./gradlew :desktopApp:standalonePortable` — BUILD SUCCESSFUL; `clients/kmp/dist/.staging/TaskBridge/server` contains 192 manifest entries, and all 192 hashes were re-checked against the written files with 0 mismatches.
- `npm run check`: PASS.

Hermetic tests strip inherited `TASKBRIDGE_*`/`PI_*` variables, because this shell runs inside a live TaskBridge session whose `TASKBRIDGE_PORT` otherwise made the child try to claim the operator's port. No bind succeeded, and no user data was touched.

## Limits

**DIST-03 partially done.** Still open: running the bundle from a directory outside this repository (the sandbox stays under `.local` by the agent's write boundary), a clean Windows machine without Node/npm/Git, pruning genuinely unused runtime dependencies (only `pg` for the optional cloud path is identified), and wiring the bundle into the real Desktop launcher/PKG-01 ZIP. No installer, updater or clean-install acceptance was performed here.
