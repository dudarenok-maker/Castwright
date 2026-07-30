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

  /* #1951 / plan 275 — REWRITTEN, not incidentally broken. This case used to
     read "Qwen sees plain zh unchanged" and assert `body.language === 'zh'`,
     which was a true statement of the OLD contract: Qwen was sent the raw
     BCP-47 code, and ignored it.

     Under the new contract Qwen is sent the sidecar language WORD, and only
     for a CLONED voice; a designed voice is sent no language at all. Both arms
     are asserted below, and the fs-59 W4b invariant this case exists to
     protect — the Coqui-only `zh` → `zh-cn` map must never leak off Coqui — is
     still asserted on each: neither arm may ever put `zh-cn` on the wire. */
  it('never leaks zh-cn onto Qwen: a designed voice sends no language at all', async () => {
    const bodies: unknown[] = [];
    stubFetch(capturingFetch(bodies));
    await makeQwenProvider().synthesize({
      text: 'hi',
      voiceName: 'qwen-v1',
      modelKey: 'qwen3-tts-0.6b',
      language: 'zh',
    });
    const body = bodies[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('language');
    expect(JSON.stringify(body)).not.toContain('zh-cn');
  });

  it('never leaks zh-cn onto Qwen: a cloned voice sends the sidecar WORD, not the code', async () => {
    const bodies: unknown[] = [];
    stubFetch(capturingFetch(bodies));
    await makeQwenProvider().synthesize({
      text: 'hi',
      voiceName: 'qwen-v1',
      modelKey: 'qwen3-tts-0.6b',
      language: 'zh',
      cloned: true,
    });
    const body = bodies[0] as Record<string, unknown>;
    expect(body.language).toBe('Chinese');
    expect(JSON.stringify(body)).not.toContain('zh-cn');
  });
});

/* #1951 / plan 275 — a cloned Qwen voice must render the BOOK's language, not
   the "English" its manifest permanently claims. Node decides clone-ness
   (`hasClonedProvenance`) and signals it to the sidecar purely by WHETHER it
   sends a `language`. */
