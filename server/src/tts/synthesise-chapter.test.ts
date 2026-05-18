/* Regression coverage for the chapter synthesis voice-routing contract.

   The Elwyn/Ro bug: synthesiseChapter dropped every hint field from the cast
   before calling pickVoiceForEngine. The picker then had nothing to work with
   beyond id/name/attributes, inferGender returned 'unknown' for any character
   whose attributes didn't contain a gendered noun, and the fallback was
   narrator-cool. Net effect: Elwin (male) and Ro (female) both came out
   sounding like the narrator.

   These tests pin the contract so a future refactor cannot silently revert
   the hint plumbing. They use a fake provider (no real synthesis) and assert
   on the voiceName argument the picker resolves for each speaker. */

import { describe, it, expect } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';

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
        id: 'elwin',
        name: 'Elwin',
        gender: 'male',
        ageRange: 'adult',
        attributes: ['caring', 'firm', 'patient'],
        description: 'A medical professional balancing genuine care with firmness.',
      },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'elwin')],
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
    /* The exact bug scenario from Day One of the Bonus Keefe Story: three
       speakers, only the narrator gendered by id. Without the hint plumbing,
       Elwin and Ro both collapsed onto the narrator-cool bucket. */
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
      {
        id: 'elwin',
        name: 'Elwin',
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
        sentence(1, 'narrator', 'And it made Keefe queasier.'),
        sentence(2, 'elwin', 'Lifetime of pain if you do not listen.'),
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
    expect(GEMINI_MALE_VOICES, `elwin → ${elwinVoice}`).toContain(elwinVoice);
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
      { id: 'elwin', name: 'Elwin', gender: 'male', attributes: ['caring'] },
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
          sentence(2, 'elwin', 'Second group.'),
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
      { id: 'elwin', name: 'Elwin', gender: 'male', attributes: ['caring'] },
    ];
    const events: string[] = [];
    const provider: TtsProvider = {
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        events.push(`synth:${input.voiceName}`);
        return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };

    await synthesiseChapter({
      sentences: [sentence(1, 'narrator', 'First.'), sentence(2, 'elwin', 'Second.')],
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
    expect(events[3]).toBe('start:elwin');
    expect(events[4]).toMatch(/^synth:/);
    expect(events[5]).toBe('complete:elwin');
  });

  it('scrubs all-caps openers and em-dashes before handing text to the provider (chapter-2 regression)', async () => {
    /* The canonical Keeper of the Lost Cities chapter-2 opener fed XTTS
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
          'The car swerved right—missing Sophie by inches—then jumped the curb and sideswiped a streetlight.',
        ),
        sentence(
          3,
          'narrator',
          'The heavy steel lantern cracked from its base and plummeted toward Sophie.',
        ),
      ],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });

    expect(provider.calls).toHaveLength(1);
    const sentText = provider.calls[0].text;
    expect(sentText, `provider received: ${sentText}`).not.toMatch(/[A-Z]{3,}/);
    expect(sentText, `provider received: ${sentText}`).not.toMatch(/[—–]/);
    /* Sanity check that the actual content survived — we only meant to
       scrub the hazards, not drop the sentence. */
    expect(sentText).toContain('The Next Second Was A Blur.');
    expect(sentText).toContain('Sophie by inches, then');
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
      { id: 'elwin', name: 'Elwin', gender: 'male', attributes: ['caring'] },
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
        sentence(2, 'elwin', 'Second group with a different rate.'),
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
        id: 'keefe',
        name: 'Keefe',
        attributes: ['playful', 'witty'],
        description:
          'A witty young man recovering from his injuries. He often grins and jokes when he is scared. He keeps trying to reassure himself.',
      },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [sentence(1, 'keefe')],
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

/* ── Transient-failure auto-retry (Backlog Should #13) ──────────────────
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
