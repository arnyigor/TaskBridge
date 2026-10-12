package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * «Модель читает промпт» показывалось всё время, пока в ответе не появится текст, — то
 * есть и над активно идущими размышлениями: подпись держалась на PP прошлого хода,
 * который не гаснет. Живое чтение промпта — это фаза движка или его PP из /api/info.
 */
class ReadsPromptTest {

    @Test
    fun aLivePromptReadIsShownWhileTheModelHasProducedNothing() {
        assertTrue(readsPromptNow(readingPrompt = true, livePp = null, answerSilent = true))
        assertTrue(readsPromptNow(readingPrompt = false, livePp = 1800.0, answerSilent = true))
    }

    @Test
    fun reasoningArrivingIsNotAPromptRead() {
        // The reported case: the think block streams, the answer text is still empty.
        assertFalse(readsPromptNow(readingPrompt = true, livePp = 1800.0, answerSilent = false))
        assertFalse(readsPromptNow(readingPrompt = true, livePp = null, answerSilent = false))
    }

    @Test
    fun withoutALiveSignThereIsNothingToClaim() {
        assertFalse(readsPromptNow(readingPrompt = false, livePp = null, answerSilent = true))
    }
}
