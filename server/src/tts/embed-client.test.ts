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

import { embedSegment, spkRunsOnGpu } from './embed-client.js';

const mockFetch = vi.mocked(undiciFetch);
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

describe('spkRunsOnGpu — indexed cuda', () => {
  const prev = process.env.SPK_DEVICE;
  afterEach(() => { if (prev === undefined) delete process.env.SPK_DEVICE; else process.env.SPK_DEVICE = prev; });
  it('is true for cuda:1 / CUDA:0, false for cpu', () => {
    process.env.SPK_DEVICE = 'cuda:1'; expect(spkRunsOnGpu()).toBe(true);
    process.env.SPK_DEVICE = 'CUDA:0'; expect(spkRunsOnGpu()).toBe(true);
    process.env.SPK_DEVICE = 'cpu'; expect(spkRunsOnGpu()).toBe(false);
  });
});
