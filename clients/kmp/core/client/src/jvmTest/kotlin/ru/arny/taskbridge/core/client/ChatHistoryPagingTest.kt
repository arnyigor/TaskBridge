package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import ru.arny.taskbridge.core.client.session.CACHE_BUDGET_CHARS
import ru.arny.taskbridge.core.client.session.CachedChat
import ru.arny.taskbridge.core.client.session.ChatPersistence
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.session.ChatSessionState
import ru.arny.taskbridge.core.client.session.NoopChatPersistence
import ru.arny.taskbridge.core.client.session.OLDER_PAGE_LIMIT
import ru.arny.taskbridge.core.client.session.lightenEvent
import ru.arny.taskbridge.core.client.session.trimCacheToBudget
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The paged history of one chat.
 *
 * Every case comes from the phone (2026-10-11): scrolling the history up needed
 * one tap per page, and the session died with `OutOfMemoryError` inside
 * `JsonToStringWriter.ensureTotalCapacity`, thrown from `persistCache` right
 * after `loadOlder` — three crashes in one morning, all with the same stack
 * (`ChatSession$loadOlder$2` → `persistCache` → `AndroidChatPersistence.saveChat`).
 */
class ChatHistoryPagingTest {
    private val task = Task(id = "t", prompt = "первый вопрос", status = "SUCCEEDED")

    private fun user(seq: Long, text: String = "вопрос $seq") = TaskEvent(
        taskId = "t", seq = seq, type = "USER_MESSAGE", message = text,
        data = buildJsonObject { put("text", text) },
    )

    private fun frame(seq: Long, type: String, answer: String = ""): TaskEvent = TaskEvent(
        taskId = "t", seq = seq, type = "PI_EVENT",
        data = buildJsonObject {
            put("pi", when (type) {
                "message_start" -> buildJsonObject {
                    put("type", "message_start")
                    put("message", buildJsonObject { put("role", "assistant") })
                }
                "message_end" -> buildJsonObject {
                    put("type", "message_end")
                    put("message", buildJsonObject {
                        put("role", "assistant")
                        put("content", buildJsonArray {
                            add(buildJsonObject { put("type", "text"); put("text", answer) })
                        })
                    })
                }
                else -> buildJsonObject { put("type", type) }
            })
        },
    )

    /** One exchange the way the server pages it: the prompt, then the answer frames. */
    private fun exchange(from: Long, answer: String): List<TaskEvent> = listOf(
        user(from),
        frame(from + 1, "message_start"),
        frame(from + 2, "message_end", answer),
    )

    // --- the reducer must never hand two items with one id to the list ---------

    @Test
    fun anOverlappingPageDoesNotDuplicateTurns() {
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.prependOlder(task, exchange(10, "старый ответ"), reachedStart = false)
        val once = reducer.snapshot().items
        // The same page again: a server that answered twice, a retried request.
        reducer.prependOlder(task, exchange(10, "старый ответ"), reachedStart = false)
        val twice = reducer.snapshot().items

        assertEquals(once.map { it.id }, twice.map { it.id }, "an overlapping page must add nothing")
        assertEquals(twice.size, twice.map { it.id }.toSet().size, "LazyColumn keys must stay unique: $twice")
    }

    @Test
    fun anOlderPageLandsInFrontOfTheLoadedOne() {
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.prependOlder(task, exchange(20, "свежий"), reachedStart = false)
        reducer.prependOlder(task, exchange(10, "старый"), reachedStart = false)
        assertEquals(
            listOf("user-10", "assistant-10", "user-20", "assistant-20"),
            reducer.snapshot().items.map { it.id },
            "the older page goes above the newer one",
        )
    }

    // --- one action loads several pages -------------------------------------

    /**
     * The operator presses «load older» once and the history actually moves: a page is
     * [pageTurns] turns, less than a screen, so one page per action meant dozens of
     * taps on a long session.
     */
    @Test
    fun oneActionPullsSeveralPagesUntilTheHistoryStart() = runBlocking<Unit> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            // tail(40) -> 30 -> 20 -> 10 (the start)
            val pages = mapOf(
                40L to (exchange(30, "ответ 30") to false),
                30L to (exchange(20, "ответ 20") to false),
                20L to (exchange(10, "ответ 10") to true),
            )
            val api = api { path, before ->
                if (!path.endsWith("/events")) null else pages[before] ?: (exchange(40, "ответ 40") to false)
            }
            val session = ChatSession(
                api, "t", scope,
                ids = { "id" }, now = { "2026-10-11T00:00:00Z" },
                persistence = NoopChatPersistence,
            )
            session.start()
            await(session) { it.task != null && it.chat.items.size == 2 && !it.loading }

