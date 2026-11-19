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
    /** Признак готовности нового экземпляра (BUG-04C): pid, версия и отметка окна. */
    internal val readyMarkerName = "app-ready.txt"

    /** Пишется приложением: сначала сразу после захвата SingleInstance-лока, потом
     *  дополняется после создания главного окна. Обновлятор сверяет pid запущенного
     *  процесса и флаг окна — вместо ненадёжного «жив 4 секунды». */
    object StartupMarker {
        private fun file(installDir: Path): Path =
            installDir.resolve("logs").resolve(readyMarkerName)

        fun clear(installDir: Path) {
            runCatching { Files.deleteIfExists(installDir.resolve("logs").resolve(readyMarkerName)) }
        }

        fun write(installDir: Path?, version: String, windowShown: Boolean) {
            if (installDir == null) return
            runCatching {
                val logs = installDir.resolve("logs")
                Files.createDirectories(logs)
                val pid = ProcessHandle.current().pid()
                val existing = runCatching { Files.readString(file(installDir)) }.getOrDefault("")
                val mine = existing.lineSequence().any { it == "pid=$pid" }
                // Маркер другого pid (перезапуск без обновлятора): начинаем заново.
                val body = if (mine) existing else {
                    buildString {
                        append("pid=$pid\n")
                        append("version=$version\n")
                        // Идентификатор сборки сильнее версии: пересборка может сохранить
                        // номер версии, а хэш app-jar — нет. Обновлятор сверяет его с
                        // хэшем jar в staging и ставит FAIL при расхождении.
                        appJarHash(installDir)?.let { append("appJarHash=$it\n") }
                        append("startedAt=${System.currentTimeMillis()}\n")
                    }
                }
                val withWindow = if (windowShown) {
                    if (body.contains("window=true")) body else body.removeSuffix("\n") + "\nwindow=true\n"
                } else body
                Files.writeString(file(installDir), withWindow)
            }
        }
    }

    /** SHA-256 app/desktopApp-*.jar каталога — идентификатор сборки (для маркера и сверки staging). */
    internal fun appJarHash(dir: Path): String? = runCatching {
        val appDir = dir.resolve("app")
        val jar = Files.list(appDir).use { files ->
            files.filter { it.fileName.toString().startsWith("desktopApp-") && it.fileName.toString().endsWith(".jar") }
                .findFirst().orElse(null)
        } ?: return@runCatching null
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        java.security.DigestInputStream(Files.newInputStream(jar), digest).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (input.read(buffer) != -1) { /* drain */ }
        }
        digest.digest().joinToString("") { "%02x".format(it) }
    }.getOrNull()
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
        // Журнал живёт в защищённом от /MIR каталоге `logs` (UpdateMirror.protectedDirNames):
        // раньше update.log лежал рядом с exe, robocopy удалял его первым же проходом,
        // и после неудачного обновления оставались только последние две строки (живой
        // отчёт 2026-11-19: лог обрывался на «copy attempt 10 failed» без причин).
        val logs = installDir.resolve("logs")
        Files.createDirectories(logs)
        val log = logs.resolve("update.log")
        // Устаревший маркер предыдущего экземпляра не должен вводить в заблуждение
        // поллинг готовности: снимаем его до запуска скрипта.
        StartupMarker.clear(installDir)
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
                // Ожидаемый идентификатор сборки: маркер готовности нового EXE обязан
                // его повторить, иначе staging-сборка не та (пересборка может сохранить
                // номер версии, но не содержимое app-jar).
                "-ExpectedHash", appJarHash(staged).orEmpty(),
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
        param([string]${'$'}Source, [string]${'$'}Target, [string]${'$'}Log, [string]${'$'}CallerPid, [string]${'$'}ExcludeDirs, [string]${'$'}ExcludeFiles, [string]${'$'}ExpectedHash)

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
        # Вывод НЕ глушим: текст ошибки локализован («Ошибка», а не «ERROR»), ловим
        # по префиксу дата-время, который robocopy ставит перед любой ошибкой.
        ${'$'}attempt = 0
        do {
            ${'$'}attempt++
            ${'$'}out = robocopy ${'$'}Source ${'$'}Target /MIR /R:1 /W:1 /NDL /NJH /NJS /NP ${'$'}excludeArgs
            ${'$'}code = ${'$'}LASTEXITCODE
            if (${'$'}code -ge 8) {
                Write-Log "copy attempt ${'$'}attempt failed (robocopy ${'$'}code)"
                # Заблокированный целевой файл переименовываем: rename разрешён даже для
                # файла, открытого чужим процессом (llama-server держит runtime DLL
                # приложения, живой отчёт 2026-11-19). Новый файл ложится на его место,
                # старый под .old-* дорабатывает у держателя и чистится при следующем
                # обновлении. В ошибке robocopy путь ИСХОДНОГО файла, целевой получаем
                # заменой префикса источника на цель.
                ${'$'}renamed = 0
                foreach (${'$'}errLine in (${'$'}out | Where-Object { ${'$'}_ -match '^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}' -and ${'$'}_ -match '0x00000020' })) {
                    if (${'$'}renamed -ge 20) { break }
                    # Без якоря $: robocopy завершает строки \r, якорь не пускал.
                    # Жадный захват берёт всё от последней буквы диска до конца строки;
                    # ошибочные строки начинаются с даты, других путей в них нет.
                    if (${'$'}errLine -match '([A-Za-z]:\\.*)') {
                        ${'$'}srcPath = ${'$'}matches[1].Trim()
                        if (${'$'}srcPath.StartsWith(${'$'}Source, [System.StringComparison]::OrdinalIgnoreCase)) {
                            ${'$'}dstPath = ${'$'}Target + ${'$'}srcPath.Substring(${'$'}Source.Length)
                            if (Test-Path -LiteralPath ${'$'}dstPath) {
                                ${'$'}item = Get-Item -LiteralPath ${'$'}dstPath
                                ${'$'}newName = "${'$'}(${'$'}item.BaseName).old-${'$'}attempt-${'$'}renamed"
                                try { Rename-Item -LiteralPath ${'$'}dstPath -NewName ${'$'}newName -ErrorAction Stop; Write-Log "renamed locked target: ${'$'}dstPath -> ${'$'}newName"; ${'$'}renamed++ }
                                catch { Write-Log "WARN: rename ${'$'}dstPath failed: ${'$'}(${'$'}_.Exception.Message)" }
                            }
                        }
                    }
                }
                if (${'$'}renamed -eq 0) {
                    foreach (${'$'}errLine in (${'$'}out | Where-Object { ${'$'}_ -match '^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}' } | Select-Object -First 10)) {
                        Write-Log ${'$'}errLine
                    }
                }
                Start-Sleep -Milliseconds 700
            }
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
        New-Item -ItemType Directory -Force -Path (Join-Path ${'$'}Target 'logs') | Out-Null
        ${'$'}appLog = Join-Path ${'$'}Target 'logs\app-start.log'
        try {
            ${'$'}proc = Start-Process -FilePath ${'$'}exe -WorkingDirectory ${'$'}Target -PassThru `
                -RedirectStandardError ${'$'}appLog -RedirectStandardOutput (Join-Path ${'$'}Target 'logs\app-out.log')
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
        # 4b. Готовность нового экземпляра (BUG-04C): приложение пишет logs\app-ready.txt
        # (pid после захвата SingleInstance, window=true после создания главного окна).
        # Ждём маркер именно ЭТОГО pid — процесс может существовать, но висеть на старте,
        # а SingleInstance мог отдать фокус прежнему экземпляру.
        ${'$'}marker = Join-Path (Join-Path ${'$'}Target 'logs') 'app-ready.txt'
        ${'$'}ready = ${'$'}false
        ${'$'}waited = 0
        while (${'$'}waited -lt 45) {
            if (Test-Path -LiteralPath ${'$'}marker) {
                ${'$'}content = try { Get-Content -LiteralPath ${'$'}marker -Raw -ErrorAction Stop } catch { '' }
                ${'$'}pidOk = ${'$'}content -match "pid=${'$'}(${'$'}proc.Id)\b"
                ${'$'}hashOk = [string]::IsNullOrEmpty(${'$'}ExpectedHash) -or ${'$'}content -match "appJarHash=${'$'}ExpectedHash"
                if (${'$'}pidOk -and ${'$'}hashOk -and (${'$'}content -match 'window=true')) {
                    ${'$'}ready = ${'$'}true; break
                }
                if (${'$'}pidOk -and -not ${'$'}hashOk -and ${'$'}content -match 'appJarHash=') {
                    Write-Log "FAIL: marker build hash differs from staging (${'$'}ExpectedHash)"
                    exit 11
                }
            }
            Start-Sleep -Milliseconds 1000
            ${'$'}waited += 1
            ${'$'}proc.Refresh()
            if (${'$'}proc.HasExited) {
                ${'$'}stderr = try { (Get-Content -LiteralPath ${'$'}appLog -Raw -ErrorAction Stop).Trim() } catch { '' }
                if (${'$'}stderr) { Write-Log "app stderr: ${'$'}stderr" }
                Write-Log "FAIL: new process exited during readiness wait with code ${'$'}(${'$'}proc.ExitCode)"; exit 9
            }
        }
        if (${'$'}ready) { Write-Log "ready: pid ${'$'}(${'$'}proc.Id) in ${'$'}waited s" }
        else {
            Write-Log "FAIL: readiness marker with pid=${'$'}(${'$'}proc.Id) and window=true did not appear in 45 s"
            Write-Log "WARN: keeping staging for a manual retry"
            exit 10
        }
        Write-Log "started pid ${'$'}(${'$'}proc.Id)"

        # 5. Staging убираем только после успешного запуска: иначе повтор невозможен.
        try { Remove-Item -LiteralPath ${'$'}Source -Recurse -Force -ErrorAction Stop; Write-Log 'staging removed' }
        catch { Write-Log "WARN: staging not removed: ${'$'}(${'$'}_.Exception.Message)" }
        # Старые .old-* (переименованные заблокированные файлы): держатели их уже
        # отпустили или держат под новым именем — пробуем убрать, неудача не мешает.
        try {
            Get-ChildItem -LiteralPath ${'$'}Target -Recurse -Filter '*.old-*' -ErrorAction SilentlyContinue |
                Remove-Item -Force -ErrorAction SilentlyContinue
        } catch {}
        try { Remove-Item -LiteralPath ${'$'}PSCommandPath -Force -ErrorAction SilentlyContinue } catch {}
        Write-Log 'update finished'
    """.trimIndent() + "\r\n"
}
