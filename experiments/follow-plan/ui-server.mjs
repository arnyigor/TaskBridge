#!/usr/bin/env node
// FP-06E: изолированный сервер для пользовательской приёмки Follow Plan.
//
//   node experiments/follow-plan/ui-server.mjs start             # followPlan.enabled=true
//   node experiments/follow-plan/ui-server.mjs start --disabled   # тот же стенд с выключенным режимом
//   node experiments/follow-plan/ui-server.mjs stop    # остановить по сохранённому pid
//
// Свой корень приложения, свой dataRoot, свой проект и свой каталог агента Pi.
// Рабочий TaskBridge, его config.json, data и Pi-сессии не читаются и не меняются:
// из окружения вычищаются TASKBRIDGE_* и PI_* (этот агент сам работает внутри
// TaskBridge, и унаследованные переменные уже один раз уводили изолированный
// сервер на порт оператора).
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const disabled = process.argv.includes('--disabled');
const out = path.join(repo, '.local', 'fp-06', disabled ? 'ui-disabled' : 'ui');
const stateFile = path.join(out, 'server.json');
const SHOTS = path.join(out, 'screens');
const command = process.argv[2] || 'start';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const stopSaved = async () => {
  const saved = await fs.readFile(stateFile, 'utf8').then(JSON.parse, () => null);
  if (!saved?.pid) return false;
  if (process.platform === 'win32') {
    await new Promise(resolve => spawn('taskkill', ['/PID', String(saved.pid), '/T', '/F'], { windowsHide: true }).on('exit', resolve));
  } else {
    try { process.kill(saved.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await fs.rm(stateFile, { force: true });
  return true;
};

if (command === 'stop') {
  const stopped = await stopSaved();
  console.log(stopped ? 'изолированный сервер остановлен' : 'запущенного сервера не было');
  process.exit(0);
}

const freePort = async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
};

const PLAN = `---
taskbridge_plan: 1
plan_id: p-ui
revision: 1
goal: "Приёмка интерфейса: три небольших шага"
---

# План: приёмка интерфейса

## Шаги

### S-001 | TODO | P1 | Файл с приветствием и его тест
**Критерии:** файл hello.mjs экспортирует greet(name), тест в hello.test.mjs проходит.
**Проверка:** node --test hello.test.mjs

### S-002 | TODO | P1 | Функция суммы и её тест
**Критерии:** hello.mjs экспортирует sum(list), оба теста проходят.
**Проверка:** node --test hello.test.mjs

### S-003 | TODO | P1 | README с итогом проверки
**Критерии:** README.md описывает функции и команду запуска тестов.
**Проверка:** read README.md

## Обнаруженные проблемы
`;

await stopSaved();
// Внутри out — только рабочие каталоги стенда: скрипты приёмки и скриншоты
// лежат рядом (out/screens), и перезапуск стенда их не удаляет.
const stand = path.join(out, 'stand');
const root = path.join(stand, 'app');
const dataDir = path.join(stand, 'data');
const workspace = path.join(stand, 'workspace');
const agentDir = path.join(stand, 'pi-agent');
await fs.rm(stand, { recursive: true, force: true }).catch(() => {});
for (const dir of [root, dataDir, workspace, agentDir, SHOTS]) await fs.mkdir(dir, { recursive: true });
await fs.cp(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
await fs.cp(path.join(repo, 'web'), path.join(root, 'web'), { recursive: true });
await fs.cp(path.join(repo, 'pi-extension'), path.join(root, 'pi-extension'), { recursive: true });
await fs.copyFile(path.join(repo, 'package.json'), path.join(root, 'package.json'));
await fs.writeFile(path.join(workspace, 'PLAN.md'), PLAN, 'utf8');
// A second, long plan for the card/scroll check: the same file company, 24 steps.
const longPlan = [
  '---', 'taskbridge_plan: 1', 'plan_id: p-long', 'revision: 1',
  'goal: "Длинный план: 24 пункта"', '---', '', '# План: длинный', '', '## Шаги', ''
];
for (let i = 1; i <= 24; i++) {
  longPlan.push(`### S-${String(i).padStart(3, '0')} | TODO | P${i < 4 ? 1 : i < 12 ? 2 : 3} | Пункт ${i}: небольшое действие`, '**Критерии:** пункт выполнен.', '**Проверка:** read', '');
}
longPlan.push('## Обнаруженные проблемы');
await fs.writeFile(path.join(workspace, 'LONG.md'), longPlan.join('\n'), 'utf8');

const fixedPort = Number(process.argv[process.argv.indexOf('--port') + 1]) || 0;
let port = fixedPort || await freePort();
const config = {
  server: { host: '127.0.0.1', port, auth: { enabled: false } },
  pi: { command: 'pi', projectTrust: 'approve', persistSessions: true, turnInstructions: { mode: 'legacy' } },
  projects: [{ id: 'ui', name: 'Приёмка UI', path: workspace, useWorktree: false }],
  followPlan: { enabled: !disabled }
};
await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2));

const inherited = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith('PI_') && !key.startsWith('TASKBRIDGE_')));
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: root,
  windowsHide: true,
  detached: true,
  stdio: 'ignore',
  env: { ...inherited, PI_CODING_AGENT_DIR: agentDir, TASKBRIDGE_DATA_DIR: dataDir }
});
child.unref();

const base = `http://127.0.0.1:${port}`;
let ready = false;
for (let i = 0; i < 240; i++) {
  try { await fetch(`${base}/api/health`); ready = true; break; } catch { await sleep(100); }
}
if (!ready) {
  console.error('сервер не поднялся — смотри .local/fp-06/ui/app');
  process.exit(1);
}
await fs.writeFile(stateFile, JSON.stringify({ pid: child.pid, port, base, root, workspace, startedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ base, pid: child.pid, workspace, plan: 'PLAN.md', longPlan: 'LONG.md', followPlanEnabled: !disabled }));
