import { describe, it, expect } from 'vitest';
import { sampleScopeFor } from './sample-scope';

describe('sampleScopeFor', () => {
  it('keys on the persisted voiceId', () => {
    expect(sampleScopeFor({ id: 'corvin', voiceId: 'corvin' })).toBe('corvin');
    expect(sampleScopeFor({ id: 'maerin', voiceId: 'maerin' })).toBe('maerin');
  });

  it('falls back to the char-namespaced id for a character with no voiceId or bookId', () => {
    expect(sampleScopeFor({ id: 'new-char' })).toBe('char-new-char');
    expect(sampleScopeFor({ id: 'new-char', voiceId: null })).toBe('char-new-char');
  });

  it('is STABLE for a voiceId-less character regardless of library state (the design→play miss)', () => {
    /* Regression: a freshly-designed Qwen character (no voiceId) had its
       audition cached at design time under `char-wren`, but the "Play 12s"
       player resolved a same-id library voice by play-time and the old
       `voice?.id ??` form flipped the scope to `wren` — a cache miss that
       re-synthesised the same line. The scope must not depend on whether a
       library voice happens to be resolved, so the function no longer takes a
       `voice` argument at all. */
    expect(sampleScopeFor({ id: 'wren' })).toBe('char-wren');
    expect(sampleScopeFor({ id: 'wren', voiceId: undefined })).toBe('char-wren');
  });

  it('bug #1411: book-scopes the char-namespaced fallback when a bookId is given', () => {
    expect(sampleScopeFor({ id: 'narrator' }, 'book-alpha')).toBe('char-book-alpha-narrator');
    expect(sampleScopeFor({ id: 'narrator' }, 'book-beta')).toBe('char-book-beta-narrator');
    expect(sampleScopeFor({ id: 'narrator' }, 'book-alpha')).not.toBe(
      sampleScopeFor({ id: 'narrator' }, 'book-beta'),
    );
  });

  it('bug #1411: a persisted voiceId still wins over bookId (deliberate cross-book reuse)', () => {
    expect(sampleScopeFor({ id: 'narrator', voiceId: 'v_narrator' }, 'book-alpha')).toBe(
      'v_narrator',
    );
  });
});
