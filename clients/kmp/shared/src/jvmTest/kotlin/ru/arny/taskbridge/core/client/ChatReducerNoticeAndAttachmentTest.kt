package ru.arny.taskbridge.core.client

import kotlinx.serialization.json.JsonObject
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChatReducerNoticeAndAttachmentTest {
    private val task = Task(id = "t", prompt = "question", status = "RUNNING")

    private fun event(seq: Long, type: String, data: String) = TaskEvent(
        taskId = "t",
        seq = seq,
        type = type,
        data = TaskBridgeJson.parseToJsonElement(data) as JsonObject,
    )

    @Test
    fun mcpServerNoticeMovesOutOfTimelineButOtherNotifyStaysVisible() {
        val reducer = ChatReducer(task)
        reducer.apply(TaskEvent(taskId = "t", seq = 1, type = "UI_NOTIFY", message = "MCP: servers connected: mcpServer"))

        assertEquals("MCP: servers connected: mcpServer", reducer.snapshot().mcpNotice)
        assertTrue(reducer.snapshot().items.none { it is ChatItem.Note && it.text.startsWith("MCP:") })

        reducer.apply(TaskEvent(taskId = "t", seq = 2, type = "UI_NOTIFY", message = "slash command output"))
        val note = reducer.snapshot().items.filterIsInstance<ChatItem.Note>().single()
        assertEquals("slash command output", note.text)
    }

    @Test
    fun phoneAttachmentMarkerIsNotShownAsMessageText() {
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(event(1, "USER_MESSAGE", """{"text":"смотри\n\nAdditional files from the phone are in .taskbridge-input/:\n- .taskbridge-input/f7fd6aef2797/67d0e2c2-ff96-4f54-8b36-c5fb57f7b84c/Screenshot_20260928-200642.jpg"}"""))

        val user = reducer.snapshot().items.filterIsInstance<ChatItem.User>().single()
        assertEquals("смотри", user.text)
        assertEquals(
            listOf(".taskbridge-input/f7fd6aef2797/67d0e2c2-ff96-4f54-8b36-c5fb57f7b84c/Screenshot_20260928-200642.jpg"),
            user.files.map { it.name },
        )
    }
}
