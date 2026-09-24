package ru.arny.taskbridge.core.client.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import ru.arny.taskbridge.core.api.FileRef
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.humanizeError

// The chat of one session, rebuilt from its event log.
//
// A line-by-line port of web/chat-state.mjs (ChatState), which the web client
// has been hardened on: late settles that belong to the previous answer,
// messages that supersede an answer mid-stream, aborted ends arriving after the
// next answer started, regenerated variants, edited and truncated history. The
// rules and their reasons are kept next to the code; when the two differ, the
// web version is the reference and this one is the bug.
//
// Internally the turns are mutable (exactly like the original); the UI gets an
// immutable [ChatSnapshot] from [snapshot] after every change.

val ACTIVE_STATUSES = setOf("QUEUED", "PREPARING", "PREFLIGHT", "RUNNING", "WAITING_USER", "VERIFYING", "CANCELLING")

private val PRIVATE_PART = Regex("^(?:\\.git|\\.pi|\\.ssh|\\.aws|\\.codex|node_modules|data)$", RegexOption.IGNORE_CASE)
private val SECRET_PART = Regex("^(?:\\.env(?:\\..*)?|secret(?:s)?(?:\\..*)?|credentials(?:\\..*)?|config\\.json|server-auth\\.json|auth\\.json)$", RegexOption.IGNORE_CASE)
private val SECRET_EXT = Regex("\\.(?:pem|key|p12|pfx|jks|keystore)$", RegexOption.IGNORE_CASE)
private val ABORT = Regex("abort", RegexOption.IGNORE_CASE)

/** Mirrors isPrivatePath in src/files.mjs: such paths are never offered as viewable files. */
fun isPrivateFilePath(value: String?): Boolean =
    value.orEmpty().replace('\\', '/').split('/').any { PRIVATE_PART.matches(it) || SECRET_PART.matches(it) || SECRET_EXT.containsMatchIn(it) }

private fun paragraphSeparator(text: String): String {
    val trimmed = text.trimEnd()
    if (trimmed.isEmpty()) return ""
    return if (trimmed.endsWith("\n")) "\n" else "\n\n"
}

/** ISO-8601 instants from the server all share one format, so they compare as strings. */
private fun before(a: String?, b: String?): Boolean = a != null && b != null && a < b

class ChatReducer(task: Task, seedInitial: Boolean = true) {
    internal enum class Role { USER, ASSISTANT, NOTE }

    internal class Tool(
        val id: String,
        val name: String,
        var label: String?,
        var state: String = "run",
        val imagePath: String? = null,
    )

    internal class Turn(
        var id: String,
        val role: Role,
        var text: String = "",
        var thinking: String = "",
        val tools: MutableList<Tool> = mutableListOf(),
        var active: Boolean = false,
        var status: String = "",
        var error: String? = null,
        var variantKey: Long? = null,
        var at: String? = null,
        var endedAt: String? = null,
        var userAt: String? = null,
        var final: Boolean = false,
        var superseded: Boolean = false,
        var hidden: Boolean = false,
        var partial: Boolean = false,
        var stopReason: String? = null,
        var files: List<FileRef> = emptyList(),
        var clientId: String? = null,
        var commandId: String? = null,
        var mode: String? = null,
    )

    private class Variants(val ids: MutableList<String>, var selected: String?)

    private class Orphan(val turn: Turn, val textPrefix: String, val thinkingPrefix: String, val textSeparator: String)

    val taskId: String = task.id

    /** The newest seq applied; events at or below it are ignored. */
    var cursor: Long = 0
        private set

    private var turns = mutableListOf<Turn>()
    private val tools = mutableMapOf<String, Tool>()
    private val notes = mutableSetOf<Long>()
    private val variants = mutableMapOf<Long, Variants>()
    private var current: Turn
    private var messageTurn: Turn? = null
    private var messageOpen = false
    private var orphanMessage: Orphan? = null
    private var executionTurn: Turn? = null
    private var windowStart: Turn? = null
    private var textPrefix = ""
    private var thinkingPrefix = ""
    private var textSeparator = ""
    private var separatorApplied = false

    /** Bumped on every change, so the UI can tell snapshots apart cheaply. */
    var version: Long = 0
        private set

