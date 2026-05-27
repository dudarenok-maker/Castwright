/* resolveVoiceStatus — the two-dimension Status resolver shared by the cast
   view's Status column and the profile drawer's Voice-profile header. Locks
   the split that lets a reused Qwen voice read "Designed/Generated · Reused"
   instead of collapsing to a lone "Reused" pill. */

import { describe, it, expect } from 'vitest';
import { resolveVoiceStatus } from './voice-status';
import type { Character, Voice } from './types';

function char(partial: Partial<Character>): Character {
  return {
    id: 'c1',
    name: 'Char',
    role: 'role',
    color: 'narrator',
    lines: 1,
    scenes: 1,
    attributes: [],
    ...partial,
  } as Character;
}

function voice(partial: Partial<Voice>): Voice {
  return {
    id: 'v1',
    character: 'Char',
    bookTitle: 'Book',
    bookId: 'b1',
    attributes: [],
    gradient: ['#000', '#fff'],
    usedIn: 1,
    source: 'library',
    ttsVoice: { provider: 'coqui', name: 'Aaron Dreschner', description: 'Mid' },
    ...partial,
  } as Voice;
}

const matchedFrom = {
  bookTitle: 'Prior Book',
  bookId: 'b0',
  characterId: 'c0',
  confidence: 0.9,
};

describe('resolveVoiceStatus — lifecycle pill', () => {
  it('maps preset voiceState values to their lifecycle pills', () => {
    expect(resolveVoiceStatus(char({ voiceState: 'generated' }), undefined).lifecycle).toEqual({
      label: 'Matched',
      color: 'success',
    });
    expect(resolveVoiceStatus(char({ voiceState: 'tuned' }), undefined).lifecycle).toEqual({
      label: 'Tuned',
      color: 'warning',
    });
    expect(resolveVoiceStatus(char({ voiceState: 'locked' }), undefined).lifecycle).toEqual({
      label: 'Locked',
      color: 'neutral',
    });
  });

  it('treats a reused preset voiceState as "Matched" (provenance moves to the badge)', () => {
    expect(resolveVoiceStatus(char({ voiceState: 'reused' }), undefined).lifecycle).toEqual({
      label: 'Matched',
      color: 'success',
    });
  });

  it('returns null lifecycle for a stateless row', () => {
    expect(resolveVoiceStatus(char({}), undefined).lifecycle).toBeNull();
  });

  describe('Qwen lifecycle', () => {
    it('reads "Needs voice" for a Qwen-pinned character with no designed voice', () => {
      const c = char({ ttsEngine: 'qwen' });
      expect(resolveVoiceStatus(c, undefined).lifecycle).toEqual({
        label: 'Needs voice',
        color: 'warning',
      });
    });

    it('reads "Designed" for a designed Qwen voice that has not rendered audio', () => {
      const c = char({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-x' } } });
      expect(resolveVoiceStatus(c, voice({ generated: false })).lifecycle).toEqual({
        label: 'Designed',
        color: 'library',
      });
    });

    it('reads "Generated" once the matched voice is flagged generated', () => {
      const c = char({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-x' } } });
      expect(resolveVoiceStatus(c, voice({ generated: true })).lifecycle).toEqual({
        label: 'Generated',
        color: 'success',
      });
    });

    it('treats a REUSED voice whose matched Voice is Qwen as a Qwen lifecycle, even when the character is not pinned to Qwen', () => {
      /* The drawer/table divergence the split fixes: the reuse path leaves
         the character's own ttsEngine/override empty and carries the Qwen
         voice on the matched Voice. */
      const c = char({ voiceState: 'reused', matchedFrom });
      const v = voice({
        generated: true,
        ttsVoice: { provider: 'qwen', name: 'qwen-narrator', description: 'Designed voice' },
      });
      expect(resolveVoiceStatus(c, v).lifecycle).toEqual({ label: 'Generated', color: 'success' });
    });
  });
});

describe('resolveVoiceStatus — Reused badge (provenance)', () => {
  it('is true whenever matchedFrom is set', () => {
    expect(resolveVoiceStatus(char({ matchedFrom }), undefined).reused).toBe(true);
  });

  it('survives a later tune/lock (keyed off matchedFrom, not voiceState)', () => {
    expect(resolveVoiceStatus(char({ voiceState: 'tuned', matchedFrom }), undefined).reused).toBe(
      true,
    );
    expect(resolveVoiceStatus(char({ voiceState: 'locked', matchedFrom }), undefined).reused).toBe(
      true,
    );
  });

  it('is false for a character with no match provenance', () => {
    expect(resolveVoiceStatus(char({ voiceState: 'generated' }), undefined).reused).toBe(false);
  });

  it('coexists with the lifecycle pill — a reused Qwen voice yields both', () => {
    const c = char({ voiceState: 'reused', matchedFrom });
    const v = voice({
      generated: true,
      ttsVoice: { provider: 'qwen', name: 'qwen-narrator', description: 'Designed voice' },
    });
    const status = resolveVoiceStatus(c, v);
    expect(status.lifecycle).toEqual({ label: 'Generated', color: 'success' });
    expect(status.reused).toBe(true);
  });
});
