/* Regression: server derives Voice.id from `character.voiceId ?? character.id`,
   and the analyzer schema never emits voiceId, so for freshly-analysed books
   Voice.id === character.id. A voiceId-only join misses every row — the cast
   table shows "No library voice" on every character and the library panel
   cards stay drag-only. The fallback in findVoiceForCharacter /
   findCharacterForVoice fixes both call sites. */

import { describe, expect, it } from 'vitest';
import { findVoiceForCharacter, findCharacterForVoice } from './voice-character-link';
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
    const c = makeChar('Marlow');
    const library = [makeVoice('narrator', 'Narrator'), makeVoice('Marlow', 'Marlow')];
    expect(findVoiceForCharacter(c, library)?.id).toBe('Marlow');
  });

  it('prefers an explicit voiceId match over the character.id fallback', () => {
    const c = makeChar('Marlow', 'v_pemberton');
    const library = [makeVoice('Marlow', 'Marlow'), makeVoice('v_pemberton', 'Pemberton')];
    expect(findVoiceForCharacter(c, library)?.id).toBe('v_pemberton');
  });

  it('falls back to character.id when the explicit voiceId is stale (voice deleted from library)', () => {
    const c = makeChar('Marlow', 'v_deleted');
    const library = [makeVoice('Marlow', 'Marlow')];
    expect(findVoiceForCharacter(c, library)?.id).toBe('Marlow');
  });

  it('returns undefined when no match exists either way', () => {
    const c = makeChar('Marlow');
    expect(findVoiceForCharacter(c, [])).toBeUndefined();
  });
});

describe('findCharacterForVoice', () => {
  it('matches by character.id when no character has voiceId set (fresh-analysis case)', () => {
    const v = makeVoice('Marlow', 'Marlow');
    const characters = [makeChar('narrator'), makeChar('Marlow')];
    expect(findCharacterForVoice(v, characters)?.id).toBe('Marlow');
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
    const characters = [makeChar('Marlow')];
    expect(findCharacterForVoice(v, characters)).toBeUndefined();
  });
});
