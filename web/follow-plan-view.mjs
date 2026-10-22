// Follow Plan в интерфейсе: что именно показывать и что делает каждая кнопка.
//
// Вынесено из app.js, потому что ошибаются здесь тихо: карточка показывает
// «выполняется», хотя цикл на паузе; выключение переключателя убивает ход вместо
// паузы; кнопка «Продолжить» доступна при незавершённом конфликте ревизий.
// Проверяется без DOM и сети — tests/web-follow-plan-view.test.mjs.

export const PLAN_MODE_LABEL = 'По плану';

export const PLAN_STATE_LABELS = Object.freeze({
  NOT_ATTACHED: 'план не подключён',
  IDLE: 'готов к запуску',
  RUNNING_STEP: 'выполняется шаг',
  REVIEWING: 'проверка результата',
  PAUSED_REVIEW: 'нужен разбор',
  PAUSED: 'пауза',
  COMPLETED: 'план завершён'
});

const ACTIVE = new Set(['RUNNING_STEP', 'REVIEWING']);

/** Строка карточки: `PLAN.md • 3/7 • выполняется шаг S-004`. */
export function planHeadline(status) {
  if (!status || status.attached === false) return 'План не подключён';
  const progress = status.progress ? `${status.progress.done}/${status.progress.total}` : '—';
  const state = PLAN_STATE_LABELS[status.state] || status.state || 'состояние неизвестно';
  const step = status.stepId && ACTIVE.has(status.state) ? ` ${status.stepId}` : '';
  return `${status.path || 'PLAN.md'} • ${progress} • ${state}${step}`;
}

/** Последнее, что стоит показать про находки: сначала блокирующие. */
export function planFindingsLine(status) {
  const findings = Array.isArray(status?.findings) ? status.findings : [];
  const open = findings.filter(finding => finding.state === 'OPEN');
  if (!open.length) return '';
  const sorted = [...open].sort((a, b) => String(a.priority).localeCompare(String(b.priority)));
  const first = sorted[0];
  const more = sorted.length > 1 ? ` (+${sorted.length - 1})` : '';
  return `${first.priority} ${first.summary}${more}`;
}

/**
 * Кнопки карточки. `Продолжить` — единственный запуск модели; `Пауза после шага`
 * ставит паузу на безопасной границе; `STOP сейчас` — отдельное действие и
 * никогда не прячется за переключателем.
 */
export function planActions(status, { enabled = true } = {}) {
  const state = status?.state || 'NOT_ATTACHED';
  const attached = Boolean(status?.attached);
  const active = ACTIVE.has(state);
  const blocked = state === 'PAUSED_REVIEW' || Boolean(status?.conflict) || Boolean(status?.fileError);
  return [
    {
      id: 'start',
      label: state === 'COMPLETED' ? 'Завершён' : attached ? 'Продолжить' : 'Старт',
      disabled: !enabled || !attached || active || state === 'COMPLETED' || Boolean(status?.conflict) || Boolean(status?.fileError),
      title: !attached ? 'Сначала подключите файл плана' : active ? 'Шаг уже выполняется' : 'Отправить следующий шаг'
    },
    {
      id: 'pause',
      label: 'Пауза после шага',
      disabled: !enabled || !active,
      title: active ? 'Текущий шаг доиграет, следующий не будет отправлен' : 'Пауза возможна только во время шага'
    },
    {
      id: 'stop',
      label: 'STOP сейчас',
      disabled: !enabled || (!active && state !== 'PAUSED_REVIEW'),
      title: 'Остановить ход и оставить план на разбор'
    },
    {
      id: 'open',
      label: 'Открыть план',
      disabled: !attached,
      title: status?.path || 'Файл плана не подключён'
    },
    { id: 'reconcile', label: 'Принять файл', disabled: !enabled || !attached || !blocked, title: 'Принять версию файла с диска и снять конфликт' },
    {
      id: 'edit',
      label: 'Изменить план',
      disabled: !enabled || !attached,
      title: 'Править файл плана в проекте'
    }
  ];
}

/** Модель карточки; `visible:false` — места в чате не занимает. */
export function planCardModel(status, options = {}) {
  if (!status || status.attached === false) {
    return { visible: false, headline: 'План не подключён', goal: '', findings: '', conflict: null, error: null, actions: [] };
  }
  const conflict = status.conflict
    ? 'Файл плана изменён снаружи: примите его версию или верните свою'
    : null;
  const error = status.fileError ? `${status.fileError.message}` : null;
  return {
    visible: true,
    headline: planHeadline(status),
    state: status.state,
    goal: status.goal || '',
    findings: planFindingsLine(status),
    conflict,
    error,
    actions: planActions(status, options)
  };
}

/**
 * Что означает выключение переключателя. Во время шага это ПАУЗА на безопасной
 * границе, никогда не STOP: ход не обрывается.
 */
export function toggleOffAction(status) {
  return ACTIVE.has(status?.state) ? 'pause' : 'none';
}

/** Первое включение: путь к файлу плана внутри проекта. */
export function planPathProblem(value) {
  const text = String(value || '').trim();
  if (!text) return 'Укажите путь к файлу плана, например docs/PLAN.md';
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\')) return 'Путь должен быть относительным, внутри проекта';
  if (!/\.md$/i.test(text)) return 'План — это Markdown-файл (*.md)';
  return null;
}

/** Тело запроса на запуск: ревизия едет с командой, чтобы CAS сработал. */
export function planRequestBody(status, extra = {}) {
  return {
    ...(Number.isInteger(status?.revision) ? { expectedRevision: status.revision } : {}),
    ...extra
  };
}

const NOTICES = {
  PLAN_ATTACHED: 'План подключён',
  PLAN_STEP_STARTED: 'Шаг отправлен',
  PLAN_STEP_CHECKPOINT: 'Контрольная проверка',
  PLAN_REVISED: 'План обновлён',
  PLAN_PAUSED: 'Цикл на паузе',
  PLAN_COMPLETED: 'План завершён',
  PLAN_CONFLICT: 'Конфликт ревизий'
};

/** Короткая строка для ленты по событию Follow Plan; null — событие не наше. */
export function planEventNotice(event) {
  if (!event || typeof event.type !== 'string' || !event.type.startsWith('PLAN_')) return null;
  const title = NOTICES[event.type] || event.type;
  const detail = String(event.message || '').trim();
  return detail && !detail.includes(title) ? `${title}: ${detail}` : title;
}

/** События, после которых серверное состояние карточки надо перечитать. */
export const PLAN_EVENT_TYPES = Object.freeze(Object.keys(NOTICES));
