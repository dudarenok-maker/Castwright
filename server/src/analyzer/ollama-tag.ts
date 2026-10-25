/* #3084 wave 5 (N7) — Ollama model tag identity. A leaf with no imports, so reasoning.ts, capabilities.ts,
   workspace/analyzer-request-controls.ts and user-settings.ts can all use the one normaliser without a cycle. */

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
