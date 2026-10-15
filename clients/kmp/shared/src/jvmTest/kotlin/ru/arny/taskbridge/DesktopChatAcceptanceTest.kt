package ru.arny.taskbridge

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.v2.runComposeUiTest
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ru.arny.taskbridge.core.api.CreateTaskRequest
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.client.session.ChatPersistence
import ru.arny.taskbridge.core.client.session.LinkState
import ru.arny.taskbridge.core.client.session.NoopChatPersistence
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.core.client.settings.SecretStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.platform.PlatformServices
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals

/** The production desktop composition, with isolated settings and a real disposable server. */
@OptIn(ExperimentalTestApi::class)
class DesktopChatAcceptanceTest {
    @Test
    fun chatKeepsDraftAcrossReconnectAndStopCancelsTheAddressedRun() = runComposeUiTest {
        val fixture = ProcessBuilder("node", "tests/fixture-server.mjs")
            .directory(File(System.getProperty("taskbridge.repo")))
            .redirectError(ProcessBuilder.Redirect.INHERIT).start()
        val output = fixture.inputStream.bufferedReader()
        val input = fixture.outputStream.bufferedWriter()
        fun fixtureLine(): String = CompletableFuture.supplyAsync { output.readLine() }
            .get(30, TimeUnit.SECONDS) ?: error("fixture output closed")
        var graph: AppGraph? = null
        try {
            val ready = fixtureLine()
            val base = TaskBridgeJson.parseToJsonElement(ready).jsonObject.getValue("base").jsonPrimitive.content
            val memory = MemorySettings().apply { put("serverUrl", base) }
            val desktop = DesktopPlatformServices(store = memory)
            val platform = object : PlatformServices by desktop {
                override val secrets: SecretStore = memory
                override fun chatPersistence(serverUrl: String): ChatPersistence = NoopChatPersistence
            }
            val app = AppGraph(platform)
            graph = app
            val connection = app.connection ?: error("isolated connection missing")
            val task = runBlocking { connection.api.createTask(CreateTaskRequest(projectId = "fixture", prompt = "Desktop acceptance initial")) }
            val chat = connection.chat(task.id)
            setContent { App(app, openTaskId = task.id) }
            waitUntil(timeoutMillis = 30_000) { chat.state.value.task?.status == "SUCCEEDED" && chat.state.value.link == LinkState.Live }
            waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Desktop acceptance initial", substring = true).fetchSemanticsNodes().isNotEmpty() }

            onNode(hasSetTextAction()).performTextInput("unsent desktop draft")
            input.write("down 3000\n")
            input.flush()
            waitUntil(timeoutMillis = 10_000) { chat.state.value.link != LinkState.Live }
            assertEquals("up", fixtureLine())
            waitUntil(timeoutMillis = 30_000) { chat.state.value.link == LinkState.Live }
            waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("unsent desktop draft").fetchSemanticsNodes().isNotEmpty() }

            // Replace text through the UI, then send the hanging fixture request.
            onNode(hasSetTextAction()).performTextInput(" fault-hang")
            onNodeWithContentDescription("Отправить в очередь").performClick()
            waitUntil(timeoutMillis = 30_000) { chat.state.value.task?.status == "RUNNING" }
            onNodeWithContentDescription("Остановить агента").performClick()
            onNodeWithText("Остановить").performClick()
            waitUntil(timeoutMillis = 30_000) { chat.state.value.task?.status == "CANCELLED" }
            assertEquals("CANCELLED", runBlocking { connection.api.task(task.id) }.status)
        } finally {
            graph?.disconnect()
            graph?.scope?.cancel()
            input.close() // fixture owns and removes only its generated temp directory
            if (!fixture.waitFor(15, TimeUnit.SECONDS)) {
                fixture.destroy()
                check(fixture.waitFor(5, TimeUnit.SECONDS)) { "fixture did not terminate" }
            }
        }
    }

    private class MemorySettings : KeyValueStore, SecretStore {
        private val values = ConcurrentHashMap<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }
}
