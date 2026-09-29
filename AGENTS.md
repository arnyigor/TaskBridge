# TaskBridge project notes

## Repository hygiene — no local scratch, backups or memory snapshots in git

`.gitignore` covers the known offenders: `.memory-backup*/`, `config.json.bak*`,
`project-md/`, `.claude/`, `tmp-*`, `*.zip` and the `.pi/security-audit*` reports.

`npm run check:secrets` is the gate. It audits the Vercel upload set, tracked files,
the secret literals from `config.json`, risky path names and the whole git history.
It runs before every push once the clone has `git config core.hooksPath .githooks`.

Why this exists: a memory-snapshot directory reached `origin` in the past. It was
deleted and the history rewritten on 2026-09-29; every branch and tag was force-pushed,
so an existing clone must be re-fetched, not pulled.

## Desktop portable update procedure

When the user asks to update the Windows `TaskBridge.exe`:

1. Build the staged portable distribution first:
   - `cd clients/kmp && ./gradlew :desktopApp:portable --console=plain`
   - This writes the new app to `clients/kmp/dist/.staging/TaskBridge` and does not touch the running install.
2. Check whether the installed portable app is running:
   - PowerShell: `Get-Process TaskBridge -ErrorAction SilentlyContinue | Select-Object Id,Path`
3. If `TaskBridge.exe` is running from `clients/kmp/dist/TaskBridge`, do **not** overwrite files and do **not** force-restart it by command.
   - Windows locks `TaskBridge.exe`, `app/icudtl.dat`, and runtime files.
   - Stop after staging the update and tell the user: update is prepared; install/restart it from the tray item `Установить обновление и перезапустить`.
4. If TaskBridge is not running, direct install is fine:
   - `cd clients/kmp && ./gradlew :desktopApp:installPortable --console=plain`
5. Verify:
   - Running app case: verify `clients/kmp/dist/.staging/TaskBridge/TaskBridge.exe` exists and report that the user must apply it through tray.
   - Not running case: verify `clients/kmp/dist/TaskBridge/TaskBridge.exe` timestamp changed.
   - If packaging a ZIP, create it from `clients/kmp/dist/.staging/TaskBridge` before the staged update is consumed.