    init {
        // seedInitial: false when built from a paginated tail window that does
        // not reach the task's original prompt — that first turn has no
        // USER_MESSAGE of its own, so it can only be synthesised here.
        if (seedInitial) {
            current = Turn(id = "", role = Role.ASSISTANT) // replaced by addUser
            addUser(task.prompt.orEmpty(), task.files, "initial")
            current.at = null
        } else {
            // A window that opens mid-turn: a detached placeholder gives live
            // state a sink until the first real USER_MESSAGE; never rendered.
            current = Turn(id = "assistant-window-start", role = Role.ASSISTANT, variantKey = 0)
            windowStart = current
        }
    }

    /**
     * Replays an older, settled batch in a scratch reducer and puts its turns
     * in front. Never touches the live tail (current, messageTurn, cursor).
     */
    fun prependOlder(task: Task, events: List<TaskEvent>, reachedStart: Boolean) {
        val scratch = ChatReducer(task, seedInitial = reachedStart)
        for (event in events) scratch.apply(event)
        val older = scratch.turns.toMutableList()
        val partial = scratch.windowStart
        if (partial != null && partial !in older && (partial.text.isNotEmpty() || partial.thinking.isNotEmpty() || partial.tools.isNotEmpty())) {
            // A page cut by size opens mid-turn; that content is real, so it
            // becomes a partial turn of its own instead of vanishing.
            partial.id = "assistant-partial-${events.firstOrNull()?.seq ?: 0}"
            partial.partial = true
            partial.active = false
            partial.final = true
            for (tool in partial.tools) if (tool.state == "run") tool.state = "interrupted"
            older.add(0, partial)
        }
        turns.addAll(0, older)
        for ((id, tool) in scratch.tools) tools.getOrPut(id) { tool }
        for ((key, entry) in scratch.variants) variants.getOrPut(key) { entry }
        version++
    }

    private fun addUser(text: String, files: List<FileRef>, id: String, at: String? = null, preservePrevious: Boolean = false, origin: TaskEvent? = null) {
        if (!preservePrevious && current.role == Role.ASSISTANT && !current.final && current.id.isNotEmpty()) {
            current.active = false
            current.superseded = true
            if (current.status.isEmpty()) current.status = if (current.text.isNotBlank()) "DONE" else "CANCELLED"
            if (current.endedAt == null && at != null) current.endedAt = at
            current.final = true
        }
        // Older logs embedded the upload note in the visible message.
        val marker = "\n\nAdditional files from the phone are in .taskbridge-input/:\n"
        val split = text.split(marker)
        var shownFiles = files
        if (files.isEmpty() && split.size > 1) {
            shownFiles = split[1].split('\n').filter { it.startsWith("- ") }.map { FileRef(name = it.drop(2)) }
        }
        turns += Turn(
            id = "user-$id", role = Role.USER, text = split[0], files = shownFiles, at = at,
            clientId = origin?.string("clientId"), commandId = origin?.string("commandId"), mode = origin?.string("mode"),
        )
        val key = if (id == "initial") 0L else id.toLong()
        current = Turn(id = "assistant-$id", role = Role.ASSISTANT, variantKey = key, userAt = at)
        turns += current
        variants[key] = Variants(mutableListOf("assistant-$id"), "assistant-$id")
    }

    private fun finish(status: String, error: String? = null, at: String? = null) {
        val humanError = error?.let { humanizeError(it) }?.takeIf { it.isNotEmpty() }
        fun answered(turn: Turn) = turn.text.isNotBlank()
        fun cutOff(turn: Turn) = !answered(turn) && (turn.superseded || status == "CANCELLED")
        fun labelFor(turn: Turn) = if (turn.error != null || cutOff(turn)) "FAILED" else status

        // A late settle that predates the CURRENT prompt belongs to the previous answer.
        val currentStart = current.at ?: current.userAt
        if (at != null && currentStart != null && before(at, currentStart)) {
            val previous = turns.lastOrNull { it.role == Role.ASSISTANT && it !== current }
            if (previous != null) {
                previous.status = if (humanError != null || previous.error != null || cutOff(previous)) "FAILED" else status
                if (humanError != null) previous.error = humanError
                previous.endedAt = previous.endedAt ?: at
                previous.final = true
                for (tool in previous.tools) if (tool.state == "run") tool.state = "interrupted"
            }
            return
        }

        val running = turns.filter { it.role == Role.ASSISTANT && (it.active || it.status.isEmpty()) }
        for (turn in turns) {
            if (turn.role != Role.ASSISTANT) continue
            // DONE (from agent_settled) is interim: the run's real terminal
            // event (cancelled, failed) replaces it.
            val interim = turn.status.isEmpty() || turn.status == "DONE"
            if (turn.active || (interim && !turn.superseded)) turn.status = labelFor(turn)
            turn.active = false
            turn.final = true
            for (tool in turn.tools) if (tool.state == "run") tool.state = "interrupted"
        }
        current.status = if (humanError != null || current.error != null || cutOff(current)) "FAILED" else status
        current.final = true
        if (humanError != null) current.error = humanError
        if (at != null) for (turn in running.ifEmpty { listOf(current) }) {
            if (before(at, turn.at)) continue
            turn.endedAt = turn.endedAt ?: at
        }
    }

