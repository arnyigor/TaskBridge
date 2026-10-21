#!/usr/bin/env node
// OMP-02: честное сравнение Pi и OMP на сложных правках кода.
//
//   node experiments/omp-02/run-comparison.mjs --variant pi-a --only CODE-01
//   node experiments/omp-02/run-comparison.mjs --variant all
//
// Что делает прогон: чистая копия фикстуры → один запрос агенту через RPC →
// ожидание завершения → снимок файлов → проверка состояния среды (тесты,
// компиляция, отсутствие лишних правок) → запись метрик в run.json.
// Ничего в рабочем TaskBridge, конфигурации Pi и активных сессиях не меняется:
// у каждого прогона свой каталог, свои сессии, свой профиль OMP и отдельный
// каталог конфигурации Pi (PI_CODING_AGENT_DIR).
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PiRpc } from '../pi-hooks/pi-rpc-client.mjs';
import { OmpRpc, summarizeFrames } from '../omp-01/omp-rpc-client.mjs';
import { prepareWorkspace, snapshot, diffSnapshots, approxDiff } from './fixtures/build.mjs';
import { checkScenario } from './checks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const model = argValue('--model', 'deepseek-flash');
const thinking = argValue('--thinking', 'high');
const timeoutMs = Number(argValue('--timeout', '900000'));
const variantFilter = argValue('--variant', 'all').split(',').map(item => item.trim()).filter(Boolean);
const only = (argValue('--only', '') || '').split(',').map(item => item.trim()).filter(Boolean);
const out = path.resolve(argValue('--out', path.join(repo, '.local', 'omp-02', `run-${Date.now()}`)));

const PROMPTS = {
  'CODE-01': [
    'Задача: перевести цены магазина с double (рубли) на long (копейки), не меняя поведение и формат вывода.',
    'Точный контракт, его нужно соблюсти дословно:',
    '- Item: убрать getPrice(): double, добавить priceCents(): long; цена хранится в копейках.',
    '- ItemRepository: totalPrice(): double → totalCents(): long.',
    '- Cart: subtotal(): double → subtotalCents(): long; totalWithVat(double rate): double → totalWithVatCents(double rate): long, где результат Math.round(subtotalCents() * (1 + rate)).',
    '- ReceiptFormatter: line(Item) сохраняет подпись и возвращает ту же строку; total(double) → totalCents(long) с тем же форматом.',
    '- Checkout и Main обновить под новый API; Main проверяет те же значения и печатает OK.',
    'Сборка и проверка: javac -encoding UTF-8 -d out src/shop/*.java && java -cp out shop.Main',
    'Структуру каталогов и остальные классы не трогай.',
  ].join('\n'),
  'CODE-02': 'Тесты в этом проекте падают. Найди корневую причину и исправь её минимальным изменением в исходном коде. Тесты не менять: после правки `npm test` должен проходить.',
  'CODE-03': 'Файл src/big.mjs содержит тысячи строк. Функция sliceWindow(values, start, length) должна возвращать ровно length элементов, начиная с индекса start, а сейчас возвращает лишний элемент. Исправь только эту функцию, остальной файл не трогай. `npm test` должен проходить.',
  'CODE-04': 'Измени API: функция fetchUser(id) в src/api.mjs должна стать loadUser({ id }). Обнови её реализацию, все вызовы во всех файлах проекта (src/services/*.mjs, src/index.mjs) и соответствующие импорты. Поведение не меняй: `npm test` должен проходить.',
};

const VARIANTS = {
  'pi-a': { runtime: 'pi', label: 'A: Pi 1.3.0, сопоставимый набор инструментов (read,write,edit,bash,grep,find,ls)' },
  'omp-b': { runtime: 'omp', label: 'B: OMP 18.11.0, сопоставимый набор инструментов (read,write,edit,bash,grep,glob, без LSP/PTY)' },
  'omp-c': { runtime: 'omp', label: 'C: OMP 18.11.0, штатные инструменты (LSP, PTY, все builtin)' },
};

