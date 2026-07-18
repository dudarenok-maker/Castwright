import { activeGenerationBooks } from '../routes/generation.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { shouldEvictBeforeSidecarLoad } from '../gpu/residency.js';
import { getLastKnownVram } from '../gpu/vram-state.js';
import { engineDeviceIsGpu } from '../gpu/engine-device.js';
import { isOtherBookDesignBusy, isAnyAnalysisBusy } from './design-lock.js';
import { resolvePersonaEngine } from '../analyzer/voice-style.js';

/* Voice-design (persona) keep-alive is a fixed window, independent of the
   per-model analyzer map: the persona local model is kept warm across a
   cast-review session (back-to-back designs) then freed by the design idle
   watchdog. 300 s preserves the historical '5m'. */
const PERSONA_KEEP_ALIVE_SECONDS = 300;

/** Thrown when the sidecar can't be safely unloaded for a persona run because a
    render is active. The caller falls back to CPU persona generation. */
export class GpuBusyForPersonaError extends Error {
  readonly code = 'GPU_BUSY_FOR_PERSONA';
  constructor(message: string) {
    super(message);
    this.name = 'GpuBusyForPersonaError';
  }
}

/** Reverse-evict: free the sidecar's resident Qwen models so a local persona
    Ollama model fits on a constrained GPU. Refuses (throwing
    GpuBusyForPersonaError) if a render is active, checked via the durable
    `activeGenerationBooks` flag. No longer holds a full-budget gpuSemaphore
    lock around the unload — same-engine/cross-book serialization against a
    concurrent render now lives in the sidecar (`_synth_lock` + the sidecar
    load locks), not a Node-side mutex. */
export async function unloadResidentSidecar(): Promise<void> {
  if (activeGenerationBooks().length > 0) {
    throw new GpuBusyForPersonaError('A render is active — skip the GPU persona pre-pass.');
  }
  const url = getResolvedSidecarUrl();
  const res = await fetch(`${url}/unload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'qwen' }), // frees Qwen Base + VoiceDesign
  });
  if (!res.ok) {
    throw new Error(`Sidecar /unload returned ${res.status} ${res.statusText}`);
  }
  // Best-effort health verify — /health is the sidecar's own endpoint (not the Node proxy).
  const health = await fetch(`${url}/health`).then((r) => r.json()).catch((e) => { console.warn('[persona-gpu-plan] sidecar /health probe failed after /unload (best-effort):', (e as Error).message); return {}; });
  void health; // idempotent; /unload 200 is sufficient; health is diagnostic only.
}

export interface PersonaGpuPlan {
  onCpu: boolean;
  evict: boolean;
  keepAlive: string | number;
}

/** Decide how the local persona call should use the GPU for `bookDir`. See the
    spec's decision table. "Busy" is the durable render flag (a render is
    mid-job for its whole duration, not just between per-chunk GPU holds). */
export function resolvePersonaGpuPlan(bookDir: string): PersonaGpuPlan {
  const constrained = shouldEvictBeforeSidecarLoad(getLastKnownVram(), engineDeviceIsGpu('qwen'));
  if (!constrained) return { onCpu: false, evict: false, keepAlive: 0 };

  const busy =
    activeGenerationBooks().length > 0 ||
    isOtherBookDesignBusy(bookDir) ||
    isAnyAnalysisBusy();

  return busy
    ? { onCpu: true, evict: false, keepAlive: 0 }
    : { onCpu: false, evict: true, keepAlive: PERSONA_KEEP_ALIVE_SECONDS };
}

/** Resolve the GPU plan for a persona batch on `bookDir` and perform the
    one-shot reverse-evict if needed, returning the per-call args to thread
    into generateVoiceStylePersona. Used by both voice-style routes and the
    bulk pre-pass so the evict dance lives in exactly one place.

    - gemini engine → `{ onCpu: false, keepAlive: 0 }` (off-GPU, no evict).
    - local engine → resolve the plan; if evict, unload once; on
      GpuBusyForPersonaError (a render slipped in) fall back to CPU.

    `_signal` is kept in the signature for call-site compatibility
    (`routes/cast-design.ts` still passes its job's AbortSignal), but is
    unused now that `unloadResidentSidecar` no longer waits on a full-budget
    gpuSemaphore acquire — there is nothing left to abort. */
export async function preparePersonaBatch(
  bookDir: string,
  _signal?: AbortSignal,
): Promise<{ onCpu: boolean; keepAlive: string | number }> {
  if (resolvePersonaEngine() !== 'local') return { onCpu: false, keepAlive: 0 };
  const plan = resolvePersonaGpuPlan(bookDir);
  if (plan.evict) {
    try {
      await unloadResidentSidecar();
    } catch (err) {
      // Render slipped in (GpuBusy) → fall back to CPU.
      if (err instanceof GpuBusyForPersonaError) {
        return { onCpu: true, keepAlive: 0 };
      }
      throw err;
    }
  }
  return { onCpu: plan.onCpu, keepAlive: plan.keepAlive };
}
