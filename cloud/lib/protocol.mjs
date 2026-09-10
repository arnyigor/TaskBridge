export const NAME = /^[A-Za-z0-9_-]{1,120}$/;
export const COMMANDS = new Set(['START_TASK', 'ABORT_TASK', 'FOLLOW_UP', 'COMPACT', 'GET_STATE', 'SYNC_STATE']);

export function validName(value, label = 'name') {
  if (!NAME.test(value || '')) throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  return value;
}

export const commandTopic = machineId => `tb_cmd_${validName(machineId, 'machineId')}`;
export const taskTopic = taskId => `tb_task_${validName(taskId, 'taskId')}`;
export const indexTopic = () => `tb_index_${validName(process.env.TASKBRIDGE_USER_ID || 'owner', 'TASKBRIDGE_USER_ID')}`;
export const consumerName = viewerId => `viewer_${validName(viewerId, 'viewerId')}`;
