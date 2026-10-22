package ru.arny.taskbridge.ui.notice

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.ui.theme.TaskBridgeTheme
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Жалоба оператора 2026-10-22: «не переходит при клике, приложение было свёрнуто».
 * Системный тост на Windows клик не доставляет, поэтому уведомление обязано быть
 * своим окном — и клик по карточке обязан называть сессию, иначе возвращать нечего.
 */
class SessionNoticeCardTest {
    private val alert = SessionAlert(
        "task-7", SessionAlert.Kind.WAITING_USER, "Починить импорт", "Жду решения", "TaskBridge",
    )

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun clickingTheCardOpensItsSession() = runComposeUiTest {
        var opened: String? = null
        setContent { TaskBridgeTheme("dark") { SessionNoticeCard(alert, onOpen = { opened = it }) } }
        onNodeWithTag(SESSION_NOTICE_TAG).performClick()
        assertEquals("task-7", opened)
    }

    @Test
    fun aNewerAlertReplacesTheSameSessionAndKeepsTheOthers() {
        val first = alert
        val other = alert.copy(taskId = "task-8")
        val newest = alert.copy(kind = SessionAlert.Kind.FINISHED)
        val after = noticesAfter(listOf(first, other), newest)
        assertEquals(listOf("task-8", "task-7"), after.map { it.taskId })
        assertEquals(SessionAlert.Kind.FINISHED, after.last().kind)
    }

    @Test
    fun onlyTheLastNoticesAreKept() {
        val many = (1..SESSION_NOTICE_LIMIT + 2).map { alert.copy(taskId = "task-$it") }
        val after = many.fold(emptyList<SessionAlert>()) { shown, next -> noticesAfter(shown, next) }
        assertEquals(SESSION_NOTICE_LIMIT, after.size)
        assertEquals("task-${SESSION_NOTICE_LIMIT + 2}", after.last().taskId)
    }

    /**
     * Окно не может быть больше карточки: прозрачное поле вокруг неё перехватывает
     * клики по чужим окнам. Значит высота считается по содержимому, а не на глазок.
     */
    @Test
    fun theCardIsAsTallAsItsText() {
        val short = noticeHeight("Проект · Готово · Сессия", "готово")
        val long = noticeHeight("Проект · Готово · Сессия", "готово ".repeat(40))
        assertTrue(long.value > short.value)
        assertEquals(1, noticeTextLines("готово"))
        // Дальше четвёртой строки текст режется многоточием, и карточка не растёт.
        assertEquals(4, noticeTextLines("x".repeat(500)))
    }
}
