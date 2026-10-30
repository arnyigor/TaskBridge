package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
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
 * Прокрутка настоящего [MessageList] (production-лента с настоящими ChatItem и
 * Markdown): приход дельты и нового элемента не имеет права сдвинуть вид, пока
 * оператор читает выше низа, и обязан держать низ, когда он у низа.
 */
@OptIn(ExperimentalTestApi::class)
class MessageListScrollTest {

    private fun message(i: Int, tail: String = "") = if (i % 2 == 1) {
        ChatItem.User("u$i", "Команда $i", emptyList(), null, pending = false, clientId = null, mode = "prompt", turnId = "user-$i")
    } else {
        ChatItem.Assistant(
            "a$i",
            "Ответ $i\n\nПервый абзац ответа.\n\n- пункт один\n- пункт два\n\n```kotlin\nval x = $i\n```\n$tail",
            "", emptyList(), active = false, status = "SUCCEEDED", error = null, final = true,
            at = null, endedAt = null, partial = false, superseded = false, stopReason = null, variants = null,
        )
    }

    @Test
    fun readingAboveIsNotMovedByChunksOrNewItems() = runComposeUiTest {
        val platform = DesktopPlatformServices(store = MemorySettings())
        val graph = AppGraph(platform)
        val http = HttpClient(MockEngine { respond("{}", HttpStatusCode.OK) })
        val api = TaskBridgeApi(http, SimpleConnection("http://pc:8787", clientId = "probe"))
        val session = ChatSession(api, "task-1", CoroutineScope(SupervisorJob() + Dispatchers.Default), { "cmd-1" }, { "2026-10-20T00:00:00Z" })
        val items = mutableStateListOf<ChatItem>().apply { for (i in 1..16) add(message(i)) }
        val chat = mutableStateOf(ChatSnapshot(items = items.toList(), newestAnswerId = "a16"))
        val listState = LazyListState()
        val following = mutableStateOf(true)
        setContent {
            MaterialTheme {
                Box(Modifier.size(420.dp, 640.dp)) {
                    MessageList(
                        graph = graph,
                        session = session,
                        state = ChatSessionState(
                            taskId = "task-1",
                            chat = chat.value,
                            loading = false,
                            link = LinkState.Live,
                            reachedStart = true,
                        ),
                        listState = listState,
                        following = following.value,
                        historyLocked = false,
                        onDialog = {},
                        onViewFile = {},
                        onCopyMessage = {},
                    )
                }
            }
        }
        waitForIdle()
        assertEquals(0, listState.firstVisibleItemIndex)
        assertEquals(0, listState.firstVisibleItemScrollOffset)

        // 1. Проверяем удержание позиции, а не распознавание жеста платформой.
        // У Markdown есть вложенные scroll-узлы; onFirst() не гарантирует ленту.
        runOnIdle { following.value = false }
        waitForIdle()
        listState.scrollToItem(3)
        waitForIdle()
        assertEquals(3, listState.firstVisibleItemIndex, "предусловие: лента прокручена выше низа")
        val before = listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset
        val visibleBefore = visible(listState)
        val last = items.last() as ChatItem.Assistant
        items[items.lastIndex] = last.copy(text = last.text + "Ещё кусок.")
        chat.value = chat.value.copy(items = items.toList())
        waitForIdle()
        assertEquals(before, listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset, "дельта сдвинула вид")
        assertEquals(visibleBefore, visible(listState))

        // 2. Читаем ВНУТРИ растущего ответа: последний ответ делаем высоким и стоим внутри него.
        val longTail = "Длинный абзац ответа. ".repeat(60)
        val tailIndex = items.lastIndex
        items[tailIndex] = message(tailIndex + 1, longTail)
        chat.value = chat.value.copy(items = items.toList())
        waitForIdle()
        listState.scrollToItem(0, 900)
        waitForIdle()
        fun textTop(): Float? = runCatching {
            onAllNodesWithText("Первый абзац ответа.", substring = true).fetchSemanticsNodes().map { it.boundsInRoot.top }.minOrNull()
        }.getOrNull()
        val insideTop = textTop()
        assertEquals(0, listState.firstVisibleItemIndex, "предусловие: стоим внутри нижнего ответа")
        repeat(3) { step ->
            val current = items[tailIndex] as ChatItem.Assistant
            items[tailIndex] = current.copy(text = current.text + "Ещё кусок стрима $step. ".repeat(20))
            chat.value = chat.value.copy(items = items.toList())
            waitForIdle()
            assertEquals(0, listState.firstVisibleItemIndex)
            assertEquals(900, listState.firstVisibleItemScrollOffset, "рост ответа не должен тянуть ленту вниз")
            // Допуск — на переразметку строк (4 px дрожания замерены), а не на сдвиг.
            assertTrue(kotlin.math.abs((textTop() ?: 0f) - (insideTop ?: 0f)) <= 12f, "текст под пальцем съехал")
        }

        // 3. Новый элемент чата, пока читаем выше: вид тоже не двигается.
        val visibleInside = visible(listState)
        items.add(message(17, "новый элемент"))
        chat.value = chat.value.copy(items = items.toList(), newestAnswerId = "a17")
        waitForIdle()
        // Индекс сдвигается (новый элемент стал нулевым), а вид — нет: лента держит
        // позицию по ключу элемента. Проверяем именно то, что видит оператор.
        assertEquals(visibleInside, visible(listState), "новый элемент сдвинул вид")

        // 4. Приходит ОГРОМНЫЙ отчёт отдельным сообщением (выше экрана), пока читаем выше.
        val report = ChatItem.Assistant(
            "report-1",
            "# Полный отчёт" + "\n\n" + "Строка отчёта с подробностями.\n\n".repeat(200),
            "", emptyList(), active = false, status = "SUCCEEDED", error = null, final = true,
            at = null, endedAt = null, partial = false, superseded = false, stopReason = null, variants = null,
        )
        items.add(report)
        chat.value = chat.value.copy(items = items.toList(), newestAnswerId = "report-1")
        waitForIdle()
        assertEquals(visibleInside, visible(listState), "огромный отчёт сдвинул вид")
        println("PROBE big-insert first=${listState.firstVisibleItemIndex}/${listState.firstVisibleItemScrollOffset}")

    }

    private fun visible(state: LazyListState): List<String> =
        state.layoutInfo.visibleItemsInfo.map { "${it.key}@${it.offset}" }

    private class MemorySettings : KeyValueStore {
        private val values = ConcurrentHashMap<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }
}
