/* #3084 wave 2b — cached Gemini model catalog (spec §3, §6, §7).

   Feeds Auto max output tokens (outputTokenLimit) and the capacity
   descriptor's context/output limits. Wave 3's GET /api/analyzer/models reuses
   listGeminiModels.

   Filter (planning facts §C.3): models.list carries no output-modality field, so
   keep supportedActions ∋ generateContent and drop ids naming a non-text
   modality or product (embedding, -tts, -image, -live, imagen, veo, aqa).

   Caching: one listing per API key per GEMINI_CATALOG_TTL_MS, keyed by a
   SHA-256 of the key (the raw key is never stored here). Concurrent callers
   share one request. getCachedGeminiModelInfo stays SYNCHRONOUS so
   resolveCapacity / resolveGeminiMaxOutputTokens never await — the transport
   warms the cache (warmGeminiCatalog) before the runner reads its settings. It
   answers only for the key most recently listed or warmed, so a key change
   never reuses the previous key's limits, even while the new key's listing
   fails (N6).

   Bounded warm-up (P26): the warm-up runs before the limiter, ceiling and
   watchdog, so a listing is capped at GEMINI_CATALOG_WARM_TIMEOUT_MS (SDK
   httpOptions.timeout + abortSignal, and our own timer over the whole
   listing). A caller's signal releases that caller's wait at once. The shared
   listing is cancelled only when no caller still waits; a cancelled listing
   caches nothing and starts no back-off. A failed or timed-out listing leaves
   the cache as it was: callers fall back to today's values (12000-token cap,
   8192 output).

   Thinking (P27): geminiModelThinks is a static id rule and never reads the
   catalog, so request shape and the thinking window are stable per model. */
import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';

export interface GeminiModelInfo {
  id: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  thinking?: boolean;
}

export interface GeminiListedModel {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedActions?: string[];
  thinking?: boolean;
}

export type GeminiModelsClient = {
  models: {
    list: (params?: {
      config?: { httpOptions?: { timeout?: number }; abortSignal?: AbortSignal };
    }) => Promise<AsyncIterable<GeminiListedModel>>;
  };
};

export const GEMINI_CATALOG_TTL_MS = 10 * 60 * 1000;
export const GEMINI_CATALOG_WARM_TIMEOUT_MS = 10_000;
const FAILURE_BACKOFF_MS = 60 * 1000;
const EXCLUDED_ID = /embedding|-tts|-image|-live|imagen|veo|aqa/i;
const THINKING_ID_RULE = /^gemini-(?:2\.5-(?:pro|flash)(?!-lite)|[3-9])/;

interface CatalogState {
  keyHash: string;
  fetchedAt: number;
  models: GeminiModelInfo[];
}

/** One in-flight models.list, shared by every caller for the same key. */
interface SharedListing {
  keyHash: string;
  promise: Promise<GeminiModelInfo[]>;
  /** P26 — callers still waiting on it. */
  waiters: number;
  settled: boolean;
  /** P26 — abort the SDK request and reject `promise` with ListingAbandonedError. */
  cancel: () => void;
}

/** P26 — the listing was cancelled because no caller still waited: not a failure. */
class ListingAbandonedError extends Error {
  constructor() {
    super('models.list cancelled: no caller still waits');
    this.name = 'ListingAbandonedError';
  }
}

let state: CatalogState | null = null;
let inFlight: SharedListing | null = null;
let lastFailure: { keyHash: string; at: number } | null = null;
let warnedFailure = false;
/** N6 — the key most recently listed or warmed. getCachedGeminiModelInfo
    answers only for it. */
let activeKeyHash: string | null = null;

const hashKey = (apiKey: string): string => createHash('sha256').update(apiKey).digest('hex');

export function toGeminiModelInfo(m: GeminiListedModel): GeminiModelInfo | null {
  if (!m.name || !(m.supportedActions ?? []).includes('generateContent')) return null;
  const id = m.name.replace(/^models\//, '');
  if (EXCLUDED_ID.test(id)) return null;
  return {
    id,
    displayName: m.displayName,
    inputTokenLimit: m.inputTokenLimit,
    outputTokenLimit: m.outputTokenLimit,
    thinking: m.thinking,
  };
}

function freshListing(keyHash: string): GeminiModelInfo[] | null {
  return state && state.keyHash === keyHash && Date.now() - state.fetchedAt < GEMINI_CATALOG_TTL_MS
    ? state.models
    : null;
}

/** Join the in-flight listing for this key, or start one: bounded at
    GEMINI_CATALOG_WARM_TIMEOUT_MS, cancellable once abandoned (P26). */
function joinListing(
  apiKey: string,
  keyHash: string,
  opts: { refresh?: boolean; client?: GeminiModelsClient },
): SharedListing {
  if (!opts.refresh && inFlight && inFlight.keyHash === keyHash) return inFlight;

  const client = opts.client ?? (new GoogleGenAI({ apiKey }) as unknown as GeminiModelsClient);
  /* P26 — the SDK bounds each HTTP attempt (httpOptions.timeout, abortSignal);
     our own timer bounds the whole listing, pages included, and aborts the SDK
     signal when it fires. */
  const sdkAbort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: (err: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
    timer = setTimeout(() => {
      sdkAbort.abort();
      reject(new Error(`models.list did not finish within ${GEMINI_CATALOG_WARM_TIMEOUT_MS} ms`));
    }, GEMINI_CATALOG_WARM_TIMEOUT_MS);
  });
  const listing = (async () => {
    const pager = await client.models.list({
      config: { httpOptions: { timeout: GEMINI_CATALOG_WARM_TIMEOUT_MS }, abortSignal: sdkAbort.signal },
    });
    const models: GeminiModelInfo[] = [];
    for await (const listed of pager) {
      const info = toGeminiModelInfo(listed);
      if (info) models.push(info);
    }
    return models;
  })();
  /* A listing that settles after the deadline or a cancel already lost the
     race; its late rejection must not surface as an unhandled rejection. */
  listing.catch(() => undefined);

  const promise = Promise.race([listing, stopped])
    .then((models) => {
      state = { keyHash, fetchedAt: Date.now(), models };
      lastFailure = null;
      /* N6 — a failure after this success warns again. */
      warnedFailure = false;
      return models;
    })
    .finally(() => {
      shared.settled = true;
      clearTimeout(timer);
      if (inFlight === shared) inFlight = null;
    });
  /* A cancelled listing may have no caller left to observe its rejection. */
  promise.catch(() => undefined);
  const shared: SharedListing = {
    keyHash,
    promise,
    waiters: 0,
    settled: false,
    cancel: () => {
      sdkAbort.abort();
      stop(new ListingAbandonedError());
    },
  };
  inFlight = shared;
  return shared;
}

