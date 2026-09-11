# OpenAI-compatible analyzer endpoints and request controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named OpenAI Chat Completions-compatible analyzer endpoints. Give every analyzer engine (Ollama, Gemini, endpoints) consistent controls, all through one stage runner:
- structured output;
- capacity;
- max output;
- reasoning;
- rate limits;
- custom payload.

**Architecture:**
- **Runner:** one stage runner is extracted from `OllamaAnalyzer` / `GeminiAnalyzer`. Each engine becomes a `ChatTransport` (Ollama, Gemini, OpenAI) with a per-transport retry policy that preserves today's behaviour.
- **Per-engine settings:** capacity, output caps and reasoning become descriptors resolved from settings.
- **Endpoints:** stored in user settings with origin-bound keys and a GPU card assignment. The existing analyzer guards and TTS eviction read that assignment.

**Tech Stack:**
- **Server:** Node/Express + TypeScript, Vitest; `openai` npm SDK 7.x over `undici` fetch; `@google/genai` 2.19.
- **Frontend:** Vite/React/RTK.
- **Contract and e2e:** OpenAPI → `src/lib/api-types.ts`; Playwright (mock mode).

**Spec:** [`docs/superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md`](../specs/2026-09-10-openai-compatible-analyzer-design.md). Read it before any task. Decision numbers D1–D10 and §1–§10 refer to it.

**Regression plan:** [`docs/features/284-openai-compatible-analyzer.md`](../../features/284-openai-compatible-analyzer.md). Issue: #3084.

## How this plan is organised

This file holds what every task needs:
- global constraints;
- decisions made while planning;
- the interface contract;
- the wave → PR map.

Each wave's tasks are in their own file:

| Wave | File | PRs |
|---|---|---|
| 1 — stage runner + Ollama/Gemini transports | [`2026-09-11-openai-compatible-analyzer-w1.md`](2026-09-11-openai-compatible-analyzer-w1.md) | 1a, 1b |
| 2 — capacity, max output, Gemini thinking, reasoning overflow | [`2026-09-11-openai-compatible-analyzer-w2.md`](2026-09-11-openai-compatible-analyzer-w2.md) | 2a, 2b |
| 3 — endpoints (engine ids, keys, OpenAI transport, structured output) | [`2026-09-11-openai-compatible-analyzer-w3ab.md`](2026-09-11-openai-compatible-analyzer-w3ab.md) | 3a, 3b |
| 3 — endpoints (catalog, limits, Test action, GPU, selection, UI) | [`2026-09-11-openai-compatible-analyzer-w3cd.md`](2026-09-11-openai-compatible-analyzer-w3cd.md) | 3c, 3d |
| 4 — persona generation through transports | [`2026-09-11-openai-compatible-analyzer-w4.md`](2026-09-11-openai-compatible-analyzer-w4.md) | 4 |
| 5 — reasoning controls + custom payload | [`2026-09-11-openai-compatible-analyzer-w5.md`](2026-09-11-openai-compatible-analyzer-w5.md) | 5a, 5b |

**Later waves cite earlier waves by symbol, not by line.** Each PR's first task re-reads every cited `file:line` against `main` at the time it starts (all citations are from `main` `2b63b451`). It also runs the `git grep` checks its entry criteria name. A symbol that moved is followed; a symbol that changed shape is reported to the coordinator before the task proceeds.

## Global Constraints

- **Wave 0 gates everything.**
  - Do not start wave 1 until #3139 (PR #3163) and #3141 (re-verify #3168) are merged.
  - Then re-read every `file:line` cited in your wave file against `main` before editing. Both touch `rate-limit.ts`, `select-analyzer.ts`, `user-settings.ts` and the analysing view.
- **Incidental fixes already in flight must be on `main` first.**
  - #3196 (PR #3199, merged `839c65ac`): the attribution eval passes its engine to stage 2. Wave 2's pinning is captured after it.
  - #3200 (PR #3201): removes the retired `analyzer.engine` knob and gates the Advanced Settings Ollama-device row on the saved engine. Wave 3 assumes it is merged.
