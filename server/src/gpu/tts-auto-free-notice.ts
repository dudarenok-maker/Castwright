/* Last "TTS models unloaded to free VRAM" event (#4066).

   When a voice design or a Quality (1.7B) op is refused for GPU capacity, the
   admission lever (./evict-idle-tts.ts) unloads the resident standard Qwen
   base and an on-GPU Kokoro to make room. The browser did not ask for that
   unload, so it has no way to know it happened. This module keeps the latest
   such event, and GET /api/gpu/queue (routes/gpu-queue.ts) hands it to the
   frontend's 30 s poll, which shows the existing "unloaded to free VRAM"
   notice (src/lib/use-tts-lifecycle.ts) once per new `seq`.

   This module imports NOTHING, so it cannot join an import cycle, the same as
   the other leaf modules in this directory. */

export type TtsAutoFreePurpose = 'voice design' | 'Quality render';

export interface TtsAutoFreeNotice {
  /** Identifies this server process. `seq` restarts at 1 after a Node restart,
      so the frontend compares `bootId` + `seq`, never `seq` alone — otherwise
      the first event after a restart can look like the one already shown. */
  bootId: string;
  /** Monotonic per-event counter (within one `bootId`), so the frontend shows
      each event once even when two events free the same models. */
  seq: number;
  /** Display names of what was unloaded, e.g. ['Qwen 0.6B', 'Kokoro']. */
  models: string[];
  purpose: TtsAutoFreePurpose;
  /** ISO timestamp, for logs and diagnostics only. */
  at: string;
}

/* Process-start timestamp: unique per Node process without an import. */
const bootId = new Date().toISOString();
let seq = 0;
let last: TtsAutoFreeNotice | null = null;

export function recordTtsAutoFree(models: string[], purpose: TtsAutoFreePurpose): void {
  if (models.length === 0) return;
  seq += 1;
  last = { bootId, seq, models: [...models], purpose, at: new Date().toISOString() };
}

export function getLastTtsAutoFree(): TtsAutoFreeNotice | null {
  return last;
}

/** Test isolation only. */
export function resetTtsAutoFreeForTests(): void {
  last = null;
}
