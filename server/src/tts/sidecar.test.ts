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
import { fetch as undiciFetch } from 'undici';
import { SidecarTtsProvider, getCapacityWaiterCount } from './sidecar.js';
import { NoCapacityError } from './tts-errors.js';
import { isTransient } from './retry.js';
import type { SynthesizeInput } from './index.js';

/* The provider posts via undici's OWN `fetch` (plan 137 — so the no-timeout
   `Agent` dispatcher and the fetch belong to the same undici instance), NOT
   the global fetch. So these classification tests mock the `undici` module's
   `fetch` export; the real `Agent` is preserved (spread) so the module-level
   SIDECAR_DISPATCHER still constructs. Real-network timeout behaviour is
   covered separately in sidecar-timeout.test.ts. */
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});
const mockFetch = vi.mocked(undiciFetch);

function makeProvider() {
  return new SidecarTtsProvider({ url: 'http://localhost:6006/', engine: 'coqui' });
}

const SYNTH_INPUT: SynthesizeInput = {
  text: 'hello',
  voiceName: 'Asya Anara',
  modelKey: 'coqui-xtts-v2',
};

function stubFetch(impl: typeof fetch) {
  mockFetch.mockImplementation(impl as unknown as typeof undiciFetch);
}

afterEach(() => {
  mockFetch.mockReset();
});

/* Helper: build a minimal valid batch response frame for N items.
   Format: `{"sampleRate":N,"lengths":[…]}\n<pcm0><pcm1>…` */
function makeBatchFrame(sampleRate: number, pcms: Buffer[]): Buffer {
  const header = JSON.stringify({ sampleRate, lengths: pcms.map((p) => p.length) });
  return Buffer.concat([Buffer.from(header + '\n'), ...pcms]);
}

describe('fs-57 — synthesizeBatch request body carries liveInstruct + per-item instruct', () => {
  /* Capture every POST's parsed body, return a minimal valid batch frame. */
  function stubBatchFetch(capturedBodies: unknown[]) {
    stubFetch(async (_url: unknown, init: unknown) => {
      capturedBodies.push(JSON.parse((init as { body: string }).body));
      const pcm1 = Buffer.alloc(4, 0);
      const pcm2 = Buffer.alloc(4, 0);
      return new Response(makeBatchFrame(24000, [pcm1, pcm2]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    });
  }

  function makeQwenProvider() {
    return new SidecarTtsProvider({ url: 'http://localhost:9000/', engine: 'qwen' });
  }

  it('sends liveInstruct=false and no per-item instruct by default', async () => {
    const bodies: unknown[] = [];
    stubBatchFetch(bodies);
    await makeQwenProvider().synthesizeBatch!({
      items: [
        { text: 'hello', voiceName: 'qwen-v1' },
        { text: 'world', voiceName: 'qwen-v2' },
      ],
      modelKey: 'qwen3-tts-0.6b',
    });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(body.liveInstruct).toBe(false);
    expect((body.items as Array<Record<string, unknown>>)[0]).not.toHaveProperty('instruct');
    expect((body.items as Array<Record<string, unknown>>)[1]).not.toHaveProperty('instruct');
  });

  it('sends liveInstruct=true when the flag is set', async () => {
    const bodies: unknown[] = [];
    stubBatchFetch(bodies);
    await makeQwenProvider().synthesizeBatch!({
      items: [
        { text: 'hello', voiceName: 'qwen-v1' },
        { text: 'world', voiceName: 'qwen-v2' },
      ],
      modelKey: 'qwen3-tts-1.7b',
      liveInstruct: true,
    });
    const body = bodies[0] as Record<string, unknown>;
    expect(body.liveInstruct).toBe(true);
  });

  it('sends per-item instruct only when present on the item', async () => {
    const bodies: unknown[] = [];
    stubBatchFetch(bodies);
    await makeQwenProvider().synthesizeBatch!({
      items: [
        { text: 'hello', voiceName: 'qwen-v1', instruct: 'in an angry, raised voice' },
        { text: 'world', voiceName: 'qwen-v2' }, // no instruct
      ],
      modelKey: 'qwen3-tts-1.7b',
      liveInstruct: true,
    });
    const body = bodies[0] as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].instruct).toBe('in an angry, raised voice');
    expect(items[1]).not.toHaveProperty('instruct');
  });

  it('sends per-item emotion only when present on the item', async () => {
    /* fs-57 gain fix: emotion is forwarded so the sidecar can apply
       _live_instruct_gain on the liveInstruct path.  Items without an emotion
       must not carry the key (no-op → unity gain on the sidecar side). */
    const bodies: unknown[] = [];
    stubBatchFetch(bodies);
    await makeQwenProvider().synthesizeBatch!({
      items: [
        { text: 'hello', voiceName: 'qwen-v1', emotion: 'whisper' },
        { text: 'world', voiceName: 'qwen-v2' }, // no emotion
      ],
      modelKey: 'qwen3-tts-1.7b',
      liveInstruct: true,
    });
    const body = bodies[0] as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].emotion).toBe('whisper');
    expect(items[1]).not.toHaveProperty('emotion');
  });

  it('emotion is absent from body when not set (variant path)', async () => {
    /* On the standard (anchored-variant) path, emotion is not set so no emotion
       key should appear in the request body. */
    const bodies: unknown[] = [];
    stubBatchFetch(bodies);
    await makeQwenProvider().synthesizeBatch!({
      items: [
        { text: 'hello', voiceName: 'qwen-v1__whisper' },
        { text: 'world', voiceName: 'qwen-v2' },
      ],
      modelKey: 'qwen3-tts-0.6b',
    });
    const body = bodies[0] as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0]).not.toHaveProperty('emotion');
    expect(items[1]).not.toHaveProperty('emotion');
  });

  it('single /synthesize body is unchanged — no liveInstruct field', async () => {
    /* PR2-M3: live instruct is batch-only; the single /synthesize body MUST NOT
       carry liveInstruct so a future sidecar version can rely on it not being set. */
    const bodies: unknown[] = [];
    stubFetch(async (_url: unknown, init: unknown) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      const pcm = Buffer.alloc(4, 0);
      return new Response(pcm, {
        status: 200,
        headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000', 'x-sample-rate': '24000' },
      });
    });
    await makeQwenProvider().synthesize({ text: 'hi', voiceName: 'v', modelKey: 'qwen3-tts-1.7b' });
    const body = bodies[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('liveInstruct');
    expect(body).not.toHaveProperty('instruct');
  });
});

