import { describe, it, expect } from 'vitest';
import { buildModelsStatus, classifyPackageFault, type EngineProbeResult } from './models-status.js';

/* #1999 — classifyPackageFault is the single shared precedence order the
   Admin console (diagnostics.ts) and the Setup checker (setup-diagnosis.ts,
   via setup-readiness.ts) both call, replacing an inline copy in the former
   and a collapsed boolean in the latter. */
describe('classifyPackageFault', () => {
  it('importOk true wins outright, even over a stale find_spec false', () => {
    expect(classifyPackageFault(true, false)).toBe('ok');
  });

  it('specPresent false wins over importOk false — one fault, "missing"', () => {
    expect(classifyPackageFault(false, false)).toBe('missing');
  });

  it('specPresent false alone (importOk never attempted) is "missing"', () => {
    expect(classifyPackageFault(undefined, false)).toBe('missing');
  });

  it('importOk false alone (spec present or unknown) is "broken"', () => {
    expect(classifyPackageFault(false, true)).toBe('broken');
    expect(classifyPackageFault(false, undefined)).toBe('broken');
  });

  it('importOk undefined (the COMMON value — nothing tried to import yet) with specPresent true or unknown reads "ok"', () => {
    expect(classifyPackageFault(undefined, true)).toBe('ok');
    expect(classifyPackageFault(undefined, undefined)).toBe('ok');
  });
});

/* #1965 note on the six cases in the first describe below: their assertions and
   expected values are UNCHANGED by the importable → importOk/specPresent split.
   Only the input key spelling moved, mechanically, because the field was
   renamed — every old `importable: v` became `importOk: v` with specPresent
   unknown, which the equivalence suite at the bottom of this file proves is one
   of two interchangeable encodings of the same input. */

const base = {
  runtime: { installedOnDisk: true, pythonFound: true, process: 'ready' as const },
  info: { gpu: 'cuda · 4/8 GB reserved', vramTotalMb: 8192 },
};

describe('buildModelsStatus', () => {
  it('maps each engine to its deriveEngineHealth state + packageBroken', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importOk: true, specPresent: undefined },
        qwen: { packageOnDisk: true, weightsOnDisk: false, loaded: false, importOk: true, specPresent: undefined },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined },
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
        kokoro: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importOk: false, specPresent: undefined },
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined },
      },
    });
    expect(s.engines.kokoro.packageBroken).toBe(true);
  });

  it('#1999 — wires packageFault through from classifyPackageFault, distinguishing missing from broken', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        // specPresent false → missing, regardless of packageOnDisk's disk heuristic.
        kokoro: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importOk: undefined, specPresent: false },
        // importOk false with spec present → broken.
        qwen: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importOk: false, specPresent: true },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined },
      },
    });
    expect(s.engines.kokoro.packageFault).toBe('missing');
    expect(s.engines.qwen.packageFault).toBe('broken');
    expect(s.engines.coqui.packageFault).toBe('ok');
  });

  it('preserves package-missing (weights present, package absent) — not collapsed to not-installed', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: false, weightsOnDisk: true, loaded: false, importOk: undefined, specPresent: undefined },
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined },
      },
    });
    expect(s.engines.kokoro.state).toBe('package-missing');
  });

  it('does not let a green aggregate mask a broken engine (per-engine independence)', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importOk: true, specPresent: undefined }, // usable
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined },
        coqui: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importOk: false, specPresent: undefined }, // broken
      },
    });
    expect(s.engines.kokoro.state).toBe('ready');
    expect(s.engines.coqui.packageBroken).toBe(true); // coqui's own state survives
  });

  it('passes runtime + info through unchanged', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined },
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined },
      },
    });
    expect(s.runtime.process).toBe('ready');
    expect(s.info.vramTotalMb).toBe(8192);
  });

  it('surfaces a recommendation derived from vramTotalMb', () => {
    const probe = { packageOnDisk: false, weightsOnDisk: false, loaded: false, importOk: undefined, specPresent: undefined };
    const engines = { kokoro: probe, qwen: probe, coqui: probe };

    const hi = buildModelsStatus({ ...base, info: { ...base.info, vramTotalMb: 8192 }, engines });
    expect(hi.recommendation.expressiveOrMultilingual.engine).toBe('qwen');
    expect(hi.recommendation.expressiveOrMultilingual.caveat).toBeNull();
    expect(hi.recommendation.simpleEnglish.engine).toBe('kokoro');

    const lo = buildModelsStatus({ ...base, info: { ...base.info, vramTotalMb: 2048 }, engines });
    expect(lo.recommendation.expressiveOrMultilingual.caveat).toMatch(/may not fit/i);
  });
});

