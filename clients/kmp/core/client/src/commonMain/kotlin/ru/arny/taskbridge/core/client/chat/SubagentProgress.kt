package ru.arny.taskbridge.core.client.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Mirrors web/chat-state.mjs: public activity, not system prompts, thinking or tool output. */
internal fun subagentProgress(result: JsonObject?, args: JsonObject?): String? {
    fun JsonObject.text(key: String): String = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
    fun compact(value: String): String = value.replace(Regex("\\s+"), " ").trim().take(180)
    // What a call is about: «read src/app.js», «bash npm test» — the name alone said nothing.
    fun call(x: JsonObject): String {
        val a = x["arguments"] as? JsonObject
        val target = listOf("command", "path", "file_path", "pattern", "query", "url").map { a?.text(it).orEmpty() }.firstOrNull { it.isNotBlank() }
        return listOf(compact(x.text("name")), target?.let { compact(it).take(80) }.orEmpty()).filter { it.isNotEmpty() }.joinToString(" ")
    }
    val results = (result?.get("details") as? JsonObject)?.get("results") as? JsonArray
    val entries: List<JsonElement> = results?.takeIf { it.isNotEmpty() }
        ?: if (args != null && args.text("agent").isNotEmpty()) listOf(args)
        else (args?.get("tasks") as? JsonArray) ?: (args?.get("chain") as? JsonArray) ?: emptyList()
    return entries.take(8).joinToString("\n") { element ->
        val entry = element as? JsonObject ?: return@joinToString "subagent · ожидание обновления"
        var activity = ""
        val messages = entry["messages"] as? JsonArray ?: emptyList()
        for (message in messages.asReversed()) {
            val m = message as? JsonObject ?: continue
            if (m.text("role") == "toolResult") activity = "получен результат: " + compact(m.text("toolName")).ifEmpty { "инструмент" }
            if (m.text("role") == "assistant") {
                val content = (m["content"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
                val calls = content.filter { it.text("type") == "toolCall" }.map(::call).filter { it.isNotEmpty() }
                activity = if (calls.isNotEmpty()) "вызов: " + calls.take(3).joinToString(", ")
                    else compact(content.filter { it.text("type") == "text" }.joinToString(" ") { it.text("text") })
            }
            if (activity.isNotEmpty()) break
        }
        // How far it got: the number of tool results so far.
        val steps = messages.count { (it as? JsonObject)?.text("role") == "toolResult" }
        listOf(compact(entry.text("agent")).ifEmpty { "subagent" }, activity.ifEmpty { "ожидание обновления" }, if (steps > 0) "действий: $steps" else "", compact(entry.text("task")))
            .filter { it.isNotEmpty() }.joinToString(" · ")
    }.takeIf { it.isNotEmpty() }
}
