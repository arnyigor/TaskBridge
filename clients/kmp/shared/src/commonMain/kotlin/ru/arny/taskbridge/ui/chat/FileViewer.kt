package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.session.describe
import ru.arny.taskbridge.platform.PlatformServices
import ru.arny.taskbridge.ui.common.AdaptiveSheet
import ru.arny.taskbridge.ui.common.formatBytes
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors
import ru.arny.taskbridge.ui.theme.MonoStyle

/** A file the chat can show: one the agent touched in the workspace, or a message attachment. */
sealed interface FileTarget {
    val name: String

    /** What makes two opens the same tab: the path for a workspace file, the id for an upload. */
    val identity: String

    data class Workspace(val path: String, val line: Int? = null, val endLine: Int? = null) : FileTarget {
        override val name get() = path.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
        override val identity get() = "w:$path"
    }

    data class Attachment(val id: String, override val name: String) : FileTarget {
        override val identity get() = "a:$id"
    }

    /** A task artifact (a tool output log, diff.patch, …), addressed by name. */
    data class Artifact(override val name: String) : FileTarget {
        override val identity get() = "r:$name"
    }
}

/** One target as saveable fields; the tabs saver joins several of these into one string. */
internal fun FileTarget.toFields(): List<String> = when (this) {
    is FileTarget.Workspace -> listOf("workspace", path, line?.toString() ?: "", endLine?.toString() ?: "")
    is FileTarget.Attachment -> listOf("attachment", id, name)
    is FileTarget.Artifact -> listOf("artifact", name)
}

internal fun targetFromFields(parts: List<String>): FileTarget? = when (parts.firstOrNull()) {
    "workspace" -> parts.getOrNull(1)?.let { FileTarget.Workspace(it, parts.getOrNull(2)?.toIntOrNull(), parts.getOrNull(3)?.toIntOrNull()) }
    "attachment" -> parts.getOrNull(1)?.let { id -> parts.getOrNull(2)?.let { FileTarget.Attachment(id, it) } }
    "artifact" -> parts.getOrNull(1)?.let { FileTarget.Artifact(it) }
    else -> null
}

/** Preserve viewer identity when its chat is restored; image bytes are reloaded from the API. */
internal val FileTargetSaver = androidx.compose.runtime.saveable.Saver<FileTarget?, List<String>>(
    save = { target -> target?.toFields() ?: emptyList() },
    restore = { parts -> targetFromFields(parts) },
)

private const val SHOWN_BYTES = 300_000

/** What the viewer got: text to show, or a binary it cannot. */
internal sealed interface Loaded {
    data class Text(val text: String, val bytes: Int, val cut: Boolean) : Loaded
    data class Binary(val bytes: ByteArray) : Loaded
    data class Picture(val bitmap: ImageBitmap, val original: ByteArray) : Loaded
    data class Failed(val message: String) : Loaded
}

internal fun looksBinary(bytes: ByteArray): Boolean = bytes.take(8000).any { it == 0.toByte() }

private val MARKDOWN_NAME = Regex("\\.(?:md|markdown|mdx)$", RegexOption.IGNORE_CASE)
private val VIDEO_NAME = Regex("\\.(?:mp4|webm|mov|m4v|mkv|avi)$", RegexOption.IGNORE_CASE)

/** A file the viewer renders as Markdown instead of showing as source (the web's `MARKDOWN_EXT_RE`). */
internal fun isMarkdownName(name: String?): Boolean = name != null && MARKDOWN_NAME.containsMatchIn(name)

internal fun isVideoName(name: String?): Boolean = name != null && VIDEO_NAME.containsMatchIn(name)

private fun mimeTypeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "mp4", "m4v" -> "video/mp4"
    "webm" -> "video/webm"
    "mov" -> "video/quicktime"
    "mkv" -> "video/x-matroska"
    "avi" -> "video/x-msvideo"
    "png" -> "image/png"
    "jpg", "jpeg" -> "image/jpeg"
    "gif" -> "image/gif"
    "webp" -> "image/webp"
    "bmp" -> "image/bmp"
    "pdf" -> "application/pdf"
    else -> "application/octet-stream"
}

/**
 * What a file view holds: the bytes it read and transient messages of its own
 * actions («Скопировано»). Hoisted out of the composable so the docked panel and
 * the phone sheet read a file and render it through one path.
 */
