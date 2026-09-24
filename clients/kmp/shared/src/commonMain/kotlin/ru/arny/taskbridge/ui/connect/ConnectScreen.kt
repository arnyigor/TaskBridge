package ru.arny.taskbridge.ui.connect

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.client.session.describe
import ru.arny.taskbridge.core.client.settings.ConnectResult
import ru.arny.taskbridge.core.client.settings.checkConnection
import ru.arny.taskbridge.core.client.settings.normalizeServerUrl
import ru.arny.taskbridge.ui.theme.AppIcons

/**
 * First run (and after «Отключиться»): the address of TaskBridge on the PC,
 * then — only if the server has pairing on — the code it shows.
 */
@Composable
fun ConnectScreen(graph: AppGraph, onConnected: () -> Unit) {
    val scope = rememberCoroutineScope()
    // Desktop: the daemon is on this machine, so the default address is known and prefilled.
    // Android: the PC's address is not discoverable, the field stays empty (the placeholder is an example).
    var address by remember {
        mutableStateOf(graph.settings.serverUrl ?: if (graph.platform.kind == "desktop") "127.0.0.1:8787" else "")
    }
    var code by remember { mutableStateOf("") }
    var needsCode by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun submit() {
        val url = normalizeServerUrl(address)
        if (url == null) {
            error = "Адрес выглядит неправильно. Пример: 192.168.1.10:8787"
            return
        }
        busy = true
        error = null
        scope.launch {
            val api = graph.probe(url)
            try {
                if (needsCode && code.isNotBlank()) api.pair(code)
                when (val result = checkConnection(api)) {
                    is ConnectResult.Ready -> {
                        graph.connect(url)
                        onConnected()
                    }
                    is ConnectResult.NeedsPairing -> {
                        if (needsCode && code.isNotBlank()) error = "Код не подошёл — проверьте его на компьютере."
                        needsCode = true
                    }
                    is ConnectResult.Unsupported -> error = "TaskBridge на компьютере говорит на версии API ${result.serverVersion}, а приложение знает только 1. Обновите приложение."
                    is ConnectResult.Failed -> error = result.message
                }
            } catch (failure: ApiException) {
                error = describe(failure.error)
            } finally {
                busy = false
            }
        }
    }

    Box(Modifier.fillMaxSize().systemBarsPadding().imePadding(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 460.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                Modifier.size(72.dp).clip(RoundedCornerShape(22.dp)).background(MaterialTheme.colorScheme.primary),
                contentAlignment = Alignment.Center,
            ) {
                Icon(AppIcons.Terminal, null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(36.dp))
            }
            Spacer(Modifier.height(20.dp))
            Text("TaskBridge", style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(8.dp))
            Text(
                "Пульт агента на вашем компьютере: сессии, живой чат, подтверждения и STOP — с телефона или другого ПК.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(28.dp))
            OutlinedTextField(
                value = address,
                onValueChange = { address = it; error = null },
                label = { Text("Адрес TaskBridge") },
                placeholder = { Text("192.168.1.10:8787") },
                leadingIcon = { Icon(AppIcons.Computer, null) },
                singleLine = true,
                enabled = !busy,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = if (needsCode) ImeAction.Next else ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { submit() }),
                modifier = Modifier.fillMaxWidth(),
            )
            if (needsCode) {
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.filter { c -> !c.isWhitespace() }; error = null },
                    label = { Text("Код подключения") },
                    supportingText = { Text("Откройте TaskBridge на компьютере — код показан в окне входа.") },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { submit() }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (error != null) {
                Spacer(Modifier.height(12.dp))
                Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(AppIcons.Alert, null, tint = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(10.dp))
                        Text(error.orEmpty(), color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
            Button(onClick = { submit() }, enabled = !busy && address.isNotBlank(), modifier = Modifier.fillMaxWidth().height(50.dp)) {
                if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Text(if (needsCode) "Подключить устройство" else "Подключиться")
            }
            Spacer(Modifier.height(24.dp))
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Hint("Компьютер и это устройство должны быть в одной сети (или в одной VPN, например Tailscale).")
                Hint("Адрес печатает `taskbridge status`; порт по умолчанию — 8787.")
                Hint("Если на компьютере включён вход по коду, приложение попросит его на следующем шаге.")
            }
            if (needsCode) {
                TextButton(onClick = { needsCode = false; code = "" }) { Text("Изменить адрес") }
            }
        }
    }
}

@Composable
private fun Hint(text: String) {
    Row {
        Text("•  ", color = MaterialTheme.colorScheme.primary)
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
