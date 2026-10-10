CREATE TABLE IF NOT EXISTS cafe_product_card_requests (
 request_id TEXT PRIMARY KEY,
 actor INTEGER NOT NULL,
 fingerprint TEXT NOT NULL,
 item_id TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cafe_purchase_price_versions (
 id INTEGER PRIMARY KEY,
 inventory_id INTEGER NOT NULL,
 unit_id INTEGER NOT NULL,
 quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
 total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
 actor INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
