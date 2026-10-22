// FP-01: один Markdown-файл как единственный источник истины Follow Plan.
//
// Проверяется то, что можно проверить без Pi и без модели: формат, отказ от
// незнакомого текста (иначе он молча потеряется при записи), workspace-scope,
// compare-and-swap по ревизии и хэшу, атомарная запись с Windows-retry и
// восстановление после неудачного rename.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parsePlan, serializePlan, planHash, readPlan, updatePlan, writePlanAtomic,
  proposeImport, applyChanges, nextStepId, nextFindingId, PlanError,
  STEP_STATUSES, PRIORITIES
} from '../src/application/plan-file.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-test
revision: 3
goal: "Стабилизировать загрузку истории"
---

# План: стабилизация истории

## Шаги

### S-001 | DONE | P1 | Воспроизвести проблему
**Критерии:** сценарий воспроизведён в тесте.
**Проверка:** node --test tests/history.test.mjs
**Результат:** failing-тест до исправления

### S-002 | TODO | P1 | Исправить пагинацию
**Критерии:** нет дублей и потери событий.
**Проверка:** адресные тесты + UI smoke

## Обнаруженные проблемы
- F-001 | P1 | OPEN | дублирование событий при reconnect
`;

const tempRoot = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-plan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

const write = async (file, text) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
};

const rejects = async (promise, code) => {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof PlanError, `ожидалась PlanError, получено ${error.name}: ${error.message}`);
    assert.equal(error.code, code);
    return true;
  });
};

test('the managed plan round-trips through parse and serialise without losing anything', () => {
  const plan = parsePlan(PLAN);
  assert.equal(plan.planId, 'p-test');
  assert.equal(plan.revision, 3);
  assert.equal(plan.goal, 'Стабилизировать загрузку истории');
  assert.deepEqual(plan.steps.map(step => [step.id, step.status, step.priority]), [['S-001', 'DONE', 'P1'], ['S-002', 'TODO', 'P1']]);
  assert.equal(plan.steps[0].result, 'failing-тест до исправления');
  assert.equal(plan.findings[0].id, 'F-001');

  const text = serializePlan(plan);
  const again = parsePlan(text);
  assert.deepEqual(again, plan);
  assert.equal(planHash(text), planHash(serializePlan(again)), 'the same plan must hash the same');
  assert.equal(serializePlan(again), text, 'serialisation is deterministic');
});

test('CRLF is folded, so a Windows checkout is not an edit', () => {
  assert.equal(planHash(PLAN.replace(/\n/g, '\r\n')), planHash(PLAN));
  assert.deepEqual(parsePlan(PLAN.replace(/\n/g, '\r\n')), parsePlan(PLAN));
});

test('the format refuses what it cannot represent instead of dropping it', () => {
  const cases = [
    ['нет front matter', '# просто текст\n', /front matter/i],
    ['закрывающий --- потерян', '---\ntaskbridge_plan: 1\n', /не закрыт/i],
    ['неизвестный статус', PLAN.replace('S-002 | TODO', 'S-002 | HOLD'), /неизвестный статус/],
    ['нет критериев', PLAN.replace('**Критерии:** нет дублей и потери событий.\n', ''), /критери/],
    ['DONE без результата', PLAN.replace('**Результат:** failing-тест до исправления\n', ''), /DONE без результата/],
    ['повтор идентификатора', PLAN.replace('### S-002', '### S-001'), /повторяется/],
    ['свободный текст в шаге', PLAN.replace('\n## Обнаруженные проблемы', '\nКакой-то текст без поля\n\n## Обнаруженные проблемы'), /не понята строка/],
    ['текст вне разделов', PLAN.replace('\n# План: стабилизация истории', '\nВступление, которого нет в формате\n\n# План: стабилизация истории'), /вне разделов/],
    ['неизвестный раздел', PLAN.replace('## Обнаруженные проблемы', '## Заметки'), /неизвестный раздел/],
    ['плоский plan_id', PLAN.replace('plan_id: p-test', 'plan_id: test'), /plan_id/],
    ['ревизия не число', PLAN.replace('revision: 3', 'revision: три'), /revision/]
  ];
  for (const [name, text, pattern] of cases) {
    assert.throws(() => parsePlan(text), error => {
      assert.equal(error.code, 'PLAN_INVALID', name);
      assert.match(error.message, pattern, name);
      assert.ok(error.problems.length > 0, `${name}: problems must be listed`);
      return true;
    }, name);
  }
});

test('the plan file stays inside the workspace and is read with its hash', async t => {
  const root = await tempRoot(t);
  await write(path.join(root, 'docs', 'PLAN.md'), PLAN);

  const read = await readPlan({ root, relPath: 'docs/PLAN.md' });
  assert.equal(read.plan.planId, 'p-test');
  assert.equal(read.hash, planHash(PLAN));

  await rejects(readPlan({ root, relPath: 'docs/missing.md' }), 'PLAN_NOT_ATTACHED');
  await rejects(readPlan({ root, relPath: '../outside.md' }), 'PLAN_INVALID');
  await rejects(readPlan({ root, relPath: path.join(root, 'docs', 'PLAN.md') }), 'PLAN_INVALID');
  await rejects(readPlan({ root, relPath: 'docs/PLAN.md', maxBytes: 10 }), 'PLAN_INVALID');
});

test('a symlink out of the workspace is refused', async t => {
  const root = await tempRoot(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await write(path.join(outside, 'PLAN.md'), PLAN);
  let relPath = 'PLAN.md';
  try {
    await fs.symlink(path.join(outside, 'PLAN.md'), path.join(root, 'PLAN.md'));
  } catch (error) {
    // Windows без developer mode не даёт создать symlink, но junction каталога
    // создаётся без прав администратора и так же выводит за пределы workspace.
    try {
      await fs.symlink(outside, path.join(root, 'linked'), 'junction');
      relPath = 'linked/PLAN.md';
    } catch (junctionError) {
      t.skip(`neither symlink nor junction is available: ${error.code} / ${junctionError.code}`);
      return;
    }
  }
  await rejects(readPlan({ root, relPath }), 'PLAN_INVALID');
});

test('updatePlan writes the same file with a new revision and verified bytes', async t => {
  const root = await tempRoot(t);
  const file = path.join(root, 'docs', 'PLAN.md');
  await write(file, PLAN);
  const before = await readPlan({ root, relPath: 'docs/PLAN.md' });

  const updated = await updatePlan({
    root,
    relPath: 'docs/PLAN.md',
    expectedRevision: 3,
    expectedHash: before.hash,
    changes: { ops: [{ op: 'set_step_status', stepId: 'S-002', status: 'DONE', result: 'тесты зелёные' }] }
  });

  assert.equal(updated.plan.revision, 4);
  const onDisk = await fs.readFile(file, 'utf8');
  assert.equal(onDisk, updated.text);
  assert.equal(planHash(onDisk), updated.hash);
  const reread = await readPlan({ root, relPath: 'docs/PLAN.md' });
  assert.equal(reread.plan.steps[1].status, 'DONE');
  assert.equal(reread.plan.steps[1].result, 'тесты зелёные');
  assert.equal(reread.plan.steps[0].result, 'failing-тест до исправления', 'existing evidence is untouched');
});

test('a human edit during the cycle is a conflict, never overwritten', async t => {
  const root = await tempRoot(t);
  const file = path.join(root, 'docs', 'PLAN.md');
  await write(file, PLAN);
  const before = await readPlan({ root, relPath: 'docs/PLAN.md' });

  const humanText = PLAN.replace('Исправить пагинацию', 'Исправить пагинацию (правка человека)');
  await fs.writeFile(file, humanText, 'utf8');

  await rejects(updatePlan({
    root, relPath: 'docs/PLAN.md', expectedRevision: 3, expectedHash: before.hash,
    changes: { ops: [{ op: 'set_step_status', stepId: 'S-002', status: 'IN_PROGRESS' }] }
  }), 'PLAN_REVISION_CONFLICT');
  assert.equal(await fs.readFile(file, 'utf8'), humanText, 'the human version is still on disk');

  // A stale revision with a matching hash is also a conflict.
  await rejects(updatePlan({
    root, relPath: 'docs/PLAN.md', expectedRevision: 2,
    changes: { ops: [{ op: 'set_step_status', stepId: 'S-002', status: 'IN_PROGRESS' }] }
  }), 'PLAN_REVISION_CONFLICT');
});

test('a busy rename is retried, and a failed one leaves the plan intact', async t => {
  const root = await tempRoot(t);
  const file = path.join(root, 'PLAN.md');
  await write(file, PLAN);

  // Windows: the file is briefly held by an editor.
  let attempts = 0;
  const flaky = {
    ...fs,
    writeFile: fs.writeFile.bind(fs),
    readFile: fs.readFile.bind(fs),
    rm: fs.rm.bind(fs),
    rename: async (from, to) => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return fs.rename(from, to);
    }
  };
  const ok = await writePlanAtomic({ file, text: PLAN, fsImpl: flaky, sleep: async () => {} });
  assert.equal(attempts, 3);
  assert.equal(ok.hash, planHash(PLAN));
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.tmp')), [], 'no temp file is left behind');

  const broken = {
    ...fs,
    writeFile: fs.writeFile.bind(fs),
    readFile: fs.readFile.bind(fs),
    rm: fs.rm.bind(fs),
    rename: async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); }
  };
  await rejects(writePlanAtomic({ file, text: 'испорченный текст\n', fsImpl: broken, attempts: 3, sleep: async () => {} }), 'PLAN_WRITE_FAILED');
  assert.equal(await fs.readFile(file, 'utf8'), PLAN, 'the previous plan is still readable');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.tmp')), []);
});

test('a rename that did not store the prepared bytes is reported, not trusted', async t => {
  const root = await tempRoot(t);
  const file = path.join(root, 'PLAN.md');
  await write(file, PLAN);
  const lying = {
    ...fs,
    writeFile: fs.writeFile.bind(fs),
    rename: fs.rename.bind(fs),
    rm: fs.rm.bind(fs),
    readFile: async () => 'другой текст\n'
  };
  await rejects(writePlanAtomic({ file, text: PLAN, fsImpl: lying }), 'PLAN_WRITE_FAILED');
  assert.equal(await fs.readFile(file, 'utf8'), PLAN);
});

test('only modelled edits are allowed, and they keep the invariants', () => {
  const plan = parsePlan(PLAN);
  assert.equal(nextStepId(plan), 'S-003');
  assert.equal(nextFindingId(plan), 'F-002');

  const added = applyChanges(structuredClone(plan), {
    ops: [
      { op: 'add_finding', findingId: 'F-002', priority: 'P1', summary: 'дубли после reconnect' },
      { op: 'add_step', stepId: 'S-003', priority: 'P1', title: 'Исправить reconnect', criteria: 'нет дублей', verification: 'тест reconnect', after: 'S-002', originFindingId: 'F-002' }
    ]
  });
  assert.deepEqual(added.steps.map(step => step.id), ['S-001', 'S-002', 'S-003']);
  assert.equal(added.steps[2].status, 'TODO');
  assert.equal(added.steps[2].originFindingId, 'F-002');
  assert.deepEqual(parsePlan(serializePlan(added)).steps.map(step => step.id), ['S-001', 'S-002', 'S-003']);

  assert.equal(STEP_STATUSES.includes('UNVERIFIED'), false, 'the verification level is not a step status (open decision §13.4)');
  assert.equal(PRIORITIES.length, 4);

  const cases = [
    [{ op: 'set_step_status', stepId: 'S-002', status: 'DONE' }, /DONE требует результата/],
    [{ op: 'set_step_status', stepId: 'S-002', status: 'SKIPPED' }, /SKIPPED требует причины/],
    [{ op: 'add_step', stepId: 'S-003', priority: 'P9', criteria: 'x', verification: 'y' }, /приоритет/],
    [{ op: 'add_step', stepId: 'S-003', priority: 'P1', title: 'без проверки', criteria: 'x' }, /критериев и способа проверки/],
    [{ op: 'add_step', stepId: 'S-001', priority: 'P1', criteria: 'x', verification: 'y' }, /уже есть/],
    [{ op: 'delete_step', stepId: 'S-001' }, /Неизвестная операция/]
  ];
  for (const [op, pattern] of cases) {
    assert.throws(() => applyChanges(parsePlan(PLAN), { ops: [op] }), error => {
      assert.equal(error.code, 'PLAN_INVALID');
      assert.match(error.message, pattern);
      return true;
    }, JSON.stringify(op));
  }
});

test('import is a preview: free-form text becomes managed steps, nothing is written', async t => {
  const root = await tempRoot(t);
  const source = path.join(root, 'PLAN.md');
  const text = [
    '# Мой план',
    '',
    '## Что сделать',
    'Вступление, которого нет в формате.',
    '- [ ] Починить пагинацию',
    '- [x] Воспроизвести проблему',
    '### Проверить приёмку',
    '',
    'Пояснение к плану, которого нет в формате.'
  ].join('\n');
  await write(source, text);

  const preview = proposeImport(text, { planId: 'p-import', goal: 'Стабилизировать историю' });
  assert.equal(preview.problems.length, 0);
  assert.deepEqual(preview.plan.steps.map(step => step.title), ['Починить пагинацию', 'Воспроизвести проблему', 'Проверить приёмку']);
  assert.deepEqual(preview.plan.steps.map(step => step.status), ['TODO', 'TODO', 'TODO'], 'a ticked box is not evidence');
  assert.ok(preview.unmapped.some(line => /подтверждения нет/.test(line)));
  assert.ok(preview.unmapped.some(line => /Вступление/.test(line)));
  // Абзац после шага относится к этому шагу, а не теряется.
  assert.match(preview.plan.steps[2].criteria, /Пояснение к плану/);
  assert.equal(preview.plan.revision, 0);

  const imported = parsePlan(preview.content);
  assert.equal(imported.goal, 'Стабилизировать историю');
  assert.equal(await fs.readFile(source, 'utf8'), text, 'the source file is untouched');
  assert.deepEqual((await fs.readdir(root)), ['PLAN.md'], 'import creates no second plan file');

  const empty = proposeImport('просто заметки\n', { planId: 'p-empty' });
  assert.equal(empty.content, null);
  assert.ok(empty.problems.some(line => /ни одного шага/.test(line)));
});
