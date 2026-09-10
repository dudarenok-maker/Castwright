---
status: draft
issue: 3084
date: 2026-09-10
---

# OpenAI-compatible analyzer endpoints, and request controls for every analyzer engine

**Issue:** #3084 (reporter feature request). **Prerequisite bugs found during this design:** #3139, #3141.
**Decisions:** made one area at a time with the repo owner on 2026-09-10, then revised after a mandatory adversarial assumption check the same day. Each decision is recorded with its rationale.

## Problem

The #3084 reporter asks for five things: (1) an OpenAI-compatible endpoint (base URL, API key, model) for script generation, (2) chunk-size control, (3) max-tokens control, (4) reasoning-effort control, and (5) a custom JSON payload merged into the request. Their setup is Windows 10 with 2× GTX 1060 6 GB and a GTX 1050 Ti 4 GB on v1.14.0, and a single chapter on the Gemini API "buffered" for 30 minutes. That stall is undiagnosed; the reporter has been asked for logs on #3084.

What the code does today:

- **Exactly two analyzer engines, hard-coded as a pair.**
  - `local` goes to Ollama's native `/api/chat` (`server/src/analyzer/ollama.ts:693`).
  - `gemini` goes through `@google/genai` (`server/src/analyzer/gemini.ts:725`).
  - The union `'local' | 'gemini'` appears 84 times across 47 files; some are TTS-engine uses of the same words.
  - It is fixed in `analysisEngine`'s enum (`openapi.yaml:4628`, `:4831`; `server/src/workspace/user-settings.ts:98`), in `ModelOption.engine` (`src/lib/models.ts:16`), and in persona generation's engine enum `['local', 'gemini']` (`server/src/config/registry.ts:1181-1191`).
- **Two separate stage runners.** `OllamaAnalyzer` and `GeminiAnalyzer` each implement prompt building, `parseAndValidate` and a validation retry (`ollama.ts` ~470-614; `gemini.ts:441-521`). Persona generation adds two more direct LLM calls: `generatePersonaViaOllama` (`ollama.ts:938`) and a Gemini `generateContent` call (`server/src/analyzer/voice-style.ts:197-219`).
- **The engine is inferred from the model id's shape.** `:` means Ollama; anything else means Gemini. This rule is duplicated on the server (`server/src/analyzer/index.ts:195`) and the frontend (`src/lib/models.ts:108`).
- **Structured output differs by engine.**
  - Ollama sends the per-stage Zod schema as `format` (`ollama.ts:504`, `:643`).
  - Gemini sends only `responseMimeType: 'application/json'` (`gemini.ts:729`).
  - The generated schemas contain `$schema`, `minLength` and `exclusiveMinimum`, none of which are in Gemini's supported `responseJsonSchema` subset (`server/node_modules/@google/genai/dist/genai.d.ts:5651-5666`).
  - `parseAndValidate` (`gemini.ts:1006-1053`) strips code fences and trailing prose, but not a leading `<think>` block.
- **Long local calls need a special HTTP client.** Ollama sends no response headers until the first generated token. `ANALYZER_DISPATCHER` (`ollama.ts:120-133`) therefore disables undici's header and body timeouts, and keeps a 10 s connect timeout so a down daemon still fails fast into the fallback path.
- **Chunk budgets branch on the engine name.**
  - Local budgets derive from Ollama `num_ctx` (`server/src/analyzer/stage1-chunk.ts:70-79`, `stage2-chunk.ts:59-68`).
  - Anything else is sized from `analyzer.gemini.maxInputTokensPerRequest` (default 12000; `server/src/analyzer/token-budget.ts:30-51`), with per-pass character ceilings of 24000 / 9000 / 32000 (`server/src/analyzer/chapter-chunker.ts:130-139`).
- **Output caps are static per engine.** Ollama `num_predict` defaults to −1 (`registry.ts:41`). Gemini `maxOutputTokens` defaults to 8192 with a hard max of 32768 (`registry.ts:51-58`).
- **Reasoning is controlled only on Ollama** (`think: false`, `ollama.ts:651`). **No custom request payload exists.**

Two defects in this area were split out as prerequisites and are queued as Open Engine chains:

