/* Ollama analyzer settings resolvers and keep-alive policy (moved verbatim from
   ollama.ts, #3084 wave 1). A leaf: transports and retry policies import it
   without importing ollama.ts. */
import { configValue } from '../config/resolver.js';
import { getCachedUserSettings } from '../workspace/user-settings.js';
import { isAnyAnalyzerRunBusy } from '../tts/design-lock.js';
import type { Accelerator } from '../gpu/vram-state.js';

/* Default sampling temperature for /api/chat. Low enough that the model
   sticks close to the schema and the system prompt's structural rules, but
   not zero — pure-greedy decoding makes the validation-retry loop a no-op
   because attempt 2 is just attempt 1 again.
   Read through the registry so the operator can tune without a rebuild;
   kept as an exported const for any importer that references the symbol
   directly (the value is evaluated at module load — use configValue for
   a live read). */
export const DEFAULT_TEMPERATURE = 0.2;
/* Retry temperature — kept for compat; use resolveOllamaTemperature() /
   resolveOllamaRetryTemperature() for live values. */
export const INVALID_JSON_RETRY_TEMPERATURE = 0.6;

/** Live-read first-attempt temperature (registry wins over the const). */
export function resolveOllamaTemperature(): number {
  return configValue<number>('analyzer.ollama.temperature');
}
/** Live-read invalid-JSON retry temperature (registry wins over the const). */
export function resolveOllamaRetryTemperature(): number {
  return configValue<number>('analyzer.ollama.retryTemperature');
}

/* Fallback keep-alive (seconds) for any analyzer model WITHOUT an explicit
   per-model override in userSettings.analyzerKeepAliveByModel. Deliberately a
   single flat value — the previous per-model curated map (qwen3.5:4b→300 etc.)
   was removed: it left every UNCURATED tag (a Castwright fine-tune like
   qwen36-cw-iq4-32k, any pulled community model) falling through to 0, which is
   Ollama's EVICT-IMMEDIATELY idiom — so the analyzer unloaded after every
   /api/chat call and cold-reloaded on the next, thrashing a whole run. 30s
   comfortably bridges the gap between back-to-back attribution calls (which
   refresh the timer) so the model stays resident through a run, while still
   idling out ~30s after the run ends. Raise per-model in Model Manager for a
   longer hold; 0 (evict) / -1 (pin) remain available as explicit overrides. */
const DEFAULT_ANALYZER_KEEP_ALIVE_SECONDS = 30;

/* Models unsafe to keep resident on CPU (would pin ~6.4 GB system RAM for the
   whole window). Clamped to 0 on a CPU-only box regardless of the configured
   value. Orthogonal to the per-model map — a deliberate safety rail. */
const RAM_HEAVY_MODELS = new Set(['qwen3.5:9b']);

/** Strip a trailing ':latest' only (Ollama treats bare == :latest). Leaves real
    tags like 'qwen3.5:9b' untouched. */
export function normalizeModelTag(tag: string): string {
  return tag.endsWith(':latest') ? tag.slice(0, -':latest'.length) : tag;
}

/** Resolved keep-alive (seconds) for `model`: user override (raw or normalized
    key) → flat DEFAULT_ANALYZER_KEEP_ALIVE_SECONDS (30). Reads the settings
    cache synchronously so it is safe at the request-body build site. */
export function resolveKeepAliveSeconds(model: string): number {
  const map = getCachedUserSettings().analyzerKeepAliveByModel ?? {};
  const norm = normalizeModelTag(model);
  const override = map[model] ?? map[norm];
  if (override !== undefined) return override;
  return DEFAULT_ANALYZER_KEEP_ALIVE_SECONDS;
}

/** True when the user has an explicit override for `model` (raw or normalized). */
export function hasKeepAliveOverride(model: string): boolean {
  const map = getCachedUserSettings().analyzerKeepAliveByModel ?? {};
  return map[model] !== undefined || map[normalizeModelTag(model)] !== undefined;
}

/** Full keep-alive policy for `model` on `accelerator`. Returns -1 (pin) while
    a run is busy so the model stays resident for the whole run; 0 (evict) for
    RAM-heavy models on CPU; otherwise the per-model or flat-default value. */
export function keepAliveFor(model: string, accelerator: Accelerator = 'unknown'): number {
  if (isAnyAnalyzerRunBusy()) return -1;
  if (RAM_HEAVY_MODELS.has(model) && accelerator === 'cpu') return 0;
  return resolveKeepAliveSeconds(model);
}

/* num_ctx the analyzer hands Ollama on every /api/chat call (see the
   structured-output runStage path below). Exported so the in-app Load
   button's warming probe can pass the same value — Ollama treats
   (model, num_ctx) as the cache key, so warming with default 2048 and
   then running with 16384 triggers a full model reload mid-request,
   which surfaces to the UI as "stream ended without a result event"
   while Ollama re-paged the model.
   Kept as static export for compat; call-sites inside this module use
   resolveAnalyzerNumCtx() / resolveAnalyzerNumGpu() for live values. */
export const ANALYZER_NUM_CTX = 32768;

/* Force Ollama to load every layer of the model onto the GPU. 999 is
   the standard idiom for "all layers" — it exceeds any model's actual
   layer count, so Ollama clamps to the real value (32 for llama3.1:8b,
   40 for qwen3.5:9b, etc.). Hard-coding to 999 means this knob is
   correct for every supported tag without a per-model lookup.
   Without this hint, Ollama makes its own auto-split decision based on
   a VRAM-headroom heuristic that turns out to be twitchy under
   pressure: at llama3.1:8b + num_ctx 16384, ollama ps reported
   "8.0 GB, 8%/92% CPU/GPU" — ~640 MB silently offloaded to system RAM,
   which dragged stage-2 wall-clock measurably. Combined with
   the daemon's OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0 env
   pair (see docs/local-llm.md "Pinning the analyzer to 100% GPU"),
   this pins the analyzer to GPU-only and produces a clean OOM if the
   budget is ever exceeded, instead of a silent slowdown the user can't
   diagnose from the UI. Exported for the in-app Load button to thread
   the same value (Ollama treats num_gpu as part of the load-time cache
   key the same way num_ctx is — mismatching values between /load and
   the first /api/chat call triggers a silent reload mid-stream). */
export const ANALYZER_NUM_GPU = 999;

/** Live-read num_ctx (registry wins over the const). */
export function resolveAnalyzerNumCtx(): number {
  return configValue<number>('analyzer.ollama.numCtx');
}
/** Live-read num_gpu (registry wins over the const). */
export function resolveAnalyzerNumGpu(): number {
  return configValue<number>('analyzer.ollama.numGpu');
}

/* Optional explicit output-token cap (`num_predict`). Unset → -1 (Ollama's
   "predict until the context window fills"), which on a huge stage-2 chapter
   silently truncates the JSON once input + output brush num_ctx. The
   `done_reason: 'length'` check in chat() turns any such truncation into a
   loud AnalyzerTruncatedError (#528); this knob lets an operator cap output
   sooner. Shares the env name with Gemini's maxOutputTokens knob's sibling. */
export function resolveNumPredict(): number {
  // 0 is pathological (a zero-token cap truncates all output); preserve the
  // historical behaviour where 0 is treated as "no explicit cap" (-1).
  const n = configValue<number>('analyzer.ollama.numPredict');
  return n === 0 ? -1 : n;
}