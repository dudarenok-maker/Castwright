import { describe, it, expect } from 'vitest';
import { StatsAccumulator } from './listen-stats-reporter';

const day = (iso: string) => new Date(iso).getTime();

describe('StatsAccumulator', () => {
  it('accrues wall-clock while playing, ignores paused time', () => {
    let t = day('2026-06-13T10:00:00');
    const acc = new StatsAccumulator('book-1', () => t, () => '2026-06-13');
    acc.onPlay();
    t += 10_000;
    acc.onPause();
    t += 60_000;
    acc.onPlay();
    t += 5_000;
    const drained = acc.drain();
    expect(drained).toEqual({ sessionPresent: true, days: [{ date: '2026-06-13', seconds: 15 }] });
  });

  it('attributes to the active book and flushes prior book on switch', () => {
    let t = day('2026-06-13T10:00:00');
    const dateStr = '2026-06-13';
    const acc = new StatsAccumulator('book-1', () => t, () => dateStr);
    acc.onPlay();
    t += 20_000;
    const handoff = acc.switchBook('book-2');
    expect(handoff).toEqual({ bookId: 'book-1', days: [{ date: '2026-06-13', seconds: 20 }] });
    t += 10_000;
    expect(acc.drain().days).toEqual([{ date: '2026-06-13', seconds: 10 }]);
  });

  it('splits a play interval across local midnight', () => {
    let t = day('2026-06-13T23:59:50');
    let dateStr = '2026-06-13';
    const acc = new StatsAccumulator('b', () => t, () => dateStr);
    acc.onPlay();
    t += 10_000; dateStr = '2026-06-13'; acc.tick();
    t += 10_000; dateStr = '2026-06-14'; acc.tick();
    const d = acc.drain().days;
    expect(d).toContainEqual({ date: '2026-06-13', seconds: 10 });
    expect(d).toContainEqual({ date: '2026-06-14', seconds: 10 });
  });

  it('drain reports sessionPresent false before any play', () => {
    const acc = new StatsAccumulator('b', () => 0, () => '2026-06-13');
    expect(acc.drain()).toEqual({ sessionPresent: false, days: [] });
  });
});
