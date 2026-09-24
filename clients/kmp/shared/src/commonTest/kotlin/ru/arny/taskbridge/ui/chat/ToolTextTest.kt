package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.client.chat.ToolCall
import ru.arny.taskbridge.core.client.chat.ToolState
import kotlin.test.Test
import kotlin.test.assertEquals

class ToolTextTest {

    private fun tool(name: String, label: String?) = ToolCall("t", name, label, ToolState.DONE, null)

    @Test
    fun fileToolsShowTheFileNameCommandsTheirFirstLine() {
        assertEquals("ChatScreen.kt", toolTarget(tool("read", "shared/src/ui/ChatScreen.kt")))
        assertEquals("Main.kt", toolTarget(tool("edit", "C:\\proj\\Main.kt")))
        assertEquals("./gradlew test", toolTarget(tool("bash", "./gradlew test\n--info")))
        assertEquals(null, toolTarget(tool("bash", " ")))
    }

    @Test
    fun actionsWordAgreesWithTheNumber() {
        assertEquals(
            listOf("действие", "действия", "действий", "действий", "действие", "действия"),
            listOf(1, 3, 5, 11, 21, 104).map(::actionsWord),
        )
    }
}
