/* GET /api/sidecar/health + POST /api/sidecar/load + POST /api/sidecar/unload
   + POST /api/sidecar/restart — the proxy surface the in-app Load/Stop pill
   polls and mutates. Mirrors ollama-health.test.ts: stubbed global fetch,
   supertest against a minimal Express app. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sidecarHealthRouter } from './sidecar-health.js';
import { _resetUserSettingsCache, getLastKnownCoquiInstallState } from '../workspace/user-settings.js';
import {
  getLastKnownCoquiVersion,
  _resetLastKnownCoquiVersionForTests,
} from '../tts/coqui-version-state.js';

/* fs-38 Wave 3c Task 19 — the coqui health-poll refresh falls back to the
   Node-side disk probe for cases the wire doesn't settle (no full
   install-state enum on the wire for Coqui, see sidecar-health.ts's
   deriveCoquiInstallState doc). Mocked here so tests can drive it
   deterministically without touching the real filesystem.

   fix round 1 (MINOR-4) — importOriginal-merged, NOT a bare replacement
   object: the real module also exports `coquiModelDir` /
   `coquiPackageInstalled`, and (as of this same round) `sidecar-health.ts`
   itself now imports `coquiWeightsPresent` too — a bare mock silently
   returns `undefined` for any export it doesn't list, which crashes with
   "not a function" the moment the route's import graph reaches it. This is
   the EXACT defect class that broke `ensure-sidecar-vram.test.ts`'s own
   bare `user-settings.js` mock earlier this task. */
vi.mock('../tts/coqui-install-detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/coqui-install-detect.js')>();
  return {
    ...actual,
    detectCoquiInstallStateOnDisk: vi.fn(() => 'not-installed'),
    coquiWeightsPresent: vi.fn(() => false),
  };
});
import { detectCoquiInstallStateOnDisk, coquiWeightsPresent } from '../tts/coqui-install-detect.js';

/* sidecar-supervisor is mocked so restart tests can inject a fake supervisor
   without needing a real sidecar process. vi.mock is hoisted to the module
   top regardless of where it appears in the source file. */
vi.mock('../tts/sidecar-supervisor.js', () => ({
  getActiveSupervisor: vi.fn(() => null),
  registerActiveSupervisor: vi.fn(),
  createSidecarSupervisor: vi.fn(),
}));
import * as supervisorMod from '../tts/sidecar-supervisor.js';

/* #1720 Task 7 — withCapacityRetry is mocked wholesale rather than exercised
   for real (its retry/evict/exhaustion policy is already covered by
   server/src/gpu/capacity-retry.test.ts). The default implementation below
   is a plain passthrough — one doPost call — so every PRE-EXISTING /load
   test in this file keeps exercising exactly the same single-fetch behavior
   it did before this wiring landed. Tests that care about the retry/throw
   wiring itself override the implementation locally. */
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));
import { withCapacityRetry } from '../gpu/capacity-retry.js';
import { NoCapacityError } from '../tts/tts-errors.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sidecar', sidecarHealthRouter);
  return app;
}

