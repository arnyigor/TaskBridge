# Warehouse CSV importer

Небольшая утилита: читает CSV с остатками склада, считает итоги по SKU и печатает отчёт.

    npm test
    npm run report

Формат входа: `sku;title;quantity` (заголовок необязателен, разделитель `;`).
