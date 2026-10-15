package ru.arny.taskbridge.core.client

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import ru.arny.taskbridge.core.client.session.DraftAutosave
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalCoroutinesApi::class)
class DraftAutosaveTest {
    @Test
    fun rapidTypingPersistsOnlyLatestTextAfterTheQuietPeriod() = runTest {
        val saved = mutableListOf<String>()
        val draft = DraftAutosave(backgroundScope, "", saved::add)
        draft.update("a")
        runCurrent()
        advanceTimeBy(300)
        draft.update("ab")
        runCurrent()
        advanceTimeBy(399)
        runCurrent()
        assertEquals(emptyList(), saved)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf("ab"), saved)
    }

    @Test
    fun leavingBeforeDebounceFlushesEvenTheTextObserverHasNotSeen() = runTest {
        val first = mutableListOf<String>()
        val second = mutableListOf<String>()
        val a = DraftAutosave(backgroundScope, "", first::add)
        val b = DraftAutosave(backgroundScope, "", second::add)
        a.update("pending")
        b.update("another chat")
        a.close("latest keystroke")
        a.update("stale observer")
        advanceTimeBy(500)
        runCurrent()
        assertEquals(listOf("latest keystroke"), first)
        assertEquals(listOf("another chat"), second)
    }

    @Test
    fun sendClearsPersistedDraftWithoutAnOlderDelayedWriteResurrectingIt() = runTest {
        val saved = mutableListOf<String>()
        val draft = DraftAutosave(backgroundScope, "old draft", saved::add)
        draft.update("ready to send")
        runCurrent()
        draft.flush("")
        advanceTimeBy(500)
        runCurrent()
        draft.close("")
        assertEquals(listOf(""), saved)
    }
}
