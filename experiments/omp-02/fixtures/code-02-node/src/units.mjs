export function kilogramsToGrams(kilograms) {
  return kilograms * 100;
}

export function gramsToKilograms(grams) {
  return grams / 1000;
}

export function roundMoney(value) {
  return Math.round(value * 100) / 100;
}
