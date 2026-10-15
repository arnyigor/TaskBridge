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
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Section 4.3: retained chats must not retain one SSE socket each. */
class ChatStreamingLifecycleTest {
    @Test
    fun `closing during initial load can never open an orphan stream`() = runBlocking<Unit> {
        val streamRequests = AtomicInteger()
        val json = headersOf(HttpHeaders.ContentType, "application/json")
        val http = HttpClient(MockEngine { request ->
            when {
                request.url.encodedPath.endsWith("/events") -> {
                    delay(300)
                    respond("""{"events":[],"reachedStart":true}""", HttpStatusCode.OK, json)
                }
                request.url.encodedPath.endsWith("/stream") -> {
                    streamRequests.incrementAndGet()
                    respond("", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"))
                }
                request.url.encodedPath.endsWith("/approvals") -> respond("[]", HttpStatusCode.OK, json)
                else -> respond("""{"id":"t","status":"SUCCEEDED"}""", HttpStatusCode.OK, json)
            }
        })
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val session = ChatSession(
            TaskBridgeApi(http, SimpleConnection("http://pc:8787", clientId = "close-race-test")),
            "t", scope, ids = { "id" }, now = { "2026-10-14T00:00:00Z" },
        )
        try {
            session.start()
            delay(30)
            session.close()
            // A stale actor command may arrive after close; terminal state must reject it.
            session.setStreamingEnabled(true)
            delay(400)
            assertEquals(0, streamRequests.get(), "a closed loading chat must remain terminal")
        } finally {
            scope.cancel()
            http.close()
        }
    }

    @Test
    fun `a hidden chat opens no stream and a visible chat owns only one`() = runBlocking<Unit> {
        val streamRequests = AtomicInteger()
        val streamCursors = java.util.concurrent.CopyOnWriteArrayList<Pair<String?, String?>>()
        val json = headersOf(HttpHeaders.ContentType, "application/json")
        val sse = headersOf(HttpHeaders.ContentType, "text/event-stream")
        val http = HttpClient(MockEngine { request ->
            when {
                request.url.encodedPath.endsWith("/events") ->
                    respond("""{"events":[{"taskId":"t","seq":7,"type":"STATUS","data":{"status":"SUCCEEDED"}}],"reachedStart":true}""", HttpStatusCode.OK, json)
                request.url.encodedPath.endsWith("/approvals") ->
                    respond("[]", HttpStatusCode.OK, json)
                request.url.encodedPath.endsWith("/stream") -> {
                    streamRequests.incrementAndGet()
                    streamCursors += request.url.parameters["after"] to request.headers["Last-Event-ID"]
                    // A finite SSE response leaves the loop in its backoff, which makes
                    // duplicate enable calls observable without keeping a socket in the test.
                    respond("retry: 60000\n\n", HttpStatusCode.OK, sse)
                }
                request.url.encodedPath.endsWith("/health") ->
                    respond("""{"ok":true}""", HttpStatusCode.OK, json)
                else -> respond("""{"id":"t","status":"SUCCEEDED","projectId":"fixture"}""", HttpStatusCode.OK, json)
            }
        })
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val session = ChatSession(
            TaskBridgeApi(http, SimpleConnection("http://pc:8787", clientId = "stream-lifecycle-test")),
            "t",
            scope,
            ids = { "id" },
            now = { "2026-10-14T00:00:00Z" },
            initialStreamingEnabled = false,
        )

        try {
            session.start()
            withTimeout(5_000) { while (session.state.value.loading) delay(10) }
            delay(100)
            assertEquals(0, streamRequests.get(), "a retained hidden chat must not open SSE")

            session.setStreamingEnabled(true)
            withTimeout(5_000) { while (streamRequests.get() < 1) delay(10) }
            session.setStreamingEnabled(true)
            delay(100)
            assertEquals(1, streamRequests.get(), "enabling is idempotent")

            session.setStreamingEnabled(false)
            val pausedAt = streamRequests.get()
            delay(100)
            assertEquals(pausedAt, streamRequests.get(), "a hidden chat remains disconnected")

            session.setStreamingEnabled(true)
            withTimeout(5_000) { while (streamRequests.get() < 2) delay(10) }
            assertTrue(streamRequests.get() >= 2, "returning to the chat reconnects")
            assertTrue(
                streamCursors.all { it == ("7" to "7") },
                "every resumed stream must catch up after the reducer cursor: $streamCursors",
            )
        } finally {
            session.close()
            scope.cancel()
            http.close()
        }
    }
}
