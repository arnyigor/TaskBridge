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
    val nested = body["error"] as? JsonObject
    fun JsonObject?.str(key: String): String = ((this?.get(key)) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim().orEmpty()
    val message = listOf(body.str("message"), nested.str("message"), body.str("error"), body.str("detail"), body.str("reason"), body.str("description"))
        .firstOrNull { it.isNotEmpty() }.orEmpty()
    val rawCode = listOf(body.str("error_type"), body.str("type"), nested.str("type"), nested.str("code"), body.str("errorCode"), body.str("code"))
        .firstOrNull { it.isNotEmpty() }.orEmpty()
    val named = if (IDENTIFIER.matches(rawCode)) rawCode else ""
    val param = listOf(body.str("param"), nested.str("param")).firstOrNull { it.isNotEmpty() }.orEmpty()
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
