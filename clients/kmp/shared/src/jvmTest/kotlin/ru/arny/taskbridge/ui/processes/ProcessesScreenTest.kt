package ru.arny.taskbridge.ui.processes

import ru.arny.taskbridge.core.api.ProcessEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Панель процессов без Compose: форматы и сортировка — чистые функции файла
// экрана, так же проверены карточки «Локальных моделей» (LocalModelCardTest).

class ProcessesScreenTest {

    private fun entry(pid: Long, name: String? = "node.exe", memory: Long? = 100L, commandLine: String? = null, startedAt: Long? = null) =
        ProcessEntry(pid = pid, name = name, memoryBytes = memory, startedAt = startedAt, commandLine = commandLine)

    @Test
    fun memoryLabelScalesBytesToHumanUnits() {
        assertEquals("—", processMemoryLabel(null))
        assertEquals("—", processMemoryLabel(0))
        assertEquals("1 МБ", processMemoryLabel(1_100_000))
        assertEquals("1 КБ", processMemoryLabel(1))
    }

    @Test
    fun memoryLabelShowsGigabytesWithOneDecimal() {
        // 15347 МБ → 14.99 ГБ; гигабайты вместо «15764 МБ», которые не прочитать.
        assertEquals("15.0 ГБ", processMemoryLabel(15_347L * 1024 * 1024))
    }

    @Test
    fun subLabelAlwaysCarriesPidAndCommandLineWhenKnown() {
        assertEquals("pid 42", processSubLabel(entry(42, name = null, commandLine = null)))
        assertEquals("pid 42 · node src/index.js", processSubLabel(entry(42, commandLine = "node src/index.js")))
    }

    @Test
    fun ageLabelSpeaksMinutesAndHours() {
        val now = 1_000_000_000_000L
        assertEquals("только что", processAgeLabel(now, now))
        assertEquals("5 мин назад", processAgeLabel(now - 5 * 60_000, now))
        assertEquals("2 ч назад", processAgeLabel(now - 120 * 60_000, now))
        assertEquals("2 ч 5 мин назад", processAgeLabel(now - 125 * 60_000, now))
        // Часы компьютера убежали вперёд относительно времени старта из ОС.
        assertEquals("только что", processAgeLabel(now + 60_000, now))
        assertEquals("pid 42 · старт 5 мин назад", processSubLabel(entry(42, commandLine = null, startedAt = now - 5 * 60_000), now))
    }

    @Test
    fun sortingPutsMemoryEatersFirstAndUnknownLast() {
        val sorted = sortedProcesses(
            listOf(
                entry(1, memory = null),
                entry(2, memory = 100),
                entry(3, memory = 1_000_000_000),
                entry(4, memory = 500),
            ),
        )
        assertEquals(listOf(3L, 4L, 2L, 1L), sorted.map { it.pid })
    }
}
