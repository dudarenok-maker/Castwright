/* Unit coverage for the extracted snapshot builder shared by generation +
   splice. The drift detector depends on this shape, so we pin: only speaking
   characters appear, attributes are sorted, the resolved voice name is the
   real picker output, and a fallback engine is threaded through. The per-
   character render tier (`modelKey`) is pinned separately below — it feeds the
   srv-36 audition centroid, so it MUST match what routeFor synthesised under. */

import { describe, it, expect } from 'vitest';
import { buildCharacterSnapshots } from './character-snapshots.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

const cast: CastCharacter[] = [
  { id: 'castor', name: 'Castor', gender: 'female', ageRange: 'adult', attributes: ['warm', 'bright'] },
  { id: 'narrator', name: 'Narrator', gender: 'neutral', attributes: [] },
  { id: 'silent-guy', name: 'Mute', gender: 'male' },
];

describe('buildCharacterSnapshots', () => {
  it('includes only characters that actually spoke', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['castor', 'narrator']), 'kokoro', new Map(), 'kokoro-v1');
    expect(Object.keys(snaps).sort()).toEqual(['castor', 'narrator']);
    expect(snaps['silent-guy']).toBeUndefined();
  });

  it('sorts attributes for stable drift comparison', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['castor']), 'kokoro', new Map(), 'kokoro-v1');
    expect(snaps.castor.attributes).toEqual(['bright', 'warm']);
  });

  it('records the per-character engine + a resolved voice name', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['castor']), 'kokoro', new Map(), 'kokoro-v1');
    expect(snaps.castor.voiceEngine).toBe('kokoro');
    expect(typeof snaps.castor.resolvedVoiceName).toBe('string');
    expect(snaps.castor.resolvedVoiceName!.length).toBeGreaterThan(0);
  });

  it('threads renderedFallbackEngine through for characters that fell back', () => {
    const snaps = buildCharacterSnapshots(
      cast,
      new Set(['castor']),
      'qwen',
      new Map([['castor', 'kokoro']]),
      'qwen3-tts-1.7b',
    );
    expect(snaps.castor.renderedFallbackEngine).toBe('kokoro');
  });

  it('omits attributes when the character has none', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['narrator']), 'kokoro', new Map(), 'kokoro-v1');
    expect(snaps.narrator.attributes).toBeUndefined();
  });

  it('legacy Qwen voice without voiceUuid resolves to qwen-<voiceId> — no drift from srv-43 (srv-43 regression guard)', () => {
    /* An UNCHANGED legacy character: designed before srv-43, so it carries
       overrideTtsVoices.qwen.name but NO voiceUuid. The snapshot's
       resolvedVoiceName must still be qwen-<voiceId> via the legacy fallback
       path — not '' (undesigned) and not a uuid-based key. This asserts that
       the srv-43 changes introduce no snapshot drift for voices that were never
       re-designed after the upgrade. */
    const legacy: CastCharacter[] = [
      {
        id: 'char-wren',
        name: 'Wren',
        gender: 'female',
        voiceId: 'wren',
        // no voiceUuid — pre-srv-43 voice
        overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
        ttsEngine: 'qwen',
      },
    ];
    const snaps = buildCharacterSnapshots(legacy, new Set(['char-wren']), 'qwen', new Map(), 'qwen3-tts-1.7b');
    expect(snaps['char-wren'].resolvedVoiceName).toBe('qwen-wren');
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
    const snaps = buildCharacterSnapshots(qwenCast, new Set(['hero']), 'qwen', new Map(), 'qwen3-tts-0.6b');
    expect(snaps.hero.modelKey).toBe('qwen3-tts-1.7b');
  });

  it('stamps an un-pinned Qwen character with the run default tier', () => {
    const snaps = buildCharacterSnapshots(qwenCast, new Set(['extra']), 'qwen', new Map(), 'qwen3-tts-1.7b');
    expect(snaps.extra.modelKey).toBe('qwen3-tts-1.7b');
  });

  it('stamps a Kokoro character with its canonical key regardless of run default', () => {
    const snaps = buildCharacterSnapshots(qwenCast, new Set(['reader']), 'qwen', new Map(), 'qwen3-tts-1.7b');
    expect(snaps.reader.modelKey).toBe('kokoro-v1');
  });

  it('THE FIX: a Qwen 1.7B character in a NON-Qwen-default book is stamped 1.7B (not dragged to 0.6B)', () => {
    // The mixed-engine edge case the chapter-level modelKey missed: run default
    // is a Kokoro key, but a per-character Qwen 1.7B override renders on 1.7B.
    // The audition MUST see 1.7B here, or it co-resides the 0.6B base (8GB OOM).
    const snaps = buildCharacterSnapshots(qwenCast, new Set(['hero']), 'kokoro', new Map(), 'kokoro-v1');
    expect(snaps.hero.modelKey).toBe('qwen3-tts-1.7b');
  });
});
