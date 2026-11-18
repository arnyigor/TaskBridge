package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
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
import kotlin.test.assertTrue

/**
 * Шапка списка на узком экране телефона. Регрессия 2026-11-18: к шести иконкам
 * добавилась седьмая (группировка), в заголовке осталось меньше 60 dp — и «Сессии»
 * с подписью «ждут: N · работают: M» переносились по буквам, из-за чего TopAppBar
 * вырастал в высоту, а список уезжал вниз.
 *
 * Проверка по метрикам узла, а не по тексту: однострочный заголовок не бывает
 * выше ~28 dp, а разорванный на четыре строки — выше 60 dp.
 */
@OptIn(ExperimentalTestApi::class)
class SessionsHeaderHeightTest {

    private val json = headersOf(HttpHeaders.ContentType, "application/json")

    private val tasks = """
        [
          {"id":"t1","title":"Ждёт","projectId":"p1","status":"WAITING_USER","updatedAt":"2026-10-20T10:00:00Z"},
          {"id":"t2","title":"Работает","projectId":"p2","status":"RUNNING","updatedAt":"2026-10-20T11:00:00Z"}
        ]
    """.trimIndent()

    @Test
    fun narrowHeaderStaysOneLineTall() = runComposeUiTest {
        // Длинное имя проекта, чтобы заголовку заведомо не хватало ширины.
        val projects = """[
            {"id":"p1","name":"my-business-with-a-very-long-folder-name"},
            {"id":"p2","name":"TaskBridge"}
        ]"""
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val body = when {
                path.endsWith("/api/tasks") -> tasks
                path.endsWith("/api/projects") -> projects
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
                Box(Modifier.size(360.dp, 640.dp)) {
                    SessionsScreen(graph = graph, connection = connection, projectId = "p1", selectedTaskId = null, onOpen = {}, onDraft = {}, onSettings = {})
                }
            }
        }

        val density = this.density
        // Заход внутрь проекта с длинным именем: заголовок обязан остаться одной строкой.
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("my-business-with-a-very-long-folder-name").fetchSemanticsNodes().isNotEmpty() }
        val title = onAllNodesWithText("my-business-with-a-very-long-folder-name")[0].fetchSemanticsNode().boundsInRoot
        assertTrue(title.height < with(density) { 40.dp.toPx() }, "заголовок разорван по строкам: высота ${title.height}px")
        // В шапке три действия (перезапуск, настройки, меню ⋮), а не семь: именно они
        // отнимали у заголовка ширину и ломали высоту полосы.
        onNodeWithContentDescription("Перезапустить сервер").assertIsDisplayed()
        onNodeWithContentDescription("Настройки").assertIsDisplayed()
        onNodeWithContentDescription("Ещё").assertIsDisplayed()

        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("ждут: 1 · работают: 1").fetchSemanticsNodes().isNotEmpty() }
        val summary = onAllNodesWithText("ждут: 1 · работают: 1")[0].fetchSemanticsNode().boundsInRoot
        assertTrue(summary.height < with(density) { 26.dp.toPx() }, "подпись шапки разорвана по строкам: высота ${summary.height}px")

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
