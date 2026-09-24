package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.FileRef
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ToolCall
import ru.arny.taskbridge.core.client.chat.ToolState
import kotlin.test.Test
import kotlin.test.assertEquals

class TranscriptTest {

    @Test
    fun transcriptKeepsTheTalkAndOneLinePerTool() {
        val items = listOf(
            ChatItem.User("u1", "Запусти тесты", listOf(FileRef(name = "log.txt")), "10:00", false, null, "prompt", "user-1"),
            ChatItem.Assistant(
                id = "assistant-1", text = "Тесты прошли.", thinking = "скрыто",
                tools = listOf(ToolCall("t1", "bash", "npm test\n--verbose", ToolState.DONE, null), ToolCall("t2", "read", "src/a.kt", ToolState.ERROR, null)),
                active = false, status = "SUCCEEDED", error = "timeout", final = true, at = "10:00", endedAt = "10:01",
                partial = false, superseded = false, stopReason = null, variants = null,
            ),
            ChatItem.Note("n1", "Контекст сжат"),
        )
        val text = chatTranscript(items, "Сессия") { start, end -> listOfNotNull(start, end).joinToString("–") }
        assertEquals(
            """
            # Сессия

            ## Вы · 10:00
            Запусти тесты
            Файлы: log.txt

            ## Агент · 10:00–10:01
            > Выполнил: npm test
            > Прочитал: a.kt — ошибка

            Тесты прошли.
            Ошибка: timeout

            — Контекст сжат —
            """.trimIndent() + "\n",
            text,
        )
    }
}
