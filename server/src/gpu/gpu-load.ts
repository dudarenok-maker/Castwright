import { withGpuLoadLock } from './load-mutex.js';
import { isAnyAnalysisBusy } from '../tts/design-lock.js';
import { capacityProbe } from './capacity-probe.js';
import { evictOllama } from '../analyzer/ollama-residency.js';

/** Thrown when a sidecar TTS/voice-design load cannot proceed because an
    analysis is in flight AND the card has no room to coexist. Routes map it to
    HTTP 409. */
export class GpuBusyError extends Error {
  readonly code = 'GPU_BUSY';
  constructor(message: string) {
    super(message);
    this.name = 'GpuBusyError';
  }
}

/** Rough free-VRAM (MB) a heavy TTS/voice-design model needs to load AND reach
    its decode peak alongside whatever else is resident. Set to the Qwen render
    decode peak (mirrors the sidecar `SEED_FOOTPRINTS_MB.qwen`); when the roomiest
    GPU has at least this much free (minus the reserve) we can coexist with a
    resident Ollama analyzer, otherwise we must free it first. This is the Node
    load-path replacement for the retired `gpu.safeCoexistMb` total-size threshold
    — measured free VRAM instead of a hand-set number. (The sidecar's own
    FootprintTable admission handles the synth path precisely once
    SEG_CAPACITY_ADMISSION is on; this coarse check protects the LOAD path in both
    flag states.) */
const HEAVY_TTS_DECODE_FLOOR_MB = 6144;

function reserveMb(): number {
  // Flat cap for this COARSE load-path check (subtracted from the roomiest
  // device's free VRAM). The sidecar admission path applies the same
  // GPU_RESERVE_MB as a PER-DEVICE cap — min(5% of the card, this value) — but
  // here we only have the roomiest free number, so the flat cap is the right
  // conservative floor. Fallback matches the sidecar default (500).
  const n = Number(process.env.GPU_RESERVE_MB);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

/** Run a sidecar model load safely w.r.t. VRAM.

    Decides coexist-vs-evict from MEASURED free VRAM (capacityProbe), the way the
    retired `gpu.safeCoexistMb` heuristic used total card size:
    - Roomy device (free − reserve ≥ a heavy TTS decode peak): load directly —
      a big card (e.g. 16 GB) coexists with a resident Ollama analyzer, even
      during an analysis, exactly as before.
    - Tight device, analysis idle: evict the resident Ollama analyzer first, so a
      heavy TTS model can't land on top of it and OOM an 8 GB card (the #1155/#1388
      co-residence class). This is the proactive evict the old `withGpuLoad` did on
      small cards; without it, a default (flag-OFF) 8 GB render OOMs.
    - Tight device, analysis in flight: refuse (GpuBusyError → 409) — we can't
      evict a live analyzer, so the caller retries once analysis finishes.

    `engineOnGpu` (default true): when false the engine can't contend for GPU
    memory, so all of this is skipped. */
export async function withGpuLoad<T>(loadFn: () => Promise<T>, engineOnGpu = true): Promise<T> {
  if (!engineOnGpu) return loadFn();
  // When capacity admission is on, the sidecar's PlacementController is the single
  // admission authority and Node's withCapacityRetry is the single eviction authority —
  // running this coarse Node probe/evict/lock too would triple-evict and let a bounded
  // poll hold the load mutex. Skip straight to the load. Default ON since #1720
  // shipped; only an explicit SEG_CAPACITY_ADMISSION=0 opt-out drops to the coarse path.
  if (process.env.SEG_CAPACITY_ADMISSION !== '0') return loadFn();
  return withGpuLoadLock(async () => {
    const devices = await capacityProbe.read({ fresh: true });
    const gpuFree = devices.filter((d) => d.kind !== 'cpu').map((d) => d.freeMb);
    const roomiestFree = gpuFree.length ? Math.max(...gpuFree) : 0;
    const fits = gpuFree.length > 0 && roomiestFree - reserveMb() >= HEAVY_TTS_DECODE_FLOOR_MB;

    if (fits) return loadFn(); // enough headroom to coexist — no evict, no busy-fail

    if (isAnyAnalysisBusy()) {
      throw new GpuBusyError('GPU busy with analysis — try again once it finishes.');
    }
    // Analysis idle and the card is tight: free the resident analyzer before the
    // heavy load so they can't co-reside and OOM.
    await evictOllama();
    return loadFn();
  });
}
