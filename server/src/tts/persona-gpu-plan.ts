import { activeGenerationBooks } from '../routes/generation.js';
import { isOtherBookDesignBusy, isAnyAnalysisBusy } from './design-lock.js';
import { personaSharesGpu } from '../analyzer/voice-style.js';

/* Voice-design (persona) keep-alive is a fixed window, independent of the
   per-model analyzer map: the persona local model is kept warm across a
   cast-review session (back-to-back designs) then freed by the design idle
   watchdog. 300 s preserves the historical '5m'. */
const PERSONA_KEEP_ALIVE_SECONDS = 300;

export interface PersonaGpuPlan {
  onCpu: boolean;
  keepAlive: string | number;
}

/** Decide how the local persona call should use the GPU for `bookDir`. "Busy"
    is the durable render flag (a render is mid-job for its whole duration,
    not just between per-chunk GPU holds), another book's design in flight, or
    the analyzer.

    Reverse-eviction of the sidecar's resident Qwen models to make room for
    the persona Ollama call on a constrained GPU — gated on the now-retired
    `gpu.safeCoexistMb` heuristic — is gone: VRAM arbitration for the
    sidecar's own engines now lives in its capacity admission
    (SEG_CAPACITY_ADMISSION) when that flag is on; when it's off, the
    sequential workflow (design happens in cast-review, render happens after)
    keeps them from actually overlapping, so no proactive Node-side eviction
    is needed here any more — busy still falls back to CPU, idle just runs on
    GPU directly. That CPU fallback is local Ollama's alone: an OpenAI-compatible
    endpoint ignores the plan, so on a same-card endpoint the protection against a busy
    card is the frontend's pause-generation confirm (useLocalAnalyzerGuard, purpose
    'design'), not this function. */
export function resolvePersonaGpuPlan(bookDir: string): PersonaGpuPlan {
  const busy =
    activeGenerationBooks().length > 0 ||
    isOtherBookDesignBusy(bookDir) ||
    isAnyAnalysisBusy();

  return busy
    ? { onCpu: true, keepAlive: 0 }
    : { onCpu: false, keepAlive: PERSONA_KEEP_ALIVE_SECONDS };
}

/** Resolve the GPU plan for a persona batch on `bookDir`, returning the
    per-call args to thread into generateVoiceStylePersona. Used by both
    voice-style routes and the bulk pre-pass so the decision lives in exactly
    one place.

    - persona does not share the GPU (gemini, or an OpenAI-compatible endpoint on
      no card or on a card Qwen does not use) → `{ onCpu: false, keepAlive: 0 }`.
    - persona shares the GPU (local Ollama, or an endpoint on the Qwen card, #3084 W4)
      → resolve the plan directly. Only the Ollama transport reads `onCpu`/`keepAlive`;
      for an endpoint a busy plan is ignored server-side (the call still goes to the card),
      and what "like local" buys it is the design job's ordering (personas before
      VoiceDesign loads — see routes/cast-design.ts). The protection against a render on
      that card is the frontend's pause-generation confirm before the design starts.

    `_signal` is kept in the signature for call-site compatibility
    (`routes/cast-design.ts` still passes its job's AbortSignal), but is
    unused — there is nothing here to abort. */
export async function preparePersonaBatch(
  bookDir: string,
  _signal?: AbortSignal,
): Promise<{ onCpu: boolean; keepAlive: string | number }> {
  if (!personaSharesGpu()) return { onCpu: false, keepAlive: 0 };
  return resolvePersonaGpuPlan(bookDir);
}
