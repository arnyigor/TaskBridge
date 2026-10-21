package shop;

import java.util.List;

public final class Main {
    private static void expect(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    private static void expectClose(double actual, double expected, String message) {
        if (Math.abs(actual - expected) > 0.0001) {
            throw new AssertionError(message + ": " + actual + " != " + expected);
        }
    }

    public static void main(String[] args) {
        ItemRepository repository = new ItemRepository();
        ReceiptFormatter formatter = new ReceiptFormatter();
        Cart cart = new Cart()
                .add(repository.bySku("A-1").orElseThrow())
                .add(repository.bySku("B-7").orElseThrow());
        Checkout checkout = new Checkout(repository, formatter, cart);

        expect(repository.all().size() == 4, "в каталоге четыре товара");
        expectClose(repository.totalPrice(), 62.50, "сумма каталога");
        expectClose(cart.subtotal(), 57.50, "подытог корзины");
        expect(cart.size() == 2, "в корзине две позиции");
        expectClose(cart.totalWithVat(0.2), 69.00, "итог с НДС");
        expect(formatter.line(repository.bySku("A-1").orElseThrow()).equals("Кофе — 12.50 ₽"), "строка чека");
        expect(formatter.total(69.00).equals("Итого: 69.00 ₽"), "итог чека");
        List<String> lines = checkout.receiptLines();
        expect(lines.size() == 4, "четыре строки в чеке");
        expect(lines.get(3).equals("Чай — 0.25 ₽"), "последняя строка чека");
        expect(checkout.cartSummary().equals("Итого: 69.00 ₽"), "сводка корзины");
        System.out.println("OK");
    }
}
