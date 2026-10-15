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
import ru.arny.taskbridge.core.client.session.ChatSession
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * STOP обязан разблокировать любое состояние (оператор 2026-10-14: «сообщение не
 * отправляется, и я не могу никак перезапустить»). Если сервер не подтверждает
 * отправку, текст должен вернуться оператору, а не остаться в вечной очереди.
 */
class StuckSendReleaseTest {

    @Test
    fun `a send the server never confirms is released with its text`() = runBlocking<Unit> {
        val json = headersOf(HttpHeaders.ContentType, "application/json")
        val http = HttpClient(MockEngine { request ->
            when {
                // Команда принята, но подтверждения нет: клиент остаётся в Retrying/Unknown.
                request.url.encodedPath.endsWith("/message") -> respond("""{"commandId":"c1"}""", HttpStatusCode.OK, json)
                request.url.encodedPath.contains("/commands/") -> respond("""{"status":"ACCEPTED"}""", HttpStatusCode.OK, json)
                request.url.encodedPath.endsWith("/events") -> respond("""{"events":[],"reachedStart":true}""", HttpStatusCode.OK, json)
                request.url.encodedPath.endsWith("/stream") -> respond("", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"))
                request.url.encodedPath.endsWith("/approvals") -> respond("[]", HttpStatusCode.OK, json)
                else -> respond("""{"id":"t","status":"RUNNING"}""", HttpStatusCode.OK, json)
            }
        })
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val session = ChatSession(
            TaskBridgeApi(http, SimpleConnection("http://pc:8787", clientId = "stuck-send-test")),
            "t", scope, ids = { "id" }, now = { "2026-10-14T00:00:00Z" },
        )
        try {
            session.start()
            withTimeout(5_000) { while (session.state.value.loading) delay(10) }
            session.send("сообщение, которое не уходит", mode = ru.arny.taskbridge.core.client.session.SendMode.NOW)
            // Незавершённая отправка уже в очереди — STOP обязан отпустить её
            // независимо от того, успела ли она залипнуть в Retrying/Unknown.
            assertEquals(1, session.state.value.outbox.size, "отправка в очереди: ${session.state.value.outbox}")

            val released = session.releaseStuckSends()
            assertEquals(listOf("сообщение, которое не уходит"), released, "текст возвращается оператору, а не теряется")
            assertTrue(session.state.value.outbox.isEmpty(), "очередь разблокирована: ${session.state.value.outbox}")
            // Повторный STOP без зависших отправок ничего не «возвращает».
            assertEquals(emptyList(), session.releaseStuckSends())
        } finally {
            scope.cancel()
            http.close()
        }
    }
}
