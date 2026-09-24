package ru.arny.taskbridge.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.withStyle
import ru.arny.taskbridge.ui.theme.LocalStatusColors

/** What a piece of code is, for coloring. */
enum class TokenKind { COMMENT, STRING, NUMBER, KEYWORD, TYPE, FUNCTION, ANNOTATION }

data class Token(val kind: TokenKind, val start: Int, val end: Int)

class CodePalette(val comment: Color, val string: Color, val number: Color, val keyword: Color, val type: Color, val function: Color, val annotation: Color) {
    fun of(kind: TokenKind) = when (kind) {
        TokenKind.COMMENT -> comment
        TokenKind.STRING -> string
        TokenKind.NUMBER -> number
        TokenKind.KEYWORD -> keyword
        TokenKind.TYPE -> type
        TokenKind.FUNCTION -> function
        TokenKind.ANNOTATION -> annotation
    }
}

private val LightPalette = CodePalette(
    comment = Color(0xFF6E7781), string = Color(0xFF0A3069), number = Color(0xFF0550AE), keyword = Color(0xFFCF222E),
    type = Color(0xFF953800), function = Color(0xFF8250DF), annotation = Color(0xFF116329),
)
private val DarkPalette = CodePalette(
    comment = Color(0xFF8B949E), string = Color(0xFFA5D6FF), number = Color(0xFF79C0FF), keyword = Color(0xFFFF7B72),
    type = Color(0xFFFFA657), function = Color(0xFFD2A8FF), annotation = Color(0xFF7EE787),
)

@Composable
fun codePalette(): CodePalette = if (LocalStatusColors.current.codeBackground.luminance() < 0.5f) DarkPalette else LightPalette

private val HASH_COMMENTS = setOf("python", "py", "sh", "bash", "shell", "zsh", "console", "yaml", "yml", "toml", "ruby", "rb", "dockerfile", "makefile", "make", "r", "perl", "pl", "powershell", "ps1", "ini", "conf", "properties", "cmake", "nix", "elixir", "ex")
private val DASH_COMMENTS = setOf("sql", "lua", "haskell", "hs", "psql", "mysql", "sqlite")
private val MARKUP = setOf("xml", "html", "svg", "vue", "xaml")
private val NO_CODE = setOf("text", "txt", "plain", "plaintext", "log", "output", "diff", "patch", "markdown", "md", "csv")

private val KEYWORDS = """
    abstract actual and as assert async await break case catch class const constructor continue data def default defer del delete
    do elif else enum except expect export extends extern false final finally fn for foreach from fun func function go goto if impl
    implements import in init inline instanceof interface internal is lambda let loop match mod module mut namespace new nil none
    not null object open operator or out override package pass private protected pub public raise readonly ref return sealed select
    self static struct super suspend switch synchronized template then this throw throws trait true try type typealias typeof
    undefined union unsafe use using val var virtual void when where while with yield None True False
""".trim().split(Regex("\\s+")).toSet()

private val SQL_KEYWORDS = """
    select from where insert into values update set delete create table index view drop alter add column primary key foreign
    references join left right inner outer full on group by order having limit offset as and or not null is in like between
    distinct union all exists case when then else end default unique begin commit rollback transaction with returning count
""".trim().split(Regex("\\s+")).toSet()

