package ru.arny.taskbridge.core.client

import ru.arny.taskbridge.core.client.markdown.MdAlign
import ru.arny.taskbridge.core.client.markdown.MdBlock
import ru.arny.taskbridge.core.client.markdown.MdRun
import ru.arny.taskbridge.core.client.markdown.Markdown
import ru.arny.taskbridge.core.client.markdown.plainText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class MarkdownTest {
    @Test
    fun blocksOfATypicalAnswer() {
        val blocks = Markdown.parse(
            """
            ## Итог

            Исправил **два** файла:

            1. `src/app.kt` — *ошибка* в цикле
            2. README

            - [x] тесты
            - [ ] релиз

            ```kotlin
            fun main() = println("ок")
            ```

            > цитата
            > вторая строка

            | Файл | Строк |
            |:-----|------:|
            | a.kt | 10 |
            | b\|c | 2 |

            ---
            Готово.
            """.trimIndent(),
        )
        assertEquals(listOf("Heading", "Paragraph", "ListBlock", "ListBlock", "Code", "Quote", "Table", "Rule", "Paragraph"), blocks.map { it::class.simpleName })
        val heading = blocks[0] as MdBlock.Heading
        assertEquals(2, heading.level)
        assertEquals("Итог", heading.text.plainText())
        assertEquals(MdRun("два", bold = true), (blocks[1] as MdBlock.Paragraph).text[1])
        val ordered = blocks[2] as MdBlock.ListBlock
        assertTrue(ordered.ordered)
        assertEquals(2, ordered.items.size)
        val firstItem = (ordered.items[0].blocks.single() as MdBlock.Paragraph).text
        assertEquals(MdRun("src/app.kt", code = true), firstItem[0])
        assertEquals(MdRun("ошибка", italic = true), firstItem[2])
        val tasks = blocks[3] as MdBlock.ListBlock
        assertEquals(listOf(true, false), tasks.items.map { it.checked })
        val code = blocks[4] as MdBlock.Code
        assertEquals("kotlin", code.language)
        assertEquals("fun main() = println(\"ок\")", code.code)
        assertTrue(code.closed)
        assertEquals("цитата\nвторая строка", ((blocks[5] as MdBlock.Quote).blocks.single() as MdBlock.Paragraph).text.plainText())
        val table = blocks[6] as MdBlock.Table
        assertEquals(listOf(MdAlign.START, MdAlign.END), table.alignments)
        assertEquals("b|c", table.rows[1][0].plainText())
    }

    @Test
    fun anUnclosedFenceWhileStreaming() {
        val code = Markdown.parse("Смотри:\n```bash\nnpm test\nnpm run") .last()
        assertIs<MdBlock.Code>(code)
        assertEquals(false, code.closed)
        assertEquals("npm test\nnpm run", code.code)
    }

    @Test
    fun inlineRules() {
        assertEquals(listOf(MdRun("snake_case_name stays")), Markdown.inline("snake_case_name stays"))
        assertEquals(listOf(MdRun("2 * 3 * 4")), Markdown.inline("2 * 3 * 4"))
        assertEquals(listOf(MdRun("see "), MdRun("docs", link = "https://x.io/a"), MdRun(".")), Markdown.inline("see [docs](https://x.io/a)."))
        assertEquals(listOf(MdRun("at "), MdRun("https://pc.local:8787/x", link = "https://pc.local:8787/x"), MdRun(", ok")), Markdown.inline("at https://pc.local:8787/x, ok"))
        assertEquals(listOf(MdRun("old", strike = true)), Markdown.inline("~~old~~"))
        assertEquals(listOf(MdRun("**literal**")), Markdown.inline("\\*\\*literal\\*\\*"))
        assertEquals(listOf(MdRun("a "), MdRun("b", bold = true, italic = true)), Markdown.inline("a ***b***"))
        assertEquals(listOf(MdRun("x ** y")), Markdown.inline("x ** y"))
    }

    @Test
    fun plainTextNeverThrows() {
        for (sample in listOf("", "*", "**", "[", "[a](", "`", "```", "| a |", "1.", "- ", "> ", "#", "~~", "<http", "_a_b_")) {
            Markdown.parse(sample)
        }
    }
}
