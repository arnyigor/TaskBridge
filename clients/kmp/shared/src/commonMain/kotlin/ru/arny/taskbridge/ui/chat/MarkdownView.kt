package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import io.ktor.http.decodeURLPart
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.em
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ru.arny.taskbridge.core.client.markdown.Markdown
import ru.arny.taskbridge.core.client.markdown.MdAlign
import ru.arny.taskbridge.core.client.markdown.MdBlock
import ru.arny.taskbridge.core.client.markdown.MdRun
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors
import ru.arny.taskbridge.ui.theme.MonoStyle

/**
 * An agent answer rendered from Markdown. Parsing is remembered per text, so a
 * streaming answer re-parses only when its text changes, and only this item
 * recomposes, not the whole chat.
 */
@Composable
fun MarkdownView(text: String, onCopy: (String) -> Unit, modifier: Modifier = Modifier) {
    val blocks = remember(text) { Markdown.parse(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (block in blocks) Block(block, onCopy)
    }
}

@Composable
private fun Block(block: MdBlock, onCopy: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    when (block) {
        is MdBlock.Heading -> Column(Modifier.padding(top = if (block.level <= 2) 12.dp else 6.dp)) {
            Text(
                inlineText(block.text),
                style = when (block.level) {
                    1 -> MaterialTheme.typography.titleLarge
                    2 -> MaterialTheme.typography.titleMedium.copy(fontSize = 18.sp)
                    else -> MaterialTheme.typography.titleSmall
                },
            )
            // Top-level sections get a hairline, as on GitHub: long answers read as parts.
            if (block.level <= 2) HorizontalDivider(Modifier.padding(top = 6.dp), color = colors.outlineVariant.copy(alpha = 0.6f))
        }
        is MdBlock.Paragraph -> Text(inlineText(block.text), style = MaterialTheme.typography.bodyLarge)
        is MdBlock.Code -> CodeBlock(block.language, block.code, onCopy)
        is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(colors.outlineVariant))
            Spacer(Modifier.width(10.dp))
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides colors.onSurfaceVariant) {
                    for (inner in block.blocks) Block(inner, onCopy)
                }
            }
        }
        is MdBlock.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            block.items.forEachIndexed { index, item ->
                Row {
                    val marker = when {
                        item.checked == true -> "☑"
                        item.checked == false -> "☐"
                        block.ordered -> "${block.start + index}."
                        else -> "•"
                    }
                    Text(marker, style = MaterialTheme.typography.bodyLarge, color = colors.onSurfaceVariant, modifier = Modifier.widthIn(min = 22.dp))
                    Spacer(Modifier.width(4.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (inner in item.blocks) Block(inner, onCopy)
                    }
                }
            }
        }
        is MdBlock.Table -> TableBlock(block)
        MdBlock.Rule -> HorizontalDivider(Modifier.padding(vertical = 4.dp))
    }
}

private const val FOLDED_LINES = 24

/** A fenced block: language and Copy in a header, highlighted monospace, long blocks folded. */
@Composable
fun CodeBlock(language: String?, code: String, onCopy: (String) -> Unit, modifier: Modifier = Modifier) {
    val background = LocalStatusColors.current.codeBackground
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val palette = codePalette()
    val lines = remember(code) { code.count { it == '\n' } + 1 }
    var expanded by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1500); copied = false } }
    val folded = lines > FOLDED_LINES + 6 && !expanded
    val shown = remember(code, folded) { if (folded) code.lineSequence().take(FOLDED_LINES).joinToString("\n") else code }
    val text = remember(shown, language, palette) { highlight(shown, language, palette) }
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(background)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f), RoundedCornerShape(10.dp)),
    ) {
        // The answer sits in a SelectionContainer: selectable text there takes the
        // press for selection, so only the icon of «Копировать» reacted. The header
        // is chrome, not content: no selection in it.
        DisableSelection {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 2.dp).height(34.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                language?.takeIf { it.isNotBlank() } ?: "код",
                style = MaterialTheme.typography.labelMedium,
                color = muted,
                modifier = Modifier.weight(1f),
            )
            if (lines > 1) Text("$lines стр.", style = MaterialTheme.typography.labelSmall, color = muted.copy(alpha = 0.7f))
            Row(
                Modifier.clip(RoundedCornerShape(8.dp)).pointerHoverIcon(PointerIcon.Hand).clickable { onCopy(code); copied = true }.padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (copied) AppIcons.Check else AppIcons.Copy, null, Modifier.size(14.dp), tint = muted)
                Spacer(Modifier.width(4.dp))
                Text(if (copied) "Скопировано" else "Копировать", style = MaterialTheme.typography.labelMedium, color = muted)
            }
        }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
        Text(
            text,
            style = MonoStyle,
            softWrap = false,
            modifier = Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 10.dp),
        )
        if (lines > FOLDED_LINES + 6) DisableSelection {
            Text(
                if (folded) "Показать все $lines строк" else "Свернуть",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().pointerHoverIcon(PointerIcon.Hand).clickable { expanded = !expanded }.padding(vertical = 8.dp),
            )
        }
    }
}

