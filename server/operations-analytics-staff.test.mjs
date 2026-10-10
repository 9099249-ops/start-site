import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {staffAnalytics} from './operations-analytics-staff.mjs';

const MSK = 3 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const local = value => Date.parse(`${value}+03:00`);

function fixture(t) {
  const admin = new AdminStore(':memory:');
  admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'worker','staff','unused'),(3,'archived','waiter','unused')");
  admin.db.prepare('INSERT INTO employee_profiles VALUES(2,?)').run('Worker Name');
  admin.db.prepare('INSERT INTO archived_accounts VALUES(3,?,1)').run(1);
  t.after(() => admin.close());
  return admin;
}

function addPlan(admin, userId, day, start, end, confirmed = 1) {
  admin.db.prepare('INSERT INTO staff_schedule(user_id,day,confirmed,plan_start,plan_end) VALUES(?,?,?,?,?)').run(userId, day, confirmed, start, end);
}

function addSession(admin, userId, started, ended) {
  return Number(admin.db.prepare('INSERT INTO employee_work_sessions(user_id,started_at,ended_at) VALUES(?,?,?)').run(userId, started, ended).lastInsertRowid);
}

const employee = (result, id = 2) => result.employees.find(row => row.id === id);
const run = (admin, from, to, now = to - 1) => staffAnalytics(admin, {start: from, end: to}, now);

test('staff analytics clips at Moscow midnight, excludes login admin, retains archived staff', t => {
  const admin = fixture(t), start = local('2026-10-01T00:00'), end = local('2026-10-02T00:00');
  addSession(admin, 1, start, start + 3600000);
  addSession(admin, 2, start - 30 * 60000, start + 90 * 60000);
  const result = run(admin, start, end);
  assert.deepEqual(result.employees.map(row => row.id), [2, 3]);
  assert.equal(employee(result).minutes, 90);
  assert.equal(employee(result).shifts[0].start, start);
  assert.equal(employee(result, 3).minutes, 0);
  assert.equal(employee(result).name, 'Worker Name');
});

test('overlapping sessions union to one shift; confirmed 09:00 plan measures lateness and overtime', t => {
  const admin = fixture(t), day = '2026-10-01', start = local(`${day}T00:00`), end = local('2026-10-02T00:00');
  addPlan(admin, 2, day, '09:00', '17:00');
  addSession(admin, 2, local(`${day}T09:07`), local(`${day}T17:30`));
  addSession(admin, 2, local(`${day}T09:20`), local(`${day}T12:00`));
  const result = run(admin, start, end);
  const row = employee(result);
  assert.equal(row.minutes, 503);
  assert.equal(row.planned9Count, 1);
  assert.equal(row.lateCount, 1);
  assert.equal(row.lateMinutes, 7);
  assert.equal(row.overtimeCount, 1);
  assert.equal(row.overtimeMinutes, 30);
  assert.equal(row.shifts.length, 1);
});

test('lateness metrics apply only to confirmed 09:00 plans', t => {
  const admin = fixture(t), day = '2026-10-01', start = local(`${day}T00:00`), end = local('2026-10-02T00:00');
  addPlan(admin, 2, day, '11:00', '17:00');
  addSession(admin, 2, local(`${day}T11:10`), local(`${day}T17:00`));
  const row = employee(run(admin, start, end));
  assert.equal(row.lateCount, 0);
  assert.equal(row.lateMinutes, 0);
  assert.equal(row.planned9Count, 0);
  assert.equal(row.shifts[0].lateMinutes, 0);
});

test('a past confirmed plan with no attendance is a no-show; an unconfirmed wish is not', t => {
  const admin = fixture(t), day = '2026-10-01', start = local(`${day}T00:00`), end = local('2026-10-03T00:00');
  addPlan(admin, 2, day, '09:00', '17:00');
  addPlan(admin, 3, day, '09:00', '17:00', 0);
  const result = run(admin, start, end);
  assert.equal(employee(result).planned9Count, 1);
  assert.equal(employee(result).noShowCount, 1);
  assert.equal(employee(result, 3).noShowCount, 0);
});

test('same-day active attendance includes elapsed minutes without review', t => {
  const admin = fixture(t), day = '2026-10-01', start = local(`${day}T00:00`), now = local(`${day}T10:30`);
  const id = addSession(admin, 2, local(`${day}T10:00`), null);
  addSession(admin, 2, local(`${day}T10:40`), local(`${day}T11:00`));
  const result = run(admin, start, local('2026-10-02T00:00'), now);
  const row = employee(result);
  assert.equal(row.minutes, 30);
  assert.equal(row.reviewCount, 0);
  assert.equal(row.shifts[0].id, id);
  assert.equal(row.shifts[0].active, true);
  assert.equal(row.shifts[0].review, false);
});

