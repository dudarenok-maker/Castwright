/* fs-18 — GET /api/diagnostics aggregator. Each underlying probe is mocked so
   the per-check status derivation, the engine-aware analyzer/gemini rows, the
   one-probe-throws isolation, and the overall = worst-severity rule can be
   exercised in isolation. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const probeSidecarHealth = vi.fn();
const probeOllamaHealth = vi.fn();
const readGpuQueueState = vi.fn();
const probeFfmpeg = vi.fn();
const probeDiskSpace = vi.fn();
const getResolvedAnalysisEngine = vi.fn();
const getResolvedGeminiApiKey = vi.fn();

vi.mock('./sidecar-health.js', () => ({ probeSidecarHealth: () => probeSidecarHealth() }));
vi.mock('./ollama-health.js', () => ({ probeOllamaHealth: () => probeOllamaHealth() }));
vi.mock('./gpu-queue.js', () => ({ readGpuQueueState: () => readGpuQueueState() }));
vi.mock('../diagnostics/ffmpeg.js', () => ({ probeFfmpeg: () => probeFfmpeg() }));
vi.mock('../diagnostics/disk.js', () => ({
  probeDiskSpace: () => probeDiskSpace(),
  DISK_WARN_GB: 10,
  DISK_FAIL_GB: 2,
}));
vi.mock('../workspace/user-settings.js', () => ({
  getResolvedAnalysisEngine: () => getResolvedAnalysisEngine(),
  getResolvedGeminiApiKey: () => getResolvedGeminiApiKey(),
  readConfigOverrides: () => ({}),
}));
vi.mock('../workspace/paths.js', () => ({ WORKSPACE_ROOT: '/workspace' }));

import { diagnosticsRouter } from './diagnostics.js';

function makeApp() {
  const app = express();
  app.use('/api/diagnostics', diagnosticsRouter);
  return app;
}

/* Healthy defaults — individual tests override the one probe they care about. */
beforeEach(() => {
  vi.clearAllMocks();
  probeSidecarHealth.mockResolvedValue({
    status: 'reachable',
    url: 'http://localhost:9000',
    proxy: 'sidecar',
    device: 'cuda',
    vramReservedMb: 1024,
    vramTotalMb: 8192,
    qwenLoaded: true,
  });
  probeOllamaHealth.mockResolvedValue({
    status: 'reachable',
    url: 'http://localhost:11434',
    expectedModel: 'qwen3.5:4b',
    modelPulled: true,
    modelResident: true,
  });
  readGpuQueueState.mockReturnValue({ depth: 0, inFlight: 0, max: 1, budget: 0, usedTokens: 0 });
  probeFfmpeg.mockReturnValue({ ffmpeg: true, ffprobe: true });
  probeDiskSpace.mockResolvedValue({ status: 'ok', freeGb: 142, path: '/workspace' });
  getResolvedAnalysisEngine.mockReturnValue('local');
  getResolvedGeminiApiKey.mockReturnValue(null);
});

type Check = { id: string; status: string; detail: string };
const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id)!;

