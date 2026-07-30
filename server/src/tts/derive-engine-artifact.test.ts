import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* Task 15 — withCapacityRetry is mocked wholesale (mirrors embed-client.test.ts
   / transcribe-client.test.ts): the retry/evict/exhaustion policy itself is
   already covered by gpu/capacity-retry.test.ts. What THIS file needs to pin
   is the WIRING — deriveEngineArtifact reserves capacity against the ACTUAL
   engine being derived ('qwen' or 'coqui'), not a hardcoded literal (the
   3b1-era bug this task fixes: a hardcoded 'qwen' would reserve the wrong
   footprint and mis-place admission on a multi-GPU box for a coqui derive).
   The default implementation below just calls through to `doPost` so the
   existing transport-shape tests (headers/target/response-mapping) don't
   need to know about capacity retry at all. */
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));

import { deriveEngineArtifact } from './derive-engine-artifact.js';
import { SidecarDesignError } from './design-voice-core.js';
import { withCapacityRetry } from '../gpu/capacity-retry.js';

const mockWithCapacityRetry = vi.mocked(withCapacityRetry);

beforeEach(() => {
  mockWithCapacityRetry.mockImplementation((doPost, opts) => doPost(opts.signal));
});

afterEach(() => {
  vi.restoreAllMocks();
  mockWithCapacityRetry.mockReset();
});

function okResponse(pcm: Buffer, headers: Record<string, string>) {
  return new Response(pcm, { status: 200, headers });
}

describe('deriveEngineArtifact (qwen)', () => {
  it('POSTs PCM + base64 headers to /qwen/clone-voice, reserves capacity as "qwen", and returns preview + baseModel', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        okResponse(Buffer.from([1, 2, 3, 4]), { 'X-Sample-Rate': '24000', 'X-Base-Model': 'qwen3-0.6b' }),
      );
    const res = await deriveEngineArtifact(
      'abc',
      'qwen',
      { masterPcm: Buffer.from([9, 9]), sampleRate: 24000, refText: 'héllo', auditionText: 'audition' },
      { sidecarUrl: 'http://sidecar:9000' },
    );
    expect(res.baseModel).toBe('qwen3-0.6b');
    expect(res.coquiVersion).toBeUndefined();
    expect(res.modelId).toBeUndefined();
    expect(res.sampleRate).toBe(24000);
    expect(res.previewPcm.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sidecar:9000/qwen/clone-voice');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Voice-Id']).toBe('qwen-abc');
    expect(Buffer.from(headers['X-Ref-Text'], 'base64').toString('utf8')).toBe('héllo');
    expect(Buffer.from(headers['X-Audition-Text'], 'base64').toString('utf8')).toBe('audition');

    expect(mockWithCapacityRetry.mock.calls[0][1]).toMatchObject({ engine: 'qwen' });
  });

  it('throws SidecarDesignError preserving the upstream 503', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'no capacity', code: 'gpu_poisoned' }), { status: 503 }),
    );
    await expect(
      deriveEngineArtifact('abc', 'qwen', { masterPcm: Buffer.from([1]), sampleRate: 24000, refText: 't' }),
    ).rejects.toMatchObject({ name: 'SidecarDesignError', status: 503, code: 'gpu_poisoned' });
  });

  it('rejects a qwen derive missing refText with a 400, before ever reaching the sidecar', async () => {
    const spy = vi.spyOn(global, 'fetch');
    await expect(
      deriveEngineArtifact('abc', 'qwen', { masterPcm: Buffer.from([1]), sampleRate: 24000 }),
    ).rejects.toMatchObject({ name: 'SidecarDesignError', status: 400 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('deriveEngineArtifact (coqui)', () => {
  it('POSTs PCM to /xtts/clone-voice with X-Voice-Id "xtts-<uuid>" and NO X-Ref-Text, reserves capacity as "coqui", and maps coquiVersion/modelId (baseModel left undefined)', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      okResponse(Buffer.from([5, 6, 7, 8]), {
        'X-Sample-Rate': '24000',
        'X-Coqui-Version': 'v2.0.3',
        'X-Model-Id': 'tts_models/multilingual/multi-dataset/xtts_v2',
      }),
    );
    const res = await deriveEngineArtifact(
      'u1',
      'coqui',
      { masterPcm: Buffer.from([9, 9]), sampleRate: 24000, auditionText: 'audition' },
      { sidecarUrl: 'http://sidecar:9000' },
    );
    expect(res.coquiVersion).toBe('v2.0.3');
    expect(res.modelId).toBe('tts_models/multilingual/multi-dataset/xtts_v2');
    expect(res.baseModel).toBeUndefined();
    expect(res.sampleRate).toBe(24000);
    expect(res.previewPcm.equals(Buffer.from([5, 6, 7, 8]))).toBe(true);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sidecar:9000/xtts/clone-voice');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Voice-Id']).toBe('xtts-u1');
    expect(headers['X-Ref-Text']).toBeUndefined();
    expect(Buffer.from(headers['X-Audition-Text'], 'base64').toString('utf8')).toBe('audition');

    expect(mockWithCapacityRetry.mock.calls[0][1]).toMatchObject({ engine: 'coqui' });
  });

  it('does not require refText for a coqui derive', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(okResponse(Buffer.from([1]), { 'X-Sample-Rate': '24000' }));
    await expect(
      deriveEngineArtifact('u1', 'coqui', { masterPcm: Buffer.from([1]), sampleRate: 24000 }),
    ).resolves.toMatchObject({ sampleRate: 24000 });
  });
});

