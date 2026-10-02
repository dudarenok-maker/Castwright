/* Frontend twin of server/src/analyzer/model-id.ts (#3084 spec §3). Both are
   driven by server/src/analyzer/__fixtures__/model-id-cases.json, and
   model-id.test.ts asserts the two agree on every table id and near-miss.
   Change both files and the table together. Leaf module — no imports. */

export type AnalysisEngine = 'local' | 'gemini' | 'openai';

/** A saved endpoint id: 1–40 lowercase letters, digits or hyphens. */
export const ENDPOINT_ID_PATTERN = /^[a-z0-9-]{1,40}$/;

const ENDPOINT_MODEL_ID = /^openai:([a-z0-9-]+)::([\s\S]*)$/;

export function engineForModelId(id: string): AnalysisEngine {
  if (ENDPOINT_MODEL_ID.test(id)) return 'openai';
  return id.includes(':') ? 'local' : 'gemini';
}

export function parseEndpointModelId(id: string): { endpointId: string; model: string } | null {
  const m = ENDPOINT_MODEL_ID.exec(id);
  return m ? { endpointId: m[1], model: m[2] } : null;
}

export function endpointModelId(endpointId: string, model: string): string {
  if (!ENDPOINT_ID_PATTERN.test(endpointId)) {
    throw new Error(
      `Invalid endpoint id "${endpointId}" — use 1–40 lowercase letters, digits or hyphens.`,
    );
  }
  if (model.length === 0) throw new Error('An endpoint model id needs a non-empty model name.');
  return `openai:${endpointId}::${model}`;
}
