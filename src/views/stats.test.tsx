/* fs-16 F3 — the real #/stats Reading-column dashboard. The view fetches
   api.getLibraryStats() on mount and renders headline figures inside
   sentences, a 7-day sparkline, an in-progress completion list, and a
   per-series table. `today` is injected so the streak / last-7 math is
   deterministic in tests (PL2). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatsView } from './stats';
import { api } from '../lib/api';

/* byDay ends on 2026-06-13 with a 3-day run (11,12,13) → currentStreak 3.
   A separate earlier 4-day run (1,2,3,4 June) is the longest. Saturday
   2026-06-13 is the peak day. */
const PAYLOAD = {
  totalListenedSec: 47 * 3600 + 12 * 60, // 47h 12m
  booksFinished: 6,
  perBook: [
    { bookId: 'b-coalfall', title: 'The Coalfall Commission', completionPct: 1, finished: true },
    { bookId: 'b-hollow', title: 'Hollow Tide', completionPct: 0.78, finished: false },
    { bookId: 'b-never2', title: 'Neverseen · Book 2', completionPct: 0.54, finished: false },
    { bookId: 'b-unstarted', title: 'Unstarted Book', completionPct: 0, finished: false },
  ],
  perSeries: [
    { series: 'Neverseen', finishedCount: 1, importedCount: 3 },
    { series: 'Coalfall', finishedCount: 1, importedCount: 2 },
  ],
  byDay: [
    { date: '2026-06-01', seconds: 600 },
    { date: '2026-06-02', seconds: 600 },
    { date: '2026-06-03', seconds: 600 },
    { date: '2026-06-04', seconds: 600 },
    { date: '2026-06-11', seconds: 1200 },
    { date: '2026-06-12', seconds: 1800 },
    { date: '2026-06-13', seconds: 3600 }, // Saturday — peak day
  ],
};

describe('StatsView', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the headline lede with the formatted total and books finished', async () => {
    vi.spyOn(api, 'getLibraryStats').mockResolvedValue(PAYLOAD);
    render(<StatsView today="2026-06-13" />);
    // 47h 12m total listened
    expect(await screen.findByText(/47h 12m/)).toBeInTheDocument();
    // N = books with any listening (completionPct > 0) = 3
    const lede = await screen.findByTestId('stats-lede');
    expect(lede).toHaveTextContent('3 books');
    expect(lede).toHaveTextContent('6'); // booksFinished
  });

  it('renders the streak sentence with current + longest streaks', async () => {
    vi.spyOn(api, 'getLibraryStats').mockResolvedValue(PAYLOAD);
    render(<StatsView today="2026-06-13" />);
    const streak = await screen.findByTestId('stats-streak');
    // current run = 11,12,13 June ending today = 3 days
    expect(streak).toHaveTextContent('3-day');
    // longest run = 1,2,3,4 June = 4 days
    expect(streak).toHaveTextContent('4 days');
  });

  it('renders 7 sparkbars for the last week', async () => {
    vi.spyOn(api, 'getLibraryStats').mockResolvedValue(PAYLOAD);
    render(<StatsView today="2026-06-13" />);
    await screen.findByTestId('stats-lede');
    expect(screen.getAllByTestId('stats-sparkbar')).toHaveLength(7);
  });

  it('renders an in-progress completion row with its percentage', async () => {
    vi.spyOn(api, 'getLibraryStats').mockResolvedValue(PAYLOAD);
    render(<StatsView today="2026-06-13" />);
    expect(await screen.findByText('Hollow Tide')).toBeInTheDocument();
    expect(screen.getByText('78%')).toBeInTheDocument();
    // The unstarted (0%) book must NOT appear in the in-progress list.
    expect(screen.queryByText('Unstarted Book')).not.toBeInTheDocument();
  });

  it('renders a per-series line', async () => {
    vi.spyOn(api, 'getLibraryStats').mockResolvedValue(PAYLOAD);
    render(<StatsView today="2026-06-13" />);
    expect(await screen.findByText('Neverseen')).toBeInTheDocument();
    expect(screen.getByText(/1 of 3/)).toBeInTheDocument();
  });

  it('renders a friendly empty state on first run — never NaN', async () => {
    vi.spyOn(api, 'getLibraryStats').mockResolvedValue({
      totalListenedSec: 0,
      booksFinished: 0,
      perBook: [],
      perSeries: [],
      byDay: [],
    });
    const { container } = render(<StatsView today="2026-06-13" />);
    expect(await screen.findByTestId('stats-empty')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/NaN/);
  });

  it('handles a zero-streak gracefully (no active streak copy)', async () => {
    vi.spyOn(api, 'getLibraryStats').mockResolvedValue({
      ...PAYLOAD,
      // shift all listening to early June so neither today nor yesterday is active
      byDay: [
        { date: '2026-06-01', seconds: 600 },
        { date: '2026-06-02', seconds: 600 },
      ],
    });
    render(<StatsView today="2026-06-13" />);
    const streak = await screen.findByTestId('stats-streak');
    expect(streak).toHaveTextContent(/no active streak/i);
    expect(streak.textContent ?? '').not.toMatch(/NaN/);
  });
});
