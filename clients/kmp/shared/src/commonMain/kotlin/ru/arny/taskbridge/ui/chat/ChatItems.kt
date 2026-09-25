package ru.arny.taskbridge.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.TimeSource
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.isSecondaryPressed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.round
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.FileRef
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
    onOpenFile: (fileId: String, name: String) -> Unit,
    loadFile: suspend (fileId: String) -> Result<ByteArray>,
    /** Desktop: the action icons appear on hover; the time stays. */
    hoverActions: Boolean = false,
) {
    val colors = LocalStatusColors.current
    val menu = remember { MenuAnchor() }
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    Column(Modifier.fillMaxWidth().padding(start = 48.dp).hoverable(interaction), horizontalAlignment = Alignment.End) {
        Box {
            Surface(
                color = colors.userBubble,
                contentColor = colors.onUserBubble,
                shape = RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp),
                modifier = Modifier.menuAnchor(menu).combinedClickable(interactionSource = null, indication = null, onClick = {}, onLongClick = { menu.open = true }),
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    if (item.mode == "steer") {
                        Text("вклинилось в ответ", style = MaterialTheme.typography.labelSmall, color = colors.onUserBubble.copy(alpha = 0.7f))
                    }
                    SelectionContainer { Text(item.text, style = MaterialTheme.typography.bodyLarge) }
                    if (item.files.isNotEmpty()) FileList(item.files, onOpenFile, loadFile, Modifier.padding(top = 8.dp))
                }
            }
            AnchoredMenu(menu, actions, isUser = true)
        }
        Row(Modifier.padding(top = 2.dp).heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
            // Same order as the web's msgActions: copy, time, then edit / fork / delete.
            Row(Modifier.alpha(if (!hoverActions || hovered || menu.open) 1f else 0f), verticalAlignment = Alignment.CenterVertically) {
                SmallAction(AppIcons.Copy, "Копировать", actions.copy)
                actions.edit?.let { SmallAction(AppIcons.Edit, "Изменить и отправить заново", it) }
                actions.fork?.let { SmallAction(AppIcons.Fork, "Новая ветка отсюда", it) }
                actions.deleteFrom?.let { SmallAction(AppIcons.Delete, "Удалить отсюда и ниже", it) }
            }
            Spacer(Modifier.width(4.dp))
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
    onOpenFile: (fileId: String, name: String) -> Unit,
    loadFile: suspend (fileId: String) -> Result<ByteArray>,
    loadWorkspaceFile: suspend (path: String) -> Result<ByteArray>,
    /** Desktop: the action row appears on hover (the newest answer keeps it). */
    hoverActions: Boolean = false,
) {
    val menu = remember { MenuAnchor() }
    var buttonMenu by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    Column(Modifier.fillMaxWidth().padding(end = 8.dp).hoverable(interaction).animateContentSize()) {
        if (item.thinking.isNotBlank()) ThinkingBlock(item.thinking, streaming = item.active && item.text.isBlank())
        if (item.tools.isNotEmpty()) ToolList(item.tools, loadToolOutput, onCopyText, onOpenPath)
        // A picture a tool wrote shows at once, while the answer runs; once the run
        // ends the same file arrives as an output file and is shown from there.
        val saved = item.files.mapNotNull { it.path }.toSet()
        for (path in item.tools.mapNotNull { it.path }.distinct().filter { isImageName(it) && it !in saved }) {
            ChatImage("ws:$path", path, { loadWorkspaceFile(path) }, onClick = { onOpenPath(path) }, Modifier.padding(vertical = 4.dp))
        }
        Box {
            Column(Modifier.fillMaxWidth().menuAnchor(menu).combinedClickable(interactionSource = null, indication = null, onClick = {}, onLongClick = { menu.open = true })) {
                when {
                    item.text.isNotBlank() -> CompositionLocalProvider(LocalOpenFile provides onOpenPath) {
                        SelectionContainer { MarkdownView(item.text, onCopy = onCopyText) }
                    }
                    item.active -> TypingIndicator()
                    item.cutOff -> Muted("Запрос прерван")
                    item.thinking.isNotBlank() || item.tools.isNotEmpty() -> if (item.final && item.error == null) Muted("Без текста")
                    item.final && item.error == null -> Muted("Ответ не был получен.")
                }
                if (item.active && item.text.isNotBlank()) TypingIndicator()
                if (item.files.isNotEmpty()) FileList(item.files, onOpenFile, loadFile, Modifier.padding(top = 8.dp))
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
                            SelectionContainer(Modifier.weight(1f, fill = false)) { Text(error, style = MaterialTheme.typography.bodySmall) }
                            IconButton(onClick = { onCopyText(error) }, modifier = Modifier.padding(start = 4.dp).size(24.dp)) {
                                Icon(AppIcons.Copy, "Копировать ошибку", Modifier.size(14.dp))
                            }
                        }
                    }
                }
            }
            AnchoredMenu(menu, actions, isUser = false)
        }
        val showActions = !hoverActions || hovered || menu.open || buttonMenu || actions.regenerate != null
        if (item.final || !item.active) {
            Row(Modifier.padding(top = 4.dp).heightIn(min = 32.dp).alpha(if (showActions) 1f else 0f), verticalAlignment = Alignment.CenterVertically) {
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
                actions.fork?.let { SmallAction(AppIcons.Fork, "Новая ветка отсюда", it) }
                actions.deleteFrom?.let { SmallAction(AppIcons.Delete, "Удалить вопрос с ответом и всё ниже", it) }
                actions.continueAnswer?.let { SmallAction(AppIcons.Play, "Продолжить ответ", it) }
                if (actions.edit != null) Box {
                    SmallAction(AppIcons.More, "Ещё") { buttonMenu = true }
                    MessageMenu(buttonMenu, onDismiss = { buttonMenu = false }, actions = actions, isUser = false)
                }
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

/** A message's context menu opens where the finger / pointer was, not at the edge of a long message. */
private class MenuAnchor {
    var at by mutableStateOf(Offset.Zero)
    var open by mutableStateOf(false)
}

/** Remembers each press position (without consuming it); a right click opens the menu at once. */
private fun Modifier.menuAnchor(anchor: MenuAnchor): Modifier = pointerInput(anchor) {
    awaitPointerEventScope {
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            if (event.type != PointerEventType.Press) continue
            anchor.at = event.changes.firstOrNull()?.position ?: continue
            if (event.buttons.isSecondaryPressed) anchor.open = true
        }
    }
}

/** Place inside the same Box as the anchored content (at its top-left). */
@Composable
private fun AnchoredMenu(anchor: MenuAnchor, actions: MessageActions, isUser: Boolean) {
    Box(Modifier.offset { anchor.at.round() }) {
        MessageMenu(anchor.open, onDismiss = { anchor.open = false }, actions = actions, isUser = isUser)
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
                text = { Text(if (isUser) "Удалить отсюда и ниже" else "Удалить вопрос с ответом и ниже", color = MaterialTheme.colorScheme.error) },
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

/** The model's reasoning: one quiet line, folded; the last line peeks through while it streams. */
@Composable
private fun ThinkingBlock(thinking: String, streaming: Boolean) {
    var open by remember { mutableStateOf(false) }
    val pinned = rememberPinned()
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.padding(bottom = 6.dp).then(pinned.modifier)) {
        Row(
            Modifier.clip(RoundedCornerShape(8.dp)).clickable { pinned.toggle { open = !open } }.padding(vertical = 4.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (open) AppIcons.ChevronDown else AppIcons.ChevronRight, null, Modifier.size(14.dp), tint = muted)
            Spacer(Modifier.width(4.dp))
            Text(if (streaming) "Думает…" else "Размышления", style = MaterialTheme.typography.labelMedium, color = muted)
        }
        if (!open && streaming) {
            Text(
                thinking.trim().lineSequence().lastOrNull { it.isNotBlank() }.orEmpty(),
                style = MaterialTheme.typography.bodySmall,
                color = muted.copy(alpha = 0.7f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 20.dp),
            )
        }
        AnimatedVisibility(open) {
            Column {
                SecondaryPane { SelectionContainer { Text(thinking.trim(), style = MaterialTheme.typography.bodySmall, color = muted) } }
                QuietRow(
                    leading = { Icon(AppIcons.ChevronUp, null, Modifier.size(14.dp), tint = muted) },
                    text = "Свернуть",
                    color = muted,
                    onClick = { open = false },
                )
            }
        }
    }
}

/** Indented, left-ruled secondary content under a quiet row: reasoning, tool output. */
@Composable
private fun SecondaryPane(content: @Composable () -> Unit) {
    Row(Modifier.padding(start = 8.dp, top = 4.dp, bottom = 4.dp).height(IntrinsicSize.Min)) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outlineVariant))
        Spacer(Modifier.width(12.dp))
        Box(Modifier.weight(1f)) { content() }
    }
}

