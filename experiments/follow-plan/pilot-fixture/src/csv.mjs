import { parseQuantity } from './quantity.mjs';

/**
 * Разбор CSV с остатками. Простой вариант: строки, разделённые переводом строки,
 * поля — через ';'. Заголовок распознаётся по первому полю `sku`.
 */
export function parseCsv(text) {
  const lines = String(text ?? '').split('\n');
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sku, title, quantity] = trimmed.split(';');
    if (String(sku).trim().toLowerCase() === 'sku') continue;
    rows.push({ sku: String(sku).trim(), title: String(title ?? '').trim(), quantity: parseQuantity(quantity) });
  }
  return rows;
}
