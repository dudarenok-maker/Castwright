/* GET /api/sidecar/health + POST /api/sidecar/load + POST /api/sidecar/unload —
   the proxy surface the in-app Load/Stop pill polls and mutates. Mirrors
   ollama-health.test.ts: stubbed global fetch, supertest against a minimal
   Express app. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sidecarHealthRouter } from './sidecar-health.js';
import { _resetUserSettingsCache } from '../workspace/user-settings.js';

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
  });
});
