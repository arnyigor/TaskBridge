package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors

/**
 * Шаг C-A: состояние молчания хода для баннера.
 *
 * silentMs считает сервер (клиент не вычитает часы другого устройства),
 * порог по умолчанию — 120 с (как в web). Молчание сообщается только для
 * живого хода: терминальная сессия молчать не может.
 */
data class SilenceState(val totalMs: Long, val stage: String?, val waitingModelMs: Long? = null) {
    // waitingModelMs != null — запрос ещё не начал отвечать потоком (нет ни одного
    // кадра ответа); подпись одна в обоих случаях, таймер общий — молчание хода.
    val label: String
        get() = "Модель молчит ${mmss(totalMs)}"

    /** Стадия для подписи баннера; null — «стадия неизвестна». Правило было в композабле. */
    val displayStage: String?
        get() = stage?.takeIf { it.isNotBlank() && it !in SilenceStageNoise }
}

// Служебные стадии не про модель: «Pi is working» — заглушка agent_start.
private val SilenceStageNoise = setOf("Pi is working", "Pi starting")

internal fun silenceState(task: Task?, thresholdMs: Long = 120_000L): SilenceState? {
    // A quiet tool/compaction/provider retry is a known activity, not a silent model.
    if (task?.status != "RUNNING" ||
        task.providerWait != null ||
        task.runtime?.activity in setOf("tool", "compacting", "waiting_model")) return null
    val silent = task?.turnState?.silentMs?.takeIf { it >= thresholdMs } ?: return null
    return SilenceState(silent, task.turnState?.stage?.takeIf { it.isNotBlank() }, task.turnState?.waitingModelMs)
}

@Composable
internal fun SilenceBanner(silence: SilenceState, onWait: () -> Unit, onStop: () -> Unit, onRestart: () -> Unit) {
    val colors = LocalStatusColors.current
    // На узком экране кнопки в Row вытесняли текст до одного слова на строку:
    // заголовок и пояснение идут во всю ширину, действия — отдельной строкой.
    Surface(Modifier.fillMaxWidth(), color = colors.waiting.copy(alpha = 0.12f)) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(AppIcons.Alert, null, tint = colors.waiting, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text(silence.label, style = MaterialTheme.typography.labelLarge, color = colors.waiting)
            }
            Text(
                "Последний прогресс: ${silence.displayStage ?: "стадия неизвестна"}. Ход может быть просто долгим.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onWait) { Text("Подождать") }
                // Перезапуск — не «повторить»: промпт сам не переотправится (план 4.2/C-A).
                TextButton(onClick = onRestart) { Text("Перезапустить") }
                TextButton(onClick = onStop) { Text("STOP", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}
