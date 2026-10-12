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

    // 2026-10-12: большой текст, вставленный первым сообщением, оставался стеной в
    // поле — черновик нового сообщения разбирал вставку иначе, чем чат, и порога
    // в нём не было вовсе.
    @Test
    fun movesLargeTextPastedAsTheFirstMessageToAttachment() {
        val pasted = "x".repeat(PASTED_TEXT_FILE_THRESHOLD + 1)
        val draft = pastedTextDraft(previousText = "", nextText = pasted, nowIso = "2026-10-12T03:26:01.000Z")

        assertEquals("", draft.text, "поле остаётся пустым: весь текст уехал вложением")
        assertEquals(0, draft.caret)
        assertEquals("pasted-2026-10-12T03-26-01-000Z.txt", draft.attached?.name)
        assertEquals(pasted, draft.attached?.bytes?.decodeToString())
        assertEquals("text/plain", draft.attached?.mimeType)
    }

    @Test
    fun keepsASmallPasteInTheFieldWithItsOwnCaret() {
        val draft = pastedTextDraft(previousText = "", nextText = "x".repeat(PASTED_TEXT_FILE_THRESHOLD), nowIso = "2026-10-12T03:26:01.000Z")

        assertNull(draft.attached)
        assertNull(draft.caret, "значение и каретка остаются у самого поля")
        assertEquals("x".repeat(PASTED_TEXT_FILE_THRESHOLD), draft.text)
    }
}
