/* #3084 wave 2b — Gemini model catalog: models.list filter (planning facts §C.3:
   no output-modality field, so supportedActions + name exclusions), 10-minute
   cache, key-change refetch, in-flight dedupe, a warm-up bounded at 10 s whose
   caller's abort signal releases that caller and whose shared listing is
   cancelled once no caller waits (P26), a failure warning that re-arms after a
   success and cached limits keyed to the active key (N6), and the static
   thinking rule (P27). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listGeminiModels,
  getCachedGeminiModelInfo,
  warmGeminiCatalog,
  geminiModelThinks,
  toGeminiModelInfo,
  GEMINI_CATALOG_TTL_MS,
  GEMINI_CATALOG_WARM_TIMEOUT_MS,
  _resetGeminiCatalogForTest,
  _seedGeminiCatalogForTest,
  type GeminiModelsClient,
} from './gemini-catalog.js';

const LISTED = [
  { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedActions: ['generateContent', 'countTokens'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, thinking: true },
  { name: 'models/gemma-4-31b-it', supportedActions: ['generateContent'], inputTokenLimit: 131_072, outputTokenLimit: 8_192 },
  { name: 'models/gemini-embedding-001', supportedActions: ['embedContent'] },
  { name: 'models/gemini-3.5-flash-preview-tts', supportedActions: ['generateContent'] },
  { name: 'models/imagen-4.0-generate-001', supportedActions: ['generateContent', 'predict'] },
  { name: 'models/gemini-3.6-flash-live', supportedActions: ['generateContent', 'bidiGenerateContent'] },
  { name: 'models/aqa', supportedActions: ['generateAnswer', 'generateContent'] },
  /* Pins the `supportedActions ∋ generateContent` half of the filter (planning
     facts §C.3): this id matches no EXCLUDED_ID name, so only that rule drops
     it. Without it, Task 2.5 Step 5's first mutation (that check -> false)
     leaves the suite green. */
  { name: 'models/gemini-3.6-flash-count-tokens', supportedActions: ['countTokens'] },
];

type SpyClient = GeminiModelsClient & { models: { list: ReturnType<typeof vi.fn> } };

function fakeClient(models: object[] = LISTED): SpyClient {
  return {
    models: {
      list: vi.fn(async () =>
        (async function* () {
          yield* models;
        })(),
      ),
    },
  } as unknown as SpyClient;
}

/** A models.list() that never settles, like a stalled connection. */
function hungClient(): SpyClient {
  return { models: { list: vi.fn(() => new Promise<never>(() => {})) } } as unknown as SpyClient;
}

beforeEach(() => _resetGeminiCatalogForTest());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('toGeminiModelInfo / listGeminiModels filter', () => {
  it('keeps generateContent text models, strips models/, drops embedding/tts/image/live/aqa', async () => {
    const out = await listGeminiModels('k1', { client: fakeClient() });
    expect(out).toEqual([
      { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, thinking: true },
      { id: 'gemma-4-31b-it', displayName: undefined, inputTokenLimit: 131_072, outputTokenLimit: 8_192, thinking: undefined },
    ]);
  });

  it('rejects a model with no name', () => {
    expect(toGeminiModelInfo({ supportedActions: ['generateContent'] })).toBeNull();
  });
});

describe('cache', () => {
  it('serves a second call within 10 minutes from cache', async () => {
    const client = fakeClient();
    await listGeminiModels('k1', { client });
    await listGeminiModels('k1', { client });
    expect(client.models.list).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL', async () => {
    const client = fakeClient();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await listGeminiModels('k1', { client });
    now.mockReturnValue(1_000_000 + GEMINI_CATALOG_TTL_MS + 1);
    await listGeminiModels('k1', { client });
    expect(client.models.list).toHaveBeenCalledTimes(2);
  });

  it('refetches on refresh: true and on a different key', async () => {
    const client = fakeClient();
    await listGeminiModels('k1', { client });
    await listGeminiModels('k1', { client, refresh: true });
    await listGeminiModels('k2', { client });
    expect(client.models.list).toHaveBeenCalledTimes(3);
  });

  it('dedupes concurrent listings', async () => {
    const client = fakeClient();
    await Promise.all([listGeminiModels('k1', { client }), listGeminiModels('k1', { client })]);
    expect(client.models.list).toHaveBeenCalledTimes(1);
  });

  it('getCachedGeminiModelInfo answers synchronously after a listing', async () => {
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
    await listGeminiModels('k1', { client: fakeClient() });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')?.outputTokenLimit).toBe(65_536);
    expect(getCachedGeminiModelInfo('not-listed')).toBeUndefined();
  });

  it('asks the SDK to bound the request: httpOptions.timeout 10 s plus an abort signal (P26)', async () => {
    const client = fakeClient();
    await listGeminiModels('k1', { client });
    expect(GEMINI_CATALOG_WARM_TIMEOUT_MS).toBe(10_000);
    expect(client.models.list).toHaveBeenCalledWith({
      config: { httpOptions: { timeout: 10_000 }, abortSignal: expect.any(AbortSignal) },
    });
  });
});

