CREATE TABLE IF NOT EXISTS staff_schedule(
 user_id INTEGER NOT NULL REFERENCES admin_users(id),day TEXT NOT NULL,
 preference TEXT NOT NULL DEFAULT 'none',wish_start TEXT NOT NULL DEFAULT '',wish_end TEXT NOT NULL DEFAULT '',wish_note TEXT NOT NULL DEFAULT '',
 confirmed INTEGER NOT NULL DEFAULT 0,plan_start TEXT NOT NULL DEFAULT '',plan_end TEXT NOT NULL DEFAULT '',plan_note TEXT NOT NULL DEFAULT '',pending INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,day)
);
CREATE INDEX IF NOT EXISTS staff_schedule_day ON staff_schedule(day);
