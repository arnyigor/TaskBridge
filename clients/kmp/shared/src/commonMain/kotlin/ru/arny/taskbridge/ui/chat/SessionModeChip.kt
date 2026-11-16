package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AssistChip
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.ui.theme.AppIcons

/** Режимы, между которыми переключается сессия, в порядке показа. */
internal val sessionModes = listOf("agent", "plan")

internal fun sessionModeLabel(mode: String?): String = if (mode == "plan") "Планирование" else "Агент"

/**
 * Режим относится к следующему сообщению, поэтому живёт в композере, а не
 * вкладками над лентой. Чип показывает текущий режим; меню — два пункта с
 * описанием: агент правит проект, планирование только читает.
 *
 * [blocked] объясняет, почему режим менять нельзя (ход идёт, проверка проекта
 * ещё выполняется). Пункты при этом остаются видимыми и выключенными: молча
 * неактивная кнопка не говорит ничего.
 */
@Composable
internal fun SessionModeChip(
    mode: String?,
    onPick: (String) -> Unit,
    blocked: String? = null,
    planBlocked: String? = null,
    /** Меняется при отправке — открытое меню должно закрыться, а не висеть над полем. */
    collapseKey: Any? = null,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    LaunchedEffect(collapseKey) { open = false }
    Box(modifier) {
        AssistChip(
            onClick = { open = true },
            label = { Text(sessionModeLabel(mode)) },
            trailingIcon = { Icon(AppIcons.ChevronDown, null, Modifier.size(16.dp)) },
            // Доступное имя: чип — единственный вход в смену режима, и скринридер
            // должен сказать, что он называет, а не только текущее значение.
            modifier = Modifier.semantics { contentDescription = "Режим сессии: ${sessionModeLabel(mode)}" },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (blocked != null) {
                Text(
                    blocked,
                    modifier = Modifier.widthIn(max = 260.dp).padding(horizontal = 16.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            for (candidate in sessionModes) {
                val reason = blocked ?: planBlocked?.takeIf { candidate == "plan" }
                DropdownMenuItem(
                    text = {
                        Column(Modifier.widthIn(max = 260.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Icon(
                                    if (candidate == "plan") AppIcons.Plan else AppIcons.Tool,
                                    null,
                                    Modifier.size(16.dp),
                                )
                                Text(sessionModeLabel(candidate))
                            }
                            Text(
                                if (candidate == "plan") "Только чтение: план без изменений проекта"
                                else "Правит проект и запускает проверки",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (reason != null) {
                                Text(
                                    reason,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                    },
                    enabled = reason == null && candidate != mode,
                    onClick = { open = false; onPick(candidate) },
                )
            }
        }
    }
}
