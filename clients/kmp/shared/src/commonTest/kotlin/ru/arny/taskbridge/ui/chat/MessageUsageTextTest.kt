package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ru.arny.taskbridge.core.api.ProviderPeakRules
import ru.arny.taskbridge.core.api.ProviderPeakWindow
import ru.arny.taskbridge.core.api.ProviderRate
import ru.arny.taskbridge.core.api.ProviderTariff
import ru.arny.taskbridge.core.api.TurnMetrics
import ru.arny.taskbridge.core.client.chat.AnswerUsage

/**
 * Подпись «токены · деньги» под ответом: арифметика, часы пика и форматы.
 * Ставки и расписание — те же, что отдаёт сервер (см. tests/deepseek-tariff.test.mjs).
 */
class MessageUsageTextTest {
    private val usdRates = mapOf(
        "deepseek-flash" to ProviderRate(hit = 0.003, miss = 0.15, out = 0.6),
        "deepseek-v4-pro" to ProviderRate(hit = 0.022, miss = 0.66, out = 1.98),
    )
    private val cnyRates = mapOf(
        "deepseek-flash" to ProviderRate(hit = 0.02, miss = 1.0, out = 4.0),
    )
    private val peak = ProviderPeakRules(
        weekdaysUtc = listOf(1, 2, 3, 4, 5),
        windowsUtc = listOf(ProviderPeakWindow("01:00", "04:00"), ProviderPeakWindow("06:00", "10:00")),
        holidays = emptyList(),
        timeZoneRule = "utc",
    )
    private val tariff = ProviderTariff(
        currency = "USD",
        unit = "per_1m_tokens",
        multiplier = 2.0,
        rates = usdRates,
        ratesCny = cnyRates,
        aliases = mapOf("flash" to "deepseek-v4-flash", "pro" to "deepseek-v4-pro"),
        peak = peak,
    )

    // Один ответ: кэш + промах + вывод, 2 379 400 токенов.
    private val answer = AnswerUsage(hit = 2_350_000, miss = 24_100, out = 5_300)

    @Test
    fun `внепиковый ответ считается по базовым ставкам`() {
        // Воскресенье 2026-09-13 — непик весь день.
        val line = usageLine(answer, "deepseek-flash", "2026-09-13T12:00:00Z", UsagePricing(tariff, rubPerUnit = 80.5573))
        assertEquals("2.4M ток · $0.0138 · ≈ 1.12 ₽", line?.text)
        assertFalse(line!!.peak)
    }

    @Test
    fun `пиковый ответ дороже ровно вдвое и помечается`() {
        // Среда 2026-09-16, 07:00 UTC — второе окно пика.
        val line = usageLine(answer, "deepseek-flash", "2026-09-16T07:00:00Z", UsagePricing(tariff, rubPerUnit = 80.5573))
        assertTrue(line!!.peak)
        assertEquals("2.4M ток · $0.0277 · ≈ 2.23 ₽", line.text)
    }

    @Test
    fun `границы окон и выходные считаются по UTC`() {
        val at = { iso: String? -> isPeakAt(iso, peak) }
        assertTrue(at("2026-09-16T01:00:00Z"))
        assertTrue(at("2026-09-16T03:59:59Z"))
        assertFalse(at("2026-09-16T04:00:00Z"))
        assertFalse(at("2026-09-16T05:59:00Z"))
        assertTrue(at("2026-09-16T06:00:00Z"))
        assertFalse(at("2026-09-16T10:00:00Z"))
        assertFalse(at("2026-09-19T07:00:00Z"), "суббота")
        assertFalse(at("2026-09-20T02:00:00Z"), "воскресенье")
        assertFalse(at(null))
    }

