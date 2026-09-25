-- Additive tables. Conditional column extensions live in WorkforceStore.
CREATE TABLE IF NOT EXISTS employee_profiles(user_id INTEGER PRIMARY KEY REFERENCES admin_users(id),display_name TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS work_day_settings(day TEXT PRIMARY KEY,settings_json TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS employee_work_sessions(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES admin_users(id),started_at INTEGER NOT NULL,ended_at INTEGER,revision INTEGER NOT NULL DEFAULT 0,CHECK(ended_at IS NULL OR ended_at>=started_at));
   CREATE UNIQUE INDEX IF NOT EXISTS one_active_work_session ON employee_work_sessions(user_id) WHERE ended_at IS NULL;
   CREATE INDEX IF NOT EXISTS employee_work_dates ON employee_work_sessions(started_at,ended_at);
   CREATE TABLE IF NOT EXISTS financial_audit_log(id INTEGER PRIMARY KEY,actor INTEGER NOT NULL REFERENCES admin_users(id),action TEXT NOT NULL,entity_id INTEGER,before_json TEXT NOT NULL,after_json TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS work_actions(request_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES admin_users(id),kind TEXT NOT NULL,session_id INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS daily_work_reports(day TEXT PRIMARY KEY,created_at INTEGER NOT NULL,snapshot_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',claimed_at INTEGER,sent_at INTEGER,last_error TEXT NOT NULL DEFAULT '');
   CREATE TABLE IF NOT EXISTS shift_report_jobs(shift_id INTEGER PRIMARY KEY REFERENCES shifts(id),body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',claimed_at INTEGER,last_error TEXT NOT NULL DEFAULT '');
