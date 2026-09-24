package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import ru.arny.taskbridge.core.api.CreateTaskRequest
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.core.client.session.ChatSessionState
import ru.arny.taskbridge.core.client.session.LinkState
import ru.arny.taskbridge.core.client.session.SendMode
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * ChatSession against a real TaskBridge on fake-pi (tests/fixture-server.mjs),
 * through OkHttp like the apps. Needs `node` on PATH; skipped without it.
 */
class ChatSessionIntegrationTest {
    private var server: Process? = null
    private lateinit var input: java.io.Writer
    private lateinit var output: BufferedReader
    private lateinit var base: String
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = HttpClient(OkHttp) {
        engine { config { readTimeout(0, TimeUnit.MILLISECONDS) } }
    }

    private val nodeAvailable: Boolean by lazy {
        runCatching { ProcessBuilder("node", "--version").start().waitFor(10, TimeUnit.SECONDS) }.getOrDefault(false)
    }

    @BeforeTest
    fun start() {
        if (!nodeAvailable) return
        val repo = File(System.getProperty("taskbridge.repo"))
        val process = ProcessBuilder("node", "tests/fixture-server.mjs").directory(repo).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        server = process
        input = process.outputStream.writer()
        output = BufferedReader(InputStreamReader(process.inputStream))
        val ready = output.readLine() ?: error("fixture server did not start")
        base = TaskBridgeJson.parseToJsonElement(ready).let { (it as kotlinx.serialization.json.JsonObject)["base"].toString().trim('"') }
    }

    @AfterTest
    fun stop() {
        scope.cancel()
        http.close()
        server?.let {
            runCatching { input.close() }
            if (!it.waitFor(15, TimeUnit.SECONDS)) it.destroyForcibly()
        }
    }

    private fun api() = TaskBridgeApi(http, SimpleConnection(base, clientId = "android-itest"))

    private fun session(taskId: String) = ChatSession(api(), taskId, scope, ids = { UUID.randomUUID().toString() }, now = { java.time.Instant.now().toString() })

    private suspend fun ChatSession.await(what: String, timeoutMillis: Long = 20_000, check: (ChatSessionState) -> Boolean): ChatSessionState =
        kotlinx.coroutines.withTimeoutOrNull(timeoutMillis) {
            while (!check(state.value)) delay(50)
            state.value
        } ?: throw AssertionError(buildString {
            val s = state.value
            append("timed out: $what\n link=${s.link} loading=${s.loading} status=${s.task?.status} pending=${s.task?.pendingPrompts?.map { it.text }}\n outbox=${s.outbox}\n")
            s.chat.items.forEach { append("  ${it.id} ${(it as? ChatItem.User)?.text ?: (it as? ChatItem.Assistant)?.let { a -> "${a.text}|${a.status}|active=${a.active}|final=${a.final}" }}\n") }
        })

    private fun ChatSessionState.idle() = task != null && task.status in setOf("SUCCEEDED", "FAILED", "CANCELLED") && task.pendingPrompts.isEmpty()

    private fun ChatSessionState.users() = chat.items.filterIsInstance<ChatItem.User>()
    private fun ChatSessionState.answers() = chat.items.filterIsInstance<ChatItem.Assistant>()

    @Test
    fun deletingAnOpenSessionEndsWithDeletedAndNoError() = runBlocking<Unit> {
        if (!nodeAvailable) return@runBlocking
        val api = api()
        val task = api.createTask(CreateTaskRequest(projectId = "fixture", prompt = "Прочитай example.txt"))
        val chat = session(task.id)
        val effects = java.util.concurrent.CopyOnWriteArrayList<ru.arny.taskbridge.core.client.session.ChatEffect>()
        val collector = scope.launch { chat.effects.collect { effects += it } }
        chat.start()
        chat.await("answered") { it.link == LinkState.Live && it.idle() }

        chat.delete()
        withTimeout(20_000) { while (effects.none { it is ru.arny.taskbridge.core.client.session.ChatEffect.Deleted }) delay(50) }
        delay(1500)
        collector.cancel()
        assertEquals(emptyList(), effects.filterIsInstance<ru.arny.taskbridge.core.client.session.ChatEffect.Notice>().map { it.message })
        assertTrue(api.tasks().none { it.id == task.id }, "the session is gone on the server")
    }