    @Test
    fun `праздник КНР отменяет пик, а локальное время его не сдвигает`() {
        assertEquals("2026-10-01", "2026-10-01T07:00:00Z".substringBefore('T'))
        assertTrue(isPeakAt("2026-10-01T07:00:00Z", peak))
        assertFalse(isPeakAt("2026-10-01T07:00:00Z", peak.copy(holidays = listOf("2026-10-01"))))
        // 11:00 местного (+05:00) — это 06:00 UTC, то есть пик; 15:00 местного — уже нет.
        assertTrue(isPeakAt("2026-09-16T11:00:00+05:00", peak))
        assertFalse(isPeakAt("2026-09-16T15:00:00+05:00", peak))
    }

    @Test
    fun `юаневый тариф считает по юаневой таблице, а не по курсу`() {
        val cnyTariff = tariff.copy(currency = "CNY")
        val line = usageLine(answer, "deepseek-flash", "2026-09-13T12:00:00Z", UsagePricing(cnyTariff, rubPerUnit = 12.0873))
        assertEquals("2.4M ток · ¥0.0923 · ≈ 1.12 ₽", line?.text)
        assertFalse(line!!.peak)
    }

    @Test
    fun `неизвестная модель показывает только токены, пустой usage — ничего`() {
        val unknown = usageLine(answer, "llama.cpp/local", "2026-09-16T07:00:00Z", UsagePricing(tariff, 80.0))
        assertEquals("2.4M ток", unknown?.text)
        assertFalse(unknown!!.peak)
        assertNull(usageLine(null, "deepseek-flash", "2026-09-16T07:00:00Z", UsagePricing(tariff, 80.0)))
        assertNull(usageLine(AnswerUsage(), "deepseek-flash", "2026-09-16T07:00:00Z", UsagePricing(tariff, 80.0)))
    }

    @Test
    fun `алиас биллинга и префикс провайдера находят ту же ставку`() {
        assertNull(rateFor(tariff, null))
        assertEquals(0.6, rateFor(tariff, "deepseek/deepseek-flash")?.out)
        assertEquals(1.98, rateFor(tariff, "pro")?.out)
        assertEquals(0.02, rateFor(tariff.copy(currency = "CNY"), "deepseek-flash")?.hit)
    }

    @Test
    fun `токены и деньги печатаются в человеческом виде`() {
        assertEquals("820 ток", tokenText(820))
        assertEquals("9500 ток", tokenText(9_500))
        assertEquals("179K ток", tokenText(179_000))
        assertEquals("2.4M ток", tokenText(2_379_400))
        assertEquals("536.2M ток", tokenText(536_200_000))
        assertEquals("0.0138", fixed(0.013845, 4))
        assertEquals("1.12", fixed(1.1159, 2))
        assertEquals("3.21", fixed(3.205249, 2))
    }

    // --- Время работы сообщения (серверное значение, клиент не пересчитывает) ---

    @Test
    fun durationUsesFourFormats() {
        assertEquals("0.4 с", durationText(400))
        assertEquals("42 с", durationText(42_000))
        assertEquals("1:05", durationText(65_000))
        assertEquals("1:02:05", durationText(3_725_000))
    }

    @Test
    fun durationNeverShowsSixtySeconds() {
        assertEquals("59 с", durationText(59_900))
        assertEquals("1:00", durationText(60_000))
    }

    @Test
    fun exactTokensKeepEveryDigit() {
        assertEquals("1 235 652 ток", tokensExact(1_235_652))
        assertEquals("8 412 ток", tokensExact(8_412))
        assertEquals("0 ток", tokensExact(0))
        assertEquals("999 ток", tokensExact(999))
    }

    @Test
    fun cacheHitIsComputedBeforeRounding() {
        assertEquals("99.8%", cacheHitText(1_228_928, 2_165))
        assertEquals("0.0%", cacheHitText(0, 1_000))
        assertEquals("100.0%", cacheHitText(1_000, 0))
        assertNull(cacheHitText(0, 0))
        assertNull(cacheHitText(null, 10))
        assertNull(cacheHitText(10, null))
    }

