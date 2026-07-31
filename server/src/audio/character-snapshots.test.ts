/* Unit coverage for the extracted snapshot builder shared by generation +
   splice. The drift detector depends on this shape, so we pin: only speaking
   characters appear, attributes are sorted, the resolved voice name is the
   voice ACTUALLY sent to the provider (not re-derived from the cast record —
   #1972), and a fallback engine is threaded through. The per-character render
   tier (`modelKey`) is pinned separately below — it feeds the srv-36 audition
   centroid, so it MUST match what routeFor synthesised under. */

import { describe, it, expect } from 'vitest';
import { buildCharacterSnapshots } from './character-snapshots.js';
import {
  synthesiseChapter,
  toVoiceLike,
  buildHintFromCast,
  type CastCharacter,
} from '../tts/synthesise-chapter.js';
import { pickVoiceForEngine } from '../tts/voice-mapping.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from '../tts/index.js';

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

const cast: CastCharacter[] = [
  { id: 'castor', name: 'Castor', gender: 'female', ageRange: 'adult', attributes: ['warm', 'bright'] },
  { id: 'narrator', name: 'Narrator', gender: 'neutral', attributes: [] },
  { id: 'silent-guy', name: 'Mute', gender: 'male' },
];

describe('buildCharacterSnapshots', () => {
  it('includes only characters that actually spoke', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['castor', 'narrator']), 'kokoro', new Map(), 'kokoro-v1', new Map());
    expect(Object.keys(snaps).sort()).toEqual(['castor', 'narrator']);
    expect(snaps['silent-guy']).toBeUndefined();
  });

  it('sorts attributes for stable drift comparison', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['castor']), 'kokoro', new Map(), 'kokoro-v1', new Map());
    expect(snaps.castor.attributes).toEqual(['bright', 'warm']);
  });

  it('records the per-character engine + the voice name actually sent to the provider', () => {
    const snaps = buildCharacterSnapshots(
      cast,
      new Set(['castor']),
      'kokoro',
      new Map(),
      'kokoro-v1',
      new Map([['castor', 'kokoro-castor-voice']]),
    );
    expect(snaps.castor.voiceEngine).toBe('kokoro');
    expect(snaps.castor.resolvedVoiceName).toBe('kokoro-castor-voice');
  });

  it('threads renderedFallbackEngine through for characters that fell back', () => {
    const snaps = buildCharacterSnapshots(
      cast,
      new Set(['castor']),
      'qwen',
      new Map([['castor', 'kokoro']]),
      'qwen3-tts-1.7b',
      new Map(),
    );
    expect(snaps.castor.renderedFallbackEngine).toBe('kokoro');
  });

  it('omits attributes when the character has none', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['narrator']), 'kokoro', new Map(), 'kokoro-v1', new Map());
    expect(snaps.narrator.attributes).toBeUndefined();
  });

  it('#1972 — resolvedVoiceName follows the voice ACTUALLY sent, not a re-derivation from the cast record', () => {
    /* The exact #1972 symptom: the cast's assigned voice and the voice this
       run actually rendered under can differ (a substitution upstream, an
       analysis-source disagreement in the splice path, etc). The snapshot
       must report what happened, not what was intended. */
    const legacy: CastCharacter[] = [
      {
        id: 'char-wren',
        name: 'Wren',
        gender: 'female',
        voiceId: 'wren',
        overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
        ttsEngine: 'qwen',
      },
    ];
    const assignedVoice = pickVoiceForEngine('qwen', toVoiceLike(legacy[0]), buildHintFromCast(legacy[0]));
    const actuallyRenderedVoice = 'qwen-some-other-voice-entirely';
    expect(actuallyRenderedVoice).not.toBe(assignedVoice); // sanity: the two genuinely differ

    const snaps = buildCharacterSnapshots(
      legacy,
      new Set(['char-wren']),
      'qwen',
      new Map(),
      'qwen3-tts-1.7b',
      new Map([['char-wren', actuallyRenderedVoice]]),
    );
    expect(snaps['char-wren'].resolvedVoiceName).toBe(actuallyRenderedVoice);
    expect(snaps['char-wren'].resolvedVoiceName).not.toBe(assignedVoice);
  });

  it('#1972 — omits resolvedVoiceName rather than asserting a voice that was never sent, when `voiceNameByChar` carries no entry for a speaking character', () => {
    /* This pins buildCharacterSnapshots' OWN contract in isolation: given an
       empty voiceNameByChar, it must never invent a voice. It does NOT pin
       "what happens on a real remix" — a gain-only remix in production
       doesn't actually reach this empty-map state, because
       finalize-chapter-write.ts (the only caller) pre-populates
       voiceNameByChar with the PRIOR render's resolvedVoiceName for any
       speaking character this run didn't synthesise, before ever calling
       this function (see finalize-chapter-write.test.ts's "carries
       resolvedVoiceName forward" cases, C1 (#1972 follow-up)). This test's
       empty map models the one case that carry-forward can't fill: a
       character with no prior recorded voice at all (e.g. a first-ever
       render that somehow reached this state). */
    const snaps = buildCharacterSnapshots(cast, new Set(['castor']), 'kokoro', new Map(), 'kokoro-v1', new Map());
    expect(snaps.castor.resolvedVoiceName).toBeUndefined();
  });
});

