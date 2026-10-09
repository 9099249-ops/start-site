CREATE TABLE IF NOT EXISTS financial_expense_versions(
 id INTEGER PRIMARY KEY,
 expense_id TEXT NOT NULL,
 body TEXT NOT NULL,
 actor INTEGER NOT NULL REFERENCES admin_users(id),
 request_id TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS financial_expense_lookup ON financial_expense_versions(expense_id,id);
CREATE TABLE IF NOT EXISTS financial_expense_requests(
 request_id TEXT PRIMARY KEY,
 fingerprint TEXT NOT NULL,
 actor INTEGER NOT NULL REFERENCES admin_users(id),
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS financial_expense_confirmations(
 id INTEGER PRIMARY KEY,
 period_from TEXT NOT NULL,
 period_to TEXT NOT NULL,
 expense_revision INTEGER NOT NULL,
 cost_revision INTEGER NOT NULL,
 actor INTEGER NOT NULL REFERENCES admin_users(id),
 created_at INTEGER NOT NULL
);
