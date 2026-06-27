/* transcribe-client (srv-31) — transport + GPU-arbitration contract.
 *
 * Like sidecar.test.ts, the client posts via undici's OWN `fetch`, so we mock
 * the `undici` module's `fetch` export (real `Agent` preserved so the module-
 * level dispatcher still constructs). The load-bearing assertions:
 *   - raw PCM body + X-Sample-Rate (+ optional X-Language) reach /transcribe,
 *   - the JSON response maps to the camelCase TranscribeResult,
 *   - a GPU token is acquired ONLY when ASR_DEVICE=cuda (CPU path is free),
 *   - a 5xx is annotated transient.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetch as undiciFetch } from 'undici';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

/* Spy the GPU semaphore so we can assert ASR only takes a token on cuda.
   Hoisted so the const is initialised before the (also-hoisted) vi.mock factory. */
const { acquire } = vi.hoisted(() => ({ acquire: vi.fn(async () => vi.fn()) }));
vi.mock('../gpu/semaphore.js', () => ({ gpuSemaphore: { acquire } }));

import { transcribeSegment, asrRunsOnGpu, normalizeWhisperLanguage } from './transcribe-client.js';

const mockFetch = vi.mocked(undiciFetch);
const URL = 'http://sidecar.test:9000';
const PCM = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

afterEach(() => {
  mockFetch.mockReset();
  acquire.mockClear();
  delete process.env.ASR_DEVICE;
});

describe('transcribeSegment', () => {
  it('posts raw PCM with X-Sample-Rate and maps the JSON response', async () => {
    let captured: { url: string; init: { headers: Record<string, string>; body: unknown } } | null =
      null;
    mockFetch.mockImplementation((async (url: string, init: { headers: Record<string, string>; body: unknown }) => {
      captured = { url, init };
      return jsonResponse({
        text: 'hello world',
        language: 'en',
        avg_logprob: -0.3,
        no_speech_prob: 0.02,
        compression_ratio: 1.4,
      });
    }) as unknown as typeof undiciFetch);

    const out = await transcribeSegment(PCM, 24000, { sidecarUrl: URL });

    expect(out).toEqual({
      text: 'hello world',
      language: 'en',
      avgLogprob: -0.3,
      noSpeechProb: 0.02,
      compressionRatio: 1.4,
    });
    expect(captured!.url).toBe(`${URL}/transcribe`);
    expect(captured!.init.headers['x-sample-rate']).toBe('24000');
    expect(captured!.init.body).toBe(PCM);
  });

  it('forwards the language hint as X-Language', async () => {
    let headers: Record<string, string> = {};
    mockFetch.mockImplementation((async (_url: string, init: { headers: Record<string, string> }) => {
      headers = init.headers;
      return jsonResponse({ text: 'привет', language: 'ru' });
    }) as unknown as typeof undiciFetch);

    await transcribeSegment(PCM, 24000, { sidecarUrl: URL, language: 'ru-RU' });
    expect(headers['x-language']).toBe('ru'); // normalised to the base subtag
  });

  it('normalizeWhisperLanguage takes the base subtag and drops non-codes', () => {
    expect(normalizeWhisperLanguage('en-US')).toBe('en');
    expect(normalizeWhisperLanguage('ru')).toBe('ru');
    expect(normalizeWhisperLanguage(undefined)).toBeUndefined();
    expect(normalizeWhisperLanguage('Russian')).toBeUndefined();
  });

  it('does NOT acquire a GPU token on the CPU default path', async () => {
    delete process.env.ASR_DEVICE;
    mockFetch.mockImplementation((async () => jsonResponse({ text: 'x' })) as unknown as typeof undiciFetch);
    await transcribeSegment(PCM, 24000, { sidecarUrl: URL });
    expect(acquire).not.toHaveBeenCalled();
    expect(asrRunsOnGpu()).toBe(false);
  });

  it('acquires a GPU token when ASR_DEVICE=cuda', async () => {
    process.env.ASR_DEVICE = 'cuda';
    mockFetch.mockImplementation((async () => jsonResponse({ text: 'x' })) as unknown as typeof undiciFetch);
    await transcribeSegment(PCM, 24000, { sidecarUrl: URL });
    expect(acquire).toHaveBeenCalledOnce();
    expect(asrRunsOnGpu()).toBe(true);
  });

  it('annotates a 5xx as transient', async () => {
    mockFetch.mockImplementation((async () => new Response('boom', { status: 503 }) as unknown as Response) as unknown as typeof undiciFetch);
    const err = await transcribeSegment(PCM, 24000, { sidecarUrl: URL }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { transient?: boolean }).transient).toBe(true);
  });

  it('throws on an empty PCM buffer', async () => {
    await expect(transcribeSegment(Buffer.alloc(0), 24000, { sidecarUrl: URL })).rejects.toThrow(
      /empty PCM/,
    );
  });
});

describe('asrRunsOnGpu — indexed cuda', () => {
  const prev = process.env.ASR_DEVICE;
  afterEach(() => { if (prev === undefined) delete process.env.ASR_DEVICE; else process.env.ASR_DEVICE = prev; });
  it('is true for cuda:1 / CUDA:0, false for cpu', () => {
    process.env.ASR_DEVICE = 'cuda:1'; expect(asrRunsOnGpu()).toBe(true);
    process.env.ASR_DEVICE = 'CUDA:0'; expect(asrRunsOnGpu()).toBe(true);
    process.env.ASR_DEVICE = 'cpu'; expect(asrRunsOnGpu()).toBe(false);
  });
});
