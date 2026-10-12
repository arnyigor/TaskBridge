package ru.arny.taskbridge.ui.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.ProjectOverview
import ru.arny.taskbridge.core.api.ProjectSummary
import ru.arny.taskbridge.core.client.session.describe
import ru.arny.taskbridge.ui.sessions.messageOf
import ru.arny.taskbridge.ui.common.AppSnackbarHost
import ru.arny.taskbridge.ui.common.Banner
import ru.arny.taskbridge.ui.common.EmptyState
import ru.arny.taskbridge.ui.common.sinceLabel
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors

/**
 * The project dashboard (MR-01): the level between «all sessions» and one chat.
 *
 * Every number here is computed by the server from the project registry and the
 * sessions (`GET /api/projects/overview`), so a card cannot drift from the list
 * the sessions screen shows; only pinned/archived are stored, and both survive a
 * restart of the server. «Работа» (Work Items) appears on this screen with MR-02 —
 * showing a zero now would be a lie.
 */

/** The three sections the dashboard renders, each already filtered by the search box. */
internal data class ProjectSections(
    val pinned: List<ProjectSummary> = emptyList(),
    val active: List<ProjectSummary> = emptyList(),
    val archived: List<ProjectSummary> = emptyList(),
) {
    val total: Int get() = pinned.size + active.size + archived.size
}

internal fun projectSections(projects: List<ProjectSummary>, query: String): ProjectSections {
    val needle = query.trim().lowercase()
    val matching = projects.filter { project ->
        needle.isEmpty() ||
            project.displayName.lowercase().contains(needle) ||
            project.path.orEmpty().lowercase().contains(needle)
    }
    // Archive wins over pin: a project that is both must appear once, in the archive
    // (its pin is kept in the database and comes back when it leaves the archive).
    return ProjectSections(
        pinned = matching.filter { it.pinned && !it.archived },
        active = matching.filter { !it.pinned && !it.archived },
        archived = matching.filter { it.archived },
    )
}

/**
 * The counts under a project's name. A zero is left out: «работают: 0» on every
 * card is noise, and its absence is the same information.
 */
internal fun projectCountsLine(project: ProjectSummary, activity: String? = null): String = listOfNotNull(
    "сессий: ${project.sessions}",
    // MR-02: открытая работа — то самое «Active work» из роадмапа.
    if (project.activeWork > 0) "работа: ${project.activeWork}" else null,
    if (project.working > 0) "работают: ${project.working}" else null,
    if (project.needsAttention > 0) "внимание: ${project.needsAttention}" else null,
    activity?.let { "активность: $it" },
).joinToString(" · ")

/** The line above the cards: what the whole machine is doing. */
internal fun projectTotalsLine(overview: ProjectOverview): String = listOf(
    "проектов: ${overview.totals.projects}",
    "сессий: ${overview.totals.sessions}",
    "работают: ${overview.totals.working}",
    "требуют внимания: ${overview.totals.needsAttention}",
    "работы: ${overview.totals.activeWork}",
).joinToString(" · ")

