/* fs-16 — per-book listening-stats domain. Pure (no IO). The on-disk file
   stores ABSOLUTE wall-clock seconds keyed per (date, sessionId); the server
   SUMS sessions per day. Upserts take max() so an out-of-order/stale retry
   can't lower a higher stored absolute (a session's per-(book,date) total is
   monotonic). See the design spec, decisions D2/D3/S2. */

export interface StatsSessionSlot { sessionId: string; seconds: number; }
export interface StatsDay { date: string; sessions: StatsSessionSlot[]; }
export interface ListenStatsFile { schema: 1; perDay: StatsDay[]; }

export interface StatsDayInput { date: string; seconds: number; }
export interface StatsPutBody { sessionId: string; days: StatsDayInput[]; }

const MAX_DAYS_PER_PUT = 366;
const MAX_SECONDS_PER_DAY = 86400;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const PAST_FLOOR_MS = Date.parse('2020-01-01T00:00:00Z');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyStatsFile(): ListenStatsFile {
  return { schema: 1, perDay: [] };
}

/** Returns null when valid, else a short reason for a 400. */
export function validateStatsBody(raw: unknown, now: number): string | null {
  if (!raw || typeof raw !== 'object') return 'body must be an object';
  const b = raw as Partial<StatsPutBody>;
  if (typeof b.sessionId !== 'string' || b.sessionId.length === 0) return 'sessionId must be a non-empty string';
  if (!Array.isArray(b.days)) return 'days must be an array';
  if (b.days.length > MAX_DAYS_PER_PUT) return `days must have at most ${MAX_DAYS_PER_PUT} entries`;
  for (const d of b.days) {
    if (!d || typeof d !== 'object') return 'each day must be an object';
    const day = d as Partial<StatsDayInput>;
    if (typeof day.date !== 'string' || !ISO_DATE.test(day.date)) {
      return 'day.date must be an ISO YYYY-MM-DD string';
    }
    // Round-trip guard: Date.parse accepts roll-over dates (2026-02-30 -> Mar 2),
    // so re-serialize and compare to reject invalid calendar dates.
    const parsedDate = new Date(day.date + 'T00:00:00Z');
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== day.date) {
      return 'day.date must be a valid calendar date';
    }
    const t = Date.parse(day.date);
    if (t > now + FUTURE_SKEW_MS) return 'day.date is too far in the future';
    if (t < PAST_FLOOR_MS) return 'day.date is too far in the past';
    if (typeof day.seconds !== 'number' || !Number.isFinite(day.seconds) || day.seconds < 0 || day.seconds > MAX_SECONDS_PER_DAY) {
      return `day.seconds must be a finite number in [0, ${MAX_SECONDS_PER_DAY}]`;
    }
  }
  return null;
}

/** Pure merge: upsert each (date, sessionId) slot to max(existing, incoming).
    Returns a NEW file object (does not mutate input). */
export function mergeStatsDays(
  file: ListenStatsFile,
  sessionId: string,
  days: StatsDayInput[],
): ListenStatsFile {
  const byDate = new Map<string, StatsSessionSlot[]>();
  for (const d of file.perDay) byDate.set(d.date, d.sessions.map((s) => ({ ...s })));
  for (const { date, seconds } of days) {
    const slots = byDate.get(date) ?? [];
    const existing = slots.find((s) => s.sessionId === sessionId);
    if (existing) existing.seconds = Math.max(existing.seconds, seconds);
    else slots.push({ sessionId, seconds });
    byDate.set(date, slots);
  }
  return {
    schema: 1,
    perDay: [...byDate.entries()]
      .map(([date, sessions]) => ({ date, sessions }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

export function sumAllSeconds(files: ListenStatsFile[]): number {
  let total = 0;
  for (const f of files) for (const d of f.perDay) for (const s of d.sessions) total += s.seconds;
  return total;
}

/** date -> summed seconds across every session in every supplied file. */
export function byDayTotals(files: ListenStatsFile[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) for (const d of f.perDay) {
    const daySum = d.sessions.reduce((n, s) => n + s.seconds, 0);
    out[d.date] = (out[d.date] ?? 0) + daySum;
  }
  return out;
}
