---
status: draft
shipped: null
owner: null
---

# 284 — OpenAI-compatible analyzer endpoints and request controls (#3084)

> Status: draft. The design is approved in phases (spec, then plan), and implementation follows in waves 1–5 after wave 0 (#3139, #3141) merges.
> Key files (planned):
> - `server/src/analyzer/runner/` (stage runner, transport contract, retry policies, schema adapters, payload merge)
> - `server/src/analyzer/transports/` (Ollama, Gemini, OpenAI)
> - `server/src/analyzer/capacity.ts`, `server/src/analyzer/reasoning.ts`, `server/src/analyzer/capabilities.ts`, `server/src/analyzer/model-id.ts`
> - `server/src/workspace/analyzer-endpoints.ts`, `server/src/gpu/endpoint-eviction.ts`
> - `server/src/routes/analyzer-endpoints.ts`, `server/src/routes/analyzer-models.ts`
> - `src/lib/model-id.ts`, `src/lib/analyzer-endpoints.ts`, `src/components/model-settings-form.tsx`
>
> URL surface: indirect. It is the Model Manager analyzer settings, the analysis model pickers, and Advanced Settings.
> OpenAPI ops (planned): `getAnalyzerModels`, `createAnalyzerEndpoint`, `updateAnalyzerEndpoint`, `deleteAnalyzerEndpoint`, `putAnalyzerEndpointKey`, `detectAnalyzerEndpointContext`, `testAnalyzerModel`, plus new `UserSettings` fields.

- **Design:** [2026-09-10-openai-compatible-analyzer-design.md](../superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md)
- **Implementation plan:** [2026-09-11-openai-compatible-analyzer.md](../superpowers/plans/2026-09-11-openai-compatible-analyzer.md), with one file per wave.

## Benefit / Rationale

- **User:** a user can point analysis at any OpenAI Chat Completions-compatible server (llama.cpp / llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter) next to Ollama and Gemini. They can also control structured output, max output tokens, reasoning and provider-specific parameters, with each control's effect stated in Settings. A thinking model no longer fails silently at a hidden 8192-token cap.
- **Technical:** one stage runner replaces two drifted copies. Structured output, capacity, output caps, reasoning, rate limits and custom parameters are then written and tested once, across three transports. Typed HTTP, timeout and abort errors replace message-text matching.
- **Architectural:** it opens a `ChatTransport` seam, so a new provider is a transport rather than a third runner. The model id grammar (`openai:<endpointId>::<model>`) replaces "a colon means Ollama" at every site. GPU sharing is keyed on an endpoint's card, not the engine name.

## Architectural impact

- **New seams:**
  - `ChatTransport` with a per-transport `ValidationRetryPolicy`.
  - `EngineCapacity` descriptors, which the chunk-budget resolvers take in place of an engine name.
  - `analyzerEndpoints` and origin-bound `analyzerEndpointKeys` in user settings.
  - Model capability records from the Test action.
  - `evictEndpoints` in TTS capacity retry.
- **Invariants preserved:**
  - Wave 1 keeps every current failure-taxonomy outcome.
  - Ollama keeps its long-call dispatcher and unreachable classification.
  - `FallbackAnalyzer` still falls back only on "unreachable".
  - Keys are never returned by GET, as with the Gemini key.
  - No endpoint is selectable before its sizing, GPU coordination and concurrency exist.
- **Migration:**
  - The `analysisEngine` enum gains `openai`.
  - `analyzer.gemini.maxOutputTokens` gains `0` = Auto as its default; an explicit value keeps its meaning.
  - The six `rate.*.gemma*` knobs move into `analyzerRateLimitsByModel`.
  - `analyzer.personaGeneration.engine` accepts endpoint model ids.
- **Reversibility:** each wave is its own PR set.
  - Waves 1–2 are behaviour-preserving apart from the `<think>` strip, Gemini Auto output and reasoning overflow.
  - Endpoints become selectable only in PR 3d, so reverting 3d hides them without data loss.

## Invariants to preserve

1. **Ollama long-call dispatcher.** Ollama calls keep `ANALYZER_DISPATCHER`: no header or body timeout, 10 s connect timeout (`server/src/analyzer/ollama.ts:129-133`).
2. **Abort handling.** `FallbackAnalyzer` rethrows `AnalysisAbortedError` and falls back only on the unreachable error class (`server/src/analyzer/index.ts:257-406`).
3. **Gemini key privacy.** The Gemini key is stripped from GET and forbidden in the general PUT (`server/src/routes/user-settings.ts:44-66`, `server/src/workspace/user-settings.ts:450-467`). Endpoint keys follow the same rule.
4. **Ollama 5xx outcome.** An Ollama 5xx keeps its pre-wave-1 taxonomy outcome, pinned by wave 1's characterisation test. The plan-29 rule applies: reachable-but-misbehaving must not read as unreachable (`server/src/analyzer/index.ts:251-256`).
5. **Chunk budgets.** Budgets for today's engines stay byte-identical to the pinning fixture captured from `main` before wave 2 (`server/src/analyzer/stage1-chunk.ts:95-125`, `stage2-chunk.ts:70`, `chapter-chunker.ts:130-139`).
6. **In-flight eviction.** TTS eviction never unloads an analyzer model while a call that shares a GPU is in flight (`server/src/gpu/capacity-retry.ts:273-290`, `server/src/tts/sidecar.ts:191-194`).

## Test plan

### Automated coverage

The full list is in the implementation plan; each wave's tasks name their test files. In summary:

- **Characterisation (server, before wave 1).** Pins the Ollama and Gemini retry-policy differences, and the taxonomy outcomes for Ollama 400/404/500/503.
- **Transport contract suite (server).** Runs over a real `http.createServer` and a real undici `Agent`. It asserts the error class for:
  - refused, unroutable and stalled connections;
  - long silent prefill, and header-then-silence;
  - caller abort, a socket drop mid-stream, and an in-stream error event;
  - a missing `finish_reason`, and reasoning deltas.
- **Pure functions (server and frontend).**
  - The id grammar case table, shared by server and frontend.
  - Schema adapters with `dropped` snapshots.
  - Capacity pinning, Auto output tokens, and reasoning level tables.
  - Payload merge, protected keys and redaction.
  - Key-origin matching.
- **Routes (server).** Endpoint CRUD refusals, the key write, Detect, the catalog, and the Test action's `enforced` / `ignored` / `rejected` records.
- **Eviction (server).** Same-card only, never while in flight, the latch shared with Ollama, and a capacity re-probe after unload.
- **E2E (Playwright, mock mode).**
  - Add an endpoint and pick its model; the label shows the structured-output state and "+ custom params".
  - The GPU guard prompts for a same-card endpoint only.
  - A host change prompts for the key.

### Manual acceptance walkthrough

These run in mock mode (`npm run dev:mock`) once PR 3d has merged.

1. Open the Model Manager. The analyzer settings show an **Endpoints** section with **Add endpoint**.
2. Add an endpoint with base URL `http://127.0.0.1:8080/v1` and no context size. Save is refused with "Context size is required". Enter `32768` and save. The endpoint's GPU defaults to "Any card".
3. Open the analysis model picker. An endpoint group lists its models. Picking one sets the id `openai:<endpointId>::<model>`.
4. Change the endpoint's host to `http://192.168.1.20:8080/v1`. The form asks for the API key again.

**On-box acceptance** (live structured output, thinking-model output, long silent prefill, same-card eviction, capacity recalibration) is recorded in `docs/testing/onbox-acceptance-register.md` by the PRs that ship each behaviour.
