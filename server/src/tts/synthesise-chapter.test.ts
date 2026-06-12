/* Regression coverage for the chapter synthesis voice-routing contract.

   The Elwyn/Ro bug: synthesiseChapter dropped every hint field from the cast
   before calling pickVoiceForEngine. The picker then had nothing to work with
   beyond id/name/attributes, inferGender returned 'unknown' for any character
   whose attributes didn't contain a gendered noun, and the fallback was
   narrator-cool. Net effect: Oduvan (male) and Ro (female) both came out
   sounding like the narrator.

   These tests pin the contract so a future refactor cannot silently revert
   the hint plumbing. They use a fake provider (no real synthesis) and assert
   on the voiceName argument the picker resolves for each speaker. */

import { describe, it, expect, vi } from 'vitest';
import {
  buildSentenceGroups,
  synthesiseChapter,
  resolveQwenTokenBudget,
  DEFAULT_QWEN_BATCH_TOKEN_BUDGET,
  ChapterSynthTimeoutError,
  MissingDesignedVoiceError,
  RecycleStormError,
  type CastCharacter,
} from './synthesise-chapter.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type {
  SynthesizeInput,
  SynthesizeOutput,
  SynthesizeBatchInput,
  SynthesizeBatchOutput,
  TtsProvider,
} from './index.js';

const GEMINI_MALE_VOICES = new Set(['Charon', 'Algieba', 'Puck', 'Orus', 'Iapetus', 'Sadachbia']);
const GEMINI_FEMALE_VOICES = new Set([
  'Despina',
  'Vindemiatrix',
  'Kore',
  'Leda',
  'Aoede',
  'Callirrhoe',
]);
const GEMINI_NARRATOR_VOICES = new Set(['Zephyr', 'Sulafat', 'Algenib', 'Achernar']);

function makeProvider(): TtsProvider & { calls: Array<SynthesizeInput> } {
  const calls: SynthesizeInput[] = [];
  return {
    calls,
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      calls.push(input);
      /* Minimum-viable PCM (one stereo-equivalent 16-bit sample at 24 kHz).
         synthesiseChapter only inspects sampleRate and length; content is
         irrelevant. */
      return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
}

function sentence(id: number, characterId: string, text = 'Line.'): SentenceOutput {
  return { id, chapterId: 1, characterId, text };
}

describe('synthesiseChapter voice routing', () => {
  it('routes a male character to the male voice bucket when gender is set on the cast', async () => {
    const cast: CastCharacter[] = [
      {
        id: 'oduvan',
        name: 'Oduvan',
        gender: 'male',
        ageRange: 'adult',
        attributes: ['caring', 'firm', 'patient'],
        description: 'A medical professional balancing genuine care with firmness.',
      },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'oduvan')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });

    expect(provider.calls).toHaveLength(1);
    const used = provider.calls[0].voiceName;
    expect(GEMINI_MALE_VOICES, `Expected ${used} in male bucket`).toContain(used);
    expect(GEMINI_NARRATOR_VOICES, `Got narrator voice ${used} for male cast`).not.toContain(used);
  });

  it('routes a female character to the female voice bucket when gender is set on the cast', async () => {
    const cast: CastCharacter[] = [
      {
        id: 'ro',
        name: 'Ro',
        gender: 'female',
        ageRange: 'adult',
        attributes: ['sarcastic', 'blunt', 'intimidating'],
        description: 'A sharp-tongued goblin with brutal honesty.',
      },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'ro')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });

    const used = provider.calls[0].voiceName;
    expect(GEMINI_FEMALE_VOICES, `Expected ${used} in female bucket`).toContain(used);
    expect(GEMINI_NARRATOR_VOICES, `Got narrator voice ${used} for female cast`).not.toContain(
      used,
    );
  });

  it('keeps the narrator on a narrator voice', async () => {
    const cast: CastCharacter[] = [
      {
        id: 'narrator',
        name: 'Narrator',
        attributes: ['observational'],
        tone: { warmth: 24, pace: 65, authority: 70, emotion: 59 },
      },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'narrator')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });

    expect(GEMINI_NARRATOR_VOICES).toContain(provider.calls[0].voiceName);
  });

  it('uses different voice buckets per speaker within the same chapter (multi-character regression)', async () => {
    /* The exact bug scenario from Day One of the the Coalfall Commission: three
       speakers, only the narrator gendered by id. Without the hint plumbing,
       Oduvan and Ro both collapsed onto the narrator-cool bucket. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
      {
        id: 'oduvan',
        name: 'Oduvan',
        gender: 'male',
        ageRange: 'adult',
        attributes: ['caring', 'firm'],
      },
      {
        id: 'ro',
        name: 'Ro',
        gender: 'female',
        ageRange: 'adult',
        attributes: ['sarcastic', 'blunt'],
      },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'And it made Marlow queasier.'),
        sentence(2, 'oduvan', 'Lifetime of pain if you do not listen.'),
        sentence(3, 'ro', 'Moving from denial mode to sulky boy.'),
      ],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });

    expect(provider.calls).toHaveLength(3);
    const [narratorVoice, elwinVoice, roVoice] = provider.calls.map((c) => c.voiceName);

    expect(GEMINI_NARRATOR_VOICES, `narrator → ${narratorVoice}`).toContain(narratorVoice);
    expect(GEMINI_MALE_VOICES, `oduvan → ${elwinVoice}`).toContain(elwinVoice);
    expect(GEMINI_FEMALE_VOICES, `ro → ${roVoice}`).toContain(roVoice);

    /* All three must be distinct — the original bug collapsed them onto the
       same narrator voice. */
    expect(new Set([narratorVoice, elwinVoice, roVoice]).size).toBe(3);
  });

  it('honours an abort signal between groups (per-bookId mutex regression)', async () => {
    /* The per-bookId server mutex aborts the prior handler's controller when a
       new POST arrives for the same book. The synthesis loop must check the
       signal between groups so a stale handler stops within seconds instead
       of running the chapter to completion (each Coqui group can be minutes
       on CPU). This is what unstuck the pause→resume loop. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
      { id: 'oduvan', name: 'Oduvan', gender: 'male', attributes: ['caring'] },
      { id: 'ro', name: 'Ro', gender: 'female', attributes: ['blunt'] },
    ];
    const controller = new AbortController();
    const provider = makeProvider();
    const originalSynth = provider.synthesize.bind(provider);
    provider.synthesize = async (input) => {
      const out = await originalSynth(input);
      if (provider.calls.length === 1) controller.abort();
      return out;
    };

    await expect(
      synthesiseChapter({
        sentences: [
          sentence(1, 'narrator', 'First group.'),
          sentence(2, 'oduvan', 'Second group.'),
          sentence(3, 'ro', 'Third group.'),
        ],
        cast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'gemini',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    /* Group 1 ran (and fired abort); groups 2 and 3 must NOT have run. */
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].voiceName).toBeTruthy();
  });

  it('forwards the abort signal into each provider call so a mid-call abort cancels the fetch', async () => {
    /* The sidecar's /synthesize call can take a minute on CPU; the
       between-groups check alone isn't enough if we're inside a slow call
       when the user pauses or a fresh POST displaces us. The provider must
       receive the same signal so the underlying fetch rejects with
       AbortError mid-flight. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
    ];
    const controller = new AbortController();
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'Line.')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      signal: controller.signal,
      /* Watchdog OFF: with no per-call timeout the parent signal is forwarded
         verbatim, which is what this identity assertion pins. The derived-child
         path (callTimeoutMs > 0) is covered by the plan-148 timeout tests. */
      callTimeoutMs: 0,
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].signal).toBe(controller.signal);
  });

  it('fires onGroupStart BEFORE the provider call for each group (stall-timer reset regression)', async () => {
    /* The "Worker has gone quiet" bug: a single same-speaker group can be a
       multi-minute synth call on CPU. The client's 30s stall detector fires
       if no tick arrives in that window. Without onGroupStart we only ticked
       at group completion, which made every long call look like a hang.

       This test pins the *ordering*: onGroupStart must run before the
       provider.synthesize call, so the SSE route can emit a "started" tick
       that resets the stall timer at the start of each group. Future
       refactors that move the callback after the synth would silently
       regress the stall UX. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
      { id: 'oduvan', name: 'Oduvan', gender: 'male', attributes: ['caring'] },
    ];
    const events: string[] = [];
    const provider: TtsProvider = {
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        events.push(`synth:${input.voiceName}`);
        return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };

    await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'First.'), sentence(2, 'oduvan', 'Second.')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      onGroupStart: ({ group }) => events.push(`start:${group.characterId}`),
      onGroupComplete: ({ group }) => events.push(`complete:${group.characterId}`),
    });

    /* Strict ordering per group: start → synth → complete. The exact voice
       name chosen by pickVoiceForEngine isn't load-bearing here — only that
       a synth event is sandwiched between start and complete for each group. */
    expect(events).toHaveLength(6);
    expect(events[0]).toBe('start:narrator');
    expect(events[1]).toMatch(/^synth:/);
    expect(events[2]).toBe('complete:narrator');
    expect(events[3]).toBe('start:oduvan');
    expect(events[4]).toMatch(/^synth:/);
    expect(events[5]).toBe('complete:oduvan');
  });

  it('scrubs all-caps openers and em-dashes before handing text to the provider (chapter-2 regression)', async () => {
    /* The canonical The Hollow Tide chapter-2 opener fed XTTS
       a 3-sentence narrator group whose first sentence was all-caps
       ("THE NEXT SECOND WAS A BLUR.") with two em-dashes in the
       follow-on. XTTS spelled the all-caps letter-by-letter and looped
       around the dashes, producing ~60s of garbled audio for what
       should have been ~13s of speech.

       The synth path now runs `normaliseForTts` immediately before each
       provider call. This test pins that contract end-to-end: assert on
       what the provider actually received, not on the helper alone, so
       a future refactor that bypasses the normalizer fails here. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'THE NEXT SECOND WAS A BLUR.'),
        sentence(
          2,
          'narrator',
          'The car swerved right—missing Wren by inches—then jumped the curb and sideswiped a streetlight.',
        ),
        sentence(
          3,
          'narrator',
          'The heavy steel lantern cracked from its base and plummeted toward Wren.',
        ),
      ],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });

    /* Plan 70d: one provider call per sentence (no same-speaker folding).
       The normalisation contract still applies to every group — assert
       per-call so a future regression to either the folding or the
       normaliser surfaces here. */
    expect(provider.calls).toHaveLength(3);
    for (const call of provider.calls) {
      expect(call.text, `provider received: ${call.text}`).not.toMatch(/[A-Z]{3,}/);
      expect(call.text, `provider received: ${call.text}`).not.toMatch(/[—–]/);
    }
    expect(provider.calls[0].text).toBe('The Next Second Was A Blur.');
    expect(provider.calls[1].text).toContain('Wren by inches, then');
  });

  it('resamples mid-chapter sample-rate mismatches to the first-group anchor (Kokoro/Coqui co-cast regression)', async () => {
    /* Per-character engine overrides allow a chapter to mix Kokoro (24 kHz)
       and Coqui (22.05 kHz) speakers. Before resampling landed, the synth
       loop threw on the first mismatched group, bricking the chapter for a
       recoverable condition. Pin: a chapter whose second group returns a
       different sampleRate completes without throwing, and the segments
       array stays monotonic. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
      { id: 'oduvan', name: 'Oduvan', gender: 'male', attributes: ['caring'] },
    ];
    let callIndex = 0;
    const provider: TtsProvider = {
      async synthesize(_input: SynthesizeInput): Promise<SynthesizeOutput> {
        /* First group: 24 kHz (Kokoro anchor). Second group: 22.05 kHz —
           the synth loop must resample group 2 to the 24 kHz anchor. The
           PCM payload here is real enough to flow through the resampler
           (10 samples each), so we exercise the actual resample path. */
        const sampleRate = callIndex++ === 0 ? 24000 : 22050;
        const pcm = Buffer.alloc(10 * 2);
        for (let i = 0; i < 10; i++) pcm.writeInt16LE(1000 + i * 100, i * 2);
        return { pcm, sampleRate, mimeType: 'audio/pcm' };
      },
    };

    const result = await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'First group.'),
        sentence(2, 'oduvan', 'Second group with a different rate.'),
      ],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });

    /* No throw, chapter anchors on the first group's rate. */
    expect(result.sampleRate).toBe(24000);
    expect(result.segments).toHaveLength(2);
    /* Segments are monotonic and contiguous — the resampled group's byte
       count contributes to the second segment's endSec, which must be
       strictly greater than the first segment's endSec. */
    expect(result.segments[1].startSec).toBe(result.segments[0].endSec);
    expect(result.segments[1].endSec).toBeGreaterThan(result.segments[1].startSec);
    /* Concatenated PCM length is consistent with the duration at the
       anchor rate (2 bytes per sample at 24 kHz). */
    const expectedBytes = Math.round(result.durationSec * 24000) * 2;
    expect(Math.abs(result.pcm.length - expectedBytes)).toBeLessThanOrEqual(2);
  });

  it('falls back to gendered inference from description when explicit gender is absent', async () => {
    /* Belt-and-braces: if the analyzer cached an older shape without
       `gender:`, the prose description still carries enough signal to land
       in the right bucket. */
    const cast: CastCharacter[] = [
      {
        id: 'marlow',
        name: 'Marlow',
        attributes: ['playful', 'witty'],
        description:
          'A witty young man recovering from his injuries. He often grins and jokes when he is scared. He keeps trying to reassure himself.',
      },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'marlow')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });

    const used = provider.calls[0].voiceName;
    expect(
      GEMINI_MALE_VOICES,
      `Expected description-based fallback to male, got ${used}`,
    ).toContain(used);
  });
});

