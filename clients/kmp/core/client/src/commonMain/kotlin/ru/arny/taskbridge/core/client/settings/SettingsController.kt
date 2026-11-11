package ru.arny.taskbridge.core.client.settings

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import ru.arny.taskbridge.core.api.McpStatus
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ModelProfile
import ru.arny.taskbridge.core.api.ModelProbeResult
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.ProviderCheck
import ru.arny.taskbridge.core.api.ProviderDraftCheck
import ru.arny.taskbridge.core.api.ProviderProfile
import ru.arny.taskbridge.core.api.ProviderProfilesPage
import ru.arny.taskbridge.core.api.ProviderStatus
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.humanizeError
import ru.arny.taskbridge.core.client.settings.providerEndpoint

data class ModelProbeState(
    val loading: Boolean = false,
    val result: ModelProbeResult? = null,
    val error: String? = null,
)

/** Проверка ещё не сохранённого адреса (шаги мастера до записи в models.json). */
data class ProviderDraftState(
    val loading: Boolean = false,
    val result: ProviderDraftCheck? = null,
    val error: String? = null,
)

/** Состояние черновика редактора подключения: пока не нажато «Сохранить», файл Pi не меняется.
 *
 * Модель может быть в трёх состояниях: в черновике (добавлена), в списке (только для чтения,
 * берётся из сохранённого провайдера), либо помечена к удалению (removedModelIds) — удаляется
 * только вместе с сохранением черновика. Удаление модели из редактора теперь работает через
 * тот же draft, как и добавление: физически модель уходит из models.json только при onSave.
 */
data class ProviderEditorState(
    val existing: Boolean = false,
    /**
     * Название, которое пишет человек. ID записи выводится из него
     * ([providerIdFromName]) — требования к слагу не его забота.
     */
    val name: String = "",
    val id: String = "",
    val baseUrl: String = "",
    val keyEnv: String = "",
    val api: String = "openai-completions",
    /**
     * Новая модель этого подключения умеет размышлять: ей сразу пишутся
     * `reasoning`, `thinkingLevelMap` и `compat`. Без них Pi отдаёт только «off»,
     * и клиент показывает «None» вместо уровней.
     */
    val thinking: Boolean = true,
    /** Модели, добавленные в черновике (текст для редактирования). */
    val models: String = "",
    /** Модели, отмеченные на удаление в черновике — показываются как pending removal;
     * физически удаляются только при сохранении черновика. */
    val removedModelIds: Set<String> = emptySet(),
    val query: String = "",
) {
    /** Итоговый список моделей в черновике: добавленные минус отмеченные на удаление. */
    val modelIds: List<String> get() = (models.lines().map(String::trim).filter(String::isNotBlank) +
        (if (existing) modelIdsFromExisting else emptyList())).distinct() - removedModelIds
    val ready: Boolean get() = providerIdPattern.matches(id.trim()) &&
        providerEndpoint(baseUrl) != null &&
        (keyEnv.isBlank() || Regex("[A-Z][A-Z0-9_]{0,95}").matches(keyEnv.trim())) &&
        (providerEndpoint(baseUrl)?.local == true || keyEnv.isNotBlank()) && modelIds.size in 1..100

    companion object {
        /** Текущие модели сохранённого подключения (только чтение) — берутся из профиля.
         * Заполняются при открытии редактора; используются вычисляемым свойством
         * `modelIds`, чтобы существующие модели отображались как список для чтения. */
        var modelIdsFromExisting: List<String> = emptyList()
    }
}

data class AgentSettingsState(
    val providerStatuses: Map<String, ProviderStatus> = emptyMap(),
    val refreshingProviders: Set<String> = emptySet(),
    val mcp: McpStatus? = null,
    val mcpLoading: Boolean = false,
    val models: ModelCatalog? = null,
    val modelsLoading: Boolean = false,
    val modelProbes: Map<String, ModelProbeState> = emptyMap(),
    /** Подключения Pi из models.json (страница «Провайдеры»): список + ревизия файла. */
    val providerProfiles: List<ProviderProfile> = emptyList(),
    val providerRevision: String = "",
    val providerProfilesLoading: Boolean = false,
    /** ID провайдера, над которым прямо сейчас идёт запись или проверка. */
    val providerBusy: String? = null,
    /** Результат `GET /models` по провайдеру; ключ — ID провайдера. */
    val providerChecks: Map<String, ProviderCheck> = emptyMap(),
    val providerDraft: ProviderDraftState? = null,
    val providerEditor: ProviderEditorState? = null,
    val providerDelete: String? = null,
    /** Что сказать оператору после правки (нужен ли перезапуск сервера, копия файла). */
    val providerNotice: String? = null,
    val error: String? = null,
)

