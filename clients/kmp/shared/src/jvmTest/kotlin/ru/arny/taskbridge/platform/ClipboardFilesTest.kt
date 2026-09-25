package ru.arny.taskbridge.platform

import java.awt.datatransfer.Clipboard
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.awt.datatransfer.Transferable
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Ctrl+V in the composer: a picture or copied files become attachments, text stays text.
class ClipboardFilesTest {
    private fun holding(flavor: DataFlavor, data: Any) = Clipboard("test").apply {
        setContents(object : Transferable {
            override fun getTransferDataFlavors() = arrayOf(flavor)
            override fun isDataFlavorSupported(f: DataFlavor) = f == flavor
            override fun getTransferData(f: DataFlavor) = data
        }, null)
    }

    @Test
    fun aPictureBecomesAPng() {
        val file = clipboardFiles(holding(DataFlavor.imageFlavor, BufferedImage(40, 20, BufferedImage.TYPE_INT_RGB))).single()
        assertEquals("image/png", file.mimeType)
        assertTrue(file.name.endsWith(".png"), file.name)
        val decoded = ImageIO.read(file.bytes.inputStream())
        assertEquals(40 to 20, decoded.width to decoded.height)
    }

    @Test
    fun copiedFilesAreAttachedAsThemselves() {
        val copied = File.createTempFile("report", ".txt").apply { writeText("hello"); deleteOnExit() }
        val file = clipboardFiles(holding(DataFlavor.javaFileListFlavor, listOf(copied))).single()
        assertEquals(copied.name, file.name)
        assertEquals("hello", file.bytes.decodeToString())
    }

    @Test
    fun textIsLeftToTheTextField() {
        val clipboard = Clipboard("test").apply { setContents(StringSelection("just text"), null) }
        assertEquals(emptyList(), clipboardFiles(clipboard))
    }
}
