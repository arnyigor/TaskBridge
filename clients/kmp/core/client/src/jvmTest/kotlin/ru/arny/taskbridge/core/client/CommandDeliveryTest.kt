package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.session.CommandDelivery
import ru.arny.taskbridge.core.client.session.DeliveryOutcome

class CommandDeliveryTest {
    @Test
    fun sessionBusyIsRetriedInsteadOfFailingTheOutboxEntry() = runBlocking<Unit> {
        // Отмена ещё не отправленного сообщения не снимает серверный слот #admit:
        // мгновенный повтор получает BUSY («Другой запрос ещё отправляется»).
        // Это переходящая ошибка — повтор с короткой паузой, а не красный отказ.
        var calls = 0
        val http = HttpClient(MockEngine {
            if (calls++ == 0) respond("{\"error\":\"Другой запрос этой сессии ещё отправляется.\",\"code\":\"BUSY\"}",
                HttpStatusCode.Conflict, headersOf(HttpHeaders.ContentType, "application/json"))
            else respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        })
        try {
            val delivery = CommandDelivery(TaskBridgeApi(http, SimpleConnection("http://pc")), "t") { _, _ -> 0L }
            val result = delivery.run<Unit>("c", { _, _ -> }) { }
            assertEquals(DeliveryOutcome.Delivered(Unit), result)
        } finally { http.close() }
    }

    @Test
    fun cancellationDuringHistoryReconciliationIsNeverConvertedIntoUnknownOutcome() = runBlocking<Unit> {
        val http = HttpClient(MockEngine { throw CancellationException("history cancelled") })
        try {
            val delivery = CommandDelivery(TaskBridgeApi(http, SimpleConnection("http://pc")), "t") { _, _ -> 0L }
            assertFailsWith<CancellationException> {
                delivery.run<Unit>("c", { _, _ -> }) { throw ApiException(ApiError.UnknownAfterCrash("unknown")) }
            }
        } finally { http.close() }
    }

    @Test
    fun recordedCommandIsConfirmedWithoutRepeatingItsEffect() = runBlocking<Unit> {
        val http = HttpClient(MockEngine {
            respond("""[{"taskId":"t","seq":1,"type":"USER_MESSAGE","data":{"commandId":"c"}}]""",
                HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        })
        try {
            val delivery = CommandDelivery(TaskBridgeApi(http, SimpleConnection("http://pc")), "t") { _, _ -> 0L }
            for (error in listOf(ApiError.UnknownAfterCrash("unknown"), ApiError.UnknownOutcome("not persisted"))) {
                var effects = 0
                val result = delivery.run<Unit>("c", { _, _ -> }) {
                    effects += 1
                    throw ApiException(error)
                }
                assertEquals(DeliveryOutcome.Confirmed, result)
                assertEquals(1, effects)
            }
        } finally { http.close() }
    }

    @Test
    fun aTransientOutageIsRetriedByTimeNotBySixAttempts() = runBlocking<Unit> {
        // S2: 30 s outage. The old policy stopped after six attempts (~25 s), so a
        // message typed during a normal reconnect window became Failed. Eight
        // Unreachable failures must still end in Delivered once the server is back.
        val http = HttpClient(MockEngine { respond("{}", HttpStatusCode.OK) })
        try {
            val delivery = CommandDelivery(TaskBridgeApi(http, SimpleConnection("http://pc")), "t", 10_000) { _, _ -> 1L }
            var calls = 0
            val result = delivery.run<Unit>("c", { _, _ -> }) {
                calls += 1
                if (calls <= 8) throw ApiException(ApiError.Unreachable("down"))
            }
            assertEquals(DeliveryOutcome.Delivered(Unit), result)
            assertEquals(9, calls)
        } finally { http.close() }
    }
}
