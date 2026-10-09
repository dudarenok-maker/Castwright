/* #3084 W3 — one catalog for every analyzer source: Ollama /api/tags, Gemini
   models.list() (only with a key), and each saved OpenAI-compatible endpoint's
   /v1/models through the openai SDK under the key-origin rule. Served context/output
   limits and the Test record ride on each entry; the frontend overlays curated labels. */
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { Agent } from 'undici';
import { configValue } from '../../config/resolver.js';
import { AnalysisAbortedError, AnalyzerHttpError, AnalyzerTransportError, sanitizeCauseCode } from '../errors.js';
import { getCachedUserSettings, getResolvedGeminiApiKey, type UserSettings } from '../../workspace/user-settings.js';
/* #3192 moved the Ollama URL resolver into its own leaf (env → Advanced override → default). */
import { getResolvedOllamaUrl } from '../../config/ollama-resolved.js';
/* Known secrets come through 3b's leaf gate, never from user-settings.ts (import-cycle rule, A9). */
import { knownAnalyzerSecrets } from '../known-secrets-gate.js';
import { allowlistedFetch } from '../transports/allowlisted-fetch.js';
import { redactKnownSecrets } from '../redact.js';
import { keyOriginMatches, type AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';
import { endpointModelId } from '../model-id.js';
import { listGeminiModels, type GeminiModelInfo } from './gemini-catalog.js';
import {
  ALL_STRUCTURED_OUTPUT_MODES,
  STAGE_GRAMMAR_SCHEMAS,
  capabilityRecordFor,
  defaultReasoningKey,
  draft07,
  plannedTestRequestCount,
  type ModelCapabilityRecord,
} from '../capabilities.js';
import {
  adaptSchemaForGemini,
  adaptSchemaForOllama,
  adaptSchemaForOpenAI,
  structuredOutputLabel,
} from '../runner/schema-adapters.js';
import type { AdaptedSchema, StructuredOutputMode } from '../runner/transport.js';

export type CatalogGroupKind = 'ollama' | 'gemini' | 'endpoint';

/** Master-contract fields: id, label, contextTokens?, outputTokens?, capability?
    (offeredReasoningLevels? arrives in wave 5). W3c additions: engine, model,
    structuredOutput, testPlan. */
export interface AnalyzerCatalogEntry {
  id: string;
  /** Gemini `displayName ?? id`; the Ollama tag; an endpoint's bare model name. */
  label: string;
  contextTokens?: number;
  outputTokens?: number;
  capability?: ModelCapabilityRecord;
  engine: 'local' | 'gemini' | 'openai';
  model: string;
  structuredOutput: { mode: StructuredOutputMode; dropped: string[]; label: string };
  /** `attempts` (N6): the most attempts one Test request can take on this model's transport,
      retries included, so the confirm dialog can state the maximum. */
  testPlan: { configured: number; all: number; attempts: number };
}

/** N6 — each transport's retry budget for one request: `OpenAITransport` and `GeminiTransport`
    call `withTransportRetry` with `maxAttempts: 3`; `OllamaTransport` does not retry. Pinned
    against the transport sources by `TEST_REQUEST_MAX_ATTEMPTS matches each transport's own retry budget`. */
export const TEST_REQUEST_MAX_ATTEMPTS: Readonly<Record<'local' | 'gemini' | 'openai', number>> = {
  local: 1,
  gemini: 3,
  openai: 3,
};

export interface AnalyzerCatalogGroup {
  kind: CatalogGroupKind;
  id: string;
  label: string;
  /** ok = listed. fallback = Gemini without a key or with a failed listing: no models, and the
      frontend overlays its curated list. error = an Ollama or endpoint listing failed: no models. */
  status: 'ok' | 'fallback' | 'error';
  error?: string;
  models: AnalyzerCatalogEntry[];
}

export interface AnalyzerCatalog {
  groups: AnalyzerCatalogGroup[];
}

export interface CatalogDeps {
  settings(): UserSettings;
  ollamaUrl(): string;
  geminiApiKey(): string | null;
  /** A3: each tag with its digest, so an entry drops a Test record for another build. */
  listOllamaTags(url: string): Promise<Array<{ name: string; digest?: string }>>;
  listGemini(apiKey: string, refresh: boolean): Promise<GeminiModelInfo[]>;
  /** P26: `signal` bounds and cancels the listing (the served-limits warm-up passes one; the catalog does not). */
  listEndpoint(baseUrl: string, apiKey: string | null, signal?: AbortSignal): Promise<Array<Record<string, unknown>>>;
  now(): number;
}

export const CATALOG_TTL_MS = 30_000;
const OLLAMA_TAGS_TIMEOUT_MS = 2_000;
const ENDPOINT_LIST_TIMEOUT_MS = 10_000;

/* Listing-only dispatcher: short connect/header/body budgets — unlike the long-call
   analyzer dispatcher, a model list that takes more than 10 s is a failed listing. */
const LISTING_DISPATCHER = new Agent({
  connect: { timeout: 5_000 },
  headersTimeout: ENDPOINT_LIST_TIMEOUT_MS,
  bodyTimeout: ENDPOINT_LIST_TIMEOUT_MS,
});

async function listOllamaTags(url: string): Promise<Array<{ name: string; digest?: string }>> {
  const resp = await fetch(`${url}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(OLLAMA_TAGS_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Ollama returned ${resp.status} ${resp.statusText}`);
  const body = (await resp.json()) as { models?: Array<{ name?: string; model?: string; digest?: string }> };
  return (body.models ?? [])
    .map((m) => ({ name: m.name ?? m.model ?? '', ...(typeof m.digest === 'string' && m.digest ? { digest: m.digest } : {}) }))
    .filter((m) => m.name);
}

type OpenAIClientOptions = NonNullable<ConstructorParameters<typeof OpenAI>[0]>;

async function listEndpoint(baseUrl: string, apiKey: string | null, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
  const client = new OpenAI({
    baseURL: baseUrl,
    /* As 3b's transport: a placeholder only, so the SDK never reads OPENAI_API_KEY.
       allowlistedFetch drops the header the SDK builds from it and every host
       OPENAI_CUSTOM_HEADERS header, and sends the real key on its own origin only;
       a null key sends none (P22). */
    apiKey: 'castwright-placeholder-key',
    organization: null,
    project: null,
    maxRetries: 0,
    timeout: ENDPOINT_LIST_TIMEOUT_MS,
    logLevel: 'off',
    fetch: allowlistedFetch(apiKey, new URL(baseUrl).origin) as unknown as OpenAIClientOptions['fetch'],
    fetchOptions: { dispatcher: LISTING_DISPATCHER } as unknown as OpenAIClientOptions['fetchOptions'],
  });
  const out: Array<Record<string, unknown>> = [];
  try {
    for await (const model of client.models.list(signal ? { signal } : undefined)) out.push(model as unknown as Record<string, unknown>);
  } catch (err) {
    throw rebuildListingError(err, apiKey);
  }
  return out;
}

/* P22 — the SDK's errors never leave the listing client, as 3b's rule 7 does for the transport.
   Nothing is rethrown and nothing is attached as `cause`: undici's header errors embed the header
   value (`Headers.append: "Bearer <key>" is an invalid header value.`), and a logged or inspected
   error prints its whole cause chain. An HTTP status keeps the provider's words, redacted before
   they are capped; everything else carries fixed text and a sanitized code only. None of these is
   AnalyzerUnreachableError: a listing is never "unreachable" (P21). The listing can only echo the
   key it sent, so its key plus the saved analyzer secrets are enough to redact against. */
function rebuildListingError(err: unknown, apiKey: string | null): Error {
  const secrets = [...(apiKey === null ? [] : [apiKey]), ...knownAnalyzerSecrets()];
  if (err instanceof APIUserAbortError) return new AnalysisAbortedError('Endpoint model listing aborted.');
  if (err instanceof APIError && !(err instanceof APIConnectionError) && typeof err.status === 'number') {
    const excerpt = redactKnownSecrets(err.message, secrets).slice(0, 300);
    return new AnalyzerHttpError('openai', err.status, excerpt, excerpt);
  }
  const codes: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== null && typeof cur === 'object' && depth <= 4; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    cur = (cur as { cause?: unknown }).cause;
  }
  const causeCode = sanitizeCauseCode(codes.find((c) => TRANSIENT_LISTING_CODES.has(c)) ?? codes[0], secrets);
  const outcome = err instanceof APIConnectionTimeoutError ? 'timed out' : 'failed';
  return new AnalyzerTransportError('openai', 'models.list', `Endpoint model listing ${outcome}${causeCode ? ` (${causeCode})` : ''}.`, causeCode);
}

