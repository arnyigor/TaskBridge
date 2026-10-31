#!/usr/bin/env node
// P1 live check: does the context-budget extension really keep an old bulky tool
// result out of the request, on the installed Pi, with a real model?
//
//   node experiments/compact-01/run-tool-archive.mjs
//
// Method: isolated agent dir (PI_CODING_AGENT_DIR), own workspace, own sessions,
// provider key from the environment. The extension is loaded with `-e`, writes a
// JSONL line for every request it changed, and the run then asks the model a
// question whose answer can only come from reading the archived result — if the
// model still sees the output, the archive did not happen.
//
// Budget is set small (200 tokens) so the first `bash` output leaves the window
// after one more turn; with the production default (40k) the same code path
// would need a much longer session to trigger.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiRpc } from '../pi-hooks/pi-rpc-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const model = argValue('--model', 'deepseek/deepseek-flash');
const keepTokens = Number(argValue('--keep', '200'));
const timeoutMs = Number(argValue('--timeout', '240000'));
const out = path.resolve(argValue('--out', path.join(repo, '.local', 'compact-01', `archive-${Date.now()}`)));

const workspace = path.join(out, 'workspace');
const sessions = path.join(out, 'sessions');
const agentDir = path.join(out, 'pi-agent');
const logPath = path.join(out, 'context-budget.jsonl');
const inspectPath = path.join(out, 'requests.jsonl');
for (const dir of [workspace, sessions, agentDir]) await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(agentDir, 'settings.json'), `${JSON.stringify({ compaction: { enabled: false } }, null, 2)}\n`);
// The marker the model can only know from the tool output.
const marker = 'ZQ-4711-LARCH';
const filler = Array.from({ length: 400 }, (_, i) => `${i}: строка диагностики ${marker}`).join('\n');
await fs.writeFile(path.join(workspace, 'build.log'), filler);

const [provider, modelId] = model.split('/');
const env = {
  PI_CODING_AGENT_DIR: agentDir,
  TASKBRIDGE_CONTEXT_BUDGET: '1',
  TASKBRIDGE_CONTEXT_KEEP_TOKENS: String(keepTokens),
  TASKBRIDGE_CONTEXT_MIN_CHARS: '500',
  TASKBRIDGE_CONTEXT_LOG: logPath,
  TASKBRIDGE_CONTEXT_DEBUG: '1',
  TASKBRIDGE_INSPECT_LOG: inspectPath,
  ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
};
const extension = path.join(repo, 'pi-extension', 'taskbridge-context-budget.js');
// The inspector is the half that proves the archive: it sees the request as the
// provider does, so an archived result must appear there as a short message.
const inspector = path.join(here, 'inspect-request.js');
const rpc = new PiRpc({
  cwd: workspace,
  args: ['--approve', '--session-dir', sessions, '--provider', provider, '--model', modelId, '-e', extension, '-e', inspector],
  env,
});

