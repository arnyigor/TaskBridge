import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY, archivedText, estimateTokens, messageChars, planArchival,
} from '../pi-extension/taskbridge-context-budget.js';

const toolResult = (id, chars, extra = {}) => ({
  role: 'toolResult', toolCallId: id, toolName: 'bash', isError: false,
  content: [{ type: 'text', text: 'x'.repeat(chars) }], timestamp: 1, ...extra,
});
const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 1 });

test('estimateTokens follows Pi (chars/4 up) and never invents a size', () => {
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(-10), 0);
});

test('messageChars counts text parts and ignores non-text ones', () => {
  assert.equal(messageChars(user('hello')), 5);
  assert.equal(messageChars({ role: 'user', content: 'plain' }), 5);
  assert.equal(messageChars({ role: 'assistant', content: [{ type: 'image', data: 'zzz' }] }), 0);
  assert.equal(messageChars(null), 0);
});

test('recent tool results stay untouched and old bulky ones become a reference', () => {
  const messages = [
    user('go'),
    assistant('running'),
    toolResult('t1', 400_000),            // 100k tokens: far outside the budget
    assistant('done'),
    toolResult('t2', 4_000),              // 1k tokens: inside the recent budget
  ];
  const plan = planArchival(messages, { keepRecentToolTokens: 2_000, minChars: 2_000 });
  assert.equal(plan.changed, true);
  assert.equal(plan.archived, 1);
  assert.equal(plan.savedChars, 400_000);
  const archived = plan.messages[2];
  assert.equal(archived.role, 'toolResult');
  assert.equal(archived.toolCallId, 't1', 'the call id keeps the pair intact');
  assert.equal(archived.toolName, 'bash');
  assert.equal(archived.content.length, 1);
  assert.equal(archived.content[0].text, archivedText('bash', 400_000));
  assert.match(archived.content[0].text, /400000 символов/);
  // Recent result and the conversation around it are untouched.
  assert.equal(plan.messages[4].content[0].text.length, 4_000);
  assert.equal(plan.messages[0], messages[0]);
});

test('small results are left alone even when they are old', () => {
  const messages = [toolResult('small', 500), assistant('y'.repeat(40_000))];
  const plan = planArchival(messages, { keepRecentToolTokens: 100, minChars: 2_000 });
  assert.equal(plan.changed, false);
  assert.equal(plan.messages, messages, 'the same array when nothing changed');
});

test('a short transcript is never rewritten', () => {
  const messages = [user('hi'), toolResult('t1', 100_000)];
  const plan = planArchival(messages, { keepRecentToolTokens: DEFAULT_POLICY.keepRecentToolTokens });
  assert.equal(plan.changed, false, 'everything fits in the recent budget');
  assert.equal(plan.keptTokens >= 25_000, true);
});

test('image parts survive: only the text of an old result is archived', () => {
  const withImage = {
    role: 'toolResult', toolCallId: 'img', toolName: 'read', isError: false, timestamp: 1,
    content: [{ type: 'text', text: 'y'.repeat(50_000) }, { type: 'image', data: 'AAAA' }],
  };
  const plan = planArchival([withImage, assistant('done'), user('z'.repeat(400_000))], { keepRecentToolTokens: 1000, minChars: 2_000 });
  assert.equal(plan.archived, 1);
  const parts = plan.messages[0].content;
  assert.equal(parts.filter(part => part.type === 'image').length, 1, 'the media policy keeps its part');
  assert.match(parts.find(part => part.type === 'text').text, /архивирован/);
});

test('error results are archived like any other: the fact of the call and the id remain', () => {
  const failed = toolResult('err', 30_000, { isError: true });
  const plan = planArchival([failed, assistant('done'), user('q'.repeat(200_000))], { keepRecentToolTokens: 1000, minChars: 2_000 });
  assert.equal(plan.messages[0].isError, true);
  assert.equal(plan.messages[0].toolCallId, 'err');
});

