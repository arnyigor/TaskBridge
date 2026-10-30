package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.writeStringUtf8
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.platform.PlatformServices
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Поиск на настоящем экране сессии: стрелки в строке поиска должны переводить
 * на следующее найденное сообщение — и счётчиком, и прокруткой ленты.
 *
 * Регрессия, которую это ловит: «кликаешь на стрелки и ничего» (оператор,
 * десктоп, 2026-10-30). Экран собирается целиком, через настоящий ChatScreen со
 * своим ChatSession, поэтому проверяется вся проводка щелчка: кнопка → шаг поиска
 * → подсветка и прокрутка ленты.
 */
@OptIn(ExperimentalTestApi::class)
class ChatScreenSearchTest {

    private val json = headersOf(HttpHeaders.ContentType, "application/json")

    /** Длинное сообщение: два таких не помещаются на экран вместе. */
    private fun message(seq: Int, text: String) =
        """{"taskId":"t1","seq":$seq,"type":"USER_MESSAGE","data":{"text":"$text"}}"""

    private val filler = "Строка отчёта с подробностями. "

    private fun longText(tail: String) = filler.repeat(120) + tail

    private fun graphWith(http: HttpClient): Pair<AppGraph, PlatformServices> {
        val platform = object : PlatformServices by DesktopPlatformServices(store = MemorySettings()) {
            override fun httpClient(baseUrl: String?): HttpClient = http
        }
        return AppGraph(platform) to platform
    }

    @Test
    fun arrowsStepThroughFoundMessagesOnTheWholeScreen() = runComposeUiTest {
        // Поток событий держим открытым: закрытый поток заставляет ChatSession
        // переподключаться и перезагружать окно истории, и лента «мигает» — тогда
        // проверка стрелок мерила бы гонку, а не поведение поиска.
        val stream = ByteChannel(autoFlush = true)
        stream.writeStringUtf8(": keepalive\n\n")
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            if (path.endsWith("/stream")) {
                return@MockEngine respond(
                    content = stream,
                    status = HttpStatusCode.OK,
                    headers = headersOf(HttpHeaders.ContentType, "text/event-stream"),
                )
            }
            val body = when {
                // Как настоящий сервер: окно по tail — с историей, а догрузка по after —
                // только новые события (иначе чат получал бы дубли и пересобирал ленту).
                path.endsWith("/api/tasks/t1/events") && request.url.parameters["tail"] != null -> """
                    {"events":[
                      ${message(1, longText("иголка в первом вопросе"))},
                      ${message(2, longText("иголка во втором вопросе"))}
                    ],"reachedStart":true}
                """.trimIndent()
                path.endsWith("/api/tasks/t1/events") -> """{"events":[],"reachedStart":true}"""
                path == "/api/tasks/t1" -> """{"id":"t1","title":"Проверка поиска","status":"SUCCEEDED","updatedAt":"2026-10-20T12:00:00Z"}"""
                path.endsWith("/approvals") -> "[]"
                else -> "{}"
            }
            respond(body, HttpStatusCode.OK, json)
        }
        val http = HttpClient(engine)
        val (graph, _) = graphWith(http)
        val connection = graph.connect("http://pc:8787")

        setContent {
            MaterialTheme {
                Box(Modifier.size(900.dp, 700.dp)) {
                    ChatScreen(
                        graph = graph,
                        connection = connection,
                        taskId = "t1",
                        onBack = {},
                        onOpenSession = {},
                        showBack = true,
                    )
                }
            }
        }

        waitUntil(timeoutMillis = 15_000) {
            onAllNodesWithText("иголка", substring = true).fetchSemanticsNodes().isNotEmpty()
        }

        onNodeWithContentDescription("Поиск по сессии").performClick()
        waitForIdle()
        // Первое поле на экране — строка поиска (она над лентой); если бы попало в
        // поле ввода сообщения, счётчик ниже не появился бы.
        onAllNodes(hasSetTextAction())[0].performTextInput("иголка")
        waitForIdle()
        onNodeWithText("2 из 2").assertExists()

        fun visible(text: String) = onAllNodesWithText(text, substring = true, useUnmergedTree = true)
            .fetchSemanticsNodes().any { it.boundsInRoot.height > 0f }

        // Переход вперёд: со второго (последнего) совпадения — на первое, самое старое.
        onNodeWithContentDescription("Следующее совпадение").performClick()
        waitForIdle()
        // Именно это и не работало: щелчок по стрелке не менял счётчик вовсе.
        onNodeWithText("1 из 2").assertExists()
        assertTrue(visible("иголка в первом вопросе"), "лента не дошла до найденного сообщения")

        // И назад: с первого — снова на последнее.
        onNodeWithContentDescription("Предыдущее совпадение").performClick()
        waitForIdle()
        onNodeWithText("2 из 2").assertExists()
        assertTrue(visible("иголка во втором вопросе"), "лента не вернулась ко второму сообщению")

        graph.disconnect()
        stream.close()
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
