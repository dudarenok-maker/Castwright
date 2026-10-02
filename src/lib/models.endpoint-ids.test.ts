import { describe, it, expect } from 'vitest';
import { engineForModelId, localRunModelIds, runModelsAllResident } from './models';

describe('models.ts uses the shared id grammar (#3084 PR 3a)', () => {
  it('classifies an endpoint id as openai, not local', () => {
    expect(engineForModelId('openai:lab::qwen3:30b')).toBe('openai');
  });
  it('localRunModelIds excludes endpoint ids from the Ollama residency set', () => {
    expect(localRunModelIds(['openai:lab::qwen3:30b', 'qwen3.5:4b'])).toEqual(['qwen3.5:4b']);
  });
  it('a run on an endpoint alone has no local models to be resident', () => {
    expect(runModelsAllResident(['openai:lab::qwen3:30b'], ['openai:lab::qwen3:30b'])).toBe(false);
  });
});
