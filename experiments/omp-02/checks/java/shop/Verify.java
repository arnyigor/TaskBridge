package shop;

/**
 * Проверка CODE-01, которую стенд кладёт в рабочую копию ПОСЛЕ прогона агента:
 * агенту этот файл не виден, поэтому ослабить проверку он не может.
 * Компилируется вместе с исходниками проекта, то есть контракт API должен
 * совпасть точно.
 */
public final class Verify {
    private static void expect(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    public static void main(String[] args) {
        ItemRepository repository = new ItemRepository();
        ReceiptFormatter formatter = new ReceiptFormatter();
        Cart cart = new Cart()
                .add(repository.bySku("A-1").orElseThrow())
                .add(repository.bySku("B-7").orElseThrow());
        Checkout checkout = new Checkout(repository, formatter, cart);

        Item coffee = repository.bySku("A-1").orElseThrow();
        expect(coffee.priceCents() == 1250L, "priceCents A-1: " + coffee.priceCents());
        expect(repository.totalCents() == 6250L, "totalCents: " + repository.totalCents());
        expect(cart.subtotalCents() == 5750L, "subtotalCents: " + cart.subtotalCents());
        expect(cart.totalWithVatCents(0.2) == 6900L, "totalWithVatCents: " + cart.totalWithVatCents(0.2));
        expect(formatter.line(coffee).equals("Кофе — 12.50 ₽"), "строка чека: " + formatter.line(coffee));
        expect(formatter.totalCents(6900L).equals("Итого: 69.00 ₽"), "итог чека: " + formatter.totalCents(6900L));
        expect(checkout.receiptLines().size() == 4, "строк в чеке: " + checkout.receiptLines().size());
        expect(checkout.receiptLines().get(3).equals("Чай — 0.25 ₽"), "последняя строка: " + checkout.receiptLines().get(3));
        expect(checkout.cartSummary().equals("Итого: 69.00 ₽"), "сводка корзины: " + checkout.cartSummary());
        expect(repository.all().size() == 4, "товаров в каталоге: " + repository.all().size());
        System.out.println("OK");
    }
}
