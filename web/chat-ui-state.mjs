// Единая проекция состояния UI чата для Web.
//
// Зачем модуль существует. Анимации и кнопки в web/app.js читали пять разных
// источников, которые обновлялись в разное время:
//   • точки набора — из ChatState (SSE, задержка 80 мс);
//   • полоса активности (#activity) — из currentTask.status/turnState (GET раз в 2 с);
//   • STOP — из stopTarget(), который сначала смотрел устаревший lastTasks;
//   • SEND — из setBusy() на время HTTP-запроса;
//   • кнопки на сообщениях — из turn.active, снятого по agent_settled, пока сервер
//     ещё в VERIFYING.
// Согласовать их было физически нельзя. Здесь все пять решений принимает одна
// чистая функция, а SSE сразу правит локальный снимок задачи, не дожидаясь опроса.

import { ACTIVE_STATUSES } from './chat-state.mjs';

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/**
 * Слияние снимка задачи с учётом курсора SSE (chatCursor).
 *
 * Если SSE уже доставил более новые события (chatCursor > next.snapshotSeq),
 * устаревший ответ GET /api/tasks/:id не имеет права откатывать статус/фазу хода:
 * опоздавший GET с `RUNNING` перетирал уже пришедший `TASK_CANCELLED`, и чат
 * «оживал» после STOP.
 */
export function mergeTaskSnapshot(prev, next, chatCursor = 0) {
  if (!next) return prev;
  if (!prev) return next;
  const prevSeq = Math.max(Number(prev.snapshotSeq) || 0, Number(chatCursor) || 0);
  const nextSeq = Number(next.snapshotSeq) || 0;
  // Сервер без версии (старый сбор) — прежнее поведение.
  if (prevSeq > 0 && nextSeq > 0 && nextSeq < prevSeq) {
    return {
      ...next,
      snapshotSeq: prevSeq,
      status: prev.status,
      current: prev.current,
      turnState: prev.turnState ?? next.turnState,
      runtime: prev.runtime ?? next.runtime,
      ui: prev.ui ?? next.ui,
    };
  }
  return next;
}

/**
 * Обновляет локальный снимок задачи прямо из SSE-события, не дожидаясь GET-опроса.
 * Это убирает 2-секундный лаг между анимацией в ленте и кнопкой STOP / полосой
 * активности: событие уже пришло, значит состояние уже известно.
 */
export function applyEventToTaskSnapshot(task, event) {
  if (!task || !event || (event.taskId && event.taskId !== task.id)) return task;
  const nextSeq = Math.max(Number(task.snapshotSeq) || 0, Number(event.seq) || 0);
  const next = { ...task, snapshotSeq: nextSeq };

  if (event.type === 'STATUS' && event.data?.status) {
    next.status = event.data.status;
    next.current = event.message || next.current;
    next.statusChangedAt = event.at || next.statusChangedAt;
    // Смена статуса снимает ожидание провайдера только на терминальном событии;
    // здесь достаточно не тащить его в следующую фазу, если пришёл TASK_*.
  } else if (event.type === 'TASK_SUCCEEDED') {
    next.status = 'SUCCEEDED';
    next.current = 'Done';
    next.providerWait = null;
    next.turnState = { ...(next.turnState || {}), phase: 'SETTLED' };
  } else if (event.type === 'TASK_FAILED') {
    next.status = 'FAILED';
    next.error = event.message || next.error;
    next.providerWait = null;
    next.turnState = { ...(next.turnState || {}), phase: 'FAILED' };
  } else if (event.type === 'TASK_CANCELLED') {
    next.status = 'CANCELLED';
    next.current = 'Cancelled';
    next.providerWait = null;
    next.turnState = { ...(next.turnState || {}), phase: 'CANCELLED' };
  } else if (event.type === 'TURN_STATE' && event.data?.phase) {
    next.turnState = {
      ...(next.turnState || {}),
      phase: event.data.phase,
      stage: event.data.stage ?? next.turnState?.stage ?? null,
      lastProgressAt: event.data.lastProgressAt ?? event.at ?? next.turnState?.lastProgressAt ?? null,
    };
  } else if (event.type === 'PI_EVENT') {
    const pi = event.data?.pi;
    if (pi?.type === 'agent_start' && !TERMINAL_STATUSES.has(next.status) && next.status !== 'CANCELLING') {
      next.status = 'RUNNING';
      next.current = 'Pi is working';
    }
    if (pi?.type === 'compaction_start' || pi?.type === 'auto_compaction_start') {
      next.runtime = { ...(next.runtime || {}), activity: 'compacting' };
    }
    if (pi?.type === 'compaction_end' || pi?.type === 'auto_compaction_end') {
      if (next.runtime?.activity === 'compacting') {
        next.runtime = { ...next.runtime, activity: null };
      }
    }
  } else if (event.type === 'RUNTIME_STATE' && event.data?.to) {
    next.runtime = {
      ...(next.runtime || {}),
      state: event.data.to,
      activity: event.data.toActivity ?? null,
      ...(event.data.compactingSince ? { compactingSince: event.data.compactingSince } : {}),
    };
  }
  return next;
}

