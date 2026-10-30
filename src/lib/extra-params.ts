/* #3084 wave 5 — frontend payload helpers. Semantic validation (protected keys)
   is server-side; these only parse the textarea and mirror the output-cap/label
   rule, pinned to the server by the shared extra-params-cases.json fixture. */
export type PayloadKind = 'ollama' | 'gemini' | 'openai';
type Json = Record<string, unknown>;

export function parseExtraParamsText(text: string): { ok: true; value: Json | undefined } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Must be a JSON object, for example {"top_k": 40}.' };
  }
  return { ok: true, value: parsed as Json };
}

const OUTPUT_CAP: Record<PayloadKind, { container: string | null; keys: readonly string[] }> = {
  openai: { container: null, keys: ['max_tokens', 'max_completion_tokens', 'n_predict'] }, // N9: llama.cpp's n_predict
  ollama: { container: 'options', keys: ['num_predict'] },
  gemini: { container: 'config', keys: ['maxOutputTokens'] },
};

export function payloadSetsOutputCap(kind: PayloadKind, params: Json | undefined): boolean {
  if (!params) return false;
  const { container, keys } = OUTPUT_CAP[kind];
  const scope = container === null ? params : params[container];
  return typeof scope === 'object' && scope !== null && !Array.isArray(scope) && keys.some((k) => Object.hasOwn(scope, k));
}

export function requestControlsLabelParts(kind: PayloadKind, params: Json | undefined): string[] {
  if (!params || Object.keys(params).length === 0) return [];
  return payloadSetsOutputCap(kind, params) ? ['+ custom params', 'max output set by custom params'] : ['+ custom params'];
}
