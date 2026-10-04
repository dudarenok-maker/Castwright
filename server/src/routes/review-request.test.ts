import { describe, it, expect } from 'vitest';
import { parseReviewRequest, INVALID_REVIEW } from './review-request.js';

describe('parseReviewRequest (plan 285)', () => {
  it('treats undefined and null as absent', () => {
    expect(parseReviewRequest(undefined)).toBeUndefined();
    expect(parseReviewRequest(null)).toBeUndefined();
  });
  it('accepts { characterId, triggeredBy } and strips extra fields', () => {
    expect(parseReviewRequest({ characterId: 'amy', triggeredBy: 'Amy voice change', x: 1 })).toEqual({
      characterId: 'amy',
      triggeredBy: 'Amy voice change',
    });
  });
  it('rejects every malformed shape', () => {
    for (const bad of [true, 'amy', [], {}, { characterId: '', triggeredBy: 't' }, { characterId: 'a' }, { characterId: 'a', triggeredBy: 3 }]) {
      expect(parseReviewRequest(bad)).toBe(INVALID_REVIEW);
    }
  });
});
