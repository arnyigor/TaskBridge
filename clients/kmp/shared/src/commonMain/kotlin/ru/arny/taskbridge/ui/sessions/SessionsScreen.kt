package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
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
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
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
                    // One tap flips what is on screen now; "как в системе" stays in Settings.
                    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
                    IconButton(onClick = { graph.changeTheme(if (dark) "light" else "dark") }) {
                        Icon(if (dark) AppIcons.Sun else AppIcons.Moon, if (dark) "Светлая тема" else "Тёмная тема")
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
            RefreshContainer(pull = graph.platform.kind != "desktop", refreshing = state.refreshing, onRefresh = { connection.sessions.refresh() }) {
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
                        searching = query.isNotBlank(),
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
    searching: Boolean,
    selectedTaskId: String?,
    now: Long,
    graph: AppGraph,
    onOpen: (String) -> Unit,
    onRename: (Task) -> Unit,
    onDelete: (Task) -> Unit,
) {
    // A folder the user never touched opens itself when something in it needs
    // attention (working, waiting, queued) or is open; a hand toggle is remembered.
    val toggled = remember { mutableStateMapOf<String, Boolean>() }
    fun expanded(group: SessionGroup): Boolean =
        toggled[group.projectId] ?: graph.settings.folderExpanded(group.projectId)
            ?: (groups.size == 1 || group.sessions.any { it.id == selectedTaskId || displayStateOf(it).active })
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
        for (group in groups) {
            val open = searching || expanded(group)
            stickyHeader(key = "header:${group.projectId}") {
                FolderHeader(group, open, onToggle = {
                    toggled[group.projectId] = !open
                    graph.settings.setFolderExpanded(group.projectId, !open)
                })
            }
            if (!open) continue
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

/** A project folder: tap to fold; folded, it still shows what inside needs attention. */
@Composable
private fun FolderHeader(group: SessionGroup, open: Boolean, onToggle: () -> Unit) {
    val colors = LocalStatusColors.current
    val states = group.sessions.map { displayStateOf(it) }
    val waiting = states.count { it == DisplayState.WAITING_USER }
    val working = states.count { it == DisplayState.WORKING }
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .padding(horizontal = 8.dp, vertical = 2.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .clickable(onClick = onToggle)
                .padding(start = 8.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (open) AppIcons.ChevronDown else AppIcons.ChevronRight, if (open) "Свернуть" else "Развернуть", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(6.dp))
            Icon(AppIcons.Folder, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                group.title,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.weight(1f))
            if (working > 0) FolderCount(working, colors.working)
            if (waiting > 0) FolderCount(waiting, colors.waiting)
            Text("${group.sessions.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

@Composable
private fun FolderCount(count: Int, color: Color) {
    Row(
        Modifier.padding(start = 6.dp).clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.14f)).padding(horizontal = 7.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(6.dp).clip(RoundedCornerShape(50)).background(color))
        Spacer(Modifier.width(4.dp))
        Text("$count", style = MaterialTheme.typography.labelSmall, color = color)
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
    val accent = MaterialTheme.colorScheme.primary
    val background = when {
        selected -> MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
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
                // The open session: an accent bar on the left edge, readable in both themes.
                .drawBehind { if (selected) drawRect(accent, size = Size(3.dp.toPx(), size.height)) }
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
                        fontWeight = if (state.active || selected) FontWeight.SemiBold else FontWeight.Medium,
                        color = if (selected) MaterialTheme.colorScheme.primary else Color.Unspecified,
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

/** Pull to refresh is a touch gesture: on desktop the mouse wheel at the top kept firing it, and the list polls anyway. */
@Composable
private fun RefreshContainer(pull: Boolean, refreshing: Boolean, onRefresh: () -> Unit, content: @Composable BoxScope.() -> Unit) {
    if (pull) PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = Modifier.fillMaxSize(), content = content)
    else Box(Modifier.fillMaxSize(), content = content)
}
