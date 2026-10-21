#!/usr/bin/env node
// OMP-01: шесть функциональных сценариев на синтетических фикстурах.
//
//   node experiments/omp-01/run-functional.mjs --model deepseek-flash
//
// Каждый сценарий: чистый каталог, своя сессия, один запрос; после прогона
// собираются факты — вызовы инструментов (включая повторы и ошибки), время до
// первого текста и до конца, токены, реальный diff файлов и результат тестов.
// Качество оценивается по состоянию среды (тесты/файлы), а не по рассказу агента.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OmpRpc, sleep, summarizeFrames } from './omp-rpc-client.mjs';
import { buildProject, buildCatalog, snapshot, diffSnapshots } from './fixtures/build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const model = argValue('--model', 'deepseek-flash');
const out = path.resolve(argValue('--out', path.join(repo, '.local', 'omp-01', `functional-${Date.now()}`)));
const only = (argValue('--only', '') || '').split(',').map(item => item.trim()).filter(Boolean);
const timeoutMs = Number(argValue('--timeout', '420000'));

const SCENARIOS = [
  {
    id: 'Q01', kind: 'lookup', fixture: 'catalog',
    prompt: 'Найди в каталоге Learning папку с курсом Blender и назови её полный путь.',
    check: ({ answer, toolTexts }) => /Blender Guru - Donut/i.test(toolTexts) && /Blender Guru - Donut/i.test(answer),
    expect: 'путь Learning/Blender/Blender Guru - Donut найден и назван',
  },
  {
    id: 'Q02', kind: 'lookup', fixture: 'catalog',
    prompt: 'Есть ли в каталоге Learning курс Nuke Compositing? Ответь коротко.',
    check: ({ answer, toolTexts }) => !/nuke/i.test(toolTexts) && /(нет|не найден|не нашёл|отсутств)/i.test(answer),
    expect: 'отсутствие названо словами, объекта нет',
  },
  {
    id: 'E01', kind: 'explore', fixture: 'project',
    prompt: 'Тесты в этом проекте падают. Найди причину и объясни её, ничего не меняя.',
    check: ({ answer, changed }) => changed.length === 0 && /multiply/i.test(answer),
    expect: 'причина названа (multiply), файлы не изменены',
  },
  {
    id: 'E02', kind: 'explore', fixture: 'project',
    prompt: 'Какие файлы зависят от src/calculator.mjs и что сломается, если изменить multiply? Ничего не меняй.',
    check: ({ answer, changed }) => changed.length === 0 && /format/i.test(answer) && /report/i.test(answer),
    expect: 'зависимости названы (format.mjs, report.mjs), файлы не изменены',
  },
  {
    id: 'D01', kind: 'implement', fixture: 'project',
    prompt: 'Исправь ошибку, из-за которой падают тесты, и убедись, что npm test проходит.',
    check: async ({ workspace }) => {
      const result = await runTests(workspace);
      return result.failed === 0 && result.passed >= 5;
    },
    expect: 'npm test: 5+ тестов, 0 провалов',
  },
  {
    id: 'D02', kind: 'implement', fixture: 'project',
    prompt: 'Добавь в src/calculator.mjs функцию subtract(a, b), а в src/format.mjs — функцию difference(a, b), которая возвращает "diff=<значение>". Добавь тесты на обе функции и проверь, что npm test проходит.',
    check: async ({ workspace, changed }) => {
      const calculator = await fs.readFile(path.join(workspace, 'src/calculator.mjs'), 'utf8').catch(() => '');
      const format = await fs.readFile(path.join(workspace, 'src/format.mjs'), 'utf8').catch(() => '');
      const result = await runTests(workspace);
      return changed.length >= 2 && /subtract/.test(calculator) && /difference/.test(format) && result.failed === 0;
    },
    expect: 'две функции, два+ файла изменены, тесты зелёные',
  },
];

