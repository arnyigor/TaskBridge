import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTaskSnapshot,
  applyEventToTaskSnapshot,
  deriveChatUiState,
} from '../web/chat-ui-state.mjs';

describe('web/chat-ui-state', () => {
  it('mergeTaskSnapshot не откатывает статус, если SSE уже прошёл дальше (chatCursor > next.snapshotSeq)', () => {
    const prev = { id: 't1', status: 'CANCELLED', snapshotSeq: 40, current: 'Cancelled' };
    const staleGet = { id: 't1', status: 'RUNNING', snapshotSeq: 48, current: 'Pi is working' };

    // SSE уже доставил seq 50 (TASK_CANCELLED), а параллельный GET пришёл с seq 48 (RUNNING).
    const merged = mergeTaskSnapshot(prev, staleGet, 50);

    assert.equal(merged.status, 'CANCELLED');
    assert.equal(merged.current, 'Cancelled');
  });

  it('applyEventToTaskSnapshot мгновенно обновляет статус и snapshotSeq по TASK_CANCELLED', () => {
    const task = { id: 't1', status: 'RUNNING', snapshotSeq: 10, providerWait: { httpStatus: 429 } };
    const updated = applyEventToTaskSnapshot(task, {
      taskId: 't1', seq: 11, type: 'TASK_CANCELLED', message: 'Task cancelled',
    });

    assert.equal(updated.status, 'CANCELLED');
    assert.equal(updated.snapshotSeq, 11);
    assert.equal(updated.providerWait, null);
  });

  it('deriveChatUiState доверяет currentTask, а не устаревшему lastTasks', () => {
    const ui = deriveChatUiState({
      selectedTaskId: 't1',
      currentTask: { id: 't1', status: 'SUCCEEDED', pendingPrompts: [] },
      // В lastTasks сессия ещё RUNNING (список обновляется позже).
      allTasks: [{ id: 't1', status: 'RUNNING' }],
    });

    assert.equal(ui.selectedWorking, false);
    assert.equal(ui.canStop, false);
    assert.equal(ui.showTyping, false);
    assert.equal(ui.canEditHistory, true);
  });

  it('во время VERIFYING: STOP включён, но редактировать историю нельзя и точек нет', () => {
    const ui = deriveChatUiState({
      selectedTaskId: 't1',
      currentTask: { id: 't1', status: 'VERIFYING' },
      allTasks: [],
    });

    assert.equal(ui.selectedWorking, true);
    assert.equal(ui.canStop, true);
    assert.equal(ui.showTyping, false);
    assert.equal(ui.canEditHistory, false);
  });
});
