package ru.arny.taskbridge.platform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import java.awt.Desktop
import java.awt.FileDialog
import java.awt.Frame
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.prefs.Preferences

/** java.util.prefs: per-user, survives restarts, no files to manage. */
class PreferencesStore(node: String = "ru/arny/taskbridge") : KeyValueStore {
    private val prefs = Preferences.userRoot().node(node)
    override fun get(key: String): String? = prefs.get(key, null)
    override fun put(key: String, value: String?) {
        if (value == null) prefs.remove(key) else prefs.put(key, value)
        runCatching { prefs.flush() }
    }
}

/**
 * Desktop services. Notifications go through [notifier] (the tray, wired by
 * the desktop app); [foreground] is updated from the window focus.
 */
class DesktopPlatformServices(
    override val store: KeyValueStore = PreferencesStore(),
) : PlatformServices {
    override val kind: String = "desktop"

    @Volatile
    var foreground: Boolean = true

    /** Set by the desktop app to post a tray notification. */
    var notifier: ((SessionAlert) -> Unit)? = null

    override val inForeground: Boolean get() = foreground

    override fun httpClient(): HttpClient = HttpClient(OkHttp) {
        engine {
            config {
                connectTimeout(10, TimeUnit.SECONDS)
                readTimeout(0, TimeUnit.MILLISECONDS)
                retryOnConnectionFailure(true)
            }
        }
    }

    override fun copyText(text: String) {
        runCatching { Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(text), null) }
    }

    override fun formatClock(epochMillis: Long): String = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(epochMillis))

    override fun formatDate(epochMillis: Long): String = SimpleDateFormat("d MMM", Locale.forLanguageTag("ru")).format(Date(epochMillis))

    override fun notify(alert: SessionAlert) {
        notifier?.invoke(alert)
    }

    override fun clearNotification(taskId: String) = Unit

    override fun setBackgroundWatch(activeSessions: Int) = Unit

    override fun openUrl(url: String) {
        runCatching {
            if (Desktop.isDesktopSupported()) Desktop.getDesktop().browse(URI(url))
        }
    }
}

@Composable
actual fun PlatformBackHandler(enabled: Boolean, onBack: () -> Unit) = Unit

@Composable
actual fun rememberFilePicker(onPicked: (List<UploadFile>) -> Unit): () -> Unit = remember(onPicked) {
    {
        val dialog = FileDialog(null as Frame?, "Выберите файлы", FileDialog.LOAD).apply {
            isMultipleMode = true
            isVisible = true
        }
        val files = dialog.files.orEmpty().filter(File::isFile).map { file ->
            UploadFile(file.name, runCatching { Files.probeContentType(file.toPath()) }.getOrNull(), file.readBytes())
        }
        if (files.isNotEmpty()) onPicked(files)
    }
}
