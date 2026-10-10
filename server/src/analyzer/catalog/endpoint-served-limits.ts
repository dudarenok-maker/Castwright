/* #3084 P15 / P26 — an endpoint's served limits (context, output), warmed at run start through
   OpenAITransport.prepare(signal) — the W2 hook StageRunner awaits before every settings read —
   and cached per base URL with a TTL. resolveCapacity and OpenAIAnalyzer's settings read them,
   so a run's caps never depend on whether the catalog view was opened, and limits listed by an
   old base URL never apply to a new one.
   P26: the warm-up runs before the limiter, the request ceiling and the idle watchdog, so it
   bounds itself. One listing per base URL is in flight at a time and every concurrent request
   waits on it. The listing's signal is the 10 s bound plus "every waiter has left"; the wait
   also races that signal, so a listing that ignores it cannot hold a request. A caller's abort
   releases only that caller. A timeout or a failure proceeds with fallback limits and backs off
   60 s; an abandoned listing caches nothing. Never rejects. */
import { DEFAULT_CATALOG_DEPS, servedLimitsFromModelEntry, type CatalogDeps } from './analyzer-catalog.js';
import { redactKnownSecrets } from '../redact.js';

export const SERVED_LIMITS_TTL_MS = 10 * 60_000;
export const SERVED_LIMITS_WARMUP_TIMEOUT_MS = 10_000;
const FAILED_LISTING_BACKOFF_MS = 60_000;

export interface ServedLimits {
  contextTokens?: number;
  maxOutputTokens?: number;
}

interface WarmDeps {
  listEndpoint?: CatalogDeps['listEndpoint'];
  now?: () => number;
  /** Test seam; production uses SERVED_LIMITS_WARMUP_TIMEOUT_MS. */
  timeoutMs?: number;
  /** The caller's abort signal (pause, client gone): releases this caller only. */
  signal?: AbortSignal;
}

type InFlight = { done: Promise<void>; waiters: number; cancel: AbortController };

const cache = new Map<string, { expiresAt: number; byModel: Map<string, ServedLimits> }>();
const inflight = new Map<string, InFlight>();
const ABORTED = Symbol('aborted');

function keyFor(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** `work`'s value, or ABORTED as soon as `signal` aborts. `work` always keeps a rejection
    handler, so a rejection that lands after the abort is never unhandled. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

async function listInto(
  key: string,
  baseUrl: string,
  apiKey: string | null,
  deps: WarmDeps,
  listing: AbortSignal,
  cancel: AbortSignal,
): Promise<void> {
  const now = deps.now ?? Date.now;
  try {
    const list = deps.listEndpoint ?? DEFAULT_CATALOG_DEPS.listEndpoint;
    const rows = await untilAborted(list(baseUrl, apiKey, listing), listing);
    if (rows === ABORTED) throw new Error(`no answer within ${deps.timeoutMs ?? SERVED_LIMITS_WARMUP_TIMEOUT_MS} ms`);
    const byModel = new Map<string, ServedLimits>();
    for (const row of rows) if (typeof row.id === 'string') byModel.set(row.id, servedLimitsFromModelEntry(row));
    cache.set(key, { expiresAt: now() + SERVED_LIMITS_TTL_MS, byModel });
  } catch (err) {
    /* Every waiter left (pause, client gone): not a failed listing. Cache nothing, so the next run lists again. */
    if (cancel.aborted) return;
    /* P22: a listing error can carry the server's echo of the key. Only the listing runs here — no stage call (P20). */
    const message = redactKnownSecrets(err instanceof Error ? err.message : String(err), [apiKey]);
    console.warn(`[endpoint-limits] listing ${key}/models failed; output caps fall back to context minus input: ${message}`);
    cache.set(key, { expiresAt: now() + FAILED_LISTING_BACKOFF_MS, byModel: new Map() });
  }
}

export async function warmEndpointServedLimits(
  endpoint: { baseUrl: string },
  apiKey: string | null,
  deps: WarmDeps = {},
): Promise<void> {
  const now = deps.now ?? Date.now;
  const key = keyFor(endpoint.baseUrl);
  const hit = cache.get(key);
  if (hit && now() < hit.expiresAt) return;
  if (deps.signal?.aborted) return;
  let run = inflight.get(key);
  if (!run) {
    const cancel = new AbortController();
    const listing = AbortSignal.any([AbortSignal.timeout(deps.timeoutMs ?? SERVED_LIMITS_WARMUP_TIMEOUT_MS), cancel.signal]);
    const entry: InFlight = { done: Promise.resolve(), waiters: 0, cancel };
    entry.done = listInto(key, endpoint.baseUrl, apiKey, deps, listing, cancel.signal).finally(() => {
      if (inflight.get(key) === entry) inflight.delete(key);
    });
    inflight.set(key, entry);
    run = entry;
  }
  const joined = run;
  joined.waiters += 1;
  try {
    await untilAborted(joined.done, deps.signal);
  } finally {
    joined.waiters -= 1;
    /* An abort releases only this caller; the shared listing is cancelled once nobody waits on it. */
    if (joined.waiters === 0 && deps.signal?.aborted) joined.cancel.abort();
  }
}

export function getEndpointServedLimits(baseUrl: string, model: string, now: number = Date.now()): ServedLimits | undefined {
  const hit = cache.get(keyFor(baseUrl));
  if (!hit || now >= hit.expiresAt) return undefined;
  return hit.byModel.get(model);
}

/** Test-only. */
export function _resetEndpointServedLimitsForTest(): void {
  for (const run of inflight.values()) run.cancel.abort();
  inflight.clear();
  cache.clear();
}
