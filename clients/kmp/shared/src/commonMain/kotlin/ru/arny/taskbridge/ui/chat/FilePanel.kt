package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.session.describe
import ru.arny.taskbridge.platform.PlatformServices
import ru.arny.taskbridge.ui.theme.AppIcons

/**
 * Files opened in the docked panel, with the tab on screen. One tab per file:
 * opening a file that is already open brings its tab forward (and updates the
 * line range) instead of stacking a duplicate.
 */
internal class FileTabs(initial: List<FileTarget> = emptyList(), active: Int = 0) {
    val items = mutableStateListOf<FileTarget>().also { list -> list.addAll(initial) }

    var activeIndex by mutableStateOf(active.coerceIn(0, maxOf(0, initial.lastIndex)))
        private set

    val active: FileTarget? get() = items.getOrNull(activeIndex)

    fun open(target: FileTarget) {
        val existing = items.indexOfFirst { it.identity == target.identity }
        if (existing >= 0) {
            items[existing] = target
            activeIndex = existing
        } else {
            items += target
            activeIndex = items.lastIndex
        }
    }

    fun select(index: Int) {
        if (index in items.indices) activeIndex = index
    }

    /** Closing the active tab shows its right neighbour, or the last one when it was the rightmost. */
    fun close(index: Int) {
        if (index !in items.indices) return
        val active = activeIndex
        items.removeAt(index)
        activeIndex = when {
            items.isEmpty() -> 0
            index < active -> active - 1
            index == active -> index.coerceAtMost(items.lastIndex)
            else -> active
        }
    }

    fun closeActive() = close(activeIndex)

    fun closeAll() {
        items.clear()
        activeIndex = 0
    }
}

private const val TAB_FIELD = "\u001f"

/** Tabs survive the Android activity being recreated; the files themselves are re-read from the API. */
internal val FileTabsSaver = Saver<FileTabs, List<String>>(
    save = { tabs -> listOf(tabs.activeIndex.toString()) + tabs.items.map { it.toFields().joinToString(TAB_FIELD) } },
    restore = { saved ->
        val active = saved.firstOrNull()?.toIntOrNull() ?: 0
        val targets = saved.drop(1).mapNotNull { raw -> targetFromFields(raw.split(TAB_FIELD)) }
        FileTabs(targets, active)
    },
)

/** От 700 dp области чата у панели есть место рядом с лентой; уже — только шит снизу. */
internal val PANEL_PANE_MIN = 700.dp
internal val MIN_PANEL_WIDTH = 360.dp
internal val DEFAULT_PANEL_WIDTH = 440.dp

/** Ширина из настроек, а мусор в ней (0, отрицательное, огромное) — это значение по умолчанию. */
internal fun panelWidthSetting(stored: Int): Dp = if (stored in 320..1400) stored.dp else DEFAULT_PANEL_WIDTH

/**
 * Чат с блоком просмотра файлов: на широком окне — док-панель справа, которая
 * забирает ширину у чата (ответ и файл видны одновременно), на телефоне — шит
 * снизу, как раньше. Обе формы рисуют один и тот же файл одним и тем же кодом.
 */
@Composable
internal fun ChatWithFilePanel(
    tabs: FileTabs,
    session: ChatSession,
    platform: PlatformServices,
    width: Dp,
    onWidth: (Dp) -> Unit,
    /** Вызывается по окончании перетаскивания разделителя: момент, когда ширину стоит сохранить. */
    onWidthCommitted: () -> Unit,
    onOpenPath: (WorkspaceLink) -> Unit,
    /** Esc нажат: сначала панель, потом прежнее поведение экрана. true — событие обработано. */
    onEscape: () -> Boolean,
    chat: @Composable () -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxSize().onPreviewKeyEvent { event ->
        if (event.type == KeyEventType.KeyUp && event.key == Key.Escape) onEscape() else false
    }) {
        val docked = tabs.items.isNotEmpty() && maxWidth >= PANEL_PANE_MIN
        // Панель не должна съедать чат: не больше 70% области.
        val limit = (maxWidth * 0.7f).coerceAtLeast(MIN_PANEL_WIDTH)
        val shown = width.coerceIn(MIN_PANEL_WIDTH, limit)
        if (docked) {
            Row(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxHeight()) { chat() }
                PanelSplitter(width = shown, minWidth = MIN_PANEL_WIDTH, maxWidth = limit, onWidth = onWidth, onRelease = onWidthCommitted)
                FilePanel(
                    tabs = tabs,
                    session = session,
                    platform = platform,
                    onClose = { tabs.closeAll() },
                    onOpenPath = onOpenPath,
                    modifier = Modifier.width((shown - 7.dp).coerceAtLeast(MIN_PANEL_WIDTH)),
                )
            }
        } else {
            chat()
            // На узком окне места на док нет — тот же файл открывается шитом.
            tabs.active?.let { target ->
                FileViewer(
                    target,
                    session,
                    platform,
                    onDismiss = { tabs.closeAll() },
                    // A link inside a rendered Markdown file opens the file it points at.
                    onOpenPath = onOpenPath,
                )
            }
        }
    }
}

