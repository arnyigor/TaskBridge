package ru.arny.taskbridge

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Инцидент 2026-10-14: вход в приложение показывал offline до ручного
// «выйти и войти» в настройках. Причина — неудачная первая попытка связи
// оставляла online=false навсегда: после неё ничего не пробовало снова.
// Теперь ждём и пробуем, и именно этот расчёт пауз проверяется здесь.
class OfflineRetryTest {

    @Test
    fun firstRetryIsSoonSoAColdStartHealsItself() {
        assertEquals(OFFLINE_RETRY_MIN_MS, offlineRetryDelayMs(0))
        assertEquals(OFFLINE_RETRY_MIN_MS * 2, offlineRetryDelayMs(1))
    }

    @Test
    fun attemptsBackOffButNeverStop() {
        val delays = (0..8).map { offlineRetryDelayMs(it) }
        assertTrue(delays.zipWithNext().all { (left, right) -> right >= left }, "паузы не уменьшаются: $delays")
        assertTrue(delays.all { it in OFFLINE_RETRY_MIN_MS..OFFLINE_RETRY_MAX_MS }, "в границах: $delays")
        assertEquals(OFFLINE_RETRY_MAX_MS, offlineRetryDelayMs(8), "потолок держит частоту опроса")
    }

    @Test
    fun anAbsurdAttemptCountStillReturnsABoundValue() {
        // Счётчик не должен переполниться в отрицательную паузу (delay(-1) бросает).
        assertTrue(offlineRetryDelayMs(Int.MAX_VALUE) in OFFLINE_RETRY_MIN_MS..OFFLINE_RETRY_MAX_MS)
    }
}
