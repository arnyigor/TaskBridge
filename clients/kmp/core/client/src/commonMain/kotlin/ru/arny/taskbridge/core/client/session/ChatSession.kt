package ru.arny.taskbridge.core.client.session

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.Approval
import ru.arny.taskbridge.core.api.FileRef
import ru.arny.taskbridge.core.api.MessageRequest
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.StreamItem
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.api.ToolOutput
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.client.chat.ChatReducer
import ru.arny.taskbridge.core.client.chat.ChatSnapshot
import kotlin.random.Random

/** How a message is delivered while the agent is busy (docs/api-contract.md, /message). */
enum class SendMode {
    /** Wait for the current answer to end, then go (Enter in the web UI). */
    QUEUE,

    /** Stop the current answer and send right away (Ctrl+Enter). */
    NOW,

    /** Slip the text into the running answer as steering. */
    STEER,
}

sealed interface LinkState {
    data object Connecting : LinkState
    data object Live : LinkState
    data class Reconnecting(val attempt: Int, val inMillis: Long, val reason: String) : LinkState

    /** Nothing more to do automatically (session gone, auth lost, API mismatch). */
    data class Failed(val error: ApiError) : LinkState
}

/** A message on its way out; it leaves the list once the server has it. */
data class OutgoingMessage(
    val commandId: String,
    val text: String,
    val fileNames: List<String>,
    val mode: SendMode,
    val status: Status,
) {
    sealed interface Status {
        data object Uploading : Status
        data object Sending : Status
        data class Retrying(val attempt: Int, val reason: String) : Status

        /** Rejected for good: the text is offered back for editing. */
        data class Failed(val message: String) : Status

        /** The server crashed mid-command and the history does not show it: ask the operator. */
        data object Unknown : Status
    }
}

data class ChatSessionState(
    val taskId: String,
    val task: Task? = null,
    val chat: ChatSnapshot = ChatSnapshot(),
    val loading: Boolean = true,
    val link: LinkState = LinkState.Connecting,
    val reachedStart: Boolean = true,
    val loadingOlder: Boolean = false,
    val approvals: List<Approval> = emptyList(),
    val outbox: List<OutgoingMessage> = emptyList(),
    /** Which actions are running, so buttons can show progress and not double-fire. */
    val busy: Set<String> = emptySet(),
)

/** One-shot things the screen reacts to (a snackbar, text back into the composer, navigation). */
sealed interface ChatEffect {
    data class Notice(val message: String) : ChatEffect
    data class RestoreComposer(val text: String) : ChatEffect
    data class OpenSession(val taskId: String) : ChatEffect
    data object Deleted : ChatEffect
}

/**
 * Everything one open chat needs: history (loaded newest first, older pages on
 * demand), the live stream with reconnection, message delivery with
 * idempotency, and the session commands. UI-agnostic; the screen collects
 * [state] and [effects] and calls the methods.
 */
