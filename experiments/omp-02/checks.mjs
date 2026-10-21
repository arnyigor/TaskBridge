// Проверка результата прогона: оценивается состояние среды, а не рассказ агента.
// Для CODE-01 проверочный класс (checks/java/shop/Verify.java) копируется в копию
// ПОСЛЕ прогона — агенту он не виден и ослабить его нельзя.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

function run(command, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: isWindows });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', error => resolve({ code: -1, text: `${text}\n${error.message}` }));
    child.on('exit', code => resolve({ code: code ?? -1, text }));
  });
}

async function nodeTests(workspace) {
  const result = await run('node', ['--test'], workspace);
  const passed = Number((/ℹ pass (\d+)/.exec(result.text) || [])[1] ?? 0);
  const failed = Number((/ℹ fail (\d+)/.exec(result.text) || [])[1] ?? (result.code === 0 ? 0 : 1));
  return { ...result, passed, failed };
}

async function readIfExists(file) {
  return fs.readFile(file, 'utf8').catch(() => '');
}

async function grepSourceFiles(workspace, pattern) {
  const hits = [];
  const walk = async relative => {
    const entries = await fs.readdir(path.join(workspace, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (['out', 'node_modules', '.git'].includes(entry.name)) continue;
        await walk(next);
        continue;
      }
      if (!/\.(mjs|js|java)$/.test(entry.name)) continue;
      const body = await readIfExists(path.join(workspace, next));
      const count = body.split(pattern).length - 1;
      if (count > 0) hits.push({ file: next.replaceAll('\\', '/'), count });
    }
  };
  await walk('');
  return hits;
}

async function code01(workspace) {
  const verifySource = await fs.readFile(path.join(here, 'checks', 'java', 'shop', 'Verify.java'), 'utf8');
  const verifyTarget = path.join(workspace, 'src', 'shop', 'Verify.java');
  await fs.mkdir(path.dirname(verifyTarget), { recursive: true });
  await fs.writeFile(verifyTarget, verifySource);

  const sources = (await fs.readdir(path.join(workspace, 'src', 'shop')).catch(() => []))
    .filter(name => name.endsWith('.java'))
    .map(name => path.join('src', 'shop', name));
  const compile = sources.length
    ? await run('javac', ['-encoding', 'UTF-8', '-d', 'out', ...sources], workspace)
    : { code: -1, text: 'нет исходников' };
  const executed = compile.code === 0
    ? await run('java', ['-cp', 'out', 'shop.Verify'], workspace)
    : { code: -1, text: 'компиляция не прошла' };
  const oldApi = await grepSourceFiles(workspace, 'getPrice(');
  const ok = compile.code === 0 && executed.code === 0 && /OK/.test(executed.text) && oldApi.length === 0;
  return {
    ok,
    detail: {
      sourcesCompiled: sources.length,
      compileCode: compile.code,
      compileTail: compile.text.slice(-400),
      runCode: executed.code,
      runTail: executed.text.slice(-400),
      leftoverOldCalls: oldApi,
    },
  };
}

async function code02(workspace, before, diffStat) {
  const tests = await nodeTests(workspace);
  const testFiles = diffStat.files.filter(file => file.startsWith('test/'));
  const ok = tests.failed === 0 && tests.passed >= 7 && testFiles.length === 0;
  return {
    ok,
    detail: {
      passed: tests.passed,
      failed: tests.failed,
      touchedTests: testFiles,
      testTail: tests.text.slice(-400),
    },
  };
}

async function code03(workspace, before, diffStat) {
  const tests = await nodeTests(workspace);
  const changed = diffStat.files;
  const ok = tests.failed === 0
    && tests.passed >= 6
    && changed.length === 1
    && changed[0] === 'src/big.mjs'
    && diffStat.lines <= 40;
  return {
    ok,
    detail: {
      passed: tests.passed,
      failed: tests.failed,
      changedFiles: changed,
      changedLines: diffStat.lines,
      testTail: tests.text.slice(-300),
    },
  };
}

async function code04(workspace, before, diffStat) {
  const tests = await nodeTests(workspace);
  const leftovers = await grepSourceFiles(workspace, 'fetchUser');
  const changed = diffStat.files;
  const services = changed.filter(file => /^src\/services\/svc\d\d\.mjs$/.test(file));
  const ok = tests.failed === 0
    && tests.passed >= 3
    && leftovers.length === 0
    && changed.includes('src/api.mjs')
    && changed.includes('src/index.mjs')
    && services.length === 12;
  return {
    ok,
    detail: {
      passed: tests.passed,
      failed: tests.failed,
      changedFiles: changed.length,
      changedServices: services.length,
      leftovers,
      testTail: tests.text.slice(-300),
    },
  };
}

/**
 * @param {string} id сценарий CODE-01..CODE-04
 * @param {{workspace: string, diffStat: {files: string[], lines: number}, before: Map<string, string>}} context
 */
export async function checkScenario(id, { workspace, diffStat, before }) {
  if (id === 'CODE-01') return code01(workspace);
  if (id === 'CODE-02') return code02(workspace, before, diffStat);
  if (id === 'CODE-03') return code03(workspace, before, diffStat);
  if (id === 'CODE-04') return code04(workspace, before, diffStat);
  throw new Error(`нет проверки для ${id}`);
}
