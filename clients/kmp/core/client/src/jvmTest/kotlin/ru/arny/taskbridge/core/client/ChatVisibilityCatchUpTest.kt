package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteChannel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.session.ChatSession
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Возврат к чату обязан сам сверить версию с сервером.
 *
 * Сокет открывается и может молчать: следующий кадр приходит только с
 * heartbeat или с новым событием, а обрезанный реплей при пустом хвосте не
 * приходит вовсе. Пока сверка ждала кадра, чат на десктопе показывал старую
 * историю при живом соединении (телефон в этот момент просто открывал окно
 * заново и потому «работал»).
 */
class ChatVisibilityCatchUpTest {
    private val json = headersOf(HttpHeaders.ContentType, "application/json")
    private val sse = headersOf(HttpHeaders.ContentType, "text/event-stream")

    private fun user(seq: Long, text: String) =
        """{"taskId":"t","seq":$seq,"type":"USER_MESSAGE","data":{"text":"$text"}}"""

    /**
     * Клиент, у которого окно истории отдаётся по очереди [windows], поток
     * открывается и молчит (ни одного кадра), а версия задачи — [snapshotSeq].
     */
    private inner class Fixture(private val windows: List<String>, private val rawBody: String, snapshotSeq: Long) {
        val windowCalls = AtomicInteger()
        val rawCalls = AtomicInteger()
        private val pages = ConcurrentLinkedQueue(windows)

        @Volatile
        var snapshot: Long = snapshotSeq

        private val silent = ByteChannel()
        val http = HttpClient(MockEngine { request ->
            val path = request.url.encodedPath
            when {
                path.endsWith("/events") && request.url.parameters["tail"] != null -> {
                    windowCalls.incrementAndGet()
                    respond(pages.poll() ?: """{"events":[],"reachedStart":true}""", HttpStatusCode.OK, json)
                }
                path.endsWith("/events") -> {
                    rawCalls.incrementAndGet()
                    respond(rawBody, HttpStatusCode.OK, json)
                }
                // Открытый и молчащий поток: кадра, который запустил бы сверку, нет.
                path.endsWith("/stream") -> respond(silent, HttpStatusCode.OK, sse)
                path.endsWith("/approvals") -> respond("[]", HttpStatusCode.OK, json)
                else -> respond("""{"id":"t","status":"RUNNING","snapshotSeq":${snapshot}}""", HttpStatusCode.OK, json)
            }
        })
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val session = ChatSession(
            TaskBridgeApi(http, SimpleConnection("http://pc:8787", clientId = "visibility-catch-up-test")),
            "t",
            scope,
            ids = { "id" },
            now = { "2026-11-13T00:00:00Z" },
            initialStreamingEnabled = false,
        )

        fun userTexts(): List<String> =
            session.state.value.chat.items.filterIsInstance<ChatItem.User>().map { it.text }

        fun close() {
            runCatching { silent.cancel(null) }
            scope.cancel()
            http.close()
        }
    }

    @Test
    fun `returning to the chat catches up without waiting for a stream frame`() = runBlocking<Unit> {
        val fixture = Fixture(
            windows = listOf("""{"events":[${user(7, "seven")}],"reachedStart":false}"""),
            rawBody = """[${user(8, "eight")},${user(9, "nine")}]""",
            snapshotSeq = 9,
        )
        try {
            fixture.session.start()
            withTimeout(5_000) { while (fixture.session.state.value.loading) delay(10) }
            delay(100)
            assertEquals(listOf("seven"), fixture.userTexts(), "стартовое окно загружено")

            // Чат снова виден: сервер уже на 9, клиент на 7, поток молчит.
            fixture.session.setStreamingEnabled(true)
            withTimeout(5_000) {
                while (fixture.userTexts() != listOf("seven", "eight", "nine")) delay(10)
            }
            assertEquals(1, fixture.rawCalls.get(), "хвост догружен запросом /events?after=7")
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `a server whose history is behind the cursor is reloaded once, not left frozen`() = runBlocking<Unit> {
        val fixture = Fixture(
            windows = listOf(
                """{"events":[${user(5, "five")},${user(6, "six")},${user(7, "seven")}],"reachedStart":false}""",
                """{"events":[${user(1, "one")},${user(2, "two")}],"reachedStart":false}""",
            ),
            rawBody = "[]",
            snapshotSeq = 7,
        )
        try {
            fixture.session.start()
            withTimeout(5_000) { while (fixture.session.state.value.loading) delay(10) }
            delay(100)
            assertEquals(listOf("five", "six", "seven"), fixture.userTexts())

            // История сервера переписана ниже курсора (восстановление стора):
            // после курсора не придёт ничего, ждать нечего — нужно окно заново.
            fixture.snapshot = 2
            fixture.session.setStreamingEnabled(true)
            withTimeout(5_000) { while (fixture.userTexts() != listOf("one", "two")) delay(10) }
            assertEquals(2, fixture.windowCalls.get(), "история перечитана окном")

            // Сверка версии идемпотентна: второго перечитывания быть не должно.
            fixture.session.setStreamingEnabled(true)
            delay(400)
            assertEquals(2, fixture.windowCalls.get(), "после сверки окно не перечитывается повторно")
        } finally {
            fixture.close()
        }
    }
}
