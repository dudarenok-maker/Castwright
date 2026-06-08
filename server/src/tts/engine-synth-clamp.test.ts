/* Per-engine in-flight clamp — mirrors the sidecar's _synth_lock on the Node
 * side so at most ONE synth call per engine is in flight at a time, while
 * DIFFERENT engines (e.g. Kokoro narrator + Qwen dialogue) can still overlap.
 *
 * Motivation: with GPU_VRAM_BUDGET=2 and Qwen cost=1, TWO Qwen calls fit the
 * global VRAM semaphore and both get dispatched simultaneously. They then
 * serialize on the sidecar's _synth_lock but double transient VRAM use,
 * accelerating the leak. Clamping at the Node layer prevents this.
 *
 * Both `engineSynths` (per-engine semaphore map) and `gpuSem` (global VRAM
 * semaphore) are injectable via SidecarOptions so each test uses fresh,
 * isolated instances rather than the module-level singletons.  The global
 * semaphore is injected with budget-2 so two simultaneous same-engine calls
 * would BOTH fit it — making the per-engine gate the only thing that could
 * serialize them.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { GpuSemaphore } from '../gpu/semaphore.js';
import { SidecarTtsProvider } from './sidecar.js';
import type { SynthesizeInput } from './index.js';

/* Mirror sidecar.test.ts: mock undici's fetch, preserve Agent so the
   module-level SIDECAR_DISPATCHER still constructs. */
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});
const mockFetch = vi.mocked(undiciFetch);

/** Two micro-ticks: one for the semaphore's drain(), one for the newly-resolved
    waiter's .then() continuation to run. Mirrors semaphore.test.ts's flush(). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Build a successful 200 PCM response (mirrors sidecar.test.ts). */
function okResponse(): Response {
  const pcm = Buffer.from([0x00, 0x10, 0x20, 0x30]);
  return new Response(pcm, {
    status: 200,
    headers: {
      'content-type': 'audio/L16;codec=pcm;rate=24000',
      'x-sample-rate': '24000',
    },
  });
}

const QWEN_INPUT: SynthesizeInput = {
  text: 'hello world',
  voiceName: 'qwen-narrator',
  modelKey: 'qwen3-tts-0.6b',
};

const KOKORO_INPUT: SynthesizeInput = {
  text: 'hello world',
  voiceName: 'af_sky',
  modelKey: 'kokoro-v1',
};

afterEach(() => {
  mockFetch.mockReset();
});

describe('per-engine synth clamp', () => {
  it('serialises two SAME-engine (qwen) synth calls — the 2nd waits for the 1st', async () => {
    /* Fresh, isolated semaphore instances injected via SidecarOptions:
       - gpuSem budget=2: both cost-1 Qwen calls fit the global sem, so the
         ONLY gate serialising them is the per-engine semaphore.
       - engineSynths: empty fresh map, isolated from the global singleton. */
    const gpuSem = new GpuSemaphore(2);
    const engineSynths = new Map<string, GpuSemaphore>();
    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'qwen',
      gpuSem,
      engineSynths,
    });

    /* Deferred: resolve manually to hold call 1 open. */
    let resolveFirst!: (r: Response) => void;
    const firstHeld = new Promise<Response>((res) => {
      resolveFirst = res;
    });

    let fetchCallCount = 0;
    mockFetch.mockImplementation(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return firstHeld as unknown as Awaited<ReturnType<typeof undiciFetch>>;
      }
      return okResponse() as unknown as Awaited<ReturnType<typeof undiciFetch>>;
    });

    /* Start both synth calls without awaiting.  A acquires the per-engine sem
       and dispatches fetch. B should block on the per-engine sem (global sem has
       budget 2, so both would fit there — the per-engine clamp is the only gate). */
    const synthA = provider.synthesize(QWEN_INPUT);
    const synthB = provider.synthesize(QWEN_INPUT);

    /* Settle microtasks: A is in-flight (fetch called once); B is queued on
       the per-engine semaphore and has NOT yet dispatched fetch. */
    await flush();
    expect(fetchCallCount).toBe(1);

    /* Unblock A: it completes and releases the per-engine sem, unblocking B. */
    resolveFirst(okResponse());
    await synthA;
    await flush();
    expect(fetchCallCount).toBe(2);

    /* B must also complete cleanly. */
    await synthB;
  });

  it('allows DIFFERENT engines (qwen + kokoro) to overlap', async () => {
    /* Both providers share SAME injected gpuSem (budget=2, fits both cost-1
       calls) and SAME engineSynths map — they get DIFFERENT per-engine
       semaphores keyed by engine name, so neither blocks the other. */
    const gpuSem = new GpuSemaphore(2);
    const engineSynths = new Map<string, GpuSemaphore>();
    const qwenProvider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'qwen',
      gpuSem,
      engineSynths,
    });
    const kokoroProvider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'kokoro',
      gpuSem,
      engineSynths,
    });

    /* Hold both fetches open simultaneously. */
    let resolveQwen!: (r: Response) => void;
    let resolveKokoro!: (r: Response) => void;
    const qwenHeld = new Promise<Response>((res) => {
      resolveQwen = res;
    });
    const kokoroHeld = new Promise<Response>((res) => {
      resolveKokoro = res;
    });

    let fetchCallCount = 0;
    mockFetch.mockImplementationOnce(async () => {
      fetchCallCount++;
      return qwenHeld as unknown as Awaited<ReturnType<typeof undiciFetch>>;
    });
    mockFetch.mockImplementationOnce(async () => {
      fetchCallCount++;
      return kokoroHeld as unknown as Awaited<ReturnType<typeof undiciFetch>>;
    });

    /* Start both — different engines, both should dispatch fetch immediately. */
    const synthQwen = qwenProvider.synthesize(QWEN_INPUT);
    const synthKokoro = kokoroProvider.synthesize(KOKORO_INPUT);

    /* After a flush both should be in-flight: fetch called TWICE. */
    await flush();
    expect(fetchCallCount).toBe(2);

    /* Clean up: resolve both so the test doesn't leak. */
    resolveQwen(okResponse());
    resolveKokoro(okResponse());
    await synthQwen;
    await synthKokoro;
  });
});
