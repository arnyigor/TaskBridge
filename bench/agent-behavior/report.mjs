#!/usr/bin/env node
// Отчёт A/B: читает runs/*.json, раскладывает по вариантам и пишет Markdown + JSON.
//
//   node bench/agent-behavior/report.mjs --a .local/bench/2026-10-21/A --b .local/bench/2026-10-21/B
//
// Оценка — только детерминированная (evaluate.mjs); модели здесь не участвуют.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRun, summarize, verdicts, toMarkdown } from './evaluate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bench = JSON.parse(await fs.readFile(path.join(here, 'scenarios.json'), 'utf8'));
const byId = new Map(bench.scenarios.map(item => [item.id, item]));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = path.resolve(argv[i + 1]);
  }
  if (!args.a || !args.b) throw new Error('нужны --a <каталог A> и --b <каталог B>');
  return args;
}

async function readRuns(dir, variant) {
  const runsDir = path.join(dir, 'runs');
  const files = await fs.readdir(runsDir).catch(() => []);
  const runs = [];
  for (const file of files.filter(name => name.endsWith('.json')).sort()) {
    const run = JSON.parse(await fs.readFile(path.join(runsDir, file), 'utf8'));
    runs.push({ ...run, variant: run.variant || variant });
  }
  return runs;
}

const args = parseArgs(process.argv.slice(2));
const runs = [...await readRuns(args.a, 'A'), ...await readRuns(args.b, 'B')];
const metrics = [];
for (const run of runs) {
  const scenario = byId.get(run.scenarioId);
  // Сценарий без описания — не повод падать: он попадёт в отчёт как «не оценён».
  if (!scenario) {
    metrics.push({ scenarioId: run.scenarioId, variant: run.variant, taskSuccess: false, reasons: ['сценарий не найден в scenarios.json'], toolCalls: 0, unnecessaryCalls: 0, unnecessaryWrites: 0, unsupportedClaims: [], profile: null, profileAccuracy: null, elapsedMs: null, totalTokens: null });
    continue;
  }
  metrics.push(evaluateRun(scenario, run));
}

const summary = summarize(metrics);
const verdictList = verdicts(summary);
const metaA = JSON.parse(await fs.readFile(path.join(args.a, 'meta.json'), 'utf8').catch(() => '{}'));
const metaB = JSON.parse(await fs.readFile(path.join(args.b, 'meta.json'), 'utf8').catch(() => '{}'));
// Режим инструкций в подписи столбцов: без него «A против B» не говорит, что именно
// различалось (дерево кода или доставка инструкций).
const label = (letter, meta) => (meta.policy ? `${letter} (${meta.policy})` : null);
const markdown = toMarkdown({
  summary,
  metrics,
  verdictList,
  meta: {
    generatedAt: new Date().toISOString(),
    model: metaB.model || metaA.model || null,
    benchVersion: bench.version,
    labelA: label('A', metaA),
    labelB: label('B', metaB),
  },
});

const outDir = path.dirname(args.b);
await fs.writeFile(path.join(outDir, 'REPORT.md'), `${markdown}\n`);
await fs.writeFile(path.join(outDir, 'metrics.json'), `${JSON.stringify({ summary, verdicts: verdictList, metrics }, null, 2)}\n`);
console.log(markdown);
