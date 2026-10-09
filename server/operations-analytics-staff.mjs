const MSK = 3 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const mskDay = value => new Date(value + MSK).toISOString().slice(0, 10);
const dayStart = day => Date.parse(`${day}T00:00:00+03:00`);
const bound = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? dayStart(value) : Number(value);
const clockMs = (day, clock) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock || '')) return null;
  return dayStart(day) + Number(clock.slice(0, 2)) * 3600000 + Number(clock.slice(3)) * 60000;
};

function occurrences(events, tasks, start, end) {
  const kinds = new Map(tasks.map(task => [task.id, task.kind]));
  const states = new Map();
  for (const event of events) {
    if (event.created_at >= end) continue;
    const kind = kinds.get(event.task_id);
    if (!kind) continue;
    let period = 'all';
    if (kind === 'opening' || kind === 'closing') period = mskDay(event.created_at);
    if (kind === 'during') {
      const local = new Date(event.created_at + MSK);
      period = `${local.toISOString().slice(0, 10)}@${String(Math.floor(local.getUTCHours() / 2) * 2).padStart(2, '0')}`;
    }
    const key = `${event.task_id}:${period}`;
    states.set(key, event);
  }
  const result = new Map();
  for (const event of states.values()) {
    if (event.action !== 'completed' || event.created_at < start || event.created_at >= end) continue;
    const row = result.get(event.actor) || {taskCompleted: 0, oneOffCompleted: 0, regularCompleted: 0};
    row.taskCompleted++;
    if (kinds.get(event.task_id) === 'task') row.oneOffCompleted++;
    else row.regularCompleted++;
    result.set(event.actor, row);
  }
  return result;
}

function mergeIntervals(rows) {
  const ordered = [...rows].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const row of ordered) {
    const last = merged.at(-1);
    if (last && row.start <= last.end) {
      last.end = Math.max(last.end, row.end);
      last.ids.push(row.id);
      last.active ||= row.active;
    } else merged.push({start: row.start, end: row.end, ids: [row.id], active: row.active});
  }
  return merged;
}

