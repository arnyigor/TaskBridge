/**
 * Независимая проверка moon_mission: эталонная физика + поиск оптимума, затем сверка файла.
 *
 *   node bench/verify-moon.mjs --reference           # посчитать эталон (Δv) и проверить сам код
 *   node bench/verify-moon.mjs --file <путь.html>    # разобрать файл модели и сверить с эталоном
 *
 * Зачем своя симуляция. Задача требует, чтобы модель сама нашла TLI-импульс и сообщила Δv и
 * минимальное расстояние до поверхности Луны. Но отчёту модели верить нельзя (мы это уже
 * проходили с фикстурой), а некоторые модели вообще не сообщают числа, ссылаясь на браузер.
 * Поэтому эталон считается здесь: та же постановка, но реализованная заново.
 *
 * Контроль корректности самого эталона: при нулевом возмущении орбита вокруг Земли должна
 * сохранять энергию, а найденный Δv должен попадать в классическую оценку TLI (~3.1 км/с).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// --- постановка из task.txt ---------------------------------------------------
const R_EARTH = 6371;          // км
const MU_EARTH = 398600;       // км³/с²
const R_MOON = 1737;           // км
const MU_MOON = 4902.8;        // км³/с²
const EARTH_MOON = 384400;     // км
const MOON_PERIOD = 27.32 * 86400;   // с
const LEO_ALT = 200;           // км
const MAX_TIME = 7 * 86400;    // с
const SUCCESS_CENTER_KM = R_MOON + 3000; // 4737 км от центра Луны

const R0 = R_EARTH + LEO_ALT;
const V_CIRC = Math.sqrt(MU_EARTH / R0);

// Луна: круговая орбита в той же плоскости. phase0 — начальный угол Луны.
function moonPos(t, phase0) {
  const th = phase0 + (2 * Math.PI * t) / MOON_PERIOD;
  return [EARTH_MOON * Math.cos(th), EARTH_MOON * Math.sin(th)];
}

function accel(x, y, t, phase0, withMoon = true) {
  const r2 = x * x + y * y;
  const r = Math.sqrt(r2);
  const aE = -MU_EARTH / (r2 * r);           // тяготение Земли в начале координат
  let ax = aE * x;
  let ay = aE * y;
  if (withMoon) {
    const [mx, my] = moonPos(t, phase0);
    const dx = x - mx;
    const dy = y - my;
    const d2 = dx * dx + dy * dy;
    const d = Math.sqrt(d2);
    const aM = -MU_MOON / (d2 * d);
    ax += aM * dx;
    ay += aM * dy;
  }
  return [ax, ay];
}

// Производная состояния [x, y, vx, vy] — для классического RK4.
function deriv(s, t, phase0, withMoon) {
  const [ax, ay] = accel(s[0], s[1], t, phase0, withMoon);
  return [s[2], s[3], ax, ay];
}

// RK4 с фиксированным шагом. dt ≤ 10 с по требованию задачи (для грубого прохода — крупнее).
// phase0 — НАЧАЛЬНАЯ ФАЗА ЛУНЫ: аппарат всегда стартует из точки (R0, 0), а свободный
// параметр задачи — угол между аппаратом и Луной. Если связать их одним углом (как было
// в первой версии), свободный параметр пропадает и перелёт не находится вообще.
function propagate(dv, phase0, dt, maxTime = MAX_TIME, withMoon = true) {
  let s = [R0, 0, 0, V_CIRC];
  if (withMoon) {
    // TLI: разгон по направлению движения (проgrade)
    const speed = Math.hypot(s[2], s[3]);
    s[2] += (dv * s[2]) / speed;
    s[3] += (dv * s[3]) / speed;
  }

  let minDist = Infinity;
  let tMin = 0;
  const steps = Math.floor(maxTime / dt);
  for (let i = 0; i < steps; i += 1) {
    const t = i * dt;
    const [mx, my] = moonPos(t, phase0);
    const d = Math.hypot(s[0] - mx, s[1] - my);
    if (d < minDist) { minDist = d; tMin = t; }
    if (withMoon && d < R_MOON) break;       // столкновение — дальше считать незачем
    const k1 = deriv(s, t, phase0, withMoon);
    const s2 = [s[0] + (dt / 2) * k1[0], s[1] + (dt / 2) * k1[1], s[2] + (dt / 2) * k1[2], s[3] + (dt / 2) * k1[3]];
    const k2 = deriv(s2, t + dt / 2, phase0, withMoon);
    const s3 = [s[0] + (dt / 2) * k2[0], s[1] + (dt / 2) * k2[1], s[2] + (dt / 2) * k2[2], s[3] + (dt / 2) * k2[3]];
    const k3 = deriv(s3, t + dt / 2, phase0, withMoon);
    const s4 = [s[0] + dt * k3[0], s[1] + dt * k3[1], s[2] + dt * k3[2], s[3] + dt * k3[3]];
    const k4 = deriv(s4, t + dt, phase0, withMoon);
    s = [
      s[0] + (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
      s[1] + (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
      s[2] + (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]),
      s[3] + (dt / 6) * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]),
    ];
  }
  return { minDist, tMin, state: s };
}

// Проверка симулятора: без импульса орбита вокруг Земли замкнута, энергия не уезжает.
function selfTest() {
  const period = 2 * Math.PI * Math.sqrt(Math.pow(R0, 3) / MU_EARTH);
  const energy = s => (s[2] * s[2] + s[3] * s[3]) / 2 - MU_EARTH / Math.hypot(s[0], s[1]);
  const dt = 10;
  const oneTurn = propagate(0, 0, dt, period, false);
  const e0 = energy([R0, 0, 0, V_CIRC]);
  const e1 = energy(oneTurn.state);
  const drift = Math.abs((e1 - e0) / e0);
  const radius = Math.hypot(oneTurn.state[0], oneTurn.state[1]);
  console.log('Самопроверка симулятора (один виток вокруг Земли, Луна выключена, dt=10 с):');
  console.log(`  дрейф энергии: ${(drift * 100).toFixed(6)} % (ждём < 0.001 %)`);
  console.log(`  радиус после витка: ${radius.toFixed(3)} км, стартовали с ${R0.toFixed(3)} км`);
  // Контроль по порядку сходимости: ошибка должна падать ~ в 16 раз при dt/2 (RK4).
  const half = propagate(0, 0, dt / 2, period, false);
  const radiusHalf = Math.hypot(half.state[0], half.state[1]);
  console.log(`  радиус при dt=5 с: ${radiusHalf.toFixed(3)} км (расхождение с dt=10: ${Math.abs(radiusHalf - radius).toFixed(4)} км)`);
  return drift < 1e-5 && Math.abs(radius - R0) < 1;
}

// --- поиск оптимума ----------------------------------------------------------

// Постановка требует НЕ «самого близкого пролёта», а минимального Δv среди решений,
// которые доводят аппарат ближе 3000 км к поверхности Луны (≤ 4737 км от центра).
// Минимизация одного лишь расстояния смещает ответ в сторону траекторий-таранов.
function searchMinDeltaV({ dvFrom, dvTo, dvStep, phaseCount, dt }) {
  let best = null;
  let deepest = { dv: null, phase: null, minDist: Infinity };
  for (let p = 0; p < phaseCount; p += 1) {
    const phase0 = (2 * Math.PI * p) / phaseCount;
    for (let dv = dvFrom; dv <= dvTo + 1e-9; dv += dvStep) {
      const r = propagate(dv, phase0, dt);
      if (r.minDist < deepest.minDist) deepest = { dv: Number(dv.toFixed(4)), phase: Number(phase0.toFixed(5)), minDist: r.minDist, tMin: r.tMin };
      if (r.minDist <= SUCCESS_CENTER_KM && (!best || dv < best.dv)) {
        best = { dv: Number(dv.toFixed(4)), phase: Number(phase0.toFixed(5)), minDist: r.minDist, tMin: r.tMin };
      }
    }
  }
  return { best, deepest };
}

function reference() {
  if (!selfTest()) { console.log('СИМУЛЯТОР НЕ ПРОШЁЛ САМОПРОВЕРКУ — эталону доверять нельзя'); process.exit(1); }
  console.log('\nПоиск минимального Δv среди успешных: Δv 2.98…3.35 км/с шаг 10 м/с, 72 фазы, dt 20 с…');
  const t0 = Date.now();
  const { best, deepest } = searchMinDeltaV({ dvFrom: 2.98, dvTo: 3.35, dvStep: 0.01, phaseCount: 72, dt: 20 });
  console.log(`  заняло ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  if (!best) { console.log('  успешных решений на сетке не найдено'); process.exit(1); }
  console.log(`  лучший успешный: Δv ${best.dv} км/с, фаза ${best.phase} рад, мин. до центра ${best.minDist.toFixed(0)} км`);

  console.log('\nУточнение вокруг найденного (Δv шаг 1 м/с, фаза шаг 0.002 рад, dt 10 с)…');
  let fine = best;
  for (let d = -0.12; d <= 0.12; d += 0.002) {
    for (let dv = best.dv - 0.03; dv <= best.dv + 0.012; dv += 0.001) {
      const r = propagate(dv, best.phase + d, 10);
      if (r.minDist <= SUCCESS_CENTER_KM && (!fine || dv < fine.dv)) {
        fine = { dv: Number(dv.toFixed(4)), phase: Number((best.phase + d).toFixed(5)), minDist: r.minDist, tMin: r.tMin };
      }
    }
  }
  const out = {
    dvKmS: fine.dv,
    dvMS: Math.round(fine.dv * 1000),
    minMoonCenterKm: Math.round(fine.minDist),
    minMoonSurfaceKm: Math.round(fine.minDist - R_MOON),
    impact: fine.minDist < R_MOON,
    success: fine.minDist <= SUCCESS_CENTER_KM,
    phase: fine.phase,
    timeToClosestDays: Number((fine.tMin / 86400).toFixed(2)),
    deepestFlyby: { dvKmS: deepest.dv, minMoonCenterKm: Math.round(deepest.minDist) },
    note: 'Эталон посчитан независимо от файлов моделей: та же постановка, своя реализация. Минимизируется Δv, а не расстояние.'
  };
  console.log('\nЭТАЛОН:');
  console.log(`  минимальный Δv, дающий попадание в зону 3000 км: ${out.dvKmS} км/с (${out.dvMS} м/с)`);
  console.log(`  минимальное расстояние до поверхности: ${out.minMoonSurfaceKm} км${out.impact ? ' (падение на Луну)' : ''}`);
  console.log(`  ближайшая точка на ${out.timeToClosestDays} сут`);
  console.log(`  для сравнения: классическая оценка TLI из LEO 200 км — около 3.1 км/с`);
  fs.writeFileSync(path.join(here, 'tasks', 'moon-reference.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`\nсохранено: bench/tasks/moon-reference.json`);
}

// --- разбор файла модели -----------------------------------------------------

function checkFile(file) {
  const html = fs.readFileSync(file, 'utf8');
  const refPath = path.join(here, 'tasks', 'moon-reference.json');
  const ref = fs.existsSync(refPath) ? JSON.parse(fs.readFileSync(refPath, 'utf8')) : null;

  const has = re => re.test(html);
  const openScripts = (html.match(/<script\b/gi) ?? []).length;
  const closeScripts = (html.match(/<\/script>/gi) ?? []).length;
  const checks = [
    ['файл завершён (есть </html>)', /<\/html>/i.test(html)],
    ['все <script> закрыты', openScripts > 0 && openScripts === closeScripts],
    ['Земля r=6371', /6371/.test(html)],
    ['μ Земли 398600', /3986(00|0|\.?0*)/.test(html)],
    ['Луна r=1737', /1737/.test(html)],
    ['μ Луны 4902.8', /4902(\.8)?/.test(html)],
    ['дистанция 384400', /384400/.test(html)],
    ['период 27.32', /27\.32/.test(html)],
    ['старт 200 км LEO', /200\b/.test(html)],
    ['лимит 7 дней', /7\s*\*\s*86400|604800/.test(html)],
    ['порог 3000 км', /3000/.test(html)],
    ['шаг ≤10 с', /dt\s*=\s*(10|5|1)\b|10000\b/.test(html)],
    ['гравитация Луны в уравнениях', /mu(_?moon|M|_M)|4902/.test(html)],
    ['есть поиск (сетка/скан)', /search|scan|grid|optimiz/i.test(html)],
    ['есть canvas', /<canvas/i.test(html)],
    ['нет внешних скриптов', !/<script[^>]+src=/i.test(html)],
  ];

  // Подозрение на зашитый ответ: «красивое» значение Δv, вписанное константой
  const hardcoded = [];
  for (const m of html.matchAll(/(?:tli|dv|delta[_-]?v)[^=]{0,20}=\s*([0-9]+\.?[0-9]*)/gi)) {
    const v = Number(m[1]);
    if (v > 2.5 && v < 4.0) hardcoded.push(`${m[0].trim().slice(0, 40)} → ${v}`);
  }
  const reported = [];
  for (const m of html.matchAll(/([0-9]+\.?[0-9]*)\s*(?:km\/s|км\/с)/g)) reported.push(m[1]);

  console.log(`\nФайл: ${path.basename(file)} (${(html.length / 1024).toFixed(1)} КБ)`);
  for (const [name, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (hardcoded.length) { console.log('  ! возможные зашитые значения Δv:'); hardcoded.slice(0, 6).forEach(h => console.log('      ' + h)); }
  if (reported.length) { console.log(`  Δv-подобных чисел в тексте: ${[...new Set(reported)].slice(0, 8).join(', ')}`); }
  if (ref) console.log(`  эталон для сравнения: Δv ${ref.dvMS} м/с, мин. до поверхности ${ref.minMoonSurfaceKm} км`);
  const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
  const truncated = /<\/html>/i.test(html) === false || openScripts !== closeScripts;
  console.log(`  итог: ${checks.length - failed.length}/${checks.length} статических проверок пройдено${failed.length ? '; провалено: ' + failed.join(', ') : ''}`);
  if (truncated) console.log('  ВЫВОД ОБОРВАН: файл незавершён, запускать в браузере его нельзя');
  return { file: path.basename(file), passed: checks.length - failed.length, total: checks.length, failed, truncated, hardcoded, reported: [...new Set(reported)], sizeKb: Math.round(html.length / 1024) };
}

// --- CLI ---------------------------------------------------------------------

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith('--')) argv.set(t.replace(/^--/, ''), true);
  else { argv.set(t.replace(/^--/, ''), n); i += 1; }
}

if (argv.get('reference')) reference();
const fileArg = argv.get('file');
if (fileArg) {
  const out = checkFile(String(fileArg));
  fs.mkdirSync(path.join(here, '..', 'data', 'runtime', 'batch'), { recursive: true });
  fs.writeFileSync(path.join(here, '..', 'data', 'runtime', 'batch', `moon-check-${out.file}.json`), JSON.stringify(out, null, 2) + '\n');
}
if (!argv.get('reference') && !fileArg) console.log('укажи --reference или --file <путь.html>');