/* ── Transient-failure auto-retry ──────────────────
   End-to-end coverage of the retry wiring: when the provider throws a
   transient error, synthesiseChapter must NOT fail the chapter — it must
   re-call the provider after a short backoff. When the failure persists
   past the retry budget, the chapter must fail with the last underlying
   error. The retry helper's own contract is unit-tested in
   `retry.test.ts`; these tests pin the wiring at the call site. */

describe('synthesiseChapter auto-retry on transient TTS failures', () => {
  it("absorbs two transient 503s and returns the third attempt's audio", async () => {
    /* The headline plan-13 scenario: sidecar returns 503 twice (e.g. brief
       CUDA OOM, mid-restart 502 surfaced as 503), then a 200. The retry
       wrapper inside the per-group loop must replay the call so the
       chapter completes without the user clicking Retry. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
    ];
    const events: string[] = [];
    let attemptIndex = 0;
    const provider: TtsProvider = {
      async synthesize(_input: SynthesizeInput): Promise<SynthesizeOutput> {
        attemptIndex += 1;
        events.push(`attempt:${attemptIndex}`);
        if (attemptIndex < 3) {
          throw Object.assign(new Error(`Local TTS sidecar returned 503: model loading`), {
            transient: true as const,
            status: 503,
          });
        }
        return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };
    const retries: number[] = [];

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'Line.')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      onGroupRetry: ({ attempt }) => retries.push(attempt),
    });

    /* Three provider invocations total (1 primary + 2 retries). */
    expect(events).toEqual(['attempt:1', 'attempt:2', 'attempt:3']);
    /* onGroupRetry fired twice — once before attempt 2, once before attempt 3. */
    expect(retries).toEqual([2, 3]);
    /* Chapter completed normally; PCM round-trips through. */
    expect(result.pcm.length).toBe(2);
    expect(result.segments).toHaveLength(1);
  });

  it('throws the last transient error when all retries fail', async () => {
    /* Retry budget exhausts → the underlying error bubbles out so the
       route can flip the chapter to chapter_failed with a meaningful
       message. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
    ];
    let attemptIndex = 0;
    const provider: TtsProvider = {
      async synthesize(_input: SynthesizeInput): Promise<SynthesizeOutput> {
        attemptIndex += 1;
        throw Object.assign(
          new Error(`Local TTS sidecar returned 503: persistent #${attemptIndex}`),
          { transient: true as const, status: 503 },
        );
      },
    };

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'narrator', 'Line.')],
        cast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'gemini',
      }),
    ).rejects.toThrow(/persistent #3/);

    /* 3 attempts = 1 primary + 2 retries. */
    expect(attemptIndex).toBe(3);
  });

  it('does NOT retry a non-transient error (4xx fails immediately)', async () => {
    /* A 400 (bad request — model name unknown) won't get better on
       retry. Bail on the first throw so the user sees the actionable
       error fast instead of waiting through two needless backoffs. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
    ];
    let attemptIndex = 0;
    const provider: TtsProvider = {
      async synthesize(_input: SynthesizeInput): Promise<SynthesizeOutput> {
        attemptIndex += 1;
        throw Object.assign(new Error(`Local TTS sidecar returned 400: unknown model 'wat'`), {
          transient: false as const,
          status: 400,
        });
      },
    };

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'narrator', 'Line.')],
        cast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'gemini',
      }),
    ).rejects.toThrow(/unknown model/);

    expect(attemptIndex).toBe(1);
  });

  it('does NOT retry a poisoned-CUDA 503 (poisoned bodies need a restart, not a retry)', async () => {
    /* The sidecar's CUDA-poison fast-fail (`{ "detail": "...", "poisoned":
       true }` body) won't recover until the sidecar restarts. SidecarTtsProvider
       annotates these with `transient: false`; even though the status code
       is 503, the retry wrapper must bail immediately so the UI can
       surface the "restart the sidecar" banner without delay. This test
       simulates that annotation. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
    ];
    let attemptIndex = 0;
    const provider: TtsProvider = {
      async synthesize(_input: SynthesizeInput): Promise<SynthesizeOutput> {
        attemptIndex += 1;
        throw Object.assign(
          new Error(`Local TTS sidecar returned 503: TTS sidecar is in a poisoned CUDA state…`),
          { transient: false as const, status: 503, poisoned: true },
        );
      },
    };

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'narrator', 'Line.')],
        cast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'gemini',
      }),
    ).rejects.toThrow(/poisoned/);

    expect(attemptIndex).toBe(1);
  });

  it('honours an abort signal mid-retry (caller Stop wins over the retry sleep)', async () => {
    /* The user clicks Stop while the queue is mid-retry. The retry's
       backoff sleep must reject promptly with AbortError so the route
       can tear down the handler instead of waiting out the full delay. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
    ];
    const controller = new AbortController();
    let attemptIndex = 0;
    const provider: TtsProvider = {
      async synthesize(_input: SynthesizeInput): Promise<SynthesizeOutput> {
        attemptIndex += 1;
        /* Trigger abort once the first transient has thrown — the retry
           wrapper's sleep should pick this up immediately. */
        setTimeout(() => controller.abort(), 5);
        throw Object.assign(new Error(`Local TTS sidecar returned 503: brief flake`), {
          transient: true as const,
          status: 503,
        });
      },
    };

    const start = Date.now();
    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'narrator', 'Line.')],
        cast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'gemini',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const elapsed = Date.now() - start;

    /* Only the primary attempt ran; the retry sleep was aborted before
       a second provider invocation could fire. Bound is generous (200 ms)
       to absorb slow CI but tight enough that a full backoff (500 ms
       primary + jitter) would fail it. */
    expect(attemptIndex).toBe(1);
    expect(elapsed).toBeLessThan(200);
  });
});

/* ── Chapter-title beat + leading/trailing silence ───────────────────
   Production bug: chapter titles were never voiced and chapters
   concatenated gaplessly. The synth path now prepends
   `[1.5s silence] + [narrator voicing the title] + [1.5s silence]`
   when the caller supplies a `chapterTitleNarration`. These tests pin
   the contract: title is narrator-voiced, silences bracket it at the
   title's sample rate, body segments stay monotonic after the prepend,
   and the legacy no-title path keeps the original zero-padding shape. */
describe('synthesiseChapter chapter-title beat', () => {
  it('prepends a narrator-voiced title segment with leading + trailing silence', async () => {
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
      { id: 'marlow', name: 'Marlow', gender: 'male', attributes: ['witty'] },
    ];
    const provider = makeProvider();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'marlow', 'Body line one.')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      chapterTitleNarration: 'Chapter 2. Moolark.',
    });

    /* Two provider calls: title first, then body. The title's voiceName
       comes from the narrator bucket — confirms the narrator routing
       runs for the synthetic title beat the same way it runs for the
       narrator's own sentences. */
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].text).toBe('Chapter 2. Moolark.');
    expect(GEMINI_NARRATOR_VOICES, `title voiced by ${provider.calls[0].voiceName}`).toContain(
      provider.calls[0].voiceName,
    );

    /* Title segment lands first with kind: 'title', empty sentenceIds[],
       and starts AFTER the 1.5s leading silence. */
    expect(result.segments[0].kind).toBe('title');
    expect(result.segments[0].characterId).toBe('narrator');
    expect(result.segments[0].sentenceIds).toEqual([]);
    expect(result.segments[0].startSec).toBeCloseTo(1.5, 3);

    /* Body segment starts AFTER the title beat + the 1.5s post-title
       silence. The fake provider returns a 1-sample (≈ 41.7 µs at
       24 kHz) PCM for the title, so titleEndSec ≈ 1.5 + 0.0000417 and
       body startSec ≈ 1.5 + 0.0000417 + 1.5 ≈ 3.0. */
    expect(result.segments[1].kind).toBeUndefined();
    expect(result.segments[1].characterId).toBe('marlow');
    expect(result.segments[1].startSec).toBeCloseTo(3.0, 2);
  });

  it('skips the title beat AND silence when chapterTitleNarration is empty/blank', async () => {
    /* Legacy path: callers that don't opt in get the original zero-padding
       shape. Body segment starts at t=0 exactly. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
    ];
    const provider = makeProvider();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'Body only.')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      chapterTitleNarration: '   ',
    });

    expect(provider.calls).toHaveLength(1);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].startSec).toBe(0);
    expect(result.segments[0].kind).toBeUndefined();
  });

  it('anchors the chapter sample rate on the title response (Kokoro/Coqui co-cast with title)', async () => {
    /* When a title is prepended, the title's sampleRate becomes the chapter
       anchor — NOT the first body group's. Pin: title at 24 kHz, body at
       22.05 kHz → the final concatenated buffer stays at 24 kHz throughout
       (the body group gets resampled). Catches a future refactor that
       accidentally lets the body loop re-anchor mid-chapter. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
      { id: 'oduvan', name: 'Oduvan', gender: 'male', attributes: ['caring'] },
    ];
    let callIndex = 0;
    const provider: TtsProvider = {
      async synthesize(_input: SynthesizeInput): Promise<SynthesizeOutput> {
        const sampleRate = callIndex++ === 0 ? 24000 : 22050;
        const pcm = Buffer.alloc(10 * 2);
        for (let i = 0; i < 10; i++) pcm.writeInt16LE(1000 + i * 100, i * 2);
        return { pcm, sampleRate, mimeType: 'audio/pcm' };
      },
    };

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'oduvan', 'Body line at a mismatched rate.')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      chapterTitleNarration: 'Chapter 1.',
    });

    expect(result.sampleRate).toBe(24000);
    /* Two segments: title (kind: 'title') + one body group. Both timed
       against the 24 kHz anchor. */
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].kind).toBe('title');
    expect(result.segments[1].startSec).toBeGreaterThanOrEqual(result.segments[0].endSec);
  });

  it('fires onTitleStart and onTitleComplete around the title synth call', async () => {
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
    ];
    const events: string[] = [];
    const provider: TtsProvider = {
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        events.push(`synth:${input.text}`);
        return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };

    await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'Body.')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      chapterTitleNarration: 'Chapter 1.',
      onTitleStart: () => events.push('title-start'),
      onTitleComplete: ({ accumulatedSec }) =>
        events.push(`title-complete:${accumulatedSec > 1 ? 'past-leading-silence' : 'too-early'}`),
    });

    /* Ordering: onTitleStart fires BEFORE the title synth (so the SSE
       stall timer resets), onTitleComplete fires AFTER. Body synth
       follows. The accumulatedSec at title-complete must be past the
       1.5 s leading silence — sanity-check that the silence padding
       actually contributed to runningBytes. */
    expect(events[0]).toBe('title-start');
    expect(events[1]).toBe('synth:Chapter 1.');
    expect(events[2]).toBe('title-complete:past-leading-silence');
    expect(events[3]).toBe('synth:Body.');
  });

  it('uses the fallback narrator hint when the cast has no narrator row', async () => {
    /* Defensive: a cast without a `narrator` row still gets a narrator-bucket
       voice for the title beat. The fallback character is constructed inline
       with no gender/age hints; pickVoiceForEngine routes that to the
       narrator-cool bucket (which IS what we want for chapter titles). */
    const cast: CastCharacter[] = [
      { id: 'marlow', name: 'Marlow', gender: 'male', attributes: ['witty'] },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'marlow', 'Body.')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      chapterTitleNarration: 'Chapter 1.',
    });

    expect(provider.calls).toHaveLength(2);
    expect(GEMINI_NARRATOR_VOICES, `title voiced by ${provider.calls[0].voiceName}`).toContain(
      provider.calls[0].voiceName,
    );
  });
});

