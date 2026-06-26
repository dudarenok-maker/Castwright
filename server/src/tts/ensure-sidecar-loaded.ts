/* READINESS gate (plan 113 follow-up; srv-17 respawn-resilience).
   Before a generation worker dispatches any synth for a chapter, it WAITS until
   the sidecar is reachable — so a cold start (or a supervisor respawn) pauses
   the queue ON THE GATE instead of N workers all firing synth at a sidecar that
   isn't up yet.

   IMPORTANT (2026-06-26): this gate POLLS `GET /health` — it NEVER `/load`s a
   model. The old gate POSTed `/load {engine}`, which (for Qwen) eagerly warmed
   the **0.6B base** as a side effect — so on a pure-1.7B render the 0.6B squatted
   ~1.2 GB of an 8 GB card per chapter and reloaded itself the moment it was
   evicted (#1162). Model loading is now purely lazy: the synth path loads the
   CORRECT tier (`_ensure_base17_loaded` for 1.7B / `_ensure_base_loaded` for
   0.6B) once, under its own single-flight lock, and keeps it warm across the
   book — so the load price is paid on the first chapter only. Preloading a model
   at startup is a separate, opt-in concern (`PRELOAD_QWEN` / `PRELOAD_QWEN_BASE17`).
   VRAM hygiene — evicting a resident tier this run won't use — is the run-start
   `reconcileResidentQwenTiers` below, NOT this per-chapter gate.

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

/** GET `/health` once. Returns `{ready:true}` when the sidecar is reachable and
    settled (not mid-recycle, not poisoned, this engine's package installed) —
    NO model load. A connection failure (sidecar down / respawning), a non-ok
    response, a pending recycle, or a poisoned process are all `{ready:false}` so
    the caller keeps waiting. Re-throws AbortError so a run-level stop propagates
    cleanly. The actual model is lazy-loaded by the first synth (correct tier,
    single-flight) — this gate only proves the sidecar is up. */
async function tryReadyOnce(
  healthUrl: string,
  engine: TtsEngine,
  signal: AbortSignal | undefined,
): Promise<LoadOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(healthUrl, { method: 'GET', signal: controller.signal });
    if (!res.ok) return { ready: false, reason: `/health returned ${res.status}` };
    const h = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    /* Honour the recycle drain fence: a sidecar that is reachable but draining /
       respawning is NOT ready for new synth — keep waiting (mirrors the old
       gate's /load drain fence). */
    if (h.recycle_pending === true) return { ready: false, reason: 'recycle pending' };
    if (h.poisoned === true) return { ready: false, reason: 'poisoned' };
    if (h[`${engine}_package_installed`] === false) {
      return { ready: false, reason: `${engine} package not installed` };
    }
    return { ready: true };
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
  const target = `${getResolvedSidecarUrl()}/health`;
  const timeoutMs = opts.timeoutMs ?? READINESS_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'unknown';

  /* withGpuLoad still wraps the wait so a live analysis on a constrained card
     surfaces as a GpuBusyError → user-facing "Generation paused" (unchanged).
     The poll itself is a cheap GET — it loads nothing. */
  await withGpuLoad(async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException('preload aborted', 'AbortError');
      const outcome = await tryReadyOnce(target, engine, signal);
      if (outcome.ready) return; // resolves the withGpuLoad callback; ensureSidecarEngineReady then returns void
      lastReason = outcome.reason;
      if (Date.now() >= deadline) {
        console.warn(
          `[generation] readiness ${engine}: sidecar not ready after ${timeoutMs}ms (last: ${lastReason}) — proceeding to lazy load.`,
        );
        return;
      }
      await sleep(pollIntervalMs, signal);
    }
  });

  // fs-45 v1: sample this engine's reserved footprint (env-gated + clean-process
  // gate inside maybeSampleSidecarEngine). Best-effort, record-only. The gate no
  // longer triggers the load, so this captures the CURRENT resident footprint
  // (whatever tier is warm) rather than a just-loaded one.
  if (engine === 'qwen' || engine === 'coqui') {
    const { maybeSampleSidecarEngine } = await import('../gpu/sidecar-vram-sample.js');
    await maybeSampleSidecarEngine(engine === 'qwen' ? 'qwen:synth' : 'coqui');
  }
}

/** Run-start VRAM hygiene (2026-06-26). Evict any resident Qwen base TIER this
    run will not use, so only the needed tier occupies the GPU — a pure-1.7B
    render no longer co-resides the 0.6B base (and vice-versa). Fires ONCE at
    generation start (NOT per chapter), so the in-use tier is never evicted
    between chapters — the load price is paid on the first chapter only. The
    needed tiers come from the run's cast (per-character `ttsModelKey` + the run
    default), so a genuinely mixed-tier book keeps both. Best-effort: a sidecar
    that is down / mid-recycle just skips (the next run reconciles).

    `keep06` / `keep17` = "this run uses the 0.6B / 1.7B base tier". */
export async function reconcileResidentQwenTiers(
  keep: { keep06: boolean; keep17: boolean },
  signal?: AbortSignal,
): Promise<void> {
  const base = getResolvedSidecarUrl();
  let h: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${base}/health`, { method: 'GET', signal });
    h = res.ok ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
  } catch {
    return; // sidecar unreachable — nothing to reconcile
  }
  if (!h || h.recycle_pending === true) return;

  const unload = async (model?: '1.7b'): Promise<void> => {
    try {
      await fetch(`${base}/unload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(model ? { engine: 'qwen', model } : { engine: 'qwen' }),
        signal,
      });
    } catch {
      /* best-effort */
    }
  };

  const evictions: Promise<void>[] = [];
  if (h.qwen_loaded === true && !keep.keep06) evictions.push(unload()); // drop the 0.6B base
  if (h.qwen_base17_loaded === true && !keep.keep17) evictions.push(unload('1.7b')); // drop the 1.7B base
  if (evictions.length === 0) return;
  console.info(
    `[generation] VRAM reconcile: evicting unused Qwen tier(s) ` +
      `[${!keep.keep06 && h.qwen_loaded ? '0.6B ' : ''}${!keep.keep17 && h.qwen_base17_loaded ? '1.7B' : ''}]`.trim(),
  );
  await Promise.allSettled(evictions);
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
