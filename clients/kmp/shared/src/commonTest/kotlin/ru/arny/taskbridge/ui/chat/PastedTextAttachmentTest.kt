package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PastedTextAttachmentTest {

    @Test
    fun keepsSmallDraftAsText() {
        assertNull(largeTextAttachmentFromDraftChange("", "hello", threshold = 8))
    }

    @Test
    fun movesLargeInsertedTextToAttachmentAndKeepsSurroundingDraft() {
        val pasted = "x".repeat(9)
        val attachment = largeTextAttachmentFromDraftChange("beforeafter", "before${pasted}after", threshold = 8)

        assertEquals(pasted, attachment?.text)
        assertEquals("beforeafter", attachment?.remainingText)
        assertEquals("before".length, attachment?.caret)
    }

    @Test
    fun movesWholeDraftWhenItOnlyBecomesTooLargeAfterSeveralEdits() {
        val next = "x".repeat(9)
        val attachment = largeTextAttachmentFromDraftChange("x".repeat(8), next, threshold = 8)

        assertEquals(next, attachment?.text)
        assertEquals("", attachment?.remainingText)
        assertEquals(0, attachment?.caret)
    }

    @Test
    fun sanitizesIsoTimestampForFilename() {
        assertEquals("pasted-2026-09-28T01-02-03-456Z.txt", pastedTextFileName("2026-09-28T01:02:03.456Z"))
    }
}
