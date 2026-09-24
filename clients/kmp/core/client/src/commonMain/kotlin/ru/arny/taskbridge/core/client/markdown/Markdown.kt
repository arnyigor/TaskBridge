package ru.arny.taskbridge.core.client.markdown

// A small Markdown parser for agent answers: the subset models actually write
// (headings, paragraphs, fenced code, quotes, lists with checkboxes, tables,
// rules; bold, italic, inline code, strikethrough, links). It never fails:
// anything it does not understand stays text. Streaming answers are re-parsed
// on every update, so an unclosed fence simply runs to the end.

sealed interface MdBlock {
    data class Heading(val level: Int, val text: List<MdRun>) : MdBlock
    data class Paragraph(val text: List<MdRun>) : MdBlock
    data class Code(val language: String?, val code: String, val closed: Boolean) : MdBlock
    data class Quote(val blocks: List<MdBlock>) : MdBlock
    data class ListBlock(val ordered: Boolean, val start: Int, val items: List<MdListItem>) : MdBlock
    data class Table(val header: List<List<MdRun>>, val alignments: List<MdAlign>, val rows: List<List<List<MdRun>>>) : MdBlock
    data object Rule : MdBlock
}

data class MdListItem(val checked: Boolean?, val blocks: List<MdBlock>)

enum class MdAlign { START, CENTER, END }

data class MdRun(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val code: Boolean = false,
    val strike: Boolean = false,
    val link: String? = null,
)

object Markdown {
    private val HEADING = Regex("^(#{1,6})\\s+(.*?)\\s*#*\\s*$")
    private val FENCE = Regex("^(\\s{0,3})(`{3,}|~{3,})\\s*([^`\\s]*)?.*$")
    private val BULLET = Regex("^(\\s*)([-*+])\\s+(.*)$")
    private val ORDERED = Regex("^(\\s*)(\\d{1,9})[.)]\\s+(.*)$")
    private val RULE = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
    private val TABLE_SEPARATOR = Regex("^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$")
    private val CHECKBOX = Regex("^\\[([ xX])]\\s+(.*)$")

    fun parse(source: String): List<MdBlock> = parseLines(source.replace("\r\n", "\n").split('\n'))

