package ru.arny.taskbridge.ui.models

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.client.settings.ModelRawDraft
import ru.arny.taskbridge.core.client.settings.ProviderRawDraft
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.MonoStyle
import ru.arny.taskbridge.ui.common.AdaptiveSheet
import ru.arny.taskbridge.ui.settings.ProviderDialogs
import ru.arny.taskbridge.ui.settings.modelProbeResultText
import ru.arny.taskbridge.core.client.settings.ModelProbeState

/**
 * Редактор models.json — аналог Pi Manager.
 *
 * Слева (на телефоне — сверху) провайдеры и их модели; по тапу на модель
 * открывается карточка: вкладки «Модель» / «RAW JSON», быстрые пресеты
 * контекста и выхода, поля `name`, `contextWindow`, `maxTokens`, `api`,
 * `reasoning`, `input`, вложенные `samplingParams` / `thinkingLevelMap` /
 * `compat` — строками `ключ=значение`, и кнопки Test / Copy / Delete / Save.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PiModelsScreen(graph: AppGraph, connection: AppGraph.Connected, onBack: () -> Unit, onOpenLocalModels: () -> Unit) {
    val controller = connection.piModelsController
    val state by controller.state.collectAsState()
    var query by rememberSaveable { mutableStateOf("") }
    var providerDialog by remember { mutableStateOf(false) }
    var expandedProvider by rememberSaveable { mutableStateOf<String?>(null) }
    var providerToDelete by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { if (state.providers.isEmpty()) controller.load() }
    // Ревизия models.json нужна форме подключения: сохранение без неё сервер
    // не принимает, и без этой загрузки кнопка «Сохранить» молча ничего не делала бы.
    LaunchedEffect(Unit) { connection.settingsController.loadProviderProfiles() }

    val visible = state.providers.filter { provider ->
        val text = query.trim()
        text.isEmpty() || provider.id.contains(text, true) ||
            provider.name?.contains(text, true) == true || provider.models.any { it.id.contains(text, true) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Модели Pi") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад") } },
                actions = {
                    // Добавить подключение можно здесь же: это тот же models.json, и
                    // раньше за этим приходилось уходить в «Настройки».
                    IconButton(
                        onClick = { connection.settingsController.editProvider() },
                        enabled = !state.saving && !state.loading,
                    ) {
                        Icon(AppIcons.Add, "Добавить подключение")
                    }
                    TextButton(onClick = onOpenLocalModels) { Text("Локальные") }
                    IconButton(onClick = { controller.load() }, enabled = !state.loading) {
                        Icon(AppIcons.Refresh, "Обновить")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Text(
                "~/.pi/agent/models.json · правится любая запись, с резервной копией",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
            )
            OutlinedTextField(
                query,
                { query = it },
                label = { Text("Поиск провайдера или модели") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            )
            state.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp))
            }
            state.notice?.let {
                Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp))
            }
            if (state.loading && state.providers.isEmpty()) {
                Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center) {
                    CircularProgressIndicator(Modifier.size(22.dp))
                }
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(visible, key = { it.id }) { provider ->
                    val expanded = provider.id == expandedProvider
                    val toggleModels: () -> Unit = {
                        if (expanded) expandedProvider = null
                        else {
                            expandedProvider = provider.id
                            controller.openProvider(provider.id)
                        }
                    }
                    Column(Modifier.fillMaxWidth()) {
                        Row(
                            Modifier.fillMaxWidth()
                                .clickable(enabled = !state.saving, onClick = toggleModels)
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                // Человеческое название — заголовком, ID — подписью: искать
                                // «мой шлюз» в списке из одних слагов было невозможно.
                                Text(
                                    provider.name ?: provider.id,
                                    style = MaterialTheme.typography.titleSmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                if (provider.name != null) {
                                    Text(
                                        provider.id,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                Text(
                                    listOfNotNull(
                                        provider.api ?: "api по умолчанию",
                                        "${provider.modelCount} мод.",
                                        if (provider.managed) "TaskBridge" else "вручную",
                                    ).joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            IconButton(
                                onClick = toggleModels,
                                enabled = !state.saving,
                            ) {
                                Icon(
                                    if (expanded) AppIcons.ChevronUp else AppIcons.ChevronDown,
                                    if (expanded) "Свернуть модели ${provider.id}" else "Раскрыть модели ${provider.id}",
                                )
                            }
                            IconButton(onClick = {
                                // Управляемая запись (`tb-*`) правится формой с моделями,
                                // а не сырым JSON: раньше в это место вела только кнопка
                                // на удалённом разделе настроек, и правка сводилась к JSON.
                                if (provider.managed) {
                                    connection.settingsController.editProvider(provider)
                                } else {
                                    controller.openProvider(provider.id)
                                    providerDialog = true
                                }
                            }, enabled = !state.saving && !state.loading) {
                                Icon(AppIcons.Edit, "Запись ${provider.id}", Modifier.size(18.dp))
                            }
                            IconButton(
                                onClick = { providerToDelete = provider.id },
                                enabled = !state.saving && !state.loading,
                            ) {
                                Icon(AppIcons.Delete, "Удалить провайдера ${provider.id}", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error)
                            }
                        }
                        if (expanded && state.selectedProvider == provider.id) {
                            if (state.loading) CircularProgressIndicator(Modifier.padding(12.dp).size(20.dp))
                            state.models.forEach { model ->
                                val modelId = (model["id"] as? JsonPrimitive)?.contentOrNull.orEmpty()
                                val probe = state.modelProbes[provider.id to modelId]
                                Row(
                                    Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column(Modifier.weight(1f)) {
                                        Text(modelId, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        val details = listOfNotNull(
                                            (model["name"] as? JsonPrimitive)?.contentOrNull,
                                            (model["contextWindow"] as? JsonPrimitive)?.contentOrNull?.let { "ctx $it" },
                                            (model["maxTokens"] as? JsonPrimitive)?.contentOrNull?.let { "out $it" },
                                            if ((model["reasoning"] as? JsonPrimitive)?.contentOrNull == "true") "reasoning" else null,
                                        ).joinToString(" · ")
                                        if (details.isNotEmpty()) {
                                            Text(details, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        }
                                        ModelProbeFeedback(probe)
                                    }
                                    TextButton(
                                        onClick = { controller.testModel(modelId) },
                                        enabled = !state.saving && probe?.loading != true,
                                    ) {
                                        if (probe?.loading == true) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                        else Text("Проверить (1 токен)")
                                    }
                                    IconButton(onClick = { controller.openModel(modelId) }) {
                                        Icon(AppIcons.Edit, "Изменить $modelId", Modifier.size(18.dp))
                                    }
                                }
                            }
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
    }

    providerToDelete?.let { id ->
        AlertDialog(
            onDismissRequest = { providerToDelete = null },
            title = { Text("Удалить провайдера $id?") },
            text = { Text("Запись провайдера и все его модели будут удалены из models.json. Резервная копия сохранится рядом. Запущенные сессии не переключатся автоматически; следующий ход может потребовать выбора другой модели.") },
            confirmButton = {
                TextButton(
                    onClick = { providerToDelete = null; controller.deleteProvider(id) },
                    enabled = !state.saving && !state.loading,
                ) { Text("Удалить", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { providerToDelete = null }) { Text("Отмена") } },
        )
    }

    state.modelDraft?.let { draft ->
        ModelCard(
            draft = draft,
            saving = state.saving,
            error = state.error,
            canUndo = state.history.isNotEmpty(),
            probe = state.modelProbes[state.selectedProvider to draft.originalId],
            presets = state.presetsForModel,
            presetName = state.presetName,
            presetBusy = state.presetBusy,
            onChange = controller::updateModelDraft,
            onContextPreset = controller::applyContextPreset,
            onOutputPreset = controller::applyOutputPreset,
            onUndo = controller::undoModel,
            onTest = { controller.testModel(draft.originalId) },
            onDelete = { controller.deleteModel(draft.originalId) },
            rawJson = { controller.modelJson() },
            onApplyRaw = controller::applyModelJson,
            onPresetName = controller::updatePresetName,
            onSavePreset = controller::savePreset,
            onApplyPreset = controller::applyPreset,
            onDeletePreset = controller::deletePreset,
            onSave = controller::saveModel,
            onDismiss = controller::closeModel,
        )
    }

    val providerDraft = state.providerDraft
    if (providerDialog && providerDraft != null) {
        ProviderRawDialog(
            draft = providerDraft,
            saving = state.saving,
            error = state.error,
            onChange = controller::updateProviderDraft,
            onSave = { controller.saveProvider(); providerDialog = false },
            onDismiss = { providerDialog = false },
        )
    }

    // Форма подключения — одна на оба экрана. После закрытия перечитываем список:
    // новая запись появляется в models.json, а не в состоянии этого экрана.
    ProviderDialogs(
        connection,
        onClosed = { controller.load() },
        onOpenRaw = { id ->
            connection.settingsController.closeProviderEditor()
            controller.openProvider(id)
            providerDialog = true
        },
    )
}

/** Карточка модели: вкладки «Модель» и «RAW JSON», как в Pi Manager. */
@Composable
private fun ModelCard(
    draft: ModelRawDraft,
    saving: Boolean,
    error: String?,
    canUndo: Boolean,
    probe: ModelProbeState?,
    presets: List<ru.arny.taskbridge.core.api.ModelProfile>,
    presetName: String,
    presetBusy: Boolean,
    onChange: (ModelRawDraft) -> Unit,
    onContextPreset: (Long) -> Unit,
    onOutputPreset: (Long) -> Unit,
    onUndo: () -> Unit,
    onTest: () -> Unit,
    onDelete: () -> Unit,
    rawJson: () -> String,
    onApplyRaw: (String) -> Unit,
    onPresetName: (String) -> Unit,
    onSavePreset: () -> Unit,
    onApplyPreset: (String) -> Unit,
    onDeletePreset: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    var tab by rememberSaveable { mutableStateOf(0) }
    var raw by remember(draft.originalId) { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    val problem = error ?: draft.validationError
    // Было AlertDialog с heightIn(520): на телефоне это узкое окно, в котором
    // обрезалось поле `id`, а «Сохранить» перекрывало низ. AdaptiveSheet — тот же
    // лист, что у формы подключения: на телефоне во весь экран, на десктопе окно.
    AdaptiveSheet(
        title = draft.originalId,
        onDismiss = { if (!saving) onDismiss() },
        maxWidth = 640,
        // Действия и вкладки закреплены: правка длинной формы не уносит их из виду.
        pinned = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = onTest, enabled = !saving && probe?.loading != true) {
                        Text(if (probe?.loading == true) "Проверяю…" else "Проверить (1 токен)")
                    }
                    TextButton(onClick = { clipboard.setText(AnnotatedString(rawJson())) }) { Text("Copy JSON") }
                    TextButton(onClick = { confirmDelete = true }, enabled = !saving) { Text("Удалить", color = MaterialTheme.colorScheme.error) }
                }
                ModelProbeFeedback(probe)
                TabRow(selectedTabIndex = tab) {
                    Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Модель") })
                    Tab(selected = tab == 1, onClick = { tab = 1; raw = rawJson() }, text = { Text("RAW JSON") })
                }
            }
        },
        footer = {
            if (canUndo) TextButton(onClick = onUndo, enabled = !saving) { Text("Отменить") }
            TextButton(onClick = onDismiss, enabled = !saving) { Text("Закрыть") }
            TextButton(onClick = onSave, enabled = !saving && problem == null) {
                Text(if (saving) "Сохранение…" else "Сохранить")
            }
        },
    ) {
            Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (tab == 0) {
                    Text("Контекст", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf(32_000L, 64_000L, 100_000L, 128_000L, 256_000L).forEach { tokens ->
                            FilterChip(
                                selected = draft.contextWindow == tokens.toString(),
                                onClick = { onContextPreset(tokens) },
                                enabled = !saving,
                                label = { Text("${tokens / 1000}K") },
                            )
                        }
                    }
                    OutlinedTextField(
                        draft.contextWindow,
                        { onChange(draft.copy(contextWindow = it.filter(Char::isDigit))) },
                        label = { Text("contextWindow") }, singleLine = true, enabled = !saving,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("Выход", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf(4_000L, 8_000L, 16_000L, 32_000L).forEach { tokens ->
                            FilterChip(
                                selected = draft.maxTokens == tokens.toString(),
                                onClick = { onOutputPreset(tokens) },
                                enabled = !saving,
                                label = { Text("${tokens / 1000}K") },
                            )
                        }
                    }
                    OutlinedTextField(
                        draft.maxTokens,
                        { onChange(draft.copy(maxTokens = it.filter(Char::isDigit))) },
                        label = { Text("maxTokens") }, singleLine = true, enabled = !saving,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        draft.id, { onChange(draft.copy(id = it)) },
                        label = { Text("id") }, singleLine = true, enabled = !saving,
                        textStyle = MonoStyle, modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        draft.name, { onChange(draft.copy(name = it)) },
                        label = { Text("name") }, singleLine = true, enabled = !saving,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        draft.api, { onChange(draft.copy(api = it)) },
                        label = { Text("api override") }, placeholder = { Text("openai-completions") },
                        singleLine = true, enabled = !saving, modifier = Modifier.fillMaxWidth(),
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(draft.reasoning, { onChange(draft.copy(reasoning = it)) }, enabled = !saving)
                        Text("reasoning")
                    }
                    OutlinedTextField(
                        draft.input, { onChange(draft.copy(input = it)) },
                        label = { Text("input (через запятую)") }, placeholder = { Text("text, image") },
                        singleLine = true, enabled = !saving, modifier = Modifier.fillMaxWidth(),
                    )
                    KeyValueField("samplingParams", draft.samplingParams, saving) { onChange(draft.copy(samplingParams = it)) }
                    KeyValueField("thinkingLevelMap", draft.thinkingLevelMap, saving) { onChange(draft.copy(thinkingLevelMap = it)) }
                    KeyValueField("compat", draft.compat, saving) { onChange(draft.copy(compat = it)) }
                    KeyValueField("настройки TaskBridge", draft.settings, saving) { onChange(draft.copy(settings = it)) }
                    KeyValueField("прочие поля модели", draft.extra, saving) { onChange(draft.copy(extra = it)) }
                    HorizontalDivider(Modifier.padding(vertical = 4.dp))
                    // Пресеты: именованные наборы полей модели в model-profiles.json.
                    // «Применить» только подставляет значения; в models.json они уходят по «Сохранить».
                    Text("Пресеты", style = MaterialTheme.typography.labelLarge)
                    if (presets.isEmpty()) {
                        Text(
                            "Нет. Заполните поля и сохраните набор под именем — например «Быстрый».",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    presets.forEach { preset ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(preset.name, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            TextButton(onClick = { onApplyPreset(preset.id) }, enabled = !saving) { Text("Применить") }
                            IconButton(onClick = { onDeletePreset(preset.id) }, enabled = !saving && !presetBusy) {
                                Icon(AppIcons.Delete, "Удалить пресет ${preset.name}", Modifier.size(18.dp))
                            }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            presetName, onPresetName,
                            label = { Text("Имя пресета") }, singleLine = true, enabled = !saving,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = onSavePreset, enabled = !saving && !presetBusy && presetName.isNotBlank()) {
                            Text("Сохранить")
                        }
                    }
                } else {
                    Text(
                        "Объект модели целиком. «Применить» разложит его по полям формы; «Сохранить» отправит только поля формы.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedTextField(
                        raw, { raw = it },
                        label = { Text("JSON") }, minLines = 10, enabled = !saving,
                        textStyle = MonoStyle, modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { onApplyRaw(raw) }, enabled = !saving) { Text("Применить к полям") }
                        TextButton(onClick = { raw = rawJson() }, enabled = !saving) { Text("Сбросить") }
                    }
                }
                problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Удалить модель?") },
            text = { Text("${draft.originalId} будет удалена из записи провайдера. Резервная копия models.json сохранится рядом.") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; onDelete() }) {
                    Text("Удалить", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Отмена") } },
        )
    }
}

@Composable
private fun ModelProbeFeedback(probe: ModelProbeState?) {
    val text = probe?.result?.let(::modelProbeResultText) ?: probe?.error ?: return
    Text(text, style = MaterialTheme.typography.bodySmall,
        color = if (probe?.result?.ok == true) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
}

/** Вложенный объект строкой `ключ=значение`: читается глазами, без фигурных скобок. */
@Composable
private fun KeyValueField(label: String, value: String, saving: Boolean, onChange: (String) -> Unit) {
    OutlinedTextField(
        value,
        onChange,
        label = { Text(label) },
        placeholder = { Text("ключ=значение, по одному в строке") },
        minLines = 2,
        enabled = !saving,
        textStyle = MonoStyle,
        modifier = Modifier.fillMaxWidth(),
    )
}

/** Форма записи провайдера: адрес, протокол, имя, headers и compat. */
@Composable
private fun ProviderRawDialog(
    draft: ProviderRawDraft,
    saving: Boolean,
    error: String?,
    onChange: (ProviderRawDraft) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() },
        title = { Text("Запись ${draft.id}") },
        text = {
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    draft.baseUrl, { onChange(draft.copy(baseUrl = it)) },
                    label = { Text("baseUrl") }, singleLine = true, enabled = !saving,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    draft.api, { onChange(draft.copy(api = it)) },
                    label = { Text("api") }, singleLine = true, enabled = !saving,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    draft.apiKey, { onChange(draft.copy(apiKey = it)) },
                    label = { Text("apiKey: имя переменной, local или REDACTED") },
                    singleLine = true, enabled = !saving,
                    textStyle = MonoStyle, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    draft.name, { onChange(draft.copy(name = it)) },
                    label = { Text("name") }, singleLine = true, enabled = !saving,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    draft.headers, { onChange(draft.copy(headers = it)) },
                    label = { Text("headers (ключами)") },
                    minLines = 2, enabled = !saving, textStyle = MonoStyle,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    draft.compat, { onChange(draft.copy(compat = it)) },
                    label = { Text("compat (ключами)") },
                    minLines = 2, enabled = !saving, textStyle = MonoStyle,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    draft.extra, { onChange(draft.copy(extra = it)) },
                    label = { Text("прочие поля провайдера (ключами)") },
                    minLines = 2, enabled = !saving, textStyle = MonoStyle,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Модели правятся отдельно: эта форма их не заменяет.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(onClick = onSave, enabled = !saving) { Text(if (saving) "Сохранение…" else "Сохранить") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text("Отмена") } },
    )
}
