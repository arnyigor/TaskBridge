package ru.arny.taskbridge.ui.chat

import kotlin.system.measureNanoTime
import kotlin.test.Test
import kotlin.test.assertTrue
import ru.arny.taskbridge.core.client.markdown.Markdown

class LargeMarkdownTest {
    @Test
    fun parseLargeDocuments() {
        val section = "# Section\n\nParagraph with **bold**, `code` and [link](docs/file.md).\n\n- first\n- second\n\n"
        // Warm up separately: report timings, not a machine-dependent CI deadline.
        repeat(3) { Markdown.parse(section.repeat(500)) }
        for (size in listOf(300_000, 1_000_000)) {
            val source = section.repeat(size / section.length + 1)
            val timings = List(5) {
                measureNanoTime { assertTrue(Markdown.parse(source).isNotEmpty()) } / 1_000_000.0
            }.sorted()
            println("Markdown.parse ${source.length} ASCII bytes: median=${timings[2]} ms, samples=$timings")
        }
    }
}
