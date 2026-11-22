package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.session.ChatSessionState

/**
 * S2: STOP can be accepted by the server while its HTTP acknowledgement is lost.
 * The client must not leave a permanent STOPPING state; the next task snapshot
 * must show the real outcome (CANCELLED here).
 */
class ChatStopReconnectTest {
    @Test
    fun aLostStopAcknowledgementReconcilesToTheServerResult() = runBlocking<Unit> {
        var cancelCalls = 0
        var cancelled = false
        val json = headersOf(HttpHeaders.ContentType, "application/json")
        val http = HttpClient(MockEngine { request ->
            val path = request.url.encodedPath
            when {
                path.endsWith("/events") -> respond("""{"events":[],"reachedStart":true}""", HttpStatusCode.OK, json)
                path.endsWith("/cancel") -> {
                    cancelCalls += 1
                    cancelled = true
                    throw ApiException(ApiError.Unreachable("ack lost"))
                }
                path.endsWith("/api/tasks/t") -> respond(
                    if (cancelled) """{"id":"t","status":"CANCELLED","title":"q"}""" else """{"id":"t","status":"RUNNING","title":"q"}""",
                    HttpStatusCode.OK, json,
                )
                else -> respond("{}", HttpStatusCode.OK, json)
            }
        })
        val session = ChatSession(
            TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "t", this,
            ids = { "stop-1" }, now = { "2026-11-22T00:00:00Z" }, initialStreamingEnabled = false,
        )
        try {
            session.start()
            withTimeout(5_000) { while (session.state.value.task == null) delay(20) }
            session.cancel()
            // The acknowledgement was lost; on reconnect the client refreshes the
            // task snapshot and learns the real result.
            session.setStreamingEnabled(true)
            val state = withTimeout(10_000) {
                while (session.state.value.task?.status != "CANCELLED") delay(20)
                session.state.value
            }
            assertEquals(1, cancelCalls)
            val answers = state.chat.items.filterIsInstance<ChatItem.Assistant>()
            assertTrue(answers.none { it.status == "STOPPING" }, "STOPPING survived a lost acknowledgement: ${answers.map { it.status }}")
            assertEquals("CANCELLED", answers.lastOrNull()?.status ?: "CANCELLED")
            assertFalse(state.busy.contains("cancel"), "the failed STOP left the cancel action busy")
        } finally {
            session.close()
            http.close()
        }
    }

    @Suppress("unused")
    private fun ChatSessionState.idleOrCancelled() = task?.status == "CANCELLED"
}
