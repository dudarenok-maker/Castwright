/* fs-16 — pure date-relative stats from the server's byDay totals, computed
   against the viewing client's local "today" (passed in, so this is testable
   and timezone-correct per the viewer). A day is "active" when seconds > 0.
   Streak rule: consecutive active days ending on the most recent active day,
   counted as current only if that day is today or yesterday (one grace day). */
export interface DayTotal { date: string; seconds: number; }

const DAY_MS = 86_400_000;
const toUTC = (d: string): number => Date.parse(d + 'T00:00:00Z');
const toDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function activeDates(byDay: DayTotal[]): Set<string> {
  return new Set(byDay.filter((d) => d.seconds > 0).map((d) => d.date));
}

export function currentStreak(byDay: DayTotal[], today: string): number {
  const active = activeDates(byDay);
  const todayMs = toUTC(today);
  let cursor: number;
  if (active.has(today)) cursor = todayMs;
  else if (active.has(toDate(todayMs - DAY_MS))) cursor = todayMs - DAY_MS;
  else return 0;
  let streak = 0;
  while (active.has(toDate(cursor))) { streak++; cursor -= DAY_MS; }
  return streak;
}

export function longestStreak(byDay: DayTotal[]): number {
  const days = [...activeDates(byDay)].map(toUTC).sort((a, b) => a - b);
  let best = 0, run = 0, prev = Number.NaN;
  for (const ms of days) {
    run = ms - prev === DAY_MS ? run + 1 : 1;
    best = Math.max(best, run);
    prev = ms;
  }
  return best;
}

export function last7Days(byDay: DayTotal[], today: string): DayTotal[] {
  const map = new Map(byDay.map((d) => [d.date, d.seconds]));
  const todayMs = toUTC(today);
  const out: DayTotal[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = toDate(todayMs - i * DAY_MS);
    out.push({ date, seconds: map.get(date) ?? 0 });
  }
  return out;
}
