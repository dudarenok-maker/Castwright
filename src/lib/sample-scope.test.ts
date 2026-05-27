import { describe, it, expect } from 'vitest';
import { sampleScopeFor } from './sample-scope';

describe('sampleScopeFor', () => {
  it('keys on the stable voiceId even when the voice is not resolved in the library', () => {
    /* The regression: at design time the library entry often isn't loaded,
       so the old `voice ? voice.id : char-<id>` produced `char-grady`, but at
       play time the entry resolved and it produced `grady` — a cache miss. */
    expect(sampleScopeFor({ id: 'grady', voiceId: 'grady' }, undefined)).toBe('grady');
    expect(sampleScopeFor({ id: 'grady', voiceId: 'grady' }, { id: 'grady' })).toBe('grady');
  });

  it('uses a resolved voice id when present', () => {
    expect(sampleScopeFor({ id: 'biana', voiceId: 'biana' }, { id: 'biana' })).toBe('biana');
  });

  it('falls back to the char-namespaced id for a character with no voiceId', () => {
    expect(sampleScopeFor({ id: 'new-char' }, undefined)).toBe('char-new-char');
    expect(sampleScopeFor({ id: 'new-char', voiceId: null }, null)).toBe('char-new-char');
  });
});
