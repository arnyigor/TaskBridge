package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatSnapshot
import ru.arny.taskbridge.core.client.chat.ToolCall
import ru.arny.taskbridge.core.client.chat.ToolState
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.session.ChatSessionState
import ru.arny.taskbridge.core.client.session.LinkState
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Поиск на настоящей ленте: строка поиска считает совпадения, а переход доводит
 * найденное до экрана — в том числе когда оно утонуло в размышлениях и строках
 * инструментов (случай с экрана оператора 2026-10-30: «2 из 2», а подсветки нет).
 *
 * Подсветка и прокрутка включаются состоянием [ChatSearchHighlight], как в ChatScreen:
 * щёлкнуть по строке поиска в тесте нельзя, а проводка «запрос → подсветка → довод
 * до экрана» — именно то, что проверяется.
 */
@OptIn(ExperimentalTestApi::class)
class ChatSearchUiTest {

    private class MemorySettings : KeyValueStore {
        private val values = ConcurrentHashMap<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    private fun setup(): Triple<AppGraph, ChatSession, List<ChatItem>> {
        val platform = DesktopPlatformServices(store = MemorySettings())
        val graph = AppGraph(platform)
        val http = HttpClient(MockEngine { respond("{}", HttpStatusCode.OK) })
        val api = TaskBridgeApi(http, SimpleConnection("http://pc:8787", clientId = "probe"))
        val session = ChatSession(api, "task-1", CoroutineScope(SupervisorJob() + Dispatchers.Default), { "cmd-1" }, { "2026-10-20T00:00:00Z" })
        val body = "НУЖНОЕ-СЛОВО\n\n" + "Строка отчёта с подробностями.\n\n".repeat(120) + "Конец отчёта"
        val items = listOf(
            ChatItem.User("u1", "Отчёт в чате, где-то там «нужное-слово»", emptyList(), null, pending = false, clientId = null, mode = "prompt", turnId = "user-1"),
            ChatItem.Assistant(
                "a1", body, "", emptyList(), active = false, status = "SUCCEEDED", error = null, final = true,
                at = null, endedAt = null, partial = false, superseded = false, stopReason = null, variants = null,
            ),
        )
        return Triple(graph, session, items)
    }

    @Test
    fun barCountsMatchesAndStepsThroughThem() = runComposeUiTest {
        var query by mutableStateOf("")
        var current by mutableStateOf(0)
        setContent {
            MaterialTheme {
                ChatSearchBar(
                    query = query,
                    onQuery = { query = it; current = 0 },
                    matches = 3,
                    current = current,
                    partialHistory = false,
                    onStep = { current = stepSearchIndex(current, it, 3) },
                    onClose = {},
                )
            }
        }
        onNode(hasSetTextAction()).performTextInput("иголка")
        waitForIdle()
        onNodeWithText("1 из 3").assertExists()
        onNodeWithContentDescription("Следующее совпадение").performClick()
        waitForIdle()
        onNodeWithText("2 из 3").assertExists()
        onNodeWithContentDescription("Предыдущее совпадение").performClick()
        onNodeWithContentDescription("Предыдущее совпадение").performClick()
        waitForIdle()
        // Переход по кругу: назад с первого совпадения — на последнее.
        onNodeWithText("3 из 3").assertExists()
    }

    /**
     * Жалоба 2026-10-30: «нет перехода между найденными по стрелкам». Шаг по
     * совпадениям должен менять то, что видно: каждое найденное сообщение — отдельная
     * остановка, и в каждом на экране оказывается строка с находкой.
     */
    @Test
    fun steppingWalksEveryMatchedMessageOnTheRealFeed() = runComposeUiTest {
        val (graph, session, _) = setup()
        val filler = "Строка отчёта с подробностями.\n\n".repeat(40)
        val items = listOf(
            ChatItem.User("u1", "иголка в первом вопросе", emptyList(), null, pending = false, clientId = null, mode = "prompt", turnId = "user-1"),
            ChatItem.Assistant(
                "a1", filler + "иголка в конце ответа", "", emptyList(), active = false, status = "SUCCEEDED", error = null, final = true,
                at = null, endedAt = null, partial = false, superseded = false, stopReason = null, variants = null,
            ),
            ChatItem.User("u2", "иголка во втором вопросе", emptyList(), null, pending = false, clientId = null, mode = "prompt", turnId = "user-2"),
        )
        val listState = LazyListState()
        var search by mutableStateOf(ChatSearchHighlight())
        setContent {
            MaterialTheme {
                Box(Modifier.size(360.dp, 300.dp)) {
                    MessageList(
                        graph = graph,
                        session = session,
                        state = ChatSessionState(
                            taskId = "task-1",
                            chat = ChatSnapshot(items = items),
                            loading = false,
                            link = LinkState.Live,
                            reachedStart = true,
                        ),
                        listState = listState,
                        following = false,
                        historyLocked = false,
                        onDialog = {},
                        onViewFile = {},
                        onCopyMessage = {},
                        search = search,
                    )
                }
            }
        }
        waitForIdle()

        fun textVisible(line: String) = onAllNodesWithText(line, substring = true, useUnmergedTree = true)
            .fetchSemanticsNodes().any { it.boundsInRoot.height > 0f }
        val hits = chatSearchHits(items, "иголка")
        assertEquals(3, hits.size, "по находке на каждое сообщение")
        val markers = listOf("иголка в первом вопросе", "иголка в конце ответа", "иголка во втором вопросе")
        val stops = ArrayList<Pair<Int, Int>>()
        for ((n, hit) in hits.withIndex()) {
            // Как в ChatScreen: сначала новый шаг поиска, затем прокрутка к сообщению.
            runOnIdle { search = ChatSearchHighlight(query = "иголка", activeItemId = hit.itemId, step = n) }
            waitForIdle()
            revealSearchHit(listState, searchTarget(items, hit)!!)
            waitForIdle()
            stops += listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset
            assertTrue(textVisible(markers[n]), "шаг ${n + 1}: «${markers[n]}» не попало в видимую часть ленты")
        }
        assertEquals(3, stops.distinct().size, "два шага подряд привели в одну и ту же точку ленты: $stops")
    }