class ChatSession(
    private val api: TaskBridgeApi,
    val taskId: String,
    private val scope: CoroutineScope,
    private val ids: () -> String,
    private val now: () -> String,
    private val pageTurns: Int = 8,
    private val random: Random = Random.Default,
) {
    private val _state = MutableStateFlow(ChatSessionState(taskId))
    val state: StateFlow<ChatSessionState> = _state.asStateFlow()

    private val _effects = MutableSharedFlow<ChatEffect>(extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val effects: SharedFlow<ChatEffect> = _effects.asSharedFlow()

    private val mutex = Mutex()
    private var reducer: ChatReducer? = null
    private var oldestSeq: Long? = null
    private var streamJob: Job? = null
    private var refreshJob: Job? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val refreshRequests = Channel<Unit>(Channel.CONFLATED)
    private var started = false

    fun start() {
        if (started) return
        started = true
        scope.launch { loadInitial() }
        refreshJob = scope.launch {
            for (request in refreshRequests) {
                delay(250) // coalesce a burst of status events into one GET
                refreshTask()
            }
        }
    }

    fun close() {
        streamJob?.cancel()
        refreshJob?.cancel()
    }

    /** The network came back or the app returned to the foreground: skip the backoff wait. */
    fun reconnectNow() {
        wake.trySend(Unit)
    }

    // --- loading ----------------------------------------------------------------

    private suspend fun loadInitial() {
        try {
            val task = api.task(taskId)
            val window = api.eventWindow(taskId, pageTurns)
            mutex.withLock {
                val chat = ChatReducer(task, seedInitial = window.reachedStart)
                for (event in window.events) chat.apply(event)
                window.events.firstOrNull()?.let { chat.revealWindowStart(it.seq) }
                chat.syncTask(task, initial = true)
                reducer = chat
                oldestSeq = window.events.firstOrNull()?.seq
                _state.update { it.copy(task = task, chat = chat.snapshot(), loading = false, reachedStart = window.reachedStart) }
            }
            fillEmptyWindow()
            loadApprovals()
            streamJob = scope.launch { streamLoop() }
        } catch (error: ApiException) {
            _state.update { it.copy(loading = false, link = if (error.error.transient) LinkState.Reconnecting(1, 2000, error.message.orEmpty()) else LinkState.Failed(error.error)) }
            if (error.error.transient) {
                delay(2000)
                loadInitial()
            }
        }
    }

    fun loadOlder() {
        val state = _state.value
        if (state.reachedStart || state.loadingOlder) return
        val before = oldestSeq ?: return
        _state.update { it.copy(loadingOlder = true) }
        scope.launch {
            try {
                val window = api.eventWindow(taskId, pageTurns, before = before)
                mutex.withLock {
                    val chat = reducer ?: return@withLock
                    val task = _state.value.task ?: return@withLock
                    if (window.events.isNotEmpty() || window.reachedStart) chat.prependOlder(task, window.events, window.reachedStart)
                    oldestSeq = window.events.firstOrNull()?.seq ?: oldestSeq
                    _state.update { it.copy(chat = chat.snapshot(), reachedStart = window.reachedStart || window.events.isEmpty(), loadingOlder = false) }
                }
                fillEmptyWindow()
            } catch (error: ApiException) {
                _state.update { it.copy(loadingOlder = false) }
                notice(error.error)
            }
        }
    }

    /** A window with nothing to show (only status events, say) must not look like an empty session: page back. */
    private fun fillEmptyWindow() {
        val state = _state.value
        if (state.chat.items.isEmpty() && !state.reachedStart) loadOlder()
    }

    // --- live stream --------------------------------------------------------------

    private suspend fun streamLoop() {
        var attempt = 0
        var serverRetry = 1500L
        while (true) {
            _state.update { it.copy(link = if (attempt == 0) LinkState.Connecting else it.link) }
            var gotSomething = false
            val error: ApiError? = try {
                val cursor = mutex.withLock { reducer?.cursor ?: 0 }
                api.stream(taskId, cursor).collect { item ->
                    when (item) {
                        is StreamItem.Retry -> serverRetry = item.millis
                        is StreamItem.Event -> onEvent(item.event)
                    }
                    if (!gotSomething) {
                        gotSomething = true
                        attempt = 0
                        _state.update { it.copy(link = LinkState.Live) }
                    }
                }
                null // the server closed the stream: reconnect after a short pause
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: ApiException) {
                failure.error
            }
            if (error != null && !error.transient && error !is ApiError.Other) {
                _state.update { it.copy(link = LinkState.Failed(error)) }
                return
            }
            if (gotSomething) {
                // A connection that worked and then dropped: catch up at once.
                attempt = 0
                refreshRequests.trySend(Unit)
            }
            attempt += 1
            val wait = backoff(attempt, serverRetry)
            _state.update { it.copy(link = LinkState.Reconnecting(attempt, wait, error?.message ?: "Соединение закрыто")) }
            kotlinx.coroutines.withTimeoutOrNull(wait) { wake.receive() }
        }
    }

    private fun backoff(attempt: Int, floor: Long): Long {
        if (attempt <= 1) return floor.coerceAtMost(1500)
        val base = (500L shl (attempt - 1).coerceAtMost(6)).coerceAtMost(30_000)
        val jitter = (base * 0.2 * (random.nextDouble() * 2 - 1)).toLong()
        return (base + jitter).coerceIn(500, 30_000)
    }

    private suspend fun onEvent(event: TaskEvent) {
        mutex.withLock {
            val chat = reducer ?: return
            if (!chat.apply(event)) return
            if (event.type == "USER_MESSAGE") {
                event.string("commandId")?.let { id -> _state.update { s -> s.copy(outbox = s.outbox.filterNot { it.commandId == id }) } }
            }
            _state.update { it.copy(chat = chat.snapshot()) }
        }
        if (event.type.startsWith("APPROVAL_")) scope.launch { loadApprovals() }
        val frameType = event.piFrame?.get("type")?.toString()?.trim('"')
        if (event.type != "PI_EVENT" || frameType == "agent_settled" || frameType == "compaction_end") refreshRequests.trySend(Unit)
    }

    private suspend fun refreshTask() {
        try {
            val task = api.task(taskId)
            mutex.withLock {
                val chat = reducer
                if (chat != null) chat.syncTask(task)
                _state.update { it.copy(task = task, chat = chat?.snapshot() ?: it.chat) }
            }
        } catch (error: ApiException) {
            if (error.error is ApiError.NotFound) _state.update { it.copy(link = LinkState.Failed(error.error)) }
        }
    }

    private suspend fun loadApprovals() {
        runCatching { api.approvals(taskId) }.onSuccess { list -> _state.update { it.copy(approvals = list.filter { a -> a.status == null || a.status == "PENDING" }) } }
    }

    // --- sending ------------------------------------------------------------------

    /**
     * Sends a message. Returns immediately; progress is in [ChatSessionState.outbox]
     * and in the optimistic bubble. The commandId is fixed before the first try,
     * so every retry is the same command and the agent never gets it twice.
     */
    fun send(text: String, files: List<UploadFile> = emptyList(), mode: SendMode = SendMode.QUEUE) {
        val clean = text.trim()
        if (clean.isEmpty() && files.isEmpty()) return
        val commandId = ids()
        val message = OutgoingMessage(commandId, clean, files.map { it.name }, mode, if (files.isEmpty()) OutgoingMessage.Status.Sending else OutgoingMessage.Status.Uploading)
        _state.update { it.copy(outbox = it.outbox + message) }
        scope.launch {
            mutex.withLock {
                reducer?.let { chat ->
                    chat.addOptimistic(commandId, clean.ifEmpty { "Прикреплённые файлы" }, files.map { FileRef(name = it.name, size = it.bytes.size.toLong(), mimeType = it.mimeType) }, now())
                    _state.update { s -> s.copy(chat = chat.snapshot()) }
                }
            }
            deliver(message, files)
        }
    }

    /** Try a failed or unknown message again. An unknown one gets a new command id: the old one may have landed. */
    fun retry(commandId: String) {
        val message = _state.value.outbox.firstOrNull { it.commandId == commandId } ?: return
        dismiss(commandId)
        send(message.text, emptyList(), message.mode)
    }

    fun dismiss(commandId: String) {
        _state.update { it.copy(outbox = it.outbox.filterNot { m -> m.commandId == commandId }) }
        scope.launch { dropOptimistic(commandId) }
    }

    private suspend fun deliver(message: OutgoingMessage, files: List<UploadFile>) {
        var uploadToken: String? = null
        var fileIds: List<ru.arny.taskbridge.core.api.UploadedFileId>? = null
        if (files.isNotEmpty()) {
            val upload = withRetries(message.commandId) { api.upload(files) } ?: return
            uploadToken = upload.token
            fileIds = upload.files.mapNotNull { it.id }.map { ru.arny.taskbridge.core.api.UploadedFileId(it) }
            setStatus(message.commandId, OutgoingMessage.Status.Sending)
        }
        val request = MessageRequest(
            text = message.text,
            mode = if (message.mode == SendMode.STEER) "steer" else "auto",
            now = message.mode == SendMode.NOW,
            queue = message.mode == SendMode.QUEUE,
            uploadToken = uploadToken,
            files = fileIds,
            commandId = message.commandId,
        )
        val task = withRetries(message.commandId) { api.message(taskId, request) } ?: return
        onDelivered(message.commandId, message.text, task)
    }

    private suspend fun onDelivered(commandId: String, text: String, task: Task) {
        // A server that does not record commandId on queue entries (older builds)
        // still parks the message: then the entry is ours by its text.
        val queued = task.pendingPrompts.any { it.commandId == commandId } ||
            task.pendingPrompts.any { it.commandId == null && it.text.trim() == text.trim() }
        mutex.withLock {
            val chat = reducer
            // Parked in the server queue: the banner above the composer shows it,
            // the bubble appears when it is really delivered.
            if (queued && chat != null) chat.removeOptimistic(commandId)
            chat?.syncTask(task)
            _state.update { s ->
                s.copy(task = task, chat = chat?.snapshot() ?: s.chat, outbox = s.outbox.filterNot { it.commandId == commandId })
            }
        }
    }

    /**
     * Runs one step of a delivery with the retry policy of the plan (§3.3):
     * transient failures repeat with the same command id, an in-flight command
     * is waited for, an unknown outcome is checked against the history, and a
     * final refusal gives the text back.
     */
    private suspend fun <T> withRetries(commandId: String, block: suspend () -> T): T? {
        var attempt = 0
        while (true) {
            try {
                return block()
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: ApiException) {
                val error = failure.error
                when {
                    error is ApiError.CommandInFlight -> {
                        delay(1000)
                        val status = runCatching { api.commandStatus(commandId) }.getOrNull()
                        if (status?.done == true) {
                            refreshRequests.trySend(Unit)
                            removeFromOutbox(commandId)
                            return null
                        }
                    }
                    error is ApiError.UnknownAfterCrash -> {
                        val landed = runCatching { api.events(taskId, 0, 0).any { it.type == "USER_MESSAGE" && it.string("commandId") == commandId } }.getOrDefault(false)
                        if (landed) removeFromOutbox(commandId) else setStatus(commandId, OutgoingMessage.Status.Unknown)
                        if (!landed) dropOptimistic(commandId)
                        return null
                    }
                    error.transient && attempt < 6 -> {
                        attempt += 1
                        setStatus(commandId, OutgoingMessage.Status.Retrying(attempt, error.message))
                        delay(backoff(attempt + 1, 1000))
                    }
                    else -> {
                        setStatus(commandId, OutgoingMessage.Status.Failed(error.message))
                        dropOptimistic(commandId)
                        return null
                    }
                }
            }
        }
    }

    private fun setStatus(commandId: String, status: OutgoingMessage.Status) {
        _state.update { s -> s.copy(outbox = s.outbox.map { if (it.commandId == commandId) it.copy(status = status) else it }) }
    }

    private fun removeFromOutbox(commandId: String) {
        _state.update { s -> s.copy(outbox = s.outbox.filterNot { it.commandId == commandId }) }
    }

    private suspend fun dropOptimistic(commandId: String) {
        mutex.withLock {
            val chat = reducer ?: return
            if (chat.hasOptimistic(commandId)) {
                chat.removeOptimistic(commandId)
                _state.update { it.copy(chat = chat.snapshot()) }
            }
        }
    }

    // --- commands -------------------------------------------------------------------

    /** STOP: ends the current answer (and the tools it runs). */
    fun cancel() = act("cancel") { api.cancel(taskId, ids()) }

    fun sendPendingNow(pendingId: String) = act("pending:$pendingId") { api.sendPendingNow(taskId, pendingId) }

    fun dropPending(pendingId: String) = act("pending:$pendingId") { api.dropPending(taskId, pendingId) }

    fun answerApproval(approvalId: String, allow: Boolean) = act("approval:$approvalId") {
        try {
            api.answerApproval(taskId, approvalId, allow)
        } catch (failure: ApiException) {
            // Someone else answered first: not an error for this operator.
            if (failure.error !is ApiError.NotFound) throw failure
        }
        _state.update { s -> s.copy(approvals = s.approvals.filterNot { it.approvalId == approvalId }) }
    }

    fun compact() = act("compact", "Контекст сжимается…") { api.compact(taskId) }

    fun setModel(model: ModelRef) = act("model") { api.setModel(taskId, model) }

    fun setThinking(level: String) = act("thinking") { api.setThinking(taskId, level) }

    fun setAutoCompaction(enabled: Boolean) = act("autoCompaction") { api.setAutoCompaction(taskId, enabled) }

    fun rename(title: String) = act("rename") { api.rename(taskId, title.trim()) }

    fun delete() = act("delete") {
        // "Not found": deleted already (another device, an earlier tap) — the outcome asked for.
        try {
            api.delete(taskId)
        } catch (gone: ApiException) {
            if (gone.error !is ApiError.NotFound) throw gone
        }
        _effects.tryEmit(ChatEffect.Deleted)
    }

    fun clear() = act("clear") { api.clear(taskId) }

    fun editMessage(turnId: String, text: String) = act("edit:$turnId") { api.editTurn(taskId, turnId, text) }

    fun editAnswer(turnId: String, text: String, asVariant: Boolean) = act("edit:$turnId") { api.editTurn(taskId, turnId, text, branch = asVariant) }

    fun deleteFrom(turnId: String) = act("delete:$turnId") { api.deleteTurn(taskId, turnId) }

    fun regenerate(answerId: String) = act("regenerate") { api.regenerate(taskId, answerId) }

    fun continueAnswer(answerId: String) = act("continue") { api.continueTurn(taskId, answerId) }

    fun selectVariant(turnSeq: Long, variantId: String) = act("variant") { api.selectVariant(taskId, turnSeq, variantId) }

    fun fork(turnId: String) = act("fork") {
        val forked = api.fork(taskId, turnId)
        _effects.tryEmit(ChatEffect.OpenSession(forked.id))
    }

    suspend fun toolOutput(toolCallId: String): Result<ToolOutput> = runCatching { api.toolOutput(taskId, toolCallId) }

    fun fileUrl(fileId: String): String = api.fileUrl(taskId, fileId)

    fun workspaceFileUrl(path: String): String = api.workspaceFileUrl(taskId, path)

    suspend fun readWorkspaceFile(path: String): Result<ByteArray> = runCatching { api.download(api.workspaceFileUrl(taskId, path)) }

    suspend fun readFile(fileId: String): Result<ByteArray> = runCatching { api.download(api.fileUrl(taskId, fileId)) }

    suspend fun openWorkspaceFileOnComputer(path: String, reveal: Boolean): Result<Unit> = runCatching { api.openWorkspaceFile(taskId, path, reveal) }

    suspend fun openFileOnComputer(fileId: String, reveal: Boolean): Result<Unit> = runCatching { api.openFile(taskId, fileId, reveal) }

    private fun act(key: String, startNotice: String? = null, block: suspend () -> Unit) {
        if (key in _state.value.busy) return
        _state.update { it.copy(busy = it.busy + key) }
        startNotice?.let { _effects.tryEmit(ChatEffect.Notice(it)) }
        scope.launch {
            try {
                block()
                refreshRequests.trySend(Unit)
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: ApiException) {
                notice(failure.error)
            } finally {
                _state.update { it.copy(busy = it.busy - key) }
            }
        }
    }

    private fun notice(error: ApiError) {
        _effects.tryEmit(ChatEffect.Notice(describe(error)))
    }
}

/** A sentence for the operator; the server's own text when it has one. */
fun describe(error: ApiError): String = when (error) {
    is ApiError.Unreachable -> "Нет связи с компьютером: ${error.message}"
    is ApiError.RouteNotFound -> "Версии приложения и TaskBridge не совпадают — обновите одно из них."
    is ApiError.AuthRequired -> "Нужно заново подключить устройство (код с компьютера)."
    else -> error.message
}
