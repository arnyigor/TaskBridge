package ru.arny.taskbridge.ui.projects

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
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.Invocation
import ru.arny.taskbridge.core.api.RunRecipe
import ru.arny.taskbridge.core.api.Schedule
import ru.arny.taskbridge.core.api.ScheduleSpec
import ru.arny.taskbridge.core.api.WorkItem
import ru.arny.taskbridge.core.client.projects.ProjectWorkspace
import ru.arny.taskbridge.core.client.projects.ProjectWorkspaceState
import ru.arny.taskbridge.ui.common.AppSnackbarHost
import ru.arny.taskbridge.ui.common.Banner
import ru.arny.taskbridge.ui.common.sinceLabel
import ru.arny.taskbridge.ui.sessions.messageOf
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors

internal fun scheduleLabel(spec: ScheduleSpec): String = when (spec.kind) {
    "daily" -> spec.at?.let { "Каждый день в $it" } ?: "Ежедневно"
    "weekly" -> listOfNotNull(
        spec.weekday?.let(::weekdayLabel),
        spec.at?.let { "в $it" },
    ).joinToString(" ").ifBlank { "Еженедельно" }
    "interval" -> spec.everyMinutes?.let { minutes ->
        when {
            minutes % (24 * 60) == 0 -> "Каждые ${minutes / (24 * 60)} дн."
            minutes % 60 == 0 -> "Каждые ${minutes / 60} ч."
            else -> "Каждые $minutes мин."
        }
    } ?: "По интервалу"
    else -> spec.kind
}

private fun weekdayLabel(value: String): String = when (value.lowercase()) {
    "mon" -> "Пн"
    "tue" -> "Вт"
    "wed" -> "Ср"
    "thu" -> "Чт"
    "fri" -> "Пт"
    "sat" -> "Сб"
    "sun" -> "Вс"
    else -> value
}

internal fun invocationLabel(invocation: Invocation?): String? = invocation?.let {
    when (it.status) {
        "RUNNING" -> "Последний запуск выполняется"
        "SUCCEEDED" -> "Последний запуск завершён"
        "FAILED" -> "Последний запуск: ошибка"
        "SKIPPED" -> "Последний запуск пропущен"
        else -> "Последний запуск: ${it.status}"
    }
}

