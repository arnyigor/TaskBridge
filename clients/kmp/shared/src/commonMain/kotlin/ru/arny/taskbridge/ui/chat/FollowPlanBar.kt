package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.PlanInspection
import ru.arny.taskbridge.core.api.PlanStatus
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.platform.rememberPlanFilePicker
import ru.arny.taskbridge.platform.workspaceRelativePath
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
    // FP-UX-04: результат сканирования живёт до следующего нажатия. При открытии
    // окна его нет — список файлов не запрашивается сам по себе.
    var scan by mutableStateOf<ru.arny.taskbridge.core.api.PlanScanResult?>(null)
    var scanQuery by mutableStateOf("")
    var scanBusy by mutableStateOf(false)
    var aiReview by mutableStateOf<ru.arny.taskbridge.core.api.PlanAiReview?>(null)
    var aiError by mutableStateOf("")
    var aiBusy by mutableStateOf(false)
    var previewOpen by mutableStateOf(false)
    var status by mutableStateOf<PlanStatus?>(null)
    var notice by mutableStateOf("")
    var askPlan by mutableStateOf(false)
    var inspection by mutableStateOf<PlanInspection?>(null)
    var pendingName by mutableStateOf<String?>(null)
    var pendingBase64 by mutableStateOf<String?>(null)
    var pendingPath by mutableStateOf<String?>(null)
    /** Хэш текста, который видел оператор: сервер сверяет его при подключении. */
    var pendingHash by mutableStateOf<String?>(null)
    var overwrite by mutableStateOf(false)
    var stepsOpen by mutableStateOf(false)
    var findingsOpen by mutableStateOf(false)
    /** Отмена выбора: ничего не подключено и ничего не записано. */
    fun clearSelection() {
        inspection = null
        pendingName = null
        pendingBase64 = null
        pendingPath = null
        pendingHash = null
        overwrite = false
        notice = ""
        aiReview = null
        aiError = ""
        previewOpen = false
    }

    /** «Отменить выбор»: снять ещё не подключённый файл, ничего не удаляя на диске. */
    fun cancelSelection() = clearSelection()

    /** Стартовое состояние: ни файла, ни прошлых результатов сканирования. */
    fun resetToStart() {
        clearSelection()
        scan = null
        scanQuery = ""
        scanBusy = false
    }

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
    // Один системный выбор файла (FP-UX-03): на Android — Documents Picker, на
    // десктопе — стандартный диалог. Файл внутри рабочего каталога подключается
    // своим путём, без копирования; всё остальное уходит содержимым.
    val pickFile = rememberPlanFilePicker(startDir = projectPath) { file ->
        if (!file.name.endsWith(".md", true) && !file.name.endsWith(".markdown", true)) {
            state.notice = "План — это файл .md или .markdown."
            return@rememberPlanFilePicker
        }
        state.clearSelection()
        val inside = workspaceRelativePath(projectPath, file.sourcePath)
        scope.launch {
            if (inside != null) inspectThenImport(state, api, newId, path = inside)
            else inspectThenImport(state, api, newId, name = file.name, base64 = encodeBase64(file.bytes))
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
    IconButton(
        onClick = {
            // Открытие окна не сканирует проект: список появляется по кнопке.
            state.resetToStart()
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

    // Панель — свой Dialog, а не AlertDialog: на Android список внутри text-слота
    // AlertDialog не получал нажатий (проверено на Pixel 5 API 31: файл выбирался
    // не нажатием, а только через API). Здесь список живёт в ограниченной по высоте
    // колонке, поэтому прокручивается сам и принимает касания, а заголовок и футер
    // остаются на месте.
    Dialog(
        onDismissRequest = { state.askPlan = false },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            shape = MaterialTheme.shapes.extraLarge,
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier
                .padding(horizontal = 12.dp, vertical = 24.dp)
                .fillMaxWidth()
                .heightIn(max = 640.dp),
        ) {
            Column {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Следование плану", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    IconButton(onClick = { state.askPlan = false }) { Icon(AppIcons.Close, "Закрыть") }
                }
                // insets клавиатуры: поле поиска не должно накрывать нижние действия.
                Column(
                    modifier = Modifier.weight(1f, fill = false).imePadding().padding(horizontal = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
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
                    // Стартовое состояние (FP-UX-04A): описание, проект, две кнопки и
                    // «План не подключён». Список файлов — только после нажатия.
                    Text(
                        "TaskBridge ведёт шаги одного Markdown-файла: после каждого хода проверяет файл " +
                            "и подтверждения и только потом отправляет следующий шаг. Подключение не запускает выполнение.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        "Проект: ${planProjectName(projectPath)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    state.hint?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = colors.error) }
                    Text("План не подключён", style = MaterialTheme.typography.labelMedium)
                    // Обе кнопки в одной строке: FlowRow на телефоне переносил их
                    // друг под друга (проверено на Pixel 5 API 31). weight у главной
                    // кнопки делит ширину, а не заставляет переносить.
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Button(
                            onClick = { scope.launch { runScan(state, api) } },
                            enabled = !state.scanBusy && state.inspection == null,
                            modifier = Modifier.weight(1f),
                            // Узкие боковые отступы и мелкий шрифт: иначе подпись
                            // «Сканировать проект» обрезалась до «Сканировать п…».
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                        ) {
                            Text(
                                if (state.scanBusy) "Сканирую…" else "Сканировать проект",
                                style = MaterialTheme.typography.labelSmall,
                                maxLines = 1,
                                softWrap = false,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        TextButton(
                            onClick = { pickFile() },
                            enabled = state.inspection == null,
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp),
                        ) {
                            Text(
                                "Открыть файл",
                                style = MaterialTheme.typography.labelSmall,
                                maxLines = 1,
                                softWrap = false,
                            )
                        }
                    }
                    // Карточка выбора и список одновременно в панель не помещаются:
                    // список уступает место вердикту (проверено на Pixel 5 API 31).
                    if (state.inspection == null) PlanScanList(state, api, scope)
                }

                // Выбранный файл: имя, путь на сервере и вердикт до записи (FP-UX-04D).
                if (state.inspection != null) PlanSelectionCard(state, api, newId, scope)
                if (state.notice.isNotBlank() && !state.attached) {
                    Text(state.notice, style = MaterialTheme.typography.labelSmall, color = colors.error)
                }
                }
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.End,
                ) {
                    TextButton(onClick = { state.askPlan = false }) { Text("Закрыть") }
                }
            }
        }
    }
}