function runTests(workspace) {
  return new Promise(resolve => {
    const child = spawn('npm', ['test'], { cwd: workspace, windowsHide: true, shell: process.platform === 'win32' });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('exit', code => {
      const passed = Number((/ℹ pass (\d+)/.exec(text) || [])[1] ?? 0);
      const failed = Number((/ℹ fail (\d+)/.exec(text) || [])[1] ?? (code === 0 ? 0 : 1));
      resolve({ code, passed, failed, tail: text.slice(-600) });
    });
  });
}

const ompVersion = await new Promise(resolve => {
  const child = spawn('omp', ['--version'], { windowsHide: true, shell: process.platform === 'win32' });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.on('exit', () => resolve(text.trim()));
});

await fs.mkdir(out, { recursive: true });
const results = [];
for (const scenario of SCENARIOS) {
  if (only.length && !only.includes(scenario.id)) continue;
  const dir = path.join(out, scenario.id);
  const workspace = path.join(dir, 'workspace');
  const sessions = path.join(dir, 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  if (scenario.fixture === 'catalog') await buildCatalog(workspace);
  else await buildProject(workspace);
  const before = await snapshot(workspace);

  const rpc = new OmpRpc({
    cwd: workspace,
    args: ['--mode', 'rpc', '--no-ui', '--profile', 'omp01', '--session-dir', sessions, '--model', model],
  });
  const started = Date.now();
  let firstTextMs = null;
  const onFrame = frame => {
    if (firstTextMs !== null) return;
    if (frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta') firstTextMs = Date.now() - started;
  };
  rpc.listeners.add(onFrame);
  let record;
  try {
    await rpc.waitFor(frame => frame.type === 'ready', 60000).catch(() => null);
    const turn = await rpc.promptAndWait(scenario.prompt, { timeoutMs });
    rpc.listeners.delete(onFrame);
    const frames = turn.frames || [];
    const summary = summarizeFrames(frames);
    const after = await snapshot(workspace);
    const changed = diffSnapshots(before, after);
    const toolTexts = frames
      .filter(frame => frame.type === 'tool_execution_end')
      .map(frame => JSON.stringify(frame.result ?? frame.output ?? ''))
      .join('\n');
    const targets = summary.toolCalls.map(call => `${call.name}:${call.target}`);
    const repeated = targets.length - new Set(targets).size;
    const errorCalls = summary.toolCalls.filter(call => call.isError).length;
    record = {
      id: scenario.id,
      kind: scenario.kind,
      prompt: scenario.prompt,
      expect: scenario.expect,
      status: turn.result?.status ?? (turn.response.data?.agentInvoked === false ? 'local' : null),
      settled: turn.settled,
      model,
      wallMs: Date.now() - started,
      firstTextMs,
      toolCalls: summary.toolCalls.length,
      repeatedCalls: repeated,
      errorCalls,
      tools: summary.toolCalls.map(call => `${call.name} ${call.target}`.trim()).slice(0, 30),
      tokens: summary.usage ? { input: summary.usage.input ?? null, output: summary.usage.output ?? null, total: summary.usage.totalTokens ?? null } : null,
      changedFiles: changed,
      answer: summary.text,
      stopReason: summary.stopReason,
      errorMessage: summary.errorMessage,
    };
    record.ok = await scenario.check({
      answer: summary.text,
      toolTexts,
      changed,
      workspace,
    });
  } catch (error) {
    rpc.listeners.delete(onFrame);
    record = { id: scenario.id, kind: scenario.kind, prompt: scenario.prompt, expect: scenario.expect, ok: false, error: error.message, wallMs: Date.now() - started };
  } finally {
    await rpc.stop();
  }
  await fs.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  results.push(record);
  console.log(`${record.ok ? '✅' : '❌'} ${record.id} — вызовов ${record.toolCalls ?? '?'}, ${Math.round((record.wallMs || 0) / 1000)} с${record.error ? `, ошибка: ${record.error}` : ''}`);
}

const summary = {
  at: new Date().toISOString(),
  omp: ompVersion,
  model,
  scenarios: results.length,
  passed: results.filter(item => item.ok).length,
  results,
};
await fs.writeFile(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nИтог: ${summary.passed}/${summary.scenarios} сценариев; отчёт: ${path.relative(repo, path.join(out, 'summary.json'))}`);
