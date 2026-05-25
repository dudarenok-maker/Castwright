import { describe, it, expect } from 'vitest';
import { mergeSeriesCast } from './merge-series-cast';
import type { Character } from './types';

const char = (over: Partial<Character> & { id: string }): Character =>
  ({ name: over.id, role: 'role', color: 'narrator', lines: 0, ...over }) as Character;

describe('mergeSeriesCast', () => {
  it('returns the anchor unchanged when there are no siblings', () => {
    const anchor = [char({ id: 'a', voiceId: 'v_a', lines: 10 })];
    const out = mergeSeriesCast(anchor, []);
    expect(out).toHaveLength(1);
    expect(out[0].lines).toBe(10);
    /* fresh copy, not the same reference */
    expect(out[0]).not.toBe(anchor[0]);
  });

  it('dedupes by voiceId across books and sums line counts series-wide', () => {
    const anchor = [char({ id: 'Wren-b1', voiceId: 'v_Wren', lines: 120 })];
    const siblings = [
      char({ id: 'Wren-b2', voiceId: 'v_Wren', lines: 80 }),
      char({ id: 'Wren-b3', voiceId: 'v_Wren', lines: 30 }),
    ];
    const out = mergeSeriesCast(anchor, siblings);
    expect(out).toHaveLength(1);
    /* anchor identity (its id) is kept */
    expect(out[0].id).toBe('Wren-b1');
    /* 120 + 80 + 30 */
    expect(out[0].lines).toBe(230);
  });

  it('adds a sibling-only character (introduced in a later volume)', () => {
    const anchor = [char({ id: 'a', voiceId: 'v_a', lines: 50 })];
    const siblings = [char({ id: 'newcomer', voiceId: 'v_new', lines: 200 })];
    const out = mergeSeriesCast(anchor, siblings);
    expect(out.map((c) => c.id).sort()).toEqual(['a', 'newcomer']);
    expect(out.find((c) => c.id === 'newcomer')?.lines).toBe(200);
  });

  it('falls back to id as the key when a character has no voiceId', () => {
    /* No voiceId → keyed by id, so two same-named but unlinked entries stay
       separate (honest: one approve only writes the book sharing that key). */
    const anchor = [char({ id: 'ghost-b1', lines: 5 })];
    const siblings = [char({ id: 'ghost-b2', lines: 7 })];
    const out = mergeSeriesCast(anchor, siblings);
    expect(out).toHaveLength(2);
  });

  it('aggregates sibling-only duplicates among themselves', () => {
    const siblings = [
      char({ id: 'k-b2', voiceId: 'v_Marlow', lines: 90 }),
      char({ id: 'k-b3', voiceId: 'v_Marlow', lines: 60 }),
    ];
    const out = mergeSeriesCast([], siblings);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('k-b2'); // first sibling wins identity
    expect(out[0].lines).toBe(150);
  });

  it("carries a sibling's approved Qwen voice + persona onto the representative", () => {
    const anchor = [char({ id: 'Marlow-b1', voiceId: 'v_Marlow', lines: 40 })];
    const siblings = [
      char({
        id: 'Marlow-b2',
        voiceId: 'v_Marlow',
        lines: 90,
        ttsEngine: 'qwen',
        voiceStyle: 'sardonic charmer',
        overrideTtsVoices: { qwen: { name: 'Marlow-designed' } },
      }),
    ];
    const out = mergeSeriesCast(anchor, siblings);
    expect(out).toHaveLength(1);
    const rep = out[0];
    expect(rep.id).toBe('Marlow-b1'); // anchor identity kept
    expect(rep.lines).toBe(130);
    expect(rep.overrideTtsVoices?.qwen?.name).toBe('Marlow-designed');
    expect(rep.ttsEngine).toBe('qwen');
    expect(rep.voiceStyle).toBe('sardonic charmer');
  });

  it("does not overwrite the anchor's own Qwen voice with a sibling's", () => {
    const anchor = [
      char({
        id: 'a',
        voiceId: 'v_a',
        lines: 10,
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'anchor-voice' } },
      }),
    ];
    const siblings = [
      char({ id: 'a-b2', voiceId: 'v_a', lines: 5, overrideTtsVoices: { qwen: { name: 'sib-voice' } } }),
    ];
    const out = mergeSeriesCast(anchor, siblings);
    expect(out[0].overrideTtsVoices?.qwen?.name).toBe('anchor-voice');
  });

  it('does not mutate the input characters', () => {
    const anchor = [char({ id: 'a', voiceId: 'v_a', lines: 10 })];
    const siblings = [char({ id: 'a-b2', voiceId: 'v_a', lines: 5 })];
    mergeSeriesCast(anchor, siblings);
    expect(anchor[0].lines).toBe(10); // unchanged
  });
});