describe('#1951 — per-request language for cloned Qwen voices', () => {
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

  function batchFrame(count: number) {
    const lengths = Array.from({ length: count }, () => 4);
    const header = JSON.stringify({ sampleRate: 24000, lengths });
    return Buffer.concat([Buffer.from(`${header}\n`, 'utf8'), Buffer.alloc(4 * count, 0)]);
  }

  it('sends the sidecar language WORD for a cloned qwen voice', async () => {
    const bodies: unknown[] = [];
    stubFetch(capturingFetch(bodies));
    await makeQwenProvider().synthesize({
      text: 'Der alte Leuchtturm.',
      voiceName: 'qwen-abc',
      modelKey: 'qwen3-tts-0.6b',
      language: 'de',
      cloned: true,
    });
    expect((bodies[0] as Record<string, unknown>).language).toBe('German');
  });

  it('sends NO language for a designed qwen voice (byte-identical to today)', async () => {
    const bodies: unknown[] = [];
    stubFetch(capturingFetch(bodies));
    await makeQwenProvider().synthesize({
      text: 'The old lighthouse.',
      voiceName: 'qwen-abc',
      modelKey: 'qwen3-tts-0.6b',
      language: 'de',
    });
    expect(bodies[0]).not.toHaveProperty('language');
  });

  /* Invariant 6. Any caller that supplies a `language` but no `cloned` flag
     must never reach `sidecarLanguageName`, which THROWS by design for an
     unregistered code — asserted here with a code the registry does not know.

     NOTE (#1951 review fix, M4): this is no longer routes/voice-sample.ts's
     protection. That route now DOES flag cloned voices, so its unvalidated,
     client-supplied language is protected by `resolveWireLanguage`'s try/catch
     instead — see the next test, and the end-to-end route test in
     routes/voice-sample-cloned-language.test.ts. What this pins today is the
     DESIGNED-voice case: a designed voice must stay byte-identical to
     pre-#1951 behaviour whatever language its caller passes. */
  it('a call with a language but no cloned flag never reaches sidecarLanguageName', async () => {
    const bodies: unknown[] = [];
    stubFetch(capturingFetch(bodies));
    await expect(
      makeQwenProvider().synthesize({
        text: 'hi',
        voiceName: 'qwen-abc',
        modelKey: 'qwen3-tts-0.6b',
        language: 'kl-GL',
      }),
    ).resolves.toBeDefined();
    expect(bodies[0]).not.toHaveProperty('language');
  });

  /* Principle 3 — an unmappable language degrades to TODAY's behaviour: the
     field is omitted, so the sidecar falls back to the manifest word. Never a
     throw (that would fail a chapter that renders fine today) and never an
     English default (that would ship cross-language garbage silently). The
     fail-loud guarantee for a book render lives upstream in generation.ts. */
  it('omits the field rather than throwing when the language has no sidecar word', async () => {
    const bodies: unknown[] = [];
    stubFetch(capturingFetch(bodies));
    await expect(
      makeQwenProvider().synthesize({
        text: 'hi',
        voiceName: 'qwen-abc',
        modelKey: 'qwen3-tts-0.6b',
        language: 'kl-GL',
        cloned: true,
      }),
    ).resolves.toBeDefined();
    expect(bodies[0]).not.toHaveProperty('language');
  });

  it('leaves Coqui untouched — a cloned coqui voice still gets a BCP-47 code', async () => {
    const bodies: unknown[] = [];
    stubFetch(capturingFetch(bodies));
    await makeProvider().synthesize({
      text: 'hi',
      voiceName: 'xtts-abc',
      modelKey: 'coqui-xtts-v2',
      language: 'zh',
      cloned: true,
    });
    expect((bodies[0] as Record<string, unknown>).language).toBe('zh-cn');
  });

  /* THE PRIMARY SURFACE. Chapter sentences batch (QWEN_BATCH_SIZE=32); only
     the title beat uses /synthesize. A batch may MIX a cloned character's line
     with a designed narrator's, so the field is PER ITEM. */
  it('stamps language per ITEM on the batch body — cloned item only', async () => {
    const bodies: unknown[] = [];
    stubFetch(async (_url: unknown, init: unknown) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      return new Response(batchFrame(2), { status: 200 });
    });
    await makeQwenProvider().synthesizeBatch({
      modelKey: 'qwen3-tts-0.6b',
      /* Batch-level: a batch is always one chapter of one book, so there is
         exactly one book language. Per-ITEM `cloned` is what varies, and it is
         what decides whether that language reaches the wire for a given item. */
      language: 'de',
      items: [
        { text: 'Der alte Leuchtturm.', voiceName: 'qwen-cloned', cloned: true },
        { text: 'The old lighthouse.', voiceName: 'qwen-designed' },
      ],
    });
    const items = (bodies[0] as { items: Array<Record<string, unknown>> }).items;
    expect(items[0].language).toBe('German');
    expect(items[1]).not.toHaveProperty('language');
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

describe('fs-38 Wave 3c Task 17 — substituted cloned coqui voice is fatal [EX-8]', () => {
  /* D-F: cloned ⇒ fail loud, designed ⇒ fail soft (never a NEW hard
     failure). The `xtts-` storage-key prefix is Coqui's clone-capable
     manifest slot key (server/src/tts/clone-engines.ts `manifestSlotFor`)
     and, since Task 16, is minted for BOTH `cloned` and `designed`
     provenance — so this gate is deliberately keyed on the `xtts-` prefix
     alone, not on provenance. Gating on the `qwen-` prefix instead would be
     wrong: that prefix is qwen's storage key for designed voices too, and
     making a designed-qwen substitution fatal would violate D-F. */
  function makeQwenProvider() {
    return new SidecarTtsProvider({ url: 'http://localhost:9000/', engine: 'qwen' });
  }

  function substitutionResponse(substitutedFrom: string): Response {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    return new Response(pcm, {
      status: 200,
      headers: {
        'content-type': 'audio/L16;codec=pcm;rate=24000',
        'x-sample-rate': '24000',
        'x-voice-substituted-from': substitutedFrom,
      },
    });
  }

  it('throws when the sidecar substitutes a stock speaker for an xtts- prefixed cloned voice', async () => {
    stubFetch(async () => substitutionResponse('xtts-1111-2222-3333'));

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    /* Assert on the actual code path (the new fatal-substitution branch),
       not merely "something rejected" — a placebo throw from an unrelated
       branch would also make a bare `.rejects` assertion pass. */
    expect(err).not.toBeNull();
    expect(err.message).toMatch(/xtts-1111-2222-3333/);
    expect(err.message).toMatch(/substitut/i);
    /* GATE 1 M-6 — an `expect(err.transient).toBeUndefined()` line used to
       sit here. It was vacuous: this guard throws a plain `new Error`, which
       never carries `.transient` at all, so the assertion passed with the
       feature reverted. Replaced with the discriminating check it was
       presumably reaching for — the throw came from the substitution guard,
       NOT from `throwForResponse`'s status classification (which only ever
       runs on a non-2xx, and this response is a 200). */
    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/XTTS_KEY_PREFIX/);
  });

  /* GATE 1 — the case-varied sibling. This is the THIRD site of the
     un-folded-clone-key defect class on this branch (Task 10a fixed
     `voice-override-linked.ts`, C4 fixed `voice-sample.ts`); each fix
     landed only where it was found. The sidecar sanitises voice ids with a
     case-PRESERVING `re.sub(r"[^A-Za-z0-9_.-]", "_", …)` and then a
     case-INSENSITIVE `os.path.isfile`, so on NTFS/APFS `XTTS-<uuid>.pt`
     opens the real `xtts-<uuid>.pt`. Un-folded, a case-varied key missed
     BOTH the sidecar's latents branch (a stock speaker gets substituted)
     and this guard (the one meant to catch that substitution). Deliberately
     NOT overstated: C4 closed the reachable entry point, so this is
     defence-in-depth — but the fold is free and the blind spot was real. */
  it('GATE 1: the fatal-substitution guard is case-folded — `XTTS-<uuid>` must not slip past it', async () => {
    stubFetch(async () => substitutionResponse('XTTS-1111-2222-3333'));

    const err = await makeProvider()
      .synthesize(SYNTH_INPUT)
      .then(
        () => null,
        (e) => e,
      );

    expect(err).not.toBeNull();
    expect(err.message).toMatch(/XTTS-1111-2222-3333/);
    expect(err.message).toMatch(/substitut/i);
  });

  it('still only warns when the substituted voice is a plain catalog name', async () => {
    stubFetch(async () => substitutionResponse('Nonexistent Voice'));

    const result = await makeProvider().synthesize(SYNTH_INPUT);

    /* Must actually reach the return — a widened gate that fired on every
       substitution would turn this into a rejection instead. */
    expect(result.voiceSubstitutedFrom).toBe('Nonexistent Voice');
  });

  it('still only warns when a qwen- prefixed DESIGNED voice is substituted (regression guard for D-F)', async () => {
    /* Regression guard for the failure-policy split: `qwen-<uuid>` is also
       the storage key for designed voices (server/src/tts/clone-engines.ts
       `libraryVoiceForEngine`), so gating on the `qwen-` prefix — instead of
       `xtts-` — would make this case fatal too, which D-F forbids. This
       test would fail if someone widened the gate that way. */
    stubFetch(async () => substitutionResponse('qwen-4444-5555-6666'));

    const result = await makeQwenProvider().synthesize({
      text: 'hello',
      voiceName: 'qwen-4444-5555-6666',
      modelKey: 'qwen3-tts-0.6b',
    });

    expect(result.voiceSubstitutedFrom).toBe('qwen-4444-5555-6666');
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
