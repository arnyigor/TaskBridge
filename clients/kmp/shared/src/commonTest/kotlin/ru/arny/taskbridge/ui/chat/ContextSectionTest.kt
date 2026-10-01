package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.ContextCompaction
import ru.arny.taskbridge.core.api.ContextLimit
import ru.arny.taskbridge.core.api.ContextSource
import ru.arny.taskbridge.core.api.ContextUsage
import ru.arny.taskbridge.core.api.SessionContextReport
import kotlin.test.Test
import kotlin.test.assertEquals

class ContextSectionTest {

    @Test
    fun tokensReadExactlyBelowTenThousandAndInThousandsAbove() {
        assertEquals("—", tokenCount(null))
        assertEquals("0", tokenCount(0))
        assertEquals("558", tokenCount(558))
        assertEquals("9999", tokenCount(9_999))
        assertEquals("10K", tokenCount(10_000))
        assertEquals("200K", tokenCount(200_000))
    }

    @Test
    fun anUnmeasurableSourceSaysSoInsteadOfShowingZero() {
        assertEquals("не измеряется", contextSourceValue(ContextSource(id = "builtin-tools", known = false, tokens = null)))
        // known but without a number: no size either, and saying "0" would be a lie.
        assertEquals("не измеряется", contextSourceValue(ContextSource(id = "x", known = true, tokens = null)))
        assertEquals("12K", contextSourceValue(ContextSource(id = "mcp-tools", known = true, tokens = 12_000)))
    }

    @Test
    fun aCountedSourceShowsHowManyItCovers() {
        assertEquals("12K · 12 шт.", contextSourceValue(ContextSource(id = "mcp-tools", known = true, tokens = 12_000, count = 12)))
        assertEquals("12K", contextSourceValue(ContextSource(id = "instructions", known = true, tokens = 12_000, count = 0)))
    }

    @Test
    fun theHeadlineCarriesUsageTheWindowAndTheLimit() {
        val report = SessionContextReport(
            totalTokens = 60_000,
            contextWindow = 200_000,
            usage = ContextUsage(tokens = 60_000, contextWindow = 200_000, percent = 30.0, source = "pi"),
        )
        assertEquals("Всего в запросе: 60K токенов из 200K · 30%", contextHeadline(report))
        val over = report.copy(limit = ContextLimit(tokens = 40_000, exceeded = true))
        assertEquals("Всего в запросе: 60K токенов из 200K · 30% · лимит 40K — выше лимита", contextHeadline(over))
    }

    @Test
    fun aSessionWithoutLiveNumbersHasNoHeadline() {
        assertEquals(null, contextHeadline(SessionContextReport()))
    }

    @Test
    fun theCompactionLineExplainsWhatTriggersPi() {
        assertEquals("Автосжатие Pi выключено — порог по окну модели не применяется.", contextCompactionLine(auto = false, triggerAt = 183_616))
        assertEquals("Автосжатие Pi: свой порог 183K токенов (окно минус резерв ответа).", contextCompactionLine(auto = true, triggerAt = 183_616))
        assertEquals("Автосжатие Pi включено.", contextCompactionLine(auto = true, triggerAt = null))
    }
}