private val SHELL_KEYWORDS = setOf("if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "in", "function", "return", "export", "local", "echo", "cd", "set", "unset", "source")

/**
 * Splits [code] into colored tokens: one pass, no regex backtracking, so a
 * streaming block re-highlights cheaply. Good enough for chat, not a parser:
 * comment syntax comes from [language], keywords are a shared set.
 */
fun tokenize(code: String, language: String?): List<Token> {
    val lang = language?.lowercase()?.trim().orEmpty()
    // An unlabeled block is as often a log or plain text as code: leave it plain.
    if (lang.isEmpty() || lang in NO_CODE || code.length > 60_000) return emptyList()
    val hash = lang in HASH_COMMENTS
    val dash = lang in DASH_COMMENTS
    val markup = lang in MARKUP
    val keywords = when {
        lang in DASH_COMMENTS -> SQL_KEYWORDS
        lang in setOf("sh", "bash", "shell", "zsh", "console") -> SHELL_KEYWORDS
        else -> KEYWORDS
    }
    val ignoreCase = lang in DASH_COMMENTS
    val tokens = ArrayList<Token>()
    var i = 0
    val n = code.length
    fun at(s: String) = code.startsWith(s, i)
    while (i < n) {
        val c = code[i]
        when {
            markup && at("<!--") -> { val end = code.indexOf("-->", i + 4).let { if (it < 0) n else it + 3 }; tokens += Token(TokenKind.COMMENT, i, end); i = end }
            !hash && !dash && !markup && at("/*") -> { val end = code.indexOf("*/", i + 2).let { if (it < 0) n else it + 2 }; tokens += Token(TokenKind.COMMENT, i, end); i = end }
            (!hash && !dash && !markup && at("//")) || (hash && c == '#') || (dash && at("--")) -> {
                val end = code.indexOf('\n', i).let { if (it < 0) n else it }
                tokens += Token(TokenKind.COMMENT, i, end); i = end
            }
            c == '"' || c == '\'' || c == '`' -> {
                val triple = at("\"\"\"") || at("'''")
                val quote = if (triple) code.substring(i, i + 3) else c.toString()
                var j = i + quote.length
                while (j < n) {
                    if (code[j] == '\\' && !triple) { j += 2; continue }
                    if (code.startsWith(quote, j)) { j += quote.length; break }
                    // A single-line string does not swallow the rest of the file.
                    if (code[j] == '\n' && quote.length == 1 && c != '`') break
                    j++
                }
                j = j.coerceAtMost(n)
                tokens += Token(TokenKind.STRING, i, j); i = j
            }
            c.isDigit() && (i == 0 || !code[i - 1].isLetterOrDigit() && code[i - 1] != '_') -> {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_' || (code[j] == '.' && j + 1 < n && code[j + 1].isDigit()))) j++
                tokens += Token(TokenKind.NUMBER, i, j); i = j
            }
            c == '@' && i + 1 < n && code[i + 1].isLetter() -> {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_' || code[j] == '.')) j++
                tokens += Token(TokenKind.ANNOTATION, i, j); i = j
            }
            c.isLetter() || c == '_' || c == '$' -> {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_' || code[j] == '$')) j++
                val word = code.substring(i, j)
                val kind = when {
                    (if (ignoreCase) word.lowercase() else word) in keywords -> TokenKind.KEYWORD
                    j < n && code[j] == '(' -> TokenKind.FUNCTION
                    word[0].isUpperCase() && word.length > 1 && word.any { it.isLowerCase() } -> TokenKind.TYPE
                    else -> null
                }
                if (kind != null) tokens += Token(kind, i, j)
                i = j
            }
            else -> i++
        }
    }
    return tokens
}

fun highlight(code: String, language: String?, palette: CodePalette): AnnotatedString = buildAnnotatedString {
    if (language?.lowercase()?.trim() in setOf("diff", "patch")) {
        // A diff: added lines green, removed red, hunk headers muted.
        for (line in code.split('\n').let { lines -> lines.mapIndexed { i, l -> if (i < lines.size - 1) "$l\n" else l } }) {
            val color = when {
                line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") -> palette.comment
                line.startsWith("+") -> palette.annotation
                line.startsWith("-") -> palette.keyword
                else -> null
            }
            if (color == null) append(line) else withStyle(SpanStyle(color = color)) { append(line) }
        }
        return@buildAnnotatedString
    }
    var pos = 0
    for (token in tokenize(code, language)) {
        append(code, pos, token.start)
        val style = SpanStyle(color = palette.of(token.kind), fontStyle = if (token.kind == TokenKind.COMMENT) FontStyle.Italic else null)
        withStyle(style) { append(code, token.start, token.end) }
        pos = token.end
    }
    append(code, pos, code.length)
}

/** A language name for a file, from its extension, for [tokenize]. */
fun languageOfFile(name: String): String? = when (val ext = name.substringAfterLast('.', "").lowercase()) {
    "" -> if (name.equals("Dockerfile", true)) "dockerfile" else if (name.equals("Makefile", true)) "makefile" else null
    "kts", "kt" -> "kotlin"
    "mjs", "cjs", "js", "jsx" -> "javascript"
    "ts", "tsx" -> "typescript"
    "yml" -> "yaml"
    "htm" -> "html"
    else -> ext
}
