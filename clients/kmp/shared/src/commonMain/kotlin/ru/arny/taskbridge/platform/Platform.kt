package ru.arny.taskbridge.platform

import androidx.compose.runtime.Composable
import io.ktor.client.HttpClient
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.core.client.settings.KeyValueStore

/**
 * What the shared UI needs from the platform. Implemented once per app
 * (AndroidPlatformServices, DesktopPlatformServices) and handed to App().
 */
interface PlatformServices {
    /** "android" or "desktop": the prefix of this device's client id. */
    val kind: String

    val store: KeyValueStore

    /** An HTTP client whose socket reads never time out: SSE streams stay open for hours. */
    fun httpClient(): HttpClient

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
