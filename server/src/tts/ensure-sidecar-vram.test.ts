import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../workspace/user-settings.js', () => ({
  getResolvedSidecarUrl: () => 'http://localhost:9000',
  readConfigOverrides: () => ({}),
  setLastKnownQwenInstallState: () => {},
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
