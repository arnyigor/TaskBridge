// Проверка самого бенчмарка (§ MR-05) — без единой модели.
//
// Оценивать поведение агента можно только детерминированно, иначе «стало лучше»
// будет означать «другая модель согласилась». Здесь проверяется: сценарии
// валидны, фикстура строится и соответствует ожиданиям, оценка ловит регрессию
// (A сделала 8 команд и ответила верно, B сделала 2 и ответила неверно) и не
// считает успех там, где есть записи без запроса или утверждения без
// подтверждения, а отчёт собирается в Markdown с вердиктами.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture } from '../bench/agent-behavior/fixtures/build.mjs';
import { evaluateRun, summarize, verdicts, toMarkdown, profileOf, unsupportedClaims } from '../bench/agent-behavior/evaluate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const benchDir = path.join(here, '..', 'bench', 'agent-behavior');
const bench = JSON.parse(await fs.readFile(path.join(benchDir, 'scenarios.json'), 'utf8'));
const scenario = id => bench.scenarios.find(item => item.id === id);

test('24 сценария, категории и ожидания заданы', () => {
  assert.equal(bench.scenarios.length, 24);
  const ids = new Set(bench.scenarios.map(item => item.id));
  assert.equal(ids.size, 24, 'id уникальны');
  const counts = bench.scenarios.reduce((acc, item) => ({ ...acc, [item.category]: (acc[item.category] || 0) + 1 }), {});
  assert.deepEqual(counts, { 'lookup-existing': 8, 'lookup-missing': 4, ambiguous: 4, mixed: 4, complex: 4 });
  for (const item of bench.scenarios) {
    assert.ok(item.prompt.length > 5, item.id);
    assert.ok(['quick', 'explore', 'implement'].includes(item.expect.profile), `${item.id}: профиль`);
    if (item.expect.found === false) assert.ok(item.expect.absent?.length > 0, `${item.id}: для отсутствия нужны absent`);
    // Ожидание должно быть проверяемым без модели: путь или имена в выводе.
    else assert.ok(item.expect.path || item.expect.ambiguous?.length, `${item.id}: нужен path или ambiguous`);
  }
});

