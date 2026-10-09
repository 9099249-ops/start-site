CREATE TABLE IF NOT EXISTS battery_devices (
 device_id TEXT PRIMARY KEY, name TEXT NOT NULL, catamaran_label TEXT NOT NULL DEFAULT '',
 bms_id TEXT NOT NULL, serial_number TEXT NOT NULL DEFAULT '', capacity_ah REAL,
 enabled INTEGER NOT NULL DEFAULT 1, stale_after_seconds INTEGER NOT NULL DEFAULT 90,
 revision INTEGER NOT NULL DEFAULT 0, token_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_seen_at INTEGER,
 health_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS battery_device_bms_identity ON battery_devices(bms_id);
CREATE TABLE IF NOT EXISTS battery_current (
 device_id TEXT PRIMARY KEY REFERENCES battery_devices(device_id),
 boot_id TEXT NOT NULL, sequence INTEGER NOT NULL, measured_at INTEGER NOT NULL,
 received_at INTEGER NOT NULL, telemetry_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS battery_history (
 id INTEGER PRIMARY KEY, device_id TEXT NOT NULL REFERENCES battery_devices(device_id),
 bucket_at INTEGER NOT NULL, measured_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
 telemetry_json TEXT NOT NULL, UNIQUE(device_id,bucket_at)
);
CREATE INDEX IF NOT EXISTS battery_history_time ON battery_history(device_id,measured_at DESC);
CREATE TABLE IF NOT EXISTS battery_boots (
 device_id TEXT NOT NULL REFERENCES battery_devices(device_id), boot_id TEXT NOT NULL,
 highest_sequence INTEGER NOT NULL, received_at INTEGER NOT NULL,
 PRIMARY KEY(device_id,boot_id)
);
CREATE TABLE IF NOT EXISTS battery_requests (
 request_id TEXT PRIMARY KEY, action TEXT NOT NULL, fingerprint TEXT NOT NULL,
 device_id TEXT NOT NULL REFERENCES battery_devices(device_id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS battery_device_events (
 id INTEGER PRIMARY KEY, device_id TEXT NOT NULL REFERENCES battery_devices(device_id),
 actor_id INTEGER NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL
);
