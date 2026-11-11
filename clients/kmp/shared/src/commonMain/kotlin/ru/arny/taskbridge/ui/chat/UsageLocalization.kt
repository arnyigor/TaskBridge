package ru.arny.taskbridge.ui.chat

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.stringResource
import org.jetbrains.compose.resources.pluralStringResource
import taskbridge.shared.generated.resources.*

internal expect fun usageInteger(value: Long, languageTag: String): String
internal expect fun usageDecimal(value: Double, digits: Int, languageTag: String): String

internal data class UsageLabels(
    val title: String,
    val summary: String,
    val provider_model: String,
    val cache_hit: String,
    val uncached: String,
    val cached: String,
    val cache_write: String,
    val output: String,
    val duration: String,
    val ttft: String,
    val speed: String,
    val cost: String,
    val peak: String,
    val status: String,
    val interrupted: String,
    val failed: String,
    val copy: String,
    val close: String,
    val local: String,
    val tokens: String,
    val seconds: String,
    val billion: String,
    val expanded: String,
    val collapsed: String,
    val details: String,
    val total: String,
    val yes: String,
    val segments: String,
    val peakBadge: String,
)

@Composable
internal fun usageLabels(segments: Int = 0, multiplier: String = "2"): UsageLabels = UsageLabels(
    title = stringResource(Res.string.usage_title),
    summary = stringResource(Res.string.usage_summary),
    provider_model = stringResource(Res.string.usage_provider_model),
    cache_hit = stringResource(Res.string.usage_cache_hit),
    uncached = stringResource(Res.string.usage_uncached),
    cached = stringResource(Res.string.usage_cached),
    cache_write = stringResource(Res.string.usage_cache_write),
    output = stringResource(Res.string.usage_output),
    duration = stringResource(Res.string.usage_duration),
    ttft = stringResource(Res.string.usage_ttft),
    speed = stringResource(Res.string.usage_speed),
    cost = stringResource(Res.string.usage_cost),
    peak = stringResource(Res.string.usage_peak),
    status = stringResource(Res.string.usage_status),
    interrupted = stringResource(Res.string.usage_interrupted),
    failed = stringResource(Res.string.usage_failed),
    copy = stringResource(Res.string.usage_copy),
    close = stringResource(Res.string.usage_close),
    local = stringResource(Res.string.usage_local),
    tokens = stringResource(Res.string.usage_tokens),
    seconds = stringResource(Res.string.usage_seconds),
    billion = stringResource(Res.string.usage_billion),
    expanded = stringResource(Res.string.usage_expanded),
    collapsed = stringResource(Res.string.usage_collapsed),
    details = stringResource(Res.string.usage_details),
    total = stringResource(Res.string.usage_total),
    yes = stringResource(Res.string.usage_yes),
    segments = pluralStringResource(Res.plurals.usage_segments, segments, segments),
    peakBadge = stringResource(Res.string.usage_peak_badge, multiplier),
)

internal data class UsagePresentation(
    val summary: String,
    val total: String?,
    val rows: List<Pair<String, String>>,
    val copyText: String,
)

/** One presentation supplies both the visual rows and clipboard text. No network or client clock. */
internal fun presentUsage(
    details: UsageDetails,
    labels: UsageLabels,
    languageTag: String,
    segments: Int = 0,
    status: String? = null,
): UsagePresentation {
    fun tokens(value: Long) = "${usageInteger(value, languageTag)} ${labels.tokens}"
    fun decimal(value: Double, digits: Int) = usageDecimal(value, digits, languageTag)
    fun duration(ms: Long): String = when {
        ms < 1000 -> "${decimal(ms / 1000.0, 1)} ${labels.seconds}"
        ms < 60_000 -> "${usageInteger(ms / 1000, languageTag)} ${labels.seconds}"
        else -> durationText(ms) // clock notation is language independent (m:ss or h:mm:ss).
    }
    fun money(text: String): String = Regex("[0-9]+[.][0-9]+").replace(text) { number ->
        val digits = number.value.substringAfter('.').length
        decimal(number.value.toDouble(), digits)
    }
    val usage = details.usage
    val metrics = details.metrics
    val totalValue = usage?.total?.takeIf { it >= 0 }
    val total = totalValue?.let(::tokens)
    val duration = metrics?.durationMs?.takeIf { it >= 0 }?.let(::duration)
    val compact = totalValue?.let { n ->
        val value = when {
            n < 10_000 -> usageInteger(n, languageTag)
            n < 1_000_000 -> "${usageInteger(n / 1000, languageTag)}K"
            n < 1_000_000_000 -> "${decimal(n / 1_000_000.0, 1)}M"
            else -> "${decimal(n / 1_000_000_000.0, 1)} ${labels.billion}"
        }
        "$value ${labels.tokens}"
    }
    val cost = details.cost?.let(::money)
    val summary = listOfNotNull(compact, duration, cost).joinToString(" · ")
    val rows = buildList {
        details.modelId?.let { add(labels.provider_model to if (details.local) "$it · ${labels.local}" else it) }
        val hit = usage?.hit
        val miss = usage?.miss
        if (hit != null && miss != null && hit >= 0 && miss >= 0 && (hit > 0 || miss > 0)) {
            add(labels.cache_hit to "${decimal(hit.toDouble() / (hit.toDouble() + miss.toDouble()) * 100.0, 1)}%")
        }
        miss?.takeIf { it >= 0 }?.let { add(labels.uncached to tokens(it)) }
        hit?.takeIf { it >= 0 }?.let { add(labels.cached to tokens(it)) }
        usage?.cacheWrite?.takeIf { it >= 0 }?.let { add(labels.cache_write to tokens(it)) }
        usage?.out?.takeIf { it >= 0 }?.let { add(labels.output to tokens(it)) }
        duration?.let { add((if (segments > 1) "${labels.duration} (${labels.segments})" else labels.duration) to it) }
        metrics?.firstTokenMs?.takeIf { it >= 0 && (metrics.durationMs == null || it <= metrics.durationMs) }
            ?.let { add(labels.ttft to duration(it)) }
        // Never divide by whole-turn time: it includes tool execution and is not generation time.
        metrics?.outputTokensPerSecond?.takeIf { it.isFinite() && it >= 0 }?.let {
            add(labels.speed to "${decimal(it, if (it < 10) 1 else 0)} ${labels.tokens}/${labels.seconds}")
        }
        cost?.let { add(labels.cost to it) }
        if (details.peak) add(labels.peak to "${labels.yes} (×${decimal(details.multiplier, if (details.multiplier % 1.0 == 0.0) 0 else 1)})")
        status?.let { add(labels.status to it) }
    }
    val copy = (listOf(labels.title) + listOfNotNull(total?.let { "${labels.total}: $it" }) + rows.map { "${it.first}: ${it.second}" }).joinToString("\n")
    return UsagePresentation("${labels.summary} $summary".trim(), total, rows, copy)
}
