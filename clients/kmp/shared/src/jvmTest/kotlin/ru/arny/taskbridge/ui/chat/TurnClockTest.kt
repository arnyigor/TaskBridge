package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Счётчик хода в шапке чата («0:34 · TTFT … · PP … · TG …»).
 *
 * Баг: счётчик шёл вечно. Статус задачи приходил в `DeliveryDiagnostics` через
 * `snapshotFlow { state.task?.status }` внутри `LaunchedEffect(state.taskId)`, а
 * `state` — значение из `collectAsState()`, то есть обычный data-класс, а не
 * наблюдаемое состояние. Поток читал обычное поле, отдавал первый статус и
 * больше не срабатывал: начатый на RUNNING счётчик продолжал идти и после
 * SUCCEEDED, когда в задаче уже ничего не выполнялось. Решение вынесено в
 * `turnStartedAt`, чтобы это можно было проверить без Compose.
 */
class TurnClockTest {
    private val userAt = "2026-09-30T06:40:54.467Z"
    private val userMillis = 1_790_750_454_467L

    @Test
    fun aRunningTurnStartsTheClockFromTheLastUserMessage() {
        assertEquals(userMillis, turnStartedAt("RUNNING", null, userAt))
        assertEquals(userMillis, turnStartedAt("VERIFYING", null, userAt))
    }

    @Test
    fun aFinishedTaskStopsTheClock() {
        // Именно то, что видел оператор: SUCCEEDED, команд больше не выполняется,
        // а время всё шло — потому что этот переход не доезжал до счётчика.
        assertNull(turnStartedAt("SUCCEEDED", userMillis, userAt))
        assertNull(turnStartedAt("CANCELLED", userMillis, userAt))
        assertNull(turnStartedAt("FAILED", userMillis, userAt))
    }

    @Test
    fun theClockIsKeptWhileTheTurnStaysActive() {
        // RUNNING → VERIFYING: тот же ход, счёт не начинается заново.
        assertEquals(userMillis, turnStartedAt("VERIFYING", userMillis, userAt))
    }

    @Test
    fun theNextTurnStartsTheClockAgain() {
        val nextUserAt = "2026-09-30T07:10:00.000Z"
        assertNull(turnStartedAt("SUCCEEDED", userMillis, userAt))
        assertEquals(1_790_752_200_000L, turnStartedAt("RUNNING", null, nextUserAt))
    }

    @Test
    fun aTurnWithoutAUserMessageHasNoClock() {
        assertNull(turnStartedAt("RUNNING", null, null))
        // Задача ещё не пришла (state.task == null) — счётчика нет.
        assertNull(turnStartedAt(null, null, userAt))
    }
}
