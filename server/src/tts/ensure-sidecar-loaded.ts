/* Preload + READINESS gate (plan 113 follow-up; srv-17 respawn-resilience).
   Before a generation worker dispatches any synth for a chapter, it POSTs the
   sidecar `/load` for the chapter's engine and WAITS until the model reports
   ready — so a cold start (or a supervisor respawn) pauses the queue ON THE
   GATE instead of N workers all firing synth at a sidecar that isn't up yet.

   WHY THIS BLOCKS (srv-17). The host-RAM recycle (plan 143) makes the sidecar
   self-exit; the srv-15 supervisor respawns it with backoff [2s,5s,15s] + a
   fresh model load (~10-30s to be HTTP-ready). During that window the sidecar
   is unreachable. The OLD gate gave up on the first connection-refused and let
   the worker proceed straight into a synth that then failed "sidecar not
   reachable" — and because multiple chapters get claimed back-to-back, that
   produced a BURST of failures that tripped the queue's consecutive-failure
   breaker and paused the whole run (2026-05-30 incident). The gate now POLLS:
   a sidecar that is unreachable (respawning) OR still loading is treated as
   "keep waiting", up to `READINESS_TIMEOUT_MS`, so the worker rides out the
   respawn and never dispatches synth into the gap.

   Best-effort ONLY at the very end: if the sidecar is still not ready after the
   full budget, the gate logs and returns (the per-call lazy load under the
   sidecar's `_base_load_lock` remains a correct fallback) — the gate can help,
   never turn a run that would otherwise proceed into a failure. Idempotent on
   the sidecar (a second /load returns "ready" fast). A run-level abort (pause /
   same-book displacement) cancels the wait promptly. */

import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import type { TtsEngine } from './index.js';

/* Engines whose model lives in the local sidecar and must be loaded before
   synth. Gemini is a cloud API (nothing to preload); unknown engines are left
   to the per-call path. */
export const SIDECAR_ENGINES: ReadonlySet<TtsEngine> = new Set(['qwen', 'kokoro', 'coqui']);

/* Per-/load-attempt timeout. A cold XTTS pull can take ~90s; Qwen/Kokoro are
   far faster but share the ceiling (over-budgeted is safe). */
const LOAD_TIMEOUT_MS = 90_000;

/* Total readiness budget across poll attempts. Must comfortably cover a full
   recycle: the srv-17c DRAIN of in-flight synth (SIDECAR_DRAIN_GRACE_MS, default
   180s) THEN the supervisor respawn (backoff up to 15s on a crash-loop tier)
   PLUS a fresh model load. Set above the 180s drain grace so a SINGLE preload-
   gate wait rides out a worst-case full-grace drain — otherwise the gate times
   out mid-drain, falls back to a lazy-load synth, and eats another 503 (the
   2026-05-31 cascade). Now that /load honors the drain fence, this budget is
   what the gate actually spends polling through it. */
const READINESS_TIMEOUT_MS = 210_000;

/* Gap between poll attempts when the sidecar is unreachable / still loading. */
const POLL_INTERVAL_MS = 1_500;

export interface EnsureReadyOpts {
  /** Override the total readiness budget (tests use a small value). */
  timeoutMs?: number;
  /** Override the inter-poll gap (tests use a small value). */
  pollIntervalMs?: number;
}

type LoadOutcome = { ready: true } | { ready: false; reason: string };

/** POST `/load` once. Returns `{ready:true}` when the model reports ready,
    else a reason. A connection failure (sidecar down / respawning) and a
    non-ok / non-ready response are both `{ready:false}` so the caller keeps
    waiting. Re-throws AbortError so a run-level stop propagates cleanly. */
async function tryLoadOnce(
  target: string,
  engine: TtsEngine,
  signal: AbortSignal | undefined,
): Promise<LoadOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine }),
      signal: controller.signal,
    });
    if (!res.ok) return { ready: false, reason: `/load returned ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    if (body.status === 'ready') return { ready: true };
    return { ready: false, reason: `status=${body.status ?? 'unknown'}` };
  } catch (e) {
    /* A run-level abort propagates as a clean stop. A timeout / connection
       error (sidecar down or respawning) is a "keep waiting" signal, NOT a
       stop. */
    if (signal?.aborted) throw new DOMException('preload aborted', 'AbortError');
    return { ready: false, reason: (e as Error).message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Preload `engine`'s sidecar model and resolve once it reports ready. Polls
    through a respawn (unreachable / loading) until ready or the readiness
    budget is exhausted; on exhaustion it returns best-effort (lazy load is a
    correct fallback). Throws only on a run-level abort, so the caller's
    AbortError handling treats it as a clean stop. */
export async function ensureSidecarEngineReady(
  engine: TtsEngine,
  signal?: AbortSignal,
  opts: EnsureReadyOpts = {},
): Promise<void> {
  if (!SIDECAR_ENGINES.has(engine)) return; // cloud / unknown — nothing to load
  if (signal?.aborted) throw new DOMException('preload aborted', 'AbortError');

  const { withGpuLoad } = await import('../gpu/gpu-load.js');
  const target = `${getResolvedSidecarUrl()}/load`;
  const timeoutMs = opts.timeoutMs ?? READINESS_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'unknown';

  await withGpuLoad(async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException('preload aborted', 'AbortError');
      const outcome = await tryLoadOnce(target, engine, signal);
      if (outcome.ready) return; // resolves the withGpuLoad callback; ensureSidecarEngineReady then returns void
      lastReason = outcome.reason;
      if (Date.now() >= deadline) {
        console.warn(`[generation] preload ${engine}: not ready after ${timeoutMs}ms (last: ${lastReason}) — falling back to lazy load.`);
        return;
      }
      await sleep(pollIntervalMs, signal);
    }
  });
}

/* Abort-aware sleep — resolves after `ms`, or rejects promptly if `signal`
   fires (so a run-level Stop tears down the wait without serving the full gap). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('preload aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
