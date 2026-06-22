/* embedSegment (srv-36) — transport for the sidecar's /embed endpoint (render-integrity ECAPA embeddings).
 *
 * The embed client posts raw PCM via bare fetch (CPU-bound embed is sub-second;
 * no special timeout handling needed). Mocks the global `fetch` and asserts:
 *   - raw PCM body + X-Sample-Rate + content-type: audio/L16 reach /embed,
 *   - the JSON response embedding array is converted to a Float32Array(192).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  getResolvedSidecarUrl: vi.fn(() => 'http://sidecar.test:9000'),
}));

import { embedSegment } from './embed-client.js';

const PCM = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);

afterEach(() => {
  vi.clearAllMocks();
});

describe('embedSegment', () => {
  it('posts raw PCM with X-Sample-Rate and parses the vector', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ embedding: Array(192).fill(0.1), dim: 192, sample_rate: 16000 }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const out = await embedSegment(PCM, 24000);

    expect(out).toHaveLength(192);
    expect(calls[0].init.headers['x-sample-rate']).toBe('24000');
    expect(calls[0].init.headers['content-type']).toContain('audio/L16');
    expect(calls[0].url).toBe('http://sidecar.test:9000/embed');
    expect(calls[0].init.body).toBe(PCM);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', async () => new Response('error', { status: 500 }));
    await expect(embedSegment(PCM, 24000)).rejects.toThrow(/\/embed 500/);
  });
});
