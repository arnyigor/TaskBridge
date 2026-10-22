package ru.arny.taskbridge.ui.sessions

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Папка сессий открывается только по решению оператора. Активная сессия внутри,
 * выбранная сессия или непрочитанное уведомление папку больше не разворачивают:
 * список разъезжался сам, пока оператор читал другие папки.
 */
class FolderExpansionTest {
    @Test
    fun untouchedFolderStaysFolded() {
        assertFalse(
            folderExpanded(handExpanded = null),
            "папка, которую оператор не трогал, не раскрывается сама",
        )
    }

    @Test
    fun foldedByHandFolderStaysFolded() {
        assertFalse(
            folderExpanded(handExpanded = false, openByNavigation = true),
            "клик оператора обязан складывать папку даже внутри проекта, куда только что зашли",
        )
    }

    @Test
    fun openedByHandFolderStaysOpen() {
        assertTrue(
            folderExpanded(handExpanded = true),
            "развёрнутая вручную папка не должна закрываться сама",
        )
    }

    @Test
    fun drillDownOpensTheFolderTheOperatorChose() {
        assertTrue(
            folderExpanded(handExpanded = null, openByNavigation = true),
            "переход внутрь проекта — это выбор оператора показать его сессии",
        )
    }
}
