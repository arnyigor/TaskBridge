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
    fun mcpServerNoticeWithToolCountMovesOutOfTimeline() {
        val reducer = ChatReducer(task, seedInitial = false)
        // The wording pi-mcp-adapter actually emits on startup, with and without a failed server.
        reducer.apply(TaskEvent(taskId = "t", seq = 1, type = "UI_NOTIFY", message = "MCP: 4 servers connected (48 tools)"))
        reducer.apply(TaskEvent(taskId = "t", seq = 2, type = "UI_NOTIFY", message = "MCP: 2/4 servers connected (35 tools)"))

        assertEquals("MCP: 2/4 servers connected (35 tools)", reducer.snapshot().mcpNotice)
        assertTrue(reducer.snapshot().items.none { it is ChatItem.Note && it.text.startsWith("MCP:") })
    }

    @Test
    fun mcpWarningsStayInTimeline() {
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(TaskEvent(taskId = "t", seq = 1, type = "UI_NOTIFY", message = "MCP: artemis requires OAuth. Run /mcp-auth artemis first."))

        assertEquals(null, reducer.snapshot().mcpNotice)
        assertEquals("MCP: artemis requires OAuth. Run /mcp-auth artemis first.", reducer.snapshot().items.filterIsInstance<ChatItem.Note>().single().text)
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

    @Test
    fun smartCompactionStageNotifiesStayOutOfTimeline() {
        val reducer = ChatReducer(task, seedInitial = false)
        // Verbatim shapes from a live session (2026-09-30): per-stage notifies
        // arrive as one note per chunk — a wall the chat must not show; the
        // stage belongs in the diagnostics (task.current, setStatus frames).
        reducer.apply(TaskEvent(taskId = "t", seq = 1, type = "UI_NOTIFY", message = "Smart compaction: chunk 13/13."))
        reducer.apply(TaskEvent(taskId = "t", seq = 2, type = "UI_NOTIFY", message = "Smart compaction: merging 3 partials into 2 (level 2)."))
        reducer.apply(TaskEvent(taskId = "t", seq = 3, type = "UI_NOTIFY", message = "Smart compaction: final merge."))
        reducer.apply(TaskEvent(taskId = "t", seq = 4, type = "UI_NOTIFY", message = "Smart compaction: prompt (~174 863 tok) exceeds the input budget; using map-reduce."))
        assertTrue(reducer.snapshot().items.filterIsInstance<ChatItem.Note>().isEmpty())

        // A genuine failure notice is not a stage: it stays in the timeline.
        reducer.apply(TaskEvent(taskId = "t", seq = 5, type = "UI_NOTIFY", message = "Smart compaction failed safely and was cancelled: Connection error."))
        assertEquals(
            "Smart compaction failed safely and was cancelled: Connection error.",
            reducer.snapshot().items.filterIsInstance<ChatItem.Note>().single().text,
        )
    }

    @Test
    fun mcpDirectToolRefreshCountersMoveOutOfTimeline() {
        val reducer = ChatReducer(task, seedInitial = false)
        // Verbatim shape from pi-mcp-adapter (index.ts, syncToolSurface): the adapter
        // reports every tool-surface rebuild as a counter line. As a note it hung at the
        // bottom of the chat and never went away — it is session state, not a message.
        reducer.apply(TaskEvent(taskId = "t", seq = 1, type = "UI_NOTIFY", message = "MCP: direct tools refreshed (+10, ~0, -0)"))

        assertEquals("MCP: direct tools refreshed (+10, ~0, -0)", reducer.snapshot().mcpNotice)
        assertTrue(reducer.snapshot().items.filterIsInstance<ChatItem.Note>().isEmpty())
    }

    @Test
    fun mcpReconnectNoticeStaysInTimeline() {
        val reducer = ChatReducer(task, seedInitial = false)
        // The boundary of the rule above: a reconnect names a server and its outcome,
        // so it stays where the operator can read it.
        reducer.apply(TaskEvent(taskId = "t", seq = 1, type = "UI_NOTIFY", message = "MCP: Reconnected to artemis (12 tools, 0 resources)"))

        assertEquals(null, reducer.snapshot().mcpNotice)
        assertEquals(
            "MCP: Reconnected to artemis (12 tools, 0 resources)",
            reducer.snapshot().items.filterIsInstance<ChatItem.Note>().single().text,
        )
    }
}
