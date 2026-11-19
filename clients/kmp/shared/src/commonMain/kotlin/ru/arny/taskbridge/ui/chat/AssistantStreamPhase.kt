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
    // Кадры Pi идут, но видимого вывода нет. Наличие живого кадра не означает,
    // что модель уже отвечает: кадром может быть системное событие, старт хода
    // или работа инструментов — причину не утверждаем.
    turnState != null -> "Pi обрабатывает запрос · ждём ответ модели"
    else -> "Сообщение передано · ожидается ответ агента"
}

/** M:SS without hours: silence display waits shorter than an hour. */
internal fun mmss(ms: Long): String = "${ms / 60000}:${(ms % 60000 / 1000).toString().padStart(2, '0')}"
