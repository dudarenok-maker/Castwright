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

  /* #2584/#2570 — the real reported case: a re-analysis mints a fresh
     Cyrillic-kebab id (`одуван`) for a character whose established, already-
     live id is the stable ASCII kebab `oduvan`. This module's exact-name
     matcher already resolves it correctly and unconditionally: the prior id
     survives and the sentences cascade with it, regardless of either id's
     script. (An earlier fix landed a second, narrower survival rule directly
     in `mergeAnalysisResultWithExistingCast` — reverted in this commit,
     PR review found it broke the sentence/cast.json cascade (F1) and let a
     reserved fold-bucket id survive (F2); this module already ran BEFORE
     sentence persistence and already cascades both halves, so no change was
     needed here.) */
  it('keeps the established ASCII id over a freshly-minted non-ASCII id, cascading to sentences (#2584/#2570)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'одуван', name: 'Одуван' }],
      [{ characterId: 'одуван', id: 1 }],
      [{ id: 'oduvan', name: 'Одуван', voiceState: 'tuned' }],
    );
    expect(r.characters[0].id).toBe('oduvan');
    expect(r.sentences[0].characterId).toBe('oduvan');
    expect(r.rewrites).toEqual({ одуван: 'oduvan' });
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

  /* #3965 — the gate is scoped by book. A cross-book object entry says
     nothing about a same-book join. */
  it('T1: ignores a cross-book edge the seed copied onto an id-drifted twin', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'old-tom-2', name: 'Old Tom', notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }] }],
      [{ characterId: 'old-tom-2' }],
      [
        {
          id: 'old-tom',
          name: 'Old Tom',
          voiceId: 'v_tom',
          voiceState: 'locked',
          notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
        },
      ],
      {},
      'book-2',
    );
    expect(r.rewrites).toEqual({ 'old-tom-2': 'old-tom' });
    expect(r.characters[0].id).toBe('old-tom');
    expect(r.sentences[0].characterId).toBe('old-tom');
  });

  it('T2: ignores a prior-side cross-book edge only', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'x', name: 'Alden' }],
      [],
      [{ id: 'alden', name: 'Alden', notLinkedTo: [{ bookId: 'book-1', characterId: 'x' }] }],
      {},
      'book-2',
    );
    expect(r.rewrites).toEqual({ x: 'alden' });
  });

  it('T3: a same-book edge still blocks', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'x', name: 'Alden' }],
      [],
      [{ id: 'alden', name: 'Alden', notLinkedTo: [{ bookId: 'book-2', characterId: 'x' }] }],
      {},
      'book-2',
    );
    expect(r.rewrites).toEqual({});
  });

  it('T4: a bare-string edge still blocks when currentBookId is given', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'x', name: 'Alden' }],
      [],
      [{ id: 'alden', name: 'Alden', notLinkedTo: ['x'] }],
      {},
      'book-2',
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

  /* Wave 2 final-review finding 1(a). The mirror of the `freshIds.has(target)`
     guard above: that one refuses to remap ONTO an id a different fresh row
     holds; this one refuses to remap AWAY FROM an id a different PRIOR row
     still holds. Without it the rewrite retires a LIVE id, and
     `retireCharacterId`'s repoint loop (cast-id-history.ts:123-127) — which is
     only sound when `from` is genuinely dead — drags every unrelated history
     entry pointing at Brann onto Brann Weir. `dedupePriorCastByName` does not
     collapse the pair (`normaliseNameKey` gives brann / brannweir), and
     `dropSupersededIdsReclaimedByLiveCast` removes only the `brann` KEY at the
     end of the run, never the collateral repoint. */
  it('refuses a rewrite that would retire an id a DIFFERENT prior character still holds', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'brann', name: 'Brann Weir' }],
      [{ characterId: 'brann', id: 1 }],
      [
        { id: 'brann', name: 'Brann' },
        { id: 'brann-weir', name: 'Brann Weir' },
      ],
    );
    expect(r.rewrites).toEqual({});
    expect(r.characters[0].id).toBe('brann');
    expect(r.sentences[0].characterId).toBe('brann');
  });

  /* The guard compares POST-rewrite prior ids, not raw ones — same id space
     the `target` it is compared against already lives in. A prior row that
     happens to hold the fresh id but is itself being collapsed elsewhere by
     THIS run's dedup→fold table is not going to hold it after the persist, so
     it must not block the remap (over-refusing here would silently disable the
     §11 Q2 composition case the two tests above pin). */
  it('still remaps when the prior row holding the fresh id is itself heading elsewhere this run', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'brann', name: 'Brann Weir' }],
      [],
      [
        { id: 'brann', name: 'Brann' },
        { id: 'brann-weir', name: 'Brann Weir' },
      ],
      { brann: 'someone-else' },
    );
    expect(r.rewrites).toEqual({ brann: 'brann-weir' });
  });

  /* Wave 2 final-review finding 2 — spec §1.4's real _Exile_ shape: the
     analyzer emitted the reserved fold-bucket id `unknown-male` as the id of a
     character it named "Timkin", and that row is still in cast.json today. A
     fresh, correctly-slugged `timkin` row name-matches it, and without an
     exclusion this remap moves every Timkin sentence onto the reserved bucket
     AFTER `foldMinorCast` has already run — nothing downstream re-separates
     them. Regenerates RC1's "collision onto a reserved string". */
  it('never remaps a fresh character onto a reserved fold-bucket id', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'timkin', name: 'Timkin' }],
      [{ characterId: 'timkin', id: 1 }],
      [{ id: 'unknown-male', name: 'Timkin' }],
    );
    expect(r.rewrites).toEqual({});
    expect(r.characters[0].id).toBe('timkin');
    expect(r.sentences[0].characterId).toBe('timkin');
  });

  it('never remaps a fresh character onto the reserved narrator id', () => {
    /* `applyNarratorIdentity` decorates a narrator row but never seeds one, so
       a fresh roster can legitimately have none. A prior narrator the user
       renamed then name-matches a real fresh character, and the rewrite would
       retire that character's id onto `narrator` — #2040's original bug,
       manufactured by the mechanism built to prevent it. Task 12 closed this
       exact shape on the merge fallback (merge-analysis-cast.ts:219/:260). */
    const r = remapFreshToPriorIds(
      [{ id: 'sabine', name: 'The Chronicler' }],
      [],
      [{ id: 'narrator', name: 'The Chronicler' }],
    );
    expect(r.rewrites).toEqual({});
  });

  it('never retires a reserved id off the fresh roster either', () => {
    // Mirror direction: the fresh row IS the reserved id. Retiring `narrator`
    // onto a prior character id would reroute all narration.
    const r = remapFreshToPriorIds(
      [{ id: 'narrator', name: 'The Chronicler' }],
      [],
      [{ id: 'chronicler', name: 'The Chronicler' }],
    );
    expect(r.rewrites).toEqual({});
  });

  it('never retires a reserved fold-bucket id off the fresh roster either', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'unknown-female', name: 'Unknown female' }],
      [],
      [{ id: 'minor-women', name: 'Unknown female' }],
    );
    expect(r.rewrites).toEqual({});
  });

  /* #3954 child 1 — the surname-tolerant join keeps the prior id (option (c),
     owner decision 2026-10-31 on #3954): a character whose name gained or
     lost a trailing token keeps its prior cast id before any sentence is
     written, using the SAME surname-tolerant join and voiced-row selection
     rule `mergeCore` already applies (`merge-analysis-cast.ts`), never a
     second matcher. */
  it('R1: keeps the prior id when the fresh name gained a surname (#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'wren-ashby', name: 'Wren Ashby' }],
      [{ characterId: 'wren-ashby', id: 1 }],
      [{ id: 'w2', name: 'Wren', voiceState: 'locked' }],
    );
    expect(r.rewrites).toEqual({ 'wren-ashby': 'w2' });
    expect(r.characters[0].id).toBe('w2');
    expect(r.sentences[0].characterId).toBe('w2');
  });

  it('R2: keeps the prior id when the fresh name lost a surname (#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'wren', name: 'Wren' }],
      [{ characterId: 'wren', id: 1 }],
      [{ id: 'w2', name: 'Wren Ashby' }],
    );
    expect(r.rewrites).toEqual({ wren: 'w2' });
    expect(r.characters[0].id).toBe('w2');
    expect(r.sentences[0].characterId).toBe('w2');
  });

  it('R3: remaps an unpinned linked prior row with no voiceId (#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'wren-ashby', name: 'Wren Ashby' }],
      [{ characterId: 'wren-ashby', id: 1 }],
      [
        {
          id: 'w2',
          name: 'Wren',
          voiceState: 'reused',
          matchedFrom: { bookId: 'book-1', characterId: 'wren', bookTitle: 'One', confidence: 1 },
        },
      ],
    );
    expect(r.rewrites).toEqual({ 'wren-ashby': 'w2' });
    expect(r.characters[0].id).toBe('w2');
    expect(r.sentences[0].characterId).toBe('w2');
  });

  it('R4: claim-once refuses a prior row claimed by two tolerant keys (#3954)', () => {
    const r = remapFreshToPriorIds(
      [
        { id: 'brann-weir', name: 'Brann Weir' },
        { id: 'brann-cole', name: 'Brann Cole' },
      ],
      [],
      [{ id: 'brann', name: 'Brann' }],
    );
    expect(r.rewrites).toEqual({});
  });

  it('R5: an exact pair is preferred over a tolerant pair on the same prior row (#3954)', () => {
    const r = remapFreshToPriorIds(
      [
        { id: 'b1', name: 'Brann' },
        { id: 'b2', name: 'Brann Weir' },
      ],
      [],
      [{ id: 'brann', name: 'Brann' }],
    );
    expect(r.rewrites).toEqual({ b1: 'brann' });
  });

  it('R6: two unvoiced tolerant candidates stay ambiguous (#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'wren', name: 'Wren' }],
      [],
      [
        { id: 'wa', name: 'Wren Ashby' },
        { id: 'wc', name: 'Wren Cole' },
      ],
    );
    expect(r.rewrites).toEqual({});
  });

  it('R7: a voiced prior row wins a shared exact name (#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'alden-fresh', name: 'Alden' }],
      [],
      [
        { id: 'alden-locked', name: 'Alden', voiceState: 'locked' },
        { id: 'alden-plain', name: 'Alden' },
      ],
    );
    expect(r.rewrites).toEqual({ 'alden-fresh': 'alden-locked' });
  });

  it('R7 tolerant: a voiced prior row wins a shared tolerant name (#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'alden-vane', name: 'Alden Vane' }],
      [],
      [
        { id: 'alden-locked', name: 'Alden', voiceState: 'locked' },
        { id: 'alden-plain', name: 'Alden' },
      ],
    );
    expect(r.rewrites).toEqual({ 'alden-vane': 'alden-locked' });
  });

  it('R7 decline: a twin declining the voiced row’s series link keeps the name ambiguous (#3965/#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'old-tom-2', name: 'Old Tom' }],
      [],
      [
        {
          id: 'thomas',
          name: 'Old Tom',
          voiceState: 'reused',
          matchedFrom: { bookId: 'book-1', characterId: 'old-tom' },
        },
        {
          id: 'old-tom',
          name: 'Old Tom',
          notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
        },
      ],
    );
    expect(r.rewrites).toEqual({});
  });

  it('R7 decline control: without the decline the voiced twin still wins (#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'old-tom-2', name: 'Old Tom' }],
      [],
      [
        {
          id: 'thomas',
          name: 'Old Tom',
          voiceState: 'reused',
          matchedFrom: { bookId: 'book-1', characterId: 'old-tom' },
        },
        { id: 'old-tom', name: 'Old Tom' },
      ],
    );
    expect(r.rewrites).toEqual({ 'old-tom-2': 'thomas' });
  });

  it('R8: a same-book notLinkedTo edge blocks the tolerant join (#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'wren-ashby', name: 'Wren Ashby' }],
      [],
      [
        {
          id: 'w2',
          name: 'Wren',
          notLinkedTo: [{ bookId: 'book-2', characterId: 'wren-ashby' }],
        },
      ],
      {},
      'book-2',
    );
    expect(r.rewrites).toEqual({});
  });

  it('R9: a reserved prior id is never adopted by the tolerant join (#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'timkin-reed', name: 'Timkin Reed' }],
      [],
      [{ id: 'unknown-male', name: 'Timkin' }],
    );
    expect(r.rewrites).toEqual({});
  });

  it('R10: two trailing tokens apart never joins (#3954)', () => {
    const r = remapFreshToPriorIds(
      [{ id: 'wren-ashby-cole', name: 'Wren Ashby Cole' }],
      [],
      [{ id: 'w2', name: 'Wren' }],
    );
    expect(r.rewrites).toEqual({});
  });
});
