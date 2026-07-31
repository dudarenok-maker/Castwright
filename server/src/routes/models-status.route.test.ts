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
/* #1963 — a controllable spy (not the plain `() => false` the other two
   disk probes below use) so the coqui-import-honesty regression test can
   flip the disk probe to true for the one case that needs packageOnDisk
   true to observe packageBroken flip. */
const coquiPackageInstalledDisk = vi.fn(() => false);

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
  coquiPackageInstalled: () => coquiPackageInstalledDisk(), coquiWeightsPresent: () => false,
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
    coquiPackageInstalledDisk.mockReturnValue(false);
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

describe('computeModelsStatus — coqui import honesty (#1963)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPythonProbeCacheForTests();
    sidecarVenvPresent.mockReturnValue(true);
    getActiveSupervisor.mockReturnValue({ tripEvent: () => null, exhaustedEvent: () => false });
    findPython312.mockReturnValue(null);
    // Package present on disk so packageBroken's `p.packageOnDisk && …` half
    // can actually flip true — this is the producer half of the regression:
    // without it, packageBroken would read false regardless of importable.
    coquiPackageInstalledDisk.mockReturnValue(true);
  });

  it('coqui_import_ok: false flags coqui packageBroken even though find_spec (coquiPackageInstalled) says true', async () => {
    /* THE DEFECT (#1963): before the fix, coqui's livePackageImportable read
       straight off coquiPackageInstalled (find_spec), so a package that
       cannot actually import — the #1944 speechbrain lazy-proxy collision —
       reported packageBroken: false and the engine looked usable. */
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable',
      modelLoaded: false,
      coquiPackageInstalled: true,
      coquiImportOk: false,
    });

    const s = await computeModelsStatus('/repo');

    expect(s.engines.coqui.packageBroken).toBe(true);
  });

  it('coqui_import_ok: null falls back to coquiPackageInstalled — packageBroken stays false, unchanged from today', async () => {
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable',
      modelLoaded: false,
      coquiPackageInstalled: true,
      coquiImportOk: null,
    });

    const s = await computeModelsStatus('/repo');

    expect(s.engines.coqui.packageBroken).toBe(false);
  });

  it('coqui_import_ok: true reports packageBroken false', async () => {
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable',
      modelLoaded: false,
      coquiPackageInstalled: true,
      coquiImportOk: true,
    });

    const s = await computeModelsStatus('/repo');

    expect(s.engines.coqui.packageBroken).toBe(false);
  });
});

describe('computeModelsStatus — kokoro/qwen import honesty (#1965)', () => {
  /* End-to-end through the route composition: a /health body carrying
     kokoro_import_ok: false must reach packageBroken. Before #1965 the
     registry's single accessor read kokoroPackageInstalled (find_spec) alone,
     so kokoro and qwen could not produce this signal AT ALL — a package present
     on disk that genuinely will not import (#1944) looked perfectly usable and
     Model Manager never offered Repair.

     Kokoro is the engine under test here because its disk probe is mocked true
     above, which is what lets packageBroken's `packageOnDisk && …` half flip.
     The qwen half of the same regression is pinned on the pure predicate in
     tts/models-status.test.ts and on the accessor in
     tts/voice-engine-registry.test.ts. */
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPythonProbeCacheForTests();
    sidecarVenvPresent.mockReturnValue(true);
    getActiveSupervisor.mockReturnValue({ tripEvent: () => null, exhaustedEvent: () => false });
    findPython312.mockReturnValue(null);
    coquiPackageInstalledDisk.mockReturnValue(false);
  });

  it('kokoro_import_ok: false flags kokoro packageBroken even though find_spec says true', async () => {
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable',
      kokoroLoaded: false,
      kokoroPackageInstalled: true,
      kokoroImportOk: false,
    });

    const s = await computeModelsStatus('/repo');

    expect(s.engines.kokoro.packageBroken).toBe(true);
  });

  it('kokoroImportOk: null (the common value — nothing has loaded kokoro yet) falls back to find_spec', async () => {
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable',
      kokoroLoaded: false,
      kokoroPackageInstalled: true,
      kokoroImportOk: null,
    });

    const s = await computeModelsStatus('/repo');

    expect(s.engines.kokoro.packageBroken).toBe(false);
  });

  it('kokoroImportOk: null + find_spec false → packageBroken, exactly as before the split', async () => {
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable',
      kokoroLoaded: false,
      kokoroPackageInstalled: false,
      kokoroImportOk: null,
    });

    const s = await computeModelsStatus('/repo');

    expect(s.engines.kokoro.packageBroken).toBe(true);
  });

  it('kokoroImportOk: true outranks a find_spec false — a real import beats the probe', async () => {
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable',
      kokoroLoaded: false,
      kokoroPackageInstalled: false,
      kokoroImportOk: true,
    });

    const s = await computeModelsStatus('/repo');

    expect(s.engines.kokoro.packageBroken).toBe(false);
  });

  it('sidecar unreachable → both signals unknown, never broken-confirmed', async () => {
    probeSidecarHealth.mockResolvedValue({ status: 'unreachable' });

    const s = await computeModelsStatus('/repo');

    expect(s.engines.kokoro.packageBroken).toBe(false);
  });
});
