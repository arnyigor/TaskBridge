/**
 * Перехват текстового поиска: дополняем результат `grep`/`bash` типизированным ответом
 * из ast-index — прямо в тот же вызов.
 *
 * Зачем. Инструмент в списке модель видит, но grep+cut не вытесняет: текстовый поиск
 * даёт плоский список строк, и половину шагов модель тратит на то, чтобы понять, где
 * объявление, а где использование. Мы это измеряли на стенде: `verify` как просьба — 0
 * обращений, как инструмент — 31. Дальше остаётся один уровень, не зависящий от решения
 * модели вообще: сделать это за неё в момент вызова.
 *
 * Как устроено и почему именно так:
 *   · хук `tool_result` отдаёт `toolName`, `input` и содержимое результата — значит можно
 *     ДОПИСАТЬ свой блок, не подменяя чужой вывод. Подменять нельзя: сломаются законные
 *     поиски по XML, строкам, ресурсам и логам, где индекса нет и быть не должно;
 *   · срабатываем только на «одно имя символа» (`Foo`, `grep -rn "Foo" .`). Фраза, путь,
 *     регулярка, `literal` — пропускаем;
 *   · сложные пайплайны не разбираем: имя символа берём из части `grep`/`rg`, остальное
 *     (`| cut`, `| sort`) не трогаем — там разбор командной строки ненадёжен;
 *   · любая ошибка — молча пропускаем. Перехват вспомогательный, он не имеет права
 *     влиять на работу сессии.
 *
 * Включается отдельным флагом, потому что это предмет замера:
 *   PI_CODE_SEARCH_INTERCEPT=1   включить
 *   PI_CODE_SEARCH_OFF=1         выключить всё расширение (для чистого плеча A/B)
 *   PI_CODE_SEARCH_INTERCEPT_LINES  сколько строк индекса максимум подмешивать (по умолчанию 18)
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const AST = process.env.BENCH_AST_INDEX ?? 'G:/Android/plugins/ast-index.exe';
const PROJECT = process.env.BENCH_PROJECT ?? process.cwd();
const MAX_LINES = Number(process.env.PI_CODE_SEARCH_INTERCEPT_LINES ?? 18);
// refs по умолчанию отдаёт 20 записей НА СЕКЦИЮ и молчит об обрезке. Для подмешиваемого
// блока это опаснее всего: неполный список выглядит как полный, и модель ему верит.
const REF_LIMIT = Number(process.env.PI_CODE_SEARCH_INTERCEPT_LIMIT ?? 100);
// Метрика замороженного слоя: доля поисков, после которых модель открыла именно тот файл,
// который вернул индекс. Если она не выше, чем после обычного grep, — слой удаляется,
// а не оптимизируется. Пишем в тот же лог, что и надзиратель.
const STATS_LOG = process.env.PI_CODE_SEARCH_LOG ?? process.env.BENCH_SUPERVISOR_LOG ?? '';
const TIMEOUT_MS = 30000;

// Слова, которые встречаются в командах и коде так часто, что обращение к индексу по ним
// только засоряет контекст.
const STOP = new Set(['grep', 'rg', 'cut', 'awk', 'sed', 'sort', 'head', 'tail', 'find', 'cat', 'uniq', 'wc', 'the', 'and', 'for', 'val', 'var', 'fun', 'class', 'true', 'false', 'null', 'return', 'import', 'override', 'private', 'public']);

const MISSING_INDEX = /index not found|run .{0,4}ast-index rebuild/i;

export default function activate(pi: ExtensionAPI) {
  if (/^(1|true|yes)$/i.test(process.env.PI_CODE_SEARCH_OFF ?? '')) return;
  if (!/^(1|true|yes)$/i.test(process.env.PI_CODE_SEARCH_INTERCEPT ?? '')) return;
  if (!fs.existsSync(AST)) return;

  const cache = new Map<string, string>();
  let rebuilt = false;
  // Метрика: какие файлы предложил индекс и открыла ли их модель дальше.
  let delivered = new Set<string>();
  let deliveredTotal = 0;
  let deliveredUsed = 0;
  const stats = (kind: string, extra: Record<string, unknown> = {}) => {
    if (!STATS_LOG) return;
    try { fs.appendFileSync(STATS_LOG, `${JSON.stringify({ at: new Date().toISOString(), kind, deliveredTotal, deliveredUsed, ...extra })}\n`); } catch { /* телеметрия не должна ломать прогон */ }
  };

  // Файл из выдачи индекса открыли дальше? Считаем это попаданием.
  pi.on('tool_call', event => {
    try {
      if (!delivered.size) return;
      const p = String((event.input as { path?: string } | undefined)?.path ?? '');
      if (!p) return;
      const norm = p.replace(/\\/g, '/');
      for (const d of delivered) {
        if (norm.endsWith(d) || d.endsWith(norm)) {
          deliveredUsed += 1;
          delivered.delete(d);
          stats('index_hit', { path: norm.split('/').slice(-3).join('/') });
          break;
        }
      }
    } catch { /* метрика вспомогательная */ }
  });

  pi.on('tool_result', async event => {
    try {
      const names = candidates(event.toolName, event.input);
      if (!names.length) return;
      const blocks: string[] = [];
      for (const name of names.slice(0, 2)) {
        let block = await refs(name, cache);
        if (!block && !rebuilt) {
          // Индекса нет — построим один раз за сессию и повторим. Тот же самозапуск,
          // что и в инструменте ast: без него первый запрос в новом проекте бесполезен.
          rebuilt = true;
          await run(['rebuild'], 300000);
          block = await refs(name, cache);
        }
        if (block) blocks.push(block);
        if (block) {
          // Запоминаем предложенные индексом пути — по ним потом считаем попадания.
          for (const m of block.matchAll(/([\w./\\-]+\.(?:kt|java|kts|xml)):\d+/g)) delivered.add(m[1].replace(/\\/g, '/'));
          deliveredTotal += 1;
          stats('index_delivered', { name });
        }
      }
      if (!blocks.length) return;
      return { content: [...event.content, { type: 'text' as const, text: blocks.join('\n') }] };
    } catch {
      return; // вспомогательный механизм: молча пропускаем
    }
  });
}

