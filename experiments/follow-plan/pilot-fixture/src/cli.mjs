#!/usr/bin/env node
// Отчёт по остаткам: читает CSV, суммирует по SKU, печатает итоги.
import fs from 'node:fs';
import { parseCsv } from './csv.mjs';
import { sumBySku, emptySkus } from './stock.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node src/cli.mjs <file.csv>');
  process.exit(2);
}
const rows = parseCsv(fs.readFileSync(file, 'utf8'));
const totals = sumBySku(rows);
for (const [sku, total] of [...totals.entries()].sort()) console.log(`${sku}\t${total}`);
const empty = emptySkus(totals);
if (empty.length) console.log(`пусто:\t${empty.join(', ')}`);
