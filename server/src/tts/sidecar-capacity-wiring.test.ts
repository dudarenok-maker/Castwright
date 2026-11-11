/* #4066 — what SidecarTtsProvider hands the capacity-retry loop.
 *
 * Two pieces of wiring in `postWithCapacityRetry` have no other observer:
 *   - `isRenderSynth`, true ONLY for a chapter render's own synth (the caller
 *     says so with `renderSynth`), so a voice sample/preview refused while
 *     another book renders keeps the "in use by the chapter render" line;
 *   - `deviceKey`, forwarded to the idle-TTS lever so a design resident on an
 *     unrelated card never makes a Quality op decline.
 * Both are exercised end to end: the real retry loop, a stubbed sidecar. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { SidecarTtsProvider } from './sidecar.js';
import { NoCapacityError } from './tts-errors.js';
import { setProbeSidecarHealthProvider } from '../gpu/sidecar-health-gate.js';
import { setActiveGenerationBooksProvider, setInFlightSpliceCounter } from '../gpu/active-generation-gate.js';
import { evictIdleQwenBase, freeKokoroForRenderSynth } from '../gpu/evict-idle-tts.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});
vi.mock('../gpu/evict-idle-tts.js', () => ({
  evictIdleQwenBase: vi.fn(async () => false),
  freeKokoroForRenderSynth: vi.fn(async () => false),
}));
const mockFetch = vi.mocked(undiciFetch);
const mockEvictIdle = vi.mocked(evictIdleQwenBase);
const mockFreeKokoro = vi.mocked(freeKokoroForRenderSynth);

afterEach(() => {
  mockFetch.mockReset();
  mockEvictIdle.mockClear();
  mockFreeKokoro.mockClear();
  setProbeSidecarHealthProvider(null);
  setActiveGenerationBooksProvider(() => []);
  setInFlightSpliceCounter(() => 0);
});

function noCapacity(deviceKey: string): Response {
  return new Response(JSON.stringify({ noCapacity: true, neededMb: 4_000, deviceKey }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProvider() {
  return new SidecarTtsProvider({
    url: 'http://localhost:6006/',
    engine: 'qwen',
    capacityProbe: {
      read: async () => [{ kind: 'cuda' as const, index: 0, label: 'cuda:0', totalMb: 8_000, freeMb: 100 }],
    },
    evictOllama: vi.fn(async () => {}),
    analyzerEvictWouldHelp: vi.fn(async () => false),
    isAnalysisInFlight: () => false,
    capacityPollMs: 1,
    maxCapacityAttempts: 2,
  });
}

const INPUT = { text: 'hello', voiceName: 'qwen-voice', modelKey: 'qwen3-tts-0.6b' as const };

/** A render of ANOTHER book is in flight with the standard Qwen model loaded. */
function arrangeRenderInFlight() {
  mockFetch.mockImplementation((async () => noCapacity('cuda:0')) as unknown as typeof undiciFetch);
  setActiveGenerationBooksProvider(() => ['other-book']);
  setProbeSidecarHealthProvider(async () => ({ qwenLoaded: true }));
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  const err = await run().then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(NoCapacityError);
  return (err as NoCapacityError).message;
}

describe('SidecarTtsProvider → withCapacityRetry wiring (#4066)', () => {
  it('a voice sample/preview (no renderSynth) is told the running render holds the model', async () => {
    arrangeRenderInFlight();
    const msg = await messageOf(() => makeProvider().synthesize(INPUT));
    expect(msg).toMatch(/in use by the chapter render/);
  });

  it('#4075: with only a splice/repair in flight (default gate wiring), the blocker names the repair', async () => {
    mockFetch.mockImplementation((async () => noCapacity('cuda:0')) as unknown as typeof undiciFetch);
    setActiveGenerationBooksProvider(() => []); // no render
    setInFlightSpliceCounter(() => 1); // a repair is registered
    setProbeSidecarHealthProvider(async () => ({ qwenLoaded: true }));
    const msg = await messageOf(() => makeProvider().synthesize(INPUT));
    expect(msg).toMatch(/chapter repair/);
    expect(msg).not.toMatch(/chapter render/);
  });

  it('a chapter render synth (renderSynth) is never told it is blocked by itself', async () => {
    arrangeRenderInFlight();
    const msg = await messageOf(() => makeProvider().synthesize({ ...INPUT, renderSynth: true }));
    expect(msg).not.toMatch(/in use by the chapter render/);
  });

  it('a batched render synth (renderSynth) is never told it is blocked by itself', async () => {
    arrangeRenderInFlight();
    const msg = await messageOf(() =>
      makeProvider().synthesizeBatch({
        items: [{ text: 'hello', voiceName: 'qwen-voice' }],
        modelKey: 'qwen3-tts-0.6b',
        renderSynth: true,
      }),
    );
    expect(msg).not.toMatch(/in use by the chapter render/);
  });

  it("#4079: only a render's own synth gets the free-Kokoro exception, carrying the op model key", async () => {
    mockFetch.mockImplementation((async () => noCapacity('cuda:0')) as unknown as typeof undiciFetch);
    await messageOf(() => makeProvider().synthesize(INPUT));
    expect(mockFreeKokoro).not.toHaveBeenCalled(); // a preview / design / sample frees nothing extra
    await messageOf(() => makeProvider().synthesize({ ...INPUT, modelKey: 'qwen3-tts-1.7b', renderSynth: true }));
    expect(mockFreeKokoro).toHaveBeenCalledTimes(1);
    expect(mockFreeKokoro).toHaveBeenCalledWith(
      expect.objectContaining({ modelKey: 'qwen3-tts-1.7b', isRenderSynth: true }),
    );
  });

  it('forwards the denied device and the op model key to the idle-TTS lever', async () => {
    mockFetch.mockImplementation((async () => noCapacity('cuda:1')) as unknown as typeof undiciFetch);
    await messageOf(() => makeProvider().synthesize(INPUT));
    expect(mockEvictIdle).toHaveBeenCalledWith(
      expect.objectContaining({ modelKey: 'qwen3-tts-0.6b', deviceKey: 'cuda:1' }),
    );
    // #4075: withCapacityRetry's own per-admission quiet state reaches the lever; without it the
    // quiet-poll rule never runs for a Quality preview / sample.
    const quiet = mockEvictIdle.mock.calls[0][0].quiet;
    expect(quiet).toMatchObject({ sawRepair: false, idleSince: null, epoch: null });
    expect(typeof quiet?.minGapMs).toBe('number');
    // The same object on every ask of one admission, so a streak can accumulate.
    for (const c of mockEvictIdle.mock.calls) expect(c[0].quiet).toBe(quiet);
  });
});
