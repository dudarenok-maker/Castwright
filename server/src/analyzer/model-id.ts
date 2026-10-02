/* Analyzer model-id grammar (#3084 spec §3 "Id grammar"). LEAF MODULE — it
   imports nothing, so user-settings.ts, routes, transports and the frontend's
   drift test can import it without closing an import cycle.

   Shapes:
     - OpenAI-compatible endpoint: `openai:<endpointId>::<model>`
     - Ollama: contains ':'  (`qwen3.5:4b`; `openai:latest` has no '::')
     - Gemini: anything else (`gemini-3.6-flash`, `gemma-4-31b-it`)

   Order matters: the endpoint shape is tested FIRST because every endpoint id
   also contains ':'. Ollama model names cannot contain '::' (ollama
   types/model/name.go), so no Ollama tag matches it.

   One case table drives this module and src/lib/model-id.ts:
   __fixtures__/model-id-cases.json. Change both files and the table together. */

export type AnalysisEngine = 'local' | 'gemini' | 'openai';

/** A saved endpoint id: 1–40 lowercase letters, digits or hyphens. */
export const ENDPOINT_ID_PATTERN = /^[a-z0-9-]{1,40}$/;

const ENDPOINT_MODEL_ID = /^openai:([a-z0-9-]+)::([\s\S]*)$/;

export function inferEngineFromModelId(id: string): AnalysisEngine {
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
