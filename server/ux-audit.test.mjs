import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIONS, EVENTS, ERROR_CODES, RESULTS, SCREENS,
  createUxAudit, startUxAudit,
} from './ux-audit.mjs';

const baseTime = 1_800_000_000_000;
const uuid = () => crypto.randomUUID();
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ux-audit-'));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function event(overrides = {}) {
  return {
    id: uuid(), employee_session_id: uuid(), scenario_id: uuid(),
    event: 'cafe_started', screen: 'cafe_pos', action: 'start', result: 'success',
    error_code: null, seq: 0, elapsed_ms: 0, ...overrides,
  };
}

test('disabled instance makes no filesystem access', async () => {
  const directory = join(tmpdir(), `ux-audit-absent-${uuid()}`);
  const audit = createUxAudit({ directory });
  assert.deepEqual(await audit.config(), { enabled: false, startedAt: null, endsAt: null });
  assert.deepEqual(await audit.capture({ events: [event()] }, 'user'), { accepted: 0 });
  assert.equal(await audit.tick(), null);
  assert.equal(await audit.report(), null);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('starts and persists a private window without replacing active window', async t => {
  const f = await fixture(); t.after(f.cleanup);
  if (process.platform !== 'win32') await chmod(f.directory, 0o755);
  const started = await startUxAudit(f.directory, { now: baseTime, durationMs: 1000 });
  const persisted = JSON.parse(await readFile(join(f.directory, 'window.json'), 'utf8'));
  assert.deepEqual(persisted, started);
  if (process.platform !== 'win32') assert.equal((await stat(join(f.directory, 'window.json'))).mode & 0o077, 0);
  if (process.platform !== 'win32') assert.equal((await stat(f.directory)).mode & 0o777, 0o755);
  await assert.rejects(startUxAudit(f.directory, { now: baseTime + 999 }), { status: 409 });
  const next = await startUxAudit(f.directory, { now: baseTime + 1000, durationMs: 2000 });
  assert.notEqual(next.id, started.id);
  assert.equal((await readdir(join(f.directory, 'events'))).length, 2);
});

test('rejects unsafe timing and preserves a malformed persisted window', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const options of [
    { now: String(baseTime) },
    { now: baseTime, durationMs: Number.MAX_SAFE_INTEGER },
    { now: Number.MAX_SAFE_INTEGER - 5, durationMs: 10 },
  ]) await assert.rejects(startUxAudit(f.directory, options), TypeError);
  const { writeFile } = await import('node:fs/promises');
  const contents = '{"not":"a window"}';
  await writeFile(join(f.directory, 'window.json'), contents);
  await assert.rejects(startUxAudit(f.directory, { now: baseTime }), { status: 503 });
  assert.equal(await readFile(join(f.directory, 'window.json'), 'utf8'), contents);
});

test('serializes simultaneous activations with an exclusive lock', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const results = await Promise.allSettled([
    startUxAudit(f.directory, { now: baseTime }),
    startUxAudit(f.directory, { now: baseTime }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await readdir(join(f.directory, 'events'))).length, 1);
});

test('exposes config without the persisted window identity', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await startUxAudit(f.directory, { now: baseTime, durationMs: 1000 });
  const audit = createUxAudit({ directory: f.directory, enabled: true, now: () => baseTime });
  assert.deepEqual(audit.config(), { enabled: true, startedAt: baseTime, endsAt: baseTime + 1000 });
});