- **#3139** — Advanced Settings rate-limit overrides are stored and shown, but `resolveLimits` (`server/src/analyzer/rate-limit.ts:76-84`) reads only `process.env`. Children: #3147 → #3146 (adds `registry-knob-read.guard.test.ts`) → #3145.
- **#3141** — five analyzer-model overrides are never read. The analysing view's phase swap writes account settings, and falsely claims to apply "from the next chapter". Children: #3158 → #3157 → #3156 → #3155 → #3154 → #3153 → #3152.

## Goals

- Any number of **named OpenAI Chat Completions-compatible endpoints**: llama.cpp / llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter and similar, usable side by side, including across analysis phases.
- Structured output, model catalogs, rate limits, chunk sizing, output caps, reasoning and custom parameters behave **consistently across Ollama, Gemini and every endpoint**, through **one stage runner**.
- Persona generation can use any engine or endpoint the analyzer can.
- Every behaviour that changes what the model receives is **explicit in Settings, with its impact stated**. Every automatic fallback is **shown**, never silent.

## Non-goals

- Bundling or managing llama.cpp or any other server. Serving is left to whatever tool the user runs.
- A true mid-run model swap for a live job (#3141 settled this as a pre-run pick).
- OpenAI `strict: true` structured outputs: `server/src/handoff/schemas.ts` relies on optional, nullable and union constructs.
- Learning rate limits from response headers.
- Environment-variable overrides for OpenAI-compatible endpoint settings. Endpoints are configured in Settings only.

## Decisions

| # | Area | Decision | Why |
|---|---|---|---|
| 1 | Stage runner & transports | **One stage runner** for every engine (prompt, schema, parse, validation retry, persistence, downgrades, payload merge, reasoning mapping). Each engine is a **transport**: `OllamaTransport` (today's `chat()`), `GeminiTransport` (extracted from `generateWithLimiter`/`generate`, `gemini.ts:536-760`), `OpenAITransport`. | Every cross-engine rule is written and tested once. Gemini's runner is thin (`gemini.ts:441-521`), so extraction is a contained refactor with its existing tests as the net. |
| 1b | Transport library | The **official `openai` npm SDK** (7.13.0, zero runtime dependencies). | Offloads protocol code, mirroring the `@google/genai` precedent. |
| 1c | Long calls & fallback | The SDK gets a **long-call dispatcher** via `fetchOptions` (no header/body timeout, 10 s connect timeout), with its own `timeout` replaced by a configurable absolute ceiling and its retries off (`maxRetries: 0`). An idle-stream watchdog starts only after the first token. **Only connect-phase failures** (refused, DNS, connect timeout) are "unreachable" and may fall back; a timeout after connecting is a normal failure. | The SDK defaults to a 10-minute timeout that throws `APIConnectionTimeoutError` and retries twice. Its "connection" naming would otherwise route a slow local prefill into cloud fallback. |
| 2 | Structured output | Per engine/endpoint setting `schema` / `json` / `off`, **default `schema` everywhere**; repair + retry on in every mode. A **per-provider schema adapter** rewrites the generated schema into the provider's supported subset and records what it dropped; the label reads "schema (partial)" when constraints were dropped, and our validator still enforces the full schema. | Strongest default guarantee without the label overstating it. |
| 2b | Rejected parameters | A 400 on a request carrying a format or reasoning field is **retried once without that field**. If the retry succeeds, the field is dropped for the rest of the run, and the label and a one-time warning say so. No error-message parsing. A provider that silently ignores a field cannot be detected; help text says so. | Detection by behaviour is deterministic; message parsing was rejected as brittle. |
| 2c | Live validation | A live call per engine per mode, including `gemma-*` and `gemini-*` with `schema` and a llama-swap endpoint, is recorded before defaults ship. | Owner rule. |
| 3 | Endpoints & model ids | **Named endpoints list** in user settings. Model ids are `openai:<endpointId>::<model>`, with `endpointId` matching `[a-z0-9-]+`. Gemini and Ollama ids are unchanged. **Live catalogs for every engine and endpoint** via a cached `GET /api/analyzer/models`, with curated overlay, static fallback, and one `modelLabel(id)` resolver. | A local server and a cloud gateway coexist; new free Gemini models appear with no code change. |
| 4 | GPU & fallback | Per endpoint, **"runs on this machine's GPU"** (default from a `localhost`/`127.0.0.1`/`::1` host, overridable) and an optional **unload URL**. The endpoints list, including this flag, reaches the frontend, so the GPU guards can see it. Gemini fallback happens only for connect-phase failures, under `allowCloudFallback`. | llama-swap exposes `POST /api/models/unload`; a same-card TTS load must be able to free the analyzer. |
| 5 | Rate limits & concurrency | One model-keyed limiter for Gemini and every endpoint. Limits resolve **env (Gemini only, existing `GEMINI_{RPM,TPM,RPD}_<slug>`) → per-model Settings map → built-in table → engine default** (Gemini 5 rpm / 100k tpm / 50 rpd; endpoints unlimited). Per-endpoint concurrency (default 1). One shared retry helper; SDK retries off. | Live-listed models need editable limits without code. |
| 6 | Chunk sizing | **Capacity model for all engines**. Per-request input cap = **min(the engine/endpoint "max input tokens per request" setting, the model's tokens-per-minute limit)**; Gemini's setting keeps today's 12000 default. One engine-neutral budget per pass kind, plus a "preferred chunk size" that can never exceed capacity. Today's resolved budgets for today's default models are pinned by a test; defaults change only after on-box measurement. | Large-context local models make local defaults stale, but nothing changes before it is measured. |
| 7 | Max output tokens | Per engine/endpoint, default **Auto** = min(model output limit, context left after input). A manual value is clamped to the model's limit (lifting Gemini's 32768 cap). No separate reasoning reserve: overflow surfaces as a `length` finish and splits the chunk. Endpoints send `max_tokens`; a custom payload may override or rename it, which disables Auto for that endpoint and is shown. | Static caps drift; a magic reserve number would be a guess. |
| 8 | Reasoning | Per engine/endpoint `model default` / `off` / `low` / `medium` / `high`. **Defaults preserve today**: Ollama `off`, Gemini and endpoints `model default`. Mapped per transport; a rejected field uses decision 2b. Every parse strips an inline `<think>` block. | Explicit control without changing current quality or cost by default. |
| 9 | Custom payload | Per engine/endpoint JSON object, **merged last, one level deep** into the native request; `null` removes a key. Pipeline-owned keys are refused at save with a message naming them. Validated on save; the label shows "+ custom params"; never logged. | Provider-specific options without letting a payload break parsing or change the model. |
| 10 | Persona generation | Its engine choice becomes **any engine or endpoint**, running through the same transports, limiter, reasoning setting and custom payload (structured output does not apply: personas are free text). | A user with only an OpenAI-compatible endpoint can still design voices. |

## Design

### 1. Stage runner and transports

- **The transport contract.** `ChatTransport.send({ messages, system, structuredOutput, temperature, maxOutputTokens, reasoning, extraParams, signal, onChunk })` returns `{ text, finish: 'stop' | 'length' | 'blocked', usage? }`. Transports own wire format, HTTP client, streaming, rate-limiter acquisition, and the shared retry helper (429 with retry-after, daily-quota detection, 5xx, idle stream; extracted from `gemini.ts:536-652`).
- **What the runner owns.** The stage runner, generalised from the two existing runners, owns:
  - `writeInbox`, skill/system-instruction loading, schema generation and adaptation;
  - the first attempt, `parseAndValidate`, and the kind-aware retry (Ollama's invalid-JSON vs schema-validation split, `ollama.ts:550-571`);
  - persistence (`persistResponse`, `rawAttemptPath`, `errorPath`), the decision-2b downgrade tracker (per run), and failure mapping;
  - escalation (`runAttributionEscalation`: no retry, `null` on unusable output) and non-story classification use the runner's single-attempt path.
- **The Ollama transport.** `OllamaTransport` is today's `OllamaAnalyzer.chat()` body (`ollama.ts:623-760`), including `keep_alive`, `num_ctx`, `num_gpu`, `acquireAnalyzerSlot`, eval-timing telemetry and `ANALYZER_DISPATCHER`.
- **The Gemini transport.** `GeminiTransport` is `generateWithLimiter` + `generate` (`gemini.ts:536-760`): limiter, idle watchdog, token-count reconciliation, `MAX_TOKENS` / SAFETY / RECITATION → `finish`.
- **The OpenAI transport.** `OpenAITransport` creates one client per endpoint:
  - `new OpenAI({ baseURL, apiKey, maxRetries: 0, timeout: <absolute ceiling>, fetchOptions: { dispatcher: <long-call Agent> } })`, with streaming on;
  - `finish_reason: 'length'` → `length`;
  - connect-phase errors (inspect the error cause: `ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT`) → `AnalyzerUnreachableError`;
  - `APIConnectionTimeoutError` → `AnalyzerTimeoutError` (a failure, never a fallback);
  - an idle-stream watchdog arms after the first chunk.
- **Unreachable errors.** `AnalyzerUnreachableError` replaces `LocalUnreachableError` as `FallbackAnalyzer`'s trigger (`index.ts:257-405`).
- **Engine value.** `AnalysisEngine` becomes `'local' | 'gemini' | 'openai'`. It is updated in the settings enum, `openapi.yaml` (regenerating `src/lib/api-types.ts`), `AnalyzerSelection`, `ModelOption.engine`, and persona generation's engine setting.
- **Classifying `'local'` branches.** Every `engine === 'local'` branch is classified during planning as "Ollama-specific" (stays on the engine) or "shares the GPU" (reads decision 4's flag).

### 2. Structured output

| Mode | Ollama | Gemini | OpenAI-compatible |
|---|---|---|---|
| `schema` | `format: <adapted schema>` | `responseMimeType` + `responseJsonSchema: <adapted schema>` | `response_format: { type: 'json_schema', json_schema: { name, schema: <adapted>, strict: false } }` |
| `json` | `format: 'json'` | `responseMimeType` only | `response_format: { type: 'json_object' }` |
| `off` | no `format` | neither | no `response_format` |

- **Schema adapters.** Each provider has an adapter: a pure function from the draft-07 schema (`z.toJSONSchema(..., { target: 'draft-07', reused: 'inline' })`) to `{ schema, dropped: string[] }`.
  - The Gemini adapter keeps only the documented keywords (`genai.d.ts:5651-5666`), removes `$schema`, and turns `exclusiveMinimum: n` into `minimum` on integers (next integer).
  - The Ollama adapter is today's pass-through; the Ollama `format` test (`server/src/analyzer/ollama.test.ts:386-410`) stays valid.
  - The OpenAI-compatible adapter removes `$schema` only.
- **Label and help.** `dropped` feeds the label ("schema (partial)") and a debug log line listing keywords, never values.
- **Settings.** `analyzer.ollama.structuredOutput` and `analyzer.gemini.structuredOutput` are registry knobs (each with a Settings row, `.env.example` line and `config:sync`); each endpoint carries its own field.
- **Failure codes** in `server/src/routes/failure-taxonomy.ts`:
  - `analyzer-format-rejected`: decision 2b's retry also failed; names the setting.
  - `analyzer-invalid-output`: validation failed after retry, with a mode-aware hint.
  - `analyzer-timeout`: decision 1c.
- **`<think>` strip.** `parseAndValidate` strips a leading `<think>…</think>` block before its existing candidates, following the regex precedent at `voice-style.ts:148-152`.

### 3. Endpoints, model ids and catalogs

- **Storage.** `analyzerEndpoints: Array<{ id, name, baseUrl, runsOnThisGpu, unloadUrl?, concurrency, structuredOutput, reasoning, maxOutputTokens, contextTokens?, maxInputTokensPerRequest?, preferredChunkChars?, extraParams? }>` lives in user settings.
- **API keys.** They are stored separately per endpoint id, written only through a dedicated endpoint, never returned by the settings GET, and stripped from the general PUT, following the Gemini key precedent (`user-settings.ts:211-219`).
- **Deleting an endpoint.** Blocked while any saved setting references its ids (default model, phase knobs from #3141, persona engine); the error lists the references.
- **Id grammar.**
  - `openai:<endpointId>::<model>`.
  - Inference, in order: matches `^openai:[a-z0-9-]+::` → `openai`; contains `:` → `local`; else → `gemini`.
  - An Ollama tag such as `openai:latest` cannot match, because it has no `::`.
  - One shared test table drives both `engineForModelId` (frontend) and `inferEngineFromModelId` (server).
- **Catalogs.** `GET /api/analyzer/models` returns grouped catalogs with a short server-side cache and an explicit refresh:
  - **Ollama:** `/api/tags`.
  - **Gemini:** `models.list()` (`genai.d.ts:11032`), filtered to `supportedActions` containing `generateContent`, only when a key is set.
  - **Each endpoint:** `/v1/models` via the SDK, plus free-text entry.
  - Each group carries its endpoint's `runsOnThisGpu`.
  - Curated entries (`MODEL_OPTIONS`, `src/lib/models.ts:19-95`) overlay labels and hints, extending `buildLocalModelOptions(liveTags, curated)` (`models.ts:156`). A failed listing falls back to the curated list.
- **Labels.** `modelLabel(id)` (curated label → live `displayName` → model part of the id, prefixed with the endpoint name) replaces the ~9 `MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id` sites.

### 4. GPU coordination and fallback

- **Frontend guards.** `use-local-analyzer-guard.tsx:78-81` and its reverse guard resolve the selected id to its engine or endpoint. They treat `local`, and any endpoint with `runsOnThisGpu`, as sharing the GPU. The flag comes from the catalog response (decision 4).
- **Eviction.** Capacity eviction (`server/src/gpu/capacity-retry.ts:279`, `server/src/tts/sidecar.ts:432`) calls, best-effort, every configured `unloadUrl` of an endpoint with `runsOnThisGpu`, alongside `evictOllama`. Without an unload URL, admission queues and the failure message names the endpoint setting.
- **Fallback.** `FallbackAnalyzer` wraps an endpoint exactly as it wraps `local`: fallback to Gemini only on `AnalyzerUnreachableError`, only with a key and `allowCloudFallback` on, announced through `onFallback`.

### 5. Rate limits and concurrency

- **Limiter.** `GeminiRateLimiter` (`rate-limit.ts:158`) becomes the analyzer limiter, keyed by full model id, and is used by the Gemini and OpenAI transports and persona generation (today `voice-style.ts:213`).
- **Limit resolution.** For Gemini ids: env → `analyzerRateLimitsByModel` (a user-settings map, following `analyzerKeepAliveByModel`, `user-settings.ts:253`) → `BUILTIN_LIMITS` → Gemini default. For endpoint ids: `analyzerRateLimitsByModel` → unlimited.
- **Migrating the Gemma knobs.** The six `rate.*.gemma*` knobs wired by #3139 migrate into the map and are removed. The **#3146 guard's `rate.*` dynamic-reader entry and `KNOWN_UNREAD` handling are updated in the same change**.
- **Settings editor.** Settings gains a per-model limits editor listing catalog models.
- **Concurrency.** Per-endpoint concurrency gates calls with the same count-semaphore mechanism as `acquireAnalyzerSlot` (`server/src/analyzer/analyzer-concurrency.ts:60`), one semaphore per endpoint.

### 6. Capacity model

`EngineCapacity { contextTokens, maxOutputTokens, perRequestInputCap }`, resolved per model:

- **Ollama.** `contextTokens` is the `num_ctx` sent (`ollama.ts:275`), capped at `/api/show`'s native context length. `perRequestInputCap` is unbounded, since the context governs. Large local windows are enabled by raising `analyzer.ollama.numCtx`, which remains the VRAM-bearing choice.
- **Gemini.** `contextTokens` / `maxOutputTokens` come from `models.list()` `inputTokenLimit` / `outputTokenLimit`. `perRequestInputCap` = min(`analyzer.gemini.maxInputTokensPerRequest` (default 12000, unchanged), the model's TPM limit).
- **Endpoints.**
  - `contextTokens` comes from the endpoint setting, auto-filled where available from llama.cpp `/props` (llama-swap: `/props?model=<id>`).
  - `perRequestInputCap` = min(the endpoint's `maxInputTokensPerRequest` if set, its TPM limit if set).
- **Pass kinds.** *Input-heavy* passes (stage-1 cast detection, non-story classification) and *output-heavy* passes (stage-2 attribution, emotion, script review, instruct annotation). Two engine-neutral fraction knobs replace `analyzer.stage1.localInputFraction` / `analyzer.stage2.localInputFraction`, keeping their 0.7 / 0.3 defaults.
- **Budget formula.** Budget = min(`contextTokens` × fraction − fixed overhead, `perRequestInputCap` − overhead, and for output-heavy passes the input implied by `maxOutputTokens`), converted with `charsPerTokenForText`. Existing reservations are kept (`STAGE1_CLOUD_RESERVED_TOKENS`, `OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS`, roster chars). The result is then capped by the per-pass-kind "preferred chunk size" (defaults 24000 / 9000 / 32000).
- **Resolver signatures.** `resolveStage1ChunkCharBudget`, `resolveStage2ChunkCharBudget` and `chapterChunkBudget` take a capacity descriptor instead of an engine name.
- **Pinning test.** For `qwen3.5:4b` at `num_ctx` 32768 and `gemini-3.5-flash-lite` at the 12000 cap, resolved budgets for representative Latin and Cyrillic chapters equal today's values exactly.

### 7. Max output tokens

- **Settings.** `analyzer.ollama.maxOutputTokens` and `analyzer.gemini.maxOutputTokens` accept `auto` (default) or an integer, as do each endpoint's field. They replace `analyzer.ollama.numPredict` and today's `analyzer.gemini.maxOutputTokens` knob, whose explicit env/override values migrate to integers.
- **Auto.** Ollama → `num_predict: -1` (today's behaviour, since the context governs). Gemini → the model's `outputTokenLimit`. Endpoints → min(catalog/`/props` limit if known, `contextTokens` − estimated input); omitted when neither is known.
- **Unchanged behaviour.** Truncation handling is unchanged: `done_reason: 'length'` (`ollama.ts:727`), `MAX_TOKENS` (`gemini.ts:741`) and `finish_reason: 'length'` raise `AnalyzerTruncatedError`, which splits the chunk.
- **Gemini default risk.** Auto for Gemini **raises the default cap from 8192 to the model limit**, the one default change this design makes before measurement. It only affects calls that were being truncated today, and it is covered by the on-box row.

### 8. Reasoning

- **Settings.** `analyzer.ollama.reasoning` and `analyzer.gemini.reasoning`, plus each endpoint's field: `model-default` / `off` / `low` / `medium` / `high`.
- **Ollama.** `think: false` for `off`; `think: true` otherwise.
- **Gemini.** The SDK's thinking configuration. Field names and per-model support are verified during planning.
- **Endpoints.** `reasoning_effort` for `low` / `medium` / `high`; omitted otherwise.
- **Rejections.** A rejected field uses decision 2b.

### 9. Custom payload

- **Storage.** Stored per engine (`analyzerExtraParamsByEngine.ollama` / `.gemini`) and per endpoint (`extraParams`), edited in Advanced Settings' analyzer section, validated on save as a JSON object.
- **Merge.** Merged last, one level deep, into the native request; `null` removes a key.
- **Protected keys,** refused at save:
  - Endpoints: `model`, `messages`, `stream`, `response_format`, `reasoning_effort`.
  - Ollama: `model`, `messages`, `stream`, `format`, `think`, `keep_alive`.
  - Gemini `config`: `systemInstruction`, `abortSignal`, `responseMimeType`, `responseJsonSchema`, `responseSchema`.
- **Unprotected output keys.** `max_tokens`, `max_completion_tokens`, `num_predict` and `maxOutputTokens` are not protected. Setting or removing one disables Auto for that engine/endpoint, and the run label shows it.
- **Privacy.** The label shows "+ custom params". The payload is excluded from logs and persisted analyzer files.

### 10. Persona generation

- **Engine setting.** `analyzer.personaGeneration.engine` becomes a model-id-style selection: `local` / `gemini` / any `openai:<endpointId>::<model>`.
- **Transport.** `generatePersonaViaOllama` and the Gemini persona call become transport calls through the runner's free-text path (no structured output), with the limiter, reasoning setting and custom payload applied.
- **Unchanged.** The "no silent cross-provider fallback" rule in its help text (`registry.ts:1185`) is unchanged.

## Data flow (one analyzer call)

1. **Selection.** The route resolves engine/endpoint + model (per-run phase pick from #3141), capacity, and that engine/endpoint's settings.
2. **Chunking.** The chunker sizes the chapter from capacity and preference.
3. **Request.** The runner builds messages and the adapted structured-output request.
4. **Send.** The transport acquires limiter and concurrency, merges the custom payload last, sends through its HTTP client, streams, and normalises `finish`.
5. **Parse.** The runner strips `<think>`, repairs, validates and retries. A 400 on a carried format or reasoning field triggers the decision-2b retry-without.
6. **Outcome.** `length` splits and retries. A connect-phase failure falls back under the gate. Everything else maps to a failure-taxonomy code.

## Error handling summary

| Condition | Behaviour |
|---|---|
| Connect-phase failure | `AnalyzerUnreachableError` → Gemini fallback if gated on, else a hard fail naming the endpoint |
| Timeout after connecting | `analyzer-timeout`, never a fallback |
| 401/403 | `auth`, naming the endpoint's key |
| 400 on a carried format/reasoning field | Retry once without it; drop for the run if that succeeds, shown; else `analyzer-format-rejected` |
| 429 / 5xx / idle stream | Shared retry helper; limiter records rejections |
| `length` finish | `AnalyzerTruncatedError` → chunk split |
| Validation fails after retry | `analyzer-invalid-output`, mode-aware hint |
| Invalid payload / protected key / endpoint still referenced | Refused at save (400), never at run time |

## Testing

- **Transport contract suite.** Run against all three transports with stubbed HTTP: streamed text, `finish` mapping, abort, connect-phase vs post-connect timeout classification. The OpenAI suite includes a **long silent prefill** that must not time out before the configured ceiling.
- **Runner.** Existing `ollama.test.ts` / `gemini.test.ts` stage behaviours move to runner tests without weakening assertions. Also: decision-2b downgrade, the `<think>` strip, and the persona free-text path.
- **Pure functions.** Schema adapters, including a snapshot of `dropped` for every stage schema per provider; the id-grammar table; catalog merge and fallback; limiter resolution order; capacity + budgets, with the default-budget pinning test; Auto output tokens; reasoning mapping; payload merge and protected keys.
- **Routes.** `GET /api/analyzer/models`; endpoint CRUD, including the delete-while-referenced refusal; per-endpoint key write; settings validation.
- **E2E (Playwright, mock mode).** Add an endpoint, pick its model in the picker, run label shows mode and "+ custom params"; the GPU guard prompts for a `runsOnThisGpu` endpoint.
- **Mutation proofs** for each resolver, adapter and guard, per repo practice.

## On-box acceptance owed (register rows)

- **Live structured output:** `schema` checks on `gemma-*`, `gemini-*` and a llama-swap endpoint, recording what the Gemini adapter drops and whether output conforms.
- **Long silent prefill:** a llama-swap endpoint on the slower card with a 64k+ prompt completes without timeout or fallback.
- **Same-card eviction:** llama-swap endpoint with `runsOnThisGpu` + unload URL; a Qwen TTS load on the same 8 GB card evicts the analyzer instead of failing with out-of-memory.
- **Capacity recalibration:** a large-context local model on a 16 GB card, comparing chunk counts, truncation rate and attribution quality against today's defaults, and Gemini Auto output vs 8192, before any other default changes.

## Sequencing

Each wave is its own plan section and PR:

- **Wave 0 (in the queue):** #3139, #3141.
- **Wave 1:** shared runner + Gemini/Ollama transports (behaviour-preserving refactor; existing tests stay green).
- **Wave 2:** OpenAI transport + endpoints list + id grammar + catalogs + structured output with adapters (decisions 1b, 1c, 2, 3).
- **Wave 3:** GPU/fallback + rate limits/concurrency + persona generation (decisions 4, 5, 10).
- **Wave 4:** capacity model + max output tokens (decisions 6, 7), then on-box recalibration.
- **Wave 5:** reasoning + custom payload (decisions 8, 9).

## Verifications owed during planning (facts, not decisions)

- Ollama's model-name grammar cannot contain `::`.
- `@google/genai` 2.19 thinking-configuration fields and per-model support; whether Gemini returns 400 or silently ignores unsupported `responseJsonSchema` keywords.
- `openai` 7.x: that `fetchOptions.dispatcher` reaches Node's fetch for streaming requests, and the exact error class/cause shape for connect-phase failures vs `APIConnectionTimeoutError`.
- llama.cpp / llama-swap: whether response headers are sent before prefill completes (determines whether the idle watchdog or the ceiling bounds the silent phase).
- Ollama `/api/show` context-length field for the models in `MODEL_OPTIONS`.
- Every `engine === 'local'` site classified as "Ollama-specific" or "shares the GPU".
