package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
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
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Правая колонка списка сессий: меню папок и меню строк сессий стоят на одном
 * правом крае, а не «плавают» по горизонтали в зависимости от длины имени.
 *
 * Регрессия, которую это ловит: у заголовка папки стоял `weight(1f, fill = false)`
 * рядом со `Spacer(weight(1f))`. Неиспользованная половина свободного места
 * оставалась пустой у правого края, и счётчики с меню вставали тем левее, чем
 * короче имя папки (на снимке экрана от 2026-10-22 разброс был ~150 px).
 */
@OptIn(ExperimentalTestApi::class)
class SessionsRightEdgeTest {

    private val json = headersOf(HttpHeaders.ContentType, "application/json")

    private val tasks = """
        [
          {"id":"t1","title":"Короткая","projectId":"p1","status":"SUCCEEDED","sizeBytes":14000000,"updatedAt":"2026-10-20T10:00:00Z"},
          {"id":"t2","title":"Длинное имя сессии для проверки правого края","projectId":"p2","status":"FAILED","sizeBytes":513600000,"updatedAt":"2026-10-20T11:00:00Z"},
          {"id":"t3","title":"Ещё одна","projectId":"p2","status":"SUCCEEDED","sizeBytes":246300000,"updatedAt":"2026-10-20T12:00:00Z"}
        ]
    """.trimIndent()

    @Test
    fun folderAndSessionMenusShareOneRightEdge() = runComposeUiTest {
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val body = when {
                path.endsWith("/api/tasks") -> tasks
                path.endsWith("/api/projects") -> """[{"id":"p1","name":"my-business"},{"id":"p2","name":"ComfyUI"}]"""
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
                    SessionsScreen(
                        graph = graph,
                        connection = connection,
                        selectedTaskId = null,
                        onOpen = {},
                        onDraft = {},
                        onSettings = {},
                    )
                }
            }
        }

        waitUntil(timeoutMillis = 10_000) { onAllNodesWithContentDescription("Действия с папкой").fetchSemanticsNodes().size >= 2 }
        val folderEdges = onAllNodesWithContentDescription("Действия с папкой").fetchSemanticsNodes()
            .map { it.boundsInRoot.right }
        assertEquals(1, folderEdges.distinct().size, "меню папок стоят на разных правых краях: $folderEdges")

        // Папка раскрывается только рукой оператора — кликаем по её заголовку.
        onAllNodesWithText("my-business")[0].performClick()
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithContentDescription("Действия").fetchSemanticsNodes().isNotEmpty() }
        val sessionEdge = onAllNodesWithContentDescription("Действия").fetchSemanticsNodes().first().boundsInRoot.right

        assertEquals(
            true,
            abs(sessionEdge - folderEdges.first()) <= 1f,
            "меню папок (${folderEdges.first()}) и строк сессий ($sessionEdge) должны стоять на одном крае",
        )

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
