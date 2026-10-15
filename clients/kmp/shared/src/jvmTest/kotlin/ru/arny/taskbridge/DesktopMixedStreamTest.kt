package ru.arny.taskbridge

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.v2.runComposeUiTest
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ru.arny.taskbridge.core.api.CreateTaskRequest
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.session.NoopChatPersistence
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.core.client.settings.SecretStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.platform.PlatformServices
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class DesktopMixedStreamTest {
    @Test
    fun inputSurvivesLargeReasoningAndMixedToolStreaming() = runComposeUiTest {
        val fixture = ProcessBuilder("node", "tests/fixture-server.mjs")
            .directory(File(System.getProperty("taskbridge.repo")))
            .redirectError(ProcessBuilder.Redirect.INHERIT).start()
        val output = fixture.inputStream.bufferedReader()
        val input = fixture.outputStream.bufferedWriter()
        fun line() = CompletableFuture.supplyAsync { output.readLine() }.get(30, TimeUnit.SECONDS)
            ?: error("fixture output closed")
        var graph: AppGraph? = null
        try {
            val base = TaskBridgeJson.parseToJsonElement(line()).jsonObject.getValue("base").jsonPrimitive.content
            val memory = Memory().apply { put("serverUrl", base) }
            var copied = ""
            val platform = object : PlatformServices by DesktopPlatformServices(store = memory) {
                override val secrets: SecretStore = memory
                override fun chatPersistence(serverUrl: String) = NoopChatPersistence
                override fun copyText(text: String) { copied = text }
            }
            val app = AppGraph(platform)
            graph = app
            val connection = checkNotNull(app.connection)
            val task = runBlocking { connection.api.createTask(CreateTaskRequest(projectId = "fixture", prompt = "fault-heavy-mixed gated")) }
            val chat = connection.chat(task.id)
            setContent { App(app, openTaskId = task.id) }
            waitUntil(timeoutMillis = 30_000) {
                chat.state.value.chat.items.filterIsInstance<ChatItem.Assistant>().lastOrNull()?.thinking?.length ?: 0 > 200_000
            }
            onNode(hasSetTextAction()).performTextInput("draft during heavy stream")
            assertEquals("RUNNING", chat.state.value.task?.status, "input must happen before the gated stream completes")
            input.write("release-heavy\n")
            input.flush()
            assertEquals("heavy-released", line())
            waitUntil(timeoutMillis = 30_000) { chat.state.value.task?.status == "SUCCEEDED" }
            val answer = chat.state.value.chat.items.filterIsInstance<ChatItem.Assistant>().last()
            val block = "  \n" + "Разбор кода, reasoning и bash-команд.\n".repeat(7000) + "\n  "
            val expected = block.repeat(3)
            assertEquals(expected.length, answer.thinking.length)
            assertTrue(answer.tools.size >= 120)
            assertTrue(answer.tools.map { it.name }.toSet().containsAll(setOf("bash", "read", "edit", "write")))
            assertEquals("HEAVY_MIXED_STREAM_OK", answer.text)
            onNode(hasSetTextAction()).assertTextContains("draft during heavy stream")
            onNodeWithText("Размышления · ${expected.length} симв.").performScrollTo().performClick()
            onNodeWithContentDescription("Копировать размышления").performScrollTo().performClick()
            fun hash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).toList()
            assertEquals(hash(expected), hash(copied))
        } finally {
            graph?.disconnect()
            graph?.scope?.cancel()
            input.close()
            if (!fixture.waitFor(15, TimeUnit.SECONDS)) {
                fixture.destroy()
                check(fixture.waitFor(5, TimeUnit.SECONDS)) { "fixture did not terminate" }
            }
        }
    }

    private class Memory : KeyValueStore, SecretStore {
        private val values = ConcurrentHashMap<String, String>()
        override fun get(key: String) = values[key]
        override fun put(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
    }
}
