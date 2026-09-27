package ru.arny.taskbridge.core.client.settings

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.McpStatus
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ProviderStatus
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.humanizeError

data class AgentSettingsState(
    val providerStatuses: Map<String, ProviderStatus> = emptyMap(),
    val refreshingProviders: Set<String> = emptySet(),
    val mcp: McpStatus? = null,
    val mcpLoading: Boolean = false,
    val models: ModelCatalog? = null,
    val modelsLoading: Boolean = false,
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