/* ── plan 70d — buildSentenceGroups emits one group per sentence ─────
   Earlier code folded consecutive same-speaker sentences into one
   synth call to cut HTTP roundtrips. That folding produced a 207-
   sentence narrator group on the canonical Keeper book that ran past
   the 30 s "Worker has gone quiet" watchdog and either timed out or
   hung at very large context sizes. Per-sentence groups: continuous
   progress ticks (one per sentence), bounded synth duration, no voice
   drift from large-context prosody pressure. */
describe('buildSentenceGroups (plan 70d — per-sentence)', () => {
  function s(id: number, characterId: string, text: string): SentenceOutput {
    return { id, chapterId: 1, characterId, text };
  }

  it('emits one group per sentence even when consecutive sentences share a speaker', () => {
    const groups = buildSentenceGroups([
      s(1, 'narrator', 'A.'),
      s(2, 'narrator', 'B.'),
      s(3, 'narrator', 'C.'),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.text)).toEqual(['A.', 'B.', 'C.']);
    expect(groups.map((g) => g.sentenceIds)).toEqual([[1], [2], [3]]);
    expect(groups.map((g) => g.index)).toEqual([0, 1, 2]);
  });

  it('fs-25 — carries each sentence\'s emotion onto its group (undefined when absent)', () => {
    const groups = buildSentenceGroups([
      { id: 1, chapterId: 1, characterId: 'wren', text: 'Stop!', emotion: 'angry' },
      { id: 2, chapterId: 1, characterId: 'wren', text: 'okay.' },
    ]);
    expect(groups.map((g) => g.emotion)).toEqual(['angry', undefined]);
  });

  it('preserves order across mixed speakers', () => {
    const groups = buildSentenceGroups([
      s(1, 'narrator', 'Open.'),
      s(2, 'wren', 'Hi.'),
      s(3, 'wren', 'Are you there?'),
      s(4, 'narrator', 'Close.'),
    ]);
    expect(groups.map((g) => g.characterId)).toEqual(['narrator', 'wren', 'wren', 'narrator']);
    expect(groups.map((g) => g.text)).toEqual(['Open.', 'Hi.', 'Are you there?', 'Close.']);
  });

  it('scales to a 207-sentence all-narrator chapter (the regression case)', () => {
    /* Chapter 4 of the canonical Keeper book is a structured registry
       file — 207 narrator-only sentences. Pre-fix this collapsed to 1
       giant group; post-fix each becomes its own bounded synth call. */
    const sentences = Array.from({ length: 207 }, (_, i) =>
      s(i + 1, 'narrator', `Sentence ${i + 1}.`),
    );
    const groups = buildSentenceGroups(sentences);
    expect(groups).toHaveLength(207);
    expect(groups[0].text).toBe('Sentence 1.');
    expect(groups[206].text).toBe('Sentence 207.');
  });

  /* The 2026-05-31 ch14 failure: a blank/whitespace sentence reached a synth
     batch and the sidecar rejected it with `400 "item 0: text is required."`,
     failing the whole chapter. Empty-after-normalisation sentences are dropped
     here so they never become a synth item. */
  it('drops sentences whose text is empty/whitespace after normalisation', () => {
    const groups = buildSentenceGroups([
      s(1, 'narrator', 'Open.'),
      s(2, 'narrator', '   '), // whitespace-only → no spoken audio
      s(3, 'wren', 'Hi.'),
      s(4, 'narrator', ''), // empty → dropped
      s(5, 'narrator', 'Close.'),
    ]);
    expect(groups.map((g) => g.text)).toEqual(['Open.', 'Hi.', 'Close.']);
    expect(groups.map((g) => g.sentenceIds)).toEqual([[1], [3], [5]]);
    // index is re-sequenced contiguously over the kept groups (scatter-back key)
    expect(groups.map((g) => g.index)).toEqual([0, 1, 2]);
  });
});

/* ── plan 107 — within-chapter sentence parallelism ──────────────────────
   The body-group dispatch is now a bounded-concurrency worker pool whose
   width defaults to `gpuSemaphore.maxConcurrency` (1 at the conservative
   `GPU_CONCURRENCY=1` default, so production behaviour is unchanged). When an
   operator raises the cap, a single chapter can fan its sentence groups out
   across idle GPU slots. The semaphore inside every provider.synthesize keeps
   real GPU work bounded; this pool only governs Node-layer in-flight count.

   These tests pin the three determinism invariants the parallel dispatch must
   never break, using a deterministic fake provider whose PCM is derived from
   the input text and which can finish groups OUT OF narrative order. */
