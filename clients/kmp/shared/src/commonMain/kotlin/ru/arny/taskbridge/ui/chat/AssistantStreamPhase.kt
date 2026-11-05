package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.client.chat.ChatItem

/** Model output phase, separate from the execution of an already generated tool. */
internal fun assistantStreamPhaseLabel(answer: ChatItem.Assistant): String = when {
    answer.generatingToolCall -> "Модель формирует вызов инструмента"
    answer.text.isNotBlank() -> "Получаем ответ модели"
    answer.thinking.isNotBlank() -> "Получаем размышления модели"
    else -> "Сообщение передано · ожидается ответ агента"
}
