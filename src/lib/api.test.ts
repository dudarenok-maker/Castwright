import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mockGetSetupReadiness,
  mockCompleteSetup,
  mockRunSmokeTest,
  mockPutListenStats,
  mockGetLibraryStats,
  mockGetContinueListening,
  mockSetShelfStatus,
  _resetMockListenStats,
  readE2eUpdateOverride,
  readE2eWorkspaceRootOverride,
  readCastDesignStream,
  mockCreateCharacter,
  api,
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
    expect(first.blockers.tts.status).toBe('fail');
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

  it('setShelfStatus(finished) prunes the seeded shelf so a refetch drops the book', async () => {
    (globalThis as any).__SEED_CONTINUE__ = [
      { bookId: 'keep', title: 'Keep', chapterId: 1, currentSec: 90, remainingSec: 600, completionPct: 0.1, updatedAt: '2026-06-13T00:00:00Z' },
      { bookId: 'gone', title: 'Gone', chapterId: 1, currentSec: 90, remainingSec: 600, completionPct: 0.1, updatedAt: '2026-06-13T00:00:00Z' },
    ];
    const rec = await mockSetShelfStatus('gone', { finished: true });
    expect(rec.finished).toBe(true);
    const out = await mockGetContinueListening();
    expect(out.map((x: any) => x.bookId)).toEqual(['keep']);
    delete (globalThis as any).__SEED_CONTINUE__;
  });

  it('setShelfStatus(hidden) also prunes the shelf', async () => {
    (globalThis as any).__SEED_CONTINUE__ = [
      { bookId: 'h', title: 'H', chapterId: 1, currentSec: 90, remainingSec: 600, completionPct: 0.1, updatedAt: '2026-06-13T00:00:00Z' },
    ];
    await mockSetShelfStatus('h', { hidden: true });
    expect(await mockGetContinueListening()).toEqual([]);
    delete (globalThis as any).__SEED_CONTINUE__;
  });
});

describe('api.reviewScript', () => {
  it('parses the SSE stream and surfaces ops', async () => {
    const chunks = [
      'data: {"kind":"ops","chapterId":1,"ops":[{"id":1,"op":"strip_tag","newText":"x","rationale":"tag"}]}\n\n',
      'data: {"kind":"result","reviewedChapters":1,"totalOps":1}\n\n',
    ].map((s) => new TextEncoder().encode(s));
    let i = 0;
    const body = { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) };
    global.fetch = (async () => ({ ok: true, status: 200, body })) as never;
    const seen: unknown[] = [];
    const res = await api.reviewScript('b1', { onOps: (e) => seen.push(e) });
    expect(seen).toHaveLength(1);
    expect(res.totalOps).toBe(1);
  });
});

describe('readCastDesignStream — variant_designed fallback fields (srv-52)', () => {
  function fakeResponse(sseText: string): Response {
    const encoded = new TextEncoder().encode(sseText);
    let consumed = false;
    const body = {
      getReader: () => ({
        read: async () => {
          if (!consumed) {
            consumed = true;
            return { done: false, value: encoded };
          }
          return { done: true, value: undefined };
        },
      }),
    };
    return { ok: true, status: 200, body } as unknown as Response;
  }

  it('passes viaFallback through onVariantDesigned', async () => {
    const got: unknown[] = [];
    await readCastDesignStream(
      fakeResponse(
        'event: variant_designed\ndata: {"type":"variant_designed","characterId":"c","emotion":"angry","voiceId":"v","viaFallback":true,"fallbackReason":"corrupt"}\n\n',
      ),
      { onVariantDesigned: (e) => got.push(e) },
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ viaFallback: true, fallbackReason: 'corrupt' });
  });

  it('omits viaFallback when not present in event', async () => {
    const got: unknown[] = [];
    await readCastDesignStream(
      fakeResponse(
        'event: variant_designed\ndata: {"type":"variant_designed","characterId":"c","emotion":"neutral","voiceId":"v"}\n\n',
      ),
      { onVariantDesigned: (e) => got.push(e) },
    );
    expect(got).toHaveLength(1);
    expect((got[0] as Record<string, unknown>).viaFallback).toBeUndefined();
  });
});

