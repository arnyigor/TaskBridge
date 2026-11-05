package ru.arny.taskbridge.ui.settings

import ru.arny.taskbridge.core.api.ProviderMonth
import ru.arny.taskbridge.core.api.ProviderStatus
import ru.arny.taskbridge.ui.chat.fixed
import ru.arny.taskbridge.ui.chat.tokenText

/**
 * Вторая строка под DeepSeek: сколько токенов и денег уходит в день, сколько
 * вышло за месяц и насколько свежа история расходов.
 *
 * Три числа намеренно разделены, потому что это разные величины:
 *  - «в день» — темп по окну (3 дня, сервер отдаёт windowDays);
 *  - «за месяц» — прогноз по этому темпу, а не факт;
 *  - «факт месяца» — сумма, которая уже списана.
 * Прогноз показывается всегда, но рядом с ним стоит дата последней записи:
 * экстраполяция устаревшей истории — это прогноз по прошлому темпу, и читатель
 * должен видеть, на чём он построен, а не гадать, почему число не меняется.
 */
internal fun providerUsageDetail(status: ProviderStatus): String? {
    val tokens = status.tokens
    val month = status.month
    val history = status.costHistory
    if (tokens?.tokensPerDay == null && month == null) return null
    val lines = mutableListOf<String>()

    tokens?.tokensPerDay?.let { perDay ->
        val parts = mutableListOf<String>()
        parts += "${tokens.windowDays ?: 3} дн.: ${tokenText(perDay.toLong())}"
        tokens.rubPerDay?.let { parts += "≈${whole(it)} ₽/день" }
        status.pace?.monthlyRub?.let { parts += "за месяц ≈${whole(it)} ₽" }
        lines += parts.joinToString(" · ")
    }

    month?.let { facts -> monthLine(facts)?.let { lines += it } }

    // Дата последней записи — рядом с прогнозом, который из неё и посчитан.
    if (history?.stale == true && history.lastDay != null) {
        val age = history.ageDays
        val note = "история до ${shortDate(history.lastDay)}" + (age?.let { " ($it дн.)" }.orEmpty())
        if (lines.isEmpty()) lines += note else lines[lines.size - 1] += " · $note"
    }
    return lines.filter { it.isNotBlank() }.joinToString("\n").ifBlank { null }
}

private fun monthLine(facts: ProviderMonth): String? {
    val head = buildList {
        monthName(facts.key)?.let { add(it) }
        val from = facts.from?.takeLast(2)?.trimStart('0')
        val to = facts.to?.takeLast(2)?.trimStart('0')
        if (from != null && to != null) add("$from–$to")
    }.joinToString(" ")
    val parts = mutableListOf<String>()
    facts.tokens?.let { parts += tokenText(it.toLong()) }
    facts.cny?.let { cny ->
        val rub = facts.rub?.let { " ≈${whole(it)} ₽" }.orEmpty()
        parts += "¥${fixed(cny, 2)}$rub"
    }
    if (parts.isEmpty()) return null
    return if (head.isBlank()) parts.joinToString(" · ") else "$head: ${parts.joinToString(" · ")}"
}

/** Крупные суммы в рублях — целыми: копейки в оценке темпа ничего не решают. */
private fun whole(value: Double): String = fixed(value, 0)

/** «2026-09-21» → «21.09»: год в подписи не нужен. */
private fun shortDate(iso: String): String {
    val parts = iso.split('-')
    if (parts.size < 3) return iso
    return "${parts[2]}.${parts[1]}"
}

private val MONTHS = listOf(
    "январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
)

/** «2026-09» → «сентябрь». */
internal fun monthName(key: String?): String? {
    val month = key?.substringAfter('-')?.toIntOrNull() ?: return null
    return MONTHS.getOrNull(month - 1)
}
