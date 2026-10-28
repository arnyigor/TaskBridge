package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.client.session.DraftAutosave

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.roundToInt
import ru.arny.taskbridge.core.client.chat.ACTIVE_STATUSES
import ru.arny.taskbridge.core.client.chat.ToolState
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.Json
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.ApiInfo
import ru.arny.taskbridge.core.api.Approval
import ru.arny.taskbridge.core.api.GenerationMetrics
import ru.arny.taskbridge.core.api.LocalModelEntry
import ru.arny.taskbridge.core.api.LocalModelMetrics
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.PendingPrompt
import ru.arny.taskbridge.core.api.Project
import ru.arny.taskbridge.core.api.ProviderWait
import ru.arny.taskbridge.core.api.QuickAction
import ru.arny.taskbridge.core.api.SessionStorage
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.session.ChatEffect
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.session.ChatSessionState
import ru.arny.taskbridge.core.client.session.LinkState
import ru.arny.taskbridge.core.client.session.OutgoingMessage
import ru.arny.taskbridge.core.client.session.SendMode
import ru.arny.taskbridge.core.client.session.describe
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.core.client.sessions.displayStateOf
import ru.arny.taskbridge.core.client.sessions.stageLabel
import ru.arny.taskbridge.platform.PlatformServices
import ru.arny.taskbridge.platform.rememberFilePicker
import ru.arny.taskbridge.ui.common.AdaptiveSheet
import ru.arny.taskbridge.ui.common.AppSnackbarHost
import ru.arny.taskbridge.ui.common.Banner
import ru.arny.taskbridge.ui.common.EmptyState
import ru.arny.taskbridge.ui.common.formatBytes
import ru.arny.taskbridge.ui.common.StatusDot
import ru.arny.taskbridge.ui.common.TypingPhase
import ru.arny.taskbridge.ui.common.formatMoment
import ru.arny.taskbridge.ui.common.humanDuration
import ru.arny.taskbridge.ui.common.parseIsoMillis
import ru.arny.taskbridge.ui.common.sinceLabel
import ru.arny.taskbridge.ui.common.sourceLabel
import ru.arny.taskbridge.ui.common.timeRange
import ru.arny.taskbridge.ui.sessions.FieldLabel
import ru.arny.taskbridge.ui.sessions.ModelPicker
import ru.arny.taskbridge.ui.sessions.formatLatencyMs
import ru.arny.taskbridge.ui.sessions.latencyFor
import ru.arny.taskbridge.ui.sessions.modelLatencyLabel
import ru.arny.taskbridge.ui.sessions.ModelChooser
import ru.arny.taskbridge.ui.sessions.ThinkingPicker
import ru.arny.taskbridge.ui.sessions.thinkingChoices
import ru.arny.taskbridge.ui.sessions.thinkingLabel
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors
import ru.arny.taskbridge.ui.theme.MonoStyle

/** A dialog the chat can show; one at a time. */
internal sealed interface ChatDialog {
    data class EditMessage(val turnId: String, val text: String) : ChatDialog
    data class EditAnswer(val turnId: String, val text: String) : ChatDialog
    /** [withAnswer]: started from an answer — the log is linear, so its question goes too. */
    data class DeleteFrom(val turnId: String, val withAnswer: Boolean = false) : ChatDialog
    data object ConfirmStop : ChatDialog
    data object ConfirmRestart : ChatDialog
    data object ConfirmClear : ChatDialog
    data object ConfirmDelete : ChatDialog
    data object ConfirmTrustWorkspace : ChatDialog
    data object Rename : ChatDialog
    data object ModelSettings : ChatDialog
    data object ChooseModel : ChatDialog

    /** MR-07: повтор последнего ответа с выбором параметров (модели). */
    data class Rerun(val turnId: String) : ChatDialog
}

@Composable
fun ChatScreen(
    graph: AppGraph,
    connection: AppGraph.Connected,
    taskId: String,
    onBack: () -> Unit,
    onOpenSession: (String) -> Unit,
    showBack: Boolean,
) {
    val session = remember(taskId) { connection.chat(taskId) }
    val state by session.state.collectAsState()
    // Follow Plan: одно состояние на иконку композитора и карточку над ним.
    val planState = rememberFollowPlanState(connection.api, taskId, state.chat.version)
    val sessionListState by connection.sessions.state.collectAsState()
    val online by connection.online.collectAsState()
    val platform = graph.platform
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    // «Оператор у низа ленты»: защёлка, которая переживает вставку элементов. Она
    // считается здесь, потому что от неё зависят обе стороны — и сама лента, и
    // кнопка «Новое».
    // Сколько пикселей от нижней границы ещё считается «у низа». В dp: на телефоне
    // 80 px ≈ 29 dp, то есть меньше одной строки — лента у низа считалась уехавшей.
    val nearBottomPx = with(LocalDensity.current) { NEAR_BOTTOM_DP.dp.roundToPx() }
    val bottomLatch = remember(taskId, nearBottomPx) { BottomLatch(nearBottomPx) }
    var following by remember(taskId) { mutableStateOf(true) }
    LaunchedEffect(listState, bottomLatch) {
        snapshotFlow {
            val chatItems = state.chat.items
            Triple(
                listState.firstVisibleItemIndex,
                listState.firstVisibleItemScrollOffset,
                chatItems.size to chatItems.lastOrNull()?.id,
            )
        }.collect { (index, offset, newestItem) ->
            bottomLatch.observe(index, offset, newestItem.first, newestItem.second)
            following = bottomLatch.following
        }
    }
    // Конец любой прокрутки — жест, флинг, колесо: решение принимается по тому, где
    // лента остановилась. Пока лента стоит на месте, приход контента этот флаг не
    // трогает вовсе — поэтому «сам по себе» он больше не выключается и не включается.
    LaunchedEffect(listState, bottomLatch) {
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (!scrolling) {
                bottomLatch.settle(listState.firstVisibleItemIndex, listState.firstVisibleItemScrollOffset)
                following = bottomLatch.following
            }
        }
    }
    var dialog by remember { mutableStateOf<ChatDialog?>(null) }
    // Ход, для которого оператор нажал «Подождать»: баннер молчания скрыт, пока
    // идёт этот же ход (turn совпадает); новый ход показывает баннер снова.
    var silenceWaitTurn by remember { mutableStateOf<Long?>(null) }
    // Файлы смотрятся в док-панели справа (широкое окно) или шитом снизу (телефон).
    // Вкладки живут здесь, а не в просмотрщике: второй файл не закрывает первый,
    // а ссылка внутри открытого Markdown открывается рядом с ним.
    val fileTabs = rememberFileTabs(taskId)
    fun openFile(target: FileTarget) = fileTabs.open(target)
    var panelWidth by remember { mutableStateOf(panelWidthSetting(graph.settings.filePanelWidth)) }
    var files by remember(taskId) { mutableStateOf<List<UploadFile>>(emptyList()) }
    var draft by remember(taskId) { mutableStateOf(TextFieldValue(graph.settings.draft(taskId))) }
    val draftAutosave = remember(connection, taskId) {
        DraftAutosave(scope, graph.settings.draft(taskId), { graph.settings.saveDraft(taskId, it) })
    }
    DisposableEffect(draftAutosave) {
        onDispose { draftAutosave.close(draft.text) }
    }
    // The picker keeps its own copy; this one feeds the status bar's TTFT.
    var screenCatalog by remember { mutableStateOf<ModelCatalog?>(null) }
    var quickActions by remember(connection, taskId) { mutableStateOf(fallbackQuickActions()) }
    val pickFiles = rememberFilePicker { picked -> files = files + picked }

    LaunchedEffect(connection) { connection.sessions.models().onSuccess { screenCatalog = it }.onFailure { /* chooser can retry */ } }
    // Живая телеметрия движка приходит только из /api/info: в SSE её нет, а список
    // при открытом чате опрашивается редко (единственная активная сессия покрыта SSE,
    // интервал уходит в 30 с). Пока ход идёт, спрашиваем в темпе движка — это
    // ровно то, без чего « Модель читает промпт · 40% » появлялся только по счастливой
    // случайности (STAB-STATUS-01). После хода опрос прекращается сразу.
    val engineStatus = state.task?.status
    LaunchedEffect(connection, taskId, engineStatus) {
        if (engineStatus !in ACTIVE_STATUSES) return@LaunchedEffect
        while (true) {
            if (shouldRefreshEngineInfo(activeTurn = true, inForeground = graph.platform.inForeground)) {
                connection.sessions.refreshInfo()
            }
            delay(ENGINE_INFO_INTERVAL_MS)
        }
    }
    LaunchedEffect(connection, taskId, state.task?.runtime?.state) {
        quickActions = runCatching { connection.api.quickActions(taskId) }.getOrDefault(fallbackQuickActions()).ifEmpty { fallbackQuickActions() }
    }
    // Размер сессии на диске компьютера. Сервер измеряет его сам (кэш 5 минут), здесь
    // только показ: отказ запроса не должен мешать чату, поэтому runCatching.
    var storage by remember(taskId) { mutableStateOf<SessionStorage?>(null) }
    LaunchedEffect(connection, taskId, state.task?.turnState?.turn) {
        storage = runCatching { connection.api.sessionStorage(taskId) }.getOrNull()
    }

    DisposableEffect(taskId) {
        connection.showChat(taskId)
        connection.clearAttention(taskId)
        graph.settings.lastSessionId = taskId
        platform.clearNotification(taskId)
        onDispose { connection.hideChat(taskId) }
    }
    LaunchedEffect(draftAutosave) {
        snapshotFlow { draft.text }.collect { draftAutosave.update(it) }
    }
    LaunchedEffect(session) {
        session.effects.collect { effect ->
            when (effect) {
                is ChatEffect.Notice -> snackbar.showSnackbar(effect.message)
                is ChatEffect.RestoreComposer -> draft = TextFieldValue(effect.text)
                is ChatEffect.OpenSession -> onOpenSession(effect.taskId)
                ChatEffect.Deleted -> {
                    connection.sessions.forget(taskId)
                    connection.closeChat(taskId)
                    onBack()
                }
            }
        }
    }

    val task = state.task
    val displayState = task?.let { displayStateOf(it) } ?: DisplayState.UNKNOWN
    val working = displayState == DisplayState.WORKING || displayState == DisplayState.WAITING_USER
    val historyLocked = working || displayState == DisplayState.QUEUED

    fun send(mode: SendMode) {
        val text = draft.text
        if (text.isBlank() && files.isEmpty()) return
        session.send(text, files, mode)
        draft = TextFieldValue("")
        files = emptyList()
        draftAutosave.flush("")
        scope.launch { listState.animateScrollToItem(0) }
    }

    // Иконка папки в шапке: папку открывает файловый менеджер на самом ПК, поэтому
    // неудача (чужой сервер, папки ещё нет) должна быть видна словами, а не молчанием.
    fun openSessionFolder() {
        scope.launch {
            session.openSessionFolderOnComputer()
                .onSuccess {
                    snackbar.currentSnackbarData?.dismiss()
                    snackbar.showSnackbar("Папка сессии открыта на компьютере")
                }
                .onFailure { error ->
                    snackbar.showSnackbar((error as? ApiException)?.let { e -> describe(e.error) } ?: error.message ?: "Не удалось открыть папку")
                }
        }
    }

    // Выбор нескольких сообщений (как «Select messages» в ChatGPT): тап по сообщению
    // отмечает его, «Копировать» отправляет отмеченные в буфер в порядке ленты.
    var selecting by remember(taskId) { mutableStateOf(false) }
    val selectedIds = remember(taskId) { mutableStateMapOf<String, Boolean>() }
    fun toggleSelected(id: String) {
        selectedIds[id] = selectedIds[id] != true
    }

    var copyingHistory by remember { mutableStateOf(false) }
    LaunchedEffect(copyingHistory) {
        if (!copyingHistory) return@LaunchedEffect
        // Оператор 2026-10-14: «копировать историю не работает». Причина была не в
        // сборке текста (она чистая и покрыта тестом), а в ожидании страниц: без
        // ограничения на страницу зависший запрос останавливал весь путь, и копии
        // не было вообще. Плюс флаг снимался в конце: одна зависшая попытка
        // оставляла его поднятым, и следующие нажатия ничего не делали.
        //
        // Поэтому: ограниченное ожидание на страницу, копируется то, что успело
        // загрузиться, а флаг снимается всегда.
        try {
            while (!session.state.value.reachedStart) {
                val count = session.state.value.chat.items.size
                session.loadOlder()
                // Ждём окончания страницы, но не вечно: сеть может не ответить вовсе.
                withTimeoutOrNull(PAGE_WAIT_MS) { session.state.first { !it.loadingOlder } }
                val loaded = session.state.value
                if (loaded.chat.items.size == count && !loaded.reachedStart) break
                if (loaded.loadingOlder) break // страница так и не завершилась — копируем что есть
            }
            val current = session.state.value
            platform.copyText(chatTranscript(current.chat.items, current.task?.displayTitle) { start, end -> timeRange(platform, start, end) })
            snackbar.currentSnackbarData?.dismiss()
            snackbar.showSnackbar(if (current.reachedStart) "История чата скопирована" else "Скопирована только загруженная часть истории")
        } finally {
            copyingHistory = false
        }
    }

    // Файл открывается в док-панели справа (широкое окно) или шитом снизу (телефон):
    // панель забирает ширину у чата, а не закрывает его, — ответ, который упоминает
    // файл, остаётся на экране, пока файл читают.
    ChatWithFilePanel(
        tabs = fileTabs,
        session = session,
        platform = platform,
        width = panelWidth,
        onWidth = { panelWidth = it },
        // Ширина пишется в настройки по окончании перетаскивания, а не на каждый кадр.
        onWidthCommitted = { graph.settings.filePanelWidth = panelWidth.value.toInt() },
        onOpenPath = { link -> openFile(FileTarget.Workspace(link.path, link.line, link.endLine)) },
        onEscape = {
            when {
                // Открытый диалог — отдельное окно и обрабатывает Esc сам.
                dialog != null -> false
                // Панель ближе всего: Esc закрывает файл, а не ход. СТОП — следующим Esc.
                fileTabs.items.isNotEmpty() -> { fileTabs.closeActive(); true }
                // Esc = жёсткий стоп, как в консоли: подтверждение → killTree.
                canStop(task?.status, state.outbox.size) -> { dialog = ChatDialog.ConfirmStop; true }
                else -> false
            }
        },
    ) {
        Scaffold(
            topBar = {
                ChatTopBar(
                    state = state,
                    projectPath = projectPathFor(state.task, sessionListState.projects),
                    working = working,
                    showBack = showBack,
                    onBack = onBack,
                    onDialog = { dialog = it },
                    onCopyHistory = { copyingHistory = true },
                    onSelectMessages = { selectedIds.clear(); selecting = true },
                    // Папки нет — открывать нечего: у свежей сессии рабочая папка ещё не
                    // подготовлена, и сервер ответил бы 404.
                    onOpenFolder = if (canOpenSessionFolder(platform.kind, state.task?.workspacePath)) ::openSessionFolder else null,
                )
            },
            // The composer pads for the navigation bar itself; Scaffold adding it too left a blank strip.
            contentWindowInsets = WindowInsets(0),
        ) { padding ->
            Column(
                // Полоса выбора идёт над лентой: счётчик и кнопки должны быть видны там же,
                // где отметки, а не в меню, которое уже закрылось.

                Modifier.padding(padding).fillMaxSize().imePadding(),
            ) {
                if (!online) Banner("Устройство offline — показана сохранённая история, команды останутся в outbox", AppIcons.Alert, LocalStatusColors.current.waiting)
                LinkBanner(state.link, onRetry = { session.reconnectNow() })
                // Сессия хранит журнал кадров (вывод инструментов) и вложения: гигабайты
                // набираются незаметно. Предупреждение — только текст, ничего не удаляется.
                sessionStorageWarning(storage)?.let { warning ->
                    Banner(warning, AppIcons.Layers, LocalStatusColors.current.waiting)
                }
                // Шаг C-A: таймер молчания. Сервер считает silentMs у себя (клиент не
                // вычитает часы другого устройства); «Подождать» прячет баннер до нового
                // хода, STOP идёт через уже существующее подтверждение.
                val silence = silenceState(task)
                if (silence != null && task?.turnState?.turn != silenceWaitTurn) {
                    SilenceBanner(
                        silence,
                        onWait = { silenceWaitTurn = task?.turnState?.turn },
                        onStop = { dialog = ChatDialog.ConfirmStop },
                        onRestart = { dialog = ChatDialog.ConfirmRestart },
                    )
                }
                // Полоса выбора стоит над лентой: счётчик и кнопки должны быть видны там же,
                // где отметки, а не в меню, которое уже закрылось.
                if (selecting) {
                    SelectionBar(
                        count = selectedIds.count { it.value },
                        onCopy = {
                            // Тексты те же, что у одиночного «Копировать», в порядке ленты.
                            val texts = selectedMessages(state.chat.items, selectedIds.filterValues { it }.keys)
                            platform.copyText(texts.joinToString("\n\n"))
                            snackbar.currentSnackbarData?.dismiss()
                            scope.launch { snackbar.showSnackbar(if (texts.size == 1) "Сообщение скопировано" else "Скопировано сообщений: ${texts.size}") }
                            selecting = false
                            selectedIds.clear()
                        },
                        onCancel = { selecting = false; selectedIds.clear() },
                    )
                }
                // Один таймер фаз «агент пишет» на ленту: точки читают его из LocalTypingPhase
                // и не заводят собственных анимаций. Пока генерации нет, active = false
                // и лишних кадров не запрашивается вовсе.
                val generating = remember(state.chat.items) {
                    state.chat.items.any { it is ChatItem.Assistant && it.active }
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    // «Пользователь у низа» решается ДО отрисовки ленты: от этого флага
                    // зависят обе стороны поведения — держать низ или не давать ленте
                    // сдвинуть чтение.
                    val showJump = !following
                    when {
                        state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                        state.link is LinkState.Failed && state.chat.items.isEmpty() -> EmptyState(
                            AppIcons.Alert,
                            "Сессию не открыть",
                            describe((state.link as LinkState.Failed).error),
                        )
                        else -> TypingPhase(active = generating) {
                            MessageList(
                                graph = graph,
                                session = session,
                                state = state,
                                listState = listState,
                                following = following,
                                historyLocked = historyLocked,
                                onDialog = { dialog = it },
                                onViewFile = { openFile(it) },
                                onCopyMessage = { text ->
                                    platform.copyText(text)
                                    snackbar.currentSnackbarData?.dismiss()
                                    scope.launch { snackbar.showSnackbar("Сообщение скопировано") }
                                },
                                selectionMode = selecting,
                                selectedIds = selectedIds,
                                onToggleSelect = ::toggleSelected,
                            )
                        }
                    }
                    // Reading older messages: the list stays put; new output only lights up the jump button.
                    val newest = state.chat.items.lastOrNull()
                    val newestSignature = newest?.let { it.id + ((it as? ChatItem.Assistant)?.let { a -> a.text.length + a.tools.size } ?: 0) }
                    var seenSignature by remember { mutableStateOf(newestSignature) }
                    LaunchedEffect(showJump, newestSignature) { if (!showJump) seenSignature = newestSignature }
                    val hasNew = showJump && newestSignature != seenSignature
                    // Qualified: inside Box-in-Column the ColumnScope overload would win and is illegal here.
                    androidx.compose.animation.AnimatedVisibility(showJump, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.BottomCenter).padding(12.dp)) {
                        SmallFloatingActionButton(onClick = { scope.launch { listState.animateScrollToItem(0) } }) {
                            Row(Modifier.padding(horizontal = if (hasNew) 12.dp else 0.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(AppIcons.ArrowDown, "К последнему сообщению", Modifier.size(18.dp))
                                if (hasNew) {
                                    Spacer(Modifier.width(6.dp))
                                    Text("Новое", style = MaterialTheme.typography.labelLarge)
                                }
                            }
                        }
                    }
                }
                // Above the composer rather than over it: the field and its buttons must stay reachable
                // while a notice is on screen.
                AppSnackbarHost(snackbar, Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp))
                for (approval in state.approvals) {
                    ApprovalCard(approval, busy = "approval:${approval.approvalId}" in state.busy, onAnswer = { allow -> session.answerApproval(approval.approvalId, allow) })
                }
                Composer(
                    moreItems = { close ->
                        if (task != null) {
                            DropdownMenuItem(text = { Text("Выбрать модель") }, leadingIcon = { Icon(AppIcons.Spark, null) }, onClick = { close(); dialog = ChatDialog.ChooseModel })
                            DropdownMenuItem(text = { Text("Настройки сессии") }, leadingIcon = { Icon(AppIcons.Layers, null) }, onClick = { close(); dialog = ChatDialog.ModelSettings })
                            DropdownMenuItem(text = { Text("Сжать контекст") }, leadingIcon = { Icon(AppIcons.Layers, null) }, enabled = !working, onClick = { close(); session.compact() })
                            DropdownMenuItem(text = { Text("Перезапустить сессию") }, leadingIcon = { Icon(AppIcons.Refresh, null) }, onClick = { close(); session.restartSession() })
                            DropdownMenuItem(
                                text = { Text(if (task.workspaceTrusted) "Папка доверенная" else "Доверять папке") },
                                leadingIcon = { Icon(AppIcons.Shield, null) },
                                enabled = task.workspacePath != null && !task.workspaceTrusted && "workspace-trust" !in state.busy,
                                onClick = { close(); dialog = ChatDialog.ConfirmTrustWorkspace },
                            )
                        }
                    },
                    top = {
                        // Follow Plan: карточка плана над полем ввода; сама иконка
                        // режима живёт в ряду композитора (planButton).
                        DeliveryDiagnostics(state, info = sessionListState.info, catalog = screenCatalog, platform = platform, nowMillis = graph::nowMillis, onRefresh = session::reconnectNow, onCopy = platform::copyText)
                        if (task != null && task.pendingPrompts.isNotEmpty()) {
                            QueueLine(task.pendingPrompts, working = working, busy = state.busy, onSendNow = { session.sendPendingNow(it) }, onDrop = { session.dropPending(it) })
                        }
                        for (message in state.outbox) {
                            OutboxRow(
                                message,
                                onRetry = { session.retry(message.commandId) },
                                onEdit = {
                                    draft = TextFieldValue(message.text)
                                    session.dismiss(message.commandId)
                                },
                                onDismiss = { session.dismiss(message.commandId) },
                            )
                        }
                    },
                    planButton = {
                        FollowPlanIcon(
                            state = planState,
                            api = connection.api,
                            newId = graph::newId,
                            scope = scope,
                            projectPath = task?.workspacePath,
                            platformKind = platform.kind,
                            onOpenPlan = { path -> openFile(FileTarget.Workspace(path)) },
                            onCopy = platform::copyText,
                            onNotice = { message -> scope.launch { snackbar.showSnackbar(message) } },
                        )
                    },
                    value = draft,
                    onValueChange = { next ->
                        val paste = pastedTextDraft(draft.text, next.text, graph.nowIso())
                        draft = paste.caret
                            ?.let { TextFieldValue(paste.text, TextRange(it.coerceIn(0, paste.text.length))) }
                            ?: next
                        paste.attached?.let { attached ->
                            files = files + attached
                            scope.launch { snackbar.showSnackbar("Большой вставленный текст прикреплён файлом") }
                        }
                    },
                    files = files,
                    quickActions = quickActions,
                    onQuickAction = { action -> draft = draft.withSlashCommand(action.insertText) },
                    fileCompletions = { session.workspaceFiles().getOrNull()?.entries ?: emptyList() },
                    onRemoveFile = { files = files - it },
                    onAttach = pickFiles,
                    onPaste = { pasted -> if (pasted.isEmpty()) scope.launch { snackbar.showSnackbar("В буфере нет картинки или файлов") } else files = files + pasted },
                    working = working,
                    enterSends = graph.settings.enterSends && platform.kind == "desktop",
                    enabled = state.link !is LinkState.Failed || (state.link as LinkState.Failed).error !is ApiError.NotFound,
                    onSend = { send(it) },
                    onStop = if (canStop(task?.status, state.outbox.size)) ({ dialog = ChatDialog.ConfirmStop }) else null,
                )
            }
        }
    }

    ChatDialogs(dialog, state, session, graph, send = { send(it) }, onDialog = { dialog = it }, onViewFile = { openFile(it) }, onClose = { dialog = null })
}

