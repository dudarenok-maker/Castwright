/* embed-client (srv-47) — transport + GPU-arbitration contract. Mirrors
 * transcribe-client.test.ts: we mock undici's own `fetch` (real `Agent`
 * preserved so the module-level dispatcher still constructs) and spy the GPU
 * semaphore. Load-bearing assertions:
 *   - raw PCM body + X-Sample-Rate reach /embed, JSON maps to Float32Array,
 *   - a GPU token is acquired ONLY when SPK_DEVICE=cuda (cpu path is free),
 *   - release is called in finally on success AND on a thrown error,
 *   - a one-time WARN fires when SPK_DEVICE=cuda and the GPU budget < 2.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetch as undiciFetch } from 'undici';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

const { acquire, release } = vi.hoisted(() => {
  const release = vi.fn();
  return { acquire: vi.fn(async () => release), release };
});
// `budget` is a getter on the real GpuSemaphore; expose a settable backing.
const sem = vi.hoisted(() => ({ value: 1 }));
vi.mock('../gpu/semaphore.js', () => ({
  gpuSemaphore: { acquire, get budget() { return sem.value; } },
}));

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
  acquire.mockClear();
  release.mockClear();
  sem.value = 1;
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

  it('does NOT acquire a GPU token on the cpu default path', async () => {
    delete process.env.SPK_DEVICE;
    mockFetch.mockImplementation((async () => embedResponse([1])) as unknown as typeof undiciFetch);
    await embedSegment(PCM, 24000, { sidecarUrl: URL });
    expect(acquire).not.toHaveBeenCalled();
    expect(spkRunsOnGpu()).toBe(false);
  });

  it('acquires a GPU token when SPK_DEVICE=cuda and releases it', async () => {
    process.env.SPK_DEVICE = 'cuda';
    sem.value = 4;
    mockFetch.mockImplementation((async () => embedResponse([1])) as unknown as typeof undiciFetch);
    await embedSegment(PCM, 24000, { sidecarUrl: URL });
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(spkRunsOnGpu()).toBe(true);
  });

  it('releases the GPU token even when the fetch throws', async () => {
    process.env.SPK_DEVICE = 'cuda';
    sem.value = 4;
    mockFetch.mockImplementation((async () => { throw new Error('boom'); }) as unknown as typeof undiciFetch);
    await embedSegment(PCM, 24000, { sidecarUrl: URL }).catch(() => {});
    expect(release).toHaveBeenCalledOnce();
  });

  it('annotates a 5xx as transient', async () => {
    mockFetch.mockImplementation((async () => new Response('boom', { status: 503 }) as unknown as Response) as unknown as typeof undiciFetch);
    const err = await embedSegment(PCM, 24000, { sidecarUrl: URL }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { transient?: boolean }).transient).toBe(true);
  });

  // NOTE: `budgetWarned` is module-level state in embed-client.ts and can't be
  // reset from here. This test relies on running AFTER the budget>=2 cuda tests
  // above (which never flip the flag), so the flag is still false on entry.
  it('warns once when SPK_DEVICE=cuda and the GPU budget < 2', async () => {
    process.env.SPK_DEVICE = 'cuda';
    sem.value = 1;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockImplementation((async () => embedResponse([1])) as unknown as typeof undiciFetch);
    await embedSegment(PCM, 24000, { sidecarUrl: URL });
    await embedSegment(PCM, 24000, { sidecarUrl: URL });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/GPU_VRAM_BUDGET/);
  });

  it('does NOT warn when the budget is >= 2', async () => {
    process.env.SPK_DEVICE = 'cuda';
    sem.value = 2;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockImplementation((async () => embedResponse([1])) as unknown as typeof undiciFetch);
    await embedSegment(PCM, 24000, { sidecarUrl: URL });
    expect(warn).not.toHaveBeenCalled();
  });
});
