/* Reusable no-capacity retry loop (Task 5, #1720). Extracted from
   SidecarTtsProvider.postWithCapacityRetry so both the /synthesize path and
   the sidecar-load admission path (Task 6) share ONE evict-once-then-bounded-
   poll policy.

   CONTRACT (deliberately different from the old private method): given a
   `doPost` that returns a Response, `withCapacityRetry` retries only a genuine
   `noCapacity` 503 (`{ noCapacity: true, neededMb, deviceKey }`). On an ok
   response OR any non-`noCapacity` failure (poisoned CUDA, other 5xx, 4xx), it
   RETURNS that Response unchanged — the CALLER applies its own error handling
   (e.g. the TTS wrapper runs throwForResponse; the load route reads the body).
   It throws only NoCapacityError after `maxAttempts`, or the abort reason if
   the signal fires during a poll wait. */

import { capacityProbe as defaultCapacityProbe, type CapacityProbe } from './capacity-probe.js';
import {
  evictOllama as defaultEvictOllama,
  analyzerEvictWouldHelp as defaultAnalyzerEvictWouldHelp,
} from '../analyzer/ollama-residency.js';
import { getAnalyzerConcurrencyStats } from '../analyzer/analyzer-concurrency.js';
import { NoCapacityError } from '../tts/tts-errors.js';
import type { TtsEngine } from '../tts/model-keys.js';

/* Bounded poll for the no-capacity retry loop. GPU_CAPACITY_POLL_MS is the
   wait between admission checks; GPU_CAPACITY_MAX_ATTEMPTS bounds the total
   wait (default 30 * 2s = ~60s) before giving up and surfacing NoCapacityError. */
