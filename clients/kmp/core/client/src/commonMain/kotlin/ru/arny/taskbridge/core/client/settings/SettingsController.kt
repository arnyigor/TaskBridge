package ru.arny.taskbridge.core.client.settings

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.McpStatus
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ModelProbeResult
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.ProviderCheck
import ru.arny.taskbridge.core.api.ProviderDraftCheck
import ru.arny.taskbridge.core.api.ProviderProfile
import ru.arny.taskbridge.core.api.ProviderProfilesPage
import ru.arny.taskbridge.core.api.ProviderStatus
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.humanizeError

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

    fun clearError() = _state.update { it.copy(error = null) }

    // --- Провайдеры Pi (страница «Провайдеры»): списком владеет сервер, здесь только намерения.
    // Ревизия models.json передаётся в каждую правку: сервер откажет писать поверх
    // изменения, сделанного пока человек открыта форма (CONFLICT), а не затрёт его.

    fun loadProviderProfiles() {
        if (_state.value.providerProfilesLoading) return
        _state.update { it.copy(providerProfilesLoading = true, error = null) }
        scope.launch {
            runCatching { api.providerProfiles() }
                .onSuccess { page -> _state.update { it.copy(providerProfiles = page.providers, providerRevision = page.revision) } }
                .onFailure { failure -> _state.update { it.copy(error = humanizeError(failure.message)) } }
            _state.update { it.copy(providerProfilesLoading = false) }
        }
    }

    fun saveProviderProfile(id: String, baseUrl: String, keyEnv: String, models: List<String>) =
        mutateProvider(id) {
            api.saveProviderProfile(_state.value.providerRevision, id, baseUrl, keyEnv, models) to
                "Сохранено. Обнови каталог моделей; для нового API-ключа перезапусти сервер на компьютере."
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
        if (_state.value.providerDraft?.loading == true) return
        _state.update { it.copy(providerDraft = ProviderDraftState(loading = true), error = null) }
        scope.launch {
            runCatching { api.providerDraftCheck(baseUrl, keyEnv) }
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
        if (_state.value.providerBusy != null) return
        _state.update { it.copy(providerBusy = id, providerNotice = null, error = null) }
        scope.launch {
            runCatching { request() }
                .onSuccess { (page, notice) ->
                    _state.update {
                        it.copy(
                            providerProfiles = page.providers,
                            providerRevision = page.revision,
                            providerNotice = notice,
                        )
                    }
                }
                .onFailure { failure -> _state.update { it.copy(error = humanizeError(failure.message)) } }
            _state.update { if (it.providerBusy == id) it.copy(providerBusy = null) else it }
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
