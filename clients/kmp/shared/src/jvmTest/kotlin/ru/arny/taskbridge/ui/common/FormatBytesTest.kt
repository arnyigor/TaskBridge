package ru.arny.taskbridge.ui.common

import kotlin.test.Test
import kotlin.test.assertEquals

/** Единицы — то, что ломается незаметно: 64 ГБ RAM печатались как «65 536.0 МБ». */
class FormatBytesTest {
    @Test
    fun sizesAreShownInTheRightUnit() {
        assertEquals("", formatBytes(null))
        assertEquals("512 Б", formatBytes(512))
        assertEquals("2 КБ", formatBytes(2048))
        assertEquals("1.5 МБ", formatBytes(1_572_864))
        // PID-независимо от платформы: system.ram.* приходит в байтах (os.totalmem).
        assertEquals("64.0 ГБ", formatBytes(64L * 1024 * 1024 * 1024))
        assertEquals("103.9 ГБ", formatBytes(111_590_555_648))
    }
}
