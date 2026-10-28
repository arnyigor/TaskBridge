package ru.arny.taskbridge

import ru.arny.taskbridge.platform.UpdateMirror
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.exists
import kotlin.io.path.isDirectory

/**
 * Applies a staged portable build over the running installation and restarts.
 *
 * Windows keeps TaskBridge.exe, the bundled runtime and icudtl.dat locked while
 * the process is alive, so those files cannot be replaced in place. The swap is
 * done by a detached PowerShell script: it retries the mirror copy until the
 * launcher is gone, verifies the result, starts the new exe and only then
 * deletes the staging directory. Everything it does is written to update.log
 * next to the app — the first version waited on process ids, hung forever and
 * left an app that «не стартует» with no trace of why (live report 2026-10-28).
 *
 * Layout it expects (see :desktopApp:portable):
 *   <dist>/TaskBridge/TaskBridge.exe   <- running install
 *   <dist>/.staging/TaskBridge/        <- freshly built portable tree
 */
object DesktopUpdater {
    /** The install directory (the one holding TaskBridge.exe), or null outside a portable layout. */
    fun installDir(): Path? =
        ProcessHandle.current().info().command().orElse(null)
            ?.let { Paths.get(it).toAbsolutePath().parent }
            ?.takeIf { it.resolve("TaskBridge.exe").exists() }

    /** A staged portable build beside the install, or null when none is waiting. */
    fun stagedUpdate(installDir: Path): Path? {
        val staged = installDir.parent?.resolve(".staging")?.resolve("TaskBridge") ?: return null
        return staged.takeIf { it.isDirectory() && it.resolve("TaskBridge.exe").exists() }
    }

    /**
     * Starts the detached updater. Returns true when it was launched; the caller
     * must exit immediately afterwards so the files unlock.
     */
    fun applyAndRestart(installDir: Path, staged: Path): Boolean {
        val exe = installDir.resolve("TaskBridge.exe")
        if (!exe.exists()) return false
        val log = installDir.resolve("update.log")
        val script = Files.createTempFile("taskbridge-update-", ".ps1")
        Files.writeString(script, SCRIPT)
        return runCatching {
            ProcessBuilder(
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", script.toAbsolutePath().toString(),
                "-Source", staged.toAbsolutePath().toString(),
                "-Target", installDir.toAbsolutePath().toString(),
                "-Log", log.toAbsolutePath().toString(),
                "-CallerPid", ProcessHandle.current().pid().toString(),
                // Настройки и данные оператора не входят в зеркало обновления.
                "-ExcludeDirs", UpdateMirror.excludedDirSpec(),
                "-ExcludeFiles", UpdateMirror.excludedFileSpec(),
            )
                .directory(installDir.toFile())
                .redirectErrorStream(true)
                .start()
        }.isSuccess
    }

