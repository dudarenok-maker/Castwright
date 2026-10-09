import { describe, it, expect } from 'vitest';
import { modelLabel, catalogEntryFor, runLabelSuffixes } from './model-label';
import type { AnalyzerCatalog } from './types';

const catalog: AnalyzerCatalog = {
  groups: [
    {
      kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok',
      models: [{ id: 'gemini-4.0-flash', label: 'Gemini 4.0 Flash', engine: 'gemini', model: 'gemini-4.0-flash', structuredOutput: { mode: 'json', dropped: [], label: 'json' }, testPlan: { configured: 2, all: 3, attempts: 3 } }],
    },
    {
      kind: 'endpoint', id: 'lab', label: 'Lab server', status: 'ok',
      models: [{ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b', engine: 'openai', model: 'qwen3-30b', structuredOutput: { mode: 'schema', dropped: ['$schema'], label: 'schema (not enforced)' }, testPlan: { configured: 2, all: 3, attempts: 3 } }],
    },
  ],
};

describe('modelLabel (#3084)', () => {
  it('curated label first', () => {
    expect(modelLabel('qwen3.5:4b', catalog)).toBe('Qwen3.5 4B (local)');
  });
  it('the catalog entry label (live displayName) for an uncurated model', () => {
    expect(modelLabel('gemini-4.0-flash', catalog)).toBe('Gemini 4.0 Flash');
  });
  it('endpoint name · model for an endpoint id', () => {
    expect(modelLabel('openai:lab::qwen3-30b', catalog)).toBe('Lab server · qwen3-30b');
  });
  it('endpoint id · model when no catalog is loaded', () => {
    expect(modelLabel('openai:lab::qwen3-30b')).toBe('lab · qwen3-30b');
  });
  it('raw id otherwise (including an Ollama tag named openai:latest)', () => {
    expect(modelLabel('mistral:7b', catalog)).toBe('mistral:7b');
    expect(modelLabel('openai:latest', catalog)).toBe('openai:latest');
  });
  it('catalogEntryFor + runLabelSuffixes expose the structured-output label (W5 appends custom params)', () => {
    expect(runLabelSuffixes(catalogEntryFor('openai:lab::qwen3-30b', catalog))).toEqual(['schema (not enforced)']);
    expect(runLabelSuffixes(catalogEntryFor('unknown', catalog))).toEqual([]);
  });
});
