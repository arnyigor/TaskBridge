package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Доступность STOP.
 *
 * Оператор: «кнопка отмены — это гарантия того, что можно остановить процесс;
 * иначе просто зависает и ничего не можешь сделать». Поэтому CANCELLING входит
 * в набор: если сама остановка залипла, кнопка обязана остаться и повторить
 * запрос (2026-10-14).
 */
class CanStopTest {
    @Test
    fun `every working status can be stopped, including a stuck stop`() {
        for (status in listOf("QUEUED", "PREPARING", "PREFLIGHT", "RUNNING", "WAITING_USER", "VERIFYING", "CANCELLING")) {
            assertEquals(true, canStop(status), "STOP должен быть доступен в статусе $status")
        }
    }

    @Test
    fun `finished sessions have nothing to stop`() {
        for (status in listOf("SUCCEEDED", "FAILED", "CANCELLED", null, "", "ЧТО-ТО_НОВОЕ")) {
            assertEquals(false, canStop(status), "нет смысла останавливать $status")
        }
    }

    @Test
    fun `a stuck send is stoppable even in a finished session`() {
        // Оператор 2026-10-14: «сообщение не отправляется, и я не могу никак
        // перезапустить». Сессия уже SUCCEEDED/FAILED, но отправка висит —
        // это независимый повод: STOP обязан отпустить очередь.
        assertEquals(true, canStop("FAILED", pendingSends = 1), "зависшая отправка делает STOP доступным")
        assertEquals(true, canStop("SUCCEEDED", pendingSends = 3))
        assertEquals(false, canStop("SUCCEEDED", pendingSends = 0), "без очереди и без работы останавливать нечего")
    }
}
