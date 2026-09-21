import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Установка обвязки так, чтобы она работала при ОБЫЧНОМ запуске `pi` в консоли —
// без раннера и без флагов `-e`.
//
//   node bench/install.mjs                      # в текущий проект (.pi/extensions/bench-harness)
//   node bench/install.mjs --project <каталог>  # в указанный проект
//   node bench/install.mjs --global             # глобально (все сессии pi)
//   node bench/install.mjs --global --tools-only # глобально и только поиск по коду
//   node bench/install.mjs --global --tools-only --with-supervisor  # + напоминания при застое
//   node bench/install.mjs --uninstall          # снести
//
// Pi ищет расширения в двух местах (loader.js): `<cwd>/.pi/extensions/` и
// `<agentDir>/extensions/`. Проектная установка — предпочтительная: обвязка
// появляется только в том проекте, где идёт работа, и не влияет на остальные сессии.
//
// Что ставится: надзиратель, инструмент `verify`, инструмент `ast` и сценарий
// проверки. Скрипты копируются рядом, поэтому пути внутри них (они считаются от
// собственного файла) остаются рабочими.
//
// Чего установка НЕ делает: сужение MCP-инструментов. Это флаг запуска
// (`--mcp-config <этот-каталог>/mcp-bench.json`) — его надо добавлять к команде pi.

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'bench-harness';
const FULL_PAYLOAD = ['supervisor.ts', 'verify-tool.ts', 'ast-tool.ts', 'verify-scenario.mjs', 'mcp-bench.json'];
// Режим «только инструменты» — для глобальной установки: поиск по коду уместен в любом
// проекте, а проверка на устройстве — нет. `verify`/`repro` требуют эмулятора, фикстуры
// и BENCH_APP, в обычном проекте это мусор в списке инструментов.
// Надзиратель здесь тоже не ставится намеренно: его инъекции и гейт — это логика стенда,
// а не инструмент. Сначала смотрим, хватает ли модели одного описания инструмента, и
// только потом добавляем напоминания — если замер покажет, что они нужны.

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) argv.set(token.replace(/^--/, ''), true);
  else { argv.set(token.replace(/^--/, ''), next); i += 1; }
}

const GLOBAL = Boolean(argv.get('global'));
const TOOLS_ONLY = Boolean(argv.get('tools-only'));
// Надзиратель — против «ухода в раздумья»: мягко напоминает после 8 шагов без правки и
// на 4-м повторе одного действия. Нужен там, где модель застревает в анализе, но его
// инъекции — это вмешательство в диалог, поэтому включается отдельным флагом.
const WITH_SUPERVISOR = Boolean(argv.get('with-supervisor'));
const PAYLOAD = TOOLS_ONLY
  ? (WITH_SUPERVISOR ? ['ast-tool.ts', 'code-intercept.ts', 'supervisor.ts'] : ['ast-tool.ts', 'code-intercept.ts'])
  : FULL_PAYLOAD;
const PROJECT = path.resolve(String(argv.get('project') || process.cwd()));
const TARGET = GLOBAL
  ? path.join(os.homedir(), '.pi', 'agent', 'extensions', NAME)
  : path.join(PROJECT, '.pi', 'extensions', NAME);

if (argv.get('uninstall')) {
  fs.rmSync(TARGET, { recursive: true, force: true });
  console.log(`удалено: ${TARGET}`);
  process.exitCode = 0;
} else {
  fs.mkdirSync(TARGET, { recursive: true });
  for (const file of PAYLOAD) {
    const from = path.join(here, file);
    if (!fs.existsSync(from)) throw new Error(`нет файла ${from}`);
    fs.copyFileSync(from, path.join(TARGET, file));
  }
  // Точка входа расширения: pi грузит index.ts, он поднимает нужные части.
  // Локальные .ts-импорты поддерживаются (так устроено расширение subagent).
  const entry = TOOLS_ONLY
    ? `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import astTool from "./ast-tool.ts";
import codeIntercept from "./code-intercept.ts";${WITH_SUPERVISOR ? '\nimport supervisor from "./supervisor.ts";' : ''}

// Инструменты поиска по коду: ast (ast-index, Kotlin/Java) и sg (ast-grep, остальные языки).
// Индекс ast-index строится сам при первом запросе; в проект ничего не пишется
// (кэш живёт в %LOCALAPPDATA%\\ast-index).
// Перехват текстового поиска включается отдельно: PI_CODE_SEARCH_INTERCEPT=1.
${WITH_SUPERVISOR ? '// Надзиратель включён: напоминания при застое (BENCH_NUDGE_AFTER, BENCH_REPEAT_LIMIT).\n' : ''}export default function activate(pi: ExtensionAPI) {
  astTool(pi);
  codeIntercept(pi);${WITH_SUPERVISOR ? '\n  supervisor(pi);' : ''}
}
`
    : `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import supervisor from "./supervisor.ts";
import verifyTool from "./verify-tool.ts";
import astTool from "./ast-tool.ts";

// Обвязка стенда: надзиратель + проверка на устройстве + структурный поиск.
// Ставится командой bench/install.mjs; удаляется вместе с этим каталогом.
export default function activate(pi: ExtensionAPI) {
  supervisor(pi);
  verifyTool(pi);
  astTool(pi);
}
`;
  fs.writeFileSync(path.join(TARGET, 'index.ts'), entry);

  console.log(`установлено в ${TARGET}`);
  console.log(`  файлы: ${PAYLOAD.join(', ')}, index.ts`);
  console.log(TOOLS_ONLY ? '  режим: только поиск по коду (ast, sg)' : '  режим: полная обвязка стенда');
  console.log('\nкак пользоваться:');
  if (!GLOBAL || !TOOLS_ONLY) console.log(`  cd ${PROJECT}`);
  if (TOOLS_ONLY) {
    console.log('  pi -p "задача"        # инструменты ast и sg подхватятся сами, индекс построится при первом запросе');
    console.log('\nпредупреждение: инструмент ast работает по Kotlin/Java; для остальных языков — sg.');
  } else {
    console.log('  BENCH_APP=<пакет> pi -p "задача"          # инструменты verify и ast подхватятся сами');
    console.log('\nчтобы заодно сузить набор MCP-инструментов (82 → 5):');
    console.log(`  pi --mcp-config ${path.join(TARGET, 'mcp-bench.json')} -p "задача"`);
    console.log('\nпеременные (необязательные):');
    console.log('  BENCH_APP        id приложения для verify (напр. com.arny.habrrss.b1)');
    console.log('  BENCH_PROJECT    корень проекта для ast-index (по умолчанию текущий каталог)');
    console.log('  BENCH_GATE=1     надзиратель отнимает verify, пока нет ни одной правки');
    console.log('  BENCH_AST_INDEX  путь к ast-index.exe (по умолчанию G:/Android/plugins/ast-index.exe)');
  }
  console.log(`\nснести: node bench/install.mjs ${GLOBAL ? '--global ' : ''}--uninstall`);
}