@Composable
private fun ChatTopBar(
    state: ChatSessionState,
    projectPath: String?,
    working: Boolean,
    showBack: Boolean,
    onBack: () -> Unit,
    onDialog: (ChatDialog) -> Unit,
    onCopyHistory: () -> Unit,
    onSelectMessages: () -> Unit,
    /** null — папку открыть нельзя (телефон или у сессии ещё нет рабочей папки). */
    onOpenFolder: (() -> Unit)?,
) {
    var menu by remember { mutableStateOf(false) }
    val task = state.task
    val display = task?.let(::displayStateOf)
    val headerModel = task?.model ?: task?.requestedModel
    TopAppBar(
        // Чуть выше дефолтных 64 dp: под названием теперь три строки (название,
        // статус с моделью, путь проекта), и без этого их срезало бы.
        //
        // Именно expandedHeight, а не Modifier.height: инсет статус-бара TopAppBar
        // прибавляет сам, а фиксированная высота включала его внутрь — на телефоне
        // от 88 dp оставалось ~64, и третья строка (путь проекта) вылезала на ленту.
        expandedHeight = 88.dp,
        navigationIcon = {
            if (showBack) IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад") }
        },
        title = {
            Column(Modifier.padding(vertical = 4.dp)) {
                Text(task?.displayTitle ?: "Сессия", modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = task != null) { onDialog(ChatDialog.ModelSettings) }, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (display != null) {
                        StatusDot(display, size = 7)
                        Text(
                            if (display.active) stageLabel(task.status) else display.label,
                            modifier = Modifier.widthIn(max = 96.dp),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    headerModel?.let { model ->
                        val modelTitle = modelFullLabel(model)
                        Row(
                            Modifier.weight(1f, fill = false)
                                .clip(RoundedCornerShape(8.dp))
                                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                                .clickable { onDialog(ChatDialog.ChooseModel) }
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(AppIcons.Spark, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.primary)
                            Spacer(Modifier.width(4.dp))
                            Text(modelTitle, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                // Путь проекта рядом с названием: видно, какой папке принадлежит
                // чат. Только когда он реально известен — «—» в шапке не нужен.
                projectPath?.let { path ->
                    Text(
                        path,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        actions = {
            onOpenFolder?.let { open ->
                IconButton(onClick = open) { Icon(AppIcons.Folder, "Открыть папку сессии") }
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(AppIcons.More, "Меню сессии") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Копировать историю") }, leadingIcon = { Icon(AppIcons.Copy, null) }, enabled = state.chat.items.isNotEmpty(), onClick = { menu = false; onCopyHistory() })
                    DropdownMenuItem(text = { Text("Выбрать сообщения") }, leadingIcon = { Icon(AppIcons.Check, null) }, enabled = state.chat.items.isNotEmpty(), onClick = { menu = false; onSelectMessages() })
                    DropdownMenuItem(text = { Text("Переименовать") }, leadingIcon = { Icon(AppIcons.Edit, null) }, onClick = { menu = false; onDialog(ChatDialog.Rename) })
                    DropdownMenuItem(text = { Text("Очистить чат") }, leadingIcon = { Icon(AppIcons.Eraser, null) }, enabled = !working, onClick = { menu = false; onDialog(ChatDialog.ConfirmClear) })
                    DropdownMenuItem(
                        text = { Text("Удалить сессию", color = MaterialTheme.colorScheme.error) },
                        leadingIcon = { Icon(AppIcons.Delete, null, tint = MaterialTheme.colorScheme.error) },
                        onClick = { menu = false; onDialog(ChatDialog.ConfirmDelete) },
                    )
                }
            }
        },
    )
}

/**
 * Полоса выбора сообщений: сколько отмечено, скопировать отмеченные или выйти из
 * режима. «Копировать» выключена, пока ничего не отмечено — иначе в буфер ушла бы
 * пустая строка.
 */
@Composable
private fun SelectionBar(count: Int, onCopy: () -> Unit, onCancel: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (count > 0) "Выбрано: $count" else "Отметьте сообщения",
                style = MaterialTheme.typography.labelLarge,
            )
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onCopy, enabled = count > 0) { Text("Копировать") }
            TextButton(onClick = onCancel) { Text("Отмена") }
        }
    }
}

/**
 * Путь проекта сессии для шапки чата (запрос оператора: рядом с названием видеть
 * папку). Проект ищется по projectId задачи; пустой/отсутствующий путь не
 * показывается. Чистая функция — проверяется в ProjectPathTest без устройства.
 */
internal fun projectPathFor(task: Task?, projects: List<Project>): String? =
    task?.projectId?.takeIf { it.isNotBlank() }
        ?.let { id -> projects.firstOrNull { it.id == id } }
        ?.path?.takeIf { it.isNotBlank() }

/**
 * Показывать ли иконку «открыть папку сессии» в шапке чата. Папку открывает файловый
 * менеджер на самом ПК, поэтому у телефона кнопки нет (сервер всё равно ответит 403),
 * и нет её у свежей сессии — рабочая папка появляется только после подготовки, а до неё
 * открывать нечего. Чистая функция — проверяется в OpenFolderTest без устройства.
 */
internal fun canOpenSessionFolder(kind: String, workspacePath: String?): Boolean =
    kind == "desktop" && !workspacePath.isNullOrBlank()

/**
 * The conversation as plain text: who, when, what. Tools stay one line each
 * ("Выполнил: npm test") — the outputs are not loaded and would bury the talk.
 */
internal fun chatTranscript(items: List<ChatItem>, title: String?, time: (start: String?, end: String?) -> String): String = buildString {
    if (!title.isNullOrBlank()) append("# ").append(title).append("\n\n")
    for (item in items) {
        when (item) {
            is ChatItem.User -> {
                val at = time(item.at, null)
                append("## Вы").append(if (at.isNotEmpty()) " · $at" else "").append("\n")
                append(item.text.trim()).append("\n")
                if (item.files.isNotEmpty()) append("Файлы: ").append(item.files.joinToString { it.name ?: "файл" }).append("\n")
            }
            is ChatItem.Assistant -> {
                val at = time(item.at, item.endedAt)
                append("## Агент").append(if (at.isNotEmpty()) " · $at" else "").append("\n")
                for (tool in item.tools) {
                    append("> ").append(toolVerb(tool.name, running = false))
                    toolTarget(tool)?.let { append(": ").append(it) }
                    if (tool.state == ToolState.ERROR) append(" — ошибка")
                    append("\n")
                }
                if (item.tools.isNotEmpty() && item.text.isNotBlank()) append("\n")
                if (item.text.isNotBlank()) append(item.text.trim()).append("\n")
                item.error?.let { append("Ошибка: ").append(it).append("\n") }
            }
            is ChatItem.Note -> append("— ").append(item.text).append(" —\n")
        }
        append("\n")
    }
}.trimEnd() + "\n"

/**
 * Один элемент так, как его копирует кнопка «Копировать» у сообщения: для заметки —
 * в том же виде, в каком она стоит в транскрипте («— … —»), иначе текст как есть.
 *
 * Вынесено из обработчиков кнопок, чтобы «скопировать одно» и «скопировать
 * выбранные» не расходились: второе — это те же тексты через пустую строку.
 */
internal fun ChatItem.copyText(): String = when (this) {
    is ChatItem.User -> text.trim()
    is ChatItem.Assistant -> text.trim()
    is ChatItem.Note -> "— ${text.trim()} —"
}

/**
 * Тексты выбранных сообщений — как «Copy» после выбора сообщений в ChatGPT: в порядке
 * ленты, без заголовков и пометок ролей.
 *
 * Порядок задаёт сама лента (`items`), а не порядок нажатий: в буфер уезжает то, что
 * видно сверху вниз. Пустые (ход без текста, из одних вызовов инструментов)
 * выбрасываются здесь же — иначе в тексте оставались бы пустые абзацы, а счётчик
 * «скопировано сообщений» считал бы то, чего в буфере нет.
 */
internal fun selectedMessages(items: List<ChatItem>, selected: Set<String>): List<String> =
    items.filter { it.id in selected }.map { it.copyText() }.filter { it.isNotEmpty() }

/** Те же тексты одним куском: между сообщениями пустая строка. */
internal fun selectedMessagesText(items: List<ChatItem>, selected: Set<String>): String =
    selectedMessages(items, selected).joinToString("\n\n")

@Composable
private fun LinkBanner(link: LinkState, onRetry: () -> Unit) {
    when (link) {
        is LinkState.Reconnecting -> Banner(
            text = "Нет связи с компьютером — переподключение через ${(link.inMillis / 1000).coerceAtLeast(1)} с",
            icon = AppIcons.Offline,
            color = LocalStatusColors.current.waiting,
            action = "Сейчас",
            onAction = onRetry,
        )
        // Сервер отвечает, поток оборван: это другая поломка, чем «нет связи», и
        // лечится ожиданием, а не проверкой сети на компьютере (план 4.2).
        is LinkState.Degraded -> Banner(
            text = "Компьютер отвечает, но поток событий оборван — переподключаюсь через ${(link.inMillis / 1000).coerceAtLeast(1)} с",
            icon = AppIcons.Alert,
            color = LocalStatusColors.current.waiting,
            action = "Сейчас",
            onAction = onRetry,
        )
        is LinkState.Failed -> Banner(
            text = when (link.error) {
                is ApiError.NotFound -> "Сессия удалена на компьютере."
                else -> describe(link.error)
            },
            icon = AppIcons.Alert,
            color = MaterialTheme.colorScheme.error,
        )
        else -> Unit
    }
}

/**
 * Состояние связи словами для панели «Диагностика» (и любого другого места).
 *
 * Раньше сюда подставлялся сам объект состояния: после появления DEGRADED
 * (двухуровневый health, план 4.2) оператор увидел бы
 * «Degraded(attempt=2, inMillis=2000, reason=…)» — то, по чему нельзя решать.
 */
/**
 * Предупреждение о размере сессии на диске компьютера; null — предупреждать не о чем.
 *
 * Порог считает сервер (`storage.warnSessionMb`), клиент договаривает следствие:
 * место занимают журнал кадров (вывод инструментов) и вложения сессии, освободить
 * его можно удалением сессии. Автоматически ничего не удаляется и не ограничивается.
 */
internal fun sessionStorageWarning(storage: SessionStorage?): String? {
    if (storage?.warn != true) return null
    val atLeast = if (storage.partial) "не менее " else ""
    return "Сессия занимает $atLeast${formatBytes(storage.bytes)} на диске компьютера — это её журнал и вложения. " +
        "Освободить место можно удалением сессии"
}

internal fun linkLabel(link: LinkState): String = when (link) {
    LinkState.Connecting -> "подключаюсь"
    LinkState.Live -> "поток подключён"
    is LinkState.Degraded ->
        "компьютер отвечает, поток событий оборван (попытка ${link.attempt}, через ${link.inMillis / 1000} с)"
    is LinkState.Reconnecting ->
        "нет связи с компьютером (попытка ${link.attempt}, через ${link.inMillis / 1000} с)"
    is LinkState.Failed -> describe(link.error)
}

/**
 * Нужно ли вернуть ленте позицию чтения после прихода контента.
 *
 * Отдельная функция, потому что именно охрана здесь и ошибается: вернуть ленту в
 * момент, когда палец ею двигает, — это лишний скролл поверх жеста (а на
 * desktop это уже приводило к аварийному завершению), а возврат к тому же месту,
 * где пользователь и стоит, — бессмысленная работа на каждый дельта-чанк.
 */
/**
 * Якорь чтения: элемент, на котором стоит оператор, вместе со смещением внутри него.
 *
 * Почему отдельным объектом, а не двумя `remember` в композабле: инвариант здесь
 * ровно один и его нужно уметь проверять — «пришёл контент, а позиция чтения та же».
 * Элемент адресуется КЛЮЧОМ, а не индексом: при новой дельте или при догрузке
 * старой страницы индексы сдвигаются, а ключ — нет (2026-10-14).
 */
internal class ReadingAnchor {
    var key: String? = null
        private set
    var offset: Int = 0
        private set

    /**
     * Позиция ленты изменилась: запоминаем, где оператор остановился.
     *
     * Раньше запоминание шло только при `isScrollInProgress` (то есть при жесте или
     * анимации). Колесо мыши и мгновенные переходы этот флаг не поднимают, якорь
     * оставался от прошлого жеста — и первая же дельта возвращала ленту туда: «скролл
     * в самый низ при получении чанков» и «скролл вверх при добавлении элемента»
     * (оператор 2026-10-17). Поэтому теперь запоминается любая позиция, которую
     * сдвинул не приход контента, а сам оператор — любым способом.
     */
    fun record(contentArrived: Boolean, index: Int, offset: Int, keyOf: (Int) -> String?) {
        if (contentArrived) return
        keyOf(index)?.let { key = it }
        this.offset = offset
    }

    /**
     * Куда вернуть ленту, если она уехала от якоря; null — возвращать нечего
     * (нет якоря, элемент исчез из ленты, оператор внизу или двигает ленту сам).
     */
    fun target(
        following: Boolean,
        scrolling: Boolean,
        currentIndex: Int,
        currentOffset: Int,
        indexOf: (String) -> Int,
    ): Pair<Int, Int>? {
        val anchorKey = key ?: return null
        val index = indexOf(anchorKey)
        if (!needsReadingRestore(following, scrolling, currentIndex, currentOffset, index, offset)) return null
        return index to offset
    }
}

/**
 * «Оператор у низа ленты» — защёлка, а не мгновенный замер.
 *
 * Замер `firstVisibleItemIndex == 0` ошибается ровно в тот момент, когда решается
 * судьба ленты: новый элемент встаёт нулевым, прежний низ уезжает на индекс 1, и
 * лента, которую никто не трогал, считается прокрученной вверх — новый элемент
 * остаётся за нижней границей, а «Новое» загорается на пустом месте. Поэтому уход
 * от низа засчитывается только тогда, когда позиция изменилась БЕЗ прихода
 * контента: значит, это жест, колесо или программный переход.
 */
internal class BottomLatch(private val nearBottomPx: Int = 80) {
    var following: Boolean = true
        private set
    private var seenCount: Int = -1
    private var seenNewest: String? = null

    fun observe(index: Int, offset: Int, count: Int, newestId: String?) {
        val contentChanged = count != seenCount || newestId != seenNewest
        seenCount = count
        seenNewest = newestId
        following = when {
            index == 0 && offset <= nearBottomPx -> true
            // Индекс сдвинула вставка (или удаление), а не жест: низ остаётся низом.
            contentChanged -> following
            else -> false
        }
    }

    /**
     * Прокрутка закончилась (жест, флинг, колесо) — решение по тому, где лента встала.
     *
     * Это главный сигнал: `isScrollInProgress` поднимается и от касания, и от колеса
     * (замерено), а на приход контента не реагирует вовсе. В отличие от [observe],
     * здесь нечему сбиться: переокно истории или переподключение в момент жеста больше
     * не могут «защитать» уход от низа как приход контента (жалоба 2026-10-17:
     * «на телефоне при получении сообщения идёт автоскролл вниз»).
     */
    fun settle(index: Int, offset: Int) {
        following = index == 0 && offset <= nearBottomPx
    }
}

/** Насколько близко к нижней границе считается «у низа», в dp. */
internal const val NEAR_BOTTOM_DP = 40

internal fun needsReadingRestore(
    following: Boolean,
    scrolling: Boolean,
    currentIndex: Int,
    currentOffset: Int,
    targetIndex: Int,
    targetOffset: Int,
): Boolean {
    if (following || scrolling) return false
    if (targetIndex < 0) return false
    return currentIndex != targetIndex || currentOffset != targetOffset
}

@Composable
internal fun MessageList(
    graph: AppGraph,
    session: ChatSession,
    state: ChatSessionState,
    listState: androidx.compose.foundation.lazy.LazyListState,
    /**
     * Пользователь у низа ленты и хочет видеть новое.
     *
     * Ложь — он читает выше низа, и тогда приходящий контент не имеет права
     * сдвинуть вид. Это и был баг 2026-10-14: при `reverseLayout` растущий
     * ответ (он же нижний элемент, он же якорь) толкал ленту, и чтение уезжало
     * само — «при получении контента всё равно скроллится».
     */
    following: Boolean,
    historyLocked: Boolean,
    onDialog: (ChatDialog) -> Unit,
    onViewFile: (FileTarget) -> Unit,
    onCopyMessage: (String) -> Unit,
    /** Режим выбора сообщений: у каждого видна отметка, тап переключает выбор. */
    selectionMode: Boolean = false,
    selectedIds: Map<String, Boolean> = emptyMap(),
    onToggleSelect: (String) -> Unit = {},
) {
    val platform = graph.platform
    val ownClient = graph.settings.clientId
    val items = state.chat.items
    val reversed = remember(items) { items.asReversed() }

    // Якорь чтения: элемент, на котором стоит пользователь, и смещение внутри
    // него. Обновляется на каждом сдвиге, который сделал сам оператор, и
    // восстанавливается, когда контент пришёл, а пользователь читает выше низа.
    //
    // Почему так, а не через dispatchRawDelta: тот вариант уже один раз оставил
    // LazyList с незавершённым скроллом и уронил десктоп («entered drag with
    // non-zero pending scroll»), поэтому компенсация роста через raw-дельты здесь
    // запрещена сознательно (см. ChatItems.Pinned). Здесь только публичные
    // чтение состояния и scrollToItem, и то лишь когда состояние разошлось.
    val readingAnchor = remember(state.taskId) { ReadingAnchor() }
    // Сигнатура приходящего контента: длина растущего ответа и число сообщений.
    val newest = items.lastOrNull()
    val contentSignature = items.size to ((newest as? ChatItem.Assistant)?.let { it.text.length + it.tools.size } ?: 0)
    // Живой список для эффекта ниже: обычная переменная застыла бы на составе,
    // в котором эффект запустился, и приход контента был бы не виден.
    val latestItems by rememberUpdatedState(items)
    LaunchedEffect(listState) {
        var seen: Pair<Int, Int>? = null
        snapshotFlow {
            val now = latestItems
            val last = now.lastOrNull()
            Triple(
                listState.firstVisibleItemIndex,
                listState.firstVisibleItemScrollOffset,
                now.size to ((last as? ChatItem.Assistant)?.let { it.text.length + it.tools.size } ?: 0),
            )
        }.collect { (index, offset, signature) ->
            // Позиция, которую сдвинул приход контента, — не выбор оператора:
            // именно её и должен вернуть якорь.
            val arrived = seen != null && signature != seen
            seen = signature
            readingAnchor.record(arrived, index, offset) { i -> latestItems.asReversed().getOrNull(i)?.id }
        }
    }
    LaunchedEffect(contentSignature, following) {
        // Оператор у низа — низ держим сами: вставка нового элемента сдвигает
        // индексы (новый элемент становится нулевым), поэтому мало не мешать
        // ленте, надо вернуть её к нулевому.
        if (following) {
            // Дельты внутри нижнего элемента держит сам reverseLayout; догонять нужно
            // только вставку, из-за которой низ перестал быть нулевым, и только не
            // поверх собственного жеста оператора (защёлка узнает о нём кадром позже).
            if (!listState.isScrollInProgress && listState.firstVisibleItemIndex != 0) listState.scrollToItem(0, 0)
            return@LaunchedEffect
        }
        val target = readingAnchor.target(
            following = false,
            scrolling = listState.isScrollInProgress,
            currentIndex = listState.firstVisibleItemIndex,
            currentOffset = listState.firstVisibleItemScrollOffset,
            indexOf = { id -> reversed.indexOfFirst { it.id == id } },
        ) ?: return@LaunchedEffect
        listState.scrollToItem(target.first, target.second)
    }
    // Older history loads when the top of the chat comes into view.
    val nearTop by remember { derivedStateOf { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= listState.layoutInfo.totalItemsCount - 10 } == true } }
    // The effect must restart when a page ARRIVES, not only when `nearTop` flips:
    // after the first page both `nearTop` and `reachedStart` keep their values, so
    // the old key pair never changed again and the operator had to tap «Показать
    // более раннюю историю» once per page. The loaded size is what moves; a page
    // that brings nothing does not change it, so this cannot spin, and
    // `loadingOlder` keeps the next page from starting before the previous one
    // has been applied.
    LaunchedEffect(nearTop, state.reachedStart, state.loadingOlder, items.size) {
        if (nearTop && !state.reachedStart && !state.loadingOlder) session.loadOlder()
    }

    if (items.isEmpty() && !state.reachedStart) {
        // The newest window had nothing to show; the session is paging back for it.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            if (state.loadingOlder) CircularProgressIndicator()
            else TextButton(onClick = { session.loadOlder() }) { Text("Показать более раннюю историю") }
        }
        return
    }
    if (items.isEmpty()) {
        val task = state.task
        val setup = listOfNotNull(task?.model?.label?.takeIf { it != "—" }, (task?.thinkingLevelActual ?: task?.thinkingLevel)?.let { "размышления: ${thinkingLabel(it)}" }).joinToString(" · ")
        EmptyState(AppIcons.Chat, "Что сделать агенту?", listOfNotNull(setup.ifEmpty { null }, "Опишите задачу — агент прочитает проект, внесёт правки и запустит команды.").joinToString("\n"))
        return
    }
    CompositionLocalProvider(LocalChatListState provides listState) {
    LazyColumn(
        state = listState,
        reverseLayout = true,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.Bottom),
    ) {
        // Stable keys and reverseLayout own the streaming position. Do not compensate
        // growing answers with dispatchRawDelta here: nested with an expanded block's
        // Pinned scroll it re-enters LazyListState and crashes Android.
        items(reversed, key = { it.id }, contentType = { it::class.simpleName }) { item ->
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                Box(Modifier.widthIn(max = 860.dp).fillMaxWidth()) {
                    when (item) {
                        is ChatItem.User -> {
                            val turnId = item.turnId
                            UserBubble(
                                item = item,
                                time = parseIsoMillis(item.at)?.let { platform.formatClock(it) }.orEmpty(),
                                source = sourceLabel(item.clientId, ownClient),
                                actions = MessageActions(
                                    copy = { onCopyMessage(item.copyText()) },
                                    onToggleSelect = if (selectionMode) ({ onToggleSelect(item.id) }) else null,
                                    selected = selectedIds[item.id] == true,
                                    edit = turnId?.takeIf { !historyLocked }?.let { { onDialog(ChatDialog.EditMessage(it, item.text)) } },
                                    fork = turnId?.takeIf { !historyLocked }?.let { { session.fork(it) } },
                                    forkFrom = turnId?.takeIf { !historyLocked }?.let { { session.fork(it, from = true) } },
                                    deleteFrom = turnId?.takeIf { !historyLocked }?.let { { onDialog(ChatDialog.DeleteFrom(it)) } },
                                ),
                                onOpenFile = { id, name -> onViewFile(FileTarget.Attachment(id, name)) },
                                loadFile = { session.readFile(it) },
                                desktop = platform.kind == "desktop",
                            )
                        }
                        is ChatItem.Assistant -> {
                            val actionId = item.canonicalId.takeIf { item.segmentActions }
                            val newest = actionId == state.chat.newestAnswerId && actionId != null && !historyLocked && item.final
                            AssistantMessage(
                                item = item,
                                time = timeRange(platform, item.at, item.endedAt),
                                actions = MessageActions(
                                    copy = { onCopyMessage(item.copyText()) },
                                    onToggleSelect = if (selectionMode) ({ onToggleSelect(item.id) }) else null,
                                    selected = selectedIds[item.id] == true,
                                    edit = if (newest) ({ onDialog(ChatDialog.EditAnswer(item.canonicalId, item.canonicalText)) }) else null,
                                    fork = actionId?.takeIf { !historyLocked && Regex("^assistant-(\\d+|initial)$").matches(it) }?.let { { session.fork(it) } },
                                    forkFrom = actionId?.takeIf { !historyLocked && Regex("^assistant-(\\d+|initial)$").matches(it) }?.let { { session.fork(it, from = true) } },
                                    regenerate = if (newest) ({ session.regenerate(item.canonicalId) }) else null,
                                    rerunWith = if (newest) ({ onDialog(ChatDialog.Rerun(item.canonicalId)) }) else null,
                                    continueAnswer = if (newest && (item.canonicalText.isNotBlank() || item.tools.isNotEmpty())) ({ session.continueAnswer(item.canonicalId) }) else null,
                                    deleteFrom = actionId?.takeIf { !historyLocked && !item.active && Regex("^assistant-(initial|\\d+)$").matches(it) }?.let { { onDialog(ChatDialog.DeleteFrom(it, withAnswer = true)) } },
                                ),
                                onCopyText = { platform.copyText(it) },
                                loadToolOutput = { session.toolOutput(it) },
                                onOpenPath = { link -> onViewFile(FileTarget.Workspace(link.path, link.line, link.endLine)) },
                                onOpenFile = { id, name -> onViewFile(FileTarget.Attachment(id, name)) },
                                loadFile = { session.readFile(it) },
                                loadWorkspaceFile = { session.readWorkspaceFile(it) },
                                desktop = platform.kind == "desktop",
                                onSelectVariant = { position ->
                                    val variants = item.variants
                                    val variantId = variants?.variantIdAt(position)
                                    if (variants != null && variantId != null) session.selectVariant(variants.turnSeq, variantId)
                                },
                            )
                        }
                        is ChatItem.Note -> NoteRow(
                            item = item,
                            onCopy = { onCopyMessage(item.copyText()) },
                            selected = selectedIds[item.id] == true,
                            onToggleSelect = if (selectionMode) ({ onToggleSelect(item.id) }) else null,
                        )
                    }
                }
            }
        }
        item(key = "history-start") {
            Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                when {
                    state.loadingOlder -> CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    !state.reachedStart -> TextButton(onClick = { session.loadOlder() }) { Text("Показать более раннюю историю") }
                    else -> Text("Начало сессии", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
    }
}

@Composable
private fun ApprovalCard(approval: Approval, busy: Boolean, onAnswer: (Boolean) -> Unit) {
    val colors = LocalStatusColors.current
    Surface(
        color = colors.waiting.copy(alpha = 0.12f),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(AppIcons.Shield, null, tint = colors.waiting, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(
                    "Разрешить ${approval.toolName ?: "инструмент"}?",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                approval.risk?.let { Text(riskLabel(it), style = MaterialTheme.typography.labelMedium, color = colors.waiting) }
            }
            val preview = approval.args?.let { argsPreview(it) }.orEmpty()
            if (preview.isNotEmpty()) {
                Text(
                    preview,
                    style = MonoStyle,
                    maxLines = 6,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 8.dp).fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(colors.codeBackground).padding(10.dp),
                )
            }
            approval.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp)) }
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { onAnswer(false) }, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Запретить") }
                Button(onClick = { onAnswer(true) }, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Разрешить один раз") }
            }
        }
    }
}

