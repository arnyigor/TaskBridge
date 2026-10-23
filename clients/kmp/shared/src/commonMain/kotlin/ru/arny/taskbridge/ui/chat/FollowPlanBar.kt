package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import ru.arny.taskbridge.core.api.PlanInspection
import ru.arny.taskbridge.core.api.PlanStatus
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.platform.rememberFilePicker
import ru.arny.taskbridge.ui.theme.AppIcons
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * Состояние Follow Plan на экране чата: иконка в композиторе и диалог показывают
 * одно и то же и меняют одно и то же, поэтому состояние общее.
 */
class FollowPlanUiState internal constructor(val taskId: String) {
    // The base is captured when opened, never replaced by SSE status refreshes.
    var editorBase by mutableStateOf<ru.arny.taskbridge.core.api.PlanContent?>(null)
    var editorText by mutableStateOf("")
    var editorError by mutableStateOf("")
    var editorCurrent by mutableStateOf<String?>(null)
    var editorSaving by mutableStateOf(false)
    var editorDiscard by mutableStateOf(false)
    var moreOpen by mutableStateOf(false)
    var confirmDetach by mutableStateOf(false)
    var status by mutableStateOf<PlanStatus?>(null)
    var notice by mutableStateOf("")
    var askPlan by mutableStateOf(false)
    var pathInput by mutableStateOf("")
    var pathRow by mutableStateOf(true)
    var inspection by mutableStateOf<PlanInspection?>(null)
    var pendingName by mutableStateOf<String?>(null)
    var pendingBase64 by mutableStateOf<String?>(null)
    var pendingPath by mutableStateOf<String?>(null)
    var overwrite by mutableStateOf(false)
    var stepsOpen by mutableStateOf(false)
    var findingsOpen by mutableStateOf(false)
    // Ленивый браузер проекта: телефон выбирает файл, который лежит на компьютере.
    var browseOpen by mutableStateOf(false)
    var browsePath by mutableStateOf("")
    var browseEntries by mutableStateOf<List<ru.arny.taskbridge.core.api.PlanBrowseEntry>>(emptyList())
    var browseParent by mutableStateOf<String?>(null)
    var browseError by mutableStateOf<String?>(null)
    var capabilitiesLoaded by mutableStateOf(false)
    var canBrowse by mutableStateOf(false)

    val enabled: Boolean get() = planToggleEnabled(status)
    val hint: String? get() = planToggleHint(status)
    val attached: Boolean get() = status?.attached == true
}

@Composable
fun rememberFollowPlanState(api: TaskBridgeApi, taskId: String, version: Long): FollowPlanUiState {
    val state = remember(taskId) { FollowPlanUiState(taskId) }
    // Перечитывается на каждое событие чата: события плана — серверные факты.
    LaunchedEffect(taskId, version) {
        state.status = runCatching { api.plan(taskId) }.getOrNull() ?: state.status
    }
    LaunchedEffect(taskId, state.status?.enabled) {
        // Пока режим читается как выключенный, перечитываем раз в 10 с: иначе
        // иконка остаётся серой до смены сессии (приёмка 2026-10-23).
        while (state.status?.enabled != true) {
            delay(10_000)
            state.status = runCatching { api.plan(taskId) }.getOrNull() ?: state.status
        }
    }
    return state
}

private fun FollowPlanUiState.apply(next: PlanStatus) {
    status = next
    notice = ""
}

/**
 * Иконка «По плану» в ряду композитора. Нажатие открывает диалог: выбор файла,
 * статус и управление. Цвет иконки — состояние, подсказка дублирует словами.
 */
