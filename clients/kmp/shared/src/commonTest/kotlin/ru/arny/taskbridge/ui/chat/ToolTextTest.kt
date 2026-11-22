package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import ru.arny.taskbridge.core.client.chat.ToolCall
import ru.arny.taskbridge.core.client.chat.ToolState

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

    @Test
    fun aBrokenToolNameStaysOnOneShortLine() {
        // Модель прислала команду вместо имени инструмента (скриншот 2026-11-16):
        // строка не должна вырастать в экран по вертикали.
        val broken = "Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait(\"{ESC}\")</arg_value>"
        val verb = toolVerb(broken, true)
        assertTrue(!verb.contains('\n'), "имя инструмента не должно быть многострочным")
        assertTrue(verb.length <= 41, "имя инструмента должно быть обрезано: $verb")
        assertEquals(41, toolVerb("x".repeat(200), false).length) // 40 символов + «…»
        assertEquals("Выполнил", toolVerb("bash", false))
    }
}
