import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/taskbridge.db', { readOnly: true });
const rows = db.prepare("SELECT task_id, seq, payload FROM events WHERE payload LIKE '%MODEL_SWITCH%' ORDER BY seq DESC LIMIT 400").all();
const seen = new Map();
for (const row of rows) {
  const e = JSON.parse(row.payload);
  if (e.type !== 'MODEL_SWITCH') continue;
  const t = db.prepare('SELECT data FROM tasks WHERE id = ?').get(row.task_id);
  const task = t ? JSON.parse(t.data) : null;
  seen.set(row.task_id, { at: e.at || task?.updatedAt, msg: e.message, data: e.data, task: (task?.title || task?.prompt || '').slice(0, 50), id: row.task_id, seq: e.seq });
}
[...seen.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12).forEach(x => console.log(`${x.at} | ${x.id} | seq=${x.seq} | ${x.msg} | ${JSON.stringify(x.data)} | task: ${x.task}`));
console.log('\ntasks with switch:', seen.size);
db.close();