/**
 * A table whose columns line up: every cell is measured, a column is as wide as
 * its widest cell (capped), and the table fits the message width by wrapping
 * the widest columns first. Only when even that cannot fit does it scroll sideways.
 */
@Composable
private fun TableBlock(table: MdBlock.Table) {
    val border = MaterialTheme.colorScheme.outlineVariant
    val headerLine = MaterialTheme.colorScheme.outline.copy(alpha = 0.6f)
    val columns = maxOf(table.header.size, table.rows.maxOfOrNull { it.size } ?: 0)
    val rows = listOf(table.header) + table.rows
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val available = constraints.maxWidth
        Box(Modifier.horizontalScroll(rememberScrollState())) {
            // Written by the layout, read by the drawing of the same frame: no state needed.
            val grid = remember { TableGrid() }
            Layout(
                content = {
                    rows.forEachIndexed { r, cells ->
                        for (c in 0 until columns) {
                            Text(
                                inlineText(cells.getOrNull(c).orEmpty()),
                                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (r == 0) FontWeight.SemiBold else FontWeight.Normal),
                                textAlign = when (table.alignments.getOrNull(c)) {
                                    MdAlign.CENTER -> TextAlign.Center
                                    MdAlign.END -> TextAlign.End
                                    else -> TextAlign.Start
                                },
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
                            )
                        }
                    }
                },
                modifier = Modifier.drawBehind {
                    // Open, like ChatGPT / GitHub docs: no frame or fills, a firmer line under
                    // the header and hairlines between rows.
                    grid.rowBottoms.forEachIndexed { r, bottom ->
                        if (r == grid.rowBottoms.size - 1) return@forEachIndexed
                        val y = bottom.toFloat()
                        drawLine(if (r == 0) headerLine else border, Offset(0f, y), Offset(size.width, y), (if (r == 0) 1.5.dp else 1.dp).toPx())
                    }
                },
            ) { measurables, _ ->
                val maxColumn = 420.dp.roundToPx()
                val minColumn = 72.dp.roundToPx()
                val desired = IntArray(columns) { c -> rows.indices.maxOf { r -> measurables[r * columns + c].maxIntrinsicWidth(Int.MAX_VALUE) }.coerceAtMost(maxColumn) }
                val floor = IntArray(columns) { c -> minOf(desired[c], maxOf(minColumn, rows.indices.maxOf { r -> measurables[r * columns + c].minIntrinsicWidth(Int.MAX_VALUE) }.coerceAtMost(maxColumn / 2))) }
                val widths = fitColumns(desired, floor, available)
                val placeables = measurables.mapIndexed { i, m -> m.measure(Constraints.fixedWidth(widths[i % columns])) }
                val heights = IntArray(rows.size) { r -> (0 until columns).maxOf { c -> placeables[r * columns + c].height } }
                grid.rowBottoms = IntArray(rows.size) { r -> heights.take(r + 1).sum() }
                layout(widths.sum(), heights.sum()) {
                    var y = 0
                    for (r in rows.indices) {
                        var x = 0
                        for (c in 0 until columns) {
                            placeables[r * columns + c].place(x, y)
                            x += widths[c]
                        }
                        y += heights[r]
                    }
                }
            }
        }
    }
}