    private fun startVariant(data: JsonObject) {
        val key = data.long("turnSeq") ?: 0L
        val variantId = data.str("variantId").orEmpty()
        if (variantId.isEmpty()) return
        val turnId = "assistant-$variantId"
        val entry = variants.getOrPut(key) { Variants(mutableListOf(), null) }
        if (turnId !in entry.ids) entry.ids += turnId
        val turn = Turn(id = turnId, role = Role.ASSISTANT, active = true, variantKey = key)
        data.str("editedText")?.let { turn.text = it }
        val previousId = entry.ids.getOrNull(entry.ids.size - 2)
        val index = if (previousId != null) turns.indexOfFirst { it.id == previousId } else -1
        if (index >= 0) turns.add(index + 1, turn) else turns += turn
        current = turn
        selectVariant(key, turnId)
    }

    private fun selectVariant(key: Long, turnId: String) {
        val entry = variants[key] ?: return
        if (turnId !in entry.ids) return
        entry.selected = turnId
        for (turn in turns) {
            if (turn.role != Role.ASSISTANT || turn.variantKey != key) continue
            turn.hidden = turn.id != turnId
        }
    }

    private fun truncateTurns(fromSeq: Long, dropInitial: Boolean, keepUser: Boolean) {
        if (fromSeq < 0) return
        fun seqOf(turn: Turn): Long? {
            val prefix = when (turn.role) { Role.USER -> "user-"; Role.NOTE -> "note-"; Role.ASSISTANT -> "assistant-" }
            return if (turn.id.startsWith(prefix)) turn.id.removePrefix(prefix).toLongOrNull() else null
        }
        fun forget(turn: Turn) { for (tool in turn.tools) tools.remove(tool.id) }
        turns = turns.filter { turn ->
            val seq = turn.variantKey ?: seqOf(turn)
            when {
                seq == null || seq == 0L -> when {
                    keepUser -> true
                    dropInitial -> { forget(turn); false }
                    else -> true
                }
                seq < fromSeq -> true
                else -> { forget(turn); false }
            }
        }.toMutableList()
        if (keepUser) {
            while (turns.isNotEmpty() && turns.last().role != Role.USER) forget(turns.removeAt(turns.lastIndex))
            val seed = turns.lastOrNull()?.let { seqOf(it)?.toString() } ?: "initial"
            current = Turn(id = "assistant-$seed", role = Role.ASSISTANT, active = true)
            turns += current
        } else {
            current = turns.lastOrNull { it.role == Role.ASSISTANT }
                ?: Turn(id = "assistant-truncated-$fromSeq", role = Role.ASSISTANT)
        }
        val alive = turns.map { it.id }.toSet()
        if (keepUser) {
            val key = current.variantKey ?: 0L
            current.variantKey = key
            variants[key] = Variants(mutableListOf(current.id), current.id)
        }
        for ((key, entry) in variants.toList()) {
            entry.ids.retainAll { it in alive }
            if (entry.ids.isEmpty()) { variants.remove(key); continue }
            if (entry.selected !in entry.ids) entry.selected = entry.ids.last()
        }
        messageTurn = null
        messageOpen = false
        orphanMessage = null
        textSeparator = ""
        separatorApplied = false
    }

