/* Focused test: resolveLoudnormOptions() reads from the config registry so an
   app override is reflected in the returned LoudnormOptions. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
}));

import { resolveLoudnormOptions } from './loudnorm.js';
import * as us from '../workspace/user-settings.js';

describe('config resolver wiring — loudnorm', () => {
  beforeEach(() => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
  });

  it('returns the shipped defaults when no override is set', () => {
    const opts = resolveLoudnormOptions();
    expect(opts.target).toBe(-16);
    expect(opts.lra).toBe(11);
    expect(opts.tp).toBe(-1.5);
    expect(opts.twoPass).toBe(true);
  });

  it('app override of audio.loudnorm.targetLufs is reflected in target', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'audio.loudnorm.targetLufs': -23,
    });
    const opts = resolveLoudnormOptions();
    expect(opts.target).toBe(-23);
    // other fields stay at defaults
    expect(opts.lra).toBe(11);
    expect(opts.tp).toBe(-1.5);
  });
});
