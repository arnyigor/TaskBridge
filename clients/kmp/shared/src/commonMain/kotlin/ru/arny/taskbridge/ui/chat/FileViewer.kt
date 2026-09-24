package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.background
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

    data class Workspace(val path: String) : FileTarget {
        override val name get() = path.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
    }

    data class Attachment(val id: String, override val name: String) : FileTarget
}

private const val SHOWN_BYTES = 300_000

/** What the viewer got: text to show, or a binary it cannot. */
private sealed interface Loaded {
    data class Text(val text: String, val bytes: Int, val cut: Boolean) : Loaded
    data class Binary(val bytes: Int) : Loaded
    data class Failed(val message: String) : Loaded
}

internal fun looksBinary(bytes: ByteArray): Boolean = bytes.take(8000).any { it == 0.toByte() }

/**
 * Reads the file through the API with this client's session (a browser given
 * the bare URL has no cookie) and shows it highlighted. On the PC itself the
 * server can also open it with its app or reveal it in the file manager.
 */
@Composable
fun FileViewer(target: FileTarget, session: ChatSession, platform: PlatformServices, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var loaded by remember(target) { mutableStateOf<Loaded?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(target) {
        val result = when (target) {
            is FileTarget.Workspace -> session.readWorkspaceFile(target.path)
            is FileTarget.Attachment -> session.readFile(target.id)
        }
        loaded = result.fold(
            onSuccess = { bytes ->
                when {
                    looksBinary(bytes) -> Loaded.Binary(bytes.size)
                    else -> Loaded.Text(bytes.copyOf(minOf(bytes.size, SHOWN_BYTES)).decodeToString(), bytes.size, bytes.size > SHOWN_BYTES)
                }
            },
            onFailure = { Loaded.Failed((it as? ApiException)?.let { e -> describe(e.error) } ?: it.message ?: "Не удалось прочитать файл") },
        )
    }
    fun openOnComputer(reveal: Boolean) = scope.launch {
        val result = when (target) {
            is FileTarget.Workspace -> session.openWorkspaceFileOnComputer(target.path, reveal)
            is FileTarget.Attachment -> session.openFileOnComputer(target.id, reveal)
        }
        notice = result.fold(
            onSuccess = { if (reveal) "Показано в папке на компьютере" else "Открыто на компьютере" },
            onFailure = { (it as? ApiException)?.let { e -> describe(e.error) } ?: it.message },
        )
    }

    val info = when (val state = loaded) {
        is Loaded.Text -> formatBytes(state.bytes.toLong()) + if (state.cut) " · показано начало" else ""
        is Loaded.Binary -> formatBytes(state.bytes.toLong())
        else -> null
    }
    AdaptiveSheet(
        title = target.name,
        subtitle = listOfNotNull((target as? FileTarget.Workspace)?.path, info).joinToString(" · "),
        onDismiss = onDismiss,
        maxWidth = 960,
        footer = {
            if (platform.kind == "desktop") {
                OutlinedButton(onClick = { openOnComputer(reveal = false) }) { Text("Открыть в приложении") }
                TextButton(onClick = { openOnComputer(reveal = true) }) { Text("Показать в папке") }
            }
            Spacer(Modifier.weight(1f))
            (loaded as? Loaded.Text)?.let { text ->
                TextButton(onClick = { platform.copyText(text.text); notice = "Скопировано" }) {
                    Icon(AppIcons.Copy, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Копировать")
                }
            }
        },
    ) {
        notice?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(bottom = 8.dp)) }
        when (val state = loaded) {
            null -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            is Loaded.Failed -> Text(state.message, color = MaterialTheme.colorScheme.error)
            is Loaded.Binary -> Text(
                "Это не текстовый файл — показать его здесь нельзя." + if (platform.kind == "desktop") " Откройте его в приложении на компьютере." else "",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            is Loaded.Text -> {
                val palette = codePalette()
                val language = remember(target) { languageOfFile(target.name) }
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
}
