import { gpuSemaphore } from '../gpu/semaphore.js';
import { activeGenerationBooks } from '../routes/generation.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

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
    Ollama model fits on a constrained GPU. Holds the FULL gpuSemaphore budget
    (NOT just the load-mutex — synthesis holds the semaphore per-chunk and never
    takes the mutex, so the mutex alone would let a /synthesize run during the
    unload and fail that render's chapter). Re-checks the durable generation flag
    inside the hold and refuses if a render is active. Releases the budget in
    `finally` so a refused evict never wedges the GPU. */
export async function unloadResidentSidecar(): Promise<void> {
  const release = await gpuSemaphore.acquire(gpuSemaphore.budget);
  try {
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
    const health = await fetch(`${url}/health`).then((r) => r.json()).catch(() => ({}));
    void health; // idempotent; /unload 200 is sufficient; health is diagnostic only.
  } finally {
    release();
  }
}
