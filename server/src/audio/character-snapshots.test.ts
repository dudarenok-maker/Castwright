/* Unit coverage for the extracted snapshot builder shared by generation +
   splice. The drift detector depends on this shape, so we pin: only speaking
   characters appear, attributes are sorted, the resolved voice name is the
   real picker output, and a fallback engine is threaded through. */

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
    const snaps = buildCharacterSnapshots(cast, new Set(['castor', 'narrator']), 'kokoro', new Map());
    expect(Object.keys(snaps).sort()).toEqual(['castor', 'narrator']);
    expect(snaps['silent-guy']).toBeUndefined();
  });

  it('sorts attributes for stable drift comparison', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['castor']), 'kokoro', new Map());
    expect(snaps.castor.attributes).toEqual(['bright', 'warm']);
  });

  it('records the per-character engine + a resolved voice name', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['castor']), 'kokoro', new Map());
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
    );
    expect(snaps.castor.renderedFallbackEngine).toBe('kokoro');
  });

  it('omits attributes when the character has none', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['narrator']), 'kokoro', new Map());
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
    const snaps = buildCharacterSnapshots(legacy, new Set(['char-wren']), 'qwen', new Map());
    expect(snaps['char-wren'].resolvedVoiceName).toBe('qwen-wren');
  });
});
