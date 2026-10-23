import { describe, it, expect } from 'vitest';
import { buildAnalyzerPickerGroups, buildModelOptionGroups, MODEL_OPTIONS } from './models';
import type { AnalyzerCatalog, AnalyzerCatalogEntry } from './types';

const e = (id: string, engine: AnalyzerCatalogEntry['engine'], model = id): AnalyzerCatalogEntry => ({
  id, label: model, engine, model, structuredOutput: { mode: 'schema', dropped: [], label: 'schema' }, testPlan: { configured: 2, all: 3, attempts: 3 },
});

const catalog: AnalyzerCatalog = {
  groups: [
    { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [e('mistral:7b', 'local')] },
    { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'fallback', models: [] },
    { kind: 'endpoint', id: 'lab', label: 'Lab server', status: 'ok', models: [e('openai:lab::qwen3-30b', 'openai', 'qwen3-30b')] },
    { kind: 'endpoint', id: 'empty', label: 'Empty', status: 'error', error: 'connect ECONNREFUSED', models: [] },
  ],
};

describe('buildAnalyzerPickerGroups (#3084)', () => {
  it('Gemini first, then the installed Ollama tags, then endpoint groups with models', () => {
    const groups = buildAnalyzerPickerGroups({
      localTags: [{ name: 'qwen3.5:4b' }],
      catalog,
      endpoints: [{ id: 'lab', name: 'Lab server' }, { id: 'empty', name: 'Empty' }],
    });
    expect(groups.map((g) => g.id)).toEqual(['gemini', 'ollama', 'lab']);
    expect(groups[1].models.map((m) => m.id)).toEqual(['qwen3.5:4b']);
    expect(groups[2]).toMatchObject({ label: 'Lab server (OpenAI-compatible)', engine: 'openai' });
    expect(groups[2].models.map((m) => m.id)).toEqual(['openai:lab::qwen3-30b']);
  });

  it('without a catalog → exactly today\'s groups (curated Gemini + installed Ollama)', () => {
    const today = buildModelOptionGroups([{ id: 'qwen3.5:4b', label: 'Qwen3.5 4B (local)', engine: 'local' }]);
    const groups = buildAnalyzerPickerGroups({ localTags: [{ name: 'qwen3.5:4b' }], catalog: null, endpoints: [] });
    expect(groups.map((g) => ({ id: g.id, label: g.label, models: g.models.map((m) => m.id) }))).toEqual(
      today.map((g) => ({ id: g.id, label: g.label, models: g.models.map((m) => m.id) })),
    );
    expect(groups[0].models.length).toBe(MODEL_OPTIONS.filter((m) => m.engine === 'gemini').length);
  });

  it('every group has a distinct id (optgroup keys)', () => {
    const groups = buildAnalyzerPickerGroups({ localTags: [], catalog, endpoints: [{ id: 'lab', name: 'Lab server' }] });
    expect(new Set(groups.map((g) => g.id)).size).toBe(groups.length);
  });
});
