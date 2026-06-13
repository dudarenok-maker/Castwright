import { describe, it, expect, beforeEach } from 'vitest';
import {
  mockGetSetupReadiness,
  mockCompleteSetup,
  mockRunSmokeTest,
  mockPutListenStats,
  mockGetLibraryStats,
  mockGetContinueListening,
  _resetMockListenStats,
} from './api';

describe('mockGetSetupReadiness', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.location.hash = '#/';
  });

  it('returns ready by default', async () => {
    const r = await mockGetSetupReadiness();
    expect(r.ready).toBe(true);
  });

  it('latches not-ready from the setup=notready param and persists it across nav', async () => {
    window.location.hash = '#/?setup=notready';
    const first = await mockGetSetupReadiness();
    expect(first.ready).toBe(false);
    expect(first.blockers.tts).toBe('fail');
    window.location.hash = '#/setup';
    const second = await mockGetSetupReadiness();
    expect(second.ready).toBe(false);
  });
});

describe('mockCompleteSetup', () => {
  it('resolves an ISO completedAt', async () => {
    const r = await mockCompleteSetup();
    expect(typeof r.completedAt).toBe('string');
    expect(new Date(r.completedAt).toISOString()).toBe(r.completedAt);
  });
});

describe('mockRunSmokeTest', () => {
  it('resolves ok:true with an audio url', async () => {
    const r = await mockRunSmokeTest();
    expect(r.ok).toBe(true);
    expect(typeof r.url).toBe('string');
    expect(r.analyzerOk).toBe(true);
  });
});

describe('mock listen-stats client', () => {
  beforeEach(() => {
    _resetMockListenStats();
  });

  it('putListenStats merges (max) and getLibraryStats reflects total', async () => {
    await mockPutListenStats('book-1', {
      sessionId: 's1',
      days: [{ date: '2026-06-13', seconds: 120 }],
    });
    await mockPutListenStats('book-1', {
      sessionId: 's1',
      days: [{ date: '2026-06-13', seconds: 30 }],
    }); // stale lower
    const stats = await mockGetLibraryStats();
    expect(stats.totalListenedSec).toBeGreaterThanOrEqual(120); // not 150, not 30
    expect(stats.totalListenedSec).toBeLessThan(150); // proves no double-count
  });

  it('getContinueListening reads a seeded list', async () => {
    (globalThis as any).__SEED_CONTINUE__ = [
      {
        bookId: 'b',
        title: 'B',
        chapterId: 1,
        currentSec: 90,
        remainingSec: 600,
        completionPct: 0.1,
        updatedAt: '2026-06-13T00:00:00Z',
      },
    ];
    const out = await mockGetContinueListening();
    expect(out[0].bookId).toBe('b');
    delete (globalThis as any).__SEED_CONTINUE__;
  });

  it('getContinueListening returns empty array when no seed', async () => {
    const out = await mockGetContinueListening();
    expect(out).toEqual([]);
  });
});