function run(command, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: process.platform === 'win32' });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', error => resolve({ code: -1, text: `${text}\n${error.message}` }));
    child.on('exit', code => resolve({ code: code ?? -1, text }));
  });
}

async function version(command) {
  const result = await run(command, ['--version'], repo);
  return result.text.trim().split('\n')[0] || null;
}

/** Размер правки по снимкам: какие файлы изменены и сколько строк затронуто. */
function lineDiff(before, after) {
  const files = [];
  let lines = 0;
  for (const [file, body] of after) {
    if (!before.has(file)) {
      files.push(file);
      lines += body.split('\n').length;
      continue;
    }
    if (before.get(file) === body) continue;
    files.push(file);
    const counts = approxDiff(before.get(file), body);
    lines += counts.added + counts.removed;
  }
  for (const [file, body] of before) {
    if (after.has(file)) continue;
    files.push(file);
    lines += body.split('\n').length;
  }
  return { files, lines };
}

function piArgs({ sessions }) {
  return [
    '--approve',
    '--session-dir', sessions,
    '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates',
    '--tools', 'read,write,edit,bash,grep,find,ls',
    '--model', `deepseek/${model}`,
    '--thinking', thinking,
  ];
}

function ompArgs({ sessions, variant }) {
  const common = [
    '--mode', 'rpc', '--no-ui', '--auto-approve',
    '--session-dir', sessions,
    '--no-extensions', '--no-skills', '--no-rules',
    '--model', model,
    '--thinking', thinking,
  ];
  if (variant === 'omp-c') return ['--profile', 'omp02-c', ...common];
  return ['--profile', 'omp02-b', '--no-lsp', '--no-pty', '--tools', 'read,write,edit,bash,grep,glob', ...common];
}

