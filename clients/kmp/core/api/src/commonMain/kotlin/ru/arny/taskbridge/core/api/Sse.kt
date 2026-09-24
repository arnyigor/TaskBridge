package ru.arny.taskbridge.core.api

// Server-Sent Events, parsed by hand: the stream is plain text and the server
// side is ours (src/server.mjs), so a small incremental parser is simpler to
// trust than a plugin — and it is testable byte by byte.

data class SseMessage(
    val id: String?,
    val event: String?,
    val data: String,
)

/**
 * Feed it lines as they arrive (without the line terminator); it returns a
 * message whenever a blank line completes one. Implements the parts of the
 * WHATWG rules the server uses: `id`, `event`, multi-line `data`, `retry`,
 * and `:` comments (heartbeats).
 */
class SseParser {
    private val data = StringBuilder()
    private var hasData = false
    private var event: String? = null
    private var id: String? = null

    /** The last `retry:` the server asked for, in milliseconds. */
    var retryMillis: Long? = null
        private set

    fun feed(rawLine: String): SseMessage? {
        val line = rawLine.removeSuffix("\r")
        if (line.isEmpty()) return dispatch()
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        var value = if (colon < 0) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "data" -> {
                if (hasData) data.append('\n')
                data.append(value)
                hasData = true
            }
            "event" -> event = value
            "id" -> if (!value.contains('\u0000')) id = value
            "retry" -> value.toLongOrNull()?.let { retryMillis = it }
        }
        return null
    }

    private fun dispatch(): SseMessage? {
        if (!hasData) {
            event = null
            return null
        }
        val message = SseMessage(id = id, event = event, data = data.toString())
        data.clear()
        hasData = false
        event = null
        return message
    }
}
