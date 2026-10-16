import { describe, it, expect } from 'vitest';
import { analyzerEngineOptions, endpointModelOptions } from './analyzer-engine-options';

const CATALOG = {
  groups: [
    { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [{ id: 'qwen3.5:9b', label: 'qwen3.5:9b' }] },
    { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok', models: [{ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' }] },
    { kind: 'endpoint', id: 'lab', label: 'Lab box', status: 'ok', models: [{ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b' }] },
    { kind: 'endpoint', id: 'down', label: 'Down box', status: 'error', error: 'connect ECONNREFUSED', models: [] },
  ],
} as Parameters<typeof endpointModelOptions>[0];

describe('endpointModelOptions', () => {
  it('lists only OpenAI-compatible endpoint models, labelled with the endpoint', () => {
    expect(endpointModelOptions(CATALOG)).toEqual([{ value: 'openai:lab::qwen3-30b', label: 'Lab box · qwen3-30b' }]);
  });
});

describe('analyzerEngineOptions', () => {
  const lab = [{ value: 'openai:lab::qwen3-30b', label: 'Lab box · qwen3-30b' }];

  it('puts the static entries first, then endpoint models', () => {
    expect(analyzerEngineOptions(['off', 'local', 'gemini'], lab, 'gemini').map((o) => o.value)).toEqual(['off', 'local', 'gemini', 'openai:lab::qwen3-30b']);
  });

  it('keeps a saved value the lists no longer have, flagged, so the select never shows a different choice', () => {
    const options = analyzerEngineOptions(['off', 'local', 'gemini'], [], 'openai:gone::qwen3');
    expect(options.map((o) => o.value)).toEqual(['off', 'local', 'gemini', 'openai:gone::qwen3']);
    expect(options[3].label).toBe('openai:gone::qwen3 (not in the current model list)');
  });

  it('does not duplicate a current value that is already offered', () => {
    expect(analyzerEngineOptions(['off', 'local', 'gemini'], lab, 'openai:lab::qwen3-30b')).toHaveLength(4);
  });

  it('labels static entries from the server-provided labels, and falls back to the raw value', () => {
    const labels = { off: 'Off', local: 'Local Ollama — qwen3.5:4b', gemini: 'Gemini — no API key, fallback inactive' };
    expect(analyzerEngineOptions(['off', 'local', 'gemini'], [], 'local', labels).map((o) => o.label)).toEqual(['Off', 'Local Ollama — qwen3.5:4b', 'Gemini — no API key, fallback inactive']);
    expect(analyzerEngineOptions(['local', 'gemini'], [], 'local').map((o) => o.label)).toEqual(['local', 'gemini']);
  });
});

