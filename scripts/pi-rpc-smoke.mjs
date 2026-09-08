import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const cwd = process.argv[2] || process.cwd();
const command = process.env.PI_COMMAND || 'pi';
const args = ['--mode', 'rpc', '--no-session'];

console.log(`[smoke] cwd=${cwd}`);
console.log(`[smoke] starting: ${command} ${args.join(' ')}`);

const proc = spawn(command, args, {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  shell: process.platform === 'win32'
});

proc.on('error', (err) => {
  console.error('[smoke] spawn failed:', err.message);
  process.exitCode = 2;
});

proc.stderr.on('data', (chunk) => process.stderr.write(`[pi:stderr] ${chunk}`));

const decoder = new StringDecoder('utf8');
let buffer = '';
let settled = false;

proc.stdout.on('data', (chunk) => {
  buffer += decoder.write(chunk);
  while (true) {
    const i = buffer.indexOf('\n');
    if (i < 0) break;
    let line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        process.stdout.write(event.assistantMessageEvent.delta || '');
      }
      if (event.type === 'tool_execution_start') {
        console.log(`\n[tool] ${event.toolName}`, event.args || '');
      }
      if (event.type === 'compaction_end') {
        console.log(`\n[compact] ${event.result?.tokensBefore ?? '?'} -> ${event.result?.estimatedTokensAfter ?? '?'}`);
      }
      if (event.type === 'agent_settled') {
        settled = true;
        console.log('\n[smoke] PI_RPC_OK: agent_settled received');
        proc.stdin.end();
      }
    } catch (err) {
      console.error('\n[smoke] invalid JSONL:', line, err.message);
    }
  }
});

proc.on('close', (code) => {
  if (!settled) {
    console.error(`[smoke] Pi exited before agent_settled, code=${code}`);
    process.exitCode = 3;
  }
});

proc.stdin.write(JSON.stringify({
  type: 'prompt',
  message: 'Reply exactly PI_RPC_OK. Do not call tools.'
}) + '\n');
