/* GET /api/ollama/health — sanity checks the probe envelope. The probe
   uses the same 2 s AbortController + same status field shape as the sidecar
   probe, so any change here should mirror the sidecar-health pattern. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  ollamaHealthRouter,
  setOllamaBootstraps,
  _resetOllamaBootstraps,
} from './ollama-health.js';
import { _resetUserSettingsCache } from '../workspace/user-settings.js';
import { InstallBootstrap } from '../ollama/install-bootstrap.js';
import { PullBootstrap } from '../ollama/pull-bootstrap.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ollama', ollamaHealthRouter);
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
  _resetOllamaBootstraps();
});

/* /api/ollama/health now fans out across /api/tags AND /api/ps so the
   probe can tell "pulled" from "resident in VRAM". The mock routes match
   on URL substring so the order of Promise.all resolution doesn't matter. */
function mockOllamaProbes(opts: { tags: Array<{ name: string }>; ps?: Array<{ name: string }> }) {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/api/tags')) {
      return Promise.resolve(new Response(JSON.stringify({ models: opts.tags }), { status: 200 }));
    }
    if (url.endsWith('/api/ps')) {
      return Promise.resolve(
        new Response(JSON.stringify({ models: opts.ps ?? [] }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response('', { status: 404 }));
  });
}

describe('GET /api/ollama/health', () => {
  it('returns reachable with the models array when the daemon answers 200', async () => {
    /* expectedModel mirrors DEFAULT_USER_SETTINGS.defaultAnalysisModel
       via getResolvedOllamaModel; the mocked /api/tags response must
       include that tag for modelPulled to come back true. */
    mockOllamaProbes({
      tags: [{ name: 'qwen3.5:4b' }, { name: 'llama3.1:8b' }],
      ps: [{ name: 'qwen3.5:4b' }],
    });

    const res = await request(makeApp()).get('/api/ollama/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reachable');
    expect(res.body.models).toEqual(['qwen3.5:4b', 'llama3.1:8b']);
    expect(res.body.expectedModel).toBe('qwen3.5:4b');
    expect(res.body.modelPulled).toBe(true);
    expect(res.body.modelResident).toBe(true);
    expect(res.body.resident).toEqual(['qwen3.5:4b']);
  });

  it('separates "pulled" from "resident" — pulled-but-not-loaded must NOT flip the pill to ready', async () => {
    /* This is the regression that surfaced as the "Try Again" loop: the
       Analysing pill was showing green because the model was pulled, but
       it wasn't actually warmed at the analyzer's num_ctx — Ollama
       reloaded mid-request and the SSE died. /api/ps is the source of
       truth for "is the weight actually in VRAM right now". */
    mockOllamaProbes({
      tags: [{ name: 'qwen3.5:4b' }],
      ps: [],
    });

    const res = await request(makeApp()).get('/api/ollama/health');
    expect(res.body.modelPulled).toBe(true);
    expect(res.body.modelResident).toBe(false);
    expect(res.body.resident).toEqual([]);
  });

  it('flags modelPulled=false when the configured model is absent from /api/tags', async () => {
    /* Mock /api/tags returns only llama — the expected qwen3.5:4b isn't
       pulled, so the endpoint should flag modelPulled: false. */
    mockOllamaProbes({ tags: [{ name: 'llama3.1:8b' }], ps: [] });

    const res = await request(makeApp()).get('/api/ollama/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reachable');
    expect(res.body.modelPulled).toBe(false);
  });

  it('returns unreachable when the daemon responds non-2xx', async () => {
    fetchMock.mockResolvedValue(
      new Response('nope', { status: 503, statusText: 'Service Unavailable' }),
    );
    const res = await request(makeApp()).get('/api/ollama/health');
    expect(res.body.status).toBe('unreachable');
    expect(res.body.error).toMatch(/503/);
  });

  it('returns unreachable when fetch rejects (ECONNREFUSED)', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );
    const res = await request(makeApp()).get('/api/ollama/health');
    expect(res.body.status).toBe('unreachable');
  });

  it('returns unreachable with a timeout-specific message when the probe aborts', async () => {
    fetchMock.mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });
    const res = await request(makeApp()).get('/api/ollama/health');
    expect(res.body.status).toBe('unreachable');
    expect(res.body.error).toMatch(/within \d+ms/);
  }, 10_000);
});

describe('POST /api/ollama/load', () => {
  it('POSTs /api/generate with keep_alive: "5m", empty prompt, and the analyzer num_ctx', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    const res = await request(makeApp()).post('/api/ollama/load');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/generate$/),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"keep_alive":"5m"'),
      }),
    );
    /* Empty prompt is the warm-without-generating idiom — without it Ollama
       would actually run inference against the analyzer model. */
    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(init.body);
    expect(body.prompt).toBe('');
    expect(body.stream).toBe(false);
    /* CRITICAL: warming must use the same num_ctx AND num_gpu the
       analyzer's runStage path passes (ANALYZER_NUM_CTX, ANALYZER_NUM_GPU
       in server/src/analyzer/ollama.ts). Either drifting triggers a
       full model reload on the first real analysis call and the SSE
       dies mid-stream — the "Try Again" infinite-loop bug. */
    expect(body.options?.num_ctx).toBe(16384);
    expect(body.options?.num_gpu).toBe(999);
  });

  it('surfaces the upstream error envelope when Ollama returns non-2xx', async () => {
    fetchMock.mockResolvedValue(
      new Response('model not found', { status: 404, statusText: 'Not Found' }),
    );
    const res = await request(makeApp()).post('/api/ollama/load');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toMatch(/404/);
  });

  it('targets the model from the request body when provided, still threading num_ctx/num_gpu', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    const res = await request(makeApp())
      .post('/api/ollama/load')
      .send({ model: 'llama3.1:8b' });

    expect(res.status).toBe(200);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('llama3.1:8b');
    expect(body.keep_alive).toBe('5m');
    expect(body.options?.num_ctx).toBe(16384);
    expect(body.options?.num_gpu).toBe(999);
  });
});