    @Test
    fun aConversationWithQueueStopAndReconnect() = runBlocking<Unit> {
        if (!nodeAvailable) return@runBlocking
        val api = api()
        val task = api.createTask(CreateTaskRequest(projectId = "fixture", prompt = "Прочитай example.txt"))
        val chat = session(task.id)
        chat.start()

        // History and live stream: the first answer arrives with its tool call.
        var state = chat.await("first answer") { it.link == LinkState.Live && it.idle() && it.answers().firstOrNull()?.text?.isNotEmpty() == true }
        assertEquals("Прочитай example.txt", state.users().single().text)
        assertEquals("read", state.answers().single().tools.single().name)

        // A follow-up: optimistic bubble, then the server's, never two.
        chat.send("второй вопрос")
        state = chat.await("follow-up answered") { it.idle() && it.users().size == 2 && it.answers().size == 2 && it.answers().last().final && it.outbox.isEmpty() }
        assertEquals(listOf(false, false), state.users().map { it.pending })
        assertEquals("android-itest", state.users().last().clientId)

        // A long turn, and a message queued behind it: it waits in the server
        // queue (no bubble), then arrives as a normal message.
        chat.send("slow — долгий ход")
        chat.await("long turn running") { it.task?.status == "RUNNING" && it.users().size == 3 }
        chat.send("в очередь", mode = SendMode.QUEUE)
        state = chat.await("queued on the server") { s -> s.task?.pendingPrompts?.any { it.text.startsWith("в очередь") } == true }
        assertEquals(3, state.users().size, "a queued message has no bubble yet")

        // «Отправить сейчас» on the queued message: the long answer is cut and it goes out.
        val pendingId = state.task!!.pendingPrompts.single().id
        chat.sendPendingNow(pendingId)
        state = chat.await("queued message delivered", 30_000) { it.idle() && it.users().size == 4 }
        assertEquals("в очередь", state.users().last().text)

        // STOP clears the server queue by design (README, «STOP»): the UI warns before it.
        chat.send("slow — ещё один долгий")
        chat.await("second long turn running") { it.task?.status == "RUNNING" && it.users().size == 5 }
        chat.send("пропадёт при STOP", mode = SendMode.QUEUE)
        chat.await("queued again") { s -> s.task?.pendingPrompts?.isNotEmpty() == true }
        chat.cancel()
        state = chat.await("stopped", 30_000) { it.task?.status == "CANCELLED" && it.task.pendingPrompts.isEmpty() }
        assertEquals(5, state.users().size, "the queued message never reached the agent")

        // The server restarts: the chat reconnects and nothing is duplicated.
        val before = state.chat.items.map { it.id }
        input.write("restart\n")
        input.flush()
        withTimeout(30_000) { while (output.readLine() != "restarted") Unit }
        chat.reconnectNow()
        chat.await("reconnected") { it.link == LinkState.Live }
        chat.send("после рестарта")
        state = chat.await("answered after restart", 30_000) { it.idle() && it.users().size == 6 && it.answers().last().final }
        assertEquals(before, state.chat.items.map { it.id }.take(before.size), "old turns kept, in order, once")
        assertEquals(state.chat.items.map { it.id }.distinct(), state.chat.items.map { it.id })
        chat.close()
    }

    @Test
    fun attachmentsAndARejectedMessage() = runBlocking<Unit> {
        if (!nodeAvailable) return@runBlocking
        val api = api()
        val task = api.createTask(CreateTaskRequest(projectId = "fixture", prompt = "привет"))
        val chat = session(task.id)
        chat.start()
        chat.await("ready") { it.link == LinkState.Live && it.idle() }

        chat.send("посмотри файл", listOf(UploadFile("заметка.txt", "text/plain", "hello".toByteArray())))
        val state = chat.await("sent with a file") { it.idle() && it.users().size == 2 && it.outbox.isEmpty() }
        assertTrue(state.users().last().files.any { it.name == "заметка.txt" }, "the file travels with the message: ${state.users().last().files}")

        // The fake model rejects prompts containing "reject": the text comes back to the operator.
        chat.send("reject this")
        val failed = chat.await("refusal shown") { s -> s.outbox.any { it.status is ru.arny.taskbridge.core.client.session.OutgoingMessage.Status.Failed } }
        assertEquals("reject this", failed.outbox.single().text)
        assertTrue(failed.users().none { it.pending }, "no ghost bubble after a refusal")
        chat.close()
    }
}
