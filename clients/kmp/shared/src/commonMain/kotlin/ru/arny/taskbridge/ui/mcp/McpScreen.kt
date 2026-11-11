package ru.arny.taskbridge.ui.mcp

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.McpServer
import ru.arny.taskbridge.core.api.McpStatus
import ru.arny.taskbridge.ui.common.InfoRow
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors

/**
 * Режимы MCP и их подписи: один список на чипы в настройках и на этом экране.
 *
 * Две копии подписей уже расходились бы: сводка писала «Из Pi», чип — что-нибудь
 * другое, и человек не понимал, какой режим выбран.
 */
internal val mcpModes = listOf(
    "inherit" to "Из Pi",
    "managed" to "Управляемый",
    "off" to "Выключен",
)

/** Подпись режима MCP — одна на настройки и на этот экран. */
internal fun mcpModeLabel(mode: String?): String = mcpModes.toMap()[mode] ?: "нет данных"

/**
 * Сводка MCP для «Настроек»: режим, живые серверы и проблемы одной строкой.
 *
 * Полный список серверов и все их инструменты — отдельный экран: в настройках
 * десять тулов на сервер растягивали страницу на несколько экранов прокрутки.
 */
internal fun mcpSummary(status: McpStatus?): String {
    if (status == null) return "нет данных"
    val enabled = status.servers.count { !it.disabled }
    val broken = status.servers.count { !it.disabled && it.health?.state == "error" }
    return listOfNotNull(
        mcpModeLabel(status.mode),
        "серверов: $enabled",
        broken.takeIf { it > 0 }?.let { "с ошибкой: $it" },
        status.collisions.takeIf { it.isNotEmpty() }?.let { "конфликтов: ${it.size}" },
    ).joinToString(" · ")
}

/**
 * Серверы MCP и их инструменты: режим, диагностика, включение по одному.
 *
 * Экран отдельный, потому что это рабочая область, а не параметр приложения:
 * список серверов с раскрывающимися десятками инструментов занимал половину
 * «Настроек» и не давал дойти до темы и подключения.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun McpScreen(connection: AppGraph.Connected, onBack: () -> Unit) {
    val controller = connection.settingsController
    val state by controller.state.collectAsState()
    var addServer by remember { mutableStateOf(false) }
    var editServer by remember { mutableStateOf<McpServer?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("MCP-серверы") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад") } },
                actions = {
                    IconButton(onClick = { controller.loadMcp() }, enabled = !state.mcpLoading) {
                        Icon(AppIcons.Refresh, "Обновить")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
        ) {
            Text(
                "Режим применяется к новым сессиям. Уже запущенные агенты сохраняют набор инструментов до перезапуска сессии.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            // Three chips never fit one phone-width row: a plain Row squeezes the last
            // one to zero width, its label wraps per character and the row grows by ~160dp.
            FlowRow(
                Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                for ((mode, label) in mcpModes) {
                    FilterChip(
                        selected = state.mcp?.mode == mode,
                        enabled = !state.mcpLoading,
                        onClick = { controller.setMcpMode(mode) },
                        label = { Text(label) },
                    )
                }
                if (state.mcpLoading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            }
            FlowRow(
                Modifier.padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(onClick = { controller.loadMcp() }, enabled = !state.mcpLoading) {
                    Icon(AppIcons.Refresh, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Обновить")
                }
                OutlinedButton(onClick = { controller.importMcp() }, enabled = !state.mcpLoading) { Text("Импортировать из Pi") }
                OutlinedButton(onClick = { controller.probeMcp() }, enabled = !state.mcpLoading) { Text("Проверить") }
            }
            if (state.mcp?.mode == "managed") {
                // 4dp + the button's own 12dp content padding keeps the label on the 16dp grid.
                TextButton(onClick = { addServer = true }, enabled = !state.mcpLoading, modifier = Modifier.padding(horizontal = 4.dp)) { Text("Добавить MCP-сервер") }
            }
            state.mcp?.configPath?.let { InfoRow("Конфигурация", it) }
            state.mcp?.collisions.orEmpty().forEach { collision ->
                InfoRow("Конфликт tool", "${collision.tool}: ${collision.servers.joinToString()}", warning = true)
            }
            state.mcp?.servers.orEmpty().forEach { server ->
                McpServerCard(
                    server = server,
                    editable = state.mcp?.mode == "managed" && !state.mcpLoading,
                    onServerEnabled = { enabled -> controller.setServer(server.name, enabled) },
                    onToolEnabled = { tool, enabled -> controller.setTool(server.name, tool, enabled) },
                    onEdit = { editServer = server },
                    onProbe = { controller.probeMcp() },
                )
            }
            state.error?.let { error ->
                Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                    TextButton(onClick = controller::clearError) { Text("Скрыть") }
                }
            }
        }
    }

    if (addServer || editServer != null) {
        McpServerDialog(
            server = editServer,
            onDismiss = { addServer = false; editServer = null },
            onSave = { name, url, command, args ->
                controller.saveServer(name, url, command, args)
                addServer = false; editServer = null
            },
            onRemove = editServer?.let { server ->
                { controller.removeServer(server.name); editServer = null }
            },
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
