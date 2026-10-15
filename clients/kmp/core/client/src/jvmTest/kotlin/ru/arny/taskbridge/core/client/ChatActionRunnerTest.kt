package ru.arny.taskbridge.core.client

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import ru.arny.taskbridge.core.client.session.ChatActionRunner
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class ChatActionRunnerTest {
    @Test
    fun repeatedStopRemainsBusyUntilBothRequestsFinish() = runTest {
        var busy = emptySet<String>()
        var refreshes = 0
        val first = CompletableDeferred<Unit>()
        val second = CompletableDeferred<Unit>()
        val runner = ChatActionRunner(backgroundScope, { busy = it }, {}, { error("unexpected failure") }, { refreshes++ })
        runner.run("cancel", concurrent = true) { first.await() }
        runner.run("cancel", concurrent = true) { second.await() }
        assertEquals(setOf("cancel"), busy)
        first.complete(Unit)
        runCurrent()
        assertEquals(1, refreshes)
        assertEquals(setOf("cancel"), busy)
        second.complete(Unit)
        runCurrent()
        assertEquals(2, refreshes)
        assertTrue(busy.isEmpty())
    }

    @Test
    fun duplicateOrdinaryActionIsSuppressedAndCanBeRetriedAfterCompletion() = runTest {
        var busy = emptySet<String>()
        var calls = 0
        val gate = CompletableDeferred<Unit>()
        val runner = ChatActionRunner(backgroundScope, { busy = it }, {}, {}, {})
        runner.run("compact") { calls++; gate.await() }
        runner.run("compact") { calls++ }
        assertEquals(1, calls)
        gate.complete(Unit)
        runCurrent()
        assertTrue(busy.isEmpty())
        runner.run("compact") { calls++ }
        assertEquals(2, calls)
    }

    @Test
    fun cancellationReleasesActivityWithoutFailureNoticeOrRefresh() = runTest {
        var busy = emptySet<String>()
        val runner = ChatActionRunner(backgroundScope, { busy = it }, { error("unexpected notice") },
            { error("cancellation is not an API error") }, { error("cancelled action must not refresh") })
        runner.run("rename") { awaitCancellation() }
        assertEquals(setOf("rename"), busy)
        backgroundScope.cancel()
        runCurrent()
        assertTrue(busy.isEmpty())
    }
}
