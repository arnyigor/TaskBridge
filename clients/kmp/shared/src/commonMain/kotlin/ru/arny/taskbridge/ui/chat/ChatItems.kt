package ru.arny.taskbridge.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.ToolOutput
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ToolCall
import ru.arny.taskbridge.core.client.chat.ToolState
import ru.arny.taskbridge.ui.common.TypingIndicator
import ru.arny.taskbridge.ui.common.formatBytes
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors
import ru.arny.taskbridge.ui.theme.MonoStyle

/** What a message can do; null entries are hidden (not allowed right now). */
class MessageActions(
    val copy: () -> Unit,
    val edit: (() -> Unit)? = null,
    val fork: (() -> Unit)? = null,
    val deleteFrom: (() -> Unit)? = null,
    val regenerate: (() -> Unit)? = null,
    val continueAnswer: (() -> Unit)? = null,
)

@Composable
fun UserBubble(
    item: ChatItem.User,
    time: String,
    source: String?,
    actions: MessageActions,
    onOpenFile: (fileId: String) -> Unit,
) {
    val colors = LocalStatusColors.current
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(start = 48.dp), horizontalAlignment = Alignment.End) {
        Box {
            Surface(
                color = colors.userBubble,
                contentColor = colors.onUserBubble,
                shape = RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp),
                modifier = Modifier.combinedClickable(onClick = {}, onLongClick = { menu = true }),
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    if (item.mode == "steer") {
                        Text("вклинилось в ответ", style = MaterialTheme.typography.labelSmall, color = colors.onUserBubble.copy(alpha = 0.7f))
                    }
                    SelectionContainer { Text(item.text, style = MaterialTheme.typography.bodyLarge) }
                    if (item.files.isNotEmpty()) {
                        FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            for (file in item.files) {
                                FileChip(file.name ?: "файл", formatBytes(file.size), onClick = file.id?.let { id -> { onOpenFile(id) } })
                            }
                        }
                    }
                }
            }
            MessageMenu(menu, onDismiss = { menu = false }, actions = actions, isUser = true)
        }
        Row(Modifier.padding(top = 3.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (item.pending) {
                Icon(AppIcons.Clock, "Отправляется", Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(4.dp))
            }
            val meta = listOfNotNull(source, time.ifEmpty { null }).joinToString(" · ")
            Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun AssistantMessage(
    item: ChatItem.Assistant,
    time: String,
    actions: MessageActions,
    onCopyText: (String) -> Unit,
    loadToolOutput: suspend (String) -> Result<ToolOutput>,
    onOpenPath: (String) -> Unit,
    onSelectVariant: (Int) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(end = 8.dp).animateContentSize()) {
        if (item.thinking.isNotBlank()) ThinkingBlock(item.thinking, streaming = item.active && item.text.isBlank())
        if (item.tools.isNotEmpty()) {
            Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (tool in item.tools) ToolRow(tool, loadToolOutput, onCopyText, onOpenPath)
            }
        }
        Box {
            Column(Modifier.fillMaxWidth().combinedClickable(onClick = {}, onLongClick = { menu = true })) {
                when {
                    item.text.isNotBlank() -> SelectionContainer { MarkdownView(item.text, onCopy = onCopyText) }
                    item.active -> TypingIndicator()
                    item.cutOff -> Muted("Запрос прерван")
                    item.thinking.isNotBlank() || item.tools.isNotEmpty() -> if (item.final && item.error == null) Muted("Без текста")
                    item.final && item.error == null -> Muted("Ответ не был получен.")
                }
                if (item.active && item.text.isNotBlank()) TypingIndicator()
                item.error?.let { error ->
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier.padding(top = 8.dp),
                    ) {
                        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.Top) {
                            Icon(AppIcons.Alert, null, Modifier.size(16.dp).padding(top = 2.dp))
                            Spacer(Modifier.width(8.dp))
                            SelectionContainer { Text(error, style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }
            }
            MessageMenu(menu, onDismiss = { menu = false }, actions = actions, isUser = false)
        }
        if (item.final || !item.active) {
            Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                item.variants?.let { variants ->
                    IconButton(onClick = { onSelectVariant(variants.index - 1) }, enabled = variants.index > 0, modifier = Modifier.size(28.dp)) {
                        Icon(AppIcons.ChevronLeft, "Предыдущий вариант", Modifier.size(16.dp))
                    }
                    Text("${variants.index + 1}/${variants.total}", style = MaterialTheme.typography.labelMedium)
                    IconButton(onClick = { onSelectVariant(variants.index + 1) }, enabled = variants.index < variants.total - 1, modifier = Modifier.size(28.dp)) {
                        Icon(AppIcons.ChevronRight, "Следующий вариант", Modifier.size(16.dp))
                    }
                    Spacer(Modifier.width(6.dp))
                }
                if (time.isNotEmpty()) Text(time, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                if (item.text.isNotBlank()) SmallAction(AppIcons.Copy, "Копировать", actions.copy)
                actions.regenerate?.let { SmallAction(AppIcons.Refresh, "Ответить заново", it) }
                actions.continueAnswer?.let { SmallAction(AppIcons.Play, "Продолжить", it) }
                SmallAction(AppIcons.More, "Ещё") { menu = true }
            }
        }
    }
}

@Composable
private fun SmallAction(icon: ImageVector, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(32.dp)) {
        Icon(icon, label, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun MessageMenu(open: Boolean, onDismiss: () -> Unit, actions: MessageActions, isUser: Boolean) {
    DropdownMenu(expanded = open, onDismissRequest = onDismiss) {
        DropdownMenuItem(text = { Text("Копировать") }, leadingIcon = { Icon(AppIcons.Copy, null) }, onClick = { onDismiss(); actions.copy() })
        actions.edit?.let {
            DropdownMenuItem(
                text = { Text(if (isUser) "Изменить и отправить заново" else "Исправить ответ") },
                leadingIcon = { Icon(AppIcons.Edit, null) },
                onClick = { onDismiss(); it() },
            )
        }
        actions.regenerate?.let { DropdownMenuItem(text = { Text("Ответить заново") }, leadingIcon = { Icon(AppIcons.Refresh, null) }, onClick = { onDismiss(); it() }) }
        actions.continueAnswer?.let { DropdownMenuItem(text = { Text("Продолжить ответ") }, leadingIcon = { Icon(AppIcons.Play, null) }, onClick = { onDismiss(); it() }) }
        actions.fork?.let { DropdownMenuItem(text = { Text("Новая ветка отсюда") }, leadingIcon = { Icon(AppIcons.Fork, null) }, onClick = { onDismiss(); it() }) }
        actions.deleteFrom?.let {
            DropdownMenuItem(
                text = { Text("Удалить отсюда и ниже", color = MaterialTheme.colorScheme.error) },
                leadingIcon = { Icon(AppIcons.Delete, null, tint = MaterialTheme.colorScheme.error) },
                onClick = { onDismiss(); it() },
            )
        }
    }
}

@Composable
private fun Muted(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** The model's reasoning: folded by default, one line of preview while it streams. */
@Composable
private fun ThinkingBlock(thinking: String, streaming: Boolean) {
    var open by remember { mutableStateOf(false) }
    Column(
        Modifier
            .padding(bottom = 6.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .clickable { open = !open }
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(AppIcons.Spark, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.tertiary)
            Spacer(Modifier.width(6.dp))
            Text(
                if (streaming) "Думает…" else "Размышления",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.width(4.dp))
            Icon(if (open) AppIcons.ChevronUp else AppIcons.ChevronDown, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (!open && streaming) {
            Text(
                thinking.trim().lineSequence().lastOrNull { it.isNotBlank() }.orEmpty(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        AnimatedVisibility(open) {
            SelectionContainer {
                Text(thinking.trim(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}

/** One tool call: a compact row; tapping it opens the saved full output. */
@Composable
private fun ToolRow(
    tool: ToolCall,
    loadOutput: suspend (String) -> Result<ToolOutput>,
    onCopy: (String) -> Unit,
    onOpenPath: (String) -> Unit,
) {
    val colors = LocalStatusColors.current
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var output by remember { mutableStateOf<Result<ToolOutput>?>(null) }
    var loading by remember { mutableStateOf(false) }
    val tint = when (tool.state) {
        ToolState.RUNNING -> colors.working
        ToolState.DONE -> colors.done
        ToolState.ERROR -> colors.failed
        ToolState.INTERRUPTED -> colors.muted
    }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .clickable {
                open = !open
                if (open && output == null && !loading) {
                    loading = true
                    scope.launch {
                        output = loadOutput(tool.id)
                        loading = false
                    }
                }
            }
            .padding(horizontal = 10.dp, vertical = 7.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (tool.state == ToolState.RUNNING) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = tint)
            else Icon(if (tool.state == ToolState.ERROR) AppIcons.Alert else if (tool.state == ToolState.INTERRUPTED) AppIcons.Stop else AppIcons.Check, null, Modifier.size(13.dp), tint = tint)
            Spacer(Modifier.width(8.dp))
            Text(tool.name, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface)
            Spacer(Modifier.width(8.dp))
            Text(
                tool.label.orEmpty(),
                style = MonoStyle.copy(fontSize = MaterialTheme.typography.labelMedium.fontSize),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (tool.state == ToolState.INTERRUPTED) Text("прервано", style = MaterialTheme.typography.labelSmall, color = colors.muted)
        }
        AnimatedVisibility(open) {
            Column(Modifier.padding(top = 8.dp)) {
                if (!tool.label.isNullOrBlank()) {
                    SelectionContainer { Text(tool.label.orEmpty(), style = MonoStyle, color = MaterialTheme.colorScheme.onSurface) }
                }
                tool.path?.let { path ->
                    Text(
                        "Открыть файл",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(top = 6.dp).clickable { onOpenPath(path) },
                    )
                }
                when {
                    loading -> CircularProgressIndicator(Modifier.padding(top = 8.dp).size(18.dp), strokeWidth = 2.dp)
                    output?.isSuccess == true -> {
                        val result = output!!.getOrThrow()
                        Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "Вывод · ${formatBytes(result.bytes)}${if (result.truncated) " · показан конец" else ""}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.weight(1f),
                            )
                            IconButton(onClick = { onCopy(result.text) }, modifier = Modifier.size(28.dp)) {
                                Icon(AppIcons.Copy, "Копировать вывод", Modifier.size(14.dp))
                            }
                        }
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(max = 360.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(colors.codeBackground)
                                .verticalScroll(rememberScrollState())
                                .horizontalScroll(rememberScrollState())
                                .padding(10.dp),
                        ) {
                            SelectionContainer { Text(result.text.ifEmpty { "(пусто)" }, style = MonoStyle, softWrap = false) }
                        }
                    }
                    output?.isFailure == true -> Text(
                        "Полный вывод не сохранён.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun FileChip(name: String, size: String, onClick: (() -> Unit)?) {
    Row(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(Color.Black.copy(alpha = 0.06f))
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(horizontal = 8.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(AppIcons.File, null, Modifier.size(14.dp))
        Spacer(Modifier.width(6.dp))
        Text(name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp))
        if (size.isNotEmpty()) {
            Spacer(Modifier.width(6.dp))
            Text(size, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
fun NoteRow(item: ChatItem.Note) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.Center) {
        Text(
            item.text,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.surfaceContainer).padding(horizontal = 12.dp, vertical = 4.dp),
        )
    }
}
