// Консолидатор памяти (этап M3 плана): заметки, которые пора слить.
//
// Правило плана: результат работы консолидатора — ПРЕДЛОЖЕНИЕ через существующий
// гейт, а не авто-правка. Файлы .md остаются единственным источником правды, и
// решает человек. Поэтому здесь только поиск кандидатов (чистые функции), а запись
// делает memory-proposals.mjs после явного «Принять».
//
// Почему не «BM25 из индекса» напрямую: BM25 сравнивает запрос с документом, а нам
// нужна симметричная близость двух документов. Сходство считается по множествам слов
// (Jaccard по значимым терминам) — детерминированно, без порогов по корпусу, и на
// сотнях заметок это микросекунды. Индекс при этом делает свою работу: он даёт
// заметки для сравнения, и кандидаты ищутся только внутри одного скоупа.

/** Порог по умолчанию: заметки об одном и том же обычно совпадают по половине значимых слов. */
export const MERGE_THRESHOLD_DEFAULT = 0.35;

const MIN_TERM = 3;
const MAX_TERMS = 400;

/** Значимые слова текста: словами, а не подстроками (как и скоринг поиска). */
export function significantTerms(text) {
  const words = String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(word => word.length >= MIN_TERM);
  const unique = [...new Set(words)];
  return unique.length > MAX_TERMS ? unique.slice(0, MAX_TERMS) : unique;
}

/** Jaccard по значимым словам: 0 — ничего общего, 1 — те же слова. */
export function similarity(a, b) {
  const left = a instanceof Set ? a : new Set(significantTerms(a));
  const right = b instanceof Set ? b : new Set(significantTerms(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Пары заметок, которые стоит рассмотреть на слияние.
 *
 * [threshold] — насколько похожими должны быть тексты (по умолчанию 0.35: заметки об
 * одном и том же обычно совпадают по половине значимых слов, а разные общие слова
 * вроде «проект» и «нужно» такого сходства не дают).
 * Возвращает пары по убыванию сходства, без пар «заметка с самой собой» и без
 * заменённых заметок: их судьба уже решена через `supersedes`.
 */
export function findMergeCandidates(entries = [], { threshold = MERGE_THRESHOLD_DEFAULT, limit = 10 } = {}) {
  const notes = (entries || [])
    .filter(entry => entry && entry.source && !entry.superseded)
    .map(entry => ({
      source: String(entry.source),
      category: entry.category ?? 'other',
      description: entry.description ?? null,
      updatedAt: entry.updatedAt ?? null,
      terms: new Set(significantTerms(`${entry.description || ''} ${entry.text || ''}`)),
      text: String(entry.text || ''),
    }));
  const pairs = [];
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const score = similarity(notes[i].terms, notes[j].terms);
      if (score < threshold) continue;
      pairs.push({
        score: Number(score.toFixed(3)),
        sameCategory: notes[i].category === notes[j].category,
        notes: [notes[i], notes[j]].map(note => ({
          source: note.source,
          category: note.category,
          description: note.description,
          updatedAt: note.updatedAt,
          // Превью, а не весь текст: человеку нужно узнать заметку, а не читать её тут.
          preview: note.text.replace(/\s+/gu, ' ').slice(0, 200),
        })),
      });
    }
  }
  return pairs
    .sort((a, b) => b.score - a.score
      || Number(b.sameCategory) - Number(a.sameCategory)
      || String(a.notes[0].source).localeCompare(String(b.notes[0].source)))
    .slice(0, Math.max(0, Math.min(50, Number(limit) || 10)));
}

/**
 * Текст предложения на слияние: обе заметки целиком, чтобы решение принималось по
 * содержанию. Заменённая заметка называется через `supersedes` — после принятия
 * предложения её знание перестанет попадать в контекст, но останется в поиске.
 */
export function mergeProposalText(pair) {
  const [first, second] = pair?.notes || [];
  if (!first || !second) return null;
  return [
    `Слить заметки «${first.description || first.source}» и «${second.description || second.source}»:`,
    '',
    `1. ${first.source}`,
    first.preview,
    '',
    `2. ${second.source}`,
    second.preview,
    '',
    'Сходство по значимым словам: ' + pair.score + '.',
  ].join('\n');
}
