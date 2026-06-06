/* Guard: a malformed analysis cache (a chapter entry that isn't an array of
   sentences) must fail LOUD and CONTEXTFUL, not with a bare
   "sentences.map is not a function".

   The 2026-06-06 incident: a recovery script rebuilt a dropped chapter as an
   index-keyed object ({"0":{...},"1":{...}}) instead of the array shape the
   analyzer writes (Record<number, SentenceOutput[]>). The cache save then threw
   the context-free TypeError deep inside seedEmotionsFromTags, surfacing in the
   UI as "Re-analysis failed: sentences.map is not a function" with no hint of
   WHICH chapter or that the cache file was corrupt. assertCacheChaptersShape
   turns that into an actionable error naming the chapter + manuscript. */

import { describe, it, expect } from 'vitest';
import { assertCacheChaptersShape } from './analysis-cache.js';

describe('assertCacheChaptersShape', () => {
  it('passes for well-formed chapters (every entry an array)', () => {
    const chapters = {
      3: [{ id: 1, chapterId: 3, characterId: 'narrator', text: 'PREFACE' }],
      4: [],
    } as never;
    expect(() => assertCacheChaptersShape(chapters)).not.toThrow();
  });

  it('throws naming the chapter when an entry is an object map (the recovery bug)', () => {
    const chapters = {
      3: { '0': { id: 1, chapterId: 3, text: 'PREFACE' } }, // object, not array
      4: [],
    } as never;
    expect(() => assertCacheChaptersShape(chapters, 'mns_X')).toThrowError(/chapter 3/);
    expect(() => assertCacheChaptersShape(chapters, 'mns_X')).toThrowError(/mns_X/);
  });

  it('throws for a null entry, reporting the type', () => {
    const chapters = { 5: null } as never;
    expect(() => assertCacheChaptersShape(chapters)).toThrowError(/chapter 5/);
    expect(() => assertCacheChaptersShape(chapters)).toThrowError(/null/);
  });

  it('does not throw on an empty cache', () => {
    expect(() => assertCacheChaptersShape({} as never)).not.toThrow();
  });
});
