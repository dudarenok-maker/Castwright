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
    const WrenFoster = makeNamedChar('wren-sparrow', 'Wren Sparrow');
    const r1 = pickMergeSurvivor(wren, WrenFoster);
    expect(r1.target.id).toBe('wren-sparrow');
    expect(r1.source.id).toBe('wren');
    const r2 = pickMergeSurvivor(WrenFoster, wren);
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