/**
 * Единая чистая модель UI чата.
 *
 * Из результата этой функции синхронно обновляются:
 *  - кнопка STOP
 *  - кнопка SEND
 *  - анимация точек (•••)
 *  - полоса активности (#activity)
 *  - видимость кнопок Edit/Delete/Regen/Fork
 */
export function deriveChatUiState({
  selectedTaskId,
  currentTask,
  allTasks = [],
  chatState = null,
  sending = false,
  locallyQueuedCount = 0,
  hasFailedSend = false,
} = {}) {
  // 1. Всегда доверяем currentTask для выбранной сессии, а НЕ устаревшему lastTasks:
  // refreshTask() зовёт renderTaskDetails() (обновляет STOP) ДО loadTasks(), так
  // что кнопка STOP всё время отставала на один цикл опроса.
  const selected = currentTask && currentTask.id === selectedTaskId
    ? currentTask
    : allTasks.find(t => t.id === selectedTaskId) || null;

  const serverUi = selected?.ui || null;
  const status = selected?.status || null;
  const terminal = Boolean(status && TERMINAL_STATUSES.has(status));

  const selectedWorking = Boolean(
    selected && (
      serverUi
        ? serverUi.busy
        : (status === 'CANCELLING' || ACTIVE_STATUSES.has(status) || selected.runtime?.activity === 'compacting')
    )
  );

  // Другая работающая сессия: если выбранная простаивает, STOP всё равно может
  // остановить её (оператор видит «работает» в списке и жмёт ту же кнопку).
  const otherWorking = !selectedWorking
    ? (allTasks.find(t => t.id !== selectedTaskId && t.status === 'RUNNING')
      || allTasks.find(t => t.id !== selectedTaskId && (t.status === 'CANCELLING' || ACTIVE_STATUSES.has(t.status)))
      || null)
    : null;

  // Зависшая отправка — независимый повод для STOP: сообщение не уходит, сессия
  // уже терминальна, и без этого оператору нечем разблокироваться (2026-10-14).
  const hasLocalStuck = locallyQueuedCount > 0 || hasFailedSend;
  const stopTask = selectedWorking
    ? selected
    : (hasLocalStuck && selected ? selected : otherWorking);

  // VERIFYING/CANCELLING/WAITING_USER — не «модель отвечает»: точки набора там
  // были бы ложью (ответ уже пришёл / ход стоит на решении оператора).
  const typingSuppressed = status === 'VERIFYING' || status === 'CANCELLING' || status === 'WAITING_USER';
  // Локально активный ход — это НОВОЕ сообщение (оптимистичный пузырь или steer):
  // его анимация не должна зависеть от того, что снимок задачи ещё показывает
  // терминальный статус прошлого хода. А завершённый пустой ход active=false, так
  // что «Ответ не был получен.» анимацией не подменяется.
  const localActive = Boolean(chatState?.current?.active);
  const showTyping = Boolean(
    selected && !typingSuppressed && (
      sending
      || (serverUi ? serverUi.typing : selectedWorking)
      || localActive
    )
  );

  // Редактировать историю можно ТОЛЬКО когда сервер в терминальном статусе
  // (НЕ в VERIFYING: иначе кнопка Edit отвечает «Сессия сейчас работает»).
  const canEditHistory = Boolean(
    selected
    && !sending
    && (serverUi ? serverUi.canEditHistory : (terminal && !selectedWorking))
  );

  const canSend = !sending && status !== 'CANCELLING';
  const sendWillQueue = Boolean(selected && selectedWorking);

  return {
    selected,
    selectedWorking,
    stopTarget: stopTask,
    canStop: Boolean(stopTask),
    canSend,
    sendWillQueue,
    showTyping,
    canEditHistory,
    showActivity: Boolean(selected && selectedWorking),
  };
}
