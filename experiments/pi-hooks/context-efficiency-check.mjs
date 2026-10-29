#!/usr/bin/env node
// CTX-05: real Pi/model calls with synthetic, isolated histories. Not a unit test.
// node experiments/pi-hooks/context-efficiency-check.mjs [--out .local/ctx-efficiency]
// Requires a configured DEEPSEEK_API_KEY; never copies operator settings/sessions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PiRpc } from './pi-rpc-client.mjs';
import { readPiSession } from '../../src/pi-session-index.mjs';
import { summarizeSessionContext } from '../../src/context-composition.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = path.resolve(value('--out', '.local/ctx-efficiency'));
if (!root.startsWith(path.resolve('.local') + path.sep)) throw new Error('Output must be inside .local');
const provider = value('--provider', 'deepseek');
const model = value('--model', 'deepseek-flash');
const versionProbe = spawnSync('pi', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
const piVersion = versionProbe.stdout?.match(/\b\d+\.\d+\.\d+\b/)?.[0];
if (versionProbe.status !== 0 || piVersion !== '1.4.0') throw new Error('This stand requires the verified Pi 1.4.0 projection contract');
const scenarios = [
  { name: 'small', chars: 120, staticChars: 0, tools: 0, keep: 20000 },
  { name: 'large-tools', chars: 100000, staticChars: 0, tools: 0, keep: 2000 },
  { name: 'large-static', chars: 100000, staticChars: 48000, tools: 16, keep: 2000 },
];
const results = [];
for (const scenario of scenarios) {
  const dir = path.join(root, scenario.name + '-' + Date.now());
  const workspace = path.join(dir, 'workspace');
  const agent = path.join(dir, 'agent');
  const sessions = path.join(dir, 'sessions');
  for (const folder of [workspace, agent, sessions]) await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: scenario.keep } }));
  const instructions = 'Public synthetic instruction: preserve source files and verify the result.\n'.repeat(Math.ceil(scenario.staticChars / 75)).slice(0, scenario.staticChars);
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), instructions);
  const payload = ('Public synthetic log row: alpha beta gamma delta epsilon zeta.\n'.repeat(Math.ceil(scenario.chars / 62))).slice(0, scenario.chars);
  const extension = path.join(dir, 'fixture.js');
  await fs.writeFile(extension, `export default function(pi) {
    pi.registerTool({ name: 'context_payload', label: 'Public payload', description: 'Return the public test log. Call once when requested.', parameters: {type:'object',properties:{}},
      async execute() { return {content:[{type:'text',text:${JSON.stringify(payload)}}],details:{}}; } });
    for(let i=0;i<${scenario.tools};i++) pi.registerTool({name:'unused_context_tool_'+i,label:'Unused context fixture',description:${JSON.stringify('Synthetic MCP-like declaration for context accounting. '.repeat(60))},parameters:{type:'object',properties:{}},async execute(){throw new Error('Do not call unused tools');}});
  }`);
  const env = Object.fromEntries(Object.keys(process.env).filter(key => /^(TASKBRIDGE_|PI_)/.test(key)).map(key => [key, undefined]));
  env.PI_CODING_AGENT_DIR = agent;
  env.PI_AGENT_DIR = agent;
  const cli = ['--approve', '--session-dir', sessions, '--provider', provider, '--model', model, '--thinking', 'off', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-extensions', '-e', extension];
  // Explicitly append the synthetic AGENTS file instead of loading ancestors'
  // real instructions. Tool declarations are real Pi extension declarations,
  // representative of MCP schema overhead, not a live corporate MCP connection.
  if (instructions) cli.push('--append-system-prompt', path.join(workspace, 'AGENTS.md'));
  const rpc = new PiRpc({ cwd: workspace, args: cli, env });
  const result = { scenario: scenario.name, provider, model, payloadChars: payload.length, staticInstructionChars: instructions.length, extraToolDeclarations: scenario.tools, keepRecentTokens: scenario.keep };
  const turn = async message => {
    const from = rpc.events.length;
    const settled = rpc.waitFor(event => event.type === 'agent_settled', 90000).then(() => true, () => false);
    const accepted = await rpc.send({ type: 'prompt', message });
    if (!accepted.success || !await settled) throw new Error('Prompt failed or did not settle');
    const frames = rpc.events.slice(from);
    const errors = frames.filter(event => event.type === 'message_end' && ['error', 'aborted'].includes(event.message?.stopReason));
    if (errors.length) throw new Error(errors[0].message.errorMessage || 'Model turn failed');
    return frames.filter(event => event.type === 'message_end' && event.message?.role === 'assistant')
      .flatMap(event => event.message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  };
  try {
    await rpc.send({ type: 'get_state' });
    await turn('Isolated public context test. Remember three facts: project codeword LANTERN-742; never delete source files; next action is verify the checksum. Call context_payload exactly once, then acknowledge these facts briefly. Do not call any other tool.');
    result.before = (await rpc.send({ type: 'get_session_stats' })).data?.contextUsage ?? null;
    const compact = await rpc.send({ type: 'compact' }, 90000);
    if (!compact.success) {
      if (scenario.name === 'small' && /too small|nothing to compact/i.test(compact.error || '')) result.skippedReason = compact.error;
      else throw new Error(compact.error || 'Compaction failed');
    }
    const event = rpc.events.findLast(event => /compaction_end$/.test(event.type) && event.result);
    result.compaction = event?.result ? { tokensBefore: event.result.tokensBefore, estimatedTokensAfter: event.result.estimatedTokensAfter } : compact.data ?? null;
    result.immediatelyAfter = (await rpc.send({ type: 'get_session_stats' })).data?.contextUsage ?? null;
    const state = (await rpc.send({ type: 'get_state' })).data;
    const leaf = (await rpc.send({ type: 'get_entries' })).data?.leafId;
    const snapshot = await readPiSession(state.sessionFile, workspace, { leafId: leaf });
    result.composition = summarizeSessionContext(snapshot);
    const answer = await turn('Without tools, state the project codeword, source-file policy and next action from earlier. Be concise.');
    result.factsPreserved = answer.includes('LANTERN-742') && /never delete|not delete|preserv/i.test(answer) && /checksum/i.test(answer);
    result.answer = answer;
    result.afterResponse = (await rpc.send({ type: 'get_session_stats' })).data?.contextUsage ?? null;
    result.repeatedCompaction = rpc.events.filter(event => /compaction_end$/.test(event.type) && event.result).length > 1;
    result.ok = result.factsPreserved && result.afterResponse?.tokens != null;
  } catch (error) {
    result.ok = false;
    result.error = error.message;
  } finally { await rpc.stop(); }
  results.push(result);
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ piVersion, results }, null, 2) + '\n');
  console.log(JSON.stringify({ scenario: result.scenario, ok: result.ok, before: result.before?.tokens, after: result.afterResponse?.tokens, factsPreserved: result.factsPreserved, error: result.error }));
}
if (results.some(result => !result.ok)) process.exitCode = 1;
