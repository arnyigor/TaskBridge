package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.SessionStorage
import kotlin.test.Test
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Предупреждение «сессия занимает много места». Порог считает сервер
 * (`storage.warnSessionMb`), поэтому здесь проверяется ровно то, что решает клиент:
 * молчать ниже порога и называть цифру и следствие — выше него.
 */
class SessionStorageWarningTest {

    @Test
    fun nothingIsSaidWhenTheServerDoesNotWarn() {
        assertNull(sessionStorageWarning(null), "запрос не удался — молчим, чат важнее")
        assertNull(sessionStorageWarning(SessionStorage(bytes = 900_000_000, files = 12, warn = false)))
    }

    @Test
    fun theWarningNamesTheSizeAndTheWayOut() {
        val text = sessionStorageWarning(SessionStorage(bytes = 3_700_000_000, files = 40, warn = true)) ?: error("предупреждения нет")
        assertTrue(text.contains("ГБ"), text)
        assertTrue(text.contains("удалением сессии"), text)
        assertTrue(!text.contains("не менее"), "полное измерение не должно звучать как оценка: $text")
    }

    @Test
    fun aPartialMeasurementSaysSoInsteadOfUnderstating() {
        val text = sessionStorageWarning(SessionStorage(bytes = 2_000_000_000, warn = true, partial = true)) ?: error("предупреждения нет")
        assertTrue(text.contains("не менее"), text)
    }
}
