package ru.arny.taskbridge.core.client

import ru.arny.taskbridge.core.client.sessions.sessionPollIntervalMillis
import ru.arny.taskbridge.core.client.sessions.shouldPoll
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Раздел 4.3 плана («расход батареи на Android» — запрос оператора 2026-10-14).
 *
 * Правило: телефон не опрашивает сервер, когда это не нужно. В фоне опрос нужен
 * только ради уведомлений о ходе работы; без работы он останавливается совсем, а в
 * режиме экономии энергии интервалы удлиняются.
 */
class SessionPollIntervalTest {
    @Test
    fun `a visible screen polls on the working cadence`() {
        assertEquals(5_000L, sessionPollIntervalMillis(active = true, inForeground = true))
        assertEquals(30_000L, sessionPollIntervalMillis(active = false, inForeground = true))
    }

    @Test
    fun `a visible SSE replaces the fast duplicate poll`() {
        assertEquals(
            30_000L,
            sessionPollIntervalMillis(active = true, inForeground = true, activeCoveredByStream = true),
            "детальный статус уже приходит по SSE; список остаётся редким контрольным снимком",
        )
        assertEquals(
            5_000L,
            sessionPollIntervalMillis(active = true, inForeground = true, activeCoveredByStream = false),
            "другая активная сессия требует быстрых уведомлений",
        )
    }

    @Test
    fun `in the background without work the poll stops completely`() {
        val interval = sessionPollIntervalMillis(active = false, inForeground = false)
        assertEquals(0L, interval, "иначе телефон каждые 30 с ходит в сеть без причины")
        assertFalse(shouldPoll(interval), "0 — опрос приостановлен до возврата в foreground")
    }

    @Test
    fun `in the background with work the poll stays, and slows down on power save`() {
        val normal = sessionPollIntervalMillis(active = true, inForeground = false)
        assertEquals(5_000L, normal, "идёт работа — оператор ждёт уведомление о её конце")
        assertTrue(shouldPoll(normal))
        val saving = sessionPollIntervalMillis(active = true, inForeground = false, powerSave = true)
        assertEquals(30_000L, saving, "в экономии энергии уведомление может подождать")
        assertEquals(
            5_000L,
            sessionPollIntervalMillis(
                active = true,
                inForeground = false,
                activeCoveredByStream = true,
            ),
            "в фоне SSE закрыт, поэтому флаг покрытия не должен останавливать уведомления",
        )
    }

    @Test
    fun `a visible screen keeps its cadence even on power save`() {
        // Оператор смотрит на экран: статус нужен живым, экономия касается фона.
        assertEquals(5_000L, sessionPollIntervalMillis(active = true, inForeground = true, powerSave = true))
        assertEquals(30_000L, sessionPollIntervalMillis(active = false, inForeground = true, powerSave = true))
    }
}