describe('synthesiseChapter within-chapter parallelism (plan 107)', () => {
  /* Deterministic fake: each call returns PCM derived from the text (one int16
     LE sample per character) at a fixed sample rate, and can delay completion
     so later-dispatched groups finish first. Tracks call order vs. completion
     order so a test can prove the pool actually reordered completion while the
     output stayed in narrative order. */
  function makeDeterministicProvider(opts?: {
    /** Map text → artificial completion delay in ms. Lets a test make group 2
        finish before group 1, exercising the "completion order != index order"
        path that a naive `chunks.push` would corrupt. */
    delayForText?: (text: string) => number;
    sampleRate?: number;
  }): TtsProvider & {
    completionOrder: string[];
    startOrder: string[];
    peakInFlight: number;
  } {
    const sampleRate = opts?.sampleRate ?? 24000;
    const completionOrder: string[] = [];
    const startOrder: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const provider = {
      completionOrder,
      startOrder,
      get peakInFlight() {
        return peakInFlight;
      },
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        startOrder.push(input.text);
        inFlight += 1;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
        const delay = opts?.delayForText?.(input.text) ?? 0;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        inFlight -= 1;
        completionOrder.push(input.text);
        /* PCM derived from text: one int16 LE sample per char (positive
           range). Identical text → identical bytes, so a width-2 vs width-1
           byte comparison is meaningful. */
        const pcm = Buffer.alloc(input.text.length * 2);
        for (let i = 0; i < input.text.length; i++) {
          pcm.writeInt16LE(input.text.charCodeAt(i) & 0x7fff, i * 2);
        }
        return { pcm, sampleRate, mimeType: 'audio/pcm' };
      },
    };
    return provider as TtsProvider & {
      completionOrder: string[];
      startOrder: string[];
      peakInFlight: number;
    };
  }

  const cast: CastCharacter[] = [
    { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
  ];

  /* Distinct per-sentence text so each group's PCM is unique — a reorder bug
     would change byte content, not just length. Different lengths too, so an
     off-by-one concat would shift the segment timings detectably. */
  const SENTENCES = [
    sentence(1, 'narrator', 'First sentence here.'),
    sentence(2, 'narrator', 'Two.'),
    sentence(3, 'narrator', 'A noticeably longer third sentence to vary byte length.'),
    sentence(4, 'narrator', 'Fourth!'),
    sentence(5, 'narrator', 'Fifth and final sentence of the chapter.'),
  ];

  it('produces byte-identical PCM at sentenceConcurrency 2 vs 1 even when groups complete out of order', async () => {
    /* INVARIANT 1 (PCM order) + INVARIANT 2 (deterministic anchor). The delay
       map makes earlier-index groups finish LAST, so a width-2 run completes
       in a different order than it dispatched. The output must still match the
       serial width-1 baseline byte-for-byte: results are collected by
       group.index and concatenated in index order, never completion order. */
    const delayForText = (text: string) => {
      // Longer text → shorter delay, so the long group 3 finishes before the
      // short groups 2/4 it was dispatched alongside.
      return Math.max(0, 60 - text.length);
    };

    const serialProvider = makeDeterministicProvider({ delayForText });
    const serial = await synthesiseChapter({
      sentences: SENTENCES,
      cast,
      provider: serialProvider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      sentenceConcurrency: 1,
    });

    const parallelProvider = makeDeterministicProvider({ delayForText });
    const parallel = await synthesiseChapter({
      sentences: SENTENCES,
      cast,
      provider: parallelProvider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      sentenceConcurrency: 2,
    });

    /* The parallel run actually overlapped (peak > 1) AND completed at least
       one group out of dispatch order — otherwise the test wouldn't be
       exercising the reorder hazard it claims to. */
    expect(parallelProvider.peakInFlight).toBeGreaterThanOrEqual(2);
    expect(parallelProvider.completionOrder).not.toEqual(parallelProvider.startOrder);

    /* The headline assertion: byte-identical audio + identical sample rate +
       identical segment timing regardless of pool width. */
    expect(parallel.pcm.equals(serial.pcm)).toBe(true);
    expect(parallel.sampleRate).toBe(serial.sampleRate);
    expect(parallel.durationSec).toBe(serial.durationSec);
    expect(parallel.segments).toEqual(serial.segments);

    /* Segments stay in narrative order with monotonic, contiguous timing. */
    for (let i = 0; i < parallel.segments.length; i++) {
      expect(parallel.segments[i].groupIndex).toBe(i);
      expect(parallel.segments[i].sentenceIds).toEqual([SENTENCES[i].id]);
      if (i > 0) {
        expect(parallel.segments[i].startSec).toBe(parallel.segments[i - 1].endSec);
      }
    }
  });

  it('anchors the sample rate on the lowest-index group, not the first to complete (deterministic anchor)', async () => {
    /* INVARIANT 2. groups[0] returns 24 kHz but is made to finish LAST; a
       later group returns 22.05 kHz and finishes FIRST. The chapter must
       anchor on groups[0]'s 24 kHz (lowest index), NOT the first completer's
       22.05 kHz. The old `chunks.length === 0` "first to finish" rule would
       have anchored on whichever group raced in first. */
    let callIndex = 0;
    const provider: TtsProvider = {
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        const myIndex = callIndex++;
        // group[0] (first dispatched) returns 24k; make it finish last.
        // group[1] returns 22.05k and finishes first.
        const sampleRate = myIndex === 0 ? 24000 : 22050;
        const delay = myIndex === 0 ? 40 : 0;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        const pcm = Buffer.alloc(input.text.length * 2);
        for (let i = 0; i < input.text.length; i++) {
          pcm.writeInt16LE(1000 + i, i * 2);
        }
        return { pcm, sampleRate, mimeType: 'audio/pcm' };
      },
    };

    const result = await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'Anchor group at 24k.'),
        sentence(2, 'narrator', 'Later group at 22050.'),
      ],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      sentenceConcurrency: 2,
    });

    /* Anchored on the lowest-index group regardless of completion order. */
    expect(result.sampleRate).toBe(24000);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].startSec).toBe(0);
    expect(result.segments[1].startSec).toBe(result.segments[0].endSec);
  });

  it('fires onGroupStart for every group at sentenceConcurrency 2', async () => {
    /* INVARIANT 3 (stall watchdog). Every group must fire onGroupStart as it
       begins its synth so the 30 s client watchdog keeps resetting — under
       parallelism just as under the serial loop. */
    const provider = makeDeterministicProvider();
    const started: number[] = [];
    const completed: number[] = [];

    await synthesiseChapter({
      sentences: SENTENCES,
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      sentenceConcurrency: 2,
      onGroupStart: ({ group }) => started.push(group.index),
      onGroupComplete: ({ group }) => completed.push(group.index),
    });

    /* All five groups fired start AND complete (order may interleave under
       the pool, so compare as sets). */
    expect(new Set(started)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(new Set(completed)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(started).toHaveLength(5);
    expect(completed).toHaveLength(5);
  });

  it('exposes a monotonic `completed` count even when groups finish out of order (progress-bounce fix)', async () => {
    /* The "17 ↔ 25, stalled" bug: under poolWidth > 1 the route reported
       currentLine/progress from each in-flight group's narrative POSITION, so
       two concurrent items (plus the 10 s heartbeat re-firing onGroupStart)
       ping-ponged the displayed line backward. Both callbacks now also carry
       `completed` — one counter incremented only on completion, shared by every
       worker — and the route reports currentLine/progress from THAT. This pins
       that `completed` is monotonic regardless of completion order, while
       group.index (the old source) bounces in the very same fire order. */
    const delayForText = (text: string) => Math.max(0, 60 - text.length);
    const provider = makeDeterministicProvider({ delayForText });

    /* `completed` value + group position (1-based, == the OLD currentLine),
       captured in fire order across BOTH callbacks. */
    const completedInFireOrder: number[] = [];
    const positionInFireOrder: number[] = [];
    const record = (completedSoFar: number, index: number) => {
      completedInFireOrder.push(completedSoFar);
      positionInFireOrder.push(index + 1);
    };

    await synthesiseChapter({
      sentences: SENTENCES,
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      sentenceConcurrency: 2,
      onGroupStart: ({ group, completed }) => record(completed, group.index),
      onGroupComplete: ({ group, completed }) => record(completed, group.index),
    });

    /* The hazard was actually exercised: the pool overlapped and at least one
       group completed out of dispatch order. */
    expect(provider.peakInFlight).toBeGreaterThanOrEqual(2);
    expect(provider.completionOrder).not.toEqual(provider.startOrder);

    const isMonotonic = (xs: number[]): boolean => xs.every((x, i) => i === 0 || x >= xs[i - 1]);

    /* The fix: the count only ever climbs. */
    expect(isMonotonic(completedInFireOrder)).toBe(true);
    /* …whereas the OLD position-based source bounced in the same fire order —
       exactly the backward jump (e.g. 25 → 17) we removed. */
    expect(isMonotonic(positionInFireOrder)).toBe(false);
    /* Ends at the full group count. */
    expect(completedInFireOrder[completedInFireOrder.length - 1]).toBe(SENTENCES.length);
  });

  it('throws AbortError when aborted mid-run at sentenceConcurrency 2', async () => {
    /* INVARIANT 4 (abort). Aborting while the pool is running must reject with
       AbortError and stop dispatching further groups. */
    const controller = new AbortController();
    let calls = 0;
    const provider: TtsProvider = {
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        calls += 1;
        // Abort once a couple of groups have started, before all five run.
        if (calls === 2) controller.abort();
        await new Promise((r) => setTimeout(r, 5));
        const pcm = Buffer.alloc(input.text.length * 2);
        return { pcm, sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };

    await expect(
      synthesiseChapter({
        sentences: SENTENCES,
        cast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'gemini',
        sentenceConcurrency: 2,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    /* The pool stopped early — not all five groups dispatched. */
    expect(calls).toBeLessThan(SENTENCES.length);
  });

  it('keeps the chapter-title beat before the parallel dispatch (anchor = title rate)', async () => {
    /* INVARIANT 5. The title beat stays ahead of the body dispatch; its
       sample rate anchors the chapter even when body groups run in parallel
       at a mismatched rate. */
    let callIndex = 0;
    const provider: TtsProvider = {
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        // First call is the title (24k anchor); body groups return 22.05k.
        const sampleRate = callIndex++ === 0 ? 24000 : 22050;
        const pcm = Buffer.alloc(input.text.length * 2);
        for (let i = 0; i < input.text.length; i++) pcm.writeInt16LE(500 + i, i * 2);
        return { pcm, sampleRate, mimeType: 'audio/pcm' };
      },
    };

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'Body one.'), sentence(2, 'narrator', 'Body two.')],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      chapterTitleNarration: 'Chapter 1.',
      sentenceConcurrency: 2,
    });

    /* Title rate wins as the anchor; segments[0] is the title beat. */
    expect(result.sampleRate).toBe(24000);
    expect(result.segments[0].kind).toBe('title');
    expect(result.segments[1].groupIndex).toBe(0);
    expect(result.segments[2].groupIndex).toBe(1);
    expect(result.segments[1].startSec).toBeGreaterThanOrEqual(result.segments[0].endSec);
    expect(result.segments[2].startSec).toBe(result.segments[1].endSec);
  });
});

describe('synthesiseChapter per-character engine routing (plan 108)', () => {
  function taggedProvider(sampleRate = 24000): TtsProvider & { calls: SynthesizeInput[] } {
    const calls: SynthesizeInput[] = [];
    return {
      calls,
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        calls.push(input);
        return { pcm: Buffer.alloc(4), sampleRate, mimeType: 'audio/pcm' };
      },
    };
  }

  it('routes each character to its own engine via resolveForEngine, reassembling in narrative order', async () => {
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator' },
      {
        id: 'maerin',
        name: 'Maerin',
        gender: 'female',
        ageRange: 'teen',
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'maerin-designed' } },
      },
    ];
    const kokoro = taggedProvider(24000); // default engine + anchor rate
    const qwen = taggedProvider(16000); // different rate → must resample to anchor

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'narrator'), sentence(2, 'maerin'), sentence(3, 'narrator')],
      cast,
      provider: kokoro,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
      resolveForEngine: (e) =>
        e === 'qwen'
          ? { provider: qwen, modelKey: 'qwen3-tts-0.6b' }
          : { provider: kokoro, modelKey: 'kokoro-v1' },
    });

    // Maerin's line went to the Qwen provider with her designed voiceId + qwen modelKey.
    expect(qwen.calls).toHaveLength(1);
    expect(qwen.calls[0].voiceName).toBe('maerin-designed');
    expect(qwen.calls[0].modelKey).toBe('qwen3-tts-0.6b');
    // The narrator's two lines used the default (kokoro) provider + a kokoro voice.
    expect(kokoro.calls).toHaveLength(2);
    for (const c of kokoro.calls) {
      expect(c.modelKey).toBe('kokoro-v1');
      expect(c.voiceName).toMatch(/^(af_|am_|bf_|bm_)/);
    }
    // Anchor rate is groups[0] (narrator/kokoro = 24000); the 16k qwen group resamples up.
    expect(result.sampleRate).toBe(24000);
    // Narrative order preserved across engines.
    expect(result.segments.map((s) => s.characterId)).toEqual(['narrator', 'maerin', 'narrator']);
  });

  it('without resolveForEngine + no per-character ttsEngine, everything uses the default provider (byte-identical to pre-108)', async () => {
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator' },
      { id: 'brann', name: 'Brann', gender: 'male', ageRange: 'teen' },
    ];
    const provider = taggedProvider(24000);
    const result = await synthesiseChapter({
      sentences: [sentence(1, 'narrator'), sentence(2, 'brann')],
      cast,
      provider,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
    });
    expect(provider.calls).toHaveLength(2);
    for (const c of provider.calls) expect(c.modelKey).toBe('kokoro-v1');
    expect(result.segments).toHaveLength(2);
  });
});

