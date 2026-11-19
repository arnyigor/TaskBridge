package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.client.chat.AnswerUsage
import ru.arny.taskbridge.core.client.chat.ChatItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class ChatErrorTest {
    private val providerNotice = "Провайдер provider/claude не принял запрос: 502 " +
        "{\"type\":\"error\",\"error\":{\"type\":\"proxy_error\",\"message\":\"<urlopen error [WinError 10060] Попытка установить соединение была безуспешной\"}}. " +
        "Pi жив и повторит через 5 с — сессия не зависла."
    private val giveUp = "Провайдер x не принял запрос и повторять не будет: timeout."

    private fun answer(text: String = "Ответ", error: String? = null, active: Boolean = false) = ChatItem.Assistant(
        "answer", text, "", emptyList(), active = active, status = if (error == null) "DONE" else "FAILED", error = error,
        final = !active, at = null, endedAt = null, partial = false, superseded = false,
        stopReason = if (error == null) null else "error", variants = null,
    )

    @Test
    fun distinguishesAutomaticRetryFromFinalErrorAndOrdinaryNotes() {
        assertTrue(isProviderErrorNotice(providerNotice))
        assertTrue(isProviderRetryNotice(providerNotice))
        assertTrue(isProviderErrorNotice(giveUp))
        assertFalse(isProviderRetryNotice(giveUp))
        assertFalse(isProviderErrorNotice("Контекст сжат:\nСводка"))
    }

    @Test
    fun groupsConsecutiveNoticesWithoutLosingDiagnosticsOrOriginalIds() {
        val notes = listOf(ChatItem.Note("n1", providerNotice), ChatItem.Note("n2", providerNotice + " "))
        val timeline = errorTimeline(notes + answer())
        assertEquals(listOf("n1", "answer"), timeline.items.map { it.id })
        val group = timeline.groups.getValue("n1")
        assertEquals(notes, group.notes)
        assertEquals(notes.joinToString("\n\n") { it.text }, group.raw)
        assertTrue(group.retrying)
        assertTrue(group.recovered)
        // Search and selection must retain the individual IDs and original list indices.
        assertEquals(notes + answer(), errorTimeline(notes + answer(), groupNotices = false).items)
    }

    @Test
    fun doesNotGroupAcrossMessagesAndDoesNotMarkFailedOrActiveAnswerAsRecovered() {
        val notice = ChatItem.Note("n1", providerNotice)
        val second = ChatItem.Note("n2", giveUp)
        val ordinary = ChatItem.Note("ordinary", "Контекст сжат")
        assertEquals(3, errorTimeline(listOf(notice, ordinary, second)).items.size)
        val stopped = errorTimeline(listOf(notice, second, answer(error = "timeout"))).groups.getValue("n1")
        assertFalse(stopped.retrying)
        assertFalse(stopped.recovered)
        assertFalse(errorTimeline(listOf(notice, answer(active = true))).groups.getValue("n1").recovered)
        assertTrue(errorTimeline(listOf(answer(), notice)).groups.getValue("n1").recovered)
        val user = ChatItem.User("new-turn", "Новый вопрос", emptyList(), null, false, null, null, null)
        assertFalse(errorTimeline(listOf(answer(), user, notice)).groups.getValue("n1").recovered)
    }

    @Test
    fun statusOccupiesOneTouchTargetRowAndRetryIsAvailableWithoutOpeningDetails() = runComposeUiTest {
        var retries = 0
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) {
                    ChatErrorStatus("timeout", {}, Modifier.testTag("status"), onRetry = { retries++ })
                }
            }
        }
        onNodeWithTag("status").assertHeightIsEqualTo(48.dp)
        onNodeWithText("timeout").assertDoesNotExist()
        onNodeWithText("Подробнее").assertHeightIsAtLeast(48.dp)
        onNodeWithContentDescription("Повторить запрос").performClick()
        assertEquals(1, retries)
    }

    @Test
    fun phoneNoticeOpensSeparatePanelAndCopiesOriginal() = runComposeUiTest {
        var copied = ""
        setContent {
            MaterialTheme {
                CompositionLocalProvider(LocalDensity provides Density(1f, 1.5f)) {
                    Box(Modifier.width(320.dp).verticalScroll(rememberScrollState())) {
                        NoteRow(ChatItem.Note("notice", providerNotice), onCopy = { copied = providerNotice })
                    }
                }
            }
        }
        onNodeWithText("Сбой провайдера · автоповтор").assertIsDisplayed()
        onNodeWithText(providerNotice).assertDoesNotExist()
        onNodeWithText("Подробнее").performClick()
        onNodeWithText(providerNotice).assertIsDisplayed()
        onNodeWithText("Копировать ошибку").performClick()
        assertEquals(providerNotice, copied)
        onNodeWithText("Закрыть").performClick()
        onNodeWithText(providerNotice).assertDoesNotExist()
        onNodeWithText("Подробнее").assertIsDisplayed()
    }

    @Test
    fun anEmptyFailedAnswerShowsOnlyTheErrorRowWithoutAFrame() = runComposeUiTest {
        // Регресс 2026-11-19: после остановки/срыва хода без вывода оставался
        // пустой каркас — чип «Использование», мета «время · Ошибка» и кнопки
        // под ним. Для хода без текста, размышлений и инструментов должен
        // остаться только строка ошибки.
        val details = UsageDetails(
            text = "Использование 4 с",
            usage = AnswerUsage(hit = 0, miss = 0, out = 0, cacheWrite = 0),
            metrics = null,
            modelId = "",
            local = false,
            peak = false,
            multiplier = 1.0,
            cost = null,
        )
        setContent {
            MaterialTheme {
                Box(Modifier.width(320.dp)) {
                    AssistantMessage(
                        item = answer(text = "", error = "Pi снова молчит 120 с — ход остановлен."),
                        time = "20:20 · 4 с · Ошибка",
                        actions = MessageActions(copy = {}, regenerate = {}),
                        onCopyText = {}, loadToolOutput = { error("unused") }, onOpenPath = {},
                        onSelectVariant = {}, onOpenFile = { _, _ -> }, loadFile = { error("unused") },
                        loadWorkspaceFile = { error("unused") },
                        usageDetails = details,
                    )
                }
            }
        }
        onNodeWithText("Не удалось получить ответ").assertIsDisplayed()
        onNodeWithText("Использование 4 с").assertDoesNotExist()
        onNodeWithText("20:20 · 4 с · Ошибка").assertDoesNotExist()
    }

    @Test
    fun duplicateErrorTextIsHiddenUntilPanelOpensAndShownOnlyOnce() = runComposeUiTest {
        var retries = 0
        val raw = "Request timed out"
        setContent {
            MaterialTheme {
                Box(Modifier.width(320.dp)) {
                    AssistantMessage(
                        item = answer(text = raw, error = raw),
                        time = "",
                        actions = MessageActions(copy = {}, regenerate = { retries++ }),
                        onCopyText = {}, loadToolOutput = { error("unused") }, onOpenPath = {},
                        onSelectVariant = {}, onOpenFile = { _, _ -> }, loadFile = { error("unused") },
                        loadWorkspaceFile = { error("unused") },
                    )
                }
            }
        }
        onNodeWithText("Не удалось получить ответ").assertIsDisplayed()
        onNodeWithText(raw).assertDoesNotExist()
        onNodeWithText("Подробнее").performClick()
        onAllNodesWithText(raw).assertCountEquals(1)
        onNodeWithText(raw).assertIsDisplayed()
        onNodeWithText("Повторить запрос").performClick()
        assertEquals(1, retries)
        onNodeWithText(raw).assertDoesNotExist()
    }

    @Test
    fun groupedNoticeShowsCountAndAllOriginalErrorsInDetails() = runComposeUiTest {
        val second = providerNotice.replace("5 с", "15 с")
        val group = errorTimeline(listOf(ChatItem.Note("n1", providerNotice), ChatItem.Note("n2", second)))
            .groups.getValue("n1")
        setContent {
            MaterialTheme {
                Box(Modifier.width(320.dp)) {
                    NoteRow(
                        ChatItem.Note("n1", group.raw), {}, noticeCount = group.notes.size,
                        noticeRetrying = group.retrying, noticeRecovered = group.recovered,
                    )
                }
            }
        }
        onNodeWithText("Сбой провайдера · автоповтор (×2)").assertIsDisplayed()
        onNodeWithText(group.raw).assertDoesNotExist()
        onNodeWithText("Подробнее").performClick()
        onNodeWithText(group.raw).assertIsDisplayed()
    }

    @Test
    fun activeErrorDoesNotOfferManualRetry() = runComposeUiTest {
        setContent {
            MaterialTheme {
                ChatErrorStatus("timeout", {}, active = true, onRetry = { error("Must not retry") })
            }
        }
        onNodeWithContentDescription("Повторить запрос").assertDoesNotExist()
        onNodeWithText("Подробнее").performClick()
        onNodeWithText("Повторить запрос").assertDoesNotExist()
    }

    @Test
    fun longSingleLineNotesFitPhoneWidthWithoutPillClipping() = runComposeUiTest {
        val raw = "Обычное длинное уведомление ".repeat(8)
        setContent {
            MaterialTheme {
                Box(Modifier.width(320.dp)) { NoteRow(ChatItem.Note("long", raw), onCopy = {}) }
            }
        }
        onNodeWithText(raw).assertIsDisplayed()
        val bounds = onNodeWithText(raw).fetchSemanticsNode().boundsInRoot
        assertTrue(bounds.width > 0f)
        assertTrue(bounds.height > 48f)
    }
}
