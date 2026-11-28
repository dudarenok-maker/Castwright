/* #4568 — the Coqui-phase Qwen eviction waits, bounded, for a live voice design or
   variant mint to finish (the sidecar's Qwen unload takes the design's models with
   it), and evicts anyway once the bound elapses. The helper's own timing is pinned in
   qwen-evict-wait.test.ts; here it is mocked, and what is pinned is the wiring at both
   call sites: the resolver pre-pass and the render phase. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import { QWEN_EVICT_DESIGN_WAIT_MS, type DesignMintWaitOpts } from './qwen-evict-wait.js';
import type { ResolveDesignedVoiceDeps } from './clone-voice-resolver.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import { _resetUserSettingsCache } from '../workspace/user-settings.js';

/* The phase-evict POST uses undici's fetch (see EVICT_DISPATCHER in
   synthesise-chapter.ts). */
const { fetchMock, waitMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), waitMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});
vi.mock('./qwen-evict-wait.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./qwen-evict-wait.js')>();
  return { ...actual, waitForDesignMintIdle: waitMock };
});

/* Every observable step, in the order it happened. */
let order: string[] = [];

beforeEach(() => {
  order = [];
  fetchMock.mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { engine?: string };
    order.push(`unload:${body.engine}`);
    return new Response(null, { status: 200 });
  });
});

afterEach(() => {
  fetchMock.mockReset();
  waitMock.mockReset();
  vi.restoreAllMocks();
  _resetUserSettingsCache();
});

function makeProvider(label: string): TtsProvider {
  return {
    async synthesize(_input: SynthesizeInput): Promise<SynthesizeOutput> {
      order.push(`synth:${label}`);
      return { pcm: Buffer.alloc(4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
}

function sentence(id: number, characterId: string): SentenceOutput {
  return { id, chapterId: 1, characterId, text: 'Привет, это тестовое предложение для проверки.' };
}

type Overrides = Partial<Parameters<typeof synthesiseChapter>[0]>;

/* Render-phase call site: a mixed Qwen+Coqui chapter with no derive at all, so the
   only Qwen unload is synthGroupsSerialized's. */
function renderPhaseChapter(overrides: Overrides = {}) {
  const cast: CastCharacter[] = [
    {
      id: 'marlow',
      name: 'Marlow',
      gender: 'male',
      overrideTtsVoices: { qwen: { name: 'qwen-marlow' } },
    },
    { id: 'wren', name: 'Wren', gender: 'female' }, // undesigned -> falls back to Coqui
  ];
  const qwen = makeProvider('qwen');
  const coqui = makeProvider('coqui');
  return synthesiseChapter({
    sentences: [sentence(1, 'marlow'), sentence(2, 'wren'), sentence(3, 'marlow')],
    cast,
    provider: qwen,
    modelKey: 'qwen3-tts-0.6b',
    engine: 'qwen',
    resolveForEngine: (e: string) =>
      e === 'coqui'
        ? { provider: coqui, modelKey: 'coqui-xtts-v2' as const }
        : { provider: qwen, modelKey: 'qwen3-tts-0.6b' as const },
    forbidKokoroFallback: true,
    coquiEligible: true,
    bookLanguage: 'ru',
    ...overrides,
  });
}

/* Pre-pass call site: a Coqui-only chapter whose designed voice needs a re-derive, so
   the only Qwen unload is `beforeFirstCoquiDerive`'s. */
function prePassChapter(overrides: Overrides = {}) {
  const cast: CastCharacter[] = [
    {
      id: 'orin',
      name: 'Orin',
      gender: 'male',
      overrideTtsVoices: {
        coqui: { name: 'xtts-lib-designed', libraryUuid: 'lib-designed', provenance: 'designed' },
      },
    },
  ];
  const entry = {
    voiceUuid: 'lib-designed',
    name: 'Orin',
    provenance: 'designed' as const,
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const deriveEngineArtifact = async () => {
    order.push('derive');
    return {
      previewPcm: Buffer.alloc(10),
      sampleRate: 24000,
      coquiVersion: 'v2.0.5',
      modelId: 'tts_models/multilingual/multi-dataset/xtts_v2',
    };
  };
  return synthesiseChapter({
    sentences: [sentence(1, 'orin')],
    cast,
    provider: makeProvider('coqui'),
    modelKey: 'coqui-xtts-v2',
    engine: 'coqui',
    designedResolverDepsOverride: {
      readEntry: (async () => entry) as unknown as ResolveDesignedVoiceDeps['readEntry'],
      ptExists: async () => false,
      readDesignedMasterPcm: async () => ({
        pcm: Buffer.alloc(1000),
        sampleRate: 24000,
        refText: '',
        manifest: {},
      }),
      deriveEngineArtifact:
        deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      writeEntry: async () => {},
    },
    ...overrides,
  });
}

describe.each([
  { site: 'resolver pre-pass', chapter: prePassChapter, afterUnload: 'derive' },
  { site: 'render phase', chapter: renderPhaseChapter, afterUnload: 'synth:coqui' },
])('synthesiseChapter — wait before the Qwen eviction, $site (#4568)', (c) => {
  it('posts /unload only after the busy design/mint wait resolved, and logs the wait', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    waitMock.mockImplementation(async () => {
      order.push('wait:busy');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('wait:idle');
      return { waited: true, timedOut: false, waitedMs: 1234 };
    });

    await c.chapter();

    expect(waitMock).toHaveBeenCalledTimes(1);
    const from = order.indexOf('wait:busy');
    expect(from).toBeGreaterThan(-1);
    expect(order.slice(from, from + 4)).toEqual([
      'wait:busy',
      'wait:idle',
      'unload:qwen',
      c.afterUnload,
    ]);
    expect(order.filter((s) => s === 'unload:qwen')).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        'qwen evict for coqui phase: waited 1234ms for an in-flight voice design/mint to finish',
      ),
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('qwen evict for coqui phase'));
  });

  it('still posts /unload when the wait times out, and warns that the design loses', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    waitMock.mockResolvedValue({
      waited: true,
      timedOut: true,
      waitedMs: QWEN_EVICT_DESIGN_WAIT_MS,
    });

    await c.chapter();

    expect(order.filter((s) => s === 'unload:qwen')).toHaveLength(1);
    expect(order).toContain(c.afterUnload);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `qwen evict for coqui phase: .*still in flight after the ${QWEN_EVICT_DESIGN_WAIT_MS}ms bound.*` +
            'evicting Qwen anyway.*design may fail',
        ),
      ),
    );
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('qwen evict for coqui phase'));
  });

  it('logs nothing about the wait when no design or mint was in flight', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    waitMock.mockResolvedValue({ waited: false, timedOut: false, waitedMs: 0 });

    await c.chapter();

    expect(waitMock).toHaveBeenCalledTimes(1);
    expect(order.filter((s) => s === 'unload:qwen')).toHaveLength(1);
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('qwen evict for coqui phase'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('qwen evict for coqui phase'));
  });

  it("rejects as an abort, without posting /unload, when the chapter's signal fires mid-wait", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctrl = new AbortController();
    let seen: AbortSignal | undefined;
    /* Rejects only through the signal it is handed, as the real helper does: an
       unforwarded signal leaves `seen` unaborted. */
    waitMock.mockImplementation(({ signal }: DesignMintWaitOpts = {}) => {
      seen = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        ctrl.abort();
        if (!signal?.aborted) reject(new Error('the chapter signal was not forwarded'));
      });
    });

    await expect(c.chapter({ signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });

    expect(seen?.aborted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
