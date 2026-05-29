/* Wire-level tests for api.getAnalysisState — the cold-boot
   rehydration discovery endpoint introduced in plan 32 (E1/E2).

   Mocks global fetch so the test exercises the URL construction,
   the 404→null short-circuit, the non-200→throw branch, and the
   pass-through of the response body. Layout integration is
   exercised end-to-end via the acceptance walkthrough in
   docs/features/archive/32-sticky-analysis.md. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.getAnalysisState — cold-boot rehydration wire contract', () => {
  it('returns null on 404 (no rehydratable state)', async () => {
    /* The endpoint returns 404 in three cases (see book-state.ts):
       book not found, no manuscriptId in state.json, or no in-flight
       job AND no disk file. Callers (layout.tsx) treat all three as
       "no pill, leave the slice alone". */
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'No analysis state.' }), { status: 404 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const got = await api.getAnalysisState('book-id-1');
    expect(got).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/books/book-id-1/analysis/state');
  });

  it('returns the snapshot body on 200', async () => {
    const body = {
      manuscriptId: 'm_test',
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.42,
      state: 'paused' as const,
      engine: 'local' as const,
      lastTickAt: 1_700_000_000_000,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const got = await api.getAnalysisState('book-id-2');
    expect(got).toEqual(body);
  });

  it('passes through halted-state snapshots with haltCode + haltReason', async () => {
    const body = {
      manuscriptId: 'm_test',
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.7,
      state: 'halted' as const,
      haltCode: 'attribution_drift',
      haltReason: 'Phase 1 demoted 8% of sentences.',
      lastTickAt: 1_700_000_000_000,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const got = await api.getAnalysisState('book-id-3');
    expect(got).toMatchObject({
      state: 'halted',
      haltCode: 'attribution_drift',
      haltReason: 'Phase 1 demoted 8% of sentences.',
    });
  });

  it('throws on non-200/404 responses so the layout effect logs and moves on', async () => {
    /* 5xx is a server bug — the layout's catch logs and leaves the
       slice alone. We don't silently swallow because that masks the
       bug; the catch only suppresses the user-visible flash. */
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

    await expect(api.getAnalysisState('book-id-4')).rejects.toThrow(/500/);
  });

  it('URL-encodes the bookId so reserved characters in book slugs do not break the path', async () => {
    /* bookId is a slug like 'author__series__title' — no reserved
       characters today, but a future migration to richer ids
       shouldn't surprise the wire layer. */
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getAnalysisState('weird id/with slashes');
    expect(fetchMock).toHaveBeenCalledWith('/api/books/weird%20id%2Fwith%20slashes/analysis/state');
  });
});
