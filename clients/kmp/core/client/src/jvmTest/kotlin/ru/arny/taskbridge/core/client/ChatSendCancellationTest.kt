package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlin.test.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.client.session.ChatEffect
import ru.arny.taskbridge.core.client.session.ChatPersistence
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.session.NoopChatPersistence
import ru.arny.taskbridge.core.client.session.PersistedOutgoing

class ChatSendCancellationTest {
    @Test fun closeCancelsAnInFlightUploadWithoutSendingTheMessage() = runBlocking<Unit> {
        val uploading = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        var messages = 0
        val http = HttpClient(MockEngine { request ->
            if (request.url.encodedPath.endsWith("/uploads")) {
                uploading.complete(Unit)
                try { awaitCancellation() } finally { cancelled.complete(Unit) }
            }
            messages++
            respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        })
        val session = ChatSession(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "t", this, ids = { "c" }, now = { "2026-11-21T00:00:00Z" })
        try {
            session.send("file", listOf(UploadFile("photo.jpg", "image/jpeg", byteArrayOf(1))))
            withTimeout(5000) { uploading.await() }
            session.close()
            withTimeout(5000) { cancelled.await() }
            assertEquals(0, messages)
        } finally { session.close(); http.close() }
    }

    @Test fun restoredMessagesRemainOrderedAcrossConcurrentReconnects() = runBlocking<Unit> {
        val first = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val second = CompletableDeferred<Unit>()
        val bodies = mutableListOf<String>()
        val headers = headersOf(HttpHeaders.ContentType, "application/json")
        val http = HttpClient(MockEngine { request ->
            when {
                request.url.encodedPath.endsWith("/message") -> {
                    val text = (request.body as TextContent).text
                    bodies += text
                    if (text.contains("c1")) { first.complete(Unit); release.await() } else second.complete(Unit)
                    respond("""{"id":"t","status":"RUNNING"}""", HttpStatusCode.OK, headers)
                }
                request.url.encodedPath.endsWith("/events") -> respond("""{"events":[],"reachedStart":true}""", HttpStatusCode.OK, headers)
                request.url.encodedPath.endsWith("/approvals") -> respond("[]", HttpStatusCode.OK, headers)
                else -> respond("""{"id":"t","status":"SUCCEEDED"}""", HttpStatusCode.OK, headers)
            }
        })
        val saved = object : ChatPersistence by NoopChatPersistence {
            override suspend fun loadOutbox(taskId: String) = listOf(
                PersistedOutgoing("c1", "first", mode = "QUEUE"),
                PersistedOutgoing("c2", "second", mode = "QUEUE"),
            )
        }
        val session = ChatSession(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "t", this, ids = { "c" }, now = { "2026-11-21T00:00:00Z" }, persistence = saved, initialStreamingEnabled = false)
        try {
            session.start()
            withTimeout(5000) { first.await() }
            repeat(16) { session.reconnectNow() }
            kotlinx.coroutines.delay(50)
            assertEquals(1, bodies.size, "the second message waits for the first acknowledgement")
            release.complete(Unit)
            withTimeout(5000) { second.await() }
            assertEquals(2, bodies.size)
            assertTrue(bodies[0].contains("c1"))
            assertTrue(bodies[1].contains("c2"))
        } finally { release.complete(Unit); session.close(); http.close() }
    }

    @Test fun stoppingUploadCancelsRequestRestoresFileAndNeverSendsMessage() = runBlocking<Unit> {
        val uploading = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        val wait = CompletableDeferred<Unit>()
        var messages = 0
        val http = HttpClient(MockEngine { request ->
            when {
                request.url.encodedPath.endsWith("/uploads") -> {
                    uploading.complete(Unit)
                    try { wait.await() } catch (e: CancellationException) { cancelled.complete(Unit); throw e }
                    respond("""{"token":"u","files":[{"id":"f","name":"photo.jpg"}]}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                }
                else -> { messages++; respond("""{"id":"t","status":"RUNNING"}""") }
            }
        })
        val session = ChatSession(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "t", this, ids = { "c" }, now = { "2026-11-21T00:00:00Z" })
        val effects = mutableListOf<ChatEffect>()
        val collector = launch(start = CoroutineStart.UNDISPATCHED) { session.effects.collect { effects += it } }
        yield()
        val file = UploadFile("photo.jpg", "image/jpeg", byteArrayOf(1, 2, 3))
        session.send("photo", listOf(file))
        withTimeout(5000) { uploading.await() }
        assertEquals(listOf("photo"), session.releaseStuckSends())
        withTimeout(5000) { cancelled.await() }
        wait.complete(Unit)
        yield()
        assertEquals(0, messages)
        assertTrue(session.state.value.outbox.isEmpty())
        val restored = effects.filterIsInstance<ChatEffect.RestoreComposer>().single()
        assertEquals("photo", restored.text)
        assertSame(file, restored.files.single())
        assertTrue(effects.filterIsInstance<ChatEffect.Notice>().isEmpty(), "local upload cancellation is not a delivery error")
        collector.cancelAndJoin(); session.close(); http.close()
    }

    @Test fun stoppingMessageWarnsAboutUnknownServerOutcomeWithoutRetrying() = runBlocking<Unit> {
        val sending = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        var messages = 0
        val http = HttpClient(MockEngine {
            messages++
            sending.complete(Unit)
            try { CompletableDeferred<Unit>().await() } catch (e: CancellationException) { cancelled.complete(Unit); throw e }
            respond("{}")
        })
        val session = ChatSession(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "t", this, ids = { "c" }, now = { "2026-11-21T00:00:00Z" })
        val effects = mutableListOf<ChatEffect>()
        val collector = launch(start = CoroutineStart.UNDISPATCHED) { session.effects.collect { effects += it } }
        yield()
        session.send("question")
        withTimeout(5000) { sending.await() }
        session.releaseStuckSends()
        withTimeout(5000) { cancelled.await() }
        yield()
        assertEquals(1, messages)
        assertTrue(session.state.value.outbox.isEmpty())
        assertTrue(effects.filterIsInstance<ChatEffect.Notice>().single().message.contains("мог уже принять"))
        collector.cancelAndJoin(); session.close(); http.close()
    }
}
