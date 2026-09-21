/**
 * Сводка одного прогона из журнала надзирателя.
 *
 *   node bench/analyze-run.mjs <путь-к-логу.ndjson> [ещё логи...]
 *
 * Весь анализ — ЗДЕСЬ, а не в supervisor: тот пишет только факты. Поэтому определение любой
 * метрики можно поменять и пересчитать СТАРЫЕ логи, не гоняя модель заново.
 *
 * Три независимые гипотезы отвечаются одним прогоном:
 *   разведка     — есть ли эпизоды, из которых модель не выходит сама;
 *   write burst  — каково распределение мутаций между проверками (хвост, не среднее);
 *   final verify — пыталась ли модель закончить с непроверенным деревом.
 */

import fs from 'node:fs';

const read = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const num = xs => xs.slice().sort((a, b) => a - b);
const pct = (xs, p) => (xs.length ? num(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null);

function summarize(file) {
  const ev = read(file);
  if (!ev.length) return console.log(`${file}: пусто`);
  const of = name => ev.filter(e => e.event === name);

  const first = of('first_project_artifact')[0];
  const opened = of('shadow_episode_opened');
  const closed = of('shadow_episode_closed');
  const bursts = of('write_burst_closed');
  const finishes = of('turn_finish');
  const last = finishes.at(-1);

  console.log(`\n═══ ${file}`);
  console.log(`  событий ${ev.length}, схема v${ev[0].eventSchemaVersion ?? '?'}, шагов ${ev.at(-1).steps ?? '?'}`);

  // ── Прогресс ──────────────────────────────────────────────────────────────
  const turns = of('turn_end');
  const gaps = turns.map(e => e.stepsSinceProgress).filter(v => typeof v === 'number');
  const progressEvents = of('progress');
  console.log('\n  Прогресс');
  // Главная величина — не «когда появился файл», а сколько модель проводит БЕЗ сдвига.
  // Замер это подтвердил: в одном прогоне первым артефактом оказалась распаковка шаблона
  // на 6-м шаге, в двух других — свой файл на 18–22-м. Метрика нестабильна и оставлена
  // диагностической, а решение принимается по застою.
  console.log(`    МАКСИМАЛЬНЫЙ застой: ${gaps.length ? Math.max(...gaps) : 0} шагов`
    + `${gaps.length ? ` (медиана ${pct(gaps, 0.5)}, p90 ${pct(gaps, 0.9)})` : ''}`);
  const kinds = progressEvents.reduce((a, e) => ({ ...a, [e.kind]: (a[e.kind] ?? 0) + 1 }), {});
  console.log(`    сдвигов всего: ${progressEvents.length}`
    + (progressEvents.length ? ` (${Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join(', ')})` : ''));
  console.log(`    диагностически — первый артефакт: ${first ? `шаг ${first.steps} (${first.minutes} мин), ${first.path}` : 'НЕ ПОЯВИЛСЯ'}`);

  // ── Разведка и прочие гейты ───────────────────────────────────────────────
  console.log('\n  Shadow-эпизоды (гейт ничего не блокировал)');
  if (!opened.length) console.log('    ни один гейт не сработал бы ни разу');
  for (const gate of [...new Set(opened.map(e => e.gate))]) {
    const o = opened.filter(e => e.gate === gate);
    const c = closed.filter(e => e.gate === gate);
    const stuck = o.length - c.length;          // открыт без пары = прогон кончился внутри
    const latency = c.map(e => e.stepsOpen);
    const kinds = c.reduce((a, e) => ({ ...a, [e.resolution]: (a[e.resolution] ?? 0) + 1 }), {});
    console.log(`    ${gate.padEnd(13)} эпизодов ${o.length}, сам вышел ${c.length}`
      + `${stuck ? `, ЗАВИС до конца ${stuck}` : ''}`);
    if (latency.length) console.log(`    ${' '.repeat(13)} латентность: ${num(latency).join(', ')} шагов (медиана ${pct(latency, 0.5)})`);
    if (c.length) console.log(`    ${' '.repeat(13)} чем снято: ${Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join(', ')}`);
    const persisted = c.filter(e => e.persisted).length + o.filter(e => !c.some(x => x.episodeId === e.episodeId)).length;
    // Главная величина для решения о гейте: гейт оправдан ХВОСТОМ, а не частотой.
    console.log(`    ${' '.repeat(13)} пережили окно: ${persisted} из ${o.length}`);
  }

  // ── Write bursts ──────────────────────────────────────────────────────────
  console.log('\n  Write bursts (мутации PROJECT между попытками проверки)');
  const real = bursts.filter(b => b.mutations > 0);
  const censored = real.filter(b => b.censored).length;
  // Открытый отрезок на конец прогона: он не закрыт и потому отсутствует среди `real`,
  // а именно он обычно самый длинный — модель перестала проверять совсем. Без этой строки
  // распределение по одним закрытым отрезкам систематически теряет правый хвост.
  const lastTurn = turns.at(-1);
  const openB = lastTurn?.openBurstMutations ?? 0;
  if (openB) {
    console.log(`    ОТКРЫТЫЙ отрезок на конец прогона: ${openB} мутаций (файлов ${lastTurn.openBurstFiles})`
      + ' — проверки так и не было, в распределение закрытых не входит');
  }
  if (!real.length) console.log('    закрытых отрезков нет: ни одной проверки после мутаций');
  else {
    const lens = real.map(b => b.mutations);
    console.log(`    отрезков ${real.length} (пустых ${bursts.length - real.length} — в кривую не идут)`);
    console.log(`    длины: ${num(lens).join(', ')}   медиана ${pct(lens, 0.5)}, макс ${Math.max(...lens)}`);
    if (censored) console.log(`    ВНИМАНИЕ: ${censored} отрезков упёрлись в включённый гейт (censored) — K по ним выводить нельзя`);
    // P(следующая проверка упала | длина отрезка). infra_error исключается: поломка стенда
    // не должна становиться уликой против длинного отрезка.
    const usable = real.filter(b => b.verification.result === 'pass' || b.verification.result === 'fail');
    const by = new Map();
    for (const b of usable) {
      const k = Math.min(b.mutations, 5);
      const cur = by.get(k) ?? { n: 0, fail: 0 };
      cur.n += 1;
      if (b.verification.result === 'fail') cur.fail += 1;
      by.set(k, cur);
    }
    if (usable.length) {
      console.log('    P(проверка упала | длина):');
      for (const k of [...by.keys()].sort((a, b) => a - b)) {
        const { n, fail } = by.get(k);
        console.log(`      ${k === 5 ? '5+' : k}: наблюдений ${n}, упало ${fail}`
          + `${n >= 5 ? ` → ${Math.round((fail / n) * 100)}%` : '   (мало данных, проценты не считаем)'}`);
      }
    }
    const infra = real.length - usable.length;
    if (infra) console.log(`    исключено как поломка стенда: ${infra}`);
  }

  // ── Final verify ──────────────────────────────────────────────────────────
  console.log('\n  Final verify');
  if (!last) console.log('    завершений хода не было');
  else {
    const dirty = finishes.filter(f => f.wouldBlock).length;
    console.log(`    завершений хода ${finishes.length}, из них с непроверенным деревом ${dirty}`);
    // «Финиш» = ПОСЛЕДНЕЕ завершение хода: события конца задачи в API Pi не видно,
    // поэтому решение принимается здесь, а не зашито в supervisor.
    console.log(`    ПОСЛЕДНЕЕ завершение: ${last.wouldBlock ? 'ГРЯЗНОЕ — гейт сработал бы' : 'чистое'}`);
    if (last.wouldBlock) {
      console.log(`      мутаций с последней успешной проверки: ${last.mutationsSinceSuccessfulVerify}`
        + ` (файлов ${last.uniqueFilesSinceSuccessfulVerify})`);
      console.log(`      последняя проверка: ${last.lastVerificationResult}`);
    }
  }
}

const files = process.argv.slice(2);
if (!files.length) {
  console.log('укажи журнал(ы): node bench/analyze-run.mjs runs/<прогон>/supervisor.ndjson');
  process.exit(1);
}
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`нет файла: ${f}`); continue; }
  summarize(f);
}
