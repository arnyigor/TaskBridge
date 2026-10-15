package ru.arny.taskbridge.core.client.session

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import ru.arny.taskbridge.core.api.TaskEvent

/**
 * Byte budget of the cached events, in JSON characters.
 *
 * A whole [ru.arny.taskbridge.core.client.session.CachedChat] is written as ONE
 * string (`Json.encodeToString`), so the encoder allocates a buffer of that size
 * and grows it by doubling. A session with large tool output reached tens of
 * millions of characters, the growth asked for a single 108 MB array, and
 * Android's 256 MB heap refused it: `OutOfMemoryError` inside
 * `JsonToStringWriter.ensureTotalCapacity`, thrown from `persistCache` on a
 * worker thread, which killed the whole process (measured on the phone
 * 2026-10-11: three crashes in one morning, every one of them right after
 * `loadOlder` — i.e. when the operator scrolled the history up).
 *
 * The budget keeps the newest events only; the full history lives on the
 * server, and a trimmed cache is stored with `reachedStart = false` so the
 * client pages back instead of pretending the history is complete.
 */
internal const val CACHE_BUDGET_CHARS = 2_000_000

/**
 * Сколько места событие занимает в файле — БЕЗ построения строки.
 *
 * Раньше вес считался как `event.data.toString().length`, и это же роняло
 * приложение: у большого кадра один только замер просил аллокацию в 108 МБ
 * (`java.lang.OutOfMemoryError` при `JsonToStringWriter.ensureTotalCapacity`,
 * dropbox OnePlus 6T, 2026-10-11). Оценка идёт обходом дерева JsonElement:
 * длины строк-значений, имена полей, по символу на структуру. Это на единицы
 * процентов отличается от сериализации и не выделяет память под копию данных.
 */
internal fun jsonWeight(element: JsonElement, depth: Int = 0): Int {
    // Глубина ограничена: у Pi кадры вложены неглубоко, а патологическую вложенность
    // лучше посчитать приблизительно, чем упасть на переполнении стека.
    if (depth > 24) return CACHE_BUDGET_CHARS + 1
    return when (element) {
        is JsonPrimitive -> jsonStringWeight(element.content)
        is JsonObject -> element.entries.sumOf { (key, value) -> jsonStringWeight(key) + 1 + jsonWeight(value, depth + 1) }
        is JsonArray -> element.sumOf { jsonWeight(it, depth + 1) } + element.size
        JsonNull -> 4
        else -> 8
    }
}

/** What one cached event adds to the file, measured the way the encoder sees it. */
internal fun cacheWeight(event: TaskEvent): Int = jsonWeight(event.data) +
    jsonStringWeight(event.message.orEmpty()) + jsonStringWeight(event.taskId.orEmpty()) +
    jsonStringWeight(event.at.orEmpty()) + jsonStringWeight(event.type) + 96

private fun jsonStringWeight(value: String): Int {
    if (value.length > CACHE_BUDGET_CHARS) return CACHE_BUDGET_CHARS + 1
    var size = 2
    for (char in value) {
        size += when (char) {
            '"', '\\', '\n', '\r', '\t', '\b', '\u000C' -> 2
            in '\u0000'..'\u001F' -> 6
            else -> 1
        }
        if (size > CACHE_BUDGET_CHARS) return size
    }
    return size
}

/**
 * Drops the oldest cached events until the rest fit [budgetChars] and
 * [maxEvents]. Returns true when something was dropped — the caller then marks
 * the cache as not reaching the session start.
 */
internal fun trimCacheToBudget(
    events: MutableList<TaskEvent>,
    budgetChars: Int = CACHE_BUDGET_CHARS,
    maxEvents: Int = CACHE_MAX_EVENTS,
): Boolean {
    var dropped = false
    if (events.size > maxEvents) {
        events.subList(0, events.size - maxEvents).clear()
        dropped = true
    }
    var chars = 0
    var keepFrom = events.size
    for (index in events.indices.reversed()) {
        val weight = cacheWeight(events[index])
        if (chars + weight > budgetChars) break
        chars += weight
        keepFrom = index
    }
    if (keepFrom > 0) {
        events.subList(0, keepFrom).clear()
        dropped = true
    }
    return dropped
}

/**
 * A saved event a client actually reads is a fraction of what Pi sends. A frame
 * carries tool arguments and results — file contents, whole command output,
 * base64 image data — that no client code needs: the reducer builds the
 * transcript from text deltas, the final assistant message and tool
 * names/arguments, and it never looks at the four payloads dropped here. Keeping
 * them filled the phone's heap until adding a file ended with OutOfMemoryError
 * and Android force-finishing the activity (2026-09-28, 253 MB of 256 MB).
 */
internal fun lightenEvent(event: TaskEvent): TaskEvent {
    val frame = event.piFrame ?: return event
    val type = frame.str("type") ?: return event
    val tool = frame.str("toolName")
    val light: JsonObject = when (type) {
        // The whole turn again, message by message: the reducer ignores agent_end.
        "agent_end" -> JsonObject(frame - "messages")
        // Only a trigger to close the previous answer's delivery line. The tool
        // results arrive again as tool_execution_end frames (their own `result` is
        // dropped below), so the copy kept here was the single largest thing in
        // the cache: one bash run of a few hundred kilobytes was stored twice.
        "turn_end" -> JsonObject(frame - "message" - "toolResults")
        // A tool result is echoed as a message of its own, content and all.
        "message_start", "message_end" ->
            if (frame.obj("message")?.str("role") == "toolResult") JsonObject(frame - "message") else return event
        // Read only for the subagent progress line; other results are megabytes.
        "tool_execution_end" -> if (tool == "subagent") return event else JsonObject(frame - "result")
        "tool_execution_update" -> if (tool == "subagent") return event else JsonObject(frame - "partialResult")
        // `write` puts the whole file into args.content; only the label is used.
        "tool_execution_start" -> {
            val args = frame.obj("args") ?: return event
            if ("content" !in args) return event
            JsonObject(frame + ("args" to JsonObject(args - "content")))
        }
        else -> return event
    }
    return event.copy(data = JsonObject(event.data + ("pi" to light)))
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
