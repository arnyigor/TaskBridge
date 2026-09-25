package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.platform.rememberFilePicker
import ru.arny.taskbridge.ui.SessionDraft
import ru.arny.taskbridge.ui.common.EmptyState
import ru.arny.taskbridge.ui.sessions.messageOf
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
    val pickFiles = rememberFilePicker { picked -> files = files + picked }
    val setup = listOfNotNull(draft.projectName, draft.model?.label?.takeIf { it != "—" }, draft.thinking?.let { thinkingLabel(it) }).joinToString(" · ")

    fun send() {
        if (sending || (text.text.isBlank() && files.isEmpty())) return
        sending = true
        scope.launch {
            connection.sessions.create(draft.projectId, text.text.ifBlank { "Посмотри приложенные файлы" }, draft.model, draft.thinking, draft.title, files, draft.commandId)
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
        snackbarHost = { SnackbarHost(snackbar, Modifier.navigationBarsPadding()) },
        // The composer pads for the navigation bar itself; Scaffold adding it too left a blank strip.
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                EmptyState(AppIcons.Chat, "Что сделать агенту?", "$setup\nСессия появится на компьютере с первым сообщением.")
            }
            Composer(
                value = text,
                onValueChange = { text = it },
                files = files,
                onRemoveFile = { files = files - it },
                onAttach = pickFiles,
                onPaste = { pasted -> if (pasted.isEmpty()) scope.launch { snackbar.showSnackbar("В буфере нет картинки или файлов") } else files = files + pasted },
                working = false,
                enterSends = graph.settings.enterSends && graph.platform.kind == "desktop",
                enabled = !sending,
                onSend = { send() },
            )
        }
    }
}
