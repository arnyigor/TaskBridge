# PKG-01 — the portable ZIP

## What was built

`scripts/build-portable-zip.mjs` turns a prepared build directory into a distributable archive:

```
TaskBridge-Portable-<version>-win-x64.zip
  TaskBridge/
    TaskBridge.exe
    app/            Compose Desktop image
    runtime/        trimmed JVM
    server/         DIST-03 bundle (src, web, pi-extension, scripts, lockfile, manifest)
    SHA256SUMS.txt  hash of every file inside the archive
TaskBridge-Portable-<version>-win-x64.zip.sha256   side-car hash of the archive
```

The script refuses to pack instead of shipping something unusable:

- no `TaskBridge.exe` → names `:desktopApp:portable`;
- no `server/release-manifest.json` → names `:desktopApp:standalonePortable`;
- any `config.json`, `data/`, `logs/`, `backups/`, `config/`, `node_modules`, `.git`, `.gradle` directory or `*.log` file **anywhere** in the tree → refuses with the offending path. The check walks the whole tree, because the server bundle sits one level down and that is exactly where operator state would hide.

Archiving uses Windows' `%SystemRoot%/System32/tar.exe` (libarchive) explicitly, or `bsdtar` on other platforms (`-a -c -f …zip`), so the build needs no npm dependency and no network. GNU tar from Git must not be selected from PATH: it silently creates TAR for this extension. The builder checks the ZIP local-file signature before publishing the checksum. Paths are passed relative to the working directory: on Windows `tar -f G:\…` is read as `host:path` and fails with "Cannot connect to G:" — measured, then worked around.

## Verification

### Correction: previous archives were TAR, not ZIP

The earlier round-trip below verified contents but **did not verify format**: Git's GNU tar both wrote and read the `.zip` as TAR (signature `Task`, not `PK`). Those 138 MiB artifacts were not valid ZIP distributions; the previous PKG-01 format acceptance was incorrect.

After selecting Windows libarchive explicitly, the real artifact was rebuilt at the same path: **69.0 MiB**, SHA256 `b094e0e8f958d3d084a865248c59b5c24ffcbba8cc7ece1b3037fe8d11906c7c`. Independent Python `zipfile.ZipFile` opened it, `testzip()` found no CRC errors, and all **431** manifest hashes matched. `portable-zip` plus `server-bundle` tests: **9 PASS**; `npm run check`: PASS. Tests now check the ZIP signature, reject successful GNU tar output (and remove a stale sidecar), and build twice to ensure the manifest never contains its own obsolete hash. The running installation was not overwritten.

### Earlier content-only checks

- `node --test --test-force-exit tests/portable-zip.test.mjs` — **7 PASS**: full archive round-trip (entries present, every `SHA256SUMS.txt` line matches the extracted bytes, a file's bytes equal the source), four refusal cases (`server/config.json`, `server/data/taskbridge.db`, a root-level `*.log`, `server/logs/a.log` — and no archive is left behind), plus the two "missing prerequisite" messages.
- Real build from the staged distribution: `node scripts/build-portable-zip.mjs --dist clients/kmp/dist/.staging/TaskBridge` → `clients/kmp/dist/TaskBridge-Portable-1.3.0-win-x64.zip`, **429 entries**, 138.0 MiB, `sha256 31d8f370…`.
- The archive was extracted into a sandbox and all **428** hashes in `SHA256SUMS.txt` were recomputed — 0 mismatches.
- The extracted server was then started the way an operator would: `cwd` = `TaskBridge/server`, `PATH=''`, settings in `TASKBRIDGE_CONFIG_DIR`, state in `TASKBRIDGE_DATA_DIR`, a deliberately missing Pi. `/api/health` → 200, `/api/tasks` → 200, `/` → 200 (58 563 bytes), `/vendor/marked.js` → 200. SQLite appeared only in the configured state directory; no `config.json` and no `data/` were created inside the bundle.

## Limits

- This is **not** clean-machine acceptance: the same Windows machine, the same Node build, and the archive stays inside the repository. No machine without Node/Pi/Java was used, and `TaskBridge.exe` was not launched from the extracted copy (a GUI window and a tray icon are required).
- Node and Pi runtimes are still not inside the archive (DIST-04/05 bundle the *selection* logic, not the binaries).
- Windows Setup (PKG-02), release CI (REL-01) and the clean-install matrix (REL-02) remain open.