const fetchMock = vi.fn();
const mockWithCapacityRetry = vi.mocked(withCapacityRetry);
const mockDetectCoqui = vi.mocked(detectCoquiInstallStateOnDisk);
const mockCoquiWeightsPresent = vi.mocked(coquiWeightsPresent);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  _resetUserSettingsCache();
  mockWithCapacityRetry.mockReset();
  mockWithCapacityRetry.mockImplementation((doPost, opts) => doPost(opts.signal));
  mockDetectCoqui.mockReset();
  mockDetectCoqui.mockReturnValue('not-installed');
  mockCoquiWeightsPresent.mockReset();
  mockCoquiWeightsPresent.mockReturnValue(false);
  _resetLastKnownCoquiVersionForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/sidecar/health', () => {
  it('forwards the new model_loaded / loading / device fields under camelCase keys', async () => {
    /* These fields drive the in-app pill state — drift between snake_case
       on the wire and camelCase on the API would silently break the UI
       even though the upstream is fine. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['coqui'],
          model_loaded: true,
          loading: false,
          device: 'cuda',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reachable');
    expect(res.body.engines).toEqual(['coqui']);
    expect(res.body.modelLoaded).toBe(true);
    expect(res.body.loading).toBe(false);
    expect(res.body.device).toBe('cuda');
  });

  it('forwards asr_loaded / asr_device and injects asrEnabled from SEG_ASR_ENABLED (srv-31)', async () => {
    const prev = process.env.SEG_ASR_ENABLED;
    process.env.SEG_ASR_ENABLED = '1';
    try {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, engines: ['kokoro'], asr_loaded: true, asr_device: 'cuda' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const res = await request(makeApp()).get('/api/sidecar/health');
      expect(res.body.asrEnabled).toBe(true);
      expect(res.body.asrLoaded).toBe(true);
      expect(res.body.asrDevice).toBe('cuda');
    } finally {
      if (prev === undefined) delete process.env.SEG_ASR_ENABLED;
      else process.env.SEG_ASR_ENABLED = prev;
    }
  });

  it('defaults asr fields when the sidecar omits them and ASR is off', async () => {
    const prev = process.env.SEG_ASR_ENABLED;
    delete process.env.SEG_ASR_ENABLED;
    try {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: true, engines: ['kokoro'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const res = await request(makeApp()).get('/api/sidecar/health');
      expect(res.body.asrEnabled).toBe(false);
      expect(res.body.asrLoaded).toBe(false);
      expect(res.body.asrDevice).toBeNull();
    } finally {
      if (prev !== undefined) process.env.SEG_ASR_ENABLED = prev;
    }
  });

  it('coerces missing load-state fields to safe defaults', async () => {
    /* Old sidecar builds (or any third-party that speaks the same wire
       protocol) won't ship the new fields. The proxy must default them
       rather than emit `undefined` — undefined survives JSON and crashes
       the UI's switch statement. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['coqui'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.modelLoaded).toBe(false);
    expect(res.body.loading).toBe(false);
    expect(res.body.device).toBeNull();
    /* Kokoro fields default identically — an older sidecar that doesn't
       report them must not cause the new Kokoro pill to render as
       `undefined` (which the pill state machine treats as a falsy load
       state, but better to coerce explicitly). */
    expect(res.body.kokoroLoaded).toBe(false);
    expect(res.body.kokoroLoading).toBe(false);
  });

  it('forwards the Kokoro per-engine fields as kokoroLoaded / kokoroLoading', async () => {
    /* The new Kokoro pill polls the same /health response. The proxy must
       split the snake_case `kokoro_loaded` / `kokoro_loading` fields out
       to camelCase so the single useTtsLifecycle hook can fan them out
       per engine without a second probe. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['coqui', 'kokoro'],
          model_loaded: false,
          loading: false,
          kokoro_loaded: true,
          kokoro_loading: false,
          device: 'cuda',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.modelLoaded).toBe(false);
    expect(res.body.loading).toBe(false);
    expect(res.body.kokoroLoaded).toBe(true);
    expect(res.body.kokoroLoading).toBe(false);
  });

  it('forwards the Qwen per-engine fields as qwenLoaded / qwenLoading', async () => {
    /* Plan 108: Qwen rides the same /health response as Coqui + Kokoro. The
       proxy must split snake_case `qwen_loaded` / `qwen_loading` out to
       camelCase so the single useTtsLifecycle hook fans them out to the
       Qwen pill without a second probe. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['kokoro', 'qwen'],
          model_loaded: false,
          loading: false,
          kokoro_loaded: true,
          kokoro_loading: false,
          qwen_loaded: true,
          qwen_loading: false,
          device: 'cuda',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.qwenLoaded).toBe(true);
    expect(res.body.qwenLoading).toBe(false);
  });

  it('coerces missing Qwen load-state fields to safe defaults', async () => {
    /* An older sidecar that predates Qwen support must not leave the new
       Qwen pill rendering as `undefined`. Mirror the Kokoro back-compat
       coercion. */
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, engines: ['kokoro'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.qwenLoaded).toBe(false);
    expect(res.body.qwenLoading).toBe(false);
  });

  it('forwards qwen_install_state + the install booleans under camelCase keys', async () => {
    /* Install-state (distinct from load-state) drives the conditional default
       (Qwen-when-installed) + the install-check warning. Wire is snake_case;
       the API surface is camelCase. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['kokoro', 'qwen'],
          qwen_loaded: false,
          qwen_loading: false,
          qwen_package_installed: true,
          qwen_weights_present: true,
          qwen_install_state: 'ready',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.qwenInstallState).toBe('ready');
    expect(res.body.qwenPackageInstalled).toBe(true);
    expect(res.body.qwenWeightsPresent).toBe(true);
  });

  it('normalises a missing/garbage qwen_install_state to "not-installed"', async () => {
    /* An older sidecar omits qwen_install_state entirely. The proxy MUST NOT
       optimistically claim Qwen is usable — a stale build defaulting to
       "ready" would make the conditional default resolve to a Qwen that
       can't synthesise. Absent (and any non-enum value) → "not-installed". */
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, engines: ['kokoro'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const absent = await request(makeApp()).get('/api/sidecar/health');
    expect(absent.body.qwenInstallState).toBe('not-installed');
    expect(absent.body.qwenPackageInstalled).toBe(false);
    expect(absent.body.qwenWeightsPresent).toBe(false);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, qwen_install_state: 'bogus' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const garbage = await request(makeApp()).get('/api/sidecar/health');
    expect(garbage.body.qwenInstallState).toBe('not-installed');
  });

  it('reports qwenInstallState="loaded" when qwen_loaded is true even if qwen_install_state is ABSENT', async () => {
    /* Stale-build incident (2026-05-29): a pre-plan-130 sidecar omits
       qwen_install_state from /health but still reports `qwen_loaded: true`
       (the Base model IS resident and serving). Without honouring qwen_loaded,
       the absent field normalises to "not-installed" on every 30s poll, poisons
       getLastKnownQwenInstallState(), and silently falls every Qwen character
       back to Kokoro. A loaded model can never be "not installed" — the proxy
       MUST report it as usable. Also keeps the forwarded install booleans
       consistent (no "loaded but package=false" contradiction). */
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['kokoro', 'qwen'],
          qwen_loaded: true,
          qwen_loading: false,
          // qwen_install_state / qwen_package_installed / qwen_weights_present absent
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.qwenLoaded).toBe(true);
    expect(res.body.qwenInstallState).toBe('loaded');
    expect(res.body.qwenPackageInstalled).toBe(true);
    expect(res.body.qwenWeightsPresent).toBe(true);
  });

  it('qwen_loaded overrides a downgraded qwen_install_state field', async () => {
    /* Defence in depth: even if a sidecar reports a stale/inconsistent
       qwen_install_state alongside qwen_loaded:true, the loaded model wins. */
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['qwen'],
          qwen_loaded: true,
          qwen_install_state: 'not-installed',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.qwenInstallState).toBe('loaded');
  });

  it('forwards the soft-recycle signal as recyclePending / committedMb', async () => {
    /* side-11 item 2: the generation worker reads `recycle_pending` off this
       same /health poll to trigger a clean boundary recycle. Wire is snake_case;
       the API surface is camelCase. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['qwen'],
          qwen_loaded: true,
          recycle_pending: true,
          committed_mb: 30123.5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.recyclePending).toBe(true);
    expect(res.body.committedMb).toBe(30123.5);
  });

  it('forwards the VRAM figures as vramReservedMb / vramTotalMb (plan 161)', async () => {
    /* The reserved-VRAM recycle reuses `recycle_pending`, so no new boundary
       signal is needed — but the VRAM figures are forwarded for observability. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['qwen'],
          qwen_loaded: true,
          vram_reserved_mb: 7500.25,
          vram_total_mb: 8188,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.vramReservedMb).toBe(7500.25);
    expect(res.body.vramTotalMb).toBe(8188);
  });

  it('defaults recyclePending=false / committedMb=null / VRAM=null for an older sidecar', async () => {
    /* A pre-side-11 sidecar omits all of these. The proxy must coerce so the
       boundary check reads a definite `false` (never recycles on a stale
       build) and the numeric figures are explicit null, not undefined. */
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, engines: ['qwen'], qwen_loaded: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.recyclePending).toBe(false);
    expect(res.body.committedMb).toBeNull();
    expect(res.body.vramReservedMb).toBeNull();
    expect(res.body.vramTotalMb).toBeNull();
  });

  it('returns unreachable when the sidecar responds non-2xx', async () => {
    fetchMock.mockResolvedValue(
      new Response('nope', { status: 503, statusText: 'Service Unavailable' }),
    );
    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.status).toBe('unreachable');
    expect(res.body.error).toMatch(/503/);
  });

  describe('per-engine package-installed forwarding (engine-retier, old-sidecar compat)', () => {
    it('(a) body OMITTING the three fields → coqui/kokoro/whisperPackageInstalled are all undefined', async () => {
      /* An older sidecar that predates the per-engine find_spec probe omits
         coqui_package_installed / kokoro_package_installed / whisper_package_installed.
         The proxy MUST preserve undefined — coercing to false would make the
         Model Manager falsely flag them as "package-missing" on every poll. */
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, engines: ['kokoro', 'qwen'], qwen_loaded: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const res = await request(makeApp()).get('/api/sidecar/health');
      expect(res.body.status).toBe('reachable');
      expect(res.body.coquiPackageInstalled).toBeUndefined();
      expect(res.body.kokoroPackageInstalled).toBeUndefined();
      expect(res.body.whisperPackageInstalled).toBeUndefined();
    });

    it('(b) body with the three fields set to false → each is false', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            engines: ['kokoro'],
            coqui_package_installed: false,
            kokoro_package_installed: false,
            whisper_package_installed: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const res = await request(makeApp()).get('/api/sidecar/health');
      expect(res.body.coquiPackageInstalled).toBe(false);
      expect(res.body.kokoroPackageInstalled).toBe(false);
      expect(res.body.whisperPackageInstalled).toBe(false);
    });

    it('(c) body with the three fields set to true → each is true', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            engines: ['kokoro'],
            coqui_package_installed: true,
            kokoro_package_installed: true,
            whisper_package_installed: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const res = await request(makeApp()).get('/api/sidecar/health');
      expect(res.body.coquiPackageInstalled).toBe(true);
      expect(res.body.kokoroPackageInstalled).toBe(true);
      expect(res.body.whisperPackageInstalled).toBe(true);
    });
  });

  it('forwards qwen_base17_weights_present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, qwen_base17_weights_present: true }), { status: 200 }),
    );
    const { probeSidecarHealth } = await import('./sidecar-health.js');
    const r = await probeSidecarHealth();
    expect(r.qwenBase17WeightsPresent).toBe(true);
  });

  it('tags every response with proxy="sidecar" so the frontend can distinguish Node-layer failures', async () => {
    /* `proxy` is the hop tag the frontend uses to choose between "restart
       Node" and "restart sidecar" recovery copy. The Node layer always
       emits 'sidecar' here — if the failure was on the Vite → Node hop,
       this handler never runs and the frontend tags it 'node' itself. */
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, engines: ['coqui'], model_loaded: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const reachable = await request(makeApp()).get('/api/sidecar/health');
    expect(reachable.body.proxy).toBe('sidecar');

    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));
    const unreachable = await request(makeApp()).get('/api/sidecar/health');
    expect(unreachable.body.proxy).toBe('sidecar');

    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timeout = await request(makeApp()).get('/api/sidecar/health');
    expect(timeout.body.proxy).toBe('sidecar');
  });
});

