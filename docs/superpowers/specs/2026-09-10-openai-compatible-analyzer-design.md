---
status: draft
issue: 3084
date: 2026-09-10
---

# OpenAI-compatible analyzer endpoints, and request controls for every analyzer engine

**Issue:** #3084 (reporter feature request). **Prerequisite bugs found during this design:** #3139, #3141.
**Decisions:** made one area at a time with the repo owner on 2026-09-10, then revised three times, each after an adversarial assumption check:
- in-session, 2026-09-10;
- by an independent reviewer, 2026-09-11;
- by a third independent reviewer, 2026-09-11.

It was then corrected with facts verified while writing the implementation plan (2026-09-11; see "Verified during planning"). No decision changed.

Each decision is recorded with its rationale.

## Problem

The #3084 reporter asks for five things: (1) an OpenAI-compatible endpoint (base URL, API key, model) for script generation, (2) chunk-size control, (3) max-tokens control, (4) reasoning-effort control, and (5) a custom JSON payload merged into the request. Their setup is Windows 10 with 2× GTX 1060 6 GB and a GTX 1050 Ti 4 GB, on v1.14.0.

**The reporter's stall.** A Gemini chapter "buffered" for 30 minutes. Their follow-up on #3084 (2026-09-10) adds:
- the model was `gemini-3.6-flash`, a thinking model with built-in limits of 5 RPM / 20 RPD (`server/src/analyzer/rate-limit.ts:42`);
- the chapter was 20,000 characters;
- no settings were changed;
- it reproduces: the run buffers "on detected characters indefinitely".

The attached `server.log` shows no analysis request at all: no `[analysis]` milestone and no `[gemini] stream idle` retry line (`gemini.ts:590`). The screenshot shows the view still Idle with **Start analysis** visible, while phase 0 renders a spinner and a "streaming" chip, because `derivePhaseState` marks phase 0 active before any start (`src/lib/analysis-phase-state.ts:46`). That UI defect is handed off as its own bug, separately from this design.

What the code does today:

- **Exactly two analyzer engines, hard-coded as a pair.**
  - `local` goes to Ollama's native `/api/chat` (`server/src/analyzer/ollama.ts:693`).
  - `gemini` goes through `@google/genai` (`server/src/analyzer/gemini.ts:725`).
  - The union `'local' | 'gemini'` is spelled out literally in dozens of places, some of them TTS uses of the same words. It is fixed in:
    - `analysisEngine`'s enum (`openapi.yaml:4628`, `:4831`; `server/src/workspace/user-settings.ts:98`);
    - `ModelOption.engine` (`src/lib/models.ts:16`);
    - run snapshots (`server/src/store/analysis-state.ts:52`, `server/src/workspace/active-analyses.ts:47`);
    - `getResolvedAnalysisEngine`, which coerces anything that isn't `gemini` to `local` (`user-settings.ts:975-977`);
    - persona generation's engine enum (`server/src/config/registry.ts:1181-1191`).
- **Two separate stage runners.** `OllamaAnalyzer` and `GeminiAnalyzer` each implement prompt building, `parseAndValidate` and a validation retry (`ollama.ts` ~470-614; `gemini.ts:441-521`). They differ in their retry policy:
  - **On invalid JSON:** Ollama drops the assistant turn and raises the temperature (`ollama.ts:559-571`). Gemini replays the model turn at the same temperature (`gemini.ts:484-493`).
  - **Forensics:** Ollama writes `rawAttemptPath` files (`ollama.ts:539`, `:593`); Gemini does not.
  - **Escalation:** Gemini returns `null` for every error except an abort, `DailyQuotaExhaustedError` included (`gemini.ts:403-439`); Ollama rethrows abort and unreachable errors (`ollama.ts:455-456`).

  Persona generation adds two more direct LLM calls: `generatePersonaViaOllama` (`ollama.ts:938`) and a Gemini `generateContent` call (`server/src/analyzer/voice-style.ts:197-219`).
- **The engine is inferred from the model id's shape.** `:` means Ollama; anything else means Gemini.
  - **Explicit inference:** duplicated on the server (`server/src/analyzer/index.ts:195`) and the frontend (`src/lib/models.ts:108`, used at `:120`, `:127`).
  - **Implicit reuses:**
    - `getResolvedOllamaModel` (`user-settings.ts:960-965`), which persona generation inherits (`voice-style.ts:67-70`);
    - `ollama-health.ts:199,205,218`;
    - `setup-diagnosis.ts:300,302`;
    - `model-vram-stats.ts:34,179`;
    - `analyzer-eval-stats.ts:55`;
    - `models-inventory.ts:132`.
- **Structured output differs by engine.**
  - **Ollama** sends the per-stage Zod schema as `format` (`ollama.ts:504`, `:643`).
  - **Gemini** sends only `responseMimeType: 'application/json'` (`gemini.ts:729`); its runner ignores the grammar schema (`_grammarSchema`, `gemini.ts:446`).
  - **Unsupported keywords:** the generated schemas contain `$schema`, `minLength` and `exclusiveMinimum`, none of which are in Gemini's supported `responseJsonSchema` subset (`server/node_modules/@google/genai/dist/genai.d.ts:5651-5666`).
  - **Parsing:** `parseAndValidate` (`gemini.ts:1006-1053`) strips code fences and trailing prose. A leading `<think>` block defeats it, because `trimTrailingProse` slices from index 0 (`gemini.ts:1220-1255`).
- **HTTP errors carry no structure.** A non-OK Ollama response is thrown as a plain `Error` with the status only in its message text (`ollama.ts:713-715`). The taxonomy maps a typed 5xx to `analyzer-unreachable` (`failure-taxonomy.ts:562-563`), and the plan-29 rule says reachable-but-misbehaving must not read as unreachable (`index.ts:251-256`).
- **Long local calls need a special HTTP client.** Ollama sends no response headers until the first generated token.
  - **Dispatcher:** `ANALYZER_DISPATCHER` (`ollama.ts:120-133`) disables undici's header and body timeouts. It keeps a 10 s connect timeout so a down daemon still fails fast into the fallback path.
  - **"Unreachable":** `UNREACHABLE_CODES` (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `UND_ERR_SOCKET`; `ollama.ts:147-153`), a bare `fetch failed`, or an abort before the first byte (`ollama.ts:1043-1060`).
- **Gemini's stream watchdog runs before the first chunk.** `STREAM_IDLE_TIMEOUT_MS = 45_000` (`gemini.ts:60`) is armed before the stream call (`gemini.ts:724`). An idle stream is retried within `MAX_TOTAL_MS` 90 s (`gemini.ts:541-542`), and each retry re-acquires the rate limiter.
- **Chunk budgets branch on the engine name.** Every resolver treats anything that isn't `local` as Gemini cloud.
  - **Local:** `resolveStage1ChunkCharBudget` and `resolveStage2ChunkCharBudget` derive from Ollama `num_ctx` × `analyzer.stage{1,2}.localInputFraction` (0.7 / 0.3) at a fixed 2 chars/token, with no reservation (`server/src/analyzer/stage1-chunk.ts:96-126`, `stage2-chunk.ts:59-82`). Local chapter-level passes reuse stage 1's budget (`server/src/analyzer/chapter-chunker.ts:136`).
  - **Cloud:** bodies are sized by `cloudBodyCharBudget` from `analyzer.gemini.maxInputTokensPerRequest` (default 12000; `server/src/analyzer/token-budget.ts:30-51`), using `charsPerTokenForText` (`token-budget.ts:10-28`) and fixed token reservations.
  - **Ceilings:** `analyzer.stage1.chunkCharBudget` 24000, `analyzer.stage2.chunkCharBudget` 9000 and `analyzer.gemini.outputHeavyChunkChars` 32000 (`registry.ts:83-131`).
- **Output caps are static per engine.**
  - **Ollama:** `num_predict` defaults to −1, unlimited (`registry.ts:41-47`).
  - **Gemini:** `maxOutputTokens` (`ANALYZER_MAX_OUTPUT_TOKENS`) defaults to 8192, within min 256 / max 32768 (`registry.ts:51-58`). On Gemini thinking models, thinking tokens count against that cap.
  - **Empty output at the cap:** an empty `MAX_TOKENS` response becomes `AnalyzerTruncatedError`, deliberately, as a size problem that splitting recovers, observed on `gemma-4-31b-it` (`gemini.ts:784-804`). Splitting goes up to depth 3 (`stage1-chunk.ts:156`, `stage2-chunk.ts:341`), and does not shrink reasoning.
- **Reasoning is controlled only on Ollama** (`think: false`, `ollama.ts:651`). **No custom request payload exists.**
- **GPU coordination keys on Ollama.**
  - **Forward guard:** reads `ui.selectedModel` (`src/hooks/use-local-analyzer-guard.tsx:64`, `:78`).
  - **Reverse guard:** reads `analysis.activeStream.engine`, captured when the stream starts (`src/hooks/use-reverse-local-analyzer-guard.tsx:34-36`).
  - **TTS capacity eviction:**
    - It is keyed by device (`${kind}:${index}`) and gated on Ollama's VRAM figure (`server/src/gpu/capacity-retry.ts:270-281`).
    - It is skipped while `isAnalysisInFlight()`, which counts only `acquireAnalyzerSlot` holders (`server/src/tts/sidecar.ts:193-194`, `analyzer-concurrency.ts:60-72`), and only Ollama acquires those (`ollama.ts:688`, `:979`).

