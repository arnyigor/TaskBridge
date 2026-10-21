package shop;

import java.util.ArrayList;
import java.util.List;

public final class Cart {
    private final List<Item> lines = new ArrayList<>();

    public Cart add(Item item) {
        lines.add(item);
        return this;
    }

    public int size() {
        return lines.size();
    }

    public double subtotal() {
        double sum = 0;
        for (Item item : lines) {
            sum += item.getPrice();
        }
        return sum;
    }

    public double totalWithVat(double rate) {
        return subtotal() * (1 + rate);
    }
}
