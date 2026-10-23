package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.PlanStatus
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.ui.theme.AppIcons

/**
 * Состояние Follow Plan на экране чата: иконка в композиторе и карточка над ним
 * показывают одно и то же и меняют одно и то же, поэтому состояние общее.
 */
class FollowPlanUiState internal constructor(val taskId: String) {
    var status by mutableStateOf<PlanStatus?>(null)
    var notice by mutableStateOf("")
    var askPath by mutableStateOf(false)
    var pathInput by mutableStateOf("")
    var pathProblem by mutableStateOf<String?>(null)
    var planGroups by mutableStateOf<List<PlanFileGroup>>(emptyList())
    var filesLoading by mutableStateOf(false)
    var filesProblem by mutableStateOf<String?>(null)

    val enabled: Boolean get() = planToggleEnabled(status)
    val hint: String? get() = planToggleHint(status)
    val attached: Boolean get() = status?.attached == true
}

@Composable
fun rememberFollowPlanState(api: TaskBridgeApi, taskId: String, version: Long): FollowPlanUiState {
    val state = remember(taskId) { FollowPlanUiState(taskId) }
    // Перечитывается на каждое событие чата: события плана — серверные факты и
    // двигают version. Флаг может включиться на сервере, пока экран открыт.
    LaunchedEffect(taskId, version) {
        state.status = runCatching { api.plan(taskId) }.getOrNull() ?: state.status
    }
    LaunchedEffect(taskId, state.status?.enabled) {
        // Пока режим читается как выключенный, перечитываем раз в 10 с: иначе чип
        // остаётся серым до смены сессии (так и случилось на приёмке 2026-10-23).
        while (state.status?.enabled != true || state.status == null) {
            delay(10_000)
            state.status = runCatching { api.plan(taskId) }.getOrNull() ?: state.status
        }
    }
    LaunchedEffect(state.askPath) {
        if (!state.askPath) return@LaunchedEffect
        state.filesLoading = true
        state.filesProblem = null
        state.planGroups = runCatching { planFileGroups(api.workspaceFiles(taskId).entries) }
            .onFailure { state.filesProblem = it.message ?: "Список файлов не получен" }
            .getOrDefault(emptyList())
        state.filesLoading = false
    }
    return state
}

private fun FollowPlanUiState.apply(next: PlanStatus) {
    status = next
    notice = ""
    if (next.attached) pathInput = next.path.orEmpty()
}

/**
 * Иконка «По плану» в ряду композитора — рядом с вложением и настройками сессии.
 * Нажатие открывает выбор файла плана; выбранный файл и есть включённый режим,
 * убрать его можно крестиком в карточке или кнопкой в диалоге.
 */