const GPU_CAPACITY_POLL_MS = (() => {
  const raw = Number(process.env.GPU_CAPACITY_POLL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2_000;
})();
const GPU_CAPACITY_MAX_ATTEMPTS = (() => {
  const raw = Number(process.env.GPU_CAPACITY_MAX_ATTEMPTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
})();

/* GPU-queue status surface (server/src/routes/gpu-queue.ts) — counts ops
   currently parked in the no-capacity poll-wait below, giving the frontend
   "Queued (N ahead)" pill something to read now that gpuSemaphore is gone.
   Incremented just before an op's first poll wait; decremented once that op
   leaves the wait, however it resolves (succeeds, evicts-then-retries-ok, or
   throws NoCapacityError). */
let _capacityWaiters = 0;

/** Current count of ops parked in the no-capacity poll-wait. Read by
    server/src/routes/gpu-queue.ts (via a re-export from ../tts/sidecar.ts) for
    the /api/gpu/queue payload. */
export function getCapacityWaiterCount(): number {
  return _capacityWaiters;
}

export interface CapacityRetryOpts {
  engine: string;
  signal?: AbortSignal;
  /** Injected capacity probe — defaults to the shared `capacityProbe`
      singleton (server/src/gpu/capacity-probe.ts). */
  capacityProbe?: CapacityProbe;
  /** Injected Ollama-eviction action — defaults to `evictOllama`
      (server/src/analyzer/ollama-residency.ts). */
  evictOllama?: () => Promise<void>;
  /** Injected "would evicting Ollama free enough VRAM" check — defaults to
      `analyzerEvictWouldHelp`. */
  analyzerEvictWouldHelp?: (neededMb: number, freeOnDeviceMb: number) => Promise<boolean>;
  /** Injected "is the analyzer mid-run" check — defaults to reading
      `getAnalyzerConcurrencyStats().inFlight > 0`. */
  isAnalysisInFlight?: () => boolean;
  /** Injected poll interval (ms) between no-capacity admission retries. */
  pollMs?: number;
  /** Injected cap on no-capacity retry attempts before giving up with
      `NoCapacityError`. */
  maxAttempts?: number;
  /** Injected "free a resident TTS model this op doesn't need" action —
      defaults to `evictIdleQwenBase` bound to this call's model key. Returns
      true when it actually unloaded something. */
  evictIdleTts?: () => Promise<boolean>;
}

/* Capacity-aware admission (vram-aware placement, Task 8b). Calls `doPost` and,
   on a non-ok response, peeks at the body BEFORE returning it (via
   `response.clone()`) to distinguish "no GPU capacity for this op" (503
   `{ noCapacity: true, neededMb, deviceKey }`) from every other response —
   which is returned untouched for the caller to classify.

   On a genuine no-capacity 503: re-probe live capacity for the reported device,
   and — ONLY the first time, and ONLY when the analyzer isn't mid-run — ask
   whether evicting the resident Ollama analyzer would free enough VRAM; if so,
   evict it and retry immediately. Otherwise (already evicted once, analyzer
   busy, or eviction wouldn't help), wait `pollMs` and retry, up to
   `maxAttempts` total attempts, then give up with `NoCapacityError`. */
export async function withCapacityRetry(
  doPost: (signal?: AbortSignal) => Promise<Response>,
  opts: CapacityRetryOpts,
): Promise<Response> {
  const capacityProbe = opts.capacityProbe ?? defaultCapacityProbe;
  const evictOllama = opts.evictOllama ?? defaultEvictOllama;
  const analyzerEvictWouldHelp = opts.analyzerEvictWouldHelp ?? defaultAnalyzerEvictWouldHelp;
  const isAnalysisInFlight =
    opts.isAnalysisInFlight ?? (() => getAnalyzerConcurrencyStats().inFlight > 0);
  const pollMs = opts.pollMs ?? GPU_CAPACITY_POLL_MS;
  const maxAttempts = opts.maxAttempts ?? GPU_CAPACITY_MAX_ATTEMPTS;
  const evictIdleTts = opts.evictIdleTts ?? (async () => false);

  let evicted = false;
  let evictedTts = false;
  let waiting = false;
  try {
    for (let attempt = 0; ; attempt++) {
      const response = await doPost(opts.signal);
      if (response.ok) return response;

      const noCap = await parseNoCapacity(response.clone());
      if (!noCap) {
        // ok OR a non-noCapacity failure (poisoned / other 5xx / 4xx) — the
        // CALLER applies its own error handling. Return it untouched.
        return response;
      }

      const devices = await capacityProbe.read({ fresh: true });
      const freeMb =
        devices.find((d) => d.kind !== 'cpu' && `${d.kind}:${d.index}` === noCap.deviceKey)
          ?.freeMb ?? 0;

      if (!evicted && !isAnalysisInFlight() && (await analyzerEvictWouldHelp(noCap.neededMb, freeMb))) {
        await evictOllama();
        evicted = true;
        continue; // immediate retry after freeing the analyzer
      }

      /* Second lever: free a resident Qwen base this op doesn't need. Guarded to
         "no render in flight" inside evictIdleQwenBase, so it is inert during
         generation by construction. At most once per call, like the analyzer. */
      if (!evictedTts) {
        evictedTts = true;
        if (await evictIdleTts()) continue; // immediate retry after freeing VRAM
      }

      if (attempt + 1 >= maxAttempts) {
        throw new NoCapacityError(opts.engine as TtsEngine, noCap.neededMb, noCap.deviceKey);
      }
      if (!waiting) {
        waiting = true;
        _capacityWaiters++;
      }
      await abortableDelay(pollMs, opts.signal); // bounded wait; rejects if the caller aborts
    }
  } finally {
    if (waiting) _capacityWaiters--;
  }
}

/* Parse the sidecar's no-capacity admission-refusal body:
   `{ "noCapacity": true, "neededMb": N, "deviceKey": "cuda:0" }` on a 503.
   Never throws — a non-503 status, an unreadable body, or a body that
   doesn't match this shape all return null so the caller falls back to its
   normal error handling. */
export async function parseNoCapacity(
  response: Response,
): Promise<{ neededMb: number; deviceKey: string } | null> {
  if (response.status !== 503) return null;
  const text = await safeReadText(response);
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const body = parsed as { noCapacity?: unknown; neededMb?: unknown; deviceKey?: unknown };
  if (
    body?.noCapacity === true &&
    typeof body.neededMb === 'number' &&
    typeof body.deviceKey === 'string'
  ) {
    return { neededMb: body.neededMb, deviceKey: body.deviceKey };
  }
  return null;
}

/* Resolves after `ms`, or rejects with the signal's abort reason (AbortError)
   if `signal` fires first — so a cancelled op stops polling for capacity
   instead of waiting out the full interval. Mirrors retry.ts's `sleep`. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('capacity poll aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('capacity poll aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
