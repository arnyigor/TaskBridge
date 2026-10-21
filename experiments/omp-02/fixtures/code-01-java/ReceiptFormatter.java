package shop;

import java.util.Locale;

public final class ReceiptFormatter {
    public String line(Item item) {
        return String.format(Locale.ROOT, "%s — %.2f ₽", item.name(), item.getPrice());
    }

    public String total(double value) {
        return String.format(Locale.ROOT, "Итого: %.2f ₽", value);
    }
}