/**
 * The tools of one answer. A few calls show as they are; more are summed up
 * by kind — "Изучил код · 6 файлов", "Изменил 2 файла" — each unfolding into
 * its calls. The group that is working says so, with the file it is on.
 */
@Composable
private fun ToolList(
    tools: List<ToolCall>,
    loadOutput: suspend (String) -> Result<ToolOutput>,
    onCopy: (String) -> Unit,
    onOpenPath: (String) -> Unit,
) {
    Column(Modifier.padding(vertical = 2.dp)) {
        if (tools.size <= 3) {
            for (tool in tools) ToolRow(tool, loadOutput, onCopy, onOpenPath)
        } else {
            for (group in groupTools(tools)) {
                if (group.tools.size == 1) ToolRow(group.tools.single(), loadOutput, onCopy, onOpenPath)
                else ToolGroupRow(group, loadOutput, onCopy, onOpenPath)
            }
        }
    }
}

@Composable
private fun ToolGroupRow(
    group: ToolGroup,
    loadOutput: suspend (String) -> Result<ToolOutput>,
    onCopy: (String) -> Unit,
    onOpenPath: (String) -> Unit,
) {
    val colors = LocalStatusColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    var open by remember { mutableStateOf(false) }
    val pinned = rememberPinned()
    val current = group.tools.lastOrNull { it.state == ToolState.RUNNING }
    Column(pinned.modifier) {
        QuietRow(
            leading = {
                when {
                    group.running -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = colors.working)
                    group.errors > 0 -> Icon(AppIcons.Alert, "Есть ошибки", Modifier.size(14.dp), tint = colors.failed)
                    else -> Icon(AppIcons.Check, null, Modifier.size(14.dp), tint = muted)
                }
            },
            text = groupSummary(group) + if (group.errors > 0) " · ошибок: ${group.errors}" else "",
            color = if (group.errors > 0) colors.failed else if (group.running) MaterialTheme.colorScheme.onSurface else muted,
            target = current?.let { toolTarget(it) }?.let { "$it…" },
            trailing = if (open) null else "›",
            onClick = { pinned.toggle { open = !open } },
        )
        if (!open) current?.progress?.let { progress ->
            Text(progress, modifier = Modifier.padding(start = 26.dp, bottom = 6.dp), style = MaterialTheme.typography.bodySmall, color = muted)
        }
        AnimatedVisibility(open) {
            Column {
                SecondaryPane { Column { for (tool in group.tools) ToolRow(tool, loadOutput, onCopy, onOpenPath) } }
                QuietRow(
                    leading = { Icon(AppIcons.ChevronUp, null, Modifier.size(14.dp), tint = muted) },
                    text = "Свернуть",
                    color = muted,
                    onClick = { open = false },
                )
            }
        }
    }
}

