/* Unit coverage for the extracted snapshot builder shared by generation +
   splice. The drift detector depends on this shape, so we pin: only speaking
   characters appear, attributes are sorted, the resolved voice name is the
   real picker output, and a fallback engine is threaded through. */

import { describe, it, expect } from 'vitest';
import { buildCharacterSnapshots } from './character-snapshots.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

const cast: CastCharacter[] = [
  { id: 'bronte', name: 'Bronte', gender: 'female', ageRange: 'adult', attributes: ['warm', 'bright'] },
  { id: 'narrator', name: 'Narrator', gender: 'neutral', attributes: [] },
  { id: 'silent-guy', name: 'Mute', gender: 'male' },
];

describe('buildCharacterSnapshots', () => {
  it('includes only characters that actually spoke', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['bronte', 'narrator']), 'kokoro', new Map());
    expect(Object.keys(snaps).sort()).toEqual(['bronte', 'narrator']);
    expect(snaps['silent-guy']).toBeUndefined();
  });

  it('sorts attributes for stable drift comparison', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['bronte']), 'kokoro', new Map());
    expect(snaps.bronte.attributes).toEqual(['bright', 'warm']);
  });

  it('records the per-character engine + a resolved voice name', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['bronte']), 'kokoro', new Map());
    expect(snaps.bronte.voiceEngine).toBe('kokoro');
    expect(typeof snaps.bronte.resolvedVoiceName).toBe('string');
    expect(snaps.bronte.resolvedVoiceName!.length).toBeGreaterThan(0);
  });

  it('threads renderedFallbackEngine through for characters that fell back', () => {
    const snaps = buildCharacterSnapshots(
      cast,
      new Set(['bronte']),
      'qwen',
      new Map([['bronte', 'kokoro']]),
    );
    expect(snaps.bronte.renderedFallbackEngine).toBe('kokoro');
  });

  it('omits attributes when the character has none', () => {
    const snaps = buildCharacterSnapshots(cast, new Set(['narrator']), 'kokoro', new Map());
    expect(snaps.narrator.attributes).toBeUndefined();
  });
});
