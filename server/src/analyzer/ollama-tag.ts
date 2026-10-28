/* #3084 wave 5 (N7) — Ollama model tag identity. A leaf (its one import, model-id.ts, is a leaf too), so
   reasoning.ts, capabilities.ts, workspace/analyzer-request-controls.ts and user-settings.ts can all use the
   one normaliser without a cycle. */
import { inferEngineFromModelId } from './model-id.js';

/** Strip a trailing ':latest' only (Ollama treats bare == :latest). Leaves real
    tags like 'qwen3.5:9b' untouched. */
export function normalizeModelTag(tag: string): string {
  return tag.endsWith(':latest') ? tag.slice(0, -':latest'.length) : tag;
}

/** N7 — the entry a per-model map holds for an Ollama model, whichever tag form it was saved under.
    The normalised key wins when both forms are present. */
export function entryForModelTag<T>(map: Readonly<Record<string, T>> | undefined, model: string): T | undefined {
  if (!map) return undefined;
  const key = normalizeModelTag(model);
  if (Object.hasOwn(map, key)) return map[key];
  const hit = Object.entries(map).find(([saved]) => normalizeModelTag(saved) === key);
  return hit?.[1];
}

/** N7 — the key a Test record is saved under: an Ollama tag through normalizeModelTag, so `qwen3` and
    `qwen3:latest` are one model; any other id (an endpoint id, a Gemini id) as is. */
export function capabilityRecordKey(modelId: string): string {
  return inferEngineFromModelId(modelId) === 'openai' ? modelId : normalizeModelTag(modelId);
}

/** A2 — whether two record keys name the same model, so the write can merge into the record saved under
    the other tag form and leave one key behind (an endpoint id is compared exactly; capabilityRecordKey
    leaves it as is). Lives here, not in capabilities.ts, so user-settings.ts's default matcher can use it
    without importing capabilities.ts (that would close a cycle through config/resolver). */
export function sameCapabilityRecordModel(a: string, b: string): boolean {
  return capabilityRecordKey(a) === capabilityRecordKey(b);
}