test('overnight attendance overlapping a confirmed plan prevents a false no-show', t => {
  const admin = fixture(t), day = '2026-10-02', start = local('2026-10-01T00:00'), end = local('2026-10-03T00:00');
  addPlan(admin, 2, day, '09:00', '10:00');
  addSession(admin, 2, local('2026-10-01T22:00'), local(`${day}T10:00`));
  const row = employee(run(admin, start, end));
  assert.equal(row.noShowCount, 0);
  assert.equal(row.minutes, 720);
});

test('oversized, stale active, and automatically ended sessions require review and add no hours', t => {
  const admin = fixture(t), day = '2026-10-01', start = local(`${day}T00:00`), end = local('2026-10-03T00:00');
  const oversized = addSession(admin, 2, start + MSK, start + MSK + 25 * 3600000);
  admin.db.prepare("INSERT INTO financial_audit_log(actor,action,entity_id,before_json,after_json,reason,created_at) VALUES(1,'work_auto_end',?,'{}','{}','auto',?)").run(oversized, start + 26 * 3600000);
  addSession(admin, 2, start + 2 * 3600000, null);
  const result = run(admin, start, end, end - 1);
  assert.equal(employee(result).minutes, 0);
  assert.equal(employee(result).reviewCount, 2);
  assert.equal(employee(result).shifts.filter(shift => shift.review).length, 2);
  assert.ok(employee(result).shifts.filter(shift => shift.review).every(shift => shift.minutes === null));
  assert.equal(employee(result).shifts.some(shift => shift.overtimeMinutes), false);
});

test('a correction after automatic end makes corrected actual interval countable', t => {
  const admin = fixture(t), day = '2026-10-01', start = local(`${day}T00:00`), end = local('2026-10-02T00:00');
  const id = addSession(admin, 2, local(`${day}T09:00`), local(`${day}T17:00`));
  admin.db.prepare("INSERT INTO financial_audit_log(actor,action,entity_id,before_json,after_json,reason,created_at) VALUES(1,'work_auto_end',?,'{}','{}','auto',?)").run(id, start + 20 * 3600000);
  admin.db.prepare("INSERT INTO financial_audit_log(actor,action,entity_id,before_json,after_json,reason,created_at) VALUES(1,'work_correct',?,'{}','{}','corrected',?)").run(id, start + 21 * 3600000);
  const result = run(admin, start, end);
  assert.equal(employee(result).minutes, 480);
  assert.equal(employee(result).reviewCount, 0);
  assert.equal(employee(result).shifts[0].review, false);
});

test('task events replay by task occurrence and Moscow day/two-hour period as of end', t => {
  const admin = fixture(t), taskDay = '2026-10-01', previousDay = '2026-09-30';
  const oneOff = admin.tasks.create({requestId: randomUUID(), text: 'one-off'}, {id: 1, role: 'admin'}, local(`${previousDay}T08:00`));
  const daily = admin.tasks.create({requestId: randomUUID(), text: 'opening', kind: 'opening'}, {id: 1, role: 'admin'}, local(`${previousDay}T08:00`));
  const during = admin.tasks.create({requestId: randomUUID(), text: 'during', kind: 'during'}, {id: 1, role: 'admin'}, local(`${previousDay}T08:00`));
  const event = admin.db.prepare('INSERT INTO station_task_events(task_id,actor,action,created_at) VALUES(?,?,?,?)');
  const at = (day, time, action, taskId = oneOff, actor = 2) => event.run(taskId, actor, action, local(`${day}T${time}`));
  at(taskDay, '09:10', 'completed'); at(taskDay, '09:20', 'reopened');
  at(taskDay, '10:05', 'completed');
  at(previousDay, '23:55', 'completed', daily); at(taskDay, '00:05', 'reopened', daily); at(taskDay, '00:10', 'completed', daily, 3);
  at(taskDay, '09:50', 'completed', during); at(taskDay, '10:00', 'reopened', during); at(taskDay, '10:05', 'completed', during, 3);
  const result = run(admin, local('2026-09-30T00:00'), local('2026-10-02T00:00'));
  assert.equal(employee(result).oneOffCompleted, 1);
  assert.equal(employee(result).regularCompleted, 2);
  assert.equal(employee(result).taskCompleted, 3);
  assert.equal(employee(result, 3).regularCompleted, 2);
  assert.equal(employee(result, 3).taskCompleted, 2);
  assert.equal(employee(result).taskAssigned, null);
  assert.equal(employee(result).taskRatio, null);
  assert.ok(result.warnings.some(warning => warning.includes('Процент выполнения назначенных дел недоступен.')));
  assert.ok(result.warnings.some(warning => warning.includes('историю изменений плана')));
});
