/* Focused test: analyzer sampling knobs read through the config registry so
   an app override changes the resolved values. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
}));

import { resolveOllamaTemperature, resolveNumPredict } from './ollama.js';
import * as us from '../workspace/user-settings.js';

describe('config resolver wiring — analyzer sampling', () => {
  beforeEach(() => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
  });

  it('returns the shipped default temperature when no override is set', () => {
    expect(resolveOllamaTemperature()).toBe(0.2);
  });

  it('app override of analyzer.ollama.temperature is reflected', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'analyzer.ollama.temperature': 0.9,
    });
    expect(resolveOllamaTemperature()).toBe(0.9);
  });

  it('num_predict of 0 is treated as -1 (no cap), preserving historical behaviour', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'analyzer.ollama.numPredict': 0,
    });
    expect(resolveNumPredict()).toBe(-1);
  });
});
