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
  - The internal `AnalysisEngine` type (`'local' | 'gemini' | 'openai'`) and the shared id grammar (`openai:<endpointId>::<model>`, implemented once per side in `server/src/analyzer/model-id.ts` / `src/lib/model-id.ts`) landed in PR 3a. Every site that turns a selection id into an Ollama call already runs that grammar. The persisted/validated `analysisEngine` enum — `ANALYSIS_ENGINE_VALUES`, and the OpenAPI `analysisEngine` enums — still refuses `openai` and gains it only in PR 3d, once an endpoint is actually selectable. The `PERSONA_GEN_ENGINE` knob is a separate case: wave 4 made it an `analyzer-engine` knob that accepts `openai:<endpointId>::<model>` (invariant 8).
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
7. **A reasoning overflow points at the settings that fix it.** A terminal `analyzer-reasoning-overflow` error carries a structured `fixes` list (`server/src/routes/failure-taxonomy.ts`'s `reasoningOverflowFixes`). The Analysing view renders it as a "How to fix:" list in the run-level "What to do:" block, and the analysis-stream middleware pushes the same list onto a persistent notification (`src/components/reasoning-overflow-toast.tsx`, no auto-dismiss timer) — persistent because that stream, not the view's, is the one that survives navigation (`src/store/analysis-stream-middleware.ts`; `analysing.tsx`'s own stream aborts on unmount). Each entry is either an Advanced Settings deep link (`#/advanced?focus=<settingKey>`, built in `src/lib/failure-fixes.ts` and parsed by `AdvancedRoute`), a wiki link, or plain text — the label-only "Switch to a different analyzer model" entry. The Gemini thinking window (`analyzer.gemini.thinkingIdleTimeoutMs`) is never offered as a fix: it bounds silence, not output room. `fixes` rides the SSE terminal `error` event only; it is deliberately not written to the `#3004` last-outcome record, which has no reader for it.
8. **Persona generation.** A persona runs through the selected engine's transport with no cross-provider fallback (`server/src/analyzer/voice-style.ts`).
   - **Ollama:** the call stays non-streaming with a caller `keep_alive` and CPU placement. It is bounded by `PERSONA_ABSOLUTE_MAX_MS`, which starts after the analyzer slot is acquired, and the slot is released on every path (`server/src/analyzer/transports/ollama-transport.ts`, `ollama-timeout.test.ts`).
   - **Gemini:** the limiter estimate stays `ceil(prompt.length / 4) + 200`, and the persona wire carries no system instruction, temperature or output cap. It asks for no thoughts, so its `thoughtsTokenCount` is not reasoning evidence (one flag, P27).
   - **Shared card:** a persona engine that shares the Qwen card (local, or a same-card endpoint) is generated before VoiceDesign loads (`server/src/routes/cast-design.ts`).
   - **Cancellation and whole-job errors:** the design job's abort signal reaches every persona call, and a pause is a clean stop (a local persona call aborted before its first byte included). When the persona engine shares the voice card (`personaSharesGpu()`: local Ollama, an endpoint on the Qwen card, or a missing endpoint), the pre-pass ends the job once on an unreachable, missing, key-mismatched, timed-out or 401/403 persona engine. A timed-out local Ollama engine throws `AnalyzerTimeoutError` (`analyzer-timeout`, Ollama wording), so it ends the job once instead of waiting `PERSONA_ABSOLUTE_MAX_MS` per character. Every other engine (Gemini, a `gpu: 'none'` endpoint, an endpoint on another card) takes the lazy path, where each failure is a per-character `character_failed` (#3230); a missing endpoint fails before any call on either path. On the shared-GPU path a persona-less character the pre-pass did not own is reported as `character_failed`, not skipped silently.
   - **Design guard:** when the persona engine is an endpoint on the Voice engine's card and a render is streaming, every design entry point asks "Pause audio generation to design voices?": Design full cast, the profile drawer's voice-style button and Qwen auto-generate, compare-modal Regenerate, rebaseline Propose, the nudge toast and the readiness gate. **Pause and design** halts the render. Local Ollama is not asked (the server moves it to system RAM), nor are Gemini, `gpu: 'none'` and other-card endpoints. A direct API caller is unguarded, the same as analysis.
   - **Persona failure wording:** a persona failure names the Voice-style model (`VOICE_STYLE_MODEL`) and Persona generation engine settings, not analysis's. An empty Gemini reply is the empty-persona error; only a real block reason is `analyzer-content-blocked`.
   - **Failure codes:** any error that ends a design job carries its failure-taxonomy code (`auth` for a key problem), and `unknown` only when the taxonomy recognises nothing. A lazy-path persona failure does **not** end the job: since `6222e483` (#3027 second half) it is a per-character `character_failed` carrying `itemFailureReason`'s reason string, a reasoning overflow included (P20's voice-design carve-out). #3230 (closed) asked for that behaviour and that commit delivered it.

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
- **Eviction (server).** Same-card only, never while in flight, and a capacity re-probe after unload.
- **Persona generation (server and frontend).**
  - The runner's free-text path, and each transport's free-text wire shape against a stage-request control.
  - The persona engine knob's grammar, pinned to the shared id case table.
  - Selection errors before any call (missing endpoint, key origin), and endpoint wiring over a real server (key header, per-call busy registration, served-model record, served-models listing, concurrency 1).
  - The same-card rule (W3d's `endpointsSharingDevice`), the design pre-pass's wholesale errors and their codes, and the job signal reaching the persona call (a pause aborts a real in-flight endpoint request).
  - The pre-pass halt set against each transport's real timeout error (a timed-out local Ollama engine ends the job once), the lazy path staying per-character for an engine that does not share the voice card, and a persona-less character on the shared-GPU path counted as failed.
  - The design guard: the "Pause audio generation to design voices?" prompt at each design entry point for a same-card endpoint while a render streams, and none for local Ollama, Gemini, `gpu: 'none'` and other-card endpoints. A direct API caller is unguarded, so there is no server-side test for it.
  - The Advanced Settings picker.
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
5. Open Advanced configuration → Analyzer models. **Persona generation engine** lists `local`, `gemini` and the endpoint's models. Pick an endpoint model; the row shows it as overridden with Revert.

**On-box acceptance** (live structured output, thinking-model output, long silent prefill, same-card eviction, capacity recalibration) is recorded in `docs/testing/onbox-acceptance-register.md` by the PRs that ship each behaviour.
