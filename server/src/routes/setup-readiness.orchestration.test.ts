/* fs-21 — GET /api/setup/readiness route-handler orchestration.
   setup-readiness.test.ts only covers the pure buildSetupReadiness() mapper
   (field passthrough); setup-readiness.route.test.ts is a "live probe"
   integration smoke test that never mocks the individual probes. Neither
   exercises the ACTUAL orchestration wiring inside the route handler: the
   call order (diagnoseSidecar's result must feed into diagnoseTts), the
   venvPresent gate around probePython312Cached(), and the exact extra
   probeSidecarHealth() call count packageBrokenFlags() makes on top of the
   one already inside buildDiagnostics(). A reorder, a removed gate, or an
   added probe call would pass every existing test undetected.

   These tests mock every I/O probe (mirrors diagnostics.test.ts's pattern)
   but leave the four pure diagnose*() decision functions genuine, so a
   wiring regression — not just a probe-shape regression — is what's under
   test. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const buildDiagnostics = vi.fn();
const sidecarVenvPresent = vi.fn();
const venvCorePackageInstalled = vi.fn();
const getActiveSupervisor = vi.fn();
const probeSidecarHealth = vi.fn();
const detectKokoroInstallStateOnDisk = vi.fn();
const detectQwenInstallStateOnDisk = vi.fn();
const detectCoquiInstallStateOnDisk = vi.fn();
const probeFfmpeg = vi.fn();
const probeOllamaHealth = vi.fn();
const getResolvedAnalysisEngine = vi.fn();
const getResolvedGeminiApiKey = vi.fn();
const getResolvedSetupCompletedAt = vi.fn();
const getResolvedOllamaModel = vi.fn();
const writeSetupCompletedAt = vi.fn();
/* Real findPython312 spawns a subprocess to hunt for an interpreter — far too
   slow/flaky for a unit test. probePython312Cached() itself (the function the
   route actually imports and calls) is left REAL so its venvPresent-gated
   call-or-not behaviour is genuinely under test, not just asserted against a
   mock of itself. */
const findPython312 = vi.fn();

vi.mock('./diagnostics.js', () => ({ buildDiagnostics: () => buildDiagnostics() }));
vi.mock('../diagnostics/venv.js', () => ({ sidecarVenvPresent: () => sidecarVenvPresent() }));
vi.mock('../tts/venv-core-package.js', () => ({
  venvCorePackageInstalled: () => venvCorePackageInstalled(),
}));
vi.mock('../tts/sidecar-supervisor.js', () => ({ getActiveSupervisor: () => getActiveSupervisor() }));
vi.mock('./sidecar-health.js', () => ({ probeSidecarHealth: () => probeSidecarHealth() }));
vi.mock('../tts/kokoro-install-detect.js', () => ({
  detectKokoroInstallStateOnDisk: () => detectKokoroInstallStateOnDisk(),
}));
vi.mock('../tts/qwen-install-detect.js', () => ({
  detectQwenInstallStateOnDisk: () => detectQwenInstallStateOnDisk(),
}));
vi.mock('../tts/coqui-install-detect.js', () => ({
  detectCoquiInstallStateOnDisk: () => detectCoquiInstallStateOnDisk(),
}));
vi.mock('../diagnostics/ffmpeg.js', () => ({ probeFfmpeg: () => probeFfmpeg() }));
vi.mock('./ollama-health.js', () => ({ probeOllamaHealth: () => probeOllamaHealth() }));
vi.mock('../workspace/user-settings.js', () => ({
  getResolvedAnalysisEngine: () => getResolvedAnalysisEngine(),
  getResolvedGeminiApiKey: () => getResolvedGeminiApiKey(),
  getResolvedSetupCompletedAt: () => getResolvedSetupCompletedAt(),
  getResolvedOllamaModel: () => getResolvedOllamaModel(),
  writeSetupCompletedAt: (ts: string) => writeSetupCompletedAt(ts),
  readConfigOverrides: () => ({}),
}));
vi.mock('../tts/python-discovery.js', () => ({ findPython312: () => findPython312() }));

import { setupReadinessRouter } from './setup-readiness.js';
import { _resetPythonProbeCacheForTests } from './setup-diagnosis.js';

function makeApp() {
  const app = express();
  app.use('/api/setup', setupReadinessRouter);
  return app;
}

function diagnosticsResponse(overrides: { sidecarOk?: boolean; gpu?: string } = {}) {
  const { sidecarOk = true, gpu = 'cuda' } = overrides;
  return {
    ts: new Date().toISOString(),
    overall: sidecarOk ? 'ok' : 'fail',
    checks: [
      { id: 'gpu', label: 'GPU / VRAM', status: 'ok', detail: gpu },
      {
        id: 'sidecar',
        label: 'Voice engine',
        status: sidecarOk ? 'ok' : 'fail',
        detail: sidecarOk ? 'reachable · kokoro' : 'unreachable',
      },
    ],
  };
}

/* All-pass defaults. Individual tests override just the probe(s) they care
   about, mirroring diagnostics.test.ts's beforeEach convention. */
