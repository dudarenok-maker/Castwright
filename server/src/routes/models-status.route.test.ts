import { describe, it, expect, vi, beforeEach } from 'vitest';

/* sidecarVenvPresent, getActiveSupervisor, probeSidecarHealth, and
   findPython312 are vi.fn() spies (not plain returns) so call-count and
   per-test overrides are assertable — see the "single probe" and
   "venv-gated probe" invariants pinned below, mirroring
   setup-readiness.orchestration.test.ts's pattern for the same class of
   regression on the sibling route. */
const sidecarVenvPresent = vi.fn();
const getActiveSupervisor = vi.fn();
const probeSidecarHealth = vi.fn();
const findPython312 = vi.fn();

// Mock the I/O seams so the route is deterministic.
vi.mock('../diagnostics/venv.js', () => ({ sidecarVenvPresent: () => sidecarVenvPresent() }));
vi.mock('../tts/sidecar-supervisor.js', () => ({ getActiveSupervisor: () => getActiveSupervisor() }));
vi.mock('../gpu/device-total.js', () => ({ getDeviceTotalVramMb: () => 8192 }));
vi.mock('./sidecar-health.js', () => ({ probeSidecarHealth: () => probeSidecarHealth() }));
/* Mocked so the venv-absent path (which falls through to
   probePython312Cached() -> findPython312()) doesn't spawn a real
   interpreter-hunt subprocess in a unit test. */
vi.mock('../tts/python-discovery.js', () => ({ findPython312: () => findPython312() }));
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
import { _resetPythonProbeCacheForTests } from './setup-diagnosis.js';

describe('computeModelsStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    /* probePython312Cached() TTL-caches its result for 10s in module-level
       state (setup-diagnosis.ts) — reset so the venv-absent test's
       findPython312 override can't leak into (or be poisoned by) another
       test in the same wall-clock window. */
    _resetPythonProbeCacheForTests();
    sidecarVenvPresent.mockReturnValue(true);
    getActiveSupervisor.mockReturnValue({ tripEvent: () => null, exhaustedEvent: () => false });
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable', kokoroLoaded: false, kokoroPackageInstalled: true,
      qwenPackageInstalled: false, coquiPackageInstalled: false, modelLoaded: false,
    });
    findPython312.mockReturnValue(null);
  });

  it('reports kokoro ready, qwen not-installed, and runtime installed + reachable', async () => {
    const s = await computeModelsStatus('/repo');
    expect(s.engines.kokoro.state).toBe('ready');
    expect(s.engines.qwen.state).toBe('not-installed');
    expect(s.runtime.installedOnDisk).toBe(true);
    expect(s.runtime.process).toBe('ready');
    expect(s.info.vramTotalMb).toBe(8192);
  });

  it('calls probeSidecarHealth exactly once per computeModelsStatus call', async () => {
    await computeModelsStatus('/repo');

    expect(probeSidecarHealth).toHaveBeenCalledTimes(1);
  });

  it('skips probeSidecarHealth entirely when the venv is absent, deriving runtime.process from supervisor state instead', async () => {
    /* Regression this catches: computeModelsStatus must make exactly ONE
       probeSidecarHealth() call total (see the "no second probe" invariant
       documented above gpuDetail() in models-status.ts) — venv-absent means
       there's no sidecar to probe at all, so the call must be skipped, not
       just deduplicated. Supervisor active but not tripped/exhausted drives
       deriveProcess() down the 'starting' branch. */
    sidecarVenvPresent.mockReturnValue(false);
    getActiveSupervisor.mockReturnValue({ tripEvent: () => null, exhaustedEvent: () => false });

    const s = await computeModelsStatus('/repo');

    expect(probeSidecarHealth).not.toHaveBeenCalled();
    expect(s.runtime.process).toBe('starting');
  });
});