describe('synthesiseChapter GPU-FIFO false-stall guard (queue-sole)', () => {
  const cast: CastCharacter[] = [
    { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
  ];

  it('re-fires onGroupStart on the heartbeat interval while a group is blocked in the GPU FIFO', async () => {
    /* Regression: the GPU token is acquired INSIDE provider.synthesize, so a
       group blocked behind a sibling chapter in the semaphore FIFO emits its
       initial onGroupStart, then goes silent until the token frees. If that
       exceeds the 30 s client watchdog (STALL_THRESHOLD_MS) the chapter
       false-trips "Worker has gone quiet". The fix re-fires onGroupStart on a
       heartbeat (well under 30 s) until synthesize resolves.

       Here a single group's synthesize stays pending (simulating the FIFO
       block); we advance fake timers across several heartbeat intervals and
       assert onGroupStart fired more than once for that group, then release. */
    vi.useFakeTimers();
    try {
      let releaseSynth: (out: SynthesizeOutput) => void = () => {};
      const provider: TtsProvider = {
        synthesize(): Promise<SynthesizeOutput> {
          return new Promise<SynthesizeOutput>((resolve) => {
            releaseSynth = resolve;
          });
        },
      };

      const startsByGroup: number[] = [];
      const promise = synthesiseChapter({
        sentences: [sentence(1, 'narrator', 'A long blocked group.')],
        cast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'gemini',
        groupHeartbeatMs: 1_000,
        onGroupStart: ({ group }) => startsByGroup.push(group.index),
      });

      /* One immediate start tick (before the synth call). */
      expect(startsByGroup.filter((i) => i === 0)).toHaveLength(1);

      /* Advance across 3 heartbeat intervals while the synth stays pending —
         each fires another onGroupStart so lastTickAt stays fresh. */
      await vi.advanceTimersByTimeAsync(3_500);
      expect(startsByGroup.filter((i) => i === 0).length).toBeGreaterThan(1);

      /* Release the synth → heartbeat stops; finish the chapter. */
      releaseSynth({ pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' });
      await vi.runAllTimersAsync();
      await promise;

      /* No further heartbeats after the synth settled. */
      const countAfterRelease = startsByGroup.filter((i) => i === 0).length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(startsByGroup.filter((i) => i === 0).length).toBe(countAfterRelease);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT fire extra heartbeats when groupHeartbeatMs <= 0 (opt-out for exact-count callers)', async () => {
    vi.useFakeTimers();
    try {
      let releaseSynth: (out: SynthesizeOutput) => void = () => {};
      const provider: TtsProvider = {
        synthesize(): Promise<SynthesizeOutput> {
          return new Promise<SynthesizeOutput>((resolve) => {
            releaseSynth = resolve;
          });
        },
      };
      const starts: number[] = [];
      const promise = synthesiseChapter({
        sentences: [sentence(1, 'narrator', 'Blocked but heartbeat disabled.')],
        cast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'gemini',
        groupHeartbeatMs: 0,
        onGroupStart: ({ group }) => starts.push(group.index),
      });
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      /* No heartbeat fired despite a long block. */
      expect(starts).toHaveLength(1);
      releaseSynth({ pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' });
      await vi.runAllTimersAsync();
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ── plan 112 — Qwen true batching (scatter/gather) ──────────────────────
   Qwen sentences across a chapter are packed into size-capped batches sent as
   ONE `synthesizeBatch` call, then each returned PCM chunk is scattered back to
   its own sentence index. The dispatch change must NOT alter the reassembly:
   batched output is byte-identical to the per-call (kill-switch) baseline, and
   the index-order concat keeps narrative order + timing. Non-Qwen sentences,
   and Qwen providers without `synthesizeBatch`, stay one-per-call. */
describe('synthesiseChapter Qwen true batching (plan 112)', () => {
  /* Fake provider implementing BOTH paths with the SAME text-derived PCM, so a
     batched run can be compared byte-for-byte against a per-call run. Records
     single vs batch calls (with per-item voices + the forwarded signal) so the
     packing + scatter contract is assertable. */
  function makeBatchProvider(opts?: { sampleRate?: number }): TtsProvider & {
    singleCalls: SynthesizeInput[];
    batchCalls: { items: SynthesizeBatchInput['items']; signal?: AbortSignal }[];
  } {
    const sampleRate = opts?.sampleRate ?? 24000;
    const singleCalls: SynthesizeInput[] = [];
    const batchCalls: { items: SynthesizeBatchInput['items']; signal?: AbortSignal }[] = [];
    const pcmFor = (text: string): Buffer => {
      const pcm = Buffer.alloc(text.length * 2);
      for (let i = 0; i < text.length; i++) pcm.writeInt16LE(text.charCodeAt(i) & 0x7fff, i * 2);
      return pcm;
    };
    return {
      singleCalls,
      batchCalls,
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        singleCalls.push(input);
        return { pcm: pcmFor(input.text), sampleRate, mimeType: 'audio/pcm' };
      },
      async synthesizeBatch({
        items,
        signal,
      }: SynthesizeBatchInput): Promise<SynthesizeBatchOutput> {
        batchCalls.push({ items, signal });
        return { pcms: items.map((it) => pcmFor(it.text)), sampleRate };
      },
    };
  }

  const QWEN_CAST: CastCharacter[] = [
    {
      id: 'narrator',
      name: 'Narrator',
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'narr-q' } },
    },
    {
      id: 'maerin',
      name: 'Maerin',
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'maerin-q' } },
    },
  ];

  const MIXED_SENTENCES = [
    sentence(1, 'narrator', 'First sentence here.'),
    sentence(2, 'maerin', 'Two.'),
    sentence(3, 'narrator', 'A noticeably longer third sentence to vary the byte length.'),
    sentence(4, 'maerin', 'Fourth!'),
    sentence(5, 'narrator', 'Fifth and final sentence.'),
  ];

  it('is byte-identical batched (size 8) vs per-call (size 1), and mixes voices in one batch', async () => {
    const serialP = makeBatchProvider();
    const serial = await synthesiseChapter({
      sentences: MIXED_SENTENCES,
      cast: QWEN_CAST,
      provider: serialP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 1,
    });

    const batchP = makeBatchProvider();
    const batched = await synthesiseChapter({
      sentences: MIXED_SENTENCES,
      cast: QWEN_CAST,
      provider: batchP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 8,
      /* Pin index-order composition so the voiceName-order assertion below is
         deterministic — length-bucketing (default ON, plan 128) reorders batch
         items by length; that path has its own coverage further down. */
      qwenBatchBucket: false,
    });

    /* The headline guarantee: batching changes throughput, not output. */
    expect(batched.pcm.equals(serial.pcm)).toBe(true);
    expect(batched.sampleRate).toBe(serial.sampleRate);
    expect(batched.durationSec).toBe(serial.durationSec);
    expect(batched.segments).toEqual(serial.segments);

    /* size 1 is the kill-switch: every Qwen sentence is its own synth call. */
    expect(serialP.batchCalls).toHaveLength(0);
    expect(serialP.singleCalls).toHaveLength(5);

    /* size 8: groups[0] is the up-front anchor (single); groups[1..4] batch in
       one call, MIXING narrator + dialogue voices via the per-element list. */
    expect(batchP.singleCalls).toHaveLength(1);
    expect(batchP.batchCalls).toHaveLength(1);
    expect(batchP.batchCalls[0].items.map((i) => i.voiceName)).toEqual([
      'maerin-q',
      'narr-q',
      'maerin-q',
      'narr-q',
    ]);
  });

  it('scatters each batched chunk back to its own sentence index (narrative order preserved)', async () => {
    const provider = makeBatchProvider();
    const result = await synthesiseChapter({
      sentences: MIXED_SENTENCES,
      cast: QWEN_CAST,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 8,
    });
    expect(result.segments.map((s) => s.groupIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(result.segments.map((s) => s.sentenceIds)).toEqual([[1], [2], [3], [4], [5]]);
    /* Segment timing is monotonic + contiguous despite the batch landing as one
       call — the index-order concat owns timing, not completion order. */
    for (let i = 1; i < result.segments.length; i++) {
      expect(result.segments[i].startSec).toBe(result.segments[i - 1].endSec);
    }
  });

  it('fires onBatchComplete with the sidecar perf (genMs/audioMs) for live RTF', async () => {
    const provider: TtsProvider = {
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        return { pcm: Buffer.alloc(input.text.length * 2), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
      async synthesizeBatch({ items }: SynthesizeBatchInput): Promise<SynthesizeBatchOutput> {
        return {
          pcms: items.map((it) => Buffer.alloc(it.text.length * 2)),
          sampleRate: 24000,
          genMs: 1234,
          audioMs: 567,
        };
      },
    };
    const batches: { batchSize: number; genMs: number; audioMs: number }[] = [];
    await synthesiseChapter({
      sentences: MIXED_SENTENCES,
      cast: QWEN_CAST,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 8,
      onBatchComplete: (e) => batches.push(e),
    });
    /* groups[1..4] land as ONE batch (groups[0] is the up-front anchor single,
       which does not fire onBatchComplete). */
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ batchSize: 4, genMs: 1234, audioMs: 567 });
  });

  it('does not fire onBatchComplete when the sidecar omits perf fields (older sidecar)', async () => {
    const provider = makeBatchProvider(); // batch output carries no genMs/audioMs
    const batches: unknown[] = [];
    await synthesiseChapter({
      sentences: MIXED_SENTENCES,
      cast: QWEN_CAST,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 8,
      onBatchComplete: (e) => batches.push(e),
    });
    expect(batches).toHaveLength(0);
  });

  it('keeps non-Qwen sentences one-per-call while batching the Qwen ones (mixed-engine chapter)', async () => {
    const cast: CastCharacter[] = [
      /* Narrator carries a DESIGNED Qwen voice so it stays on Qwen — an
         undesigned Qwen character now falls back to Kokoro (see the
         "Qwen→Kokoro graceful fallback" suite), which would otherwise leave
         no Qwen sentences for this batching test to exercise. */
      { id: 'narrator', name: 'Narrator', overrideTtsVoices: { qwen: { name: 'narrator-q' } } },
      {
        id: 'kobo',
        name: 'Kobo',
        ttsEngine: 'kokoro',
        overrideTtsVoices: { kokoro: { name: 'af_heart' } },
      },
    ];
    const qwenP = makeBatchProvider();
    const kokoroP = makeBatchProvider();

    const result = await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'Body one.'),
        sentence(2, 'kobo', 'Kokoro line.'),
        sentence(3, 'narrator', 'Body three.'),
        sentence(4, 'narrator', 'Body four.'),
      ],
      cast,
      provider: qwenP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 8,
      resolveForEngine: (e) =>
        e === 'kokoro'
          ? { provider: kokoroP, modelKey: 'kokoro-v1' }
          : { provider: qwenP, modelKey: 'qwen3-tts-0.6b' },
    });

    /* Kobo (Kokoro) never batched — one single call, no batch on that engine. */
    expect(kokoroP.batchCalls).toHaveLength(0);
    expect(kokoroP.singleCalls).toHaveLength(1);
    /* Qwen: groups[0] anchor (single) + the two later narrator groups batched. */
    expect(qwenP.singleCalls).toHaveLength(1);
    expect(qwenP.batchCalls).toHaveLength(1);
    expect(qwenP.batchCalls[0].items).toHaveLength(2);
    /* Narrative order intact across engines. */
    expect(result.segments.map((s) => s.characterId)).toEqual([
      'narrator',
      'kobo',
      'narrator',
      'narrator',
    ]);
  });

  it('splits a long Qwen run into batchSize-capped batches', async () => {
    /* With a title beat, all body groups partition (no up-front anchor consumes
       group 0). 5 Qwen body groups at batchSize 2 → [2, 2] full batches + a
       trailing single (a size-1 slice is sent as a plain synth, not a batch). */
    const cast: CastCharacter[] = [{ id: 'narrator', name: 'Narrator', ttsEngine: 'qwen' }];
    const provider = makeBatchProvider();
    const result = await synthesiseChapter({
      sentences: Array.from({ length: 5 }, (_, i) => sentence(i + 1, 'narrator', `Sentence ${i + 1}.`)),
      cast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      chapterTitleNarration: 'Chapter 1.',
      qwenBatchSize: 2,
    });

    expect(provider.batchCalls.map((b) => b.items.length)).toEqual([2, 2]);
    /* All 5 body sentences accounted for: 2 batches (4) + 1 trailing single. */
    const batched = provider.batchCalls.reduce((n, b) => n + b.items.length, 0);
    expect(batched).toBe(4);
    /* Title segment + 5 body segments, in order. */
    expect(result.segments).toHaveLength(6);
    expect(result.segments[0].kind).toBe('title');
    expect(result.segments.slice(1).map((s) => s.groupIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('falls back to per-call when a Qwen provider lacks synthesizeBatch (back-compat)', async () => {
    /* A provider that only implements `synthesize` (Gemini, or a future
       non-batch backend) must never be routed through the batch path — the
       dispatcher feature-detects the optional method. */
    const provider = makeProvider();
    const cast: CastCharacter[] = [{ id: 'narrator', name: 'Narrator', ttsEngine: 'qwen' }];
    await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'A.'),
        sentence(2, 'narrator', 'B.'),
        sentence(3, 'narrator', 'C.'),
      ],
      cast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 8,
    });
    expect(provider.calls).toHaveLength(3);
  });

  it('forwards the abort signal into the batch call and propagates a mid-batch AbortError', async () => {
    const controller = new AbortController();
    const provider = makeBatchProvider();
    const recordBatch = provider.synthesizeBatch!.bind(provider);
    provider.synthesizeBatch = async (input: SynthesizeBatchInput) => {
      await recordBatch(input); // record the call (incl. the forwarded signal)
      throw Object.assign(new Error('batch aborted mid-flight'), { name: 'AbortError' });
    };

    await expect(
      synthesiseChapter({
        sentences: [
          sentence(1, 'narrator', 'Anchor.'),
          sentence(2, 'maerin', 'Batched one.'),
          sentence(3, 'maerin', 'Batched two.'),
        ],
        cast: QWEN_CAST,
        provider,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        qwenBatchSize: 8,
        signal: controller.signal,
        /* Watchdog OFF so the parent signal is forwarded verbatim (the identity
           this test pins). The derived-child path is covered by plan 148. */
        callTimeoutMs: 0,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    /* The batch call received the SAME signal the chapter was given, so a real
       fetch would cancel mid-flight. */
    expect(provider.batchCalls[0].signal).toBe(controller.signal);
  });

  it('re-fires onGroupStart on the heartbeat while a batch call is pending (stall watchdog)', async () => {
    vi.useFakeTimers();
    try {
      let releaseBatch: (out: SynthesizeBatchOutput) => void = () => {};
      const provider: TtsProvider = {
        async synthesize(): Promise<SynthesizeOutput> {
          return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
        },
        synthesizeBatch(): Promise<SynthesizeBatchOutput> {
          return new Promise<SynthesizeBatchOutput>((resolve) => {
            releaseBatch = resolve;
          });
        },
      };
      const cast: CastCharacter[] = [{ id: 'narrator', name: 'Narrator', ttsEngine: 'qwen' }];
      const startsByGroup: number[] = [];
      const promise = synthesiseChapter({
        sentences: [
          sentence(1, 'narrator', 'Anchor.'),
          sentence(2, 'narrator', 'Batched A.'),
          sentence(3, 'narrator', 'Batched B.'),
        ],
        cast,
        provider,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        qwenBatchSize: 8,
        groupHeartbeatMs: 1_000,
        onGroupStart: ({ group }) => startsByGroup.push(group.index),
      });

      /* Let the anchor (group 0) settle and the batch (lead = group 1) dispatch:
         one immediate start tick for the batch's lead group. */
      await vi.advanceTimersByTimeAsync(0);
      expect(startsByGroup.filter((i) => i === 1).length).toBeGreaterThanOrEqual(1);

      /* The batch stays pending across heartbeat intervals → repeated ticks keep
         the 30 s client watchdog from tripping on a long batched call. */
      await vi.advanceTimersByTimeAsync(3_500);
      expect(startsByGroup.filter((i) => i === 1).length).toBeGreaterThan(1);

      releaseBatch({ pcms: [Buffer.alloc(2), Buffer.alloc(2)], sampleRate: 24000 });
      await vi.runAllTimersAsync();
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  /* ── Length-bucketing (plan 128) ────────────────────────────────────────
     A high-variance chapter whose sentences alternate short/long in narrative
     order. groups[0] is the up-front anchor (single); groups[1..8] are the
     batchable body. With batchSize 2 that's 4 batches: index-order batching
     pairs each short with a long (max per-batch spread); length-bucketing
     groups the shorts together and the longs together (min spread). */
  const long = (n: number) =>
    `A deliberately long sentence number ${n} engineered to be the decode long-pole in whatever batch it lands in.`;
  const VARIED_SENTENCES = [
    sentence(1, 'narrator', 'Anchor sentence sets the sample rate.'),
    sentence(2, 'narrator', 'Hi.'),
    sentence(3, 'maerin', long(3)),
    sentence(4, 'narrator', 'Yo!'),
    sentence(5, 'maerin', long(5)),
    sentence(6, 'narrator', 'Ok.'),
    sentence(7, 'maerin', long(7)),
    sentence(8, 'narrator', 'Go.'),
    sentence(9, 'maerin', long(9)),
  ];
  const batchSpreads = (p: ReturnType<typeof makeBatchProvider>): number[] =>
    p.batchCalls.map((c) => {
      const lens = c.items.map((i) => i.text.length);
      return Math.max(...lens) - Math.min(...lens);
    });
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

  it('produces byte-identical audio with bucketing ON vs OFF (output-preserving)', async () => {
    const onP = makeBatchProvider();
    const on = await synthesiseChapter({
      sentences: VARIED_SENTENCES,
      cast: QWEN_CAST,
      provider: onP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 2,
      qwenBatchBucket: true,
    });
    const offP = makeBatchProvider();
    const off = await synthesiseChapter({
      sentences: VARIED_SENTENCES,
      cast: QWEN_CAST,
      provider: offP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 2,
      qwenBatchBucket: false,
    });

    /* Headline guarantee: which batch a sentence lands in never changes its
       audio (per-sentence prompts) nor the concat order (index scatter-back). */
    expect(on.pcm.equals(off.pcm)).toBe(true);
    expect(on.sampleRate).toBe(off.sampleRate);
    expect(on.durationSec).toBe(off.durationSec);
    expect(on.segments).toEqual(off.segments);
    /* Same batch *count* either way — only the composition differs. */
    expect(onP.batchCalls).toHaveLength(offP.batchCalls.length);
  });

  it('shrinks the per-batch length spread when bucketing (the mechanism)', async () => {
    const onP = makeBatchProvider();
    await synthesiseChapter({
      sentences: VARIED_SENTENCES,
      cast: QWEN_CAST,
      provider: onP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 2,
      qwenBatchBucket: true,
    });
    const offP = makeBatchProvider();
    await synthesiseChapter({
      sentences: VARIED_SENTENCES,
      cast: QWEN_CAST,
      provider: offP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 2,
      qwenBatchBucket: false,
    });
    /* Bucketing packs similar lengths together → tighter max-length per batch,
       which is exactly the padding-waste the plan targets. */
    expect(mean(batchSpreads(onP))).toBeLessThan(mean(batchSpreads(offP)));
  });

  it('kill-switch (bucketing OFF) keeps index-order batch composition', async () => {
    const offP = makeBatchProvider();
    await synthesiseChapter({
      sentences: VARIED_SENTENCES,
      cast: QWEN_CAST,
      provider: offP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 2,
      qwenBatchBucket: false,
    });
    /* Flatten the batched items in call order; OFF must reproduce the body
       sentences in narrative order (groups[1..8] — anchor excluded). */
    const flatTexts = offP.batchCalls.flatMap((c) => c.items.map((i) => i.text));
    expect(flatTexts).toEqual(VARIED_SENTENCES.slice(1).map((s) => s.text));

    /* ON instead emits length-homogeneous batches (shorts paired with shorts,
       longs with longs) — proves the default flips the composition. (Batch
       *dispatch* order stays index-sorted via the work-item sort, so it's the
       per-batch tightness, not a global sort, that bucketing guarantees.) */
    const onP = makeBatchProvider();
    await synthesiseChapter({
      sentences: VARIED_SENTENCES,
      cast: QWEN_CAST,
      provider: onP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 2,
      qwenBatchBucket: true,
    });
    expect(batchSpreads(onP)).toEqual([0, 0, 0, 0]);
  });

  /* ── Token-budget packing (plan 136) ───────────────────────────────────────
     Variable batch width: pack short/dialogue sentences wide (toward the hard
     cap = qwenBatchSize) and long sentences narrow, bounded by
     `count × maxLenInBatch <= budget`. Fake PCM is one int16 sample per char,
     so a sentence's `normaliseForTts(text).length` IS the model-side length the
     packer and the sidecar both use. Repeated-char strings avoid the all-caps /
     dash scrubbing in `normaliseForTts`, so length === text.length exactly. */
  const batchWidths = (p: ReturnType<typeof makeBatchProvider>): number[] =>
    p.batchCalls.map((c) => c.items.length);
  const SHORT = 'a'.repeat(10);
  const LONG = 'b'.repeat(28);
  /* anchor (group 0, synthed as an up-front single) + 8 shorts + 4 longs. */
  const TB_SENTENCES = [
    sentence(1, 'narrator', 'Anchor sentence sets the sample rate.'),
    ...Array.from({ length: 8 }, (_, i) =>
      sentence(i + 2, i % 2 ? 'maerin' : 'narrator', SHORT),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      sentence(i + 10, i % 2 ? 'maerin' : 'narrator', LONG),
    ),
  ];

  it('is output-preserving: token-budget ON is byte-identical to fixed-width OFF', async () => {
    const onP = makeBatchProvider();
    const on = await synthesiseChapter({
      sentences: TB_SENTENCES,
      cast: QWEN_CAST,
      provider: onP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 4,
      qwenBatchTokenBudget: 60,
    });
    const offP = makeBatchProvider();
    const off = await synthesiseChapter({
      sentences: TB_SENTENCES,
      cast: QWEN_CAST,
      provider: offP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 4,
      qwenBatchTokenBudget: 0, // fixed-width fallback
    });
    /* Packing only changes which groups co-occur — never the audio (per-item
       prompts) nor the concat order (index scatter-back). */
    expect(on.pcm.equals(off.pcm)).toBe(true);
    expect(on.sampleRate).toBe(off.sampleRate);
    expect(on.durationSec).toBe(off.durationSec);
    expect(on.segments).toEqual(off.segments);
  });

  it('packs short batches to the cap and long batches narrower, never violating the budget', async () => {
    const budget = 60;
    const hardMax = 4;
    const p = makeBatchProvider();
    await synthesiseChapter({
      sentences: TB_SENTENCES,
      cast: QWEN_CAST,
      provider: p,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: hardMax,
      qwenBatchTokenBudget: budget,
    });
    /* The invariant the packer guarantees on EVERY batch — this is the VRAM
       backstop, so it must hold without exception. */
    for (const c of p.batchCalls) {
      const maxLen = Math.max(...c.items.map((i) => i.text.length));
      expect(c.items.length * maxLen).toBeLessThanOrEqual(budget);
      expect(c.items.length).toBeLessThanOrEqual(hardMax);
    }
    /* Short batches (maxLen 10) hit the cap; long batches (maxLen 28) are forced
       narrower by the budget (2×28=56 ≤ 60 but 3×28 > 60). */
    const shortBatches = p.batchCalls.filter((c) => Math.max(...c.items.map((i) => i.text.length)) === 10);
    const longBatches = p.batchCalls.filter((c) => Math.max(...c.items.map((i) => i.text.length)) === 28);
    expect(shortBatches.length).toBeGreaterThan(0);
    expect(longBatches.length).toBeGreaterThan(0);
    for (const c of shortBatches) expect(c.items.length).toBe(hardMax);
    for (const c of longBatches) expect(c.items.length).toBeLessThan(hardMax);
  });

  it('budget=0 falls back to exact fixed-width slicing (kill-switch + back-compat)', async () => {
    const p = makeBatchProvider();
    await synthesiseChapter({
      sentences: TB_SENTENCES,
      cast: QWEN_CAST,
      provider: p,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 4,
      qwenBatchTokenBudget: 0,
      qwenBatchBucket: false, // index-order, so composition is fully pinned
    });
    /* 12 batchable body groups (anchor excluded), fixed width 4 → 3 full
       batches, no token-budget reshaping. */
    expect(batchWidths(p)).toEqual([4, 4, 4]);
    const flatTexts = p.batchCalls.flatMap((c) => c.items.map((i) => i.text));
    expect(flatTexts).toEqual(TB_SENTENCES.slice(1).map((s) => s.text));
  });

  it('emits a single sentence that alone exceeds the budget as its own work item', async () => {
    const HUGE = 'c'.repeat(200);
    const sentences = [
      sentence(1, 'narrator', 'Anchor sentence sets the sample rate.'),
      ...Array.from({ length: 6 }, (_, i) => sentence(i + 2, 'narrator', SHORT)),
      sentence(8, 'maerin', HUGE),
    ];
    const p = makeBatchProvider();
    const out = await synthesiseChapter({
      sentences,
      cast: QWEN_CAST,
      provider: p,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 8,
      qwenBatchTokenBudget: 50, // 1×200 alone > 50
    });
    /* The over-budget sentence is never co-batched; a length-1 work item routes
       to the single path, so it lands in singleCalls, not batchCalls. */
    expect(p.batchCalls.every((c) => c.items.every((i) => i.text !== HUGE))).toBe(true);
    expect(p.singleCalls.some((c) => c.text === HUGE)).toBe(true);
    /* Audio still byte-identical to the fixed-width baseline. */
    const refP = makeBatchProvider();
    const ref = await synthesiseChapter({
      sentences,
      cast: QWEN_CAST,
      provider: refP,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 8,
      qwenBatchTokenBudget: 0,
    });
    expect(out.pcm.equals(ref.pcm)).toBe(true);
    expect(out.segments).toEqual(ref.segments);
  });

  it('is deterministic: same input twice yields identical batch composition', async () => {
    const run = async () => {
      const p = makeBatchProvider();
      await synthesiseChapter({
        sentences: TB_SENTENCES,
        cast: QWEN_CAST,
        provider: p,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        qwenBatchSize: 4,
        qwenBatchTokenBudget: 60,
      });
      return p;
    };
    const a = await run();
    const b = await run();
    expect(batchWidths(a)).toEqual(batchWidths(b));
    expect(a.batchCalls.map((c) => c.items.map((i) => i.text))).toEqual(
      b.batchCalls.map((c) => c.items.map((i) => i.text)),
    );
  });
});

describe('synthesiseChapter — Qwen→Kokoro graceful fallback', () => {
  const KOKORO_VOICE_RE = /^(af|am|bf|bm)_/;

  function multiEngine() {
    const qwen = makeProvider();
    const kokoro = makeProvider();
    const resolveForEngine = (e: string) =>
      e === 'kokoro'
        ? { provider: kokoro, modelKey: 'kokoro-v1' as const }
        : { provider: qwen, modelKey: 'qwen3-tts-0.6b' as const };
    return { qwen, kokoro, resolveForEngine };
  }

  it('falls an undesigned Qwen character back to Kokoro and stamps the segment', async () => {
    const cast: CastCharacter[] = [{ id: 'wren', name: 'Wren', gender: 'female' }];
    const { qwen, kokoro, resolveForEngine } = multiEngine();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'wren')],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
    });

    // No designed Qwen voice → the Qwen provider is never asked to synth it.
    expect(qwen.calls).toHaveLength(0);
    expect(kokoro.calls).toHaveLength(1);
    expect(kokoro.calls[0].voiceName).toMatch(KOKORO_VOICE_RE);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBe('kokoro');
  });

  it('does NOT fall back a designed Qwen voice when the engine is available', async () => {
    const cast: CastCharacter[] = [
      { id: 'marlow', name: 'Marlow', gender: 'male', overrideTtsVoices: { qwen: { name: 'marlow-q' } } },
    ];
    const { qwen, kokoro, resolveForEngine } = multiEngine();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'marlow')],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
    });

    expect(qwen.calls).toHaveLength(1);
    expect(qwen.calls[0].voiceName).toBe('marlow-q');
    expect(kokoro.calls).toHaveLength(0);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBeUndefined();
  });

  it('falls a designed Qwen voice back to Kokoro when the engine is unavailable', async () => {
    const cast: CastCharacter[] = [
      { id: 'marlow', name: 'Marlow', gender: 'male', overrideTtsVoices: { qwen: { name: 'marlow-q' } } },
    ];
    const { qwen, kokoro, resolveForEngine } = multiEngine();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'marlow')],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      qwenUnavailable: true,
    });

    expect(qwen.calls).toHaveLength(0);
    expect(kokoro.calls).toHaveLength(1);
    expect(kokoro.calls[0].voiceName).toMatch(KOKORO_VOICE_RE);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBe('kokoro');
  });

  it('never stamps a fallback on a non-Qwen character', async () => {
    const cast: CastCharacter[] = [{ id: 'eliza', name: 'Eliza', gender: 'female' }];
    const provider = makeProvider();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'eliza')],
      cast,
      provider,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
    });

    expect(provider.calls).toHaveLength(1);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBeUndefined();
  });
});

