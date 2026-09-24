package ru.arny.taskbridge.core.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// The HTTP contract of TaskBridge as the client reads it (docs/api-contract.md).
// The server may add fields at any time, so every class tolerates unknown keys
// and missing ones; statuses and event types stay strings with typed helpers,
// so a value this client does not know yet is carried, not rejected.

val TaskBridgeJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = true
}

@Serializable
data class ApiInfo(
    val name: String? = null,
    val apiVersion: Int = 0,
    val storeId: String? = null,
    val bootId: String? = null,
    val pi: PiInfo? = null,
    val warnings: List<ApiWarning> = emptyList(),
    val modelBusy: Boolean? = null,
    val modelReady: Boolean? = null,
    val addresses: List<ApiAddress> = emptyList(),
    val fileLimits: FileLimits? = null,
)

@Serializable
data class PiInfo(
    val version: String? = null,
    val supported: Boolean = false,
    val supportedRange: String? = null,
    val error: String? = null,
)

@Serializable
data class ApiWarning(val code: String? = null, val message: String? = null)

@Serializable
data class ApiAddress(val `interface`: String? = null, val ip: String? = null, val url: String? = null)

@Serializable
data class FileLimits(
    val count: Int = 10,
    val totalBytes: Long = 16L * 1024 * 1024,
    val uploadFileBytes: Long = 64L * 1024 * 1024,
    val uploadBytes: Long = 128L * 1024 * 1024,
)

@Serializable
data class AuthStatus(
    val authenticated: Boolean = false,
    val enabled: Boolean = false,
    val local: Boolean = false,
    val machine: Boolean = false,
)

@Serializable
data class Project(
    val id: String,
    val name: String? = null,
    val path: String? = null,
    val useWorktree: Boolean = false,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: id
}

@Serializable
data class ModelRef(
    val provider: String? = null,
    val id: String? = null,
    val name: String? = null,
    val contextWindow: Long? = null,
    val maxTokens: Long? = null,
    val reasoning: Boolean? = null,
    val images: Boolean? = null,
) {
    val label: String get() = name?.takeIf { it.isNotBlank() } ?: id ?: "—"
    val key: String get() = "${provider.orEmpty()}/${id.orEmpty()}"
}

@Serializable
data class ModelCatalog(
    val models: List<ModelRef> = emptyList(),
    val thinkingLevels: List<String> = emptyList(),
    val defaultModel: ModelRef? = null,
    val defaultThinkingLevel: String? = null,
)

@Serializable
data class FileRef(
    val id: String? = null,
    val name: String? = null,
    val size: Long? = null,
    val mimeType: String? = null,
    val path: String? = null,
)

@Serializable
data class PendingPrompt(
    val id: String,
    val text: String = "",
    val mode: String? = null,
    val files: List<FileRef> = emptyList(),
    val commandId: String? = null,
    val clientId: String? = null,
)

@Serializable
data class Usage(val input: Long? = null, val output: Long? = null, val totalTokens: Long? = null)

@Serializable
data class GenerationMetrics(val tg: Double? = null, val outputTokens: Long? = null, val ms: Long? = null)

@Serializable
data class CompactionInfo(val count: Int = 0)

@Serializable
data class Task(
    val id: String,
    val title: String? = null,
    val prompt: String? = null,
    val projectId: String? = null,
    val status: String = "QUEUED",
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val statusChangedAt: String? = null,
    val queueReason: String? = null,
    val current: String? = null,
    val error: String? = null,
    val errorCode: String? = null,
    val model: ModelRef? = null,
    val requestedModel: ModelRef? = null,
    val thinkingLevel: String? = null,
    val thinkingLevelActual: String? = null,
    val workspacePath: String? = null,
    val pendingPrompts: List<PendingPrompt> = emptyList(),
    val files: List<FileRef> = emptyList(),
    val outputFiles: List<FileRef> = emptyList(),
    val lastUsage: Usage? = null,
    val metrics: GenerationMetrics? = null,
    val compaction: CompactionInfo? = null,
    val autoCompactionEnabled: Boolean? = null,
    val sessionAvailable: Boolean? = null,
    val assistantText: String? = null,
    val thinkingText: String? = null,
    val retryable: Boolean? = null,
) {
    val taskStatus: TaskStatus get() = TaskStatus.from(status)

    /** What a list shows: the title if the operator gave one, else the first line of the prompt. */
    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: prompt?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()?.take(120)
            ?: "Сессия $id"
}

enum class TaskStatus(val active: Boolean, val terminal: Boolean) {
    QUEUED(true, false),
    PREPARING(true, false),
    PREFLIGHT(true, false),
    RUNNING(true, false),
    WAITING_USER(true, false),
    VERIFYING(true, false),
    CANCELLING(true, false),
    SUCCEEDED(false, true),
    FAILED(false, true),
    CANCELLED(false, true),
    UNKNOWN(false, false);

    companion object {
        fun from(value: String?): TaskStatus = entries.firstOrNull { it.name == value } ?: UNKNOWN
    }
}

@Serializable
data class TaskEvent(
    val taskId: String? = null,
    val seq: Long = 0,
    val at: String? = null,
    val type: String = "",
    val message: String? = null,
    val data: JsonObject = JsonObject(emptyMap()),
) {
    /** The raw Pi frame of a PI_EVENT. */
    val piFrame: JsonObject? get() = data["pi"] as? JsonObject

    fun string(key: String): String? = (data[key] as? JsonPrimitive)?.contentOrNull
}

/** GET /api/tasks/:id/events?tail= answers a window, not a bare list. */
@Serializable
data class EventWindow(val events: List<TaskEvent> = emptyList(), val reachedStart: Boolean = false)

@Serializable
data class CommandStatus(
    val commandId: String? = null,
    val status: String? = null,
    val done: Boolean = false,
    val clientId: String? = null,
)

@Serializable
data class Approval(
    val approvalId: String,
    val toolCallId: String? = null,
    val toolName: String? = null,
    val risk: String? = null,
    val detail: String? = null,
    val status: String? = null,
    val args: JsonElement? = null,
)

@Serializable
data class ToolOutput(
    val toolCallId: String? = null,
    val text: String = "",
    val bytes: Long = 0,
    val truncated: Boolean = false,
)

@Serializable
data class UploadResult(val token: String, val files: List<FileRef> = emptyList())

@Serializable
data class CreateTaskRequest(
    val projectId: String,
    val prompt: String,
    val title: String? = null,
    val model: ModelSelection? = null,
    val thinkingLevel: String? = null,
    val uploadToken: String? = null,
    val files: List<String>? = null,
    val commandId: String? = null,
    val clientId: String? = null,
)

@Serializable
data class ModelSelection(val provider: String?, val id: String)

@Serializable
data class MessageRequest(
    val text: String,
    val mode: String = "auto",
    val now: Boolean = false,
    val queue: Boolean = false,
    val uploadToken: String? = null,
    val files: List<String>? = null,
    val commandId: String? = null,
    val clientId: String? = null,
)

/** The id of Scratch: a session without a project. */
const val SCRATCH_PROJECT_ID = "__scratch__"

internal fun JsonElement?.stringOrNull(): String? = (this as? JsonPrimitive)?.contentOrNull

internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

internal fun JsonElement.asObjectOrNull(): JsonObject? = runCatching { jsonObject }.getOrNull()

internal fun JsonElement.asStringOrNull(): String? = runCatching { jsonPrimitive.contentOrNull }.getOrNull()
