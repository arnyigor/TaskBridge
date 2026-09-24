package ru.arny.taskbridge.core.client.chat

import ru.arny.taskbridge.core.api.FileRef

/** What the chat screen renders: immutable, rebuilt after every change. */
data class ChatSnapshot(
    val items: List<ChatItem> = emptyList(),
    val cursor: Long = 0,
    val version: Long = 0,
    /** The id of the newest answer: only it may be regenerated, continued or edited. */
    val newestAnswerId: String? = null,
)

sealed interface ChatItem {
    val id: String

    data class User(
        override val id: String,
        val text: String,
        val files: List<FileRef>,
        val at: String?,
        /** Shown before the server confirmed it. */
        val pending: Boolean,
        /** The device that sent it (web / android-… / desktop-… / cli), when known. */
        val clientId: String?,
        /** prompt / steer / follow_up. */
        val mode: String?,
        /** The id the history actions take (`user-12`, `user-initial`); null while pending. */
        val turnId: String?,
    ) : ChatItem

    data class Assistant(
        override val id: String,
        val text: String,
        val thinking: String,
        val tools: List<ToolCall>,
        /** Still being written: show the typing indicator. */
        val active: Boolean,
        /** RUNNING, DONE, SUCCEEDED, FAILED, CANCELLED… */
        val status: String,
        val error: String?,
        val final: Boolean,
        val at: String?,
        val endedAt: String?,
        /** The visible part of a turn cut by a history page. */
        val partial: Boolean,
        /** Pushed aside by a newer message before it finished. */
        val superseded: Boolean,
        val stopReason: String?,
        /** Set when the exchange has more than one answer (regenerated / edited). */
        val variants: VariantInfo?,
        /** Files the agent created or changed during this answer (OUTPUT_FILES). */
        val files: List<FileRef> = emptyList(),
    ) : ChatItem {
        val cutOff: Boolean get() = final && text.isBlank() && (superseded || status == "CANCELLED" || stopReason == "aborted")
    }

    data class Note(override val id: String, val text: String) : ChatItem
}

data class VariantInfo(val turnSeq: Long, val index: Int, val ids: List<String>) {
    val total: Int get() = ids.size

    /** The server's variant id of the answer at [position] (`assistant-<id>` → `<id>`). */
    fun variantIdAt(position: Int): String? = ids.getOrNull(position)?.removePrefix("assistant-")
}

data class ToolCall(
    val id: String,
    val name: String,
    val label: String?,
    val state: ToolState,
    /** A workspace file the tool touched that may be shown (never a private path). */
    val path: String?,
)

enum class ToolState {
    RUNNING, DONE, ERROR, INTERRUPTED;

    companion object {
        fun of(value: String) = when (value) {
            "done" -> DONE
            "error" -> ERROR
            "interrupted" -> INTERRUPTED
            else -> RUNNING
        }
    }
}
