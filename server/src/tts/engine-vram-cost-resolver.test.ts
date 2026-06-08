/* Focused test: costForEngine() reads from the config registry so an app
   override changes the resolved weight for a known engine. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
}));

import { costForEngine } from './engine-vram-cost.js';
import * as us from '../workspace/user-settings.js';

describe('config resolver wiring — GPU weights', () => {
  beforeEach(() => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
  });

  it('returns the shipped default weights when no override is set', () => {
    expect(costForEngine('coqui')).toBe(3);
    expect(costForEngine('kokoro')).toBe(1);
    expect(costForEngine('analyzer')).toBe(4);
    expect(costForEngine('gemini')).toBe(0);
  });

  it('app override of gpu.weight.coqui changes costForEngine("coqui")', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'gpu.weight.coqui': 2,
    });
    expect(costForEngine('coqui')).toBe(2);
    // other engines unaffected
    expect(costForEngine('kokoro')).toBe(1);
  });

  it('falls back to 1 for unknown engines regardless of overrides', () => {
    expect(costForEngine('totally-new-engine')).toBe(1);
    expect(costForEngine('')).toBe(1);
  });
});
