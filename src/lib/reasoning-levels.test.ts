import { describe, it, expect } from 'vitest';
import styleLevels from '../../server/src/analyzer/__fixtures__/reasoning-style-levels.json';
import tagCases from '../../server/src/analyzer/__fixtures__/ollama-tag-cases.json';
import {
  collectCatalogModels,
  levelsForEndpointStyle,
  normalizeOllamaReasoningMap,
  normalizeOllamaTag,
  ollamaReasoningRows,
  REASONING_LEVEL_LABELS,
  type ReasoningLevel,
  type ReasoningStyle,
} from './reasoning-levels';
import type { AnalyzerCatalog } from './types';

describe('levelsForEndpointStyle', () => {
  it.each(Object.entries(styleLevels))('%s matches the server table', (style, levels) => {
    expect([...levelsForEndpointStyle(style as ReasoningStyle)]).toEqual(levels);
  });
  it('labels every level', () => {
    expect(Object.keys(REASONING_LEVEL_LABELS).sort()).toEqual(['high', 'low', 'medium', 'minimal', 'model-default', 'none', 'off', 'on']);
  });
});

describe('collectCatalogModels', () => {
  it('reads every catalog entry that carries offered levels, in group order, and skips entries and groups without them', () => {
    const body = {
      groups: [
        { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [{ id: 'q:4b', label: 'Qwen 4B', offeredReasoningLevels: ['model-default', 'off', 'on'] }] },
        { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok', models: [{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', offeredReasoningLevels: ['model-default', 'minimal'] }, { id: 'no-levels', label: 'no-levels' }] },
        { kind: 'endpoint', id: 'down', label: 'Down', status: 'error', error: 'connect ECONNREFUSED', models: [] },
      ],
    } as unknown as AnalyzerCatalog;
    expect(collectCatalogModels(null)).toEqual([]);
    expect(collectCatalogModels(body)).toEqual([
      { id: 'q:4b', label: 'Qwen 4B', kind: 'ollama', offeredReasoningLevels: ['model-default', 'off', 'on'] },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', kind: 'gemini', offeredReasoningLevels: ['model-default', 'minimal'] },
    ]);
  });
});

describe('ollamaReasoningRows (P18)', () => {
  const models = [
    { id: 'q:4b', label: 'Qwen 4B', kind: 'ollama' as const, offeredReasoningLevels: ['model-default', 'off', 'on', 'low'] as ReasoningLevel[] },
    { id: 'q:9b', label: 'Qwen 9B', kind: 'ollama' as const, offeredReasoningLevels: ['model-default', 'off', 'on'] as ReasoningLevel[] },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', kind: 'gemini' as const, offeredReasoningLevels: ['model-default', 'minimal'] as ReasoningLevel[] },
  ];
  it('current model first, each model its own levels, and a saved model the catalog no longer lists keeps a row', () => {
    expect(ollamaReasoningRows(models, 'q:9b', { 'old:1b': 'on' })).toEqual([
      { id: 'q:9b', label: 'Qwen 9B', levels: ['model-default', 'off', 'on'], isCurrent: true },
      { id: 'q:4b', label: 'Qwen 4B', levels: ['model-default', 'off', 'on', 'low'], isCurrent: false },
      { id: 'old:1b', label: 'old:1b', levels: ['model-default', 'off', 'on'], isCurrent: false },
    ]);
  });
  it('a saved level stays visible on its own row even when that model no longer offers it', () => {
    expect(ollamaReasoningRows(models, undefined, { 'q:9b': 'low' }).find((r) => r.id === 'q:9b')?.levels).toEqual(['model-default', 'off', 'on', 'low']);
  });
  it('one row per Ollama model id: a catalog qwen3:latest, a saved qwen3 and a current qwen3:latest share one row (N7)', () => {
    const catalog = [
      { id: 'qwen3:latest', label: 'qwen3:latest', kind: 'ollama' as const, offeredReasoningLevels: ['model-default', 'off', 'on', 'low'] as ReasoningLevel[] },
    ];
    expect(ollamaReasoningRows(catalog, 'qwen3:latest', { qwen3: 'low' })).toEqual([
      { id: 'qwen3', label: 'qwen3:latest', levels: ['model-default', 'off', 'on', 'low'], isCurrent: true },
    ]);
  });
  it('a saved value this version does not know stays visible after the known levels (N10)', () => {
    expect(ollamaReasoningRows([], undefined, { 'q:4b': 'xhigh' })[0].levels).toEqual(['model-default', 'off', 'on', 'xhigh']);
  });
});

describe('Ollama tag identity (N7)', () => {
  it.each(tagCases)('normalizeOllamaTag: $tag → $normalized, as the server normaliser does', ({ tag, normalized }) => {
    expect(normalizeOllamaTag(tag)).toBe(normalized);
  });
  it('normalizeOllamaReasoningMap folds a :latest key into its bare tag, the bare key winning', () => {
    expect(normalizeOllamaReasoningMap({ 'qwen3:latest': 'on', qwen3: 'low', 'q:4b': 'off' })).toEqual({ qwen3: 'low', 'q:4b': 'off' });
    expect(normalizeOllamaReasoningMap(undefined)).toEqual({});
  });
});