// Какие имена символов искать по этому вызову инструмента.
function candidates(toolName: string, input: Record<string, unknown> | undefined): string[] {
  const args = input ?? {};
  if (toolName === 'grep') {
    if (args.literal === true) return []; // ищут буквальную строку, а не символ
    return [symbolFromPattern(String(args.pattern ?? ''))].filter(Boolean) as string[];
  }
  if (toolName === 'bash') return symbolsFromBash(String(args.command ?? ''));
  return [];
}

// «Foo», "\bFoo\b", "^Foo$", "\"Foo\"" → Foo. Всё остальное (регулярки, фразы) — мимо.
function symbolFromPattern(pattern: string): string | null {
  const cleaned = pattern
    .replace(/^\^|\$$/g, '')
    .replace(/\\b|\\<|\\>|\(\?|\)/g, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(cleaned)) return null;
  if (STOP.has(cleaned.toLowerCase())) return null;
  return cleaned;
}

// Имя символа из простой команды `grep -rn "Foo" путь` или `rg -n Foo`.
// Пайплайны (`| cut …`) не мешают: имя берётся из части grep/rg, остальное не трогаем.
// Кавычки разбираем как единое целое: иначе `"some long phrase"` распадается на слова
// и первое из них уходит в индекс как будто это символ.
function symbolsFromBash(command: string): string[] {
  const parts = command.split(/\s+/);
  const start = parts.findIndex(t => t === 'grep' || t === 'rg' || /[\\/](grep|rg)(\.exe)?$/.test(t));
  if (start < 0) return [];
  const tail = command.slice(command.indexOf(parts[start]) + parts[start].length);
  const quoted = [...tail.matchAll(/"([^"]*)"|'([^']*)'/g)].map(m => m[1] ?? m[2]);
  if (quoted.length) {
    const first = quoted[0].trim();
    return /^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(first) && !STOP.has(first.toLowerCase()) ? [first] : [];
  }
  for (let i = start + 1; i < parts.length; i += 1) {
    const token = parts[i];
    if (!token) continue;
    if (token.startsWith('-')) continue; // флаг
    if (/[\\/]/.test(token) || /\.\w{1,5}$/.test(token)) return []; // это уже путь
    if (/^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(token) && !STOP.has(token.toLowerCase())) return [token];
    return []; // фраза или регулярка — не наш случай
  }
  return [];
}

// Обращение к индексу: `refs` даёт и объявление, и использования — одним вызовом.
async function refs(name: string, cache: Map<string, string>): Promise<string | null> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached || null;
  const output = await run(['refs', name, '--limit', String(REF_LIMIT)], TIMEOUT_MS);
  const lines = output.split(/\r?\n/).filter(line => line.trim() && !/^Cross-references/i.test(line.trim()));
  // «No references found» — это не ответ, а пустота: подмешивать её к результату grep
  // значит засорять контекст и намекать модели, что символа нет, хотя поиск шёл по тексту.
  if (!lines.length || MISSING_INDEX.test(output) || /No references found/i.test(output)) {
    cache.set(name, '');
    return null;
  }
  const refLines = lines.filter(line => /\.(kt|java|xml):\d+/.test(line)).length;
  const maybeTruncated = refLines >= REF_LIMIT;
  const shown = lines.slice(0, MAX_LINES);
  const text = [
    `[индекс] ${name} — объявления и использования (типизировано, без текстового шума${maybeTruncated ? `; ВОЗМОЖНО НЕПОЛНО: достигнут лимит ${REF_LIMIT}, часть ссылок не показана` : ''}${lines.length > MAX_LINES ? `, показаны первые ${MAX_LINES} из ${lines.length}` : ''}):`,
    ...shown
  ].join('\n');
  cache.set(name, text);
  return text;
}

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    execFile(AST, args, { cwd: PROJECT, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error && !stdout ? '' : String(stdout || '')));
  });
}
