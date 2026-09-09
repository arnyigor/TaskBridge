// TaskBridge approval gate for Pi (loaded with `pi --extension <this file>`).
//
// Pi calls this before every tool execution. The extension asks the local
// TaskBridge process — which owns the policy — whether the call may proceed,
// and blocks until an operator answers locally or from the remote PWA. No cloud
// request is held open: TaskBridge keeps the approval in its own state and the
// answer arrives as a normal command later (§53–§56).
//
// This file is intentionally dependency-free: it runs inside the Pi process and
// must not import anything from the TaskBridge source tree.
//
// Environment (set by TaskBridge when it spawns Pi):
//   TASKBRIDGE_APPROVAL_URL    http://127.0.0.1:<port>
//   TASKBRIDGE_TASK_ID         local task id
//   TASKBRIDGE_APPROVAL_TOKEN  per-task secret
//   TASKBRIDGE_APPROVAL_FAILSAFE  "block" (default) | "allow"
//   TASKBRIDGE_APPROVAL_WAIT_MS   overall wait before giving up (default 24h)
//   TASKBRIDGE_APPROVAL_POLL_MS   poll interval (default 1000)

export default function (pi) {
  const base = process.env.TASKBRIDGE_APPROVAL_URL;
  const taskId = process.env.TASKBRIDGE_TASK_ID;
  const token = process.env.TASKBRIDGE_APPROVAL_TOKEN;
  if (!base || !taskId || !token) return;

  const failsafe = (process.env.TASKBRIDGE_APPROVAL_FAILSAFE || 'block').toLowerCase();
  const waitMs = Number(process.env.TASKBRIDGE_APPROVAL_WAIT_MS || 24 * 60 * 60 * 1000);
  const pollMs = Math.max(200, Number(process.env.TASKBRIDGE_APPROVAL_POLL_MS || 1000));
  const headers = { 'content-type': 'application/json', 'x-taskbridge-approval': token };
  const endpoint = `${base.replace(/\/+$/, '')}/api/tasks/${encodeURIComponent(taskId)}/approval`;

  const failClosed = (reason) => (failsafe === 'allow' ? undefined : { block: true, reason });

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });

  pi.on('tool_call', async (event, ctx) => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.input ?? {} }),
        signal: ctx?.signal
      });
      if (!response.ok) return failClosed(`TaskBridge approval endpoint returned HTTP ${response.status}`);
      const start = await response.json();
      if (start.status === 'ALLOW_ONCE') return undefined;
      if (start.status === 'DENIED') return { block: true, reason: start.reason || 'Denied by the operator' };
      if (!start.approvalId) return failClosed('TaskBridge did not return an approval id');

      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await sleep(pollMs, ctx?.signal);
        const poll = await fetch(`${endpoint}/${encodeURIComponent(start.approvalId)}`, { headers, signal: ctx?.signal });
        if (!poll.ok) continue;
        const state = await poll.json();
        if (state.status === 'APPROVED') return undefined;
        if (state.status === 'DENIED') return { block: true, reason: state.reason || 'Denied by the operator' };
      }
      return { block: true, reason: 'Approval timed out' };
    } catch (error) {
      // A network failure must not silently let a dangerous tool run (§2925:
      // tool_call errors are fail-safe).
      return failClosed(`Approval unavailable: ${error?.message || error}`);
    }
  });
}
