/* Analyzer concurrency control. Two primitives + one helper:
   - analyzerConcurrency: a width-K FIFO count semaphore capping TOTAL in-flight
     analyzer /api/chat calls across all jobs/models (bounds Ollama-slot pressure).
     Independent of GPU_VRAM_BUDGET, so raising K never changes TTS width.
   - a per-RESIDENT-MODEL refcounted lease that holds ONE cross-engine gpuSemaphore
     slot (cost 4) while a given model has any call in flight: K same-model calls
     share one slot (concurrency); two different local models each take a slot and
     serialize on a small budget (no co-residence OOM); cloud (cost 0) overlaps.
   Every analyzer call goes through acquireAnalyzerSlot(model, onCpu): limiter FIRST,
   then the model-lease. See the spec's two concurrency cruxes — the sync-store in
   enter() and the fully-synchronous leave() are load-bearing. */
import { GpuSemaphore, gpuSemaphore } from '../gpu/semaphore.js';
import { costForEngine } from '../tts/engine-vram-cost.js';
import { configValue } from '../config/resolver.js';

function resolveK(): number {
  const k = configValue<number>('analyzer.ollama.concurrency');
  return Number.isFinite(k) && k > 0 ? Math.floor(k) : 1;
}

export const analyzerConcurrency = new GpuSemaphore(resolveK());

/** Canonicalise a model tag so one physical model has one lease key
    (mirrors canonicalVramKey: a bare tag gets ':latest'). */
export function canonicalLeaseKey(model: string): string {
  return model.includes(':') ? model : `${model}:latest`;
}

type Lease = { count: number; p: Promise<() => void> | null; release: (() => void) | null };
const leases = new Map<string, Lease>();

/* Enter the per-model lease. CPU calls take NO gpuSemaphore slot (mirrors
   acquireGpuTokenIfOnGpu). CRUX 1: store `lease.p` synchronously before await.
   CRUX 2: this function's count mutation stays in the pre-await prefix. */
async function enterModelLease(key: string, onCpu: boolean): Promise<() => void> {
  if (onCpu) return () => {}; // no GPU slot; limiter (taken by caller) still bounds it
  let lease = leases.get(key);
  if (!lease) { lease = { count: 0, p: null, release: null }; leases.set(key, lease); }
  lease.count++;
  if (lease.count === 1) {
    lease.p = gpuSemaphore.acquire(costForEngine('analyzer')); // ← sync store BEFORE await
    try {
      lease.release = await lease.p;
    } catch (e) {
      lease.count--;
      if (lease.count === 0) leases.delete(key);
      throw e; // unreachable today (acquire w/o signal never rejects); defensive
    }
  } else {
    try {
      await lease.p; // join: block until holder's acquire resolves
    } catch (e) {
      lease.count--;
      if (lease.count === 0) leases.delete(key); // symmetry with the holder catch (dead path today)
      throw e;
    }
  }
  return () => leaveModelLease(key);
}

/* CRUX 2: fully synchronous — no await. */
function leaveModelLease(key: string): void {
  const lease = leases.get(key);
  if (!lease) return;
  lease.count--;
  if (lease.count === 0) {
    const r = lease.release;
    leases.delete(key);
    r?.();
  }
}

/** The one entry point for every analyzer Ollama call. limiter → model-lease.
    Returns a single idempotent release that frees both in reverse order. */
export async function acquireAnalyzerSlot(model: string, onCpu: boolean): Promise<() => void> {
  const releaseLimiter = await analyzerConcurrency.acquire();
  let releaseLease: () => void;
  try {
    releaseLease = await enterModelLease(canonicalLeaseKey(model), onCpu);
  } catch (e) {
    releaseLimiter();
    throw e;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseLease();
    releaseLimiter();
  };
}

/** Effective analyzer concurrency for the startup log (M4). The gpuSemaphore
    clamps the per-call cost to ≥1, so the ceiling is min(K, max(1, floor(budget/cost))). */
export function describeAnalyzerConcurrency(analyzerCost: number, gpuBudget: number): string {
  const k = analyzerConcurrency.budget;
  const admits = Math.max(1, Math.floor(gpuBudget / Math.max(1, analyzerCost)));
  const effective = Math.min(k, admits);
  return `[analyzer] concurrency K=${k}, GPU budget=${gpuBudget}, analyzer cost=${analyzerCost} -> effective ${effective} concurrent GPU call(s). Ensure OLLAMA_NUM_PARALLEL >= ${k}.`;
}

/** Test-only: clear the lease map between cases. */
export function __resetAnalyzerLeasesForTest(): void {
  leases.clear();
}
