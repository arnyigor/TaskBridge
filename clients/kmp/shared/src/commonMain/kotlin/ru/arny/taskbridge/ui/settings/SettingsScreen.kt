package ru.arny.taskbridge.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.SUPPORTED_API_VERSIONS
import ru.arny.taskbridge.core.api.LocalModelEntry
import ru.arny.taskbridge.core.api.SystemCpu
import ru.arny.taskbridge.core.api.SystemGpu
import ru.arny.taskbridge.core.api.SystemRam
import ru.arny.taskbridge.core.api.McpServer
import ru.arny.taskbridge.core.api.McpStatus
import ru.arny.taskbridge.core.api.ProviderStatus
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.core.client.sessions.displayStateOf
import ru.arny.taskbridge.ui.common.SectionTitle
import ru.arny.taskbridge.ui.common.formatBytes
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

@Composable
fun SettingsScreen(graph: AppGraph, connection: AppGraph.Connected, onBack: () -> Unit, onDisconnected: () -> Unit) {
    val state by connection.sessions.state.collectAsState()
    val agentState by connection.settingsController.state.collectAsState()
    val online by connection.online.collectAsState()
    val info = state.info
    var confirmDisconnect by remember { mutableStateOf(false) }
    var enterSends by remember { mutableStateOf(graph.settings.enterSends) }
    var editMcpServer by remember { mutableStateOf<McpServer?>(null) }
    var addMcpServer by remember { mutableStateOf(false) }
    // Локальные модели (роутер llama.cpp + внешние серверы вроде Strata):
    // выбранная кнопкой модель загружается/выгружается через /api/local/*.
    // Загрузка внешнего сервера — это запуск его процесса на минуты, поэтому
    // строка до конца ждёт ответа и показывает «…».
    var localBusyId by remember { mutableStateOf<String?>(null) }
    var localError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(connection) {
        while (true) {
            connection.sessions.refresh()
            delay(1_000)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад") } },
                title = { Text("Настройки") },
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
        ) {
            Column(Modifier.widthIn(max = 720.dp)) {
                SectionTitle("Компьютер")
                InfoRow(label = "Адрес", value = connection.baseUrl, icon = AppIcons.Computer)
                InfoRow(label = "Сеть устройства", value = if (online) "доступна" else "offline", warning = !online)
                InfoRow(label = "TaskBridge", value = info?.name ?: "—")
                InfoRow(label = "Версия API", value = info?.let { "${it.apiVersion} (приложение знает: ${SUPPORTED_API_VERSIONS.joinToString()})" } ?: "—")
                val pi = info?.pi
                InfoRow(
                    label = "Pi",
                    value = when {
                        pi == null -> "проверяется…"
                        pi.version == null -> "не найден${pi.error?.let { ": $it" }.orEmpty()}"
                        pi.supported -> "${pi.version} — поддерживается"
                        else -> "${pi.version} — не проверялся (${pi.supportedRange.orEmpty()})"
                    },
                    warning = pi?.version != null && !pi.supported,
                )
                // «занята» — это про роутер llama.cpp (там же очередь и KV), а не
                // про внешние серверы вроде Strata: рядом со строкой «iq2-xs ·
                // загружена» она читалась как «никакая модель не занята».
                InfoRow(label = "Роутер занят", value = when (info?.modelBusy) { true -> "да"; false -> "нет"; null -> "нет данных" })
                // Загрузка машины: по RAM видно, как модель читается в память,
                // по VRAM — почему Strata упирается (создатели экспертов на GPU).
                info?.system?.let { sys ->
                    sys.ram?.let { InfoRow(label = "RAM", value = ramLabel(it)) }
                    sys.cpu?.let { InfoRow(label = "CPU", value = cpuLabel(it)) }
                    sys.gpu.orEmpty().forEach { InfoRow(label = "GPU", value = gpuLabel(it)) }
                    if (sys.ram == null && sys.cpu == null && sys.gpu.isNullOrEmpty()) {
                        InfoRow(label = "Нагрузка машины", value = "нет данных")
                    }
                }
                val engine = info?.engine
                val metrics = engine?.metrics
                if (engine != null || info?.local != null) {
                    val speed = listOfNotNull(
                        metrics?.pp?.takeIf { it.isFinite() && it > 0.0 }?.let { "PP ${number(it)} ток/с" },
                        metrics?.tg?.takeIf { it.isFinite() && it > 0.0 }?.let { "TG ${number(it)} ток/с" },
                    ).joinToString(" · ")
                    InfoRow(label = "Скорость сейчас", value = speed.ifBlank { metrics?.reason ?: "нет данных" })
                    val context = when {
                        metrics?.kvRatio != null -> "${(metrics.kvRatio * 100).toInt()}%" + (metrics.contextWindow ?: engine?.contextWindow)?.let { " из ${it / 1000}K" }.orEmpty() + metrics.nTokensMax?.takeIf { it > 0.0 }?.let { " · ${it.toLong()} ток." }.orEmpty()
                        metrics?.nTokensMax?.takeIf { it > 0.0 } != null -> "${metrics.nTokensMax.toLong()} ток."
                        else -> "нет данных"
                    }
                    InfoRow(label = "Контекст", value = context)
                    val queue = listOfNotNull(
                        metrics?.requestsProcessing?.takeIf { it > 0.0 }?.let { "читает/генерирует: ${it.toInt()}" },
                        metrics?.requestsDeferred?.takeIf { it > 0.0 }?.let { "ждёт: ${it.toInt()}" },
                    ).joinToString(" · ")
                    if (queue.isNotBlank()) InfoRow(label = "Очередь llama.cpp", value = queue)
                }
                LocalModelsSection(
                    models = info?.local?.models.orEmpty(),
                    routerProvider = info?.local?.provider,
                    engineModel = engine?.model,
                    onLoad = { id ->
                        localBusyId = id
                        scope.launch {
                            runCatching { connection.api.loadLocalModel(id) }
                                .onFailure { localError = it.message ?: "Не удалось загрузить $id" }
                            localBusyId = null
                            connection.sessions.refresh()
                        }
                    },
                    onUnload = { id ->
                        localBusyId = id
                        scope.launch {
                            runCatching { connection.api.unloadLocalModel(id) }
                                .onFailure { localError = it.message ?: "Не удалось выгрузить $id" }
                            localBusyId = null
                            connection.sessions.refresh()
                        }
                    },
                    busyId = localBusyId,
                    error = localError,
                )
                info?.scheduler?.let {
                    // «2 из 4» was read as "максимум 2": name every number instead
                    // of leaving the operator to guess which one is the limit.
                    InfoRow(label = "Параллельные сессии", value = "работают ${it.activeTasks} · максимум ${it.maxConcurrentSessions} · в очереди ${it.queuedTasks}")
                    // A project without worktrees is one folder for all of its sessions;
                    // the operator decides whether that folder is limited (queue.
                    // maxSessionsPerDirectory). 0 means "no limit of its own".
                    if (it.maxSessionsPerDirectory > 0) InfoRow(
                        label = "Сессий на папку",
                        value = "до ${it.maxSessionsPerDirectory}",
                        warning = it.maxSessionsPerDirectory == 1,
                    )
                    // Why the queue does not drain is decided by the model and by the
                    // working directory (one project without worktrees is one folder,
                    // and only one session may write there): name both, so a wait
                    // never looks like a stuck server. Counted from the list this
                    // screen already polls.
                    val waiting = state.tasks.filter { displayStateOf(it) == DisplayState.QUEUED }.mapNotNull { task -> task.queueReason }
                    if (waiting.isNotEmpty()) InfoRow(label = "Причина ожидания", value = listOfNotNull(
                        waiting.count { it == "WORKSPACE_BUSY" }.takeIf { it > 0 }?.let { "папка занята: $it" },
                        waiting.count { it == "MODEL_BUSY" || it == "MODEL_LOADING" }.takeIf { it > 0 }?.let { "модель занята: $it" },
                        waiting.count { it != "WORKSPACE_BUSY" && it != "MODEL_BUSY" && it != "MODEL_LOADING" }.takeIf { it > 0 }?.let { "лимит или очередь: $it" },
                    ).joinToString(" · "))
                    if (it.providers.isNotEmpty()) InfoRow(
                        label = "Слоты провайдеров",
                        value = it.providers.entries.sortedBy { entry -> entry.key }.joinToString(" · ") { entry -> "${entry.key} ${entry.value.active}/${entry.value.limit}${if (entry.value.cooldownUntil != null) " (backoff)" else ""}" },
                    )
                    it.queueWaitMs?.let { wait ->
                        if (wait.currentMax > 0 || wait.samples > 0) InfoRow(label = "Ожидание очереди", value = "сейчас до ${wait.currentMax / 1000} с · среднее ${wait.average / 1000} с")
                    }
                }
                info?.storeId?.let { InfoRow(label = "База", value = it.take(8)) }
                for (warning in info?.warnings.orEmpty()) {
                    InfoRow(label = "Предупреждение", value = warning.message ?: warning.code.orEmpty(), warning = true)
                }

                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                SectionTitle("Модели и лимиты провайдеров")
                Text(
                    "Баланс доступен только там, где провайдер предоставляет безопасный API аккаунта. Данные обновляются вручную, чтобы не превысить лимиты кабинета.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
                val catalog = agentState.models
                InfoRow("Доступно моделей", catalog?.models?.size?.toString() ?: "загрузка…")
                catalog?.defaultModel?.let { InfoRow("По умолчанию", "${it.provider.orEmpty()}/${it.label}") }
                catalog?.models
                    ?.groupingBy { it.provider ?: "другие" }
                    ?.eachCount()
                    ?.toList()
                    ?.sortedByDescending { it.second }
                    ?.forEach { (provider, count) -> InfoRow(provider, "$count моделей") }
                OutlinedButton(
                    onClick = { connection.settingsController.loadModels(refresh = true) },
                    enabled = !agentState.modelsLoading,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                ) {
                    if (agentState.modelsLoading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Icon(AppIcons.Refresh, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Обновить каталог моделей")
                }
                val providers = agentState.providerStatuses.values.sortedBy { it.label ?: it.provider }
                if (providers.isEmpty()) {
                    Text("Данные ещё не загружены", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    providers.forEach { provider ->
                        ProviderRow(
                            status = provider,
                            refreshing = provider.provider in agentState.refreshingProviders,
                            onRefresh = { provider.provider?.let(connection.settingsController::refreshProvider) },
                        )
                    }
                }

                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                McpSection(
                    mcp = agentState.mcp,
                    loading = agentState.mcpLoading,
                    onMode = connection.settingsController::setMcpMode,
                    onReload = connection.settingsController::loadMcp,
                    onImport = connection.settingsController::importMcp,
                    onProbe = { connection.settingsController.probeMcp() },
                    onAdd = { addMcpServer = true },
                    onEdit = { editMcpServer = it },
                    onServerEnabled = { name, enabled -> connection.settingsController.setServer(name, enabled) },
                    onToolEnabled = { name, tool, enabled -> connection.settingsController.setTool(name, tool, enabled) },
                )
                agentState.error?.let { error ->
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                        TextButton(onClick = connection.settingsController::clearError) { Text("Скрыть") }
                    }
                }

                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                SectionTitle("Это устройство")
                InfoRow(label = "Идентификатор", value = graph.settings.clientId)
                InfoRow(label = "Версия приложения", value = graph.platform.appVersion.ifEmpty { "—" })
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Text("Тема", style = MaterialTheme.typography.bodyMedium)
                    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((mode, label) in listOf("system" to "Как в системе", "light" to "Светлая", "dark" to "Тёмная")) {
                            FilterChip(selected = graph.theme == mode, onClick = { graph.changeTheme(mode) }, label = { Text(label) })
                        }
                    }
                }
                if (graph.platform.kind == "desktop") {
                    Row(Modifier.fillMaxWidth().clickable { enterSends = !enterSends; graph.settings.enterSends = enterSends }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Enter отправляет", style = MaterialTheme.typography.bodyMedium)
                            Text("Shift+Enter — новая строка, Ctrl+Enter — вклиниться, не останавливая команды", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Switch(checked = enterSends, onCheckedChange = { enterSends = it; graph.settings.enterSends = it })
                    }
                }

                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                SectionTitle("Подключение")
                Text(
                    "Уведомления приходят, пока приложение запущено; на Android — и в свёрнутом виде, пока агент работает.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = { confirmDisconnect = true }, modifier = Modifier.padding(horizontal = 16.dp)) {
                    Icon(AppIcons.Logout, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Отключиться от компьютера")
                }
            }
        }
    }

    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            title = { Text("Отключиться?") },
            text = { Text("Приложение забудет адрес и вход. Сессии на компьютере не пострадают.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDisconnect = false
                    graph.disconnect()
                    onDisconnected()
                }) { Text("Отключиться", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDisconnect = false }) { Text("Отмена") } },
        )
    }
    if (addMcpServer || editMcpServer != null) {
        McpServerDialog(
            server = editMcpServer,
            onDismiss = { addMcpServer = false; editMcpServer = null },
            onSave = { name, url, command, args ->
                connection.settingsController.saveServer(name, url, command, args)
                addMcpServer = false; editMcpServer = null
            },
            onRemove = editMcpServer?.let { server ->
                { connection.settingsController.removeServer(server.name); editMcpServer = null }
            },
        )
    }
}

