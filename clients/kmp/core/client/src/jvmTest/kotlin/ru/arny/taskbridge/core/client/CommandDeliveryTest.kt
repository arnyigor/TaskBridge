package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.session.CommandDelivery
import ru.arny.taskbridge.core.client.session.DeliveryOutcome
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class CommandDeliveryTest {
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
}