@Composable
internal fun rememberFileTabs(key: Any?): FileTabs =
    rememberSaveable(key, saver = FileTabsSaver) { FileTabs() }

/** Drag handle between the chat and the panel: dragging left makes the panel wider. */
@Composable
internal fun PanelSplitter(
    width: Dp,
    minWidth: Dp,
    maxWidth: Dp,
    onWidth: (Dp) -> Unit,
    /** Called once the drag ends, not on every frame: that is when the width is persisted. */
    onRelease: () -> Unit,
) {
    val density = LocalDensity.current
    // The drag state keeps the lambda of the first composition; without this the
    // gesture would keep adding deltas to the width it saw when the drag began.
    val current by rememberUpdatedState(width)
    val state = rememberDraggableState { delta ->
        onWidth((current - with(density) { delta.toDp() }).coerceIn(minWidth, maxWidth))
    }
    Box(
        Modifier
            .width(7.dp)
            .fillMaxHeight()
            .pointerHoverIcon(PointerIcon.Hand)
            .draggable(state, Orientation.Horizontal, onDragStopped = { onRelease() }),
        contentAlignment = Alignment.Center,
    ) {
        VerticalDivider(Modifier.fillMaxHeight())
    }
}

/**
 * The docked file panel: a tab per opened file, and the active file below with
 * its path, its view mode and a few actions. Sits to the right of the chat, so
 * the answer that mentions the file stays in sight while it is read.
 */
@Composable
internal fun FilePanel(
    tabs: FileTabs,
    session: ChatSession,
    platform: PlatformServices,
    onClose: () -> Unit,
    onOpenPath: (WorkspaceLink) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(modifier.fillMaxHeight(), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxSize()) {
            TabStrip(tabs, onClose)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            val target = tabs.active
            if (target != null) {
                PanelFile(target, session, platform, onOpenPath)
            } else {
                Spacer(Modifier.fillMaxSize())
            }
        }
    }
}

@Composable
private fun TabStrip(tabs: FileTabs, onClose: () -> Unit) {
    val listState = rememberLazyListState()
    // A file opened from a link deep in a Markdown document must bring its own tab
    // into view, not leave it off the right edge of the strip.
    LaunchedEffect(tabs.activeIndex, tabs.items.size) {
        if (tabs.items.isNotEmpty()) listState.animateScrollToItem(tabs.activeIndex.coerceIn(0, tabs.items.lastIndex))
    }
    Row(
        Modifier.fillMaxWidth().height(42.dp).background(MaterialTheme.colorScheme.surfaceContainerLow),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LazyRow(
            Modifier.weight(1f).fillMaxHeight(),
            state = listState,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            itemsIndexed(tabs.items, key = { _, target -> target.identity }) { index, target ->
                FileTab(target.name, active = index == tabs.activeIndex, onSelect = { tabs.select(index) }, onClose = { tabs.close(index) })
            }
        }
        IconButton(onClick = onClose) { Icon(AppIcons.Close, "Закрыть панель файлов", Modifier.size(18.dp)) }
    }
}

