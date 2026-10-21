import { kilogramsToGrams } from './units.mjs';

/** «1.5kg» → 1500 грамм, «250g» → 250 грамм. */
export function parseWeight(text) {
  const match = /^([\d.]+)\s*(kg|g)$/i.exec(String(text).trim());
  if (!match) {
    throw new Error(`не разобрать вес: ${text}`);
  }
  const value = Number(match[1]);
  return match[2].toLowerCase() === 'kg' ? kilogramsToGrams(value) : value;
}
