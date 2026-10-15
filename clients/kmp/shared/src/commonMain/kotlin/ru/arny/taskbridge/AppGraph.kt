package ru.arny.taskbridge

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.session.LinkState
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

/** Ни одна попытка связи не стоит чаще 3 с; дальше — с потолком 30 с. */
internal const val OFFLINE_RETRY_MIN_MS = 3_000L
internal const val OFFLINE_RETRY_MAX_MS = 30_000L

/**
 * Когда связь есть, цикл самовосстановления почти молчит: его задача — заметить
 * потерю, а не опрашивать сервер вместо списка сессий.
 */
internal const val ONLINE_IDLE_MS = 15_000L

/**
 * Пауза перед следующей пробой связи при offline: удвоение с потолком.
 *
 * Чистая функция, чтобы «стало ли хуже» решалось тестом, а не ожиданием в UI.
 */
internal fun offlineRetryDelayMs(attempt: Int): Long {
    if (attempt <= 0) return OFFLINE_RETRY_MIN_MS
    var delay = OFFLINE_RETRY_MIN_MS
    repeat(attempt.coerceAtMost(16)) { delay = (delay * 2).coerceAtMost(OFFLINE_RETRY_MAX_MS) }
    return delay
}

/**
 * The app's long-lived objects. One per process: the Android app and the
 * desktop app each create it once and pass it to [App]. A connection (server
 * address) owns the API, the session list and the open chats; switching the
 * server replaces all of them.
 */

/**
 * Состояние связи устройства для серверной наблюдаемости (фаза 4).
 *
 * Одно состояние на устройство, а не на чат: у каждой сессии свой поток, и если
 * докладывать по кажной, сервер считал бы эпизоды по числу открытых чатов.
 * Приоритет: нет сервера → reconnecting; сервер есть, но поток оборван → degraded;
 * остальное → live. Чистая функция — чтобы это решение проверялось тестом.
 */
internal fun linkReportFor(online: Boolean, degradedReasons: List<String>): Pair<String, String?> = when {
    !online -> "reconnecting" to "health probe failed"
    degradedReasons.isNotEmpty() -> "degraded" to degradedReasons.first()
    else -> "live" to null
}

