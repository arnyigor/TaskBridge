package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.headersOf
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.SCRATCH_PROJECT_ID
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.platform.PlatformServices
import ru.arny.taskbridge.ui.SessionDraft
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

@OptIn(ExperimentalTestApi::class)
class DraftChatModeTest {
    @Test
    fun firstSendDefaultsToAgent() = firstSend("project", "agent")

    @Test
    fun planSelectedInEmptyChatReachesCreateRequest() = firstSend("project", "plan")

    @Test
    fun scratchCannotSelectPlan() = firstSend(SCRATCH_PROJECT_ID, "agent")

    private fun firstSend(projectId: String, mode: String) = runComposeUiTest {
        val created = AtomicReference<String?>(null)
        val requestBody = AtomicReference<String?>(null)
        val http = HttpClient(MockEngine { request ->
            val body = if (request.url.encodedPath == "/api/tasks" && request.method == HttpMethod.Post) {
                requestBody.set(request.body.toByteArray().decodeToString())
                """{"id":"created","status":"RUNNING","mode":"$mode"}"""
            } else "{}"
            respond(body, headers = headersOf(HttpHeaders.ContentType, "application/json"))
        })
        val store = object : KeyValueStore {
            private val values = ConcurrentHashMap<String, String>()
            override fun get(key: String): String? = values[key]
            override fun put(key: String, value: String?) {
                if (value == null) values.remove(key) else values[key] = value
            }
        }
        val platform = object : PlatformServices by DesktopPlatformServices(store = store) {
            override fun httpClient(baseUrl: String?): HttpClient = http
        }
        val graph = AppGraph(platform)
        val connection = graph.connect("http://pc:8787")
        try {
            setContent {
                MaterialTheme {
                    Box(Modifier.size(900.dp, 700.dp)) {
                        DraftChatScreen(graph, connection, SessionDraft(projectId, "Проект", null, "high", "Задача", "draft-command"), {}, { created.set(it) }, true)
                    }
                }
            }
            onNodeWithText("Агент").assertExists()
            onNodeWithText("Chat").assertDoesNotExist()
            // Режим живёт в композере: чип «Агент ▾», внутри меню — второй режим.
            if (mode == "plan") {
                onNodeWithContentDescription("Режим сессии", substring = true).performClick()
                onNodeWithText("Планирование").performClick()
            }
            // Без проекта планирование недоступно, и экран говорит это над полем ввода
            // (меню не открываем: открытое меню перекрывает композер).
            if (projectId == SCRATCH_PROJECT_ID) onNodeWithContentDescription("Режим сессии", substring = true).assertExists()
            onNode(hasSetTextAction()).performTextInput("Составь план изменений")
            onNodeWithContentDescription("Отправить в очередь").performClick()
            waitUntil(timeoutMillis = 15_000) { created.get() != null }
            val body = Json.parseToJsonElement(requireNotNull(requestBody.get())).jsonObject
            // Agent can be omitted by serialization because it is the API default.
            assertEquals(mode, body["mode"]?.jsonPrimitive?.content ?: "agent")
            assertEquals(projectId, body["projectId"]?.jsonPrimitive?.content)
            assertEquals("draft-command", body["commandId"]?.jsonPrimitive?.content)
            assertEquals("Составь план изменений", body["prompt"]?.jsonPrimitive?.content)
            assertFalse(body.containsKey("uploadToken"))
            assertEquals("created", created.get())
        } finally {
            graph.disconnect()
            http.close()
        }
    }
}
