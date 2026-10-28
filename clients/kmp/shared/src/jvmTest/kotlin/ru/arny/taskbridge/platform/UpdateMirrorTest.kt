package ru.arny.taskbridge.platform

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * PKG-03: `robocopy /MIR` удаляет в цели всё, чего нет в источнике, поэтому
 * настройки и данные оператора должны быть исключены и из копирования, и из
 * удаления. Исключения задаются именами: абсолютный путь защищал только первый
 * уровень (`data`), а `server/data` всё равно стирался — проверено на robocopy.
 */
class UpdateMirrorTest {

    @Test
    fun userStateNamesAreProtected() {
        assertTrue("data" in UpdateMirror.protectedDirNames)
        assertTrue("logs" in UpdateMirror.protectedDirNames)
        assertTrue("backups" in UpdateMirror.protectedDirNames)
        assertTrue("config" in UpdateMirror.protectedDirNames)
        assertTrue("config.json" in UpdateMirror.protectedFileNames)
    }

    /** Программные каталоги обновляются как обычно. */
    @Test
    fun programDirectoriesAreNotExcluded() {
        for (programDir in listOf("app", "runtime", "server", "src", "web", "pi-extension", "scripts")) {
            assertFalse(programDir in UpdateMirror.protectedDirNames, "$programDir must be updated")
            assertFalse(programDir in UpdateMirror.protectedFileNames, "$programDir must be updated")
        }
    }

    @Test
    fun thePowerShellSpecsAreSemicolonSeparatedNames() {
        assertEquals(UpdateMirror.protectedDirNames.joinToString(";"), UpdateMirror.excludedDirSpec())
        assertEquals(UpdateMirror.protectedFileNames.joinToString(";"), UpdateMirror.excludedFileSpec())
        assertTrue(UpdateMirror.excludedDirSpec().split(';').none { it.contains('/') || it.contains(File.separator) })
    }
}
