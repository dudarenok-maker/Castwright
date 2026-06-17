/* fs-45 — Task 7 tests: TTS reserved-at-peak recorder + clean-process gate */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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
      // The env guard fires before the dynamic import of sidecar-health / fetch.
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
