package ru.arny.taskbridge

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.core.client.sessions.SessionAlerts
import ru.arny.taskbridge.core.client.sessions.SessionList
import ru.arny.taskbridge.core.client.sessions.displayStateOf
import ru.arny.taskbridge.core.client.settings.AppSettings
import ru.arny.taskbridge.core.client.settings.StoredConnection
import ru.arny.taskbridge.platform.PlatformServices
import kotlin.time.Clock
import kotlin.uuid.Uuid

/**
 * The app's long-lived objects. One per process: the Android app and the
 * desktop app each create it once and pass it to [App]. A connection (server
 * address) owns the API, the session list and the open chats; switching the
 * server replaces all of them.
 */
class AppGraph(val platform: PlatformServices) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val settings = AppSettings(platform.store, { newId() }, platform.kind)
    private val http = platform.httpClient()

    var connection: Connected? by mutableStateOf(settings.serverUrl?.let { Connected(it) })
        private set

    /** The theme choice, observable so the whole UI follows a change at once. */
    var theme: String by mutableStateOf(settings.theme)
        private set

    fun changeTheme(mode: String) {
        settings.theme = mode
        theme = mode
    }

    fun newId(): String = Uuid.random().toString()

    fun nowIso(): String = Clock.System.now().toString()

    fun nowMillis(): Long = Clock.System.now().toEpochMilliseconds()

    fun connect(baseUrl: String): Connected {
        connection?.close()
        settings.serverUrl = baseUrl
        return Connected(baseUrl).also { connection = it }
    }

    fun disconnect() {
        connection?.close()
        connection = null
        settings.forget()
    }

    /** An API for an address that is not saved yet (the connect screen checks it first). */
    fun probe(baseUrl: String): TaskBridgeApi = TaskBridgeApi(http, StoredConnection(settings, baseUrl))

    inner class Connected(val baseUrl: String) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val api = TaskBridgeApi(http, StoredConnection(settings, baseUrl))
        val sessions = SessionList(api, scope, clockMillis = { nowMillis() })
        private val chats = mutableMapOf<String, ChatSession>()
        private val alerts = SessionAlerts()

        /** The session on screen: its alerts are not notified. */
        var visibleSession: String? = null

        init {
            // Notifications and the background watch follow the list.
            scope.launch {
                sessions.state.collectLatest { state ->
                    val info = state.info
                    // A different database (restored or recreated): nothing cached here is valid.
                    if (info?.storeId != null && info.storeId != settings.storeId) {
                        settings.storeId = info.storeId
                    }
                    for (alert in alerts.update(state.tasks)) {
                        val onScreen = platform.inForeground && alert.taskId == visibleSession
                        if (!onScreen) platform.notify(alert)
                    }
                    platform.setBackgroundWatch(state.tasks.count { displayStateOf(it).active || displayStateOf(it) == DisplayState.WAITING_USER })
                }
            }
            sessions.start()
        }

        /** One ChatSession per open session, kept while the connection lives (switching back is instant). */
        fun chat(taskId: String): ChatSession = chats.getOrPut(taskId) {
            ChatSession(api, taskId, scope, ids = { newId() }, now = { nowIso() }).also { it.start() }
        }

        fun closeChat(taskId: String) {
            chats.remove(taskId)?.close()
        }

        /** Network back or app in front again: reconnect streams now instead of waiting out the backoff. */
        fun wakeUp() {
            sessions.refresh()
            chats.values.forEach { it.reconnectNow() }
        }

        fun close() {
            sessions.stop()
            chats.values.forEach { it.close() }
            chats.clear()
            scope.cancel()
        }
    }
}
