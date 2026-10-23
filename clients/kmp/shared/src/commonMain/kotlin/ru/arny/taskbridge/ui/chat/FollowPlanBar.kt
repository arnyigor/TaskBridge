package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import ru.arny.taskbridge.core.api.WorkspaceFileEntry

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
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FollowPlanBar(
    api: TaskBridgeApi,
    taskId: String,
    version: Long,
    newId: () -> String,
    scope: CoroutineScope,
    onOpenPlan: (String) -> Unit,
    onNotice: (String) -> Unit = {},
    projectPath: String? = null,
) {
    var status by remember(taskId) { mutableStateOf<PlanStatus?>(null) }
    var mode by remember(taskId) { mutableStateOf(false) }
    var notice by remember(taskId) { mutableStateOf("") }
    var askPath by remember(taskId) { mutableStateOf(false) }
    var pathInput by remember(taskId) { mutableStateOf("") }
    var pathProblem by remember(taskId) { mutableStateOf<String?>(null) }
    // The plan file is chosen from the project, not typed from memory.
    var planGroups by remember(taskId) { mutableStateOf<List<PlanFileGroup>>(emptyList()) }
    var filesLoading by remember(taskId) { mutableStateOf(false) }
    var filesProblem by remember(taskId) { mutableStateOf<String?>(null) }
    val model = planCardModel(status)
    val enabled = planToggleEnabled(status)

    LaunchedEffect(askPath) {
        if (!askPath) return@LaunchedEffect
        filesLoading = true
        filesProblem = null
        planGroups = runCatching { planFileGroups(api.workspaceFiles(taskId).entries) }
            .onFailure { filesProblem = it.message ?: "Список файлов не получен" }
            .getOrDefault(emptyList())
        filesLoading = false
    }

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
                enabled = enabled,                // off on the server: visible, but not pressable
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
            // A mode switched off on the server says why instead of disappearing.
            planToggleHint(status)?.let { hint ->
                Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
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
                    // Six actions do not fit one phone row: «Открыть план» and
                    // «Изменить план» were clipped off screen (Pixel 5, 2 columns).
                    // A wrapping row keeps every control reachable.
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalArrangement = Arrangement.spacedBy(0.dp),
                    ) {
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
                        "Выберите план в проекте. Управляемый Markdown с шагами S-001: свободный текст импортируется только предпросмотром.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (!projectPath.isNullOrBlank()) {
                        // Which folder this is matters on a phone: the same file name can
                        // exist twice, and the project folder is the only context.
                        Text(projectPath, style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    if (filesLoading) {
                        Text("Загрузка списка…", style = MaterialTheme.typography.labelSmall)
                    } else if (planGroups.isEmpty()) {
                        Text(
                            filesProblem ?: "В проекте нет Markdown-файлов — укажите путь вручную.",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (filesProblem != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        // The list is the main path; the field below stays for a file the
                        // listing does not reach (deep folder, listing cap).
                        LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp)) {
                            for (group in planGroups) {
                                item(key = "folder:${group.folder}") {
                                    Text(
                                        if (group.folder.isEmpty()) "корень проекта" else "${group.folder}/",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(top = 4.dp),
                                    )
                                }
                                items(group.files, key = { it.path }) { entry ->
                                    TextButton(onClick = {
                                        val path = entry.path
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
                                    }, modifier = Modifier.fillMaxWidth()) {
                                        Text(entry.name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                            }
                        }
                    }
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
