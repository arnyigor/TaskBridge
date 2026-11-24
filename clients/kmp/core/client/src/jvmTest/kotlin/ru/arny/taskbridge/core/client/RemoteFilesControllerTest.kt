package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlin.test.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import ru.arny.taskbridge.core.api.*
import ru.arny.taskbridge.core.client.remotefiles.RemoteFilesController

/**
 * Контроллер работает на настоящем HTTP (MockEngine) и на настоящем времени:
 * `TaskBridgeApi` считает таймаут запроса через `withTimeout`, поэтому под
 * виртуальными часами `runTest` любой запрос истекал мгновенно, а `runCurrent()`
 * не дожидался ответа с потока движка — тесты видели 0 вызовов. Отсюда
 * `runBlocking` + собственная область и ожидание состояния, как в
 * ChatVisibilityCatchUpTest. Интервал опроса сужен параметром контроллера.
 */
class RemoteFilesControllerTest {
    private val settings = """{"revision":0,"roots":[{"id":"r","name":"Downloads","available":true,"enabled":true,"canBrowse":true,"canPreview":true,"canAttach":true,"allowModelTransfer":true}],"requests":[]}"""
    private val headers = headersOf(HttpHeaders.ContentType, "application/json")
    private val pollInterval = 50L

    private fun scope() = CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)

    private suspend fun await(what: String, timeoutMillis: Long = 5_000, condition: suspend () -> Boolean) {
        val done = withTimeoutOrNull(timeoutMillis) {
            while (!condition()) delay(5)
            true
        } ?: false
        assertTrue(done, "Не дождались: $what")
    }

    @Test
    fun offlineAndHiddenScreensDoNotSendRequestsAndClearPreviews() = runBlocking<Unit> {
        val calls = mutableListOf<String>()
        val http = HttpClient(MockEngine { request ->
            calls += request.url.encodedPath
            respond(when {
                request.url.encodedPath.endsWith("preview") -> """{"name":"a.txt","mimeType":"text/plain","text":"private preview"}"""
                request.url.encodedPath.endsWith("browse") -> """{"rootId":"r","path":"","entries":[{"name":"a.txt","path":"a.txt","type":"file","previewAvailable":true}]}"""
                else -> settings
            }, HttpStatusCode.OK, headers)
        })
        val scope = scope()
        try {
            val controller = RemoteFilesController(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "p", "chat", scope, rootId = "r", pollIntervalMillis = pollInterval)
            controller.show()
            delay(pollInterval * 4)
            assertTrue(calls.isEmpty(), "офлайновый экран не ходит на сервер: $calls")
            controller.setOnline(true)
            await("настройки и каталог") { controller.state.value.entries.size == 1 }
            assertEquals(listOf("/api/projects/p/external-read", "/api/projects/p/remote-files/browse"), calls)
            controller.preview(controller.state.value.entries.single())
            await("preview") { controller.state.value.preview?.text != null }
            assertEquals("private preview", controller.state.value.preview?.text)
            controller.hide()
            assertNull(controller.state.value.preview)
            assertTrue(controller.state.value.entries.isEmpty())
            val before = calls.size
            // Шесть интервалов опроса: скрытый экран не опрашивает сервер.
            delay(pollInterval * 6)
            assertEquals(before, calls.size)
            controller.setOnline(false)
            controller.refresh()
            delay(pollInterval * 6)
            assertEquals(before, calls.size, "офлайновый экран не отправляет запросы")
        } finally {
            scope.cancel()
            http.close()
        }
    }

    @Test
    fun lateNavigationResponseCannotOverwriteTheNewRoot() = runBlocking<Unit> {
        val release = CompletableDeferred<Unit>()
        val settingsTwo = settings.replace("\"roots\":[", "\"roots\":[{\"id\":\"b\",\"name\":\"B\",\"available\":true,\"enabled\":true,\"canBrowse\":true},")
        val http = HttpClient(MockEngine { request ->
            val json = if (request.url.encodedPath.endsWith("browse")) {
                val root = request.url.parameters["rootId"]!!
                if (root == "r") withContext(NonCancellable) { release.await() }
                """{"rootId":"$root","path":"","entries":[{"name":"$root.txt","path":"$root.txt","type":"file"}]}"""
            } else settingsTwo
            respond(json, HttpStatusCode.OK, headers)
        })
        val scope = scope()
        try {
            val controller = RemoteFilesController(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "p", null, scope, pollIntervalMillis = pollInterval)
            controller.setOnline(true)
            controller.show()
            await("настройки") { controller.state.value.settings.roots.size == 2 }
            controller.navigate("r")
            controller.navigate("b")
            assertEquals("b", controller.state.value.rootId)
            await("каталог нового корня") { controller.state.value.entries.singleOrNull()?.name == "b.txt" }
            release.complete(Unit)
            // Поздний ответ прежнего корня не переписывает уже показанный каталог.
            delay(pollInterval * 6)
            assertEquals("b", controller.state.value.rootId)
            assertEquals("b.txt", controller.state.value.entries.single().name)
        } finally {
            scope.cancel()
            http.close()
        }
    }

    @Test
    fun pendingRequestsPollOnlyWhileVisibleAndOnline() = runBlocking<Unit> {
        var calls = 0
        val gate = Channel<Unit>(Channel.UNLIMITED)
        val pending = settings.replace("\"requests\":[]", "\"requests\":[{\"id\":\"q\",\"projectId\":\"p\",\"status\":\"PENDING\"}]")
        val http = HttpClient(MockEngine { calls++; gate.receive(); respond(pending, HttpStatusCode.OK, headers) })
        val scope = scope()
        try {
            val controller = RemoteFilesController(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "p", null, scope, pollIntervalMillis = pollInterval)
            controller.setOnline(true)
            controller.show()
            await("первичная загрузка") { calls == 1 }
            gate.send(Unit)
            await("опрос необработанного запроса") { calls == 2 }
            assertEquals(2, calls)
            controller.hide()
            gate.send(Unit)
            delay(pollInterval * 6)
            assertEquals(2, calls, "скрытый экран перестаёт опрашивать")
            controller.show()
            await("возврат на экран возобновляет опрос") { calls == 3 }
            controller.setOnline(false)
            delay(pollInterval * 6)
            assertEquals(3, calls, "офлайн перестаёт опрашивать")
        } finally {
            scope.cancel()
            http.close()
        }
    }

    @Test
    fun conflictIsShownWithoutSilentlyRepeatingTheMutation() = runBlocking<Unit> {
        var posts = 0
        val http = HttpClient(MockEngine { request ->
            if (request.url.encodedPath.endsWith("requests")) {
                posts++
                respond("""{"code":"REVISION_CONFLICT","error":"rights changed"}""", HttpStatusCode.Conflict, headers)
            } else respond(settings, HttpStatusCode.OK, headers)
        })
        val scope = scope()
        try {
            val controller = RemoteFilesController(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "p", null, scope, ids = { "command-1234" }, pollIntervalMillis = pollInterval)
            controller.setOnline(true)
            controller.show()
            await("настройки") { controller.state.value.settings.roots.isNotEmpty() && !controller.state.value.loading }
            controller.editRequestPath("Downloads")
            controller.request()
            await("конфликт показан") { controller.state.value.error != null }
            delay(pollInterval * 4)
            assertEquals(1, posts, "мутация не повторяется молча")
            assertFalse(controller.state.value.busy)
        } finally {
            scope.cancel()
            http.close()
        }
    }

    @Test
    fun serverSnapshotIsSentByReferenceWithoutDownloadingOrReuploadingBytes() = runBlocking<Unit> {
        val calls = mutableListOf<Pair<String, String>>()
        val http = HttpClient(MockEngine { request ->
            calls += request.url.encodedPath to ((request.body as? TextContent)?.text ?: "")
            val json = when {
                request.url.encodedPath.endsWith("prepare-attachment") -> """{"token":"snapshot-token","files":[{"id":"f","name":"a.txt"}]}"""
                request.url.encodedPath.endsWith("message") -> """{"id":"chat","status":"QUEUED"}"""
                request.url.encodedPath.endsWith("browse") -> """{"rootId":"r","path":"","entries":[{"name":"a.txt","path":"a.txt","type":"file"}]}"""
                else -> settings
            }
            respond(json, HttpStatusCode.OK, headers)
        })
        val scope = scope()
        try {
            val controller = RemoteFilesController(TaskBridgeApi(http, SimpleConnection("http://pc:8787")), "p", "chat", scope, rootId = "r", ids = { "command-1234" }, pollIntervalMillis = pollInterval)
            controller.setOnline(true)
            controller.show()
            await("каталог") { controller.state.value.entries.size == 1 && !controller.state.value.loading }
            controller.prepare(controller.state.value.entries.single())
            await("подготовка вложения") { controller.state.value.prepared?.token != null }
            assertEquals("snapshot-token", controller.state.value.prepared?.token)
            controller.editAttachmentText("Look at this")
            controller.sendAttachment()
            await("отправка сообщения") { calls.any { it.first.endsWith("message") } }
            val sent = calls.single { it.first.endsWith("message") }.second
            assertContains(sent, "snapshot-token")
            assertContains(sent, "Look at this")
            assertFalse(calls.any { it.first.contains("/uploads") || it.first.endsWith("preview") })
            assertFalse(sent.contains("base64"))
            await("подготовка сброшена") { controller.state.value.prepared == null }
        } finally {
            scope.cancel()
            http.close()
        }
    }
}
