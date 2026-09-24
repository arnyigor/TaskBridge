package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HighlightTest {

    private fun kinds(code: String, language: String?) = tokenize(code, language).map { it.kind to code.substring(it.start, it.end) }

    @Test
    fun kotlinLineColorsEachPart() {
        assertEquals(
            listOf(
                TokenKind.ANNOTATION to "@Composable",
                TokenKind.KEYWORD to "fun",
                TokenKind.FUNCTION to "show",
                TokenKind.TYPE to "String",
                TokenKind.STRING to "\"a\\\"b\"",
                TokenKind.NUMBER to "42",
                TokenKind.COMMENT to "// done",
            ),
            kinds("@Composable fun show(x: String = \"a\\\"b\", n = 42) // done", "kotlin"),
        )
    }

    @Test
    fun commentSyntaxFollowsTheLanguage() {
        assertEquals(listOf(TokenKind.COMMENT to "# note"), kinds("x = 1 # note", "python").filter { it.first == TokenKind.COMMENT })
        assertEquals(listOf(TokenKind.KEYWORD to "SELECT", TokenKind.COMMENT to "-- all"), kinds("SELECT * -- all", "sql"))
        // In a hash language "//" is not a comment (a URL, integer division).
        assertTrue(kinds("a // b", "python").none { it.first == TokenKind.COMMENT })
    }

    @Test
    fun unterminatedStringStopsAtTheLineEnd() {
        val tokens = kinds("val s = \"open\nval t = 1", "kotlin")
        assertEquals(TokenKind.STRING to "\"open", tokens[1])
        assertEquals(TokenKind.KEYWORD to "val", tokens[2])
    }

    @Test
    fun unlabeledAndPlainBlocksStayPlain() {
        assertEquals(emptyList(), tokenize("don't color me", null))
        assertEquals(emptyList(), tokenize("fun x()", "text"))
    }

    @Test
    fun binaryIsTheFileWithAZeroByte() {
        assertTrue(looksBinary(byteArrayOf(0x50, 0x4B, 0x03, 0x00)))
        assertTrue(!looksBinary("текст файла".encodeToByteArray()))
    }
}