const report = { at: new Date().toISOString(), model, keepTokens, marker, turns: [] };
try {
  await rpc.send({ type: 'get_state' }).catch(() => null);
  const says = async (message) => {
    await rpc.send({ type: 'prompt', message });
    await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).catch(() => null);
    const text = rpc.events
      .filter(record => record.type === 'message_update' && record.assistantMessageEvent?.type === 'text_delta')
      .map(record => record.assistantMessageEvent.delta).join('');
    return text;
  };
  // Turn 1: produce a big output through bash (`read` truncates, `bash` does not).
  const first = await says('Выполни через bash команду: type build.log  (Windows) или cat build.log, ответь одним словом: готово.');
  report.turns.push({ turn: 1, mentionsMarker: first.includes(marker), chars: first.length });
  // Turn 2: a filler exchange, so turn 1's output falls outside the 200-token window.
  const second = await says('Ответь одной строкой: сколько будет 3+3?');
  report.turns.push({ turn: 2, mentionsMarker: second.includes(marker), chars: second.length });
  // Turn 3: ask for the marker. If the result is archived, the model cannot know it.
  const third = await says(`Назови маркер вида ZQ-XXXX-LARCH, который встречался в файле build.log этой сессии. Если не знаешь — ответь ровно: НЕ ЗНАЮ.`);
  report.turns.push({ turn: 3, saysMarker: third.includes(marker), text: third.slice(0, 400) });

  report.log = await fs.readFile(logPath, 'utf8').then(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)), () => []);
  // What the provider saw: the big bash result must be small in later requests.
  const requests = await fs.readFile(inspectPath, 'utf8').then(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)), () => []);
  report.requests = requests.map(request => {
    // The provider payload names tool results `role: "tool"` (string content), while
    // the extension above works on Pi's AgentMessage (role "toolResult").
    const toolResults = (request.messages || []).filter(message => message.role === 'tool' || (message.types || []).includes('tool_result'));
    return {
      request: request.request,
      systemChars: request.systemChars,
      tools: request.tools,
      toolsChars: request.toolsChars,
      messages: (request.messages || []).length,
      totalChars: (request.messages || []).reduce((sum, message) => sum + message.chars, 0),
      toolResultChars: toolResults.map(message => message.chars),
    };
  });
} finally {
  await rpc.stop().catch(() => {});
}

await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const archivedRequests = report.log.length;
const archivedResults = report.log.reduce((sum, line) => sum + (line.archived || 0), 0);
const savedTokens = report.log.reduce((sum, line) => sum + (line.savedTokens || 0), 0);
console.log(`модель: ${model} | бюджет: ${keepTokens} ток. | расширение: ${path.relative(repo, extension)}`);
console.log(`запросов с архивом: ${archivedRequests}, архивировано результатов: ${archivedResults}, сэкономлено оценкой: ${savedTokens} ток.`);
for (const request of report.requests) {
  console.log(`  запрос ${request.request}: сообщений ${request.messages}, текст ${request.totalChars} симв., tool_result ${JSON.stringify(request.toolResultChars)}, схема инструментов ${request.toolsChars} симв.`);
}
for (const turn of report.turns) {
  console.log(`  ход ${turn.turn}: ${turn.mentionsMarker === undefined ? `маркер в ответе: ${turn.saysMarker}` : `маркер в ответе: ${turn.mentionsMarker}`}`);
}
const toolChars = report.requests.flatMap(request => request.toolResultChars);
const lastRequest = report.requests.at(-1);
// The proof is in the payload: a big result appears early, and by the last request
// every tool result on the wire is a short reference.
// History on disk must still hold the raw output: the extension is a per-request
// view, not a rewrite. Read the session file back and measure it.
const sessionFiles = (await fs.readdir(sessions)).filter(name => name.endsWith('.jsonl'));
const sessionText = sessionFiles.length ? await fs.readFile(path.join(sessions, sessionFiles[0]), 'utf8') : '';
const NEWLINE = String.fromCharCode(10);
const rawResults = sessionText.split(NEWLINE).filter(Boolean)
  .map(line => { try { return JSON.parse(line); } catch { return null; } })
  .filter(entry => entry?.message?.role === 'toolResult')
  .map(entry => (Array.isArray(entry.message.content) ? entry.message.content : [])
    .reduce((sum, part) => sum + (typeof part?.text === 'string' ? part.text.length : 0), 0));
report.fileToolResultChars = rawResults;
const verdict = {
  historyKeepsRawOutput: rawResults.some(chars => chars > 2000),
  wireToolsAreReferences: (lastRequest?.toolResultChars || []).length > 0
    && (lastRequest?.toolResultChars || []).every(chars => chars < 1000),
  archivedRequests,
};
console.log(`история в файле, размеры toolResult: ${JSON.stringify(rawResults)}`);
console.log(`итог: ${JSON.stringify(verdict)}`);
console.log(`отчёт: ${path.relative(repo, path.join(out, 'report.json'))}`);
