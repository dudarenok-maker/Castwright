import { describe, it, expect } from 'vitest';
import { engineLabel, engineFallbackMsPerChar } from './analysis.js';

describe('engineLabel (#3084 PR 3a)', () => {
  it('labels an endpoint id by endpoint and model, never as Ollama', () => {
    expect(engineLabel('openai', 'openai:lab::qwen3:30b')).toBe('Endpoint lab (qwen3:30b)');
  });
  it('keeps the Ollama and Gemini labels', () => {
    expect(engineLabel('local', 'qwen3.5:4b')).toBe('Ollama (qwen3.5:4b)');
    expect(engineLabel('gemini', 'no-such-model-id')).toBe('no-such-model-id');
  });
});

describe('engineFallbackMsPerChar with the widened engine (classification row 27)', () => {
  it('gives an endpoint the cloud rate until PR 3d reads its gpu', () => {
    expect(engineFallbackMsPerChar('openai', 'cuda')).toBe(engineFallbackMsPerChar('gemini', 'cuda'));
  });
});