test('фикстура строится детерминированно и содержит то, что обещают сценарии', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-bench-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await buildFixture(dir, { bulkFiles: 50 });

  const exists = async relative => fs.access(path.join(dir, relative)).then(() => true, () => false);
  assert.equal(await exists('Learning/UnrealEngine/Unreal Engine For Filmmakers'), true);
  assert.equal(await exists('Learning/UnrealEngine/Unreal Engine For Filmmakers/EXR'), true);
  assert.equal(await exists('Learning/UnrealEngine/Unreal Engine For Filmmakers/Chapter 01/chapter.md'), true);
  assert.equal(await exists('Learning/Houdini/Ocean Course A'), true);
  assert.equal(await exists('Learning/Houdini/Ocean Course B'), true);
  // Чего в фикстуре быть не должно — именно это проверяют сценарии «не найдено».
  assert.equal(await exists('Learning/Nuke Compositing'), false);
  assert.equal(await exists('Learning/Houdini/Houdini Course 02'), false);
  assert.equal((await fs.readdir(path.join(dir, 'Learning', '_bulk'))).length, 50);

  // Все ожидаемые пути сценариев существуют в фикстуре.
  for (const item of bench.scenarios) {
    if (!item.expect.path) continue;
    const relative = item.expect.path.replace(/^fixtures\//, '');
    assert.equal(await exists(relative), true, `${item.id}: ${relative}`);
  }
  // Имена, которые сценарий ждёт в выводе инструмента, обязаны быть в фикстуре.
  const allPaths = [];
  const walk = async relative => {
    for (const entry of await fs.readdir(path.join(dir, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      allPaths.push(next);
      if (entry.isDirectory()) await walk(next);
    }
  };
  await walk('.');
  const names = new Set(bench.scenarios.flatMap(item => item.expect.ambiguous || []));
  for (const name of names) {
    // «5000» — это счётчик файлов, в тесте их 50 (полный набор строится долго).
    if (name === '5000') continue;
    assert.equal(allPaths.some(item => item.includes(name)), true, `«${name}» нет в фикстуре`);
  }
});

const run = ({ scenarioId, variant, toolCalls, answer, status = 'SUCCEEDED', prompt = '', tokens = 1000, elapsed = 5000 }) => ({
  scenarioId,
  variant,
  status,
  model: 'deepseek/deepseek-flash',
  prompt,
  answer,
  elapsedMs: elapsed,
  totalTokens: tokens,
  toolCalls,
});

const call = (target, output) => ({ toolName: 'bash', target, output, isError: false });
const wrapped = profile => `вопрос\n\nTask instructions (${profile}):\n- …`;

test('оценка: верный ответ после трёх команд успешен и без лишних вызовов', () => {
  const metrics = evaluateRun(scenario('ue-filmmakers'), run({
    scenarioId: 'ue-filmmakers',
    variant: 'B',
    prompt: wrapped('quick'),
    toolCalls: [
      call('ls Learning', 'Android Blender Houdini UnrealEngine'),
      call('ls Learning/UnrealEngine', 'Unreal Engine For Filmmakers\nOther Unreal Course'),
      call('ls "Learning/UnrealEngine/Unreal Engine For Filmmakers"', 'Chapter 01 Chapter 02 EXR Green Screen'),
    ],
    answer: 'Да, папка Learning/UnrealEngine/Unreal Engine For Filmmakers на месте.',
  }));
  assert.equal(metrics.taskSuccess, true, metrics.reasons.join('; '));
  assert.equal(metrics.toolCalls, 3);
  assert.equal(metrics.confirmedAt, 2);
  assert.equal(metrics.unnecessaryCalls, 1, 'третий вызов уже после подтверждения');
  assert.equal(metrics.profileAccuracy, true);
});

test('оценка: 8 команд с верным ответом — качество есть, избыточность видна', () => {
  const metrics = evaluateRun(scenario('ue-filmmakers'), run({
    scenarioId: 'ue-filmmakers',
    variant: 'A',
    prompt: 'вопрос\n\nWork only inside the current working directory…',
    toolCalls: [
      call('pwd', '/tmp/x'),
      call('ls Learning', 'UnrealEngine'),
      call('ls Learning/UnrealEngine', 'Unreal Engine For Filmmakers'),
      ...Array.from({ length: 5 }, (_, i) => call(`deep-${i}`, 'Unreal Engine For Filmmakers')),
    ],
    answer: 'Да. В Learning/UnrealEngine есть Unreal Engine For Filmmakers.',
  }));
  assert.equal(metrics.taskSuccess, true);
  assert.equal(metrics.confirmedAt, 3);
  assert.equal(metrics.unnecessaryCalls, 5);
  assert.equal(metrics.profile, null, 'у варианта A профиля в промпте нет');
  assert.equal(metrics.profileAccuracy, null);
});

test('оценка: меньше команд, но неверный ответ — регрессия, а не улучшение', () => {
  const metrics = evaluateRun(scenario('ue-filmmakers'), run({
    scenarioId: 'ue-filmmakers',
    variant: 'B',
    prompt: wrapped('quick'),
    toolCalls: [call('ls Learning', 'Android Blender'), call('ls Learning/UnrealEngine', 'Other Unreal Course')],
    answer: 'Нет, такого курса у тебя нет.',
  }));
  assert.equal(metrics.taskSuccess, false);
  assert.match(metrics.reasons.join('; '), /путь не подтверждён/);
});

test('оценка: отсутствие названо словами — успех; выдуманное «есть» — нет', () => {
  const good = evaluateRun(scenario('missing-nuke'), run({
    scenarioId: 'missing-nuke',
    variant: 'B',
    prompt: wrapped('quick'),
    toolCalls: [call('ls Learning', 'Blender Houdini UnrealEngine'), call('ls Learning/UnrealEngine', 'UE5 Automotive Masterclass')],
    answer: 'Курса Nuke Compositing в Learning нет — в UnrealEngine только два курса Unreal.',
  }));
  assert.equal(good.taskSuccess, true, good.reasons.join('; '));

  const bad = evaluateRun(scenario('missing-nuke'), run({
    scenarioId: 'missing-nuke',
    variant: 'B',
    prompt: wrapped('quick'),
    toolCalls: [call('ls Learning', 'Blender Houdini')],
    answer: 'Да, курс Nuke Compositing есть.',
  }));
  assert.equal(bad.taskSuccess, false);
  assert.match(bad.reasons.join('; '), /отсутствие не названо/);
});

test('оценка: записи без запроса и профиль quick там, где просили изменения', () => {
  const scenarioItem = scenario('find-and-fix');
  const wrong = evaluateRun(scenarioItem, run({
    scenarioId: 'find-and-fix',
    variant: 'B',
    prompt: wrapped('quick'),
    toolCalls: [call('ls Learning/UnrealEngine', 'Unreal Engine For Filmmakers'), { toolName: 'write', target: 'x', output: '', isError: false }],
    answer: 'Нашёл и исправил: Unreal Engine For Filmmakers.',
  }));
  assert.equal(wrong.taskSuccess, false, 'профиль quick вместо implement не засчитывается');
  assert.match(wrong.reasons.join('; '), /профиль quick вместо implement/);
  // Здесь изменение как раз просили: запись не «лишняя», но профиль выбран неверно.
  assert.equal(wrong.writes, 1);
  assert.equal(wrong.unnecessaryWrites, 0);
});

test('числа без подтверждения инструментом считаются отдельно', () => {
  const claims = unsupportedClaims('Курс весит 9.0 ГБ и содержит 54 урока.', 'в папке 54 файла: 00.Intro.mp4 …');
  assert.deepEqual(claims, ['9.0 ГБ'], 'размер не измерялся, число уроков подтверждено выводом');
  assert.deepEqual(unsupportedClaims('Курс весит 9.0 ГБ.', '9.0G\tLearning/Unreal Engine For Filmmakers'), []);
});

test('сводка и вердикты: улучшение по вызовам при сохранении качества', () => {
  const scenarioA = scenario('ue-filmmakers');
  const long = evaluateRun(scenarioA, run({
    scenarioId: 'ue-filmmakers', variant: 'A',
    toolCalls: [call('ls Learning', 'UnrealEngine'), call('ls Learning/UnrealEngine', 'Unreal Engine For Filmmakers'), ...Array.from({ length: 5 }, () => call('x', 'Unreal Engine For Filmmakers'))],
    answer: 'Да, Unreal Engine For Filmmakers есть.',
  }));
  const short = evaluateRun(scenarioA, run({
    scenarioId: 'ue-filmmakers', variant: 'B', prompt: wrapped('quick'),
    toolCalls: [call('ls Learning/UnrealEngine', 'Unreal Engine For Filmmakers')],
    answer: 'Да, Unreal Engine For Filmmakers есть.',
  }));
  const summary = summarize([long, short]);
  assert.equal(summary.A.successRate, 1);
  assert.equal(summary.B.successRate, 1);
  assert.ok(summary.B.unnecessaryCalls < summary.A.unnecessaryCalls);
  const list = verdicts(summary);
  assert.equal(list.find(item => item.id === 'fewer-unnecessary-calls').ok, true);
  assert.equal(list.find(item => item.id === 'quality-not-worse').ok, true);
  assert.equal(list.find(item => item.id === 'no-unrequested-writes').ok, true);

  const markdown = toMarkdown({ summary, metrics: [long, short], verdictList: list, meta: { benchVersion: bench.version } });
  assert.match(markdown, /# Agent behaviour A\/B/);
  assert.match(markdown, /fewer-unnecessary-calls/);
  assert.match(markdown, /\| ue-filmmakers \| B \| ✅/);
});

test('вердикт ловит деградацию сложных задач и лишние записи', () => {
  const complex = scenario('complex-compare');
  const a = evaluateRun(complex, run({
    scenarioId: 'complex-compare', variant: 'A',
    toolCalls: [call('ls "…/Unreal Engine For Filmmakers"', 'Chapter 01  Chapter 02'), call('ls "…/Chapter 02"', 'chapter.md 02.Animation.mp4')],
    answer: 'Chapter 01 про UI, Chapter 02 про анимацию.',
  }));
  assert.equal(a.taskSuccess, true, a.reasons.join('; '));
  const b = evaluateRun(complex, run({
    scenarioId: 'complex-compare', variant: 'B', prompt: wrapped('quick'),
    toolCalls: [call('ls "…/Chapter 01"', 'chapter.md'), { toolName: 'write', target: 'x', output: '' }],
    answer: 'Не нашёл.',
  }));
  const summary = summarize([a, b]);
  const list = verdicts(summary);
  assert.equal(list.find(item => item.id === 'complex-not-cut').ok, false, 'сложная задача испорчена — вердикт обязан это поймать');
  assert.equal(list.find(item => item.id === 'no-unrequested-writes').ok, false);
});

test('run.mjs --dry-run печатает план и ничего не запускает', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(benchDir, 'run.mjs'), '--dry-run', '--limit', '3'], { env: { ...process.env } });
  assert.match(stdout, /3 сценариев × 1 вариант \(B\) = 3 запусков/);
  const lines = stdout.trim().split('\n').slice(1);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /ue-filmmakers/);
  assert.equal(profileOf('без профиля'), null);
});