internal fun actionsWord(n: Int) = plural(n, "действие", "действия", "действий")

/** "Прочитал" / "Читает" — what a Pi tool did, in words; unknown tools keep their name. */
internal fun toolVerb(name: String, running: Boolean): String = when (name.lowercase()) {
    "read" -> if (running) "Читает" else "Прочитал"
    "edit" -> if (running) "Правит" else "Изменил"
    "write" -> if (running) "Пишет" else "Записал"
    "bash" -> if (running) "Выполняет" else "Выполнил"
    "grep" -> if (running) "Ищет" else "Искал"
    "find", "ls" -> if (running) "Смотрит" else "Просмотрел"
    else -> name
}

/** What the row names: a file tool shows the file name, a command its first line. */
internal fun toolTarget(tool: ToolCall): String? {
    val label = tool.label?.takeIf { it.isNotBlank() } ?: return null
    val fileTool = tool.path != null || tool.name.lowercase() in setOf("read", "edit", "write")
    return if (fileTool) label.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\') else label.lineSequence().first()
}

@Composable
private fun QuietRow(
    leading: @Composable () -> Unit,
    text: String,
    color: Color,
    onClick: () -> Unit,
    target: String? = null,
    trailing: String? = null,
) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(vertical = 5.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) { leading() }
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.labelLarge, color = color)
        if (target != null) {
            Spacer(Modifier.width(6.dp))
            Text(
                target,
                style = MonoStyle.copy(fontSize = MaterialTheme.typography.labelMedium.fontSize),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
        if (trailing != null) {
            Spacer(Modifier.width(6.dp))
            Text(trailing, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** One tool call: a quiet line; tapping it opens the full command and the saved output. */
@Composable
private fun ToolRow(
    tool: ToolCall,
    loadOutput: suspend (String) -> Result<ToolOutput>,
    onCopy: (String) -> Unit,
    onOpenPath: (String) -> Unit,
) {
    val colors = LocalStatusColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var output by remember { mutableStateOf<Result<ToolOutput>?>(null) }
    var loading by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1500); copied = false } }
    val running = tool.state == ToolState.RUNNING
    val error = tool.state == ToolState.ERROR
    val target = toolTarget(tool)
    val pinned = rememberPinned()
    Column(pinned.modifier) {
        QuietRow(
            leading = {
                when {
                    running -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = colors.working)
                    error -> Icon(AppIcons.Alert, "Ошибка", Modifier.size(14.dp), tint = colors.failed)
                    tool.state == ToolState.INTERRUPTED -> Icon(AppIcons.Stop, "Прервано", Modifier.size(12.dp), tint = muted)
                    else -> Icon(AppIcons.Check, null, Modifier.size(14.dp), tint = muted)
                }
            },
            text = toolVerb(tool.name, running) + if (running && target == null) "…" else "",
            color = if (error) colors.failed else if (running) MaterialTheme.colorScheme.onSurface else muted,
            target = target?.let { if (running) "$it…" else it },
            trailing = if (tool.state == ToolState.INTERRUPTED) "прервано" else null,
            onClick = {
                pinned.toggle { open = !open }
                if (open && output == null && !loading) {
                    loading = true
                    scope.launch {
                        val loaded = loadOutput(tool.id)
                        pinned.toggle { output = loaded }
                        loading = false
                    }
                }
            },
        )
        tool.progress?.let { progress ->
            SelectionContainer {
                Text(progress, modifier = Modifier.padding(start = 26.dp, bottom = 6.dp), style = MaterialTheme.typography.bodySmall, color = muted)
            }
        }
        AnimatedVisibility(open) {
            SecondaryPane {
                Column {
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
                                    color = muted,
                                    modifier = Modifier.weight(1f),
                                )
                                IconButton(onClick = { onCopy(result.text); copied = true }, modifier = Modifier.size(28.dp)) {
                                    Icon(if (copied) AppIcons.Check else AppIcons.Copy, if (copied) "Скопировано" else "Копировать вывод", Modifier.size(14.dp))
                                }
                            }
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .heightIn(max = 320.dp)
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
                            color = muted,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                    // Long output pushes the header off screen: fold from the bottom too.
                    QuietRow(
                        leading = { Icon(AppIcons.ChevronUp, null, Modifier.size(14.dp), tint = muted) },
                        text = "Свернуть",
                        color = muted,
                        onClick = { open = false },
                    )
                }
            }
        }
    }
}

