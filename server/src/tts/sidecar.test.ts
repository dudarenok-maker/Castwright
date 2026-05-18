/* Classification coverage for SidecarTtsProvider.
 *
 * The retry helper (`server/src/tts/retry.ts`) is provider-agnostic — it
 * just reads the `transient` flag the provider stuck on the thrown error.
 * That means the *classification* (network blip → transient, 5xx →
 * transient, poisoned-CUDA → non-transient, 4xx → non-transient) is the
 * boundary contract the retry wrapper depends on. retry.test.ts covers
 * the wrapper's behaviour given annotated errors; this file covers the
 * sidecar's *annotation*: the assertion that the same input shapes
 * produce the same flags.
 *
 * Without this, a future refactor that flips a transient→non-transient
 * mapping (or vice versa) would only break in end-to-end retry tests in
 * synthesise-chapter.test.ts, with the failure attributed to chapter
 * orchestration rather than the actual mis-classification.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SidecarTtsProvider } from './sidecar.js';
import type { SynthesizeInput } from './index.js';

function makeProvider() {
  return new SidecarTtsProvider({ url: 'http://localhost:6006/', engine: 'coqui' });
}

const SYNTH_INPUT: SynthesizeInput = {
  text: 'hello',
  voiceName: 'Asya Anara',
  modelKey: 'coqui-xtts-v2',
};

function stubFetch(impl: typeof fetch) {
  vi.stubGlobal('fetch', impl);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SidecarTtsProvider error classification', () => {
  it('annotates network failure as transient with cause=network', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    expect(err).toBeInstanceOf(Error);
    expect(err.transient).toBe(true);
    expect(err.cause).toBe('network');
    expect(err.message).toMatch(/Local TTS sidecar not reachable/);
  });

  it('propagates AbortError unchanged (no transient flag)', async () => {
    stubFetch(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    expect(err?.name).toBe('AbortError');
    /* Critically — the helper does NOT decorate AbortError. The retry
       wrapper relies on this to bail out of a caller-driven stop. */
    expect(err?.transient).toBeUndefined();
  });

  it('classifies 503 with poisoned body as non-transient + poisoned=true', async () => {
    const body = JSON.stringify({ detail: 'CUDA crashed', poisoned: true });
    stubFetch(
      async () =>
        new Response(body, {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'content-type': 'application/json' },
        }),
    );

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    expect(err.transient).toBe(false);
    expect(err.poisoned).toBe(true);
    expect(err.status).toBe(503);
  });

  it('classifies 503 without poisoned body as transient', async () => {
    stubFetch(
      async () =>
        new Response('model loading', { status: 503, statusText: 'Service Unavailable' }),
    );

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    expect(err.transient).toBe(true);
    expect(err.poisoned).toBe(false);
    expect(err.status).toBe(503);
  });

  it('classifies 502 (reverse proxy mid-restart) as transient', async () => {
    stubFetch(async () => new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }));

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    expect(err.transient).toBe(true);
    expect(err.status).toBe(502);
  });

  it('classifies 408 (request timeout) as transient', async () => {
    stubFetch(
      async () => new Response('timeout', { status: 408, statusText: 'Request Timeout' }),
    );

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    expect(err.transient).toBe(true);
    expect(err.status).toBe(408);
  });

  it('classifies 400 (bad request) as non-transient', async () => {
    stubFetch(async () => new Response('bad input', { status: 400, statusText: 'Bad Request' }));

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    expect(err.transient).toBe(false);
    expect(err.status).toBe(400);
  });

  it('classifies 404 (missing route) as non-transient', async () => {
    stubFetch(async () => new Response('not found', { status: 404, statusText: 'Not Found' }));

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    expect(err.transient).toBe(false);
    expect(err.status).toBe(404);
  });

  it('throws on empty audio body without classifying as transient', async () => {
    /* Empty 200 means the sidecar returned success-but-no-audio. Don't
       silently retry — surface to the caller so it can fail the group. */
    stubFetch(
      async () =>
        new Response(new ArrayBuffer(0), {
          status: 200,
          headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000', 'x-sample-rate': '24000' },
        }),
    );

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    expect(err.message).toMatch(/empty audio body/i);
    expect(err.transient).toBeUndefined();
  });

  it('returns parsed PCM + sampleRate from a 200 response', async () => {
    const pcm = Buffer.from([0x00, 0x10, 0x20, 0x30, 0x40, 0x50]);
    stubFetch(
      async () =>
        new Response(pcm, {
          status: 200,
          headers: { 'content-type': 'audio/L16;codec=pcm;rate=22050', 'x-sample-rate': '22050' },
        }),
    );

    const result = await makeProvider().synthesize(SYNTH_INPUT);

    expect(result.pcm.equals(pcm)).toBe(true);
    expect(result.sampleRate).toBe(22050);
    expect(result.mimeType).toMatch(/audio\/L16/);
  });
});