@Composable
private fun ProviderRow(status: ProviderStatus, refreshing: Boolean, onRefresh: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(enabled = !refreshing, onClick = onRefresh).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(status.label ?: status.provider ?: "Провайдер", style = MaterialTheme.typography.bodyMedium)
            Text(providerStatusText(status), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        else Icon(AppIcons.Refresh, "Обновить данные провайдера", Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun providerStatusText(status: ProviderStatus): String {
    if (!status.available) return when (status.reason) {
        "no-key" -> "Ключ не настроен"
        "not-fetched" -> "Нажмите, чтобы получить данные"
        else -> status.reason ?: "Данные недоступны"
    }
    val stale = if (status.stale) " · устарело" else ""
    status.credits?.let { return "${number(it)} кредитов$stale" }
    status.subscription?.let { subscription ->
        val total = subscription.total?.let { " из ${number(it)}" }.orEmpty()
        val percent = subscription.remainingRatio?.let { " · ${(it * 100).toInt()}%" }.orEmpty()
        val rate = status.usage?.perDay?.let { " · расход ${number(it)}/день" }.orEmpty()
        return "Осталось ${number(subscription.remaining)}$total$percent$rate$stale"
    }
    status.balance?.let { balance ->
        val parts = listOfNotNull(balance.cny?.let { "¥${number(it)}" }, balance.usd?.let { "\$${number(it)}" })
        val rub = status.rub?.total?.let { " · ≈ ${number(it)} ₽" }.orEmpty()
        val runway = status.runway?.historyDays?.let { " · примерно на $it дн." }.orEmpty()
        return parts.joinToString(" · ") + rub + runway + stale
    }
    return "Данные получены$stale"
}

private fun ramLabel(ram: SystemRam): String {
    val used = ram.used
    val total = ram.total
    if (used == null || total == null) return "нет данных"
    val percent = ram.ratio?.let { " (${(it * 100).roundToInt()}%)" }.orEmpty()
    return "${formatBytes(used)} / ${formatBytes(total)}$percent"
}

private fun cpuLabel(cpu: SystemCpu): String {
    val load = cpu.load?.let { "${(it * 100).roundToInt()}%" } ?: "—"
    return cpu.cores?.let { "$load ($it ядер)" } ?: load
}

private fun gpuLabel(gpu: SystemGpu): String {
    val mem = if (gpu.memoryUsedMb != null && gpu.memoryTotalMb != null) {
        "${(gpu.memoryUsedMb * 10 / 1024) / 10.0} / ${(gpu.memoryTotalMb * 10 / 1024) / 10.0} ГБ"
    } else {
        null
    }
    val power = gpu.powerDrawW?.let { "${number(it)} Вт" + (gpu.powerLimitW?.let { limit -> " / ${number(limit)} Вт" }.orEmpty()) }
    val parts = listOfNotNull(
        mem,
        gpu.utilization?.let { "${number(it)}%" },
        power,
        gpu.temperatureC?.let { "${number(it)} °C" },
    )
    return listOfNotNull(gpu.name?.takeIf { it.isNotBlank() }?.let { "$it: " }.orEmpty().takeIf { it.isNotEmpty() }, parts.joinToString(" · ").takeIf { it.isNotEmpty() })
        .joinToString("")
        .ifBlank { "нет данных" }
}

private fun number(value: Double?): String = value?.let {
    if (it % 1.0 == 0.0) it.toLong().toString() else ((it * 100).toLong() / 100.0).toString()
} ?: "—"

@Composable
internal fun McpSection(
    mcp: McpStatus?,
    loading: Boolean,
    onMode: (String) -> Unit,
    onReload: () -> Unit,
    onImport: () -> Unit,
    onProbe: () -> Unit,
    onAdd: () -> Unit,
    onEdit: (McpServer) -> Unit,
    onServerEnabled: (String, Boolean) -> Unit,
    onToolEnabled: (String, String, Boolean) -> Unit,
) {
    SectionTitle("MCP")
    Text(
        "Режим применяется к новым сессиям. Уже запущенные агенты сохраняют набор инструментов до перезапуска сессии.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp),
    )
    // Three buttons never fit one phone-width row: a plain Row squeezes the last
    // one to zero width, its label wraps per character and the row grows by ~160dp.
    FlowRow(
        Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        for ((mode, label) in listOf("inherit" to "Из Pi", "managed" to "Управляемый", "off" to "Выключен")) {
            FilterChip(
                selected = mcp?.mode == mode,
                enabled = !loading,
                onClick = { onMode(mode) },
                label = { Text(label) },
            )
        }
        if (loading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
    }
    FlowRow(
        Modifier.padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedButton(onClick = onReload, enabled = !loading) {
            Icon(AppIcons.Refresh, null, Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Обновить")
        }
        OutlinedButton(onClick = onImport, enabled = !loading) { Text("Импортировать из Pi") }
        OutlinedButton(onClick = onProbe, enabled = !loading) { Text("Проверить") }
    }
    if (mcp?.mode == "managed") {
        // 4dp + the button's own 12dp content padding keeps the label on the 16dp grid.
        TextButton(onClick = onAdd, enabled = !loading, modifier = Modifier.padding(horizontal = 4.dp)) { Text("Добавить MCP-сервер") }
    }
    mcp?.configPath?.let { InfoRow("Конфигурация", it) }
    mcp?.collisions.orEmpty().forEach { collision ->
        InfoRow("Конфликт tool", "${collision.tool}: ${collision.servers.joinToString()}", warning = true)
    }
    mcp?.servers.orEmpty().forEach { server ->
        McpServerCard(
            server = server,
            editable = mcp?.mode == "managed" && !loading,
            onServerEnabled = { enabled -> onServerEnabled(server.name, enabled) },
            onToolEnabled = { tool, enabled -> onToolEnabled(server.name, tool, enabled) },
            onEdit = { onEdit(server) },
            onProbe = { onProbe() },
        )
    }
}

@Composable
private fun McpServerCard(
    server: McpServer,
    editable: Boolean,
    onServerEnabled: (Boolean) -> Unit,
    onToolEnabled: (String, Boolean) -> Unit,
    onEdit: () -> Unit,
    onProbe: () -> Unit,
) {
    // Compose-owned UI state: per-card reveal, like LazyListState. Erroring servers stay expanded.
    val startExpanded = !server.disabled && server.health?.state == "error"
    var expanded by rememberSaveable(server.name) { mutableStateOf(startExpanded) }
    val toolsOff = server.tools.count { it.name in server.excludeTools } +
        if (server.disabled) server.tools.size else 0
    val summary = listOfNotNull(server.transport, "${server.tools.size} инстр.", toolsOff.takeIf { it > 0 }?.let { "$it выкл" }).joinToString(" · ")
    Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        // Collapsed by default: a thumb hits the header row, details reveal on tap.
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, top = 8.dp, end = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(8.dp).background(healthColor(server), CircleShape))
            Spacer(Modifier.width(10.dp))
            Column(
                Modifier.weight(1f).clickable { expanded = !expanded },
            ) {
                Text(server.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(onClick = { expanded = !expanded }) {
                Icon(if (expanded) AppIcons.ChevronUp else AppIcons.ChevronDown, if (expanded) "Свернуть" else "Развернуть")
            }
            Switch(checked = !server.disabled, enabled = editable, onCheckedChange = onServerEnabled)
        }
        if (expanded) {
            server.health?.let { health ->
                val suffix = listOfNotNull(health.latencyMs?.let { "${it} мс" }, health.statusCode?.let { "HTTP $it" }, health.error).joinToString(" · ")
                Text("${health.state}${suffix.takeIf { it.isNotBlank() }?.let { ": $it" }.orEmpty()}", style = MaterialTheme.typography.bodySmall, color = if (health.state == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp))
            }
            (server.url ?: server.command)?.let { endpoint ->
                Text(endpoint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp))
            }
            if (server.auth != null && server.auth != "none") Text("Auth: ${server.auth}${server.scopes.takeIf { it.isNotEmpty() }?.joinToString(prefix = " · scopes: ").orEmpty()}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp))
            Row(Modifier.padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(0.dp)) {
                TextButton(onClick = onProbe) { Text("Диагностика") }
                if (editable) TextButton(onClick = onEdit) { Text("Изменить") }
            }
            HorizontalDivider(Modifier.padding(horizontal = 12.dp, vertical = 2.dp))
            server.tools.forEach { tool ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(tool.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (tool.description.isNotBlank()) Text(tool.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    Switch(
                        checked = tool.name !in server.excludeTools,
                        enabled = editable && !server.disabled,
                        onCheckedChange = { onToolEnabled(tool.name, it) },
                    )
                }
            }
        }
    }
}

@Composable
private fun healthColor(server: McpServer): Color = when {
    server.disabled -> LocalStatusColors.current.muted
    server.health?.state == "error" -> LocalStatusColors.current.failed
    server.health != null -> LocalStatusColors.current.done
    else -> LocalStatusColors.current.muted
}

@Composable
private fun McpServerDialog(
    server: McpServer?,
    onDismiss: () -> Unit,
    onSave: (String, String?, String?, List<String>) -> Unit,
    onRemove: (() -> Unit)?,
) {
    var name by remember(server) { mutableStateOf(server?.name.orEmpty()) }
    var endpoint by remember(server) { mutableStateOf(server?.url ?: server?.command.orEmpty()) }
    var useUrl by remember(server) { mutableStateOf(server?.url != null || server == null) }
    var args by remember(server) { mutableStateOf(server?.args?.joinToString("\n").orEmpty()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (server == null) "Новый MCP-сервер" else "MCP ${server.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Имя") }, enabled = server == null, singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(useUrl, { useUrl = true }, label = { Text("HTTP(S)") })
                    FilterChip(!useUrl, { useUrl = false }, label = { Text("stdio") })
                }
                OutlinedTextField(endpoint, { endpoint = it }, label = { Text(if (useUrl) "URL" else "Command") }, singleLine = true)
                if (!useUrl) OutlinedTextField(args, { args = it }, label = { Text("Аргументы, по одному в строке") })
                if (onRemove != null) TextButton(onClick = onRemove) { Text("Удалить", color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(name.trim(), endpoint.trim().takeIf { useUrl }, endpoint.trim().takeIf { !useUrl }, args.lines().map(String::trim).filter(String::isNotEmpty)) }, enabled = name.isNotBlank() && endpoint.isNotBlank()) { Text("Сохранить") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Отмена") } },
    )
}

/**
 * Все локальные модели одним блоком — пресеты роутера llama.cpp и настроенные
 * внешние серверы (Strata), ровно как в веб-панели «Локальные модели».
 *
 * Состояние берётся из [LocalModelEntry.status]: «загружена» = роутер отдаёт
 * модель или внешний сервер отвечает /health. Кнопка шлёт /api/local/load или
 * /api/local/unload: для Strata это запуск и остановка всего процесса, поэтому
 * загрузка занимает минуты и кнопка всё это время показывает «…».
 */
@Composable
private fun LocalModelsSection(
    models: List<LocalModelEntry>,
    routerProvider: String?,
    engineModel: String?,
    onLoad: (String) -> Unit,
    onUnload: (String) -> Unit,
    busyId: String?,
    error: String?,
) {
    if (models.isEmpty()) {
        InfoRow(label = "Локальные модели", value = engineModel ?: "нет данных")
        return
    }
    val isUp: (LocalModelEntry) -> Boolean = { it.status == "loaded" || it.status == "sleeping" }
    val loaded = models.count(isUp)
    InfoRow(label = "Локальные модели", value = "загружено $loaded из ${models.size}")
    models.forEach { model ->
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(model.id, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val state = when {
                    isUp(model) -> "загружена"
                    model.status == "loading" -> "грузится"
                    model.status == "failed" -> "ошибка"
                    else -> "не загружена"
                }
                val group = model.provider ?: routerProvider ?: "llama.cpp"
                Text(
                    "$group · $state",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(
                onClick = { if (isUp(model)) onUnload(model.id) else onLoad(model.id) },
                enabled = busyId == null,
            ) {
                Text(if (busyId == model.id) "…" else if (isUp(model)) "Выгрузить" else "Загрузить")
            }
        }
    }
    if (error != null) InfoRow(label = "Ошибка модели", value = error, warning = true)
}

@Composable
private fun InfoRow(label: String, value: String, icon: androidx.compose.ui.graphics.vector.ImageVector? = null, warning: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(12.dp))
        }
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(140.dp))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = if (warning) LocalStatusColors.current.waiting else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
    }
}
