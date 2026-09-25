-- Recipes reference the existing inventory, not a second warehouse.

 CREATE TABLE IF NOT EXISTS cafe_recipes(item_id TEXT NOT NULL,component TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(item_id,component));
 CREATE TABLE IF NOT EXISTS cafe_stock_usage(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES cafe_orders(id),item_id INTEGER NOT NULL REFERENCES inventory_items(id),unit_id INTEGER NOT NULL REFERENCES inventory_units(id),amount_milli INTEGER NOT NULL,created_at INTEGER NOT NULL,restored_at INTEGER);
 CREATE INDEX IF NOT EXISTS cafe_stock_order ON cafe_stock_usage(order_id);
