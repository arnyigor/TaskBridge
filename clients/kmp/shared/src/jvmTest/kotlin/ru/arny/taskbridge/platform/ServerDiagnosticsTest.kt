package ru.arny.taskbridge.platform

import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Диагностика запуска сервера: хвосты `lan-*.log` для настроек, публичный порт из
 * `lan.json` и проба `/api/health`. Всё это видит оператор, когда сервер не поднялся,
 * поэтому проверяем на реальных файлах и на живом HTTP-сервере, а не на моках.
 */
class ServerDiagnosticsTest {

    private fun temp(name: String): File = Files.createTempDirectory(name).toFile()

    @Test
    fun logTailShowsEveryLogWithItsHeading() {
        val dir = temp("tb-logs-")
        File(dir, "lan-client-start.log").writeText((1..5).joinToString("\n") { "[lan] start $it" })
        File(dir, "lan-app.log").writeText("TaskBridge MVP listening on 127.0.0.1:49867")
        File(dir, "lan-proxy.log").writeText("[proxy] upstream unreachable")

        val tail = serverLogTail(dir, lines = 10)
        assertTrue(tail?.contains("=== запуск из приложения (lan-client-start.log) ===") == true, tail)
        assertTrue(tail.contains("=== сервер (lan-app.log) ==="), tail)
        assertTrue(tail.contains("=== прокси (lan-proxy.log) ==="), tail)
        assertTrue(tail.contains("listening on 127.0.0.1:49867"), tail)
        assertEquals("[lan] start 5", tail.lines().last { it.startsWith("[lan]") })
    }

    @Test
    fun logTailSkipsMissingFilesAndSurvivesNoLogsAtAll() {
        val dir = temp("tb-logs-empty-")
        assertNull(serverLogTail(dir, lines = 10), "без логов диалог должен сказать «логов нет»")
        File(dir, "lan-app.log").writeText("только сервер")
        val tail = serverLogTail(dir, lines = 10)
        assertTrue(tail?.contains("только сервер") == true)
        assertFalse(tail!!.contains("lan-proxy.log"), "отсутствующий лог не выдумываем: $tail")
    }

    /** Лог растёт без ротации: читаем окно с конца, а не файл целиком. */
    @Test
    fun logTailReadsTheEndOfALargeFile() {
        val dir = temp("tb-logs-big-")
        val big = File(dir, "lan-app.log")
        big.writeText((1..40_000).joinToString("\n") { "строка $it" })
        val tail = serverLogTail(dir, lines = 3)
        assertTrue(tail?.endsWith("строка 40000") == true, tail?.takeLast(80))
        assertTrue(big.length() > 64 * 1024, "файл должен быть больше окна чтения: ${big.length()}")
    }

    @Test
    fun publicPortComesFromLanJsonOnlyWhenItIsThere() {
        val dir = temp("tb-lanjson-")
        assertNull(lanPublicPort(dir), "нет lan.json — нет порта")
        File(dir, "lan.json").writeText("""{"appPid":1,"proxyPid":2,"internalPort":49867,"publicPort":8787}""")
        assertEquals(8787, lanPublicPort(dir))
        File(dir, "lan.json").writeText("не json вовсе")
        assertNull(lanPublicPort(dir), "мусор в файле не должен ронять перезапуск")
    }

    /** Проба та же, что ждёт start-lan: 200 на /api/health. */
    @Test
    fun healthProbeAnswersOnlyForALiveServer() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/health") { exchange ->
            val body = """{"status":"ok"}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            assertTrue(healthAnswers(server.address.port), "живой сервер должен опознаваться")
        } finally {
            server.stop(0)
        }
        // Порт закрытого сервера: проба обязана вернуть false, а не бросить исключение.
        assertFalse(healthAnswers(server.address.port), "мёртвый порт не должен считаться живым")
    }
}
