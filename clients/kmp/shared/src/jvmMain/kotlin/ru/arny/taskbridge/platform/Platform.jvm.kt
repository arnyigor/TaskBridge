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
import java.awt.Image
import java.awt.datatransfer.Clipboard
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
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
actual fun SystemBarsAppearance(dark: Boolean) = Unit

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

@Composable
actual fun rememberClipboardFiles(): () -> List<UploadFile> = remember { { clipboardFiles(Toolkit.getDefaultToolkit().systemClipboard) } }

/** Files copied in the file manager, or a picture (a screenshot, a copied image) saved as PNG. */
internal fun clipboardFiles(clipboard: Clipboard): List<UploadFile> = runCatching {
    val contents = clipboard.getContents(null) ?: return emptyList()
    when {
        contents.isDataFlavorSupported(DataFlavor.javaFileListFlavor) ->
            (contents.getTransferData(DataFlavor.javaFileListFlavor) as List<*>).filterIsInstance<File>().filter(File::isFile).map { file ->
                UploadFile(file.name, runCatching { Files.probeContentType(file.toPath()) }.getOrNull(), file.readBytes())
            }
        contents.isDataFlavorSupported(DataFlavor.imageFlavor) -> {
            val image = contents.getTransferData(DataFlavor.imageFlavor) as Image
            val picture = BufferedImage(image.getWidth(null), image.getHeight(null), BufferedImage.TYPE_INT_ARGB)
            picture.createGraphics().apply { drawImage(image, 0, 0, null); dispose() }
            val png = ByteArrayOutputStream().also { ImageIO.write(picture, "png", it) }.toByteArray()
            listOf(UploadFile("picture-${SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date())}.png", "image/png", png))
        }
        else -> emptyList()
    }
}.getOrDefault(emptyList())