test('empty input is not a change', () => {
  assert.equal(planArchival([], {}).changed, false);
  assert.equal(planArchival(null, {}).changed, false);
});

test('the archive line is not an instruction to re-run the tool', () => {
  const text = archivedText('grep', 10_034);
  assert.match(text, /10_034|10034/);
  assert.match(text, /архивирован/);
  assert.doesNotMatch(text, /повторите|заново|прочитайте/i,
    'an imperative here makes the model repeat the same call forever');
});

const toolCall = (id, name, args) => ({
  role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], timestamp: 1,
});

test('an old write body is truncated but the call keeps its id, name and shape', () => {
  const call = toolCall('w1', 'write', { path: 'src/a.kt', content: 'y'.repeat(20_000) });
  const plan = planArchival([call, user('z'.repeat(200_000))],
    { keepRecentToolTokens: 1_000, minChars: 2_000, toolInputChars: 800 });
  const part = plan.messages[0].content[0];
  assert.equal(plan.truncated, 1);
  assert.equal(part.id, 'w1');
  assert.equal(part.name, 'write');
  assert.equal(part.arguments.path, 'src/a.kt', 'short values stay readable');
  assert.equal(typeof part.arguments.content, 'string', 'the schema type is preserved');
  assert.ok(part.arguments.content.length < 400, 'the body is gone');
  assert.ok(plan.savedChars > 19_000);
});

test('recent tool calls and short arguments are left untouched', () => {
  const big = toolCall('w2', 'write', { content: 'y'.repeat(5_000) });
  const recent = planArchival([big, user('q')], { keepRecentToolTokens: 40_000, toolInputChars: 800 });
  assert.equal(recent.truncated, 0, 'the current turn keeps its own arguments');
  const short = toolCall('b1', 'bash', { command: 'ls -la' });
  const plan = planArchival([short, user('z'.repeat(200_000))],
    { keepRecentToolTokens: 1_000, minChars: 2_000, toolInputChars: 800 });
  assert.equal(plan.truncated, 0);
});

test('tool arguments count towards the budget instead of being invisible', () => {
  const call = toolCall('w3', 'write', { content: 'y'.repeat(40_000) });
  assert.equal(messageChars(call), JSON.stringify({ content: 'y'.repeat(40_000) }).length);
});

test('a result the model has not seen yet is never archived, however large', () => {
  const huge = toolResult('h1', 400_000);
  const plan = planArchival([assistant('run it'), huge],
    { keepRecentToolTokens: 40_000, minChars: 2_000, toolInputChars: 800 });
  assert.equal(plan.archived, 0, 'the answer to the last call must reach the model');
  assert.equal(plan.messages[1].content[0].text.length, 400_000, 'the result is intact');
});

test('parallel results of one turn are protected together', () => {
  const a = toolResult('p1', 300_000);
  const b = toolResult('p2', 300_000);
  const plan = planArchival([assistant('two calls'), a, b],
    { keepRecentToolTokens: 40_000, minChars: 2_000, toolInputChars: 800 });
  assert.equal(plan.archived, 0);
});

test('once the model has answered, the same result becomes archivable', () => {
  const huge = toolResult('h2', 300_000);
  const plan = planArchival([assistant('run'), huge, assistant('seen'), user('next')],
    { keepRecentToolTokens: 1_000, minChars: 2_000, toolInputChars: 800 });
  assert.equal(plan.archived, 1);
});

test('edit and bash arguments are never truncated: they record what was changed', () => {
  const editCall = toolCall('e1', 'edit', { path: 'a.kt', oldText: 'o'.repeat(5_000), newText: 'n'.repeat(5_000) });
  const bashCall = toolCall('b2', 'bash', { command: 'cat > f <<EOF\n' + 'z'.repeat(5_000) + '\nEOF' });
  const plan = planArchival([editCall, bashCall, assistant('done'), user('q'.repeat(200_000))],
    { keepRecentToolTokens: 1_000, minChars: 2_000, toolInputChars: 800 });
  assert.equal(plan.truncated, 0);
});
