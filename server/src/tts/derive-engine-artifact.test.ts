import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* Some calls this suite exercises moved to undici's fetch (they need a
   dispatcher so a legitimate multi-minute wait isn't cut off at undici's
   hidden 300s headersTimeout — see DERIVE_DISPATCHER / DESIGN_DISPATCHER),
   while others legitimately stay on the global one. Delegating undici's fetch
   to whatever this file stubs globally keeps every existing mock and
   assertion working across both transports, with no per-test changes. */
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});


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

/* #3058 — a device preference for /xtts/clone-voice, sent as X-Device-Hint.
   Only clone-voice-resolver.ts's lazy Coqui derive supplies `deviceHint`;
   every other caller leaves it undefined, so the header must be sent only
   when explicitly provided and never invented as a default.

   #3061 review C7 — the send side of this helper is engine-blind (the
   header is written before the engine branch), but the WIRE CONTRACT is
   not: only the sidecar's `/xtts/clone-voice` route reads the header.
   `/qwen/clone-voice` ignores it, so a `deviceHint` set on a qwen derive
   travels and is discarded. An earlier version of this block asserted the
   opposite under the name "the header is engine-agnostic on the wire",
   which would have been cited as evidence the qwen path works. The two
   tests below now say which half is true, and the third pins the sidecar's
   read sites so the claim cannot rot: add a read to `/qwen/clone-voice` and
   the guard reddens, forcing this comment and those names to be revisited
   rather than leaving a green test telling a false story. */
describe('deriveEngineArtifact — X-Device-Hint (#3058)', () => {
  function headersOf(spy: ReturnType<typeof vi.spyOn>) {
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    return init.headers as Record<string, string>;
  }

  it('sends X-Device-Hint on a coqui derive when input.deviceHint is set', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse(Buffer.from([1]), { 'X-Sample-Rate': '24000' }));
    await deriveEngineArtifact(
      'u1',
      'coqui',
      { masterPcm: Buffer.from([9]), sampleRate: 24000, deviceHint: 'cuda:1' },
      { sidecarUrl: 'http://sidecar:9000' },
    );
    expect(headersOf(spy)['X-Device-Hint']).toBe('cuda:1');
  });

  it('puts X-Device-Hint on the wire for a qwen derive too, where the sidecar then ignores it (NOT engine-agnostic — see the qwen route guard below)', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse(Buffer.from([1]), { 'X-Sample-Rate': '24000' }));
    await deriveEngineArtifact(
      'abc',
      'qwen',
      { masterPcm: Buffer.from([9]), sampleRate: 24000, refText: 't', deviceHint: 'cuda:0' },
      { sidecarUrl: 'http://sidecar:9000' },
    );
    /* The send side is engine-blind, so the header IS emitted here. That is
       a fact about this helper, not a capability: `/qwen/clone-voice` never
       reads it, so this call places Qwen exactly where it would have gone
       with no header at all. QWEN_DEVICE remains the only way to move Qwen. */
    expect(headersOf(spy)['X-Device-Hint']).toBe('cuda:0');
    expect(spy.mock.calls[0][0]).toBe('http://sidecar:9000/qwen/clone-voice');
  });

  it('is read by exactly one sidecar route, /xtts/clone-voice — the guard behind the claim above', () => {
    const mainPy = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tts-sidecar', 'main.py'),
      'utf8',
    );
    /* Header READS only — `req.headers.get("X-Device-Hint")`. Mentions in
       comments and log strings are deliberately not counted; this asserts
       where the value is consumed, not where it is discussed. Case-
       INSENSITIVE: Starlette's `Headers.get` matches header names
       case-insensitively, so `req.headers.get("x-device-hint")` in some
       other route is a real second read site at runtime even though it
       doesn't match the literal spelling used at the one known call —
       a case-sensitive guard would stay green while that happened. */
    const readSites = [...mainPy.matchAll(/headers\.get\(\s*["']X-Device-Hint["']\s*\)/gi)];
    expect(readSites).toHaveLength(1);

    /* And that one read is inside `xtts_clone_voice`, not some other route:
       bound the function by its own `def` and the next top-level `def`. */
    const fnStart = mainPy.indexOf('\nasync def xtts_clone_voice');
    expect(fnStart).toBeGreaterThan(-1);
    const nextDef = mainPy.slice(fnStart + 1).search(/\n(?:async )?def /);
    const fnEnd = nextDef === -1 ? mainPy.length : fnStart + 1 + nextDef;
    const readAt = readSites[0].index as number;
    expect(readAt).toBeGreaterThan(fnStart);
    expect(readAt).toBeLessThan(fnEnd);
  });

  it('omits X-Device-Hint entirely when deviceHint is not supplied — today\'s behaviour, unchanged', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse(Buffer.from([1]), { 'X-Sample-Rate': '24000' }));
    await deriveEngineArtifact(
      'u1',
      'coqui',
      { masterPcm: Buffer.from([9]), sampleRate: 24000 },
      { sidecarUrl: 'http://sidecar:9000' },
    );
    expect(headersOf(spy)['X-Device-Hint']).toBeUndefined();
  });
});
