/**
 * Количество на складе. Принимает только целые неотрицательные числа;
 * исходное значение приходит из CSV строкой.
 */
export function parseQuantity(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('quantity: пустое значение');
  if (!/^\d+$/.test(text)) throw new Error(`quantity: не число — ${text}`);
  const number = Number(text);
  if (number <= 0) throw new Error(`quantity: должно быть положительным — ${text}`);
  return number;
}