export async function listGeminiModels(
  apiKey: string,
  opts: { refresh?: boolean; client?: GeminiModelsClient } = {},
): Promise<GeminiModelInfo[]> {
  const keyHash = hashKey(apiKey);
  activeKeyHash = keyHash;
  const cached = opts.refresh ? null : freshListing(keyHash);
  if (cached) return cached;
  const shared = joinListing(apiKey, keyHash, opts);
  /* This caller has no signal, so it keeps the listing alive until it settles. */
  shared.waiters += 1;
  try {
    return await shared.promise;
  } finally {
    shared.waiters -= 1;
  }
}

export function getCachedGeminiModelInfo(model: string): GeminiModelInfo | undefined {
  /* N6 — only the active key's listing: a key change never reuses the previous
     key's limits. */
  if (!state || state.keyHash !== activeKeyHash) return undefined;
  return state.models.find((m) => m.id === model);
}

export async function warmGeminiCatalog(
  apiKey: string,
  opts: { client?: GeminiModelsClient; signal?: AbortSignal } = {},
): Promise<void> {
  if (opts.signal?.aborted) return;
  const keyHash = hashKey(apiKey);
  activeKeyHash = keyHash;
  if (freshListing(keyHash)) return;
  if (lastFailure && lastFailure.keyHash === keyHash && Date.now() - lastFailure.at < FAILURE_BACKOFF_MS) {
    return;
  }
  const shared = joinListing(apiKey, keyHash, { client: opts.client });
  shared.waiters += 1;
  let released = false;
  /* P26 — each caller releases its wait once; when no caller still waits, the
     shared listing is cancelled. */
  const release = () => {
    if (released) return;
    released = true;
    shared.waiters -= 1;
    if (shared.waiters === 0 && !shared.settled) shared.cancel();
  };
  const outcome = shared.promise.then(
    () => undefined,
    (err: unknown) => {
      /* P26 — cancelled because every caller left: not a failure, so no
         back-off and no warning. */
      if (err instanceof ListingAbandonedError) return;
      lastFailure = { keyHash, at: Date.now() };
      if (!warnedFailure) {
        warnedFailure = true;
        const message = ((err as Error)?.message ?? String(err)).split(apiKey).join('<redacted>');
        console.warn(
          `[gemini-catalog] models.list failed — using fallback limits (12000-token cap, 8192 output): ${message}`,
        );
      }
    },
  );
  const signal = opts.signal;
  if (!signal) {
    await outcome;
    release();
    return;
  }
  /* P26 — pause releases this caller's wait at once. */
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      release();
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void outcome.then(() => {
      signal.removeEventListener('abort', onAbort);
      release();
      resolve();
    });
  });
}

/** P27 — a static id rule, never the live catalog's `thinking` flag, so a
    model's request shape and thinking window never change between
    requests. Gemma is outside it. */
export function geminiModelThinks(model: string): boolean {
  return THINKING_ID_RULE.test(model);
}

export function _resetGeminiCatalogForTest(): void {
  state = null;
  inFlight = null;
  lastFailure = null;
  warnedFailure = false;
  activeKeyHash = null;
}

/** #3084 wave 2b, F7 — seeds the cache directly (no network, no mock client)
    so a test can make `getCachedGeminiModelInfo` answer for a known model
    without going through `listGeminiModels`. Used by Task 2.9a's guard test
    to force the CONDITIONAL `analyzer.gemini.maxOutputTokens` fix to actually
    appear (it only appears when the model's listed `outputTokenLimit` is
    known AND the configured value is below it). Mirrors the shape
    `listGeminiModels` itself writes at `:1498`/`:1530` above. */
export function _seedGeminiCatalogForTest(apiKey: string, models: GeminiModelInfo[]): void {
  const keyHash = hashKey(apiKey);
  state = { keyHash, fetchedAt: Date.now(), models };
  activeKeyHash = keyHash;
}