internal class FileViewState {
    var loaded by mutableStateOf<Loaded?>(null)
        internal set
    var notice by mutableStateOf<String?>(null)
        internal set

    /** Bumped by [reload]; [rememberFileViewState] keys its read on it. */
    var reloads by mutableStateOf(0)
        private set

    /** The file may have changed on the computer: read it again. */
    fun reload() { reloads++ }

    fun setNotice(text: String?) { notice = text }
}

private suspend fun loadFile(target: FileTarget, session: ChatSession): Loaded {
    val result = when (target) {
        is FileTarget.Workspace -> session.readWorkspaceFile(target.path, target.line, target.endLine)
        is FileTarget.Attachment -> session.readFile(target.id)
        is FileTarget.Artifact -> session.readArtifact(target.name)
    }
    return result.fold(
        onSuccess = { bytes ->
            val picture = if (isImageName(target.name)) decodeImage(bytes) else null
            when {
                picture != null -> Loaded.Picture(picture, bytes)
                looksBinary(bytes) -> Loaded.Binary(bytes)
                else -> Loaded.Text(bytes.copyOf(minOf(bytes.size, SHOWN_BYTES)).decodeToString(), bytes.size, bytes.size > SHOWN_BYTES)
            }
        },
        onFailure = { Loaded.Failed((it as? ApiException)?.let { e -> describe(e.error) } ?: it.message ?: "Не удалось прочитать файл") },
    )
}

/** Reads [target] through the API with this client's session and remembers the result. */
@Composable
internal fun rememberFileViewState(target: FileTarget, session: ChatSession): FileViewState {
    val state = remember(target) { FileViewState() }
    LaunchedEffect(target, state.reloads) { state.loaded = loadFile(target, session) }
    return state
}

/** The subtitle of a file view: bytes, how much was shown, which lines were asked for. */
internal fun fileInfoLine(target: FileTarget, loaded: Loaded?): String? = when (loaded) {
    is Loaded.Text -> buildList {
        add(formatBytes(loaded.bytes.toLong()))
        if (loaded.cut) add("показано начало")
        // Диапазон из ссылки (`path#L120-L140`): сервер отдал только этот кусок, и без
        // подписи оператор видел бы текст без номеров строк и без понимания, что это.
        val workspace = target as? FileTarget.Workspace
        val start = workspace?.line
        if (start != null) {
            val end = workspace.endLine ?: start
            add(if (end > start) "строки $start–$end" else "строка $start")
        }
    }.joinToString(" · ")
    is Loaded.Binary -> formatBytes(loaded.bytes.size.toLong())
    is Loaded.Picture -> "${loaded.bitmap.width}×${loaded.bitmap.height} · " + formatBytes(loaded.original.size.toLong())
    else -> null
}

/**
 * The file itself: a rendered Markdown document, highlighted source with line
 * numbers, an image, or a note that it is not text. [markdown] switches a
 * `.md` file between the reading view and its source.
 */
@Composable
internal fun FileBody(
    target: FileTarget,
    loaded: Loaded?,
    platform: PlatformServices,
    markdown: Boolean = true,
    onOpenPath: ((WorkspaceLink) -> Unit)? = null,
) {
    when (val state = loaded) {
        null -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        is Loaded.Failed -> Text(state.message, color = MaterialTheme.colorScheme.error)
        is Loaded.Picture -> Image(state.bitmap, target.name, Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)), contentScale = ContentScale.FillWidth)
        is Loaded.Binary -> Text(
            if (isVideoName(target.name)) "Это видео можно скачать или открыть во внешнем плеере." else "Это не текстовый файл — его можно скачать." + if (platform.kind == "desktop") " Или открыть в приложении на компьютере." else "",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        is Loaded.Text -> if (markdown && isMarkdownName(target.name)) {
            // A Markdown file is shown the way it is meant to be read — headings,
            // lists, quotes, tables, code — like the same file in the web viewer.
            // «Копировать» in the footer still takes the source text.
            CompositionLocalProvider(LocalOpenFile provides onOpenPath) {
                SelectionContainer { MarkdownView(state.text, onCopy = { platform.copyText(it) }) }
            }
        } else {
            val palette = codePalette()
            val language = remember(target.name) { languageOfFile(target.name) }
            val highlighted = remember(state.text, language, palette) { highlight(state.text, language, palette) }
            val lines = remember(state.text) { (1..(state.text.count { it == '\n' } + 1)).joinToString("\n") }
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(LocalStatusColors.current.codeBackground)
                    .padding(vertical = 10.dp),
            ) {
                Text(
                    lines,
                    style = MonoStyle,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                    modifier = Modifier.padding(start = 10.dp, end = 12.dp),
                )
                SelectionContainer(Modifier.weight(1f).horizontalScroll(rememberScrollState())) {
                    Text(highlighted, style = MonoStyle, softWrap = false, modifier = Modifier.padding(end = 12.dp))
                }
            }
        }
    }
}

