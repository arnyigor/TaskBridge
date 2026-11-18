package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
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
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.platform.PlatformServices
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Удаление нескольких сессий, выбранных в папке: каждое выделение обязано дойти
 * до сервера отдельным DELETE /api/tasks/{id}, даже если выделено полпапки.
 */
@OptIn(ExperimentalTestApi::class)
class SessionsMultiDeleteTest {

    private val json = headersOf(HttpHeaders.ContentType, "application/json")

    private val tasks = """
        [
          {"id":"t1","title":"Один","projectId":"p1","status":"SUCCEEDED","updatedAt":"2026-10-20T10:00:00Z"},
          {"id":"t2","title":"Два","projectId":"p1","status":"SUCCEEDED","updatedAt":"2026-10-20T10:05:00Z"},
          {"id":"t3","title":"Три","projectId":"p1","status":"SUCCEEDED","updatedAt":"2026-10-20T10:10:00Z"}
        ]
    """.trimIndent()

    @Test
    fun everySelectedSessionIsDeleted() = runComposeUiTest {
        val deleted = mutableListOf<String>()
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val body = when {
                request.method == HttpMethod.Delete && path.startsWith("/api/tasks/") -> {
                    deleted += path.removePrefix("/api/tasks/")
                    "{}"
                }
                path.endsWith("/api/tasks") -> tasks
                path.endsWith("/api/projects") -> """[{"id":"p1","name":"Проект"}]"""
                path.endsWith("/api/projects/overview") -> """{"projects":[{"id":"p1","name":"Проект"}]}"""
                else -> "{}"
            }
            respond(body, HttpStatusCode.OK, json)
        }
        val http = HttpClient(engine)
        val platform = object : PlatformServices by DesktopPlatformServices(store = MemorySettings()) {
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
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Проект").fetchSemanticsNodes().isNotEmpty() }

        // Меню папки → «Выбрать все в папке (3)».
        onAllNodesWithContentDescription("Действия с папкой")[0].performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Выбрать все в папке (3)").fetchSemanticsNodes().isNotEmpty() }
        onAllNodesWithText("Выбрать все в папке (3)")[0].performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Выбрано: 3").fetchSemanticsNodes().isNotEmpty() }

        onNodeWithContentDescription("Удалить выбранные").performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Удалить").fetchSemanticsNodes().isNotEmpty() }
        onAllNodesWithText("Удалить")[0].performClick()

        waitUntil(timeoutMillis = 10_000) { deleted.size >= 1 }
        // Ждём, пока цикл удаления закончит все три, и сверяем состав.
        runCatching { waitUntil(timeoutMillis = 5_000) { deleted.size == 3 } }
        assertEquals(listOf("t1", "t2", "t3"), deleted.sorted(), "до сервера дошли не все выбранные сессии")

        graph.disconnect()
        http.close()
    }

    private class MemorySettings : KeyValueStore {
        private val values = ConcurrentHashMap<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }
}