    /**
     * Случай с экрана оператора: в сообщении много размышлений и строк инструментов,
     * а находка — в середине текста. Раньше лента вставала по доле текста и
     * останавливалась в пустом месте; теперь до находки доводит сам блок текста.
     */
    @Test
    fun theMatchIsBroughtIntoViewInsideAMessageFullOfToolsAndThinking() = runComposeUiTest {
        val (graph, session, _) = setup()
        val tools = (1..8).map { ToolCall("t$it", "bash", "команда $it", ToolState.DONE, path = null) }
        val text = "Строка отчёта.\n\n".repeat(40) + "НАЙДЕННАЯ-СТРОКА\n\n" + "Ещё строка отчёта.\n\n".repeat(40)
        val items = listOf(
            ChatItem.Assistant(
                "a1", text, "Размышления модели. ".repeat(200), tools, active = false, status = "SUCCEEDED", error = null, final = true,
                at = null, endedAt = null, partial = false, superseded = false, stopReason = null, variants = null,
            ),
        )
        val listState = LazyListState()
        var search by mutableStateOf(ChatSearchHighlight())
        setContent {
            MaterialTheme {
                Box(Modifier.size(360.dp, 300.dp)) {
                    MessageList(
                        graph = graph,
                        session = session,
                        state = ChatSessionState(
                            taskId = "task-1",
                            chat = ChatSnapshot(items = items),
                            loading = false,
                            link = LinkState.Live,
                            reachedStart = true,
                        ),
                        listState = listState,
                        following = false,
                        historyLocked = false,
                        onDialog = {},
                        onViewFile = {},
                        onCopyMessage = {},
                        search = search,
                    )
                }
            }
        }
        waitForIdle()
        fun visible(): Boolean = onAllNodesWithText("НАЙДЕННАЯ-СТРОКА", substring = true, useUnmergedTree = true)
            .fetchSemanticsNodes().any { it.boundsInRoot.height > 0f }
        assertTrue(!visible(), "предусловие: до поиска строка с находкой за пределами экрана")

        val hit = chatSearchHits(items, "найденная-строка").single()
        runOnIdle { search = ChatSearchHighlight(query = "найденная-строка", activeItemId = hit.itemId, step = 1) }
        waitForIdle()
        revealSearchHit(listState, searchTarget(items, hit)!!)
        waitForIdle()
        assertTrue(visible(), "переход не довёл до экрана строку с находкой")
    }

    /**
     * Находка в начале длинного ответа: без довода до блока лента показывает конец
     * ответа (у перевёрнутой ленты это низ экрана), и подсветки не видно.
     */
    @Test
    fun revealBringsTheMatchInsideATallAnswerIntoView() = runComposeUiTest {
        val (graph, session, items) = setup()
        val listState = LazyListState()
        var search by mutableStateOf(ChatSearchHighlight())
        setContent {
            MaterialTheme {
                Box(Modifier.size(360.dp, 300.dp)) {
                    MessageList(
                        graph = graph,
                        session = session,
                        state = ChatSessionState(
                            taskId = "task-1",
                            chat = ChatSnapshot(items = items),
                            loading = false,
                            link = LinkState.Live,
                            reachedStart = true,
                        ),
                        listState = listState,
                        following = false,
                        historyLocked = false,
                        onDialog = {},
                        onViewFile = {},
                        onCopyMessage = {},
                        search = search,
                    )
                }
            }
        }
        waitForIdle()
        fun matchVisible(): Boolean = onAllNodesWithText("НУЖНОЕ-СЛОВО", substring = true, useUnmergedTree = true)
            .fetchSemanticsNodes().any { it.boundsInRoot.height > 0f }
        assertTrue(!matchVisible(), "предусловие: до поиска совпадение за верхней границей экрана")

        // Переход ведёт к ответу (последняя находка — в нём).
        val hit = chatSearchHits(items, "нужное-слово").last()
        assertEquals("a1", hit.itemId)
        runOnIdle { search = ChatSearchHighlight(query = "нужное-слово", activeItemId = hit.itemId, step = 1) }
        waitForIdle()
        revealSearchHit(listState, searchTarget(items, hit)!!)
        waitForIdle()
        assertTrue(matchVisible(), "переход не довёл ленту до совпадения")
    }

    /**
     * Проводка подсветки: в ленте совпадение красится только там, где действующий
     * поиск дотягивается до сообщения через CompositionLocal, — это и проверяется
     * без сверки цветов.
     */
    @Test
    fun theActiveSearchPaintsTheMatchInTheRenderedText() = runComposeUiTest {
        var painted: androidx.compose.ui.text.AnnotatedString? = null
        setContent {
            MaterialTheme {
                androidx.compose.runtime.CompositionLocalProvider(
                    LocalChatSearch provides ChatSearchHighlight(query = "слово", activeItemId = "a1"),
                    LocalSearchItemId provides "a1",
                ) {
                    painted = searchHighlighted("важное слово")
                }
            }
        }
        waitForIdle()
        assertEquals(1, painted?.spanStyles?.size, "совпадение не подсвечено: ${painted?.spanStyles}")
        assertEquals(7 to 12, painted?.spanStyles?.single()?.let { it.start to it.end })
    }
}
