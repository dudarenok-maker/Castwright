/* Unit coverage for the extracted snapshot builder shared by generation +
   splice. The drift detector depends on this shape, so we pin: only speaking
   characters appear, attributes are sorted, the resolved voice name is the
   real picker output, and a fallback engine is threaded through. */

import { describe, it, expect } from 'vitest';
import { buildCharacterSnapshots } from './character-snapshots.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

const cast: CastCharacter[] = [
  { id: 'Castor', name: 'Castor', gender: 'female', ageRange: 'adult', attributes: ['warm', 'bright'] },
  { id: 'narrator', name: 'Narrator', gender: 'neutral', attributes: [] },
  { id: 'silent-guy', name: 'Mute', gender: 'male' },
];

describe('buildCharacterSnapshots', () => {
  it('includes only characters that actually spoke', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['Castor', 'narrator']), 'kokoro', new Map());
    expect(Object.keys(snaps).sort()).toEqual(['Castor', 'narrator']);
    expect(snaps['silent-guy']).toBeUndefined();
  });

  it('sorts attributes for stable drift comparison', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['Castor']), 'kokoro', new Map());
    expect(snaps.Castor.attributes).toEqual(['bright', 'warm']);
  });

  it('records the per-character engine + a resolved voice name', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['Castor']), 'kokoro', new Map());
    expect(snaps.Castor.voiceEngine).toBe('kokoro');
    expect(typeof snaps.Castor.resolvedVoiceName).toBe('string');
    expect(snaps.Castor.resolvedVoiceName!.length).toBeGreaterThan(0);
  });

  it('threads renderedFallbackEngine through for characters that fell back', () => {
    const snaps = buildCharacterSnapshots(
      cast,
      new Set(['Castor']),
      'qwen',
      new Map([['Castor', 'kokoro']]),
    );
    expect(snaps.Castor.renderedFallbackEngine).toBe('kokoro');
  });

  it('omits attributes when the character has none', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['narrator']), 'kokoro', new Map());
    expect(snaps.narrator.attributes).toBeUndefined();
  });
});
