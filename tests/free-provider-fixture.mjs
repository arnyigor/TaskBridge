// Explicit live-provider acceptance only; never imported by the offline test corpus.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { startFixture } from './server-fixture.mjs';

const model = 'liquid/lfm-2.5-2.6b:free';
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');
const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`);
const entry = (await response.json()).data?.find(candidate => candidate.id === model);
if (!entry || Number(entry.pricing?.prompt) !== 0 || Number(entry.pricing?.completion) !== 0) {
  throw new Error('The acceptance model is not confirmed free by the live catalog');
}

// Resolve before changing cwd: the disposable server root contains fake-pi's pi.cmd.
const requestedCommand = process.env.PI_COMMAND || 'pi';
const command = path.isAbsolute(requestedCommand) ? requestedCommand : (() => {
  const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [requestedCommand], { encoding: 'utf8', windowsHide: true })
    .trim().split(/\r?\n/);
  return process.platform === 'win32' ? found.find(value => value.toLowerCase().endsWith('.cmd')) : found[0];
})();
if (!command || !path.isAbsolute(command)) throw new Error('Installed Pi must resolve to an absolute command path');
const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-free-provider-'));
let fixture;
try {
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  fixture = await startFixture(undefined, {
    root: { pi: {
      command, projectTrust: 'deny',
      args: ['--provider', 'openrouter', '--model', model, '--no-tools', '--no-extensions',
        '--system-prompt', 'Reply.', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--offline'],
    } },
    env: { PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: '0' },
  });
  process.stdout.write(JSON.stringify({ base: fixture.base, model }) + '\n');
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => { if (line.trim() === 'close') input.close(); });
  await new Promise(resolve => input.once('close', resolve));
} finally {
  await fixture?.close();
  if (path.dirname(agentDir) !== path.resolve(os.tmpdir()) || !path.basename(agentDir).startsWith('taskbridge-free-provider-')) {
    throw new Error('Invalid agent-directory cleanup target');
  }
  await fs.rm(agentDir, { recursive: true, force: true });
}
