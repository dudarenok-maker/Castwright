---
status: draft
issue: 3084
date: 2026-09-10
---

# OpenAI-compatible analyzer endpoints, and request controls for every analyzer engine

**Issue:** #3084 (reporter feature request). **Prerequisite bugs found during this design:** #3139, #3141.
**Decisions:** made one area at a time with the repo owner on 2026-09-10. They were revised twice: after an in-session adversarial assumption check the same day, and after an independent adversarial review on 2026-09-11. Each decision is recorded with its rationale.

## Problem

The #3084 reporter asks for five things: (1) an OpenAI-compatible endpoint (base URL, API key, model) for script generation, (2) chunk-size control, (3) max-tokens control, (4) reasoning-effort control, and (5) a custom JSON payload merged into the request. Their setup is Windows 10 with 2× GTX 1060 6 GB and a GTX 1050 Ti 4 GB, on v1.14.0.

**The reporter's stall.** A Gemini chapter "buffered" for 30 minutes. Their follow-up on #3084 (2026-09-10) adds:
- the model was `gemini-3.6-flash`, a thinking model with built-in limits of 5 RPM / 20 RPD (`server/src/analyzer/rate-limit.ts:42`);
- the chapter was 20,000 characters;
- no settings were changed, which rules out #3139 as the cause;
- it reproduces: the run "buffers on detected characters indefinitely", started with `npm run start:prod`.

The attached `server.log` / `server.err.log` contain no `[analysis]` or `[gemini]` lines, so they do not cover the run. The stall is still undiagnosed and is tracked on #3084, separately from this design.

What the code does today:

- **Exactly two analyzer engines, hard-coded as a pair.**
  - `local` goes to Ollama's native `/api/chat` (`server/src/analyzer/ollama.ts:693`).
  - `gemini` goes through `@google/genai` (`server/src/analyzer/gemini.ts:725`).
  - The union `'local' | 'gemini'` appears 42 times literally under `server/src`, `src` and `openapi.yaml`; some are TTS uses of the same words.
  - The union is fixed in several places:
    - `analysisEngine`'s enum (`openapi.yaml:4628`, `:4831`; `server/src/workspace/user-settings.ts:98`);
    - `ModelOption.engine` (`src/lib/models.ts:16`);
    - run snapshots (`server/src/store/analysis-state.ts:52`, `server/src/workspace/active-analyses.ts:47`);
    - `getResolvedAnalysisEngine`, which coerces anything that isn't `gemini` to `local` (`user-settings.ts:781-783`);
    - persona generation's engine enum (`server/src/config/registry.ts:1181-1191`).
- **Two separate stage runners.** `OllamaAnalyzer` and `GeminiAnalyzer` each implement prompt building, `parseAndValidate` and a validation retry (`ollama.ts` ~470-614; `gemini.ts:441-521`). They differ in their retry policy:
  - on invalid JSON, Ollama drops the assistant turn and raises the temperature (`ollama.ts:559-571`), while Gemini replays the model turn at the same temperature (`gemini.ts:484-493`);
  - Ollama writes `rawAttemptPath` forensics (`ollama.ts:539`, `:593`); Gemini does not;
  - Gemini escalation swallows `DailyQuotaExhaustedError` (`gemini.ts:420-430`), while Ollama escalation rethrows unreachable errors (`ollama.ts:455-456`).

  Persona generation adds two more direct LLM calls: `generatePersonaViaOllama` (`ollama.ts:938`) and a Gemini `generateContent` call (`server/src/analyzer/voice-style.ts:197-219`).
- **The engine is inferred from the model id's shape.** `:` means Ollama; anything else means Gemini.
  - The rule is duplicated on the server (`server/src/analyzer/index.ts:195`) and the frontend (`src/lib/models.ts:108`).
  - It is repeated implicitly by:
    - `getResolvedOllamaModel` (`user-settings.ts:766-771`), which persona generation inherits (`voice-style.ts:67-70`);
    - the `:` normalisers in `model-vram-stats.ts:34,179`, `analyzer-eval-stats.ts:55` and `models-inventory.ts:132`.
- **Structured output differs by engine.**
  - Ollama sends the per-stage Zod schema as `format` (`ollama.ts:504`, `:643`).
  - Gemini sends only `responseMimeType: 'application/json'` (`gemini.ts:729`); its runner ignores the grammar schema (`_grammarSchema`, `gemini.ts:446`).
  - The generated schemas contain `$schema`, `minLength` and `exclusiveMinimum`, none of which are in Gemini's supported `responseJsonSchema` subset (`server/node_modules/@google/genai/dist/genai.d.ts:5651-5666`).
  - `parseAndValidate` (`gemini.ts:1006-1053`) strips code fences and trailing prose. A leading `<think>` block defeats it, because `trimTrailingProse` slices from index 0 (`gemini.ts:1220-1255`).
- **HTTP errors carry no structure.** A non-OK Ollama response is thrown as a plain `Error` with the status only in its message text (`ollama.ts:713-715`). `failure-taxonomy.ts:466-479` maps a 400 to `unknown`.
- **Long local calls need a special HTTP client.** Ollama sends no response headers until the first generated token. `ANALYZER_DISPATCHER` (`ollama.ts:120-133`) therefore disables undici's header and body timeouts, and keeps a 10 s connect timeout so a down daemon still fails fast into the fallback path.
  - "Unreachable" is `UNREACHABLE_CODES` (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `UND_ERR_SOCKET`; `ollama.ts:147-153`), a bare `fetch failed`, or an abort before the first byte (`ollama.ts:1043-1060`).
