// Turn instructions (§4 of the 1.3 plan). Until now every first request carried
// one fixed tail — «At the end, summarize what you changed and what checks you
// ran» — whatever was asked. A lookup («есть ли у меня такой курс?») therefore
// read as a change report to produce: the model kept investigating to have
// something to report, and the answer itself arrived late or not at all
// (2026-10-21).
//
// The user's text is never rewritten. These notes only state the boundaries and
// the shape of the answer for THIS turn; the request stays the goal. Pi keeps
// the transcript, so the block is deliberately short — it is not a system prompt.
//
// Profiles are guessed, not asked for: no extra LLM call in front of every turn
// (§5.1 of the plan). When nothing is clear the turn runs as `explore`, which
// restricts nothing — the mistake to avoid is cutting a real investigation short,
// not allowing one.

export const QUICK = 'quick';
export const EXPLORE = 'explore';
export const IMPLEMENT = 'implement';

// An action on the repository. A verb alone is not enough: «найди и исправь все
// ошибки» is not a lookup, «найди папку с курсом» is one — so change words win.
const CHANGE = new RegExp([
  // ru
  'исправ', 'почин', 'поправ', 'поправить', 'реализу', 'добав', 'созда', 'сделай',
  'обнови', 'обновить', 'удали', 'удалить', 'перепиши', 'переписать', 'отрефактор', 'зарефактор', 'рефактори',
  'перенес', 'внедри', 'интегриру', 'собери', 'скомпилиру', 'протестиру', 'задеплой',
  'установи', 'доделай', 'доработай', 'поменя', 'замени', 'примени', 'вставь',
  'допиши', 'переимену', 'почисти', 'проведи рефакторинг',
  // en
  '\\bfix\\b', '\\bimplement\\b', '\\brefactor\\b', '\\brewrite\\b', '\\bpatch the\\b',
  '\\bapply the\\b', '\\badd (a|an|the)\\b', '\\badd to\\b', '\\bcreate (a|an|the)\\b',
  '\\bdelete the\\b', '\\bremove the\\b', '\\bupdate the\\b', '\\breplace the\\b',
  '\\bmigrate the\\b', '\\brename the\\b', '\\bbuild the\\b', '\\binstall the\\b',
  '\\bdeploy the\\b', '\\bwrite the\\b',
].join('|'), 'i');

// «Разберись», «почему», «найди причину»: reading and reasoning, not editing.
const INVESTIGATE = new RegExp([
  'почему', 'разберись', 'разобраться', 'проанализируй', 'анализ', 'исследуй',
  'расследуй', 'диагност', 'в чём причина', 'в чем причина', 'найди причину',
  'как работает', 'объясни', 'оцени архитектуру',
  '\\bwhy\\b', '\\bdiagnose', '\\binvestigate', 'analyz', '\\bexplain\\b', '\\btrace\\b',
].join('|'), 'i');

// «Посмотри», «найди», «есть ли»: the answer is a fact that one command can
// confirm. Checked after CHANGE and INVESTIGATE, so «найди ошибку и исправь»
// stays implement.
const LOOKUP = new RegExp([
  'посмотри', 'посмотреть', 'найди', 'найти', 'покажи', 'есть ли', 'у меня есть',
  'существует ли', 'существует ли файл',
  'сколько', 'где находится', 'где лежит', 'где взять',
  '\\bfind\\b', '\\blocate\\b', '\\blook for\\b', '\\bshow\\b', '\\blist\\b',
  '\\bwhere\\b', '\\bhow much\\b', '\\bhow many\\b', '\\bdoes .* exist\\b',
].join('|'), 'i');