describe('POST /api/sidecar/load', () => {
  it('forwards the body to the sidecar and returns the {status} payload', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await request(makeApp()).post('/api/sidecar/load').send({ model: 'xtts_v2' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
    /* Critical: the body must actually reach the sidecar so optional
       `model` keys aren't silently dropped. */
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/load$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'xtts_v2' }),
      }),
    );
  });

  it('surfaces the upstream status code + error envelope when the sidecar fails to load', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          error: 'PyTorch missing from this venv',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).post('/api/sidecar/load').send({});
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toMatch(/PyTorch/);
  });

  it('returns 503 + timeout-specific message when fetch raises AbortError', async () => {
    /* The proxy's 90 s budget makes simulating a real timeout infeasible; we
       exercise the same code path by rejecting fetch with an AbortError, which
       is exactly what AbortController.abort() does from the route's setTimeout
       on the real network path. */
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const res = await request(makeApp()).post('/api/sidecar/load').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/did not complete within/);
  });

  it('forwards the engine field through to the sidecar', async () => {
    /* The Kokoro pill posts `{ engine: 'kokoro' }`; the proxy MUST round-
       trip that to the sidecar verbatim, otherwise the sidecar's default
       resolution lands on Coqui and stops the wrong engine. */
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await request(makeApp()).post('/api/sidecar/load').send({ engine: 'kokoro' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/load$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ engine: 'kokoro' }),
      }),
    );
  });

  it('maps a downed-process fetch failure to friendly copy, not the raw "fetch failed"', async () => {
    /* The pill's Load click before the sidecar finishes launching → undici
       rejects with the opaque `TypeError: fetch failed` (real reason in
       `.cause.code`). The proxy must surface something actionable instead of
       leaking that string into the error banner. */
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );
    const res = await request(makeApp()).post('/api/sidecar/load').send({ engine: 'kokoro' });
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toMatch(/voice engine/i);
    expect(res.body.error).toMatch(/starting up|running/i);
    /* The bare undici string must NOT be the whole message (the ECONNREFUSED
       code may still appear in the diagnostic parens). */
    expect(res.body.error).not.toBe('fetch failed');
  });

  it('passes the request body engine through to withCapacityRetry (#1720 Task 7), defaulting to coqui when absent', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await request(makeApp()).post('/api/sidecar/load').send({ engine: 'qwen' });
    expect(mockWithCapacityRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ engine: 'qwen' }),
    );

    await request(makeApp()).post('/api/sidecar/load').send({});
    expect(mockWithCapacityRetry).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ engine: 'coqui' }),
    );
  });

  it('a doPost that returns a noCapacity 503 once then ok succeeds after the (simulated) evict/retry', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ noCapacity: true, neededMb: 2_000, deviceKey: 'cuda:0' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ status: 'ready' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
    });
    // Stand-in mirroring withCapacityRetry's real evict-then-retry contract:
    // retry the SAME doPost once more on a non-ok first response.
    mockWithCapacityRetry.mockImplementation(async (doPost, opts) => {
      const first = await doPost(opts.signal);
      if (first.ok) return first;
      return doPost(opts.signal);
    });

    const res = await request(makeApp()).post('/api/sidecar/load').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
    expect(calls).toBe(2);
  });

  it('a non-noCapacity 503 returned by withCapacityRetry still hits the existing status-passthrough', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'error', error: 'sidecar overloaded' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await request(makeApp()).post('/api/sidecar/load').send({});

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toMatch(/sidecar overloaded/);
  });

  it('maps a thrown NoCapacityError to a capacity-specific 503 message', async () => {
    mockWithCapacityRetry.mockImplementation(async () => {
      throw new NoCapacityError('coqui', 3_000, 'cuda:0');
    });

    const res = await request(makeApp()).post('/api/sidecar/load').send({});

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toMatch(/no capacity/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/sidecar/unload', () => {
  it('returns the sidecar idle envelope and does not retry', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'idle' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await request(makeApp()).post('/api/sidecar/unload');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'idle' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/unload$/),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('forwards the engine field through to the sidecar', async () => {
    /* Kokoro Stop pill sends `{ engine: 'kokoro' }` here. Symmetric with
       /load — without this, the proxy would drop the body and the
       sidecar would default to Coqui, stopping the wrong engine. */
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'idle' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await request(makeApp()).post('/api/sidecar/unload').send({ engine: 'kokoro' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/unload$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ engine: 'kokoro' }),
      }),
    );
  });

  it('returns 503 when the sidecar is unreachable', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );
    const res = await request(makeApp()).post('/api/sidecar/unload');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toMatch(/voice engine/i);
    expect(res.body.error).not.toBe('fetch failed');
  });

  it('reports the unload budget, not the probe budget, when the sidecar never answers', async () => {
    /* Zero wall-clock, fully deterministic, and it pins the constant directly.
       Fails against the wrong implementation: the message quotes 2000ms. */
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    const res = await request(makeApp()).post('/api/sidecar/unload');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('90000ms');
    expect(res.body.error).not.toContain('2000ms');
  });

  it('waits past the 2s probe budget for an unload blocked on a forward', async () => {
    /* #1921: `CoquiEngine.unload()` waits for an in-flight forward, so a Stop
       pressed mid-render takes far longer than PROBE_TIMEOUT_MS. Before the fix
       this aborted at 2s and returned 503 while the model unloaded anyway a
       moment later — the user saw a failure for something that worked.

       The mock MUST honour `init.signal`. The route aborts via the unload
       handler's `AbortController` / `controller.signal` (sidecar-health.ts); a
       mock that ignores the signal lets `controller.abort()` fire into the
       void, the promise resolves anyway, and
       the test passes against the UNFIXED 2s budget. That is the exact placebo
       shape this branch exists to stop shipping. */
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ status: 'idle' }), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                }),
              ),
            2_500,
          );
          init.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const res = await request(makeApp()).post('/api/sidecar/unload');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'idle' });
  }, 10_000);
});

