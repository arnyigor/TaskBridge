package ru.arny.taskbridge.core.client

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import ru.arny.taskbridge.core.api.TaskBridgeJson

// Port of web/errors.mjs: providers answer with a JSON envelope and Pi forwards
// it verbatim; the chat shows the provider's sentence plus its stable error name
// instead of the raw body. Plain text is returned unchanged.

private const val MAX_LENGTH = 600
private val IDENTIFIER = Regex("^[A-Za-z][\\w-]*$")
private val WHITESPACE = Regex("\\s+")

fun humanizeError(value: String?): String {
    val text = value.orEmpty().replace(WHITESPACE, " ").trim()
    if (text.isEmpty()) return ""
    val body = parseEnvelope(text) ?: return clip(text)
    fun JsonObject?.str(key: String): String = ((this?.get(key)) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim().orEmpty()
    fun nested(value: String): JsonObject? {
        fun parse(candidate: String): JsonObject? = runCatching {
            TaskBridgeJson.parseToJsonElement(candidate) as? JsonObject
        }.getOrNull()
        return parse(value) ?: parse(value.replace("\\n", "\n").replace("\\\"", "\""))
    }
    fun find(source: JsonObject, depth: Int = 0): Triple<String, String, String> {
        if (depth > 4) return Triple("", "", "")
        val error = (source["error"] as? JsonObject) ?: nested(source.str("error"))
        val messageObject = nested(source.str("message"))
        val child = error ?: messageObject
        if (child != null) {
            val found = find(child, depth + 1)
            if (found.first.isNotEmpty() || found.second.isNotEmpty() || found.third.isNotEmpty()) return found
        }
        val message = listOf(source.str("message"), source.str("error"), source.str("detail"), source.str("reason"), source.str("description"))
            .firstOrNull { it.isNotEmpty() && nested(it) == null }.orEmpty()
        val code = listOf(source.str("error_type"), source.str("type"), source.str("code"), source.str("errorCode"), source.str("status"))
            .firstOrNull { it.isNotEmpty() }.orEmpty()
        return Triple(message, code, source.str("param"))
    }
    val found = find(body)
    val message = found.first
    val rawCode = found.second
    val named = if (IDENTIFIER.matches(rawCode)) rawCode else ""
    val param = found.third
    val human = message.ifEmpty { named }
    if (human.isEmpty()) return clip(text)
    val suffix = buildList {
        if (param.isNotEmpty() && !human.lowercase().contains(param.lowercase())) add("param: $param")
        if (named.isNotEmpty() && !human.contains(named)) add(named)
    }
    return clip(if (suffix.isEmpty()) human else "$human (${suffix.joinToString(" · ")})")
}

private fun parseEnvelope(text: String): JsonObject? {
    val start = text.indexOf('{')
    val end = text.lastIndexOf('}')
    if (start == -1 || end <= start) return null
    return runCatching { TaskBridgeJson.parseToJsonElement(text.substring(start, end + 1)) as? JsonObject }.getOrNull()
}

private fun clip(text: String) = if (text.length > MAX_LENGTH) text.take(MAX_LENGTH - 1) + "…" else text
