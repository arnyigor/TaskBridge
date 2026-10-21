package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.input.pointer.PointerButtons
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.ui.theme.TaskBridgeTheme
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// The look of inline code and of a selection is pixels, not state: render the
// answer headless and read them.
class CodeChipRenderTest {

    private val answer = "Есть `_dist/checkpoints` и ещё немного текста"
    private val width = 460
    private val height = 120

    private class Rendered(val bitmap: ImageBitmap) {
        private val pixels = IntArray(bitmap.width * bitmap.height).also {
            bitmap.readPixels(it, 0, 0, bitmap.width, bitmap.height)
        }
        fun at(x: Int, y: Int): Color = Color(pixels[y * bitmap.width + x])

        /**
         * The box behind inline code: the only long horizontal run of pixels that
         * are darker than the surface but far lighter than a glyph. Antialiased
         * glyph edges fall in the same range but never form a long run.
         */
        fun chipBox(page: Color): IntRect? {
            val runs = ArrayList<IntRect>()
            for (y in 0 until bitmap.height) {
                var start = -1
                for (x in 0..bitmap.width) {
                    val c = if (x < bitmap.width) at(x, y) else page
                    val mid = c.red < page.red - 0.015f && c.red > page.red - 0.12f && c.green < page.green - 0.015f
                    if (mid && start < 0) start = x
                    if (!mid && start >= 0) {
                        if (x - start >= 40) runs += IntRect(start, y, x, y)
                        start = -1
                    }
                }
            }
            if (runs.isEmpty()) return null
            return IntRect(runs.minOf { it.left }, runs.minOf { it.top }, runs.maxOf { it.right }, runs.maxOf { it.bottom })
        }
    }

    private fun scene(dark: Boolean, content: @androidx.compose.runtime.Composable () -> Unit): ImageComposeScene =
        ImageComposeScene(width, height, Density(1f)) {
            TaskBridgeTheme(if (dark) "dark" else "light") {
                Box(Modifier.background(MaterialTheme.colorScheme.surface).padding(8.dp)) { content() }
            }
        }

    private fun ImageComposeScene.pixels(): Rendered = Rendered(render().toComposeImageBitmap())

    /** The surface an answer is drawn on, sampled away from any content. */
    private fun surface(dark: Boolean): Color {
        val scene = ImageComposeScene(16, 16, Density(1f)) {
            TaskBridgeTheme(if (dark) "dark" else "light") {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface))
            }
        }
        val color = scene.pixels().at(4, 4)
        scene.close()
        return color
    }

    private fun markdown(): ImageComposeScene = scene(dark = false) {
        SelectionContainer { MarkdownView(answer, onCopy = {}) }
    }

    @Test
    fun inlineCodeSitsOnAVisibleChip() {
        val page = surface(dark = false)
        val scene = markdown()
        val chip = scene.pixels().chipBox(page)
        scene.close()
        assertTrue(chip != null, "a filled box behind `_dist/checkpoints`")
        assertTrue(chip.width > 80, "the box covers the whole word (${chip.width} px)")
        assertTrue(chip.height > 10, "the box is as tall as the text (${chip.height} px)")
    }

    @Test
    fun theChipIsRounded() {
        val page = surface(dark = false)
        val scene = markdown()
        val image = scene.pixels()
        scene.close()
        val chip = image.chipBox(page) ?: error("no chip")
        val middle = (chip.top + chip.bottom) / 2
        val edge = image.at(chip.left, middle)
        assertTrue(edge.red < page.red - 0.015f, "the left edge is filled at y=$middle")
        assertTrue(image.at(chip.left, chip.top).red > edge.red + 0.02f, "the top-left corner is cut, not square")
    }

    @Test
    fun aSelectionStaysVisibleOverInlineCode() {
        val page = surface(dark = false)
        val scene = markdown()
        val chip = scene.pixels().chipBox(page)!!

        // Drag across the code with the primary button: desktop text selection.
        val y = (chip.top + chip.bottom) / 2f
        scene.sendPointerEvent(PointerEventType.Press, Offset(10f, y), buttons = PointerButtons(isPrimaryPressed = true))
        for (x in 40..(chip.right + 40) step 20) scene.sendPointerEvent(PointerEventType.Move, Offset(x.toFloat(), y), buttons = PointerButtons(isPrimaryPressed = true))
        scene.sendPointerEvent(PointerEventType.Release, Offset((chip.right + 40).toFloat(), y))

        val selected = scene.pixels()
        scene.close()
        var blue = 0
        for (yy in chip.top..chip.bottom) for (xx in chip.left..chip.right) {
            val c = selected.at(xx, yy)
            if (c.blue - c.red > 0.1f) blue++
        }
        assertTrue(blue > 0, "the highlight reaches the code chip ($blue px)")
    }

    @Test
    fun aSelectionIsBlueInBothThemes() {
        for (dark in listOf(false, true)) {
            val scene = scene(dark) {
                SelectionContainer { Text("Выберите этот текст целиком, пожалуйста") }
            }
            scene.pixels()
            val y = 20f
            scene.sendPointerEvent(PointerEventType.Press, Offset(10f, y), buttons = PointerButtons(isPrimaryPressed = true))
            for (x in 40..380 step 20) scene.sendPointerEvent(PointerEventType.Move, Offset(x.toFloat(), y), buttons = PointerButtons(isPrimaryPressed = true))
            scene.sendPointerEvent(PointerEventType.Release, Offset(380f, y))
            val image = scene.pixels()
            scene.close()
            var blue = 0
            for (yy in 0 until height) for (xx in 0 until width) {
                val c = image.at(xx, yy)
                if (c.blue - c.red > 0.1f) blue++
            }
            assertTrue(blue > 200, "dark=$dark: a blue selection ($blue px)")
        }
    }

    @Test
    fun codeRangesMergeAdjacentSpans() {
        val text = buildAnnotatedString {
            append("см. ")
            withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append("a/b") }
            withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append("c") }
            append(" и всё")
        }
        assertEquals(listOf(4..7), codeRanges(text))
    }
}
