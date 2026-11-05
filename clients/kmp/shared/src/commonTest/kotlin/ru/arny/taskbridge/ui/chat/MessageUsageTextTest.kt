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
}
