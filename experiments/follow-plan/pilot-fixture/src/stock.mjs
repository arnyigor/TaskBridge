/** Суммарный остаток по каждому SKU. */
export function sumBySku(rows) {
  const totals = new Map();
  for (const row of rows) totals.set(row.sku, (totals.get(row.sku) ?? 0) + row.quantity);
  return totals;
}

/** SKU с нулевым остатком — их отчёт показывает отдельной строкой. */
export function emptySkus(totals) {
  return [...totals.entries()].filter(([, total]) => total === 0).map(([sku]) => sku);
}