describe('fs-60 — synthesize request body carries language', () => {
  it('includes language in the request body when provided', async () => {
    const bodies: unknown[] = [];
    stubFetch(async (_url: unknown, init: unknown) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      const pcm = Buffer.alloc(4, 0);
      return new Response(pcm, {
        status: 200,
        headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000', 'x-sample-rate': '24000' },
      });
    });
    await makeProvider().synthesize({
      text: 'hi',
      voiceName: 'Claribel Dervla',
      modelKey: 'coqui-xtts-v2',
      language: 'ru',
    });
    const body = bodies[0] as Record<string, unknown>;
    expect(body.language).toBe('ru');
  });

  it('omits language from the body when not provided (backward-compatible for existing English callers)', async () => {
    const bodies: unknown[] = [];
    stubFetch(async (_url: unknown, init: unknown) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      const pcm = Buffer.alloc(4, 0);
      return new Response(pcm, {
        status: 200,
        headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000', 'x-sample-rate': '24000' },
      });
    });
    await makeProvider().synthesize(SYNTH_INPUT);
    const body = bodies[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('language');
  });
});

describe('fs-59 W4b — coquiLanguageCode zh→zh-cn map (Coqui-only seam)', () => {
  function makeQwenProvider() {
    return new SidecarTtsProvider({ url: 'http://localhost:9000/', engine: 'qwen' });
  }

  function capturingFetch(bodies: unknown[]) {
    return async (_url: unknown, init: unknown) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      const pcm = Buffer.alloc(4, 0);
      return new Response(pcm, {
        status: 200,
        headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000', 'x-sample-rate': '24000' },
      });
    };
  }

  it('maps zh → zh-cn in the request body for the Coqui engine (verified 4b.0 string)', async () => {
    const bodies: unknown[] = [];
    stubFetch(capturingFetch(bodies));
    await makeProvider().synthesize({
      text: 'hi',
      voiceName: 'Claribel Dervla',
      modelKey: 'coqui-xtts-v2',
      language: 'zh',
    });
    const body = bodies[0] as Record<string, unknown>;
    expect(body.language).toBe('zh-cn');
  });

  it('leaves ja unchanged for the Coqui engine', async () => {
    const bodies: unknown[] = [];
    stubFetch(capturingFetch(bodies));
    await makeProvider().synthesize({
      text: 'hi',
      voiceName: 'Claribel Dervla',
      modelKey: 'coqui-xtts-v2',
      language: 'ja',
    });
    const body = bodies[0] as Record<string, unknown>;
    expect(body.language).toBe('ja');
  });

  it('does NOT leak zh-cn onto a non-Coqui engine — Qwen sees plain zh unchanged', async () => {
    const bodies: unknown[] = [];
    stubFetch(capturingFetch(bodies));
    await makeQwenProvider().synthesize({
      text: 'hi',
      voiceName: 'qwen-v1',
      modelKey: 'qwen3-tts-0.6b',
      language: 'zh',
    });
    const body = bodies[0] as Record<string, unknown>;
    expect(body.language).toBe('zh');
  });
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
    /* No substitution header → field omitted, so a silent fallback is
       distinguishable from a clean render downstream (golden-audio gate). */
    expect(result.voiceSubstitutedFrom).toBeUndefined();
  });

  it('surfaces x-voice-substituted-from on the result when the sidecar falls back', async () => {
    /* The sidecar substitutes a safe voice when the requested one isn't in its
       speaker manifest and signals it via this header. Surfacing it (not just
       logging) lets the chapter assembler stamp the segment + the golden-audio
       harness fail on a silent fallback. */
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    stubFetch(
      async () =>
        new Response(pcm, {
          status: 200,
          headers: {
            'content-type': 'audio/L16;codec=pcm;rate=24000',
            'x-sample-rate': '24000',
            'x-voice-substituted-from': 'Nonexistent Voice',
          },
        }),
    );

    const result = await makeProvider().synthesize(SYNTH_INPUT);

    expect(result.voiceSubstitutedFrom).toBe('Nonexistent Voice');
  });
});

