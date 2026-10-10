import { describe, it, expect } from 'vitest';
import { buildCatalogOptionGroups, MODEL_OPTIONS } from './models';
import type { AnalyzerCatalog, AnalyzerCatalogEntry } from './types';

const e = (id: string, engine: AnalyzerCatalogEntry['engine'], model = id): AnalyzerCatalogEntry => ({
  id, label: model, engine, model, structuredOutput: { mode: 'schema', dropped: [], label: 'schema' }, testPlan: { configured: 2, all: 3, attempts: 3 },
});

const catalog = (over: Partial<Record<'ollama' | 'gemini', 'ok' | 'fallback' | 'error'>> = {}): AnalyzerCatalog => ({
  groups: [
    { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: over.ollama ?? 'ok', models: over.ollama === 'error' ? [] : [e('qwen3.5:4b', 'local'), e('mistral:7b', 'local')] },
    { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: over.gemini ?? 'ok', models: over.gemini ? [] : [e('gemini-3.6-flash', 'gemini'), e('gemini-4.0-flash', 'gemini')] },
    { kind: 'endpoint', id: 'lab', label: 'Lab server', status: 'ok', models: [e('openai:lab::qwen3-30b', 'openai', 'qwen3-30b')] },
  ],
});

describe('buildCatalogOptionGroups (#3084)', () => {
  it('overlays curated labels and keeps live-only models', () => {
    const groups = buildCatalogOptionGroups(catalog(), { includeEndpoints: false });
    const gemini = groups.find((g) => g.kind === 'gemini')!;
    expect(gemini.models.find((m) => m.id === 'gemini-3.6-flash')?.label).toBe('Gemini 3.6 Flash');
    expect(gemini.models.find((m) => m.id === 'gemini-4.0-flash')?.label).toBe('gemini-4.0-flash');
    const local = groups.find((g) => g.kind === 'ollama')!;
    expect(local.models.map((m) => m.label)).toEqual(['Qwen3.5 4B (local)', 'mistral:7b']);
    expect(groups.some((g) => g.kind === 'endpoint')).toBe(false);
  });

  it('a fallback Gemini group (no key, or a failed listing) shows the curated Gemini list', () => {
    const curatedGemini = MODEL_OPTIONS.filter((m) => m.engine === 'gemini').map((m) => m.id);
    const gemini = buildCatalogOptionGroups(catalog({ gemini: 'fallback' }), { includeEndpoints: false }).find((g) => g.kind === 'gemini')!;
    expect(gemini.status).toBe('fallback');
    expect(gemini.models.map((m) => m.id)).toEqual(curatedGemini);
  });

  it('a failed Ollama listing stays empty (installed-only, plan 221 invariant 1)', () => {
    const local = buildCatalogOptionGroups(catalog({ ollama: 'error' }), { includeEndpoints: false }).find((g) => g.kind === 'ollama')!;
    expect(local.models).toEqual([]);
    expect(local.status).toBe('error');
  });

  it('endpoint groups carry openai options labelled by model name when requested', () => {
    const groups = buildCatalogOptionGroups(catalog(), { includeEndpoints: true });
    expect(groups.find((g) => g.id === 'lab')).toMatchObject({ kind: 'endpoint', engine: 'openai', label: 'Lab server', models: [{ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b', engine: 'openai' }] });
  });

  it('null catalog → curated Gemini, empty Ollama', () => {
    const groups = buildCatalogOptionGroups(null, { includeEndpoints: true });
    expect(groups.map((g) => g.kind)).toEqual(['gemini', 'ollama']);
    expect(groups[0].models.length).toBe(MODEL_OPTIONS.filter((m) => m.engine === 'gemini').length);
  });
});
