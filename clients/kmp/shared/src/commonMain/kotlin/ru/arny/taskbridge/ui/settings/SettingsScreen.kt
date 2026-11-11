package ru.arny.taskbridge.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.core.client.sessions.displayStateOf
import ru.arny.taskbridge.ui.common.InfoRow
import ru.arny.taskbridge.ui.sessions.ModelPicker
import ru.arny.taskbridge.ui.mcp.mcpModes
import ru.arny.taskbridge.ui.mcp.mcpSummary
import ru.arny.taskbridge.ui.theme.AppIcons
import kotlinx.coroutines.delay

@Composable
fun SettingsScreen(graph: AppGraph, connection: AppGraph.Connected, onBack: () -> Unit, onDisconnected: () -> Unit, onOpenLocalModels: () -> Unit, onOpenProcesses: () -> Unit, onOpenPiModels: () -> Unit = {}, onOpenMcp: () -> Unit = {}) {
    val state by connection.sessions.state.collectAsState()
    val agentState by connection.settingsController.state.collectAsState()
    val online by connection.online.collectAsState()
    val info = state.info
    // Открыт модальный диалог питания: пока он на экране, фоновый опрос статуса
    // останавливается, иначе отсчёт и поля диалога перерисовываются вместе со
    // всей страницей каждые три секунды.
    var powerModal by remember { mutableStateOf(false) }
    var enterSends by remember { mutableStateOf(graph.settings.enterSends) }

    LaunchedEffect(connection) {
        connection.settingsController.loadProviderProfiles()
    }

    // 3 с, не 1 с: секундный полный рефреш перерисовывал весь экран настроек и
    // заставлял сервер отдавать /info и список сессий без паузы. Пока открыт
    // диалог (форма подключения или подтверждение выключения), опрос стоит:
    // в этот момент человек вводит данные, а не читает диагностику.
    val modalOpen = powerModal || agentState.providerEditor != null
    LaunchedEffect(connection, modalOpen) {
        if (modalOpen) return@LaunchedEffect
        while (true) {
            connection.sessions.refresh()
            delay(3_000)
        }
    }

    // Прокрутка и координаты разделов: оглавление сверху прыгает к нужному блоку,
    // вместо прокрутки через всю диагностику.
    val scroll = rememberScrollState()
    val sectionOffsets = remember { mutableStateMapOf<String, Int>() }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад") } },
                title = { Text("Настройки") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            // Оглавление закреплено над прокруткой: иначе после первого перехода
            // оно уезжает вместе со страницей и вернуться к верхним разделам нечем.
            SettingsIndex(scroll, sectionOffsets)
            Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(scroll).padding(bottom = 24.dp)) {
                Column(Modifier.widthIn(max = 720.dp)) {
                    // Порядок разделов повторяет порядок вопросов, с которыми сюда приходят:
                    // «как выглядит приложение» → «с чем оно соединено» → «куда перейти за
                    // моделями» → «что показывает машина» → «что можно выключить».
                    SettingsSectionHeader("Это устройство", sectionOffsets)
                    SettingsCard(
                        title = "Внешний вид и ввод",
                        subtitle = "Версия ${graph.platform.appVersion.ifEmpty { "—" }} · устройство ${graph.settings.clientId}",
                    ) {
                        Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) {
                            Text("Тема", style = MaterialTheme.typography.bodyMedium)
                            FlowRow(
                                Modifier.padding(top = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                for ((mode, label) in listOf("system" to "Как в системе", "light" to "Светлая", "dark" to "Тёмная")) {
                                    FilterChip(selected = graph.theme == mode, onClick = { graph.changeTheme(mode) }, label = { Text(label) })
                                }
                            }
                        }
                        if (graph.platform.kind == "desktop") {
                            Row(Modifier.fillMaxWidth().clickable { enterSends = !enterSends; graph.settings.enterSends = enterSends }.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text("Enter отправляет", style = MaterialTheme.typography.bodyMedium)
                                    Text("Shift+Enter — новая строка, Ctrl+Enter — вклиниться, не останавливая команды", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                Switch(checked = enterSends, onCheckedChange = { enterSends = it; graph.settings.enterSends = it })
                            }
                        }
                    }

                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    SettingsSectionHeader("Компьютер", sectionOffsets)
                    ServerStatusSection(
                        platform = graph.platform,
                        baseUrl = connection.baseUrl,
                        online = online,
                        info = info,
                    )

                    // Один вход в управление вместо трёх разных кнопок в разных местах
                    // экрана: строки-переходы с живой сводкой, а не текстовые ссылки
                    // без рамки и стрелки.
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    SettingsSectionHeader("Модели и провайдеры", sectionOffsets)
                    val localModels = info?.local?.models.orEmpty()
                    val localUp = localModels.count { it.status == "loaded" || it.status == "sleeping" }
                    val providerProfiles = agentState.providerProfiles
                    val catalogModels = agentState.models?.models.orEmpty()
                    val piModelsSummary = listOfNotNull(
                        providerProfiles.size.takeIf { it > 0 }?.let { "провайдеров: $it" },
                        catalogModels.size.takeIf { it > 0 }?.let { "моделей: $it" },
                    ).joinToString(" · ").ifBlank { "провайдеры, модели и поля models.json" }
                    SettingsCard(title = "Управление") {
                        SettingsNavRow(
                            AppIcons.Tool,
                            "Модели Pi и подключения",
                            piModelsSummary,
                            onOpenPiModels,
                        )
                        SettingsNavRow(
                            AppIcons.Layers,
                            "Локальные модели",
                            if (localModels.isEmpty()) info?.engine?.model ?: "ничего не установлено"
                            else "установлено ${localModels.size} · запущено $localUp",
                            onOpenLocalModels,
                        )
                        SettingsNavRow(
                            AppIcons.Queue,
                            "Процессы и память",
                            "Процессы машины с сервером, память и kill",
                            onOpenProcesses,
                        )
                    }

                    // Загрузка машины: по RAM видно, как модель читается в память,
                    // по VRAM — почему Strata упирается (создатели экспертов на GPU).
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    SettingsSectionHeader("Состояние компьютера", sectionOffsets)
                    SettingsCard(title = "Нагрузка машины") {
                        info?.system?.let { sys ->
                            sys.ram?.let { MetricRow("RAM", ramLabel(it), it.ratio) }
                            sys.cpu?.let { MetricRow("CPU", cpuLabel(it), it.load) }
                            sys.gpu.orEmpty().forEach { gpu ->
                                MetricRow(
                                    "GPU",
                                    gpuLabel(gpu),
                                    gpu.memoryTotalMb?.takeIf { total -> total > 0 }?.let { total ->
                                        (gpu.memoryUsedMb ?: 0L).toDouble() / total
                                    },
                                )
                            }
                            if (sys.ram == null && sys.cpu == null && sys.gpu.isNullOrEmpty()) {
                                InfoRow(label = "Нагрузка машины", value = "нет данных")
                            }
                        }
                        val engine = info?.engine
                        val metrics = engine?.metrics
                        if (engine != null || info?.local != null) {
                            // Состояние модели берётся из её статуса (запущена/загружается/нет),
                            // а не из метрик роутера: отсутствие метрик llama.cpp ничего не
                            // говорит о внешнем сервере вроде Strata. Скорости и контекст
                            // показываем только когда метрики действительно есть.
                            InfoRow(label = "Локальная модель", value = localModelStatusText(info))
                            if (metrics?.available == true) {
                                val speed = listOfNotNull(
                                    metrics.pp?.takeIf { it.isFinite() && it > 0.0 }?.let { "PP ${number(it)} ток/с" },
                                    metrics.tg?.takeIf { it.isFinite() && it > 0.0 }?.let { "TG ${number(it)} ток/с" },
                                ).joinToString(" · ")
                                InfoRow(label = "Скорость сейчас", value = speed.ifBlank { "нет данных" })
                                val context = when {
                                    metrics.kvRatio != null -> "${(metrics.kvRatio * 100).toInt()}%" + (metrics.contextWindow ?: engine.contextWindow)?.let { " из ${it / 1000}K" }.orEmpty() + metrics.nTokensMax?.takeIf { it > 0.0 }?.let { " · ${it.toLong()} ток." }.orEmpty()
                                    metrics.nTokensMax?.takeIf { it > 0.0 } != null -> "${metrics.nTokensMax.toLong()} ток."
                                    else -> "нет данных"
                                }
                                MetricRow("Контекст", context, metrics.kvRatio)
                                val queue = listOfNotNull(
                                    metrics.requestsProcessing?.takeIf { it > 0.0 }?.let { "читает/генерирует: ${it.toInt()}" },
                                    metrics.requestsDeferred?.takeIf { it > 0.0 }?.let { "ждёт: ${it.toInt()}" },
                                ).joinToString(" · ")
                                if (queue.isNotBlank()) InfoRow(label = "Очередь llama.cpp", value = queue)
                            }
                        }
                    }
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    SettingsSectionHeader("Агент и очередь", sectionOffsets)
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
                    SettingsSectionHeader("Балансы и лимиты провайдеров", sectionOffsets)
                    Text(
                        "Баланс доступен только там, где провайдер предоставляет безопасный API аккаунта. Данные обновляются вручную, чтобы не превысить лимиты кабинета.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                    val catalog = agentState.models
                    val modelCounts = providerModelCounts(catalog?.models.orEmpty())
                    var providersExpanded by rememberSaveable { mutableStateOf(false) }
                    Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                        Row(
                            Modifier.fillMaxWidth().clickable { providersExpanded = !providersExpanded }.padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text("Каталог моделей", style = MaterialTheme.typography.titleSmall)
                                Text(
                                    if (catalog == null) "Загрузка…" else "${catalog.models.size} моделей · ${modelCounts.size} провайдеров",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Icon(
                                if (providersExpanded) AppIcons.ChevronUp else AppIcons.ChevronDown,
                                if (providersExpanded) "Свернуть провайдеров" else "Показать провайдеров",
                            )
                        }
                        catalog?.defaultModel?.let { model ->
                            Text(
                                "По умолчанию: ${model.provider.orEmpty()} / ${model.label}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                            )
                        }
                        if (providersExpanded) {
                            FlowRow(
                                Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                modelCounts.forEach { (provider, count) ->
                                    Surface(
                                        shape = MaterialTheme.shapes.small,
                                        color = MaterialTheme.colorScheme.surfaceVariant,
                                    ) {
                                        Text("$provider · $count", style = MaterialTheme.typography.labelMedium,
                                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                                    }
                                }
                            }
                        }
                    }

                    // Явная диагностика, не скрытая в реальном ходе: оператор выбирает
                    // любую модель и осознанно тратит максимум один токен на TTFT-пробу.
                    var modelToProbeKey by rememberSaveable { mutableStateOf<String?>(null) }
                    val modelToProbe = catalog?.models?.firstOrNull { it.key == modelToProbeKey }
                        ?: catalog?.defaultModel
                        ?: catalog?.models?.firstOrNull()
                    var probeExpanded by rememberSaveable { mutableStateOf(false) }
                    Row(
                        Modifier.fillMaxWidth().clickable { probeExpanded = !probeExpanded }
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("Проверка модели", style = MaterialTheme.typography.titleSmall)
                            Text("Диагностика · запрос на 1 токен", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Icon(if (probeExpanded) AppIcons.ChevronUp else AppIcons.ChevronDown,
                            if (probeExpanded) "Свернуть проверку" else "Раскрыть проверку")
                    }
                    if (catalog != null && probeExpanded) {
                        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                            Spacer(Modifier.height(8.dp))
                            ModelPicker(
                                catalog = catalog,
                                selected = modelToProbe,
                                settings = graph.settings,
                                onPick = { modelToProbeKey = it.key },
                                info = info,
                            )
                            val probe = modelToProbe?.let { agentState.modelProbes[it.key] }
                            Spacer(Modifier.height(8.dp))
                            OutlinedButton(
                                onClick = { modelToProbe?.let(connection.settingsController::probeModel) },
                                enabled = modelToProbe?.provider?.isNotBlank() == true
                                    && modelToProbe?.id?.isNotBlank() == true
                                    && probe?.loading != true,
                            ) {
                                if (probe?.loading == true) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                else Icon(AppIcons.Refresh, "Проверить модель", Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(if (probe?.loading == true) "Проверяю…" else "Проверить (1 токен)")
                            }
                            val probeText = probe?.result?.let(::modelProbeResultText) ?: probe?.error
                            if (probeText != null) {
                                Text(
                                    probeText,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (probe?.result?.ok == true) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                                    modifier = Modifier.padding(top = 6.dp),
                                )
                            } else {
                                Text(
                                    "Замер до первого ответа; результат не смешивается со статистикой рабочих ходов.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(top = 6.dp),
                                )
                            }
                        }
                    }

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
                                onUseReset = connection.settingsController::useCodexReset,
                            )
                        }
                    }

                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    SettingsSectionHeader("MCP", sectionOffsets)
                    // Список серверов и все их инструменты — отдельный экран: в настройках
                    // он растягивал страницу на несколько экранов прокрутки, а режим и
                    // наличие проблем видно и по сводке.
                    SettingsCard(title = "Серверы и инструменты") {
                        // Режим переключается и здесь: это единственное, что чаще всего
                        // меняют, и ради одного чипа незачем открывать весь экран.
                        FlowRow(
                            Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            for ((mode, label) in mcpModes) {
                                FilterChip(
                                    selected = agentState.mcp?.mode == mode,
                                    enabled = !agentState.mcpLoading,
                                    onClick = { connection.settingsController.setMcpMode(mode) },
                                    label = { Text(label) },
                                )
                            }
                        }
                        SettingsNavRow(
                            AppIcons.Tool,
                            "Серверы MCP",
                            mcpSummary(agentState.mcp),
                            onOpenMcp,
                        )
                    }
                    agentState.error?.let { error ->
                        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                            TextButton(onClick = connection.settingsController::clearError) { Text("Скрыть") }
                        }
                    }

                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    SettingsSectionHeader("Питание и подключение", sectionOffsets)
                    PowerSection(
                        kind = graph.platform.kind,
                        shutdown = { connection.api.shutdownComputer() },
                        reboot = { connection.api.rebootComputer() },
                        onDisconnect = {
                            graph.disconnect()
                            onDisconnected()
                        },
                        onExit = { graph.platform.exitApp() },
                        onModalChange = { powerModal = it },
                    )
            }
        }
            }
        }

    // Форма подключения — одно место на оба экрана: здесь и в «Модели Pi».
    ProviderDialogs(connection)
}
