package ru.arny.taskbridge

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.exists
import kotlin.io.path.isDirectory

/**
 * Applies a staged portable build over the running installation and restarts.
 *
 * Windows keeps TaskBridge.exe, the bundled runtime and icudtl.dat locked while
 * the process is alive, so those files cannot be replaced in place — that is
 * why `:desktopApp:portable` fails when the app is running. The swap is done by
 * a detached cmd script: it waits for this PID to exit, mirrors the staging
 * directory over the install directory and starts the new exe.
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
        val current = ProcessHandle.current()
        val exePath = exe.toAbsolutePath().normalize()
        val waitPids = listOfNotNull(
            current.pid(),
            current.parent().orElse(null)
                ?.takeIf { parent ->
                    parent.info().command().orElse(null)?.let { command ->
                        runCatching { Paths.get(command).toAbsolutePath().normalize() == exePath }.getOrDefault(false)
                    } == true
                }
                ?.pid(),
        ).distinct().joinToString(",")
        val script = Files.createTempFile("taskbridge-update-", ".cmd")
        Files.writeString(
            script,
            """
            @echo off
            setlocal
            rem Wait for the app launcher pair to release TaskBridge.exe / icudtl.dat / runtime.
            powershell -NoProfile -Command "Wait-Process -Id $waitPids -ErrorAction SilentlyContinue"
            powershell -NoProfile -Command "Start-Sleep -Milliseconds 300"
            robocopy "${staged.toAbsolutePath()}" "${installDir.toAbsolutePath()}" /MIR /NFL /NDL /NJH /NJS /NP >nul
            start "" "${exe.toAbsolutePath()}"
            rmdir /s /q "${staged.toAbsolutePath()}"
            del "%~f0"
            """.trimIndent() + "\r\n",
        )
        return runCatching {
            ProcessBuilder("cmd.exe", "/c", script.toAbsolutePath().toString())
                .directory(installDir.toFile())
                .start()
        }.isSuccess
    }
}