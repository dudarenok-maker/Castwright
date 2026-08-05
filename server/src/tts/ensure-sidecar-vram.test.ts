import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../workspace/user-settings.js', () => ({
  getResolvedSidecarUrl: () => 'http://localhost:9000',
  readConfigOverrides: () => ({}),
  setLastKnownQwenInstallState: () => {},
  // fs-38 Wave 3c Task 19 — probeSidecarHealth() (routes/sidecar-health.js,
  // reached via maybeSampleSidecarEngine below) now also calls this on every
  // reachable poll; an incomplete mock throws "not a function" inside
  // maybeSampleSidecarEngine's best-effort try/catch, silently swallowing the
  // VRAM record this test asserts on.
  setLastKnownCoquiInstallState: () => {},
}));
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: async (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class extends Error {},
}));
vi.mock('../gpu/vram-state.js', () => ({ setLastKnownVram: () => {} }));
vi.mock('../tts/segment-asr-qa.js', () => ({ asrEnabled: () => false }));
vi.mock('../tts/sidecar-supervisor.js', () => ({ getActiveSupervisor: () => null }));
vi.mock('../tts/coqui-catalog-audit.js', () => ({ getCachedCatalogAudit: () => null, runCatalogAudit: async () => null }));

let stats: typeof import('../analyzer/model-vram-stats.js');
let mod: typeof import('./ensure-sidecar-loaded.js');
beforeAll(async () => {
  process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-ensure-'));
  process.env.CASTWRIGHT_VRAM_SAMPLE = '1';
  stats = await import('../analyzer/model-vram-stats.js');
  mod = await import('./ensure-sidecar-loaded.js');
  /* #2052 — gpu/sidecar-vram-sample.ts now reaches probeSidecarHealth via
     the sidecar-health-gate.ts leaf gate instead of a self-bootstrapping
     dynamic import inside maybeSampleSidecarEngine's own try/catch. In the
     real server, routes/sidecar-health.ts registers with the gate at route-
     mount time (server startup), well before any generation call reaches
     maybeSampleSidecarEngine. This test's module graph never mounts routes,
     so it must register the same way explicitly — this import is the only
     thing that changed here; routes/sidecar-health.ts's own module graph was
     already being exercised (for real, unmocked) via the old dynamic import,
     just later (inside the try/catch) rather than up front. */
  await import('../routes/sidecar-health.js');
});
beforeEach(async () => { await rm(stats.vramStatsFilePath(), { force: true }); });
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

describe('ensureSidecarEngineReady VRAM wiring', () => {
  it('records qwen:synth from a clean process after engine-ready', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) {
        return { ok: true, json: async () => ({ vram_reserved_mb: 1800, qwen_loaded: true, qwen_design_ever_loaded: false, engines: ['qwen'] }) } as any;
      }
      return { ok: true, json: async () => ({ status: 'ready' }) } as any; // /load
    }) as unknown as typeof fetch;
    await mod.ensureSidecarEngineReady('qwen', undefined, { timeoutMs: 40, pollIntervalMs: 5 });
    const recs = await stats.readAllVramRecords();
    expect(recs.some((r) => r.key === 'qwen:synth' && r.vramMb === 1800)).toBe(true);
  });
});
