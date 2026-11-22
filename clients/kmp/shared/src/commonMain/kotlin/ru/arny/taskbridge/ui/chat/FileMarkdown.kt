package ru.arny.taskbridge.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ru.arny.taskbridge.core.client.markdown.MdBlock
import ru.arny.taskbridge.core.client.markdown.MdRun

internal const val FILE_TEXT_CHARS = 2048
private const val FILE_TABLE_ROWS = 8

internal sealed interface FileDecoration {
    data object Quote : FileDecoration
    data class Marker(val text: String?) : FileDecoration
}

internal data class FileCode(val source: MdBlock.Code, val chunks: List<String>, val lines: Int)
internal data class FileMarkdownItem(
    val block: MdBlock,
    val decorations: List<FileDecoration> = emptyList(),
    val tablePage: Boolean = false,
    val code: FileCode? = null,
)

internal class FileMarkdownDocument(val items: List<FileMarkdownItem>) {
    var expandedCodes by mutableStateOf(emptySet<Int>())
    fun toggleCode(index: Int) {
        expandedCodes = if (index in expandedCodes) expandedCodes - index else expandedCodes + index
    }
}

/** Bounded pieces, preserving every character and the formatting/link of each run. */
internal fun splitFileRuns(runs: List<MdRun>, limit: Int = FILE_TEXT_CHARS): List<List<MdRun>> {
    val result = mutableListOf<List<MdRun>>()
    var part = mutableListOf<MdRun>()
    var size = 0
    fun flush() {
        if (part.isNotEmpty()) result += part
        part = mutableListOf()
        size = 0
    }
    for (run in runs) {
        var start = 0
        while (start < run.text.length) {
            if (size >= limit) flush()
            var end = minOf(run.text.length, start + limit - size)
            if (end < run.text.length && run.text[end - 1].isHighSurrogate() && run.text[end].isLowSurrogate()) end--
            if (end == start) { flush(); continue }
            part += run.copy(text = run.text.substring(start, end))
            size += end - start
            start = end
        }
    }
    flush()
    return result.ifEmpty { listOf(emptyList()) }
}

/** No giant single line and no giant multi-line Text, including expanded fences/source mode. */
internal fun splitFileCode(source: String): List<String> {
    if (source.isEmpty()) return listOf("")
    val result = mutableListOf<String>()
    var start = 0
    while (start < source.length) {
        var end = minOf(source.length, start + FILE_TEXT_CHARS)
        if (end < source.length && source[end - 1].isHighSurrogate() && source[end].isLowSurrogate()) end--
        var lines = 0
        for (index in start until end) {
            if (source[index] == '\n' && ++lines == 24) { end = index + 1; break }
        }
        result += source.substring(start, end)
        start = end
    }
    return result
}

/** Prepared on Default once per file; no recursive document traversal while scrolling. */
internal fun prepareFileMarkdown(blocks: List<MdBlock>): FileMarkdownDocument {
    fun visit(block: MdBlock): List<FileMarkdownItem> = when (block) {
        is MdBlock.Paragraph -> splitFileRuns(block.text).map { FileMarkdownItem(block.copy(text = it)) }
        is MdBlock.Heading -> splitFileRuns(block.text).map { FileMarkdownItem(block.copy(text = it)) }
        is MdBlock.Quote -> block.blocks.flatMap { visit(it) }.map {
            it.copy(decorations = listOf(FileDecoration.Quote) + it.decorations)
        }
        is MdBlock.ListBlock -> block.items.flatMapIndexed { index, item ->
            val marker = when (item.checked) {
                true -> "☑"
                false -> "☐"
                null -> if (block.ordered) "${block.start + index}." else "•"
            }
            item.blocks.flatMap { visit(it) }.mapIndexed { part, entry ->
                entry.copy(decorations = listOf(FileDecoration.Marker(marker.takeIf { part == 0 })) + entry.decorations)
            }
        }
        is MdBlock.Code -> listOf(FileMarkdownItem(block, code = FileCode(block, splitFileCode(block.code), block.code.count { it == '\n' } + 1)))
        is MdBlock.Table -> {
            val columns = maxOf(block.header.size, block.rows.maxOfOrNull { it.size } ?: 0, 1)
            val cellLimit = maxOf(32, FILE_TEXT_CHARS / columns)
            fun rowParts(row: List<List<MdRun>>): List<List<List<MdRun>>> {
                val cells = row.map { splitFileRuns(it, cellLimit) }
                return List(cells.maxOfOrNull { it.size } ?: 1) { part ->
                    List(columns) { column -> cells.getOrNull(column)?.getOrNull(part).orEmpty() }
                }
            }
            val headerParts = rowParts(block.header)
            val rows = headerParts.drop(1) + block.rows.flatMap { rowParts(it) }
            if (rows.size <= FILE_TABLE_ROWS &&
                headerParts.size == 1 &&
                block.header.all { cell -> cell.sumOf { it.text.length } <= cellLimit } &&
                block.rows.all { row -> row.all { cell -> cell.sumOf { it.text.length } <= cellLimit } }) {
                listOf(FileMarkdownItem(block))
            } else {
                rows.chunked(FILE_TABLE_ROWS).ifEmpty { listOf(emptyList()) }.map { page ->
                    FileMarkdownItem(block.copy(header = headerParts.first(), rows = page), tablePage = true)
                }
            }
        }
        MdBlock.Rule -> listOf(FileMarkdownItem(block))
    }
    return FileMarkdownDocument(blocks.flatMap { visit(it) })
}
