package ru.arny.taskbridge.core.api

import kotlinx.serialization.Serializable

// Every failure the client can meet, by the server's stable `code` rather than
// its text (docs/api-contract.md, «Ошибка»). The UI decides what to show from
// the type; `message` is the server's human sentence, already in Russian.
sealed class ApiError(open val message: String) {
    /** The session (or another resource) does not exist. */
    data class NotFound(override val message: String) : ApiError(message)

    /** The route does not exist: this client and the server speak different API versions. */
    data class RouteNotFound(override val message: String) : ApiError(message)

    /** Pairing needed (server.auth.enabled and no valid session cookie). */
    data class AuthRequired(override val message: String) : ApiError(message)

    /** The model or the session is busy; the request was valid, just not now. */
    data class Busy(val code: String, override val message: String) : ApiError(message)

    /** The same commandId was already used with a different body. Never retry. */
    data class CommandConflict(override val message: String) : ApiError(message)

    /** The same command is still being processed; repeat later to read its result. */
    data class CommandInFlight(override val message: String) : ApiError(message)

    /** The server crashed while handling this command; check the history before re-sending. */
    data class UnknownAfterCrash(override val message: String) : ApiError(message)

    data class InputInvalid(override val message: String) : ApiError(message)

    data class Forbidden(val code: String?, override val message: String) : ApiError(message)

    data class RateLimited(override val message: String) : ApiError(message)

    /** The daemon cannot be reached at all (no network, wrong address, it is down). */
    data class Unreachable(override val message: String, val cause: Throwable? = null) : ApiError(message)

    /** Anything else, kept with its status and code for the log. */
    data class Other(val status: Int, val code: String?, override val message: String) : ApiError(message)

    /** Worth retrying automatically (with backoff) without asking the operator. */
    val transient: Boolean
        get() = this is Unreachable || this is RateLimited || this is CommandInFlight || (this is Other && status >= 500)
}

class ApiException(val error: ApiError) : Exception(error.message)

@Serializable
internal data class ErrorEnvelope(val error: String? = null, val code: String? = null)

/**
 * Maps a non-2xx answer to [ApiError]. The route-404 and the resource-404 share
 * the code NOT_FOUND; the route one is recognised by its exact text "Not found",
 * which is what the contract tells clients to rely on.
 */
fun apiErrorOf(status: Int, body: String?): ApiError {
    val envelope = body?.let { runCatching { TaskBridgeJson.decodeFromString(ErrorEnvelope.serializer(), it) }.getOrNull() }
    val code = envelope?.code
    val message = envelope?.error?.takeIf { it.isNotBlank() } ?: "HTTP $status"
    return when {
        status == 404 && envelope?.error == "Not found" -> ApiError.RouteNotFound(message)
        code == "NOT_FOUND" || status == 404 -> ApiError.NotFound(message)
        code == "AUTH_REQUIRED" || status == 401 -> ApiError.AuthRequired(message)
        code == "CONFLICT" -> ApiError.CommandConflict(message)
        code == "ACCEPTED" -> ApiError.CommandInFlight(message)
        code == "UNKNOWN_AFTER_CRASH" -> ApiError.UnknownAfterCrash(message)
        code == "INPUT_INVALID" -> ApiError.InputInvalid(message)
        code == "RATE_LIMITED" || status == 429 -> ApiError.RateLimited(message)
        status == 409 -> ApiError.Busy(code ?: "BUSY", message)
        status == 403 -> ApiError.Forbidden(code, message)
        else -> ApiError.Other(status, code, message)
    }
}
