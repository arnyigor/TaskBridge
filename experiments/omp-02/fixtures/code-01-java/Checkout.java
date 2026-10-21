package shop;

import java.util.ArrayList;
import java.util.List;

public final class Checkout {
    private final ItemRepository repository;
    private final ReceiptFormatter formatter;
    private final Cart cart;

    public Checkout(ItemRepository repository, ReceiptFormatter formatter, Cart cart) {
        this.repository = repository;
        this.formatter = formatter;
        this.cart = cart;
    }

    public List<String> receiptLines() {
        List<String> lines = new ArrayList<>();
        for (Item item : repository.all()) {
            lines.add(formatter.line(item));
        }
        return lines;
    }

    public String cartSummary() {
        return formatter.total(cart.totalWithVat(0.2));
    }
}
