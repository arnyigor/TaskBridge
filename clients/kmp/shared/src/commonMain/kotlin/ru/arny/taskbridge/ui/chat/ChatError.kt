package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.ui.common.AdaptiveSheet
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors

internal fun isProviderErrorNotice(text: String): Boolean =
    text.startsWith("Провайдер") && text.contains("не принял запрос")

internal fun isProviderRetryNotice(text: String): Boolean =
    isProviderErrorNotice(text) && text.contains("Pi жив и повторит") && !text.contains("повторять не будет")

internal data class ProviderNoticeGroup(val notes: List<ChatItem.Note>, val recovered: Boolean) {
    val raw: String get() = notes.joinToString("\n\n") { it.text }
    val retrying: Boolean get() = isProviderRetryNotice(notes.last().text)
}

internal data class ErrorTimeline(val items: List<ChatItem>, val groups: Map<String, ProviderNoticeGroup>)

/** A presentation-only projection. Original IDs and individual messages remain available to search/selection. */
internal fun errorTimeline(items: List<ChatItem>, groupNotices: Boolean = true): ErrorTimeline {
    val visible = ArrayList<ChatItem>()
    val groups = LinkedHashMap<String, ProviderNoticeGroup>()
    var index = 0
    var precedingAnswer: ChatItem.Assistant? = null
    while (index < items.size) {
        val first = items[index++]
        visible += first
        when (first) {
            is ChatItem.User -> precedingAnswer = null
            is ChatItem.Assistant -> precedingAnswer = first
            is ChatItem.Note -> Unit
        }
        if (first !is ChatItem.Note || !isProviderErrorNotice(first.text)) continue
        val notes = mutableListOf(first)
        if (groupNotices) {
            while (index < items.size) {
                val next = items[index] as? ChatItem.Note ?: break
                if (!isProviderErrorNotice(next.text)) break
                notes += next
                index++
            }
        }
        // Provider notes can follow the assistant placeholder which later becomes the final answer.
        val answer = (items.getOrNull(index) as? ChatItem.Assistant) ?: precedingAnswer
        val recovered = answer != null && answer.final && answer.error == null &&
            answer.text.isNotBlank() && answer.status in setOf("DONE", "SUCCEEDED")
        groups[first.id] = ProviderNoticeGroup(notes, recovered)
    }
    return ErrorTimeline(visible, groups)
}

/** An unboxed status line; diagnostics never expand inside the chat timeline. */
@Composable
internal fun ChatErrorStatus(
    raw: String,
    onCopy: () -> Unit,
    modifier: Modifier = Modifier,
    notice: Boolean = false,
    active: Boolean = false,
    onRetry: (() -> Unit)? = null,
    retrying: Boolean = notice && isProviderRetryNotice(raw),
    count: Int = 1,
    recovered: Boolean = false,
) {
    var showDetails by remember(raw) { mutableStateOf(false) }
    val title = when {
        retrying && recovered -> "Провайдер снова ответил"
        // Historical notices must not claim that an old automatic retry is still running.
        retrying -> "Сбой провайдера · автоповтор"
        notice -> "Не удалось отправить запрос"
        else -> "Не удалось получить ответ"
    }
    val color = if (retrying) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (recovered) 0.7f else 1f)
        else MaterialTheme.colorScheme.error
    Row(
        modifier.fillMaxWidth().heightIn(min = 48.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (retrying) AppIcons.Refresh else AppIcons.Alert,
            null,
            Modifier.size(16.dp),
            tint = if (retrying && !recovered) LocalStatusColors.current.waiting else color,
        )
        Text(
            title + if (count > 1) " (×$count)" else "",
            style = MaterialTheme.typography.labelMedium,
            color = color,
            modifier = Modifier.weight(1f),
        )
        TextButton(
            onClick = { showDetails = true },
            modifier = Modifier.heightIn(min = 48.dp),
            contentPadding = PaddingValues(horizontal = 4.dp),
        ) { Text("Подробнее", style = MaterialTheme.typography.labelMedium) }
        if (onRetry != null && !active) {
            IconButton(onClick = onRetry) { Icon(AppIcons.Refresh, "Повторить запрос", Modifier.size(18.dp), tint = color) }
        }
    }
    if (showDetails) {
        AdaptiveSheet(
            title = title,
            onDismiss = { showDetails = false },
            footer = {
                FlowRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End)) {
                    TextButton(onClick = onCopy) { Text("Копировать ошибку") }
                    if (onRetry != null && !active) {
                        TextButton(onClick = { showDetails = false; onRetry() }) { Text("Повторить запрос") }
                    }
                    TextButton(onClick = { showDetails = false }) { Text("Закрыть") }
                }
            },
        ) {
            SelectionContainer { Text(raw, style = MaterialTheme.typography.bodySmall) }
        }
    }
}
