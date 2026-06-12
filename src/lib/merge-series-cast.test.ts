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
    const anchor = [char({ id: 'wren-b1', voiceId: 'v_wren', lines: 120 })];
    const siblings = [
      char({ id: 'wren-b2', voiceId: 'v_wren', lines: 80 }),
      char({ id: 'wren-b3', voiceId: 'v_wren', lines: 30 }),
    ];
    const out = mergeSeriesCast(anchor, siblings);
    expect(out).toHaveLength(1);
    /* anchor identity (its id) is kept */
    expect(out[0].id).toBe('wren-b1');
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
      char({ id: 'k-b2', voiceId: 'v_marlow', lines: 90 }),
      char({ id: 'k-b3', voiceId: 'v_marlow', lines: 60 }),
    ];
    const out = mergeSeriesCast([], siblings);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('k-b2'); // first sibling wins identity
    expect(out[0].lines).toBe(150);
  });

  it("carries a sibling's approved Qwen voice + persona onto the representative", () => {
    const anchor = [char({ id: 'marlow-b1', voiceId: 'v_marlow', lines: 40 })];
    const siblings = [
      char({
        id: 'marlow-b2',
        voiceId: 'v_marlow',
        lines: 90,
        ttsEngine: 'qwen',
        voiceStyle: 'sardonic charmer',
        overrideTtsVoices: { qwen: { name: 'marlow-designed' } },
      }),
    ];
    const out = mergeSeriesCast(anchor, siblings);
    expect(out).toHaveLength(1);
    const rep = out[0];
    expect(rep.id).toBe('marlow-b1'); // anchor identity kept
    expect(rep.lines).toBe(130);
    expect(rep.overrideTtsVoices?.qwen?.name).toBe('marlow-designed');
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

  /* ── plan 122: collapse by name/alias when voiceId ?? id diverges ── */

  it('collapses divergent ids that share a name/alias (no shared voiceId)', () => {
    /* "Wren" (b1) ↔ "Wren Sparrow" (b2): different ids, no voiceId, bridged
       by the alias "Wren Sparrow" on the anchor. */
    const anchor = [
      char({ id: 'wren', name: 'Wren', aliases: ['Wren Sparrow'], lines: 1625 }),
    ];
    const siblings = [
      char({ id: 'wren-sparrow', name: 'Wren Sparrow', sourceBookId: 'b2', lines: 1678 }),
    ];
    const out = mergeSeriesCast(anchor, siblings, 'b1');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('wren'); // anchor identity wins
    expect(out[0].lines).toBe(3303);
  });

  it('collapses a strict-substring name pair with no alias bridge', () => {
    const anchor = [char({ id: 'wren', name: 'Wren', lines: 10 })];
    const siblings = [char({ id: 'wren-sparrow', name: 'Wren Sparrow', sourceBookId: 'b2', lines: 5 })];
    const out = mergeSeriesCast(anchor, siblings, 'b1');
    expect(out).toHaveLength(1);
    expect(out[0].lines).toBe(15);
  });

  it('collapses punctuation/case id variants (Bronte ≡ bron-te)', () => {
    const anchor = [char({ id: 'bronte', name: 'Bronte', lines: 29 })];
    const siblings = [char({ id: 'bron-te', name: 'Bron-te', sourceBookId: 'b2', lines: 33 })];
    const out = mergeSeriesCast(anchor, siblings, 'b1');
    expect(out).toHaveLength(1);
    expect(out[0].lines).toBe(62);
  });

  it('does NOT collapse a notLinkedTo pair (divergent keys, name would otherwise match)', () => {
    /* Different ids + no shared voiceId, so only the name/alias pass could
       merge them — and notLinkedTo blocks it. (A shared write key is a
       different story: same propagation target, collapses regardless.) */
    const anchor = [
      char({
        id: 'wren',
        name: 'Wren',
        lines: 10,
        notLinkedTo: [{ bookId: 'b2', characterId: 'wren-sparrow' }],
      }),
    ];
    const siblings = [char({ id: 'wren-sparrow', name: 'Wren Sparrow', sourceBookId: 'b2', lines: 5 })];
    const out = mergeSeriesCast(anchor, siblings, 'b1');
    expect(out).toHaveLength(2);
  });

  it('does NOT collapse unrelated names with no shared token (aldan vs alden)', () => {
    const anchor = [char({ id: 'aldan', name: 'Aldan', lines: 10 })];
    const siblings = [char({ id: 'alden', name: 'Alden', sourceBookId: 'b2', lines: 5 })];
    const out = mergeSeriesCast(anchor, siblings, 'b1');
    expect(out).toHaveLength(2);
  });

  it('carries a sibling Qwen voice across a name/alias collapse (no shared voiceId)', () => {
    const anchor = [char({ id: 'wren', name: 'Wren', lines: 10 })];
    const siblings = [
      char({
        id: 'wren-sparrow',
        name: 'Wren Sparrow',
        sourceBookId: 'b2',
        lines: 5,
        ttsEngine: 'qwen',
        voiceStyle: 'curious teleporter',
        overrideTtsVoices: { qwen: { name: 'wren-designed' } },
      }),
    ];
    const out = mergeSeriesCast(anchor, siblings, 'b1');
    expect(out).toHaveLength(1);
    expect(out[0].overrideTtsVoices?.qwen?.name).toBe('wren-designed');
    expect(out[0].ttsEngine).toBe('qwen');
    expect(out[0].voiceStyle).toBe('curious teleporter');
  });

  it('never collapses a fold bucket into a real character', () => {
    /* unknown-male named after a folded char must not merge with the real one. */
    const anchor = [char({ id: 'unknown-male', name: 'Lord Vane', lines: 35 })];
    const siblings = [char({ id: 'lord-vane', name: 'Lord Vane', sourceBookId: 'b2', lines: 262 })];
    const out = mergeSeriesCast(anchor, siblings, 'b1');
    expect(out).toHaveLength(2);
  });
});