async function runOne({ variant, scenario, scenarioPrompt }) {
  const dir = path.join(out, `${variant}-${scenario}`);
  const workspace = path.join(dir, 'workspace');
  const sessions = path.join(dir, 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  await prepareWorkspace(scenario, workspace);
  const before = await snapshot(workspace);

  const started = Date.now();
  let firstActivityMs = null;
  let frames = [];
  let status = null;
  let settled = null;
  let error = null;
  let rpc = null;
  try {
    if (VARIANTS[variant].runtime === 'pi') {
      rpc = new PiRpc({
        cwd: workspace,
        args: piArgs({ sessions }),
        env: { PI_CODING_AGENT_DIR: path.join(out, 'pi-agent') },
      });
      // Pi не присылает отдельного кадра готовности: prompt принимается сразу
      // после старта. Ждать «ready» бессмысленно — это добавляло ровно 120 с
      // к каждому прогону и искажало wall-clock (найдено в первом прогоне).
      await rpc.waitFor(record => ['ready', 'session_ready', 'agent_ready'].includes(record.type), 2000).catch(() => null);
      const from = rpc.events.length;
      const onEvent = record => {
        if (firstActivityMs !== null) return;
        if (record.type === 'message_update' || record.type === 'tool_execution_start') {
          firstActivityMs = Date.now() - started;
        }
      };
      rpc.listeners.add(onEvent);
      const response = await rpc.send({ type: 'prompt', message: scenarioPrompt });
      if (!response.success) throw new Error(`prompt отклонён: ${JSON.stringify(response.error)}`);
      settled = await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).then(() => true, () => false);
      rpc.listeners.delete(onEvent);
      frames = rpc.events.slice(from);
      status = response.data?.disposition ?? 'started';
    } else {
      rpc = new OmpRpc({ cwd: workspace, args: ompArgs({ sessions, variant }) });
      await rpc.waitFor(frame => frame.type === 'ready', 120000).catch(() => null);
      await rpc.send({ type: 'negotiate_protocol', protocolVersion: 2 }).catch(() => null);
      const onFrame = frame => {
        if (firstActivityMs !== null) return;
        const activity = frame.type === 'tool_execution_start'
          || (frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta');
        if (activity) firstActivityMs = Date.now() - started;
      };
      rpc.listeners.add(onFrame);
      const turn = await rpc.promptAndWait(scenarioPrompt, { timeoutMs });
      rpc.listeners.delete(onFrame);
      frames = turn.frames || [];
      status = turn.result?.status ?? (turn.response.data?.agentInvoked === false ? 'local' : null);
      settled = turn.settled;
    }
  } catch (caught) {
    error = caught.message;
  } finally {
    if (rpc) await rpc.stop();
  }
  const wallMs = Date.now() - started;

  const after = await snapshot(workspace);
  const changed = diffSnapshots(before, after);
  const diffStat = lineDiff(before, after);
  const eventTypes = frames.reduce((acc, frame) => {
    acc[frame.type] = (acc[frame.type] || 0) + 1;
    return acc;
  }, {});
  const summary = summarizeFrames(frames);
  const targets = summary.toolCalls.map(call => `${call.name}:${call.target}`);
  let check = { ok: false, detail: { reason: 'не проверялось' } };
  if (!error) {
    check = await checkScenario(scenario, { workspace, diffStat, before }).catch(caught => ({ ok: false, detail: { reason: caught.message } }));
  }

  const record = {
    scenario,
    variant,
    runtime: VARIANTS[variant].runtime,
    variantLabel: VARIANTS[variant].label,
    model,
    thinking,
    ok: check.ok === true,
    error,
    status,
    settled,
    wallMs,
    firstActivityMs,
    toolCalls: summary.toolCalls.length,
    toolNames: summary.toolCalls.reduce((acc, call) => {
      acc[call.name] = (acc[call.name] || 0) + 1;
      return acc;
    }, {}),
    repeatedCalls: targets.length - new Set(targets).size,
    errorCalls: summary.toolCalls.filter(call => call.isError).length,
    tokens: summary.usage
      ? { input: summary.usage.input ?? null, output: summary.usage.output ?? null, total: summary.usage.totalTokens ?? null }
      : null,
    changedFiles: changed.map(item => item.file),
    diffLines: diffStat.lines,
    stopReason: summary.stopReason,
    errorMessage: summary.errorMessage,
    eventTypes,
    answerTail: (summary.text || '').slice(-600),
    check: check.detail,
  };
  await fs.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

const versions = { node: process.version, pi: await version('pi'), omp: await version('omp') };
await fs.mkdir(out, { recursive: true });
const variants = Object.keys(VARIANTS).filter(variant => variantFilter.includes('all') || variantFilter.includes(variant));
const scenarios = Object.keys(PROMPTS).filter(scenario => !only.length || only.includes(scenario));

const results = [];
// Пары «Pi → OMP» по одному сценарию подряд: условия времени и модели совпадают.
for (const scenario of scenarios) {
  for (const variant of variants) {
    process.stdout.write(`\n▶ ${scenario} / ${variant} (${VARIANTS[variant].runtime})\n`);
    const record = await runOne({ variant, scenario, scenarioPrompt: PROMPTS[scenario] });
    results.push(record);
    process.stdout.write(`${record.ok ? '✅' : '❌'} ${scenario}/${variant}: ${record.toolCalls} вызовов, ${Math.round(record.wallMs / 1000)} с, diff ${record.diffLines} строк${record.error ? `, ошибка: ${record.error}` : ''}\n`);
    await fs.writeFile(path.join(out, 'summary.json'), `${JSON.stringify({ at: new Date().toISOString(), model, thinking, versions, results }, null, 2)}\n`);
  }
}

const summary = {
  at: new Date().toISOString(),
  model,
  thinking,
  versions,
  runs: results.length,
  passed: results.filter(item => item.ok).length,
  results,
};
await fs.writeFile(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nИтог: ${summary.passed}/${summary.runs}; данные: ${path.relative(repo, path.join(out, 'summary.json'))}`);
