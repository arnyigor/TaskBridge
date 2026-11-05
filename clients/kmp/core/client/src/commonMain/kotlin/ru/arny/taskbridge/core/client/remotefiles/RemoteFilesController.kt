package ru.arny.taskbridge.core.client.remotefiles

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.*
import kotlin.uuid.Uuid

/** Memory only: no file bytes, preview or upload token enter ChatPersistence. */
data class RemoteFilesState(
    val projectId: String,
    val taskId: String? = null,
    val rootId: String? = null,
    val path: String = "",
    val settings: ExternalReadSettings = ExternalReadSettings(),
    val entries: List<RemoteFileEntry> = emptyList(),
    val nextCursor: String? = null,
    val loading: Boolean = false,
    val busy: Boolean = false,
    val online: Boolean = false,
    val error: String? = null,
    val preview: RemoteFilePreview? = null,
    val requestPath: String = "",
    val requestedPermissions: Set<String> = setOf("browse", "preview"),
    val review: ExternalReadRequest? = null,
    val revoking: RemoteFileRoot? = null,
    val operatorPath: String = "",
    val query: String = "",
    val searchSummary: String? = null,
    val prepared: UploadResult? = null,
    val attachmentText: String = "",
) {
    val root: RemoteFileRoot? get() = settings.roots.firstOrNull { it.id == rootId }
    val canAct: Boolean get() = online && !loading && !busy
}

sealed interface RemoteFilesEvent {
    data class Location(val rootId: String?, val path: String) : RemoteFilesEvent
    data object Sent : RemoteFilesEvent
}

