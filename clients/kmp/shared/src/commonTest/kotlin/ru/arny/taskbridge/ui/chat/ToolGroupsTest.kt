package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.client.chat.ToolCall
import ru.arny.taskbridge.core.client.chat.ToolState
import kotlin.test.Test
import kotlin.test.assertEquals

class ToolGroupsTest {

    private var n = 0
    private fun call(name: String, label: String, state: ToolState = ToolState.DONE) = ToolCall("t${n++}", name, label, state, null)

    @Test
    fun aCodingTurnReadsAsExploreChangeRun() {
        val tools = listOf(
            call("read", "src/ChatScreen.kt"), call("grep", "reconnect"), call("read", "src/Api.kt"),
            call("edit", "src/Api.kt"), call("read", "src/Api.kt"), call("edit", "src/Store.kt"),
            call("bash", "./gradlew test"), call("git_ro", "status"),
        )
        val groups = groupTools(tools)
        assertEquals(listOf(ToolKind.EXPLORE, ToolKind.CHANGE, ToolKind.RUN), groups.map { it.kind })
        // Files read: ChatScreen.kt and Api.kt (twice); the grep and git status are not files.
        assertEquals("Изучил код · 2 файла", groupSummary(groups[0]))
        assertEquals("Изменил 2 файла", groupSummary(groups[1]))
        assertEquals("Выполнил 1 команду", groupSummary(groups[2]))
    }

    @Test
    fun aRunningGroupSpeaksInThePresentAndUnknownToolsKeepTheirName() {
        val running = groupTools(listOf(call("bash", "a"), call("bash", "b", ToolState.RUNNING))).single()
        assertEquals("Выполняет 2 команды", groupSummary(running))
        val mcp = groupTools(listOf(call("mcp_search", "x"), call("mcp_search", "y"), call("other", "z")))
        assertEquals(listOf("mcp_search · 2 вызова", "other · 1 вызов"), mcp.map(::groupSummary))
    }
}
