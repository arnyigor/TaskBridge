import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/taskbridge.db', { readOnly: true });
const id = process.argv[2] || 'd57a7e9aa9a0';
const t = JSON.parse(db.prepare('SELECT data FROM tasks WHERE id = ?').get(id).data);
console.log('task:', id, '| status:', t.status);
console.log('model:', JSON.stringify(t.model), '| requestedModel:', JSON.stringify(t.requestedModel));
console.log('compaction:', JSON.stringify(t.compaction), '| autoCompactionEnabled:', t.autoCompactionEnabled);
console.log('lastUsage:', JSON.stringify(t.lastUsage));
console.log('updatedAt:', t.updatedAt);
// last 400 events: show compaction, model, error-bearing frames
const rows = db.prepare('SELECT seq, payload FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT 600').all(id);
const hits = [];
for (const row of rows) {
  const e = JSON.parse(row.payload);
  const pi = e.data?.pi;
  const text = JSON.stringify(e);
  if (/compaction|context|model_switch|MODEL_SWITCH|too long|contextWindow/i.test(text)) hits.push({ seq: e.seq, type: e.type, pi: pi?.type, msg: String(e.message || '').slice(0, 160), frame: pi ? JSON.stringify(pi).slice(0, 300) : '' });
}
hits.reverse().slice(-25).forEach(h => console.log(`${h.seq} | ${h.type}${h.pi ? ' / ' + h.pi : ''} | ${h.msg}`));
console.log('\nmatched events:', hits.length);
db.close();
