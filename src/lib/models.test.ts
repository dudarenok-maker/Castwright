import { describe, it, expect } from 'vitest';
import {
  engineForModelId,
  buildLocalModelOptions,
  buildModelOptionGroups,
  localRunModelIds,
  isOllamaModelResident,
  runModelsAllResident,
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
  it('is installed-only: omits curated entries that are not in the live list', () => {
    /* Offline / nothing pulled → empty local list (the Gemini group keeps the
       picker non-blank). Reversal of the old curated-always union (plan 221
       invariant 1) so the dropdown only lists runnable models. */
    expect(buildLocalModelOptions([], curated)).toEqual([]);
    /* Only the installed curated tag shows; the other curated locals are omitted. */
    const opts = buildLocalModelOptions([{ name: 'qwen3.5:4b' }], curated);
    expect(opts.map((o) => o.id)).toEqual(['qwen3.5:4b']);
  });
  it('does not duplicate a curated tag that is also live', () => {
    const opts = buildLocalModelOptions([{ name: 'qwen3.5:4b' }, { name: 'qwen3.5:4b' }], curated);
    expect(opts.filter((o) => o.id === 'qwen3.5:4b')).toHaveLength(1);
  });
});

describe('run-model residency helpers (analysing-view warm targets)', () => {
  it('localRunModelIds keeps only the local (colon-tagged) ids', () => {
    expect(localRunModelIds(['gemma4-e4b-8gb:latest', 'gemini-3.1-flash-lite'])).toEqual([
      'gemma4-e4b-8gb:latest',
    ]);
  });
  it('isOllamaModelResident matches exact tag and tolerates bare ⇄ :latest', () => {
    expect(isOllamaModelResident('gemma4-e4b-8gb:latest', ['gemma4-e4b-8gb:latest'])).toBe(true);
    expect(isOllamaModelResident('gemma4-e4b-8gb', ['gemma4-e4b-8gb:latest'])).toBe(true);
    expect(isOllamaModelResident('qwen3.5:4b', ['gemma4-e4b-8gb:latest'])).toBe(false);
  });
  it('runModelsAllResident keys off the RUN model, not the configured default', () => {
    /* Run executes on gemma; only gemma is resident (qwen default is NOT). The
       analysing view must read this as ready/warm — the #3/#4 fix. */
    expect(runModelsAllResident(['gemma4-e4b-8gb:latest'], ['gemma4-e4b-8gb:latest'])).toBe(true);
    /* Default qwen resident but the run is gemma → NOT ready (don't false-green). */
    expect(runModelsAllResident(['gemma4-e4b-8gb:latest'], ['qwen3.5:4b'])).toBe(false);
    /* Pure-cloud run → no local models → false here (engine check makes it ready). */
    expect(runModelsAllResident(['gemini-3.1-flash-lite'], [])).toBe(false);
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
