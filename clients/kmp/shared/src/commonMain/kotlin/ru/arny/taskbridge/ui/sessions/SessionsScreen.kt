package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.client.session.describe
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.core.client.sessions.SessionGroup
import ru.arny.taskbridge.core.client.sessions.activityOf
import ru.arny.taskbridge.core.client.sessions.displayStateOf
import ru.arny.taskbridge.ui.common.Banner
import ru.arny.taskbridge.ui.common.EmptyState
import ru.arny.taskbridge.ui.common.StatusDot
import ru.arny.taskbridge.ui.common.StatusPill
import ru.arny.taskbridge.ui.common.relativeTime
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors

@Composable
fun SessionsScreen(
    graph: AppGraph,
    connection: AppGraph.Connected,
    selectedTaskId: String?,
    onOpen: (String) -> Unit,
    onSettings: () -> Unit,
) {
    val state by connection.sessions.state.collectAsState()
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<Task?>(null) }
    var deleting by remember { mutableStateOf<Task?>(null) }
    // Relative times ("5 мин") move on their own.
    var now by remember { mutableLongStateOf(graph.nowMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = graph.nowMillis() } }
    DisposableEffect(connection) {
        connection.sessions.start()
        onDispose { }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (searching) {
                        TextField(
                            value = query,
                            onValueChange = { query = it },
                            placeholder = { Text("Поиск по сессиям") },
                            singleLine = true,
                            colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        Column {
                            Text("Сессии")
                            val summary = buildList {
                                if (state.waitingCount > 0) add("ждут: ${state.waitingCount}")
                                if (state.workingCount > 0) add("работают: ${state.workingCount}")
                            }.joinToString(" · ")
                            if (summary.isNotEmpty()) Text(summary, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { searching = !searching; if (!searching) query = "" }) {
                        Icon(if (searching) AppIcons.Close else AppIcons.Search, "Поиск")
                    }
                    IconButton(onClick = onSettings) { Icon(AppIcons.Settings, "Настройки") }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { creating = true },
                icon = { Icon(AppIcons.Add, null) },
                text = { Text("Новая сессия") },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            val error = state.error
            if (error != null) {
                val since = state.updatedAtMillis?.let { " · данные на ${graph.platform.formatClock(it)}" }.orEmpty()
                Banner(
                    text = if (error is ApiError.Unreachable) "Нет связи с компьютером$since" else describe(error),
                    icon = AppIcons.Offline,
                    color = MaterialTheme.colorScheme.error,
                    action = "Повторить",
                    onAction = { connection.sessions.refresh() },
                )
            }
            state.info?.pi?.takeIf { !it.supported }?.let { pi ->
                Banner(
                    text = "Pi ${pi.version ?: "не найден"}: версия не проверялась с TaskBridge (${pi.supportedRange.orEmpty()})",
                    icon = AppIcons.Alert,
                    color = LocalStatusColors.current.waiting,
                )
            }
            PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = { connection.sessions.refresh() },
                modifier = Modifier.fillMaxSize(),
            ) {
                val groups = state.groups(query)
                when {
                    state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    groups.isEmpty() && query.isNotBlank() -> EmptyState(AppIcons.Search, "Ничего не найдено", "Попробуйте другое слово.")
                    groups.isEmpty() -> EmptyState(
                        AppIcons.Chat,
                        "Пока ни одной сессии",
                        "Поставьте агенту задачу — он будет работать на компьютере, а вы сможете следить отсюда.",
                    )
                    else -> SessionList(
                        groups = groups,
                        selectedTaskId = selectedTaskId,
                        now = now,
                        graph = graph,
                        onOpen = onOpen,
                        onRename = { renaming = it },
                        onDelete = { deleting = it },
                    )
                }
            }
        }
    }

    if (creating) {
        NewSessionSheet(
            graph = graph,
            connection = connection,
            projects = state.projects,
            onDismiss = { creating = false },
            onCreated = { task ->
                creating = false
                onOpen(task.id)
            },
        )
    }

    renaming?.let { task ->
        var title by remember(task.id) { mutableStateOf(task.title ?: task.displayTitle) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Название сессии") },
            text = { OutlinedTextField(title, { title = it }, singleLine = true, modifier = Modifier.fillMaxWidth()) },
            confirmButton = {
                TextButton(onClick = {
                    renaming = null
                    scope.launch {
                        connection.sessions.rename(task.id, title).onFailure { snackbar.showSnackbar(messageOf(it)) }
                    }
                }) { Text("Сохранить") }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Отмена") } },
        )
    }

    deleting?.let { task ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Удалить сессию?") },
            text = { Text("«${task.displayTitle}» и вся её история будут удалены на компьютере. Это нельзя отменить.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    scope.launch {
                        connection.sessions.delete(task.id).onFailure { snackbar.showSnackbar(messageOf(it)) }
                        connection.closeChat(task.id)
                    }
                }) { Text("Удалить", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Отмена") } },
        )
    }
}

internal fun messageOf(error: Throwable): String = (error as? ApiException)?.let { describe(it.error) } ?: (error.message ?: "Ошибка")

@Composable
private fun SessionList(
    groups: List<SessionGroup>,
    selectedTaskId: String?,
    now: Long,
    graph: AppGraph,
    onOpen: (String) -> Unit,
    onRename: (Task) -> Unit,
    onDelete: (Task) -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
        for (group in groups) {
            stickyHeader(key = "header:${group.projectId}") {
                Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(AppIcons.Folder, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(group.title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.width(6.dp))
                        Text("${group.sessions.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            items(group.sessions, key = { it.id }) { task ->
                SessionRow(
                    task = task,
                    selected = task.id == selectedTaskId,
                    now = now,
                    graph = graph,
                    onClick = { onOpen(task.id) },
                    onRename = { onRename(task) },
                    onDelete = { onDelete(task) },
                )
            }
        }
    }
}

@Composable
private fun SessionRow(
    task: Task,
    selected: Boolean,
    now: Long,
    graph: AppGraph,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    val state = displayStateOf(task)
    var menu by remember { mutableStateOf(false) }
    val background = when {
        selected -> MaterialTheme.colorScheme.secondaryContainer
        state == DisplayState.WAITING_USER -> LocalStatusColors.current.waiting.copy(alpha = 0.08f)
        else -> Color.Transparent
    }
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 2.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(background)
                .combinedClickable(onClick = onClick, onLongClick = { menu = true })
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            StatusDot(state, Modifier.padding(top = 6.dp))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        task.displayTitle,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = if (state.active) FontWeight.SemiBold else FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        relativeTime(graph.platform, task.updatedAt, now),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                val activity = activityOf(task)
                if (!activity.isNullOrBlank()) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        activity,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (state == DisplayState.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (state != DisplayState.DONE) StatusPill(state)
                    task.model?.label?.takeIf { it != "—" }?.let { model ->
                        Text(model, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (task.pendingPrompts.isNotEmpty()) {
                        Text("· в очереди ${task.pendingPrompts.size}", style = MaterialTheme.typography.labelSmall, color = LocalStatusColors.current.queued)
                    }
                }
            }
            IconButton(onClick = { menu = true }, modifier = Modifier.size(32.dp)) {
                Icon(AppIcons.More, "Действия", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("Переименовать") }, leadingIcon = { Icon(AppIcons.Edit, null) }, onClick = { menu = false; onRename() })
            DropdownMenuItem(
                text = { Text("Удалить", color = MaterialTheme.colorScheme.error) },
                leadingIcon = { Icon(AppIcons.Delete, null, tint = MaterialTheme.colorScheme.error) },
                onClick = { menu = false; onDelete() },
            )
        }
    }
}
