package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.FileRef
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.PendingPrompt
import ru.arny.taskbridge.core.api.RuntimeInfo
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatSnapshot
import ru.arny.taskbridge.core.client.session.ChatSessionState
import ru.arny.taskbridge.core.client.session.LinkState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Instant

/**
 * Текст панели «Диагностика».
 *
 * Оператор видел там сырые ISO-моменты («Последний контакт:
 * 2026-10-09T06:53:56.945250400Z»), без начала и длительности сессии, без текста
 * текущего сообщения и со строкой «Событие № 21786», по которой нельзя понять,
 * что это за число. Проверяются именно те строки, по которым он не мог ничего
 * решить.
 */
class DiagnosticsDetailsTest {
    private val start = 1_791_000_000_000L // 2026-10-03T04:00:00Z
    private val iso = { millis: Long -> Instant.fromEpochMilliseconds(millis).toString() }

    private fun state(): ChatSessionState = ChatSessionState(
        taskId = "fd258df3d795",
        task = Task(
            id = "fd258df3d795",
            prompt = "Улучши детали сессии\nвторая строка промпта",
            status = "RUNNING",
            createdAt = iso(start),
            updatedAt = iso(start),
            current = "Думает",
            model = ModelRef(provider = "deepseek", id = "deepseek-flash"),
            runtime = RuntimeInfo(state = "streaming", activity = "generating"),
            pendingPrompts = listOf(PendingPrompt(id = "p1", text = "ещё вопрос")),
        ),
        chat = ChatSnapshot(
            cursor = 21_786,
            items = listOf(
                ChatItem.User(
                    id = "user-1",
                    text = "Улучши детали сессии\nвторая строка промпта",
                    files = emptyList<FileRef>(),
                    at = iso(start),
                    pending = false,
                    clientId = null,
                    mode = null,
                    turnId = "user-1",
                ),
            ),
        ),
        link = LinkState.Live,
        lastContactAt = iso(start + 12_000),
        lastEventAt = iso(start + 2_000),
        lastEventType = "VERIFICATION",
    )

    private fun render(nowOffsetMs: Long = 4 * 3_600_000L + 12 * 60_000) =
        buildDiagnosticsDetails(state(), info = null, externalMetrics = null, now = start + nowOffsetMs) { "МОМЕНТ" }

    @Test
    fun theSessionShowsStartAndDuration() {
        val details = render()
        assertTrue(details.lineSequence().any { it == "Начало сессии: МОМЕНТ · идёт 4 ч 12 мин" }, details)
        assertTrue(details.startsWith("Сессия: fd258df3d795 · «Улучши детали сессии»"), details)
    }

    @Test
    fun aFinishedSessionShowsTheWholeDuration() {
        // Задача кончилась: счёт идёт до updatedAt, а не до «сейчас».
        val finished = state().let { it.copy(task = it.task?.copy(status = "SUCCEEDED", updatedAt = iso(start + 90_000))) }
        val details = buildDiagnosticsDetails(finished, info = null, externalMetrics = null, now = start + 10 * 3_600_000L) { "МОМЕНТ" }
        assertTrue(details.lineSequence().any { it == "Начало сессии: МОМЕНТ · длительность 1 мин 30 с" }, details)
    }

    @Test
    fun agesAreInSecondsAndWords() {
        val details = render()
        assertTrue(details.lineSequence().any { it == "Последний контакт: 4 ч назад" }, details)
        assertTrue(details.lineSequence().any { it == "Последнее событие: проверка результата · 4 ч назад" }, details)
    }

    @Test
    fun theCurrentMessageAndTheQueueAreVisible() {
        val details = render()
        assertTrue(details.lineSequence().any { it == "Текущее сообщение: «Улучши детали сессии» · отправлено 4 ч назад" }, details)
        assertTrue(details.lineSequence().any { it == "Ждут очереди (1): «ещё вопрос»" }, details)
    }

    @Test
    fun theEventCounterSaysWhatItCounts() {
        val details = render()
        assertTrue(
            details.lineSequence().any { it == "Событий получено от сервера: 21786 · сообщений в очереди: 1" },
            details,
        )
        assertEquals(0, details.lineSequence().count { it.startsWith("Событие №") }, details)
    }
}
