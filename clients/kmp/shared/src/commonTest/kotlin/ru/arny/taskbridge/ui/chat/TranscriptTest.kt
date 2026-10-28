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

    @Test
    fun compactSegmentsCopyAndExportInVisualOrderWithoutRepeatingCanonicalText() {
        val original = items()[1] as ChatItem.Assistant
        val feed = listOf(
            original.copy(text = "До", canonicalText = "До\n\nПосле", segmentActions = false),
            ChatItem.Note("compact", "Сводка"),
            original.copy(id = "assistant-1-segment-3", text = "После", canonicalText = "До\n\nПосле"),
        )
        assertEquals("До\n\n— Сводка —\n\nПосле", selectedMessagesText(feed, feed.map { it.id }.toSet()))
        val transcript = chatTranscript(feed, null) { _, _ -> "" }
        assertEquals("## Агент\nДо\n\n— Сводка —\n\n## Агент\nПосле\n", transcript)
    }

    private fun items() = listOf(
        ChatItem.User("u1", "Запусти тесты", emptyList(), "10:00", false, null, "prompt", "user-1"),
        ChatItem.Assistant(
            id = "assistant-1", text = "Тесты прошли.", thinking = "", tools = emptyList(),
            active = false, status = "SUCCEEDED", error = null, final = true, at = "10:00", endedAt = "10:01",
            partial = false, superseded = false, stopReason = null, variants = null,
        ),
        ChatItem.Note("n1", "Контекст сжат"),
        ChatItem.User("u2", "Спасибо", emptyList(), "10:02", false, null, "prompt", "user-2"),
    )

    /**
     * Выбор нескольких сообщений (как «Copy» в ChatGPT): порядок задаёт лента, а не
     * порядок нажатий — иначе копия зависела бы от того, что нажали первым.
     */
    @Test
    fun selectedMessagesFollowTheFeedOrderNotTheTapOrder() {
        val feed = items()
        assertEquals(
            "Запусти тесты\n\nТесты прошли.\n\nСпасибо",
            selectedMessagesText(feed, setOf("u2", "assistant-1", "u1")),
        )
    }

    /**
     * Текст выбранных — ровно то же, что даёт кнопка «Копировать» у сообщения, плюс
     * заметка в своём виде (у неё одиночной кнопки нет). Поэтому скопировать одно и
     * скопировать несколько не могут разойтись.
     */
    @Test
    fun selectedMessagesUseTheSameTextAsTheSingleCopy() {
        val feed = items()
        assertEquals("Запусти тесты", feed[0].copyText())
        assertEquals("— Контекст сжат —", feed[2].copyText())
        assertEquals(
            "Тесты прошли.\n\n— Контекст сжат —\n\nСпасибо",
            selectedMessagesText(feed, setOf("assistant-1", "n1", "u2")),
        )
    }

    /**
     * Список и его соединение — из одного источника: счётчик «скопировано сообщений»
     * берёт размер списка, поэтому в нём не может оказаться то, чего нет в буфере.
     */
    @Test
    fun theSelectedTextsAreListedWithoutBlanks() {
        val feed = items()
        assertEquals(listOf("Запусти тесты", "Тесты прошли."), selectedMessages(feed, setOf("u1", "assistant-1")))
        assertEquals(emptyList(), selectedMessages(feed, emptySet()))
    }

    @Test
    fun anEmptySelectionGivesAnEmptyText() {
        assertEquals("", selectedMessagesText(items(), emptySet()))
        // Чужой id (сообщение ушло из окна истории) ничего не добавляет.
        assertEquals("", selectedMessagesText(items(), setOf("нет-такого")))
    }

    /**
     * Ход без текста (из одних вызовов инструментов) не оставляет в буфере пустых
     * абзацев: иначе между сообщениями оказывались бы двойные пустые строки.
     */
    @Test
    fun aMessageWithoutTextLeavesNoBlankParagraph() {
        val feed = listOf(
            ChatItem.User("u1", "Сделай", emptyList(), null, false, null, null, "user-1"),
            ChatItem.Assistant(
                id = "assistant-1", text = "   ", thinking = "", tools = emptyList(),
                active = false, status = "SUCCEEDED", error = null, final = true, at = null, endedAt = null,
                partial = false, superseded = false, stopReason = null, variants = null,
            ),
            ChatItem.Note("n1", "Готово"),
        )
        assertEquals("Сделай\n\n— Готово —", selectedMessagesText(feed, setOf("u1", "assistant-1", "n1")))
    }
}
