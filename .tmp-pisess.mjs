import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const db = new DatabaseSync('data/taskbridge.db', { readOnly: true });
for (const id of ['d57a7e9aa9a0', 'c33088bf52d2']) {
  const t = JSON.parse(db.prepare('SELECT data FROM tasks WHERE id = ?').get(id).data);
  console.log(id, '| piSessionFile:', t.piSessionFile, '| exists:', t.piSessionFile ? fs.existsSync(t.piSessionFile) : false);
}
db.close();
