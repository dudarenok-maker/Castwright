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
  readDemoWhatsNewOverride,
  buildMockAppInfo,
  loadMockReleaseNotes,
  trimUnreleasedReleaseNotes,
  nextMinorVersion,
  mockGetAppInfo,
  mockDismissWhatsNew,
  _resetMockAppInfo,
  readCastDesignStream,
  mockCreateCharacter,
  mockGetScriptReviewState,
  mockResolveScriptReviewOps,
  mockPatchScriptReviewSelection,
  mockScriptReviewKey,
  mockReviewScript,
  mockCancelScriptReview,
  mockAttachScriptReview,
  ReviewScriptError,
  mockGetSidecarHealth,
  type LedgerEntryDTO,
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

describe('buildMockAppInfo (mock chrome tracks the build)', () => {
  it('derives every version field from buildInfo instead of a hardcoded literal', async () => {
    const { buildInfo } = await import('./build-info');
    const info = buildMockAppInfo('# Castwright 9.9.9\n\n- Note.\n');
    expect(info.appVersion).toBe(buildInfo.version);
    expect(info.sidecarVersion).toBe(buildInfo.version);
    expect(info.lastSeenAppVersion).toBe(buildInfo.version);
    // Regression for the frozen fixture that sat on v1.6.0 for six minors.
    expect(info.appVersion).not.toBe('1.6.0');
    expect(info.releaseNotes).toBe('# Castwright 9.9.9\n\n- Note.\n');
  });
});

describe('loadMockReleaseNotes (real bundled notes, lazily loaded)', () => {
  it('serves the real multi-version RELEASE_NOTES.md, not the old frozen one-liner', async () => {
    const { parseReleaseNotes } = await import('./release-notes');
    const parsed = parseReleaseNotes(await loadMockReleaseNotes());
    /* The retired fixture ('# v1.6.0 / - In-app upgrades.') would fail both:
       one section, and a bare 'v1.6.0' heading without the brand name. */
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed[0].heading).toMatch(/^Castwright \d+\.\d+\.\d+/);
    expect(parsed[0].bullets.length).toBeGreaterThan(0);
  });
});

describe('trimUnreleasedReleaseNotes (mid-cycle in-progress section)', () => {
  const MD =
    '# Castwright 1.13.0\n\n- Unreleased bullet.\n\n# Castwright 1.12.2\n\n- Shipped bullet.\n\n# Castwright 1.12.1\n\n- Older bullet.\n';

  it('drops leading sections newer than the running version', () => {
    const out = trimUnreleasedReleaseNotes(MD, '1.12.2');
    expect(out.startsWith('# Castwright 1.12.2')).toBe(true);
    expect(out).not.toContain('Unreleased bullet');
    expect(out).toContain('Older bullet');
  });

  it('serves the document unchanged when the running version has no section (dev builds)', () => {
    expect(trimUnreleasedReleaseNotes(MD, '0.0.0-dev')).toBe(MD);
  });

  it('does not match a version embedded in a longer version string', () => {
    const md = '# Castwright 11.2.0\n\n- Big.\n\n# Castwright 1.2.0\n\n- Small.\n';
    expect(trimUnreleasedReleaseNotes(md, '1.2.0').startsWith('# Castwright 1.2.0')).toBe(true);
  });

  it('is not defeated by an unreleased heading that merely mentions the running version', () => {
    const md =
      '# Castwright 1.13.0 — follow-ups to 1.12.2\n\n- Unreleased bullet.\n\n# Castwright 1.12.2\n\n- Shipped bullet.\n';
    const out = trimUnreleasedReleaseNotes(md, '1.12.2');
    expect(out.startsWith('# Castwright 1.12.2')).toBe(true);
    expect(out).not.toContain('Unreleased bullet');
  });

  it('a hotfix version with no section of its own still drops newer sections', () => {
    // package.json cut to 1.12.3 without a notes section; 1.13.0 is in progress.
    const out = trimUnreleasedReleaseNotes(MD, '1.12.3');
    expect(out.startsWith('# Castwright 1.12.2')).toBe(true);
    expect(out).not.toContain('Unreleased bullet');
  });
});