test('rejects payloads with text, extra keys, unknown enums, bad UUIDs, or bounds', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await startUxAudit(f.directory, { now: baseTime });
  const audit = createUxAudit({ directory: f.directory, enabled: true, now: () => baseTime });
  const valid = event();
  for (const payload of [
    { events: [ { ...valid, label: 'private text' } ] },
    { events: [ { ...valid, event: 'customer_order' } ] },
    { events: [ { ...valid, scenario_id: 'order-123' } ] },
    { events: [ { ...valid, seq: 100_001 } ] },
    { events: [ { ...valid, elapsed_ms: 14_400_001 } ] },
    { events: [ { ...valid, error_code: 'email' } ] },
    { events: [ { ...valid, action: 'https://example.com' } ] },
    { events: [valid, valid, valid, valid, valid, valid, valid, valid, valid] },
    { events: [], employeeId: 'x' },
  ]) await assert.rejects(audit.capture(payload, 'user'), { status: 400 });
  assert.equal(EVENTS.includes('cafe_completed'), true);
  assert.equal(SCREENS.includes('rental_payment'), true);
  assert.equal(ACTIONS.includes('repeated_click'), true);
  assert.equal(EVENTS.includes('rental_extended'), true);
  assert.equal(EVENTS.includes('rental_returned'), true);
  assert.equal(ACTIONS.includes('extend'), true);
  assert.equal(ACTIONS.includes('return'), true);
  assert.equal(RESULTS.includes('success'), true);
  assert.ok(ERROR_CODES.length > 0);
});

test('deduplicates event IDs across captures and process restarts', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await startUxAudit(f.directory, { now: baseTime });
  const first = createUxAudit({ directory: f.directory, enabled: true, now: () => baseTime });
  const row = event();
  assert.deepEqual(await first.capture({ events: [row, row] }, 'auth-user'), { accepted: 1, duplicates: 1 });
  const restarted = createUxAudit({ directory: f.directory, enabled: true, now: () => baseTime });
  assert.deepEqual(await restarted.capture({ events: [row] }, 'auth-user'), { accepted: 0, duplicates: 1 });
  const log = await readFile(join(f.directory, 'events', `${JSON.parse(await readFile(join(f.directory, 'window.json'), 'utf8')).id}.jsonl`), 'utf8');
  assert.equal(log.trim().split('\n').length, 1);
});

test('invalidates cache after partial append failure and disables on malformed log reload', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const started = await startUxAudit(f.directory, { now: baseTime });
  const audit = createUxAudit({ directory: f.directory, enabled: true, now: () => baseTime });
  const row = event();
  const logPath = join(f.directory, 'events', `${started.id}.jsonl`);
  const probe = await open(logPath, 'a');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWriteFile = prototype.writeFile;
  prototype.writeFile = async function (content) {
    await originalWriteFile.call(this, content.slice(0, 8));
    throw new Error('simulated partial append');
  };
  try {
    await assert.rejects(audit.capture({ events: [row] }, 'auth-user'), /simulated partial append/);
  } finally {
    prototype.writeFile = originalWriteFile;
  }
  await assert.rejects(audit.capture({ events: [row] }, 'auth-user'), { status: 503 });
  assert.deepEqual(await audit.capture({ events: [row] }, 'auth-user'), { accepted: 0 });
});

test('enforces the batch limiter per authenticated rate key', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await startUxAudit(f.directory, { now: baseTime });
  const audit = createUxAudit({ directory: f.directory, enabled: true, now: () => baseTime });
  for (let i = 0; i < 60; i++) await audit.capture({ events: [] }, 'auth-user');
  await assert.rejects(audit.capture({ events: [] }, 'auth-user'), { status: 429 });
  assert.deepEqual(await audit.capture({ events: [] }, 'other-user'), { accepted: 0, duplicates: 0 });
});

test('bounds rate keys and removes expired keys before admitting a new key', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await startUxAudit(f.directory, { now: baseTime });
  let clock = baseTime;
  const audit = createUxAudit({ directory: f.directory, enabled: true, now: () => clock });
  for (let i = 0; i < 1000; i++) await audit.capture({ events: [] }, `user-${i}`);
  await assert.rejects(audit.capture({ events: [] }, 'user-over-capacity'), { status: 429 });
  clock += 60_000;
  assert.deepEqual(await audit.capture({ events: [] }, 'user-after-expiry'), { accepted: 0, duplicates: 0 });
});

