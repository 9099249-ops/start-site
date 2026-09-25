export type Records = { best: number | null; maxStars: number; races: number; day: string; daily: number | null };
const key = 'start_sup_records_v1';
export function today() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
export function readRecords(): Records {
  const empty: Records = { best: null, maxStars: 0, races: 0, day: today(), daily: null };
  try {
    const r = JSON.parse(localStorage.getItem(key) || 'null');
    if (!r || typeof r !== 'object') return empty;
    const validTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
    return {
      best: validTime(r.best) ? r.best : null,
      maxStars: Number.isInteger(r.maxStars) ? Math.max(0, Math.min(5, r.maxStars)) : 0,
      races: Number.isInteger(r.races) ? Math.max(0, r.races) : 0,
      day: today(), daily: r.day === today() && validTime(r.daily) ? r.daily : null,
    };
  } catch { return empty; }
}
export function saveResult(time: number, stars: number) {
  const r = readRecords(), newBest = r.best === null || time < r.best;
  r.best = Math.min(r.best ?? Infinity, time); r.daily = Math.min(r.daily ?? Infinity, time);
  r.maxStars = Math.max(r.maxStars, stars); r.races++;
  let saved = true;
  try { localStorage.setItem(key, JSON.stringify(r)); } catch { saved = false; }
  return { records: r, newBest, saved };
}
export function formatTime(t: number | null) {
  if (t === null) return '—:—';
  return `${Math.floor(t / 60).toString().padStart(2, '0')}:${Math.floor(t % 60).toString().padStart(2, '0')}`;
}
export function track(name: string, detail: Record<string, unknown> = {}) {
  // A website can subscribe to this without sending any data to a third party.
  window.dispatchEvent(new CustomEvent('start-sup:analytics', { detail: { event: name, ...detail } }));
}
