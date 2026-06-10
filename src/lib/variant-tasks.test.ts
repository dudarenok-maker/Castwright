import { describe, it, expect } from 'vitest';
import { buildVariantTasks, variantWorkCounts } from './variant-tasks';
import type { Character } from './types';

/* A Qwen character with a designed base voice (and optional designed variants). */
const based = (id: string, variants: Record<string, { name: string }> = {}) =>
  ({ id, name: id, ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-' + id, variants } } }) as unknown as Character;

/* A Qwen-effective character with NO designed base voice yet. */
const baseless = (id: string) => ({ id, name: id, ttsEngine: 'qwen' }) as unknown as Character;

const isQwen = (c: Character) => c.ttsEngine === 'qwen';

describe('buildVariantTasks', () => {
  it('emits only in-use emotions that lack a designed variant, flagging an existing base', () => {
    const chars = [based('Wren', { angry: { name: 'x' } })];
    const used = new Map([['Wren', new Set(['angry', 'excited'])]]);
    expect(buildVariantTasks(chars, used, isQwen)).toEqual([
      { characterId: 'Wren', emotions: ['excited'], hasBase: true },
    ]);
  });

  it('INCLUDES a character with no base voice yet, flagged hasBase=false', () => {
    // The bulk "Both" run designs the base first, so the variant is still
    // counted as demand — hasBase records that it is not actionable alone.
    const used = new Map([['Brann', new Set(['angry'])]]);
    expect(buildVariantTasks([baseless('Brann')], used, isQwen)).toEqual([
      { characterId: 'Brann', emotions: ['angry'], hasBase: false },
    ]);
  });

  it('excludes characters the isQwen predicate rejects (non-Qwen-effective)', () => {
    const kokoro = { id: 'gandalf', name: 'gandalf', ttsEngine: 'kokoro' } as unknown as Character;
    const used = new Map([['gandalf', new Set(['angry'])]]);
    expect(buildVariantTasks([kokoro], used, isQwen)).toEqual([]);
  });

  it('excludes characters with no in-use emotions', () => {
    expect(buildVariantTasks([based('ed')], new Map(), isQwen)).toEqual([]);
  });
});

describe('variantWorkCounts', () => {
  it('splits total demand into ready (has base) vs blocked (needs a base first)', () => {
    const tasks = buildVariantTasks(
      [based('Wren', { angry: { name: 'x' } }), baseless('Marlow')],
      new Map([
        ['Wren', new Set(['angry', 'excited'])], // 1 ready (excited; angry designed)
        ['Marlow', new Set(['whisper', 'sad'])], // 2 blocked (no base)
      ]),
      isQwen,
    );
    expect(variantWorkCounts(tasks)).toEqual({
      totalTasks: 3,
      readyTasks: 1,
      blockedTasks: 2,
      blockedChars: 1,
    });
  });

  it('is all-ready when every emotion character already has a base', () => {
    const tasks = buildVariantTasks(
      [based('a'), based('b')],
      new Map([
        ['a', new Set(['angry'])],
        ['b', new Set(['sad', 'excited'])],
      ]),
      isQwen,
    );
    expect(variantWorkCounts(tasks)).toEqual({
      totalTasks: 3,
      readyTasks: 3,
      blockedTasks: 0,
      blockedChars: 0,
    });
  });
});