describe('demoWhatsNew dismiss latch (seam → dismiss → refetch)', () => {
  beforeEach(() => {
    _resetMockAppInfo();
    window.history.replaceState(null, '', '/?demoWhatsNew=1');
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    _resetMockAppInfo();
  });

  it('the seam shows the banner, and Dismiss keeps it dismissed across a refetch', async () => {
    expect((await mockGetAppInfo()).showWhatsNew).toBe(true);
    await mockDismissWhatsNew();
    /* The regression this pins: the refetch used to OR the URL override back
       in, resurrecting the banner right after a successful dismiss. */
    expect((await mockGetAppInfo()).showWhatsNew).toBe(false);
  });
});

describe('nextMinorVersion (mock staged-upgrade candidate)', () => {
  it('bumps the minor and zeroes the patch', () => {
    expect(nextMinorVersion('1.12.2')).toBe('1.13.0');
  });

  it('falls back gracefully for a non-semver dev sentinel', () => {
    expect(nextMinorVersion('0.0.0-dev')).toBe('0.1.0');
    expect(nextMinorVersion('weird')).toBe('weird-next');
  });
});

describe('readDemoWhatsNewOverride (marketing-capture banner seam)', () => {
  it('defaults off when the param is absent or malformed', () => {
    expect(readDemoWhatsNewOverride('')).toBe(false);
    expect(readDemoWhatsNewOverride('?foo=bar')).toBe(false);
    expect(readDemoWhatsNewOverride('?demoWhatsNew=0')).toBe(false);
  });

  it('honours ?demoWhatsNew=1', () => {
    expect(readDemoWhatsNewOverride('?demoWhatsNew=1')).toBe(true);
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
    expect(fetch).toHaveBeenCalledWith(
      '/api/books/book-1/script-review/resolve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ chapterId: 3, version: 2, appliedOpKeys: ['3:1:strip_tag'] }) }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('patchScriptReviewSelection PATCHes chapterId/version/selected and returns { ok }', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ ok: false }) });
    const result = await api.patchScriptReviewSelection('book-1', { chapterId: 3, version: 2, selected: { '3:1:strip_tag': false } });
    expect(fetch).toHaveBeenCalledWith(
      '/api/books/book-1/script-review/selection',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ chapterId: 3, version: 2, selected: { '3:1:strip_tag': false } }) }),
    );
    expect(result).toEqual({ ok: false });
  });
});

/* fs-58 persistence PR-review fix (Finding 2) — the mock-mode resolve/
   selection endpoints were no-op stubs that never touched the
   sessionStorage-backed mock ledger (unlike mockGetScriptReviewState /
   mockDiscardScriptReview, which correctly read/write it). Drives the mock
   functions directly (like mockCreateCharacter above) rather than through
   `api.*`, since `api` in this test env resolves to the real, fetch-based
   functions (VITE_USE_MOCKS is off) — see the "script-review persistence
   endpoints" describe block above. Seeds the ledger via the same
   sessionStorage key format the mock reads/writes
   (mockScriptReviewKey/LedgerEntryDTO), mirroring how mockReviewScript
   seeds it in real usage. */
