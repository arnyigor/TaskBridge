package ru.arny.taskbridge.ui.settings

import ru.arny.taskbridge.core.api.ApiInfo

/** Метрики роутера не определяют состояние внешних серверов (например, Strata). */
internal fun localModelStatusText(info: ApiInfo?): String {
    val models = info?.local?.models.orEmpty()
    val running = models.filter { it.status == "loaded" || it.status == "sleeping" }
    if (running.isNotEmpty()) {
        return "запущена: " + running.joinToString { it.name?.takeIf(String::isNotBlank) ?: it.id }
    }
    val loaded = (info?.local?.loaded.orEmpty() + info?.engine?.loaded.orEmpty()).distinct()
    if (loaded.isNotEmpty()) return "запущена: ${loaded.joinToString()}"
    val metrics = info?.engine?.metrics
    if (metrics?.available == true || metrics?.reason == "metrics-disabled") {
        return "запущена" + metrics.model?.let { ": $it" }.orEmpty()
    }
    if (models.any { it.status == "loading" } || info?.local?.loading?.isNotEmpty() == true) {
        return "загружается"
    }
    // no-model относится только к роутеру: внешний сервер может работать, пока
    // роутер пуст. Недоступность или неизвестный статус не означают остановку.
    if (models.isNotEmpty() && models.all { it.status == "unloaded" }) return "не запущена"
    return "состояние неизвестно"
}
