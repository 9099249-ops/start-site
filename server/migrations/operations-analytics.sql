CREATE TABLE IF NOT EXISTS operations_cost_versions(
 id INTEGER PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('cafe','rental','settings')),
 target_key TEXT NOT NULL,
 effective_at INTEGER NOT NULL,
 body TEXT NOT NULL,
 actor INTEGER NOT NULL REFERENCES admin_users(id),
 request_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_cost_lookup ON operations_cost_versions(kind,target_key,effective_at,id);
CREATE TABLE IF NOT EXISTS operations_cost_requests(
 request_id TEXT PRIMARY KEY,
 fingerprint TEXT NOT NULL,
 actor INTEGER NOT NULL REFERENCES admin_users(id),
 revision INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
