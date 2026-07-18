/* Analyzer concurrency control: a width-K FIFO count semaphore capping TOTAL
   in-flight analyzer /api/chat calls across all jobs/models (bounds
   Ollama-slot pressure). The VRAM co-residence gate (a per-resident-model
   lease on a cross-engine GPU token budget) has been removed — the GPU VRAM
   budget concept is retired; the K limiter here plus Ollama's own residency
   (via /api/ps, elsewhere) are what remain. Every analyzer call goes through
   acquireAnalyzerSlot(model, onCpu). */
import { CountSemaphore } from '../gpu/count-semaphore.js';
import { configValue } from '../config/resolver.js';

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

/** Startup log for analyzer concurrency (M4). Reports TWO independent axes —
    collapsing them into one "effective N" number (as an earlier version did)
    misleads operators into raising GPU_VRAM_BUDGET to "fix" a low number,
    which instead just enables distinct-model co-residence and risks the OOM
    this feature exists to prevent:
      1. Same-model call concurrency, bounded by K (the limiter budget) and
         OLLAMA_NUM_PARALLEL — this is what acquireAnalyzerSlot actually
         delivers for repeated calls to the SAME resident model.
      2. Distinct-model co-residency, bounded by floor(gpuBudget / cost) — how
         many DIFFERENT local models can hold a GPU token at once.
         This is a ceiling on co-residence, not on same-model call throughput. */
export function describeAnalyzerConcurrency(analyzerCost: number, gpuBudget: number): string {
  syncAnalyzerConcurrency(); // report live K, not the possibly-cold module-load value
  const k = analyzerConcurrency.max;
  const coResidency = Math.max(1, Math.floor(gpuBudget / Math.max(1, analyzerCost)));
  return (
    `[analyzer] up to K=${k} same-model analyzer calls run concurrently ` +
    `(Ensure OLLAMA_NUM_PARALLEL >= ${k}); ` +
    `distinct-model co-residency ceiling (GPU budget=${gpuBudget} / analyzer cost=${analyzerCost}) = ${coResidency}.`
  );
}