/** Owns the mutable state behind the settings screen; Compose only sends intents. */
class SettingsController(private val api: TaskBridgeApi, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(AgentSettingsState())
    val state = _state.asStateFlow()

    fun syncProviderStatuses(statuses: Map<String, ProviderStatus>) {
        if (statuses.isNotEmpty()) _state.update { it.copy(providerStatuses = it.providerStatuses + statuses) }
    }

    fun loadMcp() = mutateMcp { api.mcp() }
    fun setMcpMode(mode: String) = mutateMcp { api.setMcpMode(mode) }
    fun importMcp() = mutateMcp { api.importMcp() }
    fun setServer(name: String, enabled: Boolean) = mutateMcp { api.setMcpServer(name, enabled) }
    fun setTool(server: String, tool: String, enabled: Boolean) = mutateMcp { api.setMcpTool(server, tool, enabled) }
    fun probeMcp(server: String? = null) = mutateMcp { api.probeMcp(server) }
    fun saveServer(name: String, url: String?, command: String?, args: List<String>) = mutateMcp { api.saveMcpServer(name, url, command, args) }
    fun removeServer(name: String) = mutateMcp { api.removeMcpServer(name) }

    fun refreshProvider(provider: String) {
        if (provider in _state.value.refreshingProviders) return
        _state.update { it.copy(refreshingProviders = it.refreshingProviders + provider, error = null) }
        scope.launch {
            runCatching { api.refreshProvider(provider) }
                .onSuccess { statuses -> _state.update { it.copy(providerStatuses = it.providerStatuses + statuses) } }
                .onFailure { failure -> _state.update { it.copy(error = humanizeError(failure.message)) } }
            _state.update { it.copy(refreshingProviders = it.refreshingProviders - provider) }
        }
    }

    fun useCodexReset() {
        val provider = "openai-codex"
        if (provider in _state.value.refreshingProviders) return
        _state.update { it.copy(refreshingProviders = it.refreshingProviders + provider, error = null) }
        val hex = List(32) { "0123456789abcdef"[kotlin.random.Random.nextInt(16)] }.joinToString("")
        val requestId = "${hex.take(8)}-${hex.substring(8, 12)}-4${hex.substring(13, 16)}-a${hex.substring(17, 20)}-${hex.substring(20)}"
        scope.launch {
            runCatching { api.useCodexReset(requestId) }
                .onSuccess { statuses -> _state.update { it.copy(providerStatuses = it.providerStatuses + statuses,
                    providerNotice = "Кредит сброса использован. Лимиты запрошены заново.") } }
                .onFailure { failure -> _state.update { it.copy(error = humanizeError(failure.message)) } }
            _state.update { it.copy(refreshingProviders = it.refreshingProviders - provider) }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }

    // --- Провайдеры Pi (страница «Провайдеры»): списком владеет сервер, здесь только намерения.
    // Ревизия models.json передаётся в каждую правку: сервер откажет писать поверх
    // изменения, сделанного пока человек открыта форма (CONFLICT), а не затрёт его.

    fun loadProviderProfiles() {
        if (_state.value.providerProfilesLoading || _state.value.providerBusy != null) return
        _state.update { it.copy(providerProfilesLoading = true, error = null) }
        scope.launch {
            runCatching { api.providerProfiles() }
                .onSuccess { page -> _state.update { it.copy(providerProfiles = page.providers, providerRevision = page.revision) } }
                .onFailure { failure -> _state.update { it.copy(error = humanizeError(failure.message)) } }
            _state.update { it.copy(providerProfilesLoading = false) }
        }
    }

    fun editProvider(profile: ProviderProfile? = null) {
        if (_state.value.providerBusy != null) return
        ProviderEditorState.modelIdsFromExisting = profile?.models?.map { it.id } ?: emptyList()
        _state.update { it.copy(
            providerEditor = ProviderEditorState(
                // У существующей записи названия не хранится (сервер пишет туда
                // "TaskBridge: <id>"), поэтому в поле показывается сам ID — только чтение.
                existing = profile != null,
                // Только настоящее имя записи: подставлять сюда ID нельзя — при
                // сохранении он попал бы в `name` и стал виден в Pi как название.
                name = profile?.name.orEmpty(),
                id = profile?.id.orEmpty(),
                baseUrl = profile?.baseUrl.orEmpty(), keyEnv = profile?.keyEnv.orEmpty(),
                api = profile?.api ?: "openai-completions",
                models = profile?.models?.joinToString("\n") { model -> model.id }.orEmpty(),
            ), providerDraft = null, providerNotice = null, error = null,
        ) }
    }

    fun updateProviderEditor(editor: ProviderEditorState) {
        if (_state.value.providerBusy != null || _state.value.providerDraft?.loading == true) return
        // ID новой записи выводится из названия здесь, а не в форме: иначе каждая
        // правка подписи должна была бы помнить о правиле ID отдельно.
        val named = if (editor.existing) editor else editor.copy(
            id = providerIdFromName(editor.name, _state.value.providerProfiles.map { it.id }),
        )
        _state.update { state -> state.copy(
            providerEditor = named,
            providerDraft = if (state.providerEditor?.baseUrl != named.baseUrl || state.providerEditor?.keyEnv != named.keyEnv) null else state.providerDraft,
        ) }
    }

    fun closeProviderEditor() {
        if (_state.value.providerBusy == null && _state.value.providerDraft?.loading != true)
            _state.update { it.copy(providerEditor = null, providerDraft = null) }
    }

    /** Добавить модель в черновик — без записи в models.json. Если модель была помечена на
     * удаление, она возвращается в список. */
    fun addDiscoveredModel(id: String) {
        val editor = _state.value.providerEditor ?: return
        if (id in editor.removedModelIds) return
        if (editor.modelIds.size >= 100 || id in editor.modelIds) return
        updateProviderEditor(editor.copy(models = (editor.modelIds + id).joinToString("\n")))
    }

    /** Пометить модель на удаление в черновике: она исчезает из выбора, но остаётся в
     * models.json до момента сохранения черновика. Удаление из редактора теперь работает
     * так же, как добавление — через единый draft, а не прямым изменением сохранённого файла.
     */
    fun removeModelFromDraft(id: String) {
        val editor = _state.value.providerEditor ?: return
        if (id !in editor.modelIds) return
        updateProviderEditor(editor.copy(
            models = editor.modelIds.filterNot { it == id }.joinToString("\n"),
            removedModelIds = editor.removedModelIds + id,
        ))
    }

    fun requestProviderDelete(id: String?) {
        if (_state.value.providerBusy == null) _state.update { it.copy(providerDelete = id) }
    }

    fun saveProviderEditor() {
        val editor = _state.value.providerEditor ?: return
        if (!editor.ready || _state.value.providerDraft?.loading == true) return
        saveProviderProfile(
            editor.id.trim(),
            editor.baseUrl.trim(),
            editor.keyEnv.trim(),
            editor.modelIds,
            modelDefaults = if (editor.thinking) THINKING_MODEL_DEFAULTS else null,
            // Имя отправляется и для существующей записи: иначе переименовать её
            // можно было бы только правкой models.json руками.
            name = editor.name.trim().takeIf { it.isNotBlank() },
        )
    }

    fun saveProviderProfile(
        id: String,
        baseUrl: String,
        keyEnv: String,
        models: List<String>,
        modelDefaults: JsonObject? = null,
        name: String? = null,
    ) =
        mutateProvider(id) {
            api.saveProviderProfile(
                _state.value.providerRevision, id, baseUrl, keyEnv, models,
                _state.value.providerEditor?.api ?: "openai-completions", modelDefaults, name,
            ) to "Сохранено. Каталог моделей обновлён; для нового API-ключа перезапусти сервер на компьютере."
        }

    fun removeProviderModels(id: String, models: List<String>) =
        mutateProvider(id) {
            api.removeProviderModels(id, models, _state.value.providerRevision) to
                "Модели убраны из $id; копия models.json сохранена рядом. Работающую сессию это не переключит."
        }

    fun deleteProviderProfile(id: String) = mutateProvider(id) {
        api.deleteProviderProfile(id, _state.value.providerRevision) to
            "Провайдер удалён, оригинальный models.json сохранён в копии."
    }

    /** Проверка сохранённого провайдера: адрес берёт сервер, поэтому доступна и для чужих записей. */
    fun checkProviderConnection(id: String, modelId: String? = null) {
        if (_state.value.providerBusy != null) return
        _state.update { it.copy(providerBusy = id, error = null) }
        scope.launch {
            runCatching { api.checkProviderConnection(id, modelId) }
                .onSuccess { check -> _state.update { it.copy(providerChecks = it.providerChecks + (id to check)) } }
                .onFailure { failure -> _state.update { it.copy(error = humanizeError(failure.message)) } }
            _state.update { if (it.providerBusy == id) it.copy(providerBusy = null) else it }
        }
    }

    /** Проверка черновика до сохранения: черновик в файл не пишется, отдаётся каталог моделей. */
    fun checkProviderDraft(baseUrl: String, keyEnv: String) {
        if (_state.value.providerDraft?.loading == true || _state.value.providerBusy != null) return
        _state.update { it.copy(providerDraft = ProviderDraftState(loading = true), error = null) }
        scope.launch {
            runCatching { api.providerDraftCheck(baseUrl, keyEnv, _state.value.providerEditor?.api ?: "openai-completions") }
                .onSuccess { result -> _state.update { it.copy(providerDraft = ProviderDraftState(result = result)) } }
                .onFailure { failure ->
                    _state.update { it.copy(providerDraft = ProviderDraftState(error = humanizeError(failure.message))) }
                }
        }
    }

    fun clearProviderDraft() = _state.update { it.copy(providerDraft = null) }

    fun clearProviderNotice() = _state.update { it.copy(providerNotice = null) }

    /** Одна правка models.json за раз: параллельная запись потеряла бы ревизию. */
    private fun mutateProvider(id: String, request: suspend () -> Pair<ProviderProfilesPage, String>) {
        if (_state.value.providerBusy != null || _state.value.providerProfilesLoading || _state.value.providerRevision.isBlank()) return
        _state.update { it.copy(providerBusy = id, providerNotice = null, error = null) }
        scope.launch {
            runCatching { request() }
                .onSuccess { (page, notice) ->
                    _state.update {
                        it.copy(
                            providerProfiles = page.providers,
                            providerRevision = page.revision,
                            providerNotice = notice,
                            providerEditor = null,
                            providerDraft = null,
                            providerDelete = null,
                        )
                    }
                }
                .onFailure { failure -> _state.update { it.copy(error = humanizeError(failure.message)) } }
            _state.update { if (it.providerBusy == id) it.copy(providerBusy = null) else it }
            if (_state.value.providerNotice != null) loadModels(refresh = true)
        }
    }

    fun probeModel(model: ModelRef) {
        val provider = model.provider?.takeIf(String::isNotBlank) ?: return
        val id = model.id?.takeIf(String::isNotBlank) ?: return
        val key = model.key
        if (_state.value.modelProbes[key]?.loading == true) return
        _state.update {
            it.copy(modelProbes = it.modelProbes + (key to ModelProbeState(loading = true)))
        }
        scope.launch {
            runCatching { api.probeModel(provider, id) }
                .onSuccess { result ->
                    _state.update { state ->
                        state.copy(modelProbes = state.modelProbes + (key to ModelProbeState(result = result)))
                    }
                }
                .onFailure { failure ->
                    _state.update { state ->
                        state.copy(modelProbes = state.modelProbes + (key to ModelProbeState(error = humanizeError(failure.message))))
                    }
                }
        }
    }

    fun loadModels(refresh: Boolean = false) {
        if (_state.value.modelsLoading) return
        _state.update { it.copy(modelsLoading = true, error = null) }
        scope.launch {
            runCatching { api.models(refresh) }
                .onSuccess { models -> _state.update { it.copy(models = models) } }
                .onFailure { failure -> _state.update { it.copy(error = humanizeError(failure.message)) } }
            _state.update { it.copy(modelsLoading = false) }
        }
    }

    private fun mutateMcp(request: suspend () -> McpStatus) {
        if (_state.value.mcpLoading) return
        _state.update { it.copy(mcpLoading = true, error = null) }
        scope.launch {
            runCatching { request() }
                .onSuccess { status -> _state.update { it.copy(mcp = status) } }
                .onFailure { failure -> _state.update { it.copy(error = humanizeError(failure.message)) } }
            _state.update { it.copy(mcpLoading = false) }
        }
    }
}
