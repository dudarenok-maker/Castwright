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
        id: 'Oduvan',
        name: 'Oduvan',
        gender: 'male',
        ageRange: 'adult',
        attributes: ['caring', 'firm', 'patient'],
        description: 'A medical professional balancing genuine care with firmness.',
      },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'Oduvan')],
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
        id: 'Oduvan',
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
        sentence(2, 'Oduvan', 'Lifetime of pain if you do not listen.'),
        sentence(3, 'ro', 'Moving from denial mode to sulky boy.'),
      ],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });

    expect(provider.calls).toHaveLength(3);
    const [narratorVoice, OduvanVoice, roVoice] = provider.calls.map((c) => c.voiceName);

    expect(GEMINI_NARRATOR_VOICES, `narrator → ${narratorVoice}`).toContain(narratorVoice);
    expect(GEMINI_MALE_VOICES, `Oduvan → ${OduvanVoice}`).toContain(OduvanVoice);
    expect(GEMINI_FEMALE_VOICES, `ro → ${roVoice}`).toContain(roVoice);

    /* All three must be distinct — the original bug collapsed them onto the
       same narrator voice. */
    expect(new Set([narratorVoice, OduvanVoice, roVoice]).size).toBe(3);
  });

  it('honours an abort signal between groups (per-bookId mutex regression)', async () => {
    /* The per-bookId server mutex aborts the prior handler's controller when a
       new POST arrives for the same book. The synthesis loop must check the
       signal between groups so a stale handler stops within seconds instead
       of running the chapter to completion (each Coqui group can be minutes
       on CPU). This is what unstuck the pause→resume loop. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
      { id: 'Oduvan', name: 'Oduvan', gender: 'male', attributes: ['caring'] },
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
          sentence(2, 'Oduvan', 'Second group.'),
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
      { id: 'Oduvan', name: 'Oduvan', gender: 'male', attributes: ['caring'] },
    ];
    const events: string[] = [];
    const provider: TtsProvider = {
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        events.push(`synth:${input.voiceName}`);
        return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };

    await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'First.'), sentence(2, 'Oduvan', 'Second.')],
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
    expect(events[3]).toBe('start:Oduvan');
    expect(events[4]).toMatch(/^synth:/);
    expect(events[5]).toBe('complete:Oduvan');
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
      { id: 'Oduvan', name: 'Oduvan', gender: 'male', attributes: ['caring'] },
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
        sentence(2, 'Oduvan', 'Second group with a different rate.'),
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
        id: 'Marlow',
        name: 'Marlow',
        attributes: ['playful', 'witty'],
        description:
          'A witty young man recovering from his injuries. He often grins and jokes when he is scared. He keeps trying to reassure himself.',
      },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'Marlow')],
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
      { id: 'Marlow', name: 'Marlow', gender: 'male', attributes: ['witty'] },
    ];
    const provider = makeProvider();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'Marlow', 'Body line one.')],
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
    expect(result.segments[1].characterId).toBe('Marlow');
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
      { id: 'Oduvan', name: 'Oduvan', gender: 'male', attributes: ['caring'] },
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
      sentences: [sentence(1, 'Oduvan', 'Body line at a mismatched rate.')],
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
      { id: 'Marlow', name: 'Marlow', gender: 'male', attributes: ['witty'] },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'Marlow', 'Body.')],
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

  it('preserves order across mixed speakers', () => {
    const groups = buildSentenceGroups([
      s(1, 'narrator', 'Open.'),
      s(2, 'Wren', 'Hi.'),
      s(3, 'Wren', 'Are you there?'),
      s(4, 'narrator', 'Close.'),
    ]);
    expect(groups.map((g) => g.characterId)).toEqual(['narrator', 'Wren', 'Wren', 'narrator']);
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
        id: 'Maerin',
        name: 'Maerin',
        gender: 'female',
        ageRange: 'teen',
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'Maerin-designed' } },
      },
    ];
    const kokoro = taggedProvider(24000); // default engine + anchor rate
    const qwen = taggedProvider(16000); // different rate → must resample to anchor

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'narrator'), sentence(2, 'Maerin'), sentence(3, 'narrator')],
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
    expect(qwen.calls[0].voiceName).toBe('Maerin-designed');
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
    expect(result.segments.map((s) => s.characterId)).toEqual(['narrator', 'Maerin', 'narrator']);
  });

  it('without resolveForEngine + no per-character ttsEngine, everything uses the default provider (byte-identical to pre-108)', async () => {
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator' },
      { id: 'Brann', name: 'Brann', gender: 'male', ageRange: 'teen' },
    ];
    const provider = taggedProvider(24000);
    const result = await synthesiseChapter({
      sentences: [sentence(1, 'narrator'), sentence(2, 'Brann')],
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
      id: 'Maerin',
      name: 'Maerin',
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'Maerin-q' } },
    },
  ];

  const MIXED_SENTENCES = [
    sentence(1, 'narrator', 'First sentence here.'),
    sentence(2, 'Maerin', 'Two.'),
    sentence(3, 'narrator', 'A noticeably longer third sentence to vary the byte length.'),
    sentence(4, 'Maerin', 'Fourth!'),
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
      'Maerin-q',
      'narr-q',
      'Maerin-q',
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
      { id: 'narrator', name: 'Narrator' }, // default engine (qwen)
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
          sentence(2, 'Maerin', 'Batched one.'),
          sentence(3, 'Maerin', 'Batched two.'),
        ],
        cast: QWEN_CAST,
        provider,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        qwenBatchSize: 8,
        signal: controller.signal,
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
});
