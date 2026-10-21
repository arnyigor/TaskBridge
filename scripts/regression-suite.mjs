#!/usr/bin/env node
// The Core Regression Suite (TESTING_PLAN.md §3–§8).
//
// These are the guarantees that must survive EVERY MR, whatever it touched: the
// server runs, a session can be driven end to end, the chat renders history and
// live output, Git snapshots and worktrees behave, files travel, and auth holds.
// A checklist in a document decays; this one is executable, and it is the list the
// document points at.
//
//   node scripts/regression-suite.mjs              # every section
//   node scripts/regression-suite.mjs server chat  # named sections
//   node scripts/regression-suite.mjs --list       # what is in the suite
//   node scripts/regression-suite.mjs --concurrency 4
//
// Concurrency is 2 by default, not the 4 of `npm test`: this suite is the safety
// net, so it favours stability — the timing-sensitive tests (see
// KNOWN_BASELINE_FAILURES.md) are what suffer first under load.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every entry is a real file in tests/. `why` is what the file is here for, so a
 * later MR can tell whether its own change should have been covered here.
 */
export const SECTIONS = {
  server: {
    title: 'Server: запуск, SQLite, сессия целиком (prompt, follow-up, очередь, steering, cancel, restart, compact, model/thinking, завершение, повторное открытие)',
    files: [
      'tests/server.test.mjs',
      'tests/manager.test.mjs',
      'tests/store.test.mjs',
      'tests/store-identity.test.mjs',
      'tests/send-flow.test.mjs',
      'tests/send-e2e.test.mjs',
      'tests/queue-http.test.mjs',
      'tests/queue-pump.test.mjs',
      'tests/runs.test.mjs',
      'tests/local-command-coordinator.test.mjs',
      'tests/runtime-faults.test.mjs',
      'tests/session-history.test.mjs',
      'tests/context-limit.test.mjs',
      'tests/context-report.test.mjs',
      'tests/api-contract.test.mjs',
      'tests/rpc-pipe-recovery.test.mjs',
      'tests/session-startup-recovery.test.mjs',
      'tests/process-protection.test.mjs',
      'tests/instance-lock.test.mjs',
      'tests/turn-state.test.mjs',
      // Запрошенный объём работы и сохранение найденного при ошибке модели
      // (§4, §7 плана 1.3): инструкции хода, доказательства инструментов.
      'tests/prompt-builder.test.mjs',
      'tests/turn-instructions.test.mjs',
      'tests/tool-evidence.test.mjs',
    ],
  },
  chat: {
    title: 'Chat: история, live SSE, reconnect, страницы старой истории, размышления, инструменты, правки/удаление/regenerate/fork/варианты, TURN_TRUNCATED/TURN_EDITED',
    files: [
      'tests/chat.test.mjs',
      'tests/chat-delete-answer.test.mjs',
      'tests/clear-chat.test.mjs',
      'tests/undo-turn.test.mjs',
      'tests/event-stream.test.mjs',
      'tests/event-window.test.mjs',
      'tests/event-trim.test.mjs',
      'tests/output-files.test.mjs',
      'tests/web-css.test.mjs',
      'tests/machine-load-panel.test.mjs',
      'tests/web-reconnect.test.mjs',
      // Блок «Результаты инструментов» на упавшем ходе (MR-04 Web).
      'tests/web-tool-evidence.test.mjs',
      'tests/web-transport.test.mjs',
      'tests/web-command-client.test.mjs',
      'tests/composer-drafts.test.mjs',
      'tests/event-mux-failures.test.mjs',
    ],
  },
  git: {
    title: 'Git: чистый и грязный workspace, worktree, diff, staged/untracked/binary, усечённый снимок, доверие к папке',
    files: [
      'tests/git.test.mjs',
      'tests/project-trust.test.mjs',
    ],
  },
  files: {
    title: 'Files: вложения, большой файл, границы путей, открытие файла на компьютере',
    files: [
      'tests/files-contained.test.mjs',
      'tests/multipart.test.mjs',
      'tests/open-local.test.mjs',
      'tests/open-machine.test.mjs',
      'tests/project-browser.test.mjs',
    ],
  },
  auth: {
    title: 'Auth и доступ: pairing, bearer, отозванный и негодный токен, чужой Origin, LAN и прокси',
    files: [
      'tests/cloud-relay-auth.test.mjs',
      'tests/remote-access.test.mjs',
      'tests/access-machine.test.mjs',
      'tests/lan-mode.test.mjs',
      'tests/proxy.test.mjs',
    ],
  },
  delivery: {
    title: 'Delivery: durable command inbox, unknown outcome after crash, ordered event upload, relay reconnect',
    files: [
      'tests/cloud-command-inbox.test.mjs',
      'tests/cloud-upload-order.test.mjs',
      'tests/cloud-buffer.test.mjs',
      'tests/cloud-worker.test.mjs',
      'tests/cloud-relay-connector.test.mjs',
      'tests/cloud-queue.test.mjs',
    ],
  },
  project: {
    title: 'Project brain (MR-01…MR-06): дашборд, Work Items, связи с сессиями, Resume/Recap, рецепты, расписания и инвокации',
    files: [
      'tests/project-dashboard.test.mjs',
      'tests/web-project-dashboard.test.mjs',
      'tests/work-items.test.mjs',
      'tests/work-item-sessions.test.mjs',
      'tests/resume.test.mjs',
      'tests/recipes.test.mjs',
      'tests/schedules.test.mjs',
      'tests/invocations.test.mjs',
      // Бенчмарк поведения агента (MR-05): оценка без моделей.
      'tests/agent-behavior.test.mjs',
      // PoC Pi hooks (TASKBRIDGE-CORE-01): логика хука без Pi и модели.
      'tests/pi-hooks-poc.test.mjs',
    ],
  },
};