/** Attachments or results: pictures as previews, everything else as chips; a tap opens the viewer. */
@Composable
private fun FileList(
    files: List<FileRef>,
    onOpenFile: (fileId: String, name: String) -> Unit,
    loadFile: suspend (fileId: String) -> Result<ByteArray>,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (file in files) {
            val id = file.id ?: continue
            val name = file.name ?: "файл"
            if (isImageName(name)) ChatImage("file:$id", name, { loadFile(id) }, onClick = { onOpenFile(id, name) })
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (file in files) {
                val name = file.name ?: "файл"
                FileChip(name, formatBytes(file.size), onClick = file.id?.let { id -> { onOpenFile(id, name) } })
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

/** The chat list, for blocks that unfold in place (see [rememberPinned]); null outside the chat. */
val LocalChatListState = staticCompositionLocalOf<LazyListState?> { null }

/**
 * Keeps a block's top edge still while it unfolds or folds from its header.
 * The chat is anchored at the bottom (reverse layout), so a growing block
 * would push its own header up and the chat would seem to scroll; for a short
 * while after [toggle] every shift of the edge is scrolled back. A fold from
 * the bottom calls the action directly: there the bottom edge stays, as it should.
 */
class Pinned(private val list: LazyListState?) {
    private var top = Float.NaN
    private var until: TimeSource.Monotonic.ValueTimeMark? = null

    val modifier: Modifier = Modifier.onGloballyPositioned { coordinates ->
        val y = coordinates.positionInRoot().y
        val shift = y - top
        if (list != null && !top.isNaN() && until?.hasPassedNow() == false && shift != 0f) list.dispatchRawDelta(-shift)
        else top = y
    }

    fun toggle(action: () -> Unit) {
        until = TimeSource.Monotonic.markNow() + 800.milliseconds
        action()
    }
}

@Composable
fun rememberPinned(): Pinned {
    val list = LocalChatListState.current
    return remember(list) { Pinned(list) }
}
