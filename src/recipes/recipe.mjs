// Run Recipes (ROADMAP_FULL.md, MR-05).
//
// A recipe is HOW to do the work; a schedule (MR-06) is WHEN; an invocation is the
// fact that it ran. Keeping the three apart is what lets the same recipe be started
// by hand, by the scheduler, from the phone or by an event without a second code
// path — so nothing about a concrete run is stored here.
//
// Parameters are the useful half: `{{area}}` in the prompt is a dropdown on the
// phone instead of a wall of text. Substitution is deliberately NOT a template
// engine: only the fields listed in SUBSTITUTABLE are rendered, and a placeholder
// that is not declared in the schema is refused when the recipe is saved (a typo
// must fail while the operator is looking at it, not at 03:00).

export const PARAMETER_TYPES = Object.freeze(['string', 'enum', 'boolean', 'number']);

/** Where `{{parameter}}` may appear. Anything else is data, never a template. */
export const SUBSTITUTABLE = Object.freeze([
  'promptTemplate',
  'runtime.model',
  'runtime.thinking',
  'verification.command',
]);

/**
 * Настройки, которые рецепт НЕ применяет (AUTO-01A, находка A1 из
 * docs/auto-00-audit.md): `runRecipe` передаёт в `createTask` только projectId,
 * prompt, title, model и thinkingLevel. Обещанное, но не исполняемое поле хуже
 * отсутствующего — поэтому они не сохраняются, а отклоняются при записи, пока в
 * исполнении не появится то, что их исполняет.
 */
export const UNSUPPORTED_SETTINGS = Object.freeze({
  context: 'сборки контекста (work item, recap, память) при запуске рецепта нет',
  workspace: 'отдельной рабочей папки или worktree на запуск рецепта нет',
  limits: 'ограничения времени на запуск рецепта нет',
});

/** Единственное ядро, которое TaskBridge запускает (OMP — NO-GO, см. docs/omp-02b-ast-tools.md). */
export const SUPPORTED_ENGINES = Object.freeze(['pi']);

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const NAME_LIMIT = 200;
const TEMPLATE_LIMIT = 8000;
const PARAMETER_LIMIT = 30;

const invalid = (message) => Object.assign(new Error(message), { code: 'INPUT_INVALID' });

