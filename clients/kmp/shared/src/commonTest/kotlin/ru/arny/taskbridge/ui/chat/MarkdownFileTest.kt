package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MarkdownFileTest {

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
