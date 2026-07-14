import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the I/O seams so the route is deterministic.
vi.mock('../diagnostics/venv.js', () => ({ sidecarVenvPresent: () => true }));
vi.mock('../tts/sidecar-supervisor.js', () => ({ getActiveSupervisor: () => ({ tripEvent: () => null, exhaustedEvent: () => false }) }));
vi.mock('../gpu/device-total.js', () => ({ getDeviceTotalVramMb: () => 8192 }));
vi.mock('./sidecar-health.js', () => ({
  probeSidecarHealth: async () => ({
    status: 'reachable', kokoroLoaded: false, kokoroPackageInstalled: true,
    qwenPackageInstalled: false, coquiPackageInstalled: false, modelLoaded: false,
  }),
}));
vi.mock('../tts/kokoro-install-detect.js', () => ({
  kokoroPackageInstalled: () => true, detectKokoroInstalledOnDisk: () => true,
}));
vi.mock('../tts/qwen-install-detect.js', () => ({
  qwenPackageInstalled: () => false, qwenWeightsPresent: () => false,
}));
vi.mock('../tts/coqui-install-detect.js', () => ({
  coquiPackageInstalled: () => false, coquiWeightsPresent: () => false,
}));

import { computeModelsStatus } from './models-status.js';

describe('computeModelsStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports kokoro ready, qwen not-installed, and runtime installed + reachable', async () => {
    const s = await computeModelsStatus('/repo');
    expect(s.engines.kokoro.state).toBe('ready');
    expect(s.engines.qwen.state).toBe('not-installed');
    expect(s.runtime.installedOnDisk).toBe(true);
    expect(s.runtime.process).toBe('ready');
    expect(s.info.vramTotalMb).toBe(8192);
  });
});
