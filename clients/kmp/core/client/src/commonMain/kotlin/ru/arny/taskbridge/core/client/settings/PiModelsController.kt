package ru.arny.taskbridge.core.client.settings

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import ru.arny.taskbridge.core.api.ProviderProfile
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.humanizeError

/**
 * Редактор models.json — аналог Pi Manager внутри приложения.
 *
 * Правит ЛЮБУЮ запись, включая те, что создал не TaskBridge: это явное действие
 * оператора над своим конфигом Pi, с ревизией файла и резервной копией. Секреты
 * (литеральный apiKey, значения headers) сервер отдаёт как `$REDACTED`, а запись
 * возвращает маркер — значит форма не может стереть то, чего не видела.
 */
data class PiModelsState(
    val providers: List<ProviderProfile> = emptyList(),
    val revision: String = "",
    val selectedProvider: String? = null,
    val selectedModelId: String? = null,
    /** Запись провайдера целиком (с маскированными секретами). */
    val raw: JsonObject? = null,
    val providerDraft: ProviderRawDraft? = null,
    val modelDraft: ModelRawDraft? = null,
    /** История формы модели — для «Отменить». */
    val history: List<ModelRawDraft> = emptyList(),
    /** Пресеты (model-profiles.json) и ревизия этого файла. */
    val presets: List<ru.arny.taskbridge.core.api.ModelProfile> = emptyList(),
    val presetsRevision: String = "",
    val presetName: String = "",
    val presetBusy: Boolean = false,
    val loading: Boolean = false,
    val saving: Boolean = false,
    val modelProbes: Map<Pair<String, String>, ModelProbeState> = emptyMap(),
    val notice: String? = null,
    val error: String? = null,
) {
    /** Модели выбранного провайдера — из записи, иначе из списка. */
    val models: List<JsonObject>
        get() = (raw?.get("models") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()

    /** Пресеты выбранной модели. */
    val presetsForModel: List<ru.arny.taskbridge.core.api.ModelProfile>
        get() = presets.filter { it.providerId == selectedProvider && it.modelId == selectedModelId }
}

/** Поля уровня провайдера, как в Pi Manager. */
data class ProviderRawDraft(
    val id: String = "",
    val baseUrl: String = "",
    val api: String = "",
    /** `$ENV`, `local` или `$REDACTED` — значение ключа из UI не принимается. */
    val apiKey: String = "",
    val name: String = "",
    val headers: String = "",
    val compat: String = "",
    val extra: String = "",
)

/**
 * Поля одной модели. Отдельные контролы для того, что правят чаще всего
 * (контекст, выход, reasoning, input), вложенные объекты — строками `ключ=значение`:
 * так форму читают глазами, а не как JSON.
 */
data class ModelRawDraft(
    val originalId: String = "",
    val id: String = "",
    val name: String = "",
    val contextWindow: String = "",
    val maxTokens: String = "",
    val reasoning: Boolean = false,
    /** Через запятую: `text, image`. */
    val input: String = "",
    /** Переопределение API на уровне модели. */
    val api: String = "",
    val samplingParams: String = "",
    val thinkingLevelMap: String = "",
    val compat: String = "",
    val settings: String = "",
    val extra: String = "",
) {
    val validationError: String?
        get() = when {
            id.isBlank() -> "Укажите ID модели"
            contextWindow.isNotBlank() && contextWindow.trim().toLongOrNull() == null -> "Контекст — целое число токенов"
            maxTokens.isNotBlank() && maxTokens.trim().toLongOrNull() == null -> "Максимум выхода — целое число токенов"
            keyValueError(samplingParams) != null -> "samplingParams: ${keyValueError(samplingParams)}"
            keyValueError(thinkingLevelMap) != null -> "thinkingLevelMap: ${keyValueError(thinkingLevelMap)}"
            keyValueError(compat) != null -> "compat: ${keyValueError(compat)}"
            keyValueError(settings) != null -> "настройки: ${keyValueError(settings)}"
            keyValueError(extra) != null -> "прочие поля: ${keyValueError(extra)}"
            else -> null
        }
}

/** Строка `ключ=значение`; значение разбирается как JSON, иначе остаётся строкой. */
internal fun parseKeyValueLines(text: String): Map<String, kotlinx.serialization.json.JsonElement> {
    val result = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
    text.lines().forEach { rawLine ->
        val line = rawLine.trim()
        if (line.isEmpty() || line.startsWith("#")) return@forEach
        val at = line.indexOf('=').takeIf { it > 0 } ?: throw IllegalStateException("строка без «=»: $line")
        val key = line.substring(0, at).trim()
        val value = line.substring(at + 1).trim()
        if (key.isEmpty()) throw IllegalStateException("пустой ключ: $line")
        result[key] = runCatching { Json.parseToJsonElement(value) }.getOrElse { JsonPrimitive(value) }
    }
    return result
}

internal fun keyValueError(text: String): String? = runCatching { parseKeyValueLines(text); null }
    .getOrElse { it.message ?: "неверная строка" }

internal fun renderKeyValueLines(obj: JsonObject?): String = obj?.entries
    ?.joinToString("\n") { (key, value) -> "$key=${value.toString().trim('"')}" }
    .orEmpty()

private fun isObject(text: String): Boolean {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return true
    return runCatching { Json.parseToJsonElement(trimmed) is JsonObject }.getOrDefault(false)
}

private fun JsonObject.string(key: String): String =
    (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()

private fun JsonObject.numberOrBlank(key: String): String =
    (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()

class PiModelsController(private val api: TaskBridgeApi, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(PiModelsState())
    val state = _state.asStateFlow()

    fun load() {
        if (_state.value.loading) return
        _state.update { it.copy(loading = true, error = null) }
        scope.launch {
            runCatching { api.providerProfiles() }
                .onSuccess { page ->
                    _state.update { state ->
                        state.copy(
                            providers = page.providers,
                            revision = page.revision,
                            selectedProvider = state.selectedProvider?.takeIf { id -> page.providers.any { it.id == id } }
                                ?: page.providers.firstOrNull()?.id,
                        )
                    }
                    _state.value.selectedProvider?.let { openProvider(it) }
                }
                .onFailure { failure -> _state.update { it.copy(loading = false, error = humanizeError(failure.message)) } }
        }
    }

    fun openProvider(id: String) {
        _state.update { it.copy(selectedProvider = id, selectedModelId = null, raw = null, modelDraft = null, loading = true, error = null) }
        scope.launch {
            runCatching { api.rawProviderProfile(id) }
                .onSuccess { page ->
                    _state.update {
                        it.copy(
                            revision = page.revision,
                            raw = page.entry,
                            providerDraft = draftOf(id, page.entry),
                            loading = false,
                            notice = null,
                        )
                    }
                }
                .onFailure { failure -> _state.update { it.copy(loading = false, error = humanizeError(failure.message)) } }
        }
    }

    fun openModel(modelId: String) {
        val state = _state.value
        val model = state.models.firstOrNull { it.string("id") == modelId } ?: return
        _state.update { it.copy(selectedModelId = modelId, modelDraft = draftOf(model), history = emptyList(), presetName = "") }
        loadPresets()
    }

    fun closeModel() = _state.update { it.copy(selectedModelId = null, modelDraft = null, history = emptyList()) }

    fun updateProviderDraft(draft: ProviderRawDraft) = _state.update { it.copy(providerDraft = draft, error = null) }

    fun updateModelDraft(draft: ModelRawDraft) = _state.update { state ->
        val history = (state.history + listOfNotNull(state.modelDraft)).takeLast(30)
        state.copy(modelDraft = draft, error = null, history = history)
    }

    /** Отменить последнее изменение формы. */
    fun undoModel() = _state.update { state ->
        val previous = state.history.lastOrNull() ?: return@update state
        state.copy(modelDraft = previous, history = state.history.dropLast(1), error = null)
    }

    /** Состояние модели как JSON — то, что уйдёт на сервер (для вкладки RAW JSON и копирования). */
    fun modelJson(): String {
        val state = _state.value
        val draft = state.modelDraft ?: return "{}"
        val previous = state.models.firstOrNull { it.string("id") == draft.originalId }
        return runCatching { buildModel(draft, previous).toString() }
            .getOrElse { "{\"error\": ${JsonPrimitive(it.message ?: "неверный ввод")}}" }
    }

    /** Принять RAW JSON целиком: из него собираются поля формы. */
    fun applyModelJson(text: String) {
        val state = _state.value
        val draft = state.modelDraft ?: return
        val parsed = runCatching { Json.parseToJsonElement(text) }
            .getOrElse { failure ->
                _state.update { it.copy(error = "JSON: ${failure.message}") }
                return
            }
        if (parsed !is JsonObject) {
            _state.update { it.copy(error = "Ожидается JSON-объект") }
            return
        }
        val original = draft.originalId
        val next = draftOf(parsed).copy(originalId = original)
        _state.update { it.copy(modelDraft = next, error = null) }
    }

    /** Удаление всей записи с проверкой ревизии и резервной копией на сервере. */
    fun deleteProvider(providerId: String) {
        val state = _state.value
        if (state.saving || state.loading) return
        _state.update { it.copy(saving = true, error = null) }
        scope.launch {
            runCatching { api.deleteProviderProfile(providerId, state.revision) }
                .onSuccess { page ->
                    _state.update {
                        val selectedDeleted = it.selectedProvider == providerId
                        it.copy(
                            saving = false,
                            revision = page.revision,
                            providers = page.providers,
                            selectedProvider = if (selectedDeleted) null else it.selectedProvider,
                            selectedModelId = if (selectedDeleted) null else it.selectedModelId,
                            raw = if (selectedDeleted) null else it.raw,
                            providerDraft = if (selectedDeleted) null else it.providerDraft,
                            modelDraft = if (selectedDeleted) null else it.modelDraft,
                            history = if (selectedDeleted) emptyList() else it.history,
                            notice = "Провайдер $providerId удалён. Резервная копия models.json сохранена рядом.",
                        )
                    }
                }
                .onFailure { failure -> _state.update { it.copy(saving = false, error = humanizeError(failure.message)) } }
        }
    }

    /** Удалить модель из записи провайдера (с резервной копией на сервере). */
    fun deleteModel(modelId: String) {
        val state = _state.value
        val providerId = state.selectedProvider ?: return
        if (state.saving) return
        _state.update { it.copy(saving = true, error = null) }
        scope.launch {
            runCatching { api.removeProviderModels(providerId, listOf(modelId), state.revision) }
                .onSuccess { page ->
                    _state.update {
                        it.copy(
                            saving = false, revision = page.revision, providers = page.providers,
                            selectedModelId = null, modelDraft = null, history = emptyList(),
                            notice = "Модель $modelId удалена из $providerId.",
                        )
                    }
                    openProvider(providerId)
                }
                .onFailure { failure -> _state.update { it.copy(saving = false, error = humanizeError(failure.message)) } }
        }
    }

    /** Explicit one-token probe, never run by opening or expanding the model list. */
    fun testModel(modelId: String) {
        val providerId = _state.value.selectedProvider ?: return
        val key = providerId to modelId
        if (_state.value.saving || _state.value.modelProbes[key]?.loading == true) return
        _state.update { it.copy(modelProbes = it.modelProbes + (key to ModelProbeState(loading = true))) }
        scope.launch {
            runCatching { api.probeModel(providerId, modelId) }
                .onSuccess { result -> _state.update {
                    it.copy(modelProbes = it.modelProbes + (key to ModelProbeState(result = result)))
                } }
                .onFailure { failure -> _state.update {
                    it.copy(modelProbes = it.modelProbes + (key to ModelProbeState(error = humanizeError(failure.message))))
                } }
        }
    }

    fun clearNotice() = _state.update { it.copy(notice = null, error = null) }

    /** Сохранить провайдера: поля вне формы (модели и прочее) остаются как были. */
    fun saveProvider() {
        val state = _state.value
        val draft = state.providerDraft ?: return
        val providerId = state.selectedProvider ?: return
        if (state.saving) return
        val merged = runCatching {
            val base = state.raw ?: JsonObject(emptyMap())
            val builder = LinkedHashMap(base)
            builder["baseUrl"] = JsonPrimitive(draft.baseUrl.trim())
            builder["api"] = JsonPrimitive(draft.api.trim())
            if (draft.apiKey.isNotBlank()) builder["apiKey"] = JsonPrimitive(draft.apiKey.trim())
            if (draft.name.isBlank()) builder.remove("name") else builder["name"] = JsonPrimitive(draft.name.trim())
            putKeyValues(builder, "headers", draft.headers)
            putKeyValues(builder, "compat", draft.compat)
            JsonObject(builder + parseKeyValueLines(draft.extra))
        }.getOrElse { failure ->
            _state.update { it.copy(error = failure.message ?: "Некорректный JSON") }
            return
        }
        _state.update { it.copy(saving = true, error = null) }
        scope.launch {
            runCatching { api.saveProviderRaw(providerId, merged, state.revision) }
                .onSuccess { page ->
                    _state.update { it.copy(saving = false, revision = page.revision, providers = page.providers, notice = "Запись $providerId сохранена.") }
                    openProvider(providerId)
                }
                .onFailure { failure -> _state.update { it.copy(saving = false, error = humanizeError(failure.message)) } }
        }
    }

    /** Сохранить модель целиком (все поля), в том числе с переименованием ID. */
    fun saveModel() {
        val state = _state.value
        val draft = state.modelDraft ?: return
        val providerId = state.selectedProvider ?: return
        if (state.saving) return
        if (draft.validationError != null) {
            _state.update { it.copy(error = draft.validationError) }
            return
        }
        val model = runCatching { buildModel(draft, state.models.firstOrNull { it.string("id") == draft.originalId }) }
            .getOrElse { failure ->
                _state.update { it.copy(error = failure.message ?: "Некорректный JSON") }
                return
            }
        _state.update { it.copy(saving = true, error = null) }
        scope.launch {
            runCatching { api.saveModelRaw(providerId, draft.originalId, model, state.revision) }
                .onSuccess { page ->
                    _state.update {
                        it.copy(
                            saving = false,
                            revision = page.revision,
                            providers = page.providers,
                            selectedModelId = draft.id.trim(),
                            notice = "Модель ${draft.id.trim()} сохранена.",
                        )
                    }
                    openProvider(providerId)
                }
                .onFailure { failure -> _state.update { it.copy(saving = false, error = humanizeError(failure.message)) } }
        }
    }

    /** Быстрые пресеты контекста/выхода — как кнопки Quick presets в Pi Manager. */
    fun applyContextPreset(tokens: Long) {
        val draft = _state.value.modelDraft ?: return
        _state.update { it.copy(modelDraft = draft.copy(contextWindow = tokens.toString())) }
    }

    fun applyOutputPreset(tokens: Long) {
        val draft = _state.value.modelDraft ?: return
        _state.update { it.copy(modelDraft = draft.copy(maxTokens = tokens.toString())) }
    }

    // --- Пресеты модели: именованные наборы полей в model-profiles.json.

    fun loadPresets() {
        scope.launch {
            runCatching { api.listModelProfiles() }
                .onSuccess { page -> _state.update { it.copy(presets = page.profiles, presetsRevision = page.revision) } }
                .onFailure { failure -> _state.update { it.copy(error = humanizeError(failure.message)) } }
        }
    }

    fun updatePresetName(name: String) = _state.update { it.copy(presetName = name) }

    /** Сохранить текущие поля модели как пресет (или перезаписать пресет с тем же именем). */
    fun savePreset() {
        val state = _state.value
        val draft = state.modelDraft ?: return
        val providerId = state.selectedProvider ?: return
        if (state.presetBusy) return
        val name = state.presetName.trim()
        if (name.isBlank()) {
            _state.update { it.copy(error = "Укажите имя пресета.") }
            return
        }
        if (draft.validationError != null) {
            _state.update { it.copy(error = draft.validationError) }
            return
        }
        val model = runCatching { buildModel(draft, state.models.firstOrNull { it.string("id") == draft.originalId }) }
            .getOrElse { failure ->
                _state.update { it.copy(error = failure.message ?: "Некорректный ввод") }
                return
            }
        val existing = state.presets.firstOrNull {
            it.providerId == providerId && it.modelId == draft.originalId && it.name.equals(name, ignoreCase = true)
        }
        _state.update { it.copy(presetBusy = true, error = null) }
        scope.launch {
            runCatching { api.saveModelProfile(state.presetsRevision, existing?.id, name, providerId, draft.originalId, model) }
                .onSuccess { page ->
                    _state.update {
                        it.copy(
                            presetBusy = false, presets = page.profiles, presetsRevision = page.revision,
                            notice = "Пресет «$name» сохранён.",
                        )
                    }
                }
                .onFailure { failure -> _state.update { it.copy(presetBusy = false, error = humanizeError(failure.message)) } }
        }
    }

    /** Подставить пресет в поля формы (в models.json уйдёт только по «Сохранить»). */
    fun applyPreset(id: String) {
        val profile = _state.value.presets.firstOrNull { it.id == id } ?: return
        applyModelJson(profile.settings.toString())
        _state.update { it.copy(presetName = profile.name, notice = "Пресет «${profile.name}» подставлен в поля.") }
    }

    fun deletePreset(id: String) {
        val state = _state.value
        if (state.presetBusy) return
        _state.update { it.copy(presetBusy = true, error = null) }
        scope.launch {
            runCatching { api.deleteModelProfile(id, state.presetsRevision) }
                .onSuccess { page -> _state.update { it.copy(presetBusy = false, presets = page.profiles, presetsRevision = page.revision) } }
                .onFailure { failure -> _state.update { it.copy(presetBusy = false, error = humanizeError(failure.message)) } }
        }
    }

    private fun draftOf(id: String, entry: JsonObject) = ProviderRawDraft(
        id = id,
        baseUrl = entry.string("baseUrl"),
        api = entry.string("api"),
        apiKey = entry.string("apiKey"),
        name = entry.string("name"),
        headers = renderKeyValueLines(entry["headers"] as? JsonObject),
        compat = renderKeyValueLines(entry["compat"] as? JsonObject),
        extra = renderKeyValueLines(JsonObject(entry.filterKeys { key ->
            key !in setOf("baseUrl", "api", "apiKey", "name", "headers", "compat", "models", "id")
        })),
    )

    private fun draftOf(model: JsonObject) = ModelRawDraft(
        originalId = model.string("id"),
        id = model.string("id"),
        name = model.string("name"),
        contextWindow = model.numberOrBlank("contextWindow"),
        maxTokens = model.numberOrBlank("maxTokens"),
        reasoning = (model["reasoning"] as? JsonPrimitive)?.contentOrNull == "true",
        input = (model["input"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty().joinToString(", "),
        api = model.string("api"),
        samplingParams = renderKeyValueLines(model["samplingParams"] as? JsonObject),
        thinkingLevelMap = renderKeyValueLines(model["thinkingLevelMap"] as? JsonObject),
        compat = renderKeyValueLines(model["compat"] as? JsonObject),
        settings = renderKeyValueLines(model["settings"] as? JsonObject),
        extra = renderKeyValueLines(JsonObject(model.filterKeys { key ->
            key !in setOf("id", "name", "contextWindow", "maxTokens", "reasoning", "input", "api", "samplingParams", "thinkingLevelMap", "compat", "settings")
        })),
    )

    private fun buildModel(draft: ModelRawDraft, previous: JsonObject?): JsonObject {
        val builder = LinkedHashMap(previous ?: emptyMap())
        builder["id"] = JsonPrimitive(draft.id.trim())
        if (draft.name.isBlank()) builder.remove("name") else builder["name"] = JsonPrimitive(draft.name.trim())
        val context = draft.contextWindow.trim().toLongOrNull()
        if (context != null) builder["contextWindow"] = JsonPrimitive(context) else builder.remove("contextWindow")
        val output = draft.maxTokens.trim().toLongOrNull()
        if (output != null) builder["maxTokens"] = JsonPrimitive(output) else builder.remove("maxTokens")
        // reasoning: true — пишем флаг, false — поле убираем (у Pi значение по умолчанию).
        if (draft.reasoning) builder["reasoning"] = JsonPrimitive(true) else builder.remove("reasoning")
        val inputs = draft.input.split(',').map(String::trim).filter(String::isNotBlank)
        if (inputs.isEmpty()) builder.remove("input")
        else builder["input"] = JsonArray(inputs.map { JsonPrimitive(it) })
        if (draft.api.isBlank()) builder.remove("api") else builder["api"] = JsonPrimitive(draft.api.trim())
        putKeyValues(builder, "samplingParams", draft.samplingParams)
        putKeyValues(builder, "thinkingLevelMap", draft.thinkingLevelMap)
        putKeyValues(builder, "compat", draft.compat)
        putKeyValues(builder, "settings", draft.settings)
        builder.putAll(parseKeyValueLines(draft.extra))
        return JsonObject(builder)
    }

    private fun putKeyValues(builder: MutableMap<String, kotlinx.serialization.json.JsonElement>, key: String, text: String) {
        val parsed = parseKeyValueLines(text)
        if (parsed.isEmpty()) builder.remove(key) else builder[key] = JsonObject(parsed)
    }


}
