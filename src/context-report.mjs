import fs from 'node:fs/promises';
import path from 'node:path';

// "Откуда в модели берётся контекст" — разбор запроса к модели по источникам.
//
// Pi собирает запрос из системного промпта, файлов инструкций проекта, описаний
// навыков, объявлений инструментов (встроенных и MCP) и истории ветки сессии.
// Точную сумму знает только Pi, и он её отдаёт (`get_session_stats.contextUsage`);
// по источникам её можно лишь ОЦЕНИТЬ, потому что часть текста (базовые инструкции
// Pi, объявления встроенных инструментов, то, что дописывают расширения) не лежит
// ни в одном читаемом снаружи файле.
//
// Оценка размера сделана той же эвристикой, что и у Pi (compaction.js
// estimateTokens): chars/4 с округлением вверх — «консервативно, переоценивает».
// Числа здесь поэтому подписаны как оценка, а `totalTokens` и `unaccountedTokens`
// взяты из чисел самого Pi. Модуль ничего не пишет на диск: только читает.

/** Токены по эвристике Pi (chars/4 вверх). Ноль для пустого/нечислового входа. */
export function estimateTokens(chars) {
  const value = Number(chars);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / 4);
}

/**
 * Имена файлов инструкций, которые Pi ищет в каждом каталоге (resource-loader
 * `loadContextFileFromDir`), в том же порядке: первый найденный побеждает.
 */
// The agent dir has one definition (src/pi-settings.mjs): a second copy here
// drifted from Pi's own variable name and read the wrong settings file.
import { piAgentDir } from './pi-settings.mjs';
export { piAgentDir };

export const CONTEXT_FILE_CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

/** Файлы системного промпта: `SYSTEM.md` заменяет базовый, `APPEND_SYSTEM.md` дописывается. */
export const SYSTEM_PROMPT_FILES = Object.freeze({ system: 'SYSTEM.md', append: 'APPEND_SYSTEM.md' });

// Pi читает настройки сжатия из своего каталога и из `<проект>/.pi/settings.json`
// (проект перекрывает агентский). Значения ниже — её дефолты (docs/settings.md).
export const COMPACTION_DEFAULTS = Object.freeze({ reserveTokens: 16384, keepRecentTokens: 20000 });

