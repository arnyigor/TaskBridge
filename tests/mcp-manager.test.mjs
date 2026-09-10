import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpManager, normalizeServer } from '../src/mcp-manager.mjs';

async function temp(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('normalizeServer classifies stdio/http and disabled', () => {
  assert.deepEqual(normalizeServer('s', { command: 'python', args: ['x'] }), { name: 's', url: null, command: 'python', transport: 'stdio', disabled: false, excludeTools: [] });
  assert.deepEqual(normalizeServer('h', { url: 'https://x/mcp', disabled: true }), { name: 'h', url: 'https://x/mcp', command: null, transport: 'http', disabled: true, excludeTools: [] });
  assert.equal(normalizeServer('e', null).transport, null);
});

test('inherit mode leaves Pi MCP untouched', async t => {
  const dataRoot = await temp(t, 'tb-mcp-inherit-');
  const mcp = new McpManager({ mcp: { mode: 'inherit' } }, dataRoot);
  assert.equal(mcp.mode, 'inherit');
  assert.deepEqual(mcp.launch(), { args: [], env: {} });
});

test('managed mode imports from Pi, toggles servers and launches exclusively', async t => {
  const dataRoot = await temp(t, 'tb-mcp-managed-');
  const agentDir = await temp(t, 'tb-mcp-agent-');
  await fs.writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      serena: { command: 'serena' },
      'image-description-engine': { command: 'python', args: ['img'] }
    },
    settings: { collapsedResultLines: 3 }
  }));

  const mcp = new McpManager({ mcp: { mode: 'managed' } }, dataRoot);
  assert.equal(path.basename(mcp.path), 'mcp.json');
  await mcp.importFromPi({ PI_AGENT_DIR: agentDir });

  const servers = await mcp.servers();
  assert.deepEqual(servers.map(s => s.name), ['image-description-engine', 'serena']);
  assert.equal(servers.every(s => !s.disabled), true);

  // Editing TaskBridge's file must never touch Pi's own config.
  await mcp.setDisabled('image-description-engine', true);
  assert.deepEqual((await mcp.servers()).filter(s => s.disabled).map(s => s.name), ['image-description-engine']);
  const piConfig = JSON.parse(await fs.readFile(path.join(agentDir, 'mcp.json'), 'utf8'));
  assert.equal(piConfig.mcpServers['image-description-engine'].disabled, undefined);

  const launch = mcp.launch();
  assert.deepEqual(launch.args, ['--mcp-config', mcp.path]);
  assert.equal(launch.env.PI_MCP_CONFIG_MODE, 'exclusive');

  const status = await mcp.status();
  assert.equal(status.mode, 'managed');
  assert.equal(status.exists, true);
  assert.equal(status.servers.length, 2);
});

test('managed mode self-imports Pi config when the TaskBridge file is missing', async t => {
  const dataRoot = await temp(t, 'tb-mcp-auto-');
  const agentDir = await temp(t, 'tb-mcp-auto-agent-');
  await fs.writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
  const manager = new McpManager({ mcp: { mode: 'managed' } }, dataRoot);
  await manager.ensureReady({ PI_AGENT_DIR: agentDir });
  assert.deepEqual((await manager.servers()).map(s => s.name), ['a']);
});

test('off mode creates an empty config and points the launch at it', async t => {
  const dataRoot = await temp(t, 'tb-mcp-off-');
  const mcp = new McpManager({ mcp: { mode: 'off' } }, dataRoot);
  await mcp.ensureReady();
  const launch = mcp.launch();
  assert.deepEqual(launch.args, ['--mcp-config', mcp.offPath]);
  assert.deepEqual(JSON.parse(await fs.readFile(mcp.offPath, 'utf8')), { mcpServers: {} });
  assert.deepEqual(await mcp.servers(), []);
});

test('setDisabled rejects an unknown server', async t => {
  const dataRoot = await temp(t, 'tb-mcp-missing-');
  const mcp = new McpManager({ mcp: { mode: 'managed' } }, dataRoot);
  await assert.rejects(mcp.setDisabled('nope', true), { code: 'NOT_FOUND' });
});

test('per-tool exclusion writes excludeTools and is reflected in status', async t => {
  const dataRoot = await temp(t, 'tb-mcp-tools-');
  const agentDir = await temp(t, 'tb-mcp-tools-agent-');
  await fs.writeFile(path.join(agentDir, 'mcp-cache.json'), JSON.stringify({
    version: 2,
    servers: { img: { tools: [{ name: 'analyze_image', description: 'analyze' }, { name: 'ocr' }] } }
  }));
  const mcp = new McpManager({ mcp: { mode: 'managed' } }, dataRoot);
  await mcp.write({ mcpServers: { img: { command: 'python' } } });

  const server = await mcp.setToolExcluded('img', 'analyze_image', true);
  assert.deepEqual(server.excludeTools, ['analyze_image']);
  assert.deepEqual(JSON.parse(await fs.readFile(mcp.path, 'utf8')).mcpServers.img.excludeTools, ['analyze_image']);

  const status = await mcp.status({ PI_AGENT_DIR: agentDir });
  const img = status.servers.find(s => s.name === 'img');
  assert.deepEqual(img.tools.map(t => t.name), ['analyze_image', 'ocr']);
  assert.deepEqual(img.excludeTools, ['analyze_image']);

  const cleared = await mcp.setToolExcluded('img', 'analyze_image', false);
  assert.deepEqual(cleared.excludeTools, []);
  assert.equal(JSON.parse(await fs.readFile(mcp.path, 'utf8')).mcpServers.img.excludeTools, undefined);
  await assert.rejects(mcp.setToolExcluded('img', '', true), { code: 'INPUT_INVALID' });
});
