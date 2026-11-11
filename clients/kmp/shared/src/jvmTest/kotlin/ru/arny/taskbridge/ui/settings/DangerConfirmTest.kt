package ru.arny.taskbridge.ui.settings

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * Подтверждение выключения/перезагрузки компьютера: отсчёт, отмена и ошибка.
 *
 * Проверяется отдельно от диалога: окно диалога в десктопном тесте — отдельное
 * окно вне дерева семантики, а последствия здесь настоящие — команда на машину
 * и таймер, который нельзя «съесть» секундой теста.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DangerConfirmTest {

    @Test
    fun countsDownThenSendsExactlyOnce() = runTest {
        var sends = 0
        val confirm = DangerConfirm(seconds = 3, scope = this, send = { sends += 1 })

        confirm.start()
        assertEquals(3, confirm.left, "подтверждение начинается с полного отсчёта")
        assertEquals(0, sends, "сразу после подтверждения на компьютер ничего не уходит")

        advanceTimeBy(3_100)
        assertEquals(1, sends, "после отсчёта команда отправлена ровно один раз")
        assertNull(confirm.left)
        assertEquals(false, confirm.sending)
    }

    @Test
    fun cancelBeforeTheEndSendsNothing() = runTest {
        var sends = 0
        val confirm = DangerConfirm(seconds = 10, scope = this, send = { sends += 1 })

        confirm.start()
        advanceTimeBy(4_001) // четыре полные секунды: тик ровно на границе ещё не выполнен
        assertEquals(6, confirm.left, "отсчёт идёт по секунде")

        confirm.cancel()
        assertNull(confirm.left, "после отмены отсчёт сброшен")
        advanceTimeBy(10_000)
        assertEquals(0, sends, "отменённое выключение не отправляется")
    }

    @Test
    fun errorIsShownAndRetryClearsIt() = runTest {
        var attempts = 0
        val confirm = DangerConfirm(seconds = 1, scope = this, send = {
            attempts += 1
            if (attempts == 1) error("сервер не отвечает")
        })

        confirm.start()
        advanceTimeBy(1_500)
        assertEquals("сервер не отвечает", confirm.error)
        assertEquals(false, confirm.sending, "после ошибки можно попробовать снова")

        confirm.start()
        assertNull(confirm.error, "повторное подтверждение убирает старый текст ошибки")
        advanceTimeBy(1_500)
        assertEquals(2, attempts)
        assertNull(confirm.error, "вторая попытка прошла")
    }

    @Test
    fun secondConfirmationDoesNotStartTwoTimers() = runTest {
        var sends = 0
        val confirm = DangerConfirm(seconds = 2, scope = this, send = { sends += 1 })

        confirm.start()
        advanceTimeBy(1_000)
        confirm.start()
        assertNotNull(confirm.left)
        advanceTimeBy(10_000)
        assertEquals(1, sends, "двойное нажатие не отправляет две команды")
    }
}
