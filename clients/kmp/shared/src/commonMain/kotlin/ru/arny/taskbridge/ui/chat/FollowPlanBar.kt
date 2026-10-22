package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.PlanStatus
import ru.arny.taskbridge.core.api.TaskBridgeApi

/**
 * Переключатель «По плану» и компактная карточка плана в композиторе (FP-05C).
 *
 * Состояние — серверное: экран только перечитывает `GET /plan` и отправляет
 * команды с ревизией. Включение переключателя не запускает модель: сначала
 * подключается файл, ход начинается кнопкой «Продолжить».
 *
 * Выключение во время шага означает паузу на безопасной границе; STOP — отдельная
 * кнопка карточки.
 */
@Composable
fun FollowPlanBar(
    api: TaskBridgeApi,
    taskId: String,
    version: Long,
    newId: () -> String,
    scope: CoroutineScope,
    onOpenPlan: (String) -> Unit,
    onNotice: (String) -> Unit = {},
) {
    var status by remember(taskId) { mutableStateOf<PlanStatus?>(null) }
    var mode by remember(taskId) { mutableStateOf(false) }
    var notice by remember(taskId) { mutableStateOf("") }
    var askPath by remember(taskId) { mutableStateOf(false) }
    var pathInput by remember(taskId) { mutableStateOf("") }
    var pathProblem by remember(taskId) { mutableStateOf<String?>(null) }
    val model = planCardModel(status)

    // Re-read after every chat change: plan events are server facts, and the
    // version moves on any of them (PLAN_* arrive in the same stream).
    LaunchedEffect(taskId, version) {
        status = runCatching { api.plan(taskId) }.getOrNull() ?: status
        if (status?.attached == true) mode = true
    }

    fun command(run: suspend () -> PlanStatus) {
        scope.launch {
            try {
                val next = run()
                status = next
                mode = next.attached
                notice = ""
            } catch (error: ApiException) {
                // 409 PLAN_REVISION_CONFLICT arrives here: the operator changed the
                // file, so the card must show that instead of pretending to run.
                notice = error.error.message
            } catch (error: Throwable) {
                notice = error.message ?: "Команда плана не выполнена"
            }
        }
    }

    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            AssistChip(
                onClick = {
                    if (status?.attached != true) {
                        pathProblem = null
                        askPath = true
                        return@AssistChip
                    }
                    if (mode) {
                        // Off means "no further steps", never "kill this one".
                        if (planToggleOffAction(status) == "pause") command { api.pausePlan(taskId, newId()) }
                        mode = false
                    } else {
                        mode = true
                    }
                },
                label = { Text(FOLLOW_PLAN_LABEL) },
                colors = if (status?.attached == true && mode) {
                    AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.16f))
                } else {
                    AssistChipDefaults.assistChipColors()
                },
            )
            if (model.visible) {
                Text(
                    text = model.headline,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (model.visible) {
            Card(
                modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
            ) {
                Column(modifier = Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (model.goal.isNotBlank()) {
                        Text(model.goal, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    if (model.findings.isNotBlank()) {
                        Text(model.findings, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
                    }
                    val line = model.conflict ?: model.error ?: notice
                    if (!line.isNullOrBlank()) {
                        Text(line, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        for (action in model.actions) {
                            TextButton(onClick = {
                                when (action.id) {
                                    "start" -> {
                                        val paused = status?.state == "PAUSED" || status?.state == "PAUSED_REVIEW"
                                        command {
                                            if (paused) api.resumePlan(taskId, status?.revision, newId())
                                            else api.startPlan(taskId, status?.revision, newId())
                                        }
                                    }
                                    "pause" -> command { api.pausePlan(taskId, newId()) }
                                    "stop" -> command { api.stopPlan(taskId, newId()) }
                                    "reconcile" -> command { api.reconcilePlan(taskId, status?.revision, "adopt_external", newId()) }
                                    "open", "edit" -> status?.path?.let { path ->
                                        onOpenPlan(path)
                                        if (action.id == "edit") onNotice("Правьте файл в проекте — карточка перечитает его версию")
                                    }
                                }
                            }, enabled = action.enabled) {
                                Text(action.label, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                            }
                        }
                    }
                }
            }
        }
    }

    if (askPath) {
        AlertDialog(
            onDismissRequest = { askPath = false },
            title = { Text("План для режима «По плану»") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "Файл внутри проекта. Управляемый Markdown с шагами S-001: свободный текст импортируется только предпросмотром.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    BasicTextField(
                        value = pathInput,
                        onValueChange = { pathInput = it; pathProblem = null },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().widthIn(min = 200.dp),
                    )
                    pathProblem?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val problem = planPathProblem(pathInput)
                    pathProblem = problem
                    if (problem != null) return@TextButton
                    val path = pathInput.trim()
                    scope.launch {
                        try {
                            status = api.attachPlan(taskId, path, newId())
                            mode = true
                            askPath = false
                        } catch (error: ApiException) {
                            pathProblem = error.error.message
                        } catch (error: Throwable) {
                            pathProblem = error.message ?: "Файл плана не подключён"
                        }
                    }
                }) { Text("Подключить") }
            },
            dismissButton = { TextButton(onClick = { askPath = false }) { Text("Отмена") } },
        )
    }
}
