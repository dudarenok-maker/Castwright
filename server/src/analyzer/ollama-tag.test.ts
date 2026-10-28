import { describe, it, expect } from 'vitest';
import cases from './__fixtures__/ollama-tag-cases.json' with { type: 'json' };
import { entryForModelTag, normalizeModelTag } from './ollama-tag.js';
import { normalizeModelTag as reExported } from './ollama-settings.js';

describe('normalizeModelTag — moved to a leaf, body unchanged (#3084 wave 5, N7)', () => {
  it.each(cases)('$tag → $normalized', ({ tag, normalized }) => {
    expect(normalizeModelTag(tag)).toBe(normalized);
  });
  it('ollama-settings re-exports the same function, so keep-alive and ollama.ts are unchanged', () => {
    expect(reExported).toBe(normalizeModelTag);
  });
});

describe('entryForModelTag — one Ollama model id per map (N7)', () => {
  it('finds an entry saved under either tag form, preferring the normalised key', () => {
    expect(entryForModelTag({ qwen3: 'a' }, 'qwen3:latest')).toBe('a');
    expect(entryForModelTag({ 'qwen3:latest': 'b' }, 'qwen3')).toBe('b');
    expect(entryForModelTag({ qwen3: 'a', 'qwen3:latest': 'b' }, 'qwen3:latest')).toBe('a');
    expect(entryForModelTag({ 'qwen3.5:4b': 'c' }, 'qwen3.5:9b')).toBeUndefined();
    expect(entryForModelTag(undefined, 'qwen3')).toBeUndefined();
  });
});