describe('warmGeminiCatalog', () => {
  it('swallows a listing failure, warns once without the key, and leaves the cache empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { models: { list: vi.fn(async () => { throw new Error('bad key sk-SECRET-123'); }) } } as unknown as GeminiModelsClient;
    await expect(warmGeminiCatalog('sk-SECRET-123', { client })).resolves.toBeUndefined();
    await expect(warmGeminiCatalog('sk-SECRET-123', { client })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('sk-SECRET-123');
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
  });

  it('backs off listing for a minute after a failure (no request per stage call during an outage)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = vi.fn(async () => { throw new Error('offline'); });
    const client = { models: { list } } as unknown as GeminiModelsClient;
    await warmGeminiCatalog('k1', { client });
    await warmGeminiCatalog('k1', { client });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('a hung models.list() releases every waiting request after 10 s, on one shared listing, with the cache left empty (P26)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = hungClient();
    let released = 0;
    void warmGeminiCatalog('k1', { client }).then(() => { released += 1; });
    void warmGeminiCatalog('k1', { client }).then(() => { released += 1; });
    await vi.advanceTimersByTimeAsync(GEMINI_CATALOG_WARM_TIMEOUT_MS - 1);
    expect(released).toBe(0);
    expect(client.models.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(2);
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
  });

  it("the caller's abort signal releases its own wait at once; the shared listing still bounds the other request (P26)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = hungClient();
    const controller = new AbortController();
    let paused = false;
    let other = false;
    void warmGeminiCatalog('k1', { client, signal: controller.signal }).then(() => { paused = true; });
    void warmGeminiCatalog('k1', { client }).then(() => { other = true; });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(paused).toBe(true);
    expect(other).toBe(false);
    await vi.advanceTimersByTimeAsync(GEMINI_CATALOG_WARM_TIMEOUT_MS);
    expect(other).toBe(true);
    expect(client.models.list).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted signal returns without listing', async () => {
    const client = fakeClient();
    await warmGeminiCatalog('k1', { client, signal: AbortSignal.abort() });
    expect(client.models.list).not.toHaveBeenCalled();
  });

  it('when every waiting caller has released, the shared listing is cancelled: its SDK signal aborts, nothing is cached, and no back-off starts (P26)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = hungClient();
    const controller = new AbortController();
    let released = false;
    void warmGeminiCatalog('k1', { client, signal: controller.signal }).then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(true);
    const sdkSignal = (client.models.list.mock.calls[0][0] as { config: { abortSignal: AbortSignal } }).config.abortSignal;
    expect(sdkSignal.aborted).toBe(true);
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
    /* A cancel is not a failure: the next request lists again at once, and nothing was warned. */
    void warmGeminiCatalog('k1', { client });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.models.list).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GEMINI_CATALOG_WARM_TIMEOUT_MS);
  });

  it('a successful listing re-arms the failure warning, so a later outage warns again (N6)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const failing = { models: { list: vi.fn(async () => { throw new Error('offline'); }) } } as unknown as GeminiModelsClient;
    await warmGeminiCatalog('k1', { client: failing });
    expect(warn).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + 60_001); // past the failure back-off
    await warmGeminiCatalog('k1', { client: fakeClient() });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')?.outputTokenLimit).toBe(65_536);
    now.mockReturnValue(1_000_000 + 60_001 + GEMINI_CATALOG_TTL_MS + 1); // the listing has expired
    await warmGeminiCatalog('k1', { client: failing });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("after a key change the old key's cached limits are not served, even while the new key's listing fails (N6)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await listGeminiModels('k1', { client: fakeClient() });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')?.outputTokenLimit).toBe(65_536);
    const failing = { models: { list: vi.fn(async () => { throw new Error('bad key'); }) } } as unknown as GeminiModelsClient;
    await warmGeminiCatalog('k2', { client: failing });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
    /* Switching back to k1 serves its still-fresh listing again, with no new request. */
    const k1Client = fakeClient();
    await warmGeminiCatalog('k1', { client: k1Client });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')?.outputTokenLimit).toBe(65_536);
    expect(k1Client.models.list).not.toHaveBeenCalled();
  });
});

describe('geminiModelThinks (P27)', () => {
  it('follows the static id rule', () => {
    expect(geminiModelThinks('gemini-3.6-flash')).toBe(true);
    expect(geminiModelThinks('gemini-3.5-flash-lite')).toBe(true);
    expect(geminiModelThinks('gemini-2.5-flash')).toBe(true);
    expect(geminiModelThinks('gemini-2.5-pro')).toBe(true);
    expect(geminiModelThinks('gemini-2.5-flash-lite')).toBe(false);
    expect(geminiModelThinks('gemma-4-31b-it')).toBe(false);
  });

  it('ignores the catalog thinking flag in both directions', async () => {
    await listGeminiModels('k1', {
      client: fakeClient([
        { name: 'models/gemma-4-31b-it', supportedActions: ['generateContent'], thinking: true },
        { name: 'models/gemini-3.6-flash', supportedActions: ['generateContent'], thinking: false },
      ]),
    });
    expect(geminiModelThinks('gemma-4-31b-it')).toBe(false);
    expect(geminiModelThinks('gemini-3.6-flash')).toBe(true);
  });
});

/* #3084 wave 2b, F7 — test-first: Task 2.9a's guard test needs a way to make
   getCachedGeminiModelInfo answer for a known model with no network call, to
   force its conditional Gemini maxOutputTokens fix to actually run. Written
   here, ahead of _seedGeminiCatalogForTest's own implementation (below, Step
   3), per this file's TDD convention. */
describe('_seedGeminiCatalogForTest (#3084 wave 2b, F7)', () => {
  it('makes getCachedGeminiModelInfo answer synchronously, with no network call', () => {
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
    _seedGeminiCatalogForTest('test-key', [{ id: 'gemini-3.6-flash', outputTokenLimit: 65_536 }]);
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toEqual({ id: 'gemini-3.6-flash', outputTokenLimit: 65_536 });
  });

  it('a different key from listGeminiModels overwrites the seeded one, same as N6', async () => {
    _seedGeminiCatalogForTest('test-key', [{ id: 'gemini-3.6-flash', outputTokenLimit: 65_536 }]);
    await listGeminiModels('other-key', { client: fakeClient([]) });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
  });
});