describe('POST /api/sidecar/restart', () => {
  beforeEach(() => {
    (supervisorMod.getActiveSupervisor as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  it('returns 409 when no supervisor is active (autoStart off)', async () => {
    (supervisorMod.getActiveSupervisor as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await request(makeApp()).post('/api/sidecar/restart');
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/No active supervisor/);
  });

  it('returns 409 when the supervisor has no running child', async () => {
    (supervisorMod.getActiveSupervisor as ReturnType<typeof vi.fn>).mockReturnValue({
      current: () => null,
      tripEvent: () => null,
      exhaustedEvent: () => false,
    });
    const res = await request(makeApp()).post('/api/sidecar/restart');
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/No sidecar child/);
  });

  it('returns a distinct 409 (not the generic "will spawn shortly" message) when the supervisor is tripped', async () => {
    /* A code-43 streak trip (Wave 2 §W2.5) also leaves current()===null, but
       with NO respawn coming — this route must not claim one is on the way. */
    (supervisorMod.getActiveSupervisor as ReturnType<typeof vi.fn>).mockReturnValue({
      current: () => null,
      tripEvent: () => ({ card: { uuid: 'GPU-1', idx: 1 }, residentEngines: ['coqui'] }),
    });
    const res = await request(makeApp()).post('/api/sidecar/restart');
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/held down/i);
    expect(res.body.error).not.toMatch(/will spawn shortly/);
  });

  it('kills the current child and returns ok:true once /health responds', async () => {
    /* Fake handle whose kill() resolves immediately */
    const kill = vi.fn(async () => {});
    (supervisorMod.getActiveSupervisor as ReturnType<typeof vi.fn>).mockReturnValue({
      current: () => ({ kill, pid: 999, child: {} }),
    });
    /* First call to fetch (the health poll) succeeds immediately */
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, engines: ['kokoro'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await request(makeApp()).post('/api/sidecar/restart');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('kills the current child even when no health response comes (kill is always called)', async () => {
    /* The long health-poll (60s deadline) is not unit-testable without injecting
       the timeout. This test verifies that kill() is invoked regardless of the
       health-poll outcome. The 503-after-timeout path is an integration concern
       (covered by the real sidecar respawn path in production; the timeout is
       generous — 60s — to cover a cold Coqui boot). */
    const kill = vi.fn(async () => {});
    (supervisorMod.getActiveSupervisor as ReturnType<typeof vi.fn>).mockReturnValue({
      current: () => ({ kill, pid: 999, child: {} }),
    });
    /* Return ok:true on the first health poll so the route resolves promptly. */
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, engines: ['kokoro'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await request(makeApp()).post('/api/sidecar/restart');
    /* kill() MUST be called before the health poll loop. */
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('calls resetAndRespawn and polls health when the supervisor is exhausted (not tripped)', async () => {
    const resetAndRespawn = vi.fn(async () => {});
    (supervisorMod.getActiveSupervisor as ReturnType<typeof vi.fn>).mockReturnValue({
      start: async () => {},
      stop: async () => {},
      current: () => null,
      recycling: () => true,
      tripEvent: () => null,
      exhaustedEvent: () => true,
      resetAndRespawn,
    });
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const res = await request(makeApp()).post('/api/sidecar/restart');

    expect(resetAndRespawn).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('still returns the generic 409 when neither tripped nor exhausted', async () => {
    (supervisorMod.getActiveSupervisor as ReturnType<typeof vi.fn>).mockReturnValue({
      start: async () => {},
      stop: async () => {},
      current: () => null,
      recycling: () => true,
      tripEvent: () => null,
      exhaustedEvent: () => false,
      resetAndRespawn: vi.fn(async () => {}),
    });

    const res = await request(makeApp()).post('/api/sidecar/restart');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/will spawn one shortly/i);
  });
});

describe('GET /api/sidecar/health — per-engine package booleans (Task 8)', () => {
  it('forwards coqui/kokoro/whisper package booleans from the sidecar body', async () => {
    /* Task 8: the sidecar /health body now carries find_spec booleans for
       coqui, kokoro, and whisper. The proxy must forward them as camelCase
       so the inventory (Task 10) can derive "package-missing" per engine
       without an additional probe. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['kokoro', 'coqui'],
          coqui_package_installed: true,
          kokoro_package_installed: false,
          whisper_package_installed: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.status).toBe(200);
    expect(res.body.coquiPackageInstalled).toBe(true);
    expect(res.body.kokoroPackageInstalled).toBe(false);
    expect(res.body.whisperPackageInstalled).toBe(true);
  });

  it('preserves undefined for coqui/kokoro/whisper package booleans when an old sidecar omits them', async () => {
    /* An old sidecar body that predates the per-engine find_spec probe omits
       the three fields. The proxy MUST NOT coerce to false — that would make
       the inventory falsely flag packages as missing even when they ARE on
       disk. undefined is the "unknown" signal; the inventory's pkgInstalled
       helper falls back to the Node disk probe when it sees undefined. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, engines: ['kokoro'] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.coquiPackageInstalled).toBeUndefined();
    expect(res.body.kokoroPackageInstalled).toBeUndefined();
    expect(res.body.whisperPackageInstalled).toBeUndefined();
  });
});

describe('GET /api/sidecar/health — side-14 device fields', () => {
  it('forwards devices + devicesState from the sidecar body', async () => {
    /* side-14 — the sidecar's per-engine device map and probe state must flow
       through the proxy exactly as sent, with snake_case → camelCase for
       devices_state → devicesState. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['kokoro'],
          devices: { kokoro: 'cpu', coqui: 'cpu', qwen: 'mps' },
          devices_state: 'ready',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.status).toBe(200);
    expect(res.body.devices).toEqual({ kokoro: 'cpu', coqui: 'cpu', qwen: 'mps' });
    expect(res.body.devicesState).toBe('ready');
  });

  it('defaults devices to null and devicesState to null on an old sidecar body', async () => {
    /* A sidecar predating side-14 omits both fields entirely. The proxy must
       emit explicit null rather than undefined so the frontend never reads junk. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, engines: ['kokoro'] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.devices).toBeNull();
    expect(res.body.devicesState).toBeNull();
  });

  it('ignores a malformed devices field (non-object) rather than forwarding junk', async () => {
    /* A body with devices: "cuda" (or any non-object) must be coerced to null
       rather than blindly forwarded — the frontend only knows how to render a
       per-engine map, not a bare string. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, engines: ['kokoro'], devices: 'cuda', devices_state: 'ready' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.devices).toBeNull();
  });

  it('nulls a junk per-slot device value while keeping the valid slots', async () => {
    /* Per-slot junk ('gpu' is not a known family) must degrade that slot to
       null without poisoning the rest of the map. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['kokoro'],
          devices: { kokoro: 'gpu', coqui: 'cuda', qwen: null },
          devices_state: 'ready',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.devices).toEqual({ kokoro: null, coqui: 'cuda', qwen: null });
  });

  it('forwards the AMD device families (rocm / directml) (phase 2)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['kokoro'],
          devices: { kokoro: 'directml', coqui: 'rocm', qwen: 'rocm' },
          devices_state: 'ready',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.devices).toEqual({ kokoro: 'directml', coqui: 'rocm', qwen: 'rocm' });
  });

  it('feeds the last-known engine-device cache on a reachable poll', async () => {
    const { getLastKnownEngineDevice, _resetEngineDevicesForTests } = await import(
      '../gpu/engine-device-state.js'
    );
    _resetEngineDevicesForTests();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['kokoro'],
          devices: { kokoro: 'cpu', coqui: 'cuda', qwen: 'mps' },
          devices_state: 'ready',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownEngineDevice('kokoro')).toBe('cpu');
    expect(getLastKnownEngineDevice('coqui')).toBe('cuda');
    expect(getLastKnownEngineDevice('qwen')).toBe('mps');
  });

  it('leaves the engine-device cache untouched on an unreachable poll', async () => {
    const { getLastKnownEngineDevice, _resetEngineDevicesForTests, setLastKnownEngineDevices } =
      await import('../gpu/engine-device-state.js');
    _resetEngineDevicesForTests();
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' });

    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await request(makeApp()).get('/api/sidecar/health');

    expect(getLastKnownEngineDevice('kokoro')).toBe('cuda'); // unchanged
  });
});

describe('GET /api/sidecar/health — coqui install-state refresh (fs-38 Wave 3c Task 19)', () => {
  it('feeds the coqui resolver cache from the disk probe on a reachable poll', async () => {
    mockDetectCoqui.mockReturnValue('weights-missing');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, engines: ['coqui'], model_loaded: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('weights-missing');
    expect(mockDetectCoqui).toHaveBeenCalled();
  });

  it('model_loaded:true overrides the disk probe with "loaded" (same override shape as qwen_loaded)', async () => {
    /* Mirrors deriveQwenInstallState's qwen_loaded override: a resident model
       is the strongest possible proof the engine is usable, so it must win
       even over a disk probe that (e.g. on a non-standard venv layout) can't
       find the weights. */
    mockDetectCoqui.mockReturnValue('not-installed');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, engines: ['coqui'], model_loaded: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('loaded');
  });

  it('leaves the coqui resolver cache untouched on an unreachable poll (same "no downgrade on timeout" rule as qwen)', async () => {
    const { setLastKnownCoquiInstallState } = await import('../workspace/user-settings.js');
    setLastKnownCoquiInstallState('ready');
    mockDetectCoqui.mockReturnValue('not-installed');

    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await request(makeApp()).get('/api/sidecar/health');

    expect(getLastKnownCoquiInstallState()).toBe('ready'); // unchanged
    expect(mockDetectCoqui).not.toHaveBeenCalled();
  });

  it("a reachable poll re-probes disk every time, so an in-process uninstall downgrades the cache (regression guard for the guard itself)", async () => {
    mockDetectCoqui.mockReturnValue('ready');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, engines: ['coqui'], model_loaded: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('ready');

    mockDetectCoqui.mockReturnValue('not-installed');
    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('not-installed');
  });

  it('the qwen install-state refresh behaves identically to before coqui was wired alongside it', async () => {
    /* Regression guard: adding the coqui feed to the same poll handler must
       not perturb qwen's own derivation/caching. */
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, engines: ['qwen'], qwen_loaded: true, qwen_install_state: 'not-installed' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.qwenInstallState).toBe('loaded');

    const { getLastKnownQwenInstallState } = await import('../workspace/user-settings.js');
    expect(getLastKnownQwenInstallState()).toBe('loaded');
  });
});

describe('GET /api/sidecar/health — coqui install-state trusts the wire (fs-38 Wave 3c Task 19 fix round 1, IMPORTANT-1)', () => {
  it('coqui_package_installed: false is "not-installed" immediately, no disk probe at all', async () => {
    mockDetectCoqui.mockReturnValue('ready'); // if this got called, the test below would still pass by accident — it must NOT be called
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, engines: ['coqui'], model_loaded: false, coqui_package_installed: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('not-installed');
    expect(mockDetectCoqui).not.toHaveBeenCalled();
    expect(mockCoquiWeightsPresent).not.toHaveBeenCalled();
  });

  it('coqui_package_installed: true + coqui_weights_present ABSENT (a sidecar that has the former field but not the latter) falls back to the LOCAL weights-only probe → "ready"', async () => {
    mockCoquiWeightsPresent.mockReturnValue(true);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, engines: ['coqui'], model_loaded: false, coqui_package_installed: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('ready');
    expect(mockCoquiWeightsPresent).toHaveBeenCalled();
    expect(mockDetectCoqui).not.toHaveBeenCalled(); // the wire already settled the package half
  });

  it('coqui_package_installed: true + coqui_weights_present ABSENT + weights absent locally (fallback path) → "weights-missing"', async () => {
    mockCoquiWeightsPresent.mockReturnValue(false);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, engines: ['coqui'], model_loaded: false, coqui_package_installed: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('weights-missing');
  });

  it('Task 20 fix round 1 (IMPORTANT-1) — coqui_weights_present: true on the wire is trusted directly; the LOCAL probe is never called (the remote-sidecar case)', async () => {
    mockCoquiWeightsPresent.mockReturnValue(false); // if this got read, the test would read weights-missing instead
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['coqui'],
          model_loaded: false,
          coqui_package_installed: true,
          coqui_weights_present: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('ready');
    expect(mockCoquiWeightsPresent).not.toHaveBeenCalled(); // wire settled it — no local stat at all
    expect(mockDetectCoqui).not.toHaveBeenCalled();
  });

  it('Task 20 fix round 1 (IMPORTANT-1) — coqui_weights_present: false on the wire is trusted directly, even when the LOCAL probe would disagree', async () => {
    mockCoquiWeightsPresent.mockReturnValue(true); // if this got read, the test would read ready instead
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['coqui'],
          model_loaded: false,
          coqui_package_installed: true,
          coqui_weights_present: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('weights-missing');
    expect(mockCoquiWeightsPresent).not.toHaveBeenCalled();
    expect(mockDetectCoqui).not.toHaveBeenCalled();
  });

  it('coqui_package_installed absent (older sidecar) falls back to the FULL local disk probe, unchanged from before this fix', async () => {
    mockDetectCoqui.mockReturnValue('weights-missing');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, engines: ['coqui'], model_loaded: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('weights-missing');
    expect(mockDetectCoqui).toHaveBeenCalled();
    expect(mockCoquiWeightsPresent).not.toHaveBeenCalled(); // the full-probe path never calls this one directly
  });

  it('model_loaded: true still overrides even when coqui_package_installed: false is ALSO present (contradictory sidecar body)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, engines: ['coqui'], model_loaded: true, coqui_package_installed: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiInstallState()).toBe('loaded');
  });
});

describe('GET /api/sidecar/health — coqui_version oracle (fs-38 Wave 3c Task 19)', () => {
  it('forwards coqui_version as coquiVersion and feeds getLastKnownCoquiVersion() on a reachable poll', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, engines: ['coqui'], coqui_version: '0.27.5' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.coquiVersion).toBe('0.27.5');
    expect(getLastKnownCoquiVersion()).toBe('0.27.5');
  });

  it("normalises a missing/null coqui_version (older sidecar, or the sidecar's own resolution failure) to ''", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, engines: ['coqui'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const absent = await request(makeApp()).get('/api/sidecar/health');
    expect(absent.body.coquiVersion).toBe('');
    expect(getLastKnownCoquiVersion()).toBe('');

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, engines: ['coqui'], coqui_version: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const nullVersion = await request(makeApp()).get('/api/sidecar/health');
    expect(nullVersion.body.coquiVersion).toBe('');
  });

  it('leaves the cached coqui version untouched on an unreachable poll (same "no downgrade on timeout" rule as every other cache this route feeds)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, engines: ['coqui'], coqui_version: '0.27.5' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiVersion()).toBe('0.27.5');

    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownCoquiVersion()).toBe('0.27.5'); // unchanged
  });
});
