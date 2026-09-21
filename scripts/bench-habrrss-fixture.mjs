import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Собирает фикстуру для эталонного кодинг-бенчмарка HabrRSS OOM
// (docs/bench-coding-habrrss-oom.md).
//
// Зачем она нужна. Баг до фикса — `changedRemoteEntities` дёргает
// `feedDao.getAllCachedOnce()` на каждой странице, то есть материализует всю
// таблицу `feed_items` вместе с колонкой `cachedArticleJson` (полное тело статьи).
// Чтобы это упало на 256-МБ heap устройства, в таблице должно лежать много строк
// С ТЕЛАМИ. Свежее приложение такого состояния не имеет: обычная загрузка страниц
// тела не кэширует (его пишет только полнотекстовое чтение статьи), поэтому
// воспроизведение требует подготовленной базы — «архив, накопленный за месяцы».
//
// Схему, `room_master_table.identity_hash` и настоящий образец тела берём из
// живой базы приложения (её снимают с телефона через `run-as`), поэтому фикстура
// не выдумана: меняется только количество строк.
//
// Запуск:
//   node scripts/bench-habrrss-fixture.mjs \
//     --source <снятая-с-телефона-база> --out <фикстура.db> [--rows 12000] [--blocks 12]

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  const next = process.argv[i + 1];
  argv.set(key, next === undefined || next.startsWith('--') ? true : next);
}

const source = argv.get('source');
const out = argv.get('out');
const feed = String(argv.get('feed') || 'habr-hub:programming:alltime');
const rows = Number(argv.get('rows') || 12000);
const blocks = Number(argv.get('blocks') || 12);
if (!source || !out) {
  console.error('usage: node scripts/bench-habrrss-fixture.mjs --source <db> --out <db> [--rows N] [--blocks N] [--feed id]');
  process.exit(2);
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.copyFileSync(source, out);
// Копия делается без WAL: иначе рядом останется чужой журнал и SQLite начнёт
// восстанавливать состояние, которого в фикстуре нет.
for (const suffix of ['-wal', '-shm']) fs.rmSync(`${out}${suffix}`, { force: true });

const db = new DatabaseSync(out);
const template = db.prepare(
  "select * from feed_items where cachedArticleJson is not null and cachedArticleJson <> '' order by length(cachedArticleJson) desc limit 1"
).get();
if (!template) throw new Error('в исходной базе нет ни одной строки с телом статьи — сначала открой статью в приложении и сними базу заново');

const body = JSON.parse(template.cachedArticleJson);
body.blocks = Array.isArray(body.blocks) ? body.blocks.slice(0, blocks) : body.blocks;
const bodyTemplate = JSON.stringify(body);
const tagsJson = template.tagsJson;
const hubsJson = template.hubsJson;

const insert = db.prepare(`
  insert or replace into feed_items
    (id, feedId, title, summary, descriptionHtml, url, imageUrl, authorName, authorProfileUrl,
     publishedAt, publishedAtEpoch, tagsJson, hubsJson, rating, commentsCount,
     cachedArticleJson, fetchedAt, sourceOrder)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const now = Date.now();
const started = Date.now();
db.exec('begin');
db.prepare('delete from feed_items where feedId = ?').run(feed);
for (let i = 0; i < rows; i++) {
  const id = `habr-fx-${String(i).padStart(6, '0')}`;
  const url = `https://habr.com/ru/articles/${900000 + i}/`;
  const title = `Фикстура архива №${i}: материал programming-хаба`;
  // Тело правим под строку — иначе в кэше останется чужой id/url и приложение
  // решит, что статья не та.
  const cached = JSON.stringify({ ...JSON.parse(bodyTemplate), id, url, title });
  insert.run(
    id, feed, title,
    template.summary, template.descriptionHtml, url, template.imageUrl,
    template.authorName, template.authorProfileUrl,
    new Date(now - i * 3600_000).toISOString(), now - i * 3600_000,
    tagsJson, hubsJson, template.rating, template.commentsCount,
    cached, now - i * 60_000, i
  );
}
// Курсор оставляем как есть: приложение должно считать, что архив уже частично
// загружен и «Загрузить все страницы» можно продолжить.
db.exec('commit');

const total = db.prepare('select count(*) c from feed_items').get().c;
const withBody = db.prepare("select count(*) c from feed_items where cachedArticleJson is not null and cachedArticleJson <> ''").get().c;
const bodyBytes = db.prepare("select sum(length(cachedArticleJson)) b from feed_items where feedId = ?").get(feed).b;
db.close();

const size = fs.statSync(out).size;
console.log(`фикстура: ${path.resolve(out)}`);
console.log(`  строк всего      : ${total} (с телом: ${withBody})`);
console.log(`  фид              : ${feed}`);
console.log(`  тел в фиде       : ${Math.round((bodyBytes || 0) / 1048576)} МиБ (по ${Math.round(bodyTemplate.length / 1024)} КиБ × ${rows})`);
console.log(`  размер базы      : ${(size / 1048576).toFixed(1)} МиБ`);
console.log(`  собрано за       : ${((Date.now() - started) / 1000).toFixed(1)} c`);