    @Test
    fun cacheWriteIsNotPartOfTheTurnTotal() {
        val usage = AnswerUsage(hit = 1_228_928, miss = 2_165, out = 4_559, cacheWrite = 7_000)
        assertEquals(1_235_652, usage.total)
    }

    @Test
    fun speedIsDerivedFromOutputAndWindowOnly() {
        assertEquals("47 ток/с", tokensPerSecondText(4_559, 97_000))
        assertNull(tokensPerSecondText(0, 1_000))
        assertNull(tokensPerSecondText(10, 0))
        assertNull(tokensPerSecondText(null, 1_000))
    }

    @Test
    fun durationAloneStillProducesABar() {
        val line = usageLine(null, "deepseek-flash", null, null, TurnMetrics(durationMs = 42_000))
        assertEquals("42 с", line?.text)
    }

    @Test
    fun noUsageAndNoDurationMeansNoBar() {
        assertNull(usageLine(null, "deepseek-flash", null, null, null))
        assertNull(usageDetails(null, "deepseek-flash", null, null, null))
    }

    @Test
    fun barShowsTokensAndDurationTogether() {
        val line = usageLine(AnswerUsage(hit = 1_228_928, miss = 2_165, out = 4_559), "deepseek-flash", null, null, TurnMetrics(durationMs = 42_000))
        assertEquals("1.2M ток · 42 с", line?.text)
    }

    // --- Таблица: «неизвестно» и «ноль» — разные факты ---

    @Test
    fun partialUsageKeepsUnknownFieldsOutOfTheTotal() {
        val usage = AnswerUsage(miss = 100, out = 10)
        assertEquals(110, usage.total)
        assertNull(usage.hit)
        assertNull(usage.cacheWrite)
    }

    @Test
    fun knownZeroIsKeptApartFromUnknown() {
        val usage = AnswerUsage(hit = 0, miss = 100, out = 0, cacheWrite = 0)
        assertEquals(100, usage.total)
        assertEquals(0, usage.cacheWrite)
        assertEquals("0.0%", cacheHitText(usage.hit, usage.miss))
    }

    @Test
    fun summingAnswersKeepsUnknownsUnknown() {
        val first = AnswerUsage(hit = 10, miss = 5, out = 1)
        val second = AnswerUsage(miss = 3, out = 2)
        val sum = first + second
        assertEquals(10, sum.hit)
        assertEquals(8, sum.miss)
        assertEquals(3, sum.out)
        assertNull(sum.cacheWrite)
    }

    @Test
    fun largeAndInvalidCountsNeverWrapAround() {
        assertEquals("50.0%", cacheHitText(Long.MAX_VALUE, Long.MAX_VALUE))
        assertNull(cacheHitText(-1, 10))
        assertNull(cacheHitText(10, -1))
        assertNull(AnswerUsage(hit = Long.MAX_VALUE, miss = 1).total)
        assertNull((AnswerUsage(hit = Long.MAX_VALUE) + AnswerUsage(hit = 1)).hit)
    }

    @Test
    fun localModelFromTheServerSuppressesMoneyEvenWithATariff() {
        val usage = AnswerUsage(hit = 1_000, miss = 100, out = 10)
        val priced = usageDetails(usage, "deepseek-flash", null, UsagePricing(tariff, 80.0), null, isLocal = true)
            ?: error("usage есть — блок обязан быть")
        assertTrue(priced.local)
        assertNull(priced.cost, "локальная модель не тарифицируется")
        assertFalse(priced.text.contains("$"))
    }

    @Test
    fun providerTotalMismatchKeepsTheComponentSum() {
        val usage = AnswerUsage(hit = 1_228_928, miss = 2_165, out = 4_559, totalMismatch = true)
        assertEquals(1_235_652, usage.total)
        val details = usageDetails(usage, "deepseek-flash", null, null, null)
            ?: error("usage есть — блок обязан быть")
        assertTrue(details.text.startsWith("1.2M ток"))
    }
}
