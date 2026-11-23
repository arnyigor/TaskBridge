// Единый источник правды для жизненного цикла хода чата и UI-состояния.
//
// Зачем модуль существует. Состояние одного хода раньше жило одновременно в
// `task.status`, `task._turnPhase`, `runtime.retired/cancelRequested`, слотах
// `activeTaskIds` и очереди, причём каждая ветка чистила свои флаги сама.
// STOP ставил `retired = true`, `pi.on('close')` из-за этого выходил раньше
// очистки, и сессия оставалась с `_compacting = true` и мёртвым runtime в Map —
// «сжимается контекст» поверх уже остановленного чата.
//
// Здесь собраны ровно четыре вещи, которые обязаны быть в одном экземпляре:
//   1. `resetTaskRuntimeFlags` — единственная точка сброса временных полей задачи;
//   2. `retireTaskRuntime`    — единственный способ списать Pi (флаги → Map → флаги
//                               задачи → killTree), безопасный при любом порядке close;
//   3. `canAcceptPiFrame`     — запрет поздним кадрам Pi воскрешать остановленный ход;
//   4. `deriveChatUiContract` — проекция `task.ui`, по которой ВСЕ клиенты
//                               (Web, KMP Desktop, KMP Android) биндят кнопки и
//                               анимации. Клиент не угадывает состояние по шести
//                               флагам, а читает один объект.

