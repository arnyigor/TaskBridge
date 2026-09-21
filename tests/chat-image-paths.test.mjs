import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatState, isPrivateFilePath } from '../web/chat-state.mjs';
import { isPrivatePath } from '../src/files.mjs';

// Regression: a tool call that names a file under the server's private paths
// (most often `data/runtime/…png`, where screenshots and scratch output land)
// used to be advertised as a viewable image. The chat then requested
// `/api/tasks/<id>/workspace-file?path=data/…`, got 403 FILE_FORBIDDEN and
// painted a broken picture in the conversation.
const task = (id = 'a') => ({ id, prompt: 'Вопрос', status: 'RUNNING' });
const toolStart = (seq, args, name = 'bash') => ({
  taskId: 'a',
  seq,
  type: 'PI_EVENT',
  data: { pi: { type: 'tool_execution_start', toolCallId: `t${seq}`, toolName: name, args } }
});

test('a path the server will refuse is not advertised as an image', () => {
  const state = new ChatState(task());
  state.apply(toolStart(1, { command: 'adb exec-out screencap -p > data/runtime/phone.png', path: 'data/runtime/phone.png' }));
  assert.equal(state.current.tools[0].imagePath, undefined);
  // The chip itself stays: the run is still worth showing, only the preview is not.
  assert.match(state.current.tools[0].label, /screencap/);
});

test('the same path nested deeper is refused too', () => {
  const state = new ChatState(task());
  state.apply(toolStart(1, { path: 'app/data/shots/a.png' }));
  state.apply(toolStart(2, { file_path: '.pi/agent/logo.png' }));
  assert.deepEqual(state.current.tools.map(tool => tool.imagePath), [undefined, undefined]);
});

test('a servable image path is still advertised', () => {
  const state = new ChatState(task());
  state.apply(toolStart(1, { path: 'docs/shots/launch.png' }));
  state.apply(toolStart(2, { filePath: 'C:\\proj\\shots\\launch.jpeg' }));
  assert.deepEqual(state.current.tools.map(tool => tool.imagePath), ['docs/shots/launch.png', 'C:\\proj\\shots\\launch.jpeg']);
});

test('a non-image path is passed through unchanged', () => {
  const state = new ChatState(task());
  state.apply(toolStart(1, { path: 'README.md' }));
  assert.equal(state.current.tools[0].imagePath, 'README.md');
});

// The two predicates are duplicated on purpose (the browser cannot import the
// Node-side module), so drift must be caught rather than trusted.
test('the client predicate mirrors the server one', () => {
  const paths = [
    'data/x.png', 'a/data/x.png', 'data/x', 'data', 'shots/x.png', 'a.png', 'readme.md',
    '.git/hooks/x.png', '.pi/agent/x.png', 'node_modules/pkg/x.png', '.ssh/id.png', '.aws/x.png',
    'config.json', 'a/config.json', '.env', 'sub/.env.local', 'secrets.json', 'secret.properties',
    'a.secret.png', 'credentials', 'credential.png', 'auth.json', 'server-auth.json',
    'k.pem', 'a/b/k.jks', 'keystore', 'x.keystore', 'x.key', 'deploy.p12', 'x.pfx',
    'C:\\proj\\data\\x.png', 'C:\\proj\\shots\\x.png', 'docs/data-report.png', 'metadata/x.png',
    '', 'a/b/c'
  ];
  for (const value of paths) {
    assert.equal(isPrivateFilePath(value), isPrivatePath(value), `правила разошлись на «${value}»`);
  }
});
