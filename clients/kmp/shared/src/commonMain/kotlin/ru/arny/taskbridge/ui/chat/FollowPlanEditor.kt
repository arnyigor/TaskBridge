package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.TaskBridgeApi

/** Edit the server file, not a device path. SSE never replaces the captured base or text. */
@Composable
internal fun FollowPlanEditor(
    state: FollowPlanUiState,
    api: TaskBridgeApi,
    newId: () -> String,
    scope: CoroutineScope,
) {
    val base = state.editorBase ?: return
    val dirty = state.editorText != base.content
    fun close() {
        if (state.editorSaving) return
        if (dirty) state.editorDiscard = true else state.editorBase = null
    }
    AlertDialog(
        onDismissRequest = { close() },
        title = { Text("Изменить план · revision ${base.revision}") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(base.path, style = MaterialTheme.typography.labelSmall)
                Text(if (dirty) "Есть несохранённые изменения" else "Изменений нет", style = MaterialTheme.typography.labelSmall)
                OutlinedTextField(
                    value = state.editorText,
                    onValueChange = { state.editorText = it },
                    enabled = !state.editorSaving,
                    label = { Text("Markdown плана на сервере") },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp, max = 340.dp),
                )
                if (state.editorError.isNotBlank()) {
                    Text(state.editorError, color = MaterialTheme.colorScheme.error)
                }
                state.editorCurrent?.let { current ->
                    Text("Версия в файле — черновик выше не изменён", style = MaterialTheme.typography.labelSmall)
                    OutlinedTextField(
                        value = current,
                        onValueChange = {},
                        readOnly = true,
                        modifier = Modifier.fillMaxWidth().heightIn(max = 180.dp),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(enabled = dirty && !state.editorSaving, onClick = {
                state.editorSaving = true
                scope.launch {
                    try {
                        state.status = api.savePlanContent(state.taskId, base, state.editorText, newId())
                        state.editorBase = null
                        state.notice = "План сохранён"
                    } catch (error: ApiException) {
                        state.editorError = planErrorText(error)
                        if (planErrorCode(error) == "PLAN_REVISION_CONFLICT") {
                            state.editorCurrent = runCatching { api.planContent(state.taskId).content }.getOrNull()
                        }
                    } catch (error: Exception) {
                        if (error is CancellationException) throw error
                        state.editorError = "Не удалось сохранить: проверьте соединение. Черновик сохранён."
                    } finally {
                        state.editorSaving = false
                    }
                }
            }) { Text(if (state.editorSaving) "Сохранение…" else "Сохранить") }
        },
        dismissButton = {
            TextButton(enabled = !state.editorSaving, onClick = { close() }) { Text("Отмена") }
        },
    )
    if (state.editorDiscard) {
        AlertDialog(
            onDismissRequest = { state.editorDiscard = false },
            title = { Text("Отменить несохранённые изменения?") },
            confirmButton = {
                TextButton(onClick = { state.editorDiscard = false; state.editorBase = null }) { Text("Отменить изменения") }
            },
            dismissButton = {
                TextButton(onClick = { state.editorDiscard = false }) { Text("Вернуться к правке") }
            },
        )
    }
}
