package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.api.TaskUiState
import ru.arny.taskbridge.core.api.mergeTaskSnapshot
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import ru.arny.taskbridge.core.client.chat.ChatSnapshot
import ru.arny.taskbridge.core.client.chat.deriveChatUiState
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.session.ChatSessionState
import ru.arny.taskbridge.core.client.session.LinkState
import ru.arny.taskbridge.core.client.session.OutgoingMessage
import ru.arny.taskbridge.core.client.session.SendMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ChatStabilizationTest {

    private val jsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

    /** Реальное ожидание: HTTP-Mock живёт вне тестового планировщика. */
    private suspend fun until(condition: () -> Boolean) = withTimeout(10_000) {
        while (!condition()) delay(5)
    }

    // ---------- 1. ChatReducer: STOP / FAILED / agent_settled ----------

    @Test
    fun stopOnFirstTurnBeforeMessageStartIsNotIgnored() {
        val task = Task(id = "t1", prompt = "Привет", status = "RUNNING")
        val reducer = ChatReducer(task, seedInitial = true)

        // STOP пришёл на 1-й секунде до message_start: current.at == null, current.turnNo == null.
        val applied = reducer.apply(
            TaskEvent(
                taskId = "t1",
                seq = 1,
                at = "2026-11-23T10:00:01Z",
                type = "TASK_CANCELLED",
                message = "Task cancelled",
                data = buildJsonObject { put("turn", 1L) },
            ),
        )

        assertTrue(applied)
        assertTrue(reducer.terminalAffectsCurrent, "STOP на первом ходе обязан закрывать current")
        val answer = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().single()
        assertFalse(answer.active)
        assertTrue(answer.final)
        assertEquals("CANCELLED", answer.status)
        val user = reducer.snapshot().items.filterIsInstance<ChatItem.User>().single()
        assertEquals("Отменено", user.delivery)
    }

    @Test
    fun stopUpdatesUserDeliveryLabelOnFollowUp() {
        val task = Task(id = "t1", prompt = "Первый", status = "SUCCEEDED")
        val reducer = ChatReducer(task, seedInitial = true)
        reducer.apply(TaskEvent("t1", 1, "2026-11-23T10:00:01Z", "TASK_SUCCEEDED", data = buildJsonObject { put("turn", 1L) }))
        reducer.apply(
            TaskEvent(
                "t1", 2, "2026-11-23T10:00:02Z", "USER_MESSAGE",
                data = buildJsonObject { put("text", "Второй"); put("turn", 2L) },
            ),
        )
        reducer.apply(
            TaskEvent(
                "t1", 3, "2026-11-23T10:00:03Z", "TASK_CANCELLED",
                data = buildJsonObject { put("turn", 2L) },
            ),
        )

        val followUpUser = reducer.snapshot().items.filterIsInstance<ChatItem.User>().last()
        assertEquals("Отменено", followUpUser.delivery)
    }

    @Test
    fun stopOnRegeneratedVariantBeforeMessageStartIsNotIgnored() {
        val task = Task(id = "t1", prompt = "Вопрос", status = "SUCCEEDED")
        val reducer = ChatReducer(task, seedInitial = true)
        reducer.apply(TaskEvent("t1", 1, "2026-11-23T10:00:01Z", "TASK_SUCCEEDED", data = buildJsonObject { put("turn", 1L) }))
        reducer.apply(
            TaskEvent(
                "t1", 2, "2026-11-23T10:00:05Z", "TURN_VARIANT_START",
                data = buildJsonObject { put("turnSeq", 0L); put("variantId", "v2") },
            ),
        )

        // STOP нажали до первого ответа модели на новом варианте.
        reducer.apply(
            TaskEvent(
                "t1", 3, "2026-11-23T10:00:06Z", "TASK_CANCELLED",
                data = buildJsonObject { put("turn", 2L) },
            ),
        )

        assertTrue(reducer.terminalAffectsCurrent)
        val answer = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().single()
        assertEquals("assistant-v2", answer.id)
        assertFalse(answer.active)
        assertTrue(answer.final)
        assertEquals("CANCELLED", answer.status)
    }

    @Test
    fun lateFailureFromPreviousTurnDoesNotBreakNewerTurn() {
        val task = Task(id = "t1", prompt = "Ход 1", status = "RUNNING")
        val reducer = ChatReducer(task, seedInitial = true)
        reducer.apply(
            TaskEvent(
                "t1", 1, "2026-11-23T10:00:01Z", "USER_MESSAGE",
                data = buildJsonObject { put("text", "Ход 2"); put("turn", 2L) },
            ),
        )
        // Поздний TASK_FAILED от хода 1 пришёл после старта хода 2.
        reducer.apply(
            TaskEvent(
                "t1", 2, "2026-11-23T10:00:02Z", "TASK_FAILED",
                message = "old error",
                data = buildJsonObject { put("turn", 1L) },
            ),
        )

        assertFalse(reducer.terminalAffectsCurrent, "Чужой терминал не должен затрагивать ход 2")
        val answers = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>()
        assertEquals(2, answers.size)
        assertTrue(answers[1].active, "Ход 2 должен оставаться активным")
        assertFalse(answers[1].final)
    }

    @Test
    fun agentSettledKeepsTurnInVerifyingUntilTaskSucceeded() {
        val task = Task(id = "t1", prompt = "Сделай", status = "RUNNING")
        val reducer = ChatReducer(task, seedInitial = true)
        reducer.apply(
            TaskEvent(
                "t1", 1, "2026-11-23T10:00:01Z", "PI_EVENT",
                data = buildJsonObject {
                    put("pi", buildJsonObject {
                        put("type", "message_update")
                        put("assistantMessageEvent", buildJsonObject { put("type", "text_delta"); put("delta", "Готово!") })
                    })
                },
            ),
        )
        reducer.apply(
            TaskEvent(
                "t1", 2, "2026-11-23T10:00:02Z", "PI_EVENT",
                data = buildJsonObject { put("pi", buildJsonObject { put("type", "agent_settled") }) },
            ),
        )

        val duringVerify = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().single()
        assertEquals("VERIFYING", duringVerify.status)
        assertFalse(duringVerify.final, "До TASK_SUCCEEDED ответ не должен считаться финальным")

        reducer.apply(TaskEvent("t1", 3, "2026-11-23T10:00:03Z", "TASK_SUCCEEDED"))
        val finished = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().single()
        assertEquals("SUCCEEDED", finished.status)
        assertTrue(finished.final)
        assertFalse(finished.active)
    }

    // ---------- 2. ChatUiState: согласованность кнопок и анимаций ----------

    @Test
    fun uiStateMatchesVerifyingStoppingAndDoneRules() {
        val verifying = deriveChatUiState(
            ChatSessionState(
                taskId = "t1",
                task = Task(id = "t1", status = "VERIFYING"),
                link = LinkState.Live,
            ),
        )
        assertTrue(verifying.busy)
        assertFalse(verifying.showTyping)
        assertTrue(verifying.canStop)
        assertFalse(verifying.canEditHistory)
        assertFalse(verifying.canSteer)

        val stopping = deriveChatUiState(
            ChatSessionState(
                taskId = "t1",
                task = Task(id = "t1", status = "RUNNING"),
                busy = setOf("cancel"),
                link = LinkState.Live,
            ),
        )
        assertTrue(stopping.stopping)
        assertFalse(stopping.showTyping)
        assertTrue(stopping.canStop)
        assertFalse(stopping.canSend)
        assertFalse(stopping.canEditHistory)

        val doneWithStuckOutbox = deriveChatUiState(
            ChatSessionState(
                taskId = "t1",
                task = Task(id = "t1", status = "SUCCEEDED"),
                outbox = listOf(OutgoingMessage("cmd-1", "hi", emptyList(), SendMode.QUEUE, OutgoingMessage.Status.Sending)),
                link = LinkState.Live,
            ),
        )
        assertTrue(doneWithStuckOutbox.canStop, "Зависший outbox всегда должен давать нажать STOP")
        assertFalse(doneWithStuckOutbox.canEditHistory)
    }

    @Test
    fun serverTaskUiOverridesLocalWhenFreshAndMergesWithoutRollback() {
        val freshServerUi = TaskUiState(
            phase = "streaming", busy = true, typing = true,
            canStop = true, canSend = true, sendAction = "queue",
            canEditHistory = false, label = "Модель отвечает", seq = 20,
        )
        val ui = deriveChatUiState(
            ChatSessionState(
                taskId = "t1",
                task = Task(id = "t1", status = "RUNNING", snapshotSeq = 20, ui = freshServerUi),
                chat = ChatSnapshot(cursor = 20),
                link = LinkState.Live,
            ),
        )
        assertTrue(ui.showTyping)
        assertTrue(ui.canSteer)
        assertEquals("Модель отвечает", ui.statusLabel)

        val prev = Task(id = "t1", status = "CANCELLED", snapshotSeq = 25, ui = TaskUiState(phase = "idle", busy = false, seq = 25))
        val staleGet = Task(id = "t1", status = "RUNNING", snapshotSeq = 22, ui = freshServerUi)
        val merged = mergeTaskSnapshot(prev, staleGet, appliedCursor = 25)
        assertEquals("CANCELLED", merged.status)
        assertEquals("idle", merged.ui?.phase)
    }

    // ---------- 3. ChatSession: refreshTask + repairGap, cancel, queue send ----------

    @Test
    fun refreshTaskUpdatesTaskEvenAfterRepairGap() = runBlocking<Unit> {
        var taskCalls = 0
        val engine = MockEngine { req ->
            val url = req.url.toString()
            when {
                "/events?tail=" in url -> respond(
                    """{"events":[{"taskId":"t1","seq":1,"at":"2026-11-23T10:00:00Z","type":"STATUS","data":{"status":"RUNNING"}}],"reachedStart":true}""",
                    HttpStatusCode.OK, jsonHeaders,
                )
                "/events?after=1" in url -> respond(
                    """[{"taskId":"t1","seq":2,"at":"2026-11-23T10:00:05Z","type":"TASK_SUCCEEDED","message":"Done","data":{}}]""",
                    HttpStatusCode.OK, jsonHeaders,
                )
                url.endsWith("/api/tasks/t1") -> {
                    taskCalls++
                    val body = if (taskCalls == 1) {
                        """{"id":"t1","prompt":"hi","status":"RUNNING","snapshotSeq":1}"""
                    } else {
                        """{"id":"t1","prompt":"hi","status":"SUCCEEDED","snapshotSeq":2,"current":"Done","pendingPrompts":[]}"""
                    }
                    respond(body, HttpStatusCode.OK, jsonHeaders)
                }
                "/approvals" in url -> respond("[]", HttpStatusCode.OK, jsonHeaders)
                else -> respond("{}", HttpStatusCode.OK, jsonHeaders)
            }
        }
        val http = HttpClient(engine)
        val session = ChatSession(
            api = TaskBridgeApi(http, SimpleConnection("http://127.0.0.1:8787")),
            taskId = "t1", scope = this,
            ids = { "cmd-1" }, now = { "2026-11-23T10:00:06Z" },
            initialStreamingEnabled = false,
        )
        try {
            session.start()
            until { session.state.value.task?.status == "RUNNING" }

            // Опрос состояния: snapshotSeq сервера (2) выше курсора (1), поэтому
            // repairGap догружает seq=2 и двигает курсор. Раньше после этого
            // `chat.cursor != cursor` отбрасывал полученный снимок — статус не менялся.
            session.refreshNowForTest()

            until { session.state.value.task?.status == "SUCCEEDED" }
            assertEquals(2L, session.state.value.chat.cursor)
        } finally {
            session.close()
            http.close()
        }
    }

    @Test
    fun queueSendWhileRunningDoesNotFlashOptimisticBubbleInTimeline() = runBlocking<Unit> {
        var sentQueueFlag: Boolean? = null
        val engine = MockEngine { req ->
            val url = req.url.toString()
            when {
                "/events?tail=" in url -> respond("""{"events":[],"reachedStart":true}""", HttpStatusCode.OK, jsonHeaders)
                req.method == HttpMethod.Post && url.endsWith("/message") -> {
                    sentQueueFlag = true
                    respond(
                        """{"id":"t1","prompt":"hi","status":"RUNNING","snapshotSeq":1,"pendingPrompts":[{"id":"p1","text":"следующий","commandId":"cmd-q1"}]}""",
                        HttpStatusCode.OK, jsonHeaders,
                    )
                }
                url.endsWith("/api/tasks/t1") -> respond(
                    """{"id":"t1","prompt":"hi","status":"RUNNING","snapshotSeq":1,"pendingPrompts":[]}""",
                    HttpStatusCode.OK, jsonHeaders,
                )
                "/approvals" in url -> respond("[]", HttpStatusCode.OK, jsonHeaders)
                else -> respond("{}", HttpStatusCode.OK, jsonHeaders)
            }
        }
        val http = HttpClient(engine)
        val session = ChatSession(
            api = TaskBridgeApi(http, SimpleConnection("http://127.0.0.1:8787")),
            taskId = "t1", scope = this,
            ids = { "cmd-q1" }, now = { "2026-11-23T10:00:06Z" },
            initialStreamingEnabled = false,
        )
        try {
            session.start()
            until { session.state.value.task?.status == "RUNNING" }

            session.send("следующий", mode = SendMode.QUEUE)
            // Проверяем СРАЗУ, до завершения сетевого запроса: пузыря с user-pending нет.
            val hasOptimistic = session.state.value.chat.items.any { it.id.startsWith("user-pending-") }
            assertFalse(hasOptimistic, "При SendMode.QUEUE на активном ходе не должно быть мигающего пузыря в ленте")

            until { sentQueueFlag == true }
        } finally {
            session.close()
            http.close()
        }
    }

    @Test
    fun cancelAppliesServerCancelledEvenWhenCalledWithDefaultHardTrue() = runBlocking<Unit> {
        var cancelBody = ""
        val engine = MockEngine { req ->
            val url = req.url.toString()
            when {
                "/events?tail=" in url -> respond("""{"events":[],"reachedStart":true}""", HttpStatusCode.OK, jsonHeaders)
                req.method == HttpMethod.Post && url.endsWith("/cancel") -> {
                    cancelBody = req.body.toString()
                    respond("""{"id":"t1","prompt":"hi","status":"CANCELLED","snapshotSeq":5,"current":"Cancelled"}""", HttpStatusCode.OK, jsonHeaders)
                }
                url.endsWith("/api/tasks/t1") -> respond(
                    """{"id":"t1","prompt":"hi","status":"RUNNING","snapshotSeq":1}""",
                    HttpStatusCode.OK, jsonHeaders,
                )
                "/approvals" in url -> respond("[]", HttpStatusCode.OK, jsonHeaders)
                else -> respond("{}", HttpStatusCode.OK, jsonHeaders)
            }
        }
        val http = HttpClient(engine)
        val session = ChatSession(
            api = TaskBridgeApi(http, SimpleConnection("http://127.0.0.1:8787")),
            taskId = "t1", scope = this,
            ids = { "cmd-stop-1" }, now = { "2026-11-23T10:00:06Z" },
            initialStreamingEnabled = false,
        )
        try {
            session.start()
            until { session.state.value.task?.status == "RUNNING" }

            session.cancel() // по умолчанию hard = true
            until { session.state.value.task?.status == "CANCELLED" }

            assertFalse(deriveChatUiState(session.state.value).busy)
            assertFalse(deriveChatUiState(session.state.value).canStop)
            assertTrue(cancelBody.isNotEmpty())
        } finally {
            session.close()
            http.close()
        }
    }
}
