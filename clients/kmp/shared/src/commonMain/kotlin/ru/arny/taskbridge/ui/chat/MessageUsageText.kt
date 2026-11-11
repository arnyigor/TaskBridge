package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.ProviderPeakRules
import ru.arny.taskbridge.core.api.ProviderRate
import ru.arny.taskbridge.core.api.ProviderTariff
import ru.arny.taskbridge.core.api.TurnMetrics
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

/** Строка под ответом; null — считать нечего (нет ни usage, ни времени хода). */
fun usageLine(
    usage: AnswerUsage?,
    modelId: String?,
    atIso: String?,
    pricing: UsagePricing?,
    metrics: TurnMetrics? = null,
): UsageLine? {
    val hasUsage = (usage?.total ?: 0L) > 0
    val duration = metrics?.durationMs?.takeIf { it >= 0 }
    if (!hasUsage && duration == null) return null
    val tokens = if (hasUsage) tokenText(usage?.total ?: 0L) else null
    val tariff = pricing?.tariff
    val rate = if (hasUsage) rateFor(tariff, modelId) else null
    val peak = rate != null && isPeakAt(atIso, tariff?.peak)
    val parts = buildList {
        if (tokens != null) add(tokens)
        if (duration != null) add(durationText(duration))
        addAll(costParts(usage, rate, tariff, pricing, peak))
    }
    return UsageLine(text = parts.joinToString(" · "), peak = peak, currency = tariff?.currency?.uppercase())
}

/**
 * Стоимость хода одной формулой: ею пользуются и свёрнутая подпись, и таблица,
 * чтобы числа в них не могли разойтись. Отдельные части — чтобы подпись ставила
 * между валютой и рублями тот же разделитель, что и раньше.
 */
private fun costParts(usage: AnswerUsage?, rate: ProviderRate?, tariff: ProviderTariff?, pricing: UsagePricing?, peak: Boolean): List<String> {
    if (usage == null || rate == null) return emptyList()
    if (listOfNotNull(rate.hit, rate.miss, rate.out, tariff?.multiplier).any { !it.isFinite() || it < 0 }) return emptyList()
    val multiplier = if (peak) (tariff?.multiplier ?: 1.0) else 1.0
    val amount = ((usage.hit ?: 0) * (rate.hit ?: 0.0) + (usage.miss ?: 0) * (rate.miss ?: 0.0) + (usage.out ?: 0) * (rate.out ?: 0.0)) /
        TOKENS_PER_UNIT * multiplier
    if (!amount.isFinite() || amount < 0) return emptyList()
    val symbol = moneySymbol(tariff?.currency?.uppercase())
    val parts = mutableListOf(
        if (amount < 0.0001) "<$symbol${fixed(0.0001, 4)}" else "$symbol${fixed(amount, moneyDigits(amount))}",
    )
    val rubPerUnit = pricing?.rubPerUnit
    if (rubPerUnit != null && rubPerUnit.isFinite() && rubPerUnit > 0 && (amount * rubPerUnit).isFinite()) parts += "≈ ${fixed(amount * rubPerUnit, 2)} ₽"
    return parts
}

private const val MILLIS_PER_DAY = 86_400_000L

/**
 * Всё, что нужно для плашки и таблицы ресурсов за ход. Собирается один раз,
 * а не пересчитывается внутри каждой ячейки при рекомпозиции.
 */
data class UsageDetails(
    /** Свёрнутая подпись: «1.2M ток · 42 с · $0.0138 ≈ 1.12 ₽». */
    val text: String,
    val usage: AnswerUsage?,
    val metrics: TurnMetrics?,
    val modelId: String?,
    val local: Boolean,
    val peak: Boolean,
    val multiplier: Double,
    /** «$0.0138 ≈ 1.12 ₽»; null — тариф модели неизвестен. */
    val cost: String?,
)

