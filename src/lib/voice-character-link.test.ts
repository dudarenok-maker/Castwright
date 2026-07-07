/* Regression: server derives Voice.id from `character.voiceId ?? character.id`,
   and the analyzer schema never emits voiceId, so for freshly-analysed books
   Voice.id === character.id. A voiceId-only join misses every row — the cast
   table shows "No library voice" on every character and the library panel
   cards stay drag-only. The fallback in findVoiceForCharacter /
   findCharacterForVoice fixes both call sites. */

import { describe, expect, it } from 'vitest';
import {
  findVoiceForCharacter,
  findCharacterForVoice,
  pickMergeSurvivor,
} from './voice-character-link';
import type { Character, Voice } from './types';

const makeChar = (id: string, voiceId?: string): Character => ({
  id,
  name: id,
  role: 'role',
  color: id,
  voiceState: 'generated',
  voiceId,
});

const makeVoice = (id: string, character: string): Voice => ({
  id,
  character,
  bookTitle: 'the Coalfall Commission',
  bookId: 'bks',
  attributes: [],
  gradient: ['#A43C6C', '#3C194F'],
  usedIn: 1,
  source: 'current',
  ttsVoice: { provider: 'coqui', name: 'Claribel Dervla', description: '' },
});

describe('findVoiceForCharacter', () => {
  it('matches by character.id when voiceId is unset (fresh-analysis case)', () => {
    const c = makeChar('marlow');
    const library = [makeVoice('narrator', 'Narrator'), makeVoice('marlow', 'Marlow')];
    expect(findVoiceForCharacter(c, library)?.id).toBe('marlow');
  });

  it('prefers an explicit voiceId match over the character.id fallback', () => {
    const c = makeChar('marlow', 'v_pemberton');
    const library = [makeVoice('marlow', 'Marlow'), makeVoice('v_pemberton', 'Pemberton')];
    expect(findVoiceForCharacter(c, library)?.id).toBe('v_pemberton');
  });

  it('falls back to character.id when the explicit voiceId is stale (voice deleted from library)', () => {
    const c = makeChar('marlow', 'v_deleted');
    const library = [makeVoice('marlow', 'Marlow')];
    expect(findVoiceForCharacter(c, library)?.id).toBe('marlow');
  });

  it('returns undefined when no match exists either way', () => {
    const c = makeChar('marlow');
    expect(findVoiceForCharacter(c, [])).toBeUndefined();
  });

  it("with preferCurrentBook=true, prefers the current book's own voice over an unrelated book sharing the same bare id (no voiceId)", () => {
    /* Real-world collision: the analyzer assigns the SAME literal id
       ('narrator', 'unknown-male', 'unknown-female') to every book's
       narrator / auto-folded background character, and neither ever gets an
       explicit voiceId. Two unrelated books' narrators both resolve to bare
       id 'narrator' — the current book's own `source: 'current'` entry must
       win over a same-id `source: 'library'` entry from a different book,
       regardless of array order (the server can't guarantee scan order).
       Only safe for callers whose `c` is guaranteed to be the currently-
       open book's own character (cast.tsx, voice-readiness-selectors.ts). */
    const c = makeChar('narrator');
    const ownBookVoice: Voice = { ...makeVoice('narrator', 'Narrator'), source: 'current' };
    const foreignBookVoice: Voice = {
      ...makeVoice('narrator', 'Narrator'),
      source: 'library',
      bookId: 'unrelated-book',
    };
    expect(findVoiceForCharacter(c, [foreignBookVoice, ownBookVoice], true)).toBe(ownBookVoice);
    expect(findVoiceForCharacter(c, [ownBookVoice, foreignBookVoice], true)).toBe(ownBookVoice);
  });

  it('with preferCurrentBook=true, falls back to any bare-id match when no current-book voice is present', () => {
    const c = makeChar('narrator');
    const libraryVoice: Voice = {
      ...makeVoice('narrator', 'Narrator'),
      source: 'library',
      bookId: 'unrelated-book',
    };
    expect(findVoiceForCharacter(c, [libraryVoice], true)).toBe(libraryVoice);
  });

  it('defaults to unrestricted (no current-book preference) for the cross-book compare/rebaseline flows', () => {
    /* compare-cast-modal.tsx and rebaseline-modal.tsx resolve a voice for an
       arbitrary OTHER book's character (a specific comparison/rebaseline
       side, not the globally-open book) — they must NOT get the
       preferCurrentBook substitution, or they'd silently resolve the
       open book's own same-id voice instead of that side's real one. The
       default (no third arg) just matches by bare id, whichever comes
       first — same as pre-fix behavior, so these callers see no change. */
    const c = makeChar('narrator');
    const openBooksOwnVoice: Voice = { ...makeVoice('narrator', 'Narrator'), source: 'current' };
    const thisSidesRealVoice: Voice = {
      ...makeVoice('narrator', 'Narrator'),
      source: 'library',
      bookId: 'the-actual-book-being-compared',
    };
    /* thisSidesRealVoice listed first → unrestricted default returns it,
       proving the current-book entry is NOT preferred unless opted in. */
    expect(findVoiceForCharacter(c, [thisSidesRealVoice, openBooksOwnVoice])).toBe(
      thisSidesRealVoice,
    );
  });
});

