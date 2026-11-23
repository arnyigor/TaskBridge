package ru.arny.taskbridge.core.client.chat

import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.TaskUiState
import ru.arny.taskbridge.core.client.session.ChatSessionState
import ru.arny.taskbridge.core.client.session.LinkState
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.core.client.sessions.displayStateOf
import ru.arny.taskbridge.core.client.sessions.stageLabel

/**
 * Единственная модель управления UI чата.
 *
 * ВСЕ кнопки (SEND, «Вклиниться», STOP, Edit/Delete/Regen/Fork) и ВСЕ анимации
 * (точки набора, спиннер остановки, статус в шапке) читают ТОЛЬКО этот объект.
 * Раньше то же решение принималось в шести местах по разным правилам — `working`,
 * `historyLocked`, `canStop(...)`, `generating`, `item.active/final` и
 * двенадцативеточный `when` диагностики, — и они физически не могли совпадать.
 */
data class ChatUiState(
    /** Сессия занята работой (включая VERIFYING / COMPACTING / CANCELLING / WAITING_USER). */
    val busy: Boolean,
    /** Идёт остановка (нажали STOP и ждём ответа или TASK_CANCELLED). */
    val stopping: Boolean,
    /** Показывать анимацию набора (•••) в текущем ответе. */
    val showTyping: Boolean,
    /** Кнопка STOP активна. */
    val canStop: Boolean,
    /** Можно отправлять сообщения (в очередь или сразу). */
    val canSend: Boolean,
    /** Новое сообщение по Enter встанет в очередь (не показывать оптимистичный пузырь в ленте!). */
    val sendWillQueue: Boolean,
    /** Показывать кнопку «Вклиниться сейчас» — только пока идёт генерация/инструмент. */
    val canSteer: Boolean,
    /** Доступны действия переписывания истории (Edit / Delete / Regen / Fork / Continue / Clear). */
    val canEditHistory: Boolean,
    /** Доступно ручное сжатие контекста. */
    val canCompact: Boolean,
    /** Короткая подпись состояния для шапки и полосы активности. */
    val statusLabel: String,
    /** Статус для цветной точки в шапке. */
    val displayState: DisplayState,
)

private val TERMINAL = setOf("SUCCEEDED", "FAILED", "CANCELLED")
private val STEERABLE_PHASES = setOf("streaming", "tool", "waiting_model", "dispatching")
private val NON_TYPING_PHASES = setOf("verifying", "waiting_user", "provider_wait")

fun deriveChatUiState(state: ChatSessionState): ChatUiState {
    val task = state.task
    val status = task?.status
    val display = task?.let(::displayStateOf) ?: DisplayState.UNKNOWN
    val serverUi: TaskUiState? = task?.ui
    val linkDead = (state.link as? LinkState.Failed)?.error is ApiError.NotFound

    val stopping = "cancel" in state.busy || status == "CANCELLING" || serverUi?.phase == "cancelling"
    val compacting = task?.runtime?.activity == "compacting" || serverUi?.phase == "compacting"
    val terminal = status in TERMINAL

    // Сервер отдал контракт и он не старше локального курсора — верим серверу.
    // Иначе (старый сервер) считаем то же самое локально, чтобы поведение не
    // зависело от версии сервера.
    val serverAuthoritative = serverUi != null && (serverUi.seq == 0L || serverUi.seq >= state.chat.cursor)

    val busy = when {
        stopping -> true
        serverAuthoritative -> serverUi!!.busy
        else -> (status != null && !terminal) || compacting
    }

    val hasActiveAnswer = state.chat.items.any { it is ChatItem.Assistant && it.active }
    // Локально активный ход — НОВОЕ сообщение (оптимистичный пузырь/steer): его
    // анимация не зависит от того, что снимок задачи ещё показывает терминальный
    // статус прошлого хода. Завершённый пустой ответ active=false, поэтому
    // «Ответ не был получен.» анимацией не подменяется.
    val showTyping = when {
        stopping -> false
        serverAuthoritative -> serverUi!!.typing || (hasActiveAnswer && serverUi.phase !in NON_TYPING_PHASES)
        else -> hasActiveAnswer && status != "VERIFYING" && status != "WAITING_USER" && status != "CANCELLING"
    }

    // STOP доступен, пока есть работа, зависшая отправка или непустая очередь:
    // иначе оператору нечем разблокировать залипший чат.
    val canStop = !linkDead && (
        busy ||
            state.outbox.isNotEmpty() ||
            (task?.pendingPrompts?.isNotEmpty() == true) ||
            (serverAuthoritative && serverUi!!.canStop)
        )

    val canSend = !linkDead && !stopping && (!serverAuthoritative || serverUi!!.canSend)
    val sendWillQueue = busy || status == "QUEUED"

    val canSteer = !stopping && if (serverAuthoritative) {
        serverUi!!.phase in STEERABLE_PHASES
    } else {
        status == "RUNNING" && !compacting && task?.providerWait == null
    }

    // Редактировать/удалять/перегенерировать можно ТОЛЬКО когда сервер гарантированно
    // в терминале: не во время VERIFYING, не во время COMPACTING, не при непустом
    // outbox/pendingPrompts (иначе кнопка отвечает «Сессия сейчас работает»).
    val canEditHistory = !linkDead &&
        !stopping &&
        !busy &&
        state.outbox.isEmpty() &&
        (task?.pendingPrompts?.isEmpty() != false) &&
        (!serverAuthoritative || serverUi!!.canEditHistory)

    val canCompact = !linkDead && !stopping && !busy && task?.sessionAvailable != false

    val statusLabel = when {
        stopping -> "Останавливаю…"
        serverAuthoritative && serverUi!!.label.isNotBlank() -> serverUi.label
        display.active -> stageLabel(status)
        else -> display.label
    }

    return ChatUiState(
        busy = busy,
        stopping = stopping,
        showTyping = showTyping,
        canStop = canStop,
        canSend = canSend,
        sendWillQueue = sendWillQueue,
        canSteer = canSteer,
        canEditHistory = canEditHistory,
        canCompact = canCompact,
        statusLabel = statusLabel,
        displayState = display,
    )
}
