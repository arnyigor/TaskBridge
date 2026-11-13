package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Куски размышлений режутся по 1200 символов, и раскрытый блок раскладывает только
 * видимые. Значит куски обязаны склеиваться в исходный текст без потерь и без сдвигов,
 * а дописывание дельты не имеет права перекроить уже показанное начало.
 */
class ThinkingChunkerTest {

    private fun ThinkingChunker.text(): String = (0 until count).joinToString("") { chunk(it) }

    @Test
    fun piecesJoinBackIntoTheSameText() {
        val text = "Рассуждение о коде\n".repeat(500)
        val chunker = ThinkingChunker(1200)
        assertEquals((text.length + 1199) / 1200, chunker.update(text))
        assertEquals(text, chunker.text())
        assertTrue((0 until chunker.count).all { chunker.chunk(it).length in 1..1200 })
    }

    @Test
    fun anEmptyTextHasNoPieces() {
        val chunker = ThinkingChunker(1200)
        assertEquals(0, chunker.update(""))
        assertEquals("", chunker.text())
    }

    @Test
    fun aSurrogatePairIsNeverSplitBetweenPieces() {
        // Эмодзи занимает два char; граница куска попадает ровно между ними.
        val text = "a" + "😀".repeat(20)
        val chunker = ThinkingChunker(7)
        chunker.update(text)
        assertEquals(text, chunker.text())
        for (index in 0 until chunker.count) {
            val piece = chunker.chunk(index)
            assertTrue(!piece.last().isHighSurrogate(), "кусок $index кончается половиной пары")
        }
    }

    @Test
    fun appendingDeltasGivesTheSamePiecesAsACutFromScratch() {
        val source = "fragment ".repeat(2_000)
        val streamed = ThinkingChunker(97)
        var growing = ""
        for (size in 1..source.length step 37) {
            growing = source.substring(0, size)
            streamed.update(growing)
        }
        streamed.update(source)
        val once = ThinkingChunker(97).apply { update(source) }
        assertEquals(once.count, streamed.count)
        assertEquals(source, streamed.text())
        assertEquals(once.text(), streamed.text())
    }

    @Test
    fun aTextThatIsNotAnExtensionReplacesEverything() {
        val chunker = ThinkingChunker(10)
        chunker.update("первый вариант рассуждения")
        chunker.update("совсем другой текст")
        assertEquals("совсем другой текст", chunker.text())
        // Растущий текст продолжает с новой точки, а не с хвоста прежнего.
        chunker.update("совсем другой текст и продолжение")
        assertEquals("совсем другой текст и продолжение", chunker.text())
    }

    @Test
    fun theSameTextIsNotCutTwice() {
        val chunker = ThinkingChunker(10)
        chunker.update("abcdefghijklm")
        val pieces = (0 until chunker.count).map(chunker::chunk)
        assertEquals(2, chunker.update("abcdefghijklm"))
        assertEquals(pieces, (0 until chunker.count).map(chunker::chunk))
    }
}
