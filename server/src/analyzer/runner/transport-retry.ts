/* Transport-level retry helper (#3084 wave 1, Task 1.9). Extracted from
   GeminiAnalyzer.generateWithLimiter so the retry policy — rate limiter
   acquisition, error classification, backoff with jitter, daily-quota
   detection — is transport-agnostic and reusable by any ChatTransport.

   The caller supplies:
   - `attempt` — a thunk that does one wire call and returns its result.
   - `classifier` — maps a thrown error to a RetryDisposition.
   - `limiter` — the rate limiter (acquire/recordActualTokens/recordRejection).
   - `recordActualTokens` — optional reconciler that extracts the real
     prompt-token count from a successful result so the limiter can correct
     its pre-flight estimate.

   The helper NEVER swallows a completed response: a transport that returns
   a TransportResult with finish 'length' or 'blocked' is a success at this
   layer — the runner (finish.ts) maps those to errors. Only thrown errors
   (5xx, 429, idle, abort, unreachable) enter the retry loop. */
import { AnalysisAbortedError } from '../errors.js';
import {
  DailyQuotaExhaustedError,
  type GeminiRateLimiter,
  nextUtcMidnight,
} from '../rate-limit.js';

/* Inter-attempt backoffs for the retry loop. Exported so tests can shrink
   them via `GEMINI_RETRY_BACKOFFS_MS` — the 1.5 s / 6 s production values
   plus 25% jitter would push a 3-attempt retry-exhaustion spec past the
   default 5 s test budget. Moved from gemini.ts. */
export const BACKOFFS_MS: readonly number[] = parseBackoffsEnv() ?? [1500, 6000];
function parseBackoffsEnv(): number[] | null {
  const raw = process.env.GEMINI_RETRY_BACKOFFS_MS;
  if (!raw) return null;
  const parts = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parts.length > 0 ? parts : null;
}

/* True for transient HTTP statuses worth retrying. Exported so the
   GeminiRateLimiter classifier (and tests) can reference the same list. */
export function isRetryable5xx(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 500 || status === 503 || status === 504;
}

function describeStatus(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 429) return '429 rate-limit';
  if (status === 503) return '503 unavailable';
  if (status === 500) return '500 internal';
  if (status === 504) return '504 timeout';
  return String(status ?? 'unknown');
}

/* Sleep `ms`, rejecting promptly if `signal` fires. Used between retry
   attempts so an aborted analysis tears down the backoff immediately
   instead of waiting out the full delay. Throws `AnalysisAbortedError`
   (not a plain Error) so the route layer's `err instanceof
   AnalysisAbortedError` branch fires and emits the structured `error:
   aborted` event the UI uses to distinguish pause from a real failure.
   `logTag` parameterises the abort message so the helper is
   transport-agnostic. */
