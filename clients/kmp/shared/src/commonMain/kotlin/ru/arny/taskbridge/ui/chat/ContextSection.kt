package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.ContextSource
import ru.arny.taskbridge.core.api.SessionContextReport
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.ui.sessions.FieldLabel

/**
 * «Откуда контекст» и лимит контекста сессии — секция шита «Сессия».
 *
 * Отчёт приходит от сервера (`GET /api/tasks/:id/context`): он читает источники с
 * диска и числа самого Pi. Размеры источников — оценка (символы / 4, как считает
 * Pi), поэтому подпись «оценка» стоит рядом с числами, а не спрятана в коде.
 */
@Composable
internal fun ContextSection(
    taskId: String?,
    session: ChatSession,
) {
    val scope = rememberCoroutineScope()
    var report by remember(taskId) { mutableStateOf<SessionContextReport?>(null) }
    var failure by remember(taskId) { mutableStateOf<String?>(null) }
    var saving by remember(taskId) { mutableStateOf(false) }
    var summaryText by remember(taskId) { mutableStateOf<String?>(null) }
    var summaryLoading by remember(taskId) { mutableStateOf(false) }

    LaunchedEffect(taskId) {
        if (taskId == null) return@LaunchedEffect
        session.context().fold(
            onSuccess = { report = it; failure = null },
            onFailure = { failure = it.message ?: "Не удалось прочитать контекст" },
        )
    }
    if (taskId == null) return

    val save: (Long?) -> Unit = { limit ->
        if (!saving) {
            saving = true
            scope.launch {
                session.setContextLimit(limit).fold(
                    onSuccess = { report = it; failure = null },
                    onFailure = { failure = it.message ?: "Не удалось сохранить лимит" },
                )
                saving = false
            }
        }
    }

    FieldLabel("Откуда контекст", top = 20)
    val current = report
    if (current == null) {
        Text(
            failure ?: "Загрузка…",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }
    contextHeadline(current)?.let { headline ->
        Text(headline, style = MaterialTheme.typography.bodyLarge)
    }
    FieldLabel("Использование контекста", top = 12)
    current.usage?.measuredAt?.let { ContextValueRow("Измерение Pi", it) }
    current.usage?.sessionId?.let { ContextValueRow("Сессия измерения", it) }
    current.postCompaction?.measuredAt?.let { ContextValueRow("Время оценки Pi", it) }
    current.totalTokens?.let { total ->
        ContextValueRow(
            label = "Текущий размер контекста (Pi)",
            value = tokenCount(total),
        )
    }
    // CTX-03: у отсутствия измерения есть причина, и оценка после сжатия — не измерение.
    contextUnavailableLine(current)?.let { line ->
        Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    contextEstimateLine(current)?.let { line ->
        ContextValueRow(label = "Контекст после сжатия", value = line)
    }
    FieldLabel("Содержимое после compact", top = 12)
    current.session?.takeIf { !it.available }?.let {
        Text("Состав недоступен: ${it.reason ?: "нет данных"}", style = MaterialTheme.typography.bodySmall)
    }
    contextBranchLine(current)?.let { ContextValueRow("Ветка контекста", it) }
    current.session?.checkpoint?.takeIf { it.messages > 0 }?.let { ContextValueRow("Системный checkpoint (JSON)", "${it.messages} сообщ. · ${charCount(it.chars)} симв.") }
    current.session?.active?.retained?.let { ContextValueRow("Сохранено при сжатии", "${it.messages} сообщ. · ${charCount(it.chars)} симв.") }
    current.session?.active?.added?.let { ContextValueRow("Добавлено после сжатия", "${it.messages} сообщ. · ${charCount(it.chars)} симв.") }
    contextKeptLine(current)?.let { line ->
        ContextValueRow(label = "В контексте после сжатия", value = line)
    }
    contextSummaryLine(current)?.let { line ->
        ContextValueRow(label = "Сводка сжатия", value = line)
    }
    contextExcludedLine(current)?.let { line ->
        ContextValueRow(label = "Исключено из контекста", value = line)
    }
    current.session?.note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    TextButton(onClick = {
        if (summaryText != null) summaryText = null
        else if (!summaryLoading) {
            summaryLoading = true
            scope.launch {
                session.contextSummary().fold(
                    onSuccess = { summaryText = if (it.available) it.summary else it.reason ?: "Сводка недоступна." },
                    onFailure = { summaryText = it.message ?: "Не удалось прочитать сводку" },
                )
                summaryLoading = false
            }
        }
    }, enabled = !summaryLoading) {
        Text(if (summaryLoading) "Загрузка…" else if (summaryText != null) "Скрыть сводку" else "Прочитать сводку сжатия")
    }
    summaryText?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.bodySmall) } }
    FieldLabel("Статические источники (оценка, символы / 4)", top = 12)
    // Источники: то, что читается с диска. Итог и остаток — из чисел Pi.
    for (source in current.sources) ContextSourceRow(source)
    // Сумма источников — то, сколько статический контекст занимает по оценке;
    // рядом — размер текущего запроса от Pi, чтобы обе цифры можно было сверить.
    if (current.measuredTokens > 0) {
        ContextValueRow(
            label = "Сумма источников (оценка)",
            value = "≈ ${tokenCount(current.measuredTokens)}",
        )
    }
    if (current.usage?.stale == true) {
        Text(
            "Последнее измерение — до последнего сжатия: оно относится к прежней истории.",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
    // «Остаток 0» при переоценке источников читался бы как «истории нет вообще».
    current.unaccountedTokens?.takeIf { !current.overestimated }?.let { rest ->
        ContextValueRow(
            label = "Прочие источники и история (приблизительная разность)",
            value = "≈ " + tokenCount(rest),
        )
    }
    if (current.overestimated) {
        Text(
            "Оценка источников больше, чем Pi насчитал на этом ходу.",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
    current.note?.takeIf { it.isNotBlank() }?.let { note ->
        Text(
            note,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp),
        )
    }

    Text("Разность включает погрешность оценок и неучтённые источники; это не отдельное измерение истории.", style = MaterialTheme.typography.bodySmall)
    FieldLabel("Информация о сжатии", top = 12)
    current.postCompaction?.let { last ->
        last.measuredAt?.let { ContextValueRow("Последнее успешное сжатие", it) }
        last.reason?.let { ContextValueRow("Причина", it) }
        compactionChangeLine(last.tokensBefore, last.tokens)?.let { ContextValueRow("Изменение размера (оценка)", it) }
        contextFreedLine(current)?.let { ContextValueRow("Потенциально освобождено (оценка)", it) }
    } ?: Text("Успешное сжатие ещё не зафиксировано.", style = MaterialTheme.typography.bodySmall)
    FieldLabel("Лимит контекста", top = 20)
    var draft by remember(current.limit.tokens) { mutableStateOf(current.limit.tokens?.toString() ?: "") }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it.filter(Char::isDigit).take(9) },
            placeholder = { Text("без лимита") },
            singleLine = true,
            modifier = Modifier.weight(1f),
        )
        TextButton(
            onClick = { save(draft.toLongOrNull()) },
            enabled = !saving && draft.toLongOrNull() != current.limit.tokens,
        ) { Text("Сохранить") }
        if (current.limit.tokens != null) {
            TextButton(onClick = { draft = ""; save(null) }, enabled = !saving) { Text("Снять") }
        }
    }
    Text(
        "TaskBridge сам сжимает историю в конце хода, когда Pi оценивает контекст выше лимита. " +
            "Это настройка TaskBridge, а не Pi: Pi сжимает только по размеру окна модели.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 6.dp),
    )
    current.compaction?.let { compaction ->
        Text(
            contextCompactionLine(compaction.auto, compaction.triggerAt),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp),
        )
    }
    failure?.let { message ->
        Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun ContextSourceRow(source: ContextSource) {
    ContextValueRow(
        label = source.label ?: source.id,
        value = contextSourceValue(source),
    )
}

@Composable
private fun ContextValueRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(8.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.End,
            modifier = Modifier.weight(1f))
    }
}

