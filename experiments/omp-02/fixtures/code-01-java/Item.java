package shop;

public final class Item {
    private final String sku;
    private final String name;
    private final double price;

    public Item(String sku, String name, double price) {
        this.sku = sku;
        this.name = name;
        this.price = price;
    }

    public String sku() {
        return sku;
    }

    public String name() {
        return name;
    }

    public double getPrice() {
        return price;
    }
}
