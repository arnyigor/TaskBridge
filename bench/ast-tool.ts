/**
 * Инструмент `ast` для бенчмарка: поиск по коду через ast-index одним вызовом.
 *
 * Зачем. Требование «пользуйся ast-index» лежало строкой в системном промпте — и
 * модель его игнорировала: в четырёх прогонах ноль обращений, весь поиск шёл через
 * grep/read. Причина не в цене инструмента: `rebuild` на этом проекте — 0.31 с
 * (127 файлов, индекс 1.86 МБ), а `class FeedDao` после него отвечает за 3 мс.
 * Причина в том, что требуемая практика была ПРАВИЛОМ, а не инструментом: её не
 * видно в списке инструментов, и до первого полезного запроса надо было догадаться
 * сделать `rebuild`.
 *
 * Тот же урок, что с `verify`: обращений к устройству было 0, пока проверка не стала
 * инструментом — и 31, как только стала. Здесь делается ровно то же.
 *
 * Второй инструмент, `sg`, добавлен после разбора того же вопроса для ДРУГИХ языков.
 * ast-index закрывает Kotlin/Java; для JS/TS/TSX/Python/Go/Rust/… структурный поиск делает
 * ast-grep (tree-sitter, один бинарь). Замеры (331 сессия, 4 репозитория) говорят, что
 * заменять им текстовый поиск НЕЛЬЗЯ: rg выигрывает 9 классов запросов из 12, а ast-grep —
 * ровно один, зато решающий — структурные запросы в React/TSX, где rg даёт 0 % попаданий.
 * Поэтому здесь два инструмента с разными задачами, а не один «умный»:
 *   ast — символы/классы Kotlin и Java по индексу (миллисекунды);
 *   sg  — структурный паттерн и разбор файла для остальных языков.
 * Отдельный инструмент для ripgrep не нужен: встроенный grep в pi уже использует его.
 *
 * Замеченные грабли ast-grep, учтённые в обёртке:
 *   · `sg` — устаревшее имя, зовём `ast-grep`;
 *   · грамматика -l должна совпадать с расширением (tsx ≠ jsx), иначе ТИХО ноль попаданий;
 *   · сломанный паттерн даёт код возврата 0 и лишь предупреждение → это надо назвать явно;
 *   · POSIX-путь (/tmp/…) Windows-бинарь не резолвит — путь приводится к нативному.
 *
 * Подключается на прогон: pi -e bench/ast-tool.ts …
 * Настройка: BENCH_AST_INDEX, BENCH_AST_GREP (пути к бинарям), BENCH_PROJECT (корень проекта).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

const AST = process.env.BENCH_AST_INDEX ?? 'G:/Android/plugins/ast-index.exe';
// Признак того, что индекса для этого проекта ещё нет. Без самозапуска первый же
// запрос в новом проекте вернул бы это сообщение — и модель ушла бы в grep.
const MISSING_INDEX = /index not found|run .{0,4}ast-index rebuild/i;
// Важно: в npm-глобале имя `ast-grep` — это shell-скрипт, а execFile на Windows его
// не запускает (ENOENT). Ищем нативный .exe; на этот случай есть явная ошибка в выводе.
const AST_GREP = resolveAstGrep();

function resolveAstGrep(): string {
  const npmGlobal = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@ast-grep', 'cli') : '';
  const candidates = [
    process.env.BENCH_AST_GREP,
    npmGlobal ? path.join(npmGlobal, 'ast-grep.exe') : '',
    npmGlobal ? path.join(npmGlobal, 'node_modules', '@ast-grep', 'cli-win32-x64-msvc', 'ast-grep.exe') : ''
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* недоступный путь — пропускаем */ }
  }
  return 'ast-grep'; // последняя надежда: бинарь в PATH (Linux, macOS, ручная установка)
}
const PROJECT = process.env.BENCH_PROJECT ?? process.cwd();
const TIMEOUT_MS = Number(process.env.BENCH_AST_TIMEOUT_MS ?? 120000);
// ast-index обрезает вывод ПО УМОЛЧАНИЮ (class/refs — 20, usages — 50) и НИЧЕГО об этом не
// сообщает: список просто заканчивается. Это уже дало уверенно неверный ответ — «20 объявлений
// Params» вместо 42: модель приняла обрезок за полный список. Поэтому лимит запроса задаём
// явно и отдельно проверяем, не упёрлись ли в него.
const QUERY_LIMIT = Number(process.env.BENCH_AST_QUERY_LIMIT ?? 500);
// Лимит запроса поддерживают не все подкоманды — проверено по --help у каждой.
const LIMIT_OPS = new Set(['class', 'symbol', 'usages', 'refs', 'implementations', 'file', 'search']);

