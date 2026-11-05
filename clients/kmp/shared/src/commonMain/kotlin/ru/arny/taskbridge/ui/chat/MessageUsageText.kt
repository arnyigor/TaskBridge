package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.ProviderPeakRules
import ru.arny.taskbridge.core.api.ProviderRate
import ru.arny.taskbridge.core.api.ProviderTariff
import ru.arny.taskbridge.core.client.chat.AnswerUsage
import ru.arny.taskbridge.ui.common.parseIsoMillis
import kotlin.time.Instant

/**
 * Подпись под ответом модели: сколько токенов, сколько денег и был ли это пик.
 *
 * Деньги считаются по тарифу провайдера (ставки за 1M токенов в валюте списания)
 * и курсу ЦБ. Всё, что здесь есть, — чистые функции: их можно проверить тестом без
 * Compose и без сети.
 */
data class UsageLine(
    /** «2.4M ток · $0.0138 · ≈ 1.12 ₽» */
    val text: String,
    /** Вызов шёл по пиковому тарифу — подпись помечается. */
    val peak: Boolean,
    /** Валюта денег в строке: USD / CNY (для пояснения при нажатии). */
    val currency: String? = null,
)

/** Тариф и курс рубля к валюте тарифа — всё, что нужно, чтобы посчитать деньги. */
data class UsagePricing(
    val tariff: ProviderTariff,
    /** Сколько рублей в одной единице валюты тарифа (ЦБ). */
    val rubPerUnit: Double?,
)

/**
 * Ставка модели по её id с учётом того, как модель называет биллинг.
 * Таблица берётся по валюте тарифа: `rates` — валюта списания, `ratesCny` — прайс
 * юаневого периода (у DeepSeek два своих прайса, и это не пересчёт по курсу).
 */
fun rateFor(tariff: ProviderTariff?, modelId: String?): ProviderRate? {
    if (tariff == null || modelId.isNullOrBlank()) return null
    val id = modelId.trim().lowercase().substringAfterLast('/')
    val canonical = tariff.aliases[id] ?: id
    val cny = tariff.currency.equals("CNY", ignoreCase = true)
    val table = if (cny) tariff.ratesCny.ifEmpty { tariff.rates } else tariff.rates
    return table[canonical] ?: table[id]
}

/**
 * Пик ли это по правилам провайдера. [atIso] — момент начала вызова модели.
 * День недели и час считаются по UTC: в местном времени окна съезжают.
 */
fun isPeakAt(atIso: String?, rules: ProviderPeakRules?): Boolean {
    if (atIso == null || rules == null) return false
    val millis = parseIsoMillis(atIso) ?: return false
    val day = floorDiv(millis, MILLIS_PER_DAY)
    val minutes = ((millis - day * MILLIS_PER_DAY) / 60_000L).toInt()
    val utcDate = runCatching { Instant.parse(atIso).toString().substringBefore('T') }.getOrNull()
    if (utcDate != null && utcDate in rules.holidays) return false
    // 1970-01-01 был четвергом: сдвиг 4 приводит эпоху к getUTCDay (0 — воскресенье).
    val weekday = floorMod(day + 4, 7L).toInt()
    if (rules.weekdaysUtc.isNotEmpty() && weekday !in rules.weekdaysUtc) return false
    return rules.windowsUtc.any { window ->
        val from = minutesOfDay(window.from) ?: return@any false
        val to = minutesOfDay(window.to) ?: return@any false
        minutes >= from && minutes < to
    }
}

/** Строка под ответом; null — считать нечего (нет usage или модель без тарифа). */
fun usageLine(
    usage: AnswerUsage?,
    modelId: String?,
    atIso: String?,
    pricing: UsagePricing?,
): UsageLine? {
    if (usage == null || usage.total <= 0) return null
    val tokens = tokenText(usage.total)
    val tariff = pricing?.tariff
    val rate = rateFor(tariff, modelId)
    if (rate == null) return UsageLine(text = tokens, peak = false)
    val peak = isPeakAt(atIso, tariff?.peak)
    val multiplier = if (peak) (tariff?.multiplier ?: 1.0) else 1.0
    val amount = (usage.hit * (rate.hit ?: 0.0) + usage.miss * (rate.miss ?: 0.0) + usage.out * (rate.out ?: 0.0)) /
        TOKENS_PER_UNIT * multiplier
    val currency = tariff?.currency?.uppercase()
    val symbol = moneySymbol(currency)
    val parts = buildList {
        add(tokens)
        add(if (amount < 0.0001) "<$symbol${fixed(0.0001, 4)}" else "$symbol${fixed(amount, moneyDigits(amount))}")
        val rubPerUnit = pricing?.rubPerUnit
        if (rubPerUnit != null && rubPerUnit > 0) add("≈ ${fixed(amount * rubPerUnit, 2)} ₽")
    }
    return UsageLine(text = parts.joinToString(" · "), peak = peak, currency = currency)
}

private const val MILLIS_PER_DAY = 86_400_000L

/** 1M токенов: ставки тарифа заданы за миллион. */
private const val TOKENS_PER_UNIT = 1_000_000.0

private fun moneySymbol(currency: String?): String = when (currency) {
    "CNY" -> "¥"
    "USD" -> "$"
    else -> ""
}

private fun moneyDigits(amount: Double): Int = when {
    amount >= 1 -> 2
    amount >= 0.1 -> 3
    else -> 4
}

/** Токены: точные до 10K, дальше тысячи, миллионы и миллиарды суммарно. */
internal fun tokenText(total: Long): String = when {
    total < 10_000 -> "$total ток"
    total < 1_000_000 -> "${total / 1000}K ток"
    total < 1_000_000_000 -> "${fixed(total / 1_000_000.0, 1)}M ток"
    else -> "${trimZero(fixed(total / 1_000_000_000.0, 2))} млрд ток"
}

private fun trimZero(value: String): String = value.removeSuffix(".00").removeSuffix("0").removeSuffix(".")

/** Фиксированное число знаков без платформенного форматтера (общий код, JVM и iOS). */
internal fun fixed(value: Double, digits: Int): String {
    var scale = 1L
    repeat(digits) { scale *= 10 }
    val scaled = kotlin.math.round(value * scale).toLong()
    val whole = scaled / scale
    if (digits <= 0) return whole.toString()
    val fraction = (scaled % scale).let { if (it < 0) -it else it }.toString().padStart(digits, '0')
    return "$whole.$fraction"
}

private fun minutesOfDay(clock: String?): Int? {
    if (clock == null) return null
    val parts = clock.split(':')
    val hours = parts.getOrNull(0)?.toIntOrNull() ?: return null
    val minutes = parts.getOrNull(1)?.toIntOrNull() ?: 0
    return hours * 60 + minutes
}

private fun floorDiv(value: Long, divisor: Long): Long {
    val quotient = value / divisor
    return if (value % divisor != 0L && (value xor divisor) < 0) quotient - 1 else quotient
}

private fun floorMod(value: Long, divisor: Long): Long {
    val remainder = value % divisor
    return if (remainder < 0) remainder + divisor else remainder
}
