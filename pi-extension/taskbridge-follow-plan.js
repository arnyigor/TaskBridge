// Follow Plan: the checkpoint tool the model reports through (FP-02).
//
// Loaded by TaskBridge as `pi -e <this file>`, like the other extensions here.
// It registers one tool and records what the model reported; it does NOT decide
// anything. Whether a COMPLETE ends the plan, whether a step counts as done and
// what happens next is decided by TaskBridge (src/application/plan-checkpoint.mjs)
// after the turn settled. Keeping the decision out of the model's process is why
// "the model said COMPLETE" cannot finish a plan on its own.
//
// TaskBridge also reads the call from the ordinary `tool_execution_start` frame;
// the log below is a second, appended record so a checkpoint is not lost if the
// controller was not listening for that frame.
//
// Environment (set by TaskBridge when it spawns Pi):
//   TASKBRIDGE_PLAN_CHECKPOINT_LOG  ndjson file; unset means "no log"

import fs from 'node:fs';

export const CHECKPOINT_DECISIONS = ['CONTINUE', 'REPLAN', 'COMPLETE', 'BLOCKED', 'NEED_INPUT', 'NO_PROGRESS'];
export const EVIDENCE_KINDS = ['test', 'command', 'run', 'file', 'manual'];

// Pi validates the call against this schema before `execute()` runs, so a
// malformed decision or a missing planId never reaches the controller as data.
export const CHECKPOINT_PARAMETERS = {
  type: 'object',
  properties: {
    planId: { type: 'string', description: 'plan_id from the plan file front matter' },
    revision: { type: 'integer', description: 'revision the turn was started with' },
    cycleId: { type: 'string', description: 'cycle id from the turn instruction' },
    decision: { type: 'string', enum: CHECKPOINT_DECISIONS, description: 'CONTINUE, REPLAN, COMPLETE, BLOCKED, NEED_INPUT or NO_PROGRESS' },
    completedStepIds: { type: 'array', items: { type: 'string' }, description: 'steps finished in THIS turn' },
    evidence: {
      type: 'array',
      description: 'how each finished step was confirmed: a test/command/run/file reference, or manual',
      items: {
        type: 'object',
        properties: {
          stepId: { type: 'string' },
          kind: { type: 'string', enum: EVIDENCE_KINDS },
          // `ref` is what makes evidence checkable. For a test/command that ran in
          // THIS turn it is the toolCallId of that call: TaskBridge matches it
          // against the tool frames it saw and only then certifies the step.
          ref: { type: 'string', description: 'toolCallId of the tool call that produced this result (or a run id / file path). Required for every kind except manual.' },
          summary: { type: 'string', description: 'what the result says, e.g. 29/29 pass' }
        },
        required: ['stepId', 'kind', 'summary'],
        additionalProperties: false
      }
    },
    findings: {
      type: 'array',
      description: 'problems discovered while doing the step; blocking P0/P1 stops completion until fixed',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          blocking: { type: 'boolean' },
          // A defect that is really «this existing step is not done yet» must name
          // that step instead of asking for a duplicate step in the plan.
          relatedStepIds: { type: 'array', items: { type: 'string' }, description: 'existing steps this defect belongs to' },
          summary: { type: 'string' }
        },
        required: ['id', 'priority', 'summary'],
        additionalProperties: false
      }
    },
    proposedChanges: {
      type: 'array',
      description: 'minimal edits to the SAME plan file, applied by TaskBridge after validation. '
        + 'Only add_step and insert_after are accepted; any other op is refused.',
      // The fields are spelled out because a proposal without criteria and
      // verification is refused by src/application/plan-revision.mjs. Live run
      // 2026-10-29: the model sent {op, priority, title, body}, the step never
      // appeared in the plan, and the operator was never told why.
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add_step', 'insert_after'], description: 'add_step puts the step before `before`, insert_after puts it after `after`' },
          stepId: { type: 'string', description: 'new step id, e.g. S-015A' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'P0/P1 add work; P0 waits for operator approval' },
          title: { type: 'string', description: 'one line: what the step does' },
          criteria: { type: 'string', description: 'what proves the step is done — required, a body sentence is not accepted instead' },
          verification: { type: 'string', description: 'the check that is run for this step — required' },
          before: { type: 'string', description: 'existing step id the new step must run before; without before/after the step goes to the end of the plan' },
          after: { type: 'string', description: 'existing step id the new step must run after' },
          originFindingId: { type: 'string', description: 'finding id this step verifies' }
        },
        required: ['op', 'stepId', 'priority', 'title', 'criteria', 'verification'],
        additionalProperties: false
      }
    },
    nextStepId: { type: 'string' }
  },
  required: ['planId', 'revision', 'cycleId', 'decision'],
  additionalProperties: false
};

/** What gets recorded: the arguments as Pi validated them, plus a receive time. */
export const normalizeCheckpoint = (params, now = Date.now()) => ({
  planId: String(params?.planId ?? ''),
  revision: Number(params?.revision ?? -1),
  cycleId: String(params?.cycleId ?? ''),
  decision: String(params?.decision ?? ''),
  completedStepIds: Array.isArray(params?.completedStepIds) ? params.completedStepIds.map(String) : [],
  evidence: Array.isArray(params?.evidence) ? params.evidence : [],
  findings: Array.isArray(params?.findings) ? params.findings : [],
  proposedChanges: Array.isArray(params?.proposedChanges) ? params.proposedChanges : [],
  nextStepId: params?.nextStepId ? String(params.nextStepId) : null,
  receivedAt: now
});

export default function followPlanExtension(pi) {
  const logPath = process.env.TASKBRIDGE_PLAN_CHECKPOINT_LOG || '';

  pi.registerTool({
    name: 'taskbridge_plan_checkpoint',
    label: 'TaskBridge plan checkpoint',
    description: 'Report the result of the finished FOLLOW PLAN cycle: which steps are done and how that was '
      + 'confirmed, which problems were found, and what the controller should do next. Call it at the end of '
      + 'every cycle instead of writing "done" in the answer. A step is not done without its verification.',
    promptSnippet: 'taskbridge_plan_checkpoint: machine-readable result of the finished plan cycle (required)',
    promptGuidelines: [
      'Call taskbridge_plan_checkpoint at the end of every FOLLOW PLAN cycle, before the answer.',
      'Never report a step as completed without an evidence entry whose ref can be re-read.'
    ],
    parameters: CHECKPOINT_PARAMETERS,
    async execute(_toolCallId, params) {
      const checkpoint = normalizeCheckpoint(params);
      if (logPath) {
        try {
          fs.appendFileSync(logPath, `${JSON.stringify(checkpoint)}\n`);
        } catch { /* the checkpoint still reaches TaskBridge through tool_execution_start */ }
      }
      return {
        content: [{
          type: 'text',
          text: `Checkpoint received: ${checkpoint.decision}. TaskBridge verifies the plan file and the evidence; `
            + 'finishing the plan is not decided here.'
        }],
        details: { decision: checkpoint.decision, completed: checkpoint.completedStepIds, findings: checkpoint.findings.length }
      };
    }
  });
}
