/* Per-engine VRAM cost weights for the GPU semaphore (server/src/gpu/
   semaphore.ts). Each TTS engine — plus the analyzer (Ollama) — takes a
   number of tokens proportional to its VRAM footprint, so the semaphore
   admits a combination of ops only when their summed cost fits the budget.

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

import { configValue } from '../config/resolver.js';

/** VRAM token cost for an engine name (or 'analyzer'). For the five engines
    with registered gpu.weight.* knobs (kokoro/qwen/coqui/analyzer/asr) the
    value is read live through the registry so env vars and app overrides take
    effect. Gemini has no VRAM cost and stays at 0. Unknown engines fall back
    to cost 1 so a new engine never silently grabs the whole budget. */
export function costForEngine(engine: string): number {
  switch (engine) {
    case 'kokoro':
      return configValue<number>('gpu.weight.kokoro');
    case 'qwen':
      return configValue<number>('gpu.weight.qwen');
    case 'coqui':
      return configValue<number>('gpu.weight.coqui');
    case 'analyzer':
      return configValue<number>('gpu.weight.analyzer');
    case 'asr':
      return configValue<number>('gpu.weight.asr');
    case 'spk':
      return configValue<number>('gpu.weight.spk');
    case 'gemini':
      return 0; // no VRAM: always free
    default:
      return 1; // safe fallback
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
