/* embed-client (srv-47) — transport contract. Mirrors transcribe-client.test.ts:
 * we mock undici's own `fetch` (real `Agent` preserved so the module-level
 * dispatcher still constructs). Load-bearing assertions:
 *   - raw PCM body + X-Sample-Rate reach /embed, JSON maps to Float32Array.
 * VRAM arbitration for the GPU path no longer happens here — it lives in the
 * sidecar's capacity admission (SEG_CAPACITY_ADMISSION) — so this file no
 * longer asserts a GPU token is acquired/released.
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
   WIRING — embedSegment only wraps the fetch in withCapacityRetry when
   spkRunsOnGpu() is true, passes engine 'spk' + the caller's signal, and
   handles whatever withCapacityRetry returns/throws exactly like it did the
   bare fetch before. */
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));

import { embedSegment, spkRunsOnGpu } from './embed-client.js';
import { withCapacityRetry } from '../gpu/capacity-retry.js';
import { NoCapacityError } from './tts-errors.js';

const mockFetch = vi.mocked(undiciFetch);
const mockWithCapacityRetry = vi.mocked(withCapacityRetry);
const URL = 'http://sidecar.test:9000';
const PCM = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);

function embedResponse(vec: number[], status = 200): Response {
  return new Response(JSON.stringify({ embedding: vec, dim: vec.length, sample_rate: 16000 }), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

afterEach(() => {
  mockFetch.mockReset();
  mockWithCapacityRetry.mockReset();
  delete process.env.SPK_DEVICE;
  vi.restoreAllMocks();
});

describe('embedSegment', () => {
  it('posts raw PCM with X-Sample-Rate and maps the JSON to a Float32Array', async () => {
    let captured: { url: string; init: { headers: Record<string, string>; body: unknown } } | null = null;
    mockFetch.mockImplementation((async (url: string, init: { headers: Record<string, string>; body: unknown }) => {
      captured = { url, init };
      return embedResponse([0.1, 0.2, 0.3]);
    }) as unknown as typeof undiciFetch);

    const out = await embedSegment(PCM, 24000, { sidecarUrl: URL });

    expect(Array.from(out)).toEqual([
      Math.fround(0.1), Math.fround(0.2), Math.fround(0.3),
    ]);
    expect(captured!.url).toBe(`${URL}/embed`);
    expect(captured!.init.headers['x-sample-rate']).toBe('24000');
    expect(captured!.init.body).toBe(PCM);
  });

  it('annotates a 5xx as transient', async () => {
    mockFetch.mockImplementation((async () => new Response('boom', { status: 503 }) as unknown as Response) as unknown as typeof undiciFetch);
    const err = await embedSegment(PCM, 24000, { sidecarUrl: URL }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { transient?: boolean }).transient).toBe(true);
  });

  it('rejects with an "empty" error and does not call fetch when given a zero-length PCM buffer', async () => {
    const err = await embedSegment(Buffer.alloc(0), 24000, { sidecarUrl: URL }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/empty/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

});

describe('embedSegment — capacity-aware retry wiring (#1720 Task 7)', () => {
  it('wraps the fetch in withCapacityRetry(engine: "spk") when the embed runs on GPU, and resolves an ok response normally', async () => {
    process.env.SPK_DEVICE = 'cuda:0';
    let fetchCalls = 0;
    mockFetch.mockImplementation((async () => {
      fetchCalls += 1;
      return embedResponse([0.1, 0.2, 0.3]);
    }) as unknown as typeof undiciFetch);
    mockWithCapacityRetry.mockImplementation(async (doPost, opts) => {
      expect(opts.engine).toBe('spk');
      return doPost(opts.signal);
    });

    const out = await embedSegment(PCM, 24000, { sidecarUrl: URL });

    expect(mockWithCapacityRetry).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toBe(1);
    expect(Array.from(out)).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
  });

  it('a doPost that returns a noCapacity 503 once then ok succeeds after the (simulated) evict/retry', async () => {
    process.env.SPK_DEVICE = 'cuda:0';
    let calls = 0;
    mockFetch.mockImplementation((async () => {
      calls += 1;
      return calls === 1
        ? (new Response(JSON.stringify({ noCapacity: true, neededMb: 1000, deviceKey: 'cuda:0' }), {
            status: 503,
          }) as unknown as Response)
        : embedResponse([0.4, 0.5]);
    }) as unknown as typeof undiciFetch);
    // Stand-in mirroring withCapacityRetry's real evict-then-retry contract:
    // retry the SAME doPost once more on a non-ok first response.
    mockWithCapacityRetry.mockImplementation(async (doPost, opts) => {
      const first = await doPost(opts.signal);
      if (first.ok) return first;
      return doPost(opts.signal);
    });

    const out = await embedSegment(PCM, 24000, { sidecarUrl: URL });

    expect(calls).toBe(2);
    expect(Array.from(out)).toEqual([Math.fround(0.4), Math.fround(0.5)]);
  });

  it('a non-noCapacity 503 returned by withCapacityRetry still hits the existing transient-503 error path', async () => {
    process.env.SPK_DEVICE = 'cuda:0';
    mockWithCapacityRetry.mockImplementation(
      async () => new Response('boom', { status: 503 }) as unknown as Response,
    );

    const err = await embedSegment(PCM, 24000, { sidecarUrl: URL }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { transient?: boolean }).transient).toBe(true);
  });

  it('propagates a thrown NoCapacityError as-is rather than wrapping it as "not reachable"', async () => {
    process.env.SPK_DEVICE = 'cuda:0';
    const capacityErr = new NoCapacityError('coqui', 1200, 'cuda:0');
    mockWithCapacityRetry.mockImplementation(async () => {
      throw capacityErr;
    });

    const err = await embedSegment(PCM, 24000, { sidecarUrl: URL }).catch((e) => e);

    expect(err).toBe(capacityErr);
  });

  it('is INERT when the embed runs on CPU — fetch is called directly, withCapacityRetry never invoked', async () => {
    process.env.SPK_DEVICE = 'cpu';
    mockFetch.mockImplementation((async () => embedResponse([0.7])) as unknown as typeof undiciFetch);

    const out = await embedSegment(PCM, 24000, { sidecarUrl: URL });

    expect(Array.from(out)).toEqual([Math.fround(0.7)]);
    expect(mockWithCapacityRetry).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('spkRunsOnGpu — indexed cuda', () => {
  const prev = process.env.SPK_DEVICE;
  afterEach(() => { if (prev === undefined) delete process.env.SPK_DEVICE; else process.env.SPK_DEVICE = prev; });
  it('is true for cuda:1 / CUDA:0, false for cpu', () => {
    process.env.SPK_DEVICE = 'cuda:1'; expect(spkRunsOnGpu()).toBe(true);
    process.env.SPK_DEVICE = 'CUDA:0'; expect(spkRunsOnGpu()).toBe(true);
    process.env.SPK_DEVICE = 'cpu'; expect(spkRunsOnGpu()).toBe(false);
  });
});