@OptIn(kotlin.uuid.ExperimentalUuidApi::class)
class RemoteFilesController(
    private val api: TaskBridgeApi,
    projectId: String,
    taskId: String?,
    private val scope: CoroutineScope,
    rootId: String? = null,
    path: String = "",
    private val ids: () -> String = { Uuid.random().toString() },
) {
    private val mutable = MutableStateFlow(RemoteFilesState(projectId, taskId, rootId, path))
    val state = mutable.asStateFlow()
    private val eventChannel = Channel<RemoteFilesEvent>(Channel.BUFFERED)
    val events = eventChannel.receiveAsFlow()
    private var visible = false
    private var generation = 0
    private var work: Job? = null
    private var polling: Job? = null
    private var commandKey: String? = null
    private var commandId: String? = null

    fun show() { visible = true; if (state.value.online) refresh() }
    fun hide() {
        visible = false
        cancelWork()
        mutable.update { it.copy(entries = emptyList(), preview = null, prepared = null, review = null, revoking = null, attachmentText = "", loading = false, busy = false) }
    }
    fun setOnline(online: Boolean) {
        if (state.value.online == online) return
        mutable.update { it.copy(online = online) }
        if (!online) {
            cancelWork()
            mutable.update { it.copy(entries = emptyList(), preview = null, prepared = null, loading = false, busy = false) }
        } else if (visible) refresh()
    }
    private fun cancelWork() { generation++; work?.cancel(); polling?.cancel() }
    private fun allowed() = visible && state.value.online
    private fun error(failure: Throwable) = (failure as? ApiException)?.error?.message ?: failure.message ?: "Не удалось выполнить операцию"
    private fun command(key: String): String {
        if (commandKey != key) { commandKey = key; commandId = ids() }
        return commandId!!
    }
    private fun poll() {
        polling?.cancel()
        if (!allowed() || state.value.settings.requests.none { it.status == "PENDING" }) return
        val epoch = generation
        polling = scope.launch {
            while (allowed() && epoch == generation) {
                delay(5000)
                try {
                    val settings = api.externalRead(state.value.projectId)
                    if (epoch != generation || !allowed()) return@launch
                    mutable.update { it.copy(settings = settings) }
                    if (settings.requests.none { it.status == "PENDING" }) return@launch
                } catch (cancel: CancellationException) { throw cancel }
                catch (failure: Throwable) {
                    mutable.update { it.copy(error = error(failure), preview = null) }
                    return@launch
                }
            }
        }
    }
    private fun run(loading: Boolean = false, block: suspend (Int) -> Unit) {
        if (!allowed()) return
        cancelWork()
        val epoch = generation
        mutable.update { it.copy(loading = loading, busy = !loading, error = null) }
        work = scope.launch {
            try { block(epoch) }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Throwable) {
                if (epoch == generation) {
                    mutable.update { it.copy(error = error(failure), preview = null) }
                    // Never silently retry a mutation with a different revision.
                    try {
                        val settings = api.externalRead(state.value.projectId)
                        if (epoch == generation) mutable.update { it.copy(settings = settings) }
                    } catch (cancel: CancellationException) { throw cancel }
                    catch (_: Throwable) { /* retain the original failure */ }
                }
            } finally {
                if (epoch == generation) {
                    mutable.update { it.copy(loading = false, busy = false) }
                    poll()
                }
            }
        }
    }
    fun refresh() = run(loading = true) { epoch ->
        val settings = api.externalRead(state.value.projectId)
        if (epoch != generation) return@run
        mutable.update { it.copy(settings = settings, preview = null) }
        val current = state.value
        if (current.root?.canBrowse == true && current.root?.available == true) {
            val listing = api.remoteBrowse(current.projectId, current.rootId!!, current.path)
            if (epoch == generation) mutable.update { it.copy(entries = listing.entries, nextCursor = listing.nextCursor, searchSummary = if (listing.truncated) "Список ограничен первыми 5000 записями." else null) }
        } else mutable.update { it.copy(entries = emptyList(), nextCursor = null) }
    }
    fun navigate(rootId: String?, path: String = "") {
        if (state.value.busy || !allowed()) return
        mutable.update { it.copy(rootId = rootId, path = path, entries = emptyList(), preview = null, nextCursor = null, searchSummary = null, query = "") }
        eventChannel.trySend(RemoteFilesEvent.Location(rootId, path))
        refresh()
    }
    fun loadMore() {
        val current = state.value
        val root = current.rootId ?: return
        val cursor = current.nextCursor ?: return
        run(loading = true) { epoch ->
            val listing = api.remoteBrowse(current.projectId, root, current.path, cursor)
            if (epoch == generation) mutable.update { it.copy(entries = (it.entries + listing.entries).distinctBy { entry -> entry.path }, nextCursor = listing.nextCursor) }
        }
    }
    fun preview(entry: RemoteFileEntry) {
        val current = state.value
        val root = current.rootId ?: return
        run { epoch ->
            val preview = api.remotePreview(current.projectId, root, entry.path)
            if (epoch == generation) mutable.update { it.copy(preview = preview) }
        }
    }
    fun dismissPreview() { mutable.update { it.copy(preview = null) } }
    fun editRequestPath(value: String) { mutable.update { it.copy(requestPath = value) } }
    fun permission(value: String, checked: Boolean) { mutable.update { it.copy(requestedPermissions = if (checked) it.requestedPermissions + value else it.requestedPermissions - value) } }
    fun request() {
        val current = state.value
        if (!current.canAct || current.requestPath.isBlank() || current.requestedPermissions.isEmpty()) return
        val permissions = current.requestedPermissions.sorted()
        val id = command("request:${current.requestPath}:$permissions:${current.settings.revision}")
        run { epoch ->
            api.requestExternalRead(current.projectId, current.requestPath, permissions, current.settings.revision, id)
            val settings = api.externalRead(current.projectId)
            if (epoch == generation) { commandKey = null; mutable.update { it.copy(settings = settings, requestPath = "") } }
        }
    }
    fun review(request: ExternalReadRequest?) { mutable.update { it.copy(review = request, operatorPath = request?.requestedPath.orEmpty()) } }
    fun editOperatorPath(value: String) { mutable.update { it.copy(operatorPath = value) } }
    fun decide(approved: Boolean) {
        val current = state.value
        val request = current.review ?: return
        if (!current.canAct || !current.settings.localOperator || (approved && current.operatorPath.isBlank())) return
        val id = command("decision:${request.id}:$approved:${current.operatorPath}:${current.settings.revision}")
        run { epoch ->
            api.decideExternalRead(current.projectId, request.id, approved, current.operatorPath, current.settings.revision, id)
            val settings = api.externalRead(current.projectId)
            if (epoch == generation) { commandKey = null; mutable.update { it.copy(settings = settings, review = null) } }
        }
    }
    fun toggle(root: RemoteFileRoot) {
        val current = state.value
        if (!current.canAct) return
        val id = command("toggle:${root.id}:${!root.enabled}:${current.settings.revision}")
        run { epoch ->
            val settings = api.toggleExternalRead(current.projectId, root.id, !root.enabled, current.settings.revision, id)
            if (epoch == generation) { commandKey = null; mutable.update { it.copy(settings = settings, preview = null, entries = emptyList()) } }
        }
    }
    fun selectRevoke(root: RemoteFileRoot?) { mutable.update { it.copy(revoking = root) } }
    fun revoke() {
        val current = state.value
        val root = current.revoking ?: return
        if (!current.canAct || !current.settings.localOperator) return
        val id = command("revoke:${root.id}:${current.settings.revision}")
        run { epoch ->
            val settings = api.revokeExternalRead(current.projectId, root.id, current.settings.revision, id)
            if (epoch == generation) { commandKey = null; mutable.update { it.copy(settings = settings, revoking = null, preview = null, prepared = null, entries = emptyList()) } }
        }
    }
    fun editQuery(value: String) { mutable.update { it.copy(query = value) } }
    fun search() {
        val current = state.value
        val root = current.rootId ?: return
        if (!current.canAct || current.query.isBlank()) return
        run(loading = true) { epoch ->
            val result = api.remoteSearch(current.projectId, root, current.query)
            if (epoch == generation) mutable.update { it.copy(entries = result.entries, nextCursor = null, preview = null, searchSummary = "Проверено папок: ${result.checkedDirectories}" + if (result.truncated) ". Поиск ограничен." else ".") }
        }
    }
    fun prepare(entry: RemoteFileEntry) {
        val current = state.value
        val task = current.taskId ?: return
        val root = current.rootId ?: return
        if (!current.canAct) return
        val id = command("prepare:$task:$root:${entry.path}:${current.settings.revision}")
        run { epoch ->
            val upload = api.prepareRemoteAttachment(task, root, entry.path, current.settings.revision, id)
            if (epoch == generation) { commandKey = null; mutable.update { it.copy(prepared = upload) } }
        }
    }
    fun editAttachmentText(value: String) { mutable.update { it.copy(attachmentText = value) } }
    fun dismissAttachment() { mutable.update { it.copy(prepared = null, attachmentText = "") } }
    fun sendAttachment() {
        val current = state.value
        val task = current.taskId ?: return
        val upload = current.prepared ?: return
        if (!current.canAct) return
        val id = command("send:$task:${upload.token}:${current.attachmentText}")
        run { epoch ->
            api.message(task, MessageRequest(text = current.attachmentText, uploadToken = upload.token, files = upload.files.mapNotNull { it.id }.map(::UploadedFileId), commandId = id, queue = true))
            if (epoch == generation) {
                commandKey = null
                mutable.update { it.copy(prepared = null, attachmentText = "") }
                eventChannel.send(RemoteFilesEvent.Sent)
            }
        }
    }
}
