package ru.arny.taskbridge.ui.chat

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
import androidx.compose.material3.SnackbarHost
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import ru.arny.taskbridge.core.client.chat.ToolState
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.Json
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiInfo
import ru.arny.taskbridge.core.api.Approval
import ru.arny.taskbridge.core.api.GenerationMetrics
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.PendingPrompt
import ru.arny.taskbridge.core.api.QuickAction
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
import ru.arny.taskbridge.platform.rememberFilePicker
import ru.arny.taskbridge.ui.common.AdaptiveSheet
import ru.arny.taskbridge.ui.common.Banner
import ru.arny.taskbridge.ui.common.EmptyState
import ru.arny.taskbridge.ui.common.StatusDot
import ru.arny.taskbridge.ui.common.parseIsoMillis
import ru.arny.taskbridge.ui.common.sourceLabel
import ru.arny.taskbridge.ui.common.timeRange
import ru.arny.taskbridge.ui.sessions.FieldLabel
import ru.arny.taskbridge.ui.sessions.ModelPicker
import ru.arny.taskbridge.ui.sessions.formatLatencyMs
import ru.arny.taskbridge.ui.sessions.latencyFor
import ru.arny.taskbridge.ui.sessions.modelLatencyLabel
import ru.arny.taskbridge.ui.sessions.ModelChooser
import ru.arny.taskbridge.ui.sessions.ThinkingPicker
import ru.arny.taskbridge.ui.sessions.thinkingLabel
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors
import ru.arny.taskbridge.ui.theme.MonoStyle

/** A dialog the chat can show; one at a time. */
private sealed interface ChatDialog {
    data class EditMessage(val turnId: String, val text: String) : ChatDialog
    data class EditAnswer(val turnId: String, val text: String) : ChatDialog
    /** [withAnswer]: started from an answer — the log is linear, so its question goes too. */
    data class DeleteFrom(val turnId: String, val withAnswer: Boolean = false) : ChatDialog
    data object ConfirmStop : ChatDialog
    data object ConfirmClear : ChatDialog
    data object ConfirmDelete : ChatDialog
    data object Rename : ChatDialog
    data object ModelSettings : ChatDialog
    data object ChooseModel : ChatDialog
}