/* fs-2 — never-cross-language: on a non-English book the Kokoro fallback is
   FORBIDDEN. An undesigned Qwen voice (or unavailable Qwen) must fail the
   chapter loudly (MissingDesignedVoiceError), never read the book's language
   through an English-only Kokoro voice. */
describe('synthesiseChapter — forbidKokoroFallback (fs-2 never-cross-language)', () => {
  function multiEngine() {
    const qwen = makeProvider();
    const kokoro = makeProvider();
    const resolveForEngine = (e: string) =>
      e === 'kokoro'
        ? { provider: kokoro, modelKey: 'kokoro-v1' as const }
        : { provider: qwen, modelKey: 'qwen3-tts-0.6b' as const };
    return { qwen, kokoro, resolveForEngine };
  }

  it('throws MissingDesignedVoiceError for an undesigned Qwen character (no Kokoro render)', async () => {
    const cast: CastCharacter[] = [{ id: 'sofiya', name: 'Sofiya', gender: 'female' }];
    const { qwen, kokoro, resolveForEngine } = multiEngine();

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'sofiya')],
        cast,
        provider: qwen,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        resolveForEngine,
        forbidKokoroFallback: true,
        bookLanguage: 'ru',
      }),
    ).rejects.toBeInstanceOf(MissingDesignedVoiceError);

    /* Neither engine renders the body — no cross-language Kokoro audio leaks. */
    expect(qwen.calls).toHaveLength(0);
    expect(kokoro.calls).toHaveLength(0);
  });

  it('throws when Qwen is unavailable even for a designed voice (no silent Kokoro downgrade)', async () => {
    const cast: CastCharacter[] = [
      { id: 'sofiya', name: 'Sofiya', gender: 'female', overrideTtsVoices: { qwen: { name: 'sofiya-q' } } },
    ];
    const { kokoro, resolveForEngine, qwen } = multiEngine();

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'sofiya')],
        cast,
        provider: qwen,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        resolveForEngine,
        qwenUnavailable: true,
        forbidKokoroFallback: true,
        bookLanguage: 'ru',
      }),
    ).rejects.toBeInstanceOf(MissingDesignedVoiceError);
    expect(kokoro.calls).toHaveLength(0);
  });

  it('renders a designed Qwen voice normally when Qwen is available (no throw)', async () => {
    const cast: CastCharacter[] = [
      { id: 'sofiya', name: 'Sofiya', gender: 'female', overrideTtsVoices: { qwen: { name: 'sofiya-q' } } },
    ];
    const { qwen, kokoro, resolveForEngine } = multiEngine();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'sofiya')],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      forbidKokoroFallback: true,
      bookLanguage: 'ru',
    });

    expect(qwen.calls).toHaveLength(1);
    expect(qwen.calls[0].voiceName).toBe('sofiya-q');
    expect(kokoro.calls).toHaveLength(0);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBeUndefined();
  });

  it('blocks the title beat too — an undesigned Qwen narrator throws before any synth', async () => {
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', ttsEngine: 'qwen' },
      { id: 'sofiya', name: 'Sofiya', gender: 'female', overrideTtsVoices: { qwen: { name: 'sofiya-q' } } },
    ];
    const { qwen, kokoro, resolveForEngine } = multiEngine();

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'sofiya')],
        cast,
        provider: qwen,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        resolveForEngine,
        forbidKokoroFallback: true,
        bookLanguage: 'ru',
        chapterTitleNarration: 'Chapter One.',
      }),
    ).rejects.toBeInstanceOf(MissingDesignedVoiceError);
    /* The narrator title beat is the first synth — it must throw before either
       engine is called. */
    expect(qwen.calls).toHaveLength(0);
    expect(kokoro.calls).toHaveLength(0);
  });
});