@OptIn(ExperimentalEncodingApi::class)
private fun encodeBase64(bytes: ByteArray): String = Base64.encode(bytes)

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
        state.pendingHash = inspection.hash
        state.overwrite = false
        state.inspection = inspection
        // The operator sees the server destination and format verdict before writing.
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
            expectedHash = state.pendingHash,
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

/** Один запрос сканирования — одно нажатие (DISC-02). */
private suspend fun runScan(state: FollowPlanUiState, api: TaskBridgeApi) {
    if (state.scanBusy) return
    state.scanBusy = true
    state.notice = ""
    try {
        state.scan = api.scanPlan(state.taskId, "")
    } catch (error: ApiException) {
        state.scan = null
        state.notice = planErrorText(error)
    } finally {
        state.scanBusy = false
    }
}

/**
 * «Проверить с помощью ИИ»: только по нажатию, без запуска плана и без Run.
 * Ошибка модели показывается рядом и не мешает подключить валидный план.
 */
private suspend fun runAiReview(state: FollowPlanUiState, api: TaskBridgeApi) {
    if (state.aiBusy) return
    state.aiBusy = true
    state.aiReview = null
    state.aiError = ""
    try {
        state.aiReview = api.aiReviewPlan(
            state.taskId,
            path = state.pendingPath,
            name = state.pendingName,
            contentBase64 = state.pendingBase64,
        )
    } catch (error: ApiException) {
        state.aiError = planAiErrorText(error)
    } finally {
        state.aiBusy = false
    }
}

/**
 * Найденные файлы проекта: поиск, строка состояния, прокручиваемый список.
 * Фильтр применяется к уже полученному результату — на каждую букву запроса
 * проект заново не обходится (DISC-05).
 */
