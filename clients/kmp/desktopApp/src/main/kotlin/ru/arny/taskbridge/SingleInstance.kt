package ru.arny.taskbridge

import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

/**
 * One TaskBridge per user. Closing the window only hides it to the tray, so
 * every new launch used to leave one more process behind. The first process
 * listens on a loopback port written to [portFile]; a later launch asks it to
 * show its window and exits.
 */
object SingleInstance {
    private val portFile = File(System.getProperty("user.home"), ".taskbridge-desktop.port")

    /** True when another instance answered and is now showing its window: this one should exit. */
    fun activateExisting(): Boolean {
        val port = runCatching { portFile.readText().trim().toInt() }.getOrNull() ?: return false
        return runCatching {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), port), 500)
                socket.soTimeout = 1000
                socket.getOutputStream().write("show\n".toByteArray())
                socket.getOutputStream().flush()
                socket.getInputStream().bufferedReader().readLine() == "ok"
            }
        }.getOrDefault(false)
    }

    /**
     * Becomes the instance others find. [onShow] runs on a background thread.
     * ponytail: two launches in the same instant can both start; a file lock would close that gap.
     */
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
