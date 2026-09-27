package ru.arny.taskbridge.platform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.core.client.session.CachedChat
import ru.arny.taskbridge.core.client.session.ChatPersistence
import ru.arny.taskbridge.core.client.session.PersistedOutgoing
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.core.client.settings.SecretStore
import ru.arny.taskbridge.core.api.TaskBridgeJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.serialization.builtins.ListSerializer
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
import java.nio.file.StandardCopyOption
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.prefs.Preferences
import java.util.Base64
import javax.swing.JFileChooser

/** java.util.prefs: per-user, survives restarts, no files to manage. */
class PreferencesStore(node: String = "ru/arny/taskbridge") : KeyValueStore {
    private val prefs = Preferences.userRoot().node(node)
    override fun get(key: String): String? = prefs.get(key, null)
    override fun put(key: String, value: String?) {
        if (value == null) prefs.remove(key) else prefs.put(key, value)
        runCatching { prefs.flush() }
    }
}

/** Protects credentials with the current Windows user's DPAPI key; plaintext only crosses stdin. */
class DpapiSecretStore(private val prefs: Preferences = Preferences.userRoot().node("ru/arny/taskbridge/secrets")) : SecretStore {
    private val cache = mutableMapOf<String, String?>()
    override fun get(key: String): String? {
        synchronized(cache) { if (cache.containsKey(key)) return cache[key] }
        val encrypted = prefs.get(key, null) ?: return null
        val value = transform(encrypted, protect = false)?.let { String(Base64.getDecoder().decode(it), Charsets.UTF_8) }
        synchronized(cache) { cache[key] = value }
        return value
    }
    override fun put(key: String, value: String?) {
        if (value == null) { prefs.remove(key); prefs.flush(); synchronized(cache) { cache[key] = null }; return }
        check(System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) { "DPAPI доступен только в Windows" }
        val input = Base64.getEncoder().encodeToString(value.toByteArray(Charsets.UTF_8))
        val encrypted = checkNotNull(transform(input, protect = true)) { "Не удалось защитить credential через DPAPI" }
        prefs.put(key, encrypted); prefs.flush(); synchronized(cache) { cache[key] = value }
    }
    private fun transform(input: String, protect: Boolean): String? = runCatching {
        if (!System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) return null
        val operation = if (protect) "Protect" else "Unprotect"
        val script = "Add-Type -AssemblyName System.Security;${'$'}v=[Console]::In.ReadToEnd().Trim();${'$'}b=[Convert]::FromBase64String(${'$'}v);${'$'}o=[Security.Cryptography.ProtectedData]::$operation(${'$'}b,${'$'}null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String(${'$'}o))"
        val encoded = Base64.getEncoder().encodeToString(script.toByteArray(Charsets.UTF_16LE))
        val process = ProcessBuilder("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded).redirectErrorStream(false).start()
        process.outputStream.bufferedWriter().use { it.write(input) }
        check(process.waitFor(10, TimeUnit.SECONDS) && process.exitValue() == 0)
        process.inputStream.bufferedReader().readText().trim().takeIf { it.isNotEmpty() }
    }.getOrNull()
}

private class DesktopChatPersistence(root: File, serverUrl: String) : ChatPersistence {
    private val dir = File(root, serverUrl.hashCode().toUInt().toString(16)).apply { mkdirs() }
    private fun file(taskId: String, suffix: String) = File(dir, taskId.replace(Regex("[^A-Za-z0-9._-]"), "_") + suffix)
    override suspend fun loadChat(taskId: String): CachedChat? = read(file(taskId, ".chat.json"), CachedChat.serializer())
    override suspend fun saveChat(taskId: String, value: CachedChat) = write(file(taskId, ".chat.json"), TaskBridgeJson.encodeToString(CachedChat.serializer(), value))
    override suspend fun loadOutbox(taskId: String): List<PersistedOutgoing> = read(file(taskId, ".outbox.json"), ListSerializer(PersistedOutgoing.serializer())).orEmpty()
    override suspend fun saveOutbox(taskId: String, values: List<PersistedOutgoing>) {
        val target = file(taskId, ".outbox.json")
        if (values.isEmpty()) withContext(Dispatchers.IO) { target.delete() }
        else write(target, TaskBridgeJson.encodeToString(ListSerializer(PersistedOutgoing.serializer()), values))
    }
    override suspend fun clear(taskId: String) = withContext(Dispatchers.IO) { file(taskId, ".chat.json").delete(); file(taskId, ".outbox.json").delete(); Unit }
    private suspend fun <T> read(file: File, serializer: kotlinx.serialization.KSerializer<T>): T? = withContext(Dispatchers.IO) { runCatching { TaskBridgeJson.decodeFromString(serializer, file.readText()) }.getOrNull() }
    private suspend fun write(file: File, text: String) = withContext(Dispatchers.IO) {
        file.parentFile?.mkdirs(); val temp = File(file.parentFile, file.name + ".tmp"); temp.writeText(text)
        runCatching { Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE) }
            .getOrElse { Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING) }
        Unit
    }
}

/**
 * Desktop services. Notifications go through [notifier] (the tray, wired by
 * the desktop app); [foreground] is updated from the window focus.
 */
class DesktopPlatformServices(
    override val store: KeyValueStore = PreferencesStore(),
    override val appVersion: String = "",
) : PlatformServices {
    override val kind: String = "desktop"
    override val secrets: SecretStore = DpapiSecretStore()
    override fun chatPersistence(serverUrl: String): ChatPersistence = DesktopChatPersistence(
        File(System.getProperty("user.home"), ".taskbridge-kmp/chat-cache"), serverUrl,
    )

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

    override fun networkAvailable(): Flow<Boolean> = flowOf(true)

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

    override fun chooseProjectFolder(): String? {
        val chooser = JFileChooser().apply {
            dialogTitle = "Выберите папку проекта"
            fileSelectionMode = JFileChooser.DIRECTORIES_ONLY
            isAcceptAllFileFilterUsed = false
        }
        return if (chooser.showOpenDialog(null) == JFileChooser.APPROVE_OPTION) chooser.selectedFile?.absolutePath else null
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