- **Chunk budgets branch on the engine name.** Every resolver treats anything that isn't `local` as Gemini cloud.
  - **Local:** `resolveStage1ChunkCharBudget` and `resolveStage2ChunkCharBudget` derive from Ollama `num_ctx` × `analyzer.stage{1,2}.localInputFraction` (0.7 / 0.3) at a fixed 2 chars/token, with no reservation (`server/src/analyzer/stage1-chunk.ts:96-126`, `stage2-chunk.ts:59-82`). Local chapter-level passes reuse stage 1's budget (`server/src/analyzer/chapter-chunker.ts:136`).
  - **Cloud:** bodies are sized by `cloudBodyCharBudget` from `analyzer.gemini.maxInputTokensPerRequest` (default 12000; `server/src/analyzer/token-budget.ts:30-51`), using `charsPerTokenForText` (`token-budget.ts:10-28`) and fixed token reservations.
  - **Ceilings:** `analyzer.stage1.chunkCharBudget` 24000, `analyzer.stage2.chunkCharBudget` 9000 and `analyzer.gemini.outputHeavyChunkChars` 32000 (`registry.ts:83-131`).
- **Output caps are static per engine.**
  - Ollama `num_predict` defaults to −1, unlimited (`registry.ts:41-47`).
  - Gemini `maxOutputTokens` (`ANALYZER_MAX_OUTPUT_TOKENS`) defaults to 8192, within min 256 / max 32768 (`registry.ts:51-58`). On Gemini 3 thinking models, thinking tokens count against that cap.
  - An empty `MAX_TOKENS` response becomes `AnalyzerTruncatedError` (`gemini.ts:801-802`), which splits the chunk up to depth 3 (`stage1-chunk.ts:156`, `stage2-chunk.ts:341`). Splitting does not shrink reasoning.
- **Reasoning is controlled only on Ollama** (`think: false`, `ollama.ts:651`). **No custom request payload exists.**
- **GPU guards key on the engine name.**
  - The forward guard reads `ui.selectedModel` (`src/hooks/use-local-analyzer-guard.tsx:64`, `:78`).
  - The reverse guard reads `analysis.activeStream.engine`, captured when the stream starts (`src/hooks/use-reverse-local-analyzer-guard.tsx:34-36`).
  - TTS capacity eviction is keyed by device (`${kind}:${index}`), gated on Ollama's VRAM figure, and skipped while an analysis is in flight (`server/src/gpu/capacity-retry.ts:270-281`).

Two defects in this area were split out as prerequisites and are queued as Open Engine chains:

- **#3139** — Advanced Settings rate-limit overrides are stored and shown, but `resolveLimits` (`rate-limit.ts:76-84`) reads only `process.env`. Children: #3147 → #3146 (adds `registry-knob-read.guard.test.ts`) → #3145.
- **#3141** — five analyzer-model overrides are never read. The analysing view's phase swap writes account settings, and falsely claims to apply "from the next chapter". Children: #3158 → #3157 → #3156 → #3155 → #3154 → #3153 → #3152.

## Goals

- Any number of **named OpenAI Chat Completions-compatible endpoints**: llama.cpp / llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter and similar, usable side by side, including across analysis phases.
- Structured output, model catalogs, rate limits, chunk sizing, output caps, reasoning and custom parameters behave **consistently across Ollama, Gemini and every endpoint**, through **one stage runner**.
- Persona generation can use any engine or endpoint the analyzer can.
- Every behaviour that changes what the model receives is **explicit in Settings, with its impact stated**. Nothing is downgraded or guessed silently.
- An endpoint is never offered for analysis before its sizing, GPU coordination and concurrency exist.

## Non-goals

