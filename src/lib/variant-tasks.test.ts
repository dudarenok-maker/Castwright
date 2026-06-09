import { describe, it, expect } from 'vitest';
import { buildVariantTasks, variantWorkCounts } from './variant-tasks';
import type { Character } from './types';

const qwen = (id: string, variants: Record<string, { name: string }> = {}, name = 'qwen-' + id) =>
  ({ id, name: id, ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name, variants } } }) as unknown as Character;

describe('buildVariantTasks', () => {
  it('emits only in-use emotions that lack a designed variant, base present', () => {
    const chars = [qwen('sophie', { angry: { name: 'x' } })];
    const used = new Map([['sophie', new Set(['angry', 'excited'])]]);
    expect(buildVariantTasks(chars, used)).toEqual([{ characterId: 'sophie', emotions: ['excited'] }]);
  });
  it('excludes a character with no base voice (needs base first)', () => {
    const fitz = { id: 'fitz', name: 'fitz', ttsEngine: 'qwen' } as unknown as Character;
    const used = new Map([['fitz', new Set(['angry'])]]);
    expect(buildVariantTasks([fitz], used)).toEqual([]);
  });
  it('excludes characters with no in-use emotions', () => {
    const used = new Map<string, Set<string>>();
    expect(buildVariantTasks([qwen('ed')], used)).toEqual([]);
  });
});

describe('variantWorkCounts', () => {
  it('counts total missing variants across the cast', () => {
    const chars = [qwen('sophie', { angry: { name: 'x' } }), qwen('keefe')];
    const used = new Map([
      ['sophie', new Set(['angry', 'excited'])],
      ['keefe', new Set(['whisper', 'sad'])],
    ]);
    expect(variantWorkCounts(chars, used)).toBe(3);
  });
});
