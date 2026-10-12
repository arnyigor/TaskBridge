package ru.arny.taskbridge.ui.common

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Instant

/**
 * Диагностика сессии: длительность и возраст событий.
 *
 * Раньше в панели стояли сырые ISO-моменты («2026-10-09T06:53:56.945250400Z») —
 * по ним не видно ни возраста события, ни длительности сессии. Здесь проверяются
 * единицы и границы: минуты/часы/сутки не должны путаться местами, а возраст
 * считается от момента, а не «наоборот» (часы клиента и сервера расходятся на
 * секунды по LAN, поэтому будущий момент — это «только что», а не «-3 с назад»).
 */
class FormatDurationTest {
    private val t0 = Instant.parse("2026-10-09T06:12:20.032Z").toEpochMilliseconds()
    private val iso = Instant.fromEpochMilliseconds(t0).toString()

    @Test
    fun durationsUseTheLargestUsefulUnits() {
        assertEquals("0 с", humanDuration(0))
        assertEquals("34 с", humanDuration(34_000))
        assertEquals("1 мин", humanDuration(60_000))
        assertEquals("1 мин 5 с", humanDuration(65_000))
        assertEquals("4 ч 12 мин", humanDuration(4 * 3_600_000L + 12 * 60_000))
        assertEquals("3 дн. 5 ч", humanDuration(3 * 86_400_000L + 5 * 3_600_000))
        // Отрицательная длительность (часы разошлись) не должна печататься как «-5 с».
        assertEquals("0 с", humanDuration(-5_000))
    }

    @Test
    fun ageIsCountedFromTheMoment() {
        val absolute = { millis: Long -> "ABS ${Instant.fromEpochMilliseconds(millis)}" }
        assertEquals("только что", sinceLabel(iso, t0 + 1_000, absolute))
        assertEquals("12 с назад", sinceLabel(iso, t0 + 12_000, absolute))
        assertEquals("5 мин назад", sinceLabel(iso, t0 + 5 * 60_000, absolute))
        assertEquals("2 ч назад", sinceLabel(iso, t0 + 2 * 3_600_000, absolute))
        // Старше суток — абсолютный момент, а не «30 ч назад».
        assertEquals("ABS $iso", sinceLabel(iso, t0 + 30 * 3_600_000, absolute))
    }

    @Test
    fun aMissingOrUnparsableMomentHasNoAge() {
        assertNull(sinceLabel(null, t0, { "ABS" }))
        assertNull(sinceLabel("не дата", t0, { "ABS" }))
        // Часы клиента отстали от сервера: будущее не превращается в «-40 с назад».
        assertEquals("только что", sinceLabel(iso, t0 - 40_000, { "ABS" }))
    }
}