/** Asks the computer that runs the session to open [target] in its app (or show it in its folder). */
internal suspend fun requestOpenOnComputer(target: FileTarget, session: ChatSession, reveal: Boolean): Result<Unit> = when (target) {
    is FileTarget.Workspace -> session.openWorkspaceFileOnComputer(target.path, reveal)
    is FileTarget.Attachment -> session.openFileOnComputer(target.id, reveal)
    is FileTarget.Artifact -> session.openArtifactOnComputer(target.name, reveal)
}

/** The full path (or attachment/artifact description) a file view shows above its content. */
internal fun fileLocationLine(target: FileTarget): String = when (target) {
    is FileTarget.Workspace -> target.path
    is FileTarget.Attachment -> "Вложение сообщения"
    is FileTarget.Artifact -> "Артефакт задачи"
}

/**
 * Reads the file through the API with this client's session (a browser given
 * the bare URL has no cookie) and shows it highlighted. On the PC itself the
 * server can also open it with its app or reveal it in the file manager.
 *
 * This is the phone shape (a sheet from the bottom). A wide window shows the
 * same file in the docked [FilePanel] instead.
 */
@Composable
fun FileViewer(
    target: FileTarget,
    session: ChatSession,
    platform: PlatformServices,
    onDismiss: () -> Unit,
    /** Открыть другой файл из просмотрщика (ссылка внутри текста), с диапазоном строк. */
    onOpenPath: ((WorkspaceLink) -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val state = rememberFileViewState(target, session)
    val loaded = state.loaded
    fun openInApp(reveal: Boolean) = scope.launch {
        state.setNotice(
            requestOpenOnComputer(target, session, reveal).fold(
                onSuccess = { if (reveal) "Показано в папке на компьютере" else "Открыто на компьютере" },
                onFailure = { (it as? ApiException)?.let { e -> describe(e.error) } ?: it.message },
            ),
        )
    }
    fun saveOnDevice(bytes: ByteArray, open: Boolean) = scope.launch {
        state.setNotice(if (open) "Открываю…" else "Сохраняю…")
        state.setNotice(
            platform.saveFile(target.name, bytes, mimeTypeOf(target.name), open).fold(
                onSuccess = { it },
                onFailure = { it.message ?: "Не удалось сохранить файл" },
            ),
        )
    }

    (loaded as? Loaded.Picture)?.takeIf { platform.kind == "android" }?.let { picture ->
        PictureViewer(picture.bitmap, picture.original, target.name, onDismiss)
        return
    }
    AdaptiveSheet(
        title = target.name,
        subtitle = listOfNotNull((target as? FileTarget.Workspace)?.path, fileInfoLine(target, loaded)).joinToString(" · "),
        onDismiss = onDismiss,
        maxWidth = 960,
        footer = {
            if (platform.kind == "desktop") {
                OutlinedButton(onClick = { openInApp(reveal = false) }) { Text("Открыть в приложении") }
                TextButton(onClick = { openInApp(reveal = true) }) { Text("Показать в папке") }
            }
            Spacer(Modifier.weight(1f))
            (loaded as? Loaded.Binary)?.let { binary ->
                TextButton(onClick = { saveOnDevice(binary.bytes, open = false) }) { Text("Скачать") }
                if (platform.kind == "android") OutlinedButton(onClick = { saveOnDevice(binary.bytes, open = true) }) { Text("Открыть") }
            }
            (loaded as? Loaded.Text)?.let { text ->
                TextButton(onClick = { platform.copyText(text.text); state.setNotice("Скопировано") }) {
                    Icon(AppIcons.Copy, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Копировать")
                }
            }
        },
    ) {
        state.notice?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(bottom = 8.dp)) }
        FileBody(target, loaded, platform, onOpenPath = onOpenPath)
    }
}
