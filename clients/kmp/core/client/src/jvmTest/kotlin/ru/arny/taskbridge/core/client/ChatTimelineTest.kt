package ru.arny.taskbridge.core.client

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import ru.arny.taskbridge.core.client.chat.ToolState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChatTimelineTest {
    private val task = Task(id = "timeline", status = "RUNNING", prompt = "Question")
    private fun events(vararg frames: String) = frames.mapIndexed { index, frame ->
        TaskEvent(taskId = task.id, seq = index + 1L, type = "PI_EVENT", data = buildJsonObject { put("pi", TaskBridgeJson.parseToJsonElement(frame)) })
    }

    @Test
    fun textAndParallelToolsKeepTheirStartPositionsThroughCompletionReplayAndEveryPageCut() {
        val log = events(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"before"}}""",
            """{"type":"tool_execution_start","toolName":"read","toolCallId":"a"}""",
            """{"type":"tool_execution_start","toolName":"bash","toolCallId":"b"}""",
            """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"after"}}""",
            """{"type":"tool_execution_end","toolCallId":"b"}""",
            """{"type":"tool_execution_end","toolCallId":"a"}""",
            """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"beforeafter"}]}}""",
        )
        val live = ChatReducer(task)
        log.forEachIndexed { index, event ->
            live.apply(event)
            val tools = live.snapshot(detailed = true).items.filterIsInstance<ChatItem.Assistant>().flatMap { it.tools }
            if (index >= 3) assertEquals(listOf("a", "b"), tools.map { it.id })
            if (index == 5) assertEquals(listOf(ToolState.RUNNING, ToolState.DONE), tools.map { it.state })
            if (index >= 6) assertTrue(tools.all { it.state == ToolState.DONE }, "finished calls must stop spinning")
        }
        val compact = live.snapshot().items.filterIsInstance<ChatItem.Assistant>().single()
        assertEquals("beforeafter", compact.text, "default answer is a single continuous text")
        assertEquals(listOf("a", "b"), compact.tools.map { it.id })
        assertEquals("assistant-initial", compact.id)
        val items = live.snapshot(detailed = true).items
        val answers = items.filterIsInstance<ChatItem.Assistant>()
        assertEquals(listOf("before", "", "after"), answers.map { it.text })
        assertEquals(listOf(emptyList(), listOf("a", "b"), emptyList()), answers.map { it.tools.map { tool -> tool.id } })
        assertTrue(answers.all { it.canonicalId == "assistant-initial" && it.canonicalText == "beforeafter" })
        assertEquals(1, answers.count { it.segmentActions })
        log.forEach { live.apply(it) }
        assertEquals(items, live.snapshot(detailed = true).items)
        for (cut in 1 until log.size) {
            val tail = ChatReducer(task, seedInitial = false)
            log.drop(cut).forEach { tail.apply(it) }
            tail.prependOlder(task, log.take(cut), reachedStart = true)
            assertEquals(items, tail.snapshot(detailed = true).items, "page cut $cut")
        }
    }

    @Test
    fun finalOrderedContentWithoutDeltasMatchesStreamingReasoningAndText() {
        val log = events(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"why"}}""",
            """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"answer"}}""",
            """{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"why"},{"type":"text","text":"answer"}]}}""",
        )
        val live = ChatReducer(task)
        log.forEach { live.apply(it) }
        val history = ChatReducer(task)
        listOf(log.first(), log.last()).forEach { history.apply(it) }
        assertEquals(live.snapshot(detailed = true).items, history.snapshot(detailed = true).items)
        assertEquals(listOf("why" to "", "" to "answer"), live.snapshot(detailed = true).items.filterIsInstance<ChatItem.Assistant>().map { it.thinking to it.text })
    }
}