describe('GET /api/diagnostics', () => {
  it('returns an all-ok board when every probe is healthy', async () => {
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body.overall).toBe('ok');
    expect(res.body.checks.map((c: Check) => c.id)).toEqual([
      'gpu',
      'sidecar',
      'asr',
      'analyzer',
      'gemini',
      'ffmpeg',
      'disk',
    ]);
    expect(byId(res.body.checks, 'sidecar').detail).toContain('qwen');
    /* The sidecar row is labelled "Voice engine" for users (not "TTS sidecar"). */
    expect(
      (res.body.checks as Array<{ id: string; label: string }>).find((c) => c.id === 'sidecar')!
        .label,
    ).toBe('Voice engine');
  });

  it('fails the gpu + sidecar rows when the sidecar is unreachable', async () => {
    probeSidecarHealth.mockResolvedValue({
      status: 'unreachable',
      url: 'http://localhost:9000',
      proxy: 'sidecar',
      error: 'connection refused',
    });
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(byId(res.body.checks, 'gpu').status).toBe('fail');
    expect(byId(res.body.checks, 'sidecar').status).toBe('fail');
    expect(res.body.overall).toBe('fail');
  });

  it('warns on tight VRAM headroom', async () => {
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable',
      url: '',
      proxy: 'sidecar',
      device: 'cuda',
      vramReservedMb: 7800,
      vramTotalMb: 8192,
    });
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(byId(res.body.checks, 'gpu').status).toBe('warn');
  });

  it('treats a CPU-only sidecar as ok (no GPU is not a failure)', async () => {
    /* CPU-only = device null AND no VRAM figures (torch.cuda.is_available() is
       false, so the sidecar reports no vramTotalMb). */
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable',
      url: '',
      proxy: 'sidecar',
      device: null,
      vramTotalMb: null,
    });
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(byId(res.body.checks, 'gpu').status).toBe('ok');
    expect(byId(res.body.checks, 'gpu').detail).toMatch(/CPU/i);
  });

  it('reports cuda for a Qwen-on-GPU sidecar even when device is null (Coqui idle)', async () => {
    /* Regression: the GPU row used to key off the Coqui-only `device` field, so a
       Qwen run (Coqui not loaded → device null) showed "CPU — no GPU detected"
       despite VRAM figures proving CUDA is present. */
    probeSidecarHealth.mockResolvedValue({
      status: 'reachable',
      url: '',
      proxy: 'sidecar',
      device: null,
      vramReservedMb: 3072,
      vramTotalMb: 8192,
      qwenLoaded: true,
    });
    const res = await request(makeApp()).get('/api/diagnostics');
    const gpu = byId(res.body.checks, 'gpu');
    expect(gpu.status).toBe('ok');
    expect(gpu.detail).toMatch(/cuda/);
    expect(gpu.detail).toMatch(/8\.0 GB/);
    expect(gpu.detail).not.toMatch(/CPU/i);
  });

  it('skips the Ollama analyzer check when the engine is Gemini', async () => {
    getResolvedAnalysisEngine.mockReturnValue('gemini');
    getResolvedGeminiApiKey.mockReturnValue('sk-key');
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(byId(res.body.checks, 'analyzer').status).toBe('ok');
    expect(byId(res.body.checks, 'analyzer').detail).toMatch(/not in use/i);
    expect(probeOllamaHealth).not.toHaveBeenCalled();
    expect(byId(res.body.checks, 'gemini').status).toBe('ok');
  });

  it('fails the gemini row when Gemini is selected but no key is set', async () => {
    getResolvedAnalysisEngine.mockReturnValue('gemini');
    getResolvedGeminiApiKey.mockReturnValue(null);
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(byId(res.body.checks, 'gemini').status).toBe('fail');
    expect(byId(res.body.checks, 'gemini').detail).toMatch(/GEMINI_API_KEY/);
    expect(res.body.overall).toBe('fail');
  });

  it('fails the analyzer row when local Ollama is unreachable', async () => {
    probeOllamaHealth.mockResolvedValue({ status: 'unreachable', url: '', error: 'down' });
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(byId(res.body.checks, 'analyzer').status).toBe('fail');
  });

  it('warns the analyzer row when the expected model is not pulled', async () => {
    probeOllamaHealth.mockResolvedValue({
      status: 'reachable',
      url: '',
      expectedModel: 'qwen3.5:4b',
      modelPulled: false,
    });
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(byId(res.body.checks, 'analyzer').status).toBe('warn');
  });

  it('fails the ffmpeg row when a binary is missing', async () => {
    probeFfmpeg.mockReturnValue({ ffmpeg: true, ffprobe: false });
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(byId(res.body.checks, 'ffmpeg').status).toBe('fail');
    expect(byId(res.body.checks, 'ffmpeg').detail).toMatch(/ffprobe/);
  });

  it('reflects the disk probe status', async () => {
    probeDiskSpace.mockResolvedValue({ status: 'warn', freeGb: 5, path: '/workspace' });
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(byId(res.body.checks, 'disk').status).toBe('warn');
    expect(byId(res.body.checks, 'disk').detail).toContain('5 GB');
  });

  it('degrades a single throwing probe to a fail row and still returns 200', async () => {
    probeDiskSpace.mockRejectedValue(new Error('statfs blew up'));
    const res = await request(makeApp()).get('/api/diagnostics');
    expect(res.status).toBe(200);
    expect(byId(res.body.checks, 'disk').status).toBe('fail');
    expect(byId(res.body.checks, 'disk').detail).toContain('statfs blew up');
    // The other checks are unaffected.
    expect(byId(res.body.checks, 'sidecar').status).toBe('ok');
  });

  describe('sidecar package-presence checks (engine-retier)', () => {
    it('fails the sidecar row when a standard engine package is missing (sidecar-confirmed)', async () => {
      probeSidecarHealth.mockResolvedValue({
        status: 'reachable',
        url: 'http://localhost:9000',
        proxy: 'sidecar',
        device: 'cuda',
        vramReservedMb: 1024,
        vramTotalMb: 8192,
        qwenLoaded: false,
        qwenPackageInstalled: false,
        kokoroPackageInstalled: true,
      });
      const res = await request(makeApp()).get('/api/diagnostics');
      const sidecar = byId(res.body.checks, 'sidecar');
      expect(sidecar.status).toBe('fail');
      expect(sidecar.detail).toMatch(/qwen/i);
      expect(sidecar.detail).toMatch(/repair/i);
      expect(res.body.overall).toBe('fail');
    });

    it('keeps the sidecar row ok when all standard package booleans are true', async () => {
      probeSidecarHealth.mockResolvedValue({
        status: 'reachable',
        url: 'http://localhost:9000',
        proxy: 'sidecar',
        device: 'cuda',
        vramReservedMb: 1024,
        vramTotalMb: 8192,
        qwenLoaded: true,
        qwenPackageInstalled: true,
        kokoroPackageInstalled: true,
        coquiPackageInstalled: true,
      });
      const res = await request(makeApp()).get('/api/diagnostics');
      const sidecar = byId(res.body.checks, 'sidecar');
      expect(sidecar.status).toBe('ok');
    });

    it('does NOT fail the sidecar row when only the secondary (coqui) package is missing', async () => {
      probeSidecarHealth.mockResolvedValue({
        status: 'reachable',
        url: 'http://localhost:9000',
        proxy: 'sidecar',
        device: 'cuda',
        vramReservedMb: 1024,
        vramTotalMb: 8192,
        qwenPackageInstalled: true,
        kokoroPackageInstalled: true,
        coquiPackageInstalled: false,
      });
      const res = await request(makeApp()).get('/api/diagnostics');
      const sidecar = byId(res.body.checks, 'sidecar');
      expect(sidecar.status).toBe('ok');
    });
  });

  describe('ASR (Whisper) row (srv-31)', () => {
    it('reports off when content-QA ASR is disabled (the default)', async () => {
      /* Default mock omits asrEnabled → ASR is off; never a failure. */
      const res = await request(makeApp()).get('/api/diagnostics');
      const asr = byId(res.body.checks, 'asr');
      expect(asr.status).toBe('ok');
      expect(asr.detail).toMatch(/off/i);
    });

    it('reports enabled · idle · device when ASR is on but not yet resident', async () => {
      probeSidecarHealth.mockResolvedValue({
        status: 'reachable',
        url: '',
        proxy: 'sidecar',
        qwenLoaded: true,
        asrEnabled: true,
        asrLoaded: false,
        asrDevice: 'cpu',
      });
      const res = await request(makeApp()).get('/api/diagnostics');
      const asr = byId(res.body.checks, 'asr');
      expect(asr.status).toBe('ok');
      expect(asr.detail).toBe('enabled · idle · cpu');
    });

    it('reports enabled · resident · device when the Whisper model is loaded', async () => {
      probeSidecarHealth.mockResolvedValue({
        status: 'reachable',
        url: '',
        proxy: 'sidecar',
        qwenLoaded: true,
        asrEnabled: true,
        asrLoaded: true,
        asrDevice: 'cuda',
      });
      const res = await request(makeApp()).get('/api/diagnostics');
      const asr = byId(res.body.checks, 'asr');
      expect(asr.status).toBe('ok');
      expect(asr.detail).toBe('enabled · resident · cuda');
    });

    it('fails the ASR row when the voice engine is unreachable', async () => {
      probeSidecarHealth.mockResolvedValue({
        status: 'unreachable',
        url: '',
        proxy: 'sidecar',
        error: 'connection refused',
      });
      const res = await request(makeApp()).get('/api/diagnostics');
      expect(byId(res.body.checks, 'asr').status).toBe('fail');
    });
  });
});