    /**
     * Shows the operator's message right away, before the server has it. It is
     * reconciled with the USER_MESSAGE carrying the same commandId (or, for
     * servers without commandId on events, with the oldest pending one).
     */
    fun addOptimistic(commandId: String, text: String, files: List<FileRef> = emptyList(), at: String? = null) {
        turns += Turn(id = "user-pending-$commandId", role = Role.USER, text = text, files = files, at = at, commandId = commandId)
        turns += Turn(id = "assistant-pending-$commandId", role = Role.ASSISTANT, active = true)
        version++
    }

    /** The message went to the server queue (or failed): its bubble leaves the chat. */
    fun removeOptimistic(commandId: String) {
        val removed = turns.removeAll { it.id == "user-pending-$commandId" || it.id == "assistant-pending-$commandId" }
        if (removed) version++
    }

    fun hasOptimistic(commandId: String): Boolean = turns.any { it.id == "user-pending-$commandId" }

    /** Applies one event; returns false for an event already seen or of another session. */
    fun apply(event: TaskEvent): Boolean {
        if (event.taskId != null && event.taskId != taskId) return false
        if (event.seq <= cursor) return false
        cursor = event.seq
        version++
        val data = event.data
        when (event.type) {
            "USER_MESSAGE" -> onUserMessage(event)
            "TURN_TRUNCATED" -> truncateTurns(
                data.long("fromSeq") ?: -1,
                dropInitial = data.bool("dropInitial") == true,
                keepUser = data.bool("keepUser") == true,
            )
            "TURN_EDITED" -> turns.firstOrNull { it.id == data.str("id") }?.text = data.str("text").orEmpty()
            "TURN_VARIANT_START" -> startVariant(data)
            "TURN_VARIANT_SELECTED" -> selectVariant(data.long("turnSeq") ?: 0L, "assistant-${data.str("variantId")}")
            "STATUS" -> {
                val status = data.str("status")
                if (status != null && status in ACTIVE_STATUSES) {
                    current.active = true
                    current.status = status
                } else finish(status ?: "DONE")
            }
            // Files the agent left in the workspace: they belong to the answer that made them.
            "OUTPUT_FILES" -> if (current.role == Role.ASSISTANT) current.files = current.files + decodeFiles(event)
            "TASK_SUCCEEDED", "TASK_FAILED", "TASK_CANCELLED" ->
                finish(event.type.removePrefix("TASK_"), if (event.type == "TASK_FAILED") event.message else null, event.at)
        }
        val frame = event.piFrame ?: return true
        applyFrame(event, frame)
        return true
    }

    private fun onUserMessage(event: TaskEvent) {
        val mode = event.string("mode")
        val preservePrevious = mode == "steer" || mode == "follow_up"
        val superseded = current
        if (!preservePrevious && !superseded.id.startsWith("assistant-pending-") && superseded.role == Role.ASSISTANT && superseded.active) {
            superseded.active = false
            superseded.final = true
            superseded.superseded = true
            if (superseded.status.isEmpty()) superseded.status = if (superseded.error != null || superseded.text.isBlank()) "FAILED" else "DONE"
            superseded.endedAt = superseded.endedAt ?: event.at
            for (tool in superseded.tools) if (tool.state == "run") tool.state = "interrupted"
        }
        val text = event.string("text") ?: event.message.orEmpty()
        val files = decodeFiles(event)
        // Reconcile the optimistic bubble: by commandId when the server says
        // which command this is, else the oldest pending one.
        val commandId = event.string("commandId")
        val optimistic = commandId?.let { id -> turns.firstOrNull { it.id == "user-pending-$id" } }
            ?: turns.firstOrNull { it.role == Role.USER && it.id.startsWith("user-pending-") && (commandId == null || it.commandId == null) }
        if (optimistic != null) {
            if (event.at != null) optimistic.at = event.at
            val assistant = turns.firstOrNull { it.id == optimistic.id.replace("user-pending-", "assistant-pending-") }
            optimistic.id = "user-${event.seq}"
            optimistic.clientId = event.string("clientId") ?: optimistic.clientId
            optimistic.mode = mode
            if (files.isNotEmpty()) optimistic.files = files
            if (assistant != null) {
                assistant.id = "assistant-${event.seq}"
                assistant.variantKey = event.seq
                assistant.active = true
                assistant.userAt = event.at
                current = assistant
                variants[event.seq] = Variants(mutableListOf("assistant-${event.seq}"), "assistant-${event.seq}")
            } else {
                turns.remove(optimistic)
                addUser(text, files, event.seq.toString(), event.at, preservePrevious, event)
                current.active = true
            }
        } else {
            addUser(text, files, event.seq.toString(), event.at, preservePrevious, event)
            current.active = true
        }
    }

