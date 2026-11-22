package ru.arny.taskbridge

import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ru.arny.taskbridge.core.api.CreateTaskRequest
import ru.arny.taskbridge.core.api.MessageRequest
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.session.NoopChatPersistence
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.core.client.settings.SecretStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.platform.PlatformServices

/**
 * S2-01 RED/GREEN: losing window focus must not tear down the desktop SSE.
 *
 * The incident: the server restarted while Desktop was unfocused. The client had
 * already replaced its visible stream with `null` because `inForeground` was
 * false, so nothing reconnected until the single-instance `show` command. After
 * the fix, focus is notification state only; `maintainsConnection` keeps one SSE
 * alive while the window is merely unfocused.
 */
class DesktopUnfocusedReconnectTest {
    @Test
    fun anUnfocusedDesktopReconnectsAfterServerRestart() = runBlocking<Unit> {
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
            val desktop = DesktopPlatformServices(store = memory)
            val platform = object : PlatformServices by desktop {
                override val secrets: SecretStore = memory
                override fun chatPersistence(serverUrl: String) = NoopChatPersistence
            }
            val app = AppGraph(platform)
            graph = app
            val connection = checkNotNull(app.connection)
            val task = connection.api.createTask(CreateTaskRequest(projectId = "fixture", prompt = "Прочитай example.txt"))
            val chat = connection.chat(task.id)
            connection.showChat(task.id)
            withTimeout(30_000) { while (chat.state.value.link != ru.arny.taskbridge.core.client.session.LinkState.Live) delay(50) }

            // The window loses focus (user switched to another app). This used to
            // clear the stream target and stop SSE for the rest of the outage.
            desktop.foreground = false
            connection.appVisibilityChanged()
            delay(300)
            assertEquals(true, platform.maintainsConnection, "desktop must keep its connection while merely unfocused")

            val bootBefore = connection.api.info().bootId
            input.write("restart\n")
            input.flush()
            assertEquals("restarted", line())
            assertNotEquals(bootBefore, connection.api.info().bootId, "the fixture did not restart")

            // Generate a real event through the API. It can only reach the chat
            // through a reconnected SSE stream; no show/wakeUp/reconnectNow call.
            connection.api.message(task.id, MessageRequest(text = "after restart", commandId = "after-restart"))
            withTimeout(30_000) {
                while (chat.state.value.chat.items.filterIsInstance<ChatItem.User>().none { it.text == "after restart" }) delay(50)
            }
            assertEquals(true, chat.state.value.link == ru.arny.taskbridge.core.client.session.LinkState.Live)
        } finally {
            graph?.connection?.close()
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
