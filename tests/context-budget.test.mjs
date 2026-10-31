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
  const plan = planArchival([withImage, user('z'.repeat(400_000))], { keepRecentToolTokens: 1000, minChars: 2_000 });
  assert.equal(plan.archived, 1);
  const parts = plan.messages[0].content;
  assert.equal(parts.filter(part => part.type === 'image').length, 1, 'the media policy keeps its part');
  assert.match(parts.find(part => part.type === 'text').text, /архивирован/);
});

test('error results are archived like any other: the fact of the call and the id remain', () => {
  const failed = toolResult('err', 30_000, { isError: true });
  const plan = planArchival([failed, user('q'.repeat(200_000))], { keepRecentToolTokens: 1000, minChars: 2_000 });
  assert.equal(plan.messages[0].isError, true);
  assert.equal(plan.messages[0].toolCallId, 'err');
});

test('empty input is not a change', () => {
  assert.equal(planArchival([], {}).changed, false);
  assert.equal(planArchival(null, {}).changed, false);
});