// Грамматики, которые реально встроены в ast-grep 0.45 (проверено вызовом на каждой; чужие
// языки бинарь отвергает с «… is not supported!»). Держим списком, чтобы модель не гадала имя.
const SG_LANGS = [
  'js', 'jsx', 'ts', 'tsx', 'python', 'java', 'kotlin', 'go', 'rust', 'c', 'cpp',
  'ruby', 'php', 'html', 'css', 'json', 'yaml', 'bash', 'cs', 'swift', 'scala'
] as const;

// ast-grep печатает предупреждение об устаревшем имени `sg` в stderr; оно не является ошибкой.
const SG_NOISE = /\(WARNING|ERROR\).*sg.*deprecated|^=+$/i;

// Что именно умеет ast-index и как называется подкоманда. Список намеренно короткий:
// это те операции, которые заменяют собой связку grep+read+sed.
const OPERATIONS = [
  'class', 'symbol', 'usages', 'refs', 'outline', 'file', 'search',
  'implementations', 'hierarchy', 'imports', 'deps', 'stats', 'rebuild', 'update'
] as const;

export default function activate(pi: ExtensionAPI) {
  // Выключатель для чистых плечей A/B: без него «до» и «после» отличались бы не одним
  // фактором, а состоянием установки расширения (инструменты есть/нет из-за переустановки).
  if (/^(1|true|yes)$/i.test(process.env.PI_CODE_SEARCH_OFF ?? '')) return;
  pi.registerTool({
    name: 'ast',
    label: 'Поиск по коду (ast-index)',
    description: [
      'Структурный поиск по коду через ast-index: классы, символы, использования, ссылки,',
      'разбор файла по символам, зависимости модулей. Работает по индексу, поэтому отвечает',
      'за миллисекунды и точно, в отличие от текстового grep.',
      'Предпочитай этот инструмент вместо grep/read, когда нужен символ, класс, его использования',
      'или устройство файла. Индекс уже построен на стенде; если он устарел после правок — операция update.',
      'Работает только по Kotlin и Java: в проекте на Python, JS или другом языке ищи инструментом sg.',
    ].join(' '),
    promptSnippet: 'ast — структурный поиск по коду (классы, символы, использования) через ast-index (Kotlin/Java)',
    promptGuidelines: [
      'Ищи классы, символы и использования инструментом ast, а не grep: он работает по индексу и точнее.',
      'Устройство файла смотри через ast (operation=outline), а не чтением файла целиком.',
      'Если проект не на Kotlin/Java — используй sg: ast по нему не работает.',
    ],
    parameters: Type.Object({
      operation: StringEnum(OPERATIONS, { description: 'Что искать: class, symbol, usages, refs, outline, file, search, implementations, hierarchy, imports, deps, stats, rebuild, update.' }),
      query: Type.Optional(Type.String({ description: 'Имя класса/символа, путь к файлу или текст — зависит от operation.' })),
      limit: Type.Optional(Type.Number({ description: 'Ограничить число строк вывода (по умолчанию 60).' })),
    }),
    async execute(_id, params, _signal) {
      const operation = String(params.operation);
      const args = [operation];
      if (params.query) args.push(String(params.query));
      if (LIMIT_OPS.has(operation)) args.push('--limit', String(QUERY_LIMIT));
      // Самозапуск: если индекса для проекта нет, строим его сами и повторяем запрос
      // один раз. rebuild дешёвый (0.18 с на одном файле, 0.31 с на 127 файлах), но на
      // большом репозитории может быть долгим, поэтому — только лениво и по таймауту.
      let result = await run(AST, args);
      let bootstrapNote = '';
      if (MISSING_INDEX.test(`${result.stdout}${result.stderr}`)) {
        const rebuild = await run(AST, ['rebuild'], Number(process.env.BENCH_AST_REBUILD_TIMEOUT_MS ?? 300000));
        if (rebuild.spawnError) {
          bootstrapNote = `индекс отсутствовал, построить не удалось: ${rebuild.spawnError}`;
        } else if (MISSING_INDEX.test(`${rebuild.stdout}${rebuild.stderr}`) && rebuild.code !== 0) {
          bootstrapNote = 'индекс отсутствовал, rebuild завершился ошибкой';
        } else {
          result = await run(AST, args);
          bootstrapNote = 'индекса не было — построен автоматически, запрос повторён';
        }
      }
      const limit = Number(params.limit ?? 60);
      const lines = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/) : [];
      // Считаем ЗАПИСИ (путь:строка), а не строки вывода: иначе в число попадает шапка
      // «Classes matching 'Params':» — и инструмент сообщает 43 там, где объявлений 42.
      // Модель этому числу верит и отвечает неверно: такая ошибка уже выпала в прогоне C-1.
      const found = lines.filter(l => /\.(kt|java|xml):\d+/.test(l)).length;
      const truncated = LIMIT_OPS.has(operation) && found >= QUERY_LIMIT;
      const shown = lines.length > limit ? [...lines.slice(0, limit), `… ещё ${lines.length - limit} строк`] : lines;
      const text = [
        `ast ${operation}${params.query ? ` ${params.query}` : ''} → ${found ? `найдено ${found}` : lines.length ? `${lines.length} строк` : 'пусто'}`,
        truncated ? `ВНИМАНИЕ: найдено не меньше ${QUERY_LIMIT} — вывод обрезан лимитом запроса. Уточни запрос или увеличь BENCH_AST_QUERY_LIMIT, иначе ответ неполный.` : '',
        !lines.length && !truncated && !['rebuild', 'update', 'stats'].includes(operation)
          ? 'Ничего не найдено. Индекс работает только по Kotlin и Java: для Python, JS и других языков используй инструмент sg.' : '',
        bootstrapNote ? `(${bootstrapNote})` : '',
        shown.join('\n'),
        result.spawnError ? `ОШИБКА ЗАПУСКА: ${result.spawnError}` : '',
        result.stderr.trim() ? `stderr: ${result.stderr.trim().slice(0, 300)}` : ''
      ].filter(Boolean).join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        details: { operation, exitCode: result.code, lines: lines.length },
        isError: false
      };
    },
  });

  pi.registerTool({
    name: 'sg',
    label: 'Структурный поиск (ast-grep)',
    description: [
      'Структурный поиск по синтаксису для языков, которых нет в ast-index: JS/TS/JSX/TSX,',
      'Python, Go, Rust, C/C++, Ruby, PHP, HTML, CSS, JSON, YAML, Kotlin, Java и др.',
      'Понимает код как дерево, а не как текст: `console.log($A)` найдёт вызовы с любым аргументом,',
      '`$X && $X()` — все места, где что-то вызывают после проверки на истинность.',
      'operation=outline даёт структуру файла (классы, методы, функции) одним вызовом.',
      'Для точной строки или имени используй обычный grep/ast: текстовый поиск быстрее и точнее по буквам.',
      'Грамматика должна совпадать с расширением файла (tsx ≠ jsx), иначе будет пусто без ошибки.',
    ].join(' '),
    promptSnippet: 'sg — структурный поиск по синтаксису (ast-grep) для JS/TS/Python/Go/Rust/…',
    promptGuidelines: [
      'Нужен шаблон кода, а не строка — используй sg (pattern + lang), а не grep.',
      'Структуру незнакомого файла на JS/TS/Python/… смотри через sg (operation=outline).',
      'Не подменяй sg текстовый поиск: для точного имени или строки быстрее обычный grep.',
    ],
    parameters: Type.Object({
      operation: StringEnum(['search', 'outline'] as const, { description: 'search — найти паттерн; outline — структура файла (классы, методы, функции).' }),
      pattern: Type.Optional(Type.String({ description: 'Шаблон кода для search. `$A` — любой один узел, `$$$` — любая последовательность. Пример: `function $N($$$) { $$$ }`.' })),
      lang: Type.Optional(StringEnum(SG_LANGS, { description: 'Язык (js, tsx, python, go, rust, …). Обязателен для search, если путь — не файл с известным расширением.' })),
      path: Type.Optional(Type.String({ description: 'Файл или каталог. По умолчанию — корень проекта.' })),
      limit: Type.Optional(Type.Number({ description: 'Ограничить число совпадений в выводе (по умолчанию 40).' })),
    }),
    async execute(_id, params, _signal) {
      const operation = String(params.operation);
      const target = path.resolve(PROJECT, String(params.path ?? '.'));
      const lang = params.lang ? String(params.lang) : undefined;
      const limit = Number(params.limit ?? 40);

      if (operation === 'outline') {
        const args = ['outline', ...(lang ? ['-l', lang] : []), target];
        const r = await run(AST_GREP, args);
        return sgResult(r, `sg outline ${params.path ?? '.'}`, limit, false);
      }

      const pattern = params.pattern ? String(params.pattern) : '';
      if (!pattern) {
        return { content: [{ type: 'text' as const, text: 'sg: для operation=search нужен pattern (например `function $N($$$) { $$$ }`).' }], isError: false };
      }
      const args = ['-p', pattern, '--json=stream', ...(lang ? ['-l', lang] : []), target];
      const r = await run(AST_GREP, args);
      const matches: string[] = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const j = JSON.parse(t) as { file?: string; range?: { start?: { line?: number } }; text?: string };
          const oneLine = String(j.text ?? '').replace(/\s+/g, ' ').trim();
          const text = oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
          matches.push(`${j.file}:${(j.range?.start?.line ?? 0) + 1}: ${text}`);
        } catch { /* строка не JSON — пропускаем */ }
      }
      const shown = matches.length > limit ? [...matches.slice(0, limit), `… ещё ${matches.length - limit}`] : matches;
      const broken = /ERROR node/i.test(`${r.stdout}${r.stderr}`);
      const head = [
        `sg ${pattern}${lang ? ` [${lang}]` : ''} → ${matches.length} совпадений`,
        r.spawnError ? `ОШИБКА ЗАПУСКА: ${r.spawnError}` : '',
        broken ? 'ВНИМАНИЕ: паттерн не разобран как код (ERROR node) — результат недостоверен, уточни шаблон.' : '',
        !matches.length && !broken && !r.spawnError ? 'Ничего не найдено. Если файл не на том языке, что указан в lang, попаданий не будет и ошибки тоже не будет — проверь расширение и -l.' : ''
      ].filter(Boolean);
      return {
        content: [{ type: 'text' as const, text: [...head, shown.join('\n')].filter(Boolean).join('\n') }],
        details: { operation, pattern, lang: lang ?? null, matches: matches.length, exitCode: r.code },
        isError: false
      };
    },
  });
}