/**
 * Column widths for a table [available] px wide: each column its [desired]
 * width if all fit; otherwise the overflow is taken from the columns with the
 * most slack above their [floor] (the widest wrap first). Below the floors the
 * table keeps them and scrolls.
 */
internal fun fitColumns(desired: IntArray, floor: IntArray, available: Int): IntArray {
    val total = desired.sum()
    if (total <= available) {
        // Spare room is shared out by content, so the table spans the answer like its headings do.
        if (total == 0 || available == Int.MAX_VALUE) return desired
        val spare = available - total
        val widths = IntArray(desired.size) { desired[it] + (desired[it].toLong() * spare / total).toInt() }
        widths[widths.lastIndex] += available - widths.sum()
        return widths
    }
    val slack = IntArray(desired.size) { (desired[it] - floor[it]).coerceAtLeast(0) }
    val slackTotal = slack.sum()
    val over = total - available
    if (slackTotal <= over) return IntArray(desired.size) { minOf(desired[it], floor[it]) }
    // Rounded up, so the sum never exceeds [available]; a cut never exceeds the slack, so no column drops below its floor.
    return IntArray(desired.size) { desired[it] - ((slack[it].toLong() * over + slackTotal - 1) / slackTotal).toInt() }
}

private class TableGrid { var rowBottoms = IntArray(0) }
/** Inline runs as one AnnotatedString; links are real links (LinkAnnotation), code is monospace. */
@Composable
fun inlineText(runs: List<MdRun>): AnnotatedString {
    val colors = MaterialTheme.colorScheme
    val codeBackground = LocalStatusColors.current.codeBackground
    val openFile = LocalOpenFile.current
    return remember(runs, colors, codeBackground, openFile) {
        buildAnnotatedString {
            for (run in runs) {
                val style = SpanStyle(
                    fontWeight = if (run.bold) FontWeight.SemiBold else null,
                    fontStyle = if (run.italic) FontStyle.Italic else null,
                    fontFamily = if (run.code) FontFamily.Monospace else null,
                    color = if (run.code) colors.onSurface else Color.Unspecified,
                    background = if (run.code) colors.surfaceContainerHighest else Color.Unspecified,
                    fontSize = if (run.code) 0.9.em else androidx.compose.ui.unit.TextUnit.Unspecified,
                    textDecoration = if (run.strike) TextDecoration.LineThrough else null,
                )
                if (run.link != null) {
                    val linkStyle = TextLinkStyles(SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline))
                    val file = workspaceLinkPath(run.link!!)
                    val annotation = if (file != null && openFile != null) LinkAnnotation.Clickable(file, linkStyle) { openFile(file) } else LinkAnnotation.Url(run.link!!, linkStyle)
                    withLink(annotation) {
                        withStyle(style) { append(run.text) }
                    }
                } else {
                    withStyle(style) { append(run.text) }
                }
            }
        }
    }
}

/** Opens a workspace file from a link in an answer; null where there is no viewer (plain Markdown). */
val LocalOpenFile = staticCompositionLocalOf<((String) -> Unit)?> { null }

/**
 * The workspace path a Markdown link points at, or null for a real web link.
 * Models link files as `README.md`, `src/a.kt#L10`, `G:/proj/a.kt` or
 * `file:///G:/proj/a.kt`; a browser can do nothing with those (and "G:" even
 * looks like a URL scheme), so they open in the app's file viewer instead.
 */
internal fun workspaceLinkPath(link: String): String? {
    var path = link.trim()
    if (path.isEmpty() || path.startsWith("#")) return null
    if (path.startsWith("file:", ignoreCase = true)) path = path.substring(5).trimStart('/').let { if (Regex("^[A-Za-z]:").containsMatchIn(it)) it else "/$it" }
    else if (!Regex("^[A-Za-z]:[/\\\\]").containsMatchIn(path) && Regex("^[A-Za-z][A-Za-z0-9+.-]*:").containsMatchIn(path)) return null
    path = path.substringBefore('#').substringBefore('?')
    path = runCatching { path.replace("+", "%2B").decodeURLPart() }.getOrDefault(path)
    return path.ifBlank { null }
}
