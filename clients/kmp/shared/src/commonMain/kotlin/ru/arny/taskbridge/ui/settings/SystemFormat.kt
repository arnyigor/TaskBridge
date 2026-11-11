package ru.arny.taskbridge.ui.settings

import ru.arny.taskbridge.core.api.SystemCpu
import ru.arny.taskbridge.core.api.SystemGpu
import ru.arny.taskbridge.core.api.SystemRam
import ru.arny.taskbridge.ui.common.formatBytes
import kotlin.math.roundToInt

/**
 * Подписи железа для настроек: «сколько ГБ», «сколько ядер», «сколько ватт».
 *
 * Отдельный файл, потому что это формат ответа сервера, а не разметка.
 */

internal fun ramLabel(ram: SystemRam): String {
    val used = ram.used
    val total = ram.total
    if (used == null || total == null) return "нет данных"
    val percent = ram.ratio?.let { " (${(it * 100).roundToInt()}%)" }.orEmpty()
    return "${formatBytes(used)} / ${formatBytes(total)}$percent"
}

internal fun cpuLabel(cpu: SystemCpu): String {
    val load = cpu.load?.let { "${(it * 100).roundToInt()}%" } ?: "—"
    return cpu.cores?.let { "$load ($it ядер)" } ?: load
}

internal fun gpuLabel(gpu: SystemGpu): String {
    val mem = if (gpu.memoryUsedMb != null && gpu.memoryTotalMb != null) {
        "${(gpu.memoryUsedMb * 10 / 1024) / 10.0} / ${(gpu.memoryTotalMb * 10 / 1024) / 10.0} ГБ"
    } else {
        null
    }
    val power = gpu.powerDrawW?.let { "${number(it)} Вт" + (gpu.powerLimitW?.let { limit -> " / ${number(limit)} Вт" }.orEmpty()) }
    val parts = listOfNotNull(
        mem,
        gpu.utilization?.let { "${number(it)}%" },
        power,
        gpu.temperatureC?.let { "${number(it)} °C" },
    )
    return listOfNotNull(gpu.name?.takeIf { it.isNotBlank() }?.let { "$it: " }.orEmpty().takeIf { it.isNotEmpty() }, parts.joinToString(" · ").takeIf { it.isNotEmpty() })
        .joinToString("")
        .ifBlank { "нет данных" }
}

internal fun number(value: Double?): String = value?.let {
    if (it % 1.0 == 0.0) it.toLong().toString() else ((it * 100).toLong() / 100.0).toString()
} ?: "—"

