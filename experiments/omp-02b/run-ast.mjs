// OMP-02b: узкий эксперимент на структурные инструменты OMP.
//
//   node experiments/omp-02b/run-ast.mjs --variant all --only ast01,edit02
//   node experiments/omp-02b/run-ast.mjs --variant omp-ast --timeout 180000
//
// Вопрос, на который отвечает стенд: даёт ли OMP выигрыш именно на ast_grep /
// ast_edit / hashline-edit, а не на «умном программировании» вообще. Поэтому во
// всех плечах один и тот же набор инструментов и один и тот же провайдер, а
// различается только ядро и доступность AST-инструментов:
//
//   pi-plain  Pi 1.3.0, read/write/edit/grep/find/ls            — базовая линия
//   omp-plain OMP без astGrep, тот же набор (+hashline edit)    — ядро против ядра
//   omp-ast   OMP с astGrep.enabled=true: +ast_grep, +ast_edit  — проверяемая гипотеза
//
// bash намеренно нет ни в одном плече: иначе «структурный поиск» подменяется
// `sed`/`grep`, и сравнение перестаёт отвечать на вопрос.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OmpRpc } from '../omp-01/omp-rpc-client.mjs';
import { PiRpc } from '../pi-hooks/pi-rpc-client.mjs';
import { buildFixtures } from './fixtures/build.mjs';
import { checkScenario, snapshot } from './checks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function parseArgs(argv) {
  const args = {
    variant: 'all', only: null, timeoutMs: 180000, model: 'deepseek-flash', thinking: 'medium',
    out: path.join(root, '.local', 'omp02b', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--variant') args.variant = String(next());
    else if (arg === '--only') args.only = String(next()).split(',').map(item => item.trim());
    else if (arg === '--timeout') args.timeoutMs = Number(next());
    else if (arg === '--model') args.model = String(next());
    else if (arg === '--thinking') args.thinking = String(next());
    else if (arg === '--out') args.out = path.resolve(next());
    else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  return args;
}

const VARIANTS = {
  'pi-plain': {
    runtime: 'pi',
    label: 'Pi 1.3.0',
    tools: 'read,write,edit,grep,find,ls',
  },
  'omp-plain': {
    runtime: 'omp',
    label: 'OMP без AST',
    profile: 'omp02-b',
    tools: 'read,write,edit,grep,glob',
  },
  'omp-ast': {
    runtime: 'omp',
    label: 'OMP + ast_grep/ast_edit',
    profile: 'omp02b-ast',
    tools: 'read,write,edit,grep,glob,ast_grep,ast_edit',
  },
};

function piArgs({ sessions, args }) {
  return [
    '--approve', '--session-dir', sessions,
    '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates',
    '--tools', VARIANTS['pi-plain'].tools,
    '--model', `deepseek/${args.model}`,
    '--thinking', args.thinking,
  ];
}

function ompArgs({ sessions, args, variant }) {
  return [
    '--mode', 'rpc', '--no-ui', '--auto-approve', '--session-dir', sessions,
    '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty',
    '--profile', VARIANTS[variant].profile,
    '--tools', VARIANTS[variant].tools,
    '--model', args.model,
    '--thinking', args.thinking,
  ];
}

const textOf = message => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
};

/** Имена инструментов и число вызовов из кадров обоих протоколов. */
export function summarizeFrames(frames) {
  const fromBlocks = () => {
    const calls = [];
    for (const frame of frames) {
      const blocks = frame.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type !== 'tool_use' && block?.type !== 'toolCall') continue;
        const input = block.input ?? block.args ?? {};
        calls.push({
          name: String(block.name || 'tool'),
          target: String(input.command || input.pattern || input.path || input.file_path || input.query || '').split('\n')[0].slice(0, 120),
        });
      }
    }
    return calls;
  };
  // Два источника — НЕ два счёта: одно и то же событие приходит и отдельным
  // кадром, и блоком в сообщении (в OMP без этого счёт завышался в десятки раз).
  const fromStarts = frames.filter(frame => frame.type === 'tool_execution_start').map(frame => {
    const input = frame.args || frame.input || {};
    return {
      name: String(frame.toolName || frame.name || 'tool'),
      target: String(input.command || input.pattern || input.path || input.file_path || input.query || '').split('\n')[0].slice(0, 120),
    };
  });
  const toolCalls = fromStarts.length ? fromStarts : fromBlocks();
  const counts = toolCalls.reduce((acc, call) => ({ ...acc, [call.name]: (acc[call.name] || 0) + 1 }), {});
  return { toolCalls, toolNames: counts, source: fromStarts.length ? 'events' : 'messages' };
}

