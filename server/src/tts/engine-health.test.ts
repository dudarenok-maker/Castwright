import { describe, it, expect } from 'vitest';
import { deriveEngineHealth, engineTier, type EngineProbe } from './engine-health.js';

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

    it('regression (pass-2 review #2579): a probe extracted into a variable must still resolve to the WIDE overload', () => {
      // TypeScript's object-literal excess-property check (the pre-fix
      // `Omit<EngineProbe, 'packageFault'>` alone) only blocks an INLINE literal
      // carrying `packageFault`. Extracted to a `const` first — the shape a real
      // caller can innocently reach — the excess key is no longer "fresh", so
      // structural typing lets it match the first (narrow) overload anyway: the
      // call still compiles, but silently with the WRONG return type, one that
      // provably excludes 'package-broken' even though the probe's actual
      // `packageFault` is 'broken'. That's the defect pass-2 review found — not a
      // compile error, a wrong compile SUCCESS — so the regression is pinned at
      // the type level, not via `@ts-expect-error`.
      const probe: EngineProbe = {
        packageInstalled: false,
        weightsPresent: true,
        loaded: false,
        packageFault: 'broken',
      };
      const result = deriveEngineHealth('qwen', probe);

      // Compile-time pin: `result.state`'s inferred type must include
      // 'package-broken'. The `packageFault?: never` intersection member on the
      // first overload is what forces overload resolution to fall through to the
      // second (wide) overload for this variable-typed call. Revert it to a bare
      // `Omit<EngineProbe, 'packageFault'>` and TS matches the FIRST overload
      // again, `result.state`'s type narrows to
      // `Exclude<EngineHealthState, 'package-broken'>`, and the assignment below
      // fails `npm run typecheck` ("Type 'true' is not assignable to type
      // 'false'") — that failure IS this regression test.
      const stateTypeIncludesPackageBroken: 'package-broken' extends typeof result.state
        ? true
        : false = true;
      expect(stateTypeIncludesPackageBroken).toBe(true);
      expect(result.state).toBe('package-broken');
    });
  });
});
