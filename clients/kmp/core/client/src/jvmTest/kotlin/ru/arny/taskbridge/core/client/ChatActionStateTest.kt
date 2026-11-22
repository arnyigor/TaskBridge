package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.session.ChatSession
import kotlin.test.*

class ChatActionStateTest {
    private val headers = headersOf(HttpHeaders.ContentType, "application/json")
    private fun ChatSession.answer() = state.value.chat.items.filterIsInstance<ChatItem.Assistant>().last()
    private suspend fun until(condition: () -> Boolean) = withTimeout(5000) { while (!condition()) delay(5) }

    @Test fun lateTerminalFromPreviousTurnCannotGreyButtonsWhileNewAnswerIsActive() = runBlocking<Unit> {
        val task = """{"id":"t","prompt":"new","status":"RUNNING","snapshotSeq":1,"turnState":{"turn":2,"phase":"PROGRESS"}}"""
        val events = """{"events":[{"seq":1,"type":"USER_MESSAGE","data":{"text":"new","turn":2}}],"reachedStart":true}"""
        var reads = 0
        val http = HttpClient(MockEngine { request ->
            when {
                request.url.encodedPath.endsWith("/stream") -> respond(
                    "id: 2\ndata: {\"seq\":2,\"type\":\"TASK_CANCELLED\",\"data\":{\"turn\":1}}\n\n",
                    HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"),
                )
                request.url.encodedPath.endsWith("/events") -> respond(events, HttpStatusCode.OK, headers)
                request.url.encodedPath.endsWith("/approvals") -> respond("[]", HttpStatusCode.OK, headers)
                else -> {
                    if (reads++ > 0) kotlinx.coroutines.awaitCancellation()
                    respond(task, HttpStatusCode.OK, headers)
                }
            }
        })
        val session = ChatSession(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "t", this, ids = { "c" }, now = { "2026-11-21T00:00:00Z" })
        try {
            session.start()
            until { session.state.value.chat.cursor == 2L }
            assertTrue(session.answer().active, "the terminal belongs to the old answer")
            assertEquals("RUNNING", session.state.value.task?.status, "task controls and answer must use the same generation verdict")
        } finally { session.close(); http.close() }
    }

    @Test fun editHidesOldErrorWhileWaitingRejectsDoubleTapAndRestoresErrorOnRefusal() = runBlocking<Unit> {
        val editing = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var posts = 0
        val task = """{"id":"t","prompt":"old","status":"FAILED","snapshotSeq":2}"""
        val events = """{"events":[{"seq":1,"type":"USER_MESSAGE","at":"2026-11-21T00:00:00Z","data":{"text":"old","turn":1}},{"seq":2,"type":"TASK_FAILED","at":"2026-11-21T00:00:01Z","message":"old error","data":{"turn":1}}],"reachedStart":true}"""
        val http = HttpClient(MockEngine { request ->
            when {
                request.url.encodedPath.endsWith("/edit") -> {
                    posts++; editing.complete(Unit); release.await()
                    respond("""{"code":"NOT_ALLOWED","error":"refused"}""", HttpStatusCode.Conflict, headers)
                }
                request.url.encodedPath.endsWith("/events") -> respond(events, HttpStatusCode.OK, headers)
                request.url.encodedPath.endsWith("/approvals") -> respond("[]", HttpStatusCode.OK, headers)
                else -> respond(task, HttpStatusCode.OK, headers)
            }
        })
        val session = ChatSession(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "t", this, ids = { "c" }, now = { "2026-11-21T00:00:00Z" }, initialStreamingEnabled = false)
        try {
            session.start()
            until { !session.state.value.loading && session.state.value.chat.items.isNotEmpty() }
            assertEquals("old error", session.answer().error)
            session.editMessage("user-1", "new")
            withTimeout(5000) { editing.await() }
            assertEquals("SENDING", session.answer().status)
            assertNull(session.answer().error)
            session.editMessage("user-1", "new again")
            delay(30)
            assertEquals(1, posts)
            release.complete(Unit)
            until { session.state.value.busy.isEmpty() }
            assertEquals("old error", session.answer().error)
            assertEquals("old", session.state.value.chat.items.filterIsInstance<ChatItem.User>().last().text)
        } finally { release.complete(Unit); session.close(); http.close() }
    }

    @Test fun delayedStopResponseCannotCancelANewerTurnReceivedDuringRefresh() = runBlocking<Unit> {
        val cancelling = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var newer = false
        val http = HttpClient(MockEngine { request ->
            when {
                request.url.encodedPath.endsWith("/cancel") -> {
                    cancelling.complete(Unit); release.await()
                    respond("""{"id":"t","status":"CANCELLED","snapshotSeq":1,"turnState":{"turn":1,"phase":"SETTLED"}}""", HttpStatusCode.OK, headers)
                }
                request.url.encodedPath.endsWith("/events") -> {
                    val seq = if (newer) 2 else 1
                    respond("""{"events":[{"seq":$seq,"type":"USER_MESSAGE","at":"2026-11-21T00:00:0${seq}Z","data":{"text":"question $seq","turn":$seq}}],"reachedStart":true}""", HttpStatusCode.OK, headers)
                }
                request.url.encodedPath.endsWith("/approvals") -> respond("[]", HttpStatusCode.OK, headers)
                else -> respond("""{"id":"t","status":"RUNNING","snapshotSeq":${if (newer) 2 else 1}}""", HttpStatusCode.OK, headers)
            }
        })
        val session = ChatSession(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "t", this, ids = { "c" }, now = { "2026-11-21T00:00:00Z" }, initialStreamingEnabled = false)
        try {
            session.start()
            until { !session.state.value.loading && session.state.value.chat.cursor == 1L }
            session.cancel(hard = true)
            withTimeout(5000) { cancelling.await() }
            newer = true
            session.setStreamingEnabled(true)
            until { session.state.value.chat.cursor == 2L }
            release.complete(Unit)
            until { session.state.value.busy.isEmpty() }
            assertTrue(session.answer().active)
            assertFalse(session.answer().final)
            assertNotEquals("CANCELLED", session.state.value.task?.status)
        } finally { release.complete(Unit); session.close(); http.close() }
    }
}