    private fun applyFrame(event: TaskEvent, frame: JsonObject) {
        when (frame.str("type")) {
            "agent_start" -> {
                current.active = true
                current.status = "RUNNING"
            }
            "message_start" -> if (frame.obj("message")?.str("role") == "assistant") {
                // An answer left open by an interrupt: its late end must not land on this one.
                val open = messageTurn
                if (messageOpen && open != null && open !== current) {
                    orphanMessage = Orphan(open, textPrefix, thinkingPrefix, textSeparator)
                }
                if (current.at == null) current.at = event.at
                messageTurn = current
                executionTurn = current
                textPrefix = current.text
                thinkingPrefix = current.thinking
                textSeparator = paragraphSeparator(current.text)
                separatorApplied = false
                current.active = true
                messageOpen = true
            }
            "message_update" -> {
                if (!messageOpen) {
                    // Deltas without message_start continue the current message (steering).
                    messageTurn = current
                    textPrefix = current.text
                    thinkingPrefix = current.thinking
                    messageOpen = true
                }
                val turn = messageTurn ?: current
                val delta = frame.obj("assistantMessageEvent")
                when (delta?.str("type")) {
                    "text_delta" -> {
                        if (textSeparator.isNotEmpty() && !separatorApplied) { turn.text += textSeparator; separatorApplied = true }
                        turn.text += delta.str("delta").orEmpty()
                    }
                    "thinking_delta" -> turn.thinking += delta.str("delta").orEmpty()
                }
            }
            "message_end" -> if (frame.obj("message")?.str("role") == "assistant") onMessageEnd(event, frame.obj("message")!!)
            "tool_execution_start" -> {
                val id = frame.str("toolCallId") ?: "tool-${event.seq}"
                if (id !in tools) {
                    val turn = executionTurn ?: current
                    val args = frame.obj("args")
                    val arg = args?.let { it.str("command") ?: it.str("path") ?: it.str("file_path") ?: it.str("filePath") }.orEmpty()
                    val named = args?.let { it.str("path") ?: it.str("file_path") ?: it.str("filePath") }
                    val tool = Tool(id, frame.str("toolName") ?: "tool", arg.ifEmpty { event.message }, imagePath = named?.takeUnless { isPrivateFilePath(it) })
                    turn.tools += tool
                    tools[id] = tool
                }
            }
            "tool_execution_end" -> {
                val callId = frame.str("toolCallId")
                var tool = if (callId != null) tools[callId] else tools.values.lastOrNull { it.state == "run" && it.name == frame.str("toolName") }
                if (tool == null) {
                    tool = Tool(callId ?: "tool-${event.seq}", frame.str("toolName") ?: "tool", event.message)
                    (executionTurn ?: current).tools += tool
                    tools[tool.id] = tool
                }
                tool.state = if (frame.bool("isError") == true) "error" else "done"
            }
            "agent_settled" -> finish("DONE", null, event.at)
            "compaction_end", "auto_compaction_end" -> {
                val note = frame.str("errorMessage")?.let { humanizeError(it) }?.takeIf { it.isNotEmpty() }
                    ?: if (frame["result"] != null && frame["result"] !is kotlinx.serialization.json.JsonNull) "Контекст сжат." else null
                if (note != null && notes.add(event.seq)) turns += Turn(id = "note-${event.seq}", role = Role.NOTE, text = note)
            }
        }
    }

