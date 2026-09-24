package ru.arny.taskbridge.core.client.settings

import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.ApiInfo
import ru.arny.taskbridge.core.api.Compatibility
import ru.arny.taskbridge.core.api.Connection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.compatibilityOf

/** Small persistent key/value storage the platform provides (SharedPreferences, java.util.prefs). */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String?)
}

/** What the app remembers between launches. */
class AppSettings(private val store: KeyValueStore, private val newId: () -> String, private val platform: String) {
    var serverUrl: String?
        get() = store.get("serverUrl")
        set(value) = store.put("serverUrl", value)

    var sessionCookie: String?
        get() = store.get("sessionCookie")
        set(value) = store.put("sessionCookie", value)

    /** e.g. android-3f2a9c1e: tells other devices where a message came from. */
    val clientId: String
        get() = store.get("clientId") ?: "$platform-${newId().replace("-", "").take(8)}".also { store.put("clientId", it) }

    /** The storeId the cached cursors belong to (backend invariant I10). */
    var storeId: String?
        get() = store.get("storeId")
        set(value) = store.put("storeId", value)

    /** "system" / "light" / "dark". */
    var theme: String
        get() = store.get("theme") ?: "system"
        set(value) = store.put("theme", value)

    /** Enter sends (true) or inserts a newline (false) on hardware keyboards. */
    var enterSends: Boolean
        get() = store.get("enterSends") != "false"
        set(value) = store.put("enterSends", value.toString())

    var lastSessionId: String?
        get() = store.get("lastSessionId")
        set(value) = store.put("lastSessionId", value)

    fun draft(taskId: String): String = store.get("draft:$taskId").orEmpty()

    fun saveDraft(taskId: String, text: String) = store.put("draft:$taskId", text.ifEmpty { null })

    fun forget() {
        serverUrl = null
        sessionCookie = null
        storeId = null
    }
}

/** The [Connection] the API uses, backed by [AppSettings] so pairing survives restarts. */
class StoredConnection(private val settings: AppSettings, override val baseUrl: String) : Connection {
    override var sessionCookie: String?
        get() = settings.sessionCookie
        set(value) { settings.sessionCookie = value }
    override val clientId: String get() = settings.clientId
}

/** The typed result of checking an address before using it. */
sealed interface ConnectResult {
    data class Ready(val info: ApiInfo) : ConnectResult
    data class NeedsPairing(val info: ApiInfo) : ConnectResult
    data class Unsupported(val serverVersion: Int) : ConnectResult
    data class Failed(val message: String) : ConnectResult
}

/** Accepts what people type: "192.168.1.5:8787", "pc.local", "https://…/". */
fun normalizeServerUrl(input: String): String? {
    var text = input.trim().trimEnd('/')
    if (text.isEmpty()) return null
    if (!text.contains("://")) text = "http://$text"
    val scheme = text.substringBefore("://").lowercase()
    if (scheme != "http" && scheme != "https") return null
    val rest = text.substringAfter("://")
    val host = rest.substringBefore('/').substringBefore('?')
    if (host.isEmpty() || host.contains(' ')) return null
    val hostOnly = if (host.startsWith("[")) host else host.substringBefore(':')
    if (hostOnly.isEmpty()) return null
    val port = if (host.startsWith("[")) null else host.substringAfter(':', "").takeIf { it.isNotEmpty() }
    if (port != null && port.toIntOrNull() !in 1..65535) return null
    // A bare host means the TaskBridge default port.
    val withPort = if (port == null && !host.startsWith("[") && scheme == "http") "$host:8787" else host
    return "$scheme://$withPort"
}

/**
 * Checks the daemon behind [api]: reachable, pairing done, a known API version.
 * /api/auth is open without pairing; /api/info is not, so it is read after.
 */
suspend fun checkConnection(api: TaskBridgeApi): ConnectResult {
    return try {
        val auth = api.auth()
        if (auth.enabled && !auth.authenticated) return ConnectResult.NeedsPairing(ApiInfo())
        val info = api.info()
        when (val compatibility = compatibilityOf(info)) {
            is Compatibility.UnsupportedApi -> ConnectResult.Unsupported(compatibility.serverVersion)
            Compatibility.Ok -> ConnectResult.Ready(info)
        }
    } catch (failure: ApiException) {
        when (val error = failure.error) {
            is ApiError.AuthRequired -> ConnectResult.NeedsPairing(ApiInfo())
            is ApiError.Unreachable -> ConnectResult.Failed("Не удалось подключиться: ${error.message}. Проверьте адрес и что компьютер в той же сети.")
            is ApiError.RouteNotFound, is ApiError.NotFound -> ConnectResult.Failed("По этому адресу отвечает не TaskBridge.")
            else -> ConnectResult.Failed(error.message)
        }
    }
}
