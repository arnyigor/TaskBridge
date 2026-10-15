package ru.arny.taskbridge.core.client.session

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.TaskBridgeApi

internal sealed interface DeliveryOutcome<out T> {
    data class Delivered<T>(val value: T) : DeliveryOutcome<T>
    data object Confirmed : DeliveryOutcome<Nothing>
    data object Unknown : DeliveryOutcome<Nothing>
    data class Refused(val error: ApiError) : DeliveryOutcome<Nothing>
}

/** Network/reconciliation policy only: no reducer, cache, composer or UI state. */
internal class CommandDelivery(
    private val api: TaskBridgeApi,
    private val taskId: String,
    private val retryDelay: (Int, Long) -> Long,
) {
    suspend fun <T> run(
        commandId: String,
        onRetry: (Int, String) -> Unit,
        block: suspend () -> T,
    ): DeliveryOutcome<T> {
        var attempt = 0
        var inFlightChecks = 0
        while (true) {
            try {
                return DeliveryOutcome.Delivered(block())
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: ApiException) {
                val error = failure.error
                when {
                    error is ApiError.CommandInFlight -> {
                        inFlightChecks += 1
                        onRetry(inFlightChecks, "Сервер принял команду, ожидается подтверждение агента")
                        if (inFlightChecks >= 30) return DeliveryOutcome.Unknown
                        delay(1_000)
                        val status = optional { api.commandStatus(commandId) }
                        if (status?.done == true && status.status == "COMPLETED") return DeliveryOutcome.Confirmed
                    }
                    error is ApiError.UnknownAfterCrash || error is ApiError.UnknownOutcome -> {
                        val landed = optional {
                            api.events(taskId, 0, 0).any { it.type == "USER_MESSAGE" && it.string("commandId") == commandId }
                        } == true
                        return if (landed) DeliveryOutcome.Confirmed else DeliveryOutcome.Unknown
                    }
                    error.transient && attempt < 6 -> {
                        attempt += 1
                        onRetry(attempt, error.message)
                        delay(retryDelay(attempt + 1, 1_000))
                    }
                    else -> return DeliveryOutcome.Refused(error)
                }
            }
        }
    }

    private suspend fun <T> optional(block: suspend () -> T): T? = try {
        block()
    } catch (cancel: CancellationException) {
        throw cancel
    } catch (_: Throwable) {
        null
    }
}
