import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const EVENTS = Object.freeze([
  'cafe_started', 'cafe_item_added', 'cafe_item_removed', 'cafe_modifier_selected',
  'cafe_payment_started', 'cafe_completed', 'rental_started', 'rental_item_added',
  'rental_item_removed', 'rental_modifier_selected', 'rental_payment_started',
  'rental_completed', 'rental_extended', 'rental_returned', 'search', 'click', 'repeated_click', 'navigation_back',
  'scenario_cancelled', 'action_failed',
]);
export const SCREENS = Object.freeze([
  'cafe_pos', 'cafe_order', 'cafe_payment', 'rental_pos', 'rental_order',
  'rental_payment', 'booking_search', 'dashboard',
]);
export const ACTIONS = Object.freeze([
  'start', 'add', 'remove', 'select_modifier', 'pay', 'complete', 'search',
  'click', 'repeated_click', 'back', 'cancel', 'fail', 'extend', 'return',
]);
export const RESULTS = Object.freeze(['success', 'failure', 'cancelled', 'blocked']);
export const ERROR_CODES = Object.freeze([
  'validation', 'unavailable', 'timeout', 'conflict', 'permission', 'unknown',
]);

const WINDOW_FILE = 'window.json';
const EVENTS_DIR = 'events';
const REPORT_DIR = 'reports';
const REPORT_FILE = 'ux-audit-72h.md';
const MAX_EVENTS = 100_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const MAX_RATE_KEYS = 1000;
const EVENT_KEYS = Object.freeze([
  'id', 'employee_session_id', 'scenario_id', 'event', 'screen', 'action',
  'result', 'error_code', 'seq', 'elapsed_ms',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function auditError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validWindow(value) {
  return value && Object.keys(value).sort().join(',') === 'endsAt,id,startedAt'
    && typeof value.id === 'string' && UUID.test(value.id) && Number.isSafeInteger(value.startedAt)
    && Number.isSafeInteger(value.endsAt) && value.endsAt > value.startedAt;
}

function isUuid(value) { return typeof value === 'string' && UUID.test(value); }

async function readWindow(directory) {
  let value;
  try { value = JSON.parse(await readFile(join(directory, WINDOW_FILE), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw auditError('UX audit window is malformed.', 503);
  }
  if (!validWindow(value)) throw auditError('UX audit window is malformed.', 503);
  return value;
}

function readWindowSync(directory) {
  try {
    const value = JSON.parse(readFileSync(join(directory, WINDOW_FILE), 'utf8'));
    return validWindow(value) ? value : null;
  } catch { return null; }
}

async function readEventLog(path) {
  let content;
  try {
    const info = await stat(path);
    if (info.size > MAX_FILE_BYTES) throw auditError('UX audit event file is oversized.', 413);
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!content) return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events = [];
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { throw auditError('UX audit event file is malformed.', 503); }
    if (!validateEvent(event)) throw auditError('UX audit event file is malformed.', 503);
    events.push(event);
    if (events.length > MAX_EVENTS) throw auditError('UX audit event limit reached.', 413);
  }
  return events;
}

function validateEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(',') !== [...EVENT_KEYS].sort().join(',')) return false;
  return isUuid(value.id) && isUuid(value.employee_session_id)
    && isUuid(value.scenario_id) && EVENTS.includes(value.event)
    && SCREENS.includes(value.screen) && ACTIONS.includes(value.action)
    && RESULTS.includes(value.result)
    && (value.error_code === null || ERROR_CODES.includes(value.error_code))
    && Number.isInteger(value.seq) && value.seq >= 0 && value.seq <= 100_000
    && Number.isInteger(value.elapsed_ms) && value.elapsed_ms >= 0
    && value.elapsed_ms <= MAX_DURATION_MS;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'events')
      || !Array.isArray(payload.events) || payload.events.length > 8) {
    throw auditError('Invalid UX audit payload.', 400);
  }
  for (const event of payload.events) {
    if (!validateEvent(event)) throw auditError('Invalid UX audit event.', 400);
  }
}

