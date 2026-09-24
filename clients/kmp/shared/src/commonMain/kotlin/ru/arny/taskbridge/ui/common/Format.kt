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

fun formatBytes(bytes: Long?): String = when {
    bytes == null -> ""
    bytes < 1024 -> "$bytes Б"
    bytes < 1024 * 1024 -> "${bytes / 1024} КБ"
    else -> "${(bytes * 10 / (1024 * 1024)) / 10.0} МБ"
}

/** Where a message came from, from its client id: android-…, desktop-…, the web UI, the CLI. */
fun sourceLabel(clientId: String?, ownClientId: String): String? = when {
    clientId == null -> null
    clientId == ownClientId -> null
    clientId.startsWith("android") -> "с Android"
    clientId.startsWith("desktop") -> "с Desktop"
    clientId.startsWith("cli") -> "из терминала"
    clientId.startsWith("cloud") -> "через облако"
    else -> "из браузера"
}
