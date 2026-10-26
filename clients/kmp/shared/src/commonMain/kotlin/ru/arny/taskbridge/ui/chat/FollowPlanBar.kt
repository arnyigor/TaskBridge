package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.platform.testTag
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
/** Ширина панели: компактный диалог, а не горизонтальная полоса на всё окно. */
private val PLAN_PANEL_MAX_WIDTH = 560.dp
/** Ниже этой ширины две основные кнопки идут друг под другом. */
private val PLAN_PANEL_NARROW_WIDTH = 420.dp
const val PLAN_PANEL_TAG = "followPlanPanel"

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
    /** Ошибка сканирования показывается в области списка, а не в общем notice. */
    var scanError by mutableStateOf("")
    var aiReview by mutableStateOf<ru.arny.taskbridge.core.api.PlanAiReview?>(null)
    var aiError by mutableStateOf("")
    var aiBusy by mutableStateOf(false)
    var previewOpen by mutableStateOf(false)
    // «Исправить формат»: база CAS (path+hash), текст и признак перезаписи.
    var repairPath by mutableStateOf<String?>(null)
    var repairBaseHash by mutableStateOf<String?>(null)
    var repairText by mutableStateOf("")
    var repairError by mutableStateOf("")
    var repairOverwrite by mutableStateOf(false)
    var repairSaving by mutableStateOf(false)
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
        cancelRepair()
    }

    /** Отмена правки формата: ничего не записано. */
    fun cancelRepair() {
        repairPath = null
        repairBaseHash = null
        repairText = ""
        repairError = ""
        repairOverwrite = false
    }

    /** «Отменить выбор»: снять ещё не подключённый файл, ничего не удаляя на диске. */
    fun cancelSelection() = clearSelection()

    /** Стартовое состояние: ни файла, ни прошлых результатов сканирования. */
    fun resetToStart() {
        clearSelection()
        scan = null
        scanQuery = ""
        scanBusy = false
        scanError = ""
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
    /** Копирование пути проекта: через платформенный сервис, как весь остальной клиент. */
    onCopy: (String) -> Unit = {},
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
    // AlertDialog не получал нажатий (проверено на Pixel 5 API 31).
    //
    // FP-UX-05: usePlatformDefaultWidth=false + fillMaxWidth растягивали панель на
    // всё окно. Ширина ограничена 560 dp, высота — по содержимому и не больше 90%
    // доступного места; imePadding снаружи, чтобы клавиатура не накрывала действия.
    val scanListState = rememberLazyListState()
    Dialog(
        onDismissRequest = { state.askPlan = false },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        BoxWithConstraints(
            modifier = Modifier.fillMaxSize().imePadding(),
            contentAlignment = Alignment.Center,
        ) {
            val panelWidth = minOf(maxWidth - 24.dp, PLAN_PANEL_MAX_WIDTH)
            // На узком экране две основные кнопки идут друг под другом.
            val narrow = panelWidth < PLAN_PANEL_NARROW_WIDTH
            Surface(
                shape = MaterialTheme.shapes.extraLarge,
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                modifier = Modifier
                    .testTag(PLAN_PANEL_TAG)
                    .widthIn(max = panelWidth)
                    .fillMaxWidth()
                    .heightIn(max = maxHeight * 0.9f)
                    .wrapContentHeight(),
            ) {
                Column {
                    // Заголовок и закрытие зафиксированы; нижнего дубля «Закрыть» нет.
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 8.dp, top = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Следование плану", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                        IconButton(onClick = { state.askPlan = false }) { Icon(AppIcons.Close, "Закрыть") }
                    }
                    Column(
                        modifier = Modifier
                            .weight(1f, fill = false)
                            .padding(horizontal = 24.dp)
                            .padding(bottom = 20.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
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
                    // Описание и статус — только в стартовом состоянии: в списке и в
                    // карточке место нужно файлам и вердикту (FP-UX-05).
                    if (state.scan == null && state.inspection == null) {
                        Text(
                            "TaskBridge ведёт шаги одного Markdown-файла: после каждого хода проверяет файл " +
                                "и подтверждения и только потом отправляет следующий шаг. Подключение не запускает выполнение.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        PlanProjectPathRow(projectPath, onCopy)
                        state.hint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.error) }
                        Text("План не подключён", style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
                    }
                    // Две равнозначные по размеру кнопки: на узком экране — друг под
                    // другом, на широком — в одной строке. Обе занимают ширину своей
                    // строки, поэтому «Открыть файл» не выглядит мелкой ссылкой.
                    val scanButton: @Composable (Modifier) -> Unit = { modifier ->
                        Button(
                            onClick = { scope.launch { runScan(state, api) } },
                            enabled = !state.scanBusy && state.inspection == null,
                            modifier = modifier.heightIn(min = 48.dp),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                        ) {
                            Text(
                                if (state.scanBusy) "Сканирую…" else "Сканировать проект",
                                style = MaterialTheme.typography.labelLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    val openButton: @Composable (Modifier) -> Unit = { modifier ->
                        OutlinedButton(
                            onClick = { pickFile() },
                            enabled = state.inspection == null,
                            modifier = modifier.heightIn(min = 48.dp),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                        ) {
                            Text("Открыть файл", style = MaterialTheme.typography.labelLarge, maxLines = 1)
                        }
                    }
                    if (state.inspection != null) {
                        // Карточка заменяет список и стартовые действия целиком.
                    } else if (narrow) {
                        Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            scanButton(Modifier.fillMaxWidth())
                            openButton(Modifier.fillMaxWidth())
                        }
                    } else {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            scanButton(Modifier.weight(1f))
                            openButton(Modifier.weight(1f))
                        }
                    }
                    // Карточка выбора и список одновременно в панель не помещаются:
                    // список уступает место вердикту, а «Назад к файлам» возвращает
                    // к прежнему поиску и позиции прокрутки.
                    if (state.inspection == null) PlanScanList(state, api, scope, scanListState)
                }

                // Выбранный файл: имя, путь на сервере и вердикт до записи (FP-UX-04D).
                if (state.inspection != null) PlanSelectionCard(state, api, newId, scope)
                if (state.notice.isNotBlank() && !state.attached) {
                    Text(state.notice, style = MaterialTheme.typography.bodySmall, color = colors.error)
                }
                    }
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
                DropdownMenuItem(text = { Text("Отключить следование") }, enabled = state.enabled, onClick = {
                    state.moreOpen = false
                    state.confirmDetach = true
                })
            }
        }
    }
    if (state.confirmDetach) {
        AlertDialog(
            onDismissRequest = { state.confirmDetach = false },
            title = { Text("Отключить следование? Файл останется в проекте.") },
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
    state.scanError = ""
    try {
        state.scan = api.scanPlan(state.taskId, "")
    } catch (error: ApiException) {
        state.scan = null
        state.scanError = planErrorText(error)
    } finally {
        state.scanBusy = false
    }
}

/** Открыть текст выбранного файла для правки формата (только чтение). */
private suspend fun openRepair(state: FollowPlanUiState, api: TaskBridgeApi, path: String) {
    state.repairError = ""
    try {
        val file = api.readPlanFile(state.taskId, path)
        state.repairPath = file.path
        state.repairBaseHash = file.hash
        state.repairText = file.text
        state.repairOverwrite = false
    } catch (error: ApiException) {
        state.repairError = planErrorText(error)
    }
}

/** Сохранить исправленный текст: сервер принимает только валидный managed-план. */
private suspend fun saveRepair(state: FollowPlanUiState, api: TaskBridgeApi, newId: () -> String) {
    val path = state.repairPath ?: return
    state.repairSaving = true
    state.repairError = ""
    try {
        val saved = api.savePlanFile(
            id = state.taskId,
            commandId = newId(),
            path = path,
            content = state.repairText,
            expectedHash = state.repairBaseHash,
            overwrite = state.repairOverwrite,
        )
        state.cancelRepair()
        // Файл исправлен — перечитываем вердикт тем же путём, что при выборе.
        inspectThenImport(state, api, newId, path = saved.path)
    } catch (error: ApiException) {
        if (planErrorCode(error) == "PLAN_FILE_EXISTS") {
            state.repairOverwrite = true
            state.repairError = "${planErrorText(error)} Нажмите «Сохранить» ещё раз, чтобы перезаписать."
        } else {
            state.repairError = planErrorText(error)
        }
    } finally {
        state.repairSaving = false
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
private fun PlanScanList(
    state: FollowPlanUiState,
    api: TaskBridgeApi,
    scope: CoroutineScope,
    listState: LazyListState,
) {
    val colors = MaterialTheme.colorScheme
    // Состояния списка названы явно: «сканирую», «ничего не найдено», «ошибка» и
    // «есть результат» — разные вещи, и путать их оператору незачем.
    val scan = state.scan
    val rows = scan?.let { planScanRows(it, state.scanQuery) }.orEmpty()
    val phase = planScanPhase(scan, state.scanBusy, state.scanError, rows.size)
    // Пока не сканировали, в панели нет ни поиска, ни списка: стартовое состояние
    // остаётся стартовым (FP-UX-05).
    if (phase == PlanScanPhase.IDLE) return
    OutlinedTextField(
        value = state.scanQuery,
        onValueChange = { state.scanQuery = it },
        singleLine = true,
        label = { Text("Поиск по имени и пути", style = MaterialTheme.typography.bodySmall) },
        modifier = Modifier.fillMaxWidth(),
    )
    when (phase) {
        PlanScanPhase.LOADING -> {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth().heightIn(min = 4.dp))
            Text("Сканирую проект…", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
            return
        }
        PlanScanPhase.ERROR -> {
            Text(state.scanError, style = MaterialTheme.typography.bodySmall, color = colors.error)
            TextButton(onClick = { scope.launch { runScan(state, api) } }) {
                Text("Повторить", style = MaterialTheme.typography.labelLarge)
            }
            return
        }
        PlanScanPhase.IDLE -> return
        PlanScanPhase.EMPTY, PlanScanPhase.READY -> Unit
    }
    if (scan == null) return
    Text(
        planScanStatusLine(scan, rows.size),
        style = MaterialTheme.typography.bodySmall,
        color = colors.onSurfaceVariant,
    )
    if (rows.isEmpty()) {
        Text(
            planScanEmptyText(scan, state.scanQuery),
            style = MaterialTheme.typography.bodySmall,
            color = colors.onSurfaceVariant,
        )
        return
    }
    // LazyColumn с ограниченной высотой: список прокручивается сам, а заголовок и
    // нижние действия панели остаются на месте. Строка 56 dp — палец, а не мышь.
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp),
    ) {
        items(rows, key = { it.path }) { row ->
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
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
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * Строка проекта: длинный путь сокращается, полный копируется по крестику-кнопке.
 * Собственного tooltip в common-коде нет, поэтому полный путь доступен именно
 * копированием — это работает и на Desktop, и на Android.
 */
@Composable
private fun PlanProjectPathRow(path: String?, onCopy: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val value = path?.trim().orEmpty()
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            if (value.isEmpty()) "Проект: —" else "Проект: $value",
            style = MaterialTheme.typography.bodySmall,
            color = colors.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (value.isNotEmpty()) {
            IconButton(
                onClick = { onCopy(value) },
                modifier = Modifier.size(32.dp),
            ) {
                Icon(AppIcons.Copy, "Скопировать путь проекта", Modifier.size(16.dp), tint = colors.onSurfaceVariant)
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
    // «Назад к файлам» первым: возвращает список с прежним поиском и прокруткой.
    TextButton(onClick = { state.inspection = null }, contentPadding = PaddingValues(0.dp)) {
        Text("Назад к файлам", style = MaterialTheme.typography.labelLarge)
    }
    Text(
        inspection.path.orEmpty().substringAfterLast('/'),
        style = MaterialTheme.typography.titleSmall,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
    Text(
        if (state.pendingBase64 != null) "Будет сохранён в проекте: ${inspection.path}"
        else "Файл в проекте: ${inspection.path}",
        style = MaterialTheme.typography.bodySmall,
        color = colors.onSurfaceVariant,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
    if (verdict == null) return
    Text(
        verdict.label,
        style = MaterialTheme.typography.bodyMedium,
        // Цвета — токены темы: положительный вердикт не должен выглядеть тревогой.
        color = when (verdict.verdict) {
            "VALID_MANAGED" -> colors.primary
            "CONVERTIBLE" -> colors.tertiary
            else -> colors.error
        },
    )
    val detail = listOf(
        verdict.hint,
        if (verdict.steps > 0) "шагов: ${verdict.steps}" else "",
        verdict.reasons.joinToString("; "),
    ).filter { it.isNotBlank() }.joinToString(" • ")
    if (detail.isNotBlank()) {
        Text(detail, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
    }
    // Предпросмотр будущего управляемого файла: показывается, но не пишется.
    if (verdict.preview.isNotBlank()) {
        TextButton(onClick = { state.previewOpen = !state.previewOpen }) {
            Text(
                if (state.previewOpen) "Скрыть предпросмотр" else "Предпросмотр управляемого файла",
                style = MaterialTheme.typography.labelLarge,
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
    // Файл не план или непригоден — предлагаем поправить формат здесь же.
    if (!verdict.canAttach) {
        TextButton(onClick = { scope.launch { openRepair(state, api, inspection.path.orEmpty()) } }, contentPadding = PaddingValues(0.dp)) {
            Text("Исправить формат", style = MaterialTheme.typography.labelLarge)
        }
    }
    if (state.repairPath != null) {
        Text("Файл: ${state.repairPath} — сохраняется только корректный управляемый план", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
        OutlinedTextField(
            value = state.repairText,
            onValueChange = { state.repairText = it; state.repairError = "" },
            modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 240.dp),
            textStyle = MaterialTheme.typography.bodySmall,
            label = { Text("Текст плана", style = MaterialTheme.typography.bodySmall) },
        )
        if (state.repairError.isNotBlank()) {
            Text(state.repairError, style = MaterialTheme.typography.bodySmall, color = colors.error)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { state.cancelRepair() }) { Text("Отмена", style = MaterialTheme.typography.labelLarge) }
            Button(
                onClick = { scope.launch { saveRepair(state, api, newId) } },
                enabled = !state.repairSaving,
                modifier = Modifier.heightIn(min = 44.dp),
            ) {
                Text(if (state.repairSaving) "Сохраняю…" else "Сохранить как план", style = MaterialTheme.typography.labelLarge)
            }
        }
    }
    if (verdict.canAttach) {
        TextButton(onClick = { scope.launch { runAiReview(state, api) } }, enabled = !state.aiBusy) {
            Text(
                if (state.aiBusy) "Спрашиваю модель…" else "Проверить с помощью ИИ",
                style = MaterialTheme.typography.labelLarge,
            )
        }
    }
    if (state.aiError.isNotBlank()) {
        Text(state.aiError, style = MaterialTheme.typography.bodySmall, color = colors.error)
    }
    planAiReviewView(state.aiReview)?.let { review ->
        Text(
            review.text,
            style = MaterialTheme.typography.bodySmall,
            color = colors.onSurfaceVariant,
            maxLines = 5,
            overflow = TextOverflow.Ellipsis,
        )
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        // «Отменить выбор» ничего не удаляет и не отключает.
        TextButton(onClick = { state.cancelSelection() }) {
            Text("Отменить выбор", style = MaterialTheme.typography.labelLarge)
        }
        if (verdict.canAttach) {
            Button(
                onClick = { scope.launch { importNow(state, api, newId) } },
                modifier = Modifier.heightIn(min = 44.dp),
            ) {
                Text(
                    if (state.overwrite) "Перезаписать и подключить" else verdict.confirmLabel,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}