/**
 * Почему текущего размера нет: «сессия не активна» и «Pi ещё не ответил» — разные
 * состояния, и общее «нет числа» их не различает (CTX-03).
 */
internal fun contextUnavailableLine(report: SessionContextReport): String? {
    if (report.totalTokens != null) return null
    val reason = report.usage?.unavailableReason?.takeIf { it.isNotBlank() }
    return if (reason != null) "Текущий размер недоступен: $reason." else "Размера текущего запроса ещё нет."
}

/**
 * CTX-02 на экране: сколько сообщений и символов реально осталось в контексте.
 * Когда состав недоступен, причина называется, а не выдаётся за «пусто».
 */
internal fun contextBranchLine(report: SessionContextReport): String? {
    val composition = report.session?.takeIf { it.available } ?: return null
    return when (composition.branchSource) {
        "pi-leaf" -> "активная ветка Pi · leaf ${composition.leafId ?: "пусто"}"
        "file-tail" -> "последняя запись файла; активная ветка Pi не подтверждена"
        else -> null
    }
}

internal fun contextKeptLine(report: SessionContextReport): String? {
    val composition = report.session ?: return null
    if (!composition.available) return null
    val kept = composition.active?.kept ?: return null
    val tools = if (kept.toolResults > 0) " · результатов инструментов: ${kept.toolResults}" else ""
    return "${kept.messages} сообщ. · ${charCount(kept.chars)} симв.$tools"
}

