/* Integration tests for GET /api/config, PUT /api/config, POST /api/config/reset,
   and the prompt endpoints (GET/PUT /api/config/prompts/:id,
   POST /api/config/prompts/:id/reset).

   Test isolation: we point USER_SETTINGS_FILE at a throwaway temp file (same
   approach as user-settings.test.ts) so writes never touch real settings, then
   call _resetUserSettingsCache() between tests so the in-process cache is
   cold on every run. The configRouter import is dynamic (after env is set) to
   ensure the module's singleton import of user-settings sees the temp path.
   CASTWRIGHT_PROMPTS_DIR is also overridden so fork files land in the temp dir. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let settingsPath: string;
let app: Express;
let resetCache: () => void;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-config-route-test-'));
  settingsPath = join(workspaceRoot, 'user-settings.json');
  process.env.USER_SETTINGS_FILE = settingsPath;
  process.env.CASTWRIGHT_PROMPTS_DIR = join(workspaceRoot, 'prompts');

  // Import AFTER setting env so user-settings.ts resolves to the temp path
  const [{ configRouter }, us] = await Promise.all([
    import('./config.js'),
    import('../workspace/user-settings.js'),
  ]);

  resetCache = us._resetUserSettingsCache;

  app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.USER_SETTINGS_FILE;
  delete process.env.CASTWRIGHT_PROMPTS_DIR;
  delete process.env.STAGE2_MIN_COVERAGE;
});

beforeEach(() => {
  // Wipe settings file and cache so each test starts fresh
  if (settingsPath && existsSync(settingsPath)) {
    rmSync(settingsPath, { force: true });
  }
  resetCache?.();
  delete process.env.STAGE2_MIN_COVERAGE;
});

describe('GET /api/config', () => {
  it('returns groups + descriptors + values', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.groups)).toBe(true);
    expect(res.body.descriptors.length).toBeGreaterThan(20);
    expect(res.body.values['analyzer.stage2.minCoverage'].effective).toBeDefined();
    expect(res.body.values['GEMINI_API_KEY']).toBeUndefined(); // secret never present
  });

  it('prompts are excluded from values', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    // Prompt keys have isPrompt=true — resolver skips them
    expect(res.body.values['prompt.castDetection']).toBeUndefined();
  });

  it('restartPending is false by default', async () => {
    const res = await request(app).get('/api/config');
    expect(res.body.restartPending).toBe(false);
  });
});

describe('PUT /api/config', () => {
  it('validates range and rejects out-of-bounds', async () => {
    const ok = await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    expect(ok.status).toBe(200);
    const bad = await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 9 });
    expect(bad.status).toBe(400);
  });

  it('PUT rejects an env-locked key with 409', async () => {
    process.env.STAGE2_MIN_COVERAGE = '0.7';
    const res = await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    expect(res.status).toBe(409);
    delete process.env.STAGE2_MIN_COVERAGE;
  });

  it('PUT rejects an unknown key with 400', async () => {
    const res = await request(app).put('/api/config').send({ 'no.such.knob': 1 });
    expect(res.status).toBe(400);
  });

  it('PUT rejects a prompt key with 400', async () => {
    const res = await request(app).put('/api/config').send({ 'prompt.castDetection': 'some-path.md' });
    expect(res.status).toBe(400);
  });

  it('PUT applies and reflects override in values', async () => {
    const res = await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.applied).toContain('analyzer.stage2.minCoverage');
    expect(res.body.values['analyzer.stage2.minCoverage'].effective).toBe(0.5);
    expect(res.body.values['analyzer.stage2.minCoverage'].overridden).toBe(true);
  });
});

describe('POST /api/config/reset', () => {
  it('reset by key clears the override', async () => {
    await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    const res = await request(app).post('/api/config/reset').send({ keys: ['analyzer.stage2.minCoverage'] });
    expect(res.status).toBe(200);
    const after = await request(app).get('/api/config');
    expect(after.body.values['analyzer.stage2.minCoverage'].overridden).toBe(false);
  });

  it('reset by group clears all overrides in that group', async () => {
    await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    await request(app).put('/api/config').send({ 'analyzer.stage2.maxCoverage': 2.0 });
    const res = await request(app).post('/api/config/reset').send({ group: 'analyzer-chunking' });
    expect(res.status).toBe(200);
    const after = await request(app).get('/api/config');
    expect(after.body.values['analyzer.stage2.minCoverage'].overridden).toBe(false);
    expect(after.body.values['analyzer.stage2.maxCoverage'].overridden).toBe(false);
  });

  it('reset all clears every override', async () => {
    await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    const res = await request(app).post('/api/config/reset').send({ all: true });
    expect(res.status).toBe(200);
    const after = await request(app).get('/api/config');
    expect(after.body.values['analyzer.stage2.minCoverage'].overridden).toBe(false);
  });

  it('reset with no spec returns 400', async () => {
    const res = await request(app).post('/api/config/reset').send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/config/prompts/:id', () => {
  it('returns the shipped default before any fork', async () => {
    const res = await request(app).get('/api/config/prompts/prompt.sentenceAttribution');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('prompt.sentenceAttribution');
    expect(res.body.isForked).toBe(false);
    expect(typeof res.body.text).toBe('string');
    expect(res.body.text.length).toBeGreaterThan(0);
    expect(res.body.text).toBe(res.body.defaultText);
  });

  it('returns 404 for an unknown prompt id', async () => {
    const res = await request(app).get('/api/config/prompts/prompt.doesNotExist');
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/config/prompts/:id', () => {
  it('fork via PUT then GET shows isForked:true with the forked text', async () => {
    const putRes = await request(app)
      .put('/api/config/prompts/prompt.castDetection')
      .send({ text: 'MY FORKED PROMPT TEXT' });
    expect(putRes.status).toBe(200);
    expect(putRes.body.ok).toBe(true);
    expect(putRes.body.isForked).toBe(true);
    expect(putRes.body.text).toBe('MY FORKED PROMPT TEXT');

    const getRes = await request(app).get('/api/config/prompts/prompt.castDetection');
    expect(getRes.status).toBe(200);
    expect(getRes.body.isForked).toBe(true);
    expect(getRes.body.text).toBe('MY FORKED PROMPT TEXT');
  });

  it('PUT returns 404 for unknown id', async () => {
    const res = await request(app)
      .put('/api/config/prompts/prompt.nope')
      .send({ text: 'something' });
    expect(res.status).toBe(404);
  });

  it('PUT returns 400 when text is missing', async () => {
    const res = await request(app)
      .put('/api/config/prompts/prompt.castDetection')
      .send({});
    expect(res.status).toBe(400);
  });

  it('PUT returns 400 when text is empty string', async () => {
    const res = await request(app)
      .put('/api/config/prompts/prompt.castDetection')
      .send({ text: '' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/config — device knob UUID translation (Plan 2 §2.1)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Mirrors gpu-devices.test.ts's fetch-stub convention: this file has no
  // existing device-knob test / mock plumbing to reuse, and writeConfigOverride
  // here is the REAL file-backed implementation (no mock) — so we assert the
  // persisted value via readConfigOverrides() rather than a spy.
  function mockGpuDevices(devices: Array<{ uuid: string; idx: number; name?: string; total_mb?: number; free_mb?: number }>) {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ devices, cpu: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  it('translates a cuda:N write into cuda-uuid:<uuid> before persisting', async () => {
    mockGpuDevices([{ uuid: 'GPU-1', idx: 1, name: 'x', total_mb: 16000, free_mb: 14000 }]);
    const res = await request(app).put('/api/config').send({ 'tts.qwen.device': 'cuda:1' });
    expect(res.status).toBe(200);
    const { readConfigOverrides } = await import('../workspace/user-settings.js');
    expect(readConfigOverrides()['tts.qwen.device']).toBe('cuda-uuid:GPU-1');
  });

  it('stores the raw cuda:N when the sidecar device list has no match yet (reconciled on next read)', async () => {
    mockGpuDevices([]);
    const res = await request(app).put('/api/config').send({ 'tts.qwen.device': 'cuda:9' });
    expect(res.status).toBe(200);
    const { readConfigOverrides } = await import('../workspace/user-settings.js');
    expect(readConfigOverrides()['tts.qwen.device']).toBe('cuda:9');
  });

  it('leaves auto/cpu/mps values untouched', async () => {
    const res = await request(app).put('/api/config').send({ 'tts.qwen.device': 'auto' });
    expect(res.status).toBe(200);
    const { readConfigOverrides } = await import('../workspace/user-settings.js');
    expect(readConfigOverrides()['tts.qwen.device']).toBe('auto');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /* issue #1225 — a PUT patching all three tts.*.device knobs in one body
     used to pay one sidecar /devices round-trip PER key (3 total) via
     toUuidForm's own unconditional fetch. The handler now resolves the
     list once for the whole request. */
  it('fetches the sidecar device list once for a PUT patching multiple device knobs', async () => {
    mockGpuDevices([
      { uuid: 'GPU-0', idx: 0, name: 'a', total_mb: 8000, free_mb: 6000 },
      { uuid: 'GPU-1', idx: 1, name: 'b', total_mb: 16000, free_mb: 14000 },
    ]);
    const res = await request(app).put('/api/config').send({
      'tts.qwen.device': 'cuda:1',
      'tts.coqui.device': 'cuda:0',
      'tts.kokoro.device': 'cuda:1',
    });
    expect(res.status).toBe(200);
    const { readConfigOverrides } = await import('../workspace/user-settings.js');
    expect(readConfigOverrides()['tts.qwen.device']).toBe('cuda-uuid:GPU-1');
    expect(readConfigOverrides()['tts.coqui.device']).toBe('cuda-uuid:GPU-0');
    expect(readConfigOverrides()['tts.kokoro.device']).toBe('cuda-uuid:GPU-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fetch the sidecar device list when the patch has no device knob', async () => {
    const res = await request(app).put('/api/config').send({ 'analyzer.engine': 'local' });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /* Code-review on #1227 found a real fail-fast regression: an earlier draft
     pre-scanned the whole patch and fetched the sidecar device list BEFORE
     the per-key validation loop, so a patch with an unrelated invalid key
     ahead of a device key paid the sidecar round-trip even though it was
     always going to 400 on the earlier key. The fetch is now lazy, inside
     the loop, so an earlier failing key returns before it's ever reached. */
  it('returns 400 on an earlier invalid key without fetching the sidecar device list', async () => {
    mockGpuDevices([{ uuid: 'GPU-1', idx: 1, name: 'x', total_mb: 16000, free_mb: 14000 }]);
    const res = await request(app)
      .put('/api/config')
      .send({ bogus_key: 'x', 'tts.qwen.device': 'cuda:1' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* Mandatory PR code-review (#1224) found a real cold-start race: resolveAll()
   -> resolveKnob() reconciles a stored 'cuda-uuid:<uuid>' override against
   getLastKnownGpuDevices()'s cache SYNCHRONOUSLY, but that cache is only ever
   warmed by GET /api/gpu/devices's own handler (or a PUT's toUuidForm). On a
   fresh boot, AdvancedView's mount effect fires fetchConfig() and
   getGpuDevices() concurrently with no ordering — GET /api/config is a
   synchronous local computation and routinely resolves BEFORE the sidecar
   round-trip GET /api/gpu/devices needs, so a perfectly valid uuid pin got
   mislabeled staleReason:'uuid_unresolved' ("card no longer found") on the
   very first Advanced Settings load after a restart. Fixed by having GET /
   warm the cache itself (a no-op once anything else already has). */
describe('GET /api/config — warms the device-list cache before resolving (cold-start race)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not report uuid_unresolved for a valid pin when the cache starts cold', async () => {
    const { setLastKnownGpuDevices } = await import('../gpu/gpu-device-list-state.js');
    const { writeConfigOverride } = await import('../workspace/user-settings.js');

    // Simulate a pin already persisted from a PRIOR session (survives a restart).
    await writeConfigOverride('tts.qwen.device', 'cuda-uuid:GPU-1');
    // Simulate a fresh boot: the cache hasn't been warmed by anything yet.
    setLastKnownGpuDevices([]);
    // The sidecar (reached fresh by this route's own warm-up) reports the card is real.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          devices: [{ uuid: 'GPU-1', idx: 1, name: 'x', total_mb: 16000, free_mb: 14000 }],
          cpu: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    expect(res.body.values['tts.qwen.device'].staleReason).toBeUndefined();
    expect(res.body.values['tts.qwen.device'].effective).toBe('cuda:1');
  });

  it('skips the sidecar round-trip when the cache is already warm', async () => {
    const { setLastKnownGpuDevices } = await import('../gpu/gpu-device-list-state.js');
    const { writeConfigOverride } = await import('../workspace/user-settings.js');

    await writeConfigOverride('tts.qwen.device', 'cuda-uuid:GPU-1');
    setLastKnownGpuDevices([{ uuid: 'GPU-1', idx: 1 }]);

    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.body.values['tts.qwen.device'].effective).toBe('cuda:1');
  });

  it('still reports uuid_unresolved when the sidecar is genuinely unreachable', async () => {
    const { setLastKnownGpuDevices } = await import('../gpu/gpu-device-list-state.js');
    const { writeConfigOverride } = await import('../workspace/user-settings.js');

    await writeConfigOverride('tts.qwen.device', 'cuda-uuid:GPU-1');
    setLastKnownGpuDevices([]);
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );

    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.values['tts.qwen.device'].staleReason).toBe('uuid_unresolved');
  });
});

describe('POST /api/config/prompts/:id/reset', () => {
  it('fork then reset clears the fork — GET shows isForked:false', async () => {
    // Fork it first.
    await request(app)
      .put('/api/config/prompts/prompt.emotionAnnotation')
      .send({ text: 'FORKED' });
    let getRes = await request(app).get('/api/config/prompts/prompt.emotionAnnotation');
    expect(getRes.body.isForked).toBe(true);

    // Reset.
    const resetRes = await request(app).post(
      '/api/config/prompts/prompt.emotionAnnotation/reset',
    );
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.ok).toBe(true);
    expect(resetRes.body.isForked).toBe(false);

    // GET after reset should be unforked.
    getRes = await request(app).get('/api/config/prompts/prompt.emotionAnnotation');
    expect(getRes.status).toBe(200);
    expect(getRes.body.isForked).toBe(false);
  });

  it('reset returns 404 for unknown id', async () => {
    const res = await request(app).post('/api/config/prompts/prompt.nope/reset');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/config — CUDA env-shadow surfacing (Plan 2 §2.5)', () => {
  const prevCVD = process.env.CUDA_VISIBLE_DEVICES;
  const prevCDO = process.env.CUDA_DEVICE_ORDER;
  afterEach(() => {
    if (prevCVD === undefined) delete process.env.CUDA_VISIBLE_DEVICES; else process.env.CUDA_VISIBLE_DEVICES = prevCVD;
    if (prevCDO === undefined) delete process.env.CUDA_DEVICE_ORDER; else process.env.CUDA_DEVICE_ORDER = prevCDO;
  });

  it('reports cudaEnvShadow true when CUDA_VISIBLE_DEVICES is set', async () => {
    process.env.CUDA_VISIBLE_DEVICES = '1,0';
    delete process.env.CUDA_DEVICE_ORDER;
    const res = await request(app).get('/api/config');
    expect(res.body.cudaEnvShadow).toBe(true);
  });

  it('reports cudaEnvShadow false when neither var is set', async () => {
    delete process.env.CUDA_VISIBLE_DEVICES;
    delete process.env.CUDA_DEVICE_ORDER;
    const res = await request(app).get('/api/config');
    expect(res.body.cudaEnvShadow).toBe(false);
  });
});
