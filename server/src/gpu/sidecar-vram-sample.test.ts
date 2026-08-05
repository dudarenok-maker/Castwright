/* fs-45 — Task 7 tests: TTS reserved-at-peak recorder + clean-process gate */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let stats: typeof import('../analyzer/model-vram-stats.js');
let s: typeof import('./sidecar-vram-sample.js');

beforeAll(async () => {
  process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-sc-'));
  stats = await import('../analyzer/model-vram-stats.js');
  s = await import('./sidecar-vram-sample.js');
});

beforeEach(async () => {
  await rm(stats.vramStatsFilePath(), { force: true });
});

it('records the absolute reserved reading under the engine:mode key', async () => {
  await s.recordSidecarEngineVram('qwen:design', 5200);
  expect(await stats.readAllVramRecords()).toEqual([
    expect.objectContaining({ key: 'qwen:design', vramMb: 5200 }),
  ]);
});

it('discards null / non-positive / absurd readings', async () => {
  for (const v of [null, 0, -5, 999_999])
    await s.recordSidecarEngineVram('coqui', v as any);
  expect(await stats.readAllVramRecords()).toHaveLength(0);
});

describe('sampleSidecarEngineVram gate', () => {
  it('records qwen:design when qwen is loaded (no clean-process gate on design)', async () => {
    await s.sampleSidecarEngineVram('qwen:design', {
      vramReservedMb: 5200,
      qwenLoaded: true,
      qwenDesignEverLoaded: true,
    });
    expect(await stats.readAllVramRecords()).toHaveLength(1);
  });

  it('SKIPS qwen:synth when design was ever loaded (poisoned process)', async () => {
    await s.sampleSidecarEngineVram('qwen:synth', {
      vramReservedMb: 5200,
      qwenLoaded: true,
      qwenDesignEverLoaded: true,
    });
    expect(await stats.readAllVramRecords()).toHaveLength(0);
  });

  it('records qwen:synth from a clean process (design never loaded)', async () => {
    await s.sampleSidecarEngineVram('qwen:synth', {
      vramReservedMb: 1800,
      qwenLoaded: true,
      qwenDesignEverLoaded: false,
    });
    expect(await stats.readAllVramRecords()).toEqual([
      expect.objectContaining({ key: 'qwen:synth', vramMb: 1800 }),
    ]);
  });

  it('SKIPS coqui when design was ever loaded; records when clean', async () => {
    await s.sampleSidecarEngineVram('coqui', {
      vramReservedMb: 3400,
      qwenDesignEverLoaded: true,
    });
    expect(await stats.readAllVramRecords()).toHaveLength(0);
    await s.sampleSidecarEngineVram('coqui', {
      vramReservedMb: 3400,
      qwenDesignEverLoaded: false,
    });
    expect(await stats.readAllVramRecords()).toHaveLength(1);
  });
});

describe('maybeSampleSidecarEngine', () => {
  it('is a no-op when CASTWRIGHT_VRAM_SAMPLE=0 (no /health fetch)', async () => {
    const origEnv = process.env.CASTWRIGHT_VRAM_SAMPLE;
    process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
    try {
      // The env guard fires before the leaf-gate probe / fetch.
      // Nothing written to the stats file means no /health was reached.
      await s.maybeSampleSidecarEngine('qwen:synth');
      expect(await stats.readAllVramRecords()).toHaveLength(0);
    } finally {
      if (origEnv === undefined) {
        delete process.env.CASTWRIGHT_VRAM_SAMPLE;
      } else {
        process.env.CASTWRIGHT_VRAM_SAMPLE = origEnv;
      }
    }
  });
});

/* #2052 — maybeSampleSidecarEngine now reaches routes/sidecar-health.ts's
   probe through the sidecar-health-gate.ts leaf gate (setProbeSidecarHealthProvider
   / probeSidecarHealthIfRegistered) instead of a dynamic
   import('../routes/sidecar-health.js'). Each test here re-imports both
   modules fresh (vi.resetModules) so the gate's module-scoped `provider`
   starts unregistered, mirroring sidecar-health-gate.test.ts's own isolation
   pattern — this file never imports routes/sidecar-health.ts, so nothing
   auto-registers a provider otherwise. */
describe('maybeSampleSidecarEngine — routed through the sidecar-health-gate leaf gate (#2052)', () => {
  it('fails closed — records nothing when nothing has registered with the gate', async () => {
    /* R4 review fix (PR #2126) — asserting an empty stats FILE can't tell
       "fails closed by design" (the `if (!health) return;` branch at
       sidecar-vram-sample.ts) apart from "throws and the surrounding
       try/catch silently swallows it" — deleting that exact producer line
       left the original version of this assertion green too, because the
       resulting TypeError (`sampleSidecarEngineVram` reading a property off
       `null`) is caught by `maybeSampleSidecarEngine`'s own best-effort catch
       and ALSO writes nothing.

       Two follow-on attempts were ALSO proven placebo by mutation-verifying
       against the deleted guard line, both still green under the mutation:
       spying on `recordVramSample` (the TypeError fires one level upstream,
       inside `sampleSidecarEngineVram`, before ever reaching it) and spying
       on `sampleSidecarEngineVram` itself via the module's export object
       (Vitest's ESM transform does not route an INTRA-module call — this
       function calling a sibling export in the SAME file — through the
       spied binding, so the spy never sees the call either way).

       What actually distinguishes the two paths: the #2052 R6 debug log
       added to the `if (!health) return;` branch itself. That branch, log
       included, is entirely absent from the mutated (deleted-guard) code —
       so asserting the SPECIFIC log fired is true only when this exact
       branch executed, not merely when nothing was recorded. Mutation-
       verified: deleting `if (!health) return;` reddens this (the log never
       fires, the assertion fails); restoring the guard is green. */
    vi.resetModules();
    const fresh: typeof import('./sidecar-vram-sample.js') = await import('./sidecar-vram-sample.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fresh.maybeSampleSidecarEngine('qwen:synth');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no sample recorded for qwen:synth'),
    );
    expect(await stats.readAllVramRecords()).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('records the registered provider\'s snapshot through the gate', async () => {
    vi.resetModules();
    const gate: typeof import('./sidecar-health-gate.js') = await import('./sidecar-health-gate.js');
    gate.setProbeSidecarHealthProvider(async () => ({
      qwenLoaded: true,
      qwenDesignEverLoaded: false,
      vramReservedMb: 4200,
    }));
    const fresh: typeof import('./sidecar-vram-sample.js') = await import('./sidecar-vram-sample.js');
    await fresh.maybeSampleSidecarEngine('qwen:synth');
    expect(await stats.readAllVramRecords()).toEqual([
      expect.objectContaining({ key: 'qwen:synth', vramMb: 4200 }),
    ]);
  });
});
