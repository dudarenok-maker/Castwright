/* fs-60 — Qwen → Coqui graceful fallback for non-English books. Mirrors the
   structure of the existing "Qwen→Kokoro graceful fallback" and
   "forbidKokoroFallback" describe blocks in synthesise-chapter.test.ts — this
   is the Coqui-eligible-language counterpart to the still-unsupported-language
   fail-loud case those blocks already pin. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { synthesiseChapter, MissingDesignedVoiceError, type CastCharacter } from './synthesise-chapter.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const COQUI_VOICE_RE = /^[A-Z][a-z]+ [A-Z][a-z]+$/; // "Claribel Dervla"-shaped catalog names

function makeProvider(): TtsProvider & { calls: SynthesizeInput[] } {
  const calls: SynthesizeInput[] = [];
  return {
    calls,
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      calls.push(input);
      return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
}

function sentence(id: number, characterId = 'wren'): SentenceOutput {
  return { id, chapterId: 1, characterId, text: 'Привет, это тестовое предложение для проверки.' };
}

function multiEngine() {
  const qwen = makeProvider();
  const coqui = makeProvider();
  const resolveForEngine = (e: string) =>
    e === 'coqui'
      ? { provider: coqui, modelKey: 'coqui-xtts-v2' as const }
      : { provider: qwen, modelKey: 'qwen3-tts-0.6b' as const };
  return { qwen, coqui, resolveForEngine };
}

describe('synthesiseChapter — Qwen→Coqui fallback (fs-60)', () => {
  it('falls an undesigned Qwen character back to Coqui when coquiEligible + forbidKokoroFallback', async () => {
    const cast: CastCharacter[] = [{ id: 'wren', name: 'Wren', gender: 'female' }];
    const { qwen, coqui, resolveForEngine } = multiEngine();

    const result = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
    });

    expect(qwen.calls).toHaveLength(0);
    expect(coqui.calls).toHaveLength(1);
    expect(coqui.calls[0].voiceName).toMatch(COQUI_VOICE_RE);
    expect(coqui.calls[0].language).toBe('ru');
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBe('coqui');
  });

  it('still throws MissingDesignedVoiceError when coquiEligible is false (still-unsupported language)', async () => {
    const cast: CastCharacter[] = [{ id: 'wren', name: 'Wren', gender: 'female' }];
    const { qwen, coqui, resolveForEngine } = multiEngine();

    await expect(
      synthesiseChapter({
        sentences: [sentence(1)],
        cast,
        provider: qwen,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        resolveForEngine,
        forbidKokoroFallback: true,
        coquiEligible: false,
        // 'ko' (not 'zh') — fs-59 W4b made zh Coqui-eligible, so it's no longer
        // a valid "still-unsupported language" example here; Korean stays
        // genuinely unsupported. coquiEligible is passed directly (not derived
        // from resolveEligibleEngines), so this pins the flag-handling path.
        bookLanguage: 'ko',
      }),
    ).rejects.toBeInstanceOf(MissingDesignedVoiceError);

    expect(qwen.calls).toHaveLength(0);
    expect(coqui.calls).toHaveLength(0);
  });

  it('does NOT fall back a designed Qwen voice when the engine is available, even if coquiEligible', async () => {
    const cast: CastCharacter[] = [
      { id: 'marlow', name: 'Marlow', gender: 'male', overrideTtsVoices: { qwen: { name: 'qwen-marlow' } } },
    ];
    const { qwen, coqui, resolveForEngine } = multiEngine();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'marlow')],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
    });

    expect(qwen.calls).toHaveLength(1);
    expect(coqui.calls).toHaveLength(0);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBeUndefined();
  });

  it('serializes a mixed Qwen+Coqui chapter: all Qwen segments render before any Coqui segment starts', async () => {
    const cast: CastCharacter[] = [
      { id: 'marlow', name: 'Marlow', gender: 'male', overrideTtsVoices: { qwen: { name: 'qwen-marlow' } } },
      { id: 'wren', name: 'Wren', gender: 'female' }, // undesigned -> falls back to Coqui
    ];
    const { qwen, coqui } = multiEngine();
    const callOrder: string[] = [];
    const trackedQwen = {
      ...qwen,
      async synthesize(input: SynthesizeInput) {
        callOrder.push('qwen');
        return qwen.synthesize(input);
      },
    };
    const trackedCoqui = {
      ...coqui,
      async synthesize(input: SynthesizeInput) {
        callOrder.push('coqui');
        return coqui.synthesize(input);
      },
    };
    const tracked = (e: string) =>
      e === 'coqui'
        ? { provider: trackedCoqui, modelKey: 'coqui-xtts-v2' as const }
        : { provider: trackedQwen, modelKey: 'qwen3-tts-0.6b' as const };

    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'marlow'), sentence(2, 'wren'), sentence(3, 'marlow')],
      cast,
      provider: trackedQwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine: tracked,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
    });

    // All 'qwen' entries must precede all 'coqui' entries — never interleaved.
    const firstCoqui = callOrder.indexOf('coqui');
    const lastQwen = callOrder.lastIndexOf('qwen');
    expect(firstCoqui).toBeGreaterThan(-1);
    expect(lastQwen).toBeLessThan(firstCoqui);
    // Output stays in original sentence-index order regardless of dispatch order.
    const bodySegments = result.segments.filter((s) => s.kind !== 'title');
    expect(bodySegments.map((s) => s.sentenceIds?.[0])).toEqual([1, 2, 3]);
  });

  it('serializes a mixed Qwen+Coqui segment-QA re-record round too, not just the initial dispatch', async () => {
    const cast: CastCharacter[] = [
      { id: 'marlow', name: 'Marlow', gender: 'male', overrideTtsVoices: { qwen: { name: 'qwen-marlow' } } },
      { id: 'wren', name: 'Wren', gender: 'female' }, // undesigned -> falls back to Coqui
    ];
    const callOrder: string[] = [];
    let qwenCallCount = 0;
    const trackedQwen: TtsProvider = {
      async synthesize(): Promise<SynthesizeOutput> {
        qwenCallCount += 1;
        callOrder.push('qwen');
        /* Marlow is the chapter's anchor group (groups[0]) — its FIRST call
           renders silence (fails segment-QA, triggers a re-record); the
           re-record call renders real audio. */
        const silent = qwenCallCount === 1;
        return { pcm: Buffer.alloc(silent ? 4 : 4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };
    let coquiCallCount = 0;
    const trackedCoqui: TtsProvider = {
      async synthesize(): Promise<SynthesizeOutput> {
        coquiCallCount += 1;
        callOrder.push('coqui');
        /* Wren is the (coqui-only) body dispatch — its FIRST call also renders
           silence, so it's suspect too and joins the same re-record round. */
        const silent = coquiCallCount === 1;
        return { pcm: Buffer.alloc(silent ? 4 : 4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };
    const tracked = (e: string) =>
      e === 'coqui'
        ? { provider: trackedCoqui, modelKey: 'coqui-xtts-v2' as const }
        : { provider: trackedQwen, modelKey: 'qwen3-tts-0.6b' as const };

    /* fetch is only ever called by evictQwenForCoquiPhase in this test (fully
       mocked providers, no other network path) — track it in the SAME
       callOrder sequence so the assertion below can see exactly where the
       evict happened relative to the qwen/coqui calls. */
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      callOrder.push('evict');
      return new Response(null, { status: 200 });
    });

    /* Marks the callOrder index where the re-record round's OWN dispatch
       begins — fires once per pending group, all BEFORE synthGroupsSerialized
       is invoked for that round (see synthesise-chapter.ts's re-record loop),
       so the first call gives the exact boundary. Anchoring the assertion to
       this boundary (rather than a global ordering across the whole test)
       avoids the anchor group's own single, un-serialized synth call — which
       can legitimately produce a 'coqui'/'qwen' entry before the re-record
       round even starts — from making the assertion unsatisfiable. */
    let rerecordStartIndex = -1;
    await synthesiseChapter({
      sentences: [sentence(1, 'marlow'), sentence(2, 'wren')],
      cast,
      provider: trackedQwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine: tracked,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
      maxSegmentRerecords: 1,
      onSegmentRerecord: () => {
        if (rerecordStartIndex === -1) rerecordStartIndex = callOrder.length;
      },
    });

    expect(rerecordStartIndex).toBeGreaterThan(-1);
    /* Within the re-record round specifically: qwen renders, THEN an evict,
       THEN coqui renders — never interleaved, never skipping the evict. This
       is the exact sequence that only exists once the re-record loop is
       routed through synthGroupsSerialized instead of synthGroupsBatched
       directly; on the unfixed code this would read ['qwen', 'coqui'] with no
       'evict' entry at all. */
    expect(callOrder.slice(rerecordStartIndex)).toEqual(['qwen', 'evict', 'coqui']);
  });

  it('renders every group when a chapter mixes qwen + coqui + a third engine (kokoro) — none dropped', async () => {
    /* Reachability note: Pearl is pinned to Kokoro via the per-character
       `ttsEngine` field (per-character-engine.ts's resolveCharacterEngine),
       NOT via the Qwen→Kokoro *fallback* path (applyQwenFallback) that
       forbidKokoroFallback gates. routeFor only calls applyQwenFallback when
       the character's resolved route is 'qwen' with a missing/unavailable
       voice; Pearl's route is 'kokoro' from the start, so it's untouched by
       forbidKokoroFallback and reaches synthGroupsSerialized as a genuine
       third engine alongside Wren's qwen->coqui fallback and Marlow's
       designed Qwen voice. This is how the {qwen, coqui, third} group set
       gets constructed. */
    const cast: CastCharacter[] = [
      { id: 'marlow', name: 'Marlow', gender: 'male', overrideTtsVoices: { qwen: { name: 'qwen-marlow' } } },
      { id: 'wren', name: 'Wren', gender: 'female' }, // undesigned -> falls back to Coqui
      { id: 'pearl', name: 'Pearl', gender: 'female', ttsEngine: 'kokoro' }, // explicit per-character pin
    ];

    const callOrder: string[] = [];
    const makeTracked = (label: string): TtsProvider & { calls: SynthesizeInput[] } => {
      const calls: SynthesizeInput[] = [];
      return {
        calls,
        async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
          calls.push(input);
          callOrder.push(label);
          return { pcm: Buffer.alloc(4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
        },
      };
    };
    const qwen = makeTracked('qwen');
    const coqui = makeTracked('coqui');
    const kokoro = makeTracked('kokoro');
    const tracked = (e: string) => {
      if (e === 'coqui') return { provider: coqui, modelKey: 'coqui-xtts-v2' as const };
      if (e === 'kokoro') return { provider: kokoro, modelKey: 'kokoro-v1' as const };
      return { provider: qwen, modelKey: 'qwen3-tts-0.6b' as const };
    };

    /* fetch is only ever hit by evictQwenForCoquiPhase in this test (fully
       mocked providers) — track it in the same callOrder sequence so the
       ordering assertion below can see exactly where the evict happened. */
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      callOrder.push('evict');
      return new Response(null, { status: 200 });
    });

    const result = await synthesiseChapter({
      sentences: [
        sentence(1, 'marlow'), // anchor group — rendered standalone, before synthGroupsSerialized
        sentence(2, 'wren'), // body: falls back qwen -> coqui
        sentence(3, 'pearl'), // body: pinned kokoro (the previously-dropped third engine)
        sentence(4, 'marlow'), // body: designed qwen
      ],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine: tracked,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
    });

    // The previously-dropped third-engine group now actually renders.
    expect(kokoro.calls).toHaveLength(1);

    // No sentence's group silently disappears — a body segment for every one.
    const bodySegments = result.segments.filter((s) => s.kind !== 'title');
    expect(bodySegments.map((s) => s.sentenceIds?.[0])).toEqual([1, 2, 3, 4]);

    // Coqui only ever renders after the evict — never before it, never
    // interleaved with the pre-evict (qwen + kokoro) phase.
    const evictIndex = callOrder.indexOf('evict');
    expect(evictIndex).toBeGreaterThan(-1);
    expect(callOrder.slice(0, evictIndex)).not.toContain('coqui');
    const coquiIndices = callOrder
      .map((v, i) => (v === 'coqui' ? i : -1))
      .filter((i) => i > -1);
    expect(coquiIndices.length).toBeGreaterThan(0);
    expect(coquiIndices.every((i) => i > evictIndex)).toBe(true);
  });
});
