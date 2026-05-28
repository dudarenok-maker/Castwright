/* Preload gate (plan 113 follow-up). Before a generation worker dispatches any
   synth for a chapter, it POSTs the sidecar `/load` for the chapter's engine and
   WAITS until the model reports ready — so a cold start pauses the queue on the
   load instead of N workers all hitting a cold model at once. The sidecar's
   `_base_load_lock` already makes the lazy load single-flight + correct; this is
   the explicit "in code, not hope" gate on top: the model is confirmed resident
   before the first batch leaves.

   Best-effort by design: a `/load` failure logs and returns rather than throwing,
   because the per-call lazy load (under the lock) is a correct fallback — the
   gate can only help, never turn a run that would otherwise proceed into a
   failure. Idempotent on the sidecar (a second call returns "ready" fast), so
   calling it per chapter is cheap AND recovers if the model was evicted
   mid-run. A run-level abort (pause / same-book displacement) cancels the wait. */

import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import type { TtsEngine } from './index.js';

/* Engines whose model lives in the local sidecar and must be loaded before
   synth. Gemini is a cloud API (nothing to preload); unknown engines are left
   to the per-call path. */
const SIDECAR_ENGINES: ReadonlySet<TtsEngine> = new Set(['qwen', 'kokoro', 'coqui']);

/* Matches the /api/sidecar/load proxy budget — a cold XTTS pull can take ~90s;
   Qwen/Kokoro are far faster but share the ceiling (over-budgeted is safe). */
const LOAD_TIMEOUT_MS = 90_000;

/** Preload `engine`'s sidecar model and resolve once it reports ready (or on a
    best-effort failure). Throws only on a run-level abort, so the caller's
    AbortError handling treats it as a clean stop. */
export async function ensureSidecarEngineReady(
  engine: TtsEngine,
  signal?: AbortSignal,
): Promise<void> {
  if (!SIDECAR_ENGINES.has(engine)) return; // cloud / unknown — nothing to load
  if (signal?.aborted) throw new DOMException('preload aborted', 'AbortError');

  const target = `${getResolvedSidecarUrl()}/load`;
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
    if (!res.ok) {
      console.warn(
        `[generation] preload ${engine}: sidecar /load returned ${res.status} — falling back to lazy load.`,
      );
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    if (body.status !== 'ready') {
      console.warn(
        `[generation] preload ${engine}: sidecar /load status=${body.status ?? 'unknown'} — falling back to lazy load.`,
      );
    }
  } catch (e) {
    // A run-level abort propagates as a clean stop; anything else is best-effort.
    if (signal?.aborted) throw new DOMException('preload aborted', 'AbortError');
    console.warn(
      `[generation] preload ${engine}: ${(e as Error).message} — falling back to lazy load.`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
