/* Plan 291 (#4031), Task 21 - the mock analysis run's e2e seams: roster frames,
   the book-busy answer, attach-not-restart, and the PUT call log. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockAnalyseManuscript, mockGetBookBusy, mockPutBookState } from './api';
import { ANALYSIS_NORTHERN_STAR } from '../mocks/canned-data';

const BOOK = ANALYSIS_NORTHERN_STAR.bookId;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('mockAnalyseManuscript', () => {
  it('emits growing roster frames, keeps the book busy until it resolves, and a second call attaches to the live run', async () => {
    expect(await mockGetBookBusy(BOOK)).toEqual([]);

    const frames: number[] = [];
    const first = mockAnalyseManuscript('mns_seam', {
      onCastUpdate: ({ characters }) => frames.push(characters.length),
    });
    expect(await mockGetBookBusy(BOOK)).toEqual(['analysis']);

    await vi.advanceTimersByTimeAsync(1000);
    /* A re-subscribe (the stream middleware's) never starts a second run. */
    const lateFrames: number[] = [];
    const second = mockAnalyseManuscript('mns_seam', {
      onCastUpdate: ({ characters }) => lateFrames.push(characters.length),
    });
    expect(second).toBe(first);

    await vi.advanceTimersByTimeAsync(60_000);
    const payload = await first;
    expect(await second).toBe(payload);

    const total = ANALYSIS_NORTHERN_STAR.characters.length;
    expect(frames).toHaveLength(3);
    expect(frames[2]).toBe(total);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
    expect(frames[0]).toBeLessThan(total);
    /* The late subscriber saw only the frames after it joined. */
    expect(lateFrames.length).toBeLessThanOrEqual(frames.length);
    expect(lateFrames[lateFrames.length - 1]).toBe(total);
    expect(await mockGetBookBusy(BOOK)).toEqual([]);

    /* A fresh call after the run ended starts a new one. */
    const again = mockAnalyseManuscript('mns_seam', {});
    expect(again).not.toBe(first);
    await vi.advanceTimersByTimeAsync(60_000);
    await again;
  });
});

describe('mockPutBookState call log', () => {
  it('appends every PUT, in order, to window.__castwrightMockCalls', async () => {
    const put = mockPutBookState('log-book', { slice: 'state', patch: { title: 'A' } });
    await vi.advanceTimersByTimeAsync(50);
    await put;
    const put2 = mockPutBookState('log-book', { slice: 'cast', patch: { characters: [] } });
    await vi.advanceTimersByTimeAsync(50);
    await put2;

    const calls = (globalThis as unknown as { __castwrightMockCalls: Array<{ bookId: string; req: { slice: string } }> })
      .__castwrightMockCalls;
    const mine = calls.filter((c) => c.bookId === 'log-book').map((c) => c.req.slice);
    expect(mine).toEqual(['state', 'cast']);
  });
});