            session.loadOlder()
            val loaded = await(session) { !it.loadingOlder && it.reachedStart }

            assertEquals(
                listOf(
                    // The session's own first prompt has no USER_MESSAGE event, so the
                    // page that reaches the start synthesises it from the task record.
                    "user-initial", "assistant-initial",
                    "user-10", "assistant-10", "user-20", "assistant-20",
                    "user-30", "assistant-30", "user-40", "assistant-40",
                ),
                loaded.chat.items.map { it.id },
                "three pages came in one action, oldest first",
            )
        } finally {
            scope.cancel()
        }
    }

    /** One gesture must not pull a whole multi-megabyte history into the heap. */
    @Test
    fun oneActionStopsAtThePageCeilingAndOffersMore() = runBlocking<Unit> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            // Every page is older than the last and the start is never reached.
            val api = api { path, before ->
                when {
                    !path.endsWith("/events") -> null
                    before == null -> exchange(1_000L, "ответ 1000") to false
                    else -> exchange(before - 10, "ответ ${before - 10}") to false
                }
            }
            val session = ChatSession(
                api, "t", scope,
                ids = { "id" }, now = { "2026-10-11T00:00:00Z" },
                persistence = NoopChatPersistence,
            )
            session.start()
            await(session) { it.task != null && it.chat.items.size == 2 && !it.loading }

            session.loadOlder()
            val stopped = await(session) { !it.loadingOlder && it.chat.items.size > 2 }

            // The ceiling is the page count here (each page is one exchange).
            assertEquals(2 + OLDER_PAGE_LIMIT * 2, stopped.chat.items.size, "bounded by the page ceiling")
            assertTrue(!stopped.reachedStart, "more history remains, so the button stays")
            assertEquals(
                stopped.chat.items.map { it.id },
                stopped.chat.items.map { it.id }.toSet().toList(),
                "no duplicated ids",
            )
        } finally {
            scope.cancel()
        }
    }

    /**
     * A server that answers the same window twice must not duplicate turns: a turn's id
     * is its seq, and two items with one LazyColumn key crash Android.
     */
    @Test
    fun aRepeatedWindowIsNotAppliedTwice() = runBlocking<Unit> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val repeated = exchange(10, "старый ответ")
            val api = api { path, before ->
                if (!path.endsWith("/events")) null
                else if (before == null) exchange(20, "свежий ответ") to false
                else repeated to false
            }
            val session = ChatSession(
                api, "t", scope,
                ids = { "id" }, now = { "2026-10-11T00:00:00Z" },
                persistence = NoopChatPersistence,
            )
            session.start()
            await(session) { it.task != null && it.chat.items.size == 2 && !it.loading }

            session.loadOlder()
            val stopped = await(session) { !it.loadingOlder && it.chat.items.size == 4 }
            assertTrue(!stopped.reachedStart, "a repeated page does not prove the history start was reached")

            assertEquals(
                listOf("user-10", "assistant-10", "user-20", "assistant-20"),
                stopped.chat.items.map { it.id },
                "the repeated page was applied once and then ended the paging",
            )
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun closingTheSessionCancelsPagingAndRefusesFurtherLoads() = runBlocking<Unit> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val requested = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        var pageCalls = 0
        try {
            val api = api { path, before ->
                when {
                    !path.endsWith("/events") -> null
                    before == null -> exchange(20, "свежий ответ") to false
                    else -> {
                        pageCalls++
                        requested.complete(Unit)
                        try { awaitCancellation() } finally { cancelled.complete(Unit) }
                    }
                }
            }
            val session = ChatSession(api, "t", scope, ids = { "id" }, now = { "2026-10-15T00:00:00Z" })
            session.start()
            await(session) { it.task != null && !it.loading }
            session.loadOlder()
            assertTrue(withTimeoutOrNull(5000) { requested.await(); true } == true)
            session.loadOlder()
            assertEquals(1, pageCalls, "one request per cursor while a page is pending")
            session.close()
            assertTrue(withTimeoutOrNull(5000) { cancelled.await(); true } == true, "closing cancels the pending network request")
            await(session) { !it.loadingOlder }
            session.loadOlder()
            delay(50)
            assertEquals(1, pageCalls, "a closed session must not page again")
            assertEquals(listOf("user-20", "assistant-20"), session.state.value.chat.items.map { it.id })
        } finally { scope.cancel() }
    }

    private suspend fun await(session: ChatSession, timeoutMillis: Long = 15_000, check: (ChatSessionState) -> Boolean): ChatSessionState =
        withTimeoutOrNull(timeoutMillis) {
            while (!check(session.state.value)) delay(20)
            session.state.value
        } ?: throw AssertionError(
            "timed out: items=${session.state.value.chat.items.map { it.id }} loadingOlder=${session.state.value.loadingOlder} reachedStart=${session.state.value.reachedStart}",
        )

    private val taskJson = """{"id":"t","prompt":"первый вопрос","status":"SUCCEEDED","projectId":"fixture"}"""

    private fun eventsJson(events: List<TaskEvent>): String = TaskBridgeJson.encodeToString(ListSerializer(TaskEvent.serializer()), events)

    /** A mock server: the tail window with no cursor, pages below it keyed by `before`. */
    private fun api(page: suspend (path: String, before: Long?) -> Pair<List<TaskEvent>, Boolean>?): TaskBridgeApi {
        val http = HttpClient(MockEngine { request ->
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            val path = request.url.encodedPath
            val paged = page(path, request.url.parameters["before"]?.toLongOrNull())
            when {
                path.endsWith("/stream") -> respond("""{"error":"Not found","code":"NOT_FOUND"}""", HttpStatusCode.NotFound, json)
                path.endsWith("/approvals") -> respond("[]", HttpStatusCode.OK, json)
                path.endsWith("/events") && paged != null ->
                    respond("""{"events":${eventsJson(paged.first)},"reachedStart":${paged.second}}""", HttpStatusCode.OK, json)
                path.endsWith("/events") -> respond("""{"events":[],"reachedStart":true}""", HttpStatusCode.OK, json)
                else -> respond(taskJson, HttpStatusCode.OK, json)
            }
        })
        return TaskBridgeApi(http, SimpleConnection("http://pc:8787", clientId = "android-test"))
    }

    // --- the cache is bounded by size, not only by event count ----------------

    /**
     * What actually reaches the file: the whole chat used to be serialized into
     * one string, so a cache of tens of megabytes asked the encoder for an array
     * of that size and Android refused it (the crash this test was written for).
     * A trimmed cache must also stop claiming it holds the session start, or the
     * chat would show a truncated history with no way to load the rest.
     */
    @Test
    fun thePersistedCacheStaysUnderTheBudget() = runBlocking<Unit> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val saved = java.util.concurrent.CopyOnWriteArrayList<CachedChat>()
        try {
            val heavy = List(3) { index ->
                frame(10L + index, "message_end", "x".repeat(800_000))
            }
            val api = api { path, _ -> if (path.endsWith("/events")) heavy to true else null }
            val session = ChatSession(
                api, "t", scope,
                ids = { "id" }, now = { "2026-10-11T00:00:00Z" },
                persistence = object : ChatPersistence by NoopChatPersistence {
                    override suspend fun saveChat(taskId: String, value: CachedChat) {
                        saved += value
                    }
                },
            )
            session.start()
            await(session) { it.task != null && !it.loading && saved.isNotEmpty() }
            val cache = saved.last()
            val weight = cache.events.sumOf { it.data.toString().length }
            assertTrue(weight <= CACHE_BUDGET_CHARS, "the cache is $weight characters, budget is $CACHE_BUDGET_CHARS")
            assertTrue(cache.events.isNotEmpty(), "the newest events stay")
            assertTrue(!cache.reachedStart, "a trimmed cache must not claim the session start")
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun theCacheBudgetKeepsTheNewestEventsOnly() {
        val big = { seq: Long -> TaskEvent(taskId = "t", seq = seq, type = "PI_EVENT", data = buildJsonObject { put("blob", "x".repeat(400_000)) }) }
        val events = mutableListOf(big(1), big(2), big(3), big(4))
        assertTrue(trimCacheToBudget(events, budgetChars = 900_000), "something was dropped")
        assertEquals(listOf(3L, 4L), events.map { it.seq }, "the newest events survive")

        val whole = mutableListOf(big(1), big(2))
        assertTrue(!trimCacheToBudget(whole, budgetChars = CACHE_BUDGET_CHARS), "nothing to drop")
        assertEquals(2, whole.size, "an untouched cache must not be marked as truncated")

        // A single event over the budget would not fit either: the encoder allocates
        // the whole string at once, so keeping it would keep the risk.
        val single = mutableListOf(big(7))
        assertTrue(trimCacheToBudget(single, budgetChars = 100_000), "an event over the budget is dropped")
        assertEquals(0, single.size)
    }

    @Test
    fun theEventCapStillApplies() {
        val small = { seq: Long -> TaskEvent(taskId = "t", seq = seq, type = "STATUS", data = buildJsonObject { put("status", "RUNNING") }) }
        val events = MutableList(600) { small(it + 1L) }
        assertTrue(trimCacheToBudget(events), "the count cap dropped the oldest")
        assertEquals(500, events.size)
        assertEquals(101L, events.first().seq, "the oldest events are the ones dropped")
    }

    // --- the biggest thing in the cache was stored twice ----------------------

    @Test
    fun aTurnEndLosesTheToolResultsItDuplicates() {
        val frame = buildJsonObject {
            put("type", "turn_end")
            put("message", buildJsonObject { put("role", "assistant") })
            put("toolResults", buildJsonArray {
                add(buildJsonObject { put("toolName", "bash"); put("result", "y".repeat(300_000)) })
            })
        }
        val event = TaskEvent(taskId = "t", seq = 5, type = "PI_EVENT", data = buildJsonObject { put("pi", frame) })
        val pi = lightenEvent(event).piFrame!!
        assertTrue("toolResults" !in pi, "the duplicated tool output is gone: ${pi.keys}")
        assertTrue("message" !in pi, "and so is the message copy")
        // The frame is kept: it still closes the previous answer's delivery line.
        assertEquals("turn_end", pi["type"].toString().trim('"'))
    }

    @Test
    fun aToolUpdateStillDropsItsPartialResult() {
        val event = TaskEvent(
            taskId = "t", seq = 6, type = "PI_EVENT",
            data = buildJsonObject {
                put("pi", buildJsonObject {
                    put("type", "tool_execution_update")
                    put("toolName", "bash")
                    put("partialResult", "z".repeat(300_000))
                })
            },
        )
        val pi = lightenEvent(event).piFrame!!
        assertTrue("partialResult" !in pi, "streaming tool progress is not cached: ${pi.keys}")
    }

    /**
     * A cache write that cannot happen must not take the chat with it: the file is
     * a convenience for the next cold start, and the write runs from
     * supervisor-launched coroutines — on Android an exception escaping there
     * kills the process (that is how the real crash ended), so the test watches
     * the scope for unhandled failures and for the load completing.
     */
    @Test
    fun aFailingCacheWriteDoesNotBreakTheChat() = runBlocking<Unit> {
        val failures = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
        val approvals = java.util.concurrent.atomic.AtomicInteger()
        val scope = CoroutineScope(
            SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, error -> failures += error },
        )
        try {
            val api = api { path, before ->
                when {
                    path.endsWith("/approvals") -> { approvals.incrementAndGet(); null }
                    path.endsWith("/events") && before == null -> exchange(20, "ответ") to false
                    else -> null
                }
            }
            val session = ChatSession(
                api, "t", scope,
                ids = { "id" }, now = { "2026-10-11T00:00:00Z" },
                persistence = object : ChatPersistence by NoopChatPersistence {
                    override suspend fun saveChat(taskId: String, value: CachedChat) {
                        throw OutOfMemoryError("simulated: the encoder could not allocate")
                    }
                },
            )
            session.start()
            val state = await(session) { it.task != null && it.chat.items.size == 2 && !it.loading }
            delay(500)
            assertEquals(
                listOf("user-20", "assistant-20"),
                state.chat.items.map { it.id },
                "the chat loaded although nothing could be cached",
            )
            assertTrue(state.chat.items.filterIsInstance<ChatItem.Assistant>().single().text.isNotEmpty())
            assertTrue(failures.isEmpty(), "the failing write escaped into the session scope: $failures")
            assertTrue(approvals.get() >= 1, "the load finished although the cache write failed")
        } finally {
            scope.cancel()
        }
    }
}