async function readTextFile(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonFile(file) {
  const text = await readTextFile(file);
  if (text === null) return null;
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
}

/** Первый подходящий файл инструкций в каталоге, или null (как у Pi). */
async function firstContextFile(dir) {
  for (const name of CONTEXT_FILE_CANDIDATES) {
    const file = path.join(dir, name);
    const text = await readTextFile(file);
    if (text !== null) return { path: file, chars: text.length };
  }
  return null;
}

/**
 * Файлы инструкций, которые Pi подхватит для этого рабочего каталога: сначала
 * агентский каталог, затем каталоги от cwd вверх до корня (глобальный первым,
 * дальние предки раньше близких — как в `loadProjectContextFiles`).
 *
 * Возвращает `[{ path, chars, global }]`; `global` — файл агентского каталога.
 */
export async function discoverContextFiles({ cwd, agentDir = piAgentDir(), env = process.env } = {}) {
  const resolvedAgentDir = path.resolve(agentDir || piAgentDir(env));
  const files = [];
  const seen = new Set();
  const global = await firstContextFile(resolvedAgentDir);
  if (global) {
    files.push({ ...global, global: true });
    seen.add(global.path);
  }
  if (!cwd) return files;
  const ancestors = [];
  let current = path.resolve(cwd);
  for (;;) {
    const file = await firstContextFile(current);
    if (file && !seen.has(file.path)) {
      ancestors.unshift({ ...file, global: false });
      seen.add(file.path);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...files, ...ancestors];
}

/**
 * Файл системного промпта: проектный `<cwd>/.pi/SYSTEM.md` побеждает агентский
 * (Pi проверяет проектный только в доверенном проекте; доверие здесь не
 * проверяется — поэтому у проектного файла в отчёте стоит `project: true`, и
 * клиент может это показать как «если проект доверен»).
 */
export async function discoverSystemPromptFiles({ cwd, agentDir = piAgentDir(), env = process.env } = {}) {
  const resolvedAgentDir = path.resolve(agentDir || piAgentDir(env));
  const out = { system: null, append: null };
  for (const [key, name] of Object.entries(SYSTEM_PROMPT_FILES)) {
    const projectFile = cwd ? path.join(path.resolve(cwd), '.pi', name) : null;
    const projectText = projectFile ? await readTextFile(projectFile) : null;
    if (projectText !== null) { out[key] = { path: projectFile, chars: projectText.length, project: true }; continue; }
    const globalFile = path.join(resolvedAgentDir, name);
    const globalText = await readTextFile(globalFile);
    if (globalText !== null) out[key] = { path: globalFile, chars: globalText.length, project: false };
  }
  return out;
}

// Описание навыка из SKILL.md — то, что реально попадает в системный промпт:
// тег <description> или первый абзац. Полный текст SKILL.md читается моделью
// по требованию, поэтому в контекст он не входит и здесь не считается.
export function skillDescription(body) {
  const text = String(body || '');
  const match = text.match(/<description>([\s\S]*?)<\/description>/i);
  if (match) return match[1].replace(/\s+/g, ' ').trim();
  const line = text.split(/\r?\n/).map(item => item.trim())
    .find(item => item && !item.startsWith('#') && !item.startsWith('---'));
  return (line || '').replace(/\s+/g, ' ').trim();
}

/** Навыки из каталога (`<dir>/<имя>/SKILL.md`): `{ name, path, description }`. */
export async function readSkillDeclarations(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    const body = await readTextFile(file);
    if (body === null) continue;
    out.push({ name: entry.name, path: file, description: skillDescription(body) });
  }
  return out;
}

/**
 * Объявления MCP-инструментов, как их шлёт адаптер: имя, описание и схема входа.
 * Источник — статус MCP TaskBridge (у него уже есть кэш адаптера
 * `~/.pi/agent/mcp-cache.json`), а не живое соединение с серверами.
 */
export function mcpDeclarations(status) {
  const servers = Array.isArray(status?.servers) ? status.servers : [];
  const tools = [];
  for (const server of servers) {
    if (server?.disabled) continue;
    // A tool excluded in the UI is not sent to the model, so it must not be
    // counted as context (CMP-01). The list itself comes from the adapter cache:
    // it says which tools are known, not which of them a live Pi registered.
    const excluded = new Set(Array.isArray(server?.excludeTools) ? server.excludeTools : []);
    for (const tool of server?.tools || []) {
      if (!tool || typeof tool.name !== 'string') continue;
      if (excluded.has(tool.name) || tool.enabled === false) continue;
      tools.push({
        server: server.name,
        name: tool.name,
        chars: tool.name.length + String(tool.description || '').length
          + (tool.inputSchema ? JSON.stringify(tool.inputSchema).length : 0),
      });
    }
  }
  return tools;
}

/**
 * Настройки сжатия: агентские перекрываются проектными (как в Pi, где проектные
 * настройки — поверх глобальных). Возвращает эффективные значения и их источник.
 */
export async function readCompactionSettings({ cwd, agentDir = piAgentDir(), env = process.env } = {}) {
  const globalSettings = await readJsonFile(path.join(path.resolve(agentDir || piAgentDir(env)), 'settings.json'));
  const projectSettings = cwd ? await readJsonFile(path.join(path.resolve(cwd), '.pi', 'settings.json')) : null;
  const merged = {
    ...(globalSettings?.compaction || {}),
    ...(projectSettings?.compaction || {}),
  };
  const pick = (key) => {
    const value = merged[key];
    if (Number.isSafeInteger(value) && value >= 0) return value;
    return COMPACTION_DEFAULTS[key];
  };
  return {
    reserveTokens: pick('reserveTokens'),
    keepRecentTokens: pick('keepRecentTokens'),
    enabled: typeof merged.enabled === 'boolean' ? merged.enabled : true,
    fromProject: projectSettings?.compaction ? true : false,
  };
}

function source(id, label, detail, extra = {}) {
  return { id, label, detail, ...extra };
}

/**
 * Оценка по источникам, которые TaskBridge может прочитать. Каждая запись:
 * `{ id, label, detail, chars, tokens, files?, count?, known }` — `known: false`
 * значит «источник есть, но его размер снаружи не измеряется» (так честнее, чем
 * показывать ноль).
 */
export async function collectContextSources({ cwd, agentDir = piAgentDir(), env = process.env, mcp = null } = {}) {
  const sources = [];
  const systemFiles = await discoverSystemPromptFiles({ cwd, agentDir, env });

  if (systemFiles.system) {
    sources.push(source('system-prompt', 'Системный промпт (SYSTEM.md)', systemFiles.system.path, {
      chars: systemFiles.system.chars, tokens: estimateTokens(systemFiles.system.chars),
      known: true, files: [systemFiles.system.path], project: systemFiles.system.project,
    }));
  } else {
    sources.push(source('system-prompt', 'Системный промпт Pi', 'базовые инструкции Pi (встроены в пакет)', {
      chars: null, tokens: null, known: false, files: [],
    }));
  }
  if (systemFiles.append) {
    sources.push(source('append-system-prompt', 'Дополнение к системному промпту (APPEND_SYSTEM.md)', systemFiles.append.path, {
      chars: systemFiles.append.chars, tokens: estimateTokens(systemFiles.append.chars),
      known: true, files: [systemFiles.append.path], project: systemFiles.append.project,
    }));
  }

  const contextFiles = await discoverContextFiles({ cwd, agentDir, env });
  const instructionChars = contextFiles.reduce((sum, file) => sum + file.chars, 0);
  sources.push(source('instructions', 'Инструкции проекта (AGENTS.md)', contextFiles.map(file => file.path).join('\n'), {
    chars: instructionChars, tokens: estimateTokens(instructionChars),
    known: contextFiles.length > 0, files: contextFiles.map(file => file.path), count: contextFiles.length,
  }));

  const skillDirs = [
    path.join(path.resolve(agentDir || piAgentDir(env)), 'skills'),
    cwd ? path.join(path.resolve(cwd), '.pi', 'skills') : null,
  ].filter(Boolean);
  const skills = [];
  for (const dir of skillDirs) skills.push(...await readSkillDeclarations(dir));
  const skillChars = skills.reduce((sum, skill) => sum + String(skill.name || '').length + skill.description.length, 0);
  sources.push(source('skills', 'Навыки (описания)', skillDirs.join('\n'), {
    chars: skillChars, tokens: estimateTokens(skillChars), known: skills.length > 0, count: skills.length,
  }));

  const tools = mcpDeclarations(mcp);
  const toolChars = tools.reduce((sum, tool) => sum + tool.chars, 0);
  const serverNames = [...new Set(tools.map(tool => tool.server))];
  const excludedTools = (Array.isArray(mcp?.servers) ? mcp.servers : [])
    .filter(server => !server?.disabled)
    .reduce((sum, server) => sum + (Array.isArray(server.excludeTools) ? server.excludeTools.length : 0), 0);
  sources.push(source('mcp-tools', 'MCP-инструменты', serverNames.join(', '), {
    chars: toolChars, tokens: estimateTokens(toolChars), known: tools.length > 0,
    count: tools.length, servers: serverNames, excluded: excludedTools,
    // In `inherit` mode TaskBridge does not own the config Pi reads, so the
    // toggles here do not reach the model (CMP-01: said, not hidden).
    controllable: mcp?.controllable !== false,
    // Кэш адаптера: если серверы ещё не опрашивались, список будет пустым.
    partial: tools.length === 0,
  }));

  sources.push(source('builtin-tools', 'Встроенные инструменты Pi', 'read, bash, edit, write (+ grep/find/ls и инструменты расширений)', {
    chars: null, tokens: null, known: false, files: [],
  }));

  sources.push(source('memory', 'Память проекта', 'индекс MCP-сервера manage_project_memory доставляется расширением memory-store', {
    chars: null, tokens: null, known: false, files: [],
  }));

  return sources;
}

/**
 * Собрать отчёт целиком. `usage` — то, что Pi отдал в `get_session_stats`
 * (`contextUsage`), `sources` — из `collectContextSources`, `limits` — настройки
 * сжатия. Ничего не вычисляется из воздуха: чего нет, то `null`.
 */
export function buildContextReport({
  taskId,
  model = null,
  contextWindow = null,
  stats = null,
  sources = [],
  compaction = null,
  limit = null,
  running = false,
  // Когда сняты числа Pi и что они описывают (CTX-03). Без этого «всего» после
  // сжатия не отличить от числа до сжатия, а оценку Pi — от измерения.
  measuredAt = null,
  measurementSession = null,
  // Состав активной ветки из файла сессии (`summarizeSessionContext`). Из него
  // берётся единственная измеряемая часть истории: сохранённые сообщения в
  // контексте, сводка и то, что из контекста уже исключено.
  session = null,
  unavailableReason: suppliedUnavailableReason = null,
} = {}) {
  const window = Number.isFinite(contextWindow) ? contextWindow : (stats?.contextUsage?.contextWindow ?? null);
  const totalTokens = Number.isFinite(stats?.contextUsage?.tokens) ? stats.contextUsage.tokens : null;
  const measuredTokens = sources
    .filter(item => item.known && Number.isFinite(item.tokens))
    .reduce((sum, item) => sum + item.tokens, 0);
  // Остаток — всё, что не лежит в читаемых файлах: история ветки сессии, сводка
  // после сжатия, вложения и текст, который добавляют расширения. Меньше нуля он
  // быть не может по смыслу (оценка источников переоценивает), поэтому режется.
  const unaccountedTokens = totalTokens === null ? null : Math.max(0, totalTokens - measuredTokens);
  // Оценка источников может оказаться БОЛЬШЕ числа Pi (объявления MCP-инструментов
  // он считает иначе, и до первого ответа модели его «всего» меньше реального
  // запроса). Тогда остаток читался бы как «истории нет вообще», а это не так:
  // клиент должен показать именно оговорку, а не ноль.
  const overestimated = totalTokens !== null && measuredTokens > totalTokens;
  const triggerAt = window !== null && compaction ? window - compaction.reserveTokens : null;
  // Последнее успешное сжатие и его оценка размера. Это ОЦЕНКА Pi
  // (`estimatedTokensAfter`), а не измерение: после compact `contextUsage.tokens`
  // может быть null, и подставлять сюда старое число нельзя.
  // The summary body is available only from the explicit /context/summary read.
  const { summary: _summary, ...lastMetadata } = compaction?.last || {};
  const lastCompaction = compaction?.last ? lastMetadata : null;
  const estimatedAfter = Number.isFinite(lastCompaction?.estimatedTokensAfter) ? lastCompaction.estimatedTokensAfter : null;
  const measuredMs = measuredAt ? Date.parse(measuredAt) : NaN;
  const compactionMs = lastCompaction?.at ? Date.parse(lastCompaction.at) : NaN;
  // Измерение старше последнего сжатия описывает уже другую историю.
  const stale = totalTokens !== null && Number.isFinite(measuredMs) && Number.isFinite(compactionMs)
    ? measuredMs < compactionMs
    : false;
  const unavailableReason = totalTokens !== null ? null
    : suppliedUnavailableReason || (!running ? 'сессия Pi не активна: текущий размер недоступен'
      : 'Pi пока не сообщил размер текущего запроса');
  // CMP-02: named, separately sourced numbers instead of one residual.
  // `null` means «не измерено», never zero — an unknown size must not be shown
  // as «nothing there». Everything marked `measured` is read from a file Pi
  // itself uses; `estimate` is chars/4; `pi` is Pi's own contextUsage.
  const tokenOf = (id) => {
    const item = sources.find(candidate => candidate.id === id);
    return item && item.known && Number.isFinite(item.tokens) ? item.tokens : null;
  };
  const measuredIds = ['system-prompt', 'append-system-prompt', 'instructions', 'skills', 'mcp-tools'];
  const estimatedTotalTokens = measuredIds.reduce((sum, id) => {
    const value = tokenOf(id);
    return value === null ? sum : sum + value;
  }, 0) || null;
  const kept = session?.available ? session.active?.kept : null;
  const summaryChars = session?.available ? session.compaction?.summaryChars : null;
  const droppedChars = session?.available ? session.history?.excludedChars : null;
  const snapshot = session?.available ? session.systemSnapshot ?? null : null;
  const breakdown = {
    systemTokens: tokenOf('system-prompt'),
    appendSystemTokens: tokenOf('append-system-prompt'),
    instructionsTokens: tokenOf('instructions'),
    skillsTokens: tokenOf('skills'),
    toolSchemaTokens: tokenOf('mcp-tools'),
    // Снимок системного промпта из записи сжатия: Pi переигрывает его в каждом
    // запросе после compact, и без этой строки он попадал в «прочие».
    snapshotTokens: Number.isFinite(snapshot?.chars) ? estimateTokens(snapshot.chars) : null,
    snapshotSections: snapshot?.sections ?? null,
    snapshotTools: snapshot?.tools?.length ?? null,
    snapshotStaleTools: snapshot?.staleTools ?? null,
    // Сохранённая история в активном контексте и сводка — из файла сессии.
    historyTokens: Number.isFinite(kept?.chars) ? estimateTokens(kept.chars) : null,
    summaryTokens: Number.isFinite(summaryChars) ? estimateTokens(summaryChars) : null,
    // Что из контекста уже исключено сжатием: это не расход, но и не ноль.
    excludedTokens: Number.isFinite(droppedChars) ? estimateTokens(droppedChars) : null,
    estimatedTotalTokens,
    // Pi не отдаёт отдельного числа «вход запроса» в get_session_stats: его
    // tokens.input — сумма за сессию, а не размер текущего контекста. Поэтому
    // здесь null, а не подставленное похожее число.
    providerInputTokens: null,
    providerInputReason: 'Pi отдаёт tokens.input как сумму за сессию; размера текущего запроса в get_session_stats нет. См. provider.tokens.',
    unattributedTokens: unaccountedTokens,
    measuredAt,
    sources: {
      estimates: 'chars/4 по файлам (system, instructions, skills, MCP-схемы)',
      history: Number.isFinite(kept?.chars) ? 'файл сессии Pi (активная ветка)' : null,
      snapshot: Number.isFinite(snapshot?.chars) ? 'файл сессии Pi (CompactionEntry.systemMessage)' : null,
      total: totalTokens === null ? null : 'Pi contextUsage',
    },
  };
  return {
    taskId: taskId ?? null,
    model: model || null,
    contextWindow: window,
    usage: {
      tokens: totalTokens,
      contextWindow: window,
      percent: Number.isFinite(stats?.contextUsage?.percent) ? stats.contextUsage.percent : null,
      // Меняется вместе с tokens: null здесь означал бы «измерено, но неизвестно чем».
      source: totalTokens === null ? null : 'pi',
      measuredAt: totalTokens === null ? null : (measuredAt ?? null),
      sessionId: totalTokens === null ? null : (measurementSession ?? null),
      stale,
      unavailableReason
    },
    postCompaction: lastCompaction ? {
      tokens: estimatedAfter,
      source: estimatedAfter === null ? null : 'pi-estimate',
      measuredAt: lastCompaction.at ?? null,
      reason: lastCompaction.reason ?? null,
      tokensBefore: Number.isFinite(lastCompaction.tokensBefore) ? lastCompaction.tokensBefore : null
    } : null,
    conversation: stats ? {
      userMessages: stats.userMessages ?? null,
      assistantMessages: stats.assistantMessages ?? null,
      toolCalls: stats.toolCalls ?? null,
      messages: stats.totalMessages ?? null,
      tokens: stats.tokens ?? null,
      cost: stats.cost ?? null
    } : null,
    // Pi's own accounting, per session — not per request. Kept separate so nobody
    // reads a session sum as the size of the current request, and so the cache
    // behaviour is visible: cached reads cost a fraction of a normal input token,
    // which is why a stable prefix matters more than a small one.
    provider: stats?.tokens ? {
      tokens: {
        input: Number.isFinite(stats.tokens.input) ? stats.tokens.input : null,
        output: Number.isFinite(stats.tokens.output) ? stats.tokens.output : null,
        cacheRead: Number.isFinite(stats.tokens.cacheRead) ? stats.tokens.cacheRead : null,
        cacheWrite: Number.isFinite(stats.tokens.cacheWrite) ? stats.tokens.cacheWrite : null,
        total: Number.isFinite(stats.tokens.total) ? stats.tokens.total : null,
      },
      cacheHitRatio: Number.isFinite(stats.tokens.cacheRead) && Number.isFinite(stats.tokens.input)
        && stats.tokens.cacheRead + stats.tokens.input > 0
        ? stats.tokens.cacheRead / (stats.tokens.cacheRead + stats.tokens.input)
        : null,
      scope: 'session',
      note: 'Суммы за сессию по данным Pi (get_session_stats), а не размер текущего запроса.',
    } : null,
    totalTokens,
    sources,
    breakdown,
    measuredTokens,
    unaccountedTokens,
    overestimated,
    limit: {
      tokens: Number.isFinite(limit) ? limit : null,
      exceeded: Number.isFinite(limit) && totalTokens !== null ? totalTokens > limit : false
    },
    compaction: compaction ? {
      auto: taskAutoCompaction(compaction.auto),
      reserveTokens: compaction.reserveTokens,
      keepRecentTokens: compaction.keepRecentTokens,
      triggerAt,
      fromProject: compaction.fromProject === true,
      // Последнее успешное сжатие: счётчик и его числа нужны клиенту рядом с
      // оценкой (postCompaction), а не вместо неё.
      last: lastCompaction
    } : null,
    running: running === true,
    note: stale
      ? 'Последнее измерение Pi сделано до сжатия — оно относится к прежней истории. Размер после сжатия показан как оценка Pi (estimatedTokensAfter), пока не придёт новый ответ модели.'
      : totalTokens === null && estimatedAfter !== null
        ? 'Текущий размер Pi не сообщает, поэтому показана оценка после сжатия (estimatedTokensAfter). Это не измерение.'
        : overestimated
      ? 'Размеры источников — оценка (символы / 4, как считает Pi), и она больше того, что Pi насчитал на этом ходу: Pi берёт «всего» из последнего ответа модели, и до первого ответа его число меньше реального запроса. Сравнивайте обе цифры, а не их разность. «Всего» и строка истории/остатка взяты из чисел самого Pi (get_session_stats) — остаток режется нулём, потому что переоценка, а не пустая история.'
      : 'Размеры источников — приблизительная оценка (символы / 4), а не токенизация запроса. Прочие источники и история — приблизительная разность измерения Pi и этой оценки; она включает погрешность, расширения и неучтённые источники и не измеряет историю отдельно.'
  };
}

function taskAutoCompaction(value) {
  return typeof value === 'boolean' ? value : null;
}

export const CONTEXT_LIMIT_MIN = 2048;
export const CONTEXT_LIMIT_MAX = 4_000_000;

/** Лимит контекста сессии: целое в допустимых границах или null («без лимита»). */
export function assertContextLimit(value) {
  if (value === null || value === undefined || value === '' || value === 'off') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < CONTEXT_LIMIT_MIN || number > CONTEXT_LIMIT_MAX) {
    throw Object.assign(
      new Error(`Лимит контекста — целое число от ${CONTEXT_LIMIT_MIN} до ${CONTEXT_LIMIT_MAX} токенов, или null.`),
      { code: 'INPUT_INVALID' },
    );
  }
  return number;
}
