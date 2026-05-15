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

import { describe, it, expect } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';

const GEMINI_MALE_VOICES   = new Set(['Charon', 'Algieba', 'Puck', 'Orus', 'Iapetus', 'Sadachbia']);
const GEMINI_FEMALE_VOICES = new Set(['Despina', 'Vindemiatrix', 'Kore', 'Leda', 'Aoede', 'Callirrhoe']);
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
      { id: 'Oduvan', name: 'Oduvan', gender: 'male', ageRange: 'adult',
        attributes: ['caring', 'firm', 'patient'],
        description: 'A medical professional balancing genuine care with firmness.' },
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
      { id: 'ro', name: 'Ro', gender: 'female', ageRange: 'adult',
        attributes: ['sarcastic', 'blunt', 'intimidating'],
        description: 'A sharp-tongued goblin with brutal honesty.' },
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
    expect(GEMINI_NARRATOR_VOICES, `Got narrator voice ${used} for female cast`).not.toContain(used);
  });

  it('keeps the narrator on a narrator voice', async () => {
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', attributes: ['observational'],
        tone: { warmth: 24, pace: 65, authority: 70, emotion: 59 } },
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
      { id: 'Oduvan', name: 'Oduvan', gender: 'male', ageRange: 'adult',
        attributes: ['caring', 'firm'] },
      { id: 'ro',    name: 'Ro',    gender: 'female', ageRange: 'adult',
        attributes: ['sarcastic', 'blunt'] },
    ];
    const provider = makeProvider();

    await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'And it made Marlow queasier.'),
        sentence(2, 'Oduvan',    'Lifetime of pain if you do not listen.'),
        sentence(3, 'ro',       'Moving from denial mode to sulky boy.'),
      ],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });

    expect(provider.calls).toHaveLength(3);
    const [narratorVoice, OduvanVoice, roVoice] = provider.calls.map(c => c.voiceName);

    expect(GEMINI_NARRATOR_VOICES, `narrator → ${narratorVoice}`).toContain(narratorVoice);
    expect(GEMINI_MALE_VOICES,     `Oduvan → ${OduvanVoice}`).toContain(OduvanVoice);
    expect(GEMINI_FEMALE_VOICES,   `ro → ${roVoice}`).toContain(roVoice);

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
      { id: 'Oduvan',    name: 'Oduvan', gender: 'male',   attributes: ['caring'] },
      { id: 'ro',       name: 'Ro',    gender: 'female', attributes: ['blunt'] },
    ];
    const controller = new AbortController();
    const provider = makeProvider();
    const originalSynth = provider.synthesize.bind(provider);
    provider.synthesize = async (input) => {
      const out = await originalSynth(input);
      if (provider.calls.length === 1) controller.abort();
      return out;
    };

    await expect(synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'First group.'),
        sentence(2, 'Oduvan',    'Second group.'),
        sentence(3, 'ro',       'Third group.'),
      ],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

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
      { id: 'Oduvan',    name: 'Oduvan', gender: 'male', attributes: ['caring'] },
    ];
    const events: string[] = [];
    const provider: TtsProvider = {
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        events.push(`synth:${input.voiceName}`);
        return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };

    await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'First.'),
        sentence(2, 'Oduvan',    'Second.'),
      ],
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
        sentence(2, 'narrator', 'The car swerved right—missing Wren by inches—then jumped the curb and sideswiped a streetlight.'),
        sentence(3, 'narrator', 'The heavy steel lantern cracked from its base and plummeted toward Wren.'),
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
    expect(sentText).toContain('Wren by inches, then');
  });

  it('falls back to gendered inference from description when explicit gender is absent', async () => {
    /* Belt-and-braces: if the analyzer cached an older shape without
       `gender:`, the prose description still carries enough signal to land
       in the right bucket. */
    const cast: CastCharacter[] = [
      { id: 'Marlow', name: 'Marlow', attributes: ['playful', 'witty'],
        description: 'A witty young man recovering from his injuries. He often grins and jokes when he is scared. He keeps trying to reassure himself.' },
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
    expect(GEMINI_MALE_VOICES, `Expected description-based fallback to male, got ${used}`).toContain(used);
  });
});