describe('deriveEngineArtifact (engine validation)', () => {
  it('rejects a non-clone-capable engine with a 400', async () => {
    const spy = vi.spyOn(global, 'fetch');
    await expect(
      // @ts-expect-error 'kokoro' is a real TtsEngine but not clone-capable
      deriveEngineArtifact('abc', 'kokoro', { masterPcm: Buffer.from([1]), sampleRate: 24000, refText: 't' }),
    ).rejects.toBeInstanceOf(SidecarDesignError);
    await expect(
      // @ts-expect-error same as above
      deriveEngineArtifact('abc', 'kokoro', { masterPcm: Buffer.from([1]), sampleRate: 24000, refText: 't' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
  });
});

/* #1951 — the clone's own manifest language. Without `X-Language` the sidecar
   computes `lang = DEFAULT_LANGUAGE`, which is why every cloned voice's
   manifest has always read "English" — mislabelling the voice in the library
   and making the wizard's completion audition speak the wrong language. */
describe('deriveEngineArtifact — X-Language (#1951)', () => {
  function headersOf(spy: ReturnType<typeof vi.spyOn>) {
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    return init.headers as Record<string, string>;
  }

  it('sends X-Language on a qwen derive when input.language is set', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse(Buffer.from([1]), { 'X-Sample-Rate': '24000' }));
    await deriveEngineArtifact(
      'abc',
      'qwen',
      { masterPcm: Buffer.from([9]), sampleRate: 24000, refText: 't', language: 'German' },
      { sidecarUrl: 'http://sidecar:9000' },
    );
    expect(headersOf(spy)['X-Language']).toBe('German');
  });

  it('sends X-Language on a coqui derive too (the sidecar reads it on both branches)', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse(Buffer.from([1]), { 'X-Sample-Rate': '24000' }));
    await deriveEngineArtifact(
      'u1',
      'coqui',
      { masterPcm: Buffer.from([9]), sampleRate: 24000, language: 'German' },
      { sidecarUrl: 'http://sidecar:9000' },
    );
    expect(headersOf(spy)['X-Language']).toBe('German');
  });

  it('omits X-Language entirely when no language is known, leaving the sidecar default', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse(Buffer.from([1]), { 'X-Sample-Rate': '24000' }));
    await deriveEngineArtifact(
      'abc',
      'qwen',
      { masterPcm: Buffer.from([9]), sampleRate: 24000, refText: 't' },
      { sidecarUrl: 'http://sidecar:9000' },
    );
    expect(headersOf(spy)['X-Language']).toBeUndefined();
  });
});
