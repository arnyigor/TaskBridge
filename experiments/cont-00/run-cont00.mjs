// CONT-00: останавливается ли Pi раньше готовности и помогает ли лишний ход.
//
//   node experiments/cont-00/run-cont00.mjs --mode both --timeout 300000
//   node experiments/cont-00/run-cont00.mjs --mode b --only T2-failing-test
//
// Два режима на одних и тех же задачах и модели:
//   A — один ход: промпт с критериями, дальше не вмешиваемся;
//   B — после проверки, если критерии не выполнены, отправляется ЕЩЁ один ход с
//       выводом проверки (не больше `--max-extra`), и считается, сколько их нужно.
//
// Готовность решает `check.mjs` в рабочей копии, а не текст ответа модели. Поэтому
// «модель сказала готово» и «работа сделана» — разные колонки отчёта.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PiRpc } from '../pi-hooks/pi-rpc-client.mjs';
import { buildFixtures } from './fixtures/build.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function parseArgs(argv) {
  const args = {
    mode: 'both', only: null, maxExtra: 3, timeoutMs: 300000, model: 'deepseek/deepseek-flash', thinking: 'medium',
    out: path.join(root, '.local', 'cont00', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--mode') args.mode = String(next());
    else if (arg === '--only') args.only = String(next()).split(',').map(item => item.trim());
    else if (arg === '--max-extra') args.maxExtra = Number(next());
    else if (arg === '--timeout') args.timeoutMs = Number(next());
    else if (arg === '--model') args.model = String(next());
    else if (arg === '--thinking') args.thinking = String(next());
    else if (arg === '--out') args.out = path.resolve(next());
    else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  return args;
}

async function copyDir(from, to) {
  await fs.rm(to, { recursive: true, force: true });
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(source, target);
    else await fs.copyFile(source, target);
  }
}

