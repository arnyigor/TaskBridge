package ru.arny.taskbridge.ui.chat

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ToolCall
import ru.arny.taskbridge.core.client.chat.ToolState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Поиск по сессии без устройства: что считается совпадением, в каком порядке идут
 * переходы и что именно подсвечивается в тексте. Лента перевёрнута, поэтому
 * отдельно проверяется перевод позиции сообщения в её индекс.
 */
class ChatSearchTest {

    private fun user(i: Int, text: String) =
        ChatItem.User("u$i", text, emptyList(), null, pending = false, clientId = null, mode = "prompt", turnId = "user-$i")

    private fun answer(i: Int, text: String) = ChatItem.Assistant(
        "a$i", text, "", emptyList(), active = false, status = "SUCCEEDED", error = null, final = true,
        at = null, endedAt = null, partial = false, superseded = false, stopReason = null, variants = null,
    )

    @Test
    fun matchesIgnoreCaseAndDoNotOverlap() {
        assertEquals(listOf(0..5, 9..14), matchRanges("Ошибка и ошибка", "ошибка"))
        assertEquals(listOf(0..0, 2..2, 4..4), matchRanges("а а а", "а"))
        assertEquals(emptyList(), matchRanges("текст", ""))
        assertEquals(emptyList(), matchRanges("т", "текст"))
    }

    @Test
    fun needleLongerThanTextIsNotAMatch() {
        assertEquals(emptyList(), matchRanges("abc", "abcd"))
    }

    @Test
    fun hitsGoFromOldToNewAndSkipAnswersWithoutThem() {
        val items = listOf(user(1, "Найди ошибку"), answer(2, "Всё хорошо"), user(3, "Ошибка в логе"))
        val hits = chatSearchHits(items, "ошибк")
        assertEquals(listOf("u1", "u3"), hits.map { it.itemId })
        assertEquals(listOf(6..10, 0..4), hits.map { it.range })
    }

    /**
     * Переход идёт по сообщениям: два вхождения в одном ответе — одна находка.
     * Пере-hits по вхождениям давали стрелки, которые меняли только счётчик.
     */
    @Test
    fun oneHitPerMessageWithTheFirstOccurrenceAndItsCount() {
        val items = listOf(answer(1, "ошибка раз, ошибка два"))
        val hit = chatSearchHits(items, "ошибка").single()
        assertEquals(2, hit.occurrences, "оба вхождения остаются видны в сообщении")
        assertEquals(0..5, hit.range, "переход ведёт к первому вхождению")
    }

    @Test
    fun blankQueryFindsNothing() {
        assertEquals(emptyList(), chatSearchHits(listOf(user(1, "текст")), "   "))
    }

    /** Сознательно: размышления поиском не считаются — они свёрнуты и не читаются. */
    @Test
    fun thinkingIsNotSearched() {
        val items = listOf(answer(1, "Готово").copy(thinking = "ошибка в размышлениях"))
        assertEquals(emptyList(), chatSearchHits(items, "ошибка"))
    }

    /**
     * Команда видна в строке инструмента, поэтому ищется — это жалоба оператора
     * 2026-10-30 «не работает в командах». Полного вывода в клиенте нет.
     */
    @Test
    fun toolCommandAndPathAreSearched() {
        val tool = ToolCall("t1", "bash", "npm test --filter chat", ToolState.DONE, path = null)
        val fileTool = ToolCall("t2", "read", "src/ChatScreen.kt", ToolState.DONE, path = "src/ChatScreen.kt")
        val items = listOf(answer(1, "Готово").copy(tools = listOf(tool, fileTool)))
        val hits = chatSearchHits(items, "npm test")
        assertEquals(1, hits.size)
        assertTrue(hits.single().inTool)
        assertEquals(1, chatSearchHits(items, "chatscreen").size)
        // Совпадение в команде встаёт на начало сообщения: строки инструментов — над текстом.
        assertEquals(SearchTarget(0), searchTarget(items, hits.single()))
    }

    @Test
    fun targetUsesTheOrderOfTheReversedFeed() {
        val items = listOf(user(1, "а"), answer(2, "аб"), user(3, "ав"))
        // Самое старое сообщение — последний индекс перевёрнутой ленты.
        assertEquals(SearchTarget(2), searchTarget(items, ChatSearchHit("u1", 0..0)))
        assertEquals(SearchTarget(0), searchTarget(items, ChatSearchHit("u3", 0..0)))
        assertNull(searchTarget(items, ChatSearchHit("нет-такого", 0..0)))
    }

    /**
     * Место находки внутри сообщения лента не считает: высота элемента — это ещё
     * размышления и строки инструментов, и доля текста к ней не сводится (реальный
     * случай 2026-10-30: «2 из 2», а подсветки на экране нет). Прокрутку до блока
     * делает сам блок (Modifier.searchBringIntoView).
     */
    @Test
    fun targetNamesTheMessageOnly() {
        val items = listOf(answer(1, "x".repeat(50) + "иголка"))
        assertEquals(SearchTarget(0), searchTarget(items, ChatSearchHit("a1", 50..55)))
    }

    @Test
    fun markSearchPutsABackgroundOverEveryMatch() {
        val source = AnnotatedString("Ошибка в логе, ошибка в тесте")
        val marked = source.markSearch("ошибка", Color.Red)
        assertEquals(2, marked.spanStyles.size)
        assertEquals(listOf(0 to 6, 15 to 21), marked.spanStyles.map { it.start to it.end })
        assertTrue(marked.spanStyles.all { it.item.background == Color.Red })
        assertEquals("Ошибка в логе, ошибка в тесте", marked.text)
    }

    @Test
    fun markSearchKeepsTheFormattingOfTheAnswer() {
        val bold = SpanStyle(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
        val source = AnnotatedString("важное слово", listOf(AnnotatedString.Range(bold, 0, 7)))
        val marked = source.markSearch("слово", Color.Red)
        assertEquals(2, marked.spanStyles.size)
        assertTrue(marked.spanStyles.any { it.item == bold && it.start == 0 && it.end == 7 })
        assertTrue(marked.spanStyles.any { it.start == 7 && it.end == 12 })
    }

    @Test
    fun statusLabelCountsMatchesFromOne() {
        assertEquals("", searchStatusLabel(0, -1, "   "))
        assertEquals("0 из 0", searchStatusLabel(0, -1, "иголка"))
        assertEquals("3 из 12", searchStatusLabel(12, 2, "иголка"))
    }

    @Test
    fun steppingWrapsAround() {
        assertEquals(1, stepSearchIndex(0, 1, 3))
        assertEquals(0, stepSearchIndex(2, 1, 3))
        assertEquals(2, stepSearchIndex(0, -1, 3))
        assertEquals(0, stepSearchIndex(0, -1, 1))
        assertEquals(-1, stepSearchIndex(0, 1, 0))
    }
}
