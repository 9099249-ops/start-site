CREATE TABLE IF NOT EXISTS inventory_migrations(version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inventory_categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS inventory_units(id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS inventory_items(
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
 category_id INTEGER NOT NULL REFERENCES inventory_categories(id), unit_id INTEGER NOT NULL REFERENCES inventory_units(id),
 current_milli INTEGER CHECK(current_milli>=0), minimum_milli INTEGER CHECK(minimum_milli>=0), target_milli INTEGER CHECK(target_milli>=0),
 manual_buy INTEGER NOT NULL DEFAULT 0 CHECK(manual_buy IN(0,1)), comment TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), updated_at INTEGER NOT NULL,
 updated_by INTEGER REFERENCES admin_users(id), revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inventory_transactions(
 id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES inventory_items(id), category_id INTEGER NOT NULL REFERENCES inventory_categories(id),
 kind TEXT NOT NULL, delta_milli INTEGER, before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL,
 actor INTEGER REFERENCES admin_users(id), actor_login TEXT NOT NULL, created_at INTEGER NOT NULL,
 request_id TEXT UNIQUE, payload_hash TEXT
);
CREATE INDEX IF NOT EXISTS inventory_history_item ON inventory_transactions(item_id,id);
CREATE INDEX IF NOT EXISTS inventory_history_category ON inventory_transactions(category_id,id);
CREATE INDEX IF NOT EXISTS inventory_history_date ON inventory_transactions(created_at);
-- Future recipes can reference stable inventory_items.id with quantities in thousandths
-- and cafe item/variant IDs. They can append consumption transactions with a unique
-- source event ID without changing or retroactively recalculating historical balances.
INSERT OR IGNORE INTO inventory_migrations VALUES('001-inventory',CAST(strftime('%s','now') AS INTEGER)*1000);
