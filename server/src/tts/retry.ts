/* Auto-retry wrapper for transient TTS provider failures.

   Why this exists. A long generation run today wedges its queue the
   moment one sentence gets a transient 503 (sidecar mid-restart after
   a CUDA poison) or a brief connection-refused (sidecar process briefly
   gone). The user notices the chapter sitting at "failed" and clicks
   Retry — hands-on attention that defeats the "click Generate and walk
   away" magic moment. Wrapping the per-group synth call in one bounded
   retry restores hands-off operation; only persistent-and-surfaced
   failures (4xx, retry-exhausted 5xx, or `poisoned: true` bodies that
   require a sidecar restart) bubble out.

   Provider-agnostic by design. The retry classifier checks
   `(err as any).transient === true` rather than pattern-matching error
   messages — each provider annotates at the boundary where it has the
   cleanest signal (HTTP status, network errno, etc.). See
   `SidecarTtsProvider.synthesize` for the annotation site; the same
   shape can be opted into by `GeminiTtsProvider` later. */

export interface TransientErrorShape {
  /** Set to `true` by a provider to opt this error into the auto-retry
      path. Absent / false → the error bubbles out on the first throw. */
  transient?: boolean;
}

export interface WithTtsRetryOpts {
  /** Max total attempts (primary + retries). Default 3 → 1 + 2 retries.
      Matches the `1 attempt + 2 retries at 500ms / 2s` schedule named
      in the regression plan for transient-failure auto-retry. */
  maxAttempts?: number;
  /** Backoff schedule in ms BETWEEN attempts (length must be >=
      maxAttempts-1). Defaults to [500, 2000]. */
  backoffsMs?: number[];
  /** Optional abort signal — re-checked before each retry sleep so a
      caller-driven Stop tears down the wait promptly instead of letting
      the full backoff run. */
  signal?: AbortSignal;
  /** Fired before each retry sleep (NOT before the primary attempt).
      `attempt` is the upcoming attempt number, 1-indexed: e.g. attempt=2
      means "the primary failed, sleeping then trying attempt #2 of N".
      The route handler can wire this to the SSE stream so the UI shows
      a "retrying" hint while the auto-retry runs. */
  onRetry?: (info: { attempt: number; backoffMs: number; reason: string }) => void;
}

const DEFAULT_BACKOFFS_MS = [500, 2000];
const DEFAULT_MAX_ATTEMPTS = 3;

export function isTransient(err: unknown): boolean {
  return Boolean((err as TransientErrorShape | null | undefined)?.transient);
}

/* Run `fn`, retrying transient failures with bounded backoff. On a
   transient throw, sleeps according to `backoffsMs` and re-runs the
   same `fn`. On a non-transient throw, re-throws immediately. On
   AbortError, re-throws immediately (cancellation is never transient).
   When the retry budget is exhausted, re-throws the LAST transient
   error so the caller's error-surface text reflects the actual
   underlying failure. */
export async function withTtsRetry<T>(
  fn: () => Promise<T>,
  opts: WithTtsRetryOpts = {},
): Promise<T> {
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffs = opts.backoffsMs ?? DEFAULT_BACKOFFS_MS;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < max; attempt += 1) {
    if (opts.signal?.aborted) {
      throw new DOMException('TTS retry aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      /* AbortError = caller-driven stop. Always non-retryable, regardless
         of any `transient` flag. Pass through with original name so the
         outer handler can shut down cleanly. */
      if ((err as { name?: string })?.name === 'AbortError') throw err;
      /* Non-transient → bail immediately. */
      if (!isTransient(err)) throw err;
      /* Out of attempts → bail with the last (transient) error. */
      if (attempt >= max - 1) break;
      const baseMs = backoffs[attempt] ?? backoffs[backoffs.length - 1] ?? 500;
      const backoffMs = jitterMs(baseMs);
      const reason = (err as Error)?.message ?? String(err);
      opts.onRetry?.({ attempt: attempt + 2, backoffMs, reason });
      await sleep(backoffMs, opts.signal);
    }
  }
  throw lastErr ?? new Error('TTS retry budget exhausted with no recorded error.');
}

/* ±25% jitter so parallel workers don't re-enter the same upstream
   window in lockstep — matches the analyzer's jitterMs in
   server/src/analyzer/gemini.ts. */
function jitterMs(base: number): number {
  const j = base * 0.5 * (Math.random() - 0.5);
  return Math.max(0, Math.round(base + j));
}

/* Abort-aware setTimeout. Resolves after `ms`, or rejects promptly if
   `signal` fires. Modeled after analyzer/gemini.ts's `sleep`. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('TTS retry sleep aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
