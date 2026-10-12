package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Строка «Последнее событие: VERIFICATION» требует знать внутренние имена кадров. */
class LastEventLabelTest {
    @Test
    fun knownFramesGetARussianLabel() {
        assertEquals("проверка результата", lastEventLabel("VERIFICATION"))
        assertEquals("модель пишет ответ", lastEventLabel("message_update"))
        assertEquals("запущен инструмент", lastEventLabel("tool_execution_start"))
        assertEquals("агент закончил ход", lastEventLabel("agent_settled"))
    }

    @Test
    fun anUnknownFrameIsShownAsIs() {
        // Выдуманная подпись хуже сырого имени: по raw видно, что за кадр пришёл.
        assertEquals("SOME_NEW_EVENT", lastEventLabel("SOME_NEW_EVENT"))
        assertNull(lastEventLabel(null))
    }
}
