package ru.arny.taskbridge.ui.chat

import androidx.compose.runtime.saveable.SaverScope
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Tabs of the docked file panel: one per file, with the active one kept sane. */
class FileTabsTest {

    private val readme = FileTarget.Workspace("README.md")
    private val gaps = FileTarget.Workspace("docs/PRODUCT_GAPS.md")
    private val build = FileTarget.Workspace("src/build.kt")

    @Test
    fun openingAFileAddsItsTabAndShowsIt() {
        val tabs = FileTabs()
        tabs.open(readme)
        tabs.open(gaps)
        assertEquals(listOf<FileTarget>(readme, gaps), tabs.items.toList())
        assertEquals(1, tabs.activeIndex)
        assertEquals(gaps, tabs.active)
    }

    @Test
    fun theSameFileIsOneTabNotTwo() {
        val tabs = FileTabs()
        tabs.open(readme)
        tabs.open(gaps)
        tabs.open(readme)
        assertEquals(listOf<FileTarget>(readme, gaps), tabs.items.toList())
        assertEquals(0, tabs.activeIndex)
    }

    @Test
    fun linksToTheSameFileAtAnotherRangeUpdateTheTab() {
        val tabs = FileTabs()
        tabs.open(readme)
        tabs.open(FileTarget.Workspace("README.md", 120, 140))
        assertEquals(1, tabs.items.size)
        assertEquals(FileTarget.Workspace("README.md", 120, 140), tabs.active)
    }

    @Test
    fun attachmentsAndArtifactsAreDistinctFiles() {
        val tabs = FileTabs()
        tabs.open(FileTarget.Attachment("f1", "log.txt"))
        tabs.open(FileTarget.Artifact("log.txt"))
        assertEquals(2, tabs.items.size)
    }

    @Test
    fun closingTheActiveTabShowsItsRightNeighbourThenTheLastOne() {
        val tabs = FileTabs()
        tabs.open(readme)
        tabs.open(gaps)
        tabs.open(build)
        tabs.select(1)
        tabs.close(1)
        assertEquals(listOf<FileTarget>(readme, build), tabs.items.toList())
        assertEquals(build, tabs.active)
        tabs.close(tabs.activeIndex)
        assertEquals(readme, tabs.active)
    }

    @Test
    fun closingATabToTheLeftKeepsTheFileOnScreen() {
        val tabs = FileTabs()
        tabs.open(readme)
        tabs.open(gaps)
        tabs.open(build)
        assertEquals(build, tabs.active)
        tabs.close(0)
        assertEquals(listOf<FileTarget>(gaps, build), tabs.items.toList())
        assertEquals(build, tabs.active)
    }

    @Test
    fun closingTheLastTabLeavesNoPanel() {
        val tabs = FileTabs()
        tabs.open(readme)
        tabs.closeActive()
        assertTrue(tabs.items.isEmpty())
        assertNull(tabs.active)
        tabs.closeActive() // closing nothing must not throw
        assertTrue(tabs.items.isEmpty())
    }

    @Test
    fun closeAllClearsThePanel() {
        val tabs = FileTabs()
        tabs.open(readme)
        tabs.open(gaps)
        tabs.closeAll()
        assertTrue(tabs.items.isEmpty())
        assertEquals(0, tabs.activeIndex)
    }

    @Test
    fun tabsAndTheirOrderSurviveARestore() {
        val tabs = FileTabs()
        tabs.open(readme)
        tabs.open(FileTarget.Attachment("f1", "log.txt"))
        tabs.open(FileTarget.Workspace("src/a.kt", 12, 40))
        tabs.select(1)

        val scope = SaverScope { true }
        val saved = assertNotNull(with(FileTabsSaver) { scope.save(tabs) })
        val restored = assertNotNull(FileTabsSaver.restore(saved))
        assertEquals(tabs.items.toList(), restored.items.toList())
        assertEquals(1, restored.activeIndex)
    }

    @Test
    fun anOutOfRangeActiveIndexFallsBackToTheFirstTab() {
        val tabs = FileTabs(listOf(readme, gaps), active = 7)
        assertEquals(1, tabs.activeIndex)
        val empty = FileTabs(emptyList(), active = 3)
        assertNull(empty.active)
    }
}
