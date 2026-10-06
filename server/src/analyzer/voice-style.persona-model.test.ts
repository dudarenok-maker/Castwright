import { describe, it, expect, afterEach } from 'vitest';
import { resolvePersonaLocalModel } from './voice-style.js';
import { getResolvedOllamaModel } from '../config/ollama-resolved.js';
import { _resetUserSettingsCache } from '../workspace/user-settings.js';

const ENV = 'PERSONA_GEN_LOCAL_MODEL';

describe('resolvePersonaLocalModel — endpoint ids never reach Ollama (#3084 PR 3a)', () => {
  const saved = process.env[ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    _resetUserSettingsCache();
  });

  it('falls back to the analyzer Ollama model when the knob holds an endpoint id', () => {
    process.env[ENV] = 'openai:lab::qwen3:30b';
    expect(resolvePersonaLocalModel()).toBe(getResolvedOllamaModel());
  });

  it('keeps a bare Ollama tag with no colon (Ollama resolves it to :latest)', () => {
    process.env[ENV] = 'llama2';
    expect(resolvePersonaLocalModel()).toBe('llama2');
  });
});
