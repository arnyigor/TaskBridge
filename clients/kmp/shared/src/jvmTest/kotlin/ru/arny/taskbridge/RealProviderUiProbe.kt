package ru.arny.taskbridge

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.v2.runComposeUiTest
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.api.CreateTaskRequest
import ru.arny.taskbridge.core.api.ModelSelection
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.client.session.NoopChatPersistence
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.core.client.settings.SecretStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.platform.PlatformServices
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.test.assertTrue

/** Manual live-provider probe, with no @Test: offline CI must never send inference requests. */
@OptIn(ExperimentalTestApi::class)
object RealProviderUiProbe {
    @JvmStatic
    fun main(args: Array<String>) = runComposeUiTest {
        val fixture = ProcessBuilder("node", "tests/free-provider-fixture.mjs")
            .directory(File(System.getProperty("taskbridge.repo")))
            .redirectError(ProcessBuilder.Redirect.INHERIT).start()
        var graph: AppGraph? = null
        try {
            val ready = CompletableFuture.supplyAsync { fixture.inputStream.bufferedReader().readLine() }
                .get(30, TimeUnit.SECONDS) ?: error("fixture did not become ready")
            val info = TaskBridgeJson.parseToJsonElement(ready).jsonObject
            val model = info.getValue("model").jsonPrimitive.content
            val memory = Memory().apply { put("serverUrl", info.getValue("base").jsonPrimitive.content) }
            val desktop = DesktopPlatformServices(store = memory)
            var copied = ""
            val platform = object : PlatformServices by desktop {
                override val secrets: SecretStore = memory
                override fun chatPersistence(serverUrl: String) = NoopChatPersistence
                override fun copyText(text: String) { copied = text }
            }
            val app = AppGraph(platform)
            graph = app
            val connection = checkNotNull(app.connection)
            val task = runBlocking {
                connection.api.createTask(CreateTaskRequest(projectId = "fixture",
                    prompt = "Reply exactly PROVIDER_READY. Do not use tools.", model = ModelSelection("openrouter", model)))
            }
            val chat = connection.chat(task.id)
            setContent { App(app, openTaskId = task.id) }
            waitUntil(timeoutMillis = 90_000) {
                check(chat.state.value.task?.status != "FAILED") { "provider failed: ${chat.state.value.task?.errorCode} ${chat.state.value.task?.error.orEmpty()}" }
                chat.state.value.task?.status == "SUCCEEDED" &&
                    chat.state.value.chat.items.filterIsInstance<ChatItem.Assistant>().lastOrNull()?.text?.isNotBlank() == true
            }
            val initialAnswer = chat.state.value.chat.items.filterIsInstance<ChatItem.Assistant>().last().text
            val initialAnswerCount = chat.state.value.chat.items.filterIsInstance<ChatItem.Assistant>().size
            waitUntil(timeoutMillis = 10_000) {
                onAllNodes(renderedAnswer(initialAnswer)).fetchSemanticsNodes().isNotEmpty()
            }
            println("REAL_PROVIDER_READY model=$model")
            val started = System.nanoTime()
            onNode(hasSetTextAction()).performTextInput("Reply exactly TASKBRIDGE_UI_FREE_OK. Do not use tools.")
            onNodeWithContentDescription("Отправить в очередь").performClick()
            waitUntil(timeoutMillis = 90_000) {
                check(chat.state.value.task?.status != "FAILED") { "provider failed: ${chat.state.value.task?.errorCode} ${chat.state.value.task?.error.orEmpty()}" }
                val answers = chat.state.value.chat.items.filterIsInstance<ChatItem.Assistant>()
                val answer = answers.lastOrNull()
                chat.state.value.task?.status == "SUCCEEDED" && answers.size > initialAnswerCount &&
                    answer?.final == true && answer.text.isNotBlank() &&
                    onAllNodes(renderedAnswer(answer.text)).fetchSemanticsNodes().isNotEmpty()
            }
            val finalAnswer = chat.state.value.chat.items.filterIsInstance<ChatItem.Assistant>().last().text
            onNodeWithContentDescription("Меню сессии").performClick()
            onNodeWithText("Копировать историю").performClick()
            waitUntil(timeoutMillis = 10_000) { copied.contains(finalAnswer) }
            assertTrue(copied.contains(initialAnswer))
            println("REAL_PROVIDER_UI_OK model=$model markerMatched=${finalAnswer.contains("TASKBRIDGE_UI_FREE_OK")} elapsedMs=${(System.nanoTime() - started) / 1_000_000}")
        } finally {
            graph?.disconnect()
            graph?.scope?.cancel()
            fixture.outputStream.close()
            if (!fixture.waitFor(20, TimeUnit.SECONDS)) {
                fixture.destroy()
                check(fixture.waitFor(5, TimeUnit.SECONDS)) { "fixture did not terminate" }
            }
        }
    }

    private fun renderedAnswer(text: String) = SemanticsMatcher("provider answer rendered") { node ->
        node.config.getOrNull(SemanticsProperties.Text)?.any {
            it.text.replace("\u200B", "").contains(text)
        } == true
    }

    private class Memory : KeyValueStore, SecretStore {
        private val values = ConcurrentHashMap<String, String>()
        override fun get(key: String) = values[key]
        override fun put(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
    }
}