/** Сборка данных таблицы; null — показывать нечего. */
fun usageDetails(
    usage: AnswerUsage?,
    modelId: String?,
    atIso: String?,
    pricing: UsagePricing?,
    metrics: TurnMetrics?,
    isLocal: Boolean? = null,
): UsageDetails? {
    val hasUsage = (usage?.total ?: 0L) > 0
    val hasDuration = metrics?.durationMs != null && metrics.durationMs >= 0
    if (!hasUsage && !hasDuration) return null
    val local = isLocal ?: (modelId != null && runsLocally(modelId))
    val tariff = pricing?.tariff
    val rate = if (hasUsage && !local) rateFor(tariff, modelId) else null
    val peak = rate != null && isPeakAt(atIso, tariff?.peak)
    val multiplier = if (peak) (tariff?.multiplier ?: 1.0) else 1.0
    val cost = costParts(usage, rate, tariff, pricing, peak)
        .takeIf { it.isNotEmpty() }?.joinToString(" · ")
    return UsageDetails(
        text = usageLine(usage, modelId, atIso, if (local) null else pricing, metrics)?.text.orEmpty(),
        usage = usage,
        metrics = metrics,
        modelId = modelId,
        local = local,
        peak = peak,
        multiplier = multiplier,
        cost = cost,
    )
}

/**
 * Модель исполняется локально — деньги не считаются и строка так и подписана.
 * Признак берётся только из идентификатора провайдера (`local/...`), а не из имени
 * модели: имя ничего не гарантирует.
 */
private fun runsLocally(modelId: String): Boolean {
    val id = modelId.lowercase()
    return id.startsWith("local/") || id.startsWith("local:")
}

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

// ---------------------------------------------------------------------------
// Ресурсы хода: время работы, TTFT, скорость, попадание в кэш.
// ---------------------------------------------------------------------------

/** Узкий неразрывный пробел: разделитель разрядов, который не рвётся переносом. */
private const val NBSP = '\u00A0'

private const val MILLIS_PER_HOUR = 3_600_000L
private const val MILLIS_PER_MINUTE = 60_000L

/** Точные токены: тысячи разделяются узким неразрывным пробелом. */
internal fun tokensExact(n: Long): String {
    val digits = n.toString()
    val grouped = buildString {
        digits.forEachIndexed { index, ch ->
            if (index > 0 && (digits.length - index) % 3 == 0 && ch.isDigit() && digits[0].isDigit()) append(NBSP)
            append(ch)
        }
    }
    return "$grouped ток"
}

/** Время хода: <1 с — один знак, <1 мин — целые, <1 ч — М:СС, >=1 ч — ЧЧ:ММ:СС. */
internal fun durationText(ms: Long): String = when {
    ms < 1000 -> "${fixed(ms / 1000.0, 1)} с"
    ms < MILLIS_PER_MINUTE -> "${ms / 1000} с"
    ms < MILLIS_PER_HOUR -> {
        val minutes = ms / MILLIS_PER_MINUTE
        val seconds = (ms % MILLIS_PER_MINUTE) / 1000
        "$minutes:${twoDigits(seconds)}"
    }
    else -> {
        val hours = ms / MILLIS_PER_HOUR
        val rest = ms % MILLIS_PER_HOUR
        val minutes = rest / MILLIS_PER_MINUTE
        val seconds = (rest % MILLIS_PER_MINUTE) / 1000
        "$hours:${twoDigits(minutes)}:${twoDigits(seconds)}"
    }
}

private fun twoDigits(value: Long): String = if (value < 10) "0$value" else value.toString()

/** Скорость генерации, если известны токены и длительность. */
internal fun tokensPerSecondText(out: Long?, durationMs: Long?): String? {
    val o = out ?: return null
    val d = durationMs ?: return null
    if (o <= 0 || d <= 0) return null
    val tps = o / (d / 1000.0)
    return if (tps < 10) "${fixed(tps, 1)} ток/с" else "${tps.toLong()} ток/с"
}

/** Попадание в кэш: cached / (cached + uncached) × 100, один знак. */
internal fun cacheHitText(cached: Long?, uncached: Long?): String? {
    val c = cached ?: return null
    val u = uncached ?: return null
    if (c < 0 || u < 0 || (c == 0L && u == 0L)) return null
    val hit = c.toDouble() / (c.toDouble() + u.toDouble()) * 100.0
    return "${fixed(hit, 1)}%"
}
