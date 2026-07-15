import { describe, it, expect } from 'vitest';
import { buildModelsStatus } from './models-status.js';

const base = {
  runtime: { installedOnDisk: true, pythonFound: true, process: 'ready' as const },
  info: { gpu: 'cuda · 4/8 GB reserved', vramTotalMb: 8192 },
};

describe('buildModelsStatus', () => {
  it('maps each engine to its deriveEngineHealth state + packageBroken', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importable: true },
        qwen: { packageOnDisk: true, weightsOnDisk: false, loaded: false, importable: true },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
      },
    });
    expect(s.engines.kokoro.state).toBe('ready');
    expect(s.engines.qwen.state).toBe('weights-missing');
    expect(s.engines.coqui.state).toBe('not-installed');
    expect(s.engines.kokoro.packageBroken).toBe(false);
  });

  it('flags packageBroken when the package is on disk but not importable live', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importable: false },
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
      },
    });
    expect(s.engines.kokoro.packageBroken).toBe(true);
  });

  it('preserves package-missing (weights present, package absent) — not collapsed to not-installed', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: false, weightsOnDisk: true, loaded: false, importable: undefined },
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
      },
    });
    expect(s.engines.kokoro.state).toBe('package-missing');
  });

  it('does not let a green aggregate mask a broken engine (per-engine independence)', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importable: true }, // usable
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
        coqui: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importable: false }, // broken
      },
    });
    expect(s.engines.kokoro.state).toBe('ready');
    expect(s.engines.coqui.packageBroken).toBe(true); // coqui's own state survives
  });

  it('passes runtime + info through unchanged', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
      },
    });
    expect(s.runtime.process).toBe('ready');
    expect(s.info.vramTotalMb).toBe(8192);
  });

  it('surfaces a recommendation derived from vramTotalMb', () => {
    const probe = { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined };
    const engines = { kokoro: probe, qwen: probe, coqui: probe };

    const hi = buildModelsStatus({ ...base, info: { ...base.info, vramTotalMb: 8192 }, engines });
    expect(hi.recommendation.expressiveOrMultilingual.engine).toBe('qwen');
    expect(hi.recommendation.expressiveOrMultilingual.caveat).toBeNull();
    expect(hi.recommendation.simpleEnglish.engine).toBe('kokoro');

    const lo = buildModelsStatus({ ...base, info: { ...base.info, vramTotalMb: 2048 }, engines });
    expect(lo.recommendation.expressiveOrMultilingual.caveat).toMatch(/may not fit/i);
  });
});
