package ru.arny.taskbridge

import java.io.File
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import kotlin.concurrent.thread

/**
 * One TaskBridge per user. The primary process owns [lockFile] for its whole
 * lifetime and listens on a loopback port written to [portFile]; a later launch
 * asks it to show its window and exits. The lock closes the startup/restart race
 * where two tray instances could survive before the port listener was ready.
 */
object SingleInstance {
    private val portFile = File(System.getProperty("user.home"), ".taskbridge-desktop.port")
    private val lockFile = File(System.getProperty("user.home"), ".taskbridge-desktop.lock")
    private var lockChannel: FileChannel? = null
    private var lock: FileLock? = null

    /** True when this process became the only UI instance. Keep the returned lock until process exit. */
    fun claimPrimary(): Boolean {
        if (lock?.isValid == true) return true
        return runCatching {
            lockFile.parentFile?.mkdirs()
            val channel = RandomAccessFile(lockFile, "rw").channel
            val acquired = channel.tryLock()
            if (acquired == null) {
                channel.close()
                false
            } else {
                lockChannel = channel
                lock = acquired
                true
            }
        }.getOrDefault(false)
    }

    /** True when another instance answered and is now showing its window: this one should exit. */
    fun activateExisting(attempts: Int = 10, delayMillis: Long = 150): Boolean {
        repeat(attempts) { attempt ->
            val port = runCatching { portFile.readText().trim().toInt() }.getOrNull()
            val ok = if (port != null) runCatching {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), port), 500)
                    socket.soTimeout = 1000
                    socket.getOutputStream().write("show\n".toByteArray())
                    socket.getOutputStream().flush()
                    socket.getInputStream().bufferedReader().readLine() == "ok"
                }
            }.getOrDefault(false) else false
            if (ok) return true
            if (attempt < attempts - 1) Thread.sleep(delayMillis)
        }
        return false
    }

    /** Becomes the instance others find. [onShow] runs on a background thread. */
    fun listen(onShow: () -> Unit) {
        val server = runCatching { ServerSocket(0, 5, InetAddress.getLoopbackAddress()) }.getOrNull() ?: return
        runCatching { portFile.writeText(server.localPort.toString()) }
        thread(isDaemon = true, name = "single-instance") {
            while (true) {
                val client = runCatching { server.accept() }.getOrNull() ?: break
                client.use {
                    runCatching {
                        it.soTimeout = 1000
                        if (it.getInputStream().bufferedReader().readLine() == "show") {
                            onShow()
                            it.getOutputStream().write("ok\n".toByteArray())
                        }
                    }
                }
            }
        }
    }
}
