import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_LIMIT_MAX, COMPACTION_DEFAULTS, assertContextLimit, buildContextReport,
  collectContextSources, discoverContextFiles, discoverSystemPromptFiles, estimateTokens,
  mcpDeclarations, readCompactionSettings, skillDescription,
} from '../src/context-report.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'work', 'repo');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
  };
  return { root, agentDir, project, write };
}

test('estimateTokens follows Pi’s chars/4 heuristic and never guesses a negative size', () => {
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens('abc'), 0);
  assert.equal(estimateTokens(-100), 0);
});

test('context files: global first, then ancestors from the root down, first candidate wins', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.agentDir, 'AGENTS.md'), 'global');
  await f.write(path.join(f.root, 'work', 'AGENTS.md'), 'ancestor');
  await f.write(path.join(f.project, 'AGENTS.md'), 'project');
  // A more specific candidate in the same directory replaces the plain AGENTS.md.
  await f.write(path.join(f.root, 'CLAUDE.md'), 'root claude');

  const files = await discoverContextFiles({ cwd: f.project, agentDir: f.agentDir });
  assert.deepEqual(files.map(file => path.relative(f.root, file.path).replaceAll('\\', '/')), [
    'agent/AGENTS.md',
    'CLAUDE.md',
    'work/AGENTS.md',
    'work/repo/AGENTS.md',
  ]);
  assert.equal(files[0].global, true);
  assert.equal(files[1].global, false);
  assert.equal(files[0].chars, 'global'.length);
});

test('context files: AGENTS.override.md shadows AGENTS.md and a missing chain is empty', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.project, 'AGENTS.override.md'), 'override');
  await f.write(path.join(f.project, 'AGENTS.md'), 'plain');
  const files = await discoverContextFiles({ cwd: f.project, agentDir: path.join(f.root, 'no-agent') });
  assert.equal(files.length, 1);
  assert.equal(path.basename(files[0].path), 'AGENTS.override.md');
  assert.equal(files[0].chars, 'override'.length);
  const empty = path.join(f.root, 'empty');
  await fs.mkdir(empty);
  assert.deepEqual(await discoverContextFiles({ cwd: empty, agentDir: f.agentDir }), []);
});

test('SYSTEM.md: the project file wins over the agent one, append is reported separately', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.agentDir, 'SYSTEM.md'), 'agent system');
  await f.write(path.join(f.agentDir, 'APPEND_SYSTEM.md'), 'agent append');
  const globalOnly = await discoverSystemPromptFiles({ cwd: f.project, agentDir: f.agentDir });
  assert.equal(globalOnly.system.project, false);
  assert.equal(globalOnly.system.chars, 'agent system'.length);
  assert.equal(globalOnly.append.chars, 'agent append'.length);

  await f.write(path.join(f.project, '.pi', 'SYSTEM.md'), 'project system!');
  const withProject = await discoverSystemPromptFiles({ cwd: f.project, agentDir: f.agentDir });
  assert.equal(withProject.system.project, true);
  assert.equal(withProject.system.chars, 'project system!'.length);
});

test('skillDescription reads the <description> tag, else the first paragraph', () => {
  assert.equal(skillDescription('# Title\n<description>One line.</description>\nbody'), 'One line.');
  assert.equal(skillDescription('# Title\n\nuses the first paragraph\n\nmore'), 'uses the first paragraph');
  assert.equal(skillDescription('# Only a title'), '');
});

test('mcpDeclarations counts name + description + schema and skips disabled servers', () => {
  const tools = mcpDeclarations({
    servers: [
      { name: 'on', tools: [{ name: 'tool', description: 'x'.repeat(8), inputSchema: { type: 'object' } }] },
      { name: 'off', disabled: true, tools: [{ name: 'hidden', description: 'y'.repeat(400) }] },
      { name: 'broken', tools: [null, { name: 42 }] },
    ],
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].server, 'on');
  assert.equal(tools[0].name, 'tool');
  assert.equal(tools[0].chars, 'tool'.length + 8 + JSON.stringify({ type: 'object' }).length);
  assert.equal(mcpDeclarations(null).length, 0);
});

test('compaction settings: built-in defaults, project overrides, junk falls back', async t => {
  const f = await fixture(t);
  assert.deepEqual(await readCompactionSettings({ cwd: f.project, agentDir: f.agentDir }), {
    reserveTokens: COMPACTION_DEFAULTS.reserveTokens,
    keepRecentTokens: COMPACTION_DEFAULTS.keepRecentTokens,
    enabled: true,
    fromProject: false,
  });
  await f.write(path.join(f.agentDir, 'settings.json'), JSON.stringify({ compaction: { reserveTokens: 1000, keepRecentTokens: 'nope' } }));
  await f.write(path.join(f.project, '.pi', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 500, enabled: false } }));
  assert.deepEqual(await readCompactionSettings({ cwd: f.project, agentDir: f.agentDir }), {
    reserveTokens: 1000,
    keepRecentTokens: 500,
    enabled: false,
    fromProject: true,
  });
});

