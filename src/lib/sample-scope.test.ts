import { describe, it, expect } from 'vitest';
import { sampleScopeFor } from './sample-scope';

describe('sampleScopeFor', () => {
  it('keys on the persisted voiceId', () => {
    expect(sampleScopeFor({ id: 'Corvin', voiceId: 'Corvin' })).toBe('Corvin');
    expect(sampleScopeFor({ id: 'Maerin', voiceId: 'Maerin' })).toBe('Maerin');
  });

  it('falls back to the char-namespaced id for a character with no voiceId', () => {
    expect(sampleScopeFor({ id: 'new-char' })).toBe('char-new-char');
    expect(sampleScopeFor({ id: 'new-char', voiceId: null })).toBe('char-new-char');
  });

  it('is STABLE for a voiceId-less character regardless of library state (the design→play miss)', () => {
    /* Regression: a freshly-designed Qwen character (no voiceId) had its
       audition cached at design time under `char-Wren`, but the "Play 12s"
       player resolved a same-id library voice by play-time and the old
       `voice?.id ??` form flipped the scope to `Wren` — a cache miss that
       re-synthesised the same line. The scope must not depend on whether a
       library voice happens to be resolved, so the function no longer takes a
       `voice` argument at all. */
    expect(sampleScopeFor({ id: 'Wren' })).toBe('char-Wren');
    expect(sampleScopeFor({ id: 'Wren', voiceId: undefined })).toBe('char-Wren');
  });
});
