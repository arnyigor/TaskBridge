package ru.arny.taskbridge.platform

import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Приёмник wake-событий своего push-канала (раздел 4.3 плана, решение
 * оператора 2026-10-14: канал только в локальной сети, без внешних сервисов).
 *
 * Сервер, завершив ход, POST-ит `{taskId,type,at}` на наш порт (регистрация —
 * `POST /api/clients/wake {port}`). Клиент на это делает обычный refresh списка
 * — уведомление приходит за секунды вместо ближайшего фонового опроса.
 *
 * Сокет живёт, пока жив процесс: в фоне процесс держит WatchService, поэтому
 * приёмник не требует отдельного сервиса. Промахи (телефон уснул) — штатны:
 * фоновый опрос остаётся запасным каналом.
 */
class WakeListener(
    /** 0 — система даст свободный порт; фактический вернёт [start]. */
    private val requestedPort: Int = 0,
    private val onWake: () -> Unit,
) : Closeable {
    private var server: ServerSocket? = null
    private val closed = AtomicBoolean(false)

    /** Фактический порт после [start]; null — ещё не слушает. */
    @Volatile
    var boundPort: Int? = null
        private set

    /** Биндит порт и запускает daemon-цикл приёма; возвращает фактический порт. */
    @Synchronized
    fun start(): Int {
        check(server == null && !closed.get()) { "WakeListener уже запущен" }
        val socket = ServerSocket(requestedPort, 8, InetAddress.getByName("0.0.0.0"))
        server = socket
        boundPort = socket.localPort
        thread(name = "taskbridge-wake-listener", isDaemon = true) {
            while (!closed.get()) {
                val client = runCatching { socket.accept() }.getOrNull() ?: break
                handle(client)
            }
        }
        return socket.localPort
    }

    /** Один wake = одно короткое соединение: читаем запрос, отвечаем 204, будим приложение. */
    private fun handle(client: Socket) {
        client.use { socket ->
            runCatching {
                socket.soTimeout = 2_000
                val input = socket.getInputStream()
                val header = StringBuilder()
                val buffer = ByteArray(1)
                while (!header.endsWith("\r\n\r\n") && header.length < 8_192) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    header.append(buffer.decodeToString(0, read))
                }
                // Body нам не нужен: событие прочтёт сам клиент обычным refresh-ем
                // (так состояние всегда приходит одним путём, без второго парсера).
                val ok = header.startsWith("POST /wake")
                val response = (if (ok) "HTTP/1.1 204 No Content" else "HTTP/1.1 404 Not Found") +
                    "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                socket.getOutputStream().write(response.toByteArray())
                socket.getOutputStream().flush()
                if (ok) onWake()
            }
        }
    }

    @Synchronized
    override fun close() {
        closed.set(true)
        runCatching { server?.close() }
        server = null
        boundPort = null
    }
}
