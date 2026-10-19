import fs from 'node:fs/promises';
import { tailText, TEXT_TAIL, THINKING_TAIL } from '../text-tail.mjs';
import { metadata } from '../files.mjs';
import { sessionContainsUserMessage } from '../session-history.mjs';
import { shrinkSessionFile, describeShrink, DEFAULT_ARTIFACT_LABEL } from '../session-shrink.mjs';
const now = () => new Date().toISOString();

// Preflight of one session file, run before Pi is spawned on it.
//
// Pi re-sends the whole transcript with every request, and a provider refuses a
// request body over ~50 MB (2026-10-19: a 48.6 MB Blender session of 39
// screenshots answered 413 forever and could not start). Pi's own guard counts
// TOKENS, so it never fired at 28 % of the window. This is the recovery path for
// a session that is already over the byte budget: the originals of the old
// images move to the artifact store, the transcript keeps its history plus a
// reference, and the repair is verified before it is kept.
//
// The caller owns the "nobody else is writing this file" check — rewriting a
// session while Pi appends to it is the one way to corrupt it.
export async function preflightSession(file, {
  limitBytes,
  keepImages,
  artifactDir = null,
  artifactLabel = DEFAULT_ARTIFACT_LABEL
} = {}) {
  const result = await shrinkSessionFile(file, { limitBytes, keepImages, artifactDir, artifactLabel });
  switch (result.reason) {
    case 'shrunk':
      return {
        status: 'repaired',
        ...result,
        message: `Контекст сессии восстановлен: ${describeShrink(result)}. `
          + `Оригиналы сохранены (${artifactLabel}), история сообщений, tool calls и ветвление не изменились.`
      };
    case 'no-images':
      return {
        status: 'too-large',
        ...result,
        message: `История сессии (${(result.beforeBytes / 1048576).toFixed(1)} МБ) больше, чем провайдер принимает за один запрос (~50 МБ), `
          + 'а изображений в ней уже нет: уменьшать нечего, не тронув текст. Сожмите контекст или клонируйте сессию.'
      };
    case 'invalid':
      return {
        status: 'invalid',
        ...result,
        message: `Файл сессии повреждён (строка ${result.line} не разбирается как JSON): сессия оставлена как есть, ничего не переписано.`
      };
    case 'integrity':
      return {
        status: 'invalid',
        ...result,
        message: 'Проверка целостности после восстановления не прошла: id сообщений, parentId или типы записей изменились. Файл оставлен как был.'
      };
    case 'no-gain':
      return { status: 'ok', ...result, message: 'Восстановление не дало выигрыша по размеру: файл оставлен как был.' };
    default:
      return { status: 'ok', ...result, message: '' };
  }
}

// Startup reconciliation of stored sessions; runtime ownership stays with the caller.
export async function restoreSessions(previous, { store, enqueue, restorePendingFiles, onRestored, continuePrompt }) {
    let trimmed = 0;
    for (const task of previous) {
      // One-time shrink of records written before text was bounded.
      const assistantText = tailText(task.assistantText, TEXT_TAIL);
      const thinkingText = tailText(task.thinkingText, THINKING_TAIL);
      if (assistantText !== task.assistantText || thinkingText !== task.thinkingText) {
        task.assistantText = assistantText;
        task.thinkingText = thinkingText;
        await store.save(task).catch(() => {});
        trimmed++;
      }
      // A queued task is restored: nothing was sent to Pi yet, so the prompt is
      // still exactly what the operator asked for. A task that was already
      // running (or preparing) cannot be resumed — its Pi process is gone.
      const queuedNotStarted = task.status === 'QUEUED' && !task.workspacePath;
      const queuedPrompt = task.status === 'QUEUED' && Boolean(task.pendingPrompts?.length);
      if (queuedNotStarted || queuedPrompt) {
        task.queueReason = 'RESTORED';
        task.current = 'В очереди после перезапуска TaskBridge';
        task.updatedAt = now();
        await store.save(task);
        enqueue(task.id);
        await restorePendingFiles(task.id);
      } else if (['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'WAITING_USER', 'VERIFYING', 'CANCELLING'].includes(task.status)) {
        const intact = task.piSessionFile ? await fs.access(task.piSessionFile).then(() => true, () => false) : false;
        // The in-flight marker: a prompt was sent to Pi and its turn did not
        // complete before the restart. With the session file intact the restart
        // finishes the command instead of reporting a failure. Pi records the
        // user message as the prompt is accepted, so the session file tells the
        // two cases apart: the text is already there → a short continuation
        // nudge (re-sending it would duplicate the user turn); nothing there →
        // the prompt is re-sent as-is. The delivery announces nothing either
        // way (announce: false): the text is already in the chat history.
        if (intact && task.inFlightPrompt?.text) {
          const recorded = await sessionContainsUserMessage(task.piSessionFile, task.inFlightPrompt.text);
          const resume = {
            id: `resume-${now()}`,
            text: recorded ? continuePrompt : task.inFlightPrompt.text,
            mode: 'auto',
            files: (task.files || []).map(metadata),
            announce: false,
          };
          // The resume goes to the queue front; prompts queued before the
          // restart follow it. The marker is spent: the restart delivers it
          // exactly once, so no restart produces a duplicate.
          task.pendingPrompts = [resume, ...(task.pendingPrompts || [])];
          task.inFlightPrompt = null;
          // The task was RUNNING when the restart hit it: the pump delivers the
          // resume through #deliverPending, which claims the slot itself.
          task.status = 'QUEUED';
          task.queueReason = 'RESTORED_RESUME';
          task.current = 'TaskBridge перезапустился во время ответа — запрос будет отправлен повторно';
          task.updatedAt = now();
          await store.save(task);
          enqueue(task.id);
          await restorePendingFiles(task.id);
        } else {
          // R3.6: with the Pi session file intact the conversation is only
          // interrupted — the next message resumes it (RESTORABLE). Without it
          // there is nothing to resume from: a real failure.
          task.status = 'FAILED';
          task.errorCode = intact ? 'FAILED_RECOVERY' : 'SESSION_LOST';
          task.error = intact
            ? 'TaskBridge перезапустился во время ответа. Следующее сообщение продолжит сессию.'
            : 'TaskBridge перезапустился во время ответа, а файл сессии Pi не сохранился.';
          if (!intact) task._sessionLost = true;
          task.updatedAt = now();
          await store.save(task);
        }
      }
      // Pi is gone after a restart: a dialog it was waiting on is gone with it.
      if (task.pendingUiRequest) { task.pendingUiRequest = null; await store.save(task).catch(() => {}); }
      onRestored(task);
      // Шаг C-B: после рестарта даём снимку версию последнего события на диске,
      // иначе первый GET вернёт seq=0 и клиент сочтёт его древним.
      task._snapshotSeq = await store.maxSeq(task.id).catch(() => 0);
    }
    return trimmed;
}
