# TaskBridge project notes

## Repository hygiene — what may live in this repository

The control is an **allowlist**, not a list of forbidden names. `scripts/repo-paths.mjs`
lists the roots TaskBridge may contain; anything else is refused, even if nobody has ever
seen its name before. A new top-level directory is added only by editing `ALLOWED_ROOTS`
in that file — reviewed in the diff, on purpose.

| Gate | When | What it checks |
|---|---|---|
| `.githooks/pre-commit` | every commit | `scripts/repo-policy.mjs --staged`: allowlist, risky names, locally forbidden terms |
| `.githooks/pre-push` | every push | `--outgoing` over `--branches --tags --not --remotes`, plus `check-secrets` |

Enable both hooks in a clone: `git config core.hooksPath .githooks`.
Manual runs: `npm run check:policy` and `npm run check:secrets`.

`security.local.json` (git-ignored; format in `security.local.example.json`) holds the
local list of corporate terms that must never be committed. It is deliberately not in the
repository, so the list of internal names is not published either.

### Git rules for agents

- **Never `git add -A`, never `git add .`** — that is how unrelated files get in.
  Stage reviewed paths explicitly: `git add src/foo.mjs tests/foo.test.mjs`.
- Before every commit: `git status --short`, then `git diff --cached --name-status`.
- An unexpected file is a stop signal — leave it untouched, do not stage it, say so.
- Do not commit backups, memories, dumps, archives, agent state, local reports or
  anything belonging to another project.
- Scratch work goes to `.local/` (ignored) or, better, outside the repository.

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