export function staffAnalytics(admin, period, now = Date.now()) {
  const start = bound(period?.start ?? period?.from);
  const end = bound(period?.end ?? period?.to);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw new TypeError('Expected a valid end-exclusive period in milliseconds.');
  const asOf = Math.min(now, end - 1);
  const employees = admin.db.prepare(`
    SELECT u.id, u.login, u.role, coalesce(p.display_name, u.login) name
    FROM admin_users u LEFT JOIN employee_profiles p ON p.user_id=u.id
    WHERE u.login <> 'admin'
    ORDER BY u.id
  `).all().map(person => ({
    id: person.id, name: person.name, minutes: 0,
    taskCompleted: 0, oneOffCompleted: 0, regularCompleted: 0,
    taskAssigned: null, taskRatio: null,
    lateCount: 0, lateMinutes: 0, planned9Count: 0,
    overtimeMinutes: 0, overtimeCount: 0, reviewCount: 0, noShowCount: 0,
    shifts: [],
    _intervals: [], _attendanceIntervals: [], _startedDays: new Set()
  }));
  const byId = new Map(employees.map(employee => [employee.id, employee]));
  const warnings = [
    'Сохраняется только текущий график сотрудника на день; историю изменений плана восстановить нельзя, поэтому опоздания и невыходы могут отражать текущий график.',
    'Назначение дел конкретным сотрудникам пока не сохраняется. Процент выполнения назначенных дел недоступен.'
  ];
  const plans = admin.db.prepare('SELECT user_id,day,confirmed,plan_start,plan_end FROM staff_schedule WHERE day>=? AND day<=?').all(mskDay(start - DAY), mskDay(end));
  const planByDay = new Map();
  for (const plan of plans) {
    if (!plan.confirmed) continue;
    const employee = byId.get(plan.user_id);
    if (!employee) continue;
    planByDay.set(`${plan.user_id}:${plan.day}`, plan);
    if (plan.plan_start === '09:00' && dayStart(plan.day) >= start && dayStart(plan.day) < end) employee.planned9Count++;
  }
  const sessions = admin.db.prepare(`
    SELECT id,user_id,started_at,ended_at FROM employee_work_sessions
    WHERE started_at < ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?)
    ORDER BY user_id,started_at,id
  `).all(end, asOf, start);
  const sessionAudits = admin.db.prepare(`
    SELECT entity_id,action,created_at FROM financial_audit_log
    WHERE action IN ('work_auto_end','work_correct') AND created_at < ? ORDER BY created_at,id
  `).all(end);
  const auditState = new Map();
  for (const event of sessionAudits) auditState.set(event.entity_id, event.action);
  for (const session of sessions) {
    const employee = byId.get(session.user_id);
    if (!employee) continue;
    const day = mskDay(session.started_at);
    const active = session.ended_at === null;
    const sameDayActive = active && day === mskDay(asOf);
    const autoEnded = auditState.get(session.id) === 'work_auto_end';
    const tooLong = autoEnded || active && !sameDayActive || !active && session.ended_at - session.started_at > DAY;
    const actualEnd = active ? asOf : session.ended_at;
    const row = {id: session.id, day, start: session.started_at, end: actualEnd, active: sameDayActive, review: tooLong};
    if (tooLong) employee.reviewCount++;
    employee._startedDays.add(day);
    if (row.end <= start || row.start >= end) continue;
    const attendanceStart = Math.max(row.start, start), attendanceEnd = Math.min(row.end, end);
    for (let cursor = attendanceStart; cursor < attendanceEnd;) {
      const partDay = mskDay(cursor), boundary = Math.min(attendanceEnd, dayStart(partDay) + DAY);
      employee._attendanceIntervals.push({day: partDay, start: cursor, end: boundary});
      cursor = boundary;
    }
    if (tooLong) {
      const plan = planByDay.get(`${session.user_id}:${day}`);
      employee.shifts.push({id: session.id, day, start: session.started_at, end: actualEnd, minutes: null,
        plannedStart: plan?.plan_start || null, plannedEnd: plan?.plan_end || null,
        lateMinutes: 0, overtimeMinutes: 0, review: true});
      continue;
    }
    const clipStart = Math.max(row.start, start), clipEnd = Math.min(row.end, end);
    for (let cursor = clipStart; cursor < clipEnd;) {
      const partDay = mskDay(cursor), boundary = Math.min(clipEnd, dayStart(partDay) + DAY);
      employee._intervals.push({id: row.id, day: partDay, start: cursor, end: boundary, active: row.active, review: false});
      cursor = boundary;
    }
  }
  for (const employee of employees) {
    const byDay = new Map();
    for (const item of employee._intervals) {
      if (item.review) continue;
      const list = byDay.get(item.day) || [];
      list.push(item); byDay.set(item.day, list);
    }
    for (const [day, items] of byDay) {
      const merged = mergeIntervals(items);
      const plan = planByDay.get(`${employee.id}:${day}`);
      const startPlan = plan && clockMs(day, plan.plan_start);
      const endPlan = plan && clockMs(day, plan.plan_end);
      const starts = merged.map(interval => interval.start).filter(value => value < dayStart(day) + DAY);
      const ends = merged.map(interval => interval.end).filter(value => value <= dayStart(day) + DAY);
      const first = starts.length ? Math.min(...starts) : null;
      const last = ends.length ? Math.max(...ends) : null;
      if (plan?.plan_start === '09:00' && startPlan !== null && first !== null && first > startPlan) {
        const late = Math.ceil((first - startPlan) / 60000);
        employee.lateCount++;
        employee.lateMinutes += late;
      }
      if (plan && endPlan !== null && last !== null && last > endPlan) {
        const overtime = Math.floor((last - endPlan) / 60000);
        if (overtime > 0) { employee.overtimeCount++; employee.overtimeMinutes += overtime; }
      }
      for (const interval of merged) {
        const minutes = Math.floor((interval.end - interval.start) / 60000);
        employee.minutes += minutes;
        employee.shifts.push({id: interval.ids[0], day, start: interval.start, end: interval.end, minutes,
          plannedStart: plan?.plan_start || null, plannedEnd: plan?.plan_end || null,
          lateMinutes: interval === merged[0] && plan?.plan_start === '09:00' && startPlan !== null && interval.start > startPlan ? Math.ceil((interval.start - startPlan) / 60000) : 0,
          overtimeMinutes: interval === merged.at(-1) && plan && endPlan !== null && interval.end > endPlan ? Math.floor((interval.end - endPlan) / 60000) : 0,
          review: false, ...(interval.active ? {active: true} : {})});
      }
    }
    for (const plan of plans) {
      if (!plan.confirmed || plan.user_id !== employee.id || dayStart(plan.day) < start || dayStart(plan.day) + DAY > end) continue;
      const dayEnd = dayStart(plan.day) + DAY;
      if (dayEnd > asOf) continue;
      const plannedStart = clockMs(plan.day, plan.plan_start), plannedEnd = clockMs(plan.day, plan.plan_end);
      const dayIntervals = employee._attendanceIntervals.filter(interval => interval.day === plan.day);
      const attended = plannedStart !== null && plannedEnd !== null && plannedEnd > plannedStart
        ? dayIntervals.some(interval => interval.start < plannedEnd && interval.end > plannedStart)
        : employee._startedDays.has(plan.day);
      if (!attended) employee.noShowCount++;
    }
    delete employee._intervals; delete employee._attendanceIntervals; delete employee._startedDays;
  }
  const taskRows = admin.db.prepare('SELECT id,kind FROM station_tasks').all();
  const taskEvents = admin.db.prepare('SELECT task_id,actor,action,created_at,id FROM station_task_events WHERE created_at<? ORDER BY created_at,id').all(end);
  const taskCounts = occurrences(taskEvents, taskRows, start, end);
  for (const employee of employees) {
    Object.assign(employee, taskCounts.get(employee.id) || {taskCompleted: 0, oneOffCompleted: 0, regularCompleted: 0});
    employee.shifts.sort((a, b) => a.start - b.start || a.id - b.id);
  }
  return {employees, warnings};
}
