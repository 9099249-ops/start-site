CREATE TABLE IF NOT EXISTS station_tasks (
 id INTEGER PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE,
 text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 500),
 kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','opening','during','closing')),
 created_at INTEGER NOT NULL,
 created_by INTEGER NOT NULL REFERENCES admin_users(id),
 completed_at INTEGER,
 completed_by INTEGER REFERENCES admin_users(id),
 revision INTEGER NOT NULL DEFAULT 0,
 CHECK ((completed_at IS NULL) = (completed_by IS NULL))
);
CREATE TABLE IF NOT EXISTS station_task_events (
 id INTEGER PRIMARY KEY,
 task_id INTEGER NOT NULL REFERENCES station_tasks(id),
 actor INTEGER NOT NULL REFERENCES admin_users(id),
 action TEXT NOT NULL CHECK(action IN ('created','completed','reopened')),
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS station_tasks_status ON station_tasks(completed_at,created_at);
CREATE TABLE IF NOT EXISTS station_task_checks (
 task_id INTEGER NOT NULL REFERENCES station_tasks(id),
 day TEXT NOT NULL,
 completed_at INTEGER,
 completed_by INTEGER REFERENCES admin_users(id),
 revision INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(task_id,day),
 CHECK ((completed_at IS NULL) = (completed_by IS NULL))
);
