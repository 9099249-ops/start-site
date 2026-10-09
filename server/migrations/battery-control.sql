CREATE TABLE IF NOT EXISTS battery_commands (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES battery_devices(device_id),
 request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
 encrypted_payload TEXT NOT NULL, ssid TEXT, status TEXT NOT NULL DEFAULT 'queued',
 code TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 delivered_at INTEGER, acknowledged_at INTEGER, actor_id INTEGER NOT NULL,
 UNIQUE(device_id,request_id)
);
CREATE INDEX IF NOT EXISTS battery_commands_pending ON battery_commands(device_id,status,created_at);
CREATE TABLE IF NOT EXISTS battery_control_requests (
 device_id TEXT NOT NULL REFERENCES battery_devices(device_id),request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,command_id TEXT NOT NULL REFERENCES battery_commands(id),actor_id INTEGER NOT NULL,
 created_at INTEGER NOT NULL,PRIMARY KEY(device_id,request_id)
);
CREATE TABLE IF NOT EXISTS battery_trips (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, rental_id INTEGER NOT NULL REFERENCES rentals(id),
 state TEXT NOT NULL DEFAULT 'armed', revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, actor_id INTEGER NOT NULL,
 last_seen_at INTEGER, detected_departure_at INTEGER, detected_return_at INTEGER,
 confirmed_departure_at INTEGER, confirmed_return_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS battery_trip_active_boat ON battery_trips(label)
 WHERE state IN ('armed','departure-candidate','away','return-candidate');
CREATE TABLE IF NOT EXISTS battery_trip_requests (
 request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, trip_id TEXT NOT NULL,
 actor_id INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS battery_trip_events (
 id INTEGER PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES battery_trips(id),
 kind TEXT NOT NULL, actor_id INTEGER, created_at INTEGER NOT NULL
);
