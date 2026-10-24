package ru.arny.taskbridge.platform

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * FP-UX-03/04, системный выбор файла: единственное решение, которое принимает
 * клиент после системного диалога, — доверять ли абсолютному пути выбранного
 * файла. Путь внутри проекта становится относительным путём сервера; всё прочее
 * (телефон, чужой каталог, symlink наружу) обязано уйти содержимым, а не именем.
 *
 * Сам OS-диалог здесь не открывается — это делает opt-in smoke с Robot. Здесь
 * проверяется то, что после него действительно решает судьбу отметки.
 */
class PickerPathTest {
    private val root: File = Files.createTempDirectory("tb-picker").toFile().apply { deleteOnExit() }

    private fun write(rel: String): File =
        File(root, rel).apply { parentFile.mkdirs(); writeText("# plan\n-# $rel\n") }

    @Test
    fun aFileInsideTheProjectIsAttachedByItsRelativePath() {
        val file = write("docs/PLAN.md")
        assertEquals("docs/PLAN.md", workspaceRelativePath(root.absolutePath, file.canonicalPath))
    }

    @Test
    fun aFilePathIsPosixEvenOnWindows() {
        val file = write("docs/deep/nested-plan.md")
        val relative = workspaceRelativePath(root.absolutePath, file.canonicalPath)
        assertEquals("docs/deep/nested-plan.md", relative)
        assertEquals(false, relative!!.contains(0x5C.toChar()))
    }

    @Test
    fun aFileOutsideTheProjectIsNeverTrustedAsAPath() {
        val outside = Files.createTempFile("tb-outside", ".md").toFile().apply { deleteOnExit() }
        assertNull(workspaceRelativePath(root.absolutePath, outside.canonicalPath))
    }

    @Test
    fun theProjectRootItselfIsNotAFile() {
        assertNull(workspaceRelativePath(root.absolutePath, root.canonicalPath))
    }

    @Test
    fun aMissingOrUnknownSourceFallsBackToContent() {
        assertNull(workspaceRelativePath(root.absolutePath, File(root, "no-such.md").absolutePath))
        assertNull(workspaceRelativePath(root.absolutePath, null))
        assertNull(workspaceRelativePath(null, write("PLAN.md").canonicalPath))
    }
}
