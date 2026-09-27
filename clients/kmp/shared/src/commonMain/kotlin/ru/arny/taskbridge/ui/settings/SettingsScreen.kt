package ru.arny.taskbridge.ui.settings

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.SUPPORTED_API_VERSIONS
import ru.arny.taskbridge.core.api.McpServer
import ru.arny.taskbridge.core.api.ProviderStatus
import ru.arny.taskbridge.ui.common.SectionTitle
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors

@Composable
fun SettingsScreen(graph: AppGraph, connection: AppGraph.Connected, onBack: () -> Unit, onDisconnected: () -> Unit) {
    val state by connection.sessions.state.collectAsState()
    val agentState by connection.settingsController.state.collectAsState()
    val info = state.info
    var confirmDisconnect by remember { mutableStateOf(false) }
    var enterSends by remember { mutableStateOf(graph.settings.enterSends) }

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
                    warning = pi != null && !pi.supported,
                )
                InfoRow(label = "Модель занята", value = when (info?.modelBusy) { true -> "да"; false -> "нет"; null -> "нет данных" })
                info?.scheduler?.let {
                    InfoRow(label = "Параллельные сессии", value = "${it.activeTasks} из ${it.maxConcurrentSessions}; в очереди ${it.queuedTasks}")
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
                SectionTitle("MCP")
                Text(
                    "Режим применяется к новым сессиям. Уже запущенные агенты сохраняют набор инструментов до перезапуска сессии.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
                Row(
                    Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    for ((mode, label) in listOf("inherit" to "Из Pi", "managed" to "Управляемый", "off" to "Выключен")) {
                        FilterChip(
                            selected = agentState.mcp?.mode == mode,
                            enabled = !agentState.mcpLoading,
                            onClick = { connection.settingsController.setMcpMode(mode) },
                            label = { Text(label) },
                        )
                    }
                    if (agentState.mcpLoading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                }
                Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = connection.settingsController::loadMcp, enabled = !agentState.mcpLoading) {
                        Icon(AppIcons.Refresh, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Обновить")
                    }
                    OutlinedButton(onClick = connection.settingsController::importMcp, enabled = !agentState.mcpLoading) {
                        Text("Импортировать из Pi")
                    }
                }
                agentState.mcp?.configPath?.let { InfoRow("Конфигурация", it) }
                agentState.mcp?.servers.orEmpty().forEach { server ->
                    McpServerCard(
                        server = server,
                        editable = agentState.mcp?.mode == "managed" && !agentState.mcpLoading,
                        onServerEnabled = { enabled -> connection.settingsController.setServer(server.name, enabled) },
                        onToolEnabled = { tool, enabled -> connection.settingsController.setTool(server.name, tool, enabled) },
                    )
                }
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

private fun number(value: Double?): String = value?.let {
    if (it % 1.0 == 0.0) it.toLong().toString() else ((it * 100).toLong() / 100.0).toString()
} ?: "—"

@Composable
private fun McpServerCard(
    server: McpServer,
    editable: Boolean,
    onServerEnabled: (Boolean) -> Unit,
    onToolEnabled: (String, Boolean) -> Unit,
) {
    Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(server.name, style = MaterialTheme.typography.titleSmall)
                Text(server.transport ?: "неизвестный transport", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(checked = !server.disabled, enabled = editable, onCheckedChange = onServerEnabled)
        }
        server.tools.forEach { tool ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(tool.name, style = MaterialTheme.typography.bodyMedium)
                    if (tool.description.isNotBlank()) Text(tool.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