beforeEach(() => {
  vi.clearAllMocks();
  /* probePython312Cached() is left real (see the findPython312 comment
     above) and TTL-caches its result for 10s in module-level state. Without
     resetting it here, a call in one test would poison the venvPresent=false
     assertion in a later test within the same 10s wall-clock window. */
  _resetPythonProbeCacheForTests();
  buildDiagnostics.mockResolvedValue(diagnosticsResponse());
  sidecarVenvPresent.mockReturnValue(true);
  venvCorePackageInstalled.mockReturnValue(true);
  getActiveSupervisor.mockReturnValue({
    tripEvent: () => null,
    exhaustedEvent: () => false,
  });
  probeSidecarHealth.mockResolvedValue({
    status: 'reachable',
    kokoroPackageInstalled: true,
    qwenPackageInstalled: true,
  });
  detectKokoroInstallStateOnDisk.mockReturnValue('ready');
  detectQwenInstallStateOnDisk.mockReturnValue('not-installed');
  detectCoquiInstallStateOnDisk.mockReturnValue('not-installed');
  probeFfmpeg.mockReturnValue({ ffmpeg: true, ffprobe: true });
  probeOllamaHealth.mockResolvedValue({
    status: 'reachable',
    modelPulled: true,
    pullable: [],
  });
  getResolvedAnalysisEngine.mockReturnValue('local');
  getResolvedGeminiApiKey.mockReturnValue(null);
  getResolvedSetupCompletedAt.mockReturnValue(null);
  getResolvedOllamaModel.mockReturnValue('qwen3.5:4b');
  findPython312.mockReturnValue('C:\\Python312\\python.exe');
});

describe('GET /api/setup/readiness — orchestration wiring', () => {
  it('sanity: an all-healthy system reports ready:true', async () => {
    const res = await request(makeApp()).get('/api/setup/readiness');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.blockers.sidecar.cause).toBe('pass');
    expect(res.body.blockers.tts.cause).toBe('pass');
  });

  it("feeds diagnoseSidecar()'s result into diagnoseTts() — a venv-missing sidecar diagnosis surfaces as tts:sidecar-blocked, not an independently-computed tts verdict", async () => {
    /* Regression this catches: if the route stopped threading `sidecar` into
       diagnoseTts(sidecar, ...) — e.g. computed tts from raw probes
       independently, or reordered the calls so tts ran first without the
       sidecar result available — the tts blocker would NOT come back as
       'sidecar-blocked' even though the sidecar itself is broken; it would
       fall through to whatever the (irrelevant, in this scenario)
       engine-install probes say instead (here: 'pass', since Kokoro is
       'ready' per the beforeEach default). */
    sidecarVenvPresent.mockReturnValue(false);
    findPython312.mockReturnValue('C:\\Python312\\python.exe'); // python IS found -> venv-missing, not python-missing

    const res = await request(makeApp()).get('/api/setup/readiness');

    expect(res.body.blockers.sidecar.status).toBe('fail');
    expect(res.body.blockers.sidecar.cause).toBe('venv-missing');
    expect(res.body.blockers.tts.status).toBe('fail');
    expect(res.body.blockers.tts.cause).toBe('sidecar-blocked');
    expect(res.body.ready).toBe(false);
  });

  it('does NOT call the Python-interpreter probe when the venv is present', async () => {
    /* Regression this catches: removing the
       `const pythonFound = venvPresent ? true : probePython312Cached();`
       gate in setup-readiness.ts would spawn a Python-hunt subprocess on
       every healthy-system poll — exactly the per-poll cost that gate
       exists to avoid. */
    sidecarVenvPresent.mockReturnValue(true);

    await request(makeApp()).get('/api/setup/readiness');

    expect(findPython312).not.toHaveBeenCalled();
  });

  it('DOES call the Python-interpreter probe when the venv is absent', async () => {
    /* Converse of the above — proves the previous assertion is actually
       wired to the gate, not vacuously true because probePython312Cached
       never fires anywhere in this test file. */
    sidecarVenvPresent.mockReturnValue(false);
    findPython312.mockReturnValue(null);

    const res = await request(makeApp()).get('/api/setup/readiness');

    expect(findPython312).toHaveBeenCalledTimes(1);
    expect(res.body.blockers.sidecar.cause).toBe('python-missing');
  });

  it('calls probeSidecarHealth exactly once (the packageBrokenFlags probe) when the diagnostics sidecar check is ok', async () => {
    /* buildDiagnostics() is mocked wholesale here, so its own internal
       probeSidecarHealth() call never happens in this test file at all —
       every call recorded against this spy is one made directly by
       setup-readiness.ts's packageBrokenFlags() helper. The design comment
       above that helper says exactly one extra call is expected per
       request; an accidental second call (e.g. a duplicate probe added on
       a new engine branch) would fail this at 2, and dropping the call
       entirely would fail it at 0. */
    buildDiagnostics.mockResolvedValue(diagnosticsResponse({ sidecarOk: true }));

    await request(makeApp()).get('/api/setup/readiness');

    expect(probeSidecarHealth).toHaveBeenCalledTimes(1);
  });

  it('does NOT call probeSidecarHealth when the diagnostics sidecar check already reports non-ok (gate closed)', async () => {
    /* packageBrokenFlags() short-circuits to a not-broken default without a
       live probe when checkOk(d, 'sidecar') is false — there's nothing
       useful to confirm from a sidecar that diagnostics itself couldn't
       reach. A regression that dropped this early-return would call the
       probe unconditionally, turning this assertion into a call count of 1. */
    buildDiagnostics.mockResolvedValue(diagnosticsResponse({ sidecarOk: false }));

    await request(makeApp()).get('/api/setup/readiness');

    expect(probeSidecarHealth).not.toHaveBeenCalled();
  });
});
