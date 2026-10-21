import { parseWeight } from './parse.mjs';
import { gramsToKilograms, roundMoney } from './units.mjs';

/** Стоимость отправки: вес в тексте × цена за килограмм. */
export function shipmentCost(weightText, pricePerKilogram) {
  const kilograms = gramsToKilograms(parseWeight(weightText));
  return roundMoney(kilograms * pricePerKilogram);
}