@Composable
private fun FileTab(name: String, active: Boolean, onSelect: () -> Unit, onClose: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier
            .fillMaxHeight()
            .background(if (active) colors.surface else colors.surfaceContainerLow)
            .clickable(onClick = onSelect)
            .padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(AppIcons.File, null, Modifier.size(14.dp), tint = if (active) colors.primary else colors.onSurfaceVariant)
        Spacer(Modifier.width(6.dp))
        Text(
            name,
            style = MaterialTheme.typography.labelLarge,
            color = if (active) colors.onSurface else colors.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 150.dp),
        )
        Spacer(Modifier.width(6.dp))
        Box(Modifier.size(22.dp).clip(RoundedCornerShape(4.dp)).clickable(onClick = onClose), contentAlignment = Alignment.Center) {
            Icon(AppIcons.Close, "Закрыть вкладку", Modifier.size(13.dp), tint = colors.onSurfaceVariant)
        }
        if (!active) VerticalDivider(Modifier.padding(start = 4.dp).height(18.dp))
    }
}

@Composable
private fun ColumnScope.PanelFile(
    target: FileTarget,
    session: ChatSession,
    platform: PlatformServices,
    onOpenPath: (WorkspaceLink) -> Unit,
) {
    val state = rememberFileViewState(target, session)
    // A Markdown file opens as the document it is; the source stays one tap away.
    // Both are remembered per file, so switching tabs does not carry the mode and
    // the scroll position of the previous one.
    var source by remember(target.identity) { mutableStateOf(false) }
    val scroll = rememberSaveable(target.identity, saver = ScrollState.Saver) { ScrollState(0) }
    val markdown = isMarkdownName(target.name)
    Row(
        Modifier.fillMaxWidth().padding(start = 14.dp, end = 6.dp, top = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                fileLocationLine(target),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val info = fileInfoLine(target, state.loaded)
            if (info != null) {
                Text(info, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f))
            }
        }
        if (markdown) ViewModeToggle(source) { source = it }
        IconButton(onClick = { state.reload() }) { Icon(AppIcons.Refresh, "Прочитать файл заново", Modifier.size(17.dp)) }
        PanelActions(target, session, platform, state)
    }
    state.notice?.let {
        Text(
            it,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(start = 14.dp, top = 4.dp),
        )
    }
    HorizontalDivider(Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
    Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(14.dp)) {
        FileBody(target, state.loaded, platform, markdown = !source, onOpenPath = onOpenPath)
    }
}

/** Markdown ⇄ source, the way the web viewer offers a `.md` file's two readings. */
@Composable
private fun ViewModeToggle(source: Boolean, onSource: (Boolean) -> Unit) {
    Row(
        Modifier.clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for ((label, value) in listOf("Просмотр" to false, "Текст" to true)) {
            val selected = source == value
            Text(
                label,
                style = MaterialTheme.typography.labelMedium,
                color = if (selected) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                    .clickable { onSource(value) }
                    .padding(horizontal = 9.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun PanelActions(target: FileTarget, session: ChatSession, platform: PlatformServices, state: FileViewState) {
    var open by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun tell(message: String) = state.setNotice(message)
    fun openComputer(reveal: Boolean) = scope.launch {
        tell(
            requestOpenOnComputer(target, session, reveal).fold(
                onSuccess = { if (reveal) "Показано в папке на компьютере" else "Открыто на компьютере" },
                onFailure = { error -> (error as? ApiException)?.let { e -> describe(e.error) } ?: error.message ?: "Не удалось открыть файл" },
            ),
        )
    }
    Box {
        IconButton(onClick = { open = true }) { Icon(AppIcons.More, "Действия с файлом", Modifier.size(17.dp)) }
        DropdownMenu(open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text("Копировать путь") },
                leadingIcon = { Icon(AppIcons.Copy, null, Modifier.size(16.dp)) },
                onClick = {
                    platform.copyText(fileLocationLine(target))
                    tell("Путь скопирован")
                    open = false
                },
            )
            if (platform.kind == "desktop") {
                DropdownMenuItem(
                    text = { Text("Открыть в приложении") },
                    leadingIcon = { Icon(AppIcons.Computer, null, Modifier.size(16.dp)) },
                    onClick = {
                        open = false
                        openComputer(reveal = false)
                    },
                )
                DropdownMenuItem(
                    text = { Text("Показать в папке") },
                    leadingIcon = { Icon(AppIcons.Folder, null, Modifier.size(16.dp)) },
                    onClick = {
                        open = false
                        openComputer(reveal = true)
                    },
                )
            }
        }
    }
}
