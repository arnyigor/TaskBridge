package ru.arny.taskbridge.ui.chat

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import ru.arny.taskbridge.core.client.chat.ToolState
import kotlin.test.*

class AssistantStreamPhaseTest {
    private val task = Task(id = "phase", status = "RUNNING", prompt = "question")
    private fun event(seq: Long, frame: String) = TaskEvent(taskId = task.id, seq = seq, type = "PI_EVENT",
        data = buildJsonObject { put("pi", TaskBridgeJson.parseToJsonElement(frame)) })
    private fun delta(seq: Long, type: String, text: String = "") = TaskEvent(taskId = task.id, seq = seq, type = "PI_EVENT", data = buildJsonObject {
        put("pi", buildJsonObject {
            put("type", "message_update")
            put("assistantMessageEvent", buildJsonObject { put("type", type); put("delta", text) })
        })
    })
    private fun answer(reducer: ChatReducer) = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().last()

    @Test
    fun generatingToolArgumentsIsNotReportedAsAccumulatedThinkingOrText() {
        for (preceding in listOf("thinking_delta", "text_delta")) {
            val reducer = ChatReducer(task)
            reducer.apply(event(1, """{"type":"message_start","message":{"role":"assistant"}}"""))
            reducer.apply(delta(2, preceding, "accumulated output"))
            for ((index, type) in listOf("toolcall_start", "toolcall_delta", "toolcall_end").withIndex()) {
                reducer.apply(delta(index + 3L, type, "{\"command\":"))
                assertTrue(answer(reducer).generatingToolCall)
                assertEquals("Модель формирует вызов инструмента", assistantStreamPhaseLabel(answer(reducer)))
                assertTrue(answer(reducer).tools.isEmpty(), "generation must not create a running tool card")
            }
        }
    }

    @Test
    fun executionNewMessagesAndRegularOutputClearTheGenerationPhase() {
        val reducer = ChatReducer(task)
        reducer.apply(delta(1, "toolcall_delta", "{")) // also works in a paginated/mid-stream window
        assertTrue(answer(reducer).generatingToolCall)
        reducer.apply(event(2, """{"type":"tool_execution_start","toolCallId":"call","toolName":"bash"}"""))
        assertFalse(answer(reducer).generatingToolCall)
        assertEquals(ToolState.RUNNING, answer(reducer).tools.single().state)
        reducer.apply(delta(3, "toolcall_start"))
        reducer.apply(delta(4, "thinking_delta", "new reasoning"))
        assertEquals("Получаем размышления модели", assistantStreamPhaseLabel(answer(reducer)))
        reducer.apply(delta(5, "toolcall_start"))
        reducer.apply(delta(6, "text_delta", "new text"))
        assertEquals("Получаем ответ модели", assistantStreamPhaseLabel(answer(reducer)))
        reducer.apply(delta(7, "toolcall_start"))
        reducer.apply(event(8, """{"type":"message_start","message":{"role":"assistant"}}"""))
        assertFalse(answer(reducer).generatingToolCall)
    }

    @Test
    fun messageEndAndSettledTurnsNeverKeepAStreamingToolPhase() {
        for (ending in listOf(
            """{"type":"message_end","message":{"role":"assistant","stopReason":"toolUse"}}""",
            """{"type":"message_end","message":{"role":"assistant","stopReason":"aborted"}}""",
            """{"type":"agent_settled"}""",
        )) {
            val reducer = ChatReducer(task)
            reducer.apply(delta(1, "toolcall_start"))
            reducer.apply(event(2, ending))
            assertFalse(answer(reducer).generatingToolCall)
        }
    }

    @Test
    fun replayAndEveryPaginationCutPreserveTheCurrentGenerationPhase() {
        val events = listOf(
            event(1, """{"type":"message_start","message":{"role":"assistant"}}"""),
            delta(2, "thinking_delta", "reasoning"), delta(3, "toolcall_start"), delta(4, "toolcall_delta", "{"),
        )
        val live = ChatReducer(task)
        events.forEach(live::apply)
        for (cut in 1 until events.size) {
            val paged = ChatReducer(task, seedInitial = false)
            events.drop(cut).forEach(paged::apply)
            paged.prependOlder(task, events.take(cut), reachedStart = true)
            assertEquals(live.snapshot(detailed = true).items, paged.snapshot(detailed = true).items, "cut $cut")
            assertTrue(answer(paged).generatingToolCall)
        }
    }
}
