package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.CompositionActive
import ru.arny.taskbridge.core.api.CompositionCompaction
import ru.arny.taskbridge.core.api.CompositionHistory
import ru.arny.taskbridge.core.api.CompositionTotals
import ru.arny.taskbridge.core.api.ContextPostCompaction
import ru.arny.taskbridge.core.api.SessionComposition
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

/** CTX-02: состав контекста после сжатия — размеры и количество, без текста. */
class ContextCompositionLinesTest {
    private fun report(session: SessionComposition?) = SessionContextReport(session = session)

    private fun composition(
        available: Boolean = true,
        kept: Long = 4,
        chars: Long = 2345,
        toolResults: Long = 1,
        summaryChars: Long = 321,
        tokensBefore: Long? = 160_000,
        excluded: Long = 7,
        excludedChars: Long = 4321,
    ) = SessionComposition(
        available = available,
        method = "session-file-projection",
        active = CompositionActive(kept = CompositionTotals(messages = kept, chars = chars, toolResults = toolResults)),
        compaction = CompositionCompaction(summaryChars = summaryChars, summaryAvailable = summaryChars > 0, tokensBefore = tokensBefore),
        history = CompositionHistory(excludedMessages = excluded, excludedChars = excludedChars),
    )

    @Test
    fun keptMessagesAreCountedWithTheirSize() {
        assertEquals("4 сообщ. · 2345 симв. · результатов инструментов: 1", contextKeptLine(report(composition())))
    }

    @Test
    fun aLargeCharacterCountIsNotPresentedAsTokens() {
        val line = contextKeptLine(report(composition(chars = 250_000, toolResults = 0)))
        assertEquals("4 сообщ. · 250K симв.", line)
        assertTrue(line!!.contains("симв."))
    }

    @Test
    fun theSummaryShowsItsSizeAndWhatWasThereBefore() {
        assertEquals("321 симв. · до сжатия 160K ток.", contextSummaryLine(report(composition())))
        assertNull(contextSummaryLine(report(composition(summaryChars = 0))))
    }

    @Test
    fun excludedHistoryIsShownOnlyWhenSomethingWasExcluded() {
        assertEquals("7 сообщ. · 4321 симв.", contextExcludedLine(report(composition())))
        assertNull(contextExcludedLine(report(composition(excluded = 0, excludedChars = 0))))
        assertNull(contextExcludedLine(report(null)))
    }

    @Test
    fun anUnavailableCompositionShowsNothingInsteadOfZeros() {
        val unavailable = SessionComposition(available = false, reason = "у сессии ещё нет файла Pi")
        assertNull(contextKeptLine(report(unavailable)))
        assertNull(contextSummaryLine(report(unavailable)))
        assertNull(contextExcludedLine(report(unavailable)))
    }
}

/** Живой вопрос 2026-10-29: «сжалась, но занимает 482К» — направление чисел должно быть названо. */
class CompactionChangeLineTest {
    @Test
    fun theLineNamesBothSides() {
        val line = compactionChangeLine(482_700, 36_107)
        assertEquals("было 482K → ≈36K ток.", line)
    }

    @Test
    fun halfAKnownPairIsNotRenderedAsZero() {
        assertNull(compactionChangeLine(null, 36_107))
        assertNull(compactionChangeLine(482_700, null))
    }
}

class ContextBranchAndSavingsTest {
    @Test
    fun rpcLeafAndFileTailHaveDifferentLabels() {
        assertEquals("активная ветка Pi · leaf branch-a", contextBranchLine(SessionContextReport(session = SessionComposition(available = true, branchSource = "pi-leaf", leafId = "branch-a"))))
        assertEquals("последняя запись файла; активная ветка Pi не подтверждена", contextBranchLine(SessionContextReport(session = SessionComposition(available = true, branchSource = "file-tail"))))
        assertNull(contextBranchLine(SessionContextReport()))
        assertNull(contextBranchLine(SessionContextReport(session = SessionComposition(available = false, branchSource = "pi-leaf"))))
    }

    @Test
    fun savingsAreAlwaysAnEstimateAndNeverNegative() {
        val report = SessionContextReport(postCompaction = ContextPostCompaction(tokensBefore = 1000, tokens = 1200))
        assertEquals("≈ 0 ток. Это не измеренная экономия.", contextFreedLine(report))
        assertNull(contextFreedLine(SessionContextReport()))
    }
}