Two defects in this area were split out as prerequisites and are queued as Open Engine chains:

- **#3139** — Advanced Settings rate-limit overrides are stored and shown, but `resolveLimits` (`rate-limit.ts:76-84`) reads only `process.env`. Children: #3147 → #3146 (adds `registry-knob-read.guard.test.ts`) → #3145.
- **#3141** — five analyzer-model overrides are never read. The analysing view's phase swap writes account settings, and falsely claims to apply "from the next chapter". Children: #3158 → #3157 → #3156 → #3155 → #3154 → #3153 → #3152, with rework #3167 and re-verify #3168.

## Goals

- Any number of **named OpenAI Chat Completions-compatible endpoints**: llama.cpp / llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter and similar, usable side by side, including across analysis phases.
- Structured output, model catalogs, rate limits, chunk sizing, output caps, reasoning and custom parameters behave **consistently across Ollama, Gemini and every endpoint**, through **one stage runner**.
- Persona generation can use any engine or endpoint the analyzer can.
- Every behaviour that changes what the model receives is **explicit in Settings, with its impact stated**. Nothing is downgraded, and no label claims more than was observed.
- An endpoint is never offered for analysis before its sizing, GPU coordination and concurrency exist.

## Non-goals

- Bundling or managing llama.cpp or any other server. Serving is left to whatever tool the user runs.
- A true mid-run model swap for a live job (#3141 settled this as a pre-run pick).
- OpenAI `strict: true` structured outputs: `server/src/handoff/schemas.ts` relies on optional, nullable and union constructs.
- Learning rate limits from response headers.
- Environment-variable overrides for OpenAI-compatible endpoint settings. Endpoints are configured in Settings only.
- Unifying the two runners' retry policies or the two budget formula families. Both stay as they are today until measured.
- The analysing view's idle-state rendering bug (handed off separately).

## Decisions

| # | Area | Decision | Why |
|---|---|---|---|
| 1 | Stage runner & transports | **One stage runner** for every engine (prompt, schema, parse, validation retry, persistence, payload merge, reasoning mapping). Each engine is a **transport**: `OllamaTransport` (today's `chat()`), `GeminiTransport` (from `generateWithLimiter`/`generate`), `OpenAITransport`. Today's per-engine retry differences are kept as a **per-transport retry policy**, and each current failure-taxonomy outcome is kept. Both are pinned by characterisation tests written before extraction. | Every cross-engine rule is written and tested once, without changing either engine's behaviour. |
| 1b | Transport library | The **official `openai` npm SDK** (7.x, zero runtime dependencies), using undici's own `fetch`. | Offloads protocol code, mirroring the `@google/genai` precedent. |
| 1c | Long calls, aborts & fallback | **Client:** the SDK gets `fetch: undici.fetch` plus a long-call dispatcher from the same undici package (no header/body timeout, 10 s connect timeout), with SDK retries off. **Ceiling:** a per-endpoint absolute ceiling (default 30 min) is our own timer, started after limiter and semaphore acquisition. **Idle watchdog:** arms after the first delta. **Abort detection:** the SDK ends a stream **silently** on abort, so the transport never trusts a clean loop end; it checks its own signals. **Classification, in order:** (1) caller aborted → `AnalysisAbortedError`; (2) unreachable codes before response headers → unreachable, may fall back; (3) ceiling fired or `APIConnectionTimeoutError` → timeout; (4) a stream that ended without `finish_reason` → incomplete, retried like an idle stream. | Node's global fetch rejects an npm-undici `Agent`. The SDK's `timeout` stops at headers for streams, and its streaming iterator returns without throwing on abort (`openai` `core/streaming.ts:171-186`). |
| 2 | Structured output | Per engine/endpoint setting `schema` / `json` / `off`. **Defaults:** Ollama `schema` (today), Gemini `json` (today) until on-box measurement, endpoints `schema`. Repair and retry stay on in every mode. A **per-provider schema adapter** rewrites the schema into the provider's supported subset and records what it dropped. **The label states only what was observed:** "schema (partial)" when constraints were dropped, "schema (not enforced)" when the Test action saw the schema ignored. Our validator still enforces the full schema on every response. | llama.cpp has ignored `response_format` while the model is thinking and still returned 200 (ggml-org/llama.cpp#20345). That issue was closed with a fix (#20223), but later reports say it recurs on Qwen3.6 and gpt-oss, and #27279 (schema output stopping mid-object) is open, so enforcement cannot be assumed per model. |
| 2b | Test action | **Test once, never guess.** A **Test** action per model (endpoint, Gemini or Ollama) records what the model accepts and enforces. **Requests:** a control request first, then the configured structured-output mode and reasoning level; a mode or level is `rejected` only if the control request succeeded. **Schema check:** uses the largest real stage schema plus one required marker key with a single-value enum that the prompt never mentions, so it records `enforced` / `ignored` / `rejected`. **Scope and cost:** "Test all modes and levels" is optional, with its request count shown. Every request goes through the limiter; a local test goes through the forward GPU guard. **Record lifetime:** records are invalidated when the endpoint's base URL (or Ollama URL) changes. **At run time:** a mode or level recorded `rejected` refuses the run before it starts. **A 400 never triggers a downgrade or retry-without:** it fails as `analyzer-request-rejected`, with the provider's error and the settings that shape the request named. | A 400 has many causes, and an ignored field returns 200. Only a controlled probe with a control request can attribute either. |
| 2c | Live validation | The Test action, plus a real chapter, on `gemma-*`, `gemini-*` and a llama-swap endpoint with thinking on and off, recorded before defaults ship. | Owner rule. |
| 3 | Endpoints & model ids | **Named endpoints list** in user settings. Model ids are `openai:<endpointId>::<model>`, with `endpointId` matching `[a-z0-9-]+`. Gemini and Ollama ids are unchanged. Every site that sniffs `:` or coerces the engine to two values is updated. **Live catalogs for every engine and endpoint** via a cached `GET /api/analyzer/models`, with curated overlay, static fallback, and one `modelLabel(id)` resolver. | A local server and a cloud gateway coexist; new free Gemini models appear with no code change. |
| 3b | Endpoint context size | **Required when adding an endpoint.** It is prefilled only from fields that report the **served** context (vLLM `max_model_len`; llama.cpp `/v1/models` `meta.n_ctx`, the per-slot context; `context_length` from OpenRouter, or from llama-swap when its config declares one), never llama.cpp's training context (`meta.n_ctx_train`) or a gateway's catalogue limit (LiteLLM `max_input_tokens`). An on-demand **Detect** button reads llama.cpp `/props` `default_generation_settings.n_ctx`, or llama-swap `/props?model=<id>` with a warning that it may load the model. Nothing probes the endpoint automatically. | Training context overstates what a small card serves, which seeds the overflow this field exists to prevent; llama-swap's `/props` needs a model and may load it. |
| 3c | Endpoint API keys | Each key is stored **bound to its base URL's origin** and sent only when the origin still matches; changing the host requires re-entering the key. The unload URL must share the base URL's origin and is sent with the same key. | The SDK sends the key as a Bearer token to whatever base URL is saved, and the app is served over the LAN. |
| 4 | GPU & fallback | **Card picker:** per endpoint, `none` / `any` / a detected device (`cuda:N`). The default is `any` for a `localhost` / `127.0.0.1` / `::1` host, else `none`. Guards and eviction act only when TTS targets the same card; `any` counts as every card. **Source:** the endpoint's `gpu` and optional unload URL come from saved settings, not the catalog. **Unload URL:** may contain `{model}`, for per-model unload such as llama-swap's `/api/models/unload/{model}`. **Eviction gate:** it counts endpoint calls in flight. **Fallback:** to Gemini only for "unreachable" (1c), under `allowCloudFallback`. | Eviction is per card, and both this box and the reporter's have several. An all-models unload on a shared llama-swap would evict another card's model. |
| 5 | Rate limits & concurrency | One model-keyed limiter for Gemini and every endpoint. Limits resolve **env (Gemini only, existing `GEMINI_{RPM,TPM,RPD}_<slug>`) → per-model Settings map → built-in table → engine default** (Gemini 5 rpm / 100k tpm / 50 rpd; endpoints unlimited). Per-endpoint concurrency (default 1). One shared retry helper; SDK retries off. | Live-listed models need editable limits without code. |
| 6 | Chunk sizing | **Capacity model for all engines, byte-identical today.** A capacity descriptor carries today's formula family: **context-governed** (Ollama's fraction × context at 2 chars/token) or **request-cap-governed** (Gemini's `cloudBodyCharBudget` with its reservations). Endpoints are context-governed, additionally capped by their optional max-input-per-request and TPM limit. Each pass keeps the resolver and ceiling it uses today. A pinning test locks today's budgets; defaults change only after on-box measurement. | Large-context local models make local defaults stale, but nothing changes before it is measured. |
| 7 | Max output tokens | **Setting:** per engine/endpoint, **Auto** or an integer; Auto is `0` in the existing integer knobs. **Gemini's default becomes Auto (model limit)**, and Gemini requests thought summaries so thinking streams as activity (§7); Ollama's −1 is already its Auto. **Clamp:** a manual value is clamped to the model's limit. **At the limit:** a `length` finish with answer text splits the chunk, as today. A `length` finish with no answer text **and evidence of reasoning** fails as `analyzer-reasoning-overflow` instead of splitting; without that evidence it splits, as today. | Thinking tokens count against Gemini's 8192 cap on the reporter's model, and splitting never shrinks reasoning. An empty non-thinking response (Gemma) is a size problem that splitting does fix. |
| 8 | Reasoning | **Levels per engine family and per endpoint control style,** so only choices that can take effect are offered. **Endpoint styles:** `reasoning_effort`, `enable_thinking` (llama.cpp `chat_template_kwargs`) or `not controllable`. **Gemini and Ollama:** levels follow the model family. **Defaults preserve today:** Ollama `off`, Gemini and endpoints `model default`. The Test action records what each model accepts. Every parse strips an inline `<think>` block. | Servers disagree: llama.cpp passes any `reasoning_effort` string to the chat template unvalidated (`none` turns thinking off), vLLM validates `none` to `max`, and some templates key only on `enable_thinking`. Gemini levels differ per model: 3.x cannot turn thinking off, 3.7/3.8 Flash reject `minimal`, Gemma 4 is on/off. Ollama returns 400 for `think` on a model that does not think. |
| 9 | Custom payload | Per engine/endpoint JSON object, **merged last** into the native request: top-level keys, plus the transport's owned containers (Ollama `options`, Gemini `config`, endpoint `chat_template_kwargs`) key by key; `null` removes a key but never an owned container. Keys the pipeline owns, or that change capacity, VRAM, parsing or reasoning control, are refused at save with a message naming them. A payload temperature sets the first attempt only; the transport's retry policy still applies on retry. The label shows "+ custom params". The payload is never logged, and its longer string values are redacted from upstream error text. | Provider-specific options (the reporter's `top_k`, `min_p`, `presence_penalty`) without letting a payload break parsing, capacity, the retry contract or the model. |
| 10 | Persona generation | Its engine choice becomes **any engine or endpoint**, running through the same transports, limiter, reasoning setting and custom payload. Structured output does not apply, because personas are free text. | A user with only an OpenAI-compatible endpoint can still design voices. |

## Design

### 1. Stage runner and transports

- **The transport contract.** `ChatTransport.send({ messages, system, structuredOutput, temperature, maxOutputTokens, reasoning, extraParams, signal, onChunk })` returns `{ text, reasoningSeen: boolean, finish: 'stop' | 'length' | 'blocked', usage? }`.
  - `usage` carries `reasoningTokens` when the provider reports it: Gemini `thoughtsTokenCount` (`genai.d.ts:5917`), OpenAI `completion_tokens_details.reasoning_tokens`.
  - Transports own the wire format, HTTP client, streaming, rate-limiter and concurrency acquisition, and the shared retry helper (429 with retry-after, daily-quota detection, 5xx, idle or incomplete stream; extracted from `gemini.ts:536-652`).
- **Typed HTTP errors.** Every non-OK HTTP response is thrown as `AnalyzerHttpError { status, bodyExcerpt }`, replacing the plain `Error` at `ollama.ts:713-715`. Wave 1 keeps every current taxonomy outcome. In particular, an Ollama 5xx does not become `analyzer-unreachable` (`failure-taxonomy.ts:562-563`; the plan-29 rule at `index.ts:251-256`). Characterisation tests pin the outcomes for Ollama 400, 404, 500 and 503 bodies.
- **What the runner owns.** The stage runner, generalised from the two existing runners, owns:
  - `writeInbox`, skill/system-instruction loading, schema generation and adaptation;
  - the first attempt, `parseAndValidate`, and the validation retry, run through the transport's **retry policy**:
    - **Ollama:** on invalid JSON, drop the assistant turn and raise the temperature (`ollama.ts:559-571`), and write `rawAttemptPath`.
    - **Gemini:** replay the model turn at the same temperature (`gemini.ts:484-493`).

    The retry's temperature is applied after the custom payload merge.
  - persistence (`persistResponse`, `rawAttemptPath`, `errorPath`) and failure mapping;
  - escalation (`runAttributionEscalation`: no validation retry, `null` on unusable output) and non-story classification, through the runner's single-attempt path. Each transport keeps its escalation error policy: Gemini returns `null` for every error except an abort (`gemini.ts:403-439`); Ollama rethrows abort and unreachable (`ollama.ts:455-456`). Transport-level retries (Gemini's 429 / 5xx / idle-stream retries) still apply inside an escalation call, as today.
- **Characterisation first.** Before extraction, tests pin each difference above and the taxonomy outcomes. `gemini.test.ts` has no assertion on the retry request shape today, so it gets one for the replayed turn and temperature. Extraction is accepted only with these green.
- **The Ollama transport.** `OllamaTransport` is today's `OllamaAnalyzer.chat()` body (`ollama.ts:623-927`), including:
  - `keep_alive`, `num_ctx`, `num_gpu`;
  - `acquireAnalyzerSlot` and eval-timing telemetry;
  - `ANALYZER_DISPATCHER`;
  - its unreachable classifier (`ollama.ts:1043-1060`, abort-before-first-byte included).
- **The Gemini transport.** `GeminiTransport` is `generateWithLimiter` + `generate` (`gemini.ts:536-860`): limiter, idle watchdog, token-count reconciliation, `MAX_TOKENS` / SAFETY / RECITATION → `finish`. Thought parts (`thought: true`) set `reasoningSeen` and count as stream activity; they are never appended to `text`.
- **The OpenAI transport.** `OpenAITransport` creates one client per endpoint.
  - **Client.** `new OpenAI({ baseURL, apiKey, maxRetries: 0, timeout: <ceiling>, fetch: undici.fetch, fetchOptions: { dispatcher: <long-call Agent> } })`, with `fetch` and `Agent` from the same `undici` package (`server/node_modules/undici`) and streaming on.
  - **Signals.**
    - The ceiling is an `AbortSignal.timeout(requestCeilingMs)`, created **after** limiter and semaphore acquisition, so queue time is not charged to the request (the trap `ollama.ts:980-987` documents).
    - It is combined with the caller signal through `AbortSignal.any`.
    - The SDK `timeout` alone clears when headers arrive (`openai` `client.ts:1576,1600-1602`; no stream timer at `:1012-1019`).
  - **Deltas.**
    - The idle watchdog arms after the first delta.
    - A reasoning delta, `reasoning_content` (llama.cpp), `reasoning` (vLLM, where `reasoning_content` is deprecated) or a non-empty `reasoning_details` array (OpenRouter), counts as activity and feeds the route heartbeat. It sets `reasoningSeen` but is never parsed as answer text.
    - `finish_reason: 'length'` → `length`.
  - **Classification.** Verified by running openai 7.15.0 against a local server during planning: an abort **after** response headers (caller or ceiling) ends the streaming iterator without throwing (`openai` `core/streaming.mjs:134-141`, `:375-383`); an abort **before** headers throws `APIUserAbortError` whose `cause` is the signal's reason. "Headers received" means `create()` resolved. So after the loop ends, and in every `catch`, the transport classifies in this order:
    1. The caller signal aborted → `AnalysisAbortedError`, the contract `FallbackAnalyzer` (`index.ts:267`) and the route rely on.
    2. The error is connection-level (`APIConnectionError` or its timeout subclass, or a transport error raised before `create()` resolved), and its cause chain (two levels down, `err.cause.cause.code`) holds a connect-phase code: `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH` or `UND_ERR_CONNECT_TIMEOUT`, or it is a bare `fetch failed` with no code → `AnalyzerUnreachableError`. A reset or DNS hiccup before headers (`ECONNRESET`, `UND_ERR_SOCKET`, `EAI_AGAIN`) comes from a server that may be up, so it is retried as an incomplete stream and never triggers a fallback. An `APIError` that carries an HTTP status is never unreachable: the SDK copies the response body's `error.code` onto it, so a proxy's 502 reporting `ECONNREFUSED` must not trigger a fallback.
    3. The ceiling signal aborted, or `APIConnectionTimeoutError` → `AnalyzerTimeoutError`, never a fallback. A llama.cpp request waiting for a busy slot receives no headers (headers are sent when a slot starts the prompt), so it ends here, not as unreachable.
    4. An `APIError` with an HTTP status → `AnalyzerHttpError`; 429 and 5xx go through the shared retry helper first.
    5. An `APIError` without a status (an error event inside an open stream) → `AnalyzerHttpError` with status 0, not retried.
    6. Headers were received, and either the server dropped the socket (a plain `TypeError` "terminated" with `UND_ERR_SOCKET`) or the loop ended with no `finish_reason` → `AnalyzerStreamIncompleteError`, retried by the shared helper like an idle stream.
  - **Release.** The semaphore and limiter slot are released in `finally` on every path.
- **Unreachable errors.** `AnalyzerUnreachableError` replaces `LocalUnreachableError` as `FallbackAnalyzer`'s trigger (`index.ts:257-405`). The Ollama transport's classification is unchanged. Endpoints do not inherit "abort before first byte", because their pre-first-byte abort is the caller or the ceiling.
- **Engine value.** `AnalysisEngine` becomes `'local' | 'gemini' | 'openai'`, updated in:
  - the settings enum and `openapi.yaml` (regenerating `src/lib/api-types.ts`);
  - `AnalyzerSelection`, `ModelOption.engine` and persona generation's engine setting;
  - `getResolvedAnalysisEngine` (`user-settings.ts:975-977`, which must accept `openai`);
  - both run snapshots (`analysis-state.ts:52`, `active-analyses.ts:47`).
- **Classifying `'local'` branches.** A planning task lists every `'local'` engine comparison (TTS uses excluded) and classifies each as "Ollama-specific" (stays on the engine) or "shares the GPU" (reads decision 4's `gpu`). The plan carries that list as a table.

### 2. Structured output

| Mode | Ollama | Gemini | OpenAI-compatible |
|---|---|---|---|
| `schema` | `format: <adapted schema>` | `responseMimeType` + `responseJsonSchema: <adapted schema>` | `response_format: { type: 'json_schema', json_schema: { name, schema: <adapted>, strict: false } }` |
| `json` | `format: 'json'` | `responseMimeType` only | `response_format: { type: 'json_object' }` |
| `off` | no `format` | neither | no `response_format` |

- **Schema adapters.** Each provider has an adapter: a pure function from the draft-07 schema (`z.toJSONSchema(..., { target: 'draft-07', reused: 'inline' })`) to `{ schema, dropped: string[] }`.
  - The Gemini adapter keeps only the documented keywords (`genai.d.ts:5652-5667`), removes `$schema`, and turns `exclusiveMinimum: n` into `minimum` on integers (next integer). Gemini's docs say it ignores unsupported keywords rather than rejecting them, so the adapter changes what is sent only by removing constraints Gemini would not enforce; its value is the honest `dropped` list behind "schema (partial)".
  - The Ollama adapter is today's pass-through; the Ollama `format` test (`server/src/analyzer/ollama.test.ts:386-410`) stays valid.
  - The OpenAI-compatible adapter removes `$schema` only.
- **Label and help.**
  - **Label:** `dropped` feeds "schema (partial)". A Test record of `ignored` for the configured reasoning level shows "schema (not enforced)" plus a one-time warning.
  - **Logging:** a debug line lists the dropped keywords, never values.
  - **Help text:** says that llama.cpp ignores the schema while thinking, that some servers reject `json` mode (for example LM Studio), and that the Test action shows which.
- **Settings.**
  - `analyzer.ollama.structuredOutput` (default `schema`) and `analyzer.gemini.structuredOutput` (default `json`) are enum registry knobs, each with a Settings row, `.env.example` line and `config:sync`.
  - Each endpoint carries its own field (default `schema`).
  - Gemini's default flips to `schema` only after the on-box row records attribution quality, not just conformance.
- **The Test action** (`POST /api/analyzer/models/test`, body `{ modelId, scope: 'configured' | 'all' }`).
  - **Requests.**
    - **Control:** no structured output (`off` mode), at the engine's current reasoning default. It uses the same prompt and the same output cap as the probes: the model's resolved Auto cap, clamped to context minus estimated input.
      - **One change per step:** each later request differs from the one before it in exactly one field (the reasoning level in wave 5, then the structured-output mode), so a failure is attributable to that field. Control and level steps prove acceptance only, so a `length` stop on them counts as accepted.
      - **Why not a tiny cap:** thinking tokens count against the cap, so a trivial output cap would end a thinking model's request with `length`.
      - **Why not `json`:** some servers reject `json` mode (LM Studio returns 400), which would make every test there fail. `json` is probed like any other mode.
    - **Configured check:** the configured structured-output mode at the configured reasoning level (reasoning levels from wave 5). In `schema` mode it uses the largest real stage schema plus one required marker key with a single-value enum the prompt never mentions.
    - **`scope: 'all'`:** adds every mode and every offered level.
    - **Order and limiter:** requests run sequentially through the model's limiter. The UI shows the request count first, and for Gemini notes that the requests count against today's quota.
  - **Classification.**
    - **Control fails:** the test reports `failed` with the redacted error, records nothing as `rejected`, and **keeps any previous record**.
    - **Control succeeds, then a 400:** the step's field is recorded `rejected`, unless the provider's message names a context, token or length limit. That case is inconclusive, like a 5xx, timeout, or `length` / `blocked` finish on a probe: no record is saved and the route returns 502.
    - **Where records are kept:** each record is keyed by the reasoning level actually sent.
    - **Cancelling:** the route passes the client's abort signal, so leaving the page cancels a queued or running test.
    - A 200 whose output contains the marker key with its enum value → `enforced`.
    - A 200 without the marker → `ignored`.
    - Modes other than `schema`, and reasoning levels, record `accepted` / `rejected`.
  - **Record.** `analyzerCapabilitiesByModel[modelId] = { serverUrl, structuredOutput: {…}, reasoning: {…}, testedAt }`. A record whose `serverUrl` no longer matches the endpoint's base URL (or the Ollama URL) is discarded.
    - **Merging (wave 5).** A Test merges the verdicts it probed into the model's record for the same server. Each verdict keeps the date of the Test that recorded it (`verdictTestedAt`).
    - **Model identity.** An Ollama record also carries the model's `digest` from `/api/tags`. A Test whose digest differs from the stored record's replaces the record instead of merging, so a re-pulled tag keeps no verdict it was never tested for. Ollama keys are read through `normalizeModelTag`, so a record saved under `qwen3:latest` is found by a Test of `qwen3` and rewritten under `qwen3`.
    - **Endpoints** expose no digest. A different model served under the same name is caught on its first call that the new model refuses (`analyzer-request-rejected`).
  - **Local models.** A test of a local model (Ollama, or an endpoint whose `gpu` isn't `none`) goes through the forward GPU guard first.
  - **Pre-run check.** Before a run's first call, a configured mode or level recorded as `rejected` refuses the run, naming the setting and the date of the Test that recorded that verdict.
- **Failure codes** in `server/src/routes/failure-taxonomy.ts`:
  - `analyzer-request-rejected`: a 400 from the provider. It carries the redacted provider error and names the structured-output, reasoning, custom-payload and context-size settings for that engine or endpoint, plus "Test this model".
  - `analyzer-invalid-output`: validation failed after retry, with a mode-aware hint that names "schema (not enforced)" when that is the recorded state.
  - `analyzer-timeout`: decision 1c.
  - `analyzer-reasoning-overflow`: decision 7.
  - `analyzer-endpoint-missing`: §3.
  - 401/403 map to the existing `auth` code, naming the engine or endpoint key.
- **`<think>` strip.** `parseAndValidate` strips a leading `<think>…</think>` block before its existing candidates, following the regex precedent at `voice-style.ts:148-152`. An unterminated leading `<think>` block sets `reasoningSeen` and leaves no answer text.

### 3. Endpoints, model ids and catalogs

- **Storage.** `analyzerEndpoints` lives in user settings, as `Array<{ id, name, baseUrl, gpu, unloadUrl?, concurrency, requestCeilingMs, structuredOutput, reasoningStyle, reasoning, maxOutputTokens, contextTokens, maxInputTokensPerRequest?, extraParams? }>`. `contextTokens` is required.
- **Context size (decision 3b).**
  - **Prefill:** the add-endpoint form fills `contextTokens` from `/v1/models`, first match wins: `max_model_len` (vLLM), `meta.n_ctx` (llama.cpp's per-slot context, or llama-swap's configured one), `context_length` (OpenRouter, or llama-swap's configured one). llama.cpp's `meta.n_ctx_train` and LiteLLM's catalogue `max_input_tokens` are never used.
  - **Detect:** reads, only when clicked, `GET /props` → `default_generation_settings.n_ctx` (llama.cpp), or `GET /props?model=<id>` (llama-swap) behind a "may load the model" confirmation.
  - **Otherwise:** the user enters the value, and the form refuses to save without it.
  - **No mock:** Detect talks to the local machine and joins CLAUDE.md's documented local-machine exception set.
- **API keys (decision 3c).**
  - **Storage:** keys are stored separately per endpoint id as `{ origin, key }`. They are written only through a dedicated endpoint, never returned by the settings GET, and stripped from the general PUT, following the Gemini key precedent (`user-settings.ts:211-219`).
  - **Key format:** a key containing any control character (including CR, LF or NUL) is refused when written. The HTTP client would otherwise echo the whole header value in its error.
  - **Origin check:** every call, catalog listing, Test, Detect and unload POST compares `new URL(url).origin` with the stored origin. On mismatch no request is sent, and the call fails as `auth` ("re-enter the key for <endpoint name>").
  - **Host change:** the Settings form prompts for the key when the host changes.
  - **Unload URL:** saving refuses an unload URL whose origin differs from the base URL's.
- **Deleting an endpoint.** Blocked while any saved setting references its ids (default model, phase knobs from #3141, persona engine); the error lists the references.
  - **References that can't be blocked:** env (`ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL`, `select-analyzer.ts:71-77`; `PERSONA_GEN_ENGINE`, `registry.ts:1182`) and #3141's per-run phase pick.
  - **For those:** a pre-run check fails the run as `analyzer-endpoint-missing` before its first call, naming the id and where it came from.
- **Id grammar.**
  - **Shape:** `openai:<endpointId>::<model>`.
  - **Inference, in order:** matches `^openai:[a-z0-9-]+::` → `openai`; contains `:` → `local`; else → `gemini`. An Ollama tag such as `openai:latest` cannot match, because it has no `::`. Ollama allows `::` only inside a host segment, which is followed by `/` (`types/model/name.go`); the analyzer never selects host-qualified Ollama names, and the case table records that shape.
  - **One table:** one shared test table drives both `engineForModelId` (frontend) and `inferEngineFromModelId` (server).
  - **Every site that handles a selected model id applies the same inference,** so an `openai:` id never reaches Ollama. Examples:
    - `getResolvedOllamaModel` (`user-settings.ts:960-965`), and through it persona generation's local model (`voice-style.ts:67-70`);
    - `ollama-health.ts:199,205,218`;
    - `POST /api/ollama/load` (`ollama-health.ts:491-492`), which passes a requested model straight to Ollama;
    - `src/lib/models.ts:120,127`.
  - **Sites that handle Ollama's own tag lists stay unchanged.** These include pull status, setup pull checks, VRAM statistics and evaluation statistics (`model-pull-status.tsx:294`, `setup/step-analysis.tsx:21,75-76`, `setup-diagnosis.ts:300,302`, `model-vram-stats.ts`, `analyzer-eval-stats.ts`). An id inference there would misread a colonless Ollama tag such as `llama2` as Gemini.
  - **Classification:** the plan's `'local'` classification table records every site's category and its reason, re-grepped during planning.
- **Catalogs.** `GET /api/analyzer/models` returns grouped catalogs with a short server-side cache and an explicit refresh.
  - **Sources:**
    - **Ollama:** `/api/tags`.
    - **Gemini:** `models.list()` (`genai.d.ts:11032`), only when a key is set, filtered to `supportedActions` containing `generateContent`. The listing has no output-modality field, so text-output models are selected by a name rule that excludes embedding, `-tts`, `-image` and `-live` models.
    - **Each endpoint:** `/v1/models` via the SDK, plus free-text entry.
  - **Entries:** each carries the model's served context and output limits when known, plus its Test record.
  - **Curated overlay:** curated entries (`MODEL_OPTIONS`, `src/lib/models.ts:19-95`) overlay labels and hints, extending `buildLocalModelOptions(liveTags, curated)` (`models.ts:156`).
  - **Failure:** each group fails independently and shows its error.
    - **Gemini:** a failed listing falls back to the curated list.
    - **Ollama:** keeps plan 221's installed-only rule (`src/lib/models.ts:144-155`), so a failed `/api/tags` lists no local models rather than offering ones that are not installed.
    - **Endpoints:** stay listed from saved settings, with free-text entry.
  - **Preview:** the add-endpoint form lists an unsaved server's models through a separate preview call, `POST /api/analyzer/models/preview`, with the base URL and key from the form, to prefill the context size. The catalog lists saved endpoints only.
- **Labels.** `modelLabel(id)` replaces the ~9 `MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id` sites. It resolves the curated label, then the live `displayName`, then the model part of the id prefixed with the endpoint name.
- **Contract and mocks.** Every new settings field, the catalog response, endpoint CRUD, the per-endpoint key write, the Test action, `analyzerCapabilitiesByModel`, `analyzerRateLimitsByModel` and `analyzerExtraParamsByEngine` get:
  - an `openapi.yaml` schema, with `src/lib/api-types.ts` regenerated;
  - a mock-mode counterpart in `src/lib/api.ts`, because the E2E runs in mock mode. Detect is the exception above.

### 4. GPU coordination and fallback

- **Endpoint `gpu`.** Values are `none`, `any` or a device key in the `${kind}:${index}` form that `capacity-retry.ts:274-275` uses. The picker lists devices from the existing capacity probe.
- **Forward guard.** `use-local-analyzer-guard.tsx:78-81` resolves the selected id to its engine or endpoint from saved settings.
  - It treats `local` as today.
  - It treats an endpoint whose `gpu` is `any` or matches the TTS target device as sharing the card.
  - It treats an endpoint id missing from settings as `any`, so it fails closed.
- **Reverse guard.** The `activeStream` snapshot gains `gpu`, captured at stream start alongside `engine` (`use-reverse-local-analyzer-guard.tsx:34-36`), so the guard keys on what is actually running.
- **Busy accounting for endpoints.** An endpoint whose `gpu` is not `none` is busy on a card while any analyzer run using it is active, or any call to it is in flight.
  - **Why run-level:** a run is still busy between two chunk calls; a per-call check would read that gap as idle.
  - **Cards counted:** an endpoint counts for the card named in its `gpu`, or for every card when `gpu` is `any`.
  - **Remote endpoints:** an endpoint with `gpu: none` never blocks eviction, as a Gemini call does not today.
  - **Ollama:** its eviction keeps today's gate (`sidecar.ts:193-194`, `server/src/gpu/capacity-retry.ts:236-237`) with its text unchanged, read before each `evictOllama()`, and keeps its own once-per-call `evicted` latch. Endpoint activity on any card does not change it. The endpoint lever is separate and has no latch: it is reached only on an iteration where Ollama was not evicted, and bounded by one unload POST per (endpoint, model) per admission.
- **Eviction.**
  - **Where:** directly after Ollama's lever in `server/src/gpu/capacity-retry.ts:278-282`, passed through `server/src/tts/sidecar.ts:428-438`. It does not share Ollama's `evicted` latch and has none of its own. Endpoints are gated by their own busy state (above), not by Ollama's `!isAnalysisInFlight()` check, which stays as it is. An admission is one `withCapacityRetry` call, and the sidecar provider makes one per synthesize call (`/synthesize` and `/synthesize-batch`), not per chapter, so every cost below is per denied synth op.
  - **Bound:** each (endpoint, model) gets at most one unload POST per admission, 10 s each, marked before it is sent so a hang counts; a busy skip spends nothing. The worst case is Σ (served models on matching endpoints) × 10 s per admission.
  - **What:** for each endpoint with an `unloadUrl` whose `gpu` is `any` or equals `noCap.deviceKey`, the server POSTs that URL best-effort, alongside `evictOllama`.
    - **Busy re-check:** the endpoint's busy state on the denied card is checked again immediately before each POST, and a busy endpoint is skipped.
    - **`{model}`:** replaced by each model whose request was sent to that endpoint since the server started (one POST per model). Runs, Tests and requests that then fail all count; only one aborted while still queued does not. An unload that answers 2xx or 404 removes that model from the set (the server no longer holds it), so the set tracks what may still be loaded.
    - **Key:** each request carries the endpoint's key under the origin rule.
    - **All-models URLs:** an unload URL without `{model}` unloads everything on that server, which can include another card's model. Saving one shows a warning naming that risk.
  - **No VRAM figure:** `analyzerEvictWouldHelp` reads Ollama's VRAM, which endpoints lack. Endpoint eviction is therefore not gated on it; it is attempted whenever an endpoint matches.
  - **Async unload:** an unload POST blocks until the server has stopped the model. After a 2xx the retry loop retries admission at once; if that attempt is denied again, the next iteration re-probes capacity before either lever runs, so Ollama's gate and the idle-TTS lever see post-unload free memory. A POST that failed does not retry at once; the loop waits its normal poll.
  - **Give-up message:** names every sharing endpoint still holding the card and why — no unload URL, busy for the whole wait, every unload POST failed, unloaded what it could and still short, or a `{model}` URL with no model run since the server started.
  - **During a run:** the forward and reverse guard prompts are the protection, as for Ollama today.
- **Fallback.** `FallbackAnalyzer` wraps an endpoint exactly as it wraps `local`: fallback to Gemini only on `AnalyzerUnreachableError`, only with a key and `allowCloudFallback` on, announced through `onFallback`.

### 5. Rate limits and concurrency

- **Limiter.** `GeminiRateLimiter` (`rate-limit.ts:158`) becomes the analyzer limiter, keyed by full model id, and is used by the Gemini and OpenAI transports, the Test action and persona generation (today `voice-style.ts:213`).
- **Limit resolution.**
  - **Gemini ids:** env → `analyzerRateLimitsByModel` (a user-settings map, following `analyzerKeepAliveByModel`, `user-settings.ts:253`) → `BUILTIN_LIMITS` → Gemini default.
  - **Endpoint ids:** `analyzerRateLimitsByModel` → unlimited.
- **Migrating the Gemma knobs.** The six `rate.*.gemma*` knobs wired by #3139 migrate into the map and are removed.
  - **Guard:** the #3146 guard's `rate.*` dynamic-reader entry and `KNOWN_UNREAD` handling are updated in the same change. Because the map is not a registry knob, that guard cannot see it, so a paired limiter test asserts that the map is read.
  - **Env still read:** the computed env read at `rate-limit.ts:80-82` keeps reading `GEMINI_{RPM,TPM,RPD}_<slug>`. It stays a documented blind spot (`direct-env-reader-guard.test.ts:57-67`), covered by its existing tests.
  - **Env documentation:** that family is documented by a hand-written `.env.example` entry outside the generated block. `server/scripts/sync-env-example.ts` rewrites only the `BEGIN`/`END` managed block.
- **Settings editor.** Settings gains a per-model limits editor listing catalog models.
- **Concurrency.** Per-endpoint concurrency gates calls with the same count-semaphore mechanism as `acquireAnalyzerSlot` (`server/src/analyzer/analyzer-concurrency.ts:60`), one semaphore per endpoint, reporting into the in-flight stats (§4).

### 6. Capacity model

`EngineCapacity { family: 'context' | 'requestCap', contextTokens, maxOutputTokens, perRequestInputCap? }`, resolved per model:

- **Ollama.**
  - `family: 'context'`.
  - `contextTokens` is the `num_ctx` sent (`ollama.ts:275`), exactly as today, with no clamp. Clamping to `/api/show`'s native context length would shrink budgets for short-context tags before measurement, so it is recorded for the recalibration row instead.
  - Large local windows are enabled by raising `analyzer.ollama.numCtx`, which remains the VRAM-bearing choice.
- **Gemini.**
  - `family: 'requestCap'`.
  - `contextTokens` / `maxOutputTokens` come from the cached `models.list()` `inputTokenLimit` / `outputTokenLimit`. On a cache miss with a failed listing, they fall back to today's values (12000 cap, 8192 output).
  - `perRequestInputCap` = min(`analyzer.gemini.maxInputTokensPerRequest` (default 12000, unchanged), the model's TPM limit).
- **Endpoints.**
  - `family: 'context'`.
  - `contextTokens` is the required endpoint field (decision 3b).
  - `perRequestInputCap` = min(the endpoint's `maxInputTokensPerRequest`, its TPM limit), each only if set. When a cap is set, the context-family budget is further limited by `cloudBodyCharBudget` at that cap.
- **Budget formulas are today's, selected by family.**
  - **Context family:** `analyzer.stage{1,2}.localInputFraction` × `contextTokens` at 2 chars/token, no reservation (`stage1-chunk.ts:119-124`). The two fraction knobs keep their keys and defaults and apply to every context-family capacity; their help text says so.
  - **Request-cap family:** `cloudBodyCharBudget` with `charsPerTokenForText` and the existing reservations (`STAGE1_CLOUD_RESERVED_TOKENS`, `OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS`, roster chars).
- **Ceilings stay per pass, as today.**
  - **Stage 1:** `analyzer.stage1.chunkCharBudget` (24000).
  - **Stage 2:** `analyzer.stage2.chunkCharBudget` (9000).
  - **Cloud chapter-level passes:** `analyzer.gemini.outputHeavyChunkChars` (32000).
  - **Context-family chapter-level passes:** keep using stage 1's budget (`chapter-chunker.ts:136`).
  - **Endpoints:** no per-endpoint chunk-size field; these ceilings apply.
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
  - **Endpoints:** min(the served output limit if known, `contextTokens` − estimated input − a safety margin of max(1024, 10% of `contextTokens`)).
    - Endpoints send `max_tokens`.
    - The margin exists because the input size is an estimate, and strict servers reject a prompt plus `max_tokens` above the served context.
    - A 400 naming a token limit points to the endpoint's max-output setting.
  - **Payload override:** a custom payload that sets or removes `max_tokens` / `max_completion_tokens` disables Auto for that endpoint, shown in the label. OpenAI reasoning models need `max_completion_tokens`, and help text says so.
- **Gemini thinking stays visible.** Gemini's pre-first-chunk idle watchdog (45 s, `gemini.ts:60`, `:724`) would kill a long think that Auto now allows.
  - **Thought summaries:** a model that thinks, by a static id rule (never the live catalog, so behaviour is stable per model), sets `thinkingConfig.includeThoughts: true` (`genai.d.ts:14398`). Thought parts count as stream activity and are dropped from the answer text. Gemma is outside the rule until a reasoning level turns its thinking on (§8).
  - **Owned key:** this `thinkingConfig` field is owned by the transport (decision 9).
  - **Thinking window (pending owner approval):** a new `analyzer.gemini.thinkingIdleTimeoutMs` knob bounds every silent gap until the first **answer** text arrives: the wait for the first chunk, and each gap between thought parts.
    - **Default:** 4 min for thinking models; today's 45 s for other models.
    - **Maximum:** 290 s. The Gemini SDK streams over the global `fetch`, whose undici header and body timeouts are fixed at 300 s unless changed process-wide.
    - **After answer text starts:** today's 45 s idle watchdog applies unchanged.
    - **On timeout:** a request that times out before answer text fails as `analyzer-timeout`, naming this setting. It is not retried, because it already exceeds the 90 s retry budget, and no retry is announced.
    - **Trade-off:** a stalled request on a thinking model fails once, after up to 4 min, instead of two 45 s attempts. In return a think is not killed while it stays silent, or streams summaries, for up to 4 min at a time.
    - **Why this replaces a probe:** measuring streaming per model with a probe could not be made representative of real chapters.
  - **Ceiling:** every Gemini request is bounded by `analyzer.gemini.requestCeilingMs` (default 30 min), the same mechanism as decision 1c. Both knobs get a Settings row, `.env.example` line and `config:sync`.
  - **Measurement:** the transport logs time to first chunk, time to first answer text, and the number of thought parts before the answer. An on-box row records them on real chapters to tune the default. It does not gate the wave.
- **Truncation.**
  - **Split:** a `length` finish raises `AnalyzerTruncatedError`, which splits the chunk as today (`ollama.ts:838`, `gemini.ts:801,816`), in either case:
    - it has answer text;
    - it has no answer text and **no** reasoning evidence. This keeps the Gemma size-problem recovery (`gemini.ts:784-804`) at Gemma's default level and at `off`. Gemma at `on` asks for thoughts, so its thought tokens are evidence and an empty finish there fails as below.
  - **Reasoning evidence** is any of: `usage.reasoningTokens > 0`, `reasoningSeen` (reasoning deltas, Gemini thought parts), or an unterminated `<think>` block. A Gemini `thoughtsTokenCount` becomes `usage.reasoningTokens` only on a request whose wire sent `includeThoughts`, stage or free text.
  - **Fail:** a `length` finish with no answer text and reasoning evidence raises `AnalyzerReasoningOverflowError`. It maps to `analyzer-reasoning-overflow`, names that engine or endpoint's reasoning and max-output settings, and never splits.
- **Default changes before measurement.**
  - Gemini Auto **raises the default cap from 8192 to the model limit**.
  - Gemini thinking models gain thought summaries on the wire.
  - The reasoning-overflow rule applies.

  These are the only default behaviour changes this design makes before measurement. They only affect calls that were being truncated or that think, and they are covered by an on-box row.

### 8. Reasoning

- **Endpoint control style.** Each endpoint has a `reasoningStyle`, which decides the levels offered:
  - `reasoning_effort`: `model default` (omitted) / `none` / `minimal` / `low` / `medium` / `high`, sent as `reasoning_effort`.
  - `enable_thinking`: `model default` (omitted) / `off` / `on`, sent as `chat_template_kwargs: { enable_thinking }`.
  - `not controllable`: `model default` only.
- **Gemini, by model.** Levels come from a per-model table matched on the id, because support differs within a family:
  - **`thinkingLevel` models (Gemini 3.x):** `model default` / `minimal` / `low` / `medium` / `high`, with no off. Gemini 3.7 and 3.8 Flash reject `minimal`, and 3.1 Pro has none, so it is not offered for them.
  - **`thinkingBudget` models (Gemini 2.5):** `model default` / `off` (budget 0, only on 2.5 Flash and 2.5 Flash-Lite) / `low` / `medium` / `high` budget tiers. 2.5 Pro cannot turn thinking off.
  - **Gemma 4:** `model default` / `off` (`thinkingLevel: minimal`) / `on` (`thinkingLevel: high`).
  - **Unknown ids:** `model default` only.
  - A request never carries both `thinkingLevel` and `thinkingBudget`; Gemini rejects that with a 400. The Test action confirms each level.
- **Ollama.** The reasoning setting is stored **per model**, with default `off`. Persona generation's local model uses its own entry.
  - **Values:** `model default` omits `think`; `off` sends `think: false` (today's default, which Ollama accepts even from models that do not think); `on` sends `think: true`.
  - **Rejection:** Ollama rejects `think: true` or a level with a 400 on a model that does not think, and the Test action records it.
  - **Named levels:** `low` / `medium` / `high` can be saved only for a model whose own Test record accepted them. With thinking on, Ollama still enforces `format` on the answer by re-running generation once the answer starts, which costs a second prefill.
- **Defaults** preserve today: Ollama `off`; Gemini and endpoints `model default`.
- **Support.** The Test action records `accepted` / `rejected` per offered level (from wave 5). A level recorded `rejected` refuses the run before it starts. Help text states that a server may accept a level and ignore it, and that this cannot be observed.

### 9. Custom payload

- **Storage.** Stored per engine (`analyzerExtraParamsByEngine.ollama` / `.gemini`) and per endpoint (`extraParams`), edited in Advanced Settings' analyzer section, validated on save as a JSON object.
- **Merge.**
  - **Order:** merged last into the native request.
  - **Scope:** top-level keys replace. The transport's owned containers are merged key by key: Ollama `options`, Gemini `config`, and endpoint `chat_template_kwargs`. The last is merged so a payload key cannot delete the `enable_thinking` value the reasoning setting sends.
  - **Gemini:** a payload is scoped to `config`. Top-level `model` and `contents` are protected, and any other top-level key is refused.
  - **Removal:** `null` removes a key. It is refused on an owned container itself (`options: null`, `config: null`, `chat_template_kwargs: null`).
  - **Output cap keys:** a payload `max_completion_tokens` makes the endpoint transport drop its own `max_tokens`, so the request never carries both.
  - **Validation:** reasoning levels and protected keys are validated when settings are written, never when they are read. `readUserSettings` falls back to defaults for the whole file when its content parses but fails the schema (`user-settings.ts:522-525`), so validating on read could wipe every setting. An *unparseable* file is a separate path — recovered from its `.bak.N` backups, else in-memory defaults with a corruption flag (`:479-498`) — and does not reject. The risk being avoided is a refinement wiping a valid file. The one exception read *does* make is the per-entry endpoint parse: it hooks into `performUserSettingsRead` between the eager-load migration and that whole-file `safeParse`, drops only the offending entry, and never sets the corruption flag (which means the file itself was unreadable, not that one entry failed its schema).
  - **Temperature:** a payload `temperature` / `options.temperature` sets the first attempt's temperature only; the retry policy's temperature applies after the merge (§1).
- **Protected keys,** refused at save **and removed again at merge time**, so a value stored before a rule existed never reaches the wire:
  - **Endpoints:**
    - request shape and parsing: `model`, `messages`, `stream`, `stream_options`, `n`, `stop`, `tools`, `tool_choice`, `response_format`, `grammar`, `json_schema`;
    - reasoning: `reasoning_effort`, `reasoning`, `reasoning_format`, `reasoning_budget_tokens`, `thinking_budget_tokens`, `include_reasoning`, and `chat_template_kwargs.enable_thinking` when `reasoningStyle` is `enable_thinking`.
  - **Ollama:** `model`, `messages`, `stream`, `format`, `think`, `keep_alive`, `tools`, `options.num_ctx`, `options.num_gpu`, `options.main_gpu`, `options.stop`.
  - **Gemini:** the payload is an **allowlist** of `config` keys: `temperature`, `topP`, `topK`, `maxOutputTokens`, `presencePenalty`, `frequencyPenalty`, `seed`, `safetySettings`. Every other key is refused, including `httpOptions`, whose `baseUrl`, `headers` and `extraBody` would let a payload redirect the API key or reinject any protected field. The installed SDK applies `config.httpOptions` per request.
- **Stale stored values:** a stored reasoning level the current table no longer offers refuses the run before its first call, with the setting named, rather than failing inside a request. Settings are read per call, so a level saved during a run applies from the next call. A value no save can produce (a hand-edited file) that reaches a call mid-run fails that call with the same coded refusal.
- **Saves replace maps whole:** a settings save replaces each sent map (`analyzerReasoningByEngine`, `analyzerExtraParamsByEngine`) as a whole, so an engine left out of a sent map loses its entries. An endpoint update judges its level and payload only when that value or its reasoning style changes, as the settings save does.
- **Test action:** Test probes include the configured payload, so a record describes the request a run sends.
- **Unprotected output keys.** Endpoint `max_tokens` / `max_completion_tokens`, Ollama `options.num_predict` and Gemini `config.maxOutputTokens` are allowed. Setting or removing one disables Auto for that engine or endpoint, and the run label shows it. The payload value also becomes the capacity model's output cap, which the reasoning-overflow rule and the request-cap chunk budget use, so the wire and the budget never disagree. Context-family chunk budgets do not depend on the output cap.
- **Privacy.**
  - **Label:** shows "+ custom params".
  - **Logs and files:** the payload is excluded from logs and persisted analyzer files.
  - **Upstream errors:** before logging or display, every payload string value of 8 or more characters is replaced wherever it appears in upstream error text (`ollama.ts:712-715`, `gemini.ts:853-860`, the failure detail at `failure-taxonomy.ts:410-427`). Shorter values (`"json"`, `"auto"`) are not redacted, because they would blank ordinary words in the provider's message.

### 10. Persona generation

- **Engine setting.** `analyzer.personaGeneration.engine` becomes a model-id-style selection: `local` / `gemini` / any `openai:<endpointId>::<model>`.
- **Transport.** `generatePersonaViaOllama` and the Gemini persona call become transport calls through the runner's free-text path (no structured output), with the limiter, reasoning setting and custom payload applied. The payload's output-cap keys (`max_tokens`, `max_completion_tokens`, `n_predict`, `options.num_predict`, `config.maxOutputTokens`) are dropped from a persona request before the merge, so a persona keeps its own output length. Its other payload keys apply.
  - **Request shape:** a free-text request sends only what today's persona calls send. The Gemini call has no temperature, system instruction, output cap or JSON mode (`voice-style.ts:215-219`). The Ollama call stays non-streaming, keeps its keep-alive, CPU placement and 600 s bound, and keeps its slot-leak guarantee (`ollama-timeout.test.ts:149-215`).
  - **Length stops:** a persona reply cut off by a length stop with answer text is kept, as today.
  - **Behaviour changes** (A5), each announced in the release notes:
    - Gemini persona calls gain the shared transport retry (429, 5xx, idle stream), which today's single `generateContent` call lacks.
    - A blocked Gemini reply fails as `GeminiContentBlockedError` (`analyzer-content-blocked`). Today the empty text reports the empty-persona error.
    - A reply that is only an unterminated `<think>` block is the empty-persona error. Today that text is saved, because `cleanPersona` strips only a closed block.
    - A length stop with no answer and reasoning evidence fails as `analyzer-reasoning-overflow`. The evidence is Ollama's `thinking` or an unterminated `<think>` on any engine, and from wave 5 the thought tokens of a Gemini level that asks for thoughts. Today it is the empty-persona error. A Gemini persona at its default level asks for no thoughts, so its thought-token count is not evidence.
- **Unchanged.** The "no silent cross-provider fallback" rule in its help text (`registry.ts:1185`) is unchanged.

## Data flow (one analyzer call)

1. **Selection.** The route resolves engine/endpoint + model (per-run phase pick from #3141), capacity, and that engine/endpoint's settings. Pre-run checks:
   - the endpoint exists;
   - the key origin matches;
   - the Test record does not mark the configured mode or level rejected.
2. **Chunking.** The chunker sizes the chapter from capacity, using the family's formula and the pass's ceiling.
3. **Request.** The runner builds messages and the adapted structured-output request.
4. **Send.** The transport:
   - acquires limiter and concurrency, then starts the ceiling;
   - merges the custom payload last, then applies retry-owned values;
   - sends, streams, and normalises `finish` and reasoning evidence;
   - classifies aborts, per decision 1c, before handing over any text.
5. **Parse.** The runner strips `<think>`, repairs, validates and retries under the transport's retry policy.
6. **Outcome.**
   - `length` splits, except for an empty answer with reasoning evidence, which fails as reasoning overflow.
   - An unreachable failure falls back under the gate.
   - A caller abort ends quietly.
   - Everything else maps to a failure-taxonomy code.

## Error handling summary

| Condition | Behaviour |
|---|---|
| Caller abort (pause, disconnect) | `AnalysisAbortedError`, dropped quietly as today |
| Unreachable (1c classification) | `AnalyzerUnreachableError` → Gemini fallback if gated on, else a hard fail naming the endpoint |
| Ceiling, or timeout after connecting | `analyzer-timeout`, never a fallback |
| Stream ended without a finish reason | `AnalyzerStreamIncompleteError`, retried like an idle stream |
| 401/403, or key origin mismatch | `auth`, naming the engine/endpoint key |
| Any 400 | `analyzer-request-rejected` with the redacted provider error and the request-shaping settings named; no retry-without |
| Configured mode/level recorded as rejected by Test | Run refused before its first call |
| Endpoint id missing (env or per-run pick) | `analyzer-endpoint-missing` before the first call |
| 429 / 5xx / idle stream | Shared retry helper; limiter records rejections; Ollama 5xx keeps today's taxonomy outcome |
| `length` finish with answer text, or empty with no reasoning evidence | `AnalyzerTruncatedError` → chunk split |
| `length` finish, empty answer, reasoning evidence | `analyzer-reasoning-overflow`, no split |
| Validation fails after retry | `analyzer-invalid-output`, mode-aware hint |
| Invalid payload / protected key / owned container nulled / endpoint still referenced by settings / unload URL off-origin / missing context size | Refused at save (400) |

## Testing

- **Characterisation before wave 1.** Pin each runner difference listed in §1 and the taxonomy outcomes for Ollama 400/404/500/503. This includes a new `gemini.test.ts` assertion on the retry request's replayed turn and temperature.
- **Transport contract suite.** It runs against all three transports over a **real `http.createServer` and a real undici `Agent`**, following `server/src/analyzer/ollama-timeout.test.ts:61,112-114`; a stubbed `fetch` would bypass the dispatcher and could not fail. Every case asserts the **error class**, not just that the call ended:
  - streamed text and `finish` mapping;
  - a refused port and an unroutable host → `AnalyzerUnreachableError`;
  - a post-connect stall → `AnalyzerTimeoutError`;
  - a **long silent prefill** that must not time out before the ceiling;
  - a **header-then-silence** server that the ceiling ends → `AnalyzerTimeoutError`, with the semaphore released;
  - a **caller abort mid-stream** → `AnalysisAbortedError`, never parsed text;
  - a stream that closes without `finish_reason` → `AnalyzerStreamIncompleteError`;
  - a server that drops the socket mid-stream → `AnalyzerStreamIncompleteError`;
  - an error event inside an open stream → `AnalyzerHttpError` with status 0, sent once;
  - a ceiling that fires before headers (the SDK throws `APIUserAbortError`) → `AnalyzerTimeoutError`;
  - `reasoning_content` and `reasoning` deltas keeping the idle watchdog alive and setting `reasoningSeen`;
  - ceiling time not charged while the call waits on the semaphore.
- **Runner.** Existing `ollama.test.ts` / `gemini.test.ts` stage behaviours move to runner tests without weakening assertions. Also:
  - the `<think>` strip, including the unterminated case;
  - reasoning overflow versus truncation, including an empty Gemma `MAX_TOKENS` with no reasoning evidence still splitting;
  - a 400 producing `analyzer-request-rejected` with no second request;
  - pre-run refusal from a Test record;
  - a payload temperature not overriding the retry temperature;
  - the persona free-text path.
- **Test action.**
  - A failing control request records nothing as `rejected`.
  - The marker-key probe → `enforced` / `ignored` / `rejected`.
  - Records are discarded after a base-URL change.
  - `scope: 'all'` request counts.
- **Pure functions.**
  - Schema adapters, including a snapshot of `dropped` for every stage schema per provider.
  - The id-grammar table, run against every listed `:` site.
  - Catalog merge and fallback, and served-context prefill field selection.
  - Limiter resolution order, including the map-read test.
  - Capacity and budgets, with the pinning test captured from `main`; Auto output tokens.
  - The reasoning level sets per style and family.
  - Payload merge, protected keys, owned-container null refusal, and redaction length rule.
  - Key-origin matching; unload URL `{model}` substitution.
- **Eviction.** No unload POST while an endpoint call is in flight or a run using the endpoint is active (the run-level mark). An unload POST only for a matching card. Ollama keeps its own latch; the endpoint lever has none, and an endpoint idle only at a later poll is still asked, with every model of a `{model}` URL still eligible after a mid-loop busy skip. At most one POST per (endpoint, model) per admission, a hang included. A 2xx or 404 removes the model from the served set. Capacity is re-probed after an unload. Tests drive several endpoints, several models and several polls, not a single stub.
- **Routes.**
  - `GET /api/analyzer/models`, the Test action, and Detect.
  - Endpoint CRUD, including these refusals: delete-while-referenced, missing context, off-origin unload URL.
  - The per-endpoint key write and settings validation.
- **E2E (Playwright, mock mode).**
  - Add an endpoint (context size required) and pick its model in the picker; the run label shows mode, "schema (not enforced)" from a mocked Test record, and "+ custom params".
  - The GPU guard prompts for an endpoint on the TTS card and not for one on another card.
  - Editing the host prompts for the key.
- **Mutation proofs** for each resolver, adapter, classifier and guard, per repo practice.

## On-box acceptance owed (register rows)

- **Live structured output:** the Test action, plus a real chapter in `schema` mode, on `gemma-*`, `gemini-*` and a llama-swap endpoint with thinking on and off. Record:
  - the Test's `enforced` / `ignored` result against observed conformance;
  - what the Gemini adapter drops;
  - Gemini `schema` attribution quality against `json`.

  This row gates Gemini's `schema` default.
- **Thinking-model output:** `gemini-3.6-flash` on a 20,000-character chapter with Auto output. Record time to first chunk and whether thought summaries stream during thinking, plus idle retries, truncation, reasoning-overflow and request counts, against the 8192 baseline.
- **Long silent prefill:** a llama-swap endpoint on the slower card with a 64k+ prompt completes within the default ceiling, without timeout or fallback.
- **Same-card eviction:** a llama-swap endpoint with `gpu` set to one card and a per-model unload URL.
  - With the analyzer idle, a Qwen TTS load on that card evicts it instead of failing with out-of-memory.
  - A TTS load on the other card does not evict it.
  - During a run, no unload happens and the guard prompts.
- **Capacity recalibration:** a large-context local model on a 16 GB card, comparing chunk counts, truncation rate and attribution quality against today's defaults. It also compares Ollama `num_ctx` against `/api/show` native context for short-context tags, before any capacity default changes.

## Sequencing

Each wave is its own plan section. A wave may land as several PRs; nothing is offered in a picker before its wave's last PR.

- **Wave 0 (in the queue):** #3139, #3141.
- **Wave 1:** characterisation tests, then the shared runner + Ollama/Gemini transports + typed `AnalyzerHttpError` (taxonomy outcomes unchanged) + `<think>` strip. Behaviour-preserving apart from the strip.
- **Wave 2:** capacity model + max output tokens (Gemini Auto, with thought summaries, the first-chunk timeout and the request ceiling, per §7) + the reasoning-overflow rule, on today's engines, with the pinning test (decisions 6, 7).
- **Wave 3:** endpoints become selectable for analysis in this wave's last PR. It covers decisions 1b, 1c, 2, 2b, 3, 3b, 3c, 4 and 5:
  - OpenAI transport;
  - endpoints (required context size with Detect, key origin binding, card picker);
  - id grammar and every `:` site;
  - catalogs;
  - structured output with adapters;
  - the Test action (structured output only);
  - GPU guards, in-flight accounting and eviction;
  - fallback, limits and concurrency.
- **Wave 4:** persona generation (decision 10).
- **Wave 5:** reasoning settings, control styles, and their Test coverage + custom payload (decisions 8, 9).
- **After measurement:** Gemini `schema` default; any capacity default change.

## Verified during planning (2026-09-11)

Sources:
- **Ran:** `openai` 7.15.0 with `undici` 8.10.0 on Node 24.15 against local test servers.
- **Read:**
  - source at llama.cpp `451b89ba`, llama-swap `41ec321b`, Ollama `b68b112b`, vLLM `5c642796` and LiteLLM `362033cb`;
  - Gemini's docs and the installed `@google/genai` 2.19.0 types.

Findings:
- **`openai` + `undici`.**
  - Streaming works with `fetch: undici.fetch` plus the dispatcher; Node's global fetch rejects that `Agent`.
  - Aborts and cause chains behave as §1's classification lists.
  - The SDK `timeout` clears when headers arrive.
  - Unknown request keys (`chat_template_kwargs`, `top_k`, `reasoning_effort`) reach the wire untouched.
  - Reasoning deltas and the usage chunk are yielded as sent, and `models.list()` keeps unknown fields.
  - Port 9 cannot be used in a connect-timeout test: undici refuses it as a "bad port".
- **llama.cpp.**
  - Streaming headers are sent when a slot starts the prompt.
  - `/props` `n_ctx` and `/v1/models` `meta.n_ctx` are the per-slot served context; `meta.n_ctx_train` is training context.
  - `reasoning_effort` is not validated, and `none` turns thinking off.
  - The key is read from `Authorization` or `X-Api-Key`, and `/props` and `/v1/models` require it.
  - #20345 is closed with a fix, but recurrence is reported and #27279 is open.
- **llama-swap.**
  - `/props?model=` and `/upstream/<model>/props` load the model.
  - `POST /api/models/unload/{model}` unloads one model and needs the key.
  - Context fields in its `/v1/models` come only from its own config.
- **vLLM:** streams reasoning as `reasoning`; `reasoning_effort` accepts `none` to `max`.
- **OpenRouter:** streams a `reasoning_details` array.
- **LM Studio:** rejects `response_format: json_object` with a 400 (user reports); its served context is `/api/v1/models` `loaded_instances[].config.context_length`.
- **Ollama.**
  - A name contains `::` only in a host segment, which is followed by `/`.
  - `think: false` is accepted by models that do not think; `think: true` or a level returns 400 on them.
  - Levels are `low` / `medium` / `high` / `max`.
  - `format` with thinking on is enforced through a second prefill.
- **Gemini.**
  - Thought summaries are documented as "rolling, incremental summaries during generation" (documentation only).
  - Levels differ per model (§8); sending both `thinkingLevel` and `thinkingBudget` is a 400.
  - `models.list()` has `inputTokenLimit`, `outputTokenLimit`, `supportedActions` and `thinking`, but no modality field.
  - Unsupported `responseJsonSchema` keywords are documented as ignored; size limits are not published.
  - `thoughtsTokenCount` sits in `usageMetadata`, and `maxOutputTokens` includes thinking tokens.
  - `gemini-3.6-flash` and `gemini-3.5-flash-lite` each have a 65,536-token output limit.
  - Free-tier limits are not published.
- **`'local'` comparisons and `:` sites.** They are classified in the plan's table. The re-grep added `src/components/model-pull-status.tsx:294` and `src/components/setup/step-analysis.tsx:21,75-76`.

## Still owed (on-box, carried as plan gate tasks and register rows)

- How long Gemini thinking models take to their first chunk on real chapters, and whether thought parts arrive during thinking. The wave 2 on-box row measures this from the transport's logs to tune `analyzer.gemini.thinkingIdleTimeoutMs` (within its 290 s maximum); it does not gate the wave.
- Whether Gemini errors on, or ignores, `thinkingLevel` sent to a 2.5 model. The Test action records it.
- Per-model llama.cpp schema enforcement while thinking. The Test action and the live structured-output row cover it.
- Gemini's response to the largest stage schema's size and nesting. The same Test action and row cover it.
