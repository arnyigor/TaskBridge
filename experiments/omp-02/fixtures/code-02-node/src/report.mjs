import { shipmentCost } from './pricing.mjs';

export function reportRow(weightText, pricePerKilogram) {
  return `${weightText} → ${shipmentCost(weightText, pricePerKilogram).toFixed(2)} ₽`;
}

export function reportTotal(shipments) {
  const total = shipments.reduce(
    (sum, shipment) => sum + shipmentCost(shipment.weight, shipment.pricePerKilogram),
    0,
  );
  return `Итого: ${total.toFixed(2)} ₽`;
}
