CREATE TABLE IF NOT EXISTS staff_sms_contacts(
 user_id INTEGER PRIMARY KEY REFERENCES admin_users(id),
 phone TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL,updated_by INTEGER NOT NULL REFERENCES admin_users(id)
);
CREATE TABLE IF NOT EXISTS staff_sms_settings(
 id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO staff_sms_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS staff_sms_jobs(
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES admin_users(id),
 day TEXT NOT NULL,start_at INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('evening','hour')),
 due INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'scheduled',attempts INTEGER NOT NULL DEFAULT 0,
 phone TEXT,payload TEXT,claimed_at INTEGER,sent_at INTEGER,provider_id INTEGER,checked_at INTEGER,
 last_error TEXT NOT NULL DEFAULT '',cancel_reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,
 UNIQUE(user_id,day,start_at,kind)
);
CREATE INDEX IF NOT EXISTS staff_sms_due ON staff_sms_jobs(status,due);
CREATE TABLE IF NOT EXISTS staff_sms_events(
 id INTEGER PRIMARY KEY,job_id INTEGER REFERENCES staff_sms_jobs(id),user_id INTEGER REFERENCES admin_users(id),
 actor INTEGER REFERENCES admin_users(id),action TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL
);
