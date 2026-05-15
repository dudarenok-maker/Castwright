/* Tests for the base-voice catalog. Mocks global fetch so the Coqui
   branch resolves deterministically against a fake `/speakers` response;
   asserts the fall-back path when the sidecar is unreachable. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invalidateBaseVoiceCache, listBaseVoices } from './base-voices.js';

const SIDECAR_URL = 'http://sidecar.test:9000';

const realFetch = globalThis.fetch;

beforeEach(() => {
  invalidateBaseVoiceCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockSpeakersResponse(speakers: string[]) {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const target = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;
    if (target.endsWith('/speakers')) {
      return new Response(JSON.stringify({ coqui: speakers }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

function mockSidecarDown() {
  globalThis.fetch = vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

describe('listBaseVoices', () => {
  it('merges live Coqui /speakers with the static Gemini catalog', async () => {
    mockSpeakersResponse(['Asya Anara', 'Damien Black', 'Sofia Hellen']);
    const voices = await listBaseVoices({ sidecarUrl: SIDECAR_URL });
    const coqui = voices.filter(v => v.engine === 'coqui').map(v => v.name);
    const gemini = voices.filter(v => v.engine === 'gemini').map(v => v.name);
    expect(coqui).toContain('Asya Anara');
    expect(coqui).toContain('Damien Black');
    expect(coqui).toContain('Sofia Hellen');
    /* Sanity-check a couple Gemini voices the catalog always has. */
    expect(gemini).toContain('Charon');
    expect(gemini).toContain('Kore');
    /* Gemini section should be the full published catalog (30 voices) so
       the picker offers more than just the bucketed 16. */
    expect(gemini.length).toBeGreaterThanOrEqual(30);
  });

  it('falls back to the static catalog when the sidecar is unreachable so the UI does not go empty', async () => {
    mockSidecarDown();
    const voices = await listBaseVoices({ sidecarUrl: SIDECAR_URL });
    const coqui = voices.filter(v => v.engine === 'coqui').map(v => v.name);
    /* COQUI_PROFILE_VOICES contains these — sidecar fallback uses that
       catalog so the picker still has something to offer. */
    expect(coqui).toContain('Asya Anara');
    expect(coqui).toContain('Damien Black');
    /* Gemini section is always static, unaffected by sidecar state. */
    const gemini = voices.filter(v => v.engine === 'gemini');
    expect(gemini.length).toBeGreaterThanOrEqual(30);
  });

  it('caches across calls — second call does not re-fetch /speakers', async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(JSON.stringify({ coqui: ['Asya Anara'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await listBaseVoices({ sidecarUrl: SIDECAR_URL });
    await listBaseVoices({ sidecarUrl: SIDECAR_URL });
    expect((fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);

    invalidateBaseVoiceCache();
    await listBaseVoices({ sidecarUrl: SIDECAR_URL });
    expect((fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(2);
  });
});
