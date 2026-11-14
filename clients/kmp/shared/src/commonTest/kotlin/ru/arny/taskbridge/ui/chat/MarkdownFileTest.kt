package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MarkdownFileTest {

    @Test
    fun previewDoesNotSplitUtf8AtTheByteLimit() {
        for (character in listOf("я", "€", "😀")) {
            val width = character.encodeToByteArray().size
            for (part in 1 until width) {
                val prefix = "a".repeat(300_000 - part)
                val result = textPreview((prefix + character + "tail").encodeToByteArray())
                assertEquals(prefix, result.text)
                assertTrue(result.cut)
            }
            val exact = "a".repeat(300_000 - width) + character
            assertEquals(exact, textPreview((exact + "tail").encodeToByteArray()).text)
            assertEquals(exact, textPreview(exact.encodeToByteArray()).text)
        }
        val small = textPreview("Привет 😀".encodeToByteArray())
        assertEquals("Привет 😀", small.text)
        assertFalse(small.cut)
        assertEquals("", textPreview(byteArrayOf()).text)
    }

    @Test
    fun markdownFilesAreRenderedAndEverythingElseIsSource() {
        assertTrue(isMarkdownName("README.md"))
        assertTrue(isMarkdownName("docs/plan.MARKDOWN"))
        assertTrue(isMarkdownName("page.mdx"))
        assertFalse(isMarkdownName("notes.md.txt"))
        assertFalse(isMarkdownName("main.mjs"))
        assertFalse(isMarkdownName("README"))
        assertFalse(isMarkdownName(null))
    }
}
