package shop;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public final class ItemRepository {
    private final List<Item> items = new ArrayList<>();

    public ItemRepository() {
        items.add(new Item("A-1", "Кофе", 12.50));
        items.add(new Item("A-2", "Хлеб", 4.75));
        items.add(new Item("B-7", "Сыр", 45.00));
        items.add(new Item("C-3", "Чай", 0.25));
    }

    public List<Item> all() {
        return List.copyOf(items);
    }

    public Optional<Item> bySku(String sku) {
        for (Item item : items) {
            if (item.sku().equals(sku)) {
                return Optional.of(item);
            }
        }
        return Optional.empty();
    }

    public double totalPrice() {
        double sum = 0;
        for (Item item : items) {
            sum += item.getPrice();
        }
        return sum;
    }
}
