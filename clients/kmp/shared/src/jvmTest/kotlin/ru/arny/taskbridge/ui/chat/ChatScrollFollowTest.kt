package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Поведение ленты чата при приходе контента (жалоба оператора 2026-10-17):
 * «скролл вверх при добавлении команды или элемента чата» и «скролл в самый низ
 * при получении чанков сообщения».
 *
 * Проверка поведением, как в HeavyReasoningCopyTest: настоящая LazyColumn с
 * `reverseLayout` и ключами, настоящие [BottomLatch] и [ReadingAnchor], а
 * проводка эффектов повторяет [ChatScreen] / MessageList — сама лента приватна,
 * а её политика собрана из этих двух объектов.
 */
@OptIn(ExperimentalTestApi::class)
class ChatScrollFollowTest {

    data class FeedItem(val id: String, val height: Int)

    @Test
    fun newElementsAndChunksKeepTheOperatorsPlace() = runComposeUiTest {
        val feed = mutableStateListOf<FeedItem>().apply { for (i in 1..12) add(FeedItem("m$i", 300)) }
        val listState = LazyListState()
        var following = true
        setContent {
            MaterialTheme {
                val latch = remember { BottomLatch() }
                var follow by remember { mutableStateOf(true) }
                // Как в ChatScreen: защёлка «у низа» считается по позиции ленты и составу ленты.
                LaunchedEffect(listState, latch) {
                    snapshotFlow {
                        Triple(
                            listState.firstVisibleItemIndex,
                            listState.firstVisibleItemScrollOffset,
                            feed.size to feed.lastOrNull()?.id,
                        )
                    }.collect { (index, offset, newest) ->
                        latch.observe(index, offset, newest.first, newest.second)
                        follow = latch.following
                    }
                }
                // Как в ChatScreen: конец прокрутки — решение по позиции.
                LaunchedEffect(listState, latch) {
                    snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
                        if (!scrolling) {
                            latch.settle(listState.firstVisibleItemIndex, listState.firstVisibleItemScrollOffset)
                            follow = latch.following
                        }
                    }
                }
                following = follow
                ChatFeed(feed, listState, follow)
            }
        }
        waitForIdle()
        assertTrue(following, "открытая сессия стоит у низа")
        assertEquals(0, listState.firstVisibleItemIndex)
        assertEquals(0, listState.firstVisibleItemScrollOffset)

        // 1. Отправка команды: элемент приходит в ленту ПОСЛЕ того, как приложение
        //    попросило прокрутку к низу (ответ сервера асинхронный). До правки
        //    bubble оставался за нижней границей, а лента считалась уехавшей вверх.
        feed.add(FeedItem("cmd-1", 300))
        waitForIdle()
        assertEquals(0, listState.firstVisibleItemIndex, "новый элемент — нулевой, лента у низа")
        assertEquals(0, listState.firstVisibleItemScrollOffset)
        assertTrue(following)
        assertTrue(visibleKeys(listState).contains("cmd-1"), "отправленную команду видно сразу: ${visibleKeys(listState)}")

        // 2. Ответ печатается чанками: нижняя граница остаётся на месте, текст растёт вверх.
        repeat(4) {
            val last = feed.last()
            feed[feed.lastIndex] = last.copy(height = last.height + 120)
            waitForIdle()
            assertEquals(0, listState.firstVisibleItemIndex, "чанк не сдвигает низ")
            assertEquals(0, listState.firstVisibleItemScrollOffset)
        }

        // 3. Оператор читает выше. Жест у низа оставляет якорь у низа, а дальше он
        //    листает колесом — и `isScrollInProgress` при этом НЕ поднимается. На
        //    этом и ломался старый якорь: он оставался у низа, и первая же дельта
        //    возвращала ленту вниз.
        onNodeWithTag("feed").performTouchInput { swipeDown() }
        waitForIdle()
        assertFalse(following, "жест вверх выключает слежение на конце прокрутки")
        onNodeWithTag("feed").performMouseInput { moveTo(center) }
        onNodeWithTag("feed").performMouseInput { scroll(-5f) }
        waitForIdle()
        onNodeWithTag("feed").performMouseInput { scroll(-5f) }
        waitForIdle()
        assertFalse(following)
        val readingPlace = visible(listState)

        // 4. Чанки продолжают приходить, пока он читает: лента не имеет права уехать.
        repeat(3) {
            val last = feed.last()
            feed[feed.lastIndex] = last.copy(height = last.height + 120)
            waitForIdle()
            assertEquals(readingPlace, visible(listState), "чанк увёл ленту с места чтения")
        }

        // 5. Новый элемент чата, пока читаем выше: тоже без движения.
        feed.add(FeedItem("note-1", 120))
        waitForIdle()
        assertEquals(readingPlace, visible(listState), "новый элемент увёл ленту с места чтения")
        assertFalse(following)

        // 6. Возврат к низу возобновляет слежение: следующая дельта снова остаётся в виде.
        onNodeWithTag("feed").performScrollToIndex(0)
        waitForIdle()
        assertTrue(following, "у низа слежение включается снова")
        val last = feed.last()
        feed[feed.lastIndex] = last.copy(height = last.height + 120)
        waitForIdle()
        assertEquals(0, listState.firstVisibleItemIndex)
        assertEquals(0, listState.firstVisibleItemScrollOffset)
    }

    private fun visible(state: LazyListState): List<String> =
        state.layoutInfo.visibleItemsInfo.map { "${it.key}@${it.offset}" }

    private fun visibleKeys(state: LazyListState): List<String> =
        state.layoutInfo.visibleItemsInfo.map { it.key.toString() }
}

/** Лента чата: `reverseLayout`, ключи и та же проводка эффектов, что в MessageList. */
@Composable
private fun ChatFeed(
    feed: List<ChatScrollFollowTest.FeedItem>,
    listState: LazyListState,
    following: Boolean,
) {
    val anchor = remember { ReadingAnchor() }
    val reversed = remember(feed) { feed.asReversed() }
    val newest = feed.lastOrNull()
    val contentSignature = feed.size to (newest?.height ?: 0)
    val latest by rememberUpdatedState(feed.toList())
    LaunchedEffect(listState) {
        var seen: Pair<Int, Int>? = null
        snapshotFlow {
            val now = latest
            Triple(
                listState.firstVisibleItemIndex,
                listState.firstVisibleItemScrollOffset,
                now.size to (now.lastOrNull()?.height ?: 0),
            )
        }.collect { (index, offset, signature) ->
            val arrived = seen != null && signature != seen
            seen = signature
            anchor.record(arrived, index, offset) { i -> latest.asReversed().getOrNull(i)?.id }
        }
    }
    LaunchedEffect(contentSignature, following) {
        if (following) {
            if (!listState.isScrollInProgress && listState.firstVisibleItemIndex != 0) listState.scrollToItem(0, 0)
            return@LaunchedEffect
        }
        val target = anchor.target(
            following = false,
            scrolling = listState.isScrollInProgress,
            currentIndex = listState.firstVisibleItemIndex,
            currentOffset = listState.firstVisibleItemScrollOffset,
            indexOf = { id -> reversed.indexOfFirst { it.id == id } },
        ) ?: return@LaunchedEffect
        listState.scrollToItem(target.first, target.second)
    }
    LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize().testTag("feed")) {
        items(reversed, key = { it.id }) { item ->
            Box(Modifier.fillMaxWidth().height(item.height.dp)) { Text(item.id) }
        }
    }
}
