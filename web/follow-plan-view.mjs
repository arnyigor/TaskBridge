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
  enabled = enabled && status?.enabled !== false;
  const state = status?.state || 'NOT_ATTACHED';
  const attached = Boolean(status?.attached);
  const active = ACTIVE.has(state);
  const blocked = state === 'PAUSED_REVIEW' || Boolean(status?.conflict) || Boolean(status?.fileError);
  return [
    {
      id: 'start',
      label: state === 'COMPLETED' ? 'Завершён' : attached ? 'Продолжить' : 'Старт',
      // A finished file has nothing to start: the button must not offer it
      // (reported: 2/2 DONE still showed «Начать выполнение»).
      disabled: !enabled || !attached || active || state !== 'IDLE' || status?.file?.open === 0
        || Boolean(status?.conflict) || Boolean(status?.fileError),
      title: !attached ? 'Сначала подключите файл плана' : active ? 'Шаг уже выполняется' : 'Отправить следующий шаг'
    },
    { id: 'resume', label: 'Продолжить', disabled: !enabled || !attached || state !== 'PAUSED' || blocked, title: 'Продолжить после паузы' },
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
    { id: 'reconcile', label: 'Принять файл', disabled: !enabled || !attached || active || !blocked, title: 'Принять версию файла с диска и снять конфликт' },
    {
      id: 'edit',
      label: 'Изменить план',
      disabled: !enabled || !attached || active,
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

/**
 * Что показывает сама иконка (карточки в чате больше нет). Состояние кодируется
 * цветом, а подробности — в диалоге: чат не должен занимать место под планом.
 */
export function planIconState(status) {
  if (!status || status.attached !== true) return 'off';
  // Ошибка файла и конфликт — это поломка, а не «нужен разбор»: красный цвет
  // должен значить «сломано». Разбор посреди рабочего цикла — жёлтый (живой
  // отчёт 2026-10-28: план шёл, 4 из 73, а иконка горела красным).
  if (status.conflict || status.fileError) return 'error';
  switch (status.state) {
    case 'RUNNING_STEP':
    case 'REVIEWING': return 'running';
    case 'PAUSED':
    case 'PAUSED_REVIEW': return 'attention';
    case 'COMPLETED': return 'completed';
    case 'IDLE': return 'idle';
    default: return 'idle';
  }
}

export const PLAN_ICON_TITLES = Object.freeze({
  off: 'По плану: выбрать файл плана',
  idle: 'По плану: готов к запуску',
  running: 'По плану: шаг выполняется',
  attention: 'По плану: шаг ждёт разбора',
  error: 'По плану: ошибка файла плана',
  completed: 'По плану: план завершён'
});

/**
 * Значок строки шага: состояние видно с одного взгляда, а не вычитывается из
 * слова в конце строки. `current` — шаг, который выполняется прямо сейчас.
 */
export function planStepMark(step, currentStepId = null) {
  const status = String(step?.status || '');
  if (status === 'DONE') return '✓';
  if (status === 'SKIPPED') return '»';
  if (status === 'BLOCKED') return '!';
  if (status === 'IN_PROGRESS' || (currentStepId && step?.id === currentStepId)) return '●';
  return '○';
}

/** Заголовок списка шагов: «закрыто 4 из 73 · сейчас S-005». */
export function planStepsSummary(status) {
  const total = (status?.steps || []).length;
  const done = (status?.steps || []).filter(step => step.status === 'DONE').length;
  if (!total) return '';
  const current = status?.stepId ? ` · сейчас ${status.stepId}` : '';
  return `закрыто ${done} из ${total}${current}`;
}

/**
 * Планы проекта для выбора: оператор не должен вбивать путь руками, но и файл,
 * которого нет в листинге (слишком глубокая папка, лимит выдачи), должен
 * оставаться доступным — поэтому список дополняет поле ввода, а не заменяет его.
 */
export function planFileChoices(listing, { limit = 200 } = {}) {
  const entries = Array.isArray(listing?.entries) ? listing.entries : [];
  return entries
    .filter(entry => entry?.isFile !== false)
    .filter(entry => /\.md$/i.test(String(entry?.path || '')))
    // The name is derived from the path: a listing entry without `name` must not
    // turn into an empty button.
    .map(entry => ({ path: String(entry.path), name: String(entry.path).split('/').pop() }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, limit);
}

/**
 * Состояние переключателя. Выключенный на сервере режим не исчезает молча: тогда
 * человек видит «функции нет» и не понимает, что её надо включить в конфигурации.
 */
export function planToggleState(status) {
  if (!status) return { visible: true, enabled: false, hint: null };
  const enabled = status.enabled !== false;
  return {
    visible: true,
    enabled,
    hint: enabled ? null : 'режим выключен в конфигурации сервера'
  };
}

/**
 * Планы проекта по папкам: на телефоне список путей без папок не отвечает на
 * вопрос «какой файл выбрать». Корень проекта идёт первым, дальше — по алфавиту.
 */
export function planFileGroups(listing) {
  const groups = new Map();
  for (const file of planFileChoices(listing)) {
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(file);
  }
  return [...groups.entries()]
    .map(([folder, files]) => ({ folder, files }))
    .sort((a, b) => (a.folder === '' ? -1 : b.folder === '' ? 1 : a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

export function planRequestBody(status, extra = {}) {
  return {
    ...(Number.isInteger(status?.revision) ? { expectedRevision: status.revision } : {}),
    ...extra
  };
}

const STAGE_LABELS = Object.freeze({
  RUNNING: 'Pi работает',
  DISPATCHING: 'Pi работает',
  ACKED: 'запрос принят',
  PROGRESS: 'ответ идёт',
  SETTLED: 'ход завершён',
  PAUSED: 'пауза',
  SUCCEEDED: 'готово',
  FAILED: 'ошибка хода',
  CANCELLED: 'отменено'
});

/** Одно главное действие на состояние (UI-02 §6). */
export function planPrimaryAction(status) {
  const state = status?.attached === true ? status.state : 'NOT_ATTACHED';
  if (status?.conflict) return { id: 'reconcile', label: 'Обновить и сверить' };
  switch (state) {
    // FP-UX-04A: стартовое состояние предлагает поиск по проекту первым,
    // системный выбор файла остаётся вторым и никуда не делся.
    case 'NOT_ATTACHED': return { id: 'scan', label: 'Сканировать проект' };
    case 'IDLE': return { id: 'start', label: 'Начать выполнение' };
    case 'RUNNING_STEP':
    case 'REVIEWING': return { id: 'pause', label: 'Пауза после шага' };
    case 'PAUSED': return { id: 'resume', label: 'Продолжить' };
    case 'PAUSED_REVIEW': return { id: 'reconcile', label: 'Разобрать результат' };
    case 'COMPLETED': return { id: 'open', label: 'Открыть результат' };
    default: return { id: 'refresh', label: 'Проверить состояние' };
  }
}

/** Строка состояния в диалоге: статус, ревизия, шаги, цикл, шаг, стадия. */
export function planMetaLine(status) {
  if (!status || status.attached !== true) return '';
  const parts = [];
  parts.push(PLAN_STATE_LABELS[status.state] || status.state || '—');
  if (Number.isInteger(status.revision)) parts.push(`revision ${status.revision}`);
  if (status.progress) parts.push(`шагов ${status.progress.done}/${status.progress.total}`);
  if (status.cycleNumber) parts.push(`цикл ${status.cycleNumber}`);
  if (status.stepId) parts.push(`шаг ${status.stepId}`);
  // The session stage matters only while this plan drives it: on an idle plan
  // «ответ идёт» (another turn of the same session) reads like a lie.
  if (status.stage && (status.state === 'RUNNING_STEP' || status.state === 'REVIEWING')) {
    parts.push(STAGE_LABELS[status.stage] || String(status.stage));
  }
  return parts.join(' • ');
}

export const VERIFICATION_LABELS = Object.freeze({
  SYSTEM_VERIFIED: 'подтверждено системой',
  MANUAL_ACCEPTED: 'принято вручную',
  MODEL_REPORTED: 'заявлено моделью',
  UNVERIFIED: 'без подтверждения'
});

export const verificationText = level => VERIFICATION_LABELS[level] || null;

/** Текущий шаг: название, статус и последнее подтверждённое подтверждение. */
export function planCurrentStep(status) {
  const steps = Array.isArray(status?.steps) ? status.steps : [];
  const current = steps.find(step => step.id === status?.stepId)
    || steps.find(step => step.status === 'IN_PROGRESS' || step.status === 'BLOCKED')
    || steps.find(step => step.status === 'TODO')
    || steps[steps.length - 1];
  if (!current) return null;
  return {
    id: current.id, title: current.title || '', status: current.status, result: current.result || '',
    // How the result was established: a system fact, an operator's acceptance or
    // the model's own word (FP-UX-02F).
    verification: current.verification || null
  };
}

/** Находки: сколько требующих решения и сколько просто записей. */
export function planFindingsSummary(status) {
  const findings = Array.isArray(status?.findings) ? status.findings : [];
  const open = findings.filter(finding => finding.state === 'OPEN');
  return {
    blocking: open.filter(finding => finding.priority === 'P0' || finding.priority === 'P1').length,
    notes: open.filter(finding => finding.priority === 'P2' || finding.priority === 'P3').length,
    items: open
  };
}

/** Ошибка — словами и с лечением, а не общее «не удалось выполнить действие». */
export function planErrorText(error) {
  // A plain string is already the server's sentence: show it as it is, without the
  // transport's "CODE: " prefix (the reason is named below anyway).
  if (typeof error === 'string') return error.replace(/^[A-Z_]+:\s*/, '');
  const code = error?.code || null;
  const detail = String(error?.message || '').replace(/^[A-Z_]+:\s*/, '');
  switch (code) {
    case 'PLAN_API_UNAVAILABLE':
      return 'Сервер не поддерживает этот Follow Plan API. Обновите сервер и повторите подключение.';
    case 'PLAN_CONNECTION_LOST':
      return 'Соединение с сервером потеряно. Восстановите соединение и повторите действие; черновик сохранён.';
    case 'PLAN_INVALID':
      return `Файл не соответствует формату плана. ${detail}`.trim();
    case 'PLAN_REVISION_CONFLICT':
      return `Файл плана изменён вне TaskBridge. Сверьте версии и примите файл с диска. ${detail}`.trim();
    case 'PLAN_UNKNOWN_OUTCOME':
      return `Неизвестно, чем закончился прошлый ход: автоматический повтор запрещён. Проверьте состояние. ${detail}`.trim();
    case 'PLAN_NO_PROGRESS':
      return `Нет подтверждённого прогресса — проверьте текущий шаг и критерии. ${detail}`.trim();
    case 'PLAN_BUDGET_EXCEEDED':
      return `Достигнут лимит автоматических циклов или времени — нужно ваше решение. ${detail}`.trim();
    case 'FOLLOW_PLAN_DISABLED':
      return 'Режим «По плану» выключен в конфигурации сервера (followPlan.enabled).';
    case 'PLAN_BLOCKED':
      return `Выполнение остановлено: ${detail || 'шаг заблокирован'}`;
    case 'PLAN_FILE_EXISTS':
      return `В проекте уже есть такой файл с другим содержимым. Подтвердите перезапись. ${detail}`.trim();
    case 'PLAN_ALREADY_ATTACHED':
      // Never detach for the operator: the running plan may still be needed.
      return detail || 'Уже подключён другой план. Откройте его панель управления и отключите его, если нужно заменить.';
    case 'PLAN_NOT_ATTACHED':
      return `План не подключён. ${detail}`.trim();
    default:
      return detail || 'Действие не выполнено.';
  }
}

/** Что показывать после проверки выбранного файла. */
export function planInspectionText(inspection) {
  if (!inspection) return '';
  if (inspection.managed) {
    return `Управляемый план: ${inspection.steps} шаг(ов), revision ${inspection.revision}.`;
  }
  const steps = inspection.preview?.steps?.length || 0;
  return `Обычный Markdown: будет импортировано шагов — ${steps}. Файл не изменяется до подтверждения.`;
}

/**
 * Что показать сразу после выбора файла (FP-UX-03): имя, куда он попадёт на
 * сервере, чем закончилась проверка формата и нужна ли отдельная кнопка.
 * `uploaded` — файл пришёл с устройства, значит он будет записан в проект.
 */
export function planSelectionView(inspection, { uploaded = false, attached = false } = {}) {
  if (!inspection) return null;
  const name = String(inspection.path || '').split('/').pop() || '';
  const problems = Array.isArray(inspection.problems) ? inspection.problems : [];
  const managed = inspection.managed === true;
  const previewSteps = inspection.preview?.steps?.length || 0;
  const format = problems.length
    ? `Формат: ${problems[0]}`
    : managed
      ? `Формат: управляемый план, ${inspection.steps} шаг(ов), revision ${inspection.revision}.`
      : `Формат: обычный Markdown, шагов для импорта — ${previewSteps}.`;
  const target = uploaded
    ? `Будет сохранён в проекте: ${inspection.path}`
    : `Файл в проекте: ${inspection.path}`;
  // A second file never replaces the active plan on its own, and a free-form
  // Markdown is converted only after an explicit confirmation.
  const replaces = Boolean(inspection.replaces);
  // Nothing is active: the first managed file connects at once. Anything that
  // would change an active plan (or a free-form Markdown) waits for a click.
  const needsConfirm = true; // Show destination and validate before the explicit Connect click.
  const confirmLabel = replaces ? 'Заменить план' : managed ? 'Подключить' : 'Импортировать и подключить';
  return { name, target, format, needsConfirm, confirmLabel, managed, replaces, problems };
}

const NOTICES = {
  PLAN_ATTACHED: 'План подключён',
  PLAN_STEP_STARTED: 'Шаг отправлен',
  // «Checkpoint получен» — не «шаг закрыт»: исход приходит отдельным событием.
  PLAN_STEP_CHECKPOINT: 'Checkpoint получен',
  PLAN_CHECKPOINT_APPLIED: 'Checkpoint применён',
  PLAN_CHECKPOINT_RECEIVED: 'Checkpoint принят без изменений',
  PLAN_CHECKPOINT_REJECTED: 'Checkpoint не применён',
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

/* ---------------- FP-UX-04: сканирование, вердикт, ИИ ---------------- */

export const PLAN_VERDICT_LABELS = Object.freeze({
  VALID_MANAGED: 'Готов к подключению',
  CONVERTIBLE: 'Требует преобразования',
  NOT_A_PLAN: 'Это не план',
  INVALID: 'Файл непригоден'
});

/** Подписи предварительной классификации в списке найденных файлов. */
export const PLAN_SCAN_HINTS = Object.freeze({
  VALID_MANAGED: 'управляемый план',
  CONVERTIBLE: 'нужен импорт'
});

/**
 * Что показать в списке найденного. Размер и дата — только чтобы отличить
 * «сегодняшний черновик» от архивного файла, поэтому формат короткий.
 */
export function planScanRows(scan, { query = '', limit = 200 } = {}) {
  const files = Array.isArray(scan?.files) ? scan.files : [];
  const needle = String(query || '').trim().toLowerCase();
  // Фильтр считаем на клиенте по уже полученному списку: каждое нажатие клавиши
  // не должно быть новым сканированием проекта.
  const shown = needle
    ? files.filter(file => `${file.path || ''} ${file.name || ''}`.toLowerCase().includes(needle))
    : files;
  return shown.slice(0, limit).map(file => {
    const relative = String(file.path || '');
    const name = String(file.name || relative.split('/').pop() || '');
    const folder = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    return {
      path: relative,
      name,
      folder,
      hint: PLAN_SCAN_HINTS[file.classification] || '',
      size: Number.isFinite(file.size) ? `${Math.max(1, Math.round(file.size / 1024))} КБ` : ''
    };
  });
}

/** Строка под полем поиска: сколько показано, полный ли это результат. */
export function planScanStatusLine(scan, shownCount) {
  if (!scan) return '';
  const total = Number.isFinite(scan.total) ? scan.total : (scan.files?.length || 0);
  const parts = [`найдено файлов: ${total}`];
  if (shownCount !== total) parts.push(`показано ${shownCount}`);
  if (scan.partial) parts.push('результат неполный: достигнут лимит глубины, количества или времени');
  if (Array.isArray(scan.skippedLinks) && scan.skippedLinks.length) {
    parts.push(`ссылок пропущено: ${scan.skippedLinks.length}`);
  }
  return parts.join(' • ');
}

/** Пустое состояние списка: «ничего не найдено» — не то же, что «не сканировали». */
export function planScanEmptyText(scan, query = '') {
  if (!scan) return 'Файлы проекта не сканировались.';
  const count = Array.isArray(scan.files) ? scan.files.length : 0;
  if (!count) return 'В проекте не найдено ни одного Markdown-файла (.md или .markdown).';
  return `По запросу «${String(query).trim()}» ничего не найдено — измените поиск или повторите сканирование.`;
}

/**
 * Вердикт выбранного файла словами и с решением: подключать, преобразовывать или
 * отказать. Решение принимает сервер (`classifyPlan`), здесь только формулировка.
 */
export function planVerdictView(inspection) {
  if (!inspection) return null;
  const verdict = inspection.verdict
    || (inspection.managed ? 'VALID_MANAGED' : inspection.preview ? 'CONVERTIBLE' : 'NOT_A_PLAN');
  const reasons = [
    ...(inspection.problems || []),
    ...((inspection.preview?.problems) || [])
  ].filter(Boolean).slice(0, 4);
  const steps = inspection.managed ? (inspection.steps || 0) : (inspection.preview?.steps?.length || 0);
  const hint = String(inspection.reason || '').trim();
  return {
    verdict,
    label: PLAN_VERDICT_LABELS[verdict] || verdict,
    hint,
    reasons,
    steps,
    // Подключать можно только то, что прошло структурную проверку. «Это не план»
    // и «файл непригоден» — отказ, а не повод попробовать всё равно.
    canAttach: verdict === 'VALID_MANAGED' || verdict === 'CONVERTIBLE',
    confirmLabel: verdict === 'CONVERTIBLE' ? 'Импортировать и подключить'
      : inspection.replaces ? 'Заменить план' : 'Подключить',
    // Предпросмотр будущего управляемого файла: показывается, но не пишется.
    preview: verdict === 'CONVERTIBLE' ? (inspection.preview?.content || '') : ''
  };
}

/** Что сделает «Проверить с помощью ИИ» и чем это не является. */
export function planAiReviewView(review, error = null) {
  if (error) return { ok: false, text: planErrorText(error) };
  if (!review) return null;
  const model = review.model || {};
  const verdict = review.ai?.verdict || 'UNCLEAR';
  const label = verdict === 'PLAN' ? 'модель считает, что это план'
    : verdict === 'NOT_PLAN' ? 'модель считает, что это не план'
      : 'модель не уверена';
  const reasons = (review.ai?.reasons || []).filter(Boolean);
  // Конфиденциальность: куда ушёл текст — часть ответа, а не мелкий шрифт.
  const where = model.id
    ? `Спрошена модель ${model.provider ? `${model.provider}/` : ''}${model.id}${model.local ? ' (локальная, текст не покидал машину)' : ' (облачный провайдер: текст ушёл наружу)'}`
    : '';
  return {
    ok: true,
    verdict,
    text: [label, ...reasons.map(reason => `— ${reason}`), where, review.truncated ? 'в модель ушло только начало файла' : '']
      .filter(Boolean).join('\n'),
    // Совет не заменяет структурную проверку: вердикт сервера показывается рядом.
    structural: review.structural?.verdict || null
  };
}

/** Ошибки ИИ-проверки не должны звучать как ошибки плана. */
export function planAiErrorText(error) {
  const code = error?.code || null;
  const detail = String(error?.message || '').replace(/^[A-Z_]+:\s*/, '');
  if (code === 'AI_RATE_LIMITED') return detail || 'Проверка ИИ не чаще трёх раз в минуту.';
  if (code === 'AI_UNAVAILABLE') return detail || 'Модель недоступна — обычная проверка формата работает без неё.';
  return planErrorText(error);
}