/* ── QWEN_BATCH_TOKEN_BUDGET env resolution (plan 136, shipped default 3600) ──
   The shipped default is ON (3600); only an EXPLICIT `0` is the fixed-width
   kill-switch. Pins the unset-vs-0 distinction the env IIFE depends on. */
describe('resolveQwenTokenBudget', () => {
  it('defaults to 3600 (token-budget ON) when unset or empty', () => {
    expect(resolveQwenTokenBudget(undefined)).toBe(DEFAULT_QWEN_BATCH_TOKEN_BUDGET);
    expect(resolveQwenTokenBudget(undefined)).toBe(3600);
    expect(resolveQwenTokenBudget('')).toBe(3600);
    expect(resolveQwenTokenBudget('   ')).toBe(3600);
  });

  it('treats an explicit 0 as the OFF kill-switch (not the default)', () => {
    expect(resolveQwenTokenBudget('0')).toBe(0);
  });

  it('floors a positive value and rejects non-positive / non-numeric to OFF', () => {
    expect(resolveQwenTokenBudget('2400')).toBe(2400);
    expect(resolveQwenTokenBudget('3600.9')).toBe(3600);
    expect(resolveQwenTokenBudget('-5')).toBe(0);
    expect(resolveQwenTokenBudget('abc')).toBe(0);
  });
});

/* Plan 148 — defensive per-call synth timeout. The the Hollow Tide stall: a Qwen call
   ran away on degenerate back-matter and never returned, hanging the chapter
   (and the queue) for an hour. The watchdog must turn that into a chapter
   failure the queue rides past. */
describe('synthesiseChapter per-call timeout (plan 148)', () => {
  const soloCast: CastCharacter[] = [
    {
      id: 'narrator',
      name: 'Narrator',
      gender: 'neutral',
      ageRange: 'adult',
      attributes: [],
      description: '',
    },
  ];

  it('fails with ChapterSynthTimeoutError and aborts the call when a synth call never returns', async () => {
    let captured: AbortSignal | undefined;
    const provider: TtsProvider = {
      synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        captured = input.signal;
        /* Never settles — mimics a runaway/hung provider call. Without the
           watchdog this would hang the test (and, in prod, the queue). */
        return new Promise<SynthesizeOutput>(() => {});
      },
    };

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'narrator')],
        cast: soloCast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'gemini',
        callTimeoutMs: 40,
        groupHeartbeatMs: 0,
      }),
    ).rejects.toBeInstanceOf(ChapterSynthTimeoutError);

    // The derived signal was aborted, so an honouring provider cancels its fetch.
    expect(captured?.aborted).toBe(true);
  });

  it('does not fire for a fast call — callTimeoutMs is a ceiling, not a delay', async () => {
    const provider = makeProvider();
    await synthesiseChapter({
      sentences: [sentence(1, 'narrator')],
      cast: soloCast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      callTimeoutMs: 50_000,
      groupHeartbeatMs: 0,
    });
    expect(provider.calls.length).toBe(1);
  });
});