@OptIn(FlowPreview::class)
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
    val sessionListState by connection.sessions.state.collectAsState()
    val online by connection.online.collectAsState()
    val platform = graph.platform
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var dialog by remember { mutableStateOf<ChatDialog?>(null) }
    var viewing by androidx.compose.runtime.saveable.rememberSaveable(taskId, stateSaver = FileTargetSaver) { mutableStateOf<FileTarget?>(null) }
    var files by remember(taskId) { mutableStateOf<List<UploadFile>>(emptyList()) }
    var draft by remember(taskId) { mutableStateOf(TextFieldValue(graph.settings.draft(taskId))) }
    // The picker keeps its own copy; this one feeds the status bar's TTFT.
    var screenCatalog by remember { mutableStateOf<ModelCatalog?>(null) }
    var quickActions by remember(connection, taskId) { mutableStateOf(fallbackQuickActions()) }
    val pickFiles = rememberFilePicker { picked -> files = files + picked }

    LaunchedEffect(connection) { connection.sessions.models().onSuccess { screenCatalog = it }.onFailure { /* chooser can retry */ } }
    LaunchedEffect(connection, taskId, state.task?.runtime?.state) {
        quickActions = runCatching { connection.api.quickActions(taskId) }.getOrDefault(fallbackQuickActions()).ifEmpty { fallbackQuickActions() }
    }

    DisposableEffect(taskId) {
        connection.visibleSession = taskId
        graph.settings.lastSessionId = taskId
        platform.clearNotification(taskId)
        onDispose { if (connection.visibleSession == taskId) connection.visibleSession = null }
    }
    LaunchedEffect(taskId) {
        snapshotFlow { draft.text }.debounce(400).collect { graph.settings.saveDraft(taskId, it) }
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
        graph.settings.saveDraft(taskId, "")
        scope.launch { listState.animateScrollToItem(0) }
    }

    var copyingHistory by remember { mutableStateOf(false) }
    LaunchedEffect(copyingHistory) {
        if (!copyingHistory) return@LaunchedEffect
        // The chat is paged: pull every older page first; a page that brings nothing
        // (a network error) ends the loop, and the loaded part is copied.
        while (!session.state.value.reachedStart) {
            val count = session.state.value.chat.items.size
            session.loadOlder()
            session.state.first { !it.loadingOlder }
            if (session.state.value.chat.items.size == count && !session.state.value.reachedStart) break
        }
        val current = session.state.value
        platform.copyText(chatTranscript(current.chat.items, current.task?.displayTitle) { start, end -> timeRange(platform, start, end) })
        snackbar.currentSnackbarData?.dismiss()
        snackbar.showSnackbar(if (current.reachedStart) "История чата скопирована" else "Скопирована только загруженная часть истории")
        copyingHistory = false
    }

    Scaffold(
        topBar = {
            ChatTopBar(
                state = state,
                working = working,
                showBack = showBack,
                onBack = onBack,
                onDialog = { dialog = it },
                onCopyHistory = { copyingHistory = true },
            )
        },
        // The composer pads for the navigation bar itself; Scaffold adding it too left a blank strip.
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            if (!online) Banner("Устройство offline — показана сохранённая история, команды останутся в outbox", AppIcons.Alert, LocalStatusColors.current.waiting)
            LinkBanner(state.link, onRetry = { session.reconnectNow() })
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    state.link is LinkState.Failed && state.chat.items.isEmpty() -> EmptyState(
                        AppIcons.Alert,
                        "Сессию не открыть",
                        describe((state.link as LinkState.Failed).error),
                    )
                    else -> MessageList(
                        graph = graph,
                        session = session,
                        state = state,
                        listState = listState,
                        historyLocked = historyLocked,
                        onDialog = { dialog = it },
                        onViewFile = { viewing = it },
                        onCopyMessage = { text ->
                            platform.copyText(text)
                            snackbar.currentSnackbarData?.dismiss()
                            scope.launch { snackbar.showSnackbar("Сообщение скопировано") }
                        },
                    )
                }
                // Reading older messages: the list stays put; new output only lights up the jump button.
                val showJump by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 80 } }
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
            SnackbarHost(snackbar, Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp))
            for (approval in state.approvals) {
                ApprovalCard(approval, busy = "approval:${approval.approvalId}" in state.busy, onAnswer = { allow -> session.answerApproval(approval.approvalId, allow) })
            }
            Composer(
                moreItems = { close ->
                    if (task != null) {
                        DropdownMenuItem(text = { Text("Выбрать модель") }, leadingIcon = { Icon(AppIcons.Spark, null) }, onClick = { close(); dialog = ChatDialog.ChooseModel })
                        DropdownMenuItem(text = { Text("Настройки сессии") }, leadingIcon = { Icon(AppIcons.Layers, null) }, onClick = { close(); dialog = ChatDialog.ModelSettings })
                        DropdownMenuItem(text = { Text("Сжать контекст") }, leadingIcon = { Icon(AppIcons.Layers, null) }, enabled = !working, onClick = { close(); session.compact() })
                    }
                },
                top = {
                    DeliveryDiagnostics(state, info = sessionListState.info, catalog = screenCatalog, nowMillis = graph::nowMillis, onRefresh = session::reconnectNow, onCopy = platform::copyText)
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
                value = draft,
                onValueChange = { next ->
                    val attachment = largeTextAttachmentFromDraftChange(draft.text, next.text)
                    if (attachment == null) {
                        draft = next
                    } else {
                        files = files + UploadFile(pastedTextFileName(graph.nowIso()), "text/plain", attachment.text.encodeToByteArray())
                        draft = TextFieldValue(
                            attachment.remainingText,
                            TextRange(attachment.caret.coerceIn(0, attachment.remainingText.length)),
                        )
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
                onStop = if (task?.status in setOf("QUEUED", "PREPARING", "PREFLIGHT", "RUNNING", "WAITING_USER", "VERIFYING")) ({ dialog = ChatDialog.ConfirmStop }) else null,
            )
        }
    }

    ChatDialogs(dialog, state, session, graph, send = { send(it) }, onDialog = { dialog = it }, onViewFile = { viewing = it }, onClose = { dialog = null })
    viewing?.let {
        FileViewer(
            it,
            session,
            platform,
            onDismiss = { viewing = null },
            // A link inside a rendered Markdown file opens the file it points at.
            onOpenPath = { path -> viewing = FileTarget.Workspace(path) },
        )
    }
}

