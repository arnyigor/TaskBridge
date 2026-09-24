package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.writer
import io.ktor.utils.io.writeFully
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SseTest {
    private fun parseAll(text: String): List<SseMessage> {
        val parser = SseParser()
        return text.split("\n").mapNotNull { parser.feed(it) }
    }

    @Test
    fun theRecordedReplayParses() {
        val text = Fixtures.text("stream-replay.sse")
        val messages = parseAll(text)
        assertTrue(messages.size > 10)
        val events = messages.map { TaskBridgeJson.decodeFromString(TaskEvent.serializer(), it.data) }
        assertEquals(events.map { it.seq }, messages.map { it.id!!.toLong() })
        // seq only grows; it is NOT contiguous: streaming deltas closed by their
        // message_end are deleted from the log (src/event-trim.mjs), so their
        // numbers never come back. A client must not read a jump as a lost event.
        assertTrue(events.zipWithNext().all { (a, b) -> b.seq > a.seq }, "replay is strictly increasing")
        assertEquals(1L, events.first().seq)
    }

    @Test
    fun rulesOfTheFormat() {
        val parser = SseParser()
        assertNull(parser.feed(": heartbeat"))
        assertNull(parser.feed(""), "a comment alone dispatches nothing")
        assertNull(parser.feed("retry: 1500"))
        assertEquals(1500L, parser.retryMillis)
        parser.feed("id: 5\r")
        parser.feed("data: line one")
        parser.feed("data:line two")
        val message = parser.feed("\r")
        assertEquals(SseMessage("5", null, "line one\nline two"), message)
        parser.feed("event: presence")
        parser.feed("data: {}")
        assertEquals("presence", parser.feed("")!!.event)
        parser.feed("data: x")
        assertNull(parser.feed("")!!.event, "event name does not leak into the next message")
    }

    @Test
    fun theStreamSurvivesChunksCutInsideCharacters() = runBlocking<Unit> {
        val bytes = Fixtures.text("stream-replay.sse").toByteArray(Charsets.UTF_8)
        val engine = MockEngine {
            val channel = GlobalScope.writer(Dispatchers.IO) {
                // 7-byte chunks cut through the Cyrillic of the prompt text.
                bytes.toList().chunked(7).forEach { chunk -> channel.writeFully(chunk.toByteArray(), 0, chunk.size); channel.flush() }
            }.channel
            respond(channel, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"))
        }
        val api = TaskBridgeApi(HttpClient(engine), SimpleConnection("http://pc:8787"))
        val events = api.stream("t", 0).filterIsInstance<StreamItem.Event>().toList().map { it.event }
        val expected = parseAll(Fixtures.text("stream-replay.sse")).map { TaskBridgeJson.decodeFromString(TaskEvent.serializer(), it.data) }
        assertEquals(expected, events)
    }

    @Test
    fun aSilentStreamIsReportedAsUnreachable() = runBlocking<Unit> {
        val engine = MockEngine {
            val channel = GlobalScope.writer(Dispatchers.IO) {
                channel.writeFully("retry: 1500\n\n".toByteArray())
                channel.flush()
                delay(5_000)
            }.channel
            respond(channel, HttpStatusCode.OK)
        }
        val api = TaskBridgeApi(HttpClient(engine), SimpleConnection("http://pc:8787"))
        val error = assertFailsWith<ApiException> { api.stream("t", 0, idleTimeoutMillis = 200).toList() }
        assertIs<ApiError.Unreachable>(error.error)
    }

    @Test
    fun aMissingSessionFailsTheStreamWithItsError() = runBlocking<Unit> {
        val engine = MockEngine { respond(ByteReadChannel("""{"error":"Task not found","code":"NOT_FOUND"}"""), HttpStatusCode.NotFound) }
        val api = TaskBridgeApi(HttpClient(engine), SimpleConnection("http://pc:8787"))
        val error = assertFailsWith<ApiException> { api.stream("nope", 0).toList() }
        assertIs<ApiError.NotFound>(error.error)
    }
}
