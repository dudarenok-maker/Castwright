/* fs-21 / fs-75 Part A — GET /api/setup/readiness route-handler orchestration.
   setup-readiness.test.ts only covers the pure buildSetupReadiness() mapper
   (field passthrough); setup-readiness.route.test.ts is a "live probe"
   integration smoke test that never mocks the individual probes. Neither
   exercises the ACTUAL orchestration wiring inside the route handler: the
   call order (diagnoseSidecar's result must feed into diagnoseTts) and how
   the route derives its diagnoseSidecar/diagnoseTts inputs from
   computeModelsStatus's output. A reorder or a mis-derived input would pass
   every existing test undetected.

   The sidecar/tts derivation itself moved to computeModelsStatus
   (models-status.ts, covered by models-status.route.test.ts's own "single
   probe" / "venv-gated probe" invariants) — this file mocks that function
   wholesale and asserts the route's OWN wiring on top of it: diagnoseSidecar
   feeding diagnoseTts, and the sidecarReachable / noEngineAtAll /
   anyEngineUsable / weightsMissingEngine / packageBroken derivations off a
   controlled ModelsStatus. The four pure diagnose*() decision functions are
   left genuine, so a wiring regression — not just a probe-shape regression —
   is what's under test. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const computeModelsStatus = vi.fn();
const venvCorePackageInstalled = vi.fn();
const getActiveSupervisor = vi.fn();
const probeFfmpeg = vi.fn();
const probeOllamaHealth = vi.fn();
const getResolvedAnalysisEngine = vi.fn();
const getResolvedGeminiApiKey = vi.fn();
const getResolvedSetupCompletedAt = vi.fn();
const getResolvedOllamaModel = vi.fn();
const writeSetupCompletedAt = vi.fn();

vi.mock('./models-status.js', () => ({ computeModelsStatus: (root: string) => computeModelsStatus(root) }));
vi.mock('../tts/venv-core-package.js', () => ({
  venvCorePackageInstalled: () => venvCorePackageInstalled(),
}));
vi.mock('../tts/sidecar-supervisor.js', () => ({ getActiveSupervisor: () => getActiveSupervisor() }));
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

import { setupReadinessRouter } from './setup-readiness.js';

function makeApp() {
  const app = express();
  app.use('/api/setup', setupReadinessRouter);
  return app;
}

type EngineState = 'not-installed' | 'package-missing' | 'weights-missing' | 'ready' | 'loaded';

function engineStatus(state: EngineState, packageBroken = false) {
  return { state, packageBroken };
}

/* Builds a controlled computeModelsStatus() return value. Defaults to an
   all-healthy system (venv present, sidecar reachable, kokoro ready and not
   broken, qwen/coqui not installed) — individual tests override just the
   axis they care about, mirroring diagnostics.test.ts's convention. */
function modelsStatus(overrides: {
  runtime?: Partial<{ installedOnDisk: boolean; pythonFound: boolean; process: string }>;
  engines?: Partial<Record<'kokoro' | 'qwen' | 'coqui', ReturnType<typeof engineStatus>>>;
  info?: Partial<{ gpu: string; vramTotalMb: number | null }>;
} = {}) {
  return {
    runtime: { installedOnDisk: true, pythonFound: true, process: 'ready', ...overrides.runtime },
    engines: {
      kokoro: engineStatus('ready'),
      qwen: engineStatus('not-installed'),
      coqui: engineStatus('not-installed'),
      ...overrides.engines,
    },
    info: { gpu: 'cuda', vramTotalMb: 8192, ...overrides.info },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  computeModelsStatus.mockResolvedValue(modelsStatus());
  venvCorePackageInstalled.mockReturnValue(true);
  getActiveSupervisor.mockReturnValue({
    tripEvent: () => null,
    exhaustedEvent: () => false,
  });
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
});

