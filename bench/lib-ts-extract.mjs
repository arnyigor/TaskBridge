/**
 * Извлечение и лёгкая чистка функций из TypeScript-расширения для тестов.
 *
 * Зачем отдельный модуль: в тестах нужно исполнять НАСТОЯЩИЙ код надзирателя, а не копию.
 * Сначала это делалось через регекспы, вписанные прямо в тест-файлы, — и каждый такой
 * регексп приходилось чинить через шелл, где бэкслэши съедаются. Один общий модуль решает
 * и то, и другое.
 *
 * Правило чистки: убираем аннотации параметров, переменных и типов возврата. Важные детали:
 *  · объединения (`string | undefined`) разбираем ПЕРВЫМИ, иначе остаётся хвост `| undefined;`;
 *  · значения в объектных литералах не трогаем: после `имя: значение` идёт `,` `)` `;` `=` —
 *    по этим символам и ограничиваем замену, поэтому `{ withFileTypes: true }` остаётся целым.
 */

export function stripTsTypes(text) {
  // Тип — это primitive, набор/объединение primitive или ИМЯ С БОЛЬШОЙ буквы (Verdict, Set<string>).
  // Литералы (true, false, null, числа, строки) и переменные (verdict.kind) остаются на месте:
  // без этого `speak: true` превращался в `speak` и вырезанный код не запускался.
  const type = '(?:(?:string|number|boolean|undefined|null|void|never|unknown|any)(?:\\[\\])?|[A-Z][\\w.]*(?:<[^>]*>)?(?:\\[\\])?)';
  const union = `(?:${type}(?:\\s*\\|\\s*${type})*)`;
  return text
    .replace(new RegExp(`(\\w+):\\s*${union}(?=\\s*[,);=])`, 'g'), '$1')
    .replace(new RegExp(`\\)\\s*:\\s*${union}\\s*\\{`, 'g'), ') {')
    // Параметры типа в конструкторе: `new Set<string>()` — в JS это синтаксическая ошибка.
    .replace(/\bnew\s+([A-Z][\w.]*)<[^>]*>\(/g, 'new $1(');
}

export function grabFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`функция ${name} не найдена в источнике`);
  const end = source.indexOf('\n}', start) + 2;
  return source.slice(start, end);
}

export function grabConst(source, name) {
  const m = new RegExp(`const ${name} = \\[[^\\]]*\\];`).exec(source);
  return m ? m[0] : '';
}