// Единый запуск внешнего бинаря: код выхода, stdout, stderr. execFile без shell — аргументы
// вроде `$$$` и `$A` доходят до ast-grep как есть, без подстановок оболочки.
function run(bin: string, args: string[], timeoutMs: number = TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string; spawnError: string }> {
  return new Promise(resolve => {
    execFile(bin, args, { cwd: PROJECT, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // Разделяем два разных отказа: ненулевой код возврата (у процесса есть код и вывод)
        // и невозможность запуска вообще (ENOENT/EACCES — кода возврата нет). Без этого
        // сломанный бинарь выглядел бы как честное «ничего не найдено».
        const e = error as (NodeJS.ErrnoException | null);
        const spawnError = e && typeof e.code === 'string' ? `${e.code}: ${e.message ?? ''}` : '';
        const code = e && typeof e.code === 'number' ? e.code : e ? 1 : 0;
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || ''), spawnError });
      });
  });
}

// Показ результата outline: убираем служебный шум ast-grep, ограничиваем строки.
function sgResult(r: { code: number; stdout: string; stderr: string; spawnError: string }, title: string, limit: number, _json: boolean) {
  const lines = r.stdout.split(/\r?\n/).filter(l => l.trim() && !SG_NOISE.test(l.trim()));
  const shown = lines.length > limit ? [...lines.slice(0, limit), `… ещё ${lines.length - limit} строк`] : lines;
  const err = r.stderr.split(/\r?\n/).filter(l => l.trim() && !SG_NOISE.test(l.trim())).join(' ').slice(0, 300);
  return {
    content: [{ type: 'text' as const, text: [
      `${title} → ${lines.length ? `${lines.length} строк` : 'пусто'}`,
      shown.join('\n'),
      r.spawnError ? `ОШИБКА ЗАПУСКА: ${r.spawnError}` : '',
      err ? `stderr: ${err}` : ''
    ].filter(Boolean).join('\n') }],
    details: { exitCode: r.code, lines: lines.length, spawnError: r.spawnError || null },
    isError: false
  };
}
