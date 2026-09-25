package ru.arny.taskbridge.core.client

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import ru.arny.taskbridge.core.client.chat.ToolState
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// The Kotlin reducer must build exactly the turns web/chat-state.mjs builds
// from the same events. The golden files come from real sessions on fake-pi.
class ChatReducerGoldenTest {
    @Serializable
    data class GoldenTool(val id: String, val name: String, val state: String)

    @Serializable
    data class GoldenTurn(
        val id: String,
        val role: String,
        val text: String,
        val thinking: String,
        val status: String,
        val active: Boolean,
        val final: Boolean,
        val error: String? = null,
        val tools: List<GoldenTool> = emptyList(),
    )

    @Serializable
    data class Golden(val task: Task, val events: List<TaskEvent>, val expected: List<GoldenTurn>)

    private val dir = File(System.getProperty("taskbridge.chatFixtures"))

    private fun actual(golden: Golden): List<GoldenTurn> {
        val reducer = ChatReducer(golden.task)
        for (event in golden.events) reducer.apply(event)
        reducer.syncTask(golden.task)
        return reducer.snapshot().items.map { item ->
            when (item) {
                is ChatItem.User -> GoldenTurn(item.id, "user", item.text, "", "", false, false)
                is ChatItem.Note -> GoldenTurn(item.id, "note", item.text, "", "", false, false)
                is ChatItem.Assistant -> GoldenTurn(
                    item.id, "assistant", item.text, item.thinking, item.status, item.active, item.final, item.error,
                    item.tools.map { GoldenTool(it.id, it.name, when (it.state) { ToolState.RUNNING -> "run"; ToolState.DONE -> "done"; ToolState.ERROR -> "error"; ToolState.INTERRUPTED -> "interrupted" }) },
                )
            }
        }
    }

    // JS keeps `final` undefined on user turns and notes; compare what matters there.
    private fun normalize(turns: List<GoldenTurn>) = turns.map { if (it.role == "assistant") it else it.copy(final = false, active = false, status = "") }

    @Test
    fun everyScenarioMatchesTheWebReducer() {
        val files = dir.listFiles { file -> file.name.endsWith(".json") }.orEmpty().sortedBy { it.name }
        assertTrue(files.size >= 10, "golden files present: ${files.map { it.name }}")
        for (file in files) {
            val golden = TaskBridgeJson.decodeFromString(Golden.serializer(), file.readText())
            assertEquals(normalize(golden.expected), normalize(actual(golden)), "scenario ${file.nameWithoutExtension}")
        }
    }

    @Test
    fun replayingTheSameEventsTwiceChangesNothing() {
        val golden = TaskBridgeJson.decodeFromString(Golden.serializer(), File(dir, "follow-up.json").readText())
        val reducer = ChatReducer(golden.task)
        golden.events.forEach { reducer.apply(it) }
        val once = reducer.snapshot().items
        golden.events.forEach { assertEquals(false, reducer.apply(it), "seq ${it.seq} is a duplicate") }
        assertEquals(once, reducer.snapshot().items)
    }

    @Test
    fun anOptimisticMessageIsReconciledByItsCommandId() {
        val golden = TaskBridgeJson.decodeFromString(Golden.serializer(), File(dir, "follow-up.json").readText())
        val reducer = ChatReducer(golden.task)
        val (before, after) = golden.events.partition { event -> golden.events.none { it.type == "USER_MESSAGE" && it.seq <= event.seq } }
        before.forEach { reducer.apply(it) }
        reducer.addOptimistic("chat-f-1", "второй вопрос")
        val pending = reducer.snapshot().items.filterIsInstance<ChatItem.User>().last()
        assertTrue(pending.pending)
        after.forEach { reducer.apply(it) }
        reducer.syncTask(golden.task)
        val users = reducer.snapshot().items.filterIsInstance<ChatItem.User>()
        assertEquals(2, users.size, "no duplicate bubble")
        assertEquals(false, users.last().pending)
        assertEquals("android-test", users.last().clientId)
        assertEquals(normalize(golden.expected), normalize(actual(golden)))
    }

    @Test
    fun aTailWindowOpeningMidTurnIsShownNotEmpty() {
        val golden = TaskBridgeJson.decodeFromString(Golden.serializer(), File(dir, "follow-up.json").readText())
        // The first answer's events without its prompt: what a window cut mid-turn gets.
        val window = golden.events.takeWhile { it.type != "USER_MESSAGE" }
        val reducer = ChatReducer(golden.task, seedInitial = false)
        window.forEach { reducer.apply(it) }
        reducer.revealWindowStart(window.first().seq)
        reducer.syncTask(golden.task, initial = true)
        val snapshot = reducer.snapshot()
        val partial = snapshot.items.single() as ChatItem.Assistant
        assertTrue(partial.partial && partial.text.isNotBlank(), "partial turn with the answer text: $partial")
        assertEquals(null, snapshot.newestAnswerId, "a partial turn is not regenerated or edited")
    }

    @Test
    fun outputFilesBelongToTheAnswerThatMadeThem() {
        val golden = TaskBridgeJson.decodeFromString(Golden.serializer(), File(dir, "follow-up.json").readText())
        val reducer = ChatReducer(golden.task)
        golden.events.forEach { reducer.apply(it) }
        val files = TaskBridgeJson.parseToJsonElement("""{"files":[{"id":"f1","name":"result.png","path":"out/result.png","size":120,"mimeType":"image/png"}]}""") as JsonObject
        reducer.apply(TaskEvent(taskId = golden.task.id, seq = golden.events.maxOf { it.seq } + 1, type = "OUTPUT_FILES", data = files))
        val answer = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().last()
        assertEquals(listOf("result.png"), answer.files.map { it.name })
        assertEquals("f1", answer.files.single().id)
    }

    @Test
    fun humanizedProviderErrors() {
        assertEquals(
            "The following parameters are not supported for this model: tools (UNSUPPORTED_OPENAI_PARAMS)",
            humanizeError("400: {\"code\":\"422\",\"error_type\":\"UNSUPPORTED_OPENAI_PARAMS\",\"message\":\"The following parameters are not supported for this model: tools\",\"param\":\"tools\"}"),
        )
        assertEquals("plain text", humanizeError("  plain   text "))
    }
}
