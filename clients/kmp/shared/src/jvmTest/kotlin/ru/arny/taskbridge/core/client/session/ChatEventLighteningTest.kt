package ru.arny.taskbridge.core.client.session

import kotlinx.serialization.json.JsonObject
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

// The events a client keeps (and writes to its chat cache) must stay small: the
// payloads dropped by lightenEvent are what made a phone die with
// OutOfMemoryError. These tests pin the two things that matter — the dropped
// fields really are gone, and the transcript built from them is unchanged.
class ChatEventLighteningTest {
    private val task = Task(id = "t", prompt = "question", status = "RUNNING")

    private fun event(seq: Long, frame: String): TaskEvent = TaskEvent(
        taskId = "t",
        seq = seq,
        type = "PI_EVENT",
        data = TaskBridgeJson.parseToJsonElement("""{"pi":$frame}""") as JsonObject,
    )

    private fun frame(event: TaskEvent): JsonObject = event.piFrame ?: error("no frame")

    @Test
    fun heavyToolResultPayloadsAreDropped() {
        val bash = event(1, """{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"content":[{"type":"text","text":"${"x".repeat(5000)}"}]}}""")
        val light = lightenEvent(bash)
        assertEquals(null, frame(light)["result"])
        assertEquals("c1", frame(light)["toolCallId"]?.toString()?.trim('"'))
        assertEquals("bash", frame(light)["toolName"]?.toString()?.trim('"'))
        assertEquals(true, light.data.size == 1)

        val update = lightenEvent(event(2, """{"type":"tool_execution_update","toolCallId":"c1","toolName":"bash","partialResult":{"content":[{"type":"text","text":"${"y".repeat(5000)}"}]}}"""))
        assertEquals(null, frame(update)["partialResult"])

        // agent_end repeats the whole turn and turn_end repeats the answer: both unused.
        val agentEnd = lightenEvent(event(3, """{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"${"z".repeat(5000)}"}]}]}"""))
        assertEquals(null, frame(agentEnd)["messages"])
        val turnEnd = lightenEvent(event(4, """{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"${"z".repeat(5000)}"}]}}"""))
        assertEquals(null, frame(turnEnd)["message"])

        val toolResult = lightenEvent(event(5, """{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"${"z".repeat(5000)}"}]}}"""))
        assertEquals(null, frame(toolResult)["message"])

        // `write` carries the whole file in args.content; only the label is read.
        val write = lightenEvent(event(6, """{"type":"tool_execution_start","toolCallId":"c2","toolName":"write","args":{"path":"a.kt","content":"${"c".repeat(5000)}"}}"""))
        assertEquals(null, frame(write).obj("args")?.get("content"))
        assertEquals("a.kt", frame(write).obj("args")?.get("path")?.toString()?.trim('"'))
    }

    @Test
    fun whatTheReducerReadsIsKept() {
        // Subagent progress and the assistant's own message are used, not dropped.
        val subagent = lightenEvent(event(1, """{"type":"tool_execution_end","toolCallId":"c1","toolName":"subagent","result":{"content":[{"type":"text","text":"done"}]}}"""))
        assertEquals("subagent", frame(subagent)["toolName"]?.toString()?.trim('"'))
        assertEquals(true, frame(subagent)["result"] != null)

        val assistant = lightenEvent(event(2, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ответ"}]}}"""))
        assertEquals(true, frame(assistant)["message"] != null)

        val user = event(3, """{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"вопрос"}]}}""")
        assertEquals(true, frame(lightenEvent(user))["message"] != null)

        // A non-Pi event is returned untouched: the chat cache is full of them.
        val notify = TaskEvent(taskId = "t", seq = 9, type = "UI_NOTIFY", message = "note")
        assertSame(notify, lightenEvent(notify))
    }

    @Test
    fun transcriptIsTheSameWithAndWithoutLightening() {
        val events = listOf(
            event(1, """{"type":"message_start","message":{"role":"assistant"}}"""),
            event(2, """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"привет"}}"""),
            event(3, """{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls -la"}}"""),
            event(4, """{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"content":[{"type":"text","text":"${"o".repeat(4000)}"}]}}"""),
            event(5, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"готово"}],"stopReason":"stop"}}"""),
            event(6, """{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"готово"}]}}"""),
            event(7, """{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"готово"}]}]}"""),
        )
        fun render(list: List<TaskEvent>): String {
            val reducer = ChatReducer(task)
            for (e in list) reducer.apply(e)
            return reducer.snapshot().items.joinToString("\n") { item ->
                when (item) {
                    is ChatItem.User -> "user:${item.text}"
                    is ChatItem.Note -> "note:${item.text}"
                    is ChatItem.Assistant -> "assistant:${item.text}|${item.status}|${item.tools.joinToString(",") { "${it.name}:${it.state}:${it.label}" }}"
                }
            }
        }
        val original = render(events)
        val lightened = render(events.map(::lightenEvent))
        assertEquals(original, lightened)
        // The transcript the reducer builds: the answer text it settled on and the tool row.
        assertEquals("assistant:готово|RUNNING|bash:DONE:ls -la", original.lines().last())
    }
}

private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
