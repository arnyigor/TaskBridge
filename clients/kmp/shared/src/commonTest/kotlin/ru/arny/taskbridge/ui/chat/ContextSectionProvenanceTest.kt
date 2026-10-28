package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.ContextPostCompaction
import ru.arny.taskbridge.core.api.ContextUsage
import ru.arny.taskbridge.core.api.SessionContextReport
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * CTX-03: измерение, оценка и отсутствие данных — три разных состояния. Экран
 * «Откуда контекст» не имеет права выдавать оценку Pi за измерение.
 */
class ContextSectionProvenanceTest {

    private fun report(
        total: Long? = null,
        usage: ContextUsage? = null,
        estimate: Long? = null,
    ) = SessionContextReport(totalTokens = total, usage = usage, postCompaction = estimate?.let { ContextPostCompaction(tokens = it) })

    @Test
    fun anEstimateAfterCompactionIsLabeledAsAnEstimate() {
        val line = contextEstimateLine(report(estimate = 78_800))
        assertEquals("≈ ${tokenCount(78_800)} (оценка Pi)", line)
        assertTrue(line!!.contains("оценка"))
        assertNull(contextEstimateLine(report()))
    }

    @Test
    fun aMissingMeasurementExplainsItself() {
        val inactive = report(usage = ContextUsage(unavailableReason = "сессия Pi не активна: текущий размер недоступен"))
        assertEquals("Текущий размер недоступен: сессия Pi не активна: текущий размер недоступен.", contextUnavailableLine(inactive))
        assertEquals("Размера текущего запроса ещё нет.", contextUnavailableLine(report()))
        assertNull(contextUnavailableLine(report(total = 1200, usage = ContextUsage(tokens = 1200))))
    }

    @Test
    fun aStaleMeasurementKeepsItsNumberButIsMarked() {
        val stale = report(total = 160_000, usage = ContextUsage(tokens = 160_000, source = "pi", stale = true), estimate = 78_800)
        assertEquals(160_000, stale.totalTokens)
        assertEquals(true, stale.usage?.stale)
        assertEquals("≈ ${tokenCount(78_800)} (оценка Pi)", contextEstimateLine(stale))
        assertNull(contextUnavailableLine(stale))
    }
}
