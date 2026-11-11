package ru.arny.taskbridge.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.api.ModelProbeResult
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.ProviderDraftCheck
import ru.arny.taskbridge.core.api.ProviderStatus
import ru.arny.taskbridge.core.client.settings.ProviderDraftState
import ru.arny.taskbridge.core.client.settings.ProviderEditorState
import ru.arny.taskbridge.core.client.settings.providerApis
import ru.arny.taskbridge.core.client.settings.providerEndpoint
import ru.arny.taskbridge.core.client.settings.providerTemplates
import ru.arny.taskbridge.ui.common.AdaptiveSheet
import ru.arny.taskbridge.ui.theme.AppIcons

/**
 * Всё про подключения провайдеров: строка балансов, форма подключения и
 * человеческие подписи ответов сервера.
 *
 * Вынесено из экрана настроек: форма занимает треть файла, а сам экран должно
 * быть можно прочитать как список разделов, не пролистывая поля models.json.
 */

@Composable
internal fun ProviderRow(status: ProviderStatus, refreshing: Boolean, onRefresh: () -> Unit, onUseReset: () -> Unit) {
    var confirmReset by remember { mutableStateOf(false) }
    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("Использовать сброс Codex?") },
            text = { Text("Будет потрачен один доступный кредит сброса лимитов. Отменить расход нельзя. Будет выбран кредит с ближайшим сроком истечения.") },
            confirmButton = { TextButton(onClick = { confirmReset = false; onUseReset() }, enabled = !refreshing) { Text("Использовать сброс") } },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Отмена") } },
        )
    }
    Row(
        Modifier.fillMaxWidth().clickable(enabled = !refreshing, onClick = onRefresh).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(status.label ?: status.provider ?: "Провайдер", style = MaterialTheme.typography.bodyMedium)
            Text(providerStatusText(status), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (status.provider == "openai-codex" && (status.resetCredits?.available ?: 0) > 0) {
                TextButton(onClick = { confirmReset = true }, enabled = !refreshing && status.available && !status.stale) {
                    Text(if (refreshing) "Выполняется…" else "Использовать сброс")
                }
            }
            // Расход и токены — отдельной строкой: темп, факт месяца и свежесть
            // истории в одну строку с балансом уже не помещаются.
            providerUsageDetail(status)?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        else Icon(AppIcons.Refresh, "Обновить данные провайдера", Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun providerStatusText(status: ProviderStatus): String {
    if (!status.available) return when (status.reason) {
        "no-key" -> "Ключ не настроен"
        "no-auth" -> "Вход Codex не найден"
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
    if (status.limits.isNotEmpty()) {
        val fiveHour = status.limits["fiveHour"]?.remainingPercent?.let { "5 ч: ${number(it)}%" }
        val weekly = status.limits["weekly"]?.remainingPercent?.let { "7 дн.: ${number(it)}%" }
        val credits = status.resetCredits?.available?.let { "сбросов: $it" }
        return listOfNotNull(fiveHour, weekly, credits).joinToString(" · ").ifBlank { "Данные получены" } + stale
    }
    return "Данные получены$stale"
}

/** Ответ сервера на проверку черновика — то, что человек должен прочитать перед записью. */
internal fun providerDraftText(result: ProviderDraftCheck): String = when (result.status) {
    "AVAILABLE" -> "Адрес отвечает: моделей ${result.models.size}${result.latencyMs?.let { " · $it мс" }.orEmpty()}"
    "NO_KEY" -> result.note ?: "Переменной окружения нет в процессе сервера — проверка не делалась"
    "REDIRECT" -> "Адрес отвечает редиректом; TaskBridge по нему не идёт"
    "UNAUTHORIZED" -> "Провайдер отклонил ключ (HTTP ${result.httpStatus ?: 401})"
    "RATE_LIMITED" -> "Провайдер ограничил запросы (HTTP ${result.httpStatus ?: 429})"
    else -> listOfNotNull(
        if (result.ok) "Ответ получен" else "Не проверено",
        result.httpStatus?.let { "HTTP $it" },
        result.note,
        result.code,
    ).joinToString(" · ")
}


/**
 * Можно ли нажать «Сохранить».
 *
 * Условие совпадает с тем, что проверит `SettingsController.saveProviderEditor`
 * (`editor.ready`), иначе кнопка включается, а сохранение молча выходит. Для
 * существующей записи адрес, протокол и ключ уже пришли из профиля — правятся
 * только модели; прежнее `!editor.existing` выключало кнопку навсегда, и убрать
 * модель из подключения было нельзя вовсе.
 */
internal fun providerSaveEnabled(editor: ProviderEditorState, working: Boolean): Boolean =
    !working && editor.ready

/** Строка сводки в форме: подпись и значение без полей ввода. */
@Composable
private fun SummaryLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(88.dp),
        )
        Text(value, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
    }
}

/**
 * Форма подключения: адрес, имя переменной с ключом и модели.
 *
 * «Проверить и показать модели» пишет НИЧЕГО: сервер сначала отвечает каталогом
 * `GET /models`, и только отмеченные ID отправляются сохранением вместе с
 * ревизией models.json.
 */
@Composable
internal fun ProviderEditorDialog(
    editor: ProviderEditorState,
    draft: ProviderDraftState?,
    busy: String?,
    onChange: (ProviderEditorState) -> Unit,
    onDraftCheck: () -> Unit,
    onAddModel: (String) -> Unit,
    onRemoveModel: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
    /** Куда уйти за полным JSON записи; null — экран не умеет его показывать. */
    onOpenRaw: (() -> Unit)? = null,
) {
    val working = busy != null || draft?.loading == true
    // Форма была AlertDialog с жёсткой высотой 460 dp: на телефоне в неё не влезали
    // ни поля, ни найденный каталог моделей, да ещё клавиатура закрывала низ.
    // AdaptiveSheet — тот же лист, что у выбора модели и новой сессии: на телефоне
    // во весь экран (с imePadding), на десктопе центрированное окно.
    AdaptiveSheet(
        title = if (editor.existing) "Подключение" else "Новое подключение",
        subtitle = editor.id.takeIf { it.isNotBlank() },
        onDismiss = { if (!working) onDismiss() },
        footer = {
            TextButton(onClick = onDismiss, enabled = !working) { Text("Закрыть") }
            TextButton(onClick = onSave, enabled = providerSaveEnabled(editor, working)) {
                Text(if (busy != null) "Сохранение…" else "Сохранить")
            }
        },
    ) {
        Column(
            Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (editor.existing) {
                // Адрес, протокол и ключ такой записи TaskBridge не меняет, поэтому
                // четыре заблокированных поля только растягивали форму: здесь три
                // строки сводки, а правятся название и модели ниже.
                OutlinedTextField(
                    editor.name,
                    { onChange(editor.copy(name = it)) },
                    label = { Text("Название подключения") },
                    placeholder = { Text(editor.id) },
                    singleLine = true,
                    enabled = !working,
                    supportingText = { Text("ID записи: ${editor.id}") },
                )
                SummaryLine("Адрес", editor.baseUrl.ifBlank { "—" })
                SummaryLine("Протокол", providerApis[editor.api] ?: editor.api)
                SummaryLine(
                    "Ключ",
                    if (editor.keyEnv.isBlank()) "без ключа (локальный адрес)" else "переменная ${editor.keyEnv}",
                )
                if (onOpenRaw != null) {
                    TextButton(onClick = onOpenRaw, enabled = !working) { Text("Открыть RAW JSON") }
                }
            } else {
                // Человек пишет название; ID записи `models.json` выводится из него,
                // поэтому правило слага ему знать не нужно.
                OutlinedTextField(
                    editor.name,
                    { onChange(editor.copy(name = it)) },
                    label = { Text("Название подключения") },
                    placeholder = { Text("Например: мой DeepSeek") },
                    singleLine = true,
                    enabled = !working,
                    supportingText = { Text("Запись в models.json: ${editor.id}") },
                )
            }
            if (editor.existing) {
                Text(
                    "Адрес, протокол и ключ существующего подключения TaskBridge не меняет — меняется только список моделей.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text("Шаблон подключения", style = MaterialTheme.typography.labelLarge)
                // Чип, который ничего не делает, выглядит рабочим: пока идёт запрос,
                // он выключен, а не просто игнорирует нажатие.
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    providerTemplates.forEach { template ->
                        FilterChip(
                            selected = editor.baseUrl == template.baseUrl,
                            enabled = !working,
                            onClick = {
                                // Локальный сервер (llama.cpp / Ollama / LM Studio) почти всегда
                                // умеет thinking, облачный — не обязательно.
                                onChange(editor.copy(
                                    name = template.label,
                                    baseUrl = template.baseUrl,
                                    keyEnv = template.keyEnv,
                                    api = template.api,
                                    thinking = providerEndpoint(template.baseUrl)?.local == true,
                                ))
                            },
                            label = { Text(template.label) },
                        )
                    }
                }
                OutlinedTextField(
                    editor.baseUrl,
                    { onChange(editor.copy(baseUrl = it)) },
                    label = { Text("Адрес API") },
                    placeholder = { Text("127.0.0.1:8083/v1 или https://provider.example/v1") },
                    singleLine = true,
                    enabled = !working,
                    supportingText = { Text(providerEndpoint(editor.baseUrl)?.let { endpoint ->
                        "${endpoint.baseUrl} — ${if (endpoint.local) "локальный/LAN, ключ может быть пустым" else "публичный HTTPS, нужен ключ"}. Это адрес компьютера сервера TaskBridge."
                    } ?: "Можно ввести без http://. Локальный HTTP разрешён только для localhost и приватных адресов.") },
                    isError = editor.baseUrl.isNotBlank() && providerEndpoint(editor.baseUrl) == null,
                )
                Text("Протокол API", style = MaterialTheme.typography.labelLarge)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    providerApis.forEach { (api, label) ->
                        FilterChip(selected = editor.api == api, enabled = !working, onClick = { onChange(editor.copy(api = api)) }, label = { Text(label) })
                    }
                }
                OutlinedTextField(
                    editor.keyEnv,
                    { onChange(editor.copy(keyEnv = it)) },
                    label = { Text("Переменная окружения с ключом") },
                    placeholder = { Text("MY_PROVIDER_API_KEY") },
                    singleLine = true,
                    enabled = !working,
                )
                Text(
                    "Только имя переменной, не сам ключ. Для локального API без ключа оставьте поле пустым.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                // Без этих полей новая модель в models.json не умеет размышлять:
                // Pi отдаёт ей один уровень «off», и выбор в сессии пишет «None».
                Row(
                    Modifier.fillMaxWidth().clickable { if (!working) onChange(editor.copy(thinking = !editor.thinking)) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Модель умеет размышлять", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            "Новым моделям сразу записываются reasoning, thinkingLevelMap и compat (chat-template) — отключите для моделей без thinking.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.width(12.dp))
                    Switch(checked = editor.thinking, enabled = !working, onCheckedChange = { onChange(editor.copy(thinking = it)) })
                }
            }
            if (editor.existing) {
                Text(
                    "Модели (текущий список провайдера; отмеченные красным будут убраны после сохранения)",
                    style = MaterialTheme.typography.labelLarge,
                )
                editor.modelIds.forEach { id ->
                    val pendingRemoval = id in editor.removedModelIds
                    Row(
                        Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            id,
                            style = MaterialTheme.typography.bodySmall.copy(
                                color = if (pendingRemoval) MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                                textDecoration = if (pendingRemoval) TextDecoration.LineThrough else TextDecoration.None,
                            ),
                            modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        IconButton(onClick = { onRemoveModel(id) }, enabled = !working && !pendingRemoval) {
                            Icon(
                                AppIcons.Delete,
                                if (pendingRemoval) "Вернуть модель $id" else "Убрать модель $id",
                                Modifier.size(18.dp),
                            )
                        }
                    }
                }
            } else {
                OutlinedTextField(
                    editor.models,
                    { onChange(editor.copy(models = it)) },
                    label = { Text("ID моделей, по одному в строке") },
                    minLines = 3,
                    enabled = !working,
                )
            }
            OutlinedButton(
                onClick = onDraftCheck,
                enabled = !working && editor.baseUrl.isNotBlank(),
            ) {
                if (draft?.loading == true) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Icon(AppIcons.Search, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Проверить и показать модели")
            }
            val status = draft?.error ?: draft?.result?.let(::providerDraftText)
            if (status != null) {
                Text(
                    status,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (draft?.error == null && draft?.result?.ok == true) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                )
            }
            val discovered = draft?.result?.models.orEmpty()
            if (discovered.isNotEmpty()) {
                Text("Найдено у провайдера: ${discovered.size}", style = MaterialTheme.typography.labelLarge)
                val query = editor.query.trim().lowercase()
                val visible = if (query.isEmpty()) discovered else discovered.filter { model ->
                    model.id.lowercase().contains(query) || model.name?.lowercase()?.contains(query) == true
                }
                if (discovered.size > 8) {
                    OutlinedTextField(
                        editor.query,
                        { onChange(editor.copy(query = it)) },
                        label = { Text("Поиск по ID") },
                        singleLine = true,
                    )
                }
                if (visible.isEmpty()) Text("Ничего не найдено", style = MaterialTheme.typography.bodySmall)
                // Каталог — в собственной прокрутке: раньше 60 строк в общей прокрутке
                // формы уводили поля ввода далеко вверх и теряли контекст.
                Column(
                    Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    visible.take(60).forEach { model ->
                        val added = model.id in editor.modelIds
                        Row(
                            Modifier.fillMaxWidth().clickable(enabled = !added && !working) { onAddModel(model.id) },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(if (added) AppIcons.Check else AppIcons.Add, null, Modifier.size(16.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(
                                model.id,
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                                color = if (added) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                            )
                            model.contextWindow?.let { context ->
                                Text("$context", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                if (visible.size > 60) {
                    Text(
                        "Показаны первые 60 из ${visible.size} — уточните поиск.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

internal fun modelProbeResultText(result: ModelProbeResult): String {
    if (result.ok) {
        val cost = if ((result.tokensUsed ?: 0) > 0) "${result.tokensUsed} токен" else "без токенов"
        return "${result.ms ?: 0} мс · $cost"
    }
    return when (result.code) {
        "COOLDOWN" -> "Повтор через ${maxOf(1, ((result.retryInMs ?: 0) + 999) / 1000)} с"
        "TIMEOUT" -> "Провайдер не ответил вовремя"
        "AUTH" -> "Провайдер отклонил ключ (401)"
        "RATE_LIMITED" -> "Провайдер ограничил запросы (429)"
        "MODEL_NOT_FOUND" -> "Провайдер не знает такую модель"
        "MODEL_UNKNOWN" -> result.message ?: "Модель не описана у провайдера"
        "NO_KEY" -> result.message ?: "Нет ключа провайдера"
        "NO_ENDPOINT" -> result.message ?: "Нет адреса провайдера"
        "PROVIDER_ERROR" -> "Провайдер ответил ошибкой: ${result.message ?: "без подробностей"}"
        "UNREACHABLE" -> "Провайдер недоступен"
        "NO_STREAM" -> "Провайдер не прислал ни одного токена"
        "HTTP_ERROR" -> listOfNotNull(
            "HTTP ${result.httpStatus ?: "ошибка"}",
            result.message,
        ).joinToString(": ")
        else -> result.message ?: result.code ?: "Отказ без объяснения"
    }
}

/**
 * Строки «провайдер — сколько моделей» для настроек: тот же признак, что у
 * пикера моделей ([modelGroups][ru.arny.taskbridge.ui.sessions.modelGroups]), но
 * в виде счётчика. Провайдеры одной машины (`strata-iq2`, `strata-iq3`,
 * `strata-iq3s` — три кванта одной установки Strata на одном ПК) показываются
 * ОДНОЙ строкой, иначе список провайдеров выглядит как три разных движка.
 *
 * Сводим только модели с флагом `local` (его ставит сервер по `localRuntime`),
 * и только по первому дефису имени: облачный провайдер не сливается — у него имя
 * провайдера это имя аккаунта, и склеивать `x-y` с `x-z` там нельзя.
 */
internal fun providerModelCounts(models: List<ModelRef>): List<Pair<String, Int>> =
    models.groupingBy(::providerRowLabel)
        .eachCount()
        .toList()
        .sortedWith(compareByDescending<Pair<String, Int>> { it.second }.thenBy { it.first })

/** Имя строки провайдера: у локальных — до первого дефиса (`strata-iq3s` → `strata`). */
internal fun providerRowLabel(model: ModelRef): String {
    val provider = model.provider ?: return "другие"
    if (!model.local) return provider
    val prefix = provider.substringBefore('-')
    return prefix.ifEmpty { provider }
}