/** Every placeholder used in a string, in order, without duplicates. */
export function placeholdersIn(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(PLACEHOLDER)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/**
 * Validates the parameter schema. A parameter is a name plus a type; enums carry
 * their values, and a default must be of the declared type (otherwise the phone
 * would offer a value the recipe refuses).
 */
export function normalizeParameters(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw invalid('Параметры — объект с описаниями.');
  const entries = Object.entries(input);
  if (entries.length > PARAMETER_LIMIT) throw invalid(`Параметров не больше ${PARAMETER_LIMIT}.`);
  const out = {};
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(name)) throw invalid(`Некорректное имя параметра: ${name}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`Параметр ${name} описывается объектом.`);
    const type = String(raw.type ?? 'string');
    if (!PARAMETER_TYPES.includes(type)) throw invalid(`Тип параметра ${name} — один из: ${PARAMETER_TYPES.join(', ')}.`);
    const description = raw.description === undefined || raw.description === null ? null : String(raw.description).slice(0, 300);
    if (type === 'enum') {
      const values = Array.isArray(raw.values) ? raw.values.map(value => String(value)).filter(Boolean).slice(0, 50) : [];
      if (!values.length) throw invalid(`У перечислимого параметра ${name} должны быть values.`);
      const fallback = raw.default === undefined ? values[0] : String(raw.default);
      if (!values.includes(fallback)) throw invalid(`Значение по умолчанию для ${name} должно быть одним из: ${values.join(', ')}.`);
      out[name] = { type, values, default: fallback, ...(description ? { description } : {}) };
      continue;
    }
    if (type === 'boolean') {
      out[name] = { type, default: raw.default === undefined ? false : raw.default === true, ...(description ? { description } : {}) };
      continue;
    }
    if (type === 'number') {
      const fallback = raw.default === undefined ? null : Number(raw.default);
      if (fallback !== null && !Number.isFinite(fallback)) throw invalid(`Значение по умолчанию для ${name} — число.`);
      out[name] = { type, default: fallback, ...(description ? { description } : {}) };
      continue;
    }
    out[name] = { type: 'string', default: raw.default === undefined || raw.default === null ? '' : String(raw.default).slice(0, 500), ...(description ? { description } : {}) };
  }
  return out;
}

/**
 * Fills the schema: a missing value takes the default, a given one is checked
 * against the declared type. An unknown parameter name is refused — a client that
 * sends a typo must hear about it.
 */
export function resolveParameters(schema, given = {}) {
  const values = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
  const unknown = Object.keys(values).filter(name => !(name in schema));
  if (unknown.length) throw invalid(`Неизвестные параметры: ${unknown.join(', ')}.`);
  const out = {};
  for (const [name, spec] of Object.entries(schema)) {
    if (!(name in values) || values[name] === undefined || values[name] === null) {
      out[name] = spec.default;
      continue;
    }
    const value = values[name];
    switch (spec.type) {
      case 'boolean':
        if (typeof value !== 'boolean') throw invalid(`Параметр ${name} — логическое значение.`);
        out[name] = value;
        break;
      case 'number':
        if (!Number.isFinite(Number(value))) throw invalid(`Параметр ${name} — число.`);
        out[name] = Number(value);
        break;
      case 'enum':
        if (!spec.values.includes(String(value))) throw invalid(`Параметр ${name} — одно из: ${spec.values.join(', ')}.`);
        out[name] = String(value);
        break;
      default:
        out[name] = String(value).slice(0, 500);
    }
  }
  return out;
}

/** Replaces `{{name}}` with the resolved value. Only called for the fields in SUBSTITUTABLE. */
export function substitute(text, values) {
  return String(text ?? '').replace(PLACEHOLDER, (whole, name) => (name in values ? String(values[name]) : whole));
}

export function getPath(source, path) {
  return path.split('.').reduce((value, part) => (value === undefined || value === null ? undefined : value[part]), source);
}

export function setPath(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

/**
 * The recipe as it will actually run: the parameters resolved, and every
 * substitutable field rendered. This is what the invocation uses, and what the
 * preview shows — one function, so the two cannot disagree.
 */
export function renderRecipe(recipe, given = {}) {
  const schema = recipe.parameters ?? {};
  const values = resolveParameters(schema, given);
  // Только то, что запуск действительно применяет: предпросмотр не должен
  // показывать настройки, которых `runRecipe` не исполняет.
  const rendered = JSON.parse(JSON.stringify({
    promptTemplate: recipe.promptTemplate,
    runtime: recipe.runtime ?? {},
    verification: recipe.verification ?? {},
  }));
  for (const path of SUBSTITUTABLE) {
    const value = getPath(rendered, path);
    if (typeof value === 'string' && value.includes('{{')) setPath(rendered, path, substitute(value, values));
  }
  return {
    recipeId: recipe.id,
    projectId: recipe.projectId,
    workItemId: recipe.workItemId ?? null,
    name: recipe.name,
    prompt: rendered.promptTemplate,
    parameters: values,
    runtime: rendered.runtime,
    verification: rendered.verification,
  };
}

/**
 * Validates a recipe before it is stored: the placeholder that names nothing is a
 * typo the operator can still see, and a run at 09:00 with `{{are}}` in the prompt
 * would be useless.
 */
export function validateRecipe(input = {}) {
  const name = String(input.name ?? '').trim();
  if (!name) throw invalid('У рецепта должно быть имя.');
  const promptTemplate = String(input.promptTemplate ?? '').trim();
  if (!promptTemplate) throw invalid('У рецепта должен быть шаблон промпта.');
  const parameters = normalizeParameters(input.parameters);
  const fields = {
    promptTemplate: promptTemplate.slice(0, TEMPLATE_LIMIT),
    'runtime.id': input.runtime?.id ?? '',
    'runtime.model': input.runtime?.model ?? '',
    'runtime.thinking': input.runtime?.thinking ?? '',
    'verification.command': input.verification?.command ?? '',
  };
  const used = new Set(Object.values(fields).flatMap(placeholdersIn));
  const missing = [...used].filter(field => !(field in parameters));
  if (missing.length) {
    throw invalid(`В шаблоне есть параметры, которых нет в схеме: ${missing.join(', ')}.`);
  }
  // Настройки, которые некому исполнять, не сохраняются: пустой объект — это «не
  // указано», а любое значение в нём было бы обещанием, которое запуск не выполнит.
  for (const [field, why] of Object.entries(UNSUPPORTED_SETTINGS)) {
    const value = input[field];
    const used = value && typeof value === 'object' && Object.values(value).some(item => item !== undefined && item !== null && item !== '');
    if (used) throw invalid(`Поле ${field} рецепт не применяет: ${why}. Уберите его из рецепта.`);
  }
  const engine = String(input.runtime?.id ?? 'pi');
  if (!SUPPORTED_ENGINES.includes(engine)) {
    throw invalid(`Ядро запуска — только ${SUPPORTED_ENGINES.join(', ')}: второго ядра в TaskBridge нет.`);
  }
  return {
    name: name.slice(0, NAME_LIMIT),
    projectId: String(input.projectId ?? '').trim(),
    workItemId: input.workItemId === undefined || input.workItemId === null || input.workItemId === '' ? null : String(input.workItemId),
    promptTemplate: fields.promptTemplate,
    parameters,
    runtime: {
      id: 'pi',
      model: input.runtime?.model ? String(input.runtime.model).slice(0, 200) : null,
      thinking: input.runtime?.thinking ? String(input.runtime.thinking).slice(0, 40) : null,
    },
    verification: {
      required: input.verification?.required === true,
      command: input.verification?.command ? String(input.verification.command).slice(0, 500) : null,
    },
  };
}
