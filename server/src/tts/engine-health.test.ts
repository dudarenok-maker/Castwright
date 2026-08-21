import { describe, it, expect } from 'vitest';
import { deriveEngineHealth, engineTier } from './engine-health.js';

describe('engine-health', () => {
  it('package absent + weights present → package-missing', () => {
    expect(deriveEngineHealth('qwen', { packageInstalled: false, weightsPresent: true, loaded: false }).state).toBe('package-missing');
  });
  it('package present + weights absent → weights-missing', () => {
    expect(deriveEngineHealth('qwen', { packageInstalled: true, weightsPresent: false, loaded: false }).state).toBe('weights-missing');
  });
  it('neither → not-installed', () => {
    expect(deriveEngineHealth('qwen', { packageInstalled: false, weightsPresent: false, loaded: false }).state).toBe('not-installed');
  });
  it('both present → ready', () => {
    expect(deriveEngineHealth('qwen', { packageInstalled: true, weightsPresent: true, loaded: false }).state).toBe('ready');
  });
  it('loaded short-circuits to loaded', () => {
    expect(deriveEngineHealth('qwen', { packageInstalled: true, weightsPresent: true, loaded: true }).state).toBe('loaded');
  });
  it('tiers: kokoro/qwen/whisper standard, coqui secondary', () => {
    expect(engineTier('kokoro')).toBe('standard');
    expect(engineTier('qwen')).toBe('standard');
    expect(engineTier('whisper')).toBe('standard');
    expect(engineTier('coqui')).toBe('secondary');
  });

  describe('packageFault (#2533)', () => {
    it('package absent + weights present + packageFault "broken" → package-broken', () => {
      expect(
        deriveEngineHealth('qwen', {
          packageInstalled: false,
          weightsPresent: true,
          loaded: false,
          packageFault: 'broken',
        }).state,
      ).toBe('package-broken');
    });

    it('package absent + weights present + packageFault "missing" → package-missing (unchanged)', () => {
      expect(
        deriveEngineHealth('qwen', {
          packageInstalled: false,
          weightsPresent: true,
          loaded: false,
          packageFault: 'missing',
        }).state,
      ).toBe('package-missing');
    });

    it('package absent + weights present + packageFault omitted → package-missing (default, unchanged)', () => {
      expect(
        deriveEngineHealth('qwen', { packageInstalled: false, weightsPresent: true, loaded: false })
          .state,
      ).toBe('package-missing');
    });

    it('packageFault "broken" has no effect off the package-missing branch (ready stays ready)', () => {
      expect(
        deriveEngineHealth('qwen', {
          packageInstalled: true,
          weightsPresent: true,
          loaded: false,
          packageFault: 'broken',
        }).state,
      ).toBe('ready');
    });
  });
});