/** KMP is a separate toolchain: it cannot run inside `node --test`. */
export const KMP_COMMANDS = [
  { cwd: 'clients/kmp', args: ['-p', 'core', ':api:jvmTest', '--console=plain'] },
  { cwd: 'clients/kmp', args: ['-p', 'core', ':client:jvmTest', '--console=plain'] },
  { cwd: 'clients/kmp', args: [':shared:jvmTest', '--console=plain'] },
  { cwd: 'clients/kmp', args: [':androidApp:assembleDebug', '--console=plain'] },
];

function parseArgs(argv) {
  const names = [];
  let concurrency = 2;
  let list = false;
  let kmp = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--list') list = true;
    else if (arg === '--kmp') kmp = true;
    else if (arg === '--concurrency') concurrency = Number(argv[++index]) || 2;
    else if (arg.startsWith('--concurrency=')) concurrency = Number(arg.split('=')[1]) || 2;
    else names.push(arg);
  }
  return { names, concurrency, list, kmp };
}

/**
 * Runs one section, keeping its output for parsing AND writing it through: a
 * buffered suite is silent for minutes, and silence is indistinguishable from a
 * hang — the first run of this script was killed with its shell and left nothing.
 */
function run(command, args, cwd, { stream = false } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const consume = (chunk) => {
      const text = String(chunk);
      output += text;
      if (stream) for (const line of text.split(String.fromCharCode(10))) if (line.trim()) console.log(`    │ ${line}`);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    // A missing tool (no gradlew, no node) must be one failed section, not the end of
    // the whole run: the suite is the thing people trust after a risky MR.
    child.once('error', error => resolve({ code: 127, output: `${output}
${command} ${args.join(' ')}: ${error.message}` }));
    child.once('close', code => resolve({ code: code ?? 1, output }));
  });
}

/** The failing test names, as the runner prints them. */
function failuresOf(output) {
  const section = output.split('failing tests:')[1] ?? '';
  return section.split('\n').filter(line => line.startsWith('✖ ')).map(line => line.trim()).filter((line, index, all) => all.indexOf(line) === index);
}

function counts(output) {
  const pick = (name) => Number(new RegExp(`^ℹ ${name} (\\d+)`, 'mu').exec(output)?.[1] ?? 0);
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail'), skipped: pick('skipped') };
}

const { names, concurrency, list, kmp } = parseArgs(process.argv.slice(2));
const chosen = names.length ? names : Object.keys(SECTIONS);
const unknown = chosen.filter(name => !SECTIONS[name]);
if (unknown.length) {
  console.error(`Неизвестные секции: ${unknown.join(', ')}. Известные: ${Object.keys(SECTIONS).join(', ')}`);
  process.exit(2);
}

if (list) {
  for (const name of chosen) {
    console.log(`\n${name}: ${SECTIONS[name].title}`);
    for (const file of SECTIONS[name].files) console.log(`  ${file}`);
  }
  console.log('\nKMP:');
  for (const command of KMP_COMMANDS) console.log(`  (cd ${command.cwd} && ./gradlew ${command.args.join(' ')})`);
  process.exit(0);
}

const results = [];
for (const name of chosen) {
  const section = SECTIONS[name];
  process.stdout.write(`\n=== ${name}: ${section.title}\n`);
  const started = Date.now();
  // `--test-force-exit` exactly as `npm test` uses: a file that leaves a timer or a
  // fixture server alive would otherwise keep the child running forever, and the
  // whole suite would look «slow» instead of finished.
  const { code, output } = await run(
    process.execPath,
    ['--test', '--test-force-exit', `--test-concurrency=${concurrency}`, ...section.files],
    root,
    { stream: true },
  );
  const summary = counts(output);
  const failures = failuresOf(output);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ name, code, summary, failures, seconds });
  console.log(`${code === 0 ? '✔' : '✖'} ${name}: ${summary.pass}/${summary.tests} за ${seconds} с${summary.skipped ? `, пропущено ${summary.skipped}` : ''}`);
  for (const failure of failures) console.log(`    ${failure}`);
}

if (kmp) {
  for (const command of KMP_COMMANDS) {
    const label = `${command.cwd} ./gradlew ${command.args.join(' ')}`;
    process.stdout.write(`\n=== ${label}\n`);
    // A `.bat` cannot be spawned directly on Windows (ENOENT): it needs cmd.exe.
    const gradle = process.platform === 'win32'
      ? { command: 'cmd.exe', args: ['/c', 'gradlew.bat', ...command.args] }
      : { command: './gradlew', args: command.args };
    const { code, output } = await run(gradle.command, gradle.args, path.join(root, command.cwd));
    const errors = output.split('\n').filter(line => line.startsWith('e: ')).slice(0, 5);
    results.push({ name: label, code, summary: counts(output), failures: errors, seconds: null });
    console.log(`${code === 0 ? '✔' : '✖'} ${label}`);
    for (const error of errors) console.log(`    ${error}`);
  }
}

const failed = results.filter(entry => entry.code !== 0);
console.log(`\n=== Итого: ${results.length - failed.length}/${results.length} секций зелёные`);
if (failed.length) {
  console.log('Упали:');
  for (const entry of failed) console.log(`  ${entry.name}${entry.failures.length ? ` — ${entry.failures.join('; ')}` : ''}`);
  console.log('Сверьтесь с KNOWN_BASELINE_FAILURES.md: то, что перечислено там, — не ваша регрессия, но и не «наверное, было раньше».');
}
process.exit(failed.length ? 1 : 0);
