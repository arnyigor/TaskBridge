// Проверка сценариев OMP-02b по состоянию среды, а не по рассказу модели.
//
// Ответ AST-сценариев — файл `answer.json` с жёсткой схемой: сравнение множеств,
// никакого разбора прозы. Правки EDIT-сценариев проверяются запуском `verify.js`
// в рабочей копии плюс ограничением на то, какие файлы и строки могли измениться.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const normalize = value => String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').trim();

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text == null) return { missing: true };
  try { return { value: JSON.parse(text) }; } catch (error) { return { invalid: error.message }; }
}

/** Множество пар «файл:строка» — дубликаты строки (два вызова в одной) считаются. */
function callSet(entries) {
  return entries
    .map(item => `${normalize(item?.file)}:${Number(item?.line)}`)
    .filter(item => !item.endsWith(':NaN'))
    .sort();
}

async function checkAst01(scenario, { workspace }) {
  const answer = await readJson(path.join(workspace, 'answer.json'));
  if (answer.missing) return { ok: false, detail: { reason: 'answer.json не создан' } };
  if (answer.invalid) return { ok: false, detail: { reason: `answer.json не разобран: ${answer.invalid}` } };
  const expected = callSet(scenario.answer.calls);
  const actual = callSet(Array.isArray(answer.value?.calls) ? answer.value.calls : []);
  const missing = expected.filter(item => !actual.includes(item));
  const extra = actual.filter(item => !expected.includes(item));
  return {
    ok: missing.length === 0 && extra.length === 0,
    detail: { expected: expected.length, actual: actual.length, missing, extra },
  };
}

async function checkAst02(scenario, { workspace }) {
  const answer = await readJson(path.join(workspace, 'answer.json'));
  if (answer.missing) return { ok: false, detail: { reason: 'answer.json не создан' } };
  if (answer.invalid) return { ok: false, detail: { reason: `answer.json не разобран: ${answer.invalid}` } };
  const expected = [...scenario.answer.methods].sort();
  const actual = [...new Set((Array.isArray(answer.value?.methods) ? answer.value.methods : []).map(name => String(name).trim()))].sort();
  const missing = expected.filter(item => !actual.includes(item));
  const extra = actual.filter(item => !expected.includes(item));
  return {
    ok: missing.length === 0 && extra.length === 0,
    detail: { expected: expected.length, actual: actual.length, missing, extra },
  };
}

async function runVerify(workspace, args = []) {
  try {
    const { stdout, stderr } = await exec(process.execPath, ['verify.js', ...args], { cwd: workspace, timeout: 30000 });
    return { ok: /VERIFY_OK/.test(stdout), stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || '').trim(), stderr: String(error.stderr || error.message).trim() };
  }
}

const readLines = async file => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n');

/** Номера изменённых строк в файле относительно исходной версии. */
export function changedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const changed = [];
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    if ((a[index] ?? null) !== (b[index] ?? null)) changed.push(index + 1);
  }
  return changed;
}

// Функция целиком: от `export function sliceWindow(` до закрывающей скобки на
// отдельной строке. Нужна, чтобы отличить правку внутри функции от правки файла:
// подмена тела сдвигает номера строк, и наивный построчный диф считал бы чужими
// живые строки ниже (именно так и вышел ложный ❌ в первом прогоне).
const FUNCTION_RE = /export function sliceWindow\([^)]*\) \{[\s\S]*?\n\}/;

function outsideUnchanged(before, after) {
  const strip = text => (FUNCTION_RE.test(text) ? text.replace(FUNCTION_RE, '@@FUNCTION@@') : null);
  const strippedBefore = strip(before);
  const strippedAfter = strip(after);
  if (strippedBefore == null || strippedAfter == null) return false;
  return strippedBefore === strippedAfter;
}

async function checkEdit01(scenario, { workspace, original }) {
  const verify = await runVerify(workspace);
  const before = await fs.readFile(path.join(original, scenario.edit.file), 'utf8');
  const after = await fs.readFile(path.join(workspace, scenario.edit.file), 'utf8').catch(() => null);
  if (after == null) return { ok: false, detail: { reason: `${scenario.edit.file} исчез` } };
  const beforeFn = (before.match(FUNCTION_RE) || [''])[0];
  const afterFn = (after.match(FUNCTION_RE) || [''])[0];
  const changedInFunction = changedLines(beforeFn, afterFn).length;
  const restUntouched = outsideUnchanged(before, after);
  return {
    ok: verify.ok && restUntouched && afterFn.length > 0 && changedInFunction <= scenario.edit.maxChangedLines,
    detail: {
      verifyOk: verify.ok,
      functionFound: afterFn.length > 0,
      changedLinesInFunction: changedInFunction,
      restOfFileUntouched: restUntouched,
      maxChangedLines: scenario.edit.maxChangedLines,
      verify: verify.stdout || verify.stderr,
    },
  };
}

async function checkEdit02(scenario, { workspace, original }) {
  const verify = await runVerify(workspace);
  const untouchedChanged = [];
  for (const file of scenario.edit.untouched) {
    const before = await fs.readFile(path.join(original, file), 'utf8');
    const after = await fs.readFile(path.join(workspace, file), 'utf8').catch(() => null);
    if (after !== before) untouchedChanged.push(file);
  }
  const staleApi = [];
  for (const file of scenario.edit.files) {
    const text = await fs.readFile(path.join(workspace, file), 'utf8').catch(() => '');
    if (text.includes(scenario.edit.requires.absent) || !text.includes(scenario.edit.requires.present)) staleApi.push(file);
  }
  return {
    ok: verify.ok && untouchedChanged.length === 0 && staleApi.length === 0,
    detail: {
      verifyOk: verify.ok,
      untouchedChanged,
      staleApi,
      verify: verify.stdout || verify.stderr,
    },
  };
}

export async function checkScenario(scenario, context) {
  if (scenario.dir === 'ast01') return checkAst01(scenario, context);
  if (scenario.dir === 'ast02') return checkAst02(scenario, context);
  if (scenario.dir === 'edit01') return checkEdit01(scenario, context);
  if (scenario.dir === 'edit02') return checkEdit02(scenario, context);
  throw new Error(`неизвестный сценарий: ${scenario.dir}`);
}

/** Список файлов рабочей копии с содержимым — чтобы видеть, что именно изменилось. */
export async function snapshot(dir) {
  const files = new Map();
  const walk = async relative => {
    for (const entry of await fs.readdir(path.join(dir, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(next);
      else files.set(normalize(next), await fs.readFile(path.join(dir, next), 'utf8'));
    }
  };
  await walk('.');
  return files;
}

export { readLines };
