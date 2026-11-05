package ru.arny.taskbridge.ui.settings

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import ru.arny.taskbridge.core.api.ProviderCostHistory
import ru.arny.taskbridge.core.api.ProviderMonth
import ru.arny.taskbridge.core.api.ProviderPace
import ru.arny.taskbridge.core.api.ProviderStatus
import ru.arny.taskbridge.core.api.ProviderTokenPace

/**
 * Вторая строка под DeepSeek: темп, факт месяца и свежесть истории.
 * Числа взяты из реальных данных (сентябрь 2026: 3.8 млрд токенов, 196.49 ¥).
 */
class ProviderUsageSummaryTest {
    private val tokens = ProviderTokenPace(
        windowDays = 3,
        tokensPerDay = 178_746_056.0,
        rubPerDay = 111.97780604747,
        cnyPerDay = 9.2640876,
    )
    private val month = ProviderMonth(
        key = "2026-09",
        from = "2026-09-01",
        to = "2026-09-21",
        days = 21,
        tokens = 3_796_204_283.0,
        cny = 196.49399672,
        rub = 2375.081886553459,
    )
    private val fresh = ProviderCostHistory(lastDay = "2026-09-21", ageDays = 0, stale = false)

    private fun status(
        tokens: ProviderTokenPace? = this.tokens,
        month: ProviderMonth? = this.month,
        history: ProviderCostHistory? = fresh,
        monthlyRub: Double? = 3359.3341814241,
    ) = ProviderStatus(
        provider = "deepseek",
        available = true,
        tokens = tokens,
        month = month,
        costHistory = history,
        pace = ProviderPace(monthlyRub = monthlyRub),
    )

    @Test
    fun `свежая история — темп в день, прогноз за месяц и факт месяца`() {
        assertEquals(
            "3 дн.: 178.7M ток · ≈112 ₽/день · за месяц ≈3359 ₽\n" +
                "сентябрь 1–21: 3.8 млрд ток · ¥196.49 ≈2375 ₽",
            providerUsageDetail(status()),
        )
    }

    @Test
    fun `устаревшая история — прогноз есть, рядом стоит дата последней записи`() {
        val stale = providerUsageDetail(status(history = ProviderCostHistory("2026-09-21", 42, true)))
        assertEquals(
            "3 дн.: 178.7M ток · ≈112 ₽/день · за месяц ≈3359 ₽\n" +
                "сентябрь 1–21: 3.8 млрд ток · ¥196.49 ≈2375 ₽ · история до 21.09 (42 дн.)",
            stale,
        )
    }

    @Test
    fun `без истории токенов остаётся только факт месяца`() {
        assertEquals(
            "сентябрь 1–21: 3.8 млрд ток · ¥196.49 ≈2375 ₽",
            providerUsageDetail(status(tokens = null)),
        )
    }

    @Test
    fun `нечего показать — строки нет`() {
        assertNull(providerUsageDetail(status(tokens = null, month = null)))
        assertNull(providerUsageDetail(ProviderStatus(provider = "routerai", credits = 12.0)))
    }

    @Test
    fun `названия месяцев и короткие даты`() {
        assertEquals("сентябрь", monthName("2026-09"))
        assertEquals("декабрь", monthName("2026-12"))
        assertNull(monthName("2026-13"))
        assertNull(monthName(null))
        // Без месяца в данных остаётся только диапазон дней и деньги в юанях.
        assertEquals(
            "1–21: ¥196.49",
            providerUsageDetail(status(tokens = null, month = month.copy(key = null, tokens = null, rub = null))),
        )
    }
}