@Composable
fun FollowPlanIcon(
    state: FollowPlanUiState,
    api: TaskBridgeApi,
    newId: () -> String,
    scope: CoroutineScope,
    projectPath: String? = null,
    onOpenPlan: (String) -> Unit = {},
    onNotice: (String) -> Unit = {},
    platformKind: String = "desktop",
) {
    val colors = MaterialTheme.colorScheme
    val iconTint = when (planIconState(state.status)) {
        PlanIconState.RUNNING, PlanIconState.IDLE -> colors.primary
        PlanIconState.ATTENTION -> colors.error
        PlanIconState.COMPLETED -> colors.tertiary
        PlanIconState.OFF -> colors.onSurfaceVariant
    }
    // Системный выбор файла: на Android — Documents Picker (SAF), на десктопе —
    // стандартный диалог. Список .md в проекте больше не сканируется.
    val pickFile = rememberFilePicker(startDir = projectPath) { picked ->
        val file: UploadFile? = picked.firstOrNull { it.name.endsWith(".md", true) || it.name.endsWith(".markdown", true) }
        if (file == null) {
            state.notice = "План — это файл .md или .markdown."
            return@rememberFilePicker
        }
        scope.launch {
            inspectThenImport(state, api, newId, name = file.name, base64 = encodeBase64(file.bytes))
        }
    }

    // While the panel is open, re-read it: an external file edit or another
    // client's action emits no chat event, and an open dialog must still show it.
    LaunchedEffect(state.askPlan) {
        while (state.askPlan) {
            delay(3_000)
            state.status = runCatching { api.plan(state.taskId) }.getOrNull() ?: state.status
        }
    }
    // The project listing loads when the dialog opens — one directory, by request.
    LaunchedEffect(state.askPlan) {
        if (!state.askPlan) return@LaunchedEffect
        if (!state.capabilitiesLoaded) {
            val capabilities = runCatching { api.info().followPlan?.capabilities }.getOrNull().orEmpty()
            state.canBrowse = capabilities.contains("browse")
            state.capabilitiesLoaded = true
        }
        // A server without the listing route is named as such, not as «Not found».
        // Opening this dialog does not list project files.
    }
    IconButton(
        onClick = {
            state.notice = ""
            state.inspection = null
            state.askPlan = true
        },
        modifier = Modifier.size(40.dp),
    ) {
        Icon(
            AppIcons.Plan,
            planIconTitle(state.status),
            Modifier.size(20.dp),
            tint = iconTint,
        )
    }

    if (!state.askPlan) return
    if (state.editorBase != null) {
        FollowPlanEditor(state, api, newId, scope)
        return
    }

    AlertDialog(
        onDismissRequest = { state.askPlan = false },
        title = { Text("Следование плану") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val status = state.status
                if (state.attached) {
                    // Верхний блок: файл, состояние, ревизия, цикл, шаг, стадия.
                    Text(status?.path?.substringAfterLast('/') ?: "PLAN.md", style = MaterialTheme.typography.titleSmall)
                    Text(planMetaLine(status), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                    val progress = status?.progress
                    if (progress != null && progress.total > 0) {
                        LinearProgressIndicator(
                            progress = { progress.done.toFloat() / progress.total },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 6.dp),
                        )
                    }
                    planCurrentStep(status)?.let { step ->
                        Text("${step.id} · ${step.title}", style = MaterialTheme.typography.bodyMedium)
                        Text(step.status, style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                        if (step.result.isNotBlank()) {
                            Text(step.result, style = MaterialTheme.typography.labelSmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    // Полный список шагов свёрнут: в диалог не выливается весь план.
                    TextButton(onClick = { state.stepsOpen = !state.stepsOpen }) {
                        Text(if (state.stepsOpen) "Скрыть шаги" else "Все шаги (${status?.steps?.size ?: 0})")
                    }
                    if (state.stepsOpen) {
                        LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 200.dp)) {
                            items(status?.steps.orEmpty(), key = { it.id }) { step ->
                                Text(
                                    "${step.id} · ${step.title.orEmpty()} — ${step.status}",
                                    style = MaterialTheme.typography.labelSmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                    val findings = status?.findings.orEmpty().filter { it.state == "OPEN" }
                    if (findings.isNotEmpty()) {
                        val blocking = findings.count { it.priority == "P0" || it.priority == "P1" }
                        TextButton(onClick = { state.findingsOpen = !state.findingsOpen }) {
                            Text("Находки: требуют решения $blocking, записей ${findings.size - blocking}")
                        }
                        if (state.findingsOpen) {
                            for (finding in findings) {
                                Text("${finding.priority} · ${finding.summary.orEmpty()}", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                    val line = status?.fileError?.message ?: state.notice
                    if (line.isNotBlank()) Text(planErrorText(null, line), style = MaterialTheme.typography.labelSmall, color = colors.error)
                    PlanActionsRow(state, api, newId, scope, onOpenPlan, onNotice)
                } else {
                    Text(
                        "TaskBridge ведёт шаги одного Markdown-файла: после каждого хода проверяет файл " +
                            "и подтверждения и только потом отправляет следующий шаг. Подключение не запускает выполнение.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (!projectPath.isNullOrBlank()) {
                        // One line with an ellipsis: a wrapped drive path ate two rows of a phone dialog.
                        Text(projectPath, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    state.hint?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = colors.error) }

                    Text("Файл серверного проекта — по относительному пути ниже", style = MaterialTheme.typography.labelMedium)
                    TextButton(onClick = { pickFile() }) {
                        Text(
                            if (platformKind == "android") "Файл на телефоне" else "Файл на компьютере",
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                    if (state.pathRow) {
                        // A visible field, not a bare text area: on a phone an empty
                        // BasicTextField looks like nothing happened.
                        OutlinedTextField(
                            value = state.pathInput,
                            onValueChange = { state.pathInput = it },
                            singleLine = true,
                            label = { Text("Путь в проекте", style = MaterialTheme.typography.labelSmall) },
                            placeholder = { Text("docs/PLAN.md", style = MaterialTheme.typography.bodySmall) },
                            modifier = Modifier.fillMaxWidth().widthIn(min = 200.dp),
                        )
                        TextButton(
                            onClick = {
                                val path = state.pathInput.trim()
                                val problem = planPathProblem(path)
                                if (problem != null) {
                                    state.notice = problem
                                    return@TextButton
                                }
                                scope.launch { inspectThenImport(state, api, newId, path = path) }
                            },
                            enabled = state.pathInput.isNotBlank(),
                        ) { Text("Подключить") }
                    }
                }

                // Предпросмотр импорта обычного Markdown: файл не меняется до согласия.
                state.inspection?.let { inspection ->
                    if (!inspection.managed && !state.attached) {
                        Text(planInspectionText(inspection), style = MaterialTheme.typography.bodySmall)
                        Row {
                            TextButton(onClick = {
                                state.inspection = null
                                state.pendingBase64 = null
                                state.pendingPath = null
                            }) { Text("Отмена") }
                            TextButton(onClick = {
                                scope.launch { importNow(state, api, newId) }
                            }) {
                                Text(if (state.overwrite) "Перезаписать и подключить" else "Импортировать и подключить")
                            }
                        }
                    }
                }
                if (state.notice.isNotBlank() && !state.attached) {
                    Text(state.notice, style = MaterialTheme.typography.labelSmall, color = colors.error)
                }
            }
        },
        confirmButton = {
            Row {
                TextButton(onClick = { state.askPlan = false }) { Text("Закрыть") }
            }
        },
    )
}

@OptIn(ExperimentalEncodingApi::class)
private fun encodeBase64(bytes: ByteArray): String = Base64.encode(bytes)

/** Один каталог проекта за запрос: так телефон видит файлы компьютера. */
private suspend fun browse(state: FollowPlanUiState, api: TaskBridgeApi, path: String) {
    state.browseError = null
    try {
        val listing = api.browsePlan(state.taskId, path)
        state.browsePath = listing.path
        state.browseParent = listing.parent
        state.browseEntries = listing.entries
    } catch (error: ApiException) {
        state.browseError = planErrorText(error)
    }
}

private suspend fun inspectThenImport(
    state: FollowPlanUiState,
    api: TaskBridgeApi,
    newId: () -> String,
    name: String? = null,
    base64: String? = null,
    path: String? = null,
) {
    try {
        val inspection = api.inspectPlan(state.taskId, path = path, name = name, contentBase64 = base64)
        state.pendingName = name
        state.pendingBase64 = base64
        state.pendingPath = path
        state.overwrite = false
        state.inspection = inspection
        if (inspection.managed) {
            importNow(state, api, newId)
        }
    } catch (error: ApiException) {
        state.notice = planErrorText(error)
    }
}

private suspend fun importNow(state: FollowPlanUiState, api: TaskBridgeApi, newId: () -> String) {
    try {
        val result = api.importPlan(
            id = state.taskId,
            commandId = newId(),
            path = state.pendingPath,
            name = state.pendingName,
            contentBase64 = state.pendingBase64,
            confirmImport = true,
            overwrite = state.overwrite,
        )
        val next = result.status
        if (next != null) state.apply(next)
        state.inspection = null
        state.pendingBase64 = null
        state.pendingPath = null
        state.overwrite = false
    } catch (error: ApiException) {
        state.notice = planErrorText(error)
        if (planErrorCode(error) == "PLAN_FILE_EXISTS") state.overwrite = true
    }
}

/**
 * Действия плана: главное действие по состоянию, остальные — рядом. Шесть кнопок
 * не помещаются в одну строку на телефоне, поэтому ряд переносится.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PlanActionsRow(
    state: FollowPlanUiState,
    api: TaskBridgeApi,
    newId: () -> String,
    scope: CoroutineScope,
    onOpenPlan: (String) -> Unit,
    onNotice: (String) -> Unit,
) {
    val model = planCardModel(state.status)
    val status = state.status
    val primary = planPrimaryAction(status)

    fun command(run: suspend () -> PlanStatus) {
        scope.launch {
            try {
                state.apply(run())
            } catch (error: ApiException) {
                // 409 PLAN_REVISION_CONFLICT arrives here: the operator changed the
                // file, so the dialog must show that instead of pretending to run.
                state.notice = planErrorText(error)
            }
        }
    }

    fun runAction(actionId: String) {
        when (actionId) {
            "start" -> command { api.startPlan(state.taskId, status?.revision, newId()) }
            "resume" -> command { api.resumePlan(state.taskId, status?.revision, newId()) }
            "pause" -> command { api.pausePlan(state.taskId, newId()) }
            "stop" -> command { api.stopPlan(state.taskId, newId()) }
            "reconcile" -> command { api.reconcilePlan(state.taskId, status?.revision, "adopt_external", newId()) }
            "edit" -> scope.launch {
                try {
                    val base = api.planContent(state.taskId)
                    state.editorBase = base
                    state.editorText = base.content
                    state.editorError = ""
                    state.editorCurrent = null
                } catch (error: ApiException) { state.notice = planErrorText(error) }
            }
            "open" -> status?.path?.let(onOpenPlan)
        }
    }
    val contextual = if (status?.state in setOf("RUNNING_STEP", "REVIEWING")) "stop" else "edit"
    val main = model.actions.filter { it.id == primary.id || (it.id == contextual && it.enabled) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (action in main) {
            TextButton(onClick = { runAction(action.id) }, enabled = action.enabled) {
                Text(if (action.id == primary.id) primary.label else action.label, style = MaterialTheme.typography.labelSmall)
            }
        }
        Box {
            TextButton(onClick = { state.moreOpen = true }) { Text("Дополнительно") }
            DropdownMenu(expanded = state.moreOpen, onDismissRequest = { state.moreOpen = false }) {
                for (action in model.actions.filter { it.enabled && it.id !in main.map { a -> a.id } }) {
                    DropdownMenuItem(text = { Text(action.label) }, onClick = {
                        state.moreOpen = false
                        runAction(action.id)
                    })
                }
                DropdownMenuItem(text = { Text("Отключить план") }, enabled = state.enabled, onClick = {
                    state.moreOpen = false
                    state.confirmDetach = true
                })
            }
        }
    }
    if (state.confirmDetach) {
        AlertDialog(
            onDismissRequest = { state.confirmDetach = false },
            title = { Text("Отключить план? Файл останется на месте.") },
            confirmButton = {
                TextButton(onClick = {
                    state.confirmDetach = false
                    command { api.detachPlan(state.taskId, newId()) }
                }) { Text("Отключить") }
            },
            dismissButton = { TextButton(onClick = { state.confirmDetach = false }) { Text("Отмена") } },
        )
    }
}