describe('findCharacterForVoice', () => {
  it('matches by character.id when no character has voiceId set (fresh-analysis case)', () => {
    const v = makeVoice('marlow', 'Marlow');
    const characters = [makeChar('narrator'), makeChar('marlow')];
    expect(findCharacterForVoice(v, characters)?.id).toBe('marlow');
  });

  it('prefers an explicit voiceId match over the character.id collision', () => {
    /* Character A explicitly points at v_shared; character B's id happens
       to equal v_shared. The voiceId mapping must win — otherwise reused
       library voices would open the wrong drawer in the cast view. */
    const v = makeVoice('v_shared', 'Shared');
    const characters = [makeChar('different-char', 'v_shared'), makeChar('v_shared')];
    expect(findCharacterForVoice(v, characters)?.id).toBe('different-char');
  });

  it('returns undefined when no character claims the voice', () => {
    const v = makeVoice('v_orphan', 'Orphan');
    const characters = [makeChar('marlow')];
    expect(findCharacterForVoice(v, characters)).toBeUndefined();
  });

  it("with restrictToCurrentBook=true, never matches a foreign book's same-id voice to this book's own character (no voiceId link)", () => {
    /* Regression: the cast view's voice-library panel always passes the
       currently-open book's own roster and opts into this restriction.
       Two unrelated books' voiceId-less narrators share bare id 'narrator'
       — a foreign book's voice card must never resolve to this book's own
       narrator character just because the ids coincide. */
    const foreignNarratorVoice: Voice = {
      ...makeVoice('narrator', 'Narrator'),
      source: 'library',
      bookId: 'unrelated-book',
    };
    const characters = [makeChar('narrator')];
    expect(findCharacterForVoice(foreignNarratorVoice, characters, true)).toBeUndefined();
  });

  it("with restrictToCurrentBook=true, still matches by bare id when the voice IS this book's own (source: 'current')", () => {
    const ownNarratorVoice: Voice = { ...makeVoice('narrator', 'Narrator'), source: 'current' };
    const characters = [makeChar('narrator')];
    expect(findCharacterForVoice(ownNarratorVoice, characters, true)?.id).toBe('narrator');
  });

  it('defaults to unrestricted (matches by bare id regardless of source) for the cross-book duplicate-review flow', () => {
    /* views/voices.tsx intentionally matches a voice against an arbitrary
       OTHER book's own roster it fetched on demand — `source` there
       describes the globally-open book, not the roster being searched, so
       the default (no third arg) must NOT apply the current-book guard. */
    const otherBooksVoice: Voice = {
      ...makeVoice('narrator', 'Narrator'),
      source: 'library',
      bookId: 'some-other-book',
    };
    const thatBooksOwnCharacters = [makeChar('narrator')];
    expect(findCharacterForVoice(otherBooksVoice, thatBooksOwnCharacters)?.id).toBe('narrator');
  });
});

describe('pickMergeSurvivor', () => {
  const makeNamedChar = (id: string, name: string): Character => ({
    id,
    name,
    role: 'role',
    color: id,
    voiceState: 'generated',
  });

  it('picks the containing name as the survivor (substring rule, case-insensitive)', () => {
    const wren = makeNamedChar('wren', 'Wren');
    const wrenFoster = makeNamedChar('wren-sparrow', 'Wren Sparrow');
    const r1 = pickMergeSurvivor(wren, wrenFoster);
    expect(r1.target.id).toBe('wren-sparrow');
    expect(r1.source.id).toBe('wren');
    const r2 = pickMergeSurvivor(wrenFoster, wren);
    expect(r2.target.id).toBe('wren-sparrow');
    expect(r2.source.id).toBe('wren');
    const r3 = pickMergeSurvivor(
      makeNamedChar('a', 'WREN'),
      makeNamedChar('b', 'wren sparrow'),
    );
    expect(r3.target.id).toBe('b');
  });

  it('falls back to longer trimmed name when neither name contains the other', () => {
    const a = makeNamedChar('a', 'Marlow');
    const b = makeNamedChar('b', 'Edda Redek');
    const r = pickMergeSurvivor(a, b);
    expect(r.target.id).toBe('b');
    expect(r.source.id).toBe('a');
  });

  it('keeps the first-selected character as survivor on a length tie (stable tiebreaker)', () => {
    const a = makeNamedChar('a', 'Wren');
    const b = makeNamedChar('b', 'Maelor');
    /* a2/b2 are the same trimmed length (6 vs 6) → a real tie */
    const a2 = makeNamedChar('a2', 'Castor');
    const b2 = makeNamedChar('b2', 'Maelor');
    const r = pickMergeSurvivor(a2, b2);
    expect(r.target.id).toBe('a2');
    expect(r.source.id).toBe('b2');
    /* Sanity: different lengths still resolve to the longer one */
    const r2 = pickMergeSurvivor(a, b);
    expect(r2.target.id).toBe('b');
  });
});
