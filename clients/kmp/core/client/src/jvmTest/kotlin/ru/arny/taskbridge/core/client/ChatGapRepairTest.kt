package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
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
 * Дыра в потоке событий и её починка (ChatSession.repairGap).
 *
 * Переподключение отдаёт реплей, обрезанный по байтам (`: replay-trimmed` в
 * server.mjs): между курсором редьюсера и первым пришедшим событием возникает
 * дыра. Раньше редьюсер молча перепрыгивал её, и эти сообщения пропадали у
 * клиента навсегда — на десктопе так терялась часть истории при живом потоке.
 */
class ChatGapRepairTest {
    private val json = headersOf(HttpHeaders.ContentType, "application/json")
    private val sse = headersOf(HttpHeaders.ContentType, "text/event-stream")

    private fun user(seq: Long, text: String) =
        """{"taskId":"t","seq":$seq,"type":"USER_MESSAGE","data":{"text":"$text"}}"""

    /** Клиент, у которого история = [windows] (запросы с tail), поток = [sseBody]. */
    private class Fixture(windows: List<String>, private val rawBody: String, sseBody: String) {
        val windowCalls = AtomicInteger()
        val rawCalls = AtomicInteger()
        private val pages = ConcurrentLinkedQueue(windows)
        val http = HttpClient(MockEngine { request ->
            val path = request.url.encodedPath
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            when {
                path.endsWith("/events") && request.url.parameters["tail"] != null -> {
                    windowCalls.incrementAndGet()
                    respond(pages.poll() ?: """{"events":[],"reachedStart":true}""", HttpStatusCode.OK, json)
                }
                path.endsWith("/events") -> {
                    rawCalls.incrementAndGet()
                    respond(rawBody, HttpStatusCode.OK, json)
                }
                path.endsWith("/stream") ->
                    respond(sseBody, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"))
                path.endsWith("/approvals") -> respond("[]", HttpStatusCode.OK, json)
                else -> respond("""{"id":"t","status":"SUCCEEDED"}""", HttpStatusCode.OK, json)
            }
        })
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val session = ChatSession(
            TaskBridgeApi(http, SimpleConnection("http://pc:8787", clientId = "gap-repair-test")),
            "t", scope, ids = { "id" }, now = { "2026-10-16T00:00:00Z" },
        )

        fun userTexts(): List<String> =
            session.state.value.chat.items.filterIsInstance<ChatItem.User>().map { it.text }

        fun close() {
            scope.cancel()
            http.close()
        }
    }

    @Test
    fun `a trimmed replay gap is backfilled from the events api`() = runBlocking<Unit> {
        val fixture = Fixture(
            windows = listOf("""{"events":[${user(1, "one")},${user(2, "two")},${user(3, "three")}],"reachedStart":false}"""),
            rawBody = """[${user(4, "four")},${user(5, "five")}]""",
            sseBody = ": replay-trimmed 2\n\nid: 6\ndata: ${user(6, "six")}\n\n",
        )
        try {
            fixture.session.start()
            withTimeout(10_000) {
                while (fixture.userTexts() != listOf("one", "two", "three", "four", "five", "six")) delay(20)
            }
            assertEquals(1, fixture.rawCalls.get(), "дыра должна догружаться запросом /events?after=")
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `a gap the events api cannot fill is repaired by reloading the window`() = runBlocking<Unit> {
        val fixture = Fixture(
            windows = listOf(
                """{"events":[${user(1, "one")}],"reachedStart":false}""",
                """{"events":[${user(1, "one")},${user(4, "four")},${user(5, "five")},${user(6, "six")}],"reachedStart":false}""",
            ),
            rawBody = "[]",
            sseBody = "id: 6\ndata: ${user(6, "six")}\n\n",
        )
        try {
            fixture.session.start()
            withTimeout(10_000) {
                while (fixture.userTexts() != listOf("one", "four", "five", "six")) delay(20)
            }
            assertEquals(2, fixture.windowCalls.get(), "пустая догрузка должна перечитывать окно истории")
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `a gap over the ceiling reloads the window instead of pulling megabytes`() = runBlocking<Unit> {
        val fixture = Fixture(
            windows = listOf(
                """{"events":[${user(1, "one")}],"reachedStart":false}""",
                """{"events":[${user(1, "one")},${user(2500, "late")}],"reachedStart":false}""",
            ),
            rawBody = "[]",
            sseBody = "id: 2500\ndata: ${user(2500, "late")}\n\n",
        )
        try {
            fixture.session.start()
            withTimeout(10_000) {
                while (fixture.userTexts() != listOf("one", "late")) delay(20)
            }
            assertEquals(0, fixture.rawCalls.get(), "дыра выше потолка не должна догружаться страницами")
            assertEquals(2, fixture.windowCalls.get(), "история чинится перечитыванием окна")
        } finally {
            fixture.close()
        }
    }
}
