package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertTrue

class TableLayoutTest {

    @Test
    fun aNarrowTableStretchesToTheFullWidthByContent() {
        assertContentEquals(intArrayOf(133, 267), fitColumns(intArrayOf(100, 200), intArrayOf(80, 80), 400))
    }

    @Test
    fun theWidestColumnWrapsFirstAndTheTableFitsExactly() {
        val widths = fitColumns(intArrayOf(120, 420), intArrayOf(100, 100), 400)
        assertTrue(widths.sum() <= 400, "fits: ${widths.toList()}")
        assertTrue(widths[0] >= 100 && widths[1] >= 100, "no column below its floor: ${widths.toList()}")
        assertTrue(widths[0] >= 110, "the narrow label column is barely touched: ${widths.toList()}")
    }

    @Test
    fun tooManyColumnsKeepTheirFloorsAndScroll() {
        assertContentEquals(intArrayOf(100, 100, 100), fitColumns(intArrayOf(300, 300, 300), intArrayOf(100, 100, 100), 200))
    }
}