/* Pre-assembly per-sentence QA gate: a sentence whose rendered PCM fails the
   signal-based checks (here: dead/near-silent) is re-recorded in place via the
   same single-call synth path BEFORE the chapter is concatenated, and the good
   retake is what assembles. Exhausting the retries keeps the best take and
   stamps the segment `suspect` — it never blocks completion. Thresholds are
   pinned per test (only the RMS/dead check matters) so the cases isolate the
   gate from the duration/silence-run signals exercised in segment-qa.test.ts. */
describe('synthesiseChapter pre-assembly QA gate', () => {
  const RMS_ONLY = {
    silenceRms: 0.01,
    noiseFloor: 0.02,
    maxInternalSilenceSec: 999,
    minDurationRatio: 0,
    maxDurationRatio: Number.POSITIVE_INFINITY,
  };
  const gateCast: CastCharacter[] = [{ id: 'narrator', name: 'Narrator' }];

  function tonePcm(seconds = 0.5, amp = 0.3): Buffer {
    const sr = 24000;
    const n = Math.round(seconds * sr);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) {
      buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 200 * i) / sr) * amp * 32767), i * 2);
    }
    return buf;
  }
  const silencePcm = (seconds = 0.5): Buffer => Buffer.alloc(Math.round(seconds * 24000) * 2);

  /** Provider that returns silence or a tone per call, decided by `pick`. */
  function makeContentProvider(
    pick: (text: string, nthForText: number) => 'silence' | 'tone',
  ): TtsProvider & { calls: SynthesizeInput[] } {
    const calls: SynthesizeInput[] = [];
    const seen = new Map<string, number>();
    return {
      calls,
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        calls.push(input);
        const nth = (seen.get(input.text) ?? 0) + 1;
        seen.set(input.text, nth);
        const pcm = pick(input.text, nth) === 'silence' ? silencePcm() : tonePcm();
        return { pcm, sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };
  }

  it('re-records a bad segment in place and keeps the good retake', async () => {
    // "troublesome" sentence renders silence on its first call, a tone on retry.
    const provider = makeContentProvider((text, nth) =>
      text.includes('troublesome') && nth === 1 ? 'silence' : 'tone',
    );
    const result = await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'The anchor sentence is perfectly fine today.'),
        sentence(2, 'narrator', 'This troublesome line keeps dropping out.'),
      ],
      cast: gateCast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      groupHeartbeatMs: 0,
      maxSegmentRerecords: 2,
      segmentQaThresholds: RMS_ONLY,
    });

    const badCalls = provider.calls.filter((c) => c.text.includes('troublesome'));
    expect(badCalls).toHaveLength(2); // 1 initial + 1 re-record
    const badSeg = result.segments.find((s) => s.sentenceIds.includes(2));
    expect(badSeg?.qa?.status).toBe('ok');
    expect(badSeg?.suspect).toBeFalsy();
    // The kept take is the tone, so that segment's audio is not silent.
    expect(badSeg?.qa?.rms).toBeGreaterThan(0.05);
  });

  it('keeps the best take and flags suspect after exhausting re-records', async () => {
    const provider = makeContentProvider((text) => (text.includes('broken') ? 'silence' : 'tone'));
    const result = await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'The anchor sentence is perfectly fine today.'),
        sentence(2, 'narrator', 'This broken line never recovers at all.'),
      ],
      cast: gateCast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      groupHeartbeatMs: 0,
      maxSegmentRerecords: 2,
      segmentQaThresholds: RMS_ONLY,
    });

    const badCalls = provider.calls.filter((c) => c.text.includes('broken'));
    expect(badCalls).toHaveLength(3); // 1 initial + 2 re-records, all bad
    const badSeg = result.segments.find((s) => s.sentenceIds.includes(2));
    expect(badSeg?.qa?.status).toBe('suspect');
    expect(badSeg?.suspect).toBe(true);
    // Still assembled — the chapter completes regardless.
    expect(result.pcm.length).toBeGreaterThan(0);
    expect(result.segments.some((s) => s.sentenceIds.includes(1))).toBe(true);
  });

  it('is disabled by default (no re-records, no qa stamp) — back-compat', async () => {
    const provider = makeContentProvider(() => 'silence');
    const result = await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'A line that renders as silence.')],
      cast: gateCast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      groupHeartbeatMs: 0,
      // maxSegmentRerecords omitted → gate off
    });
    expect(provider.calls).toHaveLength(1);
    expect(result.segments[0].qa).toBeUndefined();
    expect(result.segments[0].suspect).toBeUndefined();
  });

  it('stamps voiceSubstitutedFrom on the segment when the provider reports a fallback', async () => {
    /* A silent voice fallback (sidecar X-Voice-Substituted-From) must reach the
       segment so the golden-audio gate can fail on it — previously it was only
       logged. */
    const provider: TtsProvider & { calls: SynthesizeInput[] } = {
      calls: [],
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        provider.calls.push(input);
        return {
          pcm: tonePcm(),
          sampleRate: 24000,
          mimeType: 'audio/pcm',
          voiceSubstitutedFrom: 'Requested Voice',
        };
      },
    };
    const result = await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'A line whose voice the sidecar could not honour.')],
      cast: gateCast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      groupHeartbeatMs: 0,
    });
    const body = result.segments.find((s) => s.sentenceIds.includes(1));
    expect(body?.voiceSubstitutedFrom).toBe('Requested Voice');
  });

  it('leaves voiceSubstitutedFrom undefined on a clean render', async () => {
    const provider = makeContentProvider(() => 'tone');
    const result = await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'A perfectly ordinary line.')],
      cast: gateCast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      groupHeartbeatMs: 0,
    });
    const body = result.segments.find((s) => s.sentenceIds.includes(1));
    expect(body?.voiceSubstitutedFrom).toBeUndefined();
  });
});

/* ── C1 (Wave 3): in-loop recycle recovery ───────────────────────────
   A transient sidecar-down mid-pool must recover WITHOUT discarding the
   already-completed groups: synthesiseChapter calls the injected
   `onRecoverRecycle` hook (the readiness wait, in production) and re-attempts
   ONLY the failed work item; every filled `results[]` slot survives because the
   function never restarts. On budget exhaustion it throws the named
   `RecycleStormError`; an abort or a non-transient error never recovers; and
   with no hook a transient bubbles out unchanged (the pre-C1 passthrough every
   other caller relies on).

   NOTE ON CALL COUNTS: each synth site wraps `withTtsRetry` (1 primary + 2
   retries on a persistent transient), so a single recovery attempt makes up to
   3 provider calls. These tests therefore assert on the RECOVERY count
   (`onRecoverRecycle` invocations / `RecycleStormError.recoveries`), which is
   the contract C1 introduces — independent of the inner retry budget. */
describe('synthesiseChapter C1 in-loop recycle recovery', () => {
  const c1Cast: CastCharacter[] = [
    { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
  ];

  function transientErr(): Error {
    return Object.assign(new Error('sidecar not reachable (fetch failed)'), {
      transient: true as const,
      cause: 'network' as const,
    });
  }

  it('recovers a transient mid-pool failure WITHOUT re-rendering completed groups', async () => {
    /* 3 single-sentence groups, serial (sentenceConcurrency 1). The middle
       group's first synthGroup throws a persistent transient (drains its whole
       withTtsRetry budget → 3 provider calls), which trips ONE in-loop recovery;
       on the re-attempt the provider succeeds. Groups 0 + 2 synth exactly once
       (never re-rendered). */
    const calls = new Map<string, number>();
    let g1Budget = 3; // throw for the first synthGroup's full retry budget, then succeed
    const provider: TtsProvider = {
      synthesize: vi.fn(async (input: SynthesizeInput): Promise<SynthesizeOutput> => {
        calls.set(input.text, (calls.get(input.text) ?? 0) + 1);
        if (input.text.includes('middle') && g1Budget > 0) {
          g1Budget -= 1;
          throw transientErr();
        }
        return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
      }),
    };
    const onRecoverRecycle = vi.fn(async () => {});

    const result = await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'first line.'),
        sentence(2, 'narrator', 'middle line.'),
        sentence(3, 'narrator', 'last line.'),
      ],
      cast: c1Cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'kokoro',
      sentenceConcurrency: 1,
      groupHeartbeatMs: 0,
      onRecoverRecycle,
      maxRecycleRecoveries: 2,
    });

    expect(onRecoverRecycle).toHaveBeenCalledTimes(1); // exactly one recovery
    expect(onRecoverRecycle).toHaveBeenCalledWith({ engine: 'kokoro', attempt: 1 });
    expect(calls.get('first line.')).toBe(1); // completed group NOT re-rendered
    expect(calls.get('last line.')).toBe(1); // completed group NOT re-rendered
    expect(result.segments.length).toBe(3); // chapter completed
  }, 15_000);

  it('throws RecycleStormError after the shared budget is exhausted', async () => {
    const onRecoverRecycle = vi.fn(async () => {});
    const provider: TtsProvider = {
      synthesize: vi.fn(async (): Promise<SynthesizeOutput> => {
        throw transientErr();
      }),
    };

    const err = await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'a line.')],
      cast: c1Cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'kokoro',
      sentenceConcurrency: 1,
      groupHeartbeatMs: 0,
      onRecoverRecycle,
      maxRecycleRecoveries: 2,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RecycleStormError);
    expect((err as RecycleStormError).recoveries).toBe(2);
    // 1 primary attempt + 2 recoveries = 3 synth attempts → hook fired twice.
    expect(onRecoverRecycle).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('a non-transient error does NOT recover (re-throws immediately)', async () => {
    const onRecoverRecycle = vi.fn(async () => {});
    const provider: TtsProvider = {
      synthesize: vi.fn(async (): Promise<SynthesizeOutput> => {
        throw new Error('index out of range in self');
      }),
    };

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'narrator', 'a line.')],
        cast: c1Cast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'kokoro',
        sentenceConcurrency: 1,
        groupHeartbeatMs: 0,
        onRecoverRecycle,
        maxRecycleRecoveries: 2,
      }),
    ).rejects.toThrow('index out of range');
    expect(onRecoverRecycle).not.toHaveBeenCalled(); // non-transient → no recovery
    expect(provider.synthesize).toHaveBeenCalledTimes(1); // withTtsRetry bails on non-transient
  });

  it('passthrough — with no onRecoverRecycle a transient bubbles out unchanged (pre-C1)', async () => {
    const provider: TtsProvider = {
      synthesize: vi.fn(async (): Promise<SynthesizeOutput> => {
        throw transientErr();
      }),
    };

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'narrator', 'a line.')],
        cast: c1Cast,
        provider,
        modelKey: 'gemini-2.5-flash',
        engine: 'kokoro',
        sentenceConcurrency: 1,
        groupHeartbeatMs: 0,
        // NO onRecoverRecycle → no in-loop recovery; transient bubbles out.
      }),
    ).rejects.toMatchObject({ transient: true });
  }, 15_000);
});