private fun riskLabel(risk: String) = when (risk.lowercase()) {
    "high", "critical" -> "высокий риск"
    "medium" -> "средний риск"
    "low" -> "низкий риск"
    else -> risk
}

private fun argsPreview(args: JsonElement): String {
    val obj = args as? kotlinx.serialization.json.JsonObject ?: return args.toString()
    val command = (obj["command"] as? kotlinx.serialization.json.JsonPrimitive)?.content
    if (command != null) return command
    return obj.entries.joinToString("\n") { (key, value) -> "$key: ${(value as? kotlinx.serialization.json.JsonPrimitive)?.content ?: value}" }
}

/**
 * The queue as one line above the input: one message shows its text and ×,
 * several show "В очереди: N ›" and unfold into the list with «Сейчас» / ×.
 */
@Composable
private fun QueueLine(
    pending: List<PendingPrompt>,
    working: Boolean,
    busy: Set<String>,
    onSendNow: (String) -> Unit,
    onDrop: (String) -> Unit,
) {
    val colors = LocalStatusColors.current
    var open by remember { mutableStateOf(false) }
    val single = pending.singleOrNull()
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp).clip(RoundedCornerShape(12.dp)).background(colors.queued.copy(alpha = 0.08f))) {
        Row(
            Modifier.fillMaxWidth().clickable(enabled = single == null) { open = !open }.padding(start = 12.dp, end = 4.dp).heightIn(min = 36.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(AppIcons.Queue, null, tint = colors.queued, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                if (single != null) "В очереди · ${single.text}" else "В очереди: ${pending.size}" + if (working && !open) " · уйдут после ответа" else "",
                style = MaterialTheme.typography.labelMedium,
                color = colors.queued,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (single != null) {
                val busyHere = "pending:${single.id}" in busy
                TextButton(onClick = { onSendNow(single.id) }, enabled = !busyHere) { Text("Сейчас") }
                IconButton(onClick = { onDrop(single.id) }, enabled = !busyHere, modifier = Modifier.size(32.dp)) {
                    Icon(AppIcons.Close, "Убрать из очереди", Modifier.size(16.dp))
                }
            } else {
                Icon(if (open) AppIcons.ChevronDown else AppIcons.ChevronRight, null, Modifier.padding(end = 8.dp).size(16.dp), tint = colors.queued)
            }
        }
        if (single == null && open) Column(Modifier.padding(start = 12.dp, end = 4.dp, bottom = 6.dp)) {
            for (prompt in pending) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(prompt.text, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    val busyHere = "pending:${prompt.id}" in busy
                    TextButton(onClick = { onSendNow(prompt.id) }, enabled = !busyHere) { Text("Сейчас") }
                    IconButton(onClick = { onDrop(prompt.id) }, enabled = !busyHere, modifier = Modifier.size(32.dp)) {
                        Icon(AppIcons.Close, "Убрать из очереди", Modifier.size(16.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun DeliveryDiagnostics(
    state: ChatSessionState,
    info: ApiInfo?,
    catalog: ModelCatalog?,
    platform: PlatformServices,
    nowMillis: () -> Long,
    onRefresh: () -> Unit,
    onCopy: (String) -> Unit,
) {
    var open by remember(state.taskId) { mutableStateOf(false) }
    // Возраст событий и длительность сессии в диагностике должны идти, пока панель
    // открыта, — иначе «12 с назад» застыло бы на моменте открытия.
    var openTick by remember(state.taskId) { mutableStateOf(nowMillis()) }
    LaunchedEffect(state.taskId, open) {
        if (open) {
            // Сразу свежий замер: без него первую секунду после открытия видны
            // возрасты с прошлого открытия панели.
            openTick = nowMillis()
            while (true) { delay(1000); openTick = nowMillis() }
        }
    }
    val answer = state.chat.items.filterIsInstance<ChatItem.Assistant>().lastOrNull()
    // Live engine PP (llama.cpp reports it in /api/info before the first token)
    // makes «Модель читает промпт» work for a local session even on its first
    // turn, where task.metrics is still empty. Gated to the local provider: the
    // local engine's numbers say nothing about a cloud provider.
    val localProvider = info?.local?.provider
    val sessionProvider = state.task?.model?.provider ?: state.task?.requestedModel?.provider
    val sessionModelId = state.task?.model?.id ?: state.task?.requestedModel?.id
    // Внешний локальный сервер (Strata) — та же машина, что и роутер, но другой
    // провайдер Pi. Его строка в info.local.models несёт живую телеметрию
    // (фаза, прогресс чтения промпта, скорости): без неё сессия на Strata не
    // показывала чтение промпта вообще.
    val externalRow = externalModelRow(info?.local?.models.orEmpty(), sessionProvider, sessionModelId)
    val externalMetrics = externalRow?.metrics
    val livePp = when {
        localProvider != null && sessionProvider == localProvider -> info.engine?.metrics?.pp?.takeIf { it.isFinite() && it > 0.0 }
        else -> externalMetrics?.pp?.takeIf { it.isFinite() && it > 0.0 }
    }
    // Live engine TG too: llama.cpp reports both while it streams, so PP and TG
    // tick with the /api/info poll (1s while a turn is active) instead of
    // freezing on the last turn's values. A cloud provider has no live source:
    // Pi reports usage only at message_end, so its PP/TG are per-turn.
    val liveTg = when {
        localProvider != null && sessionProvider == localProvider -> info.engine?.metrics?.tg?.takeIf { it.isFinite() && it > 0.0 }
        else -> externalMetrics?.tg?.takeIf { it.isFinite() && it > 0.0 }
    }
    val sessionMetrics = state.task?.metrics
    val readingPp = livePp ?: sessionMetrics?.pp?.takeIf { it.isFinite() && it > 0.0 }
    // Прогресс чтения промпта у внешнего сервера (Strata отдаёт prompt_read /
    // prompt_total): «читает промпт · 64% · 80K / 126K» вместо просто факта — по
    // одному проценту не видно, сколько уже прочитано и сколько осталось.
    val readingPrompt = engineReadingPrompt(externalMetrics?.phase)
    // Скорость чтения промпта по таймеру: опрос /api/info каждую секунду даёт
    // прирост promptRead — прирост между замерами / время = эффективный PP,
    // посчитанный клиентом. Strata сам PP у кеш-попаданий не отдаёт
    // (ppUnavailable), а «читает промпт · 63%» без скорости не показывает,
    // долго ли ждать. Скорость прошлого хода не показывается: база обнуляется,
    // когда чтение кончилось, и при новом промпте (read меньше базы).
    var ppSample by remember(state.taskId) { mutableStateOf<Pair<Long, Long>?>(null) }
    var ppTimer by remember(state.taskId) { mutableStateOf<Double?>(null) }
    LaunchedEffect(state.taskId, sessionModelId, readingPrompt, externalMetrics?.promptRead, externalMetrics?.progress) {
        val read = externalMetrics?.promptRead
        if (!readingPrompt || read == null || read <= 0L) {
            ppSample = null; ppTimer = null
            return@LaunchedEffect
        }
        val sample = ppSample
        when {
            sample == null -> ppSample = nowMillis() to read
            read > sample.second -> {
                val seconds = (nowMillis() - sample.first) / 1000.0
                if (seconds > 0) ppTimer = (read - sample.second) / seconds
                ppSample = nowMillis() to read
            }
            read < sample.second -> { ppSample = nowMillis() to read; ppTimer = null }
        }
    }
    val readingDetail = buildList {
        externalMetrics?.progress?.takeIf { it in 0.0..1.0 }?.let { add("${(it * 100).toInt()}%") }
        val read = externalMetrics?.promptRead
        val total = externalMetrics?.promptTotal
        if (read != null && total != null && total > 0) add("${formatTokensK(read)} / ${formatTokensK(total)}")
        ppTimer?.takeIf { it > 0.0 }?.let { add("≈ ${(it * 10).roundToInt() / 10.0} ток/с") }
    }.joinToString(" · ").let { if (it.isEmpty()) "" else " · $it" }
    // Сколько длится сжатие: сервер ставит compactingSince на compaction_start.
    // Часы клиента и сервера расходятся на секунды по LAN — для счётчика это ок.
    val compactingSince = state.task?.runtime?.compactingSince
    var compactTick by remember(state.taskId) { mutableStateOf(nowMillis()) }
    LaunchedEffect(state.taskId, compactingSince) {
        if (compactingSince != null && compactingSince > 0) while (true) { delay(1000); compactTick = nowMillis() }
    }
    val compactElapsed = compactingSince?.takeIf { it > 0 }?.let { (compactTick - it).coerceAtLeast(0) }
    val compactingDetail = compactElapsed?.let { " · ${elapsedClock(it)}" }.orEmpty()
    // «Читает промпт» — только по живому признаку: фаза движка (Strata: «reading the
    // prompt») или PP из /api/info, и только пока модель ещё ничего не выдала.
    // `task.metrics.pp` прошлого хода не гаснет, и с ним подпись «Модель читает
    // промпт» висела над уже идущими размышлениями модели.
    val answerSilent = answer == null || (answer.text.isBlank() && answer.thinking.isBlank() && answer.tools.isEmpty())
    val readsPrompt = readsPromptNow(readingPrompt = readingPrompt, livePp = livePp, answerSilent = answerSilent)
    val details = buildDiagnosticsDetails(state, info, externalMetrics, now = openTick) { formatMoment(platform, it) }
    // Elapsed since the turn started, ticking every second. Seeded from the last
    // user message's server timestamp (the client and the server clocks may drift
    // by seconds on a LAN, which is fine for a rough «0:34»), so a session opened
    // mid-turn shows it too.
    //
    // По ключам, а не по snapshotFlow { state.task?.status }: `state` здесь —
    // значение из collectAsState(), а не наблюдаемое состояние. Поток читал
    // обычное поле data-класса, поэтому отдавал первый статус и больше не
    // срабатывал: счётчик, запущенный на RUNNING, продолжал идти и после
    // SUCCEEDED, когда в задаче уже ничего не выполнялось.
    val lastUserAt = state.chat.items.filterIsInstance<ChatItem.User>().lastOrNull()?.at
    var startedAt by remember(state.taskId) { mutableStateOf<Long?>(null) }
    LaunchedEffect(state.taskId, state.task?.status, lastUserAt) {
        startedAt = turnStartedAt(state.task?.status, startedAt, lastUserAt)
    }
    var tick by remember(state.taskId) { mutableStateOf(nowMillis()) }
    LaunchedEffect(state.taskId, startedAt) {
        if (startedAt != null) while (true) { delay(1000); tick = nowMillis() }
    }
    val elapsed = startedAt?.let { (tick - it).coerceAtLeast(0) }
    // Подпись состояния — после счётчика: «повтор через 1 ч 31 мин» идёт по секундам
    // клиента (`tick`), и с застывшим «сейчас» она показывала бы уже прошедший повтор.
    val phase = when {
        state.link !is LinkState.Live -> "Связь с сервером не подтверждена"
        state.outbox.isNotEmpty() -> "Отправка сообщения · подробнее"
        state.task?.status == "FAILED" -> "Ошибка · подробнее"
        // Отказ провайдера важнее прочего: пока он держит ход, не идёт ничего.
        state.task?.providerWait != null -> providerWaitPhase(state.task.providerWait, tick)
        state.task?.runtime?.activity == "compacting" -> "Сжимается контекст$compactingDetail$readingDetail · подробнее"
        answer?.tools?.any { it.state == ToolState.RUNNING } == true -> "Агент выполняет команды"
        readsPrompt && answerSilent -> "Модель читает промпт$readingDetail"
        // История больше окна модели: провайдер отвечает 400, Pi повторяет запрос, и
        // «ожидается ответ агента» висит без событий — это не задержка модели.
        contextOverflow(state.task, info) != null && answer?.active != true -> "История не влезает в окно модели · подробнее"
        answer?.active == true && answer.text.isNotBlank() -> "Получаем ответ модели"
        answer?.active == true && answer.thinking.isNotBlank() -> "Получаем размышления модели"
        answer?.active == true -> "Сообщение передано · ожидается ответ агента"
        state.task?.pendingPrompts?.isNotEmpty() == true -> "Сообщение в очереди"
        else -> "Диагностика доставки"
    }
    // Line 1 segments: elapsed · TTFT · PP · TG.
    val stats = listOfNotNull(
        elapsed?.let { elapsedClock(it) },
        catalog?.latencyFor(state.task?.model ?: state.task?.requestedModel)?.let { l -> (l.p50Ms ?: l.avgMs)?.let { "TTFT ${formatLatencyMs(it)}" } },
        readingPp?.let { "PP ${formatSpeed(it)}" + (if (livePp != null) " (ход)" else "") },
        // Сессионный агрегат рядом с текущим ходом: живые PP и медиана сессии — разные метрики,
        // и без подписи их принимают за противоречие (PP 1672 в прогрессе против ≈2220 в диагностике).
        sessionMetrics?.pp?.takeIf {
            it.isFinite() && it > 0.0 && livePp != null && readingPp != null && it != readingPp
        }?.let { "сессия: PP ${if (sessionMetrics.ppApproximate) "≈" else ""}${formatSpeed(it)}" },
        (liveTg ?: state.task?.metrics?.tg?.takeIf { it.isFinite() && it > 0.0 })?.let { "TG ${formatSpeed(it)} ток/с" },
    )
    // Line 2: model · context usage · queued count. Живое число движка важнее
    // `usage` прошлого хода: на сжатии/длинном промпте они расходятся в разы.
    val used = sessionContextUsed(state.task)
    val window = sessionContextWindow(state.task, info)
    val display = state.task?.let(::displayStateOf)
    val dotColor = when {
        state.task?.status == "FAILED" -> LocalStatusColors.current.failed
        display?.active == true -> LocalStatusColors.current.working
        state.task?.status == "QUEUED" -> LocalStatusColors.current.queued
        else -> LocalStatusColors.current.muted
    }
    val contextLabel = if (window != null && window > 0 && used != null) {
        "Контекст ${(used * 100.0 / window).roundToInt()}% (${formatTokensK(used)}/${formatTokensK(window)})"
    } else null
    val queueLabel = state.task?.pendingPrompts?.size?.takeIf { it > 0 }?.let { "В очереди: $it" }
    // Живой запрос движка — отдельным сегментом с подписью: у первого хода своего
    // числа у Pi ещё нет (lastUsage пуст), и раньше панель показывала в этом месте
    // размер промпта движка — тем самым числом, которое расходилось с настройками.
    val enginePrompt = liveEnginePrompt(state.task?.model ?: state.task?.requestedModel, info)
    val engineLabel = enginePrompt?.takeIf { it > 0 && it != used }?.let { "Промпт движка: ${formatTokensK(it)}" }
    val meta = stats + listOfNotNull(contextLabel, engineLabel, queueLabel)
    Column(Modifier.fillMaxWidth().clickable { open = true }) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(dotColor))
            Spacer(Modifier.width(6.dp))
            Text(phase, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(4.dp))
            Icon(AppIcons.ChevronRight, "Открыть диагностику", Modifier.size(16.dp))
        }
        if (meta.isNotEmpty()) {
            FlowRow(Modifier.fillMaxWidth().padding(start = 14.dp, top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (line in meta) Text(line, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
        }
        if (window != null && window > 0 && used != null) {
            // A plain box bar: no LinearProgressIndicator overload surprises across platforms.
            Box(Modifier.fillMaxWidth().padding(start = 14.dp, top = 4.dp).height(4.dp).clip(RoundedCornerShape(2.dp)).background(MaterialTheme.colorScheme.surfaceVariant)) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(((used * 1.0 / window).coerceIn(0.0, 1.0)).toFloat()).background(MaterialTheme.colorScheme.primary))
            }
        }
    }
    if (open) {
        AdaptiveSheet(
            title = "Диагностика",
            subtitle = phase,
            onDismiss = { open = false },
            footer = {
                TextButton(onClick = onRefresh) { Text("Проверить связь") }
                TextButton(onClick = { onCopy(details) }) { Text("Копировать") }
            },
        ) {
            Text(details, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/**
 * Подпись строки отправки над полем ввода. `null` — строки нет.
 *
 * Сообщение, которое едет «в очередь», называется сразу: до 2026-10-12 на этом этапе
 * строки не было вообще, и очередь становилась видна только после ответа сервера —
 * оператор видел «сначала визуально попадают в чат, а потом через некоторое время в
 * очередь». «Вклиниться» и steer тоже идут в беседу (пузырь), но в очередь не встают:
 * их ждут в ленте, а не над полем ввода.
 */
internal fun outboxLabel(message: OutgoingMessage): String? = when (val status = message.status) {
    OutgoingMessage.Status.Uploading -> "Загружаю файлы…"
    OutgoingMessage.Status.Sending -> if (message.mode == SendMode.QUEUE) "Отправляю… если агент занят — встанет в очередь" else null
    is OutgoingMessage.Status.Retrying -> "Нет связи, повтор ${status.attempt}…"
    is OutgoingMessage.Status.Failed -> "Не отправлено: ${status.message}"
    OutgoingMessage.Status.Unknown -> "Неизвестно, дошло ли сообщение (сервер перезапускался)"
}

@Composable
private fun OutboxRow(message: OutgoingMessage, onRetry: () -> Unit, onEdit: () -> Unit, onDismiss: () -> Unit) {
    val status = message.status
    val text = outboxLabel(message) ?: return
    val color = when (status) {
        OutgoingMessage.Status.Uploading -> MaterialTheme.colorScheme.onSurfaceVariant
        OutgoingMessage.Status.Sending -> MaterialTheme.colorScheme.onSurfaceVariant
        is OutgoingMessage.Status.Retrying -> LocalStatusColors.current.waiting
        is OutgoingMessage.Status.Failed -> MaterialTheme.colorScheme.error
        OutgoingMessage.Status.Unknown -> LocalStatusColors.current.waiting
    }
    Surface(color = color.copy(alpha = 0.08f), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(text, style = MaterialTheme.typography.labelMedium, color = color, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(message.text, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (status is OutgoingMessage.Status.Failed || status == OutgoingMessage.Status.Unknown) {
                TextButton(onClick = onEdit) { Text("Изменить") }
                TextButton(onClick = onRetry) { Text("Ещё раз") }
                IconButton(onClick = onDismiss, modifier = Modifier.size(32.dp)) { Icon(AppIcons.Close, "Убрать", Modifier.size(16.dp)) }
            } else if (status is OutgoingMessage.Status.Uploading || status is OutgoingMessage.Status.Retrying) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            }
        }
    }
}

@Composable
private fun ChatDialogs(dialog: ChatDialog?, state: ChatSessionState, session: ChatSession, graph: AppGraph, send: (SendMode) -> Unit, onDialog: (ChatDialog) -> Unit, onViewFile: (FileTarget) -> Unit, onClose: () -> Unit) {
    when (dialog) {
        null -> Unit
        is ChatDialog.EditMessage -> TextEditDialog(
            title = "Изменить сообщение",
            hint = "Ответы после этого сообщения будут удалены, и агент ответит заново.",
            initial = dialog.text,
            confirm = "Отправить заново",
            onConfirm = { session.editMessage(dialog.turnId, it); onClose() },
            onDismiss = onClose,
        )
        is ChatDialog.EditAnswer -> {
            var asVariant by remember { mutableStateOf(true) }
            TextEditDialog(
                title = "Исправить ответ",
                hint = "Модель не спрашивается: в истории останется ваш текст.",
                initial = dialog.text,
                confirm = "Сохранить",
                extra = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(asVariant, { asVariant = it })
                        Text("Сохранить как новый вариант (старый останется)", style = MaterialTheme.typography.bodySmall)
                    }
                },
                onConfirm = { session.editAnswer(dialog.turnId, it, asVariant); onClose() },
                onDismiss = onClose,
            )
        }
        is ChatDialog.DeleteFrom -> ConfirmDialog(
            title = if (dialog.withAnswer) "Удалить ответ?" else "Удалить сообщение?",
            text = (if (dialog.withAnswer) "Ответ" else "Сообщение") + " и всё, что после, исчезнут из истории сессии. Это нельзя отменить.",
            confirm = "Удалить",
            destructive = true,
            onConfirm = { session.deleteFrom(dialog.turnId); onClose() },
            onDismiss = onClose,
        )
        ChatDialog.ConfirmRestart -> ConfirmDialog(
            title = "Перезапустить сессию?",
            text = "Процесс Pi будет остановлен и поднят заново. История сессии сохранится, " +
                "последний промпт автоматически не переотправится — отправьте его сами после перезапуска.",
            confirm = "Перезапустить",
            destructive = true,
            onConfirm = { session.restartSession(); onClose() },
            onDismiss = onClose,
        )
        ChatDialog.ConfirmStop -> ConfirmDialog(
            title = "Остановить агента?",
            text = "Грокнут все процессы сессии (Pi и его дочерние) — даже если модель читает промпт. " +
                "Текущий ответ и запущенные команды прервутся" + (state.task?.pendingPrompts?.size?.takeIf { it > 0 }
                ?.let { ", а также уберутся из очереди $it сообщ." } ?: ".") +
                // Оператор 2026-10-14: «сообщение не отправляется, и я не могу никак
                // перезапустить». Поэтому STOP снимает и незавершённые отправки —
                // текст возвращается в поле ввода, ничего не теряется молча.
                (if (state.outbox.isNotEmpty()) " Незавершённые отправки (${state.outbox.size}) будут отменены, их текст вернётся в поле ввода." else ""),
            confirm = "Остановить",
            destructive = true,
            onConfirm = {
                session.cancel(hard = true)
                // Отменённые отправки вернутся в поле ввода эффектом RestoreComposer.
                session.releaseStuckSends()
                onClose()
            },
            onDismiss = onClose,
        )
        ChatDialog.ConfirmClear -> ConfirmDialog(
            title = "Очистить чат?",
            text = "Все сообщения этой сессии будут удалены, сама сессия и её папка останутся.",
            confirm = "Очистить",
            destructive = true,
            onConfirm = { session.clear(); onClose() },
            onDismiss = onClose,
        )
        ChatDialog.ConfirmDelete -> ConfirmDialog(
            title = "Удалить сессию?",
            text = "Сессия и вся её история будут удалены на компьютере. Это нельзя отменить.",
            confirm = "Удалить",
            destructive = true,
            onConfirm = { session.delete(); onClose() },
            onDismiss = onClose,
        )
        ChatDialog.ConfirmTrustWorkspace -> ConfirmDialog(
            title = "Доверять папке проекта?",
            text = "Pi сможет загружать из этой папки локальные инструкции, навыки и расширения. " +
                "Текущий процесс Pi будет остановлен; следующее сообщение продолжит сохранённую сессию.",
            confirm = "Доверять",
            destructive = false,
            onConfirm = { session.trustWorkspace(); onClose() },
            onDismiss = onClose,
        )
        ChatDialog.Rename -> TextEditDialog(
            title = "Название сессии",
            hint = null,
            initial = state.task?.title ?: state.task?.displayTitle.orEmpty(),
            confirm = "Сохранить",
            singleLine = true,
            onConfirm = { session.rename(it); onClose() },
            onDismiss = onClose,
        )
        ChatDialog.ModelSettings -> ModelSheet(state, session, graph, onDialog = onDialog, onViewFile = onViewFile, onClose = onClose)
        ChatDialog.ChooseModel -> QuickModelChooser(state, session, graph, onClose)
        is ChatDialog.Rerun -> QuickRerunChooser(state, session, graph, turnId = dialog.turnId, onClose = onClose)
    }
}

@Composable
private fun QuickModelChooser(state: ChatSessionState, session: ChatSession, graph: AppGraph, onClose: () -> Unit) {
    val connection = graph.connection ?: return
    var catalog by remember(connection) { mutableStateOf(connection.sessions.peekModels()) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var pendingKey by remember { mutableStateOf<String?>(null) }
    var loadAttempt by remember { mutableStateOf(0) }
    LaunchedEffect(connection, loadAttempt) {
        connection.sessions.models().onSuccess { catalog = it }.onFailure { loadError = it.message ?: "Не удалось загрузить модели" }
    }
    LaunchedEffect(state.busy, state.task?.model?.key, pendingKey) {
        val requested = pendingKey ?: return@LaunchedEffect
        if ("model" !in state.busy) {
            if (state.task?.model?.key == requested) onClose() else pendingKey = null
        }
    }
    if (catalog == null) {
        AdaptiveSheet(title = "Выбор модели", onDismiss = onClose, subtitle = loadError) {
            if (loadError == null) CircularProgressIndicator()
            else OutlinedButton(onClick = { loadError = null; loadAttempt++ }) { Text("Повторить") }
        }
    } else {
        // Живой статус локальных моделей: в каталоге Pi у локального провайдера
        // записан статический размер окна, и после загрузки с другим он врёт.
        val sessionListState by connection.sessions.state.collectAsState()
        ModelChooser(catalog!!, state.task?.model, graph.settings, info = sessionListState.info, onPick = { model ->
            if (model.key == state.task?.model?.key) onClose()
            else if (pendingKey == null) {
                pendingKey = model.key
                session.setModel(model)
            }
        }, onDismiss = onClose, pendingKey = pendingKey ?: if ("model" in state.busy) "" else null)
    }
}

/**
 * MR-07: «повторить с параметрами» — выбор модели, которой запросить последний ответ
 * заново. Модель выбирается тем же списком, что и смена модели сессии
 * ([ModelChooser]): второй список моделей разошёлся бы с первым. Уровень мышления
 * здесь не спрашивается — он остаётся настройкой сессии (её видно и меняется в
 * «Сессия»); сервер принимает и его, но показывать два выбора в одном шаге значит
 * обещать больше, чем видно на экране.
 */
@Composable
private fun QuickRerunChooser(
    state: ChatSessionState,
    session: ChatSession,
    graph: AppGraph,
    turnId: String,
    onClose: () -> Unit,
) {
    val connection = graph.connection ?: return
    var catalog by remember(connection) { mutableStateOf(connection.sessions.peekModels()) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var loadAttempt by remember { mutableStateOf(0) }
    var chosen by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(connection, loadAttempt) {
        connection.sessions.models().onSuccess { catalog = it }.onFailure { loadError = it.message ?: "Не удалось загрузить модели" }
    }
    // Выбор сделан — повтор ушёл. Закрываем, когда сервер перестал держать ключ
    // «rerun» в занятых: до этого шаг выглядит незавершённым.
    LaunchedEffect(state.busy, chosen) {
        if (chosen != null && "rerun" !in state.busy) onClose()
    }
    if (catalog == null) {
        AdaptiveSheet(title = "Повторить с параметрами", onDismiss = onClose, subtitle = loadError) {
            if (loadError == null) CircularProgressIndicator()
            else OutlinedButton(onClick = { loadError = null; loadAttempt++ }) { Text("Повторить") }
        }
    } else {
        val sessionListState by connection.sessions.state.collectAsState()
        ModelChooser(
            catalog = catalog!!,
            selected = state.task?.model,
            settings = graph.settings,
            info = sessionListState.info,
            pendingKey = chosen,
            onPick = { model ->
                if (chosen == null) {
                    chosen = model.key
                    // Дальше всё делает сервер: применяет модель к сессии и задаёт
                    // вопрос заново. Уровень не назван — значит остаётся прежним.
                    session.rerun(turnId, model = model)
                }
            },
            onDismiss = onClose,
        )
    }
}

@Composable
private fun ModelSheet(state: ChatSessionState, session: ChatSession, graph: AppGraph, onDialog: (ChatDialog) -> Unit, onViewFile: (FileTarget) -> Unit, onClose: () -> Unit) {
    val connection = graph.connection ?: return
    var catalog by remember { mutableStateOf<ModelCatalog?>(null) }
    LaunchedEffect(Unit) { connection.sessions.models().onSuccess { catalog = it } }
    // Живой статус локальных моделей: окно контекста сессии берётся из него, а не
    // из каталога Pi, где у локальной модели записан статический размер.
    val sessionListState by connection.sessions.state.collectAsState()
    val task = state.task
    val running = task?.status in setOf("RUNNING", "PREPARING", "CANCELLING")
    AdaptiveSheet(
        title = "Сессия",
        subtitle = task?.workspacePath,
        onDismiss = onClose,
        footer = {
            OutlinedButton(onClick = { session.compact(); onClose() }, enabled = !running) {
                Icon(AppIcons.Layers, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Сжать контекст")
            }
            Spacer(Modifier.weight(1f))
            Button(onClick = onClose) { Text("Готово") }
        },
    ) {
        // The rows the web's «Детали сессии» dialog shows: name, status, current step.
        FieldLabel("Название")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(task?.displayTitle ?: "—", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (task != null) IconButton(onClick = { onDialog(ChatDialog.Rename) }) { Icon(AppIcons.Edit, "Переименовать") }
        }
        FieldLabel("Статус", top = 16)
        // displayStateOf labels terminal states the way the web's dialog does
        // («Готово», «Ошибка», «Остановлена»); stageLabel is for the live run only.
        Text(task?.let { displayStateOf(it).label } ?: "—", style = MaterialTheme.typography.bodyLarge)
        task?.current?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
        }
        state.chat.mcpNotice?.takeIf { it.isNotBlank() }?.let { notice ->
            FieldLabel("MCP", top = 16)
            Text(notice, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        FieldLabel("Модель", top = 16)
        ModelPicker(catalog, task?.model, graph.settings, info = sessionListState.info, onPick = { session.setModel(it) })
        Text(
            "Смена модели записывается в историю Pi и переживает перезапуск.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp),
        )
        // Размышления — здесь, как и раньше: ряд иконок под полем ввода убран (он
        // мешал и дублировал этот шит).
        val levels = thinkingChoices(task?.model, catalog?.thinkingLevels.orEmpty())
        if (levels.isNotEmpty() && task?.model?.reasoning != false) {
            FieldLabel("Размышления", top = 20)
            ThinkingPicker(levels, task?.thinkingLevelActual ?: task?.thinkingLevel, onPick = { session.setThinking(it) })
        }
        FieldLabel("Контекст", top = 20)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Автосжатие", style = MaterialTheme.typography.bodyLarge)
                Text("Pi сам сожмёт историю, когда она перестанет помещаться.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(12.dp))
            Switch(checked = task?.autoCompactionEnabled != false, onCheckedChange = { session.setAutoCompaction(it) })
        }
        ContextSection(taskId = task?.id, session = session)
        val usage = task?.lastUsage
        val window = sessionContextWindow(task, sessionListState.info)
        val catalogModel = catalog?.models?.firstOrNull { it.key == task?.model?.key }
        val estimatedCost = catalogModel?.cost?.let { price ->
            ((usage?.input ?: 0L) * (price.input ?: 0.0) +
                (usage?.output ?: 0L) * (price.output ?: 0.0) +
                (usage?.cacheRead ?: 0L) * (price.cacheRead ?: 0.0) +
                (usage?.cacheWrite ?: 0L) * (price.cacheWrite ?: 0.0)) / 1_000_000.0
        }?.takeIf { it > 0.0 }
        val stats = listOfNotNull(
            usage?.totalTokens?.let { tokens -> "последний ход: $tokens" + (window?.let { " из ${it / 1000}K" } ?: "") + " токенов" },
            task?.metrics?.let(::generationSpeedLabel)?.let { "скорость: $it ток/с" },
            // Measured response latency of the session's model (catalog.latency):
            // how long the first token usually takes — the number to compare a
            // slow cloud answer against.
            task?.model?.let { model -> catalog?.latencyFor(model) }?.let { modelLatencyLabel(it) },
            task?.compaction?.count?.takeIf { it > 0 }?.let { "сжатий: $it" },
            estimatedCost?.let { "оценка последнего хода: \$${(it * 10_000).roundToInt() / 10_000.0}" },
        )
        for (line in stats) Text(line, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
        // The agent's files and the task artifacts, the way the web's dialog shows them:
        // data lives on the server, the chat itself no longer displays the chips.
        val outputFiles = task?.outputFiles.orEmpty()
        if (outputFiles.isNotEmpty()) {
            FieldLabel("Файлы агента", top = 20)
            FileList(outputFiles, onOpenFile = { id, name -> onViewFile(FileTarget.Attachment(id, name)) }, loadFile = { session.readFile(it) })
        }
        var artifacts by remember { mutableStateOf<List<String>?>(null) }
        var artifactsOpen by remember { mutableStateOf(false) }
        LaunchedEffect(task?.id) { artifacts = session.artifacts().getOrNull() }
        val artifactNames = artifacts.orEmpty()
        // Артефакты — редкий/отладочный просмотр: свёрнуты по умолчанию, чипы
        // рендерятся только по раскрытию — как «состояние Pi (JSON)» ниже.
        if (artifactNames.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().clickable { artifactsOpen = !artifactsOpen }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (artifactsOpen) AppIcons.ChevronDown else AppIcons.ChevronRight, null, Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text("Artifacts (${artifactNames.size})", style = MaterialTheme.typography.bodyMedium)
            }
            if (artifactsOpen) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                    for (name in artifactNames) FileChip(name, "") { onViewFile(FileTarget.Artifact(name)) }
                }
            }
        }
        var followup by remember { mutableStateOf("") }
        FieldLabel("Инструкция во время/после работы", top = 20)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = followup,
                onValueChange = { followup = it },
                placeholder = { Text("Например: не меняй публичный API") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = { session.send(followup, mode = SendMode.NOW); followup = "" }, enabled = followup.isNotBlank()) { Text("Send") }
        }
        OutlinedButton(onClick = { onDialog(ChatDialog.ConfirmClear) }, enabled = !running, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
            Text("Очистить чат")
        }
        // Debug: the raw Pi state, the way the web's collapsible «состояние Pi (JSON)» shows it.
        var stateOpen by remember { mutableStateOf(false) }
        var stateJson by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(stateOpen, task?.id) {
            if (!stateOpen) return@LaunchedEffect
            stateJson = session.state().fold(
                onSuccess = { obj -> Json { prettyPrint = true }.encodeToString(JsonElement.serializer(), obj) },
                onFailure = { it.message },
            )
        }
        Row(Modifier.fillMaxWidth().clickable { stateOpen = !stateOpen }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (stateOpen) AppIcons.ChevronDown else AppIcons.ChevronRight, null, Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text("Debug: состояние Pi (JSON)", style = MaterialTheme.typography.bodyMedium)
        }
        if (stateOpen) {
            Text(
                stateJson ?: "Загрузка…",
                style = MonoStyle.copy(fontSize = MaterialTheme.typography.bodySmall.fontSize),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
    }
}

/**
 * Живое окно контекста локальной модели из статуса TaskBridge (конфиг движка и
 * `/health` его сервера), или null — для облачной модели такого числа нет.
 */
internal fun liveLocalContextWindow(model: ModelRef?, info: ApiInfo?): Long? =
    model?.let { ref ->
        info?.local?.models?.firstOrNull { entry ->
            (ref.id != null && entry.id == ref.id) || (ref.provider != null && entry.provider == ref.provider)
        }
    }?.contextWindow

/**
 * Окно контекста сессии. У локальной модели каталожное число — это статическая
 * запись провайдера в Pi (262K из models.json): после загрузки с другим окном она
 * остаётся прежней, и шкала показывала «30K/262K», хотя движок поднят на 131K.
 * Поэтому для местных моделей берём живое число TaskBridge, а каталог Pi остаётся
 * фолбэком — для облачных моделей он и есть единственный источник.
 */
internal fun sessionContextWindow(task: Task?, info: ApiInfo?): Long? {
    val model = task?.model ?: task?.requestedModel
    return liveLocalContextWindow(model, info) ?: model?.contextWindow
}

/**
 * Размер промпта, который движок (Strata) обрабатывает прямо сейчас для этой модели,
 * или null если он не занят.
 *
 * Пока движок занят, важен именно этот размер: панель иначе показывает `usage`
 * прошлого хода — в замере 2026-09-30 рядом стояли «читает 41.0K / 63.7K» от
 * движка и «55% (143.9K/262.1K)» от Pi, и это читалось как баг. Свежий запрос
 * всегда последний в счётчиках движка, поэтому число относится к текущему ходу.
 */
internal fun liveEnginePrompt(model: ModelRef?, info: ApiInfo?): Long? {
    val entry = model?.let { ref ->
        info?.local?.models?.firstOrNull { item ->
            (ref.id != null && item.id == ref.id) || (ref.provider != null && item.provider == ref.provider)
        }
    } ?: return null
    val metrics = entry.metrics ?: return null
    if (metrics.busy != true) return null
    // Во время чтения промпта движок знает точный размер, после — счётчик запроса.
    return entry.promptTotal?.takeIf { it > 0 } ?: metrics.promptTokens?.takeIf { it > 0 }
}

/**
 * Сколько токенов занимает контекст сессии по числам Pi — то же число, что в
 * настройках сессии («Текущий размер контекста (Pi)» из `get_session_stats.contextUsage`).
 *
 * Размер промпта, который движок обрабатывает прямо сейчас (`liveEnginePrompt`), сюда
 * не подставляется: 2026-10-08 панель показывала «Контекст 25% (50.4K/204.8K)» (живой
 * запрос движка), а настройки — «Всего в запросе: 99K из 204K · 48%», и один и тот же
 * контекст читался двумя разными числами. Живое число движка показывается отдельной
 * строкой с подписью «Движок обрабатывает промпт».
 */
internal fun sessionContextUsed(task: Task?): Long? =
    task?.lastUsage?.totalTokens ?: task?.compaction?.last?.estimatedTokensAfter

/**
 * История с резервом ответа не влезает в окно модели, или null если влезает (или
 * одного из чисел нет).
 *
 * Это тот случай, когда «сессия подвисла» на самом деле ждёт: движок (Strata и
 * llama.cpp) НЕ обрезает промпт, а отвечает 400 `prompt (N tokens) + max tokens
 * (M) exceeds the context (K); requests are never truncated`, а Pi повторяет такие
 * запросы с паузой. В логе сессии это видно как `limits-wait` с `retries_total`,
 * в панели — как «streaming · Pi is working» без событий модели.
 *
 * Правило движка — промпт + резерв ответа + 8 ≤ окно, поэтому одного сравнения
 * истории с окном мало: 2026-09-30 при истории 99.4K и окне 131072 всё выглядело
 * «76% заполнено», а запрос всё равно отклонялся: 99465 + 32768 + 8 = 132241.
 *
 * Резерв берётся не из каталога, а из того, что провайдер действительно отправляет
 * (см. answerReserveTokens): у Codex его нет вовсе, и там правило сводится к
 * «история против окна».
 */
internal fun contextOverflow(task: Task?, info: ApiInfo?): Pair<Long, Long>? {
    val window = sessionContextWindow(task, info)?.takeIf { it > 0 } ?: return null
    val tokens = task?.compaction?.last?.estimatedTokensAfter ?: task?.lastUsage?.totalTokens ?: return null
    val reserve = answerReserveTokens(task)
    return if (tokens + reserve > window) tokens to window else null
}

/**
 * Отправляет ли провайдер лимит вывода полем запроса.
 *
 * Лимит вывода есть у всех адаптеров Pi, кроме Codex: `openai-codex-responses`
 * собирает тело запроса из model/store/stream/instructions/input/text/include/
 * prompt_cache_key/tool_choice/parallel_tool_calls, и поля лимита вывода там нет
 * ни одного (проверено по установленному пакету 2026-10-12). У остальных — есть:
 * openai-responses (`max_output_tokens`), openai-completions (`max_completion_tokens`/
 * `max_tokens`), anthropic и mistral (`max_tokens`), google (`maxOutputTokens`).
 */
internal fun providerSendsOutputLimit(provider: String?): Boolean = provider != "openai-codex"

/**
 * Резерв ответа — сколько токенов провайдер держит под ответ в том же запросе.
 *
 * Число в каталоге модели — это её потолок вывода, а не обязательство провайдера:
 * Codex лимит вывода не отправляет, поэтому `maxTokens` 128000 у gpt-5.5 в окне
 * 272000 не занимает ничего, и вычитать его из окна нельзя.
 *
 * Проверено на живой сессии 8855fa011534 (openai-codex/gpt-5.5, окно 272000):
 * промпт 217571 токен прошёл и ответ получен, а сравнение с резервом объявляло
 * именно эту сессию «не влезает в окно» (217767 + 128000 > 272000) и советовало
 * поднять окно до 345775.
 */
internal fun answerReserveTokens(task: Task?): Long {
    val model = task?.model ?: task?.requestedModel ?: return 0
    if (!providerSendsOutputLimit(model.provider)) return 0
    return model.maxTokens ?: 0
}

/**
 * Идёт ли чтение промпта прямо сейчас.
 *
 * Признаки только живые: фаза движка (Strata отдаёт «reading the prompt») или его PP
 * из `/api/info`. PP прошлого хода (`task.metrics.pp`) сюда не попадает: он не
 * гаснет после ответа, и с ним «Модель читает промпт» висела над уже идущими
 * размышлениями — пока в ответе не появится текст, то есть всё время работы think-
 * блока. Пока модель выдала что-то видимое ([answerSilent] == false), чтения нет.
 */
internal fun readsPromptNow(readingPrompt: Boolean, livePp: Double?, answerSilent: Boolean): Boolean =
    answerSilent && (readingPrompt || livePp != null)

/**
 * Как часто открытый чат перечитывает `/api/info`, пока ход активен.
 *
 * Стадия движка меняется по мере чтения промпта (Strata обновляет `/metrics`
 * несколько раз в секунду), но чаще, чем раз в 3 с, экран её показывать не может:
 * строка статуса — не лента. Меньше значило бы лишние запросы и тепло без пользы.
 */
internal const val ENGINE_INFO_INTERVAL_MS = 3_000L

/**
 * Стоит ли сейчас перечитывать `/api/info` ради телеметрии движка.
 *
 * Только активный ход и только видимый экран: в фоне телефон не должен держать
 * лишний сетевой опрос (STAB-STATUS-01, STATUS-16), а после хода живые PP/TG и
 * фаза уже ничего не значат.
 */
internal fun shouldRefreshEngineInfo(activeTurn: Boolean, inForeground: Boolean): Boolean =
    activeTurn && inForeground

/**
 * Читает ли движок промпт сейчас — по фазе из `/metrics`.
 *
 * Подстрока здесь не годится: фаза `ready` тоже содержит `read`. Поэтому фаза
 * разбирается на слова (разделители — всё, кроме букв), и «чтение» — это слово
 * `reading`. То же правило применено на сервере (`parseStrataMetrics`) и в Web
 * (`readingPrompt`).
 */
internal fun engineReadingPrompt(phase: String?): Boolean =
    phase.orEmpty().lowercase().split(Regex("[^a-zа-яё]+")).any { it == "reading" }

/**
 * Ключ для сопоставления имён Pi с конфигом TaskBridge.
 *
 * Pi называет провайдера и модель по-своему (`strata` вместо `strata-iq3s`, `_`
 * вместо `-` в id), поэтому точное равенство строк здесь не работает.
 */
private fun modelKey(value: String?): String =
    value.orEmpty().trim().lowercase().replace('_', '-').replace(' ', '-')

/**
 * Строка живого локального движка, к которому относится эта сессия.
 *
 * Замер 2026-10-22 (Desktop, настоящая Strata): задача создана с
 * provider=strata, id=qwen3.8-flash-next-iq3_s (так их называет Pi), а в
 * info.local.models строка — provider=strata-iq3s, id=qwen3.8-flash-next-iq3-s
 * (так они названы в конфиге TaskBridge). Сравнение по точному равенству не
 * находило ни один из двух вариантов, `readingPrompt` и живой PP оставались
 * null, и во время настоящего чтения промпта UI показывал «Сообщение передано ·
 * ожидается ответ агента».
 *
 * Порядок поиска: точное совпадение обоих полей → нормализованное совпадение
 * обоих → единственная строка с тем же (нормализованным) id → единственная
 * строка с тем же провайдером. Несколько кандидатов — null: чужой процесс
 * (другая модель того же сервера) хуже, чем отсутствие процентов и скорости.
 */
internal fun externalModelRow(rows: List<LocalModelEntry>, provider: String?, modelId: String?): LocalModelEntry? {
    if (rows.isEmpty()) return null
    val providerKey = modelKey(provider)
    val idKey = modelKey(modelId)
    rows.firstOrNull { it.provider == provider && it.id == modelId }?.let { return it }
    if (idKey.isNotEmpty()) {
        val byId = rows.filter { modelKey(it.id) == idKey }
        if (byId.size == 1) return byId.single()
        if (byId.size > 1) {
            // Одинаковое имя модели у нескольких строк: решает только провайдер,
            // и только если он один. Иначе — null, а не «первая попавшаяся».
            return byId.filter { providerKey.isNotEmpty() && modelKey(it.provider) == providerKey }.singleOrNull()
        }
    }
    // 3. Точное совпадение провайдера (только если такая строка одна).
    if (provider != null) {
        val exactProvider = rows.filter { it.provider == provider }
        if (exactProvider.size == 1) return exactProvider.single()
    }
    if (providerKey.isNotEmpty()) {
        // 4. Имена провайдеров расходятся: Pi зовёт сервер `strata`, в конфиге он
        // `strata-iq3s`. Семейство — только по границе имени (дефис), и только
        // когда такая строка одна: `strata-iq3s` и `strata-q4` — не «одно из двух».
        val byProvider = rows.filter { isNameFamily(modelKey(it.provider), providerKey) }
        if (byProvider.size == 1) return byProvider.single()
    }
    return null
}

/** `strata` ⊂ `strata-iq3s` — да; `strata` ⊂ `stratagem` — нет. */
private fun isNameFamily(candidate: String, wanted: String): Boolean {
    if (candidate.isEmpty() || wanted.isEmpty()) return false
    if (candidate == wanted) return true
    return candidate.startsWith("$wanted-") || wanted.startsWith("$candidate-")
}

/**
 * Текст панели «Диагностика» (и кнопки «Копировать»).
 *
 * Вынесено из composable, чтобы это можно было проверить текстом: здесь сходятся
 * четыре источника (задача, история чата, возраст событий, метрики движка), и
 * перепутанное поле («Начало сессии» из updatedAt, «Текущее сообщение» из ответа
 * модели) видно только на живом экране.
 *
 * Диагностику читает человек: вместо сырых ISO-моментов («2026-10-09T06:53:56.9Z»)
 * — местное время [moment] и возраст события (секунды/минуты назад).
 */
internal fun buildDiagnosticsDetails(
    state: ChatSessionState,
    info: ApiInfo?,
    externalMetrics: LocalModelMetrics?,
    now: Long,
    moment: (Long) -> String,
): String {
    val task = state.task
    val pendingPrompts = task?.pendingPrompts.orEmpty()
    val lastUserMessage = state.chat.items.filterIsInstance<ChatItem.User>().lastOrNull()
    val sessionStart = parseIsoMillis(task?.createdAt)
    val sessionActive = task?.let(::displayStateOf)?.active == true
    // У законченной сессии длительность считается до последнего обновления, у
    // идущей — до текущего момента (пока панель открыта, now идёт вперёд).
    val sessionEnd = if (sessionActive) null else parseIsoMillis(task?.updatedAt) ?: parseIsoMillis(state.lastEventAt)
    val sessionDuration = sessionStart?.let { start ->
        val end = sessionEnd ?: now
        humanDuration(end - start).takeIf { end > start }
    }
    val sessionTitle = task?.let { t ->
        t.title?.takeIf { it.isNotBlank() } ?: t.prompt?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()?.take(80)
    }
    val answer = state.chat.items.filterIsInstance<ChatItem.Assistant>().lastOrNull()
    return listOfNotNull(
        "Сессия: ${state.taskId}" + sessionTitle?.let { " · «$it»" }.orEmpty(),
        "Начало сессии: " + (sessionStart?.let(moment) ?: "неизвестно") +
            sessionDuration?.let { if (sessionActive) " · идёт $it" else " · длительность $it" }.orEmpty(),
        "Связь: ${linkLabel(state.link)}",
        "Последний контакт: ${sinceLabel(state.lastContactAt, now, moment) ?: "ещё нет"}",
        "Последнее событие: ${lastEventLabel(state.lastEventType) ?: "ещё нет"} · ${sinceLabel(state.lastEventAt, now, moment) ?: "—"}",
        "Pi: ${task?.let { if (displayStateOf(it).active) stageLabel(it.status) else displayStateOf(it).label } ?: "—"}",
        "Статус сервера: ${task?.status ?: "—"} · ${task?.runtime?.state ?: "—"}",
        "Активность: ${task?.runtime?.activity ?: "—"} · ${task?.current ?: "—"}",
        "Модель сессии: ${task?.let(::sessionModelLabel) ?: "—"}",
        // Текущее сообщение — то, на что сессия отвечает в этом ходу: без него
        // непонятно, о чём вообще идёт разговор, когда история не на экране.
        lastUserMessage?.let { message ->
            val text = message.text.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.take(120).orEmpty()
            "Текущее сообщение: «$text»" + (sinceLabel(message.at, now, moment)?.let { " · отправлено $it" }.orEmpty())
        },
        pendingPrompts.takeIf { it.isNotEmpty() }?.let { prompts ->
            val listed = prompts.take(3).joinToString("; ") { "«${it.text.lineSequence().firstOrNull().orEmpty().take(60)}»" }
            "Ждут очереди (${prompts.size}): $listed" + if (prompts.size > 3) " и ещё ${prompts.size - 3}" else ""
        },
        // Пока провайдер держит ход, источник задержки известен — и этот факт идёт
        // первым: остальные числа ниже, а без него полуторачасовая тишина выглядела
        // как обычная работа модели.
        providerWaitLine(task?.providerWait, now, moment),
        *sessionDiagnosticsLines(task, info).toTypedArray(),
        externalMetrics?.let(::strataPpLine),
        "Событий получено от сервера: ${state.chat.cursor} · сообщений в очереди: ${pendingPrompts.size}",
        task?.errorCode?.let { "Код ошибки: $it" },
        task?.error,
        "Подтверждение агента не означает ответ провайдера. Пока нет событий модели, источник задержки неизвестен."
            .takeIf { task?.providerWait == null && (answer == null || (answer.text.isBlank() && answer.thinking.isBlank() && answer.tools.isEmpty())) },
    ).joinToString("\n")
}

/**
 * Сколько осталось до объявленного повтора: «1 ч 31 мин», «30 с». null — момента
 * нет или он уже прошёл (тогда ждать нечего, и выдумывать нельзя).
 */
internal fun providerWaitRemaining(wait: ProviderWait?, now: Long): String? =
    wait?.retryAt?.let(::parseIsoMillis)?.takeIf { it > now }?.let { humanDuration(it - now) }

/** Короткая причина отказа для строки состояния: код HTTP или слова провайдера. */
private fun providerWaitCause(wait: ProviderWait): String =
    wait.httpStatus?.let { "HTTP $it" } ?: wait.reason?.takeIf { it.isNotBlank() } ?: "нет ответа"

/** Фаза в панели диагностики: отказ провайдера и остаток до повтора. */
internal fun providerWaitPhase(wait: ProviderWait?, now: Long): String =
    "Провайдер не принял запрос (${wait?.let(::providerWaitCause) ?: "—"})" +
        (providerWaitRemaining(wait, now)?.let { " · повтор через $it" }.orEmpty()) +
        " · подробнее"

/** Строка диагностики: что отказал провайдер, почему и когда Pi повторит. */
internal fun providerWaitLine(wait: ProviderWait?, now: Long, moment: (Long) -> String): String? = wait?.let { w ->
    val who = w.model?.takeIf { it.isNotBlank() }?.let { " $it" }.orEmpty()
    val cause = providerWaitCause(w)
    // Причина, совпадающая с самим кодом («HTTP 507 «HTTP 507»»), — шум: код уже
    // назван. Без кода причина и есть код, и цитата повторила бы её дважды.
    val reason = w.reason?.takeIf { it.isNotBlank() && it != cause }?.let { " «$it»" }.orEmpty()
    val left = providerWaitRemaining(w, now)?.let { " через $it" }.orEmpty()
    val at = parseIsoMillis(w.retryAt)?.let { " (в ${moment(it)})" }.orEmpty()
    "Провайдер$who не принял запрос: $cause$reason. Pi жив и повторит$left$at — сессия не зависла, ответа модели пока нет."
}

/**
 * Последнее событие сессии: техническое имя кадра → короткая подпись, иначе
 * «Последнее событие: VERIFICATION» требует знать внутренние имена. Незнакомое
 * имя печатается как есть — выдуманная подпись хуже, чем raw.
 */
internal fun lastEventLabel(kind: String?): String? = when (kind) {
    null -> null
    // Кадры Pi (см. ChatReducer): по ним видно, на чём именно стоит сессия.
    "agent_start" -> "агент начал ход"
    "agent_settled" -> "агент закончил ход"
    "message_start" -> "модель начала сообщение"
    "message_update" -> "модель пишет ответ"
    "message_end" -> "модель закончила сообщение"
    "turn_end" -> "ход закончен"
    "tool_execution_start" -> "запущен инструмент"
    "tool_execution_update" -> "инструмент работает"
    "tool_execution_end" -> "инструмент завершён"
    "compaction_start", "auto_compaction_start" -> "начато сжатие контекста"
    "compaction_end", "auto_compaction_end" -> "сжатие контекста закончено"
    // События TaskBridge.
    "STATUS", "RUNTIME_STATE" -> "смена состояния"
    "USER_MESSAGE" -> "сообщение пользователя"
    "PROMPT_ACCEPTED" -> "запрос принят"
    "PROMPT_QUEUED" -> "запрос в очереди"
    "QUEUE_WAITING" -> "ждёт освобождения"
    "QUEUE_RETRY" -> "повтор из очереди"
    "QUEUE_DROPPED" -> "запрос убран из очереди"
    "RUNTIME_READY" -> "движок готов"
    "PI_EVENT" -> "кадр Pi"
    "PI_STDERR" -> "вывод Pi в stderr"
    "PI_PROTOCOL_ERROR" -> "сбой протокола Pi"
    "TOOL_OUTPUT" -> "вывод инструмента"
    "APPROVAL_REQUIRED" -> "ждёт подтверждения"
    "APPROVAL_RESOLVED" -> "подтверждение получено"
    "VERIFICATION" -> "проверка результата"
    "VERIFICATION_ERROR" -> "проверка результата упала"
    "TASK_SUCCEEDED" -> "сессия завершена"
    "TASK_FAILED" -> "сессия упала"
    "TASK_CANCELLED" -> "сессия остановлена"
    "MODEL_SWITCH" -> "смена модели"
    "ENGINE_SWITCH" -> "смена движка"
    "PROVIDER_WAIT" -> "провайдер не принял запрос, ждём повтор"
    "PROVIDER_WAIT_END" -> "провайдер снова отвечает"
    "SESSION_RESTORED" -> "сессия восстановлена"
    "THINKING_LEVEL" -> "смена уровня размышлений"
    "CONTEXT_LIMIT_REACHED" -> "достигнут лимит контекста"
    "CONTEXT_LIMIT_FAILED" -> "лимит контекста не сработал"
    "HARD_STOP" -> "жёсткая остановка"
    "UI_NOTIFY", "UI_REQUEST" -> "уведомление"
    else -> kind
}

private fun sessionDiagnosticsLines(task: Task?, info: ApiInfo?): List<String> {
    val metrics = task?.metrics
    // «Последний ход», а не «скорость сессии»: это числа одного хода, и рядом с ними
    // стоят средние по сессии — иначе два разных числа назывались бы одинаково.
    val speed = metrics?.let(::generationSpeedLabel)?.let { "Последний ход: $it ток/с" }
    // Скорости всей сессии, а не последнего хода: PP у облака оценка, у локального
    // движка — его счётчик, и один ход про модель не говорит. Средние считаются
    // только по ходам с числом (см. accumulateSessionSpeeds на сервере).
    val speeds = task?.speeds
    val sessionSpeedLines = listOfNotNull(
        speeds?.ppMax?.let { "Макс. PP за сессию: ${formatSpeed(it)} ток/с" },
        speeds?.ppAvg?.let { "Средняя PP за сессию: ${formatSpeed(it)} ток/с" + speedTurns(speeds.ppTurns) },
        speeds?.tgAvg?.let { "Средняя TG за сессию: ${formatSpeed(it)} ток/с" + speedTurns(speeds.tgTurns) },
    )
    // How long the last turn waited for the first token — the direct answer to
    // «промпт отправлен, а облако молчит».
    val firstToken = metrics?.promptMs?.takeIf { it > 0 }?.let { "Первый токен: ${formatLatencyMs(it)}" }
    val usage = task?.lastUsage
    val window = sessionContextWindow(task, info)
    val compactedTokens = task?.compaction?.last?.estimatedTokensAfter
    // Живое число движка называем по имени: пока модель работает, это размер
    // запроса в работе, а не накопленный контекст сессии, — разные числа.
    val livePrompt = liveEnginePrompt(task?.model ?: task?.requestedModel, info)
    val contextTokens = usage?.totalTokens ?: compactedTokens
    // Первой строкой: если история больше окна, всё остальное в диагностике — уже
    // следствие, и запрос уйдёт в повтор.
    val overflow = contextOverflow(task, info)?.let { (tokens, limit) ->
        val reserve = answerReserveTokens(task)
        // Резерв есть — это правило движка («prompt + max tokens exceeds the context»).
        // Резерва нет — в окно не влезает сама история, и это тоже отказ, но другой:
        // обещать 400 «за резерв» здесь нельзя, резерва в запросе нет.
        if (reserve > 0)
            "История не влезает в окно модели: $tokens + резерв ответа $reserve = ${tokens + reserve} ток. при окне $limit — " +
                "провайдер ответит 400 (промпт не обрезается), поэтому запрос повторяется без ответа. " +
                "Поднимите контекст модели хотя бы до ${tokens + reserve + 8}, уменьшите резерв ответа или начните новую сессию."
        else
            "История не влезает в окно модели: $tokens ток. при окне $limit — запрос уйдёт целиком (промпт не обрезается), " +
                "и ответа не будет. Начните новую сессию или сожмите контекст."
    }
    // Сжатие контекста — запрос к модели, но ответа агента в этом ходу не будет:
    // без этой строки ход выглядит как обычный ответ, который «завис».
    val compaction = task?.runtime?.activity
        ?.takeIf { it == "compacting" }
        ?.let { "Pi сжимает контекст: модель пишет сводку истории — это отдельный запрос, ответа агента в этом ходу не будет" }
    // Сжатие уже прошло: факт и его результат из task.compaction.last — иначе
    // в диагностике видно только «сжатий: N» без того, что именно произошло.
    val lastCompaction = task?.compaction?.last?.let { last ->
        val change = if (last.tokensBefore != null && last.estimatedTokensAfter != null)
            "${tokenCount(last.tokensBefore)} → ${tokenCount(last.estimatedTokensAfter)} ток." else null
        listOfNotNull(change, last.reason?.let(::compactionReasonLabel)).joinToString(" · ")
            .takeIf { it.isNotEmpty() }
            ?.let { "Последнее сжатие: $it · ${last.at?.substringBefore('.')?.replace('T', ' ') ?: "—"}" }
    }
    val livePromptLine = livePrompt
        ?.takeIf { prompt -> prompt > 0 && prompt != contextTokens }
        ?.let { prompt -> "Движок обрабатывает промпт: $prompt${window?.let { " из ${it / 1000}K" }.orEmpty()} ток." }
    val sessionContext = contextTokens?.let { tokens ->
        val percent = window?.takeIf { it > 0 }?.let { " · ${(tokens * 100.0 / it).roundToInt()}%" }.orEmpty()
        val label = if (usage?.totalTokens != null) "Контекст сессии" else "Контекст после сжатия"
        "$label: $tokens${window?.let { " из ${it / 1000}K" }.orEmpty()} ток.$percent"
    }
    val localProvider = info?.local?.provider
    val sessionProvider = task?.model?.provider ?: task?.requestedModel?.provider
    val isLocalSession = localProvider != null && sessionProvider == localProvider
    val localLines = if (isLocalSession) localDiagnosticsLines(info, suppressKvRatio = compactedTokens != null) else emptyList()
    return listOfNotNull(compaction, lastCompaction, overflow, speed, firstToken, sessionContext, livePromptLine) + sessionSpeedLines + localLines
}

/** Сколько ходов легло в среднюю: без числа ходов средняя читалась бы как по всем ходам. */
private fun speedTurns(turns: Int): String = if (turns > 0) " (ходов: $turns)" else ""

/** Причина сжатия из кадра Pi: две известные по имени, остальное — как пришло. */
private fun compactionReasonLabel(reason: String): String = when (reason) {
    "threshold" -> "порог автосжатия"
    "overflow" -> "история превысила окно"
    "manual" -> "вручную"
    else -> reason
}

private fun localDiagnosticsLines(info: ApiInfo?, suppressKvRatio: Boolean): List<String> {
    val metrics = info?.engine?.metrics
    val context = when {
        metrics?.kvRatio != null && !suppressKvRatio -> {
            val tokens = metrics.nTokensMax?.takeIf { it.isFinite() && it > 0.0 }?.let { "${it.toLong()} ток." }.orEmpty()
            val window = metrics.contextWindow ?: info?.engine?.contextWindow
            val windowText = window?.let { " из ${it / 1000}K" }.orEmpty()
            "KV llama.cpp: ${(metrics.kvRatio * 100).roundToInt()}%$windowText${tokens.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()}"
        }
        metrics?.nTokensMax?.takeIf { it.isFinite() && it > 0.0 } != null && !suppressKvRatio -> "KV llama.cpp: ${metrics.nTokensMax.toLong()} ток."
        else -> null
    }
    return listOfNotNull(
        "Локальная модель: ${info?.engine?.model ?: info?.local?.loaded?.firstOrNull() ?: "—"}",
        context,
        metrics?.requestsProcessing?.takeIf { it > 0.0 }?.let { "Запросов обрабатывается: ${it.toInt()}" },
        metrics?.requestsDeferred?.takeIf { it > 0.0 }?.let { "Запросов ждёт: ${it.toInt()}" },
        metrics?.available?.takeIf { !it }?.let { "Метрики llama.cpp: ${metrics.reason ?: "недоступны"}" },
    )
}

private fun sessionModelLabel(task: Task): String =
    (task.model ?: task.requestedModel)?.let(::modelFullLabel) ?: "—"

private fun modelFullLabel(model: ModelRef): String =
    model.provider?.takeIf { it.isNotBlank() }?.let { provider -> "$provider/${model.id ?: "—"}" }
        ?: model.id?.takeIf { it.isNotBlank() }
        ?: model.label

private fun generationSpeedLabel(metrics: GenerationMetrics): String? {
    val values = listOfNotNull(
        metrics.pp?.takeIf { it.isFinite() && it > 0.0 }?.let {
            "PP ${if (metrics.ppApproximate) "≈" else ""}${formatSpeed(it)}"
        },
        metrics.tg?.takeIf { it.isFinite() && it > 0.0 }?.let { "TG ${formatSpeed(it)}" },
    )
    return values.takeIf { it.isNotEmpty() }?.joinToString(" · ")
}

private fun formatSpeed(value: Double): String =
    if (value < 10.0) ((value * 10.0).roundToInt() / 10.0).toString() else value.roundToInt().toString()

/** Статусы, в которых идёт ход: счётчик хода тикает только на них. */
private val TURN_STATUSES = setOf("RUNNING", "PREPARING", "PREFLIGHT", "WAITING_USER", "VERIFYING")

/**
 * Что должно стать `startedAt` при новом статусе задачи.
 *
 * Задача кончилась (SUCCEEDED/FAILED/CANCELLED) — `null`, счётчик гаснет. Иначе
 * время старта хода: первый раз из времени последнего сообщения пользователя,
 * а дальше сохраняется, чтобы смена статуса внутри хода (RUNNING → VERIFYING)
 * не начинала счёт заново.
 */
internal fun turnStartedAt(status: String?, current: Long?, lastUserMessageAt: String?): Long? =
    if (status != null && status in TURN_STATUSES) current ?: parseIsoMillis(lastUserMessageAt) else null

/**
 * Почему у внешнего сервера (Strata) нет PP. Промпт, который движок взял из кеша
 * беседы, он вспомнил, а не прочитал: делить «новые» на время всей промпт-фазы
 * нельзя — получаются накладные расходы (163 новых токена за 1,5 с = «108 tok/s»).
 * Поэтому в строке не выдуманное число, а факт: сколько прочитано из сколько.
 */
internal fun strataPpLine(metrics: LocalModelMetrics): String? {
    if (metrics.ppUnavailable != "conversation-cache") return null
    val detail = listOfNotNull(
        metrics.freshTokens?.let { "новых ${formatTokensK(it)}" },
        metrics.promptTokens?.let { "из ${formatTokensK(it)}" },
    ).joinToString(" ")
    return "PP: — промпт из кеша беседы${if (detail.isEmpty()) "" else " ($detail)"}"
}

/** «0:34», «1:02:05» — elapsed of the running turn. */
private fun elapsedClock(ms: Long): String {
    val s = ms / 1000
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}" else "$m:${sec.toString().padStart(2, '0')}"
}

/** «40.2K», «999» — compact token counts for the status bar. */
private fun formatTokensK(tokens: Long): String =
    if (tokens >= 1000) "${(tokens / 100.0).roundToInt() / 10.0}K" else "$tokens"

@Composable
private fun TextEditDialog(
    title: String,
    hint: String?,
    initial: String,
    confirm: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
    singleLine: Boolean = false,
    extra: (@Composable () -> Unit)? = null,
) {
    var text by remember { mutableStateOf(initial) }
    if (singleLine) {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(title) },
            text = { OutlinedTextField(text, { text = it }, singleLine = true, modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(onClick = { onConfirm(text) }, enabled = text.isNotBlank()) { Text(confirm) } },
            dismissButton = { TextButton(onClick = onDismiss) { Text("Отмена") } },
        )
        return
    }
    // A long message needs room: a wide dialog on desktop, a full sheet on a phone.
    AdaptiveSheet(
        title = title,
        subtitle = hint,
        onDismiss = onDismiss,
        maxWidth = 760,
        footer = {
            TextButton(onClick = onDismiss) { Text("Отмена") }
            Button(onClick = { onConfirm(text) }, enabled = text.isNotBlank()) { Text(confirm) }
        },
    ) {
        OutlinedTextField(text, { text = it }, minLines = 6, maxLines = 20, modifier = Modifier.fillMaxWidth())
        extra?.invoke()
    }
}

@Composable
private fun ConfirmDialog(title: String, text: String, confirm: String, destructive: Boolean, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(confirm, color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Отмена") } },
    )
}

/**
 * Есть ли что останавливать. CANCELLING здесь намеренно: если остановка залипла,
 * именно повторное нажатие — единственный выход, а кнопка, исчезающая при
 * «Останавливаю…», запирает оператора в зависшем чате (2026-10-14).
 *
 * [pendingSends] — незавершённые отправки клиента. Оператор 2026-10-14: «сообщение
 * не отправляется, и я не могу никак перезапустить». Такое состояние видно в
 * статусе НЕ всегда (сессия уже SUCCEEDED/FAILED, а отправка висит), поэтому
 * очередь отправок — второй, независимый повод для STOP.
 */
/** Сколько ждать одну страницу истории при «Копировать историю» (см. эффект копирования). */
internal const val PAGE_WAIT_MS = 5_000L

internal fun canStop(status: String?, pendingSends: Int = 0): Boolean =
    pendingSends > 0 || status in setOf(
        "QUEUED", "PREPARING", "PREFLIGHT", "RUNNING", "WAITING_USER", "VERIFYING", "CANCELLING",
    )

/**
 * Шаг C-A: состояние молчания хода для баннера.
 *
 * silentMs считает сервер (клиент не вычитает часы другого устройства),
 * порог по умолчанию — 120 с (как в web). Молчание сообщается только для
 * живого хода: терминальная сессия молчать не может.
 */
data class SilenceState(val totalMs: Long, val stage: String?) {
    val label: String
        get() = "Модель молчит ${totalMs / 60000}:${(totalMs % 60000 / 1000).toString().padStart(2, '0')}"
}

internal fun silenceState(task: Task?, thresholdMs: Long = 120_000L): SilenceState? {
    // A quiet tool/compaction/provider retry is a known activity, not a silent model.
    if (task?.status != "RUNNING" || task.providerWait != null ||
        task.runtime?.activity in setOf("tool", "compacting", "waiting_model")) return null
    val silent = task?.turnState?.silentMs?.takeIf { it >= thresholdMs } ?: return null
    return SilenceState(silent, task.turnState?.stage?.takeIf { it.isNotBlank() })
}

@Composable
private fun SilenceBanner(silence: SilenceState, onWait: () -> Unit, onStop: () -> Unit, onRestart: () -> Unit) {
    val colors = LocalStatusColors.current
    Surface(Modifier.fillMaxWidth(), color = colors.waiting.copy(alpha = 0.12f)) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(AppIcons.Alert, null, tint = colors.waiting, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(silence.label, style = MaterialTheme.typography.labelLarge, color = colors.waiting)
                Text(
                    "Последний прогресс: ${silence.stage ?: "стадия неизвестна"}. Ход может быть просто долгим.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = onWait) { Text("Подождать") }
            // Перезапуск — не «повторить»: промпт сам не переотправится (план 4.2/C-A).
            TextButton(onClick = onRestart) { Text("Перезапустить") }
            TextButton(onClick = onStop) { Text("STOP", color = MaterialTheme.colorScheme.error) }
        }
    }
}