test('collectContextSources marks measured sources as known and the rest as unknown', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.agentDir, 'SYSTEM.md'), 'a'.repeat(400));
  await f.write(path.join(f.agentDir, 'AGENTS.md'), 'b'.repeat(200));
  await f.write(path.join(f.project, 'AGENTS.md'), 'c'.repeat(100));
  await f.write(path.join(f.agentDir, 'skills', 'one', 'SKILL.md'), '<description>skill one</description>');
  const sources = await collectContextSources({
    cwd: f.project,
    agentDir: f.agentDir,
    mcp: { servers: [{ name: 'srv', tools: [{ name: 'tool', description: 'd'.repeat(40) }] }] },
  });
  const byId = Object.fromEntries(sources.map(item => [item.id, item]));
  assert.equal(byId['system-prompt'].chars, 400);
  assert.equal(byId['system-prompt'].tokens, 100);
  assert.equal(byId['system-prompt'].known, true);
  assert.equal(byId['instructions'].chars, 300, 'agent AGENTS.md + project AGENTS.md');
  assert.equal(byId['instructions'].count, 2);
  assert.equal(byId.skills.count, 1);
  assert.equal(byId.skills.chars, 'one'.length + 'skill one'.length);
  assert.equal(byId['mcp-tools'].count, 1);
  assert.deepEqual(byId['mcp-tools'].servers, ['srv']);
  assert.equal(byId['mcp-tools'].known, true);
  assert.equal(byId['builtin-tools'].known, false);
  assert.equal(byId['builtin-tools'].tokens, null);
  assert.equal(byId.memory.known, false);
  assert.equal(byId.append ?? null, null, 'no APPEND_SYSTEM.md → no entry');
});

test('collectContextSources: with nothing on disk every source is unknown, not zero', async t => {
  const f = await fixture(t);
  const sources = await collectContextSources({ cwd: f.project, agentDir: path.join(f.root, 'missing') });
  const byId = Object.fromEntries(sources.map(item => [item.id, item]));
  assert.equal(byId['system-prompt'].known, false);
  assert.equal(byId['system-prompt'].tokens, null);
  assert.equal(byId.instructions.known, false);
  assert.equal(byId.instructions.chars, 0);
  assert.equal(byId.skills.known, false);
  assert.equal(byId['mcp-tools'].known, false);
});

test('buildContextReport: totals come from Pi, the residual is what sources do not cover', () => {
  const sources = [
    { id: 'system-prompt', known: true, tokens: 500 },
    { id: 'instructions', known: true, tokens: 1500 },
    { id: 'mcp-tools', known: true, tokens: 1000 },
    { id: 'builtin-tools', known: false, tokens: null },
    { id: 'memory', known: false, tokens: null },
  ];
  const report = buildContextReport({
    taskId: 't1',
    model: { provider: 'p', id: 'm', contextWindow: 200000 },
    contextWindow: 200000,
    stats: { contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 }, userMessages: 4, totalMessages: 9, tokens: { input: 10, total: 10 }, cost: 0.5 },
    sources,
    compaction: { reserveTokens: 16384, keepRecentTokens: 20000, auto: true, fromProject: false },
    limit: 40000,
    running: true,
  });
  assert.equal(report.totalTokens, 60000);
  assert.equal(report.measuredTokens, 3000);
  assert.equal(report.unaccountedTokens, 57000);
  assert.equal(report.compaction.triggerAt, 200000 - 16384);
  assert.equal(report.compaction.auto, true);
  assert.equal(report.limit.exceeded, true);
  assert.equal(report.usage.percent, 30);
  assert.equal(report.conversation.userMessages, 4);
  assert.equal(report.running, true);
});

test('buildContextReport: no live Pi means no invented numbers', () => {
  const report = buildContextReport({
    taskId: 't2',
    model: { provider: 'p', id: 'm', contextWindow: 8000 },
    contextWindow: 8000,
    stats: null,
    sources: [{ id: 'system-prompt', known: true, tokens: 100 }],
    compaction: { reserveTokens: 16384, keepRecentTokens: 20000, auto: null, fromProject: false },
    limit: 400000,
  });
  assert.equal(report.totalTokens, null);
  assert.equal(report.usage.source, null);
  assert.equal(report.unaccountedTokens, null);
  assert.equal(report.limit.exceeded, false, 'no usage → not "exceeded", the number is unknown');
  assert.equal(report.compaction.auto, null);
  assert.equal(report.conversation, null);
  assert.equal(report.running, false);
});

test('buildContextReport: an overestimating source list cannot make the residual negative', () => {
  const report = buildContextReport({
    taskId: 't3',
    stats: { contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0 } },
    sources: [{ id: 'instructions', known: true, tokens: 5000 }],
  });
  assert.equal(report.unaccountedTokens, 0);
  // The residual stays 0, but the report says WHY: the sources are an estimate
  // and mine is bigger than what Pi counted on this turn.
  assert.equal(report.overestimated, true);
  assert.match(report.note, /больше того, что Pi насчитал/);
  assert.equal(report.compaction, null);
  assert.equal(report.limit.tokens, null);
});

test('buildContextReport: a source list that fits inside Pi\u2019s total is not flagged', () => {
  const report = buildContextReport({
    stats: { contextUsage: { tokens: 9000, contextWindow: 200000, percent: 4 } },
    sources: [{ id: 'instructions', known: true, tokens: 5000 }],
  });
  assert.equal(report.overestimated, false);
  assert.equal(report.unaccountedTokens, 4000);
  assert.doesNotMatch(report.note, /больше того, что Pi насчитал/);
});

test('assertContextLimit accepts null and integers in range, rejects the rest', () => {
  assert.equal(assertContextLimit(null), null);
  assert.equal(assertContextLimit(undefined), null);
  assert.equal(assertContextLimit(''), null);
  assert.equal(assertContextLimit('off'), null);
  assert.equal(assertContextLimit(32000), 32000);
  assert.equal(assertContextLimit('32000'), 32000);
  assert.equal(assertContextLimit(CONTEXT_LIMIT_MAX), CONTEXT_LIMIT_MAX);
  for (const bad of [1, 1024, 0, -5, 1.5, 'много', NaN, CONTEXT_LIMIT_MAX + 1]) {
    assert.throws(() => assertContextLimit(bad), error => error.code === 'INPUT_INVALID', `rejects ${String(bad)}`);
  }
});
