// Pairs with docs/features/archive/53-mini-player-feature-pack.md

import { describe, expect, it } from 'vitest';
import {
  IDLE,
  SLEEP_TIMER_PRESETS_MIN,
  cancel,
  isFired,
  notifyChapterEnded,
  remainingMs,
  startCountdown,
  startEndOfChapter,
  tick,
} from './sleep-timer';

describe('sleep-timer — startCountdown + tick', () => {
  it('startCountdown stamps firesAt = now + durationMs', () => {
    const state = startCountdown(5 * 60 * 1000, 1_000);
    expect(state).toEqual({ kind: 'countdown', firesAt: 1_000 + 5 * 60 * 1000, durationMs: 300_000 });
  });

  it('tick before firesAt returns the same countdown state untouched', () => {
    const start = startCountdown(60_000, 1_000);
    const next = tick(start, 30_000);
    expect(next).toBe(start);
  });

  it('tick at exactly firesAt transitions to fired', () => {
    const start = startCountdown(60_000, 1_000);
    const next = tick(start, start.firesAt);
    expect(next).toEqual({ kind: 'fired', cause: 'countdown' });
  });

  it('tick past firesAt transitions to fired', () => {
    const start = startCountdown(60_000, 1_000);
    const next = tick(start, start.firesAt + 999);
    expect(isFired(next)).toBe(true);
  });

  it('tick is a no-op on idle / end-of-chapter / fired states', () => {
    expect(tick(IDLE, 99_999)).toBe(IDLE);
    const eoc = startEndOfChapter();
    expect(tick(eoc, 99_999)).toBe(eoc);
    const fired = tick(startCountdown(1, 0), 100);
    expect(tick(fired, 200)).toBe(fired);
  });
});

describe('sleep-timer — end-of-chapter mode', () => {
  it('notifyChapterEnded transitions end-of-chapter → fired with cause=end-of-chapter', () => {
    const state = startEndOfChapter();
    const next = notifyChapterEnded(state);
    expect(next).toEqual({ kind: 'fired', cause: 'end-of-chapter' });
  });

  it('notifyChapterEnded is a no-op on countdown / idle / fired states', () => {
    /* The countdown is wall-clock driven and ignores chapter boundaries. */
    const c = startCountdown(60_000);
    expect(notifyChapterEnded(c)).toBe(c);
    expect(notifyChapterEnded(IDLE)).toBe(IDLE);
    const fired = tick(startCountdown(1, 0), 100);
    expect(notifyChapterEnded(fired)).toBe(fired);
  });
});

describe('sleep-timer — cancel', () => {
  it('cancel before fire is a no-op on the eventual fire path', () => {
    /* Start a countdown, cancel it, then advance past the original
       firesAt — must NOT fire because cancel() returned idle. */
    const original = startCountdown(60_000, 1_000);
    const cancelled = cancel();
    expect(cancelled).toEqual(IDLE);
    const ticked = tick(cancelled, original.firesAt + 10_000);
    expect(isFired(ticked)).toBe(false);
    expect(ticked).toBe(cancelled);
  });

  it('cancel idempotent on already-idle state', () => {
    expect(cancel()).toEqual(IDLE);
    expect(cancel()).toEqual(cancel());
  });
});

describe('sleep-timer — remainingMs + presets', () => {
  it('remainingMs returns null for non-countdown states', () => {
    expect(remainingMs(IDLE, 100)).toBeNull();
    expect(remainingMs(startEndOfChapter(), 100)).toBeNull();
    const fired = tick(startCountdown(1, 0), 100);
    expect(remainingMs(fired, 100)).toBeNull();
  });

  it('remainingMs counts down from durationMs to 0', () => {
    const state = startCountdown(60_000, 1_000);
    expect(remainingMs(state, 1_000)).toBe(60_000);
    expect(remainingMs(state, 31_000)).toBe(30_000);
    expect(remainingMs(state, state.firesAt)).toBe(0);
  });

  it('remainingMs clamps to 0 when now > firesAt', () => {
    const state = startCountdown(60_000, 1_000);
    expect(remainingMs(state, state.firesAt + 10_000)).toBe(0);
  });

  it('exposes the documented preset list (15 / 30 / 45 / 60 min)', () => {
    expect(SLEEP_TIMER_PRESETS_MIN).toEqual([15, 30, 45, 60]);
  });
});