internal fun workItemStatusLabel(status: String): String = when (status) {
    "BACKLOG" -> "Бэклог"
    "READY" -> "Готово к работе"
    "IN_PROGRESS" -> "В работе"
    "BLOCKED" -> "Заблокировано"
    "DONE" -> "Готово"
    "CANCELLED" -> "Отменено"
    else -> status
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectWorkspaceScreen(
    graph: AppGraph,
    connection: AppGraph.Connected,
    projectId: String,
    onBack: () -> Unit,
    onOpenSessions: () -> Unit,
    onOpenSession: (String) -> Unit,
) {
    val controller = remember(connection, projectId) { ProjectWorkspace(connection.api, projectId, connection.scope) }
    val state by controller.state.collectAsState()
    val sessions by connection.sessions.state.collectAsState()
    val online by connection.online.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val projectName = sessions.dashboardProjects.firstOrNull { it.id == projectId }?.displayName
        ?: sessions.projects.firstOrNull { it.id == projectId }?.displayName
        ?: projectId

    LaunchedEffect(controller) { controller.start() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(projectName, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("Проект", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад к проектам") } },
                actions = {
                    IconButton(onClick = controller::refresh, enabled = !state.refreshing) { Icon(AppIcons.Refresh, "Обновить проект") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (!online) Banner("Устройство offline — показаны последние загруженные данные", AppIcons.Offline, LocalStatusColors.current.waiting)
            state.error?.let { Banner(it, AppIcons.Alert, MaterialTheme.colorScheme.error, action = "Повторить", onAction = controller::refresh) }
            when {
                state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                else -> ProjectWorkspaceContent(
                    state = state,
                    nowMillis = graph.nowMillis(),
                    formatClock = graph.platform::formatClock,
                    onOpenSessions = onOpenSessions,
                    onRun = { recipe ->
                        scope.launch {
                            controller.runNow(recipe.id)
                                .onSuccess(onOpenSession)
                                .onFailure { snackbar.showSnackbar(messageOf(it)) }
                        }
                    },
                    onToggleSchedule = { schedule ->
                        scope.launch {
                            controller.setScheduleEnabled(schedule.id, !schedule.enabled)
                                .onFailure { snackbar.showSnackbar(messageOf(it)) }
                        }
                    },
                )
            }
            AppSnackbarHost(snackbar, Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp))
        }
    }
}

@Composable
private fun ProjectWorkspaceContent(
    state: ProjectWorkspaceState,
    nowMillis: Long,
    formatClock: (Long) -> String,
    onOpenSessions: () -> Unit,
    onRun: (RunRecipe) -> Unit,
    onToggleSchedule: (Schedule) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item(key = "sessions") {
            Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f), shape = RoundedCornerShape(14.dp)) {
                Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(AppIcons.Chat, null, Modifier.size(20.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Сессии проекта", style = MaterialTheme.typography.titleSmall)
                        Text("История работы агентов и новые сессии", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = onOpenSessions) { Text("Открыть") }
                }
            }
        }

        item(key = "work-header") { WorkspaceSectionHeader("Работа", state.openWorkItems.size) }
        if (state.openWorkItems.isEmpty()) {
            item(key = "work-empty") { QuietEmpty("Открытых Work Items нет") }
        } else {
            items(state.openWorkItems, key = { "work:${it.id}" }) { WorkItemCard(it) }
        }

        item(key = "recurring-header") { WorkspaceSectionHeader("Периодическая работа", state.recipes.size) }
        if (state.recipes.isEmpty()) {
            item(key = "recurring-empty") { QuietEmpty("Run Recipes пока нет. Создать и настроить их можно через API; редактор появится следующим этапом.") }
        } else {
            items(state.recipes, key = { "recipe:${it.id}" }) { recipe ->
                RecurringCard(
                    recipe = recipe,
                    schedules = state.schedulesFor(recipe.id),
                    latest = state.latestInvocation(recipe.id),
                    busy = recipe.id in state.busyIds || state.schedulesFor(recipe.id).any { it.id in state.busyIds },
                    nowMillis = nowMillis,
                    formatClock = formatClock,
                    onRun = { onRun(recipe) },
                    onToggleSchedule = onToggleSchedule,
                )
            }
        }
    }
}

@Composable
private fun WorkspaceSectionHeader(title: String, count: Int) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.width(8.dp))
        Text(count.toString(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun WorkItemCard(item: WorkItem) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f), shape = RoundedCornerShape(12.dp)) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(item.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Text(workItemStatusLabel(item.status), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            }
            item.goal?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            if (item.acceptanceCriteria.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Text("Критерии: ${item.acceptanceCriteria.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun RecurringCard(
    recipe: RunRecipe,
    schedules: List<Schedule>,
    latest: Invocation?,
    busy: Boolean,
    nowMillis: Long,
    formatClock: (Long) -> String,
    onRun: () -> Unit,
    onToggleSchedule: (Schedule) -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f), shape = RoundedCornerShape(12.dp)) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(AppIcons.Refresh, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(recipe.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            }
            Spacer(Modifier.height(4.dp))
            Text(
                listOfNotNull(recipe.runtime.id, recipe.runtime.model).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val last = invocationLabel(latest)
            val lastAt = latest?.finishedAt ?: latest?.startedAt ?: latest?.scheduledAt
            if (last != null) {
                Spacer(Modifier.height(3.dp))
                Text(
                    last + sinceLabel(lastAt, nowMillis, formatClock)?.let { " · $it" }.orEmpty(),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (latest?.status == "FAILED") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            for (schedule in schedules) {
                Spacer(Modifier.height(6.dp))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            scheduleLabel(schedule.spec) + if (schedule.enabled) "" else " · на паузе",
                            style = MaterialTheme.typography.labelMedium,
                        )
                        schedule.nextRunAt?.let { next ->
                            Text(
                                "Следующий: ${sinceLabel(next, nowMillis, formatClock) ?: next}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    TextButton(onClick = { onToggleSchedule(schedule) }, enabled = !busy) {
                        Text(if (schedule.enabled) "Пауза" else "Включить")
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            Button(onClick = onRun, enabled = !busy) { Text("Запустить") }
        }
    }
}

@Composable
private fun QuietEmpty(text: String) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.2f), shape = RoundedCornerShape(12.dp)) {
        Text(text, modifier = Modifier.fillMaxWidth().padding(14.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