/** Removing a project from the registry never deletes its sessions; say so. */
internal fun unassignedLine(count: Int): String? = count.takeIf { it > 0 }?.let {
    "Сессий вне реестра: $it — они остались в списке всех сессий."
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectsScreen(
    graph: AppGraph,
    connection: AppGraph.Connected,
    onOpenProject: (String) -> Unit,
    onOpenAllSessions: () -> Unit,
    onSettings: () -> Unit,
) {
    val state by connection.sessions.state.collectAsState()
    val online by connection.online.collectAsState()
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val platform = graph.platform
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var showArchive by remember { mutableStateOf(false) }
    var busyProject by remember { mutableStateOf<String?>(null) }

    val overview = state.overview
    val sections = projectSections(state.dashboardProjects, query)
    val pinned = sections.pinned
    val active = sections.active
    val archived = sections.archived

    fun preferences(project: ProjectSummary, pinned: Boolean? = null, archivedFlag: Boolean? = null) {
        if (busyProject != null) return
        busyProject = project.id
        scope.launch {
            connection.sessions.setProjectPreferences(project.id, pinned, archivedFlag)
                .onFailure { snackbar.showSnackbar(messageOf(it)) }
            busyProject = null
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Проекты") },
                navigationIcon = {
                    IconButton(onClick = onOpenAllSessions) { Icon(AppIcons.Back, "Все сессии") }
                },
                actions = {
                    IconButton(onClick = { searching = !searching; if (!searching) query = "" }) {
                        Icon(AppIcons.Search, "Поиск по проектам")
                    }
                    IconButton(onClick = onSettings) { Icon(AppIcons.Settings, "Настройки") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (!online) {
                Banner(
                    "Устройство offline — показаны последние данные с компьютера",
                    AppIcons.Offline,
                    LocalStatusColors.current.waiting,
                )
            }
            state.error?.let { error ->
                Banner(describe(error), AppIcons.Alert, MaterialTheme.colorScheme.error, action = "Обновить", onAction = { connection.sessions.refresh() })
            }
            if (searching) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text("Название или путь") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
            when {
                state.loading && overview == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                overview != null && state.dashboardProjects.isEmpty() -> EmptyState(
                    AppIcons.Folder,
                    "Проектов пока нет",
                    "Зарегистрируйте папку проекта — и сессии начнут собираться вокруг неё.",
                    action = { TextButton(onClick = onSettings) { Text("Настройки") } },
                )
                overview != null && sections.total == 0 -> EmptyState(AppIcons.Search, "Ничего не найдено", "Измените запрос.")
                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    overview?.let { data ->
                        item(key = "totals") {
                            Text(
                                projectTotalsLine(data),
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        unassignedLine(data.unassignedSessions)?.let { line ->
                            item(key = "unassigned") {
                                Text(line, style = MaterialTheme.typography.labelMedium, color = LocalStatusColors.current.waiting)
                            }
                        }
                    }
                    if (pinned.isNotEmpty()) {
                        item(key = "pinned-header") { SectionHeader("Закреплённые") }
                        items(pinned, key = { "pinned:${it.id}" }) { project ->
                            ProjectRow(project, busy = busyProject == project.id, nowMillis = graph.nowMillis(), platform = platform, onOpen = { onOpenProject(project.id) }, onPin = { preferences(project, pinned = !project.pinned) }, onArchive = { preferences(project, archivedFlag = !project.archived) })
                        }
                    }
                    if (active.isNotEmpty()) {
                        item(key = "projects-header") { SectionHeader(if (pinned.isEmpty()) "Проекты" else "Остальные") }
                        items(active, key = { "project:${it.id}" }) { project ->
                            ProjectRow(project, busy = busyProject == project.id, nowMillis = graph.nowMillis(), platform = platform, onOpen = { onOpenProject(project.id) }, onPin = { preferences(project, pinned = !project.pinned) }, onArchive = { preferences(project, archivedFlag = !project.archived) })
                        }
                    }
                    if (archived.isNotEmpty()) {
                        item(key = "archive-header") {
                            Row(
                                Modifier.fillMaxWidth().clickable { showArchive = !showArchive }.padding(vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("Архив (${archived.size})", style = MaterialTheme.typography.titleSmall)
                                Spacer(Modifier.width(6.dp))
                                Text(if (showArchive) "свернуть" else "показать", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                        if (showArchive) {
                            items(archived, key = { "archived:${it.id}" }) { project ->
                                ProjectRow(project, busy = busyProject == project.id, nowMillis = graph.nowMillis(), platform = platform, onOpen = { onOpenProject(project.id) }, onPin = { preferences(project, pinned = !project.pinned) }, onArchive = { preferences(project, archivedFlag = !project.archived) })
                            }
                        }
                    }
                }
            }
            AppSnackbarHost(snackbar, Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp))
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
}

@Composable
private fun ProjectRow(
    project: ProjectSummary,
    busy: Boolean,
    nowMillis: Long,
    platform: ru.arny.taskbridge.platform.PlatformServices,
    onOpen: () -> Unit,
    onPin: () -> Unit,
    onArchive: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val colors = LocalStatusColors.current
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth().clickable(enabled = !busy) { onOpen() },
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.padding(top = 3.dp).size(9.dp).clip(CircleShape).background(if (project.working > 0) colors.working else colors.done))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(project.displayName, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (project.pinned) {
                        Spacer(Modifier.width(6.dp))
                        Icon(AppIcons.StarFilled, "Закреплён", Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
                    }
                }
                project.path?.takeIf { it.isNotBlank() }?.let { path ->
                    Text(path, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    projectCountsLine(project, sinceLabel(project.lastActivityAt, nowMillis) { platform.formatClock(it) }),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (project.needsAttention > 0) colors.waiting else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (busy) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                Box {
                    IconButton(onClick = { menu = true }) { Icon(AppIcons.More, "Действия с проектом") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text(if (project.pinned) "Открепить" else "Закрепить") },
                            leadingIcon = { Icon(AppIcons.Star, null) },
                            onClick = { menu = false; onPin() },
                        )
                        DropdownMenuItem(
                            text = { Text(if (project.archived) "Вернуть из архива" else "В архив") },
                            leadingIcon = { Icon(AppIcons.Folder, null) },
                            onClick = { menu = false; onArchive() },
                        )
                    }
                }
            }
        }
    }
}
