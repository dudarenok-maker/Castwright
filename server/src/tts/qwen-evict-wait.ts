/* #4568 — a bounded wait for any in-flight voice design or variant mint to finish, for a
   render to take before it evicts Qwen (the sidecar's Qwen unload takes the design's
   models with it). It only waits and reports; what to do on a timeout is the caller's. */
import { inFlightDesignMintCounts } from '../gpu/active-generation-gate.js';

/* 180 s: a voice design is a minutes-scale op, and the Qwen evict sits inside
   `withCallTimeout` (default ceiling 600 s) and outside `withHeartbeat`, so the wait
   counts against the 720 s `CHAPTER_NO_PROGRESS_MS` stall watchdog. This stays well
   under both, leaving the rest for the `/unload` itself. */
export const QWEN_EVICT_DESIGN_WAIT_MS = 180_000;
export const QWEN_EVICT_DESIGN_POLL_MS = 1_000;

export interface DesignMintWaitOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  /** Test seam; defaults to the leaf gate's `inFlightDesignMintCounts`. A render is
      neither a design nor a mint, so any count above zero is another op's. */
  counts?: () => { design: number; mint: number };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface DesignMintWaitResult {
  /** True when at least one design or mint was in flight on entry. */
  waited: boolean;
  /** True when the bound elapsed with a design or mint still in flight. */
  timedOut: boolean;
  waitedMs: number;
}

/* The signal's own reason (a real AbortError for a bare `controller.abort()`), so the
   caller sees an abort as an abort — as clone-voice-resolver.ts's `abortRejection`. */
function abortRejection(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

/* Resolves after `ms`, or rejects as soon as `signal` fires. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortRejection(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortRejection(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves when no voice design or variant mint is in flight, or when `timeoutMs`
    elapses, and reports which. Rejects with the signal's reason if aborted. */
export async function waitForDesignMintIdle(
  opts: DesignMintWaitOpts = {},
): Promise<DesignMintWaitResult> {
  const {
    signal,
    timeoutMs = QWEN_EVICT_DESIGN_WAIT_MS,
    pollMs = QWEN_EVICT_DESIGN_POLL_MS,
    counts = inFlightDesignMintCounts,
    sleep = abortableSleep,
    now = Date.now,
  } = opts;
  const busy = () => {
    const { design, mint } = counts();
    return design > 0 || mint > 0;
  };

  if (signal?.aborted) throw abortRejection(signal);
  if (!busy()) return { waited: false, timedOut: false, waitedMs: 0 };

  const startedAt = now();
  for (;;) {
    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) return { waited: true, timedOut: true, waitedMs: now() - startedAt };
    await sleep(Math.min(pollMs, remainingMs), signal);
    if (signal?.aborted) throw abortRejection(signal);
    if (!busy()) return { waited: true, timedOut: false, waitedMs: now() - startedAt };
  }
}
