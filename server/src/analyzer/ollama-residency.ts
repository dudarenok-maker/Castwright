/* Node-side Ollama residency read + eviction — infrastructure for the
   capacity-aware GPU placement feature. The TTS sidecar returns HTTP 503
   { noCapacity, neededMb, deviceKey } when a synth op can't fit; Node needs
   to decide whether evicting the resident Ollama analyzer would free enough
   VRAM, and if so, evict it. This module is that read + evict action only —
   it is not wired into the retry/placement decision yet (a follow-up task). */

import { getResolvedOllamaUrl } from '../workspace/user-settings.js';

/** Same 2s probe ceiling as the other Ollama health probes
    (routes/ollama-health.ts) — a hung daemon must not pin a capacity check. */
const RESIDENCY_TIMEOUT_MS = 2_000;

export interface OllamaResidency {
  totalVramMb: number;
  models: string[];
  reachable: boolean;
}

interface OllamaPsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    /** VRAM (bytes) the model currently holds; 0 for a CPU-only load. */
    size_vram?: number;
  }>;
}

/** Reads Ollama's /api/ps (resident models) and sums size_vram (bytes) into
    MB. Never throws — any failure (unreachable daemon, non-2xx, unparsable
    body) collapses to the "nothing resident" shape so callers can treat it
    uniformly as "no VRAM to reclaim here" rather than special-casing errors. */
export async function readOllamaResidency(): Promise<OllamaResidency> {
  const url = getResolvedOllamaUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESIDENCY_TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}/api/ps`, { method: 'GET', signal: controller.signal });
    if (!resp.ok) return { totalVramMb: 0, models: [], reachable: false };
    // Deliberately NOT swallowed with a `.catch(() => ({}))` fallback here — a
    // bad/unparsable body from an "ok" response is exactly the "can't trust
    // what we got" case the outer catch below is for, so let it propagate.
    const body = (await resp.json()) as OllamaPsResponse;
    const list = Array.isArray(body.models) ? body.models : [];
    const totalVramBytes = list.reduce((sum, m) => sum + (m.size_vram ?? 0), 0);
    return {
      totalVramMb: Math.round(totalVramBytes / 1_048_576),
      // Ollama /api/ps entries are usually keyed by `name`; some installs only
      // populate `model`. Fall back so a real-world response doesn't drop names.
      models: list.map((m) => m.name ?? m.model ?? '').filter(Boolean),
      reachable: true,
    };
  } catch {
    return { totalVramMb: 0, models: [], reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Forces every currently-resident Ollama model to unload NOW via Ollama's
    immediate-unload idiom — an empty-prompt, keep_alive:0 POST /api/generate
    per model (the same idiom keepAliveFor()/routes/ollama-health.ts use
    elsewhere for the in-app Stop button). Best-effort: never throws. A
    per-model failure, or an unreachable daemon, is swallowed — this is a
    capacity-freeing nudge, not a guaranteed action; the caller re-checks
    capacity after calling this and falls back to queuing if it didn't help. */
export async function evictOllama(): Promise<void> {
  const { models, reachable } = await readOllamaResidency();
  if (!reachable || models.length === 0) return;
  const url = getResolvedOllamaUrl();
  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESIDENCY_TIMEOUT_MS);
    try {
      await fetch(`${url}/api/generate`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
      });
    } catch {
      // Best-effort — one model's failed evict shouldn't block the rest.
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Optimistic single-device capacity estimate: would evicting the resident
    Ollama analyzer free enough VRAM — combined with what's already free on
    the target device — to fit `neededMb`? Treats ALL Ollama-held VRAM as
    freeable on the target device; on a multi-GPU box that can overestimate
    if Ollama and the target op sit on different devices. That's an
    acceptable optimism: a wrong "yes" here just triggers an evict + a real
    capacity re-check before the retry, which falls back to queuing if the
    freed VRAM wasn't actually on the right device. A wrong-pessimistic
    check would instead skip a real fix, which is strictly worse. */
export async function analyzerEvictWouldHelp(neededMb: number, freeOnDeviceMb: number): Promise<boolean> {
  const { totalVramMb } = await readOllamaResidency();
  return totalVramMb + freeOnDeviceMb >= neededMb;
}
