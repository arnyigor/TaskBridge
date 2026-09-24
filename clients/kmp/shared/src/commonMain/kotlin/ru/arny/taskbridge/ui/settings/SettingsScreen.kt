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
import ru.arny.taskbridge.ui.common.SectionTitle
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors

@Composable
fun SettingsScreen(graph: AppGraph, connection: AppGraph.Connected, onBack: () -> Unit, onDisconnected: () -> Unit) {
    val state by connection.sessions.state.collectAsState()
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
                info?.storeId?.let { InfoRow(label = "База", value = it.take(8)) }
                for (warning in info?.warnings.orEmpty()) {
                    InfoRow(label = "Предупреждение", value = warning.message ?: warning.code.orEmpty(), warning = true)
                }

                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                SectionTitle("Это устройство")
                InfoRow(label = "Идентификатор", value = graph.settings.clientId)
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Text("Тема", style = MaterialTheme.typography.bodyMedium)
                    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((mode, label) in listOf("system" to "Как в системе", "light" to "Светлая", "dark" to "Тёмная")) {
                            FilterChip(selected = graph.theme == mode, onClick = { graph.setTheme(mode) }, label = { Text(label) })
                        }
                    }
                }
                if (graph.platform.kind == "desktop") {
                    Row(Modifier.fillMaxWidth().clickable { enterSends = !enterSends; graph.settings.enterSends = enterSends }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Enter отправляет", style = MaterialTheme.typography.bodyMedium)
                            Text("Shift+Enter — новая строка, Ctrl+Enter — прервать и отправить", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
