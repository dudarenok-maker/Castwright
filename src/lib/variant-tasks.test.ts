import { describe, it, expect } from 'vitest';
import { buildVariantTasks, variantWorkCounts } from './variant-tasks';
import type { Character } from './types';

const qwen = (id: string, variants: Record<string, { name: string }> = {}, name = 'qwen-' + id) =>
  ({ id, name: id, ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name, variants } } }) as unknown as Character;

describe('buildVariantTasks', () => {
  it('emits only in-use emotions that lack a designed variant, base present', () => {
    const chars = [qwen('Wren', { angry: { name: 'x' } })];
    const used = new Map([['Wren', new Set(['angry', 'excited'])]]);
    expect(buildVariantTasks(chars, used)).toEqual([{ characterId: 'Wren', emotions: ['excited'] }]);
  });
  it('excludes a character with no base voice (needs base first)', () => {
    const Brann = { id: 'Brann', name: 'Brann', ttsEngine: 'qwen' } as unknown as Character;
    const used = new Map([['Brann', new Set(['angry'])]]);
    expect(buildVariantTasks([Brann], used)).toEqual([]);
  });
  it('excludes characters with no in-use emotions', () => {
    const used = new Map<string, Set<string>>();
    expect(buildVariantTasks([qwen('ed')], used)).toEqual([]);
  });
});

describe('variantWorkCounts', () => {
  it('counts total missing variants across the cast', () => {
    const chars = [qwen('Wren', { angry: { name: 'x' } }), qwen('Marlow')];
    const used = new Map([
      ['Wren', new Set(['angry', 'excited'])],
      ['Marlow', new Set(['whisper', 'sad'])],
    ]);
    expect(variantWorkCounts(chars, used)).toBe(3);
  });
});