describe('GET /api/setup/readiness — orchestration wiring', () => {
  it('sanity: an all-healthy system reports ready:true', async () => {
    const res = await request(makeApp()).get('/api/setup/readiness');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.blockers.sidecar.cause).toBe('pass');
    expect(res.body.blockers.tts.cause).toBe('pass');
    expect(res.body.info.vramTotalMb).toBe(8192);
  });

  it("feeds diagnoseSidecar()'s result into diagnoseTts() — a venv-missing sidecar diagnosis surfaces as tts:sidecar-blocked, not an independently-computed tts verdict", async () => {
    /* Regression this catches: if the route stopped threading `sidecar` into
       diagnoseTts(sidecar, ...) — e.g. computed tts from raw engine states
       independently, or reordered the calls so tts ran first without the
       sidecar result available — the tts blocker would NOT come back as
       'sidecar-blocked' even though the sidecar itself is broken; it would
       fall through to whatever the (irrelevant, in this scenario) engine
       states say instead (here: 'pass', since Kokoro is 'ready' per the
       beforeEach default). */
    computeModelsStatus.mockResolvedValue(modelsStatus({
      runtime: { installedOnDisk: false, pythonFound: true, process: 'down' },
    }));

    const res = await request(makeApp()).get('/api/setup/readiness');

    expect(res.body.blockers.sidecar.status).toBe('fail');
    expect(res.body.blockers.sidecar.cause).toBe('venv-missing');
    expect(res.body.blockers.tts.status).toBe('fail');
    expect(res.body.blockers.tts.cause).toBe('sidecar-blocked');
    expect(res.body.ready).toBe(false);
  });

  it('derives sidecarReachable from runtime.process === "ready" — a reachable-but-package-broken sidecar reads as sidecar:pass (NOT unreachable-transient), with the broken engine surfacing via tts:package-broken', async () => {
    /* Deliberate behavior change vs. the pre-fs-75 code (Finding 2): the old
       route derived sidecarReachable from a DiagnosticsCheck that reported
       warn/fail (so "not ok") whenever a package was live-broken, which made
       an actually-running sidecar read as 'unreachable-transient' ("starting
       up") — wrong. models.runtime.process === 'ready' is true here because
       the sidecar genuinely IS up; the broken engine is surfaced through
       models.engines.kokoro.packageBroken -> tts's package-broken cause
       instead, which is the more accurate signal. */
    computeModelsStatus.mockResolvedValue(modelsStatus({
      runtime: { installedOnDisk: true, pythonFound: true, process: 'ready' },
      engines: {
        kokoro: engineStatus('ready', true), // disk-ready but live-confirmed broken
        qwen: engineStatus('not-installed'),
        coqui: engineStatus('not-installed'),
      },
    }));

    const res = await request(makeApp()).get('/api/setup/readiness');

    expect(res.body.blockers.sidecar.status).toBe('pass');
    expect(res.body.blockers.sidecar.cause).not.toBe('unreachable-transient');
    expect(res.body.blockers.tts.status).toBe('fail');
    expect(res.body.blockers.tts.cause).toBe('package-broken');
  });

  it('derives weightsMissingEngine from models.engines — a weights-missing kokoro with nothing else usable surfaces as tts:weights-missing', async () => {
    computeModelsStatus.mockResolvedValue(modelsStatus({
      engines: {
        kokoro: engineStatus('weights-missing'),
        qwen: engineStatus('not-installed'),
        coqui: engineStatus('not-installed'),
      },
    }));

    const res = await request(makeApp()).get('/api/setup/readiness');

    expect(res.body.blockers.tts.status).toBe('fail');
    expect(res.body.blockers.tts.cause).toBe('weights-missing');
  });

  it('anyEngineUsable off a DIFFERENT engine masks a broken/missing one — a usable qwen alongside a weights-missing kokoro surfaces tts:pass', async () => {
    computeModelsStatus.mockResolvedValue(modelsStatus({
      engines: {
        kokoro: engineStatus('weights-missing'),
        qwen: engineStatus('ready'),
        coqui: engineStatus('not-installed'),
      },
    }));

    const res = await request(makeApp()).get('/api/setup/readiness');

    expect(res.body.blockers.tts.status).toBe('pass');
  });

  it('noEngineAtAll — every engine not-installed surfaces tts:no-engine-installed', async () => {
    computeModelsStatus.mockResolvedValue(modelsStatus({
      engines: {
        kokoro: engineStatus('not-installed'),
        qwen: engineStatus('not-installed'),
        coqui: engineStatus('not-installed'),
      },
    }));

    const res = await request(makeApp()).get('/api/setup/readiness');

    expect(res.body.blockers.tts.status).toBe('fail');
    expect(res.body.blockers.tts.cause).toBe('no-engine-installed');
  });

  it('surfaces info.gpu and info.vramTotalMb straight from computeModelsStatus', async () => {
    computeModelsStatus.mockResolvedValue(modelsStatus({
      info: { gpu: 'cuda · 1.2/8.0 GB', vramTotalMb: 8192 },
    }));

    const res = await request(makeApp()).get('/api/setup/readiness');

    expect(res.body.info.gpu).toBe('cuda · 1.2/8.0 GB');
    expect(res.body.info.vramTotalMb).toBe(8192);
  });

  it('surfaces a null vramTotalMb when there is no GPU', async () => {
    computeModelsStatus.mockResolvedValue(modelsStatus({
      info: { gpu: 'CPU — no GPU detected', vramTotalMb: null },
    }));

    const res = await request(makeApp()).get('/api/setup/readiness');

    expect(res.body.info.vramTotalMb).toBeNull();
  });

  it('calls computeModelsStatus exactly once per request', async () => {
    await request(makeApp()).get('/api/setup/readiness');

    expect(computeModelsStatus).toHaveBeenCalledTimes(1);
  });
});
