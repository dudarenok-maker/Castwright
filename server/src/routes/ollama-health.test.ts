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
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      models: [
        { name: 'qwen3.5:9b' },
        { name: 'mistral:7b' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const res = await request(makeApp()).get('/api/ollama/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reachable');
    expect(res.body.models).toEqual(['qwen3.5:9b', 'mistral:7b']);
    expect(res.body.expectedModel).toBe('qwen3.5:9b');
    expect(res.body.modelPulled).toBe(true);
  });

  it('flags modelPulled=false when the configured model is absent from /api/tags', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: 'mistral:7b' }, { name: 'llama3.1:8b' }],
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
