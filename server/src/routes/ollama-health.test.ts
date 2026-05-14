/* GET /api/ollama/health — sanity checks the probe envelope. The probe
   uses the same 2 s AbortController + same status field shape as the sidecar
   probe, so any change here should mirror the sidecar-health pattern. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ollamaHealthRouter } from './ollama-health.js';
import { _resetUserSettingsCache } from '../workspace/user-settings.js';

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
});

describe('GET /api/ollama/health', () => {
  it('returns reachable with the models array when the daemon answers 200', async () => {
    /* expectedModel mirrors DEFAULT_USER_SETTINGS.defaultAnalysisModel
       via getResolvedOllamaModel; the mocked /api/tags response must
       include that tag for modelPulled to come back true. */
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      models: [
        { name: 'qwen3.5:4b' },
        { name: 'llama3.1:8b' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const res = await request(makeApp()).get('/api/ollama/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reachable');
    expect(res.body.models).toEqual(['qwen3.5:4b', 'llama3.1:8b']);
    expect(res.body.expectedModel).toBe('qwen3.5:4b');
    expect(res.body.modelPulled).toBe(true);
  });

  it('flags modelPulled=false when the configured model is absent from /api/tags', async () => {
    /* Mock /api/tags returns only llama — the expected qwen3.5:4b isn't
       pulled, so the endpoint should flag modelPulled: false. */
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: 'llama3.1:8b' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const res = await request(makeApp()).get('/api/ollama/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reachable');
    expect(res.body.modelPulled).toBe(false);
  });

  it('returns unreachable when the daemon responds non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503, statusText: 'Service Unavailable' }));
    const res = await request(makeApp()).get('/api/ollama/health');
    expect(res.body.status).toBe('unreachable');
    expect(res.body.error).toMatch(/503/);
  });

  it('returns unreachable when fetch rejects (ECONNREFUSED)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    }));
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
  it('POSTs /api/generate with keep_alive: "5m" + empty prompt and returns {status: ready}', async () => {
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
  });

  it('surfaces the upstream error envelope when Ollama returns non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('model not found', { status: 404, statusText: 'Not Found' }));
    const res = await request(makeApp()).post('/api/ollama/load');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toMatch(/404/);
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
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    }));
    const res = await request(makeApp()).post('/api/ollama/unload');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
  });
});