- Bundling or managing llama.cpp or any other server. Serving is left to whatever tool the user runs.
- A true mid-run model swap for a live job (#3141 settled this as a pre-run pick).
- OpenAI `strict: true` structured outputs: `server/src/handoff/schemas.ts` relies on optional, nullable and union constructs.
- Learning rate limits from response headers.
- Environment-variable overrides for OpenAI-compatible endpoint settings. Endpoints are configured in Settings only.
- Unifying the two runners' retry policies or the two budget formula families. Both stay as they are today until measured.
- Diagnosing the reporter's Gemini stall (tracked on #3084).

## Decisions

| # | Area | Decision | Why |
|---|---|---|---|
| 1 | Stage runner & transports | **One stage runner** for every engine (prompt, schema, parse, validation retry, persistence, payload merge, reasoning mapping). Each engine is a **transport**: `OllamaTransport` (today's `chat()`), `GeminiTransport` (from `generateWithLimiter`/`generate`), `OpenAITransport`. Today's per-engine retry differences are kept as a **per-transport retry policy**, pinned by characterisation tests written before extraction. | Every cross-engine rule is written and tested once, without changing either engine's retry behaviour. |
| 1b | Transport library | The **official `openai` npm SDK** (7.x, zero runtime dependencies), using undici's own `fetch`. | Offloads protocol code, mirroring the `@google/genai` precedent. |
| 1c | Long calls & fallback | The SDK gets `fetch: undici.fetch` plus a **long-call dispatcher** (no header/body timeout, 10 s connect timeout) from the same undici package, with SDK retries off. A **per-endpoint absolute ceiling** (our own abort signal, default 30 min) bounds the whole call, because the SDK's `timeout` stops at response headers for streams. An idle-stream watchdog arms after the first delta. The error's cause chain is classified **before** its SDK class: today's unreachable codes plus `UND_ERR_CONNECT_TIMEOUT`, raised before response headers, mean "unreachable" and may fall back; everything else, including `APIConnectionTimeoutError` and the ceiling, is a timeout. | Passing an npm-undici `Agent` to Node's global fetch fails (`invalid onRequestStart method`). The SDK reports a connect timeout as `APIConnectionTimeoutError`. A header-then-silence server would otherwise have no bound. |
| 2 | Structured output | Per engine/endpoint setting `schema` / `json` / `off`. **Defaults: Ollama `schema` (today), Gemini `json` (today) until on-box measurement, endpoints `schema`.** Repair and retry stay on in every mode. A **per-provider schema adapter** rewrites the schema into the provider's supported subset and records what it dropped; the label reads "schema (partial)" when constraints were dropped, and our validator still enforces the full schema. | Strongest guarantee where it is already proven; Gemini's switch waits for measurement. |
| 2b | Rejected parameters | **Test once, never guess.** A **Test** action per model (endpoint, Gemini or Ollama) sends one tiny request per structured-output mode and per reasoning level, and records the result per model id. A run whose configured mode the record marks rejected is refused before it starts. An untested model is sent as configured. **A 400 never triggers a downgrade or retry-without**: it fails as `analyzer-request-rejected`, with the provider's error (redacted) and the settings that shape the request named. No error-message parsing. | A 400 has many causes (context overflow, invalid key, `max_tokens` on reasoning models). Only a controlled probe can attribute it. |
| 2c | Live validation | The Test action, plus a real chapter, run on `gemma-*`, `gemini-*` and a llama-swap endpoint per mode, recorded before defaults ship. | Owner rule. |
| 3 | Endpoints & model ids | **Named endpoints list** in user settings. Model ids are `openai:<endpointId>::<model>`, with `endpointId` matching `[a-z0-9-]+`. Gemini and Ollama ids are unchanged. Every site that sniffs `:` or coerces the engine to two values is updated. **Live catalogs for every engine and endpoint** via a cached `GET /api/analyzer/models`, with curated overlay, static fallback, and one `modelLabel(id)` resolver. | A local server and a cloud gateway coexist; new free Gemini models appear with no code change. |
| 3b | Endpoint context size | **Required when adding an endpoint**, prefilled when `/v1/models` reports it, with an on-demand **Detect** button that reads llama.cpp `/props`. Nothing probes the endpoint automatically. | llama-swap has no `/props?model=`, and `/upstream/<model>/props` loads the model onto the GPU. |
| 3c | Endpoint API keys | Each key is stored **bound to its base URL's origin** and sent only when the origin still matches; changing the host requires re-entering the key. The unload URL must share the base URL's origin. | The SDK sends the key as a Bearer token to whatever base URL is saved, and the app is served over the LAN. |
| 4 | GPU & fallback | Per endpoint, a **card picker**: `none` / `any` / a detected device (`cuda:N`). The default is `any` for a `localhost` / `127.0.0.1` / `::1` host, else `none`. Guards and eviction act only when TTS targets the same card; `any` counts as every card. The endpoint's `gpu` and optional unload URL come from **saved settings**, not the catalog. Gemini fallback happens only for "unreachable" (1c), under `allowCloudFallback`. | Eviction is per card, and both this box and the reporter's have several. llama-swap exposes `POST /api/models/unload`. |
| 5 | Rate limits & concurrency | One model-keyed limiter for Gemini and every endpoint. Limits resolve **env (Gemini only, existing `GEMINI_{RPM,TPM,RPD}_<slug>`) → per-model Settings map → built-in table → engine default** (Gemini 5 rpm / 100k tpm / 50 rpd; endpoints unlimited). Per-endpoint concurrency (default 1). One shared retry helper; SDK retries off. | Live-listed models need editable limits without code. |
| 6 | Chunk sizing | **Capacity model for all engines, byte-identical today.** A capacity descriptor carries today's formula family: **context-governed** (Ollama's fraction × context at 2 chars/token) or **request-cap-governed** (Gemini's `cloudBodyCharBudget` with its reservations). Endpoints are context-governed, additionally capped by their optional max-input-per-request and TPM limit. Each pass keeps the resolver and ceiling it uses today. A pinning test locks today's budgets; defaults change only after on-box measurement. | Large-context local models make local defaults stale, but nothing changes before it is measured. |
| 7 | Max output tokens | Per engine/endpoint, **Auto** or an integer. **Auto is `0`** in the existing integer knobs. **Gemini's default becomes Auto (model limit) now**; Ollama's −1 is already its Auto. A manual value is clamped to the model's limit. A `length` finish **with answer text** splits the chunk as today. A `length` finish **with no answer text** (all reasoning) **fails as `analyzer-reasoning-overflow`** instead of splitting. | Thinking tokens count against Gemini's 8192 cap on the reporter's model; splitting never shrinks reasoning, and on a 20 RPD model it burns the day's quota. |
| 8 | Reasoning | Per engine/endpoint `model default` / `off` / `low` / `medium` / `high`. **Defaults preserve today**: Ollama `off`, Gemini and endpoints `model default`. Mapped per transport; support per model is what the Test action records. Every parse strips an inline `<think>` block. | Explicit control without changing current quality or cost by default. |
| 9 | Custom payload | Per engine/endpoint JSON object, **merged last** into the native request: top-level keys, plus the transport's one owned container (Ollama `options`, Gemini `config`) key by key; `null` removes a key. Keys that the pipeline owns, or that change capacity, VRAM or parsing, are refused at save with a message naming them. Validated on save; the label shows "+ custom params". The payload is never logged, and its string values are redacted from upstream error text. | Provider-specific options (for example llama.cpp `chat_template_kwargs`) without letting a payload break parsing, capacity or the model. |
| 10 | Persona generation | Its engine choice becomes **any engine or endpoint**, running through the same transports, limiter, reasoning setting and custom payload. Structured output does not apply, because personas are free text. | A user with only an OpenAI-compatible endpoint can still design voices. |

## Design

### 1. Stage runner and transports

- **The transport contract.** `ChatTransport.send({ messages, system, structuredOutput, temperature, maxOutputTokens, reasoning, extraParams, signal, onChunk })` returns `{ text, reasoningText?, finish: 'stop' | 'length' | 'blocked', usage? }`.
  - Transports own the wire format, HTTP client, streaming, rate-limiter and concurrency acquisition, and the shared retry helper (429 with retry-after, daily-quota detection, 5xx, idle stream; extracted from `gemini.ts:536-652`).
  - Every non-OK HTTP response is thrown as a typed `AnalyzerHttpError { status, bodyExcerpt }`. This replaces the plain `Error` at `ollama.ts:713-715`, so the taxonomy maps by status, never by message text.
- **What the runner owns.** The stage runner, generalised from the two existing runners, owns:
  - `writeInbox`, skill/system-instruction loading, schema generation and adaptation;
  - the first attempt, `parseAndValidate`, and the validation retry, run through the transport's **retry policy**:
    - Ollama: drop the assistant turn and raise the temperature on invalid JSON (`ollama.ts:559-571`), and write `rawAttemptPath`;
    - Gemini: replay the model turn at the same temperature (`gemini.ts:484-493`);
  - persistence (`persistResponse`, `rawAttemptPath`, `errorPath`) and failure mapping;
  - escalation (`runAttributionEscalation`: no retry, `null` on unusable output) and non-story classification, through the runner's single-attempt path. Each transport keeps its escalation error policy: Gemini swallows `DailyQuotaExhaustedError` (`gemini.ts:420-430`), Ollama rethrows unreachable (`ollama.ts:455-456`).
- **Characterisation first.** Before extraction, tests pin each of those differences. `gemini.test.ts` has no assertion on the retry request shape today, so it gets one for the replayed turn and temperature. Extraction is accepted only with these green.
- **The Ollama transport.** `OllamaTransport` is today's `OllamaAnalyzer.chat()` body (`ollama.ts:623-927`), including `keep_alive`, `num_ctx`, `num_gpu`, `acquireAnalyzerSlot`, eval-timing telemetry, `ANALYZER_DISPATCHER` and its unreachable classifier (`ollama.ts:1043-1060`, abort-before-first-byte included).
- **The Gemini transport.** `GeminiTransport` is `generateWithLimiter` + `generate` (`gemini.ts:536-860`): limiter, idle watchdog, token-count reconciliation, `MAX_TOKENS` / SAFETY / RECITATION → `finish`.
- **The OpenAI transport.** `OpenAITransport` creates one client per endpoint:
  - The client is `new OpenAI({ baseURL, apiKey, maxRetries: 0, timeout: <ceiling>, fetch: undici.fetch, fetchOptions: { dispatcher: <long-call Agent> } })`, with `fetch` and `Agent` from the same `undici` package (`server/node_modules/undici`) and streaming on.
  - The **absolute ceiling** is `AbortSignal.any([callerSignal, AbortSignal.timeout(requestCeilingMs)])`, covering the call from request to last delta. The SDK `timeout` alone clears when headers arrive (`openai` `client.ts:1576,1600-1602`; no stream timer at `:1012-1019`).
  - The **idle watchdog** arms after the first delta. A `reasoning_content` delta counts as activity and feeds the route heartbeat, but is not parsed as answer text.
  - `finish_reason: 'length'` → `length`.
  - **Classification order:**
    1. Walk the error's cause chain. If a code is in `UNREACHABLE_CODES` or is `UND_ERR_CONNECT_TIMEOUT`, or it is a bare `fetch failed`, and no response headers were received, the error is `AnalyzerUnreachableError`.
    2. Only then check classes: `APIConnectionTimeoutError` or the ceiling abort → `AnalyzerTimeoutError`, never a fallback.
  - The semaphore and limiter slot are released in `finally` on every path, including the ceiling abort (the leak class `ollama.ts:966-987` documents).
- **Unreachable errors.** `AnalyzerUnreachableError` replaces `LocalUnreachableError` as `FallbackAnalyzer`'s trigger (`index.ts:257-405`). The Ollama transport's classification is unchanged. Endpoints do not inherit "abort before first byte", because their pre-first-byte abort is the ceiling.
- **Engine value.** `AnalysisEngine` becomes `'local' | 'gemini' | 'openai'`, updated in:
  - the settings enum and `openapi.yaml` (regenerating `src/lib/api-types.ts`);
  - `AnalyzerSelection`, `ModelOption.engine` and persona generation's engine setting;
  - `getResolvedAnalysisEngine` (`user-settings.ts:781-783`, which must accept `openai`);
  - both run snapshots (`analysis-state.ts:52`, `active-analyses.ts:47`).
- **Classifying `'local'` branches.** A planning task lists every `'local'` engine comparison (TTS uses excluded) and classifies each as "Ollama-specific" (stays on the engine) or "shares the GPU" (reads decision 4's `gpu`). The plan carries that list as a table.

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
- **Label and help.** `dropped` feeds the label ("schema (partial)") and a debug log line listing keywords, never values. Help text says a provider that silently ignores a field cannot be detected, and that some servers reject `json` mode (for example LM Studio); the Test action shows which.
- **Settings.**
  - `analyzer.ollama.structuredOutput` (default `schema`) and `analyzer.gemini.structuredOutput` (default `json`) are enum registry knobs, each with a Settings row, `.env.example` line and `config:sync`.
  - Each endpoint carries its own field (default `schema`).
  - Gemini's default flips to `schema` only after the on-box row records attribution quality, not just conformance.
- **The Test action** (`POST /api/analyzer/models/test`, body `{ modelId }`).
  - **Requests.** It sends one tiny request per structured-output mode (a two-field schema) and per reasoning level. Every call goes through the model's limiter.
  - **Quota warning.** Before a Gemini test, the UI states how many requests it uses.
  - **Record.** It writes `analyzerCapabilitiesByModel[modelId] = { structuredOutput: { schema, json, off }, reasoning: { off, low, medium, high }, testedAt }`. Each entry is `supported`, or `rejected` with the status and a redacted excerpt.
  - **Pre-run check.** Before a run's first call, a configured mode or level recorded as `rejected` refuses the run, naming the setting and the test date.
- **Failure codes** in `server/src/routes/failure-taxonomy.ts`:
  - `analyzer-request-rejected`: a 400 from the provider. It carries the redacted provider error and names the structured-output, reasoning, custom-payload and context-size settings for that engine or endpoint, plus "Test this model".
  - `analyzer-invalid-output`: validation failed after retry, with a mode-aware hint.
  - `analyzer-timeout`: decision 1c.
  - `analyzer-reasoning-overflow`: decision 7.
  - `analyzer-endpoint-missing`: §3.
  - 401/403 map to the existing `auth` code, naming the engine or endpoint key.
- **`<think>` strip.** `parseAndValidate` strips a leading `<think>…</think>` block before its existing candidates, following the regex precedent at `voice-style.ts:148-152`.

### 3. Endpoints, model ids and catalogs

- **Storage.** `analyzerEndpoints: Array<{ id, name, baseUrl, gpu, unloadUrl?, concurrency, requestCeilingMs, structuredOutput, reasoning, maxOutputTokens, contextTokens, maxInputTokensPerRequest?, extraParams? }>` lives in user settings. `contextTokens` is required.
- **Context size (decision 3b).**
  - **Prefill:** the add-endpoint form fills `contextTokens` from `/v1/models` when the server reports a context field.
  - **Detect:** reads llama.cpp `GET /props` only when clicked.
  - **Otherwise:** the user enters the value, and the form refuses to save without it.
- **API keys (decision 3c).**
  - **Storage:** keys are stored separately per endpoint id as `{ origin, key }`, written only through a dedicated endpoint, never returned by the settings GET, and stripped from the general PUT, following the Gemini key precedent (`user-settings.ts:211-219`).
  - **Origin check:** every call, catalog listing and Test compares `new URL(baseUrl).origin` with the stored origin. On mismatch no request is sent, and the call fails as `auth` ("re-enter the key for <endpoint name>").
  - **Host change:** the Settings form prompts for the key when the host changes.
  - **Unload URL:** saving refuses one whose origin differs from the base URL's.
- **Deleting an endpoint.** Blocked while any saved setting references its ids (default model, phase knobs from #3141, persona engine); the error lists the references.
  - References from env (`ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL`, `select-analyzer.ts:71-77`; `PERSONA_GEN_ENGINE`, `registry.ts:1182`) and #3141's per-run phase pick cannot be blocked at save.
  - For those, a pre-run check fails the run as `analyzer-endpoint-missing` before its first call, naming the id and where it came from.
- **Id grammar.**
  - `openai:<endpointId>::<model>`.
  - Inference, in order: matches `^openai:[a-z0-9-]+::` → `openai`; contains `:` → `local`; else → `gemini`.
  - An Ollama tag such as `openai:latest` cannot match, because it has no `::`.
  - One shared test table drives both `engineForModelId` (frontend) and `inferEngineFromModelId` (server).
  - These `:` sites apply the same inference, so an `openai:` id never reaches Ollama:
    - `getResolvedOllamaModel` (`user-settings.ts:766-771`), and through it persona generation's local model (`voice-style.ts:67-70`);
    - `model-vram-stats.ts:34,179`, `analyzer-eval-stats.ts:55` and `models-inventory.ts:132`.
- **Catalogs.** `GET /api/analyzer/models` returns grouped catalogs with a short server-side cache and an explicit refresh:
  - **Ollama:** `/api/tags`.
  - **Gemini:** `models.list()` (`genai.d.ts:11032`), filtered to `supportedActions` containing `generateContent` and to text-output models, only when a key is set.
  - **Each endpoint:** `/v1/models` via the SDK, plus free-text entry.
  - Each entry carries the model's context and output limits when known, plus its Test record.
  - Curated entries (`MODEL_OPTIONS`, `src/lib/models.ts:19-95`) overlay labels and hints, extending `buildLocalModelOptions(liveTags, curated)` (`models.ts:156`).
  - A failed listing falls back to the curated list for that group. Endpoints stay listed from saved settings with free-text entry.
- **Labels.** `modelLabel(id)` (curated label → live `displayName` → model part of the id, prefixed with the endpoint name) replaces the ~9 `MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id` sites.
- **Contract and mocks.** Every new settings field, the catalog response, endpoint CRUD, the per-endpoint key write, the Test action, `analyzerCapabilitiesByModel`, `analyzerRateLimitsByModel` and `analyzerExtraParamsByEngine` get:
  - an `openapi.yaml` schema, with `src/lib/api-types.ts` regenerated;
  - a mock-mode counterpart in `src/lib/api.ts`, because the E2E runs in mock mode.

### 4. GPU coordination and fallback

- **Endpoint `gpu`.** Values are `none`, `any` or a device key in the `${kind}:${index}` form that `capacity-retry.ts:274-275` uses. The picker lists devices from the existing capacity probe.
- **Forward guard.** `use-local-analyzer-guard.tsx:78-81` resolves the selected id to its engine or endpoint from **saved settings**.
  - It treats `local` as today.
  - It treats an endpoint whose `gpu` is `any` or matches the TTS target device as sharing the card.
  - An endpoint id missing from settings is treated as `any`, so the guard fails closed.
- **Reverse guard.** The `activeStream` snapshot gains `gpu`, captured at stream start alongside `engine` (`use-reverse-local-analyzer-guard.tsx:34-36`), so the guard keys on what is actually running.
- **Eviction.**
  - **Trigger:** at `capacity-retry.ts:278` and `server/src/tts/sidecar.ts:432`, under the same `!isAnalysisInFlight()` gate as Ollama.
  - **Action:** for each endpoint with an `unloadUrl` whose `gpu` is `any` or equals `noCap.deviceKey`, it POSTs that URL best-effort, alongside `evictOllama`.
  - **No VRAM figure:** `analyzerEvictWouldHelp` reads Ollama's own VRAM, which endpoints lack, so endpoint eviction is attempted whenever an endpoint matches.
  - **No unload URL:** admission queues, and the failure message names the endpoint's unload-URL setting.
  - **During a run:** the forward and reverse guard prompts are the protection, as they are for Ollama today.
- **Fallback.** `FallbackAnalyzer` wraps an endpoint exactly as it wraps `local`: fallback to Gemini only on `AnalyzerUnreachableError`, only with a key and `allowCloudFallback` on, announced through `onFallback`.

### 5. Rate limits and concurrency

- **Limiter.** `GeminiRateLimiter` (`rate-limit.ts:158`) becomes the analyzer limiter, keyed by full model id, and is used by the Gemini and OpenAI transports, the Test action and persona generation (today `voice-style.ts:213`).
- **Limit resolution.** For Gemini ids: env → `analyzerRateLimitsByModel` (a user-settings map, following `analyzerKeepAliveByModel`, `user-settings.ts:253`) → `BUILTIN_LIMITS` → Gemini default. For endpoint ids: `analyzerRateLimitsByModel` → unlimited.
- **Migrating the Gemma knobs.** The six `rate.*.gemma*` knobs wired by #3139 migrate into the map and are removed.
  - The **#3146 guard's `rate.*` dynamic-reader entry and `KNOWN_UNREAD` handling are updated in the same change**.
  - Because the map is not a registry knob, that guard cannot see it, so a paired limiter test asserts that the map is read.
  - The computed env read at `rate-limit.ts:80-82` stays a documented blind spot (`direct-env-reader-guard.test.ts:57-67`), covered by its existing tests.
- **Settings editor.** Settings gains a per-model limits editor listing catalog models.
- **Concurrency.** Per-endpoint concurrency gates calls with the same count-semaphore mechanism as `acquireAnalyzerSlot` (`server/src/analyzer/analyzer-concurrency.ts:60`), one semaphore per endpoint.

### 6. Capacity model

`EngineCapacity { family: 'context' | 'requestCap', contextTokens, maxOutputTokens, perRequestInputCap? }`, resolved per model:

- **Ollama.**
  - `family: 'context'`.
  - `contextTokens` is the `num_ctx` sent (`ollama.ts:275`), capped at `/api/show`'s native context length.
  - Large local windows are enabled by raising `analyzer.ollama.numCtx`, which remains the VRAM-bearing choice.
- **Gemini.**
  - `family: 'requestCap'`.
  - `contextTokens` / `maxOutputTokens` come from the cached `models.list()` `inputTokenLimit` / `outputTokenLimit`. On a cache miss with a failed listing, they fall back to today's values (12000 cap, 8192 output).
  - `perRequestInputCap` = min(`analyzer.gemini.maxInputTokensPerRequest` (default 12000, unchanged), the model's TPM limit).
- **Endpoints.**
  - `family: 'context'`.
  - `contextTokens` is the required endpoint field (decision 3b).
  - `perRequestInputCap` = min(the endpoint's `maxInputTokensPerRequest`, its TPM limit), each only if set.
  - When a cap is set, the context-family budget is further limited by `cloudBodyCharBudget` at that cap.
- **Budget formulas are today's, selected by family.**
  - **Context family:** `analyzer.stage{1,2}.localInputFraction` × `contextTokens` at 2 chars/token, no reservation (`stage1-chunk.ts:119-124`). The two fraction knobs keep their keys and defaults and apply to every context-family capacity; their help text says so.
  - **Request-cap family:** `cloudBodyCharBudget` with `charsPerTokenForText` and the existing reservations (`STAGE1_CLOUD_RESERVED_TOKENS`, `OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS`, roster chars).
- **Ceilings stay per pass, as today.** Stage 1 is capped by `analyzer.stage1.chunkCharBudget` (24000), stage 2 by `analyzer.stage2.chunkCharBudget` (9000), and cloud chapter-level passes by `analyzer.gemini.outputHeavyChunkChars` (32000). Context-family chapter-level passes keep using stage 1's budget (`chapter-chunker.ts:136`).
- **Endpoint chunk overrides.** Endpoints have no per-endpoint chunk-size field. The per-pass ceilings above apply to them.
- **Resolver signatures.** `resolveStage1ChunkCharBudget`, `resolveStage2ChunkCharBudget` and `chapterChunkBudget` take a capacity descriptor instead of an engine name.
- **Pinning test.** For `qwen3.5:4b` at `num_ctx` 32768 and `gemini-3.5-flash-lite` at the 12000 cap, resolved budgets for every resolver and representative Latin, Cyrillic and CJK chapters equal today's values exactly. The expected values are captured from `main` before the change, not computed by hand.

### 7. Max output tokens

- **Settings.**
  - **Gemini:** `analyzer.gemini.maxOutputTokens` keeps its key and env (`ANALYZER_MAX_OUTPUT_TOKENS`). Its minimum becomes 0 (`0` = Auto), its maximum is lifted, and its default becomes `0`. An explicit env or override value keeps its meaning.
  - **Ollama:** `analyzer.ollama.numPredict` is unchanged; −1 is already Ollama's Auto, because the context governs.
  - **Endpoints:** each endpoint's `maxOutputTokens` accepts `0` (Auto, default) or an integer.
  - **Clamp:** a manual value is clamped to the model's output limit when known.
- **Auto.**
  - **Gemini:** the model's `outputTokenLimit`, or 8192 when the listing is unavailable.
  - **Endpoints:** min(the catalog limit if known, `contextTokens` − estimated input). Endpoints send `max_tokens`.
  - **Payload override:** a custom payload that sets or removes `max_tokens` / `max_completion_tokens` disables Auto for that endpoint, shown in the label. OpenAI reasoning models need `max_completion_tokens`, and help text says so.
- **Truncation.**
  - A `length` finish with answer text raises `AnalyzerTruncatedError`, which splits the chunk as today (`ollama.ts:838`, `gemini.ts:801,816`).
  - A `length` finish with **empty answer text**, after any `<think>` strip, raises `AnalyzerReasoningOverflowError`. It maps to `analyzer-reasoning-overflow`, names that engine or endpoint's reasoning and max-output settings, and never splits. This replaces today's empty-`MAX_TOKENS` path (`gemini.ts:801-802`).
- **Default changes before measurement.** Gemini Auto **raises the default cap from 8192 to the model limit**. This, and the reasoning-overflow rule, are the only default behaviour changes this design makes before measurement. They only affect calls that were being truncated today, and they are covered by an on-box row.

### 8. Reasoning

- **Settings.** `analyzer.ollama.reasoning` and `analyzer.gemini.reasoning`, plus each endpoint's field: `model-default` / `off` / `low` / `medium` / `high`.
- **Ollama.** `model-default` omits `think`; `off` sends `think: false`; `low` / `medium` / `high` send `think: "low" | "medium" | "high"`.
- **Gemini.** The SDK's thinking configuration (`config.thinkingConfig`). `model-default` omits it. The field names per model family are verified during planning.
- **Endpoints.** `model-default` omits `reasoning_effort`; `off` sends `reasoning_effort: "none"`; `low` / `medium` / `high` send that value. Help text names llama.cpp's `chat_template_kwargs.enable_thinking`, reachable through the custom payload, for servers that ignore `reasoning_effort`.
- **Support.** Recorded per model by the Test action (decision 2b). A level recorded as rejected refuses the run before it starts.

### 9. Custom payload

- **Storage.** Stored per engine (`analyzerExtraParamsByEngine.ollama` / `.gemini`) and per endpoint (`extraParams`), edited in Advanced Settings' analyzer section, validated on save as a JSON object.
- **Merge.**
  - **Order:** merged last into the native request.
  - **Scope:** top-level keys replace. The transport's owned container is merged key by key: Ollama `options`, Gemini `config`.
  - **Removal:** `null` removes a key.
- **Protected keys,** refused at save:
  - Endpoints: `model`, `messages`, `stream`, `stream_options`, `n`, `tools`, `tool_choice`, `response_format`, `reasoning_effort`, `grammar`, `json_schema`.
  - Ollama: `model`, `messages`, `stream`, `format`, `think`, `keep_alive`, `options.num_ctx`, `options.num_gpu`.
  - Gemini `config`: `systemInstruction`, `abortSignal`, `responseMimeType`, `responseJsonSchema`, `responseSchema`, `thinkingConfig`.
- **Unprotected output keys.** Endpoint `max_tokens` / `max_completion_tokens`, Ollama `options.num_predict` and Gemini `config.maxOutputTokens` are allowed. Setting or removing one disables Auto for that engine or endpoint, and the run label shows it.
- **Privacy.**
  - **Label:** shows "+ custom params".
  - **Logs and files:** the payload is excluded from logs and persisted analyzer files.
  - **Upstream errors:** before logging or display, the payload's string values are redacted from upstream error text (`ollama.ts:712-715`, `gemini.ts:853-860`, the failure detail at `failure-taxonomy.ts:410-427`).

### 10. Persona generation

- **Engine setting.** `analyzer.personaGeneration.engine` becomes a model-id-style selection: `local` / `gemini` / any `openai:<endpointId>::<model>`.
- **Transport.** `generatePersonaViaOllama` and the Gemini persona call become transport calls through the runner's free-text path (no structured output), with the limiter, reasoning setting and custom payload applied.
- **Unchanged.** The "no silent cross-provider fallback" rule in its help text (`registry.ts:1185`) is unchanged.

## Data flow (one analyzer call)

1. **Selection.** The route resolves engine/endpoint + model (per-run phase pick from #3141), capacity, and that engine/endpoint's settings. Pre-run checks run next: endpoint exists, key origin matches, Test record does not mark the configured mode or level rejected.
2. **Chunking.** The chunker sizes the chapter from capacity, using the family's formula and the pass's ceiling.
3. **Request.** The runner builds messages and the adapted structured-output request.
4. **Send.** The transport acquires limiter and concurrency, merges the custom payload last, sends through its HTTP client within the ceiling, streams, and normalises `finish`.
5. **Parse.** The runner strips `<think>`, repairs, validates and retries under the transport's retry policy.
6. **Outcome.**
   - `length` with answer text splits and retries; `length` with none fails as reasoning overflow.
   - An unreachable failure falls back under the gate.
   - Everything else maps to a failure-taxonomy code.

## Error handling summary

| Condition | Behaviour |
|---|---|
| Unreachable (1c classification) | `AnalyzerUnreachableError` → Gemini fallback if gated on, else a hard fail naming the endpoint |
| Timeout after connecting, or the ceiling | `analyzer-timeout`, never a fallback |
| 401/403, or key origin mismatch | `auth`, naming the engine/endpoint key |
| Any 400 | `analyzer-request-rejected` with the redacted provider error and the request-shaping settings named; no retry-without |
| Configured mode/level recorded as rejected by Test | Run refused before its first call |
| Endpoint id missing (env or per-run pick) | `analyzer-endpoint-missing` before the first call |
| 429 / 5xx / idle stream | Shared retry helper; limiter records rejections |
| `length` finish with answer text | `AnalyzerTruncatedError` → chunk split |
| `length` finish with no answer text | `analyzer-reasoning-overflow`, no split |
| Validation fails after retry | `analyzer-invalid-output`, mode-aware hint |
| Invalid payload / protected key / endpoint still referenced by settings / unload URL off-origin / missing context size | Refused at save (400) |

## Testing

- **Characterisation before wave 1.** Pin each runner difference listed in §1, including a new `gemini.test.ts` assertion on the retry request's replayed turn and temperature.
- **Transport contract suite.** It runs against all three transports over a **real `http.createServer` and a real undici `Agent`**, following `server/src/analyzer/ollama-timeout.test.ts:61,112-114`. A stubbed `fetch` would bypass the dispatcher and could not fail. Cases:
  - streamed text and `finish` mapping;
  - abort;
  - a refused port and an unroutable host (→ unreachable) versus a post-connect stall (→ timeout);
  - a **long silent prefill** that must not time out before the ceiling;
  - a **header-then-silence** server that the ceiling ends, with the semaphore released afterwards;
  - `reasoning_content` deltas keeping the idle watchdog alive.
- **Runner.** Existing `ollama.test.ts` / `gemini.test.ts` stage behaviours move to runner tests without weakening assertions. Also covered:
  - the `<think>` strip;
  - reasoning-overflow versus truncation;
  - a 400 producing `analyzer-request-rejected` with no second request;
  - pre-run refusal from a Test record;
  - the persona free-text path.
- **Pure functions.**
  - Schema adapters, including a snapshot of `dropped` for every stage schema per provider.
  - The id-grammar table, run against every listed `:` site.
  - Catalog merge and fallback; limiter resolution order, including the map-read test.
  - Capacity and budgets, with the pinning test captured from `main`; Auto output tokens.
  - Reasoning mapping; payload merge, protected keys and error-text redaction; key-origin matching.
- **Routes.**
  - `GET /api/analyzer/models` and the Test action.
  - Endpoint CRUD, including the delete-while-referenced refusal, the missing-context refusal and the off-origin unload URL refusal.
  - The per-endpoint key write and settings validation.
- **E2E (Playwright, mock mode).**
  - Add an endpoint (context size required), pick its model in the picker; the run label shows mode and "+ custom params".
  - The GPU guard prompts for an endpoint on the TTS card and not for one on another card.
  - Editing the host prompts for the key.
- **Mutation proofs** for each resolver, adapter, classifier and guard, per repo practice.

## On-box acceptance owed (register rows)

- **Live structured output:** the Test action, plus a real chapter in `schema` mode, on `gemma-*`, `gemini-*` and a llama-swap endpoint. Record what the Gemini adapter drops, whether output conforms, and Gemini `schema` attribution quality against `json`. This row gates Gemini's `schema` default.
- **Thinking-model output:** `gemini-3.6-flash` on a 20,000-character chapter with Auto output. Record truncation, reasoning-overflow and request counts against the 8192 baseline.
- **Long silent prefill:** a llama-swap endpoint on the slower card with a 64k+ prompt completes within the default ceiling, without timeout or fallback.
- **Same-card eviction:** a llama-swap endpoint with `gpu` set to one card and an unload URL.
  - With the analyzer idle, a Qwen TTS load on that card evicts it instead of failing with out-of-memory.
  - A TTS load on the other card does not evict it.
  - During a run, the guard prompts.
- **Capacity recalibration:** a large-context local model on a 16 GB card, comparing chunk counts, truncation rate and attribution quality against today's defaults, before any capacity default changes.

## Sequencing

Each wave is its own plan section. A wave may land as several PRs; nothing is offered in a picker before its wave's last PR.

- **Wave 0 (in the queue):** #3139, #3141.
- **Wave 1:** characterisation tests, then the shared runner + Ollama/Gemini transports + typed `AnalyzerHttpError` + `<think>` strip. Behaviour-preserving apart from the strip.
- **Wave 2:** capacity model + max output tokens (Gemini Auto) + the reasoning-overflow rule, on today's engines, with the pinning test (decisions 6, 7).
- **Wave 3:** OpenAI transport, endpoints (required context size, key origin binding, card picker), id grammar and every `:` site, catalogs, structured output with adapters, the Test action, GPU guards and eviction, fallback, limits and concurrency (decisions 1b, 1c, 2, 2b, 3, 3b, 3c, 4, 5). **Endpoints become selectable for analysis in this wave's last PR.**
- **Wave 4:** persona generation (decision 10).
- **Wave 5:** reasoning setting + custom payload (decisions 8, 9).
- **After measurement:** Gemini `schema` default; any capacity default change.

## Verifications owed during planning (facts, not decisions)

- **Ollama.**
  - Its model-name grammar cannot contain `::`.
  - Whether `think: "low" | "medium" | "high"` is accepted, coerced or rejected by non-gpt-oss models.
  - The `/api/show` context-length field for the models in `MODEL_OPTIONS`.
- **`@google/genai` 2.19.**
  - `thinkingConfig` fields per model family.
  - Whether Gemini returns 400 on, or silently ignores, unsupported `responseJsonSchema` keywords.
  - Which `models.list()` fields identify text-output models.
- **`openai` 7.x with `server/node_modules/undici` 8.x (peer range `>=5 <9`).**
  - Streaming works with `fetch: undici.fetch` plus the dispatcher.
  - The cause-chain shape for each unreachable code.
- **llama.cpp / llama-swap.** Whether response headers are sent before prefill completes, which decides whether the ceiling alone bounds the silent phase.
- **OpenAI-compatible servers.**
  - The `/v1/models` context fields reported by vLLM, OpenRouter, LM Studio and llama-swap.
  - Whether `reasoning_effort: "none"` is accepted by llama.cpp and vLLM.
- **`'local'` comparisons.** Every `'local'` engine comparison is classified (§1).
