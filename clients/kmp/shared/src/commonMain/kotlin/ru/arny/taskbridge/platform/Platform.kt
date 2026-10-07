package ru.arny.taskbridge.platform

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draganddrop.DragAndDropEvent
import io.ktor.client.HttpClient
import kotlinx.coroutines.flow.Flow
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.core.client.session.ChatPersistence
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.core.client.settings.SecretStore

/**
 * What the shared UI needs from the platform. Implemented once per app
 * (AndroidPlatformServices, DesktopPlatformServices) and handed to App().
 */
interface PlatformServices {
    /** "android" or "desktop": the prefix of this device's client id. */
    val kind: String

    /** The installed app version, e.g. "1.1.5"; empty when the platform cannot know it (settings shows "—"). */
    val appVersion: String

    val store: KeyValueStore
    val secrets: SecretStore

    /** Durable cache/outbox scoped to one server URL. */
    fun chatPersistence(serverUrl: String): ChatPersistence

    /**
     * An HTTP client whose socket reads never time out: SSE streams stay open for hours.
     * [baseUrl] lets Android route LAN TaskBridge traffic over Wi-Fi even when that
     * Wi-Fi has no validated Internet and is not the system default network.
     */
    fun httpClient(baseUrl: String? = null): HttpClient

    /** Emits connectivity changes so suspended SSE/outbox work can resume immediately. */
    fun networkAvailable(): Flow<Boolean>

    fun copyText(text: String)

    /** Local wall-clock time, e.g. "14:03". */
    fun formatClock(epochMillis: Long): String

    /** Local date, e.g. "12 сент.". */
    fun formatDate(epochMillis: Long): String

    /** A system notification for a session (replaces the previous one of that session). */
    fun notify(alert: SessionAlert)

    fun clearNotification(taskId: String)

    /** Whether the app window/activity is in front: alerts for what is on screen are skipped. */
    val inForeground: Boolean

    /**
     * Android: keep watching sessions while the app is in the background
     * (foreground service); desktop: nothing, the process keeps running.
     */
    fun setBackgroundWatch(activeSessions: Int)

    /** Opens a link or a file URL with the system (browser, viewer). */
    fun openUrl(url: String)

    /** Saves bytes to a user-visible Downloads location; when [open] is true, also asks the system to open it. */
    suspend fun saveFile(name: String, bytes: ByteArray, mimeType: String? = null, open: Boolean = false): Result<String> =
        Result.failure(UnsupportedOperationException("Сохранение файлов на этой платформе не поддерживается"))

    /**
     * The «Выход» button: stop the background watch and close the app for good
     * (Android kills the process, so nothing polls the server until relaunch).
     * Desktop: no-op, its window/tray has its own close.
     */
    fun exitApp() {}

    /** Desktop folder dialog; null when cancelled or unavailable on this device. */
    fun chooseProjectFolder(): String? = null

    /**
     * Desktop: файлы, перетащенные из проводника на окно приложения, уходят
     * последнему зарегистрированному получателю (активный чат); null снимает.
     * Android — no-op (перетаскивание не поддерживается).
     */
    fun setFileDropHandler(handler: ((List<UploadFile>) -> Unit)?) {}

    /**
     * Запуск/перезапуск локального TaskBridge-сервера силами самого приложения
     * (только desktop): потушенный сервер поднимается скрытым процессом, без
     * консольного окна. null — платформа не умеет (Android и не должна:
     * сервер на телефоне не живёт).
     */
    val localServerLauncher: LocalServerLauncher? get() = null
}

/** Запуск локального сервера скрытым процессом. Бросает исключение с причиной, если не вышелось. */
interface LocalServerLauncher {
    /** Каталог сервера найден: кнопку запуска можно показывать. */
    fun available(): Boolean

    /**
     * Найденный корень TaskBridge, из которого запускается сервер; null — не найден.
     * Нужен UI, чтобы показать, какой именно каталог выбран: «найден автоматически»
     * не даёт понять, что поиск ушёл не туда.
     */
    fun root(): String? = null

    /**
     * Последние строки логов сервера (`lan-app.log`, `lan-proxy.log` и вывод запуска из
     * приложения) — для показа в настройках. null — платформа логов не знает (Android).
     */
    fun logTail(lines: Int = 200): String? = null

    /** Поднимает сервер (scripts/start-lan.mjs start) и ждёт его готовности. */
    suspend fun start()
}

/** Status and navigation bar icons follow the app theme, not the system one (Android); no-op on desktop. */
@Composable
expect fun SystemBarsAppearance(dark: Boolean)

/** System back (Android); no-op on desktop, where Esc is handled by the screens. */
@Composable
expect fun PlatformBackHandler(enabled: Boolean, onBack: () -> Unit)

/** Returns a function that opens the system file picker; picked files arrive read into memory. */
@Composable
expect fun rememberFilePicker(onPicked: (List<UploadFile>) -> Unit): () -> Unit

/** Returns a function that reads the pictures (or copied files) in the clipboard; empty when it holds none. */
@Composable
expect fun rememberClipboardFiles(): () -> List<UploadFile>

/**
 * Файлы, перетащенные из проводника на окно (десктоп). Оба объявления — про
 * буфер AWT, поэтому и проверка, и чтение живут в платформе; на телефоне
 * возвращается false и пустой список (перетаскивания там нет).
 */
expect fun hasFileDrop(event: DragAndDropEvent): Boolean

expect fun dragDroppedFiles(event: DragAndDropEvent): List<UploadFile>

/** Приём файлов, перетащенных в окно приложения; на телефоне — no-op. */
expect fun Modifier.fileDropTarget(onFiles: (List<UploadFile>) -> Unit): Modifier
