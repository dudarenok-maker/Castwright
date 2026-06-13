import { describe, it, expect } from 'vitest';
import {
  validateStatsBody, mergeStatsDays, sumAllSeconds, byDayTotals,
  type ListenStatsFile,
} from './listen-stats.js';

const NOW = Date.parse('2026-06-13T12:00:00Z');

describe('validateStatsBody', () => {
  const ok = { sessionId: 's1', days: [{ date: '2026-06-13', seconds: 120 }] };
  it('accepts a well-formed body', () => {
    expect(validateStatsBody(ok, NOW)).toBeNull();
  });
  it('rejects missing/empty sessionId', () => {
    expect(validateStatsBody({ ...ok, sessionId: '' }, NOW)).toMatch(/sessionId/);
  });
  it('rejects > 366 days', () => {
    const days = Array.from({ length: 367 }, () => ({ date: '2026-01-01', seconds: 1 }));
    expect(validateStatsBody({ sessionId: 's', days }, NOW)).toMatch(/366/);
  });
  it('rejects a non-ISO date', () => {
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '13-06-2026', seconds: 1 }] }, NOW)).toMatch(/date/);
  });
  it('rejects a far-future date', () => {
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '2099-01-01', seconds: 1 }] }, NOW)).toMatch(/future/);
  });
  it('rejects an absurd-past date (before 2020)', () => {
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '1999-01-01', seconds: 1 }] }, NOW)).toMatch(/past/);
  });
  it('rejects seconds out of [0, 86400]', () => {
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '2026-06-13', seconds: -1 }] }, NOW)).toMatch(/seconds/);
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '2026-06-13', seconds: 90000 }] }, NOW)).toMatch(/seconds/);
  });
  it('rejects a roll-over invalid calendar date', () => {
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '2026-02-30', seconds: 1 }] }, NOW)).toMatch(/calendar|date/);
  });
});

describe('mergeStatsDays', () => {
  const base: ListenStatsFile = {
    schema: 1,
    perDay: [{ date: '2026-06-13', sessions: [{ sessionId: 's1', seconds: 100 }] }],
  };
  it('adds a new session slot for the same day', () => {
    const out = mergeStatsDays(base, 's2', [{ date: '2026-06-13', seconds: 50 }]);
    const day = out.perDay.find((d) => d.date === '2026-06-13')!;
    expect(day.sessions).toHaveLength(2);
    expect(day.sessions.find((s) => s.sessionId === 's2')!.seconds).toBe(50);
  });
  it('upserts an existing slot with max() (never lowers)', () => {
    const grown = mergeStatsDays(base, 's1', [{ date: '2026-06-13', seconds: 250 }]);
    expect(grown.perDay[0].sessions[0].seconds).toBe(250);
    const stale = mergeStatsDays(grown, 's1', [{ date: '2026-06-13', seconds: 90 }]);
    expect(stale.perDay[0].sessions[0].seconds).toBe(250);
  });
  it('creates a new day entry', () => {
    const out = mergeStatsDays(base, 's1', [{ date: '2026-06-14', seconds: 10 }]);
    expect(out.perDay.map((d) => d.date).sort()).toEqual(['2026-06-13', '2026-06-14']);
  });
  it('does not mutate the input file', () => {
    const snapshot = JSON.stringify(base);
    mergeStatsDays(base, 's9', [{ date: '2026-06-13', seconds: 999 }]);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('sumAllSeconds / byDayTotals', () => {
  const file: ListenStatsFile = {
    schema: 1,
    perDay: [
      { date: '2026-06-12', sessions: [{ sessionId: 'a', seconds: 100 }, { sessionId: 'b', seconds: 40 }] },
      { date: '2026-06-13', sessions: [{ sessionId: 'a', seconds: 200 }] },
    ],
  };
  it('sums every session across every day', () => {
    expect(sumAllSeconds([file])).toBe(340);
  });
  it('produces per-date totals merged across files', () => {
    const totals = byDayTotals([file, file]);
    expect(totals['2026-06-12']).toBe(280);
    expect(totals['2026-06-13']).toBe(400);
  });
});
