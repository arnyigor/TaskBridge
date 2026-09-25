package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntSize
import kotlin.test.Test
import kotlin.test.assertEquals

// A picture in the chat must stay inside its slot, or it draws over the text.
class PictureBoxTest {
    private fun laidOut(width: Int, height: Int): IntSize {
        var size = IntSize.Zero
        val scene = ImageComposeScene(width = 600, height = 2000, density = Density(1f)) {
            Column { Box(Modifier.pictureBox(width, height).onGloballyPositioned { size = it.size }) }
        }
        scene.render()
        scene.close()
        return size
    }

    @Test
    fun aTallPictureIsNotTallerThanItsSlot() = assertEquals(IntSize(120, 240), laidOut(500, 1000))

    @Test
    fun aWidePictureFillsTheWidth() = assertEquals(IntSize(320, 160), laidOut(1000, 500))

    @Test
    fun aSmallIconIsScaledUp() = assertEquals(IntSize(240, 240), laidOut(96, 96))
}