    private fun onMessageEnd(event: TaskEvent, message: JsonObject) {
        val sink = messageTurn ?: current
        val stopReason = message.str("stopReason")
        val errorMessage = message.str("errorMessage")
        val aborted = stopReason == "aborted" || ABORT.containsMatchIn(errorMessage.orEmpty())
        var orphan = orphanMessage?.takeIf { it.turn !== sink && aborted }
        // An aborted end that predates the current prompt belongs to the previous answer.
        if (orphan == null && aborted && before(event.at, current.userAt)) {
            val previous = turns.lastOrNull { it.role == Role.ASSISTANT && it !== current }
            if (previous != null) orphan = Orphan(previous, previous.text, previous.thinking, "")
        }
        val turn = orphan?.turn ?: sink
        val content = message["content"] as? JsonArray
        if (content != null) {
            val blocks = content.mapNotNull { it as? JsonObject }
            val text = blocks.filter { it.str("type") == "text" }.joinToString("") { it.str("text").orEmpty() }
            val thinking = blocks.filter { it.str("type") == "thinking" }.joinToString("") { it.str("thinking").orEmpty() }
            val rebuild = orphan != null || messageTurn != null
            val prefix = orphan?.textPrefix ?: textPrefix
            val separator = orphan?.textSeparator ?: textSeparator
            val thinkPrefix = orphan?.thinkingPrefix ?: thinkingPrefix
            turn.text = (if (rebuild) prefix + separator else turn.text) + text
            turn.thinking = (if (rebuild) thinkPrefix else turn.thinking) + thinking
        }
        if (stopReason != null) turn.stopReason = stopReason
        if (errorMessage != null || aborted) turn.error = humanizeError(errorMessage).ifEmpty { "Request was aborted" }
        if (orphan != null) {
            turn.status = "FAILED"
            turn.active = false
            turn.final = true
            turn.endedAt = turn.endedAt ?: event.at
            orphanMessage = null
            return
        }
        textSeparator = ""
        separatorApplied = false
        messageTurn = null
        messageOpen = false
    }

    /** Folds the task's own status in (it arrives with the task, not as an event). */
    fun syncTask(task: Task, initial: Boolean = false) {
        if (initial && turns.none { it.role == Role.ASSISTANT && (it.text.isNotEmpty() || it.thinking.isNotEmpty()) }) {
            // Very early sessions have only session-wide saved text.
            if (turns.count { it.role == Role.ASSISTANT } == 1) {
                current.text = task.assistantText.orEmpty()
                current.thinking = task.thinkingText.orEmpty()
            }
        }
        if (task.status !in ACTIVE_STATUSES) finish(task.status, task.error)
        else if (initial && !current.final) current.active = true
        if (!current.final) current.status = task.status
        version++
    }

    private fun decodeFiles(event: TaskEvent): List<FileRef> =
        event.data["files"]?.let { runCatching { TaskBridgeJson.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(FileRef.serializer()), it) }.getOrNull() }.orEmpty()

    fun snapshot(): ChatSnapshot {
        val items = turns.filter { !it.hidden }.map { turn ->
            when (turn.role) {
                Role.USER -> ChatItem.User(
                    id = turn.id, text = turn.text, files = turn.files, at = turn.at,
                    pending = turn.id.startsWith("user-pending-"), clientId = turn.clientId, mode = turn.mode,
                    turnId = turn.id.takeUnless { it.startsWith("user-pending-") },
                )
                Role.NOTE -> ChatItem.Note(id = turn.id, text = turn.text)
                Role.ASSISTANT -> {
                    val entry = turn.variantKey?.let { variants[it] }
                    val variantInfo = if (entry != null && entry.ids.size > 1 && turn.id in entry.ids) {
                        VariantInfo(turnSeq = turn.variantKey!!, index = entry.ids.indexOf(turn.id), ids = entry.ids.toList())
                    } else null
                    ChatItem.Assistant(
                        id = turn.id, text = turn.text, thinking = turn.thinking,
                        tools = turn.tools.map { ToolCall(it.id, it.name, it.label, ToolState.of(it.state), it.imagePath) },
                        active = turn.active, status = turn.status, error = turn.error, final = turn.final,
                        at = turn.at, endedAt = turn.endedAt, partial = turn.partial, superseded = turn.superseded,
                        stopReason = turn.stopReason, variants = variantInfo, files = turn.files,
                    )
                }
            }
        }
        // The newest exchange is the one regenerate/continue/edit-answer accept.
        val newestAnswerId = items.lastOrNull { it is ChatItem.Assistant && !it.id.startsWith("assistant-pending-") }?.id
        return ChatSnapshot(items = items, cursor = cursor, version = version, newestAnswerId = newestAnswerId)
    }
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.let { it.longOrNull ?: it.contentOrNull?.toLongOrNull() }
private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