@Composable
fun FollowPlanIcon(
    state: FollowPlanUiState,
    api: TaskBridgeApi,
    newId: () -> String,
    scope: CoroutineScope,
    projectPath: String? = null,
) {
    val colors = MaterialTheme.colorScheme
    IconButton(
        onClick = {
            state.pathProblem = null
            state.pathInput = state.status?.path.orEmpty()
            state.askPath = true
        },
        modifier = Modifier.size(40.dp),
    ) {
        Icon(
            AppIcons.Plan,
            state.status?.path?.let { "По плану: $it" } ?: "По плану: выбрать файл плана",
            Modifier.size(20.dp),
            tint = if (state.attached) colors.primary else colors.onSurfaceVariant,
        )
    }

    if (state.askPath) {
        AlertDialog(
            onDismissRequest = { state.askPath = false },
            title = { Text("План") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "Выберите Markdown-файл проекта: выбранный план включает режим следования. " +
                            "Шаги S-001 ведёт TaskBridge; свободный текст импортируется только предпросмотром.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    state.hint?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = colors.error)
                    }
                    if (!projectPath.isNullOrBlank()) {
                        Text(projectPath, style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    if (state.filesLoading) {
                        Text("Загрузка списка…", style = MaterialTheme.typography.labelSmall)
                    } else if (state.planGroups.isEmpty()) {
                        Text(
                            state.filesProblem ?: "В проекте нет Markdown-файлов — укажите путь вручную.",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (state.filesProblem != null) colors.error else colors.onSurfaceVariant,
                        )
                    } else {
                        LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp)) {
                            for (group in state.planGroups) {
                                item(key = "folder:${group.folder}") {
                                    Text(
                                        if (group.folder.isEmpty()) "корень проекта" else "${group.folder}/",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = colors.onSurfaceVariant,
                                        modifier = Modifier.padding(top = 4.dp),
                                    )
                                }
                                items(group.files, key = { it.path }) { entry ->
                                    TextButton(onClick = {
                                        scope.launch {
                                            try {
                                                state.apply(api.attachPlan(state.taskId, entry.path, newId()))
                                                state.askPath = false
                                            } catch (error: ApiException) {
                                                state.pathProblem = error.error.message
                                            } catch (error: Throwable) {
                                                state.pathProblem = error.message ?: "Файл плана не подключён"
                                            }
                                        }
                                    }, modifier = Modifier.fillMaxWidth()) {
                                        Text(
                                            (if (entry.path == state.status?.path) "✓ " else "") + entry.name,
                                            style = MaterialTheme.typography.labelMedium,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            }
                        }
                    }
                    BasicTextField(
                        value = state.pathInput,
                        onValueChange = { state.pathInput = it; state.pathProblem = null },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().widthIn(min = 200.dp),
                    )
                    state.pathProblem?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = colors.error) }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val problem = planPathProblem(state.pathInput)
                    state.pathProblem = problem
                    if (problem != null) return@TextButton
                    val path = state.pathInput.trim()
                    scope.launch {
                        try {
                            state.apply(api.attachPlan(state.taskId, path, newId()))
                            state.askPath = false
                        } catch (error: ApiException) {
                            state.pathProblem = error.error.message
                        } catch (error: Throwable) {
                            state.pathProblem = error.message ?: "Файл плана не подключён"
                        }
                    }
                }) { Text("Подключить") }
            },
            dismissButton = {
                Row {
                    if (state.attached) {
                        TextButton(onClick = {
                            state.askPath = false
                            scope.launch {
                                try {
                                    state.apply(api.detachPlan(state.taskId, newId()))
                                } catch (error: ApiException) {
                                    state.notice = error.error.message
                                }
                            }
                        }) { Text("Убрать план") }
                    }
                    TextButton(onClick = { state.askPath = false }) { Text("Отмена") }
                }
            },
        )
    }
}

/** Компактная карточка плана над композитором: прогресс, шаг, находки, действия. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FollowPlanCard(
    state: FollowPlanUiState,
    api: TaskBridgeApi,
    newId: () -> String,
    scope: CoroutineScope,
    onOpenPlan: (String) -> Unit,
    onNotice: (String) -> Unit = {},
) {
    val model = planCardModel(state.status)
    val status = state.status
    val colors = MaterialTheme.colorScheme

    fun command(run: suspend () -> PlanStatus) {
        scope.launch {
            try {
                state.apply(run())
            } catch (error: ApiException) {
                // 409 PLAN_REVISION_CONFLICT arrives here: the operator changed the
                // file, so the card must show that instead of pretending to run.
                state.notice = error.error.message
            } catch (error: Throwable) {
                state.notice = error.message ?: "Команда плана не выполнена"
            }
        }
    }

    if (!model.visible) return

    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
        colors = CardDefaults.cardColors(containerColor = colors.surfaceVariant.copy(alpha = 0.5f)),
    ) {
        Column(modifier = Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    model.headline,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                // Выбранный план — это и есть режим: крестик заканчивает его, не
                // убивая текущий ход.
                IconButton(onClick = {
                    scope.launch {
                        try {
                            state.apply(api.detachPlan(state.taskId, newId()))
                        } catch (error: ApiException) {
                            state.notice = error.error.message
                        }
                    }
                }, modifier = Modifier.size(28.dp)) {
                    Icon(AppIcons.Close, "Убрать план", Modifier.size(14.dp))
                }
            }
            if (model.goal.isNotBlank()) {
                Text(model.goal, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (model.findings.isNotBlank()) {
                Text(model.findings, style = MaterialTheme.typography.labelSmall, color = colors.tertiary)
            }
            val line = model.conflict ?: model.error ?: state.notice
            if (!line.isNullOrBlank()) {
                Text(line, style = MaterialTheme.typography.labelSmall, color = colors.error)
            }
            // Six actions do not fit one phone row; a wrapping row keeps every control
            // reachable (Pixel 5 showed only three before this).
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
                                    if (paused) api.resumePlan(state.taskId, status?.revision, newId())
                                    else api.startPlan(state.taskId, status?.revision, newId())
                                }
                            }
                            "pause" -> command { api.pausePlan(state.taskId, newId()) }
                            "stop" -> command { api.stopPlan(state.taskId, newId()) }
                            "reconcile" -> command { api.reconcilePlan(state.taskId, status?.revision, "adopt_external", newId()) }
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