- **One worktree + branch per PR.**
  - Create it with `node scripts/wt-new.mjs <type>/<scope>-3084-<slug>` off the latest `main`.
  - Never work in the primary checkout.
  - Never copy the primary `server/.env` into a worktree (#2345).
- **Commits.** Never use `git commit --no-verify` or `git push --no-verify`. Subjects follow `<type>(<scope>): <subject>` (CONTRIBUTING.md). Dispatched implementers stage; the coordinating thread commits and pushes.
- **Behaviour preservation.**
  - Wave 1 changes no observable behaviour except the `<think>` strip.
  - Every current failure-taxonomy outcome stays.
  - Characterisation tests are written and green on `main` before the extraction they protect.
- **No endpoint is selectable** in any picker, settings default or env-accepted value until PR 3d.
- **Secrets.**
  - Endpoint API keys and the Gemini key are never returned by any GET, never accepted by the general settings PUT, never logged, and never written to persisted analyzer files.
  - Keys are sent only when `new URL(target).origin === storedOrigin`.
- **Custom payload (wave 5).**
  - It is never logged, and never persisted in analyzer files (`inbox`, `rawAttemptPath`, `errorPath`, `persistResponse`).
  - String values of 8 or more characters are redacted from upstream error text before logging or display.
- **OpenAPI is the type source.**
  - Every new or changed wire shape goes `openapi.yaml` → `npm run openapi:types` → commit the regenerated `src/lib/api-types.ts`.
  - Every new endpoint gets a mock in `src/lib/api.ts`. The one exception is Detect, which joins CLAUDE.md's documented local-machine exception list in the same PR.
  - `mockPutUserSettings` keeps an explicit field whitelist; add every new user-settings field to it.
- **Registry knobs** ship with their generated Settings row, `npm run config:sync`, and a paired test. A hand-written `.env.example` entry goes outside the BEGIN/END block.
- **A new `FailureCode` touches all six places:**
  1. the union in `server/src/routes/failure-taxonomy.ts`;
  2. `failure-remediations.ts`;
  3. the sorted key list in `failure-taxonomy.test.ts`;
  4. the `openapi.yaml` `FailureCode` enum;
  5. the regenerated `api-types.ts`;
  6. `src/data/help-failures.ts` (`CATEGORIES` and `TITLES`).

  The help-count assertions (currently 23 and 49) move with each code.
- **Transport tests use a real HTTP server.**
  - Use `http.createServer` on `127.0.0.1:0` and a real undici `Agent`, following `server/src/analyzer/ollama-timeout.test.ts`.
  - No `vi.mock('undici')` and no stubbed `fetch` for any timeout, abort or unreachable case.
  - Connect-timeout tests never use port 9, which undici rejects as a "bad port".
- **Import cycles.** New analyzer modules import `StageCall` and other analyzer types from the leaf `server/src/analyzer/types.ts` (wave 1), never from `server/src/analyzer/index.ts`. Madge counts type-only imports as cycle edges (`npm run check:cycles`).
- **Mutation proofs.** Every test that guards a mechanism gets one in its task: revert the guarded line, show the test go red (output in the PR), restore.
- **Pinning and characterisation values are captured from `main`,** never computed by hand.
- **`openai` SDK.**
  - Use `openai@^7.15.0` in `server/package.json`.
  - Always pass `fetch: undici.fetch` from `server/node_modules/undici`, plus `fetchOptions.dispatcher`.
  - Set `maxRetries: 0`.
- **Model ids.**
  - Format: `openai:<endpointId>::<model>`, where `endpointId` matches `^[a-z0-9-]{1,40}$`.
  - Inference order: `^openai:[a-z0-9-]+::` → `openai`; contains `:` → `local`; else `gemini`.
  - The inference applies only where a selected model id is handled. Ollama tag-list sites keep their own handling.
- **Defaults** (from the spec):
  - **Structured output:** Ollama `schema`, Gemini `json`, endpoints `schema`.
  - **Reasoning:** Ollama `off`, Gemini and endpoints `model-default`.
  - **Endpoint concurrency:** `1`.
  - **Endpoint `requestCeilingMs`:** `1_800_000`.
  - **Endpoint `gpu`:** `any` for host `localhost` / `127.0.0.1` / `::1` / `[::1]`, else `none`.
  - **Endpoint `maxOutputTokens`:** `0` (Auto).
  - **Gemini built-in fallback limits:** 5 rpm / 100k tpm / 50 rpd.
  - **Endpoints:** unlimited.
- **Each PR** does all of these:
  - adds an entry to `docs/release-notes-next.md` and to the in-progress section of `RELEASE_NOTES.md` (skipped only for a PR with no shippable delta, stated in the PR body);
  - links `Refs #3084` (PR 5b uses `Closes #3084`);
  - runs the `pr-review-gate` skill before merge.
- **On-box acceptance** rows go into:
  - `docs/testing/onbox-acceptance-register.md`;
  - the run sheet `docs/testing/3084-openai-analyzer-onbox-acceptance.md`;
  - the live view `docs/testing/onbox-acceptance-register-live-view.html`.

  All three change in the shipping PR, per CLAUDE.md Before-shipping step 3. Row ids are minted from each group's `next-id` marker at ship time, never written into a task in advance.

## Decisions made while planning

None changes a spec decision. Each settles a detail the spec left open, or records a fact verified during planning. Where the spec needed correcting, it has been corrected (see its "Verified during planning" section).

| # | Decision | Why |
|---|---|---|
| P1 | Only endpoints whose `gpu` is not `none` register a call as in flight for TTS eviction. | A remote endpoint shares no card; a Gemini call does not block eviction today. |
| P2 | `withTransportRetry` for an endpoint uses `maxTotalMs = endpoint.requestCeilingMs`. Its idle watchdog is `resolveStreamIdleTimeoutMs()` (45 s), armed after the first delta. | Local servers can take minutes before the first token; after that, 45 s of silence between tokens is a stall. |
| P3 | `{model}` in an unload URL is replaced by the endpoint's in-memory last-used model. An unload URL with `{model}` and no model used since server start is skipped. | Persisting the last-used model on every call would write settings per request. |
| P4 | Reasoning deltas (`reasoning_content`, `reasoning`, non-empty `reasoning_details`) and Gemini thought-only chunks call `onChunk` with an unchanged byte count. | Keeps the analysis route's silence warning from firing during a long think (`analysis.ts:1184`, `:4329-4335`). |
| P5 | The wave 2 Gemini probe picks branch A only if all of these hold on `gemini-3.6-flash`: `thoughtsTokenCount` > 0; the first answer part arrives at 10 s or later; 2 or more thought parts arrive before it; the first thought part arrives in the first half of that wait; no silence reaches 45 s. Anything else, including an inconclusive result, picks branch B. | Branch B (first-chunk watchdog + request ceiling) is safe either way; branch A is kept only on clear evidence. |
| P6 | An Ollama `done_reason: 'length'` finish with an empty answer follows the same rule as the other engines (split, or reasoning overflow when there is reasoning evidence) instead of today's empty-response error. | Spec §7's rule is engine-independent. Today's ordering (`ollama.ts:829` before `:838`) is why an empty cap-limited Ollama response never split. Wave 2 announces it. |
| P7 | The Test action's control request uses no structured output, and passes whenever the provider accepts it, even when it stops with `length` (it proves acceptance only). A 5xx, timeout, or `length` / `blocked` finish on a `json` or `schema` probe saves no record and returns 502. The configured `off` check reuses the control only when the configured reasoning level is the control's level; otherwise it sends one `off` request at the configured level. | `json` mode is rejected by some servers (LM Studio). An inconclusive probe must not be recorded as `ignored`, and no level may be recorded that was not sent. |
| P8 | `tpm: 0` in `analyzerRateLimitsByModel` means unlimited, matching the retired `rate.*.gemma*` knobs. Saved gemma overrides are copied into the map when settings load, without failing the load. | Keeps saved overrides meaningful after the knobs are removed. |
| P9 | Gemini 2.5 budget tiers are off/low/medium/high = 0/1024/8192/24576 (from Google's OpenAI-compatibility mapping); 2.5 models get no `minimal` level. `includeThoughts` is omitted only when the budget is 0. | These are the documented tier values, and `minimal` maps to the same budget as `low` there. |
| P10 | The persona engine uses a new knob type, `'analyzer-engine'`, modelled on `'device'`, with a literal id regex in the registry. | A plain string knob would render as a free-text box; `registry.ts` must stay pure data (`registry-imports.guard.test.ts`). |
| P11 | Readiness checks gain an `endpoint-missing` BlockerCause, so a saved `openai` engine does not demand Ollama (`setup-diagnosis.ts:323`, `setup-readiness.ts:204`). | Otherwise setup would report a missing Ollama for an endpoint user. |

## Interface contract

**Names and types are binding.** A task that cannot use a name as written reports the conflict instead of renaming. The wave tag says which PR introduces each name.

### Engines and ids
`server/src/analyzer/model-id.ts` (3a) and `src/lib/model-id.ts` (3a):
```ts
export type AnalysisEngine = 'local' | 'gemini' | 'openai';
export function inferEngineFromModelId(id: string): AnalysisEngine;          // frontend name: engineForModelId
export function parseEndpointModelId(id: string): { endpointId: string; model: string } | null;
export function endpointModelId(endpointId: string, model: string): string;  // `openai:${endpointId}::${model}`
```
One case table, `server/src/analyzer/__fixtures__/model-id-cases.json`, drives the server and frontend tests. Until 3a, `AnalysisEngine` stays `'local' | 'gemini'` where it is declared today.

### Types leaf and errors
- **`server/src/analyzer/types.ts` (1a):** `StageCall`, `StageChunkInfo` and the other analyzer types. `index.ts` re-exports them.
- **`server/src/analyzer/errors.ts`:**
```ts
export type TransportKind = 'ollama' | 'gemini' | 'openai';                  // 1a
export class AnalysisAbortedError extends Error {}                             // 1a (moved; ollama.ts re-exports)
export class AnalyzerUnreachableError extends Error {                          // 1a
  constructor(message: string, readonly transport: TransportKind, readonly cause?: unknown);
}
export class LocalUnreachableError extends AnalyzerUnreachableError {}        // 1a (transport 'ollama', code stays 'LOCAL_UNREACHABLE')
export class AnalyzerHttpError extends Error {                                 // 1a — deliberately NO `status` property
  constructor(readonly transport: TransportKind, readonly httpStatus: number, readonly bodyExcerpt: string, message: string);
}
// AnalyzerTruncatedError.engine widens to TransportKind (1a).
export class AnalyzerReasoningOverflowError extends Error {                    // 2b
  constructor(readonly transport: TransportKind, readonly model: string, readonly reasoningTokens: number | undefined);
}
export class AnalyzerTimeoutError extends Error {                              // 2b if branch B ships, else 3b
  constructor(readonly transport: TransportKind, readonly model: string, readonly elapsedMs: number, readonly reason: 'ceiling' | 'connect-timeout');
}
export class AnalyzerStreamIncompleteError extends Error { constructor(readonly transport: TransportKind, readonly model: string); }   // 3b
export class AnalyzerInvalidOutputError extends Error { /* builds today's "failed validation after retry" text itself */ }            // 3b
export class AnalyzerEndpointMissingError extends Error { constructor(readonly endpointId: string, readonly source: 'settings' | 'env' | 'run-pick' | 'persona'); } // 3b
export class AnalyzerKeyOriginError extends Error { constructor(readonly endpointId: string, readonly endpointName: string); }        // 3b → FailureCode `auth`
export class AnalyzerCapabilityRejectedError extends Error { constructor(readonly modelId: string, readonly setting: 'structuredOutput' | 'reasoning', readonly value: string, readonly testedAt: string); } // 3c
```
FailureCodes:
- **`analyzer-reasoning-overflow`** (2b).
- **`analyzer-timeout`** (with `AnalyzerTimeoutError`).
- **`analyzer-request-rejected`** (3b). Covers any 400 from any transport, including a Gemini `ApiError` with status 400. `AnalyzerCapabilityRejectedError` also maps here, with "refused before start" copy.
- **`analyzer-invalid-output`** (3b).
- **`analyzer-endpoint-missing`** (3b).
- **`auth`** (existing) also covers `AnalyzerHttpError` 401/403 and `AnalyzerKeyOriginError`.

### Transport, finish, retry — `server/src/analyzer/runner/` (1b unless tagged)
```ts
// transport.ts
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export type StructuredOutputMode = 'schema' | 'json' | 'off';
export type StructuredOutputRequest = { mode: 'schema'; name: string; schema: Record<string, unknown> } | { mode: 'json' } | { mode: 'off' };
export interface FreeTextOptions { onCpu?: boolean; keepAlive?: string | number; absoluteMaxMs?: number }   // 4
export interface TransportRequest {
  system: string;
  messages: ChatMessage[];
  structuredOutput: StructuredOutputRequest;
  temperature: number | undefined;       // undefined = send none (4: Gemini persona)
  maxOutputTokens?: number;              // 1b: undefined = pre-wave-2 default; 2b: always resolved
  estimatedInputTokens: number;
  signal?: AbortSignal;
  call: Pick<StageCall, 'onChunk' | 'onWaiting' | 'onThrottle' | 'onEvalTiming'>;
  freeText?: FreeTextOptions;            // 4
  reasoning?: ReasoningLevel;            // 5a
  extraParams?: Record<string, unknown>; // 5b
}
export interface TransportUsage { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
export interface TransportResult {
  text: string; reasoningSeen: boolean; finish: 'stop' | 'length' | 'blocked';
  finishReason?: string; blockReason?: string; usage?: TransportUsage; receivedBytes: number;
}
export interface ChatTransport {
  readonly kind: TransportKind; readonly model: string;
  prepare?(): Promise<void>;             // 2b: awaited by StageRunner before reading settings (Gemini catalog warm-up)
  send(req: TransportRequest): Promise<TransportResult>;
}
// finish.ts
export function mapFinish(r: TransportResult, ctx: { kind: TransportKind; model: string }): string;   // 1b; 2b adds the overflow rule
export function withThinkEvidence(r: TransportResult): TransportResult;                               // 1b: unterminated <think> → reasoningSeen
export function hasReasoningEvidence(r: TransportResult): boolean;                                    // 2b
// parse.ts (1a, moved from gemini.ts, re-exported): parseAndValidate, ParseResult, stripCodeFences, repairUnescapedQuotes,
//   trimTrailingProse, repairStructuralPunctuation, buildRetryMessage, summariseDetail, persistResponse; stripThink (1b)
// prompt.ts (1a): buildSystemInstruction, languagePreamble, loadSkill, SkillName, SKILL_FILES, SKILL_TO_PROMPT_ID, estimateInputTokens
// retry-policy.ts
export interface ValidationRetryPolicy {
  readonly name: 'ollama' | 'gemini' | 'openai';
  initialTemperature(): number;
  buildRetry(input: { messages: ChatMessage[]; firstRaw: string; failure: Extract<ParseResult<unknown>, { ok: false }> }): { messages: ChatMessage[]; temperature: number };
  readonly writesRawAttempts: boolean;
  readonly warnsOnRepair: boolean;
  escalationRethrows(err: unknown): boolean;
}
export const OLLAMA_RETRY_POLICY: ValidationRetryPolicy;   // 1b
export const GEMINI_RETRY_POLICY: ValidationRetryPolicy;   // 1b
export const OPENAI_RETRY_POLICY: ValidationRetryPolicy;   // 3b (Ollama shape; temperatures 0.2 / 0.6)
// transport-retry.ts (1b, extracted from gemini.ts:536-652)
export type RetryDisposition = 'abort' | 'no-retry' | 'idle' | 'daily-quota' | 'rate-limit' | 'server-error';
export interface RetryClassifier { classify(err: unknown): RetryDisposition; retryAfterMs(err: unknown): number | null }
export async function withTransportRetry<T>(attempt: () => Promise<T>, opts: {
  model: string; limiter: GeminiRateLimiter; estimatedInputTokens: number; classifier: RetryClassifier;
  signal?: AbortSignal; onThrottle?: StageCall['onThrottle']; maxAttempts: number; maxTotalMs: number;
  backoffsMs: readonly number[]; logTag: string; displayName: string;
  recordActualTokens?: (result: T) => number | undefined;
}): Promise<T>;
```
The `finalFailureMessage` policy member exists in 1b and is removed in 3b, when `AnalyzerInvalidOutputError` builds the message.

### Runner — `runner/stage-runner.ts`, `runner/transport-analyzer.ts`
```ts
export type SchemaAdapter = (draft07: Record<string, unknown>) => { schema: Record<string, unknown>; dropped: string[] };
export const identitySchemaAdapter: SchemaAdapter;                             // 1b
export interface StageSpec<T> { manuscriptId: string; key: HandoffKey; skillName: SkillName; promptMd: string; grammarSchema: z.ZodType<unknown>; validationSchema: z.ZodType<T> }
export interface EngineRequestSettings {
  structuredOutput: StructuredOutputMode;   // 1b constants; 3b resolved from knob/endpoint
  maxOutputTokens: number | undefined;      // 1b undefined; 2b resolved
  reasoning?: ReasoningLevel;               // 5a
  extraParams?: Record<string, unknown>;    // 5b
}
export class StageRunner {
  constructor(opts: { transport: ChatTransport; policy: ValidationRetryPolicy; settings: () => EngineRequestSettings; adaptSchema: SchemaAdapter });
  runStage<T>(spec: StageSpec<T>, call: StageCall): Promise<T>;
  runSingleAttempt<T>(spec: StageSpec<T>, call: StageCall): Promise<T | null>;
  runFreeText(input: { system?: string; prompt: string; signal?: AbortSignal; temperature?: number; ollama?: FreeTextOptions }): Promise<string>;   // 4
}
export class TransportAnalyzer implements Analyzer { constructor(readonly runner: StageRunner) }
// 1b: OllamaAnalyzer extends TransportAnalyzer — constructor({ url, model, dispatcher? }) unchanged.
// 1b: GeminiAnalyzer extends TransportAnalyzer — constructor({ apiKey, model }) unchanged.
// 3b: OpenAIAnalyzer extends TransportAnalyzer — server/src/analyzer/openai.ts — constructor({ endpoint, apiKey, model, dispatcher? }).
```
Leaf `server/src/analyzer/ollama-settings.ts` (1a) holds the Ollama resolvers `ollama.ts` re-exports.

### Transports — `server/src/analyzer/transports/`
- **`ollama-transport.ts` (1b):** `OllamaTransport({ url, model, dispatcher? })`, the body of today's `chat()`. It gains a non-streaming persona branch in 4.
- **`gemini-transport.ts` (1b):** `GeminiTransport({ apiKey, model, client?, requestCeilingMs? })`. Thought parts set `reasoningSeen`, count as activity, and never enter `text`. `requestCeilingMs` arrives in 2b branch B. 5a adds the exported `mergeGeminiThinkingConfig(base, fragment)`, which keeps `includeThoughts` beside `thinkingLevel` or `thinkingBudget` and never sends both.
- **`openai-transport.ts` (3b):** `OpenAITransport({ endpoint, apiKey, model, dispatcher?, now? })`. It classifies failures in this order:
  1. caller abort → `AnalysisAbortedError`;
  2. no headers and an unreachable code (`UNREACHABLE_CODES` ∪ `UND_ERR_CONNECT_TIMEOUT`, `EHOSTUNREACH`, `ENETUNREACH`; a bare `fetch failed` counts only when no code is in the chain) → `AnalyzerUnreachableError`;
  3. ceiling signal or `APIConnectionTimeoutError` → `AnalyzerTimeoutError`;
  4. `APIError` with a status → `AnalyzerHttpError`;
  5. `APIError` without a status → `AnalyzerHttpError` with status 0, not retried;
  6. headers received, and a socket drop or no `finish_reason` → `AnalyzerStreamIncompleteError`.
- **`endpoint-runtime.ts` (3b):** `noteEndpointModelUsed`, `lastUsedModel`, `endpointSemaphore(endpoint)`.

### Capacity, catalog, output — waves 2 and 3
```ts
// server/src/analyzer/capacity.ts
export interface EngineCapacity { family: 'context' | 'requestCap'; contextTokens: number; maxOutputTokens: number | null; perRequestInputCap?: number }
export function resolveCapacity(sel: { engine: AnalysisEngine; model: string; endpoint?: AnalyzerEndpoint }): EngineCapacity;  // 2a: engine 'local'|'gemini', no endpoint; 3c: endpoint branch
export const GEMINI_FALLBACK_MAX_OUTPUT_TOKENS = 8192;                                                                          // 2b
export function resolveGeminiMaxOutputTokens(model: string): number;                                                            // 2b
// 2a signature changes (all callers updated in the same task):
resolveStage1ChunkCharBudget(capacity: EngineCapacity | undefined, body?: string, runningRoster?: CharacterOutput[]): number
resolveStage2ChunkCharBudget(capacity: EngineCapacity | undefined, body?: string): number
chapterChunkBudget(capacity: EngineCapacity, reservedChars?: number, sampleText?: string, reservedTokens?: number): number
// server/src/analyzer/catalog/gemini-catalog.ts (2b)
export interface GeminiModelInfo { id: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; thinking?: boolean }
export async function listGeminiModels(apiKey: string, opts?: { refresh?: boolean; client?: GeminiModelsClient }): Promise<GeminiModelInfo[]>;
export async function warmGeminiCatalog(apiKey: string, opts?: { client?: GeminiModelsClient }): Promise<void>;   // never throws; 60 s back-off after a failed listing; callers skip it with no key
export function getCachedGeminiModelInfo(model: string): GeminiModelInfo | undefined;
export function geminiModelThinks(model: string): boolean;
// server/src/analyzer/rate-limit.ts — resolveLimits exported (2a); analyzerRateLimiter alias + unlimited endpoint ids (3b); analyzerRateLimitsByModel read (3c)
```

### Endpoints, keys, capabilities, adapters — wave 3
```ts
// server/src/workspace/analyzer-endpoints.ts (3b)
export const REASONING_STYLES = ['reasoning_effort', 'enable_thinking', 'not_controllable'] as const;
export const analyzerEndpointSchema: z.ZodObject<…>;   // fields per spec §3: id, name, baseUrl, gpu, unloadUrl?, concurrency (1), requestCeilingMs (1_800_000),
                                                       // structuredOutput ('schema'), reasoningStyle ('not_controllable'), reasoning ('model-default'),
                                                       // maxOutputTokens (0), contextTokens (required, ≥512), maxInputTokensPerRequest?, extraParams?
export type AnalyzerEndpoint = z.infer<typeof analyzerEndpointSchema>;
export function defaultGpuForBaseUrl(baseUrl: string): 'any' | 'none';
export function keyOriginMatches(stored: { origin: string } | undefined, url: string): boolean;
export function resolveEndpointApiKey(settings: { analyzerEndpointKeys: Record<string, { origin: string; key: string }> }, endpoint: AnalyzerEndpoint, targetUrl: string): string | null;  // structural param (no UserSettings import → no cycle); throws AnalyzerKeyOriginError on mismatch
export function resolveUnloadUrl(endpoint: AnalyzerEndpoint, lastUsedModel: string | undefined): string | null;
export function findEndpointReferences(settings: { [k: string]: unknown }, endpointId: string): string[];
// server/src/workspace/user-settings.ts (3b)
export async function mutateUserSettings(fn: (current: UserSettings) => Partial<UserSettings>): Promise<UserSettings>;  // serialised writer; callers return only the fields they own
// server/src/analyzer/runner/schema-adapters.ts (3b)
export function adaptSchemaForOllama(s): AdaptedSchema; export function adaptSchemaForGemini(s): AdaptedSchema; export function adaptSchemaForOpenAI(s): AdaptedSchema;
export function structuredOutputLabel(mode: StructuredOutputMode, dropped: string[], record: ModelCapabilityRecord | undefined, reasoningKey: string): string;
// server/src/analyzer/capabilities.ts (record type 3b; test action 3c; reasoning half 5a)
export type ProbeOutcome = 'enforced' | 'ignored' | 'rejected' | 'accepted';
export interface ModelCapabilityRecord {
  serverUrl: string; testedAt: string; control: { ok: true } | { ok: false; error: string };
  structuredOutput: Partial<Record<StructuredOutputMode, Record<string, ProbeOutcome>>>;
  reasoning: Partial<Record<string, 'accepted' | 'rejected'>>;   // key type narrows to ReasoningLevel in 5a
}
export function capabilityRecordFor(settings: UserSettings, modelId: string, currentServerUrl: string): ModelCapabilityRecord | undefined;
export function assertConfiguredCapabilitiesAllowed(record: ModelCapabilityRecord | undefined, configured: { structuredOutput: StructuredOutputMode; reasoning: string | undefined }, modelId: string): void;
export async function runModelTest(input: { modelId: string; scope: 'configured' | 'all' }, deps: ModelTestDeps): Promise<ModelCapabilityRecord>;
export function plannedTestRequestCount(input: { modelId: string; scope: 'configured' | 'all' }, deps: Pick<ModelTestDeps, 'configuredMode' | 'offeredModes' | 'offeredLevels'>): number;
// 3c: configured = 2 requests (1 when the configured mode is `off`), all = 3 (control + json + schema; `off` is the control itself).
// 5a: ModelTestDeps drops `offeredLevels` and gains `reasoningSelection` / `configuredReasoning`; the deps become
//     Pick<ModelTestDeps, 'configuredMode' | 'offeredModes' | 'reasoningSelection' | 'configuredReasoning'>.
// 5a exports: isProbeRejected, probeReasoningLevels, reasoningSelectionFor, configuredReasoningFor, normaliseCapabilityRecord.
// server/src/analyzer/model-test-deps.ts (3c): modelTestDepsFor(modelId) builds ModelTestDeps; the route stays thin.
// server/src/analyzer/analyzer-concurrency.ts (3d)
export function registerEndpointCallInFlight(): () => void;   export function isAnyAnalyzerCallInFlight(): boolean;
// server/src/gpu/endpoint-eviction.ts (3d)
export function endpointsSharingDevice(endpoints: AnalyzerEndpoint[], deviceKey: string): AnalyzerEndpoint[];
export async function evictEndpointsOnDevice(deviceKey: string, deps?: { fetch?: typeof undici.fetch; settings?: () => UserSettings; lastUsedModel?: (endpointId: string) => string | undefined }): Promise<{ attempted: number }>;
// src/lib/analyzer-endpoints.ts (3d)
export function endpointForModelId(settings: Pick<UserSettings, 'analyzerEndpoints'>, id: string): AnalyzerEndpoint | undefined;
export function analyzerSharesTtsDevice(input: { engine: AnalysisEngine; endpointGpu: string | undefined; ttsDeviceKey: string | undefined }): boolean;
```
User-settings fields:
- **`analyzerEndpoints`** (3b): returned by GET, written only through the endpoint routes.
- **`analyzerEndpointKeys`** (3b): in `FORBIDDEN_KEYS`. GET exposes `analyzerEndpointKeyStatus: Record<id, 'set' | 'unset' | 'origin-mismatch'>`.
- **`analyzerCapabilitiesByModel`** (3b/3c): written by the server only.
- **`analyzerRateLimitsByModel`** (3c): general PUT, whole-map write.
- **`analyzerExtraParamsByEngine`** and **`analyzerReasoningByEngine`** (5a/5b): general PUT, validated on write.

Catalog response (3c):
```ts
interface AnalyzerCatalog {
  groups: Array<{
    kind: 'ollama' | 'gemini' | 'endpoint';
    id: string; label: string; status: 'ok' | 'fallback' | 'error'; error?: string;
    models: Array<{
      id: string; label: string; engine: AnalysisEngine; model: string;
      contextTokens?: number; outputTokens?: number;
      structuredOutput: { mode: StructuredOutputMode; dropped: string[]; label: string };
      testPlan: { configured: number; all: number };
      capability?: ModelCapabilityRecord;
      offeredReasoningLevels?: string[];      // 5a
      requestControlLabelParts?: string[];    // 5b ("+ custom params", Auto disabled)
    }>;
  }>;
}
```
Status meanings: `ok`, a live listing; `fallback`, Gemini with no key or a failed listing, carrying no models (the frontend overlays its curated list); `error`, a failed Ollama or endpoint listing (endpoints stay selectable from saved settings with free-text entry). `label` is `displayName ?? model`.

### Reasoning and payload — wave 5
```ts
// server/src/analyzer/reasoning.ts (5a)
export type ReasoningLevel = 'model-default' | 'off' | 'on' | 'none' | 'minimal' | 'low' | 'medium' | 'high';
export function offeredReasoningLevels(sel: { engine: AnalysisEngine; model: string; endpoint?: { reasoningStyle: string }; record?: { reasoning: Partial<Record<string, 'accepted' | 'rejected'>> } }): ReasoningLevel[];
export function testableReasoningLevels(sel: …): ReasoningLevel[];
export function reasoningWireFragment(kind: TransportKind, sel: { model: string; endpoint?: { reasoningStyle: string } }, level: ReasoningLevel): Record<string, unknown>;
export const GEMINI_REASONING_TABLE: ReadonlyArray<{ match: RegExp; control: 'thinkingLevel' | 'thinkingBudget' | 'gemmaOnOff'; levels: ReasoningLevel[] }>;
// server/src/analyzer/runner/extra-params.ts (5b)
export const PROTECTED_KEYS: Record<TransportKind, readonly string[]>;
export const OWNED_CONTAINERS: Record<TransportKind, readonly string[]>;   // ollama: options; gemini: config; openai: chat_template_kwargs
export function validateExtraParams(kind: TransportKind, params: unknown, ctx: { reasoningStyle?: string }): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] };
export function mergeExtraParams(kind: TransportKind, native: Record<string, unknown>, params: Record<string, unknown> | undefined): Record<string, unknown>;
export function stripPayloadTemperature(kind: TransportKind, params: Record<string, unknown> | undefined): Record<string, unknown> | undefined;  // kind: temperature's container differs per transport
export function payloadControlsOutputCap(kind: TransportKind, params: Record<string, unknown> | undefined): boolean;
export function redactPayloadValues(text: string, params: unknown): string;
// server/src/workspace/analyzer-request-controls.ts (5a/5b): write-time validation of reasoning levels and payloads
```

### Persona — wave 4
- **`server/src/analyzer/voice-style.ts`:** `resolvePersonaSelection()` and `personaSharesGpu()` replace `resolvePersonaEngine()`.
- **Knob:** `analyzer.personaGeneration.engine` becomes knob type `'analyzer-engine'` (P10).

### Routes (OpenAPI operationIds)
| Method + path | operationId | Wave | Mock? |
|---|---|---|---|
| `POST /api/analyzer/endpoints` | `createAnalyzerEndpoint` | 3b | yes |
| `PUT /api/analyzer/endpoints/{endpointId}` | `updateAnalyzerEndpoint` | 3b | yes |
| `DELETE /api/analyzer/endpoints/{endpointId}` | `deleteAnalyzerEndpoint` | 3b | yes |
| `PUT /api/analyzer/endpoints/{endpointId}/key` | `putAnalyzerEndpointKey` | 3b | yes |
| `POST /api/analyzer/endpoints/detect-context` | `detectAnalyzerEndpointContext` | 3b | **no** (local-machine exception; standalone frontend export) |
| `GET /api/analyzer/models?refresh=1` | `getAnalyzerModels` | 3c | yes |
| `POST /api/analyzer/models/preview` | `previewAnalyzerEndpointModels` | 3c | yes |
| `POST /api/analyzer/models/test` | `testAnalyzerModel` | 3c | yes |

Router files: `server/src/routes/analyzer-endpoints.ts` (CRUD, key, detect) and `server/src/routes/analyzer-models.ts` (catalog, preview, test).

## Wave → PR map

| PR | Delivers | Branch | Gate before merge |
|---|---|---|---|
| 1a | characterisation tests, errors + types leaf, helper moves breaking the ollama↔gemini cycle | `refactor/server-3084-w1a-characterise` | wave 0 merged |
| 1b | transports, retry policies, stage runner, `<think>` strip | `refactor/server-3084-w1b-runner` | 1a merged |
| 2a | Gemini thought-stream probe script + run sheet, pinning capture, capacity model | `refactor/server-3084-w2a-capacity` | 1b and #3199 merged |
| 2b | Gemini catalog, Auto max output, thinking visibility (branch A or B), reasoning overflow | `feat/server-3084-w2b-output-cap` | **owner-run probe result recorded (P5)** |
| 3a | engine union, id grammar, selection-id sites, `'local'` classification | `refactor/server,frontend-3084-w3a-engine-ids` | 2b and #3201 merged |
| 3b | endpoint storage + keys + CRUD + Detect, OpenAI transport, adapters, structured-output knobs, failure codes | `feat/server,openapi-3084-w3b-endpoints` | 3a merged |
| 3c | catalog + preview, limiter map + gemma migration, endpoint capacity, Test action, pre-run checks | `feat/server,openapi-3084-w3c-catalog-test` | 3b and #3163 merged |
| 3d | GPU card picker, guards, in-flight, eviction, fallback, selection, Settings UI, pickers — **endpoints become selectable** | `feat/server,frontend-3084-w3d-selectable` | 3c merged |
| 4 | persona generation through transports | `feat/server,frontend-3084-w4-persona` | 3d merged |
| 5a | reasoning levels, control styles, Test reasoning | `feat/server,frontend-3084-w5a-reasoning` | 4 merged |
| 5b | custom payload (`Closes #3084`) | `feat/server,frontend-3084-w5b-payload` | 5a merged |

**On-box acceptance** is owed after the listed PRs. Each row is recorded in the shipping PR and does not block its merge.

| PR | Row |
|---|---|
| 1b | real-daemon telemetry and a real Gemini stream through the transports |
| 2b | thinking-model output; capacity recalibration |
| 3b | Ollama structured-output modes; Gemini `schema` mode |
| 3c / 3d | live structured output (Test action vs a real chapter); long silent prefill; same-card eviction |