describe('mock-mode script-review resolve/selection persistence (fs-58 PR-review Finding 2)', () => {
  const bookId = 'book-mock-1';

  beforeEach(() => {
    sessionStorage.clear();
  });

  function seedLedger(entries: Record<string, LedgerEntryDTO>) {
    sessionStorage.setItem(mockScriptReviewKey(bookId), JSON.stringify({ running: null, entries }));
  }

  it('mockResolveScriptReviewOps removes the named op and mockGetScriptReviewState reflects it', async () => {
    seedLedger({
      '3': {
        manuscriptId: bookId,
        version: 2,
        ops: [
          { id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' },
          { id: 2, op: 'fix_emotion', emotion: 'sad', rationale: 'r' },
        ],
        selected: { '3:1:strip_tag': true, '3:2:fix_emotion': false },
        completedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await mockResolveScriptReviewOps(bookId, {
      chapterId: 3,
      version: 2,
      appliedOpKeys: ['3:1:strip_tag'],
    });
    expect(result).toEqual({ ok: true });

    const state = await mockGetScriptReviewState(bookId);
    expect(state.kind).toBe('ledger');
    if (state.kind !== 'ledger') throw new Error('expected ledger');
    // The resolved op is gone; the other op (and its selection) survives.
    expect(state.entries['3'].ops).toEqual([{ id: 2, op: 'fix_emotion', emotion: 'sad', rationale: 'r' }]);
    expect(state.entries['3'].selected).toEqual({ '3:2:fix_emotion': false });
  });

  it('mockResolveScriptReviewOps deletes the entry entirely once every op is resolved', async () => {
    seedLedger({
      '3': {
        manuscriptId: bookId,
        version: 2,
        ops: [{ id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' }],
        selected: { '3:1:strip_tag': true },
        completedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    await mockResolveScriptReviewOps(bookId, { chapterId: 3, version: 2, appliedOpKeys: ['3:1:strip_tag'] });

    const state = await mockGetScriptReviewState(bookId);
    if (state.kind !== 'ledger') throw new Error('expected ledger');
    expect(state.entries['3']).toBeUndefined();
  });

  it('mockResolveScriptReviewOps on a version mismatch returns { ok: false } and mutates nothing', async () => {
    seedLedger({
      '3': {
        manuscriptId: bookId,
        version: 2,
        ops: [{ id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' }],
        selected: {},
        completedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await mockResolveScriptReviewOps(bookId, {
      chapterId: 3,
      version: 99, // stale
      appliedOpKeys: ['3:1:strip_tag'],
    });
    expect(result).toEqual({ ok: false });

    const state = await mockGetScriptReviewState(bookId);
    if (state.kind !== 'ledger') throw new Error('expected ledger');
    expect(state.entries['3'].ops).toEqual([{ id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' }]);
  });

  it('mockPatchScriptReviewSelection merges into the ledger entry\'s selected map', async () => {
    seedLedger({
      '3': {
        manuscriptId: bookId,
        version: 5,
        ops: [
          { id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' },
          { id: 2, op: 'fix_emotion', emotion: 'sad', rationale: 'r' },
        ],
        selected: { '3:1:strip_tag': true },
        completedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await mockPatchScriptReviewSelection(bookId, {
      chapterId: 3,
      version: 5,
      selected: { '3:2:fix_emotion': false },
    });
    expect(result).toEqual({ ok: true });

    const state = await mockGetScriptReviewState(bookId);
    if (state.kind !== 'ledger') throw new Error('expected ledger');
    // Merged, not replaced — the pre-existing key survives alongside the new one.
    expect(state.entries['3'].selected).toEqual({
      '3:1:strip_tag': true,
      '3:2:fix_emotion': false,
    });
  });

  it('mockPatchScriptReviewSelection on a version mismatch returns { ok: false } and mutates nothing', async () => {
    seedLedger({
      '3': {
        manuscriptId: bookId,
        version: 5,
        ops: [{ id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' }],
        selected: { '3:1:strip_tag': true },
        completedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await mockPatchScriptReviewSelection(bookId, {
      chapterId: 3,
      version: 1, // stale
      selected: { '3:1:strip_tag': false },
    });
    expect(result).toEqual({ ok: false });

    const state = await mockGetScriptReviewState(bookId);
    if (state.kind !== 'ledger') throw new Error('expected ledger');
    expect(state.entries['3'].selected).toEqual({ '3:1:strip_tag': true });
  });
});

describe('mock-mode script-review cancellation (fs-58 follow-up #1481)', () => {
  const cancelBookId = 'book-mock-cancel';

  beforeEach(() => {
    sessionStorage.clear();
  });

  it('mockCancelScriptReview clears the running flag and reports cancelled:true when a job was running', async () => {
    sessionStorage.setItem(mockScriptReviewKey(cancelBookId), JSON.stringify({
      running: { lastPhase: { progress: 0.5, label: 'Reviewing script' } },
      entries: {},
    }));
    const result = await mockCancelScriptReview(cancelBookId);
    expect(result).toEqual({ ok: true, cancelled: true });
    const state = await mockGetScriptReviewState(cancelBookId);
    expect(state.kind).toBe('ledger');
  });

  it('mockCancelScriptReview is idempotent — cancelled:false when nothing is running', async () => {
    const result = await mockCancelScriptReview(cancelBookId);
    expect(result).toEqual({ ok: true, cancelled: false });
  });

  it('mockAttachScriptReview resolves to null when nothing is running', async () => {
    const result = await mockAttachScriptReview(cancelBookId, {});
    expect(result).toBeNull();
  });

  it('mockAttachScriptReview delegates to the same canned timeline as mockReviewScript when a job is running, so a reload can observe it complete', async () => {
    // Deliberately does NOT seed a custom onPhase/result here — a running
    // job in mock mode is just "mockReviewScript's own promise, still
    // in flight," and attach's job is to give a NEW caller (e.g. after a
    // page reload destroyed the original caller's JS context) a way to
    // keep observing the SAME canned timeline to completion, not a
    // separate, shorter, hand-rolled seed. See the comment on
    // mockAttachScriptReview's implementation (Step 8 below) for why: a
    // version that only seeded onPhase once and returned immediately
    // would make src/store/script-review-thunk.ts's reattach fallback
    // (Task 5) fire almost instantly after a reload, breaking
    // e2e/script-review-persistence.spec.ts's existing
    // "reloading mid-review resumes progress without resetting to 0%"
    // test, which relies on the pill staying populated with a
    // NON-ZERO percent well past the moment of reload.
    sessionStorage.setItem(mockScriptReviewKey(cancelBookId), JSON.stringify({
      running: { lastPhase: { progress: 0.25, label: 'Reviewing script' } },
      entries: {},
    }));
    const phases: Array<{ progress: number }> = [];
    const result = await mockAttachScriptReview(cancelBookId, { onPhase: (p) => phases.push(p) });
    expect(phases.length).toBeGreaterThan(0);
    expect(result).toEqual({ reviewedChapters: 1, totalOps: 5 });
  });

  it('mockReviewScript throws a cancelled-coded ReviewScriptError if mockCancelScriptReview clears the running flag mid-run', async () => {
    const runPromise = mockReviewScript(cancelBookId, {});
    // Let the mock reach its first phase tick (60ms) before cancelling —
    // exercises the ordinary between-ticks throwIfCancelled() path.
    await new Promise((r) => setTimeout(r, 100));
    await mockCancelScriptReview(cancelBookId);

    let caught: unknown;
    try {
      await runPromise;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewScriptError);
    expect((caught as InstanceType<typeof ReviewScriptError>).code).toBe('cancelled');
  });

  /* Regression for the code-review-workflow finding: a cancel landing
     BEFORE the first phase tick (i.e. inside the initial 60ms wait) used
     to be silently undone — the first tick's own unconditional write set
     `running` back to non-null (mistaking the just-cancelled state for
     "hasn't started yet"), so throwIfCancelled never saw the cancel and
     the "cancelled" review silently ran to completion. mockReviewScript
     now marks itself running synchronously, before any await, closing
     the window entirely. */
  it('a cancel landing in the initial window (before the first phase tick) is not silently undone by that tick', async () => {
    const runPromise = mockReviewScript(cancelBookId, {});
    // No delay — cancel as close to immediately as possible, well inside
    // the first tick's 60ms wait.
    await mockCancelScriptReview(cancelBookId);

    let caught: unknown;
    try {
      await runPromise;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewScriptError);
    expect((caught as InstanceType<typeof ReviewScriptError>).code).toBe('cancelled');
  });

  /* Regression for the code-review-workflow finding: mockAttachScriptReview
     delegates a resumed reattach back into mockReviewScript, which used to
     restart its canned timeline unconditionally from the first tick (25%)
     — so reattaching after a LATE reload (e.g. at 85%) would visibly
     regress the pill backward to 25% before it climbed again, exactly the
     "visibly reset" regression the reattach design explicitly says to
     avoid. mockReviewScript now reads the already-recorded progress at
     call time and skips re-emitting any tick at or below it. */
  it('a resumed mockReviewScript timeline never re-emits a phase tick at or below the progress it was seeded with', async () => {
    sessionStorage.setItem(mockScriptReviewKey(cancelBookId), JSON.stringify({
      running: { lastPhase: { progress: 0.5, label: 'Reviewing script' } },
      entries: {},
    }));
    const phases: Array<{ progress: number }> = [];
    await mockAttachScriptReview(cancelBookId, { onPhase: (p) => phases.push(p) });
    // Only the 85% tick (the one genuinely ahead of the seeded 50%) fires —
    // the 25% and 50% ticks are both skipped, so the pill never regresses.
    expect(phases.map((p) => p.progress)).toEqual([0.85]);
  });
});

describe('mockGetSidecarHealth', () => {
  it('reports whisperPackageInstalled: true', async () => {
    const health = await mockGetSidecarHealth();
    expect(health.whisperPackageInstalled).toBe(true);
  });
});
