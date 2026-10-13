package ru.arny.taskbridge.ui.processes

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.GpuProcessEntry
import ru.arny.taskbridge.core.api.ProcessEntry
import ru.arny.taskbridge.core.api.ResourceSnapshot
import ru.arny.taskbridge.ui.common.Banner
import ru.arny.taskbridge.ui.theme.AppIcons
import kotlin.math.roundToLong
import kotlin.time.Clock
import kotlin.time.ExperimentalTime

private val NODE_NAMES = setOf("node", "nodejs")
private val PYTHON_NAMES = setOf("python", "python3", "py")
private val JAVA_NAMES = setOf("java", "javaw", "javac", "jshell")

/** Фильтры списка: все, только GPU-процессы или одна runtime-группа. */
private enum class ProcessFilter(val label: String) {
    ALL("Все"), GPU("GPU"), NODE("Node"), PYTHON("Python"), JAVA("Java"),
}

private fun processBaseName(entry: ProcessEntry): String =
    (entry.name ?: entry.commandLine?.trim()?.split("\\s+".toRegex())?.firstOrNull()?.substringAfterLast('/') ?: "")
        .lowercase().removeSuffix(".exe")

private fun matchesRuntime(entry: ProcessEntry, names: Set<String>): Boolean = processBaseName(entry) in names

/**
 * Экран «Ресурсы и очистка» (бывший «Процессы машины»): RAM/GPU-агрегат из
 * /api/system/resources, компактный виртуализированный список процессов
 * (LazyColumn — обязательно при 300–500+ процессах), поиск, фильтры,
 * мультивыбор и групповые действия. Сервер сам отказывается убивать защищённые
 * процессы и дерево TaskBridge; его refusal показывается как есть.
 */
