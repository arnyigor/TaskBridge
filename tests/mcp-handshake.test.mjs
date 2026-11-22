import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpManager, probeMcpHandshake } from '../src/mcp-manager.mjs';

async function temp(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const GOOD_SERVER = `
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (const line of buffer.split(/\\r?\\n/)) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\\n');
    if (message.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'ping' }] } }) + '\\n');
  }
});
`;

test('handshake proves initialize/tools/list and classifies dependency, crash and hang', async t => {
  const dataRoot = await temp(t, 'tb-mcp-handshake-');
  const mcp = new McpManager({ mcp: { mode: 'managed' } }, dataRoot);
  await mcp.write({ mcpServers: {
    good: { command: process.execPath, args: ['-e', GOOD_SERVER] },
    crash: { command: process.execPath, args: ['-e', 'process.exit(2)'] },
    hang: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
    missing: { command: path.join(dataRoot, 'missing-python.exe') },
  } });
  const status = await mcp.probe(null, { timeoutMs: 600 });
  const byName = Object.fromEntries(status.servers.map(server => [server.name, server.health]));
  assert.equal(byName.good.state, 'ready');
  assert.equal(byName.good.toolCount, 1);
  assert.equal(byName.crash.state, 'error');
  assert.match(byName.crash.error, /exited before handshake/);
  assert.equal(byName.hang.state, 'error');
  assert.match(byName.hang.error, /timeout/);
  assert.equal(byName.missing.state, 'error');
  assert.equal(byName.good.state, 'ready', 'one broken server must not break the others');
});

test('direct handshake returns tool names, never a false "configured"', async () => {
  const good = await probeMcpHandshake({ command: process.execPath, args: ['-e', GOOD_SERVER] }, { timeoutMs: 1000 });
  assert.equal(good.ok, true);
  assert.deepEqual(good.tools, ['ping']);
  const bad = await probeMcpHandshake({ command: path.join(os.tmpdir(), 'no-such-mcp.exe') }, { timeoutMs: 1000 });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

test('managed launch never sends disabled entries or the TaskBridge disabled marker to Pi', async t => {
  const dataRoot = await temp(t, 'tb-mcp-active-');
  const taskDir = await temp(t, 'tb-mcp-active-task-');
  await fs.writeFile(path.join(dataRoot, 'mcp.json'), JSON.stringify({ mcpServers: {
    on: { command: 'node', args: ['on.js'] },
    off: { command: 'node', args: ['off.js'], disabled: true },
    importedOff: { command: 'node', args: ['imported.js'], enabled: false },
  }, settings: { collapsedResultLines: 3 } }));
  const mcp = new McpManager({ mcp: { mode: 'managed' } }, dataRoot);
  const launch = await mcp.launchFor(null, { taskDir });
  const written = JSON.parse(await fs.readFile(launch.path, 'utf8'));
  assert.deepEqual(Object.keys(written.mcpServers), ['on']);
  assert.deepEqual(Object.keys(written.mcpServers.on), ['command', 'args']);
  assert.equal(written.mcpServers.on.disabled, undefined);
  assert.equal(written.mcpServers.on.enabled, undefined);
  assert.equal(written.settings.warnOnLargeDirectTools, false);
  // The shared config, and the user's disabled entries, stay intact for the UI.
  const shared = JSON.parse(await fs.readFile(path.join(dataRoot, 'mcp.json'), 'utf8'));
  assert.equal(shared.mcpServers.off.disabled, true);
  assert.equal(shared.mcpServers.importedOff.enabled, false);
});
