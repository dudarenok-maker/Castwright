/* #3084 W3 — builds the Test action's dependencies for one model id: the transport,
   the server URL its record binds to, the configured structured-output mode, the
   provider's schema adapter, and the limits the probe cap is resolved from (P7).
   Enforces the key-origin rule before any transport exists. */
import { configValue } from '../config/resolver.js';
import { getResolvedGeminiApiKey, type UserSettings } from '../workspace/user-settings.js';
import { getResolvedOllamaUrl } from '../config/ollama-resolved.js';
/* Known secrets come through 3b's leaf gate, never from user-settings.ts (A9). */
import { knownAnalyzerSecrets } from './known-secrets-gate.js';
import { resolveEndpointApiKey } from '../workspace/analyzer-endpoints.js';
import { redactKnownSecrets } from './redact.js';
import { inferEngineFromModelId, parseEndpointModelId } from './model-id.js';
import { AnalyzerEndpointMissingError } from './errors.js';
import { OllamaTransport } from './transports/ollama-transport.js';
import { GeminiTransport } from './transports/gemini-transport.js';
import { OpenAITransport } from './transports/openai-transport.js';
import { adaptSchemaForGemini, adaptSchemaForOllama, adaptSchemaForOpenAI } from './runner/schema-adapters.js';
import { resolveCapacity, resolveGeminiMaxOutputTokens } from './capacity.js';
import { resolveNumPredict } from './ollama-settings.js';
import { ollamaModelDigest } from './ollama-digest.js';
import { ALL_STRUCTURED_OUTPUT_MODES, type ModelTestDeps } from './capabilities.js';
import type { StructuredOutputMode } from './runner/transport.js';

export class GeminiKeyMissingForTestError extends Error {
  constructor() {
    super('Add a Gemini API key before testing a Gemini model.');
    this.name = 'GeminiKeyMissingForTestError';
  }
}

/** Without `signal`: the route adds the client's abort signal. */
export function modelTestDepsFor(modelId: string, settings: UserSettings): ModelTestDeps {
  /* P22: runModelTest redacts before it caps (Task 3c.4). `settings` may not be the cache, so its
     endpoint keys are added to the saved secrets. */
  const secrets = [...knownAnalyzerSecrets(), ...Object.values(settings.analyzerEndpointKeys).map((k) => k.key)];
  const redact = (text: string): string => redactKnownSecrets(text, secrets);
  const offered = { offeredModes: ALL_STRUCTURED_OUTPUT_MODES, redact };
  const engine = inferEngineFromModelId(modelId);
  if (engine === 'openai') {
    const parsed = parseEndpointModelId(modelId);
    const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
    if (!parsed || !endpoint) throw new AnalyzerEndpointMissingError(parsed?.endpointId ?? modelId, 'settings');
    // 3b Task 3b.5: null when no key is saved; throws AnalyzerKeyOriginError before any request.
    const apiKey = resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl);
    return {
      ...offered,
      /* N2: no opt-out flag. A Test leaves the model loaded on the server exactly as a run
         does, so its name must reach the `{model}` unload URL too (P3). */
      transport: new OpenAITransport({ endpoint, apiKey, model: parsed.model }),
      serverUrl: endpoint.baseUrl,
      configuredMode: endpoint.structuredOutput,
      adaptSchema: adaptSchemaForOpenAI,
      /* P7/P15: the same capacity a run resolves — the saved context, and the manual cap
         clamped to the served limit transport.prepare() warms (runModelTest calls it first). */
      probeLimits: () => {
        const capacity = resolveCapacity({ engine: 'openai', model: parsed.model, endpoint });
        return { contextTokens: capacity.contextTokens, maxOutputTokens: capacity.maxOutputTokens };
      },
    };
  }
  if (engine === 'gemini') {
    const apiKey = getResolvedGeminiApiKey();
    if (!apiKey) throw new GeminiKeyMissingForTestError();
    return {
      ...offered,
      transport: new GeminiTransport({ apiKey, model: modelId }),
      serverUrl: 'gemini',
      configuredMode: configValue<StructuredOutputMode>('analyzer.gemini.structuredOutput'),
      adaptSchema: adaptSchemaForGemini,
      /* W2's Auto cap (the listed outputTokenLimit, 8192 without a list); prepare() warms the list. */
      probeLimits: () => ({
        contextTokens: resolveCapacity({ engine: 'gemini', model: modelId }).contextTokens,
        maxOutputTokens: resolveGeminiMaxOutputTokens(modelId),
      }),
    };
  }
  const url = getResolvedOllamaUrl();
  return {
    ...offered,
    transport: new OllamaTransport({ url, model: modelId }),
    serverUrl: url,
    /* A3: the installed build is stamped on the record, so a later `ollama pull` discards it. */
    modelDigest: () => ollamaModelDigest(url, modelId),
    configuredMode: configValue<StructuredOutputMode>('analyzer.ollama.structuredOutput'),
    adaptSchema: adaptSchemaForOllama,
    /* num_ctx is the context; num_predict -1 (the default) is Ollama's Auto — the context governs. */
    probeLimits: () => {
      const numPredict = resolveNumPredict();
      return {
        contextTokens: resolveCapacity({ engine: 'local', model: modelId }).contextTokens,
        maxOutputTokens: numPredict > 0 ? numPredict : null,
      };
    },
  };
}
