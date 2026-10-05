package ru.arny.taskbridge.ui.sessions

import ru.arny.taskbridge.core.api.NativeSession
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Поиск в списке сессий папки (диалог «Новая сессия» → «Продолжить сессию Pi»).
 * Сессия ищется по имени, id и последним репликам; слова — независимо, как в
 * поиске моделей: «импорт тест» должно находить сессию, где они в разных местах.
 */
class ImportSessionFilterTest {
    private val sessions = listOf(
        NativeSession(key = "a".repeat(64), id = "01a0ccca-c4f8", name = "2026-09-23T05-43-55-897Z_01a0ccca", preview = "Правим импорт сессий в TaskBridge"),
        NativeSession(key = "b".repeat(64), id = "01a0c8fa-6eea", name = "terminal-session", preview = "Собираем локальные модели"),
        NativeSession(key = "c".repeat(64), id = "01a0d000-1111", name = null, preview = null),
    )

    @Test
    fun emptyQueryKeepsEverySessionInOrder() {
        assertEquals(sessions, filterNativeSessions(sessions, ""))
        assertEquals(sessions, filterNativeSessions(sessions, "   "))
    }

    @Test
    fun matchesNameIdAndLastMessages() {
        assertEquals(listOf("terminal-session"), filterNativeSessions(sessions, "terminal").map { it.displayName })
        assertEquals(listOf("01a0d000-1111"), filterNativeSessions(sessions, "1111").map { it.displayName })
        assertEquals(1, filterNativeSessions(sessions, "локальные").size)
    }

    @Test
    fun wordsAreMatchedIndependentlyOfWhereTheyAre() {
        assertEquals(1, filterNativeSessions(sessions, "импорт сессий").size)
        // «импорт» есть в первой сессии, «моделей» — только во второй: вместе не
        // совпадает ни одна (слова не сшиваются в одну подстроку).
        assertEquals(0, filterNativeSessions(sessions, "импорт моделей").size)
        assertEquals(1, filterNativeSessions(sessions, "правим импорт").size)
    }

    @Test
    fun queryIsCaseInsensitiveAndTrimmed() {
        assertEquals(1, filterNativeSessions(sessions, "  TASKBRIDGE  ").size)
        assertEquals(0, filterNativeSessions(sessions, "ничего такого").size)
    }

    @Test
    fun alreadyImportedSessionsAreExcludedFromTheListAndFromTheSearch() {
        val open = sessions[0]
        val imported = sessions[1].copy(existingTaskId = "5b726a36ff8d")
        val all = listOf(open, imported, sessions[2])

        assertEquals(listOf(open, sessions[2]), importableNativeSessions(all))
        // Импортированную не находит и поиск — она исключена целиком, а не спрятана
        // за фильтром списка.
        assertEquals(emptyList(), filterNativeSessions(importableNativeSessions(all), "локальные"))
        assertEquals(emptyList(), importableNativeSessions(listOf(imported)))
    }
}
