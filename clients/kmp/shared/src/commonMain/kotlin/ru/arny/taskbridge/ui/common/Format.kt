package ru.arny.taskbridge.ui.common

import ru.arny.taskbridge.platform.PlatformServices
import kotlin.time.Instant

fun parseIsoMillis(iso: String?): Long? = iso?.let { runCatching { Instant.parse(it).toEpochMilliseconds() }.getOrNull() }

/** "только что", "5 мин", "14:03", "вчера", "12 сент." */
fun relativeTime(platform: PlatformServices, iso: String?, nowMillis: Long): String {
    val millis = parseIsoMillis(iso) ?: return ""
    val diff = nowMillis - millis
    val minute = 60_000L
    val day = 24 * 60 * minute
    return when {
        diff < minute -> "только что"
        diff < 60 * minute -> "${diff / minute} мин"
        diff < day && platform.formatDate(millis) == platform.formatDate(nowMillis) -> platform.formatClock(millis)
        diff < 2 * day -> "вчера"
        else -> platform.formatDate(millis)
    }
}

/** "14:03" or "14:03–14:05" for an answer that took a while. */
fun timeRange(platform: PlatformServices, startIso: String?, endIso: String?): String {
    val start = parseIsoMillis(startIso) ?: return ""
    val end = parseIsoMillis(endIso)
    val first = platform.formatClock(start)
    if (end == null) return first
    val seconds = (end - start) / 1000
    val duration = when {
        seconds < 1 -> ""
        seconds < 60 -> " · ${seconds} с"
        else -> " · ${seconds / 60} мин ${seconds % 60} с"
    }
    return first + duration
}

/** Абсолютный момент в местном времени: «9 окт., 06:12». */
fun formatMoment(platform: PlatformServices, millis: Long): String =
    "${platform.formatDate(millis)}, ${platform.formatClock(millis)}"

private const val SECOND_MS = 1_000L
private const val MINUTE_MS = 60 * SECOND_MS
private const val HOUR_MS = 60 * MINUTE_MS
private const val DAY_MS = 24 * HOUR_MS

/**
 * Возраст события: «только что», «12 с назад», «5 мин назад», «2 ч назад», а
 * старше суток — через [absolute] («9 окт., 06:12»). null — даты нет или она не разобралась.
 *
 * В диагностике нужны именно секунды: «только что» одинаково и для 0,2 с, и для
 * 55 с тишины, а по ним как раз и видно, что поток встал. Это не [relativeTime]:
 * там у сообщений в ленте своя шкала («14:03», «вчера»).
 */
fun sinceLabel(iso: String?, nowMillis: Long, absolute: (Long) -> String): String? {
    val millis = parseIsoMillis(iso) ?: return null
    val diff = (nowMillis - millis).coerceAtLeast(0)
    return when {
        diff < 3 * SECOND_MS -> "только что"
        diff < MINUTE_MS -> "${diff / SECOND_MS} с назад"
        diff < HOUR_MS -> "${diff / MINUTE_MS} мин назад"
        diff < DAY_MS -> "${diff / HOUR_MS} ч назад"
        else -> absolute(millis)
    }
}

/**
 * Длительность человеческими единицами: «34 с», «12 мин 5 с», «4 ч 12 мин», «3 дн. 5 ч».
 * У дней и часов минуты опускаются: «3 дн. 5 ч» точнее не нужно.
 */
fun humanDuration(millis: Long): String {
    val total = millis.coerceAtLeast(0) / 1000
    val days = total / 86_400
    val hours = (total % 86_400) / 3_600
    val minutes = (total % 3_600) / 60
    val seconds = total % 60
    return when {
        days > 0 -> "$days дн. $hours ч"
        hours > 0 -> "$hours ч $minutes мин"
        minutes > 0 -> if (seconds > 0) "$minutes мин $seconds с" else "$minutes мин"
        else -> "$seconds с"
    }
}

fun formatBytes(bytes: Long?): String = when {
    bytes == null -> ""
    bytes < 1024 -> "$bytes Б"
    bytes < 1024 * 1024 -> "${bytes / 1024} КБ"
    // ГБ нужен для RAM машины (/api/info.system.ram — байты): без него 64 ГБ
    // печатались как «64 000.0 МБ».
    bytes < 1024L * 1024 * 1024 -> "${(bytes * 10 / (1024 * 1024)) / 10.0} МБ"
    else -> "${(bytes * 10 / (1024L * 1024 * 1024)) / 10.0} ГБ"
}

/** Where a message came from, from its client id: android-…, desktop-…, the web UI, the CLI. */
fun sourceLabel(clientId: String?, ownClientId: String): String? = when {
    clientId == null -> null
    clientId == ownClientId -> null
    clientId.startsWith("android") -> "с Android"
    clientId.startsWith("desktop") -> "с Desktop"
    clientId.startsWith("cli") -> "из терминала"
    clientId.startsWith("cloud") -> "через облако"
    // Сообщение контроллера Follow Plan: его не печатал ни один клиент, и «из
    // браузера» здесь было просто неправдой (живой отчёт 2026-10-28 — Desktop
    // подписал инструкцию плана как пришедшую из браузера).
    clientId.startsWith("follow-plan") -> "по плану"
    else -> "из другого клиента"
}
