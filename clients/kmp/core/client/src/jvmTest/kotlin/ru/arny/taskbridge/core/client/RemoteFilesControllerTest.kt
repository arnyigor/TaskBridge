package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.*
import kotlinx.coroutines.withContext
import ru.arny.taskbridge.core.api.*
import ru.arny.taskbridge.core.client.remotefiles.RemoteFilesController
import kotlin.test.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class RemoteFilesControllerTest {
    private val settings = """{"revision":0,"roots":[{"id":"r","name":"Downloads","available":true,"enabled":true,"canBrowse":true,"canPreview":true,"canAttach":true,"allowModelTransfer":true}],"requests":[]}"""
    private val headers = headersOf(HttpHeaders.ContentType, "application/json")

    @Test
    fun offlineAndHiddenScreensDoNotSendRequestsAndClearPreviews() = runTest {
        val calls = mutableListOf<String>()
        val api = TaskBridgeApi(HttpClient(MockEngine { request ->
            calls += request.url.encodedPath
            respond(when {
                request.url.encodedPath.endsWith("preview") -> """{"name":"a.txt","mimeType":"text/plain","text":"private preview"}"""
                request.url.encodedPath.endsWith("browse") -> """{"rootId":"r","path":"","entries":[{"name":"a.txt","path":"a.txt","type":"file","previewAvailable":true}]}"""
                else -> settings
            }, HttpStatusCode.OK, headers)
        }), SimpleConnection("http://pc:8787"))
        val controller = RemoteFilesController(api, "p", "chat", backgroundScope, rootId = "r")
        controller.show(); runCurrent()
        assertTrue(calls.isEmpty())
        controller.setOnline(true); runCurrent()
        assertEquals(2, calls.size)
        controller.preview(controller.state.value.entries.single()); runCurrent()
        assertEquals("private preview", controller.state.value.preview?.text)
        controller.hide()
        assertNull(controller.state.value.preview)
        assertTrue(controller.state.value.entries.isEmpty())
        val before = calls.size
        advanceTimeBy(30000); runCurrent()
        assertEquals(before, calls.size)
        controller.setOnline(false); controller.refresh(); runCurrent()
        assertEquals(before, calls.size)
    }

    @Test
    fun lateNavigationResponseCannotOverwriteTheNewRoot() = runTest {
        val release = CompletableDeferred<Unit>()
        val settingsTwo = settings.replace("\"requests\":[]", "\"requests\":[]").replace("\"roots\":[", "\"roots\":[{\"id\":\"b\",\"name\":\"B\",\"available\":true,\"enabled\":true,\"canBrowse\":true},")
        val api = TaskBridgeApi(HttpClient(MockEngine { request ->
            val json = if (request.url.encodedPath.endsWith("browse")) {
                val root = request.url.parameters["rootId"]!!
                if (root == "r") withContext(NonCancellable) { release.await() }
                """{"rootId":"$root","path":"","entries":[{"name":"$root.txt","path":"$root.txt","type":"file"}]}"""
            } else settingsTwo
            respond(json, HttpStatusCode.OK, headers)
        }), SimpleConnection("http://pc:8787"))
        val controller = RemoteFilesController(api, "p", null, backgroundScope)
        controller.setOnline(true); controller.show(); runCurrent()
        controller.navigate("r"); runCurrent()
        controller.navigate("b"); runCurrent()
        assertEquals("b", controller.state.value.rootId)
        assertEquals("b.txt", controller.state.value.entries.single().name)
        release.complete(Unit); runCurrent()
        assertEquals("b.txt", controller.state.value.entries.single().name)
    }

    @Test
    fun pendingRequestsPollOnlyWhileVisibleAndOnline() = runTest {
        var calls = 0
        val pending = settings.replace("\"requests\":[]", "\"requests\":[{\"id\":\"q\",\"projectId\":\"p\",\"status\":\"PENDING\"}]")
        val api = TaskBridgeApi(HttpClient(MockEngine { calls++; respond(pending, HttpStatusCode.OK, headers) }), SimpleConnection("http://pc:8787"))
        val controller = RemoteFilesController(api, "p", null, backgroundScope)
        controller.setOnline(true); controller.show(); runCurrent()
        assertEquals(1, calls)
        advanceTimeBy(5000); runCurrent()
        assertEquals(2, calls)
        controller.hide(); advanceTimeBy(20000); runCurrent()
        assertEquals(2, calls)
        controller.show(); runCurrent()
        assertEquals(3, calls)
        controller.setOnline(false); advanceTimeBy(20000); runCurrent()
        assertEquals(3, calls)
    }

    @Test
    fun conflictIsShownWithoutSilentlyRepeatingTheMutation() = runTest {
        var posts = 0
        val api = TaskBridgeApi(HttpClient(MockEngine { request ->
            if (request.url.encodedPath.endsWith("requests")) {
                posts++
                respond("""{"code":"REVISION_CONFLICT","error":"rights changed"}""", HttpStatusCode.Conflict, headers)
            } else respond(settings, HttpStatusCode.OK, headers)
        }), SimpleConnection("http://pc:8787"))
        val controller = RemoteFilesController(api, "p", null, backgroundScope, ids = { "command-1234" })
        controller.setOnline(true); controller.show(); runCurrent()
        controller.editRequestPath("Downloads"); controller.request(); runCurrent()
        assertEquals(1, posts)
        assertNotNull(controller.state.value.error)
        assertFalse(controller.state.value.busy)
    }

    @Test
    fun serverSnapshotIsSentByReferenceWithoutDownloadingOrReuploadingBytes() = runTest {
        val calls = mutableListOf<Pair<String, String>>()
        val api = TaskBridgeApi(HttpClient(MockEngine { request ->
            calls += request.url.encodedPath to ((request.body as? TextContent)?.text ?: "")
            val json = when {
                request.url.encodedPath.endsWith("prepare-attachment") -> """{"token":"snapshot-token","files":[{"id":"f","name":"a.txt"}]}"""
                request.url.encodedPath.endsWith("message") -> """{"id":"chat","status":"QUEUED"}"""
                request.url.encodedPath.endsWith("browse") -> """{"rootId":"r","path":"","entries":[{"name":"a.txt","path":"a.txt","type":"file"}]}"""
                else -> settings
            }
            respond(json, HttpStatusCode.OK, headers)
        }), SimpleConnection("http://pc:8787"))
        val controller = RemoteFilesController(api, "p", "chat", backgroundScope, rootId = "r", ids = { "command-1234" })
        controller.setOnline(true); controller.show(); runCurrent()
        controller.prepare(controller.state.value.entries.single()); runCurrent()
        assertEquals("snapshot-token", controller.state.value.prepared?.token)
        controller.editAttachmentText("Look at this"); controller.sendAttachment(); runCurrent()
        val sent = calls.single { it.first.endsWith("message") }.second
        assertContains(sent, "snapshot-token"); assertContains(sent, "Look at this")
        assertFalse(calls.any { it.first.contains("/uploads") || it.first.endsWith("preview") })
        assertFalse(sent.contains("base64"))
        assertNull(controller.state.value.prepared)
    }
}