describe('POST /api/ollama/unload', () => {
  it('POSTs /api/generate with keep_alive: 0 and returns {status: unloaded}', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    const res = await request(makeApp()).post('/api/ollama/unload');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unloaded' });
    /* keep_alive: 0 is the documented Ollama idiom for "drop this model from
       VRAM now" — see analyzer/ollama.ts:92 for the equivalent on real chat
       calls. If the literal 0 changes (e.g. to "0s") the eviction stops
       being immediate, which silently breaks auto-evict-before-TTS. */
    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(init.body);
    expect(body.keep_alive).toBe(0);
    expect(body.prompt).toBe('');
  });

  it('returns 503 when Ollama is unreachable', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );
    const res = await request(makeApp()).post('/api/ollama/unload');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
  });
});

/* ============================================================
 * Plan 61 — install / pull / refresh
 * ============================================================ */

describe('GET /api/ollama/detect', () => {
  it('returns installed:true with the version when ollama is on PATH', async () => {
    setOllamaBootstraps({
      install: new InstallBootstrap({
        detectOllama: () => Promise.resolve('ollama version 0.5.4'),
      }),
    });
    const res = await request(makeApp()).get('/api/ollama/detect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ installed: true, version: 'ollama version 0.5.4' });
  });

  it('returns installed:false when ollama is missing', async () => {
    setOllamaBootstraps({
      install: new InstallBootstrap({ detectOllama: () => Promise.resolve(null) }),
    });
    const res = await request(makeApp()).get('/api/ollama/detect');
    expect(res.body).toEqual({ installed: false, version: null });
  });
});

describe('POST /api/ollama/install', () => {
  it('starts a job and returns 202 with the initial snapshot', async () => {
    setOllamaBootstraps({
      install: new InstallBootstrap({
        detectOllama: () => Promise.resolve('ollama version 0.5.4'),
      }),
    });
    const res = await request(makeApp()).post('/api/ollama/install');
    expect(res.status).toBe(202);
    expect(res.body.id).toBeTruthy();
    expect(['detecting', 'installed']).toContain(res.body.status);
  });

  it('GET /api/ollama/install/:id returns 404 for unknown id', async () => {
    setOllamaBootstraps({ install: new InstallBootstrap() });
    const res = await request(makeApp()).get('/api/ollama/install/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('GET /api/ollama/install/:id returns the job snapshot for a real id', async () => {
    setOllamaBootstraps({
      install: new InstallBootstrap({
        detectOllama: () => Promise.resolve('ollama version 0.5.4'),
      }),
    });
    const post = await request(makeApp()).post('/api/ollama/install');
    const id = post.body.id;
    /* short-circuit means it might already be installed */
    await new Promise((r) => setImmediate(r));
    const get = await request(makeApp()).get(`/api/ollama/install/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(id);
  });
});

describe('POST /api/ollama/pull', () => {
  it('400s on missing model body', async () => {
    setOllamaBootstraps({ pull: new PullBootstrap() });
    const res = await request(makeApp())
      .post('/api/ollama/pull')
      .send({})
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model/);
  });

  it('400s on non-allowlisted model tag', async () => {
    setOllamaBootstraps({ pull: new PullBootstrap() });
    const res = await request(makeApp())
      .post('/api/ollama/pull')
      .send({ model: 'evil-narrator:13b' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allowlist/);
  });

  it('starts a pull job and returns 202 with the initial snapshot', async () => {
    /* Stub fetch on the bootstrap so no real Ollama is needed. */
    const fakeFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('{"status":"success"}\n'));
            controller.close();
          },
        }),
        text: () => Promise.resolve(''),
      }),
    );
    setOllamaBootstraps({ pull: new PullBootstrap({ fetchFn: fakeFetch }) });
    const res = await request(makeApp())
      .post('/api/ollama/pull')
      .send({ model: 'qwen3.5:4b' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pulling');
    expect(res.body.model).toBe('qwen3.5:4b');
  });

  it('GET /api/ollama/pull/:id returns 404 for unknown id', async () => {
    setOllamaBootstraps({ pull: new PullBootstrap() });
    const res = await request(makeApp()).get('/api/ollama/pull/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/ollama/refresh', () => {
  it('returns the same envelope as GET /health when the daemon answers', async () => {
    mockOllamaProbes({
      tags: [{ name: 'qwen3.5:4b' }],
      ps: [{ name: 'qwen3.5:4b' }],
    });
    const res = await request(makeApp()).post('/api/ollama/refresh');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reachable');
    expect(res.body.models).toEqual(['qwen3.5:4b']);
    expect(res.body.modelPulled).toBe(true);
    expect(res.body.modelResident).toBe(true);
  });

  it('returns unreachable when the daemon refuses connection', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );
    const res = await request(makeApp()).post('/api/ollama/refresh');
    expect(res.body.status).toBe('unreachable');
  });
});
