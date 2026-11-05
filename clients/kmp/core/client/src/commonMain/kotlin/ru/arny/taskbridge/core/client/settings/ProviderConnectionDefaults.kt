package ru.arny.taskbridge.core.client.settings

import io.ktor.http.Url

val providerApis = linkedMapOf(
    "openai-completions" to "OpenAI Chat Completions",
    "openai-responses" to "OpenAI Responses",
    "anthropic-messages" to "Anthropic Messages",
)

data class ProviderTemplate(
    val label: String,
    val id: String,
    val baseUrl: String,
    val keyEnv: String = "",
    val api: String = "openai-completions",
)

val providerTemplates = listOf(
    ProviderTemplate("Локальный / LAN", "tb-local", "http://127.0.0.1:8083/v1"),
    ProviderTemplate("LM Studio", "tb-lmstudio", "http://127.0.0.1:1234/v1"),
    ProviderTemplate("Ollama", "tb-ollama", "http://127.0.0.1:11434/v1"),
    ProviderTemplate("llama.cpp / vLLM", "tb-llamacpp", "http://127.0.0.1:8080/v1"),
    ProviderTemplate("OpenRouter", "tb-openrouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    ProviderTemplate("OpenAI", "tb-openai", "https://api.openai.com/v1", "OPENAI_API_KEY", "openai-responses"),
    ProviderTemplate("Anthropic", "tb-anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY", "anthropic-messages"),
)

data class ProviderEndpoint(val baseUrl: String, val local: Boolean)

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