@Composable
private fun PlanScanList(state: FollowPlanUiState, api: TaskBridgeApi, scope: CoroutineScope) {
    val scan = state.scan ?: return
    val colors = MaterialTheme.colorScheme
    OutlinedTextField(
        value = state.scanQuery,
        onValueChange = { state.scanQuery = it },
        singleLine = true,
        label = { Text("Поиск по имени и пути", style = MaterialTheme.typography.labelSmall) },
        modifier = Modifier.fillMaxWidth(),
    )
    val rows = planScanRows(scan, state.scanQuery)
    Text(
        planScanStatusLine(scan, rows.size),
        style = MaterialTheme.typography.labelSmall,
        color = colors.onSurfaceVariant,
    )
    if (rows.isEmpty()) {
        Text(
            planScanEmptyText(scan, state.scanQuery),
            style = MaterialTheme.typography.labelSmall,
            color = colors.onSurfaceVariant,
        )
        return
    }
    // Строка не ниже 48 dp (палец, а не мышь), имя с ellipsis, относительный путь
    // под ним. Список прокручивается внутри панели: нижние действия остаются видны.
    Column(modifier = Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(rememberScrollState())) {
        for (row in rows) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable { scope.launch { inspectThenImport(state, api, newId = { "" }, path = row.path) } }
                    .padding(vertical = 6.dp, horizontal = 4.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    row.name,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    listOf(row.folder.ifBlank { "корень проекта" }, row.hint)
                        .filter { it.isNotBlank() }
                        .joinToString(" • "),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** Карточка выбранного файла: вердикт, предпросмотр, ИИ и три разных действия. */
@Composable
private fun PlanSelectionCard(
    state: FollowPlanUiState,
    api: TaskBridgeApi,
    newId: () -> String,
    scope: CoroutineScope,
) {
    val inspection = state.inspection ?: return
    val colors = MaterialTheme.colorScheme
    val verdict = planVerdictView(inspection)
    Text(
        inspection.path.orEmpty().substringAfterLast('/'),
        style = MaterialTheme.typography.titleSmall,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
    Text(
        if (state.pendingBase64 != null) "Будет сохранён в проекте: ${inspection.path}"
        else "Файл в проекте: ${inspection.path}",
        style = MaterialTheme.typography.labelSmall,
        color = colors.onSurfaceVariant,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
    if (verdict == null) return
    Text(
        verdict.label,
        style = MaterialTheme.typography.labelMedium,
        color = when (verdict.verdict) {
            "VALID_MANAGED" -> colors.tertiary
            "CONVERTIBLE" -> colors.primary
            else -> colors.error
        },
    )
    val detail = listOf(
        verdict.hint,
        if (verdict.steps > 0) "шагов: ${verdict.steps}" else "",
        verdict.reasons.joinToString("; "),
    ).filter { it.isNotBlank() }.joinToString(" • ")
    if (detail.isNotBlank()) {
        Text(detail, style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
    }
    // Предпросмотр будущего управляемого файла: показывается, но не пишется.
    if (verdict.preview.isNotBlank()) {
        TextButton(onClick = { state.previewOpen = !state.previewOpen }) {
            Text(
                if (state.previewOpen) "Скрыть предпросмотр" else "Предпросмотр управляемого файла",
                style = MaterialTheme.typography.labelSmall,
            )
        }
        if (state.previewOpen) {
            LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 160.dp)) {
                items(verdict.preview.lines(), key = { it.hashCode() }) { line ->
                    Text(line, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
    if (verdict.canAttach) {
        TextButton(onClick = { scope.launch { runAiReview(state, api) } }, enabled = !state.aiBusy) {
            Text(
                if (state.aiBusy) "Спрашиваю модель…" else "Проверить с помощью ИИ",
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
    if (state.aiError.isNotBlank()) {
        Text(state.aiError, style = MaterialTheme.typography.labelSmall, color = colors.error)
    }
    planAiReviewView(state.aiReview)?.let { review ->
        Text(
            review.text,
            style = MaterialTheme.typography.labelSmall,
            color = colors.onSurfaceVariant,
            maxLines = 5,
            overflow = TextOverflow.Ellipsis,
        )
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        // «Отменить выбор» ничего не удаляет и не отключает.
        TextButton(onClick = { state.cancelSelection() }) {
            Text("Отменить выбор", style = MaterialTheme.typography.labelSmall)
        }
        if (verdict.canAttach) {
            TextButton(onClick = { scope.launch { importNow(state, api, newId) } }) {
                Text(
                    if (state.overwrite) "Перезаписать и подключить" else verdict.confirmLabel,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}

/** «Название текущего проекта» для стартового экрана: последняя часть пути. */
private fun planProjectName(path: String?): String {
    val value = path?.trim().orEmpty()
    if (value.isEmpty()) return "—"
    val tail = value.split('/', 0x5C.toChar()).filter { it.isNotBlank() }.lastOrNull() ?: value
    return tail.ifBlank { "—" }
}