describe('readE2eUpdateOverride (fe-27 update override)', () => {
  it('defaults update fields off when the param is absent', () => {
    expect(readE2eUpdateOverride('')).toEqual({ updateAvailable: false, latestVersion: null });
    expect(readE2eUpdateOverride('?foo=bar')).toEqual({ updateAvailable: false, latestVersion: null });
  });

  it('honours ?e2eUpdate=<version>', () => {
    expect(readE2eUpdateOverride('?e2eUpdate=9.9.9')).toEqual({
      updateAvailable: true,
      latestVersion: '9.9.9',
    });
  });
});

describe('readE2eWorkspaceRootOverride (bug #1298)', () => {
  it('defaults to null when the param is absent', () => {
    expect(readE2eWorkspaceRootOverride('')).toBeNull();
    expect(readE2eWorkspaceRootOverride('?foo=bar')).toBeNull();
  });

  it('honours ?e2eWorkspaceRoot=<path>', () => {
    expect(readE2eWorkspaceRootOverride('?e2eWorkspaceRoot=C%3A%5CLong%5CPath')).toBe(
      'C:\\Long\\Path',
    );
  });
});

describe('mockCreateCharacter (fs-58 Unit B)', () => {
  it('mints a deterministic slug id from name', async () => {
    const { character: c } = await mockCreateCharacter('b1', { name: 'Ferra', gender: 'female' });
    expect(c.name).toBe('Ferra');
    expect(c.id).toMatch(/ferra/);
    expect(c.voiceState).toBe('generated');
  });

  it('returns a full Character with required fields (id, name, role, color)', async () => {
    const { character: c } = await mockCreateCharacter('b1', { name: 'The Narrator' });
    expect(c.id).toBe('the_narrator');
    expect(c.role).toBe('character');
    expect(c.color).toBe('unset');
    expect(c.voiceState).toBe('generated');
  });

  it('preserves optional gender and ageRange fields', async () => {
    const { character: c } = await mockCreateCharacter('b2', {
      name: 'Old Crow',
      gender: 'male',
      ageRange: 'elderly',
      role: 'narrator',
    });
    expect(c.gender).toBe('male');
    expect(c.ageRange).toBe('elderly');
    expect(c.role).toBe('narrator');
  });

  it('is registered on the api object (mock surface)', () => {
    expect(typeof api.createCharacter).toBe('function');
  });
});

describe('script-review persistence endpoints', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getScriptReviewState GETs the state endpoint and returns the parsed body', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'ledger', entries: {} }),
    });
    const result = await api.getScriptReviewState('book-1');
    expect(fetch).toHaveBeenCalledWith('/api/books/book-1/script-review/state', expect.objectContaining({ method: 'GET' }));
    expect(result).toEqual({ kind: 'ledger', entries: {} });
  });

  it('discardScriptReview POSTs the chapter ids', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await api.discardScriptReview('book-1', [3, 4]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/books/book-1/script-review/discard',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ chapterIds: [3, 4] }) }),
    );
  });

  it('resolveScriptReviewOps POSTs chapterId/version/appliedOpKeys and returns { ok }', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const result = await api.resolveScriptReviewOps('book-1', { chapterId: 3, version: 2, appliedOpKeys: ['3:1:strip_tag'] });
    expect(result).toEqual({ ok: true });
  });

  it('patchScriptReviewSelection PATCHes chapterId/version/selected and returns { ok }', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ ok: false }) });
    const result = await api.patchScriptReviewSelection('book-1', { chapterId: 3, version: 2, selected: { '3:1:strip_tag': false } });
    expect(result).toEqual({ ok: false });
  });
});
