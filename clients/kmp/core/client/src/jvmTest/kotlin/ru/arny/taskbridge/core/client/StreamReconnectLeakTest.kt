package ru.arny.taskbridge.core.client

import com.sun.net.httpserver.HttpServer
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import java.net.InetSocketAddress
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.session.ChatSession

/**
 * S2-02: a closed SSE must release its HTTP exchange, and reconnect must never
 * run two sockets for one chat. The server counts handler entries/exits, so a
 * leak is visible as active > 1 or active != 0 after close.
 */
class StreamReconnectLeakTest {
    @Test
    fun twentyReconnectsNeverHoldTwoStreamsAndReleaseTheLastOne() = runBlocking<Unit> {
        val active = AtomicInteger(0)
        val maxActive = AtomicInteger(0)
        val streams = AtomicInteger(0)
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.executor = Executors.newCachedThreadPool()
        val json = "application/json"
        fun body(exchange: com.sun.net.httpserver.HttpExchange, text: String) {
            exchange.responseHeaders.add("Content-Type", json)
            val bytes = text.toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.createContext("/api/tasks/t/stream") { exchange ->
            streams.incrementAndGet()
            val current = active.incrementAndGet()
            maxActive.updateAndGet { maxOf(it, current) }
            try {
                exchange.responseHeaders.add("Content-Type", "text/event-stream")
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.write(": heartbeat\n\n".toByteArray())
                exchange.responseBody.flush()
                Thread.sleep(20)
            } finally {
                exchange.close()
                active.decrementAndGet()
            }
        }
        server.createContext("/api/tasks/t/events") { body(it, """{"events":[],"reachedStart":true}""") }
        server.createContext("/api/tasks/t") { body(it, """{"id":"t","status":"RUNNING"}""") }
        server.createContext("/api/health") { body(it, """{"status":"ok"}""") }
        server.createContext("/api/info") { body(it, """{"bootId":"b","storeId":"s"}""") }
        server.start()
        val base = "http://127.0.0.1:${server.address.port}"
        val http = HttpClient(OkHttp) { engine { config { readTimeout(0, TimeUnit.MILLISECONDS) } } }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val session = ChatSession(
            TaskBridgeApi(http, SimpleConnection(base)), "t", scope,
            ids = { "id" }, now = { "2026-11-22T00:00:00Z" }, initialStreamingEnabled = true,
        )
        try {
            session.start()
            withTimeout(90_000) { while (streams.get() < 20) delay(50) }
            assertEquals(1, maxActive.get(), "two SSE streams overlapped for one chat")
            session.close()
            withTimeout(15_000) { while (active.get() > 0) delay(50) }
            assertEquals(0, active.get(), "a closed SSE exchange remained open")
            assertTrue(streams.get() >= 20, "not enough reconnect cycles: ${streams.get()}")
        } finally {
            session.close()
            http.close()
            server.stop(0)
            scope.cancel()
        }
    }
}
