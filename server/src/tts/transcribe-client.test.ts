/* transcribe-client (srv-31) — transport contract.
 *
 * Like sidecar.test.ts, the client posts via undici's OWN `fetch`, so we mock
 * the `undici` module's `fetch` export (real `Agent` preserved so the module-
 * level dispatcher still constructs). The load-bearing assertions:
 *   - raw PCM body + X-Sample-Rate (+ optional X-Language) reach /transcribe,
 *   - the JSON response maps to the camelCase TranscribeResult,
 *   - a 5xx is annotated transient.
 * VRAM arbitration for the GPU path no longer happens here — it lives in the
 * sidecar's capacity admission (SEG_CAPACITY_ADMISSION) — so this file no
 * longer asserts a GPU token is acquired.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetch as undiciFetch } from 'undici';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

/* #1720 Task 7 — withCapacityRetry is mocked wholesale rather than exercised
   for real: the retry/evict/exhaustion policy itself is already covered by
   server/src/gpu/capacity-retry.test.ts. What THIS file needs to pin is the
   WIRING — transcribeSegment only wraps the fetch in withCapacityRetry when
   asrRunsOnGpu() is true, passes engine 'asr' + the caller's signal, and
   handles whatever withCapacityRetry returns/throws exactly like it did the
   bare fetch before. */
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));

import { transcribeSegment, asrRunsOnGpu, normalizeWhisperLanguage } from './transcribe-client.js';
import { withCapacityRetry } from '../gpu/capacity-retry.js';
import { NoCapacityError } from './tts-errors.js';

const mockFetch = vi.mocked(undiciFetch);
const mockWithCapacityRetry = vi.mocked(withCapacityRetry);
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
  mockWithCapacityRetry.mockReset();
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
      words: null,
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

  it('sets X-Word-Timestamps and maps the words[] field when wordTimestamps is requested', async () => {
    const captured: { value: { init: { headers: Record<string, string> } } | null } = { value: null };
    mockFetch.mockImplementation((async (_url: string, init: { headers: Record<string, string> }) => {
      captured.value = { init };
      return jsonResponse({
        text: 'Hello world.',
        language: 'en',
        avg_logprob: -0.2,
        no_speech_prob: 0.01,
        compression_ratio: 1.2,
        words: [
          { word: 'Hello', start: 0, end: 0.4 },
          { word: 'world.', start: 0.4, end: 0.9 },
        ],
      });
    }) as unknown as typeof undiciFetch);

    const result = await transcribeSegment(PCM, 16000, {
      wordTimestamps: true,
      sidecarUrl: URL,
    });

    expect(captured.value?.init.headers['x-word-timestamps']).toBe('1');
    expect(result.words).toEqual([
      { word: 'Hello', start: 0, end: 0.4 },
      { word: 'world.', start: 0.4, end: 0.9 },
    ]);
  });

  it('drops malformed words[] entries (missing/non-numeric start/end, non-string word) rather than trusting the cast', async () => {
    mockFetch.mockImplementation((async () =>
      jsonResponse({
        text: 'Hello world.',
        language: 'en',
        words: [
          { word: 'Hello', start: 0, end: 0.4 },
          /* missing start */ { word: 'world.', end: 0.9 },
          /* non-numeric end */ { word: 'foo', start: 1, end: 'bar' },
          /* non-string word */ { word: 42, start: 2, end: 2.5 },
          /* non-finite start */ { word: 'baz', start: Number.NaN, end: 3 },
          { word: 'qux', start: 3, end: 3.5 },
        ],
      })) as unknown as typeof undiciFetch);

    const result = await transcribeSegment(PCM, 16000, {
      wordTimestamps: true,
      sidecarUrl: URL,
    });

    expect(result.words).toEqual([
      { word: 'Hello', start: 0, end: 0.4 },
      { word: 'qux', start: 3, end: 3.5 },
    ]);
  });

  it('omits X-Word-Timestamps and returns words: null when not requested', async () => {
    const captured: { value: { init: { headers: Record<string, string> } } | null } = { value: null };
    mockFetch.mockImplementation((async (_url: string, init: { headers: Record<string, string> }) => {
      captured.value = { init };
      return jsonResponse({ text: 'Hi.', language: 'en' });
    }) as unknown as typeof undiciFetch);

    const result = await transcribeSegment(PCM, 16000, { sidecarUrl: URL });

    expect(captured.value?.init.headers['x-word-timestamps']).toBeUndefined();
    expect(result.words).toBeNull();
  });
});

