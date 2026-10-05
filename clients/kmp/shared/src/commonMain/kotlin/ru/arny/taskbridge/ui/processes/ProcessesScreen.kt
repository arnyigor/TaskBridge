package ru.arny.taskbridge.ui.processes

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.FlowRowScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.GpuProcessEntry
import ru.arny.taskbridge.core.api.ProcessEntry
import ru.arny.taskbridge.ui.common.Banner
import ru.arny.taskbridge.ui.theme.AppIcons
import kotlin.math.roundToLong
import kotlin.time.Clock
import kotlin.time.ExperimentalTime

/**
 * Экран «Процессы»: кто на машине с сервером ест память, и кого можно прибить.
 * Ручной вход из «Настроек», как и «Локальные модели» — это действие оператора,
 * а не настройка. Бэкенд сам отказывается убивать системные процессы и дерево
 * TaskBridge; его refusal приходит готовым сообщением и показывается как есть.
 *
 * Список опрашивается сам, пока экран открыт: не для анимации, а потому что
 * после «Остановить» (и вообще со временем) он быстро устаревает.
 */
@Composable
fun ProcessesScreen(connection: AppGraph.Connected, onBack: () -> Unit) {
    var processes by remember { mutableStateOf<List<ProcessEntry>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var pendingKill by remember { mutableStateOf<ProcessEntry?>(null) }
    var killingPid by remember { mutableStateOf<Long?>(null) }
    var gpuProcesses by remember { mutableStateOf<List<GpuProcessEntry>?>(null) }
    var pendingGroup by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun refresh(fresh: Boolean) {
        scope.launch {
            refreshing = true
            runCatching { connection.api.processes(fresh) }
                .onSuccess { processes = it; error = null }
                .onFailure { error = it.message ?: "Не удалось получить список процессов" }
            refreshing = false
        }
    }

    LaunchedEffect(Unit) {
        refresh(false)
        runCatching { connection.api.gpuProcesses() }.onSuccess { gpuProcesses = it }
    }
    // Живой список: без опроса после kill пришлось бы жать «Обновить» руками.
    LaunchedEffect(Unit) {
        while (true) {
            delay(10_000)
            runCatching { connection.api.processes() }.onSuccess { processes = it }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад") } },
                title = { Text("Процессы машины") },
                actions = {
                    IconButton(onClick = { refresh(true) }, enabled = !refreshing) {
                        if (refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(AppIcons.Refresh, "Обновить")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
        ) {
            Column(Modifier.widthIn(max = 720.dp).padding(horizontal = 16.dp)) {
                error?.let { Banner(it, AppIcons.Alert, MaterialTheme.colorScheme.error) }
                val list = processes
                when {
                    list == null && error == null -> Text("Загрузка…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    list != null && list.isEmpty() -> Text("ОС не вернула ни одного процесса.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    list != null -> {
                        val known = list.count { it.memoryBytes != null }
                        val total = list.sumOf { it.memoryBytes ?: 0L }
                        Text(
                            "Процессов: ${list.size} · память учтённых: ${processMemoryLabel(total)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 8.dp),
                        )
                        Text(
                            gpuProcesses?.let { if (it.isEmpty()) "GPU-память: свободна" else "GPU-процессов: ${it.size} · ${it.sumOf { p -> p.memoryMb ?: 0L }} МБ" }
                                ?: "GPU: nvidia-smi недоступен",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(bottom = 8.dp),
                        )
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = { pendingGroup = "node" }) { Text("Завершить все Node") }
                            OutlinedButton(onClick = { pendingGroup = "python" }) { Text("Завершить все Python") }
                        }
                        for (entry in sortedProcesses(list)) ProcessCard(
                            entry, killingPid,
                            onKill = { pendingKill = entry },
                        )
                        if (known == 0) Text(
                            "Память процессов ОС не сообщила — убийство по-прежнему работает.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }

    pendingGroup?.let { runtime ->
        AlertDialog(
            onDismissRequest = { pendingGroup = null },
            title = { Text("Освободить ресурсы: $runtime?") },
            text = { Text("Будут принудительно завершены все видимые процессы $runtime, кроме защищённых процессов TaskBridge и системы.") },
            confirmButton = { TextButton(onClick = {
                pendingGroup = null
                scope.launch { runCatching { connection.api.killProcessGroup(runtime) }.onFailure { error = it.message }; refresh(true); gpuProcesses = runCatching { connection.api.gpuProcesses() }.getOrNull() }
            }) { Text("Завершить", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { pendingGroup = null }) { Text("Отмена") } },
        )
    }

    pendingKill?.let { victim ->
        AlertDialog(
            onDismissRequest = { pendingKill = null },
            title = { Text("Остановить ${victim.name ?: "процесс ${victim.pid}"}?") },
            text = {
                Text(
                    "Процесс и его дочерние будут завершены принудительно (taskkill /T /F). " +
                        "Несохранённая работа в нём будет потеряна.",
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

@Composable
private fun ProcessCard(entry: ProcessEntry, killingPid: Long?, onKill: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row {
            Text(
                entry.name ?: "(без имени)",
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                processMemoryLabel(entry.memoryBytes),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            processSubLabel(entry),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        FlowRow(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
        ) {
            OutlinedButton(onClick = onKill, enabled = killingPid == null || killingPid == entry.pid) {
                if (killingPid == entry.pid) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Text("Остановить")
                }
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

/** Подпись карточки: pid, возраст процесса и командная строка — что известно. */
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
