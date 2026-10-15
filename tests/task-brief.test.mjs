import test from 'node:test';
import assert from 'node:assert/strict';
import { headText } from '../src/text-tail.mjs';
import { briefTask } from '../src/task-manager.mjs';

// A LIST response ships every session at once (`GET /api/tasks` — the first call
// the phone makes, and the project dashboard). A field that is unbounded per
// session therefore makes a body no client can read: 168 sessions reached
// 16.96 MB in the real database on 2026-10-13, over the KMP client's 16 MB body
// ceiling (TaskBridgeApi.MAX_BODY_BYTES), and the sessions screen — the first
// thing the app loads — refused to open at all.

const big = chars => 'x'.repeat(chars);

test('headText keeps the beginning and says how much it dropped', () => {
  assert.equal(headText('короткий', 100), 'короткий');
  assert.equal(headText(null, 100), '');
  const long = headText('начало\n' + big(5000), 100);
  assert.ok(long.startsWith('начало\n'), 'the head is what survives');
  assert.ok(long.length <= 100, `kept ${long.length} chars`);
  assert.match(long, /остальные \d+ символов опущены/);
});

test('briefTask cuts the per-session megabytes down to what a list shows', () => {
  const brief = briefTask({
    id: 'a1',
    status: 'SUCCEEDED',
    prompt: `первая строка\n${big(200_000)}`,
    assistantText: big(100_000) + '\nготово, файл записан',
    thinkingText: big(50_000),
    verification: [{ command: 'npm test', ok: true, exitCode: 0, stdout: big(80_000), stderr: big(80_000), durationMs: 1200 }],
    git: { isGit: true, status: big(40_000), changedFiles: ['src/a.mjs'] },
    compaction: { count: 1, last: { summary: big(30_000), at: '2026-10-13T00:00:00.000Z' } },
  });

  assert.ok(brief.prompt.startsWith('первая строка\n'), 'the title line survives');
  assert.ok(brief.prompt.length <= 1024, `prompt kept ${brief.prompt.length}`);
  assert.ok(brief.assistantText.endsWith('готово, файл записан'), 'the notification takes the last line of the answer');
  assert.ok(brief.assistantText.length <= 1024, `assistantText kept ${brief.assistantText.length}`);
  assert.equal(brief.thinkingText, null, 'reasoning is only shown by the chat screen, which reads the session itself');
  assert.ok(brief.verification[0].stdout.length <= 512 && brief.verification[0].stderr.length <= 512, 'tool output keeps a tail');
  assert.equal(brief.verification[0].command, 'npm test', 'the command survives');
  assert.equal(brief.verification[0].exitCode, 0);
  assert.ok(brief.git.status.length <= 300, `git status kept ${brief.git.status.length}`);
  assert.deepEqual(brief.git.changedFiles, ['src/a.mjs'], 'the list counts the changed files');
  assert.ok(brief.compaction.last.summary.length <= 300);
});

test('briefTask leaves everything else as it was', () => {
  const task = { id: 'a1', status: 'RUNNING', projectId: 'p', model: { provider: 'x', id: 'y' }, events: 12, sizeBytes: 4096, metrics: { tokens: 5 } };
  // Контракт списка (2026-10-14): строка сессии несёт подпись модели и счётчики, а
  // метрики, скорости, usage и параметры хода убираются — их читает экран сессии
  // из /api/tasks/:id. Списков файлов и правок в строке нет: только сэмпл и число.
  assert.deepEqual(briefTask(task), {
    ...task,
    prompt: '', assistantText: '', thinkingText: null,
    metrics: null, speeds: null, lastUsage: null, parameters: null,
    verification: undefined, git: undefined, compaction: undefined,
  });
  // A session with nothing heavy to trim is returned with its own values intact.
  const withText = { id: 'b2', prompt: 'вопрос', assistantText: 'ответ' };
  const brief = briefTask(withText);
  assert.equal(brief.prompt, 'вопрос');
  assert.equal(brief.assistantText, 'ответ');
  assert.equal(brief.id, 'b2');
});

test('a session with megabytes of text stays small enough for a phone', () => {
  const brief = briefTask({
    id: 'a1',
    prompt: big(300_000),
    assistantText: big(100_000),
    thinkingText: big(100_000),
    verification: Array.from({ length: 10 }, () => ({ command: 'bash x', ok: true, stdout: big(60_000), stderr: big(60_000) })),
    git: { isGit: true, status: big(200_000) },
  });
  const bytes = Buffer.byteLength(JSON.stringify(brief), 'utf8');
  assert.ok(bytes < 100 * 1024, `one briefed session weighs ${(bytes / 1024).toFixed(1)} KB`);
});
