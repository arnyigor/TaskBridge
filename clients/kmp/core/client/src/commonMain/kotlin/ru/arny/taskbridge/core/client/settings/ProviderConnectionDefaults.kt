package ru.arny.taskbridge.core.client.settings

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

import io.ktor.http.Url

val providerApis = linkedMapOf(
    "openai-completions" to "OpenAI Chat Completions",
    "openai-responses" to "OpenAI Responses",
    "anthropic-messages" to "Anthropic Messages",
)

/**
 * Шаблон подключения: адрес, протокол и имя переменной с ключом.
 *
 * ID здесь намеренно нет: он выводится из названия ([providerIdFromName]), иначе
 * вторая дюжина «правильных ID» разошлась бы с правилом `tb-` при первой же правке.
 */
data class ProviderTemplate(
    val label: String,
    val baseUrl: String,
    val keyEnv: String = "",
    val api: String = "openai-completions",
)

val providerTemplates = listOf(
    ProviderTemplate("Локальный / LAN", "http://127.0.0.1:8083/v1"),
    ProviderTemplate("LM Studio", "http://127.0.0.1:1234/v1"),
    ProviderTemplate("Ollama", "http://127.0.0.1:11434/v1"),
    ProviderTemplate("llama.cpp / vLLM", "http://127.0.0.1:8080/v1"),
    ProviderTemplate("OpenRouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    ProviderTemplate("OpenAI", "https://api.openai.com/v1", "OPENAI_API_KEY", "openai-responses"),
    ProviderTemplate("Anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY", "anthropic-messages"),
)

data class ProviderEndpoint(val baseUrl: String, val local: Boolean)

/**
 * Транслит для кириллицы: имя подключения человек пишет по-русски, а ID записи
 * `models.json` — только `[a-z0-9-]`.
 */
private val translit = mapOf(
    'а' to "a", 'б' to "b", 'в' to "v", 'г' to "g", 'д' to "d", 'е' to "e", 'ё' to "e",
    'ж' to "zh", 'з' to "z", 'и' to "i", 'й' to "y", 'к' to "k", 'л' to "l", 'м' to "m",
    'н' to "n", 'о' to "o", 'п' to "p", 'р' to "r", 'с' to "s", 'т' to "t", 'у' to "u",
    'ф' to "f", 'х' to "kh", 'ц' to "ts", 'ч' to "ch", 'ш' to "sh", 'щ' to "sch",
    'ъ' to "", 'ы' to "y", 'ь' to "", 'э' to "e", 'ю' to "yu", 'я' to "ya",
)

/**
 * Правило ID записи `models.json` — то же, что проверяет сервер
 * (`src/providers/pi-provider-profiles.mjs`): маленькие латинские буквы, цифры и
 * дефисы, до 48 символов, без дефиса по краям.
 *
 * Префикса `tb-` здесь нет: раньше он был соглашением «своя запись», но владение
 * сервер доказывает маркером `name` (`TaskBridge: <id>`), а чужая запись с тем же
 * ID по-прежнему не перезаписывается. Человеку этот префикс ничего не сообщал.
 */
internal val providerIdPattern = Regex("^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$")

/**
 * ID записи `models.json` из человеческого названия.
 *
 * Слаг не пустой и не длиннее 48 символов (столько разрешает сервер), без ведущих и
 * хвостовых дефисов.
 *
 * @param taken уже занятые ID: одинаковое название двух подключений даёт `-2`, `-3`.
 */
fun providerIdFromName(name: String, taken: Collection<String> = emptyList()): String {
    val slug = name.lowercase()
        .map { ch ->
            when {
                ch in 'a'..'z' || ch in '0'..'9' -> ch.toString()
                else -> translit[ch] ?: "-"
            }
        }
        .joinToString("")
        .replace(Regex("[^a-z0-9]+"), "-")
        .trim('-')
        .take(48)
        .trim('-')
        .ifEmpty { "provider" }
    if (slug !in taken) return slug
    for (n in 2..99) {
        val suffix = "-$n"
        val candidate = slug.take(48 - suffix.length).trimEnd('-') + suffix
        if (candidate !in taken) return candidate
    }
    return slug
}

/** Mirrors the server's transport policy; the server still validates every request. */
fun providerEndpoint(raw: String): ProviderEndpoint? = runCatching {
    val value = raw.trim()
    require(value.isNotBlank() && value.length <= 512)
    val hasScheme = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://").containsMatchIn(value)
    val authority = value.removePrefix("https://").removePrefix("http://").substringBefore('/')
    require('@' !in authority && '?' !in value && '#' !in value)
    val url = Url(if (hasScheme) value else "https://$value")
    require(url.protocol.name in listOf("http", "https"))
    val host = url.host.removeSurrounding("[", "]").lowercase()
    require(host.isNotBlank())
    val ipv4 = host.split('.').mapNotNull(String::toIntOrNull).takeIf { it.size == 4 && it.all { n -> n in 0..255 } }
    val localV4 = ipv4 != null && (ipv4[0] == 127 || ipv4[0] == 10 ||
        (ipv4[0] == 172 && ipv4[1] in 16..31) || (ipv4[0] == 192 && ipv4[1] == 168))
    require(ipv4 == null || !(ipv4[0] == 0 || ipv4[0] >= 224 || (ipv4[0] == 169 && ipv4[1] == 254)))
    require(host == "::1" || !Regex("^(fe80:|fc|fd|ff|::)").containsMatchIn(host))
    val local = localV4 || host == "localhost" || host == "::1"
    require(url.protocol.name != "http" || local)
    val normalized = if (!hasScheme && local) url.toString().replaceFirst("https://", "http://") else url.toString()
    ProviderEndpoint(normalized.trimEnd('/'), local)
}.getOrNull()

/**
 * Поля модели, которые форма пишет новым моделям сразу, когда подключение
 * помечено как «умеет размышлять».
 *
 * Без них Pi считает модель нерассуждающей (`supportedThinkingLevels` в
 * `src/model-catalog.mjs` отдаёт один «off»), и выбор уровней в сессии
 * показывает «None». Значения не придуманы: это рабочая конфигурация локального
 * llama.cpp/Strata из `docs/local-model-providers.md`
 * (`compat.thinkingFormat: "chat-template"` + `chatTemplateKwargs`).
 */
val THINKING_MODEL_DEFAULTS: JsonObject = buildJsonObject {
    put("reasoning", JsonPrimitive(true))
    put("thinkingLevelMap", buildJsonObject {
        put("off", JsonPrimitive("none"))
        put("minimal", JsonNull)
        put("low", JsonPrimitive("low"))
        put("medium", JsonPrimitive("medium"))
        put("high", JsonPrimitive("high"))
        put("xhigh", JsonNull)
        put("max*", JsonNull)
    })
    put("compat", buildJsonObject {
        put("thinkingFormat", JsonPrimitive("chat-template"))
        put("chatTemplateKwargs", buildJsonObject {
            put("enable_thinking", buildJsonObject { put("\$var", JsonPrimitive("thinking.enabled")) })
            put("reasoning_effort", buildJsonObject {
                put("\$var", JsonPrimitive("thinking.effort"))
                put("omitWhenOff", JsonPrimitive(true))
            })
        })
    })
}
