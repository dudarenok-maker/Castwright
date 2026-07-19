/* Per-engine VRAM cost weights, historically charged against the GPU token-
   budget semaphore (retired — see costForEngine's docstring below). Each
   TTS engine — plus the analyzer (Ollama) — had a number of tokens
   proportional to its VRAM footprint, so the semaphore admitted a
   combination of ops only when their summed cost fit the budget.

   PROVISIONAL VALUES — these are first-cut estimates, not measured. They
   WILL be tuned once we have real VRAM telemetry on the target 8 GB box;
   see BACKLOG #39. The rationale behind DEFAULT_GPU_VRAM_BUDGET below
   documents the intended fits.

   Keyed loosely as Record<string, number> on purpose: the future `qwen`
   engine isn't yet in the TtsEngine union (added in a later wave), and the
   analyzer isn't a TtsEngine at all — so we don't tie this map to that
   union. Unknown keys fall back to cost 1 via costForEngine. */
export const ENGINE_VRAM_COST: Record<string, number> = {
  kokoro: 1,
  qwen: 1,
  coqui: 3,
  gemini: 0,
  analyzer: 4,
  /* ASR content-QA (srv-31). A tiny/base faster-whisper int8 model is only
     ~150–400 MB, so it costs the same single token as Kokoro/Qwen — it admits
     alongside one of them (1+1=2 ≤ 4) but serialises behind a Coqui (3) or the
     analyzer (4). ONLY charged when ASR runs on the GPU (ASR_DEVICE=cuda); the
     CPU-default path takes no token at all (see transcribe-client.ts). */
  asr: 1,
  /* Render-integrity ECAPA speaker embed (srv-47). The speechbrain ECAPA-TDNN
     model is ~80–200 MB — a single token like Kokoro/Qwen/ASR. ONLY charged
     when the embed runs on the GPU (SPK_DEVICE=cuda); the CPU-default path
     takes no token at all (see embed-client.ts). */
  spk: 1,
};

import { getLastKnownAnalyzerDevice } from '../gpu/analyzer-device-state.js';

/** VRAM token cost for an engine name (or 'analyzer'). Historically read live
    through the registry's gpu.weight.* knobs so an env var / app override
    could retune it without a restart — those knobs were deleted along with
    the GPU token-budget semaphore they fed (capacity-aware placement now
    arbitrates VRAM on the sidecar side, see docs/features/vram-aware-
    placement), so this now returns the static ENGINE_VRAM_COST weight
    directly. Gemini has no VRAM cost and stays at 0. Unknown engines fall
    back to cost 1. The analyzer is an exception (W2.6): a CONFIRMED-cpu
    analyzer can't contend for GPU memory at all, so it's charged 0 instead
    of its static weight.

    NOTE: costForEngine has no live caller left in the codebase — the GPU
    semaphore it fed was removed in the capacity-aware-placement cutover.
    Kept (per this delete task's explicit instruction) rather than removed;
    flagged for the whole-branch review to decide whether this module is now
    safe to retire outright. */
export function costForEngine(engine: string): number {
  switch (engine) {
    case 'analyzer':
      // W2.6 "don't cross-charge": a CONFIRMED-cpu analyzer can't contend for
      // GPU memory at all, so it shouldn't consume semaphore budget. An
      // UNKNOWN placement stays charged (conservative — matches the old
      // residency.ts "unknown → assume GPU" convention).
      return getLastKnownAnalyzerDevice() === 'cpu' ? 0 : ENGINE_VRAM_COST.analyzer;
    case 'gemini':
      return 0; // no VRAM: always free
    default:
      return ENGINE_VRAM_COST[engine] ?? 1; // safe fallback for an unknown engine
  }
}

/* Suggested GPU_VRAM_BUDGET for an 8 GB GPU. NOTE: this is only the value to
   document in server/.env.example — when GPU_VRAM_BUDGET is UNSET the
   semaphore falls back to GPU_CONCURRENCY (default 1), NOT this constant.

   Budget 4 fits the intended concurrency story:
     - Kokoro (1) + Qwen (1) run together (2 ≤ 4) — the common dual-TTS case.
     - Coqui (3) fits on its own and even leaves room for one Kokoro (3+1=4).
     - Coqui (3) + another Coqui (3) = 6 > 4 → the second serialises.
     - The analyzer (4) consumes the whole budget, so analysis serialises
       against any TTS op — analyzer and TTS already evict each other on the
       GPU, so co-residence would just thrash. */
export const DEFAULT_GPU_VRAM_BUDGET = 4;