    private fun parseLines(lines: List<String>): List<MdBlock> {
        val blocks = mutableListOf<MdBlock>()
        var i = 0
        val paragraph = mutableListOf<String>()
        fun flush() {
            if (paragraph.isNotEmpty()) {
                blocks += MdBlock.Paragraph(inline(paragraph.joinToString("\n")))
                paragraph.clear()
            }
        }
        while (i < lines.size) {
            val line = lines[i]
            val fence = FENCE.matchEntire(line)
            if (fence != null) {
                flush()
                val marker = fence.groupValues[2]
                val language = fence.groupValues[3].ifEmpty { null }
                val code = mutableListOf<String>()
                i++
                var closed = false
                while (i < lines.size) {
                    val candidate = lines[i].trim()
                    if (candidate.startsWith(marker.take(3)) && candidate.all { it == marker[0] } && candidate.length >= marker.length) {
                        closed = true
                        i++
                        break
                    }
                    code += lines[i]
                    i++
                }
                blocks += MdBlock.Code(language, code.joinToString("\n"), closed)
                continue
            }
            if (line.isBlank()) { flush(); i++; continue }
            HEADING.matchEntire(line)?.let {
                flush()
                blocks += MdBlock.Heading(it.groupValues[1].length, inline(it.groupValues[2]))
                i++
                return@let
            }?.also { continue }
            if (RULE.matches(line) && paragraph.isEmpty()) { flush(); blocks += MdBlock.Rule; i++; continue }
            if (line.trimStart().startsWith(">")) {
                flush()
                val quoted = mutableListOf<String>()
                while (i < lines.size && lines[i].trimStart().startsWith(">")) {
                    quoted += lines[i].trimStart().removePrefix(">").removePrefix(" ")
                    i++
                }
                blocks += MdBlock.Quote(parseLines(quoted))
                continue
            }
            if (line.contains('|') && i + 1 < lines.size && TABLE_SEPARATOR.matches(lines[i + 1]) && lines[i + 1].contains('-')) {
                flush()
                val header = cells(line)
                val alignments = cells(lines[i + 1]).map { cell ->
                    val c = cell.trim()
                    when {
                        c.startsWith(":") && c.endsWith(":") -> MdAlign.CENTER
                        c.endsWith(":") -> MdAlign.END
                        else -> MdAlign.START
                    }
                }
                i += 2
                val rows = mutableListOf<List<List<MdRun>>>()
                while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) {
                    val row = cells(lines[i])
                    rows += List(header.size) { index -> inline(row.getOrElse(index) { "" }.trim()) }
                    i++
                }
                blocks += MdBlock.Table(header.map { inline(it.trim()) }, List(header.size) { alignments.getOrElse(it) { MdAlign.START } }, rows)
                continue
            }
            val bullet = BULLET.matchEntire(line)
            val ordered = ORDERED.matchEntire(line)
            if ((bullet != null || ordered != null) && !(bullet != null && RULE.matches(line))) {
                flush()
                val isOrdered = bullet == null
                val baseIndent = (bullet ?: ordered)!!.groupValues[1].length
                val start = ordered?.groupValues?.get(2)?.toIntOrNull() ?: 1
                val items = mutableListOf<MdListItem>()
                var itemLines = mutableListOf<String>()
                fun closeItem() {
                    if (itemLines.isEmpty()) return
                    val first = itemLines.first()
                    val check = CHECKBOX.matchEntire(first)
                    val content = if (check != null) listOf(check.groupValues[2]) + itemLines.drop(1) else itemLines
                    items += MdListItem(check?.let { it.groupValues[1] != " " }, parseLines(content))
                    itemLines = mutableListOf()
                }
                while (i < lines.size) {
                    val current = lines[i]
                    val b = BULLET.matchEntire(current)
                    val o = ORDERED.matchEntire(current)
                    val marker = if (isOrdered) o else b
                    if (marker != null && marker.groupValues[1].length <= baseIndent + 1) {
                        closeItem()
                        itemLines += marker.groupValues[3]
                        i++
                        continue
                    }
                    if (current.isBlank()) {
                        // A blank line ends the list unless the next line continues it indented.
                        val next = lines.getOrNull(i + 1)
                        if (next != null && (next.startsWith("  ") || (if (isOrdered) ORDERED else BULLET).matchEntire(next)?.groupValues?.get(1)?.length?.let { it <= baseIndent + 1 } == true)) {
                            itemLines += ""
                            i++
                            continue
                        }
                        break
                    }
                    if (current.startsWith(" ".repeat(baseIndent + 2)) || current.startsWith("\t")) {
                        itemLines += current.drop(minOf(current.length, baseIndent + 2).coerceAtMost(current.indexOfFirst { !it.isWhitespace() }.coerceAtLeast(0)))
                        i++
                        continue
                    }
                    if (itemLines.isNotEmpty() && b == null && o == null && !FENCE.matches(current) && !HEADING.matches(current)) {
                        // Lazy continuation of the item's paragraph.
                        itemLines += current.trim()
                        i++
                        continue
                    }
                    break
                }
                closeItem()
                blocks += MdBlock.ListBlock(isOrdered, start, items)
                continue
            }
            paragraph += line
            i++
        }
        flush()
        return blocks
    }

    private fun cells(line: String): List<String> {
        var text = line.trim()
        if (text.startsWith("|")) text = text.drop(1)
        if (text.endsWith("|") && !text.endsWith("\\|")) text = text.dropLast(1)
        val out = mutableListOf<String>()
        val cell = StringBuilder()
        var inCode = false
        var index = 0
        while (index < text.length) {
            val c = text[index]
            when {
                c == '\\' && index + 1 < text.length && text[index + 1] == '|' -> { cell.append('|'); index++ }
                c == '`' -> { inCode = !inCode; cell.append(c) }
                c == '|' && !inCode -> { out += cell.toString(); cell.clear() }
                else -> cell.append(c)
            }
            index++
        }
        out += cell.toString()
        return out
    }

    /** Inline formatting of one block's text. */
    fun inline(text: String): List<MdRun> {
        val runs = mutableListOf<MdRun>()
        parseInline(text, Style(), runs)
        return merge(runs)
    }

    private data class Style(val bold: Boolean = false, val italic: Boolean = false, val strike: Boolean = false, val link: String? = null)

    private val URL = Regex("^(https?://[^\\s<>()\\[\\]]*[^\\s<>()\\[\\].,;:!?'\"])")

    private fun parseInline(text: String, style: Style, out: MutableList<MdRun>) {
        val plain = StringBuilder()
        fun emit() {
            if (plain.isNotEmpty()) {
                out += MdRun(plain.toString(), style.bold, style.italic, false, style.strike, style.link)
                plain.clear()
            }
        }
        var i = 0
        while (i < text.length) {
            val c = text[i]
            // Escapes.
            if (c == '\\' && i + 1 < text.length && text[i + 1] in "\\`*_{}[]()#+-.!|~<>") {
                plain.append(text[i + 1]); i += 2; continue
            }
            // Inline code: the content is literal.
            if (c == '`') {
                var ticks = 1
                while (i + ticks < text.length && text[i + ticks] == '`') ticks++
                val fence = "`".repeat(ticks)
                val end = text.indexOf(fence, i + ticks)
                if (end > 0) {
                    emit()
                    var code = text.substring(i + ticks, end)
                    if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.substring(1, code.length - 1)
                    out += MdRun(code, style.bold, style.italic, true, style.strike, style.link)
                    i = end + ticks
                    continue
                }
            }
            // Links: [text](url)
            if (c == '[' && style.link == null) {
                val close = findClosing(text, i, '[', ']')
                if (close > 0 && close + 1 < text.length && text[close + 1] == '(') {
                    val end = text.indexOf(')', close + 2)
                    if (end > 0) {
                        emit()
                        val url = text.substring(close + 2, end).trim().substringBefore(' ')
                        parseInline(text.substring(i + 1, close), style.copy(link = url), out)
                        i = end + 1
                        continue
                    }
                }
            }
            // Autolinks: <https://…> and bare URLs.
            if (c == '<' && style.link == null) {
                val end = text.indexOf('>', i)
                val candidate = if (end > 0) text.substring(i + 1, end) else ""
                if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
                    emit()
                    out += MdRun(candidate, style.bold, style.italic, false, style.strike, candidate)
                    i = end + 1
                    continue
                }
            }
            if ((c == 'h') && style.link == null && (i == 0 || !text[i - 1].isLetterOrDigit())) {
                val match = URL.find(text.substring(i))
                if (match != null) {
                    emit()
                    val url = match.value
                    out += MdRun(url, style.bold, style.italic, false, style.strike, url)
                    i += url.length
                    continue
                }
            }
            // Strikethrough ~~text~~
            if (c == '~' && text.startsWith("~~", i)) {
                val end = text.indexOf("~~", i + 2)
                if (end > i + 2) {
                    emit()
                    parseInline(text.substring(i + 2, end), style.copy(strike = true), out)
                    i = end + 2
                    continue
                }
            }
            // Emphasis: ** / __ (bold), * / _ (italic). Intraword underscores stay literal (snake_case).
            if ((c == '*' || c == '_') && text.startsWith("$c$c$c", i)) {
                // ***bold italic***
                val marker = "$c$c$c"
                val end = text.indexOf(marker, i + 3)
                if (end > i + 3 && !text[i + 3].isWhitespace() && !text[end - 1].isWhitespace()) {
                    emit()
                    parseInline(text.substring(i + 3, end), style.copy(bold = true, italic = true), out)
                    i = end + 3
                    continue
                }
            }
            if (c == '*' || c == '_') {
                val double = i + 1 < text.length && text[i + 1] == c
                val marker = if (double) "$c$c" else "$c"
                val leftFlanking = i + marker.length < text.length && !text[i + marker.length].isWhitespace()
                val intraword = c == '_' && i > 0 && text[i - 1].isLetterOrDigit()
                if (leftFlanking && !intraword) {
                    val end = findEmphasisEnd(text, i + marker.length, marker)
                    if (end > 0) {
                        emit()
                        val inner = text.substring(i + marker.length, end)
                        parseInline(inner, if (double) style.copy(bold = true) else style.copy(italic = true), out)
                        i = end + marker.length
                        continue
                    }
                }
            }
            plain.append(c)
            i++
        }
        emit()
    }

    private fun findEmphasisEnd(text: String, from: Int, marker: String): Int {
        var index = from
        while (true) {
            val end = text.indexOf(marker, index)
            if (end < 0) return -1
            val before = text[end - 1]
            val after = text.getOrNull(end + marker.length)
            // Closing marker: not after whitespace, and for a single marker not part of a double one.
            val single = marker.length == 1 && after == marker[0]
            val intraword = marker[0] == '_' && after != null && after.isLetterOrDigit()
            if (!before.isWhitespace() && end > from && !single && !intraword) return end
            index = end + if (single) 2 else 1
        }
    }

    private fun findClosing(text: String, open: Int, openChar: Char, closeChar: Char): Int {
        var depth = 0
        var i = open
        while (i < text.length) {
            when (text[i]) {
                '\\' -> i++
                openChar -> depth++
                closeChar -> { depth--; if (depth == 0) return i }
            }
            i++
        }
        return -1
    }

    private fun merge(runs: List<MdRun>): List<MdRun> {
        val merged = mutableListOf<MdRun>()
        for (run in runs) {
            val last = merged.lastOrNull()
            if (last != null && last.copy(text = "") == run.copy(text = "")) merged[merged.lastIndex] = last.copy(text = last.text + run.text)
            else merged += run
        }
        return merged
    }
}

/** Text without formatting, e.g. for copying an answer or a notification preview. */
fun List<MdRun>.plainText(): String = joinToString("") { it.text }