export const TERMINAL_STATUSES = Object.freeze(new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']));

export const ACTIVE_STATUSES = Object.freeze(new Set([
  'QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'
]));

const PHASE_LABELS = Object.freeze({
  idle: '',
  queued: 'В очереди',
  preparing: 'Подготовка рабочей папки',
  preflight: 'Проверка модели',
  dispatching: 'Отправка запроса в Pi…',
  waiting_model: 'Ждём первый ответ модели…',
  provider_wait: 'Ждём провайдера…',
  streaming: 'Модель отвечает',
  tool: 'Выполняется инструмент',
  compacting: 'Сжимается контекст…',
  waiting_user: 'Ждёт вашего подтверждения',
  verifying: 'Сохранение результата…',
  cancelling: 'Останавливаю…',
});

/**
 * Единственная точка сброса временного состояния runtime на задаче.
 *
 * Вызывается при любом списании/закрытии Pi: STOP, crash, restartSession,
 * retireRuntime, deleteTask. Гарантирует, что после остановки не останутся
 * зависшие `_compacting` / `_toolsRunning` / `providerWait` / `_starting`.
 */
export function resetTaskRuntimeFlags(task) {
  if (!task) return;
  task.piPid = null;
  task.piStartedAt = null;
  task._toolsRunning = 0;
  task._compacting = false;
  task._compactingSince = 0;
  task._compactionStage = null;
  task._starting = false;
  task.providerWait = null;
  task._modelFrameAt = 0;
}

/**
 * Безопасное списание runtime: флаги → отвязка от Map → сброс полей задачи → killTree.
 *
 * Два инварианта, из-за отсутствия которых STOP «залипал»:
 *   • runtime снимается с Map ДО первого `await`. Пока ждали killTree, `#ensureSession`
 *     успевал выдать тот же самый списанный runtime новому сообщению — и оно уходило
 *     в процесс, который через миг умирал.
 *   • флаги задачи чистятся здесь же, а не в `pi.on('close')`: у `retired`-процесса
 *     обработчик close обязан молчать (иначе он «оживит» уже отменённый ход), значит
 *     уборка не может жить только в нём.
 *
 * `runtime` передаётся явно, когда списывается конкретный процесс: за время остановки
 * сессию мог забрать НОВЫЙ runtime (доставка из очереди во время финализации STOP).
 * Тогда ни Map, ни флаги задачи не трогаются — это уже другой ход.
 */
export async function retireTaskRuntime({ task, runtimes, resolveSettle, kill = true, runtime = null }) {
  const target = runtime || runtimes?.get(task.id) || null;
  const current = runtimes?.get(task.id) || null;
  const superseded = current != null && current !== target;
  if (target) {
    target.cancelRequested = true;
    target.retired = true;
    if (runtimes && !superseded && runtimes.get(task.id) === target) runtimes.delete(task.id);
  }
  if (!superseded) {
    resetTaskRuntimeFlags(task);
    task._lastPiExitAt = Date.now();
  }
  if (target && kill) {
    await target.pi.killTree().catch(() => {});
  }
  resolveSettle?.(task.id);
  return target;
}

/**
 * Допустимо ли входящему Pi-кадру менять статус задачи.
 *
 * Блокирует «воскрешение» отменённого хода: STOP ставит `retired`, но кадры,
 * отправленные Pi до смерти процесса, ещё летят. `agent_start` такого кадра
 * раньше выставлял `task.status = 'RUNNING'` напрямую — чат после нажатого STOP
 * снова начинал «работать».
 */
export function canAcceptPiFrame(task, runtime) {
  if (!task || !runtime) return false;
  if (runtime.retired || runtime.cancelRequested) return false;
  if (task.status === 'CANCELLING') return false;
  return true;
}

/**
 * Единая проекция состояния для UI всех клиентов (Web, KMP Desktop, KMP Android).
 *
 * Вычисляется детерминированно из фактического состояния задачи и runtime:
 * кнопки и анимации не могут разойтись, потому что у них один источник.
 * `liveRuntime` обязателен: `_compacting`/`_toolsRunning`/`providerWait` имеют
 * смысл только пока жив процесс, который их объявил.
 */
export function deriveChatUiContract(task, { liveRuntime = false, hasPendingWork = false, seq = 0 } = {}) {
  const status = task?.status || 'SUCCEEDED';
  const pendingCount = Array.isArray(task?.pendingPrompts) ? task.pendingPrompts.length : 0;
  const terminal = TERMINAL_STATUSES.has(status);
  const compacting = Boolean(task?._compacting) && liveRuntime;
  const toolsRunning = liveRuntime ? Math.max(0, Number(task?._toolsRunning) || 0) : 0;
  const providerWait = liveRuntime ? (task?.providerWait || null) : null;
  const turnPhase = task?._turnPhase || null;

  let phase = 'idle';
  if (status === 'CANCELLING') {
    phase = 'cancelling';
  } else if (status === 'WAITING_USER') {
    phase = 'waiting_user';
  } else if (status === 'VERIFYING') {
    phase = 'verifying';
  } else if (status === 'PREPARING') {
    phase = 'preparing';
  } else if (status === 'PREFLIGHT') {
    phase = 'preflight';
  } else if (status === 'QUEUED') {
    phase = 'queued';
  } else if (status === 'RUNNING') {
    if (compacting) phase = 'compacting';
    else if (providerWait) phase = 'provider_wait';
    else if (toolsRunning > 0) phase = 'tool';
    else if (turnPhase === 'DISPATCHING') phase = 'dispatching';
    else if (turnPhase === 'ACKED' || !task?._modelFrameAt) phase = 'waiting_model';
    else phase = 'streaming';
  } else if (compacting) {
    phase = 'compacting';
  }

  // VERIFYING — работа: ответ модели готов, но сервер ещё собирает diff/outputs.
  // Поэтому busy, а не «готово»; кнопки истории закрыты до терминального события.
  const busy = !terminal || compacting;
  // STOP доступен всегда, пока есть активная работа, сжатие, зависшая отмена или
  // незавершённая доставка (иначе оператору нечем разблокировать залипший чат).
  const canStop = busy || Boolean(task?.inFlightPrompt) || hasPendingWork;
  // Редактировать/перегенерировать/удалять историю можно ТОЛЬКО в чистом
  // терминальном состоянии: иначе кнопка отвечает «Сессия сейчас работает».
  const canEditHistory = terminal && !compacting && !task?.inFlightPrompt && pendingCount === 0;
  const sendAction = status === 'CANCELLING'
    ? 'disabled'
    : (busy ? 'queue' : 'send');

  return {
    phase,
    busy,
    // Точки набора только там, где модель действительно отвечает. В VERIFYING и
    // WAITING_USER их нет: ответ уже пришёл или ход стоит на решении оператора.
    typing: ['preparing', 'preflight', 'dispatching', 'waiting_model', 'streaming'].includes(phase),
    canStop,
    canSend: sendAction !== 'disabled',
    sendAction,
    canEditHistory,
    pendingCount,
    label: PHASE_LABELS[phase] || '',
    seq: Number(seq || 0),
  };
}