internal fun contextSummaryLine(report: SessionContextReport): String? {
    val compaction = report.session?.takeIf { it.available }?.compaction ?: return null
    if (!compaction.summaryAvailable) return null
    val before = compaction.tokensBefore?.let { " · до сжатия ${tokenCount(it)} ток." }.orEmpty()
    return "${charCount(compaction.summaryChars)} симв.$before"
}

internal fun contextExcludedLine(report: SessionContextReport): String? {
    val history = report.session?.takeIf { it.available }?.history ?: return null
    if (history.excludedMessages <= 0) return null
    return "${history.excludedMessages} сообщ. · ${charCount(history.excludedChars)} симв."
}

/** «≈78.8K (оценка Pi)» — estimatedTokensAfter, подписанный как оценка. */
internal fun contextEstimateLine(report: SessionContextReport): String? {
    val tokens = report.postCompaction?.tokens ?: return null
    return "≈ ${tokenCount(tokens)} (оценка Pi)"
}

/** «60K из 200K · 30%» — то же число, что Pi показывает в своём футере. */
internal fun contextHeadline(report: SessionContextReport): String? {
    val tokens = report.totalTokens ?: return null
    val percent = report.usage?.percent?.let { " · ${it.toInt()}%" }.orEmpty()
    val limit = report.limit.tokens
    val limitPart = if (limit != null) " · лимит ${tokenCount(limit)}" else ""
    val exceeded = if (report.limit.exceeded) " — выше лимита" else ""
    return "Всего в запросе: ${tokenCount(tokens)} токенов" +
        (report.contextWindow?.let { " из ${tokenCount(it)}" }.orEmpty()) + percent + limitPart + exceeded
}

/**
 * Размер одного источника или «не измеряется». Ноль вместо неизвестного размера
 * читался бы как «источник пуст», а это разные вещи: базовые инструкции Pi и то,
 * что дописывают расширения, снаружи не посчитать.
 */
internal fun contextSourceValue(source: ContextSource): String = when {
    !source.known || source.tokens == null -> "не измеряется"
    source.count != null && source.count > 0 -> "${tokenCount(source.tokens)} · ${source.count} шт."
    else -> tokenCount(source.tokens)
}

internal fun contextCompactionLine(auto: Boolean?, triggerAt: Long?): String = when {
    auto == false -> "Автосжатие Pi выключено — порог по окну модели не применяется."
    triggerAt != null -> "Автосжатие Pi: свой порог ${tokenCount(triggerAt)} токенов (окно минус резерв ответа)."
    else -> "Автосжатие Pi включено."
}

/** Токены в подписи: до 10K — точно, дальше в тысячах (как в остальных подписях). */
/**
 * Символы, а не токены: «250K токенов» и «250K символов» — разные величины, и
 * подменять одну другой нельзя (CTX-02/CTX-03).
 */
internal fun charCount(chars: Long?): String = when {
    chars == null -> "—"
    chars < 10_000 -> chars.toString()
    else -> "${chars / 1000}K"
}

internal fun tokenCount(tokens: Long?): String = when {
    tokens == null -> "—"
    tokens < 10_000 -> tokens.toString()
    else -> "${tokens / 1000}K"
}

/** A difference involving an estimate is not measured savings. */
internal fun contextFreedLine(report: SessionContextReport): String? {
    val before = report.postCompaction?.tokensBefore ?: return null
    val after = report.postCompaction.tokens ?: return null
    return "≈ ${tokenCount((before - after).coerceAtLeast(0))} ток. Это не измеренная экономия."
}