/** Запускает check.mjs в рабочей копии: он и решает, готова ли работа. */
async function runCheck(workspace) {
  try {
    const { stdout } = await exec(process.execPath, ['check.mjs'], { cwd: workspace, timeout: 60000 });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ''}${error.stderr || error.message}`.trim() };
  }
}

const textOf = message => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
};

/** Утверждения модели о готовности — то, что нельзя принимать на веру. */
export function claimsDone(answer) {
  return /(готово|сделано|выполнено|всё исправлено|all done|completed)/i.test(String(answer || ''));
}

function summarizeFrames(frames) {
  const calls = frames.filter(frame => frame.type === 'tool_execution_start').map(frame => String(frame.toolName || 'tool'));
  let tokens = null;
  for (const frame of frames) {
    const usage = frame.message?.usage || frame.usage;
    const total = Number(usage?.totalTokens ?? 0);
    if (Number.isFinite(total) && total > (tokens ?? 0)) tokens = total;
  }
  const answers = frames.filter(frame => frame.type === 'message_end' && frame.message?.role === 'assistant').map(frame => textOf(frame.message));
  return { toolCalls: calls.length, toolNames: [...new Set(calls)], tokens, answer: answers.join('\n').slice(0, 4000) };
}

async function runTurn({ rpc, prompt, timeoutMs }) {
  const from = rpc.events.length;
  const response = await rpc.send({ type: 'prompt', message: prompt });
  if (!response?.success) throw new Error(`prompt отклонён: ${JSON.stringify(response?.error)}`);
  const settled = await rpc.waitFor(item => item.type === 'agent_settled', timeoutMs).then(() => true, () => false);
  return { frames: rpc.events.slice(from), settled };
}

async function changedFiles(workspace, pristine) {
  const walk = async dir => {
    const files = new Map();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const [name, body] of await walk(full)) files.set(path.join(entry.name, name), body);
      } else {
        files.set(entry.name, await fs.readFile(full, 'utf8'));
      }
    }
    return files;
  };
  const before = await walk(pristine);
  const after = await walk(workspace);
  const changed = [];
  for (const [file, body] of after) if (before.get(file) !== body) changed.push(file);
  for (const file of before.keys()) if (!after.has(file)) changed.push(`${file} (удалён)`);
  return changed;
}

async function runOne({ task, mode, pristine, args, out }) {
  const dir = path.join(out, `${mode}-${task.name}`);
  const workspace = path.join(dir, 'workspace');
  const sessions = path.join(dir, 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  await copyDir(path.join(pristine, task.name), workspace);

  const record = { task: task.name, mode, turns: 0, firstTurnOk: null, extraTurns: 0, ok: false, wallMs: 0, tokens: null, toolCalls: 0, toolNames: [], changed: [], claimedDone: false, checkOutput: '', error: null };
  const started = Date.now();
  let rpc = null;
  try {
    rpc = new PiRpc({
      cwd: workspace,
      args: [
        '--approve', '--session-dir', sessions,
        '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates',
        '--model', args.model, '--thinking', args.thinking,
      ],
      env: { PI_CODING_AGENT_DIR: path.join(out, 'pi-agent') },
    });

    let prompt = task.prompt;
    let check = await runCheck(workspace);
    for (let turn = 1; turn <= 1 + (mode === 'b' ? args.maxExtra : 0); turn += 1) {
      const result = await runTurn({ rpc, prompt, timeoutMs: args.timeoutMs });
      record.turns = turn;
      const summary = summarizeFrames(result.frames);
      record.tokens = Math.max(record.tokens ?? 0, summary.tokens ?? 0) || record.tokens;
      record.toolCalls += summary.toolCalls;
      record.toolNames = [...new Set([...record.toolNames, ...summary.toolNames])];
      record.claimedDone = record.claimedDone || claimsDone(summary.answer);
      check = await runCheck(workspace);
      if (turn === 1) record.firstTurnOk = check.ok;
      if (check.ok) break;
      if (mode !== 'b') break;
      record.extraTurns = turn;
      // Следующий ход несёт только факты проверки: ни «пожалуйста», ни уговоров.
      prompt = `Проверка готовности не пройдена.\n\n${check.output.slice(0, 2000)}\n\nДоведи работу до готовности. Файл check.mjs менять нельзя.`;
    }
    record.ok = check.ok;
    record.checkOutput = check.output.slice(0, 2000);
  } catch (error) {
    record.error = error.message;
  } finally {
    if (rpc) await rpc.stop();
  }
  record.wallMs = Date.now() - started;
  record.changed = await changedFiles(workspace, path.join(pristine, task.name)).catch(() => []);
  await fs.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pristine = path.join(args.out, 'fixtures');
  const tasks = await buildFixtures(pristine);
  const selected = args.only ? tasks.filter(task => args.only.includes(task.name)) : tasks;
  const modes = args.mode === 'both' ? ['a', 'b'] : [args.mode];
  await fs.mkdir(args.out, { recursive: true });
  console.log(`CONT-00 → ${args.out}`);
  console.log(`модель ${args.model}, thinking ${args.thinking}, режимы ${modes.join('/')}, максимум доп. ходов ${args.maxExtra}`);

  const records = [];
  for (const task of selected) {
    for (const mode of modes) {
      const record = await runOne({ task, mode, pristine, args, out: args.out });
      records.push(record);
      const mark = record.ok ? '✅' : '❌';
      console.log(`  ${task.name.padEnd(24)} ${mode}  ${mark}  ходов ${record.turns}  доп. ${record.extraTurns}  ${Math.round(record.wallMs / 1000)}s  ${record.claimedDone ? 'сказала «готово»' : 'без заявления'}`);
    }
  }
  await fs.writeFile(path.join(args.out, 'summary.json'), `${JSON.stringify({ model: args.model, thinking: args.thinking, maxExtra: args.maxExtra, records }, null, 2)}\n`);
  console.log(`\nсводка: ${path.join(args.out, 'summary.json')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
