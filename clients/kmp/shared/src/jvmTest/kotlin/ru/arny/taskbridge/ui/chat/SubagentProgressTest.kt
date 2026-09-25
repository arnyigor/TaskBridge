package ru.arny.taskbridge.ui.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import ru.arny.taskbridge.core.client.chat.ToolState
import ru.arny.taskbridge.core.client.chat.subagentProgress
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SubagentProgressTest {
    private fun obj(value: String) = Json.parseToJsonElement(value).jsonObject
    private val result = """{"details":{"results":[{"agent":"scout","task":"Проверить проект","exitCode":0,"messages":[
        {"role":"system","content":"PRIVATE SYSTEM"},
        {"role":"assistant","content":[{"type":"thinking","thinking":"PRIVATE THINKING"},{"type":"toolCall","name":"read"}]}]}]}}"""

    @Test
    fun snapshotsReplaceAndLateUpdatesCannotReviveCompletedTools() {
        val reducer = ChatReducer(Task(id = "a"))
        var seq = 0L
        fun frame(value: String) { reducer.apply(TaskEvent(seq = ++seq, type = "PI_EVENT", data = JsonObject(mapOf("pi" to obj(value))))) }
        fun tool() = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().flatMap { it.tools }.single()
        frame("""{"type":"tool_execution_start","toolCallId":"child","toolName":"subagent","args":{"agent":"scout","task":"Проверить проект"}}""")
        assertEquals("scout · ожидание обновления · Проверить проект", tool().progress)
        repeat(2) { frame("""{"type":"tool_execution_update","toolCallId":"child","partialResult":$result}""") }
        assertEquals("scout · вызов: read · Проверить проект", tool().progress)
        assertEquals(ToolState.RUNNING, tool().state)
        frame("""{"type":"tool_execution_update","toolCallId":"child","partialResult":{}}""")
        frame("""{"type":"tool_execution_update","toolCallId":"unknown","partialResult":$result}""")
        assertEquals("scout · вызов: read · Проверить проект", tool().progress)
        frame("""{"type":"tool_execution_end","toolCallId":"child","toolName":"subagent","isError":true}""")
        frame("""{"type":"tool_execution_update","toolCallId":"child","partialResult":${result.replace("read", "write")}}""")
        assertEquals(ToolState.ERROR, tool().state)
        assertEquals("scout · вызов: read · Проверить проект", tool().progress)
    }

    @Test
    fun parallelAndChainAreBoundedAndToolOutputIsNotDisplayed() {
        val args = obj("""{"tasks":[{"agent":"a","task":"one"},{"agent":"b","task":"two"}]}""")
        assertEquals(2, subagentProgress(null, args)!!.lines().size)
        assertEquals(subagentProgress(null, args), subagentProgress(null, obj(args.toString().replace("tasks", "chain"))))
        val received = obj("""{"details":{"results":[{"agent":"scout","messages":[{"role":"toolResult","toolName":"read","content":[{"type":"text","text":"PRIVATE FILE"}]}]}]}}""")
        assertEquals("scout · получен результат: read · действий: 1", subagentProgress(received, null))
        val withArgs = obj("""{"details":{"results":[{"agent":"scout","messages":[{"role":"assistant","content":[{"type":"toolCall","name":"bash","arguments":{"command":"npm test"}}]}]}]}}""")
        assertEquals("scout · вызов: bash npm test", subagentProgress(withArgs, null), "the call says what it is about")
        val long = obj("""{"agent":"scout","task":"${"a".repeat(10000)}"}""")
        assertTrue(subagentProgress(null, long)!!.length < 400)
    }
}