describe('capacity-aware admission retry (vram-aware placement, Task 8b)', () => {
  /* The sidecar returns this shape on a 503 when SEG_CAPACITY_ADMISSION
     decides an op can't fit. `postWithCapacityRetry` peeks for it before
     the generic throwForResponse classification. */
  function noCapacityResponse(neededMb: number, deviceKey: string): Response {
    return new Response(JSON.stringify({ noCapacity: true, neededMb, deviceKey }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'content-type': 'application/json' },
    });
  }

  function okResponse(): Response {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    return new Response(pcm, {
      status: 200,
      headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000', 'x-sample-rate': '24000' },
    });
  }

  function fakeDevices(deviceKey: string, freeMb: number) {
    const [kind, indexStr] = deviceKey.split(':');
    return [
      {
        kind: kind as 'cuda' | 'rocm' | 'mps' | 'cpu',
        index: Number(indexStr),
        label: deviceKey,
        totalMb: 8_000,
        freeMb,
      },
    ];
  }

  it('(a) a plain 200 returns audio unchanged — no capacity path taken', async () => {
    stubFetch(async () => okResponse());
    const capacityProbeRead = vi.fn();
    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'coqui',
      capacityProbe: { read: capacityProbeRead },
    });

    const result = await provider.synthesize(SYNTH_INPUT);

    expect(result.pcm.equals(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBe(true);
    expect(capacityProbeRead).not.toHaveBeenCalled();
  });

  it('(b) noCapacity 503 then, when analysis is idle and eviction would help, evicts Ollama once and retries to success', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse();
    });
    const evictOllama = vi.fn(async () => {});
    const analyzerEvictWouldHelp = vi.fn(async () => true);
    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'coqui',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama,
      analyzerEvictWouldHelp,
      isAnalysisInFlight: () => false,
      capacityPollMs: 1,
      maxCapacityAttempts: 5,
    });

    const result = await provider.synthesize(SYNTH_INPUT);

    expect(calls).toBe(2);
    expect(evictOllama).toHaveBeenCalledTimes(1);
    expect(analyzerEvictWouldHelp).toHaveBeenCalledWith(2_000, 500);
    expect(result.pcm.equals(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBe(true);
  });

  it('(c) noCapacity 503 while analysis is in flight does NOT evict; it polls and a later 200 succeeds', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse();
    });
    const evictOllama = vi.fn(async () => {});
    const analyzerEvictWouldHelp = vi.fn(async () => true);
    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'coqui',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama,
      analyzerEvictWouldHelp,
      isAnalysisInFlight: () => true,
      capacityPollMs: 1,
      maxCapacityAttempts: 5,
    });

    const result = await provider.synthesize(SYNTH_INPUT);

    expect(calls).toBe(2);
    expect(evictOllama).not.toHaveBeenCalled();
    expect(analyzerEvictWouldHelp).not.toHaveBeenCalled();
    expect(result.pcm.equals(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBe(true);
  });

  it('(c continued) getCapacityWaiterCount() reflects an op parked in the poll-wait, and resets once it resolves', async () => {
    expect(getCapacityWaiterCount()).toBe(0);
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      if (calls === 2) {
        // The retry after the poll wait — the waiter count should already be up.
        expect(getCapacityWaiterCount()).toBe(1);
      }
      return calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse();
    });
    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'coqui',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: vi.fn(async () => false), // no eviction path — forces the poll wait
      isAnalysisInFlight: () => false,
      capacityPollMs: 1,
      maxCapacityAttempts: 5,
    });

    await provider.synthesize(SYNTH_INPUT);

    expect(calls).toBe(2);
    expect(getCapacityWaiterCount()).toBe(0);
  });

  it('(d) noCapacity 503 persisting past maxCapacityAttempts throws NoCapacityError, not treated as transient', async () => {
    stubFetch(async () => noCapacityResponse(4_000, 'cuda:0'));
    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 100) },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: vi.fn(async () => false), // eviction never helps → always exhausts via polling
      isAnalysisInFlight: () => false,
      capacityPollMs: 1,
      maxCapacityAttempts: 3,
    });

    const err = await provider.synthesize(SYNTH_INPUT).then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(NoCapacityError);
    expect(err.engine).toBe('qwen');
    expect(err.neededMb).toBe(4_000);
    expect(err.deviceKey).toBe('cuda:0');
    expect(err.message).toMatch(/Not enough GPU memory for qwen \(4000MB\)/);
    expect(isTransient(err)).toBe(false);
    expect(getCapacityWaiterCount()).toBe(0);
  });

  it('(e) a poisoned 503 (not a noCapacity shape) still goes through throwForResponse, never swallowed as noCapacity', async () => {
    const body = JSON.stringify({ detail: 'CUDA crashed', poisoned: true });
    stubFetch(async () => new Response(body, { status: 503, headers: { 'content-type': 'application/json' } }));
    const capacityProbeRead = vi.fn();
    const evictOllama = vi.fn(async () => {});
    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'coqui',
      capacityProbe: { read: capacityProbeRead },
      evictOllama,
    });

    const err = await provider.synthesize(SYNTH_INPUT).then(
      () => null,
      (e) => e,
    );

    expect(err.poisoned).toBe(true);
    expect(err.transient).toBe(false);
    expect(err.status).toBe(503);
    expect(capacityProbeRead).not.toHaveBeenCalled();
    expect(evictOllama).not.toHaveBeenCalled();
  });

  it('(e continued) a plain 500 (not a noCapacity shape) is classified transient as before, capacity path never engaged', async () => {
    stubFetch(async () => new Response('internal error', { status: 500 }));
    const capacityProbeRead = vi.fn();
    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'coqui',
      capacityProbe: { read: capacityProbeRead },
    });

    const err = await provider.synthesize(SYNTH_INPUT).then(
      () => null,
      (e) => e,
    );

    expect(err.transient).toBe(true);
    expect(err.status).toBe(500);
    expect(capacityProbeRead).not.toHaveBeenCalled();
  });
});
