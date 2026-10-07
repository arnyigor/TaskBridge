package ru.arny.taskbridge.ui.sessions

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import ru.arny.taskbridge.ui.SessionDraft
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.PiInfo
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.client.session.describe
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.core.client.sessions.SessionGroup
import ru.arny.taskbridge.core.client.sessions.activityOf
import ru.arny.taskbridge.core.client.sessions.displayStateOf
import ru.arny.taskbridge.ui.common.AppSnackbarHost
import ru.arny.taskbridge.ui.common.Banner
import ru.arny.taskbridge.ui.common.EmptyState
import ru.arny.taskbridge.ui.common.StatusDot
import ru.arny.taskbridge.ui.common.StatusPill
import ru.arny.taskbridge.ui.common.formatBytes
import ru.arny.taskbridge.ui.common.parseIsoMillis
import ru.arny.taskbridge.ui.common.relativeTime
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors

@Composable
fun SessionsScreen(
    graph: AppGraph,
    connection: AppGraph.Connected,
    selectedTaskId: String?,
    onOpen: (String) -> Unit,
    onDraft: (SessionDraft) -> Unit,
    onSettings: () -> Unit,
) {
    val state by connection.sessions.state.collectAsState()
    // Sessions that alerted while the operator was looking elsewhere: their rows pulse
    // until the chat is opened, instead of the screen jumping to them.
    val attention by connection.attention.collectAsState()
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var creatingIn by remember { mutableStateOf<String?>(null) }
    var clearing by remember { mutableStateOf<SessionGroup?>(null) }
    var renaming by remember { mutableStateOf<Task?>(null) }
    var deleting by remember { mutableStateOf<Task?>(null) }
    var selecting by remember { mutableStateOf(false) }
    var selectedIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var deletingSelected by remember { mutableStateOf<Set<String>?>(null) }
    var selectingOlder by remember { mutableStateOf(false) }
    var confirmRestart by remember { mutableStateOf(false) }
    var restarting by remember { mutableStateOf(false) }
    // Relative times ("5 мин") move on their own.
    var now by remember { mutableLongStateOf(graph.nowMillis()) }
    val groups = state.groups(query)
    val activeTasks = state.sorted.filter { displayStateOf(it).active }
    val visibleTasks = groups.flatMap { it.sessions }
    val visibleIds = visibleTasks.mapTo(mutableSetOf()) { it.id }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = graph.nowMillis() } }
    DisposableEffect(connection) {
        connection.sessions.start()
        onDispose { }
    }
    LaunchedEffect(visibleIds) {
        selectedIds = selectedIds.filterTo(mutableSetOf()) { it in visibleIds }
        if (selecting && selectedIds.isEmpty()) selecting = false
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    when {
                        selecting -> Text("Выбрано: ${selectedIds.size}")
                        searching -> TextField(
                            value = query,
                            onValueChange = { query = it },
                            placeholder = { Text("Поиск по сессиям") },
                            singleLine = true,
                            colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        else -> Column {
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
                    if (selecting) {
                        IconButton(onClick = { selectedIds = visibleIds; if (selectedIds.isNotEmpty()) selecting = true }, enabled = visibleIds.isNotEmpty()) {
                            Icon(AppIcons.Check, "Выбрать все видимые")
                        }
                        IconButton(onClick = { selectingOlder = true }, enabled = visibleTasks.isNotEmpty()) {
                            Icon(AppIcons.Clock, "Выбрать старые")
                        }
                        IconButton(onClick = { deletingSelected = selectedIds }, enabled = selectedIds.isNotEmpty()) {
                            Icon(AppIcons.Delete, "Удалить выбранные", tint = if (selectedIds.isNotEmpty()) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        IconButton(onClick = { selecting = false; selectedIds = emptySet() }) {
                            Icon(AppIcons.Close, "Выйти из выбора")
                        }
                    } else {
                        IconButton(onClick = { searching = !searching; if (!searching) query = "" }) {
                            Icon(if (searching) AppIcons.Close else AppIcons.Search, "Поиск")
                        }
                        IconButton(onClick = { selecting = true }) {
                            Icon(AppIcons.Check, "Выбрать сессии")
                        }
                        // One tap flips what is on screen now; "как в системе" stays in Settings.
                        val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
                        IconButton(onClick = { graph.changeTheme(if (dark) "light" else "dark") }) {
                            Icon(if (dark) AppIcons.Sun else AppIcons.Moon, if (dark) "Светлая тема" else "Тёмная тема")
                        }
                        // Restarts the TaskBridge process, as the web header does: the way out of a stuck state.
                        IconButton(onClick = { confirmRestart = true }, enabled = !restarting) { Icon(AppIcons.Refresh, "Перезапустить сервер") }
                        IconButton(onClick = onSettings) { Icon(AppIcons.Settings, "Настройки") }
                    }
                },
            )
        },
        floatingActionButton = {
            if (!selecting) {
                ExtendedFloatingActionButton(
                    onClick = { creatingIn = null; creating = true },
                    icon = { Icon(AppIcons.Add, null) },
                    text = { Text("Новая сессия") },
                )
            }
        },
        snackbarHost = { AppSnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (restarting) {
                Banner(
                    text = "Перезапуск сервера… сессии переподключатся сами",
                    icon = AppIcons.Refresh,
                    color = LocalStatusColors.current.working,
                )
            }
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
            piVersionBanner(state.info?.pi)?.let { text ->
                Banner(
                    text = text,
                    icon = AppIcons.Alert,
                    color = LocalStatusColors.current.waiting,
                )
            }
            RefreshContainer(pull = graph.platform.kind != "desktop", refreshing = state.refreshing, onRefresh = { connection.sessions.refresh() }) {
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
                        activeTasks = activeTasks,
                        searching = query.isNotBlank(),
                        selectedTaskId = selectedTaskId,
                        now = now,
                        graph = graph,
                        attention = attention,
                        onOpen = onOpen,
                        selecting = selecting,
                        selectedIds = selectedIds,
                        onToggleSelected = { task ->
                            selecting = true
                            selectedIds = if (task.id in selectedIds) selectedIds - task.id else selectedIds + task.id
                        },
                        onRename = { renaming = it },
                        onDelete = { deleting = it },
                        onNewIn = { projectId -> creatingIn = projectId; creating = true },
                        onClearFinished = { clearing = it },
                        onSelectGroup = { group -> selecting = true; selectedIds = group.sessions.mapTo(mutableSetOf()) { it.id } },
                        onSelectFinished = { group -> selecting = true; selectedIds = group.sessions.filter(::finished).mapTo(mutableSetOf()) { it.id } },
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
            initialProjectId = creatingIn,
            onDismiss = { creating = false },
            onDraft = { draft ->
                creating = false
                onDraft(draft)
            },
            onCreated = { task ->
                creating = false
                onOpen(task.id)
            },
            // Импорт сессии Pi из выбранной папки: список обновляем, чтобы новая
            // задача встала на своё место в списке сессий.
            onImported = { task ->
                creating = false
                scope.launch { connection.sessions.refresh() }
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

    if (confirmRestart) {
        // Недоступный сервер меняет смысл кнопки: перезапускать нечего —
        // desktop-приложение запустит его само, скрытым процессом без консоли.
        val wasOnline = connection.online.value
        AlertDialog(
            onDismissRequest = { confirmRestart = false },
            title = { Text(if (wasOnline) "Перезапустить сервер TaskBridge?" else "Запустить сервер TaskBridge?") },
            text = { Text(
                when {
                    wasOnline -> "Активные сессии будут прерваны. Приложение переподключится само через несколько секунд."
                    // Обещать скрытый запуск можно только когда это правда: на Android лаунчера нет,
                    // а на desktop он бесполезен без найденного каталога TaskBridge.
                    connection.sessions.canStartLocalServer() ->
                        "Сервер сейчас недоступен. Он будет запущен на этом компьютере скрытым процессом — без консольного окна."
                    else ->
                        "Сервер сейчас недоступен, а запустить его из приложения нечем: каталог TaskBridge не найден. " +
                            "Укажите его в настройках → «Каталог TaskBridge» или запустите сервер на компьютере вручную."
                }
            ) },
            confirmButton = {
                TextButton(onClick = {
                    confirmRestart = false
                    restarting = true
                    scope.launch {
                        connection.sessions.restartServer()
                            .onSuccess { snackbar.showSnackbar(if (wasOnline) "Сервер перезапущен" else "Сервер запущен") }
                            .onFailure { snackbar.showSnackbar(messageOf(it)) }
                        restarting = false
                    }
                }) {
                    Text(
                        if (wasOnline) "Перезапустить" else "Запустить",
                        color = MaterialTheme.colorScheme.error,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            },
            dismissButton = { TextButton(onClick = { confirmRestart = false }) { Text("Отмена") } },
        )
    }

    clearing?.let { group ->
        val finished = group.sessions.filter { finished(it) }
        AlertDialog(
            onDismissRequest = { clearing = null },
            title = { Text("Удалить завершённые сессии?") },
            text = { Text("В папке «${group.title}» будут удалены сессии, которые не работают и не ждут ответа (${finished.size}), вместе с историей. Это нельзя отменить.") },
            confirmButton = {
                TextButton(onClick = {
                    clearing = null
                    scope.launch {
                        val failed = finished.count { task ->
                            connection.sessions.delete(task.id).also { connection.closeChat(task.id) }.isFailure
                        }
                        snackbar.showSnackbar(if (failed == 0) "Удалено сессий: ${finished.size}" else "Не удалось удалить: $failed из ${finished.size}")
                    }
                }) { Text("Удалить", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { clearing = null }) { Text("Отмена") } },
        )
    }

    if (selectingOlder) {
        var daysText by remember { mutableStateOf("30") }
        val days = daysText.toLongOrNull()?.takeIf { it > 0 }
        AlertDialog(
            onDismissRequest = { selectingOlder = false },
            title = { Text("Выбрать старые сессии") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Будут отмечены видимые сессии, обновлённые раньше указанного числа дней назад.")
                    OutlinedTextField(daysText, { daysText = it.filter(Char::isDigit).take(4) }, label = { Text("Старше, дней") }, singleLine = true)
                }
            },
            confirmButton = {
                TextButton(
                    enabled = days != null,
                    onClick = {
                        val picked = visibleTasks.filter { days != null && olderThanDays(it, days, now) }.mapTo(mutableSetOf()) { it.id }
                        selectedIds = picked
                        selecting = picked.isNotEmpty()
                        selectingOlder = false
                        scope.launch { snackbar.showSnackbar(if (picked.isEmpty()) "Старых сессий не найдено" else "Выбрано сессий: ${picked.size}") }
                    },
                ) { Text("Выбрать") }
            },
            dismissButton = { TextButton(onClick = { selectingOlder = false }) { Text("Отмена") } },
        )
    }

    deletingSelected?.let { ids ->
        AlertDialog(
            onDismissRequest = { deletingSelected = null },
            title = { Text("Удалить выбранные сессии?") },
            text = { Text("Будут удалены выбранные сессии (${ids.size}) вместе с историей. Это нельзя отменить.") },
            confirmButton = {
                TextButton(onClick = {
                    deletingSelected = null
                    selecting = false
                    selectedIds = emptySet()
                    scope.launch {
                        val failed = ids.count { id ->
                            connection.sessions.delete(id).also { connection.closeChat(id) }.isFailure
                        }
                        snackbar.showSnackbar(if (failed == 0) "Удалено сессий: ${ids.size}" else "Не удалось удалить: $failed из ${ids.size}")
                    }
                }) { Text("Удалить", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deletingSelected = null }) { Text("Отмена") } },
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

/** Not running, not waiting for the operator: safe to clear from a folder. */
private fun finished(task: Task): Boolean = !displayStateOf(task).active

private fun olderThanDays(task: Task, days: Long, nowMillis: Long): Boolean {
    val millis = parseIsoMillis(task.updatedAt ?: task.createdAt) ?: return false
    return nowMillis - millis >= days * 24L * 60L * 60L * 1000L
}

internal fun messageOf(error: Throwable): String = (error as? ApiException)?.let { describe(it.error) } ?: (error.message ?: "Ошибка")

/**
 * Текст предупреждения о версии Pi, или null если предупреждать не о чем.
 *
 * Неизвестная версия — не ошибка версии: "/api/info" не смог получить
 * `pi --version` (например, проба совпала с загруженной сборкой). Раньше строка
 * `pi.version ?: "не найден"` рисовала баннер «Pi не найден: версия не
 * проверялась», то есть выдуманную проблему вместо отсутствия данных.
 */
internal fun piVersionBanner(pi: PiInfo?): String? {
    val version = pi?.version ?: return null
    if (pi.supported) return null
    return "Pi $version: версия не проверялась с TaskBridge (${pi.supportedRange.orEmpty()})"
}

/**
 * Открыта ли папка сессий.
 *
 * Клик по заголовку — единственный способ сложить папку, поэтому явный выбор оператора
 * сильнее уведомления: пока непрочитанное уведомление перебивало выбор, папка с ним не
 * закрывалась вовсе — клик менял сохранённое значение, но на экране не происходило ничего
 * (а уведомление снимается только открытием чата, которого в сложенной папке не видно).
 * Роль уведомления в сложенной папке берёт на себя пульсирующий значок в заголовке.
 *
 * @param handExpanded выбор оператора (память экрана или настройки); null — папку не трогали.
 * @param alerted внутри есть уведомление, которое ещё не открывали.
 * @param autoOpen папка открыта бы сама: она одна, либо внутри выбранная или активная сессия.
 */
internal fun folderExpanded(handExpanded: Boolean?, alerted: Boolean, autoOpen: Boolean): Boolean = when {
    handExpanded != null -> handExpanded
    alerted -> true
    else -> autoOpen
}

@Composable
private fun SessionList(
    groups: List<SessionGroup>,
    activeTasks: List<Task>,
    searching: Boolean,
    selectedTaskId: String?,
    now: Long,
    graph: AppGraph,
    attention: Set<String>,
    onOpen: (String) -> Unit,
    selecting: Boolean,
    selectedIds: Set<String>,
    onToggleSelected: (Task) -> Unit,
    onRename: (Task) -> Unit,
    onDelete: (Task) -> Unit,
    onNewIn: (String) -> Unit,
    onClearFinished: (SessionGroup) -> Unit,
    onSelectGroup: (SessionGroup) -> Unit,
    onSelectFinished: (SessionGroup) -> Unit,
) {
    // A folder the user never touched opens itself when something in it needs
    // attention (working, waiting, queued) or is open; a hand toggle is remembered
    // and always wins, so the header tap is never a no-op. An unread alert in a
    // folder that was never touched opens it; in a folded one the header pulses.
    val toggled = remember { mutableStateMapOf<String, Boolean>() }
    fun expanded(group: SessionGroup): Boolean = folderExpanded(
        handExpanded = toggled[group.projectId] ?: graph.settings.folderExpanded(group.projectId),
        alerted = group.sessions.any { it.id in attention },
        autoOpen = groups.size == 1 || group.sessions.any { it.id == selectedTaskId || displayStateOf(it).active },
    )
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
        if (!selecting && activeTasks.isNotEmpty()) {
            item(key = "active-sessions-header") {
                ActiveSessionsHeader(activeTasks.size)
            }
            items(activeTasks, key = { "active:${it.id}" }) { task ->
                ActiveSessionRow(
                    task = task,
                    selected = task.id == selectedTaskId,
                    attention = task.id in attention,
                    now = now,
                    onClick = { onOpen(task.id) },
                )
            }
            item(key = "active-sessions-gap") { Spacer(Modifier.height(6.dp)) }
        }
        for (group in groups) {
            val open = searching || expanded(group)
            stickyHeader(key = "header:${group.projectId}") {
                FolderHeader(
                    group, open,
                    alerted = group.sessions.any { it.id in attention },
                    onToggle = {
                        toggled[group.projectId] = !open
                        graph.settings.setFolderExpanded(group.projectId, !open)
                    },
                    onNewHere = { onNewIn(group.projectId) },
                    onClearFinished = { onClearFinished(group) },
                    onSelectGroup = { onSelectGroup(group) },
                    onSelectFinished = { onSelectFinished(group) },
                )
            }
            if (!open) continue
            items(group.sessions, key = { it.id }) { task ->
                SessionRow(
                    task = task,
                    selected = task.id == selectedTaskId,
                    checked = task.id in selectedIds,
                    selecting = selecting,
                    now = now,
                    graph = graph,
                    attention = task.id in attention,
                    onClick = { if (selecting) onToggleSelected(task) else onOpen(task.id) },
                    onLongClick = { onToggleSelected(task) },
                    onRename = { onRename(task) },
                    onDelete = { onDelete(task) },
                )
            }
        }
    }
}

@Composable
private fun ActiveSessionsHeader(count: Int) {
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(AppIcons.Spark, null, modifier = Modifier.size(16.dp), tint = LocalStatusColors.current.working)
        Spacer(Modifier.width(8.dp))
        Text("Активные сессии", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
        Text("$count", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * How strongly an alerted row is lit right now; 0 for rows without an unseen alert.
 * The pulse is what makes the row noticeable without moving the screen to it.
 */
@Composable
internal fun attentionPulse(attention: Boolean): Float {
    if (!attention) return 0f
    val transition = rememberInfiniteTransition(label = "attention")
    val value by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(durationMillis = 700, easing = LinearEasing), RepeatMode.Reverse),
        label = "attentionPulse",
    )
    return value
}

@Composable
private fun ActiveSessionRow(task: Task, selected: Boolean, attention: Boolean, now: Long, onClick: () -> Unit) {
    val state = displayStateOf(task)
    val accent = MaterialTheme.colorScheme.primary
    val alert = LocalStatusColors.current.waiting
    val pulse = attentionPulse(attention)
    val background = when {
        selected -> MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
        attention -> alert.copy(alpha = 0.10f + 0.25f * pulse)
        else -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(background)
            .drawBehind {
                when {
                    selected -> drawRect(accent, size = Size(3.dp.toPx(), size.height))
                    attention -> drawRect(alert.copy(alpha = 0.35f + 0.65f * pulse), size = Size(3.dp.toPx(), size.height))
                }
            }
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(state)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                task.displayTitle,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = if (selected) MaterialTheme.colorScheme.primary else Color.Unspecified,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            activityOf(task, now)?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(8.dp))
        StatusPill(state)
    }
}

/** A project folder: tap to fold; folded, it still shows what inside needs attention. */
@Composable
private fun FolderHeader(
    group: SessionGroup,
    open: Boolean,
    alerted: Boolean,
    onToggle: () -> Unit,
    onNewHere: () -> Unit,
    onClearFinished: () -> Unit,
    onSelectGroup: () -> Unit,
    onSelectFinished: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val colors = LocalStatusColors.current
    val states = group.sessions.map { displayStateOf(it) }
    val waiting = states.count { it == DisplayState.WAITING_USER }
    val working = states.count { it == DisplayState.WORKING }
    // Сложенную папку с непрочитанным уведомлением видно по пульсирующему значку:
    // строка с новостью скрыта, и без этого знака новость пряталась бы вместе с ней.
    val news = alerted && !open
    val newsPulse = attentionPulse(news)
    // Total on-disk footprint of the folder: the same number the sessions screen shows per row.
    val totalBytes = group.sessions.sumOf { it.sizeBytes ?: 0L }
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .padding(horizontal = 8.dp, vertical = 2.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .combinedClickable(onClick = onToggle, onLongClick = { menu = true })
                .padding(start = 8.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (open) AppIcons.ChevronDown else AppIcons.ChevronRight, if (open) "Свернуть" else "Развернуть", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(6.dp))
            Icon(
                AppIcons.Folder,
                if (news) "Есть непрочитанное уведомление" else null,
                tint = if (news) colors.waiting.copy(alpha = 0.45f + 0.55f * newsPulse) else MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(16.dp),
            )
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
            if (totalBytes > 0) {
                Text(formatBytes(totalBytes), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
            }
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.size(36.dp)) {
                    Icon(AppIcons.More, "Действия с папкой", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Новая сессия здесь") }, leadingIcon = { Icon(AppIcons.Add, null) }, onClick = { menu = false; onNewHere() })
                    DropdownMenuItem(text = { Text("Выбрать все в папке (${group.sessions.size})") }, leadingIcon = { Icon(AppIcons.Check, null) }, onClick = { menu = false; onSelectGroup() })
                    val finishedCount = group.sessions.count { finished(it) }
                    DropdownMenuItem(text = { Text("Выбрать завершённые ($finishedCount)") }, leadingIcon = { Icon(AppIcons.Check, null) }, enabled = finishedCount > 0, onClick = { menu = false; onSelectFinished() })
                    DropdownMenuItem(
                        text = { Text("Удалить завершённые ($finishedCount)", color = if (finishedCount > 0) MaterialTheme.colorScheme.error else Color.Unspecified) },
                        leadingIcon = { Icon(AppIcons.Delete, null, tint = MaterialTheme.colorScheme.error) },
                        enabled = finishedCount > 0,
                        onClick = { menu = false; onClearFinished() },
                    )
                }
            }
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
    checked: Boolean,
    selecting: Boolean,
    now: Long,
    graph: AppGraph,
    attention: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    val state = displayStateOf(task)
    var menu by remember { mutableStateOf(false) }
    val accent = MaterialTheme.colorScheme.primary
    val alert = LocalStatusColors.current.waiting
    val pulse = attentionPulse(attention)
    val background = when {
        checked -> MaterialTheme.colorScheme.primary.copy(alpha = 0.10f)
        selected -> MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
        attention -> alert.copy(alpha = 0.10f + 0.25f * pulse)
        state == DisplayState.WAITING_USER -> alert.copy(alpha = 0.08f)
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
                .drawBehind {
                    when {
                        selected -> drawRect(accent, size = Size(3.dp.toPx(), size.height))
                        attention -> drawRect(alert.copy(alpha = 0.35f + 0.65f * pulse), size = Size(3.dp.toPx(), size.height))
                    }
                }
                .combinedClickable(onClick = onClick, onLongClick = onLongClick)
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            if (selecting) {
                Checkbox(checked = checked, onCheckedChange = { onClick() }, modifier = Modifier.size(24.dp))
                Spacer(Modifier.width(8.dp))
            }
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
                val activity = activityOf(task, now)
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
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (state != DisplayState.DONE) StatusPill(state)
                    task.model?.label?.takeIf { it != "—" }?.let { model ->
                        Text(
                            model,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                    task.sizeBytes?.takeIf { it > 0 }?.let { bytes ->
                        Text(
                            formatBytes(bytes),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                    }
                    if (task.pendingPrompts.isNotEmpty()) {
                        Text(
                            "· в очереди ${task.pendingPrompts.size}",
                            style = MaterialTheme.typography.labelSmall,
                            color = LocalStatusColors.current.queued,
                            maxLines = 1,
                        )
                    }
                }
            }
            if (!selecting) {
                IconButton(onClick = { menu = true }, modifier = Modifier.size(32.dp)) {
                    Icon(AppIcons.More, "Действия", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                }
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