private data class ChatStreamTarget(val target: ChatSession?, val chats: List<ChatSession>)

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
            // Раздел 4.3: в фоне список опрашивается только пока идёт работа, и реже
            // при экономии энергии — иначе телефон греется и садится на пустых запросах.
            inForeground = { platform.inForeground },
            powerSave = { platform.powerSaveMode },
            // Если единственная работа уже видна через SSE, список нужен лишь как
            // редкий контрольный снимок, а не второй канал каждые 5 секунд.
            streamedTaskId = { visibleSession.takeIf { platform.inForeground } },
            startLocalServer = platform.localServerLauncher?.let { launcher -> { launcher.start() } },
            // Проверяется в момент нажатия, а не при создании графа: каталог можно задать в настройках уже после подключения.
            localServerAvailable = { platform.localServerLauncher?.available() == true },
        )
        val settingsController = SettingsController(api, scope)
        private val persistence = platform.chatPersistence(baseUrl)
        // Copy-on-write: UI, network callbacks and the stream actor may read snapshots
        // concurrently, but no iterator ever observes a mutating HashMap.
        private var chats: Map<String, ChatSession> = emptyMap()
        /**
         * Serializes chat switches: the old socket is joined before the next opens.
         * Lifecycle commands are never conflated: a close command carries the removed
         * session as a join barrier and must not be overwritten by a later navigation.
         */
        private val streamTargets = Channel<ChatStreamTarget>(Channel.UNLIMITED)
        private val alerts = SessionAlerts()
        private val _online = MutableStateFlow(true)
        val online = _online.asStateFlow()

        /** The session on screen: its alerts are not notified and it alone may hold SSE. */
        var visibleSession: String? = null
            private set

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
                for (command in streamTargets) {
                    // Disable and fully join every old stream before enabling the target.
                    // The immutable command snapshot avoids concurrent-map iteration;
                    // a session closed after enqueue is terminal and refuses to reopen.
                    command.chats.forEach { chat ->
                        if (chat !== command.target) chat.setStreamingEnabled(false)
                    }
                    command.target?.setStreamingEnabled(true)
                }
            }
            scope.launch {
                platform.networkAvailable().distinctUntilChanged().collectLatest { available ->
                    if (!available) {
                        _online.value = false
                        return@collectLatest
                    }
                    refreshHostReachability()
                    registerWakeChannel()
                    wakeUp()
                }
            }
            registerWakeChannel()
            scope.launch { refreshHostReachability() }
            scope.launch { healOfflineLink() }
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
                    if (!state.loading) {
                        val reachable = state.error !is ApiError.Unreachable
                        val recovered = !_online.value && reachable
                        _online.value = reachable
                        if (recovered) chats.values.forEach { it.reconnectNow() }
                    }
                }
            }
            sessions.start()
            settingsController.loadMcp()
            settingsController.loadModels()
        }

        /**
         * One retained reducer/cache per opened chat, but never one socket per chat:
         * only the visible foreground chat streams. Switching back is still instant
         * and the cursor catches up any events missed while hidden.
         */
        fun chat(taskId: String): ChatSession = chats[taskId] ?: ChatSession(
            api, taskId, scope,
            ids = { newId() }, now = { nowIso() }, persistence = persistence,
            initialStreamingEnabled = false,
        ).also {
            chats = chats + (taskId to it)
            it.start()
            // Переход связи этого чата влияет на состояние устройства (degraded),
            // и сервер должен узнать об этом один раз на ПЕРЕХОД: без
            // distinctUntilChanged каждый дельта-кадр (их десятки в секунду)
            // заново сравнивал бы состояние со всеми открытыми чатами.
            scope.launch {
                it.state
                    .map { state -> state.link::class.simpleName to (state.link as? LinkState.Degraded)?.reason }
                    .distinctUntilChanged()
                    .collect { reportLinkOnce() }
            }
        }

        fun showChat(taskId: String) {
            visibleSession = taskId
            syncChatStreaming()
        }

        fun hideChat(taskId: String) {
            if (visibleSession != taskId) return
            visibleSession = null
            syncChatStreaming()
        }

        /** Called after the platform foreground flag changes. */
        fun appVisibilityChanged() {
            syncChatStreaming()
        }

        private fun syncChatStreaming(joinBarriers: List<ChatSession> = emptyList()) {
            val snapshot = chats
            val target = visibleSession.takeIf { platform.inForeground }?.let(snapshot::get)
            streamTargets.trySend(ChatStreamTarget(target, snapshot.values.toList() + joinBarriers))
        }

        fun closeChat(taskId: String) {
            val closing = chats[taskId] ?: return
            chats = chats - taskId
            closing.close()
            if (visibleSession == taskId) visibleSession = null
            // Even though it left the map, the actor must join its cancelled socket
            // before any queued target is allowed to start.
            syncChatStreaming(joinBarriers = listOf(closing))
        }

        /** Свой push в локальной сети (4.3): сервер будит приёмник при завершении хода. */
        private fun registerWakeChannel() {
            val port = platform.wakeListenerPort() ?: return
            platform.onWake = { scope.launch { wakeUp() } }
            scope.launch {
                runCatching { api.registerWakeChannel(port) }
            }
        }

        private suspend fun refreshHostReachability() {
            _online.value = api.health()
            reportLinkOnce()
        }

        /**
         * Последнее доложенное состояние связи: сервер считает эпизоды переходами,
         * поэтому повтор одного и того же состояния — это лишний запрос, а не данные.
         */
        private var lastLinkReport: Pair<String, String?>? = null

        /**
         * Сообщает серверу, что связь у этого устройства изменилась (фаза 4).
         *
         * Ошибка отправки глушится: наблюдаемость не имеет права мешать работе —
         * тот же принцип, что у wake-канала (4.3). Содержимое сессии сюда не
         * попадает: только состояние, причина и номер попытки.
         */
        private fun reportLinkOnce(attempt: Int? = null) {
            val current = linkReportFor(
                online = _online.value,
                degradedReasons = chats.values.mapNotNull { (it.state.value.link as? LinkState.Degraded)?.reason },
            )
            if (current == lastLinkReport) return
            lastLinkReport = current
            scope.launch { runCatching { api.reportLinkState(current.first, current.second, attempt) } }
        }

        /**
         * Пока связи нет — пробуем сами.
         *
         * Почему это нужно: холодный старт приложения приходит раньше, чем создано
         * соединение (MainActivity.onStart видит `connection == null` и `wakeUp()`
         * не вызывается), а неудачная первая попытка оставляла `online = false`
         * навсегда — оператор видел «offline» до тех пор, пока вручную не выйдет
         * из сервера в настройках и не войдёт снова. Ровно это и происходило
         * 2026-10-14: сообщение дошло до сервера, а клиент остался «offline» с
         * неотправленным исходящим.
         *
         * Цена — по одному запросу /api/health в 3—30 с, пока связи нет (обратный
         * отсчёт с потолком). Это противоположно осознанному «реже в фоне» (4.3),
         * но восстанавливающийся offline без этого невозможен: без запросов
         * узнавать о связи неоткуда. Когда связь есть, цикл молчит и ничего не стоит.
         */
        private suspend fun healOfflineLink() {
            var attempt = 0
            while (true) {
                if (_online.value) {
                    attempt = 0
                    delay(ONLINE_IDLE_MS)
                    continue
                }
                delay(offlineRetryDelayMs(attempt))
                attempt += 1
                refreshHostReachability()
                if (_online.value) wakeUp() else sessions.refresh()
            }
        }

        /** Network back or app in front again: only the visible stream wakes; every outbox resumes. */
        fun wakeUp() {
            syncChatStreaming()
            sessions.refresh()
            // reconnectNow gates stream/refresh by streamingEnabled, while delivery is
            // intentionally visibility-independent.
            chats.values.forEach { it.reconnectNow() }
        }

        fun close() {
            sessions.stop()
            chats.values.forEach { it.close() }
            chats = emptyMap()
            http.close()
            scope.cancel()
        }
    }
}