function sleep(ms: number, signal: AbortSignal | undefined, logTag: string): Promise<void> {
  /* Bind the clamp to a const that feeds setTimeout directly so the bound is
     provable at the sink (js/resource-exhaustion barrier). */
  const delay = Math.min(ms, 60_000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AnalysisAbortedError(`Aborted during ${logTag} retry backoff.`));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* Apply ±25% jitter to a backoff base. Keeps parallel workers from
   re-entering the same RPM window in lockstep. */
function jitterMs(baseMs: number): number {
  const j = baseMs * 0.5 * (Math.random() - 0.5); // ±25% range
  return Math.max(0, Math.round(baseMs + j));
}

/* Parse `retry-delay` from a Gemini SDK error's `details[]` array. The
   error message wraps a JSON envelope with shape:
     { error: { code, message, status, details: [{
         "@type": "type.googleapis.com/google.rpc.RetryInfo",
         "retryDelay": "15s"
       }, ...] } }
   Returns ms or null when the field isn't present. */
export function parseRetryDelayMs(err: unknown): number | null {
  const raw = (err as Error)?.message ?? String(err);
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    const obj = JSON.parse(raw.slice(start)) as {
      error?: { details?: Array<{ '@type'?: string; retryDelay?: string }> };
    };
    const details = obj?.error?.details ?? [];
    for (const d of details) {
      const type = d['@type'] ?? '';
      const delay = d.retryDelay;
      if (typeof delay === 'string' && type.includes('RetryInfo')) {
        /* Common shapes: "15s", "1.5s", "500ms", "0.5s". */
        const m = delay.match(/^([\d.]+)(ms|s)?$/);
        if (m) {
          const n = Number(m[1]);
          if (Number.isFinite(n)) return m[2] === 'ms' ? n : Math.round(n * 1000);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/* The retry dispositions a classifier can return. */
export type RetryDisposition =
  | 'server-error' // 5xx — bounded retry with backoff
  | 'idle' // stream idle watchdog — bounded retry with backoff
  | 'rate-limit' // 429 per-minute — record rejection, honor retry-after
  | 'daily-quota' // 429 per-day — block limiter, throw DailyQuotaExhaustedError
  | 'abort' // caller aborted — rethrow immediately
  | 'no-retry'; // anything else — rethrow immediately

/* A classifier maps a thrown error to a RetryDisposition and, for
   rate-limit errors, extracts the provider's retry-after hint. */
export interface RetryClassifier {
  classify(err: unknown): RetryDisposition;
  retryAfterMs(err: unknown): number | null;
}

export interface TransportRetryOpts<T> {
  model: string;
  limiter: GeminiRateLimiter;
  estimatedInputTokens: number;
  classifier: RetryClassifier;
  logTag: string;
  displayName: string;
  maxAttempts?: number;
  maxTotalMs?: number;
  backoffsMs?: readonly number[];
  signal?: AbortSignal;
  onThrottle?: (waitMs: number, reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after') => void;
  /* Reconciler: given a successful result, return the actual prompt-token
     count so the limiter can correct its pre-flight estimate. Return
     undefined (or omit) to skip reconciliation — e.g. when the transport
     did not report usage. */
  recordActualTokens?: (result: T) => number | undefined;
}

/* Retry policy: every attempt (primary + retries) goes through the
   per-model rate limiter so retries can't push us over the RPM/TPM cap
   and cause the very 429s we're retrying.

   • server-error / idle — bounded retries with exponential backoff +
     jitter, limiter re-acquired before each.
   • rate-limit (per-minute) — parse the provider's retry-after, feed it
     into the limiter via recordRejection, then retry up to maxAttempts-1.
   • daily-quota — re-thrown as DailyQuotaExhaustedError (no retry); also
     long-blocks the model in the limiter so other in-flight workers stop
     hitting it.
   • abort / no-retry — rethrown immediately. */
export async function withTransportRetry<T>(
  attempt: () => Promise<T>,
  opts: TransportRetryOpts<T>,
): Promise<T> {
  const {
    model,
    limiter,
    estimatedInputTokens,
    classifier,
    logTag,
    displayName,
    maxAttempts = 3,
    maxTotalMs = 90_000,
    backoffsMs = BACKOFFS_MS,
    signal,
    onThrottle,
    recordActualTokens,
  } = opts;

  const start = Date.now();
  let lastErr: unknown = null;

  const onWaitForLimiter = (waitMs: number, reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after') => {
    if (waitMs > 1000) onThrottle?.(waitMs, reason);
  };

  for (let attemptNum = 0; attemptNum < maxAttempts; attemptNum += 1) {
    if (Date.now() - start >= maxTotalMs) break;

    await limiter.acquire(model, estimatedInputTokens, {
      signal,
      onWait: onWaitForLimiter,
    });

    try {
      const out = await attempt();
      if (recordActualTokens) {
        const actual = recordActualTokens(out);
        if (actual !== undefined && Number.isFinite(actual)) {
          limiter.recordActualTokens(model, actual);
        }
      }
      return out;
    } catch (err) {
      lastErr = err;
      const disposition = classifier.classify(err);

      if (disposition === 'abort' || disposition === 'no-retry') {
        throw err;
      }

      if (disposition === 'daily-quota') {
        const resetAt = nextUtcMidnight();
        limiter.recordRejection(model, resetAt.getTime() - Date.now());
        throw new DailyQuotaExhaustedError(model, resetAt);
      }

      if (disposition === 'rate-limit') {
        const retryAfterMs = classifier.retryAfterMs(err);
        limiter.recordRejection(model, retryAfterMs);
        if (attemptNum >= maxAttempts - 1) break;
        const backoff = jitterMs(Math.max(retryAfterMs ?? 0, backoffsMs[attemptNum] ?? 6000));
        console.warn(
          `[${logTag}] 429 — retrying in ${backoff}ms (attempt ${attemptNum + 2}/${maxAttempts})`,
        );
        if (backoff > 1000) onThrottle?.(backoff, 'retry-after');
        await sleep(backoff, signal, logTag);
        continue;
      }

      /* server-error or idle — bounded retry with backoff. */
      if (attemptNum >= maxAttempts - 1) break;
      const backoff = jitterMs(backoffsMs[attemptNum] ?? 6000);
      const label =
        disposition === 'idle'
          ? `stream idle ${(err as { idleMs?: number })?.idleMs ?? '?'}ms`
          : `transient ${describeStatus(err)}`;
      console.warn(
        `[${logTag}] ${label} — retrying in ${backoff}ms (attempt ${attemptNum + 2}/${maxAttempts})`,
      );
      if (backoff > 1000) onThrottle?.(backoff, 'retry-after');
      await sleep(backoff, signal, logTag);
      continue;
    }
  }

  /* Retry budget exhausted — re-throw the last upstream error so the
     route layer can classify it correctly (rate_limit / unavailable /
     internal). */
  throw lastErr ?? new Error(`${displayName} retry budget exhausted with no recorded error.`);
}
