package ru.arny.taskbridge.core.client.session

import kotlinx.serialization.Serializable
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskEvent

@Serializable
data class CachedChat(
    val task: Task,
    val events: List<TaskEvent>,
    val reachedStart: Boolean,
)

@Serializable
data class PersistedOutgoing(
    val commandId: String,
    val text: String,
    val fileNames: List<String> = emptyList(),
    val mode: String,
)

/** Durable per-server client state. Implementations must replace files atomically. */
interface ChatPersistence {
    suspend fun loadChat(taskId: String): CachedChat?
    suspend fun saveChat(taskId: String, value: CachedChat)
    suspend fun loadOutbox(taskId: String): List<PersistedOutgoing>
    suspend fun saveOutbox(taskId: String, values: List<PersistedOutgoing>)
    suspend fun clear(taskId: String)
}

object NoopChatPersistence : ChatPersistence {
    override suspend fun loadChat(taskId: String): CachedChat? = null
    override suspend fun saveChat(taskId: String, value: CachedChat) = Unit
    override suspend fun loadOutbox(taskId: String): List<PersistedOutgoing> = emptyList()
    override suspend fun saveOutbox(taskId: String, values: List<PersistedOutgoing>) = Unit
    override suspend fun clear(taskId: String) = Unit
}