export const DEFAULT_CATALOG_DEPS: CatalogDeps = {
  settings: getCachedUserSettings,
  ollamaUrl: getResolvedOllamaUrl,
  geminiApiKey: getResolvedGeminiApiKey,
  listOllamaTags,
  listGemini: (apiKey, refresh) => listGeminiModels(apiKey, { refresh }),
  listEndpoint,
  now: () => Date.now(),
};

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Served limits only: max_model_len → meta.n_ctx → context_length; never
    meta.n_ctx_train, never LiteLLM max_input_tokens / max_output_tokens. */
export function servedLimitsFromModelEntry(entry: Record<string, unknown>): { contextTokens?: number; maxOutputTokens?: number } {
  const meta = entry.meta as Record<string, unknown> | undefined;
  const contextTokens = positiveInt(entry.max_model_len) ?? positiveInt(meta?.n_ctx) ?? positiveInt(entry.context_length);
  const topProvider = entry.top_provider as Record<string, unknown> | undefined;
  const maxOutputTokens = positiveInt(topProvider?.max_completion_tokens);
  return {
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

interface RawModel {
  id: string;
  model: string;
  displayName?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  /** A3: Ollama only — the installed digest from /api/tags. */
  digest?: string;
}
type Listing = { ok: true; models: RawModel[] } | { ok: false; error: string };

const listingCache = new Map<string, { at: number; listing: Listing }>();

export function _resetCatalogCacheForTest(): void {
  listingCache.clear();
}

/* P21: a reset or DNS hiccup is transient, never "unreachable" — the next view or Refresh lists
   again. P22: any other message is redacted before it is capped, so the cut cannot leave half a key. */
const TRANSIENT_LISTING_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN']);

export function listingErrorMessage(err: unknown, secrets: ReadonlyArray<string | null | undefined>): string {
  let cur: unknown = err;
  for (let depth = 0; cur !== null && typeof cur === 'object' && depth <= 4; depth += 1) {
    const { code, causeCode } = cur as { code?: unknown; causeCode?: unknown };
    if (typeof code === 'string' && TRANSIENT_LISTING_CODES.has(code)) {
      return `The connection dropped before the server answered (${code}). Try again.`;
    }
    /* listEndpoint's rebuilt AnalyzerTransportError carries its code here and has no cause chain (P22). */
    if (typeof causeCode === 'string' && TRANSIENT_LISTING_CODES.has(causeCode)) {
      return `The connection dropped before the server answered (${causeCode}). Try again.`;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return redactKnownSecrets(err instanceof Error ? err.message : String(err), secrets).slice(0, 300);
}

async function cachedListing(
  key: string,
  refresh: boolean,
  now: () => number,
  secrets: readonly string[],
  load: () => Promise<RawModel[]>,
): Promise<Listing> {
  const hit = listingCache.get(key);
  if (!refresh && hit && now() - hit.at < CATALOG_TTL_MS) return hit.listing;
  let listing: Listing;
  try {
    listing = { ok: true, models: await load() };
  } catch (err) {
    listing = { ok: false, error: listingErrorMessage(err, secrets) };
  }
  listingCache.set(key, { at: now(), listing });
  return listing;
}

const droppedMemo = new Map<CatalogGroupKind, string[]>();
function droppedForKind(kind: CatalogGroupKind): string[] {
  const memo = droppedMemo.get(kind);
  if (memo) return memo;
  const adapt: (s: Record<string, unknown>) => AdaptedSchema =
    kind === 'gemini' ? adaptSchemaForGemini : kind === 'endpoint' ? adaptSchemaForOpenAI : adaptSchemaForOllama;
  const all = new Set<string>();
  for (const { schema } of STAGE_GRAMMAR_SCHEMAS) for (const d of adapt(draft07(schema)).dropped) all.add(d);
  const out = [...all].sort();
  droppedMemo.set(kind, out);
  return out;
}

const OFFERED = { offeredModes: ALL_STRUCTURED_OUTPUT_MODES };

function toEntry(
  raw: RawModel,
  ctx: { kind: CatalogGroupKind; engine: AnalyzerCatalogEntry['engine']; mode: StructuredOutputMode; serverUrl: string; settings: UserSettings },
): AnalyzerCatalogEntry {
  const capability = capabilityRecordFor(ctx.settings, raw.id, ctx.serverUrl, raw.digest); // A3: another build's record is dropped
  const dropped = ctx.mode === 'schema' ? droppedForKind(ctx.kind) : [];
  const planDeps = { ...OFFERED, configuredMode: ctx.mode };
  /* P7: label from the record filed under the level a run of this model sends. */
  const level = defaultReasoningKey(ctx.kind === 'endpoint' ? 'openai' : ctx.kind);
  return {
    id: raw.id,
    label: raw.displayName ?? raw.model,
    ...(raw.contextTokens !== undefined ? { contextTokens: raw.contextTokens } : {}),
    ...(raw.maxOutputTokens !== undefined ? { outputTokens: raw.maxOutputTokens } : {}),
    ...(capability ? { capability } : {}),
    engine: ctx.engine,
    model: raw.model,
    structuredOutput: { mode: ctx.mode, dropped, label: structuredOutputLabel(ctx.mode, dropped, capability, level) },
    testPlan: {
      configured: plannedTestRequestCount({ modelId: raw.id, scope: 'configured' }, planDeps),
      all: plannedTestRequestCount({ modelId: raw.id, scope: 'all' }, planDeps),
      attempts: TEST_REQUEST_MAX_ATTEMPTS[ctx.engine],
    },
  };
}

async function ollamaGroup(refresh: boolean, deps: CatalogDeps, settings: UserSettings, secrets: readonly string[]): Promise<AnalyzerCatalogGroup> {
  const url = deps.ollamaUrl();
  const base = { kind: 'ollama' as const, id: 'ollama', label: 'Local Ollama' };
  const listing = await cachedListing(`ollama:${url}`, refresh, deps.now, secrets, async () =>
    (await deps.listOllamaTags(url)).map((t) => ({ id: t.name, model: t.name, ...(t.digest ? { digest: t.digest } : {}) })),
  );
  /* Plan 221 installed-only: a failed /api/tags lists nothing, and nothing is overlaid. */
  if (!listing.ok) return { ...base, status: 'error', error: listing.error, models: [] };
  const mode = configValue<StructuredOutputMode>('analyzer.ollama.structuredOutput');
  return { ...base, status: 'ok', models: listing.models.map((m) => toEntry(m, { kind: 'ollama', engine: 'local', mode, serverUrl: url, settings })) };
}

async function geminiGroup(refresh: boolean, deps: CatalogDeps, settings: UserSettings, secrets: readonly string[]): Promise<AnalyzerCatalogGroup> {
  const base = { kind: 'gemini' as const, id: 'gemini', label: 'Gemini API' };
  const apiKey = deps.geminiApiKey();
  /* Spec §3: no key, or a failed listing, falls back to the curated list. The server has no
     curated list (it is the frontend's MODEL_OPTIONS), so the group carries no models and
     `fallback` tells the frontend to overlay it. */
  if (!apiKey) return { ...base, status: 'fallback', models: [] };
  const listing = await cachedListing('gemini', refresh, deps.now, secrets, async () =>
    (await deps.listGemini(apiKey, refresh)).map((m) => ({
      id: m.id,
      model: m.id,
      ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
      ...(m.inputTokenLimit !== undefined ? { contextTokens: m.inputTokenLimit } : {}),
      ...(m.outputTokenLimit !== undefined ? { maxOutputTokens: m.outputTokenLimit } : {}),
    })),
  );
  if (!listing.ok) return { ...base, status: 'fallback', error: listing.error, models: [] };
  const mode = configValue<StructuredOutputMode>('analyzer.gemini.structuredOutput');
  return { ...base, status: 'ok', models: listing.models.map((m) => toEntry(m, { kind: 'gemini', engine: 'gemini', mode, serverUrl: 'gemini', settings })) };
}

async function endpointGroup(
  endpoint: AnalyzerEndpoint,
  refresh: boolean,
  deps: CatalogDeps,
  settings: UserSettings,
  secrets: readonly string[],
): Promise<AnalyzerCatalogGroup> {
  const base = { kind: 'endpoint' as const, id: endpoint.id, label: endpoint.name };
  const stored = settings.analyzerEndpointKeys[endpoint.id];
  if (stored && !keyOriginMatches(stored, endpoint.baseUrl)) {
    return { ...base, status: 'error', error: `Re-enter the API key for ${endpoint.name}: the saved key belongs to a different host.`, models: [] };
  }
  const listing = await cachedListing(`endpoint:${endpoint.id}:${endpoint.baseUrl}`, refresh, deps.now, secrets, async () =>
    (await deps.listEndpoint(endpoint.baseUrl, stored?.key ?? null))
      .filter((raw) => typeof raw.id === 'string')
      .map((raw) => ({ id: endpointModelId(endpoint.id, raw.id as string), model: raw.id as string, ...servedLimitsFromModelEntry(raw) })),
  );
  if (!listing.ok) return { ...base, status: 'error', error: listing.error, models: [] };
  return {
    ...base,
    status: 'ok',
    models: listing.models.map((m) => toEntry(m, { kind: 'endpoint', engine: 'openai', mode: endpoint.structuredOutput, serverUrl: endpoint.baseUrl, settings })),
  };
}

export async function buildAnalyzerCatalog(opts: { refresh: boolean }, deps: CatalogDeps = DEFAULT_CATALOG_DEPS): Promise<AnalyzerCatalog> {
  const settings = deps.settings();
  /* P22: every analyzer secret the listings could echo. The settings this call read may be
     injected (never the cache), so their endpoint keys are taken from them. */
  const secrets = [deps.geminiApiKey(), ...Object.values(settings.analyzerEndpointKeys).map((k) => k.key)].filter(
    (s): s is string => typeof s === 'string',
  );
  const groups = await Promise.all([
    ollamaGroup(opts.refresh, deps, settings, secrets),
    geminiGroup(opts.refresh, deps, settings, secrets),
    ...settings.analyzerEndpoints.map((e) => endpointGroup(e, opts.refresh, deps, settings, secrets)),
  ]);
  return { groups };
}

export interface EndpointModelsPreview {
  status: 'ok' | 'failed';
  error?: string;
  models: Array<{ model: string; contextTokens?: number; maxOutputTokens?: number }>;
  /** Smallest served context among listed models — a conservative prefill. */
  suggestedContextTokens?: number;
}

export async function previewEndpointModels(
  input: { baseUrl: string; apiKey: string | null },
  deps: Pick<CatalogDeps, 'listEndpoint'> = DEFAULT_CATALOG_DEPS,
): Promise<EndpointModelsPreview> {
  try {
    const models = (await deps.listEndpoint(input.baseUrl, input.apiKey))
      .filter((raw) => typeof raw.id === 'string')
      .map((raw) => ({ model: raw.id as string, ...servedLimitsFromModelEntry(raw) }));
    const contexts = models.map((m) => m.contextTokens).filter((n): n is number => n !== undefined);
    return { status: 'ok', models, ...(contexts.length > 0 ? { suggestedContextTokens: Math.min(...contexts) } : {}) };
  } catch (err) {
    /* P21 transient codes get the curated message; anything else is redacted against the key this
       preview used and every saved analyzer secret (P22). */
    const error = listingErrorMessage(err, [input.apiKey, ...knownAnalyzerSecrets()]);
    /* P22: the log line carries only that curated text, never `err` (console would inspect it). */
    console.warn(`[analyzer-catalog] preview listing failed: ${error}`);
    return { status: 'failed', error, models: [] };
  }
}