@Composable
fun ProcessesScreen(connection: AppGraph.Connected, onBack: () -> Unit) {
    var processes by remember { mutableStateOf<List<ProcessEntry>?>(null) }
    var resources by remember { mutableStateOf<ResourceSnapshot?>(null) }
    var gpuProcesses by remember { mutableStateOf<List<GpuProcessEntry>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var resultNote by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var pendingKill by remember { mutableStateOf<ProcessEntry?>(null) }
    var pendingGroup by remember { mutableStateOf<String?>(null) }
    var pendingBatch by remember { mutableStateOf<Boolean>(false) }
    var killingPid by remember { mutableStateOf<Long?>(null) }
    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf(ProcessFilter.ALL) }
    var selected by remember { mutableStateOf<Set<Long>>(emptySet()) }
    var expandedPid by remember { mutableStateOf<Long?>(null) }
    val scope = rememberCoroutineScope()

    fun refresh(fresh: Boolean) {
        scope.launch {
            refreshing = true
            runCatching { connection.api.processes(fresh) }
                .onSuccess { processes = it; error = null }
                .onFailure { error = it.message ?: "Не удалось получить список процессов" }
            runCatching { connection.api.systemResources() }.onSuccess { resources = it }
            runCatching { connection.api.gpuProcesses() }.onSuccess { gpuProcesses = it }
            refreshing = false
        }
    }

    LaunchedEffect(Unit) { refresh(false) }
    // Живой список: без опроса после kill пришлось бы жать «Обновить» руками.
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(10_000)
            runCatching { connection.api.processes() }.onSuccess { processes = it }
        }
    }

    val gpuPids = gpuProcesses?.map { it.pid }?.toSet()
    val list = processes
    val visible = remember(list, query, filter, gpuPids) {
        val base = list.orEmpty()
            .filter { entry ->
                when (filter) {
                    ProcessFilter.ALL -> true
                    ProcessFilter.GPU -> gpuPids?.contains(entry.pid) == true
                    ProcessFilter.NODE -> matchesRuntime(entry, NODE_NAMES)
                    ProcessFilter.PYTHON -> matchesRuntime(entry, PYTHON_NAMES)
                    ProcessFilter.JAVA -> matchesRuntime(entry, JAVA_NAMES)
                }
            }
            .let { if (query.isBlank()) it else it.filter { entry ->
                (entry.name ?: "").contains(query, ignoreCase = true) ||
                    (entry.commandLine ?: "").contains(query, ignoreCase = true) ||
                    entry.pid.toString() == query.trim()
            } }
        sortedProcesses(base)
    }
    val selectedEntries = visible.filter { it.pid in selected }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад") } },
                title = { Text("Ресурсы и очистка") },
                actions = {
                    IconButton(onClick = { refresh(true) }, enabled = !refreshing) {
                        if (refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(AppIcons.Refresh, "Обновить")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            Column(Modifier.widthIn(max = 720.dp).fillMaxSize().padding(horizontal = 16.dp)) {
                error?.let { Banner(it, AppIcons.Alert, MaterialTheme.colorScheme.error) }
                resultNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                ResourceOverview(resources)
                FlowRow2 {
                    OutlinedButton(onClick = { pendingGroup = "node" }) { Text("Завершить все Node") }
                    OutlinedButton(onClick = { pendingGroup = "python" }) { Text("Завершить все Python") }
                    OutlinedButton(onClick = { pendingGroup = "java" }) { Text("Завершить все Java") }
                }
                if (selected.isNotEmpty()) {
                    Text(
                        "Выбрано: ${selected.size}" + if (selectedEntries.size < selected.size) " (в фильтре видно ${selectedEntries.size})" else "",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 4.dp),
                    )
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    singleLine = true,
                    placeholder = { Text("Поиск по имени, команде, pid…") },
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                )
                FlowRow2(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (candidate in ProcessFilter.entries) {
                        FilterChip(
                            selected = filter == candidate,
                            onClick = { filter = candidate },
                            label = { Text(candidate.label) },
                        )
                    }
                }
                when {
                    list == null && error == null -> Text("Загрузка…", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
                    list != null && list.isEmpty() -> Text("ОС не вернула ни одного процесса.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
                    list != null -> LazyColumn(Modifier.fillMaxSize().padding(top = 4.dp)) {
                        item(key = "selection-actions") {
                            if (selectedEntries.isNotEmpty()) {
                                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.End) {
                                    OutlinedButton(onClick = { pendingBatch = true }, enabled = killingPid == null) {
                                        Text("Остановить выбранные (${selectedEntries.size})", color = MaterialTheme.colorScheme.error)
                                    }
                                    TextButton(onClick = { selected = emptySet() }) { Text("Снять") }
                                }
                            }
                        }
                        items(visible, key = { it.pid }) { entry ->
                            ProcessRow(
                                entry = entry,
                                expanded = expandedPid == entry.pid,
                                selected = entry.pid in selected,
                                killing = killingPid == entry.pid,
                                onClick = { expandedPid = if (expandedPid == entry.pid) null else entry.pid },
                                onToggleSelect = {
                                    selected = if (entry.pid in selected) selected - entry.pid else selected + entry.pid
                                },
                                onKill = { pendingKill = entry },
                            )
                        }
                    }
                }
            }
        }
    }

    pendingGroup?.let { runtime ->
        val runtimeLabel = processRuntimeLabel(runtime)
        AlertDialog(
            onDismissRequest = { pendingGroup = null },
            title = { Text("Освободить ресурсы: $runtimeLabel?") },
            text = { Text("Будут принудительно завершены все видимые процессы $runtimeLabel, кроме защищённых процессов TaskBridge и системы (включая их потомков).") },
            confirmButton = { TextButton(onClick = {
                pendingGroup = null
                scope.launch { runCatching { connection.api.killProcessGroup(runtime) }.onFailure { error = it.message }; refresh(true) }
            }) { Text("Завершить", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { pendingGroup = null }) { Text("Отмена") } },
        )
    }

    if (pendingBatch) {
        AlertDialog(
            onDismissRequest = { pendingBatch = false },
            title = { Text("Остановить ${selectedEntries.size} процессов?") },
            text = { Text("Каждый выбранный процесс будет завершён принудительно вместе с потомками. Сервер пропустит защищённые и сообщит об отказах по каждому процессу.") },
            confirmButton = {
                TextButton(onClick = {
                    pendingBatch = false
                    val targets = selectedEntries.toList()
                    scope.launch {
                        var stopped = 0
                        val failures = mutableListOf<String>()
                        for (target in targets) {
                            killingPid = target.pid
                            runCatching { connection.api.killProcess(target.pid, target.name ?: "") }
                                .onSuccess { stopped++; selected = selected - target.pid }
                                .onFailure { failures.add("${target.name ?: target.pid}: ${it.message}") }
                        }
                        killingPid = null
                        resultNote = "Остановлено: $stopped" + if (failures.isEmpty()) "" else " · отказов: ${failures.size} — ${failures.take(3).joinToString("; ")}"
                        refresh(true)
                    }
                }) { Text("Остановить", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { pendingBatch = false }) { Text("Отмена") } },
        )
    }

    pendingKill?.let { victim ->
        AlertDialog(
            onDismissRequest = { pendingKill = null },
            title = { Text("Остановить ${victim.name ?: "процесс ${victim.pid}"}?") },
            text = {
                Text(
                    "Процесс и его дочерние будут завершены принудительно (taskkill /T /F). " +
                        "Несохранённая работа в них будет потеряна.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val target = victim
                    pendingKill = null
                    killingPid = target.pid
                    scope.launch {
                        runCatching { connection.api.killProcess(target.pid, target.name ?: "") }
                            .onSuccess { error = null }
                            .onFailure { error = it.message ?: "Не удалось остановить процесс" }
                        killingPid = null
                        refresh(true)
                    }
                }) { Text("Остановить", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { pendingKill = null }) { Text("Отмена") } },
        )
    }
}

/** Верхний блок: RAM из ОС и GPU-агрегат nvidia-smi; null-поля — «неизвестно», не 0. */
@Composable
private fun ResourceOverview(snapshot: ResourceSnapshot?) {
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        val ram = snapshot?.ram
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("RAM", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(
                ram?.let {
                    val used = it.usedBytes; val total = it.totalBytes; val free = it.freeBytes
                    "${processMemoryLabel(used)} / ${processMemoryLabel(total)} · доступно ${processMemoryLabel(free)}"
                } ?: "неизвестно",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        val gpu = snapshot?.gpu
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("GPU", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(
                when {
                    gpu == null -> "nvidia-smi недоступен"
                    gpu.gpus.isEmpty() -> "GPU не найдены"
                    else -> gpu.gpus.joinToString(" · ") { card ->
                        "${card.name ?: "GPU"}: ${processMemoryLabel(card.vramUsedMb?.times(1024 * 1024))} / " +
                            "${processMemoryLabel(card.vramTotalMb?.times(1024 * 1024))}" +
                            (card.utilizationPercent?.let { " · $it%" } ?: "")
                    }
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun FlowRow2(horizontalArrangement: Arrangement.Horizontal = Arrangement.spacedBy(8.dp), content: @Composable () -> Unit) {
    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = horizontalArrangement) { content() }
}

/**
 * Компактная строка процесса: чекбокс выбора, имя, память, pid; по нажатию —
 * раскрываются подробности (командная строка, родитель, время старта).
 */
@Composable
private fun ProcessRow(
    entry: ProcessEntry,
    expanded: Boolean,
    selected: Boolean,
    killing: Boolean,
    onClick: () -> Unit,
    onToggleSelect: () -> Unit,
    onKill: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 4.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) MaterialTheme.colorScheme.surfaceContainerHigh else MaterialTheme.colorScheme.surfaceContainerLow)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = selected, onCheckedChange = { onToggleSelect() }, modifier = Modifier.size(32.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    entry.name ?: "(без имени)",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (expanded) {
                    Text(
                        buildString {
                            append("pid ${entry.pid}")
                            entry.parentPid?.let { append(" · родитель $it") }
                            entry.startedAt?.let { append(" · старт ${processAgeLabel(it)}") }
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    entry.commandLine?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 4, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            Text(
                processMemoryLabel(entry.memoryBytes),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (killing) {
                Spacer(Modifier.size(8.dp))
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            }
        }
        if (expanded) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                OutlinedButton(onClick = onKill, enabled = !killing) { Text("Остановить", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

/** `15347 МБ` → `«15,0 ГБ»`; null — «—»: ОС память не назвала. */
internal fun processMemoryLabel(bytes: Long?): String {
    if (bytes == null || bytes <= 0) return "—"
    val mb = bytes / (1024.0 * 1024.0)
    return when {
        mb >= 1024 -> "${(mb / 1024 * 10).roundToLong() / 10.0} ГБ"
        mb >= 1 -> "${mb.roundToLong()} МБ"
        else -> "${(bytes / 1024.0).roundToLong().coerceAtLeast(1)} КБ"
    }
}

/** Подпись: pid, возраст процесса и командная строка — что известно. */
internal fun processSubLabel(entry: ProcessEntry, nowMs: Long? = null): String {
    val parts = mutableListOf("pid ${entry.pid}")
    entry.startedAt?.let { parts.add("старт ${processAgeLabel(it, nowMs)}") }
    entry.commandLine?.let { parts.add(it) }
    return parts.joinToString(" · ")
}

/** «2 ч 5 мин назад»; будущее время (часовой пояс/часы) — «только что». */
@OptIn(ExperimentalTime::class)
internal fun processAgeLabel(startedAtMs: Long, nowMs: Long? = null): String {
    val now = nowMs ?: Clock.System.now().toEpochMilliseconds()
    val minutes = ((now - startedAtMs).coerceAtLeast(0L) / 60_000L)
    return when {
        minutes < 1 -> "только что"
        minutes < 60 -> "$minutes мин назад"
        minutes % 60 == 0L -> "${minutes / 60} ч назад"
        else -> "${minutes / 60} ч ${minutes % 60} мин назад"
    }
}

/** Самые прожорливые сверху; без памяти — в конец, а не вперемешку. */
internal fun sortedProcesses(list: List<ProcessEntry>): List<ProcessEntry> =
    list.sortedByDescending { it.memoryBytes ?: -1L }

internal fun processRuntimeLabel(runtime: String): String = when (runtime) {
    "node" -> "Node"
    "python" -> "Python"
    "java" -> "Java"
    else -> runtime
}