    /**
     * Ждём не «процесс с таким-то pid», а освобождение самого файла: номер процесса
     * после выхода приложения может достаться другому, и ожидание по pid висело
     * вечно (живой отчёт 2026-10-28: два зависших скрипта обновления, staging на
     * месте, приложение так и не перезапустилось).
     */
    private val SCRIPT = """
        param([string]${'$'}Source, [string]${'$'}Target, [string]${'$'}Log, [string]${'$'}CallerPid, [string]${'$'}ExcludeDirs, [string]${'$'}ExcludeFiles)

        ${'$'}ErrorActionPreference = 'Continue'
        function Write-Log([string]${'$'}text) {
            ${'$'}line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), ${'$'}text
            Add-Content -LiteralPath ${'$'}Log -Value ${'$'}line -Encoding utf8
        }
        function Unlocked([string]${'$'}path) {
            try {
                ${'$'}stream = [System.IO.File]::Open(${'$'}path, 'Open', 'Write', 'None')
                ${'$'}stream.Close()
                return ${'$'}true
            } catch { return ${'$'}false }
        }

        Write-Log "update started: source=${'$'}Source target=${'$'}Target caller=${'$'}CallerPid"
        # /MIR удаляет в цели всё, чего нет в источнике, поэтому настройки и данные
        # оператора исключаются и из копирования, и из удаления.
        ${'$'}excludeArgs = @()
        foreach (${'$'}dir in (${'$'}ExcludeDirs -split ';' | Where-Object { ${'$'}_.Trim() })) { ${'$'}excludeArgs += '/XD'; ${'$'}excludeArgs += ${'$'}dir }
        foreach (${'$'}file in (${'$'}ExcludeFiles -split ';' | Where-Object { ${'$'}_.Trim() })) { ${'$'}excludeArgs += '/XF'; ${'$'}excludeArgs += ${'$'}file }
        if (${'$'}excludeArgs.Count -gt 0) { Write-Log ("preserving: " + (${'$'}excludeArgs -join ' ')) }
        ${'$'}exe = Join-Path ${'$'}Target 'TaskBridge.exe'
        ${'$'}stagedExe = Join-Path ${'$'}Source 'TaskBridge.exe'
        if (-not (Test-Path -LiteralPath ${'$'}stagedExe)) { Write-Log 'FAIL: staging has no TaskBridge.exe'; exit 2 }

        # 0. Остатки приложения: лаунчер выходит раньше своего JVM, и файлы остаются
        #    занятыми. Останавливаем только процессы ЭТОГО exe — по имени образа
        #    убивать нельзя, рядом живут сервер и сессии.
        ${'$'}leftover = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { ${'$'}_.Path -eq ${'$'}exe })
        foreach (${'$'}item in ${'$'}leftover) {
            Write-Log "stopping leftover app process ${'$'}(${'$'}item.Id)"
            try { ${'$'}item.Kill() } catch { Write-Log "WARN: kill ${'$'}(${'$'}item.Id) failed: ${'$'}(${'$'}_.Exception.Message)" }
        }
        if (${'$'}leftover.Count -gt 0) { Start-Sleep -Milliseconds 800 }

        # 1. Ждём, пока приложение отпустит exe: копирование поверх занятого файла
        #    оставляет половину старой сборки — именно это и выглядело как «exe не стартует».
        ${'$'}waited = 0
        # Цель может быть пустой (первая установка) — тогда ждать нечего.
        while ((Test-Path -LiteralPath ${'$'}exe) -and -not (Unlocked ${'$'}exe) -and ${'$'}waited -lt 120) {
            Start-Sleep -Milliseconds 500
            ${'$'}waited += 0.5
        }
        if ((Test-Path -LiteralPath ${'$'}exe) -and -not (Unlocked ${'$'}exe)) { Write-Log "FAIL: exe still locked after ${'$'}waited s"; exit 3 }
        Write-Log "lock released after ${'$'}waited s"

        # 2. Зеркалим сборку до победного: robocopy возвращает 8+, когда файл занят.
        ${'$'}attempt = 0
        do {
            ${'$'}attempt++
            robocopy ${'$'}Source ${'$'}Target /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP ${'$'}excludeArgs | Out-Null
            ${'$'}code = ${'$'}LASTEXITCODE
            if (${'$'}code -ge 8) { Write-Log "copy attempt ${'$'}attempt failed (robocopy ${'$'}code)"; Start-Sleep -Milliseconds 700 }
        } while (${'$'}code -ge 8 -and ${'$'}attempt -lt 10)
        if (${'$'}code -ge 8) { Write-Log "FAIL: copy failed after ${'$'}attempt attempts (robocopy ${'$'}code)"; exit 4 }
        Write-Log "copy ok (robocopy ${'$'}code) after ${'$'}attempt attempt(s)"

        # 3. Проверяем, что в каталоге действительно новая сборка, а не её обломки.
        if (-not (Test-Path -LiteralPath ${'$'}exe)) { Write-Log 'FAIL: TaskBridge.exe missing after copy'; exit 5 }
        ${'$'}srcTime = (Get-Item -LiteralPath ${'$'}stagedExe).LastWriteTimeUtc
        ${'$'}dstTime = (Get-Item -LiteralPath ${'$'}exe).LastWriteTimeUtc
        if (${'$'}dstTime -lt ${'$'}srcTime) { Write-Log "FAIL: installed exe is older (${'$'}dstTime < ${'$'}srcTime)"; exit 6 }

        # 4. Запускаем и убеждаемся, что процесс живёт.
        # stderr приложения — единственное, что объясняет мгновенный выход: без него
        # «exe не стартует» остаётся догадкой (живой отчёт 2026-10-28).
        ${'$'}appLog = Join-Path ${'$'}Target 'app-start.log'
        try {
            ${'$'}proc = Start-Process -FilePath ${'$'}exe -WorkingDirectory ${'$'}Target -PassThru `
                -RedirectStandardError ${'$'}appLog -RedirectStandardOutput (Join-Path ${'$'}Target 'app-out.log')
        } catch {
            Write-Log "FAIL: start threw: ${'$'}(${'$'}_.Exception.Message)"; exit 7
        }
        Start-Sleep -Seconds 4
        ${'$'}proc.Refresh()
        if (${'$'}proc.HasExited) {
            ${'$'}stderr = try { (Get-Content -LiteralPath ${'$'}appLog -Raw -ErrorAction Stop).Trim() } catch { '' }
            if (${'$'}stderr) { Write-Log "app stderr: ${'$'}stderr" }
            Write-Log "FAIL: new process exited with code ${'$'}(${'$'}proc.ExitCode)"; exit 8
        }
        Write-Log "started pid ${'$'}(${'$'}proc.Id)"

        # 5. Staging убираем только после успешного запуска: иначе повтор невозможен.
        try { Remove-Item -LiteralPath ${'$'}Source -Recurse -Force -ErrorAction Stop; Write-Log 'staging removed' }
        catch { Write-Log "WARN: staging not removed: ${'$'}(${'$'}_.Exception.Message)" }
        try { Remove-Item -LiteralPath ${'$'}PSCommandPath -Force -ErrorAction SilentlyContinue } catch {}
        Write-Log 'update finished'
    """.trimIndent() + "\r\n"
}