// «Не исправляй ничего, только найди» is a lookup, not a change request.
const NEGATED_CHANGE = /(?:^|[^а-яёa-z])не\s+(исправ\w*|почин\w*|поправ\w*|добав\w*|удал\w*|обнов\w*|меня\w*|трогай\w*|переписыв\w*|создавай\w*|заменяй\w*|перенос\w*)/gi;
const NEGATED_CHANGE_EN = /(?:^|[^a-z])(do not|don't|dont)\s+(fix|add|change|update|remove|delete|refactor|rewrite|touch|modify)/gi;

export function detectProfile(text) {
  // The strip is a heuristic, not a parser: dropping too much costs only the shape
  // of the answer block (the request itself is still in the prompt untouched).
  const value = String(text ?? '').replace(NEGATED_CHANGE, ' ').replace(NEGATED_CHANGE_EN, ' ');
  if (CHANGE.test(value)) return IMPLEMENT;
  if (INVESTIGATE.test(value)) return EXPLORE;
  if (LOOKUP.test(value)) return QUICK;
  return EXPLORE;
}

// Applies to every profile: the request is the goal, the notes are boundaries.
const CONTRACT = [
  'Do only what the request asks: the request defines the goal, these notes only set the boundaries.',
  'Before each additional step, check which open question of the request it answers; once the requested answer is confirmed, report it and stop.',
  'If the answer is not confirmed, say which part is unconfirmed instead of guessing.',
  'If a tool fails, keep what the earlier tools already confirmed and report the failure.',
];

const PROFILE_NOTES = {
  [QUICK]: 'This is a lookup: use the fewest commands and stop at the first confirmed answer. Do not modify files unless the request asks for changes.',
  [EXPLORE]: 'Investigation is allowed while an open question of the request remains; do not modify files unless the request asks for changes.',
  [IMPLEMENT]: 'Make the change the request asks for, verify it, and summarize what changed and which checks ran. Link deliverable files as Markdown relative paths, e.g. [Download report](report.pdf).',
};

/**
 * The instructions for one turn: the same text goes into the first message
 * (legacy mode) and into Pi's system prompt section `turn_instructions` (hook
 * mode). One generator, so the two delivery paths cannot drift apart.
 */
export function turnInstructions(profile = EXPLORE, { files = [] } = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const lines = [
    `Task instructions (${profile}):`,
    ...CONTRACT.map(line => `- ${line}`),
    `- ${PROFILE_NOTES[profile] || PROFILE_NOTES[EXPLORE]}`,
    `- Work only inside the current working directory.${list.length ? ' Read attached files as needed.' : ''}`,
  ];
  return lines.join('\n');
}

/**
 * The text sent to Pi for one turn: the operator's own words, then the notes.
 * `files` are workspace-relative paths of attachments staged for this turn.
 */
export function buildTurnPrompt({ text, profile = EXPLORE, files = [] } = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const note = list.length
    ? `\n\nAdditional files from the phone are in .taskbridge-input/:\n${list.map(file => `- ${file}`).join('\n')}`
    : '';
  return `${String(text ?? '').trimEnd()}${note}\n\n${turnInstructions(profile, { files: list })}`;
}

/**
 * How instructions reach the model: `legacy` appends them to the first message,
 * `hook` gives them to the Pi extension (`before_agent_start`) on every turn and
 * leaves that message untouched. Exactly one mode is active — both at once would
 * send the model two sets of rules.
 */
export const TURN_INSTRUCTIONS_MODES = ['legacy', 'hook'];

export function resolveTurnInstructionsMode(config = {}, env = process.env) {
  const fromEnv = String(env?.TASKBRIDGE_TURN_INSTRUCTIONS || '').trim().toLowerCase();
  const fromConfig = String(config?.pi?.turnInstructions?.mode || '').trim().toLowerCase();
  const chosen = fromEnv || fromConfig;
  // An unknown value is a configuration mistake, not a reason to fall through to
  // the other mechanism silently: say which values exist.
  if (chosen && !TURN_INSTRUCTIONS_MODES.includes(chosen)) {
    throw Object.assign(new Error(`Неизвестный режим инструкций: ${chosen}. Допустимо: ${TURN_INSTRUCTIONS_MODES.join(', ')}.`), { code: 'CONFIG_INVALID' });
  }
  return TURN_INSTRUCTIONS_MODES.includes(chosen) ? chosen : 'legacy';
}
