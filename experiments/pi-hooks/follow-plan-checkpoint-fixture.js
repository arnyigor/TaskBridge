// FP-00 fixture: ровно то, на что опирается Follow Plan в Pi 1.4.0 —
// model-callable `taskbridge_plan_checkpoint` и наблюдаемость границ хода.
//
// Это не production-расширение: оно ничего не решает и никуда не пишет, кроме
// собственного ndjson-журнала (FP_LOG), чтобы стенд мог сверить «что видел хук»
// с «что видел RPC-клиент». Решение `CONTINUE`/`COMPLETE` принимает TaskBridge.
//
// Переменные окружения:
//   FP_LOG              путь ndjson-журнала хуков (пусто — молча)
//   FP_ALLOW_CONTINUE   "1" — однократно вернуть continue:true из
//                       agent_before_settle (проверка «один контрольный ход»)

import fs from 'node:fs';

const logPath = process.env.FP_LOG || '';
const allowContinue = process.env.FP_ALLOW_CONTINUE === '1';

const append = record => {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...record })}\n`);
  } catch { /* журнал стенда не должен ломать ход */ }
};

export const DECISIONS = ['CONTINUE', 'REPLAN', 'COMPLETE', 'BLOCKED', 'NEED_INPUT', 'NO_PROGRESS'];

export default function followPlanFixture(pi) {
  let checkpoints = 0;
  let continued = false;

  pi.registerTool({
    name: 'taskbridge_plan_checkpoint',
    label: 'TaskBridge plan checkpoint',
    description: 'Report the Follow Plan checkpoint for the finished turn: which steps are done, '
      + 'with what evidence, what findings were discovered and what the controller should do next. '
      + 'Call it at the end of every plan cycle instead of writing "done" in the answer.',
    promptSnippet: 'taskbridge_plan_checkpoint: machine-readable result of the finished plan cycle',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'plan id from the plan file front matter' },
        revision: { type: 'integer', description: 'plan revision the turn was started with' },
        cycleId: { type: 'string' },
        decision: { type: 'string', enum: DECISIONS },
        completedStepIds: { type: 'array', items: { type: 'string' } },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: { stepId: { type: 'string' }, kind: { type: 'string' }, ref: { type: 'string' }, summary: { type: 'string' } },
            required: ['stepId', 'kind', 'summary']
          }
        },
        findings: { type: 'array', items: { type: 'object' } },
        nextStepId: { type: 'string' }
      },
      required: ['planId', 'revision', 'cycleId', 'decision'],
      additionalProperties: false
    },
    async execute(_toolCallId, params) {
      checkpoints += 1;
      append({ hook: 'tool_execute', checkpoints, planId: params?.planId, revision: params?.revision, decision: params?.decision, nextStepId: params?.nextStepId });
      return {
        content: [{ type: 'text', text: `Checkpoint accepted: ${params?.decision || 'unknown'} (revision ${params?.revision}).` }],
        details: { accepted: true, decision: params?.decision ?? null, checkpoints }
      };
    }
  });

  pi.on('turn_end', event => {
    append({
      hook: 'turn_end',
      turnIndex: event.turnIndex,
      outcome: event.outcome,
      toolResults: (event.toolResults || []).length,
      continueProposed: event.continue,
      draftEntries: (event.entries || []).map(entry => entry.type),
      checkpoints
    });
  });

  pi.on('agent_before_settle', event => {
    append({
      hook: 'agent_before_settle',
      outcome: event.outcome,
      continueProposed: event.continue,
      draftEntries: (event.entries || []).map(entry => entry.type),
      canContinue: event.context?.canContinue ?? null,
      llmMessages: (event.context?.llmMessages || []).length,
      checkpoints
    });
    // Однократно: одна контрольная инструкция вместо бесконечной цепочки.
    if (allowContinue && !continued) {
      continued = true;
      return {
        continue: true,
        entries: [{
          type: 'custom_message',
          customType: 'fp_audit',
          content: 'Ты не передал taskbridge_plan_checkpoint. Передай его сейчас: '
            + 'planId=p-fp00, revision=1, cycleId=c-1, decision=NO_PROGRESS.',
          display: false
        }]
      };
    }
    return undefined;
  });

  pi.on('agent_settled', event => {
    append({ hook: 'agent_settled', aborted: event.aborted === true, checkpoints });
  });
}
