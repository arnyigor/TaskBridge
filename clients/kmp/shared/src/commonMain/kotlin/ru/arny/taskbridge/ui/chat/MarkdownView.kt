package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (block in blocks) Block(block, onCopy)
    }
}

@Composable
private fun Block(block: MdBlock, onCopy: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    when (block) {
        is MdBlock.Heading -> Text(
            inlineText(block.text),
            style = when (block.level) {
                1 -> MaterialTheme.typography.titleLarge
                2 -> MaterialTheme.typography.titleMedium.copy(fontSize = 18.sp)
                else -> MaterialTheme.typography.titleSmall
            },
            modifier = Modifier.padding(top = 4.dp),
        )
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
                    Text(marker, style = MaterialTheme.typography.bodyLarge, color = colors.primary, modifier = Modifier.widthIn(min = 22.dp))
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

@Composable
private fun CodeBlock(language: String?, code: String, onCopy: (String) -> Unit) {
    val background = LocalStatusColors.current.codeBackground
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(background)) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                language ?: "код",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = { onCopy(code) }, modifier = Modifier.size(34.dp)) {
                Icon(AppIcons.Copy, "Копировать код", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Text(
            code,
            style = MonoStyle,
            softWrap = false,
            modifier = Modifier.horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
        )
    }
}

@Composable
private fun TableBlock(table: MdBlock.Table) {
    val border = MaterialTheme.colorScheme.outlineVariant
    Box(Modifier.horizontalScroll(rememberScrollState())) {
        Column(Modifier.clip(RoundedCornerShape(10.dp)).border(1.dp, border, RoundedCornerShape(10.dp))) {
            TableRow(table.header, table.alignments, header = true)
            for (row in table.rows) {
                HorizontalDivider(color = border)
                TableRow(row, table.alignments, header = false)
            }
        }
    }
}

@Composable
private fun TableRow(cells: List<List<MdRun>>, alignments: List<MdAlign>, header: Boolean) {
    Row(Modifier.background(if (header) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent)) {
        cells.forEachIndexed { index, cell ->
            Text(
                inlineText(cell),
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal),
                textAlign = when (alignments.getOrNull(index)) {
                    MdAlign.CENTER -> TextAlign.Center
                    MdAlign.END -> TextAlign.End
                    else -> TextAlign.Start
                },
                modifier = Modifier.widthIn(min = 64.dp, max = 320.dp).padding(horizontal = 10.dp, vertical = 7.dp),
            )
        }
    }
}

/** Inline runs as one AnnotatedString; links are real links (LinkAnnotation), code is monospace. */
@Composable
fun inlineText(runs: List<MdRun>): AnnotatedString {
    val colors = MaterialTheme.colorScheme
    val codeBackground = LocalStatusColors.current.codeBackground
    return remember(runs, colors, codeBackground) {
        buildAnnotatedString {
            for (run in runs) {
                val style = SpanStyle(
                    fontWeight = if (run.bold) FontWeight.SemiBold else null,
                    fontStyle = if (run.italic) FontStyle.Italic else null,
                    fontFamily = if (run.code) FontFamily.Monospace else null,
                    background = if (run.code) codeBackground else Color.Unspecified,
                    fontSize = if (run.code) 14.sp else androidx.compose.ui.unit.TextUnit.Unspecified,
                    textDecoration = if (run.strike) TextDecoration.LineThrough else null,
                )
                if (run.link != null) {
                    withLink(LinkAnnotation.Url(run.link!!, TextLinkStyles(SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline)))) {
                        withStyle(style) { append(run.text) }
                    }
                } else {
                    withStyle(style) { append(run.text) }
                }
            }
        }
    }
}
