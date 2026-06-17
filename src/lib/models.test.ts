import { describe, it, expect } from 'vitest';
import {
  engineForModelId,
  buildLocalModelOptions,
  buildModelOptionGroups,
  MODEL_OPTION_GROUPS,
  MODEL_OPTIONS,
} from './models';

describe('engineForModelId', () => {
  it('classifies a tag with a colon as local', () => {
    expect(engineForModelId('qwen3.5:4b')).toBe('local');
    expect(engineForModelId('gemma-4-E4B-it-GGUF:UD-Q4_K_XL')).toBe('local');
  });
  it('classifies a colonless id as gemini', () => {
    expect(engineForModelId('gemma-4-31b-it')).toBe('gemini');
  });
});

describe('buildLocalModelOptions', () => {
  const curated = MODEL_OPTIONS.filter((m) => m.engine === 'local');
  it('keeps the curated label/hint for a matching live tag', () => {
    const opts = buildLocalModelOptions([{ name: 'qwen3.5:4b' }], curated);
    const q = opts.find((o) => o.id === 'qwen3.5:4b');
    expect(q?.label).toBe('Qwen3.5 4B (local)');
  });
  it('appends an uncurated live tag as a bare option', () => {
    /* A genuinely-uncurated tag (a custom local model not in MODEL_OPTIONS). */
    const opts = buildLocalModelOptions([{ name: 'gemma4-e4b-8gb:latest' }], curated);
    const g = opts.find((o) => o.id === 'gemma4-e4b-8gb:latest');
    expect(g).toEqual({
      id: 'gemma4-e4b-8gb:latest',
      label: 'gemma4-e4b-8gb:latest',
      engine: 'local',
    });
  });
  it('always includes curated entries even when not in the live list (offline)', () => {
    const opts = buildLocalModelOptions([], curated);
    expect(opts.some((o) => o.id === 'qwen3.5:4b')).toBe(true);
  });
  it('does not duplicate a curated tag that is also live', () => {
    const opts = buildLocalModelOptions([{ name: 'qwen3.5:4b' }], curated);
    expect(opts.filter((o) => o.id === 'qwen3.5:4b')).toHaveLength(1);
  });
});

describe('buildModelOptionGroups', () => {
  it('returns a gemini group FIRST + a local group from the supplied local options', () => {
    const groups = buildModelOptionGroups([
      { id: 'qwen3.5:4b', label: 'Qwen3.5 4B (local)', engine: 'local' },
    ]);
    expect(groups[0].engine).toBe('gemini');
    expect(groups.find((g) => g.engine === 'gemini')?.models.length).toBeGreaterThan(0);
    expect(groups.find((g) => g.engine === 'local')?.models).toHaveLength(1);
  });
});

describe('MODEL_OPTION_GROUPS (back-compat const)', () => {
  it('still exports a static groups array built from the curated locals', () => {
    expect(MODEL_OPTION_GROUPS[0].engine).toBe('gemini');
    expect(MODEL_OPTION_GROUPS.find((g) => g.engine === 'local')?.models.length).toBeGreaterThan(0);
  });
});