describe('transcribeSegment — capacity-aware retry wiring (#1720 Task 7)', () => {
  it('wraps the fetch in withCapacityRetry(engine: "asr") when ASR runs on GPU, and resolves an ok response normally', async () => {
    process.env.ASR_DEVICE = 'cuda:0';
    let fetchCalls = 0;
    mockFetch.mockImplementation((async () => {
      fetchCalls += 1;
      return jsonResponse({ text: 'hi', language: 'en' });
    }) as unknown as typeof undiciFetch);
    mockWithCapacityRetry.mockImplementation(async (doPost, opts) => {
      expect(opts.engine).toBe('asr');
      return doPost(opts.signal);
    });

    const out = await transcribeSegment(PCM, 24000, { sidecarUrl: URL });

    expect(mockWithCapacityRetry).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toBe(1);
    expect(out.text).toBe('hi');
  });

  it('a doPost that returns a noCapacity 503 once then ok succeeds after the (simulated) evict/retry', async () => {
    process.env.ASR_DEVICE = 'cuda:0';
    let calls = 0;
    mockFetch.mockImplementation((async () => {
      calls += 1;
      return calls === 1
        ? (new Response(JSON.stringify({ noCapacity: true, neededMb: 1000, deviceKey: 'cuda:0' }), {
            status: 503,
          }) as unknown as Response)
        : jsonResponse({ text: 'after retry', language: 'en' });
    }) as unknown as typeof undiciFetch);
    // Stand-in mirroring withCapacityRetry's real evict-then-retry contract:
    // retry the SAME doPost once more on a non-ok first response.
    mockWithCapacityRetry.mockImplementation(async (doPost, opts) => {
      const first = await doPost(opts.signal);
      if (first.ok) return first;
      return doPost(opts.signal);
    });

    const out = await transcribeSegment(PCM, 24000, { sidecarUrl: URL });

    expect(calls).toBe(2);
    expect(out.text).toBe('after retry');
  });

  it('a non-noCapacity 503 returned by withCapacityRetry still hits the existing transient-503 error path', async () => {
    process.env.ASR_DEVICE = 'cuda:0';
    mockWithCapacityRetry.mockImplementation(
      async () => new Response('boom', { status: 503 }) as unknown as Response,
    );

    const err = await transcribeSegment(PCM, 24000, { sidecarUrl: URL }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { transient?: boolean }).transient).toBe(true);
  });

  it('propagates a thrown NoCapacityError as-is rather than wrapping it as "not reachable"', async () => {
    process.env.ASR_DEVICE = 'cuda:0';
    const capacityErr = new NoCapacityError('coqui', 1200, 'cuda:0');
    mockWithCapacityRetry.mockImplementation(async () => {
      throw capacityErr;
    });

    const err = await transcribeSegment(PCM, 24000, { sidecarUrl: URL }).catch((e) => e);

    expect(err).toBe(capacityErr);
  });

  it('is INERT when ASR runs on CPU — fetch is called directly, withCapacityRetry never invoked', async () => {
    process.env.ASR_DEVICE = 'cpu';
    mockFetch.mockImplementation((async () =>
      jsonResponse({ text: 'cpu path', language: 'en' })) as unknown as typeof undiciFetch);

    const out = await transcribeSegment(PCM, 24000, { sidecarUrl: URL });

    expect(out.text).toBe('cpu path');
    expect(mockWithCapacityRetry).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
