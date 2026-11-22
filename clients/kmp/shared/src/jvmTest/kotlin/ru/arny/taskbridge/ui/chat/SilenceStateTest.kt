package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import ru.arny.taskbridge.core.api.RuntimeInfo
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TurnState

/**
 * Шаг C-A: баннер молчания в KMP-чате. silentMs считает сервер, порог — 120 с,
 * показывается только для живого хода. Рендер баннера требует устройства.
 */
class SilenceStateTest {
    private fun task(status: String = "RUNNING", silentMs: Long? = 180_000L, turn: Long? = 3, stage: String? = "bash: npm test") =
        Task(id = "t1", status = status, turnState = TurnState(phase = "PROGRESS", turn = turn, stage = stage, silentMs = silentMs))

    @Test
    fun `silent beyond threshold on an active turn is reported with the stage`() {
        val s = silenceState(task())!!
        assertEquals(180_000L, s.totalMs)
        assertEquals("Модель молчит 3:00", s.label)
        assertEquals("bash: npm test", s.stage)
    }

    @Test
    fun `no banner below threshold, for terminal status or without server facts`() {
        assertNull(silenceState(task(silentMs = 119_999L)))
        assertNull(silenceState(task(status = "SUCCEEDED")))
        assertNull(silenceState(task(silentMs = null)))
        assertNull(silenceState(null))
    }

    @Test
    fun `a blank stage is not shown as progress`() {
        assertNull(silenceState(task(stage = "  "))!!.stage)
    }

    @Test
    fun `quiet long tools and known runtime waits are not model silence`() {
        for (activity in listOf("tool", "compacting", "waiting_model")) {
            assertNull(silenceState(task(silentMs = 600_000L).copy(
                runtime = RuntimeInfo(state = "WORKING", activity = activity),
            )), activity)
        }
        for (status in listOf("QUEUED", "PREPARING", "PREFLIGHT", "WAITING_USER", "VERIFYING", "CANCELLING")) {
            assertNull(silenceState(task(status = status)), status)
        }
        assertEquals("Модель молчит 3:00", silenceState(task().copy(
            runtime = RuntimeInfo(state = "WORKING", activity = "streaming"),
        ))?.label)
    }

    @Test
    fun `silence is named the same regardless of the first token`() {
        // Подпись «Ждём первый токен …» убрана: таймер один — общее молчание хода.
        val s = silenceState(task().copy(turnState = TurnState(phase = "DISPATCHING", turn = 3, silentMs = 180_000L, waitingModelMs = 180_000L)))!!
        assertEquals("Модель молчит 3:00", s.label)
        assertEquals(180_000L, s.waitingModelMs)
        assertEquals("Модель молчит 3:00", silenceState(task())!!.label)
        assertNull(silenceState(task())!!.waitingModelMs)
    }
}
