/* Analyzer concurrency control: a width-K FIFO count semaphore capping TOTAL
   in-flight analyzer /api/chat calls across all jobs/models (bounds
   Ollama-slot pressure). The VRAM co-residence gate (a per-resident-model
   lease on a cross-engine GPU token budget) has been removed — the GPU VRAM
   budget concept is retired; the K limiter here plus Ollama's own residency
   (via /api/ps, elsewhere) are what remain. Every analyzer call goes through
   acquireAnalyzerSlot(model, onCpu). */
import { CountSemaphore } from '../gpu/count-semaphore.js';
import { configValue } from '../config/resolver.js';
import { parseEndpointModelId } from './model-id.js';

function resolveK(): number {
  const k = configValue<number>('analyzer.ollama.concurrency');
  return Number.isFinite(k) && k > 0 ? Math.floor(k) : 1;
}

// K is captured once, at module load, via resolveK() above — a test (or
// caller) that flips ANALYZER_OLLAMA_CONCURRENCY after this module has
// already been imported will NOT resize this limiter without a fresh module
// import (contrast analyzerPoolWidth()-style helpers that re-read config
// live on every call).
export const analyzerConcurrency = new CountSemaphore(resolveK());

/* Re-resolve K live and resize the limiter to match. The singleton is built at
   module-load (above), but K can legitimately differ from that captured value:
   (a) the persisted analyzer.ollama.concurrency override often isn't in the
   user-settings cache yet when this module is first imported during boot, so
   the constructor reads the bare default — this is why a saved K never used to
   take effect; and (b) the knob is `live`, so an operator can change K between
   runs. Calling this at the head of every acquire means the FIRST call after
   the settings cache warms adopts the persisted value, and a later change
   applies on the next run — with no restart. resize() is a no-op when K is
   unchanged, so the steady-state cost is one cached configValue read. */
export function syncAnalyzerConcurrency(): void {
  analyzerConcurrency.resize(resolveK());
}

/* Honest observability (M3 follow-up): the peak number of analyzer calls that
   were simultaneously past the limiter — i.e. genuinely
   in-flight to Ollama at once. A run that fired K-wide reaches peak=K even if
   Ollama's own n_slots serialised the decodes, so peak<K localises the cap to
   the APP (a limiter/pool bug) while peak==K with no wall-clock speedup
   localises it to OLLAMA (n_slots below K — raise OLLAMA_NUM_PARALLEL / lower
   num_ctx so the KV for K slots fits). The route logs this at each phase end. */
let inFlightCount = 0;
let peakInFlight = 0;
export function getAnalyzerConcurrencyStats(): { inFlight: number; peak: number; limiter: number } {
  return { inFlight: inFlightCount, peak: peakInFlight, limiter: analyzerConcurrency.max };
}
/** Reset the peak watermark to the CURRENT in-flight count (not 0) so a
    mid-run reset — e.g. at a phase boundary while calls from the prior phase
    are still draining — stays truthful rather than under-reporting. */
export function resetAnalyzerConcurrencyPeak(): void {
  peakInFlight = inFlightCount;
}

/** The one entry point for every analyzer Ollama call: the width-K limiter.
    `model`/`onCpu` are unused now that the VRAM co-residence lease is gone —
    kept so call sites don't need to change. Returns a single idempotent
    release. */
export async function acquireAnalyzerSlot(_model: string, _onCpu: boolean): Promise<() => void> {
  syncAnalyzerConcurrency(); // adopt persisted/current K before gating
  const releaseLimiter = await analyzerConcurrency.acquire();
  inFlightCount++;
  if (inFlightCount > peakInFlight) peakInFlight = inFlightCount;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlightCount--;
    releaseLimiter();
  };
}

/* #3084 P1 — busy accounting for OpenAI-compatible endpoints, keyed by endpoint id. An
   endpoint is busy while a call to it is in flight OR a run that uses it is active: the
   run mark covers the gap between two chunk calls, which a per-call count reads as idle.
   TTS eviction (gpu/endpoint-eviction.ts) re-checks it before every unload POST. Kept apart
   from the Ollama K limiter, so Ollama's own eviction gate and peak stay Ollama-only. */
const endpointCalls = new Map<string, number>();
const endpointRuns = new Map<string, number>();

function adjust(counts: Map<string, number>, id: string, delta: number): void {
  const next = (counts.get(id) ?? 0) + delta;
  if (next <= 0) counts.delete(id);
  else counts.set(id, next);
}

function onceOnly(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** One call to an endpoint on a GPU. Returns an idempotent release. */
export function registerEndpointCallInFlight(endpointId: string): () => void {
  adjust(endpointCalls, endpointId, 1);
  return onceOnly(() => adjust(endpointCalls, endpointId, -1));
}

/** A run (analysis job or script review) that will use these endpoints, for its whole life.
    Returns an idempotent release, so a second call cannot clear another run's mark. */
export function markEndpointRunActive(endpointIds: readonly string[]): () => void {
  const ids = [...new Set(endpointIds)];
  for (const id of ids) adjust(endpointRuns, id, 1);
  return onceOnly(() => {
    for (const id of ids) adjust(endpointRuns, id, -1);
  });
}

export function isEndpointBusy(endpointId: string): boolean {
  return endpointCalls.has(endpointId) || endpointRuns.has(endpointId);
}

/** Test-only. A mark leaked by one case (a route that threw before its release) would make
    every later case's endpoint read busy; each 3d test file resets in beforeEach/afterEach. */
export function _resetEndpointBusyForTest(): void {
  endpointCalls.clear();
  endpointRuns.clear();
}

/** The endpoint ids named by a run's model ids (non-endpoint ids are ignored), once each. */
export function endpointIdsForModelIds(modelIds: readonly string[]): string[] {
  const ids = modelIds.map((id) => parseEndpointModelId(id)?.endpointId).filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
}

/** Startup log for analyzer concurrency (M4, K-only since the GPU VRAM budget
    concept was retired). Reports same-model call concurrency, bounded by K
    (the limiter budget) and OLLAMA_NUM_PARALLEL — this is what
    acquireAnalyzerSlot actually delivers for repeated calls to the SAME
    resident model. The distinct-model co-residency ceiling this used to also
    report (floor(gpuBudget / cost)) is gone along with the GPU semaphore it
    was computed from. */
export function describeAnalyzerConcurrency(): string {
  syncAnalyzerConcurrency(); // report live K, not the possibly-cold module-load value
  const k = analyzerConcurrency.max;
  return (
    `[analyzer] up to K=${k} same-model analyzer calls run concurrently ` +
    `(Ensure OLLAMA_NUM_PARALLEL >= ${k}).`
  );
}

