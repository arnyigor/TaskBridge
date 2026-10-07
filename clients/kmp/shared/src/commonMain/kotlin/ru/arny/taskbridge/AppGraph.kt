package ru.arny.taskbridge

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.core.client.sessions.SessionAlerts
import ru.arny.taskbridge.core.client.sessions.SessionList
import ru.arny.taskbridge.core.client.sessions.displayStateOf
import ru.arny.taskbridge.core.client.settings.AppSettings
import ru.arny.taskbridge.core.client.settings.SettingsController
import ru.arny.taskbridge.core.client.settings.StoredConnection
import ru.arny.taskbridge.core.client.settings.savedAddressNeedsPairing
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
    val settings = AppSettings(platform.store, { newId() }, platform.kind, platform.secrets)
    var connection: Connected? by mutableStateOf(settings.serverUrl?.let { Connected(it) })
        private set

    /** The connect screen probes the address it is given; the saved one is probed once per launch. */
    private var savedAddressChecked = false

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
        savedAddressChecked = true
        return Connected(baseUrl).also { connection = it }
    }

    /**
     * A device that connected while the PC had pairing off keeps its address and no
     * device token, so it boots straight into the session list — where every write
     * then fails with «нужно заново подключить устройство», and that screen has no way
     * to ask for a code. So the saved address is checked once per launch, and only a
     * server that wants a code sends the app back to the connect screen (the address
     * stays and is prefilled there). An unreachable daemon keeps the list: offline is
     * not the same as unpaired.
     */
    fun verifySavedConnection() {
        val current = connection ?: return
        if (savedAddressChecked) return
        savedAddressChecked = true
        scope.launch {
            if (savedAddressNeedsPairing(current.api)) {
                current.close()
                connection = null
            }
        }
    }

    fun disconnect() {
        connection?.close()
        connection = null
        settings.forget()
    }

    /** An API for an address that is not saved yet (the connect screen checks it first). */
    fun probe(baseUrl: String): TaskBridgeApi = TaskBridgeApi(platform.httpClient(baseUrl), StoredConnection(settings, baseUrl))

    inner class Connected(val baseUrl: String) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val http = platform.httpClient(baseUrl)
        val api = TaskBridgeApi(http, StoredConnection(settings, baseUrl))
        val sessions = SessionList(
            api, scope, clockMillis = { nowMillis() },
            startLocalServer = platform.localServerLauncher?.let { launcher -> { launcher.start() } },
            // Проверяется в момент нажатия, а не при создании графа: каталог можно задать в настройках уже после подключения.
            localServerAvailable = { platform.localServerLauncher?.available() == true },
        )
        val settingsController = SettingsController(api, scope)
        private val persistence = platform.chatPersistence(baseUrl)
        private val chats = mutableMapOf<String, ChatSession>()
        private val alerts = SessionAlerts()
        private val _online = MutableStateFlow(true)
        val online = _online.asStateFlow()

        /** The session on screen: its alerts are not notified. */
        var visibleSession: String? = null

        private val _attention = MutableStateFlow<Set<String>>(emptySet())

        /**
         * Sessions that alerted while the operator was elsewhere. Their rows pulse in
         * the list, and the session leaves the set when its chat is opened.
         */
        val attention: StateFlow<Set<String>> = _attention.asStateFlow()

        fun clearAttention(taskId: String) {
            if (taskId in _attention.value) _attention.update { it - taskId }
        }

        init {
            scope.launch {
                platform.networkAvailable().distinctUntilChanged().collectLatest { available ->
                    if (!available) {
                        _online.value = false
                        return@collectLatest
                    }
                    refreshHostReachability()
                    wakeUp()
                }
            }
            scope.launch { refreshHostReachability() }
            // Notifications and the background watch follow the list.
            scope.launch {
                sessions.state.collectLatest { state ->
                    val info = state.info
                    settingsController.syncProviderStatuses(info?.providerStatuses.orEmpty())
                    // A different database (restored or recreated): nothing cached here is valid.
                    if (info?.storeId != null && info.storeId != settings.storeId) {
                        settings.storeId = info.storeId
                    }
                    for (alert in alerts.update(state.tasks)) {
                        val onScreen = platform.inForeground && alert.taskId == visibleSession
                        if (onScreen) continue
                        _attention.update { it + alert.taskId }
                        platform.notify(alert)
                    }
                    platform.setBackgroundWatch(state.tasks.count { displayStateOf(it).active || displayStateOf(it) == DisplayState.WAITING_USER })
                }
            }
            sessions.start()
            settingsController.loadMcp()
            settingsController.loadModels()
        }

        /** One ChatSession per open session, kept while the connection lives (switching back is instant). */
        fun chat(taskId: String): ChatSession = chats.getOrPut(taskId) {
            ChatSession(api, taskId, scope, ids = { newId() }, now = { nowIso() }, persistence = persistence).also { it.start() }
        }

        fun closeChat(taskId: String) {
            chats.remove(taskId)?.close()
        }

        private suspend fun refreshHostReachability() {
            _online.value = api.health()
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
            http.close()
            scope.cancel()
        }
    }
}