/* ── #1965: importable split into importOk + specPresent ──────────────────── */

const NOT_ON_DISK: EngineProbeResult = {
  packageOnDisk: false,
  weightsOnDisk: false,
  loaded: false,
  importOk: undefined,
  specPresent: undefined,
};

/** One engine under test, the other two parked in a state that can't interfere. */
function statusFor(
  engine: 'kokoro' | 'qwen' | 'coqui',
  probe: { packageOnDisk: boolean; importOk: boolean | undefined; specPresent: boolean | undefined },
) {
  const engines = { kokoro: NOT_ON_DISK, qwen: NOT_ON_DISK, coqui: NOT_ON_DISK };
  engines[engine] = { ...NOT_ON_DISK, ...probe, weightsOnDisk: true, loaded: false };
  return buildModelsStatus({ ...base, engines });
}

describe('packageBroken is exactly equivalent to the pre-split collapse', () => {
  /* The property that made the split a pure refactor. Pre-split there was ONE
     field, `importable`, already collapsed by the registry as
     `importOk ?? specPresent`; packageBroken was `packageOnDisk && importable
     === false`. So for any single known value v, encoding v as importOk (spec
     unknown) and encoding it as specPresent (importOk unknown) must BOTH give
     the old answer, and must give the same answer as each other. */
  const oldFormula = (packageOnDisk: boolean, v: boolean | undefined) =>
    packageOnDisk && v === false;

  for (const packageOnDisk of [true, false]) {
    for (const v of [true, false, undefined]) {
      it(`packageOnDisk=${packageOnDisk}, value=${String(v)} → both encodings match the old formula`, () => {
        const viaImportOk = statusFor('kokoro', { packageOnDisk, importOk: v, specPresent: undefined });
        const viaSpecPresent = statusFor('kokoro', { packageOnDisk, importOk: undefined, specPresent: v });
        expect(viaImportOk.engines.kokoro.packageBroken).toBe(oldFormula(packageOnDisk, v));
        expect(viaSpecPresent.engines.kokoro.packageBroken).toBe(oldFormula(packageOnDisk, v));
      });
    }
  }
});

describe('a real failed import outranks the find_spec probe (#1944 / #1965)', () => {
  /* THE REGRESSION THAT MATTERS. find_spec says the package is right there on
     the venv path; a real `import` of it raised anyway — the speechbrain
     lazy-proxy collision (#1944). Before the sidecar grew kokoro_import_ok /
     qwen_import_ok these two engines could not produce this signal AT ALL, so
     Model Manager stayed silent where it should offer Repair (the CTA in
     src/components/{kokoro,qwen}-install.tsx hangs off packageBroken). */
  for (const engine of ['kokoro', 'qwen'] as const) {
    it(`${engine}: specPresent true + importOk false → packageBroken`, () => {
      const s = statusFor(engine, { packageOnDisk: true, importOk: false, specPresent: true });
      expect(s.engines[engine].packageBroken).toBe(true);
    });
  }

  it('coqui keeps the same behaviour it had after #1963', () => {
    const s = statusFor('coqui', { packageOnDisk: true, importOk: false, specPresent: true });
    expect(s.engines.coqui.packageBroken).toBe(true);
  });

  it('importOk true outranks a stale find_spec false — a real import beats the probe', () => {
    const s = statusFor('kokoro', { packageOnDisk: true, importOk: true, specPresent: false });
    expect(s.engines.kokoro.packageBroken).toBe(false);
  });
});

describe('unknown is never broken (fail-open)', () => {
  it('importOk undefined (the COMMON case — nothing tried to import yet) falls back to specPresent', () => {
    expect(
      statusFor('kokoro', { packageOnDisk: true, importOk: undefined, specPresent: true }).engines
        .kokoro.packageBroken,
    ).toBe(false);
    expect(
      statusFor('kokoro', { packageOnDisk: true, importOk: undefined, specPresent: false }).engines
        .kokoro.packageBroken,
    ).toBe(true);
  });

  it('both signals unknown (sidecar down / older sidecar) → never broken-confirmed', () => {
    const s = statusFor('qwen', { packageOnDisk: true, importOk: undefined, specPresent: undefined });
    expect(s.engines.qwen.packageBroken).toBe(false);
  });

  it('packageOnDisk false gates everything — no disk package, nothing to call broken', () => {
    const s = statusFor('qwen', { packageOnDisk: false, importOk: false, specPresent: false });
    expect(s.engines.qwen.packageBroken).toBe(false);
  });
});
