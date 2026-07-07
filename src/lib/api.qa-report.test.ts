/* Wire-level tests for api.getQaReport — the per-book performance-QA
   report endpoint (fs-51).

   Mocks global fetch so the test exercises the URL construction and the
   pass-through of the response body, mirroring api-analysis-state.test.ts's
   pattern: import `{ api }` and call it directly, relying on the default
   (non-mock) VITE_USE_MOCKS test env to resolve `api.getQaReport` to the
   `real` implementation. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.getQaReport — wire contract', () => {
  it('fetches the book-scoped QA report endpoint and returns the body', async () => {
    const body = {
      bookId: 'b1',
      generatedAt: '2026-01-01T00:00:00Z',
      chaptersRendered: 1,
      chaptersTotal: 1,
      totalLines: 10,
      acoustic: { linesChecked: 10, linesRerecorded: 0, chaptersFlagged: 0 },
      asr: { linesVerified: 0, linesFlaggedDrift: 0 },
      voiceDrift: {
        attribution: 'full' as const,
        chaptersEligible: 0,
        chaptersScored: 0,
        chaptersEmbedFailed: 0,
        charactersOnRoster: 0,
        charactersChecked: 0,
        mismatches: [],
        inconclusiveCount: 0,
        uncheckedCharacterIds: [],
      },
      configDrift: { counts: { mild: 0, moderate: 0, severe: 0 }, events: [] },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const report = await api.getQaReport('b1');
    expect(report.bookId).toBe('b1');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/books/b1/qa-report'));
  });

  it('throws on a non-ok response, surfacing the status and response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

    await expect(api.getQaReport('b1')).rejects.toThrow(/QA report fetch failed \(500\): boom/);
  });

  it('URL-encodes the bookId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getQaReport('weird id/with slashes');
    expect(fetchMock).toHaveBeenCalledWith('/api/books/weird%20id%2Fwith%20slashes/qa-report');
  });
});