test('deadline stops capture and produces a Russian aggregate report', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const start = await startUxAudit(f.directory, { now: baseTime, durationMs: 1000 });
  let clock = baseTime;
  const audit = createUxAudit({ directory: f.directory, enabled: true, now: () => clock });
  const session = uuid();
  const scenario = uuid();
  await audit.capture({ events: [
    event({ employee_session_id: session, scenario_id: scenario, event: 'cafe_started' }),
    event({ employee_session_id: session, scenario_id: scenario, event: 'repeated_click', screen: 'cafe_order', action: 'repeated_click', elapsed_ms: 60000 }),
    event({ employee_session_id: session, scenario_id: scenario, event: 'cafe_completed', screen: 'cafe_order', action: 'complete', elapsed_ms: 120000 }),
  ] }, 'authenticated-user-id');
  clock = start.endsAt;
  assert.deepEqual(audit.config(), { enabled: false, startedAt: baseTime, endsAt: start.endsAt });
  assert.equal(await audit.tick(), await readFile(join(f.directory, 'reports', 'ux-audit-72h.md'), 'utf8'));
  assert.match(await readFile(join(f.directory, 'reports', 'ux-audit-72h.md'), 'utf8'), /Сессий: 1\. Ошибок: 0\. Повторных нажатий: 1\./);
  assert.match(await audit.report() ?? '', /^$/);
  assert.deepEqual(await audit.capture({ events: [] }, 'authenticated-user-id'), { accepted: 0 });
});

test('reports only same-session, same-type scenarios with chronological matching events', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const started = await startUxAudit(f.directory, { now: baseTime, durationMs: 1000 });
  let clock = baseTime;
  const audit = createUxAudit({ directory: f.directory, enabled: true, now: () => clock });
  const session = uuid();
  const validScenario = uuid();
  const orphanScenario = uuid();
  const typeMismatchScenario = uuid();
  const orderMismatchScenario = uuid();
  await audit.capture({ events: [
    event({ employee_session_id: session, scenario_id: validScenario, event: 'cafe_started', seq: 1, elapsed_ms: 0 }),
    event({ employee_session_id: session, scenario_id: validScenario, event: 'cafe_completed', action: 'complete', seq: 2, elapsed_ms: 12_500 }),
    event({ employee_session_id: uuid(), scenario_id: orphanScenario, event: 'cafe_completed', action: 'complete', seq: 2, elapsed_ms: 20_000 }),
    event({ employee_session_id: session, scenario_id: typeMismatchScenario, event: 'rental_started', screen: 'rental_pos', seq: 1 }),
    event({ employee_session_id: session, scenario_id: typeMismatchScenario, event: 'cafe_completed', action: 'complete', seq: 2, elapsed_ms: 10_000 }),
    event({ employee_session_id: session, scenario_id: orderMismatchScenario, event: 'cafe_completed', action: 'complete', seq: 4, elapsed_ms: 10_000 }),
    event({ employee_session_id: session, scenario_id: orderMismatchScenario, event: 'cafe_started', seq: 5, elapsed_ms: 0 }),
  ] }, 'auth-user');
  clock = started.endsAt;
  const report = await audit.tick();
  assert.match(report, /Кафе: 1 завершено; медиана 12\.5 с; p90 12\.5 с\./);
  assert.match(report, /Незавершённых: 1; завершение без подходящего старта: 3\./);
  assert.match(report, /Прокат: 0 завершено; медиана нет данных; p90 нет данных\./);
  assert.match(report, /Незавершённых: 1; завершение без подходящего старта: 0\./);
});

test('writes an explicit zero-event report and catches up after restart', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const started = await startUxAudit(f.directory, { now: baseTime, durationMs: 1000 });
  const overdue = createUxAudit({ directory: f.directory, enabled: true, now: () => started.endsAt + 1 });
  const report = await overdue.report();
  assert.match(report, /Событий: 0\. Сессий: 0\. Ошибок: 0\. Повторных нажатий: 0\./);
  assert.match(report, /Нет событий/);
  const repeat = createUxAudit({ directory: f.directory, enabled: true, now: () => started.endsAt + 1 });
  assert.equal(await repeat.tick(), report);
  assert.equal((await readdir(join(f.directory, 'reports'))).length, 1);
});

test('malformed persisted window disables cleanly without returning file contents', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(f.directory, 'window.json'), '{"private":"do not expose"}', { mode: 0o600 });
  const audit = createUxAudit({ directory: f.directory, enabled: true, now: () => baseTime });
  assert.deepEqual(audit.config(), { enabled: false, startedAt: null, endsAt: null });
  assert.equal(await audit.report(), null);
});
