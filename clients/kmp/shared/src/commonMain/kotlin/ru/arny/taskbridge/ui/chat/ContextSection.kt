package ru.arny.taskbridge.ui.chat

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
    current.totalTokens?.let { total ->
        ContextValueRow(
            label = "Текущий размер контекста (Pi)",
            value = tokenCount(total),
        )
    }
    // «Остаток 0» при переоценке источников читался бы как «истории нет вообще».
    current.unaccountedTokens?.takeIf { !current.overestimated }?.let { rest ->
        ContextValueRow(
            label = "История диалога и расширения",
            value = tokenCount(rest) + " (остаток)",
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
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
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
internal fun tokenCount(tokens: Long?): String = when {
    tokens == null -> "—"
    tokens < 10_000 -> tokens.toString()
    else -> "${tokens / 1000}K"
}