@Composable
private fun ChatTopBar(
    state: ChatSessionState,
    working: Boolean,
    showBack: Boolean,
    onBack: () -> Unit,
    onDialog: (ChatDialog) -> Unit,
    onCopyHistory: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val task = state.task
    val display = task?.let(::displayStateOf)
    val headerModel = task?.model ?: task?.requestedModel
    TopAppBar(
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
            }
        },
        actions = {
            Box {
                IconButton(onClick = { menu = true }) { Icon(AppIcons.More, "Меню сессии") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Копировать историю") }, leadingIcon = { Icon(AppIcons.Copy, null) }, enabled = state.chat.items.isNotEmpty(), onClick = { menu = false; onCopyHistory() })
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

@Composable
private fun MessageList(
    graph: AppGraph,
    session: ChatSession,
    state: ChatSessionState,
    listState: androidx.compose.foundation.lazy.LazyListState,
    historyLocked: Boolean,
    onDialog: (ChatDialog) -> Unit,
    onViewFile: (FileTarget) -> Unit,
    onCopyMessage: (String) -> Unit,
) {
    val platform = graph.platform
    val ownClient = graph.settings.clientId
    val items = state.chat.items
    val reversed = remember(items) { items.asReversed() }
    // Older history loads when the top of the chat comes into view.
    val nearTop by remember { derivedStateOf { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= listState.layoutInfo.totalItemsCount - 10 } == true } }
    LaunchedEffect(nearTop, state.reachedStart) { if (nearTop && !state.reachedStart) session.loadOlder() }

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
                                    copy = { onCopyMessage(item.text) },
                                    edit = turnId?.takeIf { !historyLocked }?.let { { onDialog(ChatDialog.EditMessage(it, item.text)) } },
                                    fork = turnId?.takeIf { !historyLocked }?.let { { session.fork(it) } },
                                    deleteFrom = turnId?.takeIf { !historyLocked }?.let { { onDialog(ChatDialog.DeleteFrom(it)) } },
                                ),
                                onOpenFile = { id, name -> onViewFile(FileTarget.Attachment(id, name)) },
                                loadFile = { session.readFile(it) },
                                hoverActions = platform.kind == "desktop",
                            )
                        }
                        is ChatItem.Assistant -> {
                            val newest = item.id == state.chat.newestAnswerId && !historyLocked && item.final
                            AssistantMessage(
                                item = item,
                                time = timeRange(platform, item.at, item.endedAt),
                                actions = MessageActions(
                                    copy = { onCopyMessage(item.text) },
                                    edit = if (newest) ({ onDialog(ChatDialog.EditAnswer(item.id, item.text)) }) else null,
                                    fork = item.id.takeIf { !historyLocked && Regex("^assistant-(\\d+|initial)$").matches(it) }?.let { { session.fork(it) } },
                                    regenerate = if (newest) ({ session.regenerate(item.id) }) else null,
                                    continueAnswer = if (newest && (item.text.isNotBlank() || item.tools.isNotEmpty())) ({ session.continueAnswer(item.id) }) else null,
                                    deleteFrom = item.id.takeIf { !historyLocked && !item.active && Regex("^assistant-(initial|\\d+)$").matches(it) }?.let { { onDialog(ChatDialog.DeleteFrom(it, withAnswer = true)) } },
                                ),
                                onCopyText = { platform.copyText(it) },
                                loadToolOutput = { session.toolOutput(it) },
                                onOpenPath = { onViewFile(FileTarget.Workspace(it)) },
                                onOpenFile = { id, name -> onViewFile(FileTarget.Attachment(id, name)) },
                                loadFile = { session.readFile(it) },
                                loadWorkspaceFile = { session.readWorkspaceFile(it) },
                                hoverActions = platform.kind == "desktop",
                                onSelectVariant = { position ->
                                    val variants = item.variants
                                    val variantId = variants?.variantIdAt(position)
                                    if (variants != null && variantId != null) session.selectVariant(variants.turnSeq, variantId)
                                },
                            )
                        }
                        is ChatItem.Note -> NoteRow(item, onCopy = { onCopyMessage(item.text) })
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
private fun DeliveryDiagnostics(state: ChatSessionState, info: ApiInfo?, catalog: ModelCatalog?, nowMillis: () -> Long, onRefresh: () -> Unit, onCopy: (String) -> Unit) {
    var open by remember(state.taskId) { mutableStateOf(false) }
    val answer = state.chat.items.filterIsInstance<ChatItem.Assistant>().lastOrNull()
    // Live engine PP (llama.cpp reports it in /api/info before the first token)
    // makes «Модель читает промпт» work for a local session even on its first
    // turn, where task.metrics is still empty. Gated to the local provider: the
    // local engine's numbers say nothing about a cloud provider.
    val localProvider = info?.local?.provider
    val sessionProvider = state.task?.model?.provider ?: state.task?.requestedModel?.provider
    val livePp = if (localProvider != null && sessionProvider == localProvider) info?.engine?.metrics?.pp?.takeIf { it.isFinite() && it > 0.0 } else null
    // Live engine TG too: llama.cpp reports both while it streams, so PP and TG
    // tick with the /api/info poll (1s while a turn is active) instead of
    // freezing on the last turn's values. A cloud provider has no live source:
    // Pi reports usage only at message_end, so its PP/TG are per-turn.
    val liveTg = if (localProvider != null && sessionProvider == localProvider) info?.engine?.metrics?.tg?.takeIf { it.isFinite() && it > 0.0 } else null
    val readingPp = livePp ?: state.task?.metrics?.pp?.takeIf { it.isFinite() && it > 0.0 }
    val phase = when {
        state.link !is LinkState.Live -> "Связь с сервером не подтверждена"
        state.outbox.isNotEmpty() -> "Отправка сообщения · подробнее"
        state.task?.status == "FAILED" -> "Ошибка · подробнее"
        answer?.tools?.any { it.state == ToolState.RUNNING } == true -> "Агент выполняет команды"
        readingPp != null && answer?.text.isNullOrBlank() == true -> "Модель читает промпт"
        answer?.active == true && answer.text.isNotBlank() -> "Получаем ответ модели"
        answer?.active == true && answer.thinking.isNotBlank() -> "Получаем размышления модели"
        answer?.active == true -> "Сообщение передано · ожидается ответ агента"
        state.task?.pendingPrompts?.isNotEmpty() == true -> "Сообщение в очереди"
        else -> "Диагностика доставки"
    }
    val details = listOfNotNull(
        "Сессия: ${state.taskId}",
        "Связь: ${if (state.link is LinkState.Live) "поток подключён" else state.link}",
        "Последний контакт: ${state.lastContactAt ?: "ещё нет"}",
        "Последнее событие: ${state.lastEventType ?: "ещё нет"} · ${state.lastEventAt ?: "—"}",
        "Pi: ${state.task?.let { if (displayStateOf(it).active) stageLabel(it.status) else displayStateOf(it).label } ?: "—"}",
        "Статус сервера: ${state.task?.status ?: "—"} · ${state.task?.runtime?.state ?: "—"}",
        "Активность: ${state.task?.runtime?.activity ?: "—"} · ${state.task?.current ?: "—"}",
        "Модель сессии: ${state.task?.let(::sessionModelLabel) ?: "—"}",
        *sessionDiagnosticsLines(state.task, info).toTypedArray(),
        "Событие № ${state.chat.cursor} · в очереди ${state.task?.pendingPrompts?.size ?: 0}",
        state.task?.errorCode?.let { "Код ошибки: $it" },
        state.task?.error,
        "Подтверждение агента не означает ответ провайдера. Пока нет событий модели, источник задержки неизвестен."
            .takeIf { answer == null || (answer.text.isBlank() && answer.thinking.isBlank() && answer.tools.isEmpty()) },
    ).joinToString("\n")
    // Elapsed since the turn started, ticking every second. Seeded from the last
    // user message's server timestamp (the client and the server clocks may drift
    // by seconds on a LAN, which is fine for a rough «0:34»), so a session opened
    // mid-turn shows it too.
    var startedAt by remember(state.taskId) { mutableStateOf<Long?>(null) }
    LaunchedEffect(state.taskId) {
        snapshotFlow { state.task?.status }.collect { status ->
            when (status) {
                "RUNNING", "PREPARING", "PREFLIGHT", "WAITING_USER", "VERIFYING" ->
                    if (startedAt == null) startedAt = state.chat.items.filterIsInstance<ChatItem.User>().lastOrNull()?.let { parseIsoMillis(it.at) }
                null -> {}
                else -> startedAt = null
            }
        }
    }
    var tick by remember(state.taskId) { mutableStateOf(nowMillis()) }
    LaunchedEffect(state.taskId, startedAt) {
        if (startedAt != null) while (true) { delay(1000); tick = nowMillis() }
    }
    val elapsed = startedAt?.let { (tick - it).coerceAtLeast(0) }
    // Line 1 segments: elapsed · TTFT · PP · TG.
    val stats = listOfNotNull(
        elapsed?.let { elapsedClock(it) },
        catalog?.latencyFor(state.task?.model ?: state.task?.requestedModel)?.let { l -> (l.p50Ms ?: l.avgMs)?.let { "TTFT ${formatLatencyMs(it)}" } },
        readingPp?.let { "PP ${formatSpeed(it)}" },
        (liveTg ?: state.task?.metrics?.tg?.takeIf { it.isFinite() && it > 0.0 })?.let { "TG ${formatSpeed(it)} ток/с" },
    )
    // Line 2: model · context usage · queued count.
    val used = state.task?.compaction?.last?.estimatedTokensAfter ?: state.task?.lastUsage?.totalTokens
    val window = state.task?.model?.contextWindow ?: state.task?.requestedModel?.contextWindow
    val display = state.task?.let(::displayStateOf)
    val dotColor = when {
        state.task?.status == "FAILED" -> LocalStatusColors.current.failed
        display?.active == true -> LocalStatusColors.current.working
        state.task?.status == "QUEUED" -> LocalStatusColors.current.queued
        else -> LocalStatusColors.current.muted
    }
    Column(Modifier.fillMaxWidth().clickable { open = true }) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(dotColor))
            Spacer(Modifier.width(6.dp))
            Text(phase, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (stats.isNotEmpty()) {
                Spacer(Modifier.width(8.dp))
                Text(stats.joinToString("  ·  "), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
            Spacer(Modifier.width(4.dp))
            Icon(AppIcons.ChevronRight, "Открыть диагностику", Modifier.size(16.dp))
        }
        state.task?.let { task ->
            Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                if (window != null && window > 0 && used != null) {
                    Spacer(Modifier.width(8.dp))
                    // A plain box bar: no LinearProgressIndicator overload surprises across platforms.
                    Box(Modifier.weight(1f).height(4.dp).clip(RoundedCornerShape(2.dp)).background(MaterialTheme.colorScheme.surfaceVariant)) {
                        Box(Modifier.fillMaxHeight().fillMaxWidth(((used * 1.0 / window).coerceIn(0.0, 1.0)).toFloat()).background(MaterialTheme.colorScheme.primary))
                    }
                    Spacer(Modifier.width(6.dp))
                    Text("${(used * 100.0 / window).roundToInt()}% (${formatTokensK(used)}/${formatTokensK(window)})", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.width(8.dp))
                Text("оч. ${task.pendingPrompts.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
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

@Composable
private fun OutboxRow(message: OutgoingMessage, onRetry: () -> Unit, onEdit: () -> Unit, onDismiss: () -> Unit) {
    val status = message.status
    val (text, color) = when (status) {
        OutgoingMessage.Status.Uploading -> "Загружаю файлы…" to MaterialTheme.colorScheme.onSurfaceVariant
        OutgoingMessage.Status.Sending -> return
        is OutgoingMessage.Status.Retrying -> "Нет связи, повтор ${status.attempt}…" to LocalStatusColors.current.waiting
        is OutgoingMessage.Status.Failed -> "Не отправлено: ${status.message}" to MaterialTheme.colorScheme.error
        OutgoingMessage.Status.Unknown -> "Неизвестно, дошло ли сообщение (сервер перезапускался)" to LocalStatusColors.current.waiting
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
        ChatDialog.ConfirmStop -> ConfirmDialog(
            title = "Остановить агента?",
            text = "STOP прервёт текущий ответ и запущенные команды" + (state.task?.pendingPrompts?.size?.takeIf { it > 0 }
                ?.let { ", а также уберёт из очереди $it сообщ. Чтобы сохранить очередь, отправьте первое из неё «Сейчас»." } ?: "."),
            confirm = "Остановить",
            destructive = true,
            onConfirm = { session.cancel(); onClose() },
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
        ModelChooser(catalog!!, state.task?.model, graph.settings, onPick = { model ->
            if (model.key == state.task?.model?.key) onClose()
            else if (pendingKey == null) {
                pendingKey = model.key
                session.setModel(model)
            }
        }, onDismiss = onClose, pendingKey = pendingKey ?: if ("model" in state.busy) "" else null)
    }
}

@Composable
private fun ModelSheet(state: ChatSessionState, session: ChatSession, graph: AppGraph, onDialog: (ChatDialog) -> Unit, onViewFile: (FileTarget) -> Unit, onClose: () -> Unit) {
    val connection = graph.connection ?: return
    var catalog by remember { mutableStateOf<ModelCatalog?>(null) }
    LaunchedEffect(Unit) { connection.sessions.models().onSuccess { catalog = it } }
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
        ModelPicker(catalog, task?.model, graph.settings, onPick = { session.setModel(it) })
        Text(
            "Смена модели записывается в историю Pi и переживает перезапуск.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp),
        )
        val levels = catalog?.thinkingLevels.orEmpty()
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
        val usage = task?.lastUsage
        val window = task?.model?.contextWindow
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
        LaunchedEffect(task?.id) { artifacts = session.artifacts().getOrNull() }
        val artifactNames = artifacts.orEmpty()
        if (artifactNames.isNotEmpty()) {
            FieldLabel("Artifacts", top = 20)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (name in artifactNames) FileChip(name, "") { onViewFile(FileTarget.Artifact(name)) }
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

private fun sessionDiagnosticsLines(task: Task?, info: ApiInfo?): List<String> {
    val metrics = task?.metrics
    val speed = metrics?.let(::generationSpeedLabel)?.let { "Скорость сессии: $it ток/с" }
    // How long the last turn waited for the first token — the direct answer to
    // «промпт отправлен, а облако молчит».
    val firstToken = metrics?.promptMs?.takeIf { it > 0 }?.let { "Первый токен: ${formatLatencyMs(it)}" }
    val usage = task?.lastUsage
    val window = task?.model?.contextWindow ?: task?.requestedModel?.contextWindow
    val compactedTokens = task?.compaction?.last?.estimatedTokensAfter
    val contextTokens = compactedTokens ?: usage?.totalTokens
    val sessionContext = contextTokens?.let { tokens ->
        val percent = window?.takeIf { it > 0 }?.let { " · ${(tokens * 100.0 / it).roundToInt()}%" }.orEmpty()
        val label = if (compactedTokens != null) "Контекст после сжатия" else "Контекст сессии"
        "$label: $tokens${window?.let { " из ${it / 1000}K" }.orEmpty()} ток.$percent"
    }
    val localProvider = info?.local?.provider
    val sessionProvider = task?.model?.provider ?: task?.requestedModel?.provider
    val isLocalSession = localProvider != null && sessionProvider == localProvider
    val localLines = if (isLocalSession) localDiagnosticsLines(info, suppressKvRatio = compactedTokens != null) else emptyList()
    return listOfNotNull(speed, firstToken, sessionContext) + localLines
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

private fun modelFullLabel(model: ru.arny.taskbridge.core.api.ModelRef): String =
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
