package ru.arny.taskbridge.core.client.chat

import ru.arny.taskbridge.core.api.FileRef
import ru.arny.taskbridge.core.api.TurnMetrics

/** What the chat screen renders: immutable, rebuilt after every change. */
data class ChatSnapshot(
    val items: List<ChatItem> = emptyList(),
    val cursor: Long = 0,
    val version: Long = 0,
    /** Session-level MCP notice moved out of the message timeline. */
    val mcpNotice: String? = null,
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
        val delivery: String = "Передано агенту",
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
        /** Server answer identity and full text, even for a visual compact segment. */
        val canonicalId: String = id,
        val canonicalText: String = text,
        /** Only the last nonempty segment exposes history actions and variants. */
        val segmentActions: Boolean = true,
        /** Токены ответа, сложенные по всем вызовам модели внутри него (Pi usage). */
        val usage: AnswerUsage? = null,
        /** Модель, которой считались деньги; null — ответ до сбора usage. */
        val usageModel: String? = null,
        /** Explicit server knowledge, not a guess based on a model name. */
        val usageIsLocal: Boolean? = null,
        /** Метрики хода: длительность, TTFT и скорость генерации — считались сервером. */
        val turnMetrics: TurnMetrics? = null,
        /** Сколько сегментов хода суммировано в [turnMetrics] («Продолжить»); 0 или 1 — один. */
        val metricsSegments: Int = 0,
        /** Arguments are still streaming; this is not tool execution yet. */
        val generatingToolCall: Boolean = false,
    ) : ChatItem {
        val cutOff: Boolean get() = final && text.isBlank() && (superseded || status == "CANCELLED" || stopReason == "aborted")
    }

    data class Note(override val id: String, val text: String) : ChatItem
}

/**
 * Токены одного ответа: попадания в кэш, обычный вход, вывод и запись в кэш.
 *
 * Поля nullable намеренно: «провайдер не сообщил число» и «провайдер сообщил 0» —
 * разные факты, и таблица под ответом показывает их по-разному (неизвестную
 * строку скрывает, известный ноль показывает).
 */
data class AnswerUsage(
    val hit: Long? = null,
    val miss: Long? = null,
    val out: Long? = null,
    /** Запись в кэш — платная величина, но в сумму токенов хода не входит. */
    val cacheWrite: Long? = null,
    /** Provider total disagrees with complete validated components. The UI still uses the components. */
    val totalMismatch: Boolean = false,
) {
    /** Сумма только известных слагаемых; cacheWrite в неё не входит. null — складывать нечего. */
    val total: Long?
        get() {
            val known = listOfNotNull(hit, miss, out).filter { it >= 0 }
            if (known.isEmpty()) return null
            var sum = 0L
            for (value in known) {
                if (value > Long.MAX_VALUE - sum) return null
                sum += value
            }
            return sum
        }

    /** Расхода не было: ни входа, ни выхода (пустой usage прерванного вызова). */
    val isEmpty: Boolean get() = listOfNotNull(hit, miss, out, cacheWrite).none { it > 0 }

    operator fun plus(other: AnswerUsage?): AnswerUsage {
        if (other == null) return this
        return AnswerUsage(
            hit = add(hit, other.hit),
            miss = add(miss, other.miss),
            out = add(out, other.out),
            cacheWrite = add(cacheWrite, other.cacheWrite),
            totalMismatch = totalMismatch || other.totalMismatch,
        )
    }

    private fun add(a: Long?, b: Long?): Long? = when {
        a == null -> b
        b == null -> a
        a < 0 || b < 0 || a > Long.MAX_VALUE - b -> null
        else -> a + b
    }
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
    val progress: String? = null,
    /** A compact diff-like preview for edit/write tools, built from the tool arguments. */
    val changePreview: String? = null,
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
