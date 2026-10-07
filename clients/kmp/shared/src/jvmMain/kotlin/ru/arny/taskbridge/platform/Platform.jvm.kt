package ru.arny.taskbridge.platform

import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.ui.draganddrop.DragAndDropTarget
import androidx.compose.ui.draganddrop.awtTransferable
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
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.prefs.Preferences
import kotlin.concurrent.thread
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

private fun uniqueFile(dir: File, name: String): File {
    val dot = name.lastIndexOf('.').takeIf { it > 0 }
    val base = dot?.let { name.substring(0, it) } ?: name
    val ext = dot?.let { name.substring(it) }.orEmpty()
    var candidate = File(dir, name)
    var index = 1
    while (candidate.exists()) candidate = File(dir, "$base ($index)$ext").also { index++ }
    return candidate
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

    override fun httpClient(baseUrl: String?): HttpClient = HttpClient(OkHttp) {
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

    override suspend fun saveFile(name: String, bytes: ByteArray, mimeType: String?, open: Boolean): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val safeName = name.substringAfterLast('/').substringAfterLast('\\').ifBlank { "taskbridge-file" }
            val downloads = File(System.getProperty("user.home"), "Downloads").apply { mkdirs() }
            val target = uniqueFile(downloads, safeName)
            target.writeBytes(bytes)
            if (open && Desktop.isDesktopSupported()) Desktop.getDesktop().open(target)
            "Сохранено: ${target.absolutePath}"
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

    override val localServerLauncher: LocalServerLauncher = DesktopServerLauncher(store)
}

/**
 * Запуск локального TaskBridge-сервера без консоли. Вместо своей логики запуска
 * вызывает готовый демон-режим `node scripts/start-lan.mjs start`: он гасит
 * остатки прошлой пары, поднимает app+proxy скрытыми процессами (windowsHide),
 * сам ждёт health и пишет data/lan.json — тот же файл, по которому серверный
 * перезапуск (restart-lan-now) находит процессы. Консольного окна нет, потому
 * что у GUI-процесса (jpackage) нет своей консоли, а вывод дочернего процесса
 * перенаправлен в пайпы — JVM на Windows ставит таким дочерним CREATE_NO_WINDOW.
 */
class DesktopServerLauncher(private val store: KeyValueStore) : LocalServerLauncher {

    override fun available(): Boolean = findRoot() != null

    override fun root(): String? = findRoot()?.path

    override fun logTail(lines: Int): String? {
        val root = findRoot() ?: return null
        return serverLogTail(serverDataDir(root), lines)
    }

    /**
     * Каталог TaskBridge: настройка `server.root`, иначе — от местоположения своего кода
     * (jar в `app/` у jpackage-сборки, каталог классов при `gradle run`) и от рабочего
     * каталога процесса; каждый якорь проверяется вверх до корня диска.
     * Местоположение кода — якорь, не зависящий от того, кто и с каким cwd запустил процесс.
     */
    private fun findRoot(): File? = findTaskBridgeRoot(store.get("server.root"), anchors())

    private fun anchors(): List<File> = listOfNotNull(
        codeLocation(DesktopServerLauncher::class.java),
        File(System.getProperty("user.dir")),
        // Последним — копия сервера внутри дистрибутива (см. :desktopApp:standalonePortable):
        // она идёт после репозитория, поэтому в разработке побеждает живой код, а в
        // распакованном ZIP, где репозитория нет, — копия.
        bundledServer(),
    )

    private fun bundledServer(): File? =
        codeLocation(DesktopServerLauncher::class.java)?.parentFile?.let { File(it, "server") }

    override suspend fun start(): Unit = withContext(Dispatchers.IO) {
        val root = findRoot() ?: throw IllegalStateException(
            "Каталог TaskBridge (scripts/start-lan.mjs) не найден — задайте настройку server.root в настройках. " +
                "Проверено: " + checkedPathList(store.get("server.root"), anchors()),
        )
        // node обязателен в PATH: его же требует сам сервер (start.cmd проверяет то же).
        val process = ProcessBuilder("node", "scripts/start-lan.mjs", "start")
            .directory(root)
            .redirectErrorStream(true)
            .start()
        val output = StringBuilder()
        val reader = thread(isDaemon = true) {
            runCatching { process.inputStream.bufferedReader().forEachLine { output.appendLine(it) } }
        }
        if (!process.waitFor(180, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            writeStartLog(root, output.toString())
            throw IllegalStateException("Запуск сервера не завершился за 180 с. Вывод: ${startLogPath(root)}")
        }
        runCatching { reader.join(1000) }
        // Полный вывод всегда в файл: в тосте видно только хвост, а причина (блокировка
        // экземпляра, порт, конфиг) часто оказывается выше по тексту или в lan-app.log.
        writeStartLog(root, output.toString())
        if (process.exitValue() != 0) {
            val port = lanPublicPort(serverDataDir(root))
            if (port != null && healthAnswers(port)) {
                // Ненулевой код при живом сервере — это гонка: пара уже поднята
                // (например, её подняло предыдущее нажатие или соседний запуск).
                return@withContext
            }
            throw IllegalStateException(
                "Не удалось запустить сервер:\n" + readableOutput(output.toString()) +
                    "\n\nПолные логи: ${startLogPath(root)}, ${File(serverDataDir(root), "lan-app.log")}",
            )
        }
    }

    private fun startLogPath(root: File): File = File(serverDataDir(root), "lan-client-start.log")

    private fun writeStartLog(root: File, text: String) {
        runCatching {
            val file = startLogPath(root)
            file.parentFile?.mkdirs()
            file.writeText(text)
        }
    }

    /** Кандидаты для текста ошибки: первые 10 путей, дальше — многоточие (вверх до корня диска их бывает много). */
    private fun checkedPathList(setting: String?, anchors: List<File>): String =
        taskBridgeRootCandidates(setting, anchors)
            .let { it.take(10).joinToString(", ") { dir -> dir.path } + if (it.size > 10) " …" else "" }
}

/**
 * Кандидаты на корень TaskBridge: сначала настройка `server.root`, затем якоря и все их
 * родители до корня диска. Раньше поиск ограничивался четырьмя кандидатами от `user.dir`,
 * а портативная сборка `clients/kmp/dist/TaskBridge` лежит на четыре уровня ниже корня —
 * корень был пятым кандидатом и не проверялся, поэтому сервер не запускался.
 */
internal fun taskBridgeRootCandidates(setting: String?, anchors: List<File>): List<File> = buildList {
    setting?.trim()?.takeIf { it.isNotEmpty() }?.let { add(File(it)) }
    for (anchor in anchors) {
        var dir: File? = anchor
        while (dir != null) {
            add(dir)
            dir = dir.parentFile
        }
    }
}

/** Корень TaskBridge — каталог, в котором лежит `scripts/start-lan.mjs`. */
internal fun findTaskBridgeRoot(setting: String?, anchors: List<File>): File? =
    taskBridgeRootCandidates(setting, anchors).firstOrNull { File(it, "scripts/start-lan.mjs").isFile }

/**
 * То, что показывает тост при неудачном запуске сервера: вывод `start-lan.mjs` без шума Node.
 * Предупреждения `(node:NNN) ... DeprecationWarning` занимали весь хвост, и в сообщении не было
 * видно причины — например, «TaskBridge уже запущен (PID 13220)» из lan-app.log.
 */
internal fun readableOutput(text: String, tail: Int = 12): String {
    val noise = listOf("DeprecationWarning", "ExperimentalWarning", "(Use `node --trace-deprecation", "--trace-warnings")
    val meaningful = text.lines().map { it.trim() }.filterNot { line -> noise.any { line.contains(it) } }.filter { it.isNotEmpty() }
    return meaningful.takeLast(tail).joinToString("\n").ifEmpty { "вывод пуст — причину смотрите в lan-app.log" }
}

/** Каталог состояния сервера: тот же, что выбирает start-lan и src/server.mjs (`TASKBRIDGE_DATA_DIR` или `<корень>/data`). */
internal fun serverDataDir(root: File): File =
    System.getenv("TASKBRIDGE_DATA_DIR")?.takeIf { it.isNotBlank() }?.let { File(it) } ?: File(root, "data")

/** Публичный порт из `lan.json` — того состояния, по которому серверный перезапуск находит процессы. */
internal fun lanPublicPort(dataDir: File): Int? = runCatching {
    val state = File(dataDir, "lan.json").readText()
    Regex("\"publicPort\"\\s*:\\s*(\\d+)").find(state)?.groupValues?.get(1)?.toIntOrNull()
}.getOrNull()

/** Короткая проба: жив ли сервер на публичном порту (тот же `/api/health`, что ждёт start-lan). */
internal fun healthAnswers(port: Int): Boolean = runCatching {
    val connection = URI("http://127.0.0.1:$port/api/health").toURL().openConnection().apply {
        connectTimeout = 1500
        readTimeout = 1500
    }
    (connection as HttpURLConnection).responseCode == 200
}.getOrDefault(false)

/**
 * Последние [lines] строк файла: читаем окно с конца, а не весь лог — логи копятся без ротации.
 * Окно больше [lines] строк, чтобы после отбрасывания пустых строк хватало содержательных.
 */
internal fun fileTail(file: File, lines: Int, window: Int = 64 * 1024): String = runCatching {
    java.io.RandomAccessFile(file, "r").use { raf ->
        val size = minOf(raf.length(), window.toLong()).toInt()
        raf.seek(raf.length() - size)
        val bytes = ByteArray(size)
        raf.readFully(bytes)
        String(bytes, Charsets.UTF_8).lines().takeLast(lines).joinToString("\n")
    }
}.getOrDefault("(не удалось прочитать ${file.name})")

/** Хвосты логов сервера одним текстом для настроек; null — логов ещё нет. */
internal fun serverLogTail(dataDir: File, lines: Int): String? = listOf(
    "lan-client-start.log" to "запуск из приложения",
    "lan-app.log" to "сервер",
    "lan-proxy.log" to "прокси",
).mapNotNull { (name, title) ->
    val file = File(dataDir, name)
    if (!file.isFile) null else "=== $title ($name) ===\n" + fileTail(file, lines)
}.takeIf { it.isNotEmpty() }?.joinToString("\n\n")

/** Каталог с кодом класса: у jpackage-сборки это `app/` (jar), при `gradle run` и в тестах —
 * каталог классов. Через `toURI()` + `File`, а не через `path`, чтобы пробелы и кириллица
 * в пути не ломали якорь.
 */
internal fun codeLocation(anchor: Class<*>): File? = runCatching {
    val location = anchor.protectionDomain?.codeSource?.location?.toURI() ?: return null
    File(location).let { if (it.isFile) it.parentFile else it }
}.getOrNull()

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

/** Файлы, перетащенные из проводника на окно: тот же формат, что у Ctrl+V (javaFileListFlavor). */
@OptIn(ExperimentalComposeUiApi::class)
actual fun hasFileDrop(event: DragAndDropEvent): Boolean =
    event.awtTransferable.isDataFlavorSupported(DataFlavor.javaFileListFlavor)

@OptIn(ExperimentalComposeUiApi::class)
actual fun dragDroppedFiles(event: DragAndDropEvent): List<UploadFile> = runCatching {
    (event.awtTransferable.getTransferData(DataFlavor.javaFileListFlavor) as List<*>)
        .filterIsInstance<File>().filter(File::isFile).map { file ->
            UploadFile(file.name, runCatching { Files.probeContentType(file.toPath()) }.getOrNull(), file.readBytes())
        }
}.getOrDefault(emptyList())

/**
 * Приём файлов, перетащенных из проводника: Modifier.dragAndDropTarget из
 * foundation (в CMP 1.12 он есть, самодельная нода не нужна) плюс чтение файлов
 * через javaFileListFlavor — тот же путь, что у Ctrl+V.
 */
actual fun Modifier.fileDropTarget(onFiles: (List<UploadFile>) -> Unit): Modifier =
    dragAndDropTarget(shouldStartDragAndDrop = { hasFileDrop(it) }, target = FileDropTarget(onFiles))

private class FileDropTarget(val onFiles: (List<UploadFile>) -> Unit) : DragAndDropTarget {
    override fun onDrop(event: DragAndDropEvent): Boolean {
        val dropped = dragDroppedFiles(event)
        if (dropped.isEmpty()) return false
        onFiles(dropped)
        return true
    }

    // Сравнение по самой лямбде: Composer держит её стабильной (remember), поэтому
    // при перерисовке поля нода не пересобирается.
    override fun equals(other: Any?): Boolean = other is FileDropTarget && other.onFiles === onFiles

    override fun hashCode(): Int = onFiles.hashCode()
}

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
