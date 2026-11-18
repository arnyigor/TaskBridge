package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.platform.PlatformServices
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Меню ⋮ списка сессий и меню папки: сортировка папок, закрепление и архив.
 *
 * Сортировка перекладывает уже загруженные папки — запросов она стоить не должна;
 * закрепление и архив — это PATCH /api/projects/{id}/preferences, его счётчик и проверяется.
 */
@OptIn(ExperimentalTestApi::class)
class SessionsMenuTest {

    private val json = headersOf(HttpHeaders.ContentType, "application/json")

    private val tasks = """
        [
          {"id":"t1","title":"Бета","projectId":"p1","status":"SUCCEEDED","updatedAt":"2026-10-20T10:00:00Z"},
          {"id":"t2","title":"Альфа","projectId":"p2","status":"RUNNING","updatedAt":"2026-10-20T11:00:00Z"}
        ]
    """.trimIndent()

    private val overview = """
        {"projects":[{"id":"p1","name":"first"},{"id":"p2","name":"second"}],"unassignedSessions":0,"totals":{}}
    """.trimIndent()

    @Test
    fun foldersSortPinAndArchiveFromMenus() = runComposeUiTest {
        var taskRequests = 0
        var preferenceCalls = 0
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val body = when {
                path.endsWith("/api/tasks") -> { taskRequests++; tasks }
                path.endsWith("/api/projects/overview") -> overview
                path.endsWith("/api/projects") -> """[{"id":"p1","name":"first"},{"id":"p2","name":"second"}]"""
                path.endsWith("/preferences") -> { preferenceCalls++; """{"pinned":true,"archived":false}""" }
                else -> "{}"
            }
            respond(body, HttpStatusCode.OK, json)
        }
        val http = HttpClient(engine)
        val store = MemorySettings()
        val platform = object : PlatformServices by DesktopPlatformServices(store = store) {
            override fun httpClient(baseUrl: String?): HttpClient = http
        }
        val graph = AppGraph(platform)
        val connection = graph.connect("http://pc:8787")

        setContent {
            MaterialTheme {
                Box(Modifier.size(420.dp, 800.dp)) {
                    SessionsScreen(graph = graph, connection = connection, selectedTaskId = null, onOpen = {}, onDraft = {}, onSettings = {})
                }
            }
        }

        // По умолчанию папки стоят «сначала активные»: папка работающей сессии выше.
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("first").fetchSemanticsNodes().isNotEmpty() }
        assertTrue(top("second") < top("first"), "по активности выше та папка, где идёт работа")
        val requestsBefore = taskRequests

        // Сортировка папок по имени — внутри меню ⋮ и без запросов к серверу.
        onNodeWithContentDescription("Ещё").performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("По имени").fetchSemanticsNodes().isNotEmpty() }
        onAllNodesWithText("По имени")[0].performClick()
        waitUntil(timeoutMillis = 5_000) { top("first") < top("second") }
        assertEquals("name", store.get("sessionsSortBy"))
        assertEquals(requestsBefore, taskRequests, "сортировка не должна ходить на сервер")

        // Закрепление папки — это PATCH предпочтений проекта, а не локальная догадка.
        onAllNodesWithContentDescription("Действия с папкой")[0].performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Закрепить папку").fetchSemanticsNodes().isNotEmpty() }
        assertTrue(onAllNodesWithText("В архив").fetchSemanticsNodes().isNotEmpty(), "у папки проекта есть архив")
        onAllNodesWithText("Закрепить папку")[0].performClick()
        waitUntil(timeoutMillis = 5_000) { preferenceCalls > 0 }

        graph.disconnect()
        http.close()
    }

    /**
     * Y-координата заголовка папки. Имя папки встречается дважды — подписью в строке
     * активной сессии (сверху) и заголовком-группой (ниже), поэтому берётся нижний.
     */
    private fun androidx.compose.ui.test.ComposeUiTest.top(text: String): Float =
        onAllNodesWithText(text).fetchSemanticsNodes().maxOf { it.boundsInRoot.top }

    private class MemorySettings : KeyValueStore {
        private val values = ConcurrentHashMap<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }
}
