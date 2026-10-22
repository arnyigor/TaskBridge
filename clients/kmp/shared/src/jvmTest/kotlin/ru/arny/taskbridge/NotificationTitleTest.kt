package ru.arny.taskbridge

import ru.arny.taskbridge.core.client.sessions.SessionAlert
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Верх уведомления — одна строка: проект идёт первым, иначе по сессии не видно,
 * чья она, а на телефоне это единственное, что видно до раскрытия.
 */
class NotificationTitleTest {
    @Test
    fun projectComesFirst() {
        val alert = SessionAlert("t1", SessionAlert.Kind.WAITING_USER, "Починить импорт", "Жду решения", "TaskBridge")
        assertEquals("TaskBridge · Ждёт ответа · Починить импорт", alertTitle(alert))
    }

    @Test
    fun withoutAProjectTheTitleKeepsItsOldShape() {
        val alert = SessionAlert("t1", SessionAlert.Kind.FINISHED, "Починить импорт", "Готово")
        assertEquals("Готово · Починить импорт", alertTitle(alert))
    }
}