describe('buildCharacterSnapshots — per-character render tier (srv-36 audition-centroid feed)', () => {
  const qwenCast: CastCharacter[] = [
    { id: 'hero', name: 'Hero', ttsEngine: 'qwen', ttsModelKey: 'qwen3-tts-1.7b' },
    { id: 'extra', name: 'Extra', ttsEngine: 'qwen' }, // no per-char tier → run default
    { id: 'reader', name: 'Reader', ttsEngine: 'kokoro' },
  ];

  it('stamps a Qwen character with an explicit 1.7B tier as 1.7B, even when the run default is 0.6B', () => {
    // The elevate-only rule: a per-character 1.7B pin wins over a lower run default.
    const snaps = buildCharacterSnapshots(qwenCast, new Set(['hero']), 'qwen', new Map(), 'qwen3-tts-0.6b', new Map());
    expect(snaps.hero.modelKey).toBe('qwen3-tts-1.7b');
  });

  it('stamps an un-pinned Qwen character with the run default tier', () => {
    const snaps = buildCharacterSnapshots(qwenCast, new Set(['extra']), 'qwen', new Map(), 'qwen3-tts-1.7b', new Map());
    expect(snaps.extra.modelKey).toBe('qwen3-tts-1.7b');
  });

  it('stamps a Kokoro character with its canonical key regardless of run default', () => {
    const snaps = buildCharacterSnapshots(qwenCast, new Set(['reader']), 'qwen', new Map(), 'qwen3-tts-1.7b', new Map());
    expect(snaps.reader.modelKey).toBe('kokoro-v1');
  });

  it('THE FIX: a Qwen 1.7B character in a NON-Qwen-default book is stamped 1.7B (not dragged to 0.6B)', () => {
    // The mixed-engine edge case the chapter-level modelKey missed: run default
    // is a Kokoro key, but a per-character Qwen 1.7B override renders on 1.7B.
    // The audition MUST see 1.7B here, or it co-resides the 0.6B base (8GB OOM).
    const snaps = buildCharacterSnapshots(qwenCast, new Set(['hero']), 'kokoro', new Map(), 'kokoro-v1', new Map());
    expect(snaps.hero.modelKey).toBe('qwen3-tts-1.7b');
  });

  it('F1 regression: an UN-PINNED Qwen character in a Kokoro-default book is stamped the Qwen base (0.6B), not the raw run key', () => {
    // routeFor renders `extra` on Qwen 0.6B (resolveForEngine('qwen').modelKey
    // falls back to 0.6B). Before the fix, buildCharacterSnapshots passed the
    // raw run key `kokoro-v1` into resolveCharacterQwenTier, which — with no
    // per-character ttsModelKey — returned it VERBATIM, stamping a `qwen`-engine
    // snapshot with `kokoro-v1`. The render-integrity keep-flags then missed the
    // in-use 0.6B tier and reconcile evicted it out from under the render.
    const snaps = buildCharacterSnapshots(qwenCast, new Set(['extra']), 'kokoro', new Map(), 'kokoro-v1', new Map());
    expect(snaps.extra.voiceEngine).toBe('qwen');
    expect(snaps.extra.modelKey).toBe('qwen3-tts-0.6b');
  });
});

/* #1972 — end-to-end wiring check: drive the REAL `synthesiseChapter` with a
   fake provider (no live sidecar), then feed its OWN segments through the SAME
   voiceNameByChar-building step `finalize-chapter-write.ts` uses, into the
   REAL `buildCharacterSnapshots`. Pins the whole chain the fix depends on —
   provider.calls[i].voiceName -> ChapterSegment.voiceName ->
   voiceNameByChar -> CharacterSnapshot.resolvedVoiceName — end to end, not
   just at each function's own boundary. */
describe('buildCharacterSnapshots + synthesiseChapter — #1972 end-to-end voice provenance', () => {
  it('resolvedVoiceName equals the voice actually sent to the provider', async () => {
    const provider = makeProvider();
    /* #1992 review (M3) — an EXPLICIT override, so the expected voice is a
       literal known independently of the code under test. Reading the expected
       value out of `provider.calls[0]` (as this test first did) pins only that
       the snapshot AGREES with the provider — it cannot tell "the right voice
       was sent" from "a wrong voice was sent consistently", which is precisely
       the #1972 substitution class. */
    const castMember: CastCharacter = {
      id: 'oduvan',
      name: 'Oduvan',
      gender: 'male',
      overrideTtsVoices: { kokoro: { name: 'kokoro-oduvan-explicit' } },
    };

    const result = await synthesiseChapter({
      sentences: [{ id: 1, chapterId: 1, characterId: 'oduvan', text: 'A short line.' }],
      cast: [castMember],
      provider,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
    });

    expect(provider.calls).toHaveLength(1);
    const sentVoice = provider.calls[0].voiceName;
    // The load-bearing assertion: the voice the provider ACTUALLY received is
    // the character's assigned one, checked against a literal — not against a
    // value re-read from the same call.
    expect(sentVoice).toBe('kokoro-oduvan-explicit');
    expect(result.segments[0].voiceName).toBe(sentVoice);

    // Same voiceNameByChar-building loop finalize-chapter-write.ts runs.
    const voiceNameByChar = new Map<string, string>();
    for (const s of result.segments) {
      if (s.voiceName) voiceNameByChar.set(s.characterId, s.voiceName);
    }
    const speakingIds = new Set(result.segments.map((s) => s.characterId));
    const snaps = buildCharacterSnapshots(
      [castMember],
      speakingIds,
      'kokoro',
      new Map(),
      'kokoro-v1',
      voiceNameByChar,
    );
    expect(snaps.oduvan.resolvedVoiceName).toBe(sentVoice);
  });
});
