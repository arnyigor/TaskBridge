package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.TurnState
import ru.arny.taskbridge.core.client.chat.ChatItem

/** Model output phase, separate from the execution of an already generated tool. */
internal fun assistantStreamPhaseLabel(answer: ChatItem.Assistant, turnState: TurnState? = null): String = when {
    answer.generatingToolCall -> "Модель формирует вызов инструмента"
    answer.text.isNotBlank() -> "Получаем ответ модели"
    answer.thinking.isNotBlank() -> "Получаем размышления модели"
    turnState?.phase == "DISPATCHING" -> "Передаём запрос в Pi"
    turnState?.phase == "ACKED" -> "Pi принял запрос"
    turnState?.waitingModelMs != null ->
        "Запрос у провайдера модели · ждём первый токен ${mmss(turnState.waitingModelMs)}"
    // Кадры Pi идут, но видимого вывода ещё нет: скорее всего скрытые размышления.
    turnState != null -> "Модель отвечает без видимого вывода (возможно, скрытые размышления)"
    else -> "Сообщение передано · ожидается ответ агента"
}

/** M:SS without hours: banners show waits shorter than an hour. */
internal fun mmss(ms: Long): String = "${ms / 60000}:${(ms % 60000 / 1000).toString().padStart(2, '0')}"