const usageOf = frames => {
  let best = null;
  for (const frame of frames) {
    const usage = frame.message?.usage || frame.usage;
    if (!usage) continue;
    const total = Number(usage.totalTokens ?? usage.total_tokens ?? usage.input_tokens ?? 0);
    if (Number.isFinite(total) && (!best || total > best)) best = total;
  }
  return best;
};

const answerText = frames => frames.map(frame => textOf(frame.message || frame)).filter(Boolean).join('\n').slice(0, 4000);

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

async function runOne({ variant, scenario, pristine, args, out }) {
  const dir = path.join(out, `${variant}-${scenario.dir}`);
  const workspace = path.join(dir, 'workspace');
  const sessions = path.join(dir, 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  await copyDir(path.join(pristine, scenario.dir), workspace);

  const started = Date.now();
  const record = { variant, core: VARIANTS[variant].runtime, label: VARIANTS[variant].label, scenario: scenario.dir };
  let frames = [];
  let rpc = null;
  try {
    if (VARIANTS[variant].runtime === 'pi') {
      rpc = new PiRpc({
        cwd: workspace,
        args: piArgs({ sessions, args }),
        env: { PI_CODING_AGENT_DIR: path.join(out, 'pi-agent') },
      });
      const from = rpc.events.length;
      const response = await rpc.send({ type: 'prompt', message: scenario.question });
      if (!response?.success) throw new Error(`prompt отклонён: ${JSON.stringify(response?.error)}`);
      record.settled = await rpc.waitFor(item => item.type === 'agent_settled', args.timeoutMs).then(() => true, () => false);
      frames = rpc.events.slice(from);
      record.status = response.data?.disposition ?? 'started';
    } else {
      rpc = new OmpRpc({ cwd: workspace, args: ompArgs({ sessions, args, variant }) });
      await rpc.waitFor(frame => frame.type === 'ready', 120000).catch(() => null);
      await rpc.send({ type: 'negotiate_protocol', protocolVersion: 2 }).catch(() => null);
      const turn = await rpc.promptAndWait(`${scenario.question}\n\nРаботай только в текущем каталоге.`, { timeoutMs: args.timeoutMs });
      frames = turn.frames || [];
      record.settled = turn.settled === true;
      record.status = turn.result?.status ?? null;
    }
  } catch (error) {
    record.error = error.message;
  } finally {
    if (rpc) await rpc.stop();
  }
  record.wallMs = Date.now() - started;

  const summary = summarizeFrames(frames);
  record.toolCalls = summary.toolCalls.length;
  record.toolNames = summary.toolNames;
  record.maxTokens = usageOf(frames);
  record.answerText = answerText(frames);
  record.usage = summary.toolCalls.filter(call => call.name === 'ast_grep' || call.name === 'ast_edit').length;

  const after = await snapshot(workspace);
  const before = await snapshot(path.join(pristine, scenario.dir));
  record.changedFiles = [...after.keys()].filter(file => before.get(file) !== after.get(file));

  const check = record.error
    ? { ok: false, detail: { reason: record.error } }
    : await checkScenario(scenario, { workspace, original: path.join(pristine, scenario.dir) }).catch(error => ({ ok: false, detail: { reason: error.message } }));
  record.ok = check.ok === true;
  record.check = check.detail ?? {};
  await fs.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pristine = path.join(args.out, 'fixtures');
  const scenarios = await buildFixtures(pristine);
  const selectedScenarios = args.only ? scenarios.filter(item => args.only.includes(item.dir)) : scenarios;
  const variants = args.variant === 'all' ? Object.keys(VARIANTS) : [args.variant];
  for (const variant of variants) {
    if (!VARIANTS[variant]) throw new Error(`неизвестное плечо: ${variant}`);
  }
  await fs.mkdir(args.out, { recursive: true });
  console.log(`OMP-02b → ${args.out}`);
  console.log(`модель ${args.model}, thinking ${args.thinking}, таймаут ${args.timeoutMs} мс`);

  const records = [];
  for (const scenario of selectedScenarios) {
    for (const variant of variants) {
      const record = await runOne({ variant, scenario, pristine, args, out: args.out });
      records.push(record);
      const used = Object.keys(record.toolNames || {}).join(',') || '—';
      console.log(`  ${scenario.dir.padEnd(8)} ${variant.padEnd(10)} ${record.ok ? '✅' : '❌'} ${String(Math.round(record.wallMs / 100) / 10).padStart(6)}s  вызовов ${String(record.toolCalls).padStart(2)}  [${used}]`);
    }
  }
  await fs.writeFile(path.join(args.out, 'summary.json'), `${JSON.stringify({ model: args.model, thinking: args.thinking, records }, null, 2)}\n`);
  console.log(`\nсводка: ${path.join(args.out, 'summary.json')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
