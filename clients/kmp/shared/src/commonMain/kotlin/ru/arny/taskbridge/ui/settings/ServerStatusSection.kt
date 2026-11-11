package ru.arny.taskbridge.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ru.arny.taskbridge.core.api.ApiInfo
import ru.arny.taskbridge.core.api.SUPPORTED_API_VERSIONS
import ru.arny.taskbridge.platform.PlatformServices
import ru.arny.taskbridge.ui.common.InfoRow
import ru.arny.taskbridge.ui.theme.AppIcons

/**
 * С чем соединено приложение: адрес, каталог локального сервера и его логи,
 * версия API, версия Pi и занятость роутера llama.cpp.
 *
 * Вынесено из экрана, чтобы «Компьютер» читался как одна карточка, а не как
 * россыпь строк между заголовками: раньше эти же строки оказывались под
 * заголовком «Подключения к провайдерам», и видеокарта выглядела их частью.
 */
@Composable
internal fun ServerStatusSection(
    platform: PlatformServices,
    baseUrl: String,
    online: Boolean,
    info: ApiInfo?,
) {
    val scope = rememberCoroutineScope()
    SettingsCard(title = "Подключение", subtitle = baseUrl) {
        // Локальный сервер приложение поднимает через scripts/start-lan.mjs, то есть из корня
        // репозитория. Автопоиск (от кода приложения и рабочего каталога вверх) обычно его
        // находит, но если рядом репозитория нет — каталог задаётся здесь: без этого запуск
        // локального сервера отвечал «не найден — задайте настройку server.root», а задать её было негде.
        platform.localServerLauncher?.let { launcher ->
            var serverRoot by remember { mutableStateOf(platform.store.get("server.root").orEmpty()) }
            var logs by remember { mutableStateOf<String?>(null) }
            // Поиск корня — это обход файловой системы: считаем вне кадра композиции
            // и заново при смене настройки.
            val found by produceState<String?>(null, serverRoot) {
                value = withContext(Dispatchers.Default) { launcher.root() }
            }
            InfoRow(
                label = "Каталог TaskBridge",
                value = serverRoot.ifBlank { found?.let { "найден: $it" } ?: "не найден" },
                warning = found == null,
            )
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = {
                    platform.chooseProjectFolder()?.let { picked ->
                        platform.store.put("server.root", picked)
                        serverRoot = picked
                    }
                }) { Text("Выбрать каталог…") }
                if (serverRoot.isNotBlank()) {
                    TextButton(onClick = {
                        platform.store.put("server.root", null)
                        serverRoot = ""
                    }) { Text("Сбросить") }
                }
                // Логи сервера живут файлами рядом с данными (data/lan-*.log): при неудачном
                // запуске тост показывает только хвост, а причина — в lan-app.log.
                TextButton(onClick = {
                    scope.launch { logs = withContext(Dispatchers.Default) { launcher.logTail(200) } ?: "Логов пока нет" }
                }) { Text("Логи сервера") }
            }
            logs?.let { text ->
                AlertDialog(
                    onDismissRequest = { logs = null },
                    title = { Text("Логи сервера") },
                    text = {
                        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                            Text(text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                        }
                    },
                    confirmButton = {
                        Row {
                            TextButton(onClick = { platform.copyText(text) }) { Text("Копировать") }
                            TextButton(onClick = { logs = null }) { Text("Закрыть") }
                        }
                    },
                )
            }
        }
        InfoRow(
            label = "Связь",
            value = if (online) "есть" else "нет связи",
            icon = AppIcons.Computer,
            warning = !online,
        )
        InfoRow(label = "TaskBridge", value = info?.name ?: "—")
        InfoRow(label = "Версия API", value = info?.let { "${it.apiVersion} (приложение знает: ${SUPPORTED_API_VERSIONS.joinToString()})" } ?: "—")
        val pi = info?.pi
        // Версия выше верхней границы диапазона — не поломка: Pi 1.5.0 при
        // проверенном «>=0.85.0 <1.5.0» работал, а оранжевая строка читалась
        // как ошибка. Красным помечаем только отсутствие Pi.
        InfoRow(
            label = "Pi",
            value = when {
                pi == null -> "проверяется…"
                pi.version == null -> "не найден${pi.error?.let { ": $it" }.orEmpty()}"
                pi.supported -> "${pi.version} — поддерживается"
                else -> "${pi.version} · новее проверенного диапазона ${pi.supportedRange.orEmpty()}"
            },
            warning = pi != null && pi.version == null,
        )
        // «занята» — это про роутер llama.cpp (там же очередь и KV), а не
        // про внешние серверы вроде Strata: рядом со строкой «iq2-xs ·
        // загружена» она читалась как «никакая модель не занята».
        InfoRow(
            label = "Роутер llama.cpp",
            value = when (info?.modelBusy) {
                true -> "занят — идёт запрос"
                false -> "свободен"
                null -> "нет данных"
            },
        )
    }
}