async function privateMkdir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function privateSubdir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicPrivateWrite(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export async function startUxAudit(directory, { now = Date.now(), durationMs = 72 * 3600000 } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('directory is required');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(durationMs) || durationMs <= 0
      || !Number.isSafeInteger(now + durationMs)) {
    throw new TypeError('Invalid UX audit window timing.');
  }
  await privateMkdir(directory);
  const lockPath = join(directory, 'window.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw auditError('UX audit activation is already in progress.', 409);
    throw error;
  }
  try {
    await chmod(lockPath, 0o600);
    const current = await readWindow(directory);
    if (current && current.endsAt > now) throw auditError('A UX audit window is already active.', 409);
    const window = { id: randomUUID(), startedAt: now, endsAt: now + durationMs };
    const eventsDirectory = join(directory, EVENTS_DIR);
    await privateSubdir(eventsDirectory);
    const file = await open(join(eventsDirectory, `${window.id}.jsonl`), 'wx', 0o600);
    await file.close();
    await chmod(join(eventsDirectory, `${window.id}.jsonl`), 0o600);
    await atomicPrivateWrite(join(directory, WINDOW_FILE), `${JSON.stringify(window)}\n`);
    return { id: window.id, startedAt: window.startedAt, endsAt: window.endsAt };
  } finally {
    try { await lock.close(); }
    finally { await unlink(lockPath).catch(() => {}); }
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function formatDuration(ms) {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} с`;
}

function buildReport(window, events) {
  const counts = new Map();
  const sessions = new Set();
  const scenarioEvents = new Map();
  let errors = 0;
  let repeatedClicks = 0;
  for (const event of events) {
    counts.set(event.event, (counts.get(event.event) || 0) + 1);
    sessions.add(event.employee_session_id);
    if (event.event === 'action_failed' || event.result === 'failure') errors++;
    if (event.event === 'repeated_click') repeatedClicks++;
    const type = event.event.startsWith('cafe_') ? 'cafe' : event.event.startsWith('rental_') ? 'rental' : null;
    if (type && (event.event === `${type}_started` || event.event === `${type}_completed`)) {
      const key = `${event.employee_session_id}:${event.scenario_id}:${type}`;
      const group = scenarioEvents.get(key) || { type, events: [] };
      group.events.push(event);
      scenarioEvents.set(key, group);
    }
  }
  const completed = { cafe: [], rental: [] };
  const incomplete = { cafe: 0, rental: 0 };
  const orphan = { cafe: 0, rental: 0 };
  for (const group of scenarioEvents.values()) {
    const ordered = group.events.map((value, index) => ({ value, index }))
      .sort((a, b) => a.value.seq - b.value.seq || a.index - b.index).map(item => item.value);
    const starts = [];
    for (const item of ordered) {
      if (item.event === `${group.type}_started`) starts.push(item);
      else {
        let index = starts.findIndex(start => start.seq < item.seq && item.elapsed_ms >= start.elapsed_ms);
        if (index < 0) orphan[group.type]++;
        else {
          const [start] = starts.splice(index, 1);
          completed[group.type].push(item.elapsed_ms - start.elapsed_ms);
        }
      }
    }
    incomplete[group.type] += starts.length;
  }
  const lines = [
    '# UX-аудит за 72 часа', '',
    `Окно: ${new Date(window.startedAt).toISOString()} — ${new Date(window.endsAt).toISOString()}.`,
    `Событий: ${events.length}. Сессий: ${sessions.size}. Ошибок: ${errors}. Повторных нажатий: ${repeatedClicks}.`, '',
    '## События', '',
  ];
  if (counts.size) for (const [name, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) lines.push(`- ${name}: ${count}`);
  else lines.push('- Нет событий.');
  lines.push('', '## Завершённые сценарии', '');
  for (const type of ['cafe', 'rental']) {
    const values = completed[type];
    lines.push(`- ${type === 'cafe' ? 'Кафе' : 'Прокат'}: ${values.length} завершено; медиана ${values.length ? formatDuration(percentile(values, 0.5)) : 'нет данных'}; p90 ${values.length ? formatDuration(percentile(values, 0.9)) : 'нет данных'}.`);
    lines.push(`  Незавершённых: ${incomplete[type]}; завершение без подходящего старта: ${orphan[type]}.`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function createUxAudit({ directory, enabled = false, now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  let disabled = enabled !== true;
  let broken = false;
  let operation = Promise.resolve();
  const rates = new Map();
  let eventCache = null;
  const clock = () => {
    const value = now();
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('now must return a safe integer.');
    return value;
  };
  const enqueue = task => {
    const result = operation.then(task);
    operation = result.catch(() => {});
    return result;
  };
  const config = () => {
    if (disabled || broken) return { enabled: false, startedAt: null, endsAt: null };
    const window = readWindowSync(directory);
    if (!window) broken = true;
    const active = Boolean(window) && !disabled && !broken && clock() < window.endsAt;
    return { enabled: active, startedAt: window?.startedAt ?? null, endsAt: window?.endsAt ?? null };
  };

  async function currentWindow() {
    if (disabled || broken) return null;
    try {
      const window = await readWindow(directory);
      if (!window) { broken = true; return null; }
      return window;
    } catch {
      broken = true;
      return null;
    }
  }

  async function loadEventCache(window) {
    if (eventCache?.id === window.id) return eventCache;
    const path = join(directory, EVENTS_DIR, `${window.id}.jsonl`);
    const events = await readEventLog(path);
    let bytes = 0;
    try { bytes = (await stat(path)).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    eventCache = { id: window.id, ids: new Set(events.map(item => item.id)), count: events.length, bytes };
    return eventCache;
  }

  async function writeReport(window) {
    try {
      const events = await readEventLog(join(directory, EVENTS_DIR, `${window.id}.jsonl`));
      const report = buildReport(window, events);
      const reportDir = join(directory, REPORT_DIR);
      await privateSubdir(reportDir);
      await atomicPrivateWrite(join(reportDir, REPORT_FILE), report);
      disabled = true;
      return report;
    } catch {
      broken = true;
      return null;
    }
  }

  async function tick() {
    if (disabled || broken) return null;
    return enqueue(async () => {
      const window = await currentWindow();
      if (!window || clock() < window.endsAt) return null;
      return writeReport(window);
    });
  }

  async function capture(payload, rateKey) {
    if (disabled || broken) return { accepted: 0 };
    validatePayload(payload);
    if (typeof rateKey !== 'string' || !rateKey || rateKey.length > 200) throw auditError('Invalid rate key.', 400);
    return enqueue(async () => {
      const window = await currentWindow();
      if (!window) return { accepted: 0 };
      const timestamp = clock();
      if (timestamp >= window.endsAt) { await writeReport(window); return { accepted: 0, expired: true }; }
      for (const [key, bucket] of rates) {
        if (timestamp < bucket.startedAt || timestamp - bucket.startedAt >= 60_000) rates.delete(key);
      }
      let bucket = rates.get(rateKey);
      if (!bucket) {
        if (rates.size >= MAX_RATE_KEYS) throw auditError('UX audit rate limit capacity reached.', 429);
        bucket = { startedAt: timestamp, batches: 0 };
        rates.set(rateKey, bucket);
      }
      if (bucket.batches >= 60) throw auditError('UX audit rate limit exceeded.', 429);
      bucket.batches++;
      const path = join(directory, EVENTS_DIR, `${window.id}.jsonl`);
      let cached;
      try { cached = await loadEventCache(window); }
      catch (error) {
        eventCache = null;
        if (error.status === 503 || error.status === 413) broken = true;
        throw error;
      }
      const batchIds = new Set();
      const fresh = payload.events.filter(event => {
        if (cached.ids.has(event.id) || batchIds.has(event.id)) return false;
        batchIds.add(event.id);
        return true;
      });
      if (cached.count + fresh.length > MAX_EVENTS) throw auditError('UX audit event limit reached.', 413);
      if (!fresh.length) return { accepted: 0, duplicates: payload.events.length };
      const addition = fresh.map(event => `${JSON.stringify(event)}\n`).join('');
      const additionBytes = Buffer.byteLength(addition);
      if (cached.bytes + additionBytes > MAX_FILE_BYTES) throw auditError('UX audit event file is oversized.', 413);
      try {
        const file = await open(path, 'a', 0o600);
        try { await file.writeFile(addition); } finally { await file.close(); }
        await chmod(path, 0o600);
      } catch (error) {
        eventCache = null;
        throw error;
      }
      for (const event of fresh) cached.ids.add(event.id);
      cached.count += fresh.length;
      cached.bytes += additionBytes;
      return { accepted: fresh.length, duplicates: payload.events.length - fresh.length };
    });
  }

  return {
    config,
    capture,
    tick,
    report: async () => {
      if (disabled || broken) return null;
      const window = await currentWindow();
      if (!window || clock() < window.endsAt) return null;
      return tick();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory] = process.argv.slice(2);
  if (!directory || !['--start', '--report'].includes(command)) {
    process.stderr.write('Usage: node server/ux-audit.mjs --start|--report DIRECTORY\n');
    process.exitCode = 2;
  } else if (command === '--start') {
    try {
      const window = await startUxAudit(directory);
      process.stdout.write(`UX audit window started; ends ${new Date(window.endsAt).toISOString()}.\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.status === 409 ? 1 : 2;
    }
  } else {
    const audit = createUxAudit({ directory, enabled: true });
    const report = await audit.report();
    if (report) process.stdout.write('UX audit report written privately.\n');
    else process.stdout.write('Report is not ready or audit data is invalid.\n');
  }
}
