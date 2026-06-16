import { getLastKnownVram } from './vram-state.js';
import { shouldEvictBeforeSidecarLoad } from './residency.js';
import { withGpuLoadLock } from './load-mutex.js';
import { unloadResidentOllama, verifyOllamaEvicted } from '../routes/ollama-health.js';
import { isAnyAnalysisBusy } from '../tts/design-lock.js';

/** Thrown when a sidecar TTS/voice-design load cannot proceed on a card that
    can't coexist — because an analysis is in flight, or eviction couldn't be
    confirmed. Routes map it to HTTP 409. */
export class GpuBusyError extends Error {
  readonly code = 'GPU_BUSY';
  constructor(message: string) {
    super(message);
    this.name = 'GpuBusyError';
  }
}

/** Run a sidecar model load safely w.r.t. the resident Ollama analyzer.
    - Roomy card / CPU: run the load directly (it fits; no serialisation needed).
    - Constrained card: under the load-mutex — refuse if analysis is busy
      (would have to evict an active analyzer), else evict ALL residents, verify
      they're gone (fail-closed), then run the load INSIDE the lock. */
export async function withGpuLoad<T>(loadFn: () => Promise<T>): Promise<T> {
  if (!shouldEvictBeforeSidecarLoad(getLastKnownVram())) {
    return loadFn();
  }
  return withGpuLoadLock(async () => {
    if (isAnyAnalysisBusy()) {
      throw new GpuBusyError('GPU busy with analysis — try again once it finishes.');
    }
    await unloadResidentOllama();
    if (!(await verifyOllamaEvicted())) {
      throw new GpuBusyError(
        'Could not free GPU memory (analyzer still resident) — try again shortly.',
      );
    }
    return loadFn();
  });
}
