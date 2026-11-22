package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import ru.arny.taskbridge.core.client.markdown.Markdown
import ru.arny.taskbridge.core.client.markdown.MdBlock
import ru.arny.taskbridge.core.client.markdown.MdRun

class FileMarkdownTest {
    @Test
    fun fullMarkdownIsNotTruncatedButPlainTextStillIs() {
        val source = "Пример 😀\n".repeat(70_000) + "LAST LINE"
        val bytes = source.encodeToByteArray()
        val full = textPreview(bytes, markdown = true)
        assertEquals(source, full.text)
        assertEquals(bytes.size, full.bytes)
        assertFalse(full.cut)
        assertTrue(textPreview(bytes).cut)
        assertTrue(textPreview(bytes).text.encodeToByteArray().size <= 300_000)
    }

    @Test
    fun boundedParagraphsPreserveAllStylesLinksAndSurrogatePairs() {
        val runs = listOf(
            MdRun("a".repeat(FILE_TEXT_CHARS - 1) + "😀" + "linked ".repeat(1500), bold = true, link = "docs/file.md"),
            MdRun("code ".repeat(1500), code = true),
        )
        val chunks = splitFileRuns(runs)
        assertTrue(chunks.size > 2)
        assertEquals(runs.joinToString("") { it.text }, chunks.flatten().joinToString("") { it.text })
        chunks.forEach { part ->
            assertTrue(part.sumOf { it.text.length } <= FILE_TEXT_CHARS)
            part.forEach { run ->
                assertFalse(run.text.first().isLowSurrogate())
                assertFalse(run.text.last().isHighSurrogate())
                assertEquals(runs.first { it.code == run.code }.copy(text = run.text), run)
            }
        }
    }

    @Test
    fun codeHasNoMissingCharactersAndExpansionIsHoisted() {
        for (source in listOf("", "😀".repeat(6000), "line\n".repeat(100_000), "a".repeat(10_000) + "\nlast")) {
            val chunks = splitFileCode(source)
            assertEquals(source, chunks.joinToString(""))
            chunks.forEach {
                assertTrue(it.length <= FILE_TEXT_CHARS)
                assertTrue(it.count { c -> c == '\n' } <= 24)
            }
            val document = prepareFileMarkdown(listOf(MdBlock.Code("text", source, true)))
            assertEquals(source, document.items.single().code!!.source.code)
            document.toggleCode(0)
            assertTrue(0 in document.expandedCodes)
            document.toggleCode(0)
            assertTrue(document.expandedCodes.isEmpty())
        }
    }

    @Test
    fun nestedQuotesAndListsBecomeBoundedLeavesWithoutRepeatingMarkers() {
        val document = prepareFileMarkdown(Markdown.parse("> 42. **" + "word ".repeat(5000) + "**\n> 43. final"))
        assertTrue(document.items.size > 10)
        document.items.forEach {
            assertTrue(it.block is MdBlock.Paragraph)
            assertTrue((it.block as MdBlock.Paragraph).text.sumOf { run -> run.text.length } <= FILE_TEXT_CHARS)
            assertEquals(FileDecoration.Quote, it.decorations.first())
        }
        val markers = document.items.flatMap { it.decorations }.filterIsInstance<FileDecoration.Marker>().mapNotNull { it.text }
        assertEquals(listOf("42.", "43."), markers)
    }

    @Test
    fun tablePagesBoundRowsAndRetainTheTailAndLongCell() {
        val header = listOf(listOf(MdRun("Name")), listOf(MdRun("Value")))
        val longCell = "😀value ".repeat(3000)
        val rows = List(1000) { i -> listOf(listOf(MdRun("row $i")), listOf(MdRun(if (i == 999) longCell else "value $i"))) }
        val document = prepareFileMarkdown(listOf(MdBlock.Table(header, emptyList(), rows)))
        val pages = document.items.map { assertTrue(it.tablePage); it.block as MdBlock.Table }
        assertTrue(pages.size > 100)
        assertTrue(pages.all { it.rows.size <= 8 })
        assertTrue(pages.all { it.header == header })
        val restored = pages.flatMap { it.rows }
        assertEquals((0..999).map { "row $it" }, restored.map { it[0].joinToString("") { run -> run.text } }.filter { it.isNotEmpty() })
        val content = restored.map { it[1].joinToString("") { run -> run.text } }.joinToString("")
        assertEquals((0..998).joinToString("") { "value $it" } + longCell, content)
    }
}
