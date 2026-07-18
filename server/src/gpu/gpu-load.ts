import { withGpuLoadLock } from './load-mutex.js';
import { isAnyAnalysisBusy } from '../tts/design-lock.js';

/** Thrown when a sidecar TTS/voice-design load cannot proceed because an
    analysis is in flight. Routes map it to HTTP 409. */
export class GpuBusyError extends Error {
  readonly code = 'GPU_BUSY';
  constructor(message: string) {
    super(message);
    this.name = 'GpuBusyError';
  }
}

/** Run a sidecar model load, refusing (GpuBusyError) while an analysis is in
    flight so a load can't race a live analyzer call.

    Card-size-based pre-load eviction of the resident Ollama analyzer (the old
    "big card ⇒ coexist, small card ⇒ evict" heuristic, gated on the now-
    retired `gpu.safeCoexistMb`) is gone: VRAM arbitration now lives in the
    sidecar's own capacity admission (SEG_CAPACITY_ADMISSION) when that flag
    is on; when it's off, Ollama frees the GPU via its own keep_alive idiom
    between the analysis and render phases of the (now-sequential) workflow,
    so no proactive Node-side eviction is needed here any more.

    `engineOnGpu` (W2.6, default true): the engine about to load. When false,
    it categorically can't contend with the analyzer for GPU memory, so the
    busy check is skipped entirely. */
export async function withGpuLoad<T>(loadFn: () => Promise<T>, engineOnGpu = true): Promise<T> {
  if (!engineOnGpu) return loadFn();
  return withGpuLoadLock(async () => {
    if (isAnyAnalysisBusy()) {
      throw new GpuBusyError('GPU busy with analysis — try again once it finishes.');
    }
    return loadFn();
  });
}
