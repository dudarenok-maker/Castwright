import { describe, it, expect, afterEach, vi } from 'vitest';
import { deriveEngineArtifact } from './derive-engine-artifact.js';
import { SidecarDesignError } from './design-voice-core.js';

afterEach(() => vi.restoreAllMocks());

function okResponse(pcm: Buffer, sampleRate = 24000, baseModel = 'qwen3-0.6b') {
  return new Response(pcm, {
    status: 200,
    headers: { 'X-Sample-Rate': String(sampleRate), 'X-Base-Model': baseModel },
  });
}

describe('deriveEngineArtifact (qwen)', () => {
  it('POSTs PCM + base64 headers to /qwen/clone-voice and returns preview + baseModel', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse(Buffer.from([1, 2, 3, 4])));
    const res = await deriveEngineArtifact(
      'abc',
      'qwen',
      { masterPcm: Buffer.from([9, 9]), sampleRate: 24000, refText: 'héllo', auditionText: 'audition' },
      { sidecarUrl: 'http://sidecar:9000' },
    );
    expect(res.baseModel).toBe('qwen3-0.6b');
    expect(res.sampleRate).toBe(24000);
    expect(res.previewPcm.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sidecar:9000/qwen/clone-voice');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Voice-Id']).toBe('qwen-abc');
    expect(Buffer.from(headers['X-Ref-Text'], 'base64').toString('utf8')).toBe('héllo');
    expect(Buffer.from(headers['X-Audition-Text'], 'base64').toString('utf8')).toBe('audition');
  });

  it('throws SidecarDesignError preserving the upstream 503', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'no capacity', code: 'gpu_poisoned' }), { status: 503 }),
    );
    await expect(
      deriveEngineArtifact('abc', 'qwen', { masterPcm: Buffer.from([1]), sampleRate: 24000, refText: 't' }),
    ).rejects.toMatchObject({ name: 'SidecarDesignError', status: 503, code: 'gpu_poisoned' });
  });

  it('rejects a non-qwen engine (clean 3c seam)', async () => {
    await expect(
      // @ts-expect-error 3b1 only supports 'qwen'
      deriveEngineArtifact('abc', 'xtts', { masterPcm: Buffer.from([1]), sampleRate: 24000, refText: 't' }),
    ).rejects.toBeInstanceOf(SidecarDesignError);
  });
});
