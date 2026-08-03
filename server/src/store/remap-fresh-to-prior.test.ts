import { describe, it, expect } from 'vitest';
import { remapFreshToPriorIds } from './remap-fresh-to-prior.js';

describe('remapFreshToPriorIds', () => {
  it('keeps the prior id and rewrites the sentences to match', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'mayrin', name: 'Мэйрин' }],
      [{ characterId: 'mayrin', id: 1 }],
      [{ id: 'mairin', name: 'Мэйрин' }],
    );
    expect(r.characters[0].id).toBe('mairin');
    expect(r.sentences[0].characterId).toBe('mairin');
    expect(r.rewrites).toEqual({ mayrin: 'mairin' });
  });

  it('refuses an ambiguous name match', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'a1', name: 'Alden' }],
      [],
      [{ id: 'alden', name: 'Alden' }, { id: 'aldan', name: 'Alden' }],
    );
    expect(r.characters[0].id).toBe('a1');
    expect(r.rewrites).toEqual({});
  });

  it('honours a notLinkedTo edge', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'x', name: 'Alden' }],
      [],
      [{ id: 'alden', name: 'Alden', notLinkedTo: ['x'] }],
    );
    expect(r.rewrites).toEqual({});
  });

  /* Review round-1 finding 2 — the shape actually written to disk.
     `cast-not-linked-to.ts:238` (POST /:bookId/cast/:characterId/not-linked-to)
     and its `PersistedCharacter` type in `voices.ts:104` /
     `voice-override-linked.ts:65` both carry `notLinkedTo` as
     `Array<{ bookId, characterId }>` — never a bare string. Deleting the
     object branch (`remap-fresh-to-prior.ts:51-53`) left all 7 tests green
     before this one existed, because the sibling test above only exercises
     the string shape this module invented for itself. */
  it('honours a notLinkedTo edge in the real on-disk object shape', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'x', name: 'Alden' }],
      [],
      [{ id: 'alden', name: 'Alden', notLinkedTo: [{ bookId: 'other-book', characterId: 'x' }] }],
    );
    expect(r.rewrites).toEqual({});
  });

  /* Additional regression, not in the task-10 brief's Step 1 list: a rewrite
     target must never collide with an id another fresh character is already
     using this run — that would silently merge two distinct people onto one
     roster row instead of refusing like every other ambiguous case here. */
  it('refuses a rewrite whose target id collides with a different fresh character', () => {
    const r = remapFreshToPriorIds(
      [
        { id: 'alden', name: 'Someone Else' },
        { id: 'aldan-fresh', name: 'Alden' },
      ],
      [],
      [{ id: 'alden', name: 'Alden' }],
    );
    expect(r.characters.map((c) => c.id)).toEqual(['alden', 'aldan-fresh']);
    expect(r.rewrites).toEqual({});
  });

  it('does not mutate the input arrays', () => {
    const fresh = [{ id: 'mayrin', name: 'Мэйрин' }];
    const sentences = [{ characterId: 'mayrin', id: 1 }];
    const prior = [{ id: 'mairin', name: 'Мэйрин' }];
    remapFreshToPriorIds(fresh, sentences, prior);
    expect(fresh[0].id).toBe('mayrin');
    expect(sentences[0].characterId).toBe('mayrin');
  });

  /* §11 Q2 round-2 fix — the `priorRewrites` (cumulative dedup→fold table)
     parameter. Without composing against it, this remap collides with Site 1
     (`applyRewriteToPriorCast`) / Site 3 (`mergeAnalysisResultWithExistingCast`'s
     name-fallback) whenever a prior row's id is ALSO a key in that table —
     exactly the Task 8 end-to-end guard's fixture shape (a prior 'anton-x'
     row whose id collides with this run's own pre-dedup fresh id). */
  it('skips when the prior row has already converged with the fresh id via the rewrite table', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'canon', name: 'Anton Prime' }],
      [],
      [{ id: 'anton-x', name: 'Anton Prime' }],
      { 'anton-x': 'canon' },
    );
    expect(r.characters[0].id).toBe('canon');
    expect(r.rewrites).toEqual({});
  });

  it('adopts the rewrite table\'s destination id, not the stale raw prior id', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'z', name: 'Wren' }],
      [{ characterId: 'z', id: 1 }],
      [{ id: 'x', name: 'Wren' }],
      { x: 'y' },
    );
    expect(r.characters[0].id).toBe('y');
    expect(r.sentences[0].characterId).toBe('y');
    expect(r.rewrites).toEqual({ z: 'y' });
  });
});
