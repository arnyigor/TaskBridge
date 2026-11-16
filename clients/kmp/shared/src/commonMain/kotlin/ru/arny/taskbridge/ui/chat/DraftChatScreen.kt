package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.SCRATCH_PROJECT_ID
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.platform.rememberFilePicker
import ru.arny.taskbridge.ui.SessionDraft
import ru.arny.taskbridge.ui.common.AppSnackbarHost
import ru.arny.taskbridge.ui.common.EmptyState
import ru.arny.taskbridge.ui.sessions.messageOf
import ru.arny.taskbridge.ui.sessions.ModelPicker
import ru.arny.taskbridge.ui.sessions.thinkingLabel
import ru.arny.taskbridge.ui.theme.AppIcons

/**
 * A new session before its first message: the chat looks ready, and sending
 * creates the session on the PC with the draft's project, model and thinking,
 * then [onCreated] swaps this screen for the real chat. On failure the text stays.
 */
@Composable
fun DraftChatScreen(
    graph: AppGraph,
    connection: AppGraph.Connected,
    draft: SessionDraft,
    onBack: () -> Unit,
    onCreated: (taskId: String) -> Unit,
    showBack: Boolean,
) {
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var text by remember(draft) { mutableStateOf(TextFieldValue("")) }
    var files by remember(draft) { mutableStateOf<List<UploadFile>>(emptyList()) }
    var sending by remember(draft) { mutableStateOf(false) }
    var model by remember(draft) { mutableStateOf<ModelRef?>(draft.model) }
    var catalog by remember(draft) { mutableStateOf<ModelCatalog?>(null) }
    var mode by remember(draft) { mutableStateOf("agent") }
    val canPlan = draft.projectId != SCRATCH_PROJECT_ID && files.isEmpty()
    val pickFiles = rememberFilePicker { picked -> if (mode == "agent" && !sending) files = files + picked }
    fun attachmentNotice() {
        scope.launch { snackbar.showSnackbar("Вложения недоступны в режиме планирования") }
    }
    val setup = listOfNotNull(draft.projectName, model?.label?.takeIf { it != "—" }, draft.thinking?.let { thinkingLabel(it) }).joinToString(" · ")

    LaunchedEffect(draft.commandId) {
        connection.sessions.models().onSuccess { catalog = it }
            .onFailure { snackbar.showSnackbar(messageOf(it)) }
    }

    fun send() {
        if (sending || (text.text.isBlank() && files.isEmpty())) return
        if (mode == "plan" && (!canPlan || text.text.trimStart().startsWith("/") || text.text.trimStart().startsWith("!"))) {
            scope.launch { snackbar.showSnackbar("Для планирования нужен проект и текст без команд и вложений") }
            return
        }
        sending = true
        scope.launch {
            connection.sessions.create(draft.projectId, text.text.ifBlank { "Посмотри приложенные файлы" }, model, draft.thinking, draft.title, files, draft.commandId, mode = mode)
                .onSuccess { onCreated(it.id) }
                .onFailure { snackbar.showSnackbar(messageOf(it)) }
            sending = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { if (showBack) IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад") } },
                title = {
                    Column {
                        Text(draft.title ?: "Новая сессия", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                        Text(setup, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
            )
        },
        // The composer pads for the navigation bar itself; Scaffold adding it too left a blank strip.
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            Text(
                if (mode == "plan") "Только чтение · без команд и вложений"
                else if (!canPlan) "Для планирования выберите проект и уберите вложения"
                else "Режим можно выбрать до первого сообщения",
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall,
            )
            Box(Modifier.weight(1f).fillMaxWidth()) {
                EmptyState(AppIcons.Chat, if (mode == "plan") "Что спланировать?" else "Что сделать агенту?", "$setup\nСессия появится на компьютере с первым сообщением.")
            }
            Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                val sessionListState by connection.sessions.state.collectAsState()
                ModelPicker(catalog, model, graph.settings, info = sessionListState.info, onPick = { model = it })
            }
            // Above the composer rather than over it: the field and its buttons must stay reachable
            // while a notice is on screen.
            AppSnackbarHost(snackbar, Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp))
            Composer(
                value = text,
                onValueChange = { next ->
                    val paste = pastedTextDraft(text.text, next.text, graph.nowIso())
                    text = if (mode == "plan") next else paste.caret
                        ?.let { TextFieldValue(paste.text, TextRange(it.coerceIn(0, paste.text.length))) }
                        ?: next
                    paste.attached?.takeIf { mode == "agent" }?.let { attached ->
                        files = files + attached
                        scope.launch { snackbar.showSnackbar("Большой вставленный текст прикреплён файлом") }
                    }
                },
                files = files,
                onRemoveFile = { files = files - it },
                onAttach = { if (mode == "agent") pickFiles() else attachmentNotice() },
                onPaste = { pasted -> if (mode == "plan") attachmentNotice() else if (pasted.isEmpty()) scope.launch { snackbar.showSnackbar("В буфере нет картинки или файлов") } else files = files + pasted },
                working = false,
                modeButton = {
                    SessionModeChip(
                        mode = mode,
                        onPick = { mode = it },
                        blocked = if (sending) "Сессия создаётся…" else null,
                        planBlocked = if (canPlan) null else "Планированию нужен проект и текст без вложений",
                        collapseKey = sending,
                    )
                },
                readOnly = mode == "plan",
                enterSends = graph.settings.enterSends && graph.platform.kind == "desktop",
                enabled = !sending,
                onSend = { send() },
            )
        }
    }
}
