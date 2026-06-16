/* GET /api/sidecar/health + POST /api/sidecar/load + POST /api/sidecar/unload
   + POST /api/sidecar/restart — the proxy surface the in-app Load/Stop pill
   polls and mutates. Mirrors ollama-health.test.ts: stubbed global fetch,
   supertest against a minimal Express app. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sidecarHealthRouter } from './sidecar-health.js';
import { _resetUserSettingsCache } from '../workspace/user-settings.js';

/* sidecar-supervisor is mocked so restart tests can inject a fake supervisor
   without needing a real sidecar process. vi.mock is hoisted to the module
   top regardless of where it appears in the source file. */
vi.mock('../tts/sidecar-supervisor.js', () => ({
  getActiveSupervisor: vi.fn(() => null),
  registerActiveSupervisor: vi.fn(),
  createSidecarSupervisor: vi.fn(),
}));
import * as supervisorMod from '../tts/sidecar-supervisor.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sidecar', sidecarHealthRouter);
  return app;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  _resetUserSettingsCache();
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
    });
    const res = await request(makeApp()).post('/api/sidecar/restart');
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/No sidecar child/);
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

  it('defaults coqui/kokoro/whisper package booleans to false when an old sidecar omits them', async () => {
    /* An old sidecar body that predates Task 7 omits the three fields.
       The proxy must default to false (never optimistically claim a package
       is installed) so the inventory reads a safe, definite value. */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, engines: ['kokoro'] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await request(makeApp()).get('/api/sidecar/health');
    expect(res.body.coquiPackageInstalled).toBe(false);
    expect(res.body.kokoroPackageInstalled).toBe(false);
    expect(res.body.whisperPackageInstalled).toBe(false);
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
});
