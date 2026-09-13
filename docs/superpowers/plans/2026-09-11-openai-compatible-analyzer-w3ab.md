# OpenAI-compatible analyzer — Wave 3 (PRs 3a, 3b) plan

> Part of the [OpenAI-compatible analyzer implementation plan](2026-09-11-openai-compatible-analyzer.md). Read that file first: its Global Constraints, planning decisions (P1–P25) and interface contract bind every task below. Spec: [2026-09-10-openai-compatible-analyzer-design.md](../specs/2026-09-10-openai-compatible-analyzer-design.md).

## Wave 3 — Endpoints become selectable (this section: PRs 3a and 3b)

This section covers PRs **3a** (engine value + id grammar) and **3b** (endpoints, keys, OpenAI transport, structured output, failure codes). PRs 3c/3d are drafted separately. Nothing in 3a or 3b makes an endpoint selectable in any picker, saved default or env-accepted value (Global Constraints).

**How to read the citations.** `file:line` references are to `origin/main` 46e62a34. Files that waves 1–2 create (`server/src/analyzer/runner/*`, `server/src/analyzer/transports/*`, `server/src/analyzer/capacity.ts`, `server/src/analyzer/reasoning.ts`) do not exist on that commit, so they are cited **by symbol**, marked **(W1)** / **(W2)**. Before each task, re-read every cited line on current `main`: waves 0–2 touch `user-settings.ts`, `select-analyzer.ts`, `rate-limit.ts`, `gemini.ts`, `ollama.ts`, and the analysing view.

**Wave 1–2 names this section consumes, verbatim from the contract:**
- `server/src/analyzer/errors.ts`: `TransportKind`, `AnalysisAbortedError`, `AnalyzerUnreachableError(message, transport, cause?)`, `AnalyzerHttpError(transport, httpStatus, bodyExcerpt, message)`, `AnalyzerTruncatedError`.
- `runner/transport.ts`: `ChatMessage`, `StructuredOutputMode`, `StructuredOutputRequest`, `TransportRequest`, `TransportResult`, `TransportUsage`, `ChatTransport`.
- `runner/retry-policy.ts`: `ValidationRetryPolicy`, `OLLAMA_RETRY_POLICY`, `GEMINI_RETRY_POLICY`.
- `runner/transport-retry.ts`: `withTransportRetry`, `RetryClassifier`, `RetryDisposition`.
- `runner/stage-runner.ts`: `StageRunner`, `StageSpec`, `EngineRequestSettings`, `TransportAnalyzer`.
- `runner/parse.ts`: `buildRetryMessage`, `ParseResult`.
- `transports/ollama-transport.ts` `OllamaTransport`, and `transports/gemini-transport.ts` `GeminiTransport`.

---

### PR 3a — engine value + id grammar (nothing selectable)

**Branch:** `refactor/server-3084-w3a-engine-ids`
Create the worktree with `node scripts/wt-new.mjs refactor/server-3084-w3a-engine-ids`, off the latest `main`.
(`scripts/lib/branch-name.mjs` accepts a single scope per branch — the PR title and its commits
below keep their multi-scope `refactor(server,frontend): …` form; only the branch name is single-scope.)

**What it delivers.**
- `AnalysisEngine = 'local' | 'gemini' | 'openai'` at every analyzer-engine **type** site.
- One id grammar, implemented twice — `server/src/analyzer/model-id.ts` and `src/lib/model-id.ts` — driven by one shared case table.
- Every site that turns a **selection id** into an Ollama call now uses that inference, so an `openai:<endpointId>::<model>` id can never reach Ollama.
- **Nothing can select an endpoint before PR 3d (P23).**
  - Selection throws `AnalyzerEndpointMissingError` for an endpoint id, with the source it came from (`env` for `ANALYZER_PHASE{0,1}_MODEL`, `run-pick` for a request's model, `settings` for a saved phase model or a saved default). A saved endpoint default is never swapped for Ollama's default model (Task 3a.2).
  - The general settings PUT and `PUT /api/config` refuse an `openai:` id in `defaultAnalysisModel`, `analyzerPhase0Model`, `analyzerPhase1Model` and the `analyzer.phase0.model` / `analyzer.phase1.model` overrides (Task 3a.5). The mock PUT mirrors the refusal.
- The `'local'` comparison classification table below (spec §1 last bullet), recorded as the design of record.

**What it must NOT change.**
- **Persisted/validated inputs still refuse `'openai'`.** Three sites keep rejecting it until PR 3d (the former fourth, the `analyzer.engine` registry enum, was removed by #3200 / PR #3201 before this wave):
  - `ANALYSIS_ENGINE_VALUES` (`server/src/workspace/user-settings.ts:98`, used at `:141`);
  - the `PERSONA_GEN_ENGINE` enum (`registry.ts:1187`);
  - the OpenAPI `analysisEngine` enums (`openapi.yaml:4628`, `:4831`), and so the regenerated `src/lib/api-types.ts`.
- **No request changes.** No Ollama or Gemini request changes for any id that doesn't match `^openai:[a-z0-9-]+::`.
- **Budget resolvers untouched.** No budget resolver (wave 2 owns them) and no picker contents change.
- **No new FailureCode, knob, route, or OpenAPI change.** `AnalyzerEndpointMissingError` is added in this PR (Task 3a.2) so that selection can throw it. Its FailureCode `analyzer-endpoint-missing` arrives in PR 3b (Task 3b.1). Until then it classifies as `unknown`, and no UI can reach it.

**Entry criteria.**
- #3139 (PR #3163) and #3141 (re-verify #3168) are merged.
- #3200 (PR #3201) is merged: the `analyzer.engine` registry knob and env `ANALYZER` are gone, and `src/views/advanced.tsx`'s Ollama-device block reads `account.analysisEngine`. Confirm with `git grep -n "analyzer.engine'" -- server/src src`, which must print nothing. Re-read every `registry.ts` and `advanced.tsx` line cited below, because #3201 shifted them.
- Waves 1 and 2 are merged, and `main` is green.

**Exit criteria.** All of these pass on the branch:
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run test:server`

Also required:
- The PR body carries the Task 3a.4 sweep output, with every hit classified.
- The test `refuses analysisEngine "openai" until endpoints are selectable` is green, and its mutation proof is pasted in the PR.
- The P23 refusal tests of Tasks 3a.2 and 3a.5 are green, and their mutation proofs are pasted in the PR.

#### Which engine-literal sites widen in 3a, and which flip in 3d

| Widens in 3a (TypeScript types and non-persisted validation) | Keeps rejecting `'openai'` until PR 3d (persisted/validated inputs) |
|---|---|
| `server/src/analyzer/index.ts:181` (`AnalyzerSelection.engine`) | `server/src/workspace/user-settings.ts:98,141` (`ANALYSIS_ENGINE_VALUES` — validates `user-settings.json` and the general PUT) |
| `server/src/store/analysis-state.ts:52`, `server/src/workspace/active-analyses.ts:47` (run snapshots) | `server/src/config/registry.ts:1181-1191` (`PERSONA_GEN_ENGINE` enum) |
| `server/src/routes/analysis.ts:561` (`engineLabel` param), `:1215` (`engineFallbackMsPerChar` param), `:2655` (`AnalysisJobState.engine`) | `openapi.yaml:4628` (`UserSettings.analysisEngine`) and `:4831` (`UserSettingsPatch.analysisEngine`) + regenerated `api-types.ts` |
| `server/src/routes/setup-diagnosis.ts:309`, `server/src/routes/models-inventory.ts:120` | |
| `server/src/workspace/user-settings.ts:975` (`getResolvedAnalysisEngine` **return type only**) | |
| `src/lib/models.ts:16,108,179`; `src/lib/types.ts:578,606`; `src/store/analysis-slice.ts:33`; `src/store/analysis-substage-reducers.ts:31`; `src/store/analysis-substage-selectors.ts:43`; `src/store/prosody-slice.ts:35`; `src/components/status-popover.tsx:74`; `src/components/top-bar.tsx:233`; `src/views/analysing.tsx:344` | |
| `src/lib/api.ts:3041` (type) and `:3055` (validates a **server SSE event**, not a persisted input) | |

There are **no zod enums used only for TypeScript types**. The only analyzer-engine zod enum (`user-settings.ts:141`) validates persisted data, so it stays narrow.

The OpenAPI `UserSettingsPatch.analysisEngine` staying narrow is what leaves `src/components/model-settings-form.tsx:112,498` unchanged. It also forces the one-line narrowing at `src/components/setup/step-defaults.tsx:97` (Task 3a.3), which PR 3d removes.

#### `'local'` comparison classification (spec §1, last bullet)

Every row of research Inventory 1 appears below, plus the sites the scout missed (marked **NEW**), which a fresh grep over `src`, `server/src` and `openapi.yaml` found.

**Classification key:**
- **type** — widen the union.
- **coercion** — the value is inferred or defaulted from an id.
- **ollama-specific** — talks to, or describes, the Ollama daemon; stays on the engine value.
- **gemini-specific** — the same, for Gemini.
- **shares-gpu** — must read the endpoint's decision-4 `gpu`.
- **budget** — a chunk-size resolver.
- **persisted** — a validated saved or request input.
- **label** — user-visible naming only.
- **persona** — wave 4.

TTS uses are excluded at the bottom of the table.

| # | Site (origin/main) | Code | Classification | Changed in | Reason |
|---|---|---|---|---|---|
| 1 | `openapi.yaml:4628` | `enum: [local, gemini]` | persisted (response mirror) | PR 3d | GET echoes the stored enum; it can't hold `openai` before 3d |
| 2 | `openapi.yaml:4831` | `enum: [local, gemini]` | persisted | PR 3d | general PUT request enum |
| 3 | `server/src/workspace/user-settings.ts:98,141` | `ANALYSIS_ENGINE_VALUES` | persisted | PR 3d | 3a adds the refusal test |
| 4 | `server/src/config/registry.ts:1121-1129` **NEW** | `analyzer.engine` `options: ['local','gemini']` | removed by #3200 (PR #3201); the device block reads `account.analysisEngine === 'local'`, which already hides it for `openai`; no change | PR #3201 (before this wave) | the knob had no server reader; its only reader was `advanced.tsx:293` (row 48) |
| 5 | `server/src/config/registry.ts:1181-1191` **NEW** | `PERSONA_GEN_ENGINE` enum | persisted | PR 3d / wave 4 | see report: decision 10 turns this into a model-id-style value, not an `'openai'` literal |
| 6 | `src/lib/models.ts:16` | `ModelOption.engine` | type | 3a (Task 3a.3) | catalogs (3c) add endpoint options |
| 7 | `src/lib/models.ts:108-110` | `engineForModelId` | coercion | 3a (Task 3a.3) | delegates to `src/lib/model-id.ts` |
| 8 | `src/lib/models.ts:117` **NEW** | `localRunModelIds` `=== 'local'` | ollama-specific | unchanged code (shared inference excludes endpoint ids from 3a) | it lists the models whose Ollama residency is checked |
| 9 | `src/lib/models.ts:158,187,197` **NEW** | curated `m.engine === 'local'` / `'gemini'` filters | ollama-/gemini-specific | unchanged | curated static catalog; endpoint groups come from catalogs (3c/3d) |
| 10 | `src/lib/models.ts:178-179` **NEW** | group `engine` type | type | 3a (Task 3a.3) | |
| 11 | `src/lib/types.ts:578` | analysis-pill snapshot `engine?` | type | 3a (Task 3a.3) | |
| 12 | `src/lib/types.ts:606` | analysis snapshot `engine?` (verified: analyzer engine for the reverse guard, comment `:601-605`) | type | 3a (Task 3a.3) | 3d adds `gpu` |
| 13 | `server/src/analyzer/index.ts:181` | `AnalyzerSelection.engine` | type | 3a (Task 3a.2) | |
| 14 | `server/src/analyzer/index.ts:195-197` | `inferEngineFromModelId` | coercion | 3a (Task 3a.2) | imported from `model-id.ts` |
| 15 | `server/src/analyzer/index.ts:206` | `engine === 'local'` → `OllamaAnalyzer` | ollama-specific | unchanged; 3a adds a refusing `openai` branch above it, 3d replaces the refusal with `OpenAIAnalyzer` | an `openai` id must not reach this branch |
| 16 | `server/src/analyzer/index.ts:234-235` | gemini branch | gemini-specific | unchanged | after 3a `openai` no longer falls through to it |
| 17 | `server/src/analyzer/stage1-chunk.ts:73-76,100` | `engine !== 'local'` | budget | already capacity-based after wave 2 (PR 2a) | endpoint capacity branch is PR 3c |
| 18 | `server/src/analyzer/stage2-chunk.ts:62-65,70-72` | `engine !== 'local'` | budget | already capacity-based after wave 2 (PR 2a) | |
| 19 | `server/src/analyzer/chapter-chunker.ts:131-136` **NEW** | `engine === 'local'` | budget | already capacity-based after wave 2 (PR 2a) | |
| 20 | `server/src/analyzer/attribution-eval/review-run.ts:47` **NEW** | `engine: 'local' \| 'gemini'` | budget pass-through | wave 2 (PR 2a); widen in 3a only if `npm run typecheck` reports it | feeds `chapterChunkBudget` |
| 21 | `server/src/routes/analysis.ts:2212` | `engine?: 'gemini' \| 'local'` | budget pass-through | wave 2 (PR 2a); widen in 3a only if typecheck reports it | feeds the stage-2 budget |
| 22 | `server/src/analyzer/voice-style.ts:61-62` | `resolvePersonaEngine` | coercion (persona) | wave 4 | decision 10 |
| 23 | `server/src/analyzer/voice-style.ts:177` | persona dispatch | persona | wave 4 | decision 10 |
| 24 | `server/src/routes/cast-design.ts:292,509` **NEW** | `resolvePersonaEngine() !== 'local'` / `=== 'local'` | shares-gpu (local persona pre-pass runs before VoiceDesign) | wave 4 | an endpoint persona with `gpu !== 'none'` joins the pre-pass |
| 25 | `server/src/tts/persona-gpu-plan.ts:57` **NEW** | `resolvePersonaEngine() !== 'local'` | shares-gpu | wave 4 | same |
| 26 | `server/src/routes/analysis.ts:561-562` | `engineLabel` | label | 3a (Task 3a.2) adds the `openai` branch; 3d swaps endpoint id for endpoint name | |
| 27 | `server/src/routes/analysis.ts:1214-1218` | `engineFallbackMsPerChar` | shares-gpu (local-device ETA seed) | 3a widens the param; PR 3d picks the local rate for `gpu !== 'none'` | today an endpoint would get the Gemini rate |
| 28 | `server/src/routes/analysis.ts:2655` | `AnalysisJobState.engine` | type | 3a (Task 3a.2) | |
| 29 | `server/src/routes/analysis.ts:3235` **NEW** | `job.engine === 'local'` → `unloadResidentOllama` | ollama-specific | unchanged | endpoints unload only through decision-4 eviction (3d) |
| 30 | `server/src/routes/analysis.ts:3716` **NEW** | `usesLocalAnalyzer` → `detectOllamaDevice` | ollama-specific | unchanged | probes Ollama's device only |
| 31 | `server/src/routes/script-review.ts:748` **NEW** | warm Ollama model | ollama-specific | unchanged | |
| 32 | `server/src/routes/script-review.ts:798` **NEW** | `pinnedLocal` → Ollama keep-alive pin | ollama-specific | unchanged | `keepAliveFor` is Ollama's |
| 33 | `server/src/routes/diagnostics.ts:259` **NEW** | Ollama diagnostics row | ollama-specific | unchanged | |
| 34 | `server/src/routes/diagnostics.ts:299` **NEW** | Gemini diagnostics row | gemini-specific | unchanged | |
| 35 | `server/src/routes/setup-diagnosis.ts:309` **NEW** | `AnalyzerDiagnosisInput.engine` | type | 3a (Task 3a.2) | |
| 36 | `server/src/routes/setup-diagnosis.ts:323` **NEW** | `engine === 'gemini'` else Ollama checks | persisted-engine readiness gate | PR 3d | unreachable until `analysisEngine` can be `openai`; then an endpoint needs its own branch |
| 37 | `server/src/routes/setup-readiness.ts:204` **NEW** | `getResolvedAnalysisEngine() === 'gemini'` | persisted-engine readiness gate | PR 3d | same |
| 38 | `server/src/routes/models-inventory.ts:120` **NEW** | `InventoryDeps.analysisEngine` | type | 3a (Task 3a.2) | |
| 39 | `server/src/routes/models-inventory.ts:382` **NEW** | `analysisEngine === 'local' && tagMatches(...)` | ollama-specific | unchanged | marks which Ollama tag is the default |
| 40 | `server/src/workspace/active-analyses.ts:47` | snapshot `engine?` | type | 3a (Task 3a.2) | |
| 41 | `server/src/store/analysis-state.ts:52` **NEW** | snapshot `engine?` | type | 3a (Task 3a.2) | |
| 42 | `server/src/workspace/user-settings.ts:975-977` | `getResolvedAnalysisEngine` | coercion | 3a return type; PR 3d body (with the enum flip) | the body can't compare to `'openai'` while the stored type is narrow |
| 43 | `src/store/analysis-slice.ts:33` | `AnalysisStreamSnapshot.engine` | type (shares-gpu snapshot) | 3a type; PR 3d adds `gpu` | |
| 44 | `src/store/analysis-substage-reducers.ts:31`, `src/store/analysis-substage-selectors.ts:43` | substage `engine?` | type | 3a (Task 3a.3) | |
| 45 | `src/store/prosody-slice.ts:35` | `engine?` (verified: analyzer backend, "flips to 'gemini' on a mid-pass fallback") | type | 3a (Task 3a.3) | |
| 46 | `src/views/analysing.tsx:340` | `isLocalAnalyzer` | ollama-specific (Ollama health/residency gating) | unchanged; shared inference excludes endpoint ids | |
| 47 | `src/views/analysing.tsx:344` | `effectiveEngine` | shares-gpu (snapshot engine for the reverse guard) | 3a type; PR 3d derives endpoint engine + `gpu` | today a non-local id is tagged `'gemini'` |
| 48 | `src/views/advanced.tsx:293`, `:556` | `analyzerEngine = values['analyzer.engine']?.effective` → `group.id === 'analyzer-models' && analyzerEngine === 'local'` | removed by #3200 (PR #3201); the device block reads `account.analysisEngine === 'local'`, which already hides it for `openai`; no change | PR #3201 (before this wave) | it renders only the read-only "Analyzer (Ollama) device" row (`:557-590` on 46e62a34) |
| 49 | `src/components/model-settings-form.tsx:112,498` | engine select bound to `account.analysisEngine` | persisted-input UI | PR 3d | bound to the narrow stored enum |
| 50 | `src/components/status-popover.tsx:74` | `engine?` | type | 3a (Task 3a.3) | |
| 51 | `src/components/status-popover.tsx:164` **NEW** | `=== 'gemini' ? 'Gemini' : 'Ollama'` | label | 3a (Task 3a.3) | an endpoint must not read "Ollama" |
| 52 | `src/components/top-bar.tsx:233` | `engine?` | type | 3a (Task 3a.3) | |
| 53 | `src/hooks/use-local-analyzer-guard.tsx:78-81` | `engine !== 'local'` | shares-gpu | PR 3d | forward guard |
| 54 | `src/hooks/use-reverse-local-analyzer-guard.tsx:76` | `activeStream?.engine === 'local'` | shares-gpu | PR 3d | reverse guard |
| 55 | `src/store/generation-stream-middleware.ts:102` | `analysisSnap.engine === 'local'` | shares-gpu | PR 3d | auto-generation hold |
| 56 | `src/views/generation.tsx:422,591` **NEW** | `engineForModelId(selectedAnalyzerModelId)` into `setActiveStream` | shares-gpu snapshot capture | 3a via shared inference; PR 3d adds `gpu` | |
| 57 | `src/components/setup/step-defaults.tsx:97-98` **NEW** | derives and **saves** `analysisEngine` from the id | persisted input | 3a compile-forced narrowing; PR 3d removes it | the patch type is still `'local' \| 'gemini'` |
| 58 | `src/lib/api.ts:3041` | `SubstagePhaseEvent.engine?` | type | 3a (Task 3a.3) | |
| 59 | `src/lib/api.ts:3055` | SSE engine validation | type/validation of a server event | 3a (Task 3a.3) | not a persisted input |
| 60 | tests: `server/src/routes/analysis.test.ts:3198,3263`, `annotate-emotion.test.ts:34`, `instruct-annotation.test.ts:34`, `script-review.test.ts:48`, `server/src/workspace/active-analyses.test.ts:49`, `server/src/tts/prepare-persona-batch.test.ts:14`, `src/lib/models.test.ts:50,109-110,117`, `src/hooks/use-local-analyzer-guard.test.tsx:148-150` | fixtures | type | widen only where `npm run typecheck` requires | narrower literals assign into the wider union |
| 61 | `server/src/analyzer/attribution-eval/run-eval.ts:214` on 46e62a34; on `origin/main` after #3199 it is `:190`, before the stage-2 call **NEW** | `const chunkEngine = opts.engine === 'qwen' ? 'local' : 'gemini';` (ternary coercion) | coercion (eval-only budget pass-through) | unchanged in 3a; if wave 2 (PR 2a) already replaced its consumer with a capacity descriptor, the Task 3a.4 sweep finds no hit | it maps the eval CLI's own engine names (`qwen` / `gemma`, `run-eval.ts:178`), not a model id, onto a chunk-budget engine; the eval never runs an endpoint |
| — | **Excluded (TTS or non-analyzer)** | | | | |
| — | `src/lib/tts-models.ts:12,187` | `TtsEngineId`, TTS key → engine | TTS | — | TTS engine group |
| — | `src/components/layout.tsx:1189`, `src/store/engines-in-use-selector.ts:33`, `src/lib/play-sample-with-auto-load.ts:61,180`, `src/lib/tts-voice-mapping.ts:307,314` | TTS pills / voices | TTS | — | |
| — | `server/src/tts/*`, `server/src/routes/voices.ts:213,823`, `voice-sample.ts:50`, `server/src/workspace/scan.ts:535` | TTS engines | TTS | — | |
| — | `server/src/workspace/user-settings.ts:97,124` | `TTS_ENGINE_VALUES` / `defaultTtsEngine` | TTS | — | |
| — | `server/src/routes/failure-taxonomy.ts:275` | `ctx.engine !== 'gemini'` | TTS | — | `ctx.engine` is only set by `classifyFailure(err, engine)` on the generation path; the analysis scan passes none (`:386`) |
| — | `src/components/character-search-picker.tsx:106,141` | `row.kind === 'local'` | not an engine | — | |

---

### Task 3a.1: Shared model-id grammar (server + frontend + one case table)

**Files:**
- Create: `server/src/analyzer/model-id.ts`
- Create: `server/src/analyzer/__fixtures__/model-id-cases.json`
- Create: `server/src/analyzer/model-id.test.ts`
- Create: `src/lib/model-id.ts`
- Create: `src/lib/model-id.test.ts`

**Interfaces:**
- Consumes: nothing. Both modules are leaves with no imports, so any layer can import them without closing a cycle.
- Produces (contract):
  - `AnalysisEngine`;
  - `inferEngineFromModelId(id)` on the server, `engineForModelId(id)` on the frontend;
  - `parseEndpointModelId(id)`;
  - `endpointModelId(endpointId, model)`.
- Produces (additional, used by Tasks 3b.5 and 3b.8): `ENDPOINT_ID_PATTERN` (server and frontend).

**Tests kept green:** none touched. The modules have no consumers yet; Task 3a.2/3a.3 wire them.

- [ ] **Step 1: Write the case table and the failing tests**

`server/src/analyzer/__fixtures__/model-id-cases.json`:
```json
[
  { "id": "qwen3.5:4b", "engine": "local" },
  { "id": "gemma-4-E4B-it-GGUF:UD-Q4_K_XL", "engine": "local" },
  { "id": "hf.co/unsloth/Qwen3-GGUF:Q4_K_M", "engine": "local" },
  { "id": "openai:latest", "engine": "local" },
  { "id": "openai:Lab::qwen3", "engine": "local" },
  { "id": "openai:lab_1::qwen3", "engine": "local" },
  { "id": "openai:::qwen3", "engine": "local" },
  { "id": "openai:lab:qwen3", "engine": "local" },
  { "id": "gemini-3.6-flash", "engine": "gemini" },
  { "id": "gemma-4-31b-it", "engine": "gemini" },
  { "id": "openai", "engine": "gemini" },
  { "id": "llama2", "engine": "gemini" },
  { "id": "openai:lab::qwen3:30b", "engine": "openai", "endpointId": "lab", "model": "qwen3:30b" },
  { "id": "openai:lab::qwen3-30b", "engine": "openai", "endpointId": "lab", "model": "qwen3-30b" },
  { "id": "openai:my-box-2::org/model-name", "engine": "openai", "endpointId": "my-box-2", "model": "org/model-name" },
  { "id": "openai:a::b::c", "engine": "openai", "endpointId": "a", "model": "b::c" },
  { "id": "openai:lab::", "engine": "openai", "endpointId": "lab", "model": "" },
  { "id": "openai:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa::m", "engine": "openai", "endpointId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "model": "m" }
]
```
The last entry has a 41-character endpoint id. Inference does not length-check; building such an id is refused, and a 41-character id can never be saved (Task 3b.5).

`server/src/analyzer/model-id.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  inferEngineFromModelId,
  parseEndpointModelId,
  endpointModelId,
  ENDPOINT_ID_PATTERN,
  type AnalysisEngine,
} from './model-id.js';

interface Case {
  id: string;
  engine: AnalysisEngine;
  endpointId?: string;
  model?: string;
}

/* Read, not imported: NodeNext would require an import attribute for JSON, and
   the frontend test imports the same file by relative path. */
const CASES: Case[] = JSON.parse(
  readFileSync(new URL('./__fixtures__/model-id-cases.json', import.meta.url), 'utf8'),
);

describe('model-id grammar — server (#3084 spec §3)', () => {
  it('the shared case table covers all three engines', () => {
    expect(new Set(CASES.map((c) => c.engine))).toEqual(new Set(['local', 'gemini', 'openai']));
  });

  it.each(CASES)('infers $engine for $id', (c) => {
    expect(inferEngineFromModelId(c.id)).toBe(c.engine);
  });

  it.each(CASES)('parses $id', (c) => {
    const parsed = parseEndpointModelId(c.id);
    if (c.engine === 'openai') expect(parsed).toEqual({ endpointId: c.endpointId, model: c.model });
    else expect(parsed).toBeNull();
  });

  it.each(
    CASES.filter(
      (c) => c.engine === 'openai' && ENDPOINT_ID_PATTERN.test(c.endpointId!) && c.model !== '',
    ),
  )('round-trips $id through endpointModelId', (c) => {
    expect(endpointModelId(c.endpointId!, c.model!)).toBe(c.id);
  });

  it('refuses to build an id with an invalid endpoint id or an empty model', () => {
    expect(() => endpointModelId('Lab', 'm')).toThrow(/Invalid endpoint id/);
    expect(() => endpointModelId('lab_1', 'm')).toThrow(/Invalid endpoint id/);
    expect(() => endpointModelId('a'.repeat(41), 'm')).toThrow(/Invalid endpoint id/);
    expect(() => endpointModelId('lab', '')).toThrow(/non-empty model/);
  });
});
```

`src/lib/model-id.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import cases from '../../server/src/analyzer/__fixtures__/model-id-cases.json';
import {
  engineForModelId,
  parseEndpointModelId,
  endpointModelId,
  type AnalysisEngine,
} from './model-id';
import * as server from '../../server/src/analyzer/model-id';

interface Case {
  id: string;
  engine: AnalysisEngine;
  endpointId?: string;
  model?: string;
}
const CASES = cases as Case[];

describe('model-id grammar — frontend (shared case table with the server)', () => {
  it.each(CASES)('infers $engine for $id', (c) => {
    expect(engineForModelId(c.id)).toBe(c.engine);
  });

  it.each(CASES)('parses $id', (c) => {
    const parsed = parseEndpointModelId(c.id);
    if (c.engine === 'openai') expect(parsed).toEqual({ endpointId: c.endpointId, model: c.model });
    else expect(parsed).toBeNull();
  });

  it('agrees with the server implementation on every table id and its near-misses', () => {
    const probes = CASES.flatMap((c) => [c.id, `${c.id}:`, `x${c.id}`, c.id.toUpperCase(), c.id.replace('::', ':')]);
    for (const id of probes) {
      expect(engineForModelId(id), id).toBe(server.inferEngineFromModelId(id));
      expect(parseEndpointModelId(id), id).toEqual(server.parseEndpointModelId(id));
    }
  });

  it('builds the same endpoint id as the server', () => {
    expect(endpointModelId('lab', 'qwen3:30b')).toBe(server.endpointModelId('lab', 'qwen3:30b'));
    expect(() => endpointModelId('Lab', 'm')).toThrow(/Invalid endpoint id/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail for the right reason**

```bash
npm --prefix server run test -- src/analyzer/model-id.test.ts
npx vitest run src/lib/model-id.test.ts
```

**Expected:** both FAIL with `Failed to resolve import "./model-id.js"` (server) / `"./model-id"` (frontend).

**If the frontend error names the JSON path instead of `./model-id`**, the relative JSON import is not resolvable. The root `tsconfig.json:13` has `resolveJsonModule: true`, and vitest's root is the repo root, so this is not expected. In that case, replace the JSON import line with this, and re-run:
```ts
import { readFileSync } from 'node:fs';
const cases: unknown = JSON.parse(
  readFileSync(new URL('../../server/src/analyzer/__fixtures__/model-id-cases.json', import.meta.url), 'utf8'),
);
```
Record which form was used in the PR body.

- [ ] **Step 3: Implement**

`server/src/analyzer/model-id.ts`:
```ts
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
```

`src/lib/model-id.ts`:
```ts
/* Frontend twin of server/src/analyzer/model-id.ts (#3084 spec §3). Both are
   driven by server/src/analyzer/__fixtures__/model-id-cases.json, and
   model-id.test.ts asserts the two agree on every table id and near-miss.
   Change both files and the table together. Leaf module — no imports. */

export type AnalysisEngine = 'local' | 'gemini' | 'openai';

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
```

- [ ] **Step 4: Run and confirm both pass**

```bash
npm --prefix server run test -- src/analyzer/model-id.test.ts
npx vitest run src/lib/model-id.test.ts
```
Expected: PASS.

- [ ] **Step 5: Mutation proofs**

Two proofs, each run on both suites:
1. **Inference order.** In `server/src/analyzer/model-id.ts` `inferEngineFromModelId`, swap the two lines so `id.includes(':')` is tested first.
   - Server run: expect red on `infers openai for openai:lab::qwen3:30b`.
   - Frontend run: expect red on `agrees with the server implementation…`.
   - Restore.
2. **Endpoint-id character class.** In `src/lib/model-id.ts`, change `[a-z0-9-]+` to `[a-zA-Z0-9_-]+` in `ENDPOINT_MODEL_ID`.
   - Frontend run: expect red on `infers local for openai:Lab::qwen3` and on `agrees with the server implementation…`.
   - Restore.

Paste both red outputs in the PR.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/model-id.ts server/src/analyzer/model-id.test.ts server/src/analyzer/__fixtures__/model-id-cases.json src/lib/model-id.ts src/lib/model-id.test.ts
git commit -m "refactor(server,frontend): add shared analyzer model-id grammar and case table"
```

---

### Task 3a.2: Server engine union, endpoint-id refusal in selection (P23), label

**Files:**
- Modify: `server/src/analyzer/errors.ts` (W1) — append `AnalyzerEndpointMissingError`
- Modify: `server/src/analyzer/index.ts:23-30` (imports), `:163-174` (`SelectAnalyzerOptions` gains `modelSource`), `:176-197` (selection type and private inference), `:199-209` (insert the refusal branch and the saved-default check)
- Modify: `server/src/analyzer/select-analyzer.ts:74-77`, `:82`, `:92` (comment made false; pass `modelSource`)
- Modify: `server/src/workspace/user-settings.ts:967-977`
- Modify: `server/src/store/analysis-state.ts:52`
- Modify: `server/src/workspace/active-analyses.ts:47`
- Modify: `server/src/routes/analysis.ts:557-563` (`engineLabel`, now exported), `:1214-1216`, `:2655`
- Modify: `server/src/routes/setup-diagnosis.ts:309`
- Modify: `server/src/routes/models-inventory.ts:120`
- Test: `server/src/analyzer/select-analyzer-endpoint-id.test.ts` (new)
- Test: `server/src/routes/analysis-engine-label.test.ts` (new)
- Test: `server/src/routes/user-settings.test.ts` (add one case)

**Interfaces:**
- Consumes: `inferEngineFromModelId`, `parseEndpointModelId`, and `AnalysisEngine` from `server/src/analyzer/model-id.ts`.
- Produces:
  - `AnalyzerSelection.engine: AnalysisEngine`;
  - `getResolvedAnalysisEngine(): AnalysisEngine`;
  - `export function engineLabel(engine: AnalysisEngine, modelId: string): string`;
  - `export class AnalyzerEndpointMissingError(endpointId, source: 'settings' | 'env' | 'run-pick' | 'persona')` — the contract class. **Contract wave-tag change (reported):** the contract tags it 3b; it is born here, because selection must throw it from PR 3a on (P23). Task 3b.1 adds its FailureCode and does not re-add the class.
  - `SelectAnalyzerOptions.modelSource?: 'env' | 'run-pick' | 'settings'` — where `opts.model` came from. `selectAnalyzerForPhase` sets it; any other caller that passes `model` gets `run-pick`.

**Tests kept green:**
- `server/src/analyzer/select-analyzer.test.ts`
- `server/src/routes/analysis.test.ts`
- `server/src/workspace/user-settings.test.ts`
- `server/src/routes/diagnostics.test.ts`
- `server/src/routes/setup-readiness.orchestration.test.ts`
- `server/src/workspace/active-analyses.test.ts`
- the `models-inventory` tests

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/select-analyzer-endpoint-id.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { selectAnalyzer } from './index.js';
import { selectAnalyzerForPhase } from './select-analyzer.js';
import { OllamaAnalyzer } from './ollama.js';
import { AnalyzerEndpointMissingError } from './errors.js';
import {
  _resetUserSettingsCache,
  _setUserSettingsCacheForTest,
} from '../workspace/user-settings.js';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('selectAnalyzer — endpoint-shaped model ids (#3084 PR 3a, P23)', () => {
  const ENV_KEYS = ['GEMINI_API_KEY', 'ANALYZER_PHASE0_MODEL', 'ANALYZER_PHASE1_MODEL'] as const;
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    _setUserSettingsCacheForTest({ geminiApiKey: null });
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetUserSettingsCache();
  });

  it('refuses an openai:<endpoint>::<model> id instead of handing it to Ollama', () => {
    const err = thrown(() => selectAnalyzer({ model: 'openai:lab::qwen3:30b' }));
    expect(err).toBeInstanceOf(AnalyzerEndpointMissingError);
    expect(err).toMatchObject({ endpointId: 'lab', source: 'run-pick' });
  });

  it('a saved endpoint default is refused as settings-sourced, never run on Ollama\'s default model', () => {
    _setUserSettingsCacheForTest({ geminiApiKey: null, defaultAnalysisModel: 'openai:lab::qwen3:30b' });
    const err = thrown(() => selectAnalyzer({}));
    expect(err).toBeInstanceOf(AnalyzerEndpointMissingError);
    expect(err).toMatchObject({ endpointId: 'lab', source: 'settings' });
  });

  it('each phase source is named: env, run pick, saved phase model', () => {
    process.env.ANALYZER_PHASE0_MODEL = 'openai:lab::m';
    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase0' }))).toMatchObject({ endpointId: 'lab', source: 'env' });
    delete process.env.ANALYZER_PHASE0_MODEL;

    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase1', model: 'openai:pick::m' }))).toMatchObject({
      endpointId: 'pick',
      source: 'run-pick',
    });

    _setUserSettingsCacheForTest({ geminiApiKey: null, analyzerPhase1Model: 'openai:saved::m' });
    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase1' }))).toMatchObject({ endpointId: 'saved', source: 'settings' });
  });

  it('still routes an Ollama tag that merely starts with "openai:" to Ollama', () => {
    const sel = selectAnalyzer({ model: 'openai:latest' });
    expect(sel.engine).toBe('local');
    expect(sel.analyzer).toBeInstanceOf(OllamaAnalyzer);
    expect(sel.model).toBe('openai:latest');
  });
});
```

`server/src/routes/analysis-engine-label.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { engineLabel, engineFallbackMsPerChar } from './analysis.js';

describe('engineLabel (#3084 PR 3a)', () => {
  it('labels an endpoint id by endpoint and model, never as Ollama', () => {
    expect(engineLabel('openai', 'openai:lab::qwen3:30b')).toBe('Endpoint lab (qwen3:30b)');
  });
  it('keeps the Ollama and Gemini labels', () => {
    expect(engineLabel('local', 'qwen3.5:4b')).toBe('Ollama (qwen3.5:4b)');
    expect(engineLabel('gemini', 'no-such-model-id')).toBe('no-such-model-id');
  });
});

describe('engineFallbackMsPerChar with the widened engine (classification row 27)', () => {
  it('gives an endpoint the cloud rate until PR 3d reads its gpu', () => {
    expect(engineFallbackMsPerChar('openai', 'cuda')).toBe(engineFallbackMsPerChar('gemini', 'cuda'));
  });
});
```
**If importing `./analysis.js` at top level fails outside the `analysis.test.ts` harness** (module-load side effects), add these three cases to `server/src/routes/analysis.test.ts` instead: in a new `describe` block, reusing that file's existing import of `./analysis.js`.

Append to `server/src/routes/user-settings.test.ts`, inside `describe('user-settings router', …)`:
```ts
  it('refuses analysisEngine "openai" until endpoints are selectable (#3084 PR 3a)', async () => {
    const res = await request(app).put('/api/user/settings').send({ analysisEngine: 'openai' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid user settings.');
    const after = await request(app).get('/api/user/settings');
    expect(after.body.analysisEngine).toBe('local');
  });
```

- [ ] **Step 2: Run and confirm the right failures**

Run:
```bash
npm --prefix server run test -- src/analyzer/select-analyzer-endpoint-id.test.ts src/routes/analysis-engine-label.test.ts src/routes/user-settings.test.ts
```

Expected:
- `select-analyzer-endpoint-id.test.ts` fails to load: `does not provide an export named 'AnalyzerEndpointMissingError'`. With only the class added, the three refusal cases still FAIL: `expected null to be an instance of AnalyzerEndpointMissingError`. Today an endpoint id is routed to `OllamaAnalyzer`, and a saved endpoint default runs on `getResolvedOllamaModel()`.
- `labels an endpoint id…` FAILS with `engineLabel is not a function`. It is not exported today.
- `refuses analysisEngine "openai"…` **PASSES**, by design. It pins that 3a does *not* widen the persisted enum; its mutation proof is Step 5.

- [ ] **Step 3: Implement**

Append to `server/src/analyzer/errors.ts` (W1):
```ts
/* ── #3084 — analyzer endpoint ids (P23) ─────────────────────────────────── */

const ENDPOINT_SOURCE_LABEL: Record<'settings' | 'env' | 'run-pick' | 'persona', string> = {
  settings: 'a saved setting',
  env: 'ANALYZER_PHASE0_MODEL / ANALYZER_PHASE1_MODEL',
  'run-pick': "this run's model pick",
  persona: 'the persona generation engine',
};

/** A model id names an OpenAI-compatible endpoint this build cannot run: until
    PR 3d every endpoint id (P23), from PR 3d an id whose endpoint is not in
    saved settings. Thrown by selection (PR 3a) and PR 3c's pre-run checks,
    before the first call. FailureCode `analyzer-endpoint-missing` (PR 3b). */
export class AnalyzerEndpointMissingError extends Error {
  readonly code = 'ANALYZER_ENDPOINT_MISSING';
  constructor(
    readonly endpointId: string,
    readonly source: 'settings' | 'env' | 'run-pick' | 'persona',
  ) {
    super(`Analyzer endpoint "${endpointId}" (from ${ENDPOINT_SOURCE_LABEL[source]}) is not configured.`);
    this.name = 'AnalyzerEndpointMissingError';
  }
}
```

In `server/src/analyzer/index.ts`:
1. Add to the imports block (`:23-30`):
   ```ts
   import { inferEngineFromModelId, parseEndpointModelId, type AnalysisEngine } from './model-id.js';
   ```
   Add `AnalyzerEndpointMissingError` to W1's `./errors.js` import, and `getCachedUserSettings` to the `../workspace/user-settings.js` import (`:25-31`).
2. In `SelectAnalyzerOptions` (`:167-174`), after `model?: string;`, add:
   ```ts
     /** #3084 P23 — where `model` came from, named by AnalyzerEndpointMissingError.
         selectAnalyzerForPhase sets it; any other caller passing `model` means a
         run pick. */
     modelSource?: 'env' | 'run-pick' | 'settings';
   ```
3. `:181` becomes `  engine: AnalysisEngine;`.
4. Delete the private function and its comment (`:189-197`). Replace them with this comment only:
   ```ts
   /* Engine inference from a per-request model id lives in ./model-id.ts
      (shared case table with the frontend): `openai:<endpointId>::<model>` →
      openai, contains ':' → local (Ollama), else gemini. */
   ```
5. Insert immediately before `  if (engine === 'local') {` (`:206`):
   ```ts
     if (engine === 'openai') {
       /* #3084 P23 — endpoint ids have a grammar but no analyzer until PR 3d,
          which builds OpenAIAnalyzer here. Refusing is what keeps an `openai:`
          id out of the Ollama branch below (it contains ':'). `engine` is
          'openai' only for an explicit `opts.model`: the saved engine enum
          cannot hold it before PR 3d. */
       const parsed = parseEndpointModelId(opts.model ?? '');
       throw new AnalyzerEndpointMissingError(parsed?.endpointId ?? String(opts.model), opts.modelSource ?? 'run-pick');
     }
   ```
6. Inside `if (engine === 'local') {`, as its first statement (before `const ollamaUrl = …`, `:207`):
   ```ts
       /* #3084 P23 — a saved endpoint default must fail the run with a code,
          not be swapped silently for getResolvedOllamaModel()'s Ollama default. */
       if (!opts.model) {
         const savedEndpoint = parseEndpointModelId(getCachedUserSettings().defaultAnalysisModel);
         if (savedEndpoint) throw new AnalyzerEndpointMissingError(savedEndpoint.endpointId, 'settings');
       }
   ```

In `server/src/analyzer/select-analyzer.ts`:
1. `:74-76` — replace the comment text `it routes via \`inferEngineFromModelId\` (':' → local, otherwise → Gemini).` with:
   ```
   it routes via `inferEngineFromModelId` (./model-id.ts: endpoint shape →
   openai, ':' → local, otherwise → Gemini). `modelSource` names env if that
   id is an endpoint id this build cannot run (#3084 P23).
   ```
2. `:77` → `    return selectAnalyzer({ model: phaseEnvModel.trim(), modelSource: 'env' });`
3. `:82` → `    return selectAnalyzer({ model: opts.model, modelSource: 'run-pick' });`
4. `:92` → `    return selectAnalyzer({ model: settingsModel, modelSource: 'settings' });`

In `server/src/workspace/user-settings.ts`:
1. Add a type import at the top import block:
   ```ts
   import type { AnalysisEngine } from '../analyzer/model-id.js';
   ```
2. Replace `:773-783` with:
```ts
/** Analyzer engine selector — reads the saved user-settings value only.
    `getCachedUserSettings()` returns DEFAULT_USER_SETTINGS (engine `local`)
    when the module cache is cold, so a null cache resolves local rather than
    leaking to the `ANALYZER` env var. This deliberately RETIRES `ANALYZER` as
    an engine selector (a stray `ANALYZER=gemini` in an old `.env` is now inert
    for engine choice — the engine is UI/user-settings-driven). `GEMINI_API_KEY`
    is unaffected (still used for TTS + opt-out cloud fallback).
    #3084 PR 3a: the return type is the full AnalysisEngine, but the stored
    enum (ANALYSIS_ENGINE_VALUES) still holds only local|gemini, so the body
    cannot yield 'openai' until PR 3d widens that enum. */
export function getResolvedAnalysisEngine(): AnalysisEngine {
  return getCachedUserSettings().analysisEngine === 'gemini' ? 'gemini' : 'local';
}
```

Type-only changes:
- `server/src/store/analysis-state.ts:52` → `  engine?: AnalysisEngine;`, plus `import type { AnalysisEngine } from '../analyzer/model-id.js';`.
- `server/src/workspace/active-analyses.ts:47` → `  engine?: AnalysisEngine;`, plus `import type { AnalysisEngine } from '../analyzer/model-id.js';`.
- `server/src/routes/setup-diagnosis.ts:309` → `  engine: AnalysisEngine;`, plus the same import.
- `server/src/routes/models-inventory.ts:120` → `  analysisEngine: AnalysisEngine;`, plus the same import.

`server/src/routes/analysis.ts`:
1. Add `import { parseEndpointModelId, type AnalysisEngine } from '../analyzer/model-id.js';`.
2. Replace `:557-563` with:
```ts
/** Engine-aware label so SSE chunks read "Ollama (qwen3.5:9b)" for the
    local analyzer, "Gemma 4 31B" for Gemini, and "Endpoint lab (qwen3:30b)"
    for an OpenAI-compatible endpoint (#3084; PR 3d swaps the endpoint id for
    its saved name). The MODEL_LABELS lookup only covers Gemini ids, so the
    local branch surfaces the raw tag — Ollama tags are already readable. */
export function engineLabel(engine: AnalysisEngine, modelId: string): string {
  if (engine === 'openai') {
    const parsed = parseEndpointModelId(modelId);
    return parsed ? `Endpoint ${parsed.endpointId} (${parsed.model})` : `Endpoint (${modelId})`;
  }
  return engine === 'local' ? `Ollama (${modelId})` : humanModel(modelId);
}
```
3. `:1215` → `  engine: AnalysisEngine,`. The body at `:1218` is unchanged (classification row 27).
4. `:2655` → `  engine: AnalysisEngine;`.

Then run `npm run typecheck`. The remaining errors can only be at sites that receive `AnalyzerSelection.engine` into a `'local' | 'gemini'` parameter:
- `routes/analysis.ts:2212` phase-1 option;
- `attribution-eval/review-run.ts:47`.

Wave 2 may already have replaced both with a capacity descriptor. If typecheck reports either, change that type to `AnalysisEngine` with the same import.

Any **other** error is a site the classification table missed. Add a row, classify it by the key above, and fix it by that row's rule.

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/analyzer/select-analyzer-endpoint-id.test.ts src/routes/analysis-engine-label.test.ts src/routes/user-settings.test.ts src/analyzer/select-analyzer.test.ts src/workspace/user-settings.test.ts src/workspace/active-analyses.test.ts src/routes/diagnostics.test.ts
npm run typecheck
```
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Mutation proofs**
1. **Refusal branch.** Delete the `if (engine === 'openai') { … }` block in `index.ts`. Expect red on `refuses an openai:<endpoint>::<model> id instead of handing it to Ollama`. Restore.
2. **Saved default.** Delete the `if (!opts.model) { … }` block at the top of the local branch. Expect red on `a saved endpoint default is refused as settings-sourced, never run on Ollama's default model` (received `null`: an `OllamaAnalyzer` was built). Restore.
3. **Source.** In `select-analyzer.ts:77`, drop `, modelSource: 'env'`. Expect red on `each phase source is named: env, run pick, saved phase model` (received `source: 'run-pick'`). Restore.
4. **Persisted enum.** In `user-settings.ts:98`, change `ANALYSIS_ENGINE_VALUES` to `['local', 'gemini', 'openai'] as const`. Expect red on `refuses analysisEngine "openai" until endpoints are selectable (#3084 PR 3a)`: status 200, not 400. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/errors.ts server/src/analyzer/index.ts server/src/analyzer/select-analyzer.ts server/src/workspace/user-settings.ts server/src/store/analysis-state.ts server/src/workspace/active-analyses.ts server/src/routes/analysis.ts server/src/routes/setup-diagnosis.ts server/src/routes/models-inventory.ts server/src/analyzer/select-analyzer-endpoint-id.test.ts server/src/routes/analysis-engine-label.test.ts server/src/routes/user-settings.test.ts
git commit -m "refactor(server): widen analyzer engine union and refuse endpoint ids in selectAnalyzer"
```

---

### Task 3a.3: Frontend engine union, shared inference, engine name label

**Files:**
- Modify: `src/lib/model-id.ts` (add `analyzerEngineName`)
- Modify: `src/lib/models.ts:12-17` (`ModelOption.engine`), `:104-110`, `:178-182`
- Modify: `src/lib/types.ts:578,606`
- Modify: `src/store/analysis-slice.ts:33`
- Modify: `src/store/analysis-substage-reducers.ts:31`
- Modify: `src/store/analysis-substage-selectors.ts:43`
- Modify: `src/store/prosody-slice.ts:35`
- Modify: `src/components/status-popover.tsx:74,164`
- Modify: `src/components/top-bar.tsx:233`
- Modify: `src/views/analysing.tsx:344`
- Modify: `src/lib/api.ts:3041,3055`
- Modify: `src/components/setup/step-defaults.tsx:93-99`
- Test: `src/lib/model-id.test.ts` (add), `src/lib/models.endpoint-ids.test.ts` (new), `src/lib/api-substage-phase-event.test.ts` (new)

**Interfaces:**
- Consumes: `engineForModelId` and `AnalysisEngine` (Task 3a.1).
- Produces:
  - `analyzerEngineName(engine: AnalysisEngine | undefined): string`;
  - `models.ts` keeps exporting `engineForModelId`, now returning `AnalysisEngine`.

**Tests kept green:**
- `src/lib/models.test.ts`
- `src/hooks/use-local-analyzer-guard.test.tsx`
- `src/hooks/use-reverse-local-analyzer-guard.test.tsx`
- the status-popover and top-bar tests
- `src/views/analysing*.test.tsx`
- `src/components/setup/*.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/model-id.test.ts`:
```ts
import { analyzerEngineName } from './model-id';

describe('analyzerEngineName', () => {
  it('names each engine, defaulting an unknown tag to Ollama as the popover always has', () => {
    expect(analyzerEngineName('gemini')).toBe('Gemini');
    expect(analyzerEngineName('openai')).toBe('Endpoint');
    expect(analyzerEngineName('local')).toBe('Ollama');
    expect(analyzerEngineName(undefined)).toBe('Ollama');
  });
});
```

`src/lib/models.endpoint-ids.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { engineForModelId, localRunModelIds, runModelsAllResident } from './models';

describe('models.ts uses the shared id grammar (#3084 PR 3a)', () => {
  it('classifies an endpoint id as openai, not local', () => {
    expect(engineForModelId('openai:lab::qwen3:30b')).toBe('openai');
  });
  it('localRunModelIds excludes endpoint ids from the Ollama residency set', () => {
    expect(localRunModelIds(['openai:lab::qwen3:30b', 'qwen3.5:4b'])).toEqual(['qwen3.5:4b']);
  });
  it('a run on an endpoint alone has no local models to be resident', () => {
    expect(runModelsAllResident(['openai:lab::qwen3:30b'], ['openai:lab::qwen3:30b'])).toBe(false);
  });
});
```

`src/lib/api-substage-phase-event.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseSubstagePhaseEvent } from './api';

describe('parseSubstagePhaseEvent engine tag (#3084 PR 3a)', () => {
  it('keeps an openai engine tag', () => {
    expect(parseSubstagePhaseEvent({ progress: 0.5, engine: 'openai' })?.engine).toBe('openai');
  });
  it('still keeps local and gemini, and drops anything else', () => {
    expect(parseSubstagePhaseEvent({ progress: 0.5, engine: 'local' })?.engine).toBe('local');
    expect(parseSubstagePhaseEvent({ progress: 0.5, engine: 'gemini' })?.engine).toBe('gemini');
    expect(parseSubstagePhaseEvent({ progress: 0.5, engine: 'coqui' })?.engine).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run:
```bash
npx vitest run src/lib/model-id.test.ts src/lib/models.endpoint-ids.test.ts src/lib/api-substage-phase-event.test.ts
```

Expected:
- `analyzerEngineName` → FAIL, `analyzerEngineName is not a function`.
- `classifies an endpoint id as openai` → FAIL, `expected 'local' to be 'openai'`.
- `localRunModelIds excludes endpoint ids…` → FAIL.
- `runModelsAllResident…` → FAIL, got `true`.
- `keeps an openai engine tag` → FAIL, got `undefined`.

- [ ] **Step 3: Implement**

Append to `src/lib/model-id.ts`:
```ts
/** Human name for an analyzer engine tag (status popover, run chips). An
    absent tag reads "Ollama", as the popover always has. */
export function analyzerEngineName(engine: AnalysisEngine | undefined): string {
  if (engine === 'gemini') return 'Gemini';
  if (engine === 'openai') return 'Endpoint';
  return 'Ollama';
}
```

`src/lib/models.ts`:
1. Add at the top of the file, after the header comment:
   ```ts
   import { engineForModelId, type AnalysisEngine } from './model-id';
   ```
2. `:16` → `  engine: AnalysisEngine;`.
3. Replace `:104-110` with:
```ts
/** Engine classification from the id shape — `openai:<endpointId>::<model>` →
    openai, ':' → local (Ollama), else gemini. Implemented in ./model-id.ts,
    which shares its case table with the server's inferEngineFromModelId.
    Re-exported so existing importers keep their path. Use this everywhere
    instead of looking the id up in MODEL_OPTIONS, so a dynamically-pulled
    (uncurated) local tag is still correctly classified. */
export { engineForModelId };
```
4. `:179` → `  engine: AnalysisEngine;`.

Type sites. Add `import type { AnalysisEngine } from '<relative>/lib/model-id';` where the file doesn't already import it:
- `src/lib/types.ts:578` and `:606` → `  engine?: AnalysisEngine;` (import path `./model-id`).
- `src/store/analysis-slice.ts:33`, `src/store/analysis-substage-reducers.ts:31`, `src/store/prosody-slice.ts:35` → `  engine?: AnalysisEngine;` (import path `../lib/model-id`).
- `src/store/analysis-substage-selectors.ts:43` → `    engine?: AnalysisEngine;` (import path `../lib/model-id`).
- `src/components/status-popover.tsx:74` and `src/components/top-bar.tsx:233` → `    engine?: AnalysisEngine;` (import path `../lib/model-id`).
- `src/views/analysing.tsx:344` → `  const effectiveEngine: AnalysisEngine = isLocalAnalyzer ? 'local' : 'gemini';` (import path `../lib/model-id`). Add this line above it:
  ```ts
  /* #3084 — PR 3d derives the endpoint engine + gpu per effective id. */
  ```

`src/components/status-popover.tsx`:
1. Add `import { analyzerEngineName } from '../lib/model-id';` (merge it with the type import).
2. `:164` becomes `          {analyzerEngineName(analysisSubstage.engine)} ·{' '}`.

`src/lib/api.ts`:
1. Add `import type { AnalysisEngine } from './model-id';` near `:63`.
2. `:3041` → `  engine?: AnalysisEngine;`.
3. `:3055` →
   ```ts
       engine: p.engine === 'local' || p.engine === 'gemini' || p.engine === 'openai' ? p.engine : undefined,
   ```

`src/components/setup/step-defaults.tsx:93-99` becomes:
```ts
  const handleAnalysisModelChange = (next: string) => {
    setAnalysisModel(next);
    // Auto-derive the engine from the id shape (src/lib/model-id.ts) — matches
    // the server's inference. This is what routes generation.
    const engine = engineForModelId(next);
    /* #3084 PR 3a — the saved analysisEngine enum still refuses 'openai', and
       this picker offers no endpoint models until PR 3d, which removes this line. */
    if (engine === 'openai') return;
    void dispatch(saveAccountSettings({ defaultAnalysisModel: next, analysisEngine: engine }));
  };
```
This narrowing is forced by the compiler and unreachable from the UI in 3a: the picker's `<option>`s are the local and Gemini groups only. No test is added; the PR body says so.

- [ ] **Step 4: Run and confirm pass**

```bash
npx vitest run src/lib/model-id.test.ts src/lib/models.endpoint-ids.test.ts src/lib/api-substage-phase-event.test.ts src/lib/models.test.ts src/hooks src/components/setup src/views/analysing.test.tsx
npm run typecheck
```
Expected: PASS, and typecheck clean.

**If `src/views/analysing.test.tsx` does not exist** under that exact name, run `npx vitest run src/views` instead.

- [ ] **Step 5: Mutation proofs**
1. **Shared inference.** In `src/lib/models.ts`, replace the re-export with the pre-3a body:
   ```ts
   export function engineForModelId(id: string) { return id.includes(':') ? 'local' : 'gemini'; }
   ```
   Also remove the import. Expect red on `classifies an endpoint id as openai, not local` and `localRunModelIds excludes endpoint ids…`. Restore.
2. **SSE validation.** In `src/lib/api.ts:3055`, remove `|| p.engine === 'openai'`. Expect red on `keeps an openai engine tag`. Restore.

- [ ] **Step 6: Commit**
```bash
git add src/lib/model-id.ts src/lib/model-id.test.ts src/lib/models.ts src/lib/models.endpoint-ids.test.ts src/lib/types.ts src/store/analysis-slice.ts src/store/analysis-substage-reducers.ts src/store/analysis-substage-selectors.ts src/store/prosody-slice.ts src/components/status-popover.tsx src/components/top-bar.tsx src/views/analysing.tsx src/lib/api.ts src/lib/api-substage-phase-event.test.ts src/components/setup/step-defaults.tsx
git commit -m "refactor(frontend): widen analyzer engine union onto the shared id grammar"
```

---

### Task 3a.4: Selection-id `:` sites never hand an endpoint id to Ollama, plus the sweep

**Which sites change.** Research Inventory 2 mixes two kinds of input, and the fix differs between them.

**Selection ids.** These come from saved settings, a knob, a request body or a run pick. They must pass through the shared inference. Five sites:
- `server/src/workspace/user-settings.ts:963` — `getResolvedOllamaModel`; `ollama-health.ts:199,205,218` and `models-inventory.ts:132` inherit from it.
- `server/src/analyzer/voice-style.ts:67-69` — `resolvePersonaLocalModel`.
- `server/src/routes/ollama-health.ts:491-493` **NEW** — `POST /api/ollama/load` passes a request-body `model` straight to `warmOllamaModel`.
- `src/lib/models.ts:125-131` — `isOllamaModelResident`.
- `src/lib/models.ts:117` — `localRunModelIds`, already fixed in Task 3a.3.

**Ollama-sourced strings.** These are tags from Ollama's `/api/tags` or `/api/ps`, the server pull allowlist, or the model an `OllamaTransport` was already built with. An `openai:…::…` id cannot occur in them: Ollama names cannot contain `::`, and the transport is only constructed in the `local` branch.

Engine inference is also *wrong* on these inputs. It would classify a bare Ollama tag such as `nomic-embed-text` or `llama2` as Gemini. So these sites stay as they are, each with its reason:

| Site | Input source | Why unchanged |
|---|---|---|
| `server/src/routes/ollama-health.ts:199,205,218` | `expectedModel` = `getResolvedOllamaModel()` (`:162`) vs `/api/tags` / `/api/ps` names | protected by the `getResolvedOllamaModel` fix |
| `server/src/routes/setup-diagnosis.ts:300,302` | `/api/tags` names vs pull allowlist | Ollama-sourced on both sides |
| `server/src/analyzer/model-vram-stats.ts:34,179` | `this.model` of the Ollama transport (`ollama.ts:847`) | reached only from the `local` branch |
| `server/src/analyzer/analyzer-eval-stats.ts:55` | model from Ollama eval timing (`:76`) | Ollama-only telemetry |
| `server/src/routes/models-inventory.ts:132` | `/api/tags` name vs `getResolvedOllamaModel()` (`:536,580`) | protected by the `getResolvedOllamaModel` fix |
| `src/components/model-pull-status.tsx:294` | curated pull allowlist (`:145`) vs `/api/tags` (`:146`) | Ollama-sourced on both sides |
| `src/components/setup/step-analysis.tsx:21` | curated `MODEL_OPTIONS` local entries | static Ollama tags |
| `src/components/setup/step-analysis.tsx:75-76` | `account.localAnalyzerModels` (`/api/tags`) vs `account.pullableModels` (allowlist) | Ollama-sourced on both sides |

**Files:**
- Modify: `server/src/workspace/user-settings.ts:951-965`
- Modify: `server/src/analyzer/voice-style.ts:65-70`
- Modify: `server/src/routes/ollama-health.ts:490-493`
- Modify: `src/lib/models.ts:122-131`
- Test: `server/src/workspace/user-settings.endpoint-ids.test.ts` (new)
- Test: `server/src/analyzer/voice-style.persona-model.test.ts` (new)
- Test: `server/src/routes/ollama-health-load.endpoint-id.test.ts` (new)
- Test: `src/lib/models.endpoint-ids.test.ts` (add)

**Interfaces:**
- Consumes: `inferEngineFromModelId` (server) and `engineForModelId` (frontend).
- Produces: no new exports.

**Tests kept green:**
- `server/src/workspace/user-settings.test.ts`
- `server/src/analyzer/voice-style.test.ts`
- `server/src/routes/ollama-health.test.ts`
- `src/lib/models.test.ts` — its `:88-90` residency cases include a colonless id, which is why the frontend guard tests `=== 'openai'` and not `!== 'local'`.

- [ ] **Step 1: Write the failing tests**

`server/src/workspace/user-settings.endpoint-ids.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import {
  getResolvedOllamaModel,
  _resetUserSettingsCache,
  _setUserSettingsCacheForTest,
} from './user-settings.js';
import { inferEngineFromModelId } from '../analyzer/model-id.js';

describe('getResolvedOllamaModel — endpoint ids never reach Ollama (#3084 PR 3a)', () => {
  const saved = process.env.OLLAMA_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = saved;
    _resetUserSettingsCache();
  });

  /* This resolver also feeds Ollama health, inventory and persona probes, so it
     never returns an endpoint id. It is NOT what a run falls back to: selection
     refuses a saved endpoint default as analyzer-endpoint-missing before it
     reads this resolver (Task 3a.2, `a saved endpoint default is refused…`). */
  it('never returns a saved openai:<endpoint>::<model> default as the Ollama tag', () => {
    delete process.env.OLLAMA_MODEL;
    _setUserSettingsCacheForTest({ defaultAnalysisModel: 'openai:lab::qwen3:30b' });
    expect(inferEngineFromModelId(getResolvedOllamaModel())).not.toBe('openai');
  });

  it('keeps a saved Ollama tag named openai:latest', () => {
    _setUserSettingsCacheForTest({ defaultAnalysisModel: 'openai:latest' });
    expect(getResolvedOllamaModel()).toBe('openai:latest');
  });

  it('ignores an endpoint id in OLLAMA_MODEL, falling back exactly as if the env were unset (P23)', () => {
    _setUserSettingsCacheForTest({});
    delete process.env.OLLAMA_MODEL;
    const unset = getResolvedOllamaModel();
    process.env.OLLAMA_MODEL = 'openai:lab::qwen3:30b';
    expect(getResolvedOllamaModel()).toBe(unset);
    process.env.OLLAMA_MODEL = 'openai:latest';
    expect(getResolvedOllamaModel()).toBe('openai:latest');
  });
});
```

`server/src/analyzer/voice-style.persona-model.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { resolvePersonaLocalModel } from './voice-style.js';
import { getResolvedOllamaModel, _resetUserSettingsCache } from '../workspace/user-settings.js';

const ENV = 'PERSONA_GEN_LOCAL_MODEL';

describe('resolvePersonaLocalModel — endpoint ids never reach Ollama (#3084 PR 3a)', () => {
  const saved = process.env[ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    _resetUserSettingsCache();
  });

  it('falls back to the analyzer Ollama model when the knob holds an endpoint id', () => {
    process.env[ENV] = 'openai:lab::qwen3:30b';
    expect(resolvePersonaLocalModel()).toBe(getResolvedOllamaModel());
  });

  it('keeps a bare Ollama tag with no colon (Ollama resolves it to :latest)', () => {
    process.env[ENV] = 'llama2';
    expect(resolvePersonaLocalModel()).toBe('llama2');
  });
});
```

`server/src/routes/ollama-health-load.endpoint-id.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import express, { type Express } from 'express';
import request from 'supertest';
import { ollamaHealthRouter } from './ollama-health.js';
import {
  _resetUserSettingsCache,
  _setUserSettingsCacheForTest,
} from '../workspace/user-settings.js';

let app: Express;
let ollama: Server;
let hits = 0;
const savedUrl = process.env.OLLAMA_URL;

beforeAll(async () => {
  ollama = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()));
  const addr = ollama.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.OLLAMA_URL = url;
  _setUserSettingsCacheForTest({ ollamaUrl: url });
  app = express();
  app.use(express.json());
  app.use('/api/ollama', ollamaHealthRouter);
});

afterAll(async () => {
  ollama.closeAllConnections();
  await new Promise<void>((r) => ollama.close(() => r()));
  if (savedUrl === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = savedUrl;
  _resetUserSettingsCache();
});

describe('POST /api/ollama/load — endpoint ids (#3084 PR 3a)', () => {
  it('refuses an openai:<endpoint>::<model> id without contacting Ollama', async () => {
    const res = await request(app).post('/api/ollama/load').send({ model: 'openai:lab::qwen3:30b' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 'error', kind: 'error' });
    expect(res.body.error).toMatch(/not an Ollama model/i);
    expect(hits).toBe(0);
  });
});
```

Append to `src/lib/models.endpoint-ids.test.ts`:
```ts
import { isOllamaModelResident } from './models';

describe('isOllamaModelResident skips endpoint ids (#3084 PR 3a)', () => {
  it('is false for an endpoint id even when the identical string is listed', () => {
    expect(isOllamaModelResident('openai:lab::qwen3:30b', ['openai:lab::qwen3:30b'])).toBe(false);
  });
  it('still checks an Ollama tag named openai:latest, and a colonless tag', () => {
    expect(isOllamaModelResident('openai:latest', ['openai:latest'])).toBe(true);
    expect(isOllamaModelResident('gemma4-e4b-8gb', ['gemma4-e4b-8gb:latest'])).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run:
```bash
npm --prefix server run test -- src/workspace/user-settings.endpoint-ids.test.ts src/analyzer/voice-style.persona-model.test.ts src/routes/ollama-health-load.endpoint-id.test.ts
npx vitest run src/lib/models.endpoint-ids.test.ts
```

Expected:
- `never returns a saved openai:<endpoint>::<model> default as the Ollama tag` FAILS: expected `'openai'` not to be `'openai'` (the endpoint id is returned).
- `ignores an endpoint id in OLLAMA_MODEL…` FAILS: received `'openai:lab::qwen3:30b'`, expected the unset fallback.
- `falls back to the analyzer Ollama model…` FAILS: received the endpoint id.
- `refuses an openai:<endpoint>::<model> id without contacting Ollama` FAILS: status is not 400, and `hits` ≥ 1.
- `is false for an endpoint id…` FAILS: received `true`.

- [ ] **Step 3: Implement**

`server/src/workspace/user-settings.ts`:
1. Extend the type import from Task 3a.2 to a value import:
   ```ts
   import { inferEngineFromModelId, type AnalysisEngine } from '../analyzer/model-id.js';
   ```
2. Replace `:757-771` with:
```ts
/** Ollama model tag passed to /api/chat. Resolution chain:
      1. cached `defaultAnalysisModel` if it is an Ollama tag
      2. process.env.OLLAMA_MODEL
      3. DEFAULT_OLLAMA_MODEL ('qwen3.5:4b')
    The per-request `model` override (see selectAnalyzer) trumps all
    three. "Ollama tag" uses the shared grammar (analyzer/model-id.ts): a
    Gemini id and an `openai:<endpointId>::<model>` endpoint id both contain no
    Ollama tag, so both fall through to OLLAMA_MODEL / DEFAULT_OLLAMA_MODEL.
    #3084 P23: an endpoint id in OLLAMA_MODEL is ignored as if the env were unset. */
export function getResolvedOllamaModel(): string {
  const c = cached;
  const fromSettings = c?.defaultAnalysisModel;
  if (fromSettings && inferEngineFromModelId(fromSettings) === 'local') return fromSettings;
  const fromEnv = process.env.OLLAMA_MODEL;
  if (fromEnv !== undefined && inferEngineFromModelId(fromEnv) === 'openai') return DEFAULT_OLLAMA_MODEL;
  return fromEnv ?? DEFAULT_OLLAMA_MODEL;
}
```

`server/src/analyzer/voice-style.ts`:
1. Add `import { inferEngineFromModelId } from './model-id.js';`.
2. Replace `:65-70` with:
```ts
/** Ollama model for the local persona path. Blank ⇒ inherit the analyzer's
    resolved local model (single source of truth, zero extra download). An
    endpoint id (#3084 grammar) is not an Ollama tag, so it inherits too; a bare
    colonless tag (`llama2`) is kept — Ollama resolves it to `:latest`. */
export function resolvePersonaLocalModel(): string {
  const explicit = configValue<string>('analyzer.personaGeneration.localModel').trim();
  return explicit.length > 0 && inferEngineFromModelId(explicit) !== 'openai'
    ? explicit
    : getResolvedOllamaModel();
}
```

`server/src/routes/ollama-health.ts`:
1. Add `import { inferEngineFromModelId } from '../analyzer/model-id.js';`.
2. Replace `:490-493` with:
```ts
ollamaHealthRouter.post('/load', async (req: Request, res: Response) => {
  const requested = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  /* #3084 — the body carries a selection id. An OpenAI-compatible endpoint id
     contains ':' but is not an Ollama tag; never warm it on Ollama. */
  if (requested && inferEngineFromModelId(requested) === 'openai') {
    return res
      .status(400)
      .json({ status: 'error', error: `"${requested}" is not an Ollama model.`, kind: 'error' });
  }
  const model = requested || getResolvedOllamaModel();
  const result = await warmOllamaModel(model);
```

`src/lib/models.ts`: replace `:122-131` with:
```ts
/** True when `id` is resident in the given Ollama `/api/ps` name list, tolerating
    Ollama's tag canonicalisation (bare-name ⇄ `:latest`, family-root prefix) —
    mirrors the server-side match in `server/src/routes/ollama-health.ts`. An
    endpoint id (#3084) is never an Ollama model, so it is never resident. The
    guard is `=== 'openai'`, not `!== 'local'`: a colonless Ollama tag is valid. */
export function isOllamaModelResident(id: string, resident: readonly string[]): boolean {
  if (engineForModelId(id) === 'openai') return false;
  const target = norm(id);
  const root = id.split(':')[0];
  return resident.some(
    (r) => norm(r) === target || (r.split(':')[0] === root && r.startsWith(`${root}:`)),
  );
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/workspace/user-settings.endpoint-ids.test.ts src/analyzer/voice-style.persona-model.test.ts src/routes/ollama-health-load.endpoint-id.test.ts src/workspace/user-settings.test.ts src/analyzer/voice-style.test.ts src/routes/ollama-health.test.ts
npx vitest run src/lib/models.endpoint-ids.test.ts src/lib/models.test.ts
```
Expected: PASS.

- [ ] **Step 5: Mutation proofs**

Revert one guard at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| `getResolvedOllamaModel` back to `fromSettings.includes(':')` | `never returns a saved openai:<endpoint>::<model> default as the Ollama tag` |
| Delete the `fromEnv !== undefined && … === 'openai'` line | `ignores an endpoint id in OLLAMA_MODEL, falling back exactly as if the env were unset (P23)` |
| `resolvePersonaLocalModel` guard `&& inferEngineFromModelId(explicit) !== 'openai'` removed | `falls back to the analyzer Ollama model…` |
| `/load` `if (requested && …openai…)` block removed | `refuses an openai:<endpoint>::<model> id without contacting Ollama` |
| `isOllamaModelResident` first line removed | `is false for an endpoint id…` |
| `isOllamaModelResident` guard changed to `!== 'local'` | `still checks … a colonless tag` |

- [ ] **Step 6: Re-run the sweep and classify every hit**

Run these from the worktree root in Git Bash, and paste the output into the PR body:
```bash
rg -n '(includes|split|indexOf|lastIndexOf)\(\s*.:.\s*\)' src server/src -g '!*.test.ts' -g '!*.test.tsx'
rg -n ':latest|/:/' src server/src -g '!*.test.ts' -g '!*.test.tsx'
rg -n 'inferEngineFromModelId|engineForModelId' src server/src -g '!*.test.ts' -g '!*.test.tsx'
rg -n "'local'\s*\|\s*'gemini'|'gemini'\s*\|\s*'local'|[!=]==\s*'(local|gemini)'|\['local',\s*'gemini'\]|enum: \[local, gemini\]" src server/src openapi.yaml -g '!*.test.ts' -g '!*.test.tsx'
rg -n "\?\s*'(local|gemini|openai|qwen|gemma)'\s*:\s*'(local|gemini|openai|qwen|gemma)'" src server/src -g '!*.test.ts' -g '!*.test.tsx'
```

The fifth command finds **ternary engine coercions**, which the fourth cannot: in `x === 'qwen' ? 'local' : 'gemini'`, the compared literal is not an analyzer engine. On 46e62a34 it prints seven hits. Each is a table row or excluded:
- `src/views/analysing.tsx:344` — row 47;
- `server/src/analyzer/attribution-eval/run-eval.ts:214` — row 61;
- `server/src/analyzer/index.ts:196` — row 14 (Task 3a.2 deletes it);
- `server/src/analyzer/voice-style.ts:62` — row 22;
- `server/src/workspace/user-settings.ts:976` — row 42;
- `src/lib/models.ts:109` — row 7 (Task 3a.3 replaces it);
- `src/lib/tts-models.ts:187` — excluded (TTS).

**Classification rule for every hit** of the first three commands. Apply the first rule that fits:
1. **Not a model id.** Host strings, clock strings, cover ids, sentence keys, lock keys and device keys: `src/lib/sidecar-url.ts:41`, `server/src/workspace/sidecar-url.ts:43`, `src/lib/time.ts:5`, `src/views/manuscript.tsx:1456`, `src/modals/reassign-lines.tsx:170`, `server/src/cover/search.ts:74`, `server/src/lan-auth.ts:126`, `server/src/workspace/chapter-durations.ts:8`. → Excluded, one line of reason each.
2. **Ollama-sourced.** Tags from `/api/tags` or `/api/ps`, the pull allowlist, curated `MODEL_OPTIONS` local entries, or `this.model` inside the Ollama transport (e.g. `server/src/analyzer/ollama.ts:204` `normalizeModelTag` for keep-alive). → Unchanged; name the source, as in the table above.
3. **A selection id.** A value from user settings, a registry knob, a request body/query, a run pick, or an SSE `model` field that then reaches Ollama. → It must go through `inferEngineFromModelId` / `engineForModelId` first, with a test using `openai:lab::qwen3:30b`. A hit of this kind that isn't in this task is a finding: fix it in this PR under "Also fixed, found in passing", per CLAUDE.md "Incidental findings".

For the fourth and fifth commands, every hit must be a row of the classification table or its excluded list. A new hit gets a row.

- [ ] **Step 7: Commit**
```bash
git add server/src/workspace/user-settings.ts server/src/analyzer/voice-style.ts server/src/routes/ollama-health.ts src/lib/models.ts server/src/workspace/user-settings.endpoint-ids.test.ts server/src/analyzer/voice-style.persona-model.test.ts server/src/routes/ollama-health-load.endpoint-id.test.ts src/lib/models.endpoint-ids.test.ts
git commit -m "fix(server,frontend): keep endpoint model ids away from every ollama selection site"
```

---

### Task 3a.5: Refuse endpoint model ids in saved selections until PR 3d (P23)

**Files:**
- Modify: `server/src/workspace/user-settings.ts` — add `ENDPOINT_ID_REFUSED_FIELDS`, `ENDPOINT_ID_REFUSED_KNOBS` and `endpointModelIdRefusals` after `stripForbiddenKeys` (`:663-671`)
- Modify: `server/src/routes/user-settings.ts:19-28` (imports), `:90-101` (general PUT)
- Modify: `server/src/routes/config.ts` imports, and `:106-128` (PUT pass 1)
- Modify: `src/lib/api.ts` — the `./model-id` import Task 3a.3 added near `:63`; `mockPutUserSettings` (`:7308-7346`)
- Test: `server/src/routes/user-settings.test.ts` (add)
- Test: `server/src/routes/config.endpoint-ids.test.ts` (new)
- Test: `src/lib/api-put-user-settings-endpoint-ids-mock.test.ts` (new)

**Interfaces:**
- Consumes: `inferEngineFromModelId` (Task 3a.1; `user-settings.ts` already imports it, Task 3a.4) and `engineForModelId` (frontend).
- Produces: `endpointModelIdRefusals(patch: unknown): Array<{ path: string[]; message: string }>`, `ENDPOINT_ID_REFUSED_FIELDS`, `ENDPOINT_ID_REFUSED_KNOBS`. PR 3d deletes all three and their three callers ("End of PRs 3a and 3b" lists the lift).

**Why the check sits on client input, not in the schema or `writeUserSettings`:**
- `userSettingsSchema` also parses the file on read. A refusal there would make `readUserSettings` reset every setting on one stale value (`user-settings.ts:522-525`).
- The override upsert (`user-settings.ts:1113-1117`) rewrites the whole `configOverrides` map through `writeUserSettings`. A refusal there would fail every later Advanced Settings save once a stale value is on disk.

The two routes that accept a client's model id refuse it instead. The mock PUT mirrors the general PUT.

**Tests kept green:**
- `server/src/routes/user-settings.test.ts`
- `server/src/workspace/user-settings.test.ts`
- `server/src/routes/config*.test.ts`
- `src/lib/api-put-user-settings-mock.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/src/routes/user-settings.test.ts`, inside `describe('user-settings router', …)`:
```ts
  it.each(['defaultAnalysisModel', 'analyzerPhase0Model', 'analyzerPhase1Model'])(
    'refuses an endpoint model id in %s until endpoints are selectable (#3084 P23)',
    async (field) => {
      const res = await request(app).put('/api/user/settings').send({ [field]: 'openai:lab::qwen3:30b' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid user settings.');
      expect(res.body.issues).toEqual([
        { path: [field], message: 'OpenAI-compatible endpoint models cannot be selected in this build.' },
      ]);
      const after = await request(app).get('/api/user/settings');
      expect(after.body[field]).not.toBe('openai:lab::qwen3:30b');
    },
  );

  it('refuses an endpoint model id in a phase-model override, and still saves an Ollama tag named openai:latest (#3084 P23)', async () => {
    const refused = await request(app)
      .put('/api/user/settings')
      .send({ configOverrides: { 'analyzer.phase1.model': 'openai:lab::m' } });
    expect(refused.status).toBe(400);
    expect(refused.body.issues.map((i: { path: string[] }) => i.path)).toEqual([['configOverrides', 'analyzer.phase1.model']]);
    const ok = await request(app).put('/api/user/settings').send({ analyzerPhase0Model: 'openai:latest' });
    expect(ok.status).toBe(200);
    expect(ok.body.analyzerPhase0Model).toBe('openai:latest');
  });
```

`server/src/routes/config.endpoint-ids.test.ts`:
```ts
/* #3084 P23 — PUT /api/config refuses an endpoint model id for the phase-model
   knobs until PR 3d. Real express + supertest over a temp workspace, the same
   harness shape as routes/user-settings.test.ts. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let settings: typeof import('../workspace/user-settings.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-config-endpoint-ids-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  delete process.env.ANALYZER_PHASE0_MODEL;
  delete process.env.ANALYZER_PHASE1_MODEL;
  const [{ configRouter }, s] = await Promise.all([import('./config.js'), import('../workspace/user-settings.js')]);
  settings = s;
  settings._resetUserSettingsCache();
  app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  settings._resetUserSettingsCache();
});

describe('PUT /api/config — phase-model overrides (#3084 P23)', () => {
  it.each(['analyzer.phase0.model', 'analyzer.phase1.model'])(
    'refuses an endpoint model id for %s and writes nothing',
    async (key) => {
      const res = await request(app).put('/api/config').send({ [key]: 'openai:lab::qwen3:30b' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`${key}: OpenAI-compatible endpoint models cannot be selected in this build.`);
      expect((await settings.readUserSettings()).configOverrides[key]).toBeUndefined();
    },
  );

  it('still saves an Ollama tag that starts with openai:', async () => {
    const res = await request(app).put('/api/config').send({ 'analyzer.phase0.model': 'openai:latest' });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(['analyzer.phase0.model']);
  });
});
```

`src/lib/api-put-user-settings-endpoint-ids-mock.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('VITE_USE_MOCKS', 'true');
const { api } = await import('./api');

describe('mock PUT user settings — endpoint model ids (#3084 P23)', () => {
  it.each(['defaultAnalysisModel', 'analyzerPhase0Model', 'analyzerPhase1Model'] as const)(
    'refuses an endpoint id in %s, as the server does',
    async (field) => {
      const before = (await api.getUserSettings())[field];
      await expect(api.putUserSettings({ [field]: 'openai:lab::m' })).rejects.toThrow(/\(400\).*Invalid user settings/);
      expect((await api.getUserSettings())[field]).toBe(before);
    },
  );

  it('still saves an Ollama tag named openai:latest', async () => {
    expect((await api.putUserSettings({ analyzerPhase1Model: 'openai:latest' })).analyzerPhase1Model).toBe('openai:latest');
  });
});
```

- [ ] **Step 2: Run and confirm the right failures**

Run:
```bash
npm --prefix server run test -- src/routes/user-settings.test.ts src/routes/config.endpoint-ids.test.ts
npx vitest run src/lib/api-put-user-settings-endpoint-ids-mock.test.ts
```

Expected:
- The three `refuses an endpoint model id in …` route cases FAIL: status 200, not 400.
- `refuses an endpoint model id in a phase-model override…` FAILS: status 200.
- Both `PUT /api/config … refuses` cases FAIL: status 200.
- The three mock `refuses an endpoint id in …` cases FAIL: the promise resolves.
- `still saves an Ollama tag that starts with openai:` (config) and `still saves an Ollama tag named openai:latest` (mock) PASS already. They pin that an Ollama tag is not refused.

- [ ] **Step 3: Implement**

`server/src/workspace/user-settings.ts` — insert after `stripForbiddenKeys` (`:671`):
```ts
/* #3084 P23 — until PR 3d, no saved selection may name an OpenAI-compatible
   endpoint. The model fields are plain strings, and an endpoint id saved now
   would reach selection or an Ollama probe. Checked on CLIENT input only (the
   general PUT and PUT /api/config): the schema also parses the file on read,
   and the override upsert below rewrites the whole overrides map. PR 3d deletes
   these three exports and their callers (both routes and the mock PUT). */
export const ENDPOINT_ID_REFUSED_FIELDS = ['defaultAnalysisModel', 'analyzerPhase0Model', 'analyzerPhase1Model'] as const;
export const ENDPOINT_ID_REFUSED_KNOBS = ['analyzer.phase0.model', 'analyzer.phase1.model'] as const;
const ENDPOINT_ID_REFUSAL = 'OpenAI-compatible endpoint models cannot be selected in this build.';

export function endpointModelIdRefusals(patch: unknown): Array<{ path: string[]; message: string }> {
  if (!patch || typeof patch !== 'object') return [];
  const p = patch as Record<string, unknown>;
  const isEndpointId = (v: unknown): boolean => typeof v === 'string' && inferEngineFromModelId(v.trim()) === 'openai';
  const out: Array<{ path: string[]; message: string }> = [];
  for (const field of ENDPOINT_ID_REFUSED_FIELDS) {
    if (isEndpointId(p[field])) out.push({ path: [field], message: ENDPOINT_ID_REFUSAL });
  }
  const overrides = p.configOverrides;
  if (overrides && typeof overrides === 'object') {
    for (const knob of ENDPOINT_ID_REFUSED_KNOBS) {
      if (isEndpointId((overrides as Record<string, unknown>)[knob])) {
        out.push({ path: ['configOverrides', knob], message: ENDPOINT_ID_REFUSAL });
      }
    }
  }
  return out;
}
```

`server/src/routes/user-settings.ts`:
1. Add `endpointModelIdRefusals` to the `../workspace/user-settings.js` import (`:19-27`).
2. `:78-80` becomes:
```ts
userSettingsRouter.put('/', async (req: Request, res: Response) => {
  /* #3084 P23 — PR 3d deletes this refusal. */
  const refusals = endpointModelIdRefusals(req.body);
  if (refusals.length > 0) {
    return res.status(400).json({ error: 'Invalid user settings.', issues: refusals });
  }
  try {
    const updated = await writeUserSettings(req.body);
```

`server/src/routes/config.ts`:
1. Add `import { endpointModelIdRefusals } from '../workspace/user-settings.js';` (merge it into an existing import from that module if there is one).
2. In pass 1, directly after the `if (resolveKnob(knob).locked) { … }` block (`:114-117`), insert:
```ts
    /* #3084 P23 — PR 3d deletes this refusal. */
    if (endpointModelIdRefusals({ configOverrides: { [key]: raw } }).length > 0) {
      res.status(400).json({ error: `${key}: OpenAI-compatible endpoint models cannot be selected in this build.` });
      return;
    }
```

`src/lib/api.ts`:
1. Change Task 3a.3's `import type { AnalysisEngine } from './model-id';` to `import { engineForModelId, type AnalysisEngine } from './model-id';`.
2. In `mockPutUserSettings`, directly after `await wait(50);` (`:7309`), insert:
```ts
  /* #3084 P23 — mirrors the server's refusal of an endpoint model id in a saved
     selection (server/src/workspace/user-settings.ts endpointModelIdRefusals),
     with realPutUserSettings' error text. PR 3d deletes this block. */
  const refusedFields = (['defaultAnalysisModel', 'analyzerPhase0Model', 'analyzerPhase1Model'] as const).filter((f) => {
    const v = patch[f];
    return typeof v === 'string' && engineForModelId(v.trim()) === 'openai';
  });
  if (refusedFields.length > 0) {
    throw new Error(
      `User settings save failed (400): ${JSON.stringify({
        error: 'Invalid user settings.',
        issues: refusedFields.map((f) => ({ path: [f], message: 'OpenAI-compatible endpoint models cannot be selected in this build.' })),
      })}`,
    );
  }
```

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/routes/user-settings.test.ts src/routes/config.endpoint-ids.test.ts src/workspace/user-settings.test.ts
npx vitest run src/lib/api-put-user-settings-endpoint-ids-mock.test.ts src/lib/api-put-user-settings-mock.test.ts
npm run typecheck
npm run check:cycles
```
Expected: PASS, and no new cycle (`routes/config.ts` → `workspace/user-settings.ts` is a route-to-workspace edge).

- [ ] **Step 5: Mutation proofs**

Revert one change at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| Delete the refusal block in the general PUT | `refuses an endpoint model id in defaultAnalysisModel…` (and the two other fields) |
| Delete the `configOverrides` loop in `endpointModelIdRefusals` | `refuses an endpoint model id in a phase-model override…` |
| Delete the refusal block in `routes/config.ts` | `refuses an endpoint model id for analyzer.phase0.model and writes nothing` |
| In `isEndpointId`, test `v.includes(':')` instead of the grammar | `refuses an endpoint model id in a phase-model override, and still saves an Ollama tag named openai:latest` and `still saves an Ollama tag that starts with openai:` |
| Delete the mock refusal block | `refuses an endpoint id in defaultAnalysisModel, as the server does` |

- [ ] **Step 6: Commit**
```bash
git add server/src/workspace/user-settings.ts server/src/routes/user-settings.ts server/src/routes/user-settings.test.ts server/src/routes/config.ts server/src/routes/config.endpoint-ids.test.ts src/lib/api.ts src/lib/api-put-user-settings-endpoint-ids-mock.test.ts
git commit -m "fix(server,frontend): refuse endpoint model ids in saved analyzer selections until endpoints are selectable"
```

---

### Task 3a.6: Ship PR 3a

**Files:**
- Modify: the wave plan doc that wave 1 created. Locate it with `rg -l "3084" docs/features`, and update any sentence that lists the engine union or the `:` sites.
- No `openapi.yaml`, no knobs, no register rows.

- [ ] **Step 1: Full local checks**
```bash
npm run typecheck
npm run lint
npm run check:cycles
npm run verify:fast:branch
```

Expected:
- All green.
- `check:cycles` reports no new cycle. `model-id.ts` has no imports, so it can only be a leaf.

- [ ] **Step 2: Release notes — skip, with the reason stated.** The PR body says:

  > No shippable delta: the engine union and id grammar are internal. The only behavioural changes refuse an `openai:<endpoint>::<model>` id where no UI can send one yet: selection (as `AnalyzerEndpointMissingError`, naming env / run pick / saved setting), a hand-set persona model knob, `POST /api/ollama/load`, the general settings PUT and `PUT /api/config` (P23). Release-notes entries land with PR 3d, when endpoints become selectable.

- [ ] **Step 3: On-box acceptance — not applicable.** No hardware-only behaviour ships; say so in the PR body.

- [ ] **Step 4: Open the PR.**
  - Title: `refactor(server,frontend): analyzer engine union and endpoint model-id grammar`.
  - Body:
    - `## Summary` — the union, the grammar, the classification table (copy it from this plan), and the Task 3a.4 sweep output.
    - `## Test plan` — the new test files and the mutation-proof outputs.
    - `Refs #3084`.
    - "Also fixed, found in passing": `POST /api/ollama/load` accepted any selection id (Task 3a.4).

- [ ] **Step 5: `pr-review-gate`** at depth **high** (a `refactor` spanning `server,frontend`). Triage and fold findings before merge.

---

### PR 3b — endpoints, keys, OpenAI transport, structured output, failure codes (still not selectable)

**Branch:** `feat/server-3084-w3b-endpoints`
Create it with `node scripts/wt-new.mjs feat/server-3084-w3b-endpoints`, off `main` with PR 3a merged.
(`scripts/lib/branch-name.mjs` accepts a single scope per branch — the PR title keeps its multi-scope
`feat(server,openapi): …` form.) Commits also carry `frontend` and `docs` scopes where the task touches `src/` or `CLAUDE.md`.

**What it delivers.**
- **Failure codes.** `analyzer-request-rejected`, `analyzer-invalid-output` and `analyzer-endpoint-missing` exist in all six places. `analyzer-timeout` and `AnalyzerTimeoutError` already exist from wave 2b (Task 2.8, always shipped); this PR only uses them and widens their remediation to name endpoints.
- **Endpoint reasoning-overflow fixes (F7, Task 3b.1b).** `reasoningOverflowFixes` (wave 2, P20) gains an `openai`-transport branch: the endpoint's own `maxOutputTokens` / `contextTokens` fields and the stage input fractions, naming the endpoint by its saved name (`getCachedUserSettings()`, falling back to the id). `AnalyzerReasoningOverflowError` gains an optional `endpointId`, set by `OpenAIAnalyzer` (the only layer that knows its endpoint — the overflow itself is raised by the transport-agnostic runner) and threaded through `classifyAnalysisFailure`'s call into `reasoningOverflowFixes`, so a real endpoint overflow actually reaches these fixes rather than only a hand-built test `ctx`. Reasoning-level (5a) and payload (5b) fixes are not added here; no `wikiPage` yet (PR 3d adds it alongside the page it names).
- **Typed errors.** `AnalyzerStreamIncompleteError`, `AnalyzerKeyOriginError` and `AnalyzerInvalidOutputError` are added. `AnalyzerEndpointMissingError` exists from PR 3a (Task 3a.2).
- **Error mappings.**
  - 401/403 and key-origin errors map to `auth`.
  - Any 400 maps to `analyzer-request-rejected`, with a redacted provider message and the request-shaping settings named. A Gemini 400 keeps its status/details `detail` block. An endpoint 400 naming a token or context limit points to the endpoint's max-output field (P24).
  - An **endpoint's** `AnalyzerUnreachableError` (`transport: 'openai'`) maps to `analyzer-unreachable` by `instanceof`, with endpoint copy. **Ollama's unreachable failures keep `main`'s outcome, copy and detail exactly (P28):** a `LocalUnreachableError` still classifies through the unchanged signature scan over its message, pinned by snapshots captured on `main` (Task 3b.1).
  - An endpoint's other HTTP statuses (5xx, 404, 422, 0 for an in-stream error event) and `AnalyzerStreamIncompleteError` map to a curated `unknown` naming the endpoint, the status and a redacted excerpt.
  - Every selection call site (analysis phase 0, subset, phase 1, annotate-emotion, instruct-annotation, script review) catches any error selection throws and reports its classified code through `classifyAnalysisFailure`: `AnalyzerEndpointMissingError` → `analyzer-endpoint-missing`, `AnalyzerKeyOriginError` → `auth`, any other error → its classified code. No selection error ends a stream uncoded, and none is rethrown after the SSE headers are sent (P23, Task 3b.1a).
  - Every changed outcome is listed in the PR body and release notes (Task 3b.13).
- **Secrets (P22).**
  - **Headers:** the OpenAI client's `fetch` wrapper sends a fixed set: `accept: application/json`, `content-type: application/json`, `user-agent: castwright-analyzer`, no `x-stainless-*`, and `Authorization` only for the endpoint's own key on its own origin. The host's `OPENAI_CUSTOM_HEADERS` never reaches the wire.
  - **Keys:** the key write route and its mock refuse a key containing any control character (C0 or C1, including CR, LF and NUL), naming the rule and never echoing the key.
  - **Redaction:** known secrets are redacted where errors are built in all three transports (OpenAI Task 3b.11; Ollama and Gemini Task 3b.6a), in the endpoint routes' returned and logged error text (key write Task 3b.7, Detect Task 3b.8), and in `classifyAnalysisFailure`'s fall-through branches.
  - **No raw errors:** the OpenAI transport rebuilds every error it would rethrow as our own class with a redacted message and a sanitized `causeCode` field, never carrying or returning the raw SDK error or its cause.
  - **Cause codes are shown (P22):** rule 7's `AnalyzerTransportError` and the pre-header `AnalyzerStreamIncompleteError` put the sanitized `causeCode` in their message, in the shape `… before a response (ERR_SSL_WRONG_VERSION_NUMBER)`, the same ` (CODE)` suffix as PR 3c's catalog listing error (`causeCodeSuffix`, Task 3b.1). `classifyAnalysisFailure`'s curated endpoint copy for both appends the code, so the run failure, the `[analysis] failed` log line and the Test action (which shows the error's message) all show it.
- **Classification (P21, P25).** Only a connection-level error with a connect-phase code (`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT`) or a bare `fetch failed` can be unreachable. A reset or DNS hiccup before headers (`ECONNRESET`, `UND_ERR_SOCKET`, `EAI_AGAIN`) is an `AnalyzerStreamIncompleteError`: retried, never a fallback. Every `APIError` with a status is an `AnalyzerHttpError`. A stream that has sent `finish_reason` is complete even if the idle watchdog fires, or the socket drops, before `[DONE]`.
- **Settings load (P25).** `analyzerEndpoints` / `analyzerEndpointKeys` entries parse one by one. An invalid entry, or a later entry repeating an earlier id, is dropped with a warning and never resets the settings file. Before any write can persist the drop, the entry is appended to `user-settings.invalid-endpoints.json` beside the settings file, and the warning names that file.
  - **Concurrent reads:** the cold settings read is single-flight: concurrent callers share one in-flight read, and so one append. **Already shipped** — PR #3195's `inFlightRead` (`user-settings.ts:375-378`, `:438`) is that single flight, so this requirement is met by the existing code and no wrapper of our own is added. The per-entry drop hooks into `performUserSettingsRead` (`:472-530`) between the eager-load migration and the whole-object `safeParse` (`:522`).
  - **Not a corruption:** dropping an invalid endpoint entry never sets `corruptSettingsFile` / `isUserSettingsFileCorrupt()`. That flag means the settings *file* was unreadable and was recovered (`:479-498`) and it drives the frontend corruption banner; a dropped entry is a schema failure on one entry of a readable file, reported only by its own warning naming the archive.
  - **Marking:** an entry is marked archived only after its `appendFile` succeeds. A failed append is retried on the next read.
  - **Append failure:** a settings write never refuses because an append failed. Until the append lands, every writer writes the still-unarchived entries back into the file, raw and unchanged, so nothing is lost and saving still works.
  - **Keys:** a dropped key entry is archived with its `origin` only, never the `key` value.
  - **Test state:** `_resetUserSettingsCache()` also forgets archived and unarchived drops and any in-flight archive retry. It already clears the in-flight read (`inFlightRead = null`, `:1137`, shipped in #3195).
- **Save-time validation and drop visibility (F5, Tasks 3b.5/3b.6b).** Endpoint create/update, the key write and the settings PUT refuse a malformed field with 400 `{ error, code, issues: [{ path: string[], message }] }`, never echoing a key or field value (extends the routes of Tasks 3b.5/3b.7 rather than a second validator). `message` is field-aware copy from `friendlyEndpointIssueMessage` (Task 3b.5, exported for PR 3d's UI test), not zod's own wording — zod 4.4.3's `.url()`/`.regex()` failures are `invalid_format`, not the zod-3 `invalid_string` an earlier draft assumed. Every entry dropped at read time (P25, above) is listed read-only on `GET /api/user/settings` as `droppedEndpointEntries`, with `path: code` issue strings (never a value), de-duplicated across restarts by a `contentHash` that never leaves the server; `POST /api/user/settings/dropped-endpoint-entries/acknowledge` retires the ones the user has seen, durably (keyed on that same hash, not the archive's per-line UUID, and serialised through the settings module's `writeChain` so two acknowledgements can't race). An entry whose archive append is still pending is listed too, flagged `archiveId: null`. No UI yet (PR 3d).
- **Schema adapters.** Per-provider adapters (with a `dropped` snapshot per stage schema) are wired into the runner for Ollama and Gemini now, and for OpenAI through `OpenAIAnalyzer`. `structuredOutputLabel` is exported for 3d.
- **Structured-output knobs.** `analyzer.ollama.structuredOutput` (default `schema`) and `analyzer.gemini.structuredOutput` (default `json`) are enum knobs with Settings rows and `config:sync`. The Ollama and Gemini transports honour all three modes.
- **Endpoint storage.** `workspace/analyzer-endpoints.ts` and the user-settings fields `analyzerEndpoints` (in GET, not writable by the general PUT) and `analyzerEndpointKeys` (FORBIDDEN_KEYS; GET exposes `analyzerEndpointKeyStatus`).
- **Routes.** `server/src/routes/analyzer-endpoints.ts`: create, update, delete, key write, and Detect.
- **Client side.** OpenAPI schemas plus mocks (Detect excepted), regenerated `api-types.ts`, and the account-slice thunks. There is no UI.
- **Transport.** `openai@^7.15.0`, `transports/endpoint-runtime.ts`, `transports/openai-transport.ts` with its real-socket contract suite, `OPENAI_RETRY_POLICY`, and `OpenAIAnalyzer`.

**What it must NOT change.**
- No picker, saved default, env var or `selectAnalyzer` branch accepts an endpoint id. Selection still throws `AnalyzerEndpointMissingError`, and the general PUT and `PUT /api/config` still refuse endpoint ids (PR 3a, P23). The endpoint routes of this PR write only `analyzerEndpoints` / `analyzerEndpointKeys`, never a model selection.
- No GPU guard, eviction or in-flight registration (PR 3d).
- No catalog, Test action, capacity branch for endpoints, or rate-limit settings map (PR 3c).
- **Default requests stay byte-identical.** Ollama sends the same `format` schema. Gemini sends only `responseMimeType`. The Ollama 404/500/503 classification stays byte-identical (wave 1 Task 1.3's captured snapshots are not re-captured). Every Ollama unreachable outcome (closed port, unresolvable host, reset before the first byte) stays byte-identical, pinned by snapshots Task 3b.1 captures on `main` (P28). Those snapshots are re-captured only by a PR that intentionally changes that copy and says so in its body (Task 3b.1, "Re-capture rule"); this PR does not. So does every other existing taxonomy outcome except the changes Task 3b.13 declares, each pinned by a test.
- **No copy names `ANALYZER`.** PR 3a's entry criteria require #3201, which removed the retired `ANALYZER` env var from the `analyzer-unreachable` copy. No copy this PR adds or edits (`failure-remediations.ts`, `failure-taxonomy.ts`, `src/data/help-failures.ts`) names it; Task 3b.13 greps for it.
- **No reasoning or custom-payload controls (wave 5).** Until PRs 5a/5b, the endpoint create/update routes refuse a non-default `reasoning` and a non-empty `extraParams`, naming the PR that enables each (P23, Task 3b.5).

**Entry criteria.**
- PR 3a is merged.
- Wave 1's `withTransportRetry`, `StageRunner`/`TransportAnalyzer` and both transports exist on `main`.
- Wave 2's F7 mechanism — `AnalysisFailureFix`, `reasoningOverflowFixes(ctx)`, and its guard test (P20,
  approved by the owner 2026-09-13) — is merged, for Task 3b.1b's endpoint-half extension.

**Exit criteria.**
- All of these pass: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:server`, `npm run config:check`, `npm run check:cycles`.
- The OpenAI contract suite is green, and every mutation proof is pasted in the PR.
- `npm run openapi:types` leaves no diff.
- The register row, run sheet and live view are published per Task 3b.13.

---

### Task 3b.1: Typed wave-3 errors, three failure codes, 400 / 401 / 403 / unreachable / endpoint-status mapping, redaction

**Files:**
- Modify: `server/src/analyzer/errors.ts` (W1) — append after `AnalyzerEndpointMissingError` (Task 3a.2).
- Create: `server/src/analyzer/redact.ts`, `server/src/analyzer/redact.test.ts`.
- Create: `server/src/analyzer/limit-400-patterns.ts`, `server/src/analyzer/limit-400-patterns.test.ts`.
- Create: `server/src/analyzer/known-secrets-gate.ts` (leaf, no imports; A9 — unconditional, not a fallback).
- Modify: `server/src/workspace/user-settings.ts` — add `knownAnalyzerSecrets()` after `getResolvedGeminiApiKey` (`:1027-1033`), and register it with the gate.
- Modify: `server/src/routes/failure-taxonomy.ts`:
  - `:23-27` imports;
  - `:29-52` union;
  - after `:156` signature rows;
  - `:463-479` `statusToFailureCode`;
  - `:492-571` `classifyAnalysisFailure`.
- Modify: `server/src/routes/failure-remediations.ts` — insert three entries before `unknown` (`:247`); replace wave 2's `'analyzer-timeout'` remediation.
- Modify: `openapi.yaml:7033-7056` (`FailureCode` enum).
- Regenerate: `src/lib/api-types.ts`.
- Modify: `src/data/help-failures.ts:28-55` (`CATEGORIES`), `:57-81` (`TITLES`).
- Modify: `src/data/help-failures.test.ts:13`, `src/data/help-categories.test.ts:24`.
- Test: `server/src/routes/failure-taxonomy.test.ts` — sorted list `:400-428`, plus new describes.
- Test: `server/src/analyzer/ollama-http-failure-taxonomy.test.ts` (wave 1 Task 1.3) — re-capture the 400 snapshot only; add a 401 case.
- Test: `server/src/analyzer/unreachable-failure-taxonomy.test.ts` (new; three snapshots captured on `main` in Step 2 and committed alone, P28).

**Interfaces:**
- Consumes (W1): `TransportKind`, `AnalyzerHttpError`, `AnalyzerTruncatedError`, `AnalyzerUnreachableError`, and `ApiError` from `@google/genai`. (W2 2b): `AnalyzerTimeoutError`, FailureCode `analyzer-timeout`. (3a): `AnalyzerEndpointMissingError`.
- Produces (the contract signatures):
  - `AnalyzerStreamIncompleteError(transport, model, beforeResponse?: { causeCode: string | undefined })` — **contract addition (reported, Q1):** the optional third argument marks the pre-header case (P21), which carries `phase: 'before-response'` and a sanitized `causeCode` and names that code in its message. Without it the error is the mid-stream case, `phase: 'mid-stream'`, with today's message.
  - `AnalyzerKeyOriginError(endpointId, endpointName)`
  - `AnalyzerInvalidOutputError(transport, model, key, detail, structuredOutputMode)`
- Produces (additional): `redactKnownSecrets(text, secrets)`, `REDACTED`, `knownAnalyzerSecrets()` (in `user-settings.ts`, the provider); the leaf gate `known-secrets-gate.ts` with `registerKnownSecretsProvider({ known, load })`, `knownAnalyzerSecrets()` and `loadKnownAnalyzerSecrets()` — the names the master contract gives the gate, which every route, analyzer and transport module imports instead of `user-settings.ts` (A9); `causeCodeSuffix(causeCode)` in `errors.ts`, the one ` (CODE)` formatter every message we build uses (Q1); `LIMIT_400_PATTERNS` and `namesContextOrTokenLimit(text)` in the leaf `limit-400-patterns.ts`; `AnalyzerTransportError(transport, model, message, causeCode)` and `sanitizeCauseCode(value, secrets)` in `errors.ts` (P22 — the class the OpenAI transport rebuilds an unrecognised error into, Task 3b.11). **Contract addition (reported):** P22 calls the field "a sanitized `code`"; it is `causeCode`, because every analyzer error class already uses `code` for its own sentinel (`ANALYZER_UNREACHABLE`, …). **Moved forward from PR 3c (reported):** 3c.4's Test action uses the same table. Its rows and function are copied verbatim from w3cd Task 3c.4, which must import them from this leaf instead of defining them in `capabilities.ts`.

**Tests kept green:**
- `server/src/routes/failure-taxonomy.test.ts` — every existing case, including the Gemini 429/500/503 envelope cases.
- `server/src/analyzer/ollama-http-failure-taxonomy.test.ts` — the 404, 500 and 503 inline snapshots captured from `main` by wave 1 stay byte-identical. Only the 400 snapshot is re-captured (a declared change).
- `server/src/routes/analysis.test.ts`
- `src/data/help-failures.test.ts`
- `src/data/help-categories.test.ts`
- `src/views/generation.test.tsx`
- `src/lib/router.test.ts`

**Entry check — wave 2b's timeout exists.** `AnalyzerTimeoutError` and FailureCode `analyzer-timeout` are shipped by wave 2 Task 2.8 (PR 2b). This task adds neither. Before Step 1, run:
```bash
git grep -n 'class AnalyzerTimeoutError' server/src
git grep -n "'analyzer-timeout'" server/src/routes/failure-taxonomy.ts
```
Both must print a line. If either prints nothing, stop: PR 2b is not on `main`.

**Help counts.** Wave 2b left `help-failures.test.ts` / `help-categories.test.ts` at 25 / 51. This task adds three codes (`analyzer-request-rejected`, `analyzer-invalid-output`, `analyzer-endpoint-missing`), so they end at **28 / 54**. (The master plan's "four codes … 29/55" counts `analyzer-timeout` a second time; it is already in the 25.)

**Outcome changes this task makes** (each is pinned by a test below and declared in the PR body, Task 3b.13):
1. Any HTTP 400, from any transport: `unknown` → `analyzer-request-rejected`. A Gemini envelope keeps its `status:` / `details:` `detail` block (`failure-taxonomy.ts:556-560`).
2. Ollama 401 / 403: `unknown` → `auth`.
3. Validation failed after the retry: `unknown` → `analyzer-invalid-output` (Task 3b.2 throws the typed error).

**Not a change (P28).** Every Ollama `LocalUnreachableError` keeps `main`'s outcome, copy and detail exactly, including the ones `main`'s signature regex (`failure-taxonomy.ts:136-139`) misses (`ENOTFOUND`, `ECONNRESET`, `UND_ERR_SOCKET`, "aborted before first byte"): those stay `unknown` with the error's own message, so a mistyped host still reads `Ollama at <url> is unreachable (ENOTFOUND)`. The `instanceof AnalyzerUnreachableError` branch below applies to endpoint errors (`transport === 'openai'`) only.

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/redact.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { redactKnownSecrets, REDACTED } from './redact.js';

describe('redactKnownSecrets (#3084 PR 3b)', () => {
  it('replaces every occurrence of each secret, longest first', () => {
    const out = redactKnownSecrets('key sk-abcdefgh1234 and again sk-abcdefgh1234; prefix sk-abcdefgh', [
      'sk-abcdefgh',
      'sk-abcdefgh1234',
    ]);
    expect(out).toBe(`key ${REDACTED} and again ${REDACTED}; prefix ${REDACTED}`);
  });
  it('ignores secrets shorter than 8 characters and empty/null entries', () => {
    expect(redactKnownSecrets('json mode rejected', ['json', '', null, undefined])).toBe('json mode rejected');
  });
});
```

Append to `server/src/routes/failure-taxonomy.test.ts`.

First, replace the sorted list at `:402-426` with this final list. Wave 2b already added `analyzer-reasoning-overflow` and `analyzer-timeout`:
```ts
      [
        'analyzer-content-blocked',
        'analyzer-daily-quota',
        'analyzer-endpoint-missing',
        'analyzer-invalid-output',
        'analyzer-rate-limit',
        'analyzer-reasoning-overflow',
        'analyzer-request-rejected',
        'analyzer-timeout',
        'analyzer-truncated',
        'analyzer-unreachable',
        'attribution-incomplete',
        'attribution-collapse',
        'auth',
        'cloned-voice-broken',
        'cuda-poisoned',
        'disk-full',
        'gpu-acceleration-unavailable',
        'language-unset',
        'lock-contention',
        'model-not-loaded',
        'oom',
        'recycle-storm',
        'sidecar-unreachable',
        'synth-timeout',
        'unknown',
        'vram-spill',
        'voice-not-designed',
        'xtts-speaker-desync',
      ].sort(),
```

Then add these imports at the top:
```ts
import { afterEach } from 'vitest';
import { ApiError } from '@google/genai';
import {
  AnalyzerHttpError,
  AnalyzerKeyOriginError,
  AnalyzerTimeoutError,
  AnalyzerEndpointMissingError,
  AnalyzerInvalidOutputError,
  AnalyzerStreamIncompleteError,
  AnalyzerTransportError,
  AnalyzerUnreachableError,
  causeCodeSuffix,
  sanitizeCauseCode,
} from '../analyzer/errors.js';
import { LIMIT_400_PATTERNS } from '../analyzer/limit-400-patterns.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
```

And the new describe blocks:
```ts
describe('classifyAnalysisFailure — wave-3 analyzer codes (#3084 PR 3b)', () => {
  const savedKey = process.env.GEMINI_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    _resetUserSettingsCache();
  });

  it.each(['ollama', 'gemini', 'openai'] as const)(
    'AnalyzerHttpError(%s, 400) → analyzer-request-rejected naming that engine\'s request-shaping settings',
    (transport) => {
      const body = '{"error":"response_format.type must be json_schema or text"}';
      const r = classifyAnalysisFailure(
        new AnalyzerHttpError(transport, 400, body, `returned 400: ${body}`),
        'Some model',
      );
      expect(r.code).toBe('analyzer-request-rejected');
      expect(r.userMessage).toContain('rejected the request (400)');
      expect(r.userMessage).toContain('response_format.type must be json_schema');
      const expected = {
        ollama: 'analyzer.ollama.structuredOutput',
        gemini: 'analyzer.gemini.structuredOutput',
        openai: "the endpoint's Structured output field",
      }[transport];
      expect(r.remediation).toContain(expected);
    },
  );

  it('a Gemini ApiError 400 envelope → analyzer-request-rejected with the provider message, keeping the status/details detail block', () => {
    const err = new ApiError({
      status: 400,
      message:
        'got status: 400 Bad Request. {"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \\"minLength\\"","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.BadRequest","fieldViolations":[{"field":"generation_config.response_json_schema"}]}]}}',
    });
    const r = classifyAnalysisFailure(err, 'Gemini 3.6 Flash');
    expect(r.code).toBe('analyzer-request-rejected');
    expect(r.userMessage).toContain('Unknown name');
    expect(r.remediation).toContain('analyzer.gemini.structuredOutput');
    /* failure-taxonomy.ts:556-560 — the envelope's status and details stay in `detail`. */
    expect(r.detail).toContain('status: INVALID_ARGUMENT');
    expect(r.detail).toContain('details:');
    expect(r.detail).toContain('generation_config.response_json_schema');
  });

  it('an endpoint 400 naming a token or context limit points to the max-output field; a schema 400 does not (#3084 P24)', () => {
    const limited = classifyAnalysisFailure(
      new AnalyzerHttpError('openai', 400, LIMIT_400_PATTERNS[0].example, `returned 400: ${LIMIT_400_PATTERNS[0].example}`),
      'Endpoint lab (qwen3:30b)',
    );
    expect(limited.code).toBe('analyzer-request-rejected');
    expect(limited.remediation).toContain("the endpoint's Max output tokens field");
    const schema = classifyAnalysisFailure(
      new AnalyzerHttpError('openai', 400, "'response_format.type' must be 'json_schema' or 'text'", 'returned 400'),
      'Endpoint lab (qwen3:30b)',
    );
    expect(schema.remediation).not.toContain("the endpoint's Max output tokens field");
  });

  it('redacts a saved API key from the provider message and the detail', () => {
    delete process.env.GEMINI_API_KEY;
    _setUserSettingsCacheForTest({ geminiApiKey: 'AIzaSyTEST-SECRET-123456' });
    const body = '{"error":{"message":"key AIzaSyTEST-SECRET-123456 cannot use responseJsonSchema"}}';
    const r = classifyAnalysisFailure(
      new AnalyzerHttpError('gemini', 400, body, `Gemini returned 400: ${body}`),
      'Gemini',
    );
    expect(`${r.userMessage}\n${r.detail}`).not.toContain('AIzaSyTEST-SECRET-123456');
    expect(r.userMessage).toContain('[redacted]');
  });

  it.each([401, 403])('AnalyzerHttpError(openai, %i) → auth', (status) => {
    const r = classifyAnalysisFailure(
      new AnalyzerHttpError('openai', status, '{"error":"bad key"}', `returned ${status}`),
      'Endpoint lab (qwen3:30b)',
    );
    expect(r.code).toBe('auth');
    expect(r.userMessage).toContain("the endpoint's API key");
  });

  it('AnalyzerKeyOriginError → auth naming the endpoint to re-enter the key for', () => {
    const r = classifyAnalysisFailure(new AnalyzerKeyOriginError('lab', 'Lab box'), 'Endpoint lab (m)');
    expect(r.code).toBe('auth');
    expect(r.userMessage).toContain('re-enter the key for Lab box');
  });

  it('AnalyzerTimeoutError → analyzer-timeout', () => {
    const r = classifyAnalysisFailure(new AnalyzerTimeoutError('openai', 'm', 1_800_000, 'ceiling'), 'Endpoint lab (m)');
    expect(r.code).toBe('analyzer-timeout');
    expect(r.userMessage).toContain('1800 s');
    expect(r.detail).toContain('reason=ceiling');
    expect(r.remediation).toContain('endpoint');
  });

  it('AnalyzerEndpointMissingError → analyzer-endpoint-missing naming the id and its source', () => {
    const r = classifyAnalysisFailure(new AnalyzerEndpointMissingError('gone', 'env'), 'Endpoint gone (m)');
    expect(r.code).toBe('analyzer-endpoint-missing');
    expect(r.userMessage).toContain('"gone"');
    expect(r.userMessage).toContain('ANALYZER_PHASE0_MODEL');
  });

  it.each([
    ['schema', 'may not enforce'],
    ['json', 'constrains the structure'],
    ['off', 'structured output was off'],
  ] as const)('AnalyzerInvalidOutputError(mode %s) → analyzer-invalid-output with a mode-aware hint', (mode, hint) => {
    const r = classifyAnalysisFailure(
      new AnalyzerInvalidOutputError('ollama', 'qwen3.5:4b', '1-ch1', 'invalid-json — Unexpected token', mode),
      'Ollama (qwen3.5:4b)',
    );
    expect(r.code).toBe('analyzer-invalid-output');
    expect(r.userMessage).toContain(hint);
  });
});

describe('classifyAnalysisFailure — unreachable and endpoint final errors (#3084 PR 3b)', () => {
  const savedKey = process.env.GEMINI_API_KEY;
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    _resetUserSettingsCache();
  });

  it('AnalyzerUnreachableError from an endpoint → analyzer-unreachable naming the endpoint', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerUnreachableError('Endpoint qwen3:30b is unreachable (ECONNREFUSED).', 'openai'),
      'Endpoint lab (qwen3:30b)',
    );
    expect(r.code).toBe('analyzer-unreachable');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) could not be reached: Endpoint qwen3:30b is unreachable (ECONNREFUSED).');
    expect(r.remediation).toContain("endpoint's server");
  });

  it.each([
    [502, 'Endpoint lab (qwen3:30b) returned HTTP 502: '],
    [404, 'Endpoint lab (qwen3:30b) returned HTTP 404: '],
    [422, 'Endpoint lab (qwen3:30b) returned HTTP 422: '],
    [0, 'Endpoint lab (qwen3:30b) sent an error inside its response stream: '],
  ] as const)(
    'endpoint AnalyzerHttpError(%i) → unknown with a curated message naming the endpoint, the status and a redacted excerpt',
    (status, lead) => {
      _setUserSettingsCacheForTest({ geminiApiKey: 'AIzaSy-taxonomy-secret-1' });
      const body = '{"error":{"message":"upstream failed for key AIzaSy-taxonomy-secret-1"}}';
      const r = classifyAnalysisFailure(new AnalyzerHttpError('openai', status, body, `raw ${body}`), 'Endpoint lab (qwen3:30b)');
      expect(r.code).toBe('unknown');
      expect(r.userMessage).toBe(`${lead}{"error":{"message":"upstream failed for key [redacted]"}}`);
      expect(r.detail).toBe(`transport=openai status=${status}`);
      expect(`${r.userMessage}\n${r.detail}\n${r.remediation}`).not.toContain('AIzaSy-taxonomy-secret-1');
      expect(r.remediation).toContain("endpoint's server");
    },
  );

  it('AnalyzerStreamIncompleteError from an endpoint → unknown naming the endpoint', () => {
    const r = classifyAnalysisFailure(new AnalyzerStreamIncompleteError('openai', 'qwen3:30b'), 'Endpoint lab (qwen3:30b)');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe(
      'Endpoint lab (qwen3:30b) dropped the connection or stopped streaming before it finished its answer, and retrying did not help.',
    );
    expect(r.remediation).toContain("endpoint's server");
  });

  it('a pre-header AnalyzerStreamIncompleteError names its causeCode, so a DNS failure never reads as a mid-answer drop (P22)', () => {
    const err = new AnalyzerStreamIncompleteError('openai', 'qwen3:30b', { causeCode: 'EAI_AGAIN' });
    expect(err.phase).toBe('before-response');
    expect(err.causeCode).toBe('EAI_AGAIN');
    expect(err.message).toBe('Endpoint qwen3:30b dropped the connection before a response (EAI_AGAIN).');
    const r = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) dropped the connection before a response (EAI_AGAIN), and retrying did not help.');
    expect(r.userMessage).not.toContain('stopped streaming');
    expect(r.detail).toBe('transport=openai model=qwen3:30b causeCode=EAI_AGAIN');
  });

  it('AnalyzerTransportError → unknown naming the endpoint and appending its sanitized causeCode; the class chain goes to detail, never a raw cause (P22)', () => {
    const message =
      'Endpoint qwen3:30b request failed before a response (ERR_SSL_WRONG_VERSION_NUMBER) (APIConnectionError <- TypeError <- Error).';
    const err = new AnalyzerTransportError('openai', 'qwen3:30b', message, 'ERR_SSL_WRONG_VERSION_NUMBER');
    const r = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) request failed (ERR_SSL_WRONG_VERSION_NUMBER).');
    expect(r.detail).toBe(message);
    expect(r.remediation).toContain("endpoint's server");
    expect('cause' in err).toBe(false);
  });

  it('AnalyzerTransportError with no causeCode → the same copy with no code suffix (P22)', () => {
    const err = new AnalyzerTransportError('openai', 'qwen3:30b', 'Endpoint qwen3:30b request failed (RangeError).', undefined);
    const r = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) request failed.');
    expect(r.detail).toBe('Endpoint qwen3:30b request failed (RangeError).');
  });

  it('causeCodeSuffix is the one " (CODE)" shape, empty without a code (P22)', () => {
    expect(causeCodeSuffix('EAI_AGAIN')).toBe(' (EAI_AGAIN)');
    expect(causeCodeSuffix(undefined)).toBe('');
  });

  it('sanitizeCauseCode keeps an upper-case system code and drops anything else, including a secret (P22)', () => {
    expect(sanitizeCauseCode('ECONNRESET', [])).toBe('ECONNRESET');
    expect(sanitizeCauseCode('UND_ERR_SOCKET', [])).toBe('UND_ERR_SOCKET');
    expect(sanitizeCauseCode('sk-lowercase-key-1234', [])).toBeUndefined();
    expect(sanitizeCauseCode('ABCDEFGHSECRET', ['ABCDEFGHSECRET'])).toBeUndefined();
    expect(sanitizeCauseCode(42, [])).toBeUndefined();
  });

  it("the unknown fall-through redacts a saved key from a raw message (P22)", () => {
    _setUserSettingsCacheForTest({ geminiApiKey: 'AIzaSy-taxonomy-secret-1' });
    const r = classifyAnalysisFailure(new Error('weird failure mentioning AIzaSy-taxonomy-secret-1'), 'Some model');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe('weird failure mentioning [redacted]');
  });
});
```
Add `beforeEach` to that file's `vitest` import if it is not there.

**The "stays as on main" proof uses the real transports' thrown errors.** No hand-built `AnalyzerHttpError` is compared against a hand-built `Error` here.
- **HTTP (wave 1 Task 1.3).** `server/src/analyzer/ollama-http-failure-taxonomy.test.ts` captured its 404, 500 and 503 inline snapshots on `main`, from the errors the real `OllamaAnalyzer` threw. They are this task's proof that those outcomes stay, and are **not re-captured** here: this PR does not intentionally change that copy (see the "Re-capture rule" below, which applies to these snapshots too). That file changes in two places:
  1. In its `afterAll`, `for (const s of [400, 404, 500, 503])` becomes `for (const s of [400, 401, 404, 500, 503])`, and this case is appended inside its `describe` (declared change 2):
     ```ts
       it('401 unauthorised → auth (#3084 PR 3b; unknown on main)', async () => {
         const { outcome } = await classifyOllamaHttp(401, 'Unauthorized', '{"error":"unauthorized"}');
         expect(outcome.code).toBe('auth');
         expect(outcome.userMessage).toBe("Ollama (qwen3.5:9b) refused the credentials (401) — check the Ollama server's access settings.");
       });
     ```
  2. Its `400 invalid format` snapshot is re-captured in Step 4 (declared change 1). No other snapshot moves.
- **Unreachable (P28).** `server/src/analyzer/unreachable-failure-taxonomy.test.ts` (new) follows wave 1 Task 1.3's capture procedure. It drives the **real** `OllamaAnalyzer` over real sockets in three cases and records each outcome as an inline snapshot **captured on `main`**: this branch before any Task 3b.1 implementation, since 3b.1 is PR 3b's first task and PR 3a touches no taxonomy. The oracle is those captured values, never `FAILURE_REMEDIATIONS` or the signature scan, which the branch's own code also reads. The unresolvable host is host-independent: the resolver error is injected through the `Agent`'s `connect.lookup`, which undici spreads into `net.connect` (`undici/lib/core/connect.js:108-128`), so no machine's DNS (an `EAI_AGAIN` resolver included) can change the case. The port in each URL is replaced by `<ollama-url>` before snapshotting, so the snapshot does not depend on which port the OS hands out.
```ts
/* #3084 PR 3b, P28 — Ollama's unreachable failures keep main's taxonomy outcome,
   copy and detail EXACTLY. The inline snapshots are CAPTURED on main (this
   branch before Task 3b.1's implementation) with `-u`, then committed alone.
   RE-CAPTURE RULE: only a PR that intentionally changes this copy may re-capture
   them, and its PR body must say so and paste the snapshot diff. Any other PR
   never re-captures them: a red snapshot there is a regression to fix.
   REAL OllamaAnalyzer, real sockets, no fetch stub. */
import { afterAll, describe, expect, it } from 'vitest';
import { createServer as createNetServer, type LookupFunction } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import { OllamaAnalyzer } from './ollama.js';
import { classifyAnalysisFailure } from '../routes/failure-taxonomy.js';

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');
const ID = 'm_unreachable_taxonomy';
const agents: Agent[] = [];
const servers: Server[] = [];

async function closedPortUrl(): Promise<string> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

/* The resolver answers ENOTFOUND for every host, whatever this machine's DNS does. */
function enotfoundAgent(): Agent {
  const lookup: LookupFunction = (hostname, _options, callback) =>
    callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname }), []);
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000, lookup } });
  agents.push(agent);
  return agent;
}

/* A reachable daemon that answers /api/chat with 200 headers, then closes the socket
   before the first body byte (ollama.ts:757-760 → classifyConnectError). */
async function resetBeforeFirstByteUrl(): Promise<string> {
  const server = createHttpServer((req, res) => {
    if (req.url !== '/api/chat') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.flushHeaders();
      setTimeout(() => res.destroy(), 20);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function outcomeOf(url: string, dispatcher?: Agent) {
  const err = await new OllamaAnalyzer({ url, model: 'qwen3.5:4b', dispatcher })
    .runStage1Chapter(ID, 1, '# p', {})
    .then(() => null, (e: unknown) => e);
  expect(err).not.toBeNull();
  const r = classifyAnalysisFailure(err, 'Ollama (qwen3.5:4b)');
  const scrub = (s: string | undefined) => (s === undefined ? undefined : s.split(url).join('<ollama-url>'));
  return {
    name: (err as Error).name,
    message: scrub((err as Error).message),
    code: r.code,
    userMessage: scrub(r.userMessage),
    remediation: r.remediation,
    detail: scrub(r.detail),
  };
}

afterAll(async () => {
  await Promise.all(agents.splice(0).map((a) => a.destroy()));
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => {
      s.closeAllConnections();
      s.close(() => r());
    })),
  );
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

describe('Ollama unreachable → classifyAnalysisFailure (captured from main, #3084 P28)', () => {
  it('closed port', async () => {
    expect(await outcomeOf(await closedPortUrl())).toMatchInlineSnapshot();
  });

  it('unresolvable host (ENOTFOUND injected through the resolver)', async () => {
    expect(await outcomeOf('http://castwright-unresolvable.test:11434', enotfoundAgent())).toMatchInlineSnapshot();
  });

  it('reachable daemon that closes the socket before the first body byte', async () => {
    expect(await outcomeOf(await resetBeforeFirstByteUrl())).toMatchInlineSnapshot();
  });
});
```
The unresolvable host is `http://castwright-unresolvable.test:11434` with no port substitution, so the scrub replaces the whole URL there too.

**Re-capture rule (P28, A4).** These three snapshots, and wave 1's 404 / 500 / 503 snapshots, may be re-captured **only** in a PR that intentionally changes that Ollama copy, code or detail. That PR's body must say so under "Declared outcome changes", naming each re-captured snapshot and pasting its diff. No other PR re-captures them, this one included: a snapshot that goes red in any other PR is a regression to fix, not a baseline to refresh, and that holds for a copy change made as a side effect. A later fix that deliberately rewrites the copy (for example #3201's retired-`ANALYZER` wording) is exactly the PR that re-captures it, and declares it.

Change `src/data/help-failures.test.ts:13` to `    expect(HELP_FAILURE_ENTRIES.length).toBe(28);`, and the expected count at `src/data/help-categories.test.ts:24` to `54` (25 / 51 after wave 2b, plus three codes).

- [ ] **Step 2: Run and confirm failures**

Run:
```bash
npm --prefix server run test -- src/analyzer/redact.test.ts src/routes/failure-taxonomy.test.ts src/analyzer/unreachable-failure-taxonomy.test.ts
npm --prefix server run test -- src/analyzer/ollama-http-failure-taxonomy.test.ts --retry=0
npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts
```

Expected:
- `redact.test.ts` fails to resolve `./redact.js`.
- `failure-taxonomy.test.ts` fails on the new imports: `does not provide an export named 'AnalyzerKeyOriginError'` and `Failed to resolve import "../analyzer/limit-400-patterns.js"`.
- `unreachable-failure-taxonomy.test.ts` — **capture it now, before Step 3** (no 3b code exists yet, so this is `main`'s behaviour). Locally, with `CI` unset:
  ```bash
  npm --prefix server run test -- src/analyzer/unreachable-failure-taxonomy.test.ts -u --retry=0
  npm --prefix server run test -- src/analyzer/unreachable-failure-taxonomy.test.ts --retry=0
  git add server/src/analyzer/unreachable-failure-taxonomy.test.ts
  git commit -m "test(server): capture ollama unreachable taxonomy outcomes from main"
  ```
  The first run writes the three inline snapshots and the second passes without `-u`. Read them, do not edit them, and paste them into the PR body under "Captured taxonomy outcomes". Each snapshot's `name` must be `LocalUnreachableError`, and its `message` must name the failure the real code saw (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_SOCKET` or `ECONNRESET`). If a run of the reset case records a different code than the captured one, record both runs in the PR and route the case through `quarantinedIt` with a `docs/testing/flaky-register.md` line; do not re-capture (this PR does not intentionally change that copy, so the re-capture rule below forbids it).
- `ollama-http-failure-taxonomy.test.ts`:
  - `401 unauthorised → auth…` FAILS: received `unknown`.
  - The four captured snapshots stay green until the implementation.
- `help-failures` FAILS with `expected 25 to be 28`. `help-categories` FAILS with `expected 51 to be 54`.

- [ ] **Step 3: Implement**

`server/src/analyzer/redact.ts`:
```ts
/* Redact known credentials from upstream error text before it is logged or
   shown (#3084 Global Constraints "Secrets"). Pure: callers pass the secrets.
   Values shorter than 8 characters are ignored — they would blank ordinary
   words. Wave 5's payload redaction applies the same length rule. */
export const REDACTED = '[redacted]';

export function redactKnownSecrets(
  text: string,
  secrets: ReadonlyArray<string | null | undefined>,
): string {
  const usable = [
    ...new Set(secrets.filter((s): s is string => typeof s === 'string' && s.length >= 8)),
  ].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of usable) out = out.split(secret).join(REDACTED);
  return out;
}
```

`server/src/analyzer/limit-400-patterns.ts` (leaf, no imports). The rows and the function are w3cd Task 3c.4's, verbatim, moved here so the taxonomy hint (this task, P24) and the Test action (3c.4, P7) share one table:
```ts
/* #3084 P7 / P24 — provider messages that name a context, token or length limit.
   A 400 carrying one is about the request's SIZE: the taxonomy points it at the
   endpoint's max-output field (P24), and the Test action treats it as
   inconclusive rather than `rejected` (P7). Each `example` is a provider message
   quoted in the cited source; the test replays every row. Add a row only with a
   quoted message and its source. */
export const LIMIT_400_PATTERNS: ReadonlyArray<{ provider: string; pattern: RegExp; example: string; source: string }> = [
  {
    provider: 'llama.cpp server (message)',
    pattern: /exceeds the available context size/i,
    example: 'request (33056 tokens) exceeds the available context size (32768 tokens), try increasing it',
    source: 'llama-server 400 body quoted in https://github.com/NousResearch/hermes-agent/issues/89502',
  },
  {
    provider: 'llama.cpp server (error type)',
    pattern: /\bexceed_context_size_error\b/,
    example:
      '{"error":{"code":400,"message":"request (33056 tokens) exceeds the available context size (32768 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":33056,"n_ctx":32768}}',
    source: 'https://github.com/NousResearch/hermes-agent/issues/89502',
  },
  {
    provider: 'vLLM (vllm/renderers/params.py:418 _token_len_check)',
    pattern: /maximum context length is \d+ tokens/i,
    example:
      "This model's maximum context length is 128000 tokens. However, you requested 65535 output tokens and your prompt contains at least 62466 input tokens, for a total of at least 128001 tokens.",
    source: 'https://github.com/vllm-project/vllm/issues/42474',
  },
  {
    provider: 'vLLM (older releases)',
    pattern: /maximum context length is \d+ tokens/i,
    example:
      "This model's maximum context length is 16384 tokens. However, you requested 122946 tokens (112946 in the messages, 10000 in the completion). Please reduce the length of the messages or completion.",
    source: 'https://github.com/vllm-project/vllm/issues/20409',
  },
  {
    provider: 'OpenAI (context, error code)',
    pattern: /\bcontext_length_exceeded\b/,
    example:
      '{"error":{"message":"This model\'s maximum context length is 16385 tokens. However, your messages resulted in 44366 tokens","code":"context_length_exceeded"}}',
    source: 'message and code as reported in https://community.openai.com/t/gpt-4o-context-length-issue-input-tokens-within-limit-but-exceeds-maximum/1109543',
  },
  {
    provider: 'OpenAI (output cap)',
    pattern: /\bmax_(?:completion_)?tokens? is too large\b/i,
    example: 'max_token is too large: 32768. This model supports at most 4096 completion tokens.',
    source: 'https://community.zapier.com/troubleshooting-99/chatgpt-error-400-max-token-is-too-large-32768-this-model-supports-at-most-4096-completion-tokens-39804',
  },
  {
    provider: 'Gemini API (input)',
    pattern: /input token count \(\d+\) exceeds the maximum number of tokens allowed/i,
    example: 'The input token count (1236488) exceeds the maximum number of tokens allowed (1048576).',
    source: 'https://github.com/google-gemini/gemini-cli/issues/12493',
  },
  {
    provider: 'Gemini API (output cap)',
    pattern: /has a maxOutputTokens value of \d+/i,
    example: 'Unable to submit request because it has a maxOutputTokens value of 828858',
    source: 'https://discuss.ai.google.dev/t/unable-to-submit-request-because-it-has-a-maxoutputtokens-value-of-828858/101543',
  },
];

export function namesContextOrTokenLimit(text: string): boolean {
  return LIMIT_400_PATTERNS.some((row) => row.pattern.test(text));
}
```

`server/src/analyzer/limit-400-patterns.test.ts` (write it in Step 1; it fails to resolve until this file exists):
```ts
import { describe, it, expect } from 'vitest';
import { LIMIT_400_PATTERNS, namesContextOrTokenLimit } from './limit-400-patterns.js';

describe('LIMIT_400_PATTERNS (#3084 P7, P24)', () => {
  it.each(LIMIT_400_PATTERNS)('matches its own quoted example ($provider)', (row) => {
    expect(row.pattern.test(row.example)).toBe(true);
    expect(namesContextOrTokenLimit(row.example)).toBe(true);
  });
  it('does not match a structured-output rejection', () => {
    expect(namesContextOrTokenLimit("'response_format.type' must be 'json_schema' or 'text'")).toBe(false);
    expect(namesContextOrTokenLimit('Invalid JSON payload received. Unknown name "minLength"')).toBe(false);
  });
});
```

`server/src/analyzer/known-secrets-gate.ts` (new, **no imports** — A9). This is unconditional, not a cycle-check fallback: every route, analyzer and transport module that redacts reads the known secrets through it, so none of them gains an import edge to `user-settings.ts`, the pattern CLAUDE.md prescribes for `server/src/gpu/` leaf gates.
```ts
/* #3084 P22, A9 — leaf gate: the known analyzer secrets, readable from any route,
   analyzer or transport module without importing workspace/user-settings.ts (which
   would add an import edge that can close a cycle). user-settings.ts registers the
   provider at module load; server/src/index.ts imports user-settings.ts before any
   route or transport runs. Unregistered → [] (nothing known to redact): a module
   graph that never loaded user-settings.ts has no saved secret to leak. The names
   are the master contract's. */
export interface KnownSecretsProvider {
  /** synchronous view of the cached settings */
  known: () => string[];
  /** the same list after settings have been read at least once */
  load: () => Promise<string[]>;
}

let provider: KnownSecretsProvider | null = null;

export function registerKnownSecretsProvider(next: KnownSecretsProvider): void {
  provider = next;
}

export function knownAnalyzerSecrets(): string[] {
  return provider ? provider.known() : [];
}

export async function loadKnownAnalyzerSecrets(): Promise<string[]> {
  return provider ? provider.load() : [];
}
```

`server/src/workspace/user-settings.ts` — add `import { registerKnownSecretsProvider } from '../analyzer/known-secrets-gate.js';` to the top imports, and insert after `getResolvedGeminiApiKey` (`:1033`):
```ts
/** Every analyzer credential this process could send, for redacting upstream
    error text (#3084). Task 3b.6 adds the endpoint keys. */
export function knownAnalyzerSecrets(): string[] {
  const out: string[] = [];
  const gemini = getResolvedGeminiApiKey();
  if (gemini) out.push(gemini);
  return out;
}

/* #3084 A9 — the provider behind analyzer/known-secrets-gate.ts. Task 3b.6 replaces
   `load` with loadKnownAnalyzerSecrets once that exists. */
registerKnownSecretsProvider({ known: knownAnalyzerSecrets, load: async () => knownAnalyzerSecrets() });
```
`user-settings.ts` → `known-secrets-gate.ts` is the only edge this adds, and a leaf cannot close a cycle.

Append the block below to `server/src/analyzer/errors.ts`, after `AnalyzerEndpointMissingError` (Task 3a.2). `AnalyzerTimeoutError` is wave 2b's and is not touched.
```ts
/* ── #3084 PR 3b — wave-3 analyzer errors ───────────────────────────────── */

const TRANSPORT_LABEL: Record<TransportKind, string> = {
  ollama: 'Ollama',
  gemini: 'Gemini',
  openai: 'Endpoint',
};

/** #3084 P22 — the one shape every message we build uses for a sanitized cause code:
    ` (CODE)`, or nothing. The same suffix as PR 3c's catalog listing error
    (`Endpoint model listing failed (CODE).`). */
export function causeCodeSuffix(causeCode: string | undefined): string {
  return causeCode ? ` (${causeCode})` : '';
}

/** A stream that ended — cleanly, by socket drop, or by the idle watchdog —
    after response headers but before a finish reason (`phase: 'mid-stream'`); or
    (P21) a connection reset or DNS hiccup before headers (ECONNRESET,
    UND_ERR_SOCKET, EAI_AGAIN) from a server that may be up
    (`phase: 'before-response'`). Retried like an idle stream; never a fallback.
    #3084 P22 — the pre-header case names its sanitized `causeCode` in its message,
    so a persistent DNS failure never reads as a mid-answer drop. */
export class AnalyzerStreamIncompleteError extends Error {
  readonly code = 'ANALYZER_STREAM_INCOMPLETE';
  readonly phase: 'before-response' | 'mid-stream';
  readonly causeCode: string | undefined;
  constructor(
    readonly transport: TransportKind,
    readonly model: string,
    beforeResponse?: { causeCode: string | undefined },
  ) {
    super(
      beforeResponse
        ? `${TRANSPORT_LABEL[transport]} ${model} dropped the connection before a response${causeCodeSuffix(beforeResponse.causeCode)}.`
        : `${TRANSPORT_LABEL[transport]} ${model} dropped the connection or ended its stream before a finish reason.`,
    );
    this.name = 'AnalyzerStreamIncompleteError';
    this.phase = beforeResponse ? 'before-response' : 'mid-stream';
    this.causeCode = beforeResponse?.causeCode;
  }
}

/** #3084 P22 — a system error code safe to carry on an error we build: upper-case
    letters, digits and underscores only (ECONNRESET, UND_ERR_SOCKET), and never one
    containing a known secret. Anything else is dropped. */
export function sanitizeCauseCode(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) return undefined;
  return secrets.some((s) => s.length >= 8 && value.includes(s)) ? undefined : value;
}

/** #3084 P22 — what the OpenAI transport rebuilds an error it does not recognise
    into, instead of rethrowing the SDK's. The message is built only from error
    NAMES and the sanitized code (shown with causeCodeSuffix, so the user can
    diagnose ERR_SSL_WRONG_VERSION_NUMBER and friends), never from upstream text,
    and there is no `cause`:
    a logged error prints its cause chain, and undici's header errors embed the
    header value (`Headers.append: "Bearer <key>" is an invalid header value.`). */
export class AnalyzerTransportError extends Error {
  readonly code = 'ANALYZER_TRANSPORT';
  constructor(
    readonly transport: TransportKind,
    readonly model: string,
    message: string,
    readonly causeCode: string | undefined,
  ) {
    super(message);
    this.name = 'AnalyzerTransportError';
  }
}

/** The saved key for an endpoint was bound to a different origin than the URL
    about to be called (decision 3c). No request was sent. Maps to `auth`. */
export class AnalyzerKeyOriginError extends Error {
  readonly code = 'ANALYZER_KEY_ORIGIN';
  constructor(
    readonly endpointId: string,
    readonly endpointName: string,
  ) {
    super(
      `The API key saved for ${endpointName} was entered for a different host — re-enter the key for ${endpointName}.`,
    );
    this.name = 'AnalyzerKeyOriginError';
  }
}

/** Validation failed after the retry. The message is exactly today's text
    (ollama.ts:608-610, gemini.ts:515-517); `detail` is the
    "<kind> — <summarised detail>" string the runner builds. */
export class AnalyzerInvalidOutputError extends Error {
  readonly code = 'ANALYZER_INVALID_OUTPUT';
  constructor(
    readonly transport: TransportKind,
    readonly model: string,
    readonly key: string,
    readonly detail: string,
    readonly structuredOutputMode: 'schema' | 'json' | 'off',
  ) {
    super(
      transport === 'gemini'
        ? `Gemini ${key} failed validation after retry: ${detail}`
        : `${TRANSPORT_LABEL[transport]} ${model} ${key} failed validation after retry: ${detail}`,
    );
    this.name = 'AnalyzerInvalidOutputError';
  }
}
```
`structuredOutputMode` is typed inline rather than imported from `runner/transport.ts`. That keeps `errors.ts` free of an `import type` edge into the runner. `runner/transport.ts` imports `TransportKind` from `errors.ts`, so that edge would close an `errors.ts ↔ runner/transport.ts` cycle, and madge counts type edges. The runner reads `StageCall` from the leaf `server/src/analyzer/types.ts` (wave 1 Task 1.5), never from `index.ts`.

`server/src/routes/failure-remediations.ts` — insert before `  unknown: {` (`:247`):
```ts
  'analyzer-request-rejected': {
    /* #3084 — a 400 from Ollama, Gemini or an OpenAI-compatible endpoint. The
       live message carries the provider's own (redacted) text and names the
       settings that shape the request; this is the offline Help copy. */
    userMessage:
      'The analyzer refused the request as invalid (HTTP 400) — something about how the request ' +
      'was shaped is not accepted by this model or server.',
    remediation:
      'Change one of the settings named in the error for this engine or endpoint, then retry. ' +
      'Castwright never retries a rejected request with a setting silently removed.',
    helpDetail:
      'A 400 has many causes: a structured-output mode the server does not support (LM Studio ' +
      'rejects "json", for example), a context or output size larger than the server allows, or an ' +
      "option the model does not accept. The provider's message is shown with any saved keys removed.",
  },
  'analyzer-invalid-output': {
    userMessage:
      "The analyzer's reply did not match the expected structure, even after an automatic retry.",
    remediation:
      'Retry the chapter. If it keeps failing, set Structured output to "schema" for this engine or ' +
      'endpoint, or pick a stronger model.',
  },
  'analyzer-endpoint-missing': {
    userMessage: 'The run names an analyzer endpoint that is not configured.',
    remediation:
      'Add the endpoint in Settings, or pick a different model for this run. If the model came from ' +
      'ANALYZER_PHASE0_MODEL / ANALYZER_PHASE1_MODEL in server/.env, fix or clear that value.',
  },
```

Wave 2b's `'analyzer-timeout'` entry stays, except its `remediation`, which names only the Gemini ceiling. Replace that remediation with:
```ts
    remediation:
      "Retry the chapter. If it recurs, raise the time limit of the engine that timed out — 'Gemini request " +
      "ceiling' (ANALYZER_GEMINI_REQUEST_CEILING_MS) for Gemini, or the endpoint's request time limit for an " +
      "OpenAI-compatible endpoint — lower the model's reasoning level, or switch to a faster analyzer model.",
```

`server/src/routes/failure-taxonomy.ts`:

1. Imports. Replace `:25-26` — as wave 2b left them, including its `../analyzer/errors.js` import, which wave 2b widened to `AnalyzerReasoningOverflowError`, `AnalyzerTimeoutError` and `AnalyzerTruncatedError` (w2 Task 2.8's "Import" bullet) — with the block below. It keeps every name wave 2b imports: `AnalyzerReasoningOverflowError` is read by wave 2b's `analyzer-reasoning-overflow` branch, which this task does not touch (A3).
```ts
import { ApiError } from '@google/genai';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import {
  AnalyzerTruncatedError,
  AnalyzerHttpError,
  AnalyzerKeyOriginError,
  AnalyzerReasoningOverflowError,
  AnalyzerTimeoutError,
  AnalyzerEndpointMissingError,
  AnalyzerInvalidOutputError,
  AnalyzerStreamIncompleteError,
  AnalyzerTransportError,
  AnalyzerUnreachableError,
  causeCodeSuffix,
  type TransportKind,
} from '../analyzer/errors.js';
import { redactKnownSecrets } from '../analyzer/redact.js';
import { namesContextOrTokenLimit } from '../analyzer/limit-400-patterns.js';
/* #3084 A9 — through the leaf gate, never an import of workspace/user-settings.ts. */
import { knownAnalyzerSecrets } from '../analyzer/known-secrets-gate.js';
```
If wave 2b's import on `main` holds a name this list lacks, add it; never drop one.

2. Union. After `  | 'analyzer-content-blocked'` (`:37`), add:
```ts
  | 'analyzer-request-rejected'
  | 'analyzer-invalid-output'
  | 'analyzer-endpoint-missing'
```
Wave 2b's `| 'analyzer-timeout'` line is already in the union.

3. Signature rows. After the `analyzer-content-blocked` row (ends `:156`), insert:
```ts
  /* #3084 PR 3b — typed wave-3 analyzer errors, name-driven like
     analyzer-truncated. classifyAnalysisFailure handles each first with a
     dynamic message; these rows keep the bare classifyAnalysisError scan in
     step. Status-driven outcomes (request-rejected, auth for endpoint keys)
     have no row: they need the error's HTTP status, read in
     classifyAnalysisFailure. */
  {
    code: 'analyzer-endpoint-missing',
    fatal: true,
    source: 'analysis',
    matchName: 'AnalyzerEndpointMissingError',
    match: () => false,
  },
  {
    code: 'analyzer-invalid-output',
    fatal: false,
    source: 'analysis',
    matchName: 'AnalyzerInvalidOutputError',
    match: () => false,
  },
```
Wave 2b's `analyzer-timeout` row stays as it is. `fatal` is inert on the analysis path (wave 2 Task 2.9's note: its one reader is generation); these values follow the neighbouring rows.

4. `statusToFailureCode`. Replace the comment and function at `:463-479` with:
```ts
/* classifyStatus, ported from analysis.ts — now emits FailureCode per the
   spec-A2 mapping (rate_limit→analyzer-rate-limit, daily_quota→analyzer-daily-quota,
   unavailable/internal→analyzer-unreachable, invalid_key→auth). #3084 PR 3b:
   bad_request (400) → analyzer-request-rejected (was unknown). */
function statusToFailureCode(status: number | undefined, message?: string): FailureCode {
  if (!status) return 'unknown';
  if (status === 429) {
    /* Same per_day marker as the analyzer-daily-quota signature, but applied to the parsed envelope MESSAGE
       only (raw would false-positive on per-minute quotaValue details). Do not unify. The
       `quotaValue":"\d{1,3}"` clause was DROPPED (#1695) — a per-minute RPM 429 carries the
       2-digit free-tier cap (quotaValue":"15") and would mis-classify as daily. */
    if (message && /per[_-]?day/i.test(message)) return 'analyzer-daily-quota';
    return 'analyzer-rate-limit';
  }
  if (status === 400) return 'analyzer-request-rejected';
  if (status === 503 || status === 500) return 'analyzer-unreachable';
  if (status === 401 || status === 403) return 'auth';
  return 'unknown';
}

/* #3084 PR 3b — the settings that shape a request, per transport, named in an
   analyzer-request-rejected remediation. Wave 5 adds the reasoning and
   custom-payload settings when they exist. */
const REQUEST_SHAPING_SETTINGS: Record<TransportKind, string[]> = {
  ollama: [
    'Ollama structured output (analyzer.ollama.structuredOutput)',
    'Ollama num_ctx (analyzer.ollama.numCtx)',
    'Ollama num_predict (analyzer.ollama.numPredict)',
  ],
  gemini: [
    'Gemini structured output (analyzer.gemini.structuredOutput)',
    'Gemini max output tokens (analyzer.gemini.maxOutputTokens)',
  ],
  openai: [
    "the endpoint's Structured output field",
    "the endpoint's Context size field",
    "the endpoint's Max output tokens field",
  ],
};

const KEY_SETTING: Record<TransportKind, string> = {
  ollama: "the Ollama server's access settings",
  gemini: 'the Gemini API key (Settings, or GEMINI_API_KEY in server/.env)',
  openai: "the endpoint's API key",
};

/* #3084 P24 — an endpoint 400 whose message names a context, token or length
   limit is about the request's size. Auto output leaves a margin, but the
   input size is an estimate. */
const ENDPOINT_TOKEN_LIMIT_HINT =
  " The message names a token or context limit: lower the endpoint's Max output tokens field " +
  '(0 = Auto), or set its Context size field to the context the server actually serves.';

/* #3084 PR 3b — copy for an endpoint's final errors that no FailureCode fits
   exactly. `analyzer-unreachable` tells the user to start Ollama, `analyzer-request-rejected`
   is 400-only by contract, and `model-not-loaded` is TTS copy, so these classify
   as `unknown` with a curated message instead of the raw one. */
const ENDPOINT_FAILURE_REMEDIATION =
  "Check the endpoint's server log and that the model name exists on that server, then retry the " +
  'chapter. If it keeps failing, pick a different model or endpoint for this run.';
const ENDPOINT_UNREACHABLE_REMEDIATION =
  "Check that the endpoint's server is running and that its base URL in Settings is right, then " +
  'retry. Castwright switches to Gemini only when a Gemini key is saved and cloud fallback is on.';

function requestRejected(
  modelLabel: string,
  transport: TransportKind | undefined,
  providerMessage: string,
  envelopeDetail?: string,
): AnalysisFailure {
  const secrets = knownAnalyzerSecrets();
  const redacted = redactKnownSecrets(providerMessage, secrets).slice(0, 500);
  const settings = transport
    ? REQUEST_SHAPING_SETTINGS[transport]
    : Object.values(REQUEST_SHAPING_SETTINGS).flat();
  const limitHint = transport === 'openai' && namesContextOrTokenLimit(providerMessage) ? ENDPOINT_TOKEN_LIMIT_HINT : '';
  return {
    code: 'analyzer-request-rejected',
    userMessage: `${modelLabel} rejected the request (400): ${redacted}`,
    remediation: `${FAILURE_REMEDIATIONS['analyzer-request-rejected'].remediation} Settings that shape this request: ${settings.join('; ')}.${limitHint}`,
    /* A Google envelope keeps main's status/details block (failure-taxonomy.ts:556-560). */
    detail: (envelopeDetail !== undefined ? redactKnownSecrets(envelopeDetail, secrets) : redacted) || undefined,
  };
}

const INVALID_OUTPUT_HINT: Record<AnalyzerInvalidOutputError['structuredOutputMode'], string> = {
  schema: 'structured output was "schema"; this model or server may not enforce it',
  json: 'structured output was "json" — "schema" constrains the structure as well as the syntax',
  off: 'structured output was off — "json" or "schema" usually prevents this',
};
```

5. `classifyAnalysisFailure`. Immediately after the `DailyQuotaExhaustedError` branch (ends `:541`), insert:
```ts
  if (err instanceof AnalyzerKeyOriginError) {
    return withCopy(
      'auth',
      `The API key saved for ${err.endpointName} was entered for a different host, so it was not sent — re-enter the key for ${err.endpointName}.`,
    );
  }
  if (err instanceof AnalyzerUnreachableError && err.transport === 'openai') {
    /* #3084 PR 3b, P28 — ENDPOINT errors only. Ollama's LocalUnreachableError
       (transport 'ollama') does not enter this branch: it falls through to main's
       path below (the signature scan over its message), so its code, copy and
       detail stay exactly main's (unreachable-failure-taxonomy.test.ts, captured
       on main). */
    return {
      code: 'analyzer-unreachable',
      userMessage: `${modelLabel} could not be reached: ${redactKnownSecrets(err.message, knownAnalyzerSecrets())}`,
      remediation: ENDPOINT_UNREACHABLE_REMEDIATION,
    };
  }
  if (err instanceof AnalyzerHttpError) {
    if (err.httpStatus === 401 || err.httpStatus === 403) {
      return withCopy(
        'auth',
        `${modelLabel} refused the credentials (${err.httpStatus}) — check ${KEY_SETTING[err.transport]}.`,
        redactKnownSecrets(err.bodyExcerpt, knownAnalyzerSecrets()) || undefined,
      );
    }
    if (err.httpStatus === 400) return requestRejected(modelLabel, err.transport, err.bodyExcerpt);
    if (err.transport === 'openai') {
      /* #3084 PR 3b — an endpoint that answered with any other status (5xx, 404,
         422, or 0 for an error event inside the stream) is never "unreachable"
         (P21). No FailureCode fits it exactly (see ENDPOINT_FAILURE_REMEDIATION),
         so: `unknown`, a curated message and the redacted excerpt. An Ollama
         AnalyzerHttpError falls through to main's handling below, unchanged. */
      const excerpt = redactKnownSecrets(err.bodyExcerpt, knownAnalyzerSecrets()).slice(0, 500);
      const what = err.httpStatus === 0 ? 'sent an error inside its response stream' : `returned HTTP ${err.httpStatus}`;
      return {
        code: 'unknown',
        userMessage: `${modelLabel} ${what}: ${excerpt}`,
        remediation: ENDPOINT_FAILURE_REMEDIATION,
        detail: `transport=openai status=${err.httpStatus}`,
      };
    }
  }
  if (err instanceof AnalyzerStreamIncompleteError) {
    /* #3084 P22 — the pre-header case (a reset or DNS failure before any response)
       appends its sanitized cause code, so a persistent DNS failure never reads as
       a mid-answer drop. */
    return {
      code: 'unknown',
      userMessage:
        err.phase === 'before-response'
          ? `${modelLabel} dropped the connection before a response${causeCodeSuffix(err.causeCode)}, and retrying did not help.`
          : `${modelLabel} dropped the connection or stopped streaming before it finished its answer, and retrying did not help.`,
      remediation: ENDPOINT_FAILURE_REMEDIATION,
      detail: `transport=${err.transport} model=${err.model}${err.causeCode ? ` causeCode=${err.causeCode}` : ''}`,
    };
  }
  if (err instanceof AnalyzerTransportError && err.transport === 'openai') {
    /* #3084 P22 — a rebuilt transport error (rule 7). Its message holds only class
       names and the sanitized code. The curated copy names the endpoint and appends
       the code (ERR_SSL_WRONG_VERSION_NUMBER: https:// against a plain-HTTP server;
       UNABLE_TO_VERIFY_LEAF_SIGNATURE: an untrusted certificate;
       ERR_TLS_CERT_ALTNAME_INVALID: a hostname mismatch); the class chain goes to
       detail. Without this branch the fall-through signature scan could read a
       code-bearing message as Ollama copy. */
    return {
      code: 'unknown',
      userMessage: `${modelLabel} request failed${causeCodeSuffix(err.causeCode)}.`,
      remediation: ENDPOINT_FAILURE_REMEDIATION,
      detail: redactKnownSecrets(err.message, knownAnalyzerSecrets()),
    };
  }
  if (err instanceof AnalyzerEndpointMissingError) {
    return withCopy(
      'analyzer-endpoint-missing',
      `${err.message} Add it in Settings or pick another model.`,
    );
  }
  if (err instanceof AnalyzerInvalidOutputError) {
    return withCopy(
      'analyzer-invalid-output',
      `${modelLabel} returned output that failed validation twice (${INVALID_OUTPUT_HINT[err.structuredOutputMode]}).`,
      redactKnownSecrets(err.detail, knownAnalyzerSecrets()),
    );
  }
```
Wave 2b's `AnalyzerTimeoutError` branch, after the `AnalyzerTruncatedError` branch, stays as it is; it already covers `transport: 'openai'` ("this endpoint's request ceiling").

Replace `const raw = (err as Error)?.message ?? String(err);` (`:542`) with:
```ts
  /* #3084 P22 — every branch below that shows raw provider text (the envelope,
     the bare status, the unknown fall-through) shows it with known secrets
     removed. With no secret present the text is unchanged. */
  const raw = redactKnownSecrets((err as Error)?.message ?? String(err), knownAnalyzerSecrets());
```

In the envelope branch, directly after `const code = statusToFailureCode(parsed.code ?? status, parsed.message);` (`:547`), insert:
```ts
    if (code === 'analyzer-request-rejected') {
      return requestRejected(
        modelLabel,
        err instanceof ApiError ? 'gemini' : undefined,
        parsed.message,
        formatErrorDetail(parsed, raw),
      );
    }
```

Replace the bare-status branch (`:562-564`) with:
```ts
  if (status) {
    const code = statusToFailureCode(status, raw);
    if (code === 'analyzer-request-rejected') {
      return requestRejected(modelLabel, err instanceof ApiError ? 'gemini' : undefined, raw);
    }
    return withCopy(code, `${modelLabel} returned ${status}: ${raw}`);
  }
```
The final `return withCopy('unknown', raw || 'Analysis failed.');` (`:571`) is unchanged in text: `raw` is already redacted.

`openapi.yaml`: after `        - language-unset` (`:7056`), add:
```yaml
        - analyzer-request-rejected
        - analyzer-invalid-output
        - analyzer-endpoint-missing
```
Wave 2b already added `- analyzer-timeout`. Then run `npm run openapi:types`.

`src/data/help-failures.ts` (wave 2b already added the `analyzer-timeout` category and title):
- In `CATEGORIES`, after `'analyzer-content-blocked': 'analysis',` (`:36`):
  ```ts
    'analyzer-request-rejected': 'analysis',
    'analyzer-invalid-output': 'analysis',
    'analyzer-endpoint-missing': 'analysis',
  ```
- In `TITLES`, after `'analyzer-content-blocked': …,` (`:65`):
  ```ts
    'analyzer-request-rejected': 'Analyzer rejected the request',
    'analyzer-invalid-output': 'Analyzer reply failed validation',
    'analyzer-endpoint-missing': 'Analyzer endpoint not configured',
  ```

- [ ] **Step 4: Run and confirm pass**

First re-capture the one declared snapshot change, locally with `CI` unset. Run it with `-t` so no other snapshot can be rewritten:
```bash
npm --prefix server run test -- src/analyzer/ollama-http-failure-taxonomy.test.ts -u -t "400 invalid format" --retry=0
git diff server/src/analyzer/ollama-http-failure-taxonomy.test.ts
```
The diff must show the `400 invalid format` snapshot's `code` moving from `unknown` to `analyzer-request-rejected`, plus the 401 case and the `afterAll` list — and nothing in the 404, 500 or 503 snapshots. Paste it in the PR body under "Declared outcome changes".

Then:
```bash
npm --prefix server run test -- src/analyzer/redact.test.ts src/analyzer/limit-400-patterns.test.ts src/routes/failure-taxonomy.test.ts src/analyzer/unreachable-failure-taxonomy.test.ts src/routes/analysis.test.ts
npm --prefix server run test -- src/analyzer/ollama-http-failure-taxonomy.test.ts --retry=0
npx vitest run src/data src/lib/router.test.ts src/views/generation.test.tsx
npm run typecheck
npm run check:cycles
```

Expected: PASS. The three `unreachable-failure-taxonomy.test.ts` snapshots captured in Step 2 pass without `-u`.

**Import-cycle check (A9).** `failure-taxonomy.ts` reads known secrets through the leaf `known-secrets-gate.ts`, never through `user-settings.ts`, so this task adds no edge from a route to `user-settings.ts`. The only new edges end at leaves (`known-secrets-gate.ts`, `redact.ts`, `limit-400-patterns.ts`), which cannot close a cycle.
1. **Before Step 1**, on the unmodified branch, run `npm run check:cycles` and record the count `N` it prints. Expected stdout: `check-import-cycles: OK — N circular dependencies found, all allowlisted (server/madge-cycles-allowlist.json).`
2. **Here**, run `npm run check:cycles` again. Expected stdout: the same line with the same `N`, and exit code 0.
3. Any other count, or exit code 1, fails this task. Find the edge this task added, route it through the gate, and re-run; never allowlist it.

`failure-taxonomy.test.ts` imports `user-settings.js`, so the provider is registered in its runs; the mutation row "delete `registerKnownSecretsProvider(…)`" below proves the redaction cases depend on that registration.

- [ ] **Step 5: Mutation proofs**

Revert one line at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| Delete `if (status === 400) return 'analyzer-request-rejected';` | `a Gemini ApiError 400 envelope → analyzer-request-rejected…` |
| In the envelope branch, drop the `formatErrorDetail(parsed, raw)` argument | `…keeping the status/details detail block` |
| Delete `if (err.httpStatus === 400) return requestRejected(…);` | `AnalyzerHttpError(openai, 400) → analyzer-request-rejected…` |
| `limitHint` → always `''` | `an endpoint 400 naming a token or context limit points to the max-output field…` |
| `redactKnownSecrets` body → `return text;` | `redacts a saved API key…`, `the unknown fall-through redacts a saved key…`, `endpoint AnalyzerHttpError(502) → unknown…` |
| `const raw = redactKnownSecrets(…)` → `const raw = (err as Error)?.message ?? String(err);` | `the unknown fall-through redacts a saved key from a raw message (P22)` |
| Remove the `(err.httpStatus === 401 \|\| err.httpStatus === 403)` branch | `AnalyzerHttpError(openai, 401) → auth` and `401 unauthorised → auth…` |
| Delete the `if (err.transport === 'openai') { … }` status block | `endpoint AnalyzerHttpError(502) → unknown…` (the 502 then reads as `analyzer-unreachable`) |
| Drop `if (err.transport === 'openai')` so the block applies to every transport | wave 1's `404 model not found`, `500 runner terminated` and `503 server busy` snapshots |
| Delete the `AnalyzerUnreachableError` branch | `AnalyzerUnreachableError from an endpoint → analyzer-unreachable…` |
| Drop `&& err.transport === 'openai'`, so Ollama's `LocalUnreachableError` takes the endpoint branch (P28) | all three captured snapshots in `unreachable-failure-taxonomy.test.ts`: `closed port`, `unresolvable host…` and `reachable daemon that closes the socket…` (their `userMessage` / `remediation` become the endpoint copy) |
| Delete the `AnalyzerStreamIncompleteError` branch | `AnalyzerStreamIncompleteError from an endpoint → unknown naming the endpoint` |
| `sanitizeCauseCode`: drop the `secrets.some(…)` check | `sanitizeCauseCode keeps an upper-case system code and drops anything else, including a secret (P22)` |
| `sanitizeCauseCode`: drop the character-class test (`return secrets.some(…) ? undefined : value` for any string) | the same test (`sk-lowercase-key-1234` survives) |
| Delete the `AnalyzerTransportError` branch in `classifyAnalysisFailure` (Q1) | `AnalyzerTransportError → unknown naming the endpoint and appending its sanitized causeCode…` (`userMessage` is the raw message) and `AnalyzerTransportError with no causeCode…` |
| In that branch, drop `${causeCodeSuffix(err.causeCode)}` | `AnalyzerTransportError → unknown naming the endpoint and appending its sanitized causeCode…` |
| In the `AnalyzerStreamIncompleteError` branch, always use the mid-stream copy | `a pre-header AnalyzerStreamIncompleteError names its causeCode…` |
| `AnalyzerStreamIncompleteError`'s constructor: always build the mid-stream message | `a pre-header AnalyzerStreamIncompleteError names its causeCode…` (`err.message`) |
| `causeCodeSuffix` body → `return '';` | `causeCodeSuffix is the one " (CODE)" shape…`, `a pre-header AnalyzerStreamIncompleteError names its causeCode…` and `AnalyzerTransportError → unknown naming the endpoint and appending…` |
| In `user-settings.ts`, delete `registerKnownSecretsProvider(…)` (A9) | `redacts a saved API key from the provider message and the detail`, `the unknown fall-through redacts a saved key from a raw message (P22)` and `endpoint AnalyzerHttpError(502) → unknown…` (the gate returns `[]`) |
| Drop `AnalyzerReasoningOverflowError` from the `../analyzer/errors.js` import (A3) | `npm run typecheck` (`TS2304: Cannot find name 'AnalyzerReasoningOverflowError'` in `failure-taxonomy.ts`), and wave 2b's `→ analyzer-reasoning-overflow, naming the Gemini max-output setting and the reasoning level` (a `ReferenceError` at run time) |

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/known-secrets-gate.ts server/src/analyzer/errors.ts server/src/analyzer/redact.ts server/src/analyzer/redact.test.ts server/src/analyzer/limit-400-patterns.ts server/src/analyzer/limit-400-patterns.test.ts server/src/analyzer/unreachable-failure-taxonomy.test.ts server/src/analyzer/ollama-http-failure-taxonomy.test.ts server/src/workspace/user-settings.ts server/src/routes/failure-taxonomy.ts server/src/routes/failure-remediations.ts server/src/routes/failure-taxonomy.test.ts openapi.yaml src/lib/api-types.ts src/data/help-failures.ts src/data/help-failures.test.ts src/data/help-categories.test.ts
git commit -m "feat(server,openapi): add request-rejected, invalid-output and endpoint-missing failure codes"
```

---

### Task 3b.1a: Every selection call site reports a coded error (P23)

From PR 3a on, selection throws `AnalyzerEndpointMissingError` for an endpoint id, and from PR 3d it can also throw `AnalyzerKeyOriginError`. Task 3b.1 gives both a FailureCode. This task makes every place that calls selection catch **any** error selection throws and report its classified code through `classifyAnalysisFailure`:
- `AnalyzerEndpointMissingError` → `analyzer-endpoint-missing`;
- `AnalyzerKeyOriginError` → `auth`;
- any other error → its classified code (a plain `Error` is `unknown` with its own message; selection's missing-Gemini-key error matches the `auth` signature, whose copy does not say what is missing, so the event keeps `Gemini API key required` as its `detail`).

No selection error ends a stream uncoded, and no call site rethrows after the SSE headers were sent. The fix is per class of error, not per site: the helper never returns null, so a class PR 3d or later adds is coded without touching the sites.

**The six call sites on `origin/main`** (after #3163, #3199 and #3173; locate each by the quoted code, since line numbers drift):

| Site | Code | Today on an `AnalyzerEndpointMissingError` | Change |
|---|---|---|---|
| analysis phase 0, `analysisRouter.post('/:id/analysis')` | `selection = selectAnalyzerForPhase({ phase: 'phase0', model: requestedModel, userSettings });` in a `try` (`routes/analysis.ts:3371-3377`) | `send({ kind: 'error', message })`, no code, for every selection error | coded event, every error |
| subset retry, `analysisRouter.post('/:id/analysis/chapters')` | the phase-0 and phase-1 `selectAnalyzerForPhase` pair in one `try` (`:6662-6673`) | same code-less `send` | coded event, every error |
| analysis phase 1, `runMainAnalyzerJob` | `selectAnalyzerForPhase({ phase: 'phase1', … })` (`:3679`), inside the job's `try` (`:3614`), whose catch calls `classifyAnalysisFailure` (`:6394-6451`) | already classified (`unknown` for an endpoint id before Task 3b.1; `analyzer-endpoint-missing` after it) | none — pinned by a test |
| annotate-emotion | `const selection = selectAnalyzerForPhase({ phase: 'phase1', model: req.body?.model });` (`routes/annotate-emotion.ts:147`), outside any `try`, after the SSE headers are flushed | any throw escapes the handler: no error event | coded event, every error, no rethrow |
| instruct-annotation | the same line (`routes/instruct-annotation.ts:146`) | same | coded event, every error, no rethrow |
| script review | `selectAnalyzerForPhase({ phase: 'phase1', model })` in `runScriptReviewJob` (`routes/script-review.ts:713`); the launch's detached `.catch` broadcasts `code: 'internal_error'` (`:448`) for any throw from the job | `internal_error` | selection wrapped in its own `try` inside the job: coded event, every error. A throw from later in the job still reaches the launch `.catch` as `internal_error` |

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts` — add `analyzerSelectionErrorEvent` directly after `classifyAnalysisFailure`.
- Modify: `server/src/routes/analysis.ts` — the two selection `catch` blocks above.
- Modify: `server/src/routes/annotate-emotion.ts`, `server/src/routes/instruct-annotation.ts` — the selection line and imports.
- Modify: `server/src/routes/script-review.ts` — the selection line in `runScriptReviewJob`, and imports. The launch's detached `.catch` is **not** changed.
- Test: `server/src/routes/failure-taxonomy.test.ts` (add), `server/src/routes/analysis.endpoint-missing.test.ts` (new), `server/src/routes/annotate-emotion.test.ts` (add), `server/src/routes/instruct-annotation.test.ts` (add), `server/src/routes/script-review.test.ts` (add).

None of these test files is in `server/vitest.config.slow.ts`'s `SLOW_FILES`.

**Interfaces:**
- Consumes: `AnalyzerEndpointMissingError` (Task 3a.2), `AnalyzerKeyOriginError`, `classifyAnalysisFailure` (Task 3b.1), `FailureCode`.
- Produces: `export function analyzerSelectionErrorEvent(err: unknown): { kind: 'error'; code: FailureCode; message: string; remediation: string; detail?: string }` — never null (Q2; the master contract's "codes `AnalyzerEndpointMissingError`" is widened to every error). `detail` is the classification's own detail blob when it has one, and `Gemini API key required` for selection's missing-key `Error`, whose `auth` copy is generic.

**Tests kept green:** `server/src/routes/analysis.phase-model.test.ts`, `server/src/routes/analysis-pipelining.test.ts` (slow lane), and every existing case in the three route test files except one. Script review's `when the job runner throws synchronously (e.g. a misconfigured analyzer engine)…` injects its throw through `selectAnalyzerForPhase`, so it is a selection error: its expected code changes from `internal_error` to the classified `unknown` (a declared outcome change, Task 3b.13). The launch catch's `internal_error` keeps a test: the new `a throw after selection … still reaches the launch catch as internal_error` case.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/routes/failure-taxonomy.test.ts`, and add `analyzerSelectionErrorEvent` to its `./failure-taxonomy.js` import:
```ts
describe('analyzerSelectionErrorEvent (#3084 P23)', () => {
  it.each([
    [
      'AnalyzerEndpointMissingError',
      new AnalyzerEndpointMissingError('gone', 'env'),
      'analyzer-endpoint-missing',
      'Analyzer endpoint "gone" (from ANALYZER_PHASE0_MODEL / ANALYZER_PHASE1_MODEL) is not configured. Add it in Settings or pick another model.',
    ],
    [
      'AnalyzerKeyOriginError',
      new AnalyzerKeyOriginError('lab', 'Lab box'),
      'auth',
      'The API key saved for Lab box was entered for a different host, so it was not sent — re-enter the key for Lab box.',
    ],
    ['a plain Error', new Error('misconfigured engine: missing GEMINI_API_KEY'), 'unknown', 'misconfigured engine: missing GEMINI_API_KEY'],
  ] as const)('codes %s through classifyAnalysisFailure and never returns null', (_name, err, code, message) => {
    const failure = classifyAnalysisFailure(err, 'Analyzer');
    expect(failure.code).toBe(code);
    expect(analyzerSelectionErrorEvent(err)).toEqual({
      kind: 'error',
      code,
      message,
      remediation: failure.remediation,
      ...(failure.detail ? { detail: failure.detail } : {}),
    });
  });

  it("selection's own missing-Gemini-key error classifies as auth and keeps what is missing as its detail (declared outcome change: phase 0 / subset sent it uncoded)", () => {
    const err = new Error(
      'GEMINI_API_KEY is required when analyzer engine is Gemini. Set it from Account → Server configuration → Gemini API key, or in server/.env for CI / power users.',
    );
    /* The `auth` signature's copy is generic ("check the Gemini API key"), so without the
       detail the event no longer says WHICH of the two auth cases this is. */
    expect(analyzerSelectionErrorEvent(err)).toMatchObject({ kind: 'error', code: 'auth', detail: 'Gemini API key required' });
  });
});
```

`server/src/routes/analysis.endpoint-missing.test.ts`:
```ts
/* #3084 P23 — every analysis selection call site reports AnalyzerEndpointMissingError
   as analyzer-endpoint-missing. Phase 0 and the subset retry run the REAL selection
   through the REAL routes: a request model `openai:gone::m` makes PR 3a's selection
   throw. Phase 1 runs runMainAnalyzerJob with the phase-1 selection throwing, the
   way analysis.phase-model.test.ts injects a phase-1 selection. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { analysisRouter, runMainAnalyzerJob, type AnalysisJob } from './analysis.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';
import { getManuscript, putManuscript, removeManuscript } from '../store/manuscripts.js';
import { AnalyzerEndpointMissingError } from '../analyzer/errors.js';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput } from '../handoff/schemas.js';

vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>('../analyzer/select-analyzer.js');
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: Parameters<typeof actual.selectAnalyzerForPhase>[0]) => {
      const injected = (globalThis as Record<string, unknown>).__endpoint_missing_phase1_error;
      if (opts.phase === 'phase1' && injected) throw injected;
      const injected0 = (globalThis as Record<string, unknown>).__selection_phase0_error;
      if (opts.phase === 'phase0' && injected0) throw injected0;
      return actual.selectAnalyzerForPhase(opts);
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const app = express();
app.use(express.json());
app.use('/api/manuscripts', analysisRouter);

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)) as Record<string, unknown>);
}

function registerStub(): string {
  const id = `m_endpoint_missing_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const chapterHints = [1, 2].map((n) => ({ id: n, title: `Chapter ${n}`, body: `Chapter ${n} body. ` + 'lorem ipsum dolor sit amet '.repeat(50) }));
  putManuscript({
    manuscriptId: id,
    format: 'plaintext',
    title: `Stub ${id}`,
    wordCount: 200,
    byteSize: 10_000,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterHints.map((c) => c.body).join('\n\n'),
    chapterHints,
  });
  return id;
}

const cast = (chapterId: number): Stage1ChapterOutput => ({
  characters: [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', evidence: [{ quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }] },
    { id: `ch${chapterId}-char`, name: `Character_ch${chapterId}`, role: 'character', color: 'unset', evidence: [{ quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }] },
  ],
});

const phase0Analyzer: Analyzer = {
  runStage1: () => Promise.reject(new Error('not used')),
  runStage1Chapter: (_m, chapterId) => Promise.resolve(cast(chapterId)),
  runStage2Chapter: () => Promise.reject(new Error('not used')),
  runEmotionChapter: () => Promise.reject(new Error('not used')),
  runScriptReviewChapter: () => Promise.reject(new Error('not used')),
  runStage3Chapter: () => Promise.reject(new Error('not used')),
  runAttributionEscalation: () => Promise.resolve(null),
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__endpoint_missing_phase1_error;
  delete (globalThis as Record<string, unknown>).__selection_phase0_error;
});

describe('analysis selection call sites report analyzer-endpoint-missing (#3084 P23)', () => {
  it.each([
    ['phase 0 — POST /:id/analysis', (id: string) => request(app).post(`/api/manuscripts/${id}/analysis`).send({ model: 'openai:gone::m' })],
    ['subset retry — POST /:id/analysis/chapters', (id: string) => request(app).post(`/api/manuscripts/${id}/analysis/chapters`).send({ chapterIds: [1], model: 'openai:gone::m' })],
  ] as const)('%s', async (_site, post) => {
    const id = registerStub();
    try {
      const res = await post(id);
      expect(res.status).toBe(200);
      const error = parseSse(res.text).find((e) => e.kind === 'error');
      expect(error).toMatchObject({ kind: 'error', code: 'analyzer-endpoint-missing' });
      expect(String(error?.message)).toContain('Analyzer endpoint "gone" (from this run\'s model pick) is not configured.');
    } finally {
      removeManuscript(id);
    }
  });

  it('phase 0 — any other selection error is coded too, never sent code-less (#3084 P23)', async () => {
    const id = registerStub();
    (globalThis as Record<string, unknown>).__selection_phase0_error = new Error('misconfigured engine: missing GEMINI_API_KEY');
    try {
      const res = await request(app).post(`/api/manuscripts/${id}/analysis`).send({});
      expect(res.status).toBe(200);
      expect(parseSse(res.text).find((e) => e.kind === 'error')).toMatchObject({
        kind: 'error',
        code: 'unknown',
        message: 'misconfigured engine: missing GEMINI_API_KEY',
      });
    } finally {
      removeManuscript(id);
    }
  });

  it('phase 1 — runMainAnalyzerJob classifies the throw through its job-level catch', async () => {
    const id = registerStub();
    (globalThis as Record<string, unknown>).__endpoint_missing_phase1_error = new AnalyzerEndpointMissingError('gone', 'settings');
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const events: Array<Record<string, unknown>> = [];
    const job: AnalysisJob = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: id,
      kind: 'main',
      bookDir: null,
      engine: 'gemini',
      replay: { logs: [], lastPhase: null, lastEta: null, lastCastUpdate: null, failedByChapterId: new Map(), lastSeriesPrior: null, warnings: new Map() },
      lastDiskWriteAt: 0,
    };
    const keepAlive = setInterval(() => {}, 100_000);
    clearInterval(keepAlive);
    job.subscribers.add({
      send: (payload: unknown) => events.push(payload as Record<string, unknown>),
      res: { end: () => {} } as unknown as import('express').Response,
      keepAlive,
    });
    const phase0: AnalyzerSelection = { analyzer: phase0Analyzer, engine: 'gemini', model: 'gemma-endpoint-missing-test', fallbackModel: null };
    try {
      await runMainAnalyzerJob(job, getManuscript(id) as never, phase0, { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      expect(events.find((e) => e.kind === 'error')).toMatchObject({ kind: 'error', code: 'analyzer-endpoint-missing' });
    } finally {
      removeManuscript(id);
      await clearAnalysisCache(id);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);
});
```

`server/src/routes/annotate-emotion.test.ts`:
1. In the `vi.hoisted` block, `engineState: { engine: 'gemini' as 'gemini' | 'local' }` becomes `engineState: { engine: 'gemini' as 'gemini' | 'local', selectError: null as Error | null }`.
2. In the `vi.mock('../analyzer/select-analyzer.js', …)` factory, `selectAnalyzerForPhase: () => ({ … })` becomes:
   ```ts
    selectAnalyzerForPhase: () => {
      if (emotionEngineState.selectError) throw emotionEngineState.selectError;
      return {
        analyzer: fakeAnalyzer,
        engine: emotionEngineState.engine,
        model: 'test-model',
        fallbackModel: null,
      };
    },
   ```
3. In `beforeEach`, after `emotionEngineState.engine = 'gemini';`, add `emotionEngineState.selectError = null;`.
4. Append inside `describe('POST /api/books/:bookId/annotate-emotion', …)`:
   ```ts
  it('an endpoint id this build cannot run ends the stream with analyzer-endpoint-missing, before any analyzer call (#3084 P23)', async () => {
    writeBook(SENTENCES);
    const { AnalyzerEndpointMissingError } = await import('../analyzer/errors.js');
    emotionEngineState.selectError = new AnalyzerEndpointMissingError('gone', 'run-pick');
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({ model: 'openai:gone::m' });
    expect(res.status).toBe(200);
    expect(parseSse(res.text).find((e) => e.kind === 'error')).toMatchObject({ kind: 'error', code: 'analyzer-endpoint-missing' });
    expect(runEmotion).not.toHaveBeenCalled();
  });

  it('any other selection error ends the stream with its classified code instead of escaping the handler (#3084 P23)', async () => {
    writeBook(SENTENCES);
    emotionEngineState.selectError = new Error('misconfigured engine: missing GEMINI_API_KEY');
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    expect(res.status).toBe(200);
    expect(parseSse(res.text).find((e) => e.kind === 'error')).toMatchObject({
      kind: 'error',
      code: 'unknown',
      message: 'misconfigured engine: missing GEMINI_API_KEY',
    });
    expect(runEmotion).not.toHaveBeenCalled();
  });
   ```

`server/src/routes/instruct-annotation.test.ts` — the same changes with this file's names: `instructEngineState` for `emotionEngineState`, `runStage3` for `runEmotion`, the path `/api/books/${bookId}/instruct-annotation`, and the test titles `an endpoint id this build cannot run ends the instruct stream with analyzer-endpoint-missing, before any analyzer call (#3084 P23)` and `any other selection error ends the instruct stream with its classified code instead of escaping the handler (#3084 P23)`.

`server/src/routes/script-review.test.ts`:
1. In the existing `when the job runner throws synchronously (e.g. a misconfigured analyzer engine), the SSE client receives a kind:"error" event instead of hanging` case, the throw comes from `selectAnalyzerForPhase`, so it is a selection error (P23). Replace its assertion `expect(events.some((e) => e.kind === 'error' && e.code === 'internal_error')).toBe(true);` with:
   ```ts
    /* #3084 P23 — a selection error carries its classified code, no longer internal_error. */
    expect(events.find((e) => e.kind === 'error')).toMatchObject({
      kind: 'error',
      code: 'unknown',
      message: 'misconfigured engine: missing GEMINI_API_KEY',
    });
   ```
   Its title, comment, `res.status` and `runReview` assertions stay.
2. Append inside `describe('POST /api/books/:bookId/script-review', …)`. The first case keeps the launch catch's `internal_error` covered, since the existing case no longer reaches it:
```ts
  it('a throw after selection (the warm step rejecting) still reaches the launch catch as internal_error (#3084 P23 keeps it)', async () => {
    writeBook(SENTENCES);
    selectAnalyzerForPhaseMock.mockImplementationOnce(() => ({
      analyzer: {
        runStage1: () => Promise.reject(new Error('not used')),
        runStage1Chapter: () => Promise.reject(new Error('not used')),
        runStage2Chapter: () => Promise.reject(new Error('not used')),
        runEmotionChapter: () => Promise.reject(new Error('not used')),
        runScriptReviewChapter: () => Promise.reject(new Error('not used')),
        runStage3Chapter: () => Promise.reject(new Error('not used')),
        runAttributionEscalation: () => Promise.resolve(null),
      } as Analyzer,
      engine: 'local',
      model: 'qwen3.5:9b',
      fallbackModel: null,
    }));
    warmOllamaModelMock.mockRejectedValueOnce(new Error('warm step exploded'));
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    expect(res.status).toBe(200);
    expect(parseSse(res.text).some((e) => e.kind === 'error' && e.code === 'internal_error')).toBe(true);
    expect(runReview).not.toHaveBeenCalled();
  });

  it('an endpoint id this build cannot run reports analyzer-endpoint-missing, not internal_error (#3084 P23)', async () => {
    writeBook(SENTENCES);
    const { AnalyzerEndpointMissingError } = await import('../analyzer/errors.js');
    selectAnalyzerForPhaseMock.mockImplementationOnce(() => {
      throw new AnalyzerEndpointMissingError('gone', 'run-pick');
    });
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1, model: 'openai:gone::m' });
    expect(res.status).toBe(200);
    const error = parseSse(res.text).find((e) => e.kind === 'error');
    expect(error).toMatchObject({ kind: 'error', code: 'analyzer-endpoint-missing' });
    expect(runReview).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run and confirm failures**

```bash
npm --prefix server run test -- src/routes/failure-taxonomy.test.ts src/routes/analysis.endpoint-missing.test.ts src/routes/annotate-emotion.test.ts src/routes/instruct-annotation.test.ts src/routes/script-review.test.ts
```
Expected:
- The three `codes %s through classifyAnalysisFailure…` rows and `selection's own missing-Gemini-key error…` FAIL: `analyzerSelectionErrorEvent is not a function`.
- `phase 0 — POST /:id/analysis`, `subset retry — …` and `phase 0 — any other selection error is coded too…` FAIL: the error event has no `code`.
- `phase 1 — runMainAnalyzerJob…` **PASSES**, because Task 3b.1's `AnalyzerEndpointMissingError` branch already codes it. It pins the site; its mutation proof is Step 5.
- The four annotate-emotion and instruct-annotation cases FAIL: no `error` event, because the throw escapes the handler after the SSE headers (the request can hang until the test timeout; that is the failure).
- Script review: `…reports analyzer-endpoint-missing, not internal_error` and the updated `when the job runner throws synchronously…` FAIL, received `code: 'internal_error'`. `a throw after selection … still reaches the launch catch as internal_error` **PASSES**: it pins the launch catch this task keeps.

- [ ] **Step 3: Implement**

`server/src/routes/failure-taxonomy.ts` — directly after `classifyAnalysisFailure`:
```ts
/** #3084 P23 — the SSE error event for ANY error selection throws, coded through
    classifyAnalysisFailure: AnalyzerEndpointMissingError → analyzer-endpoint-missing,
    AnalyzerKeyOriginError → auth, anything else → its classified code. Never null, so
    no selection call site ends a stream uncoded or rethrows after the SSE headers.
    Per class of error, not per site: a class a later PR adds is coded here without
    touching the six call sites. */
export function analyzerSelectionErrorEvent(
  err: unknown,
): { kind: 'error'; code: FailureCode; message: string; remediation: string; detail?: string } {
  const failure = classifyAnalysisFailure(err, 'Analyzer');
  /* Selection's own missing-key Error (analyzer/index.ts) matches the `auth` signature, whose
     copy does not name what is missing; keep that as the detail the UI's collapsible shows.
     Every other detail comes from the classification itself. */
  const raw = err instanceof Error ? err.message : String(err);
  const detail =
    failure.detail ?? (failure.code === 'auth' && GEMINI_KEY_REQUIRED.test(raw) ? 'Gemini API key required' : undefined);
  return {
    kind: 'error',
    code: failure.code,
    message: failure.userMessage,
    remediation: failure.remediation,
    ...(detail ? { detail } : {}),
  };
}

const GEMINI_KEY_REQUIRED = /GEMINI_API_KEY is required/;
```

`server/src/routes/analysis.ts`:
1. Add `analyzerSelectionErrorEvent` to the existing `./failure-taxonomy.js` import (the one that brings `classifyAnalysisFailure`, `:174`).
2. In **both** selection catches — phase 0 in `analysisRouter.post('/:id/analysis')` and the subset pair in `analysisRouter.post('/:id/analysis/chapters')` — replace
   ```ts
    send({ kind: 'error', message: (e as Error).message });
   ```
   with
   ```ts
    /* #3084 P23 — every selection error is sent with its classified code. */
    send(analyzerSelectionErrorEvent(e));
   ```
   The `clearInterval(keepAlive); return res.end();` lines after it are unchanged.

`server/src/routes/annotate-emotion.ts` (and `server/src/routes/instruct-annotation.ts`, identically):
1. Add `import type { AnalyzerSelection } from '../analyzer/index.js';` and `import { analyzerSelectionErrorEvent } from './failure-taxonomy.js';`.
2. Replace `const selection = selectAnalyzerForPhase({ phase: 'phase1', model: req.body?.model });` with:
   ```ts
    let selection: AnalyzerSelection;
    try {
      selection = selectAnalyzerForPhase({ phase: 'phase1', model: req.body?.model });
    } catch (err) {
      /* #3084 P23 — the SSE headers are already flushed, so a throw escaping here
         would end the stream with no error event. Every selection error is sent with
         its classified code (analyzer-endpoint-missing, auth for a key-origin
         mismatch, …) and the stream ends; nothing is rethrown. */
      send(analyzerSelectionErrorEvent(err));
      clearInterval(keepAlive);
      res.end();
      return;
    }
   ```

`server/src/routes/script-review.ts`:
1. Add `analyzerSelectionErrorEvent` to the imports (`import { analyzerSelectionErrorEvent } from './failure-taxonomy.js';`), and `type AnalyzerSelection` to the existing `import { selectAnalyzer, type StageCall } from '../analyzer/index.js';`.
2. In `runScriptReviewJob`, replace `const selection = selectAnalyzerForPhase({ phase: 'phase1', model });` with:
   ```ts
  let selection: AnalyzerSelection;
  try {
    selection = selectAnalyzerForPhase({ phase: 'phase1', model });
  } catch (err) {
    /* #3084 P23 — any error selection throws is reported with its classified code
       (analyzer-endpoint-missing, auth for a key-origin mismatch, …) and ends the job
       here, as the model_load_failed return below does; `send` also records it for a
       reconnect's replay. A throw from later in the job still reaches the launch
       .catch as internal_error. */
    send(analyzerSelectionErrorEvent(err));
    for (const sub of job.subscribers) sub.res.end();
    return;
  }
   ```
   `makeThrottledHeartbeat` (above it) starts no timer, so the early return leaks nothing. The subscriber loop is the same as the `model_load_failed` return's; if that return's loop has changed on `main`, copy its current form.
3. The launch's detached `.catch((err) => { … })` is **not** changed: it keeps `internal_error`, the `#3174` curation and the `console.error('[script-review] failed to start', err)` line.

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/routes/failure-taxonomy.test.ts src/routes/analysis.endpoint-missing.test.ts src/routes/annotate-emotion.test.ts src/routes/instruct-annotation.test.ts src/routes/script-review.test.ts src/routes/analysis.phase-model.test.ts
npm --prefix server run test:slow -- src/routes/analysis-pipelining.test.ts
npm run typecheck
npm run check:cycles
```
Expected: PASS; `check:cycles` prints the `OK` line with the same count `N` recorded in Task 3b.1.

- [ ] **Step 5: Mutation proofs**

| Revert | Expected red test |
|---|---|
| Phase-0 catch back to `send({ kind: 'error', message: (e as Error).message });` | `phase 0 — POST /:id/analysis` and `phase 0 — any other selection error is coded too…` |
| Subset catch back to the same line | `subset retry — POST /:id/analysis/chapters` |
| Delete Task 3b.1's `if (err instanceof AnalyzerEndpointMissingError) { … }` branch in `classifyAnalysisFailure` | `phase 1 — runMainAnalyzerJob classifies the throw…` (code `unknown`), the helper's `AnalyzerEndpointMissingError` row, and 3b.1's `AnalyzerEndpointMissingError → analyzer-endpoint-missing…` |
| annotate-emotion: restore the bare `const selection = selectAnalyzerForPhase(…)` line | `an endpoint id this build cannot run ends the stream with analyzer-endpoint-missing…` and `any other selection error ends the stream with its classified code…` |
| annotate-emotion: in the catch, add `if (!(err instanceof AnalyzerEndpointMissingError)) throw err;` before `send` (the pre-Q2 rethrow) | `any other selection error ends the stream with its classified code…` |
| instruct-annotation: the same two reverts | `…ends the instruct stream with analyzer-endpoint-missing…` and `any other selection error ends the instruct stream…` |
| script-review: restore the bare `const selection = selectAnalyzerForPhase({ phase: 'phase1', model });` | `…reports analyzer-endpoint-missing, not internal_error` and `when the job runner throws synchronously…` (both receive `internal_error`) |
| script-review: in the new selection catch, `throw err;` instead of `send(…)` | the same two cases |
| script-review: in the launch `.catch`, broadcast `analyzerSelectionErrorEvent(err)` instead of the `internal_error` object | `a throw after selection (the warm step rejecting) still reaches the launch catch as internal_error…` |
| `analyzerSelectionErrorEvent` codes one class only: `if (!(err instanceof AnalyzerEndpointMissingError)) return { kind: 'error', code: 'unknown', message: err instanceof Error ? err.message : String(err), remediation: '' };` at its top (the per-class helper) | the helper's `AnalyzerKeyOriginError` row (received `unknown`) and `selection's own missing-Gemini-key error classifies as auth` |
| `analyzerSelectionErrorEvent` returns `code: 'analyzer-endpoint-missing'` for everything | the helper's `AnalyzerKeyOriginError` and `a plain Error` rows, and every "any other selection error" route case |
| `analyzerSelectionErrorEvent`: drop the `GEMINI_KEY_REQUIRED` branch (`const detail = failure.detail;`) | `selection's own missing-Gemini-key error classifies as auth and keeps what is missing as its detail…` |

- [ ] **Step 6: Commit**
```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy.test.ts server/src/routes/analysis.ts server/src/routes/analysis.endpoint-missing.test.ts server/src/routes/annotate-emotion.ts server/src/routes/annotate-emotion.test.ts server/src/routes/instruct-annotation.ts server/src/routes/instruct-annotation.test.ts server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "fix(server): report a classified failure code from every analyzer selection call site"
```

---

### Task 3b.1b: Endpoint `analyzer-reasoning-overflow` fixes (F7 endpoint half)

**Depends on wave 2's `AnalysisFailureFix` / `reasoningOverflowFixes(ctx)` / its guard test.** Those are
introduced in wave 2 (2b) by a different fixer as part of F7 (P20's "stop new spend, with a loud,
actionable warning" — approved 2026-09-13). Both live in `server/src/routes/failure-taxonomy.ts`; the
guard test file is `server/src/routes/failure-taxonomy-fixes.test.ts`. `ctx` is
`{ transport: TransportKind; model: string; endpointId?: string }`, declared in 2b — **3b only reads
`ctx.endpointId`**, the field 2b already declared for this purpose; it adds no field of its own. At the
time of this task's authoring, wave 2's plan file has not yet landed this content, so this task cannot
pin exact line numbers the way the rest of this file pins into `46e62a34`. Locate
`reasoningOverflowFixes` and its guard by name before starting; if the exported shape differs from the
contract below, treat that as a contract conflict against the decision record (F7), not something to
improvise around.

**Review finding (CRITICAL — endpoint fixes must reach a real failure, not just a synthetic `ctx`).**
`reasoningOverflowFixes` is only as good as what calls it. `classifyAnalysisFailure`'s
`analyzer-reasoning-overflow` branch (wave 2) calls it with `{ transport: err.transport, model:
err.model }` — `err` being the thrown `AnalyzerReasoningOverflowError` (W1/2b). That error has no
`endpointId` field today, so even after this task's branch exists, a REAL endpoint overflow would call
`reasoningOverflowFixes` with `endpointId: undefined` and silently fall through to no endpoint-specific
fixes at all — the branch would be provably correct in isolation and dead in production. Three
additive changes close this, all in this task:

1. **`AnalyzerReasoningOverflowError` gains `endpointId?: string`** (W1/2b's class,
   `server/src/analyzer/errors.ts`) — a 4th, optional constructor argument
   `opts?: { endpointId?: string }`, stored as a **mutable** (not `readonly`) public field so it can be
   attached after construction (step 2 needs this). Purely additive: every existing 3-arg call site
   (wave 1's Ollama/Gemini paths, wave 2's `mapFinish`) compiles and behaves unchanged.
2. **`OpenAIAnalyzer` (Task 3b.12, `server/src/analyzer/openai.ts`) attaches its own endpoint id — on
   BOTH the thrown path and the escalation path (review pass 2, item 1).** Per this file's own Task
   3b.12 note ("The overflow itself is raised by wave 2's `mapFinish` in the runner, outside the
   transport" — line ref in this file, not `46e62a34`, since `mapFinish` does not exist yet on `main`),
   the shared runner that raises the error has no concept of "endpoint" — only `OpenAIAnalyzer` does
   (it holds `endpoint` from its constructor). There are two distinct surfaces, not one:
   - **Thrown path.** A first-attempt (non-escalation) overflow is thrown straight out of the stage
     call. `withEndpointId` (below) catches it there.
   - **Escalation path.** Per wave 2's own design (w2 `runSingleAttempt`, roughly its lines 3251 and
     3288-3290 at the time of this review — w2's plan file, not `46e62a34`), an overflow that happens
     DURING escalation is not thrown: `runSingleAttempt` reports it through `StageCall.onReasoningOverflow`
     and stores it, and `throwIfReasoningOverflowed` rethrows the STORED error only after escalation
     resolves (P20's "escalation resolves null for an overflow, like Gemini's content-block precedent" —
     this file's own Task 3b.12 "Stop-the-run errors" note). `withEndpointId`'s `try/catch` never sees
     this error at the point it is first produced — the hook does. Every `StageCall` `OpenAIAnalyzer`
     builds must wrap `onReasoningOverflow` too, so the SAME error object is annotated at the earliest
     point `OpenAIAnalyzer` can reach it, before `throwIfReasoningOverflowed` (later, inside the same
     `withEndpointId` try/catch as the thrown path) rethrows it.
   ```ts
   // server/src/analyzer/openai.ts (Task 3b.12)
   private async withEndpointId<T>(run: () => Promise<T>): Promise<T> {
     try {
       return await run();
     } catch (err) {
       if (err instanceof AnalyzerReasoningOverflowError && err.endpointId === undefined) {
         err.endpointId = this.endpoint.id;
       }
       throw err;
     }
   }

   /** Wraps the StageCall options every stage method passes to `super.<method>(...)`,
       so an escalation-path overflow (reported through the hook, never thrown —
       see above) is annotated at the same point a thrown one is, before
       `throwIfReasoningOverflowed` rethrows it (which `withEndpointId`'s catch
       then sees, so the guard there is not fooled into re-annotating). */
   private withEndpointIdHook<C extends { onReasoningOverflow?: (err: AnalyzerReasoningOverflowError) => void }>(call: C): C {
     return {
       ...call,
       onReasoningOverflow: (err: AnalyzerReasoningOverflowError) => {
         if (err.endpointId === undefined) err.endpointId = this.endpoint.id;
         call.onReasoningOverflow?.(err);
       },
     };
   }
   ```
   and override each stage method `TransportAnalyzer` (W1) exposes to wrap the whole call in
   `this.withEndpointId(() => super.<method>(…args, this.withEndpointIdHook(opts)))` — enumerate
   `TransportAnalyzer`'s actual public stage methods and its `StageCall` options shape at
   implementation time (`grep -n "^  async run\|^  async annotate\|^  async \|onReasoningOverflow"
   server/src/analyzer/runner/transport-analyzer.ts` or wherever W1/2b land them) and override every
   stage method it lists, and wrap `onReasoningOverflow` specifically (not every callback) on the
   options object each one passes down; this file cannot pin that list because `TransportAnalyzer`
   does not exist on `main` yet. **Conflict to flag if untrue at implementation time:** if
   `TransportAnalyzer`'s stage methods are `final` (not overridable), if they funnel through a single
   protected hook instead of one method each, or if `StageCall` has no `onReasoningOverflow` field by
   the name or shape assumed here — override/wrap wherever the real shape allows the same effect and
   report this as a contract note on the PR, since it changes where this edit lands but not its
   effect.
3. **`classifyAnalysisFailure`'s overflow branch passes `endpointId` through.** Change
   `reasoningOverflowFixes({ transport: err.transport, model: err.model })` (2b) to
   `reasoningOverflowFixes({ transport: err.transport, model: err.model, endpointId: err.endpointId })`
   — `err.endpointId` is `undefined` for Ollama/Gemini, so 2b's own fixes are unaffected.

**What this task adds to `reasoningOverflowFixes`, per the decision record's contract (F7, `wikiHref`
renamed to `wikiPage` per review — see below):**
```ts
// server/src/routes/failure-taxonomy.ts (2b defines AnalysisFailureFix / reasoningOverflowFixes)
if (ctx.transport === 'openai' && ctx.endpointId) {
  const endpoint = getCachedUserSettings().analyzerEndpoints.find((e) => e.id === ctx.endpointId);
  const name = endpoint?.name ?? ctx.endpointId;
  fixes.push(
    { label: `Lower ${name}'s max output tokens`, endpointField: { endpointId: ctx.endpointId, field: 'maxOutputTokens' } },
    { label: `Lower ${name}'s context size`, endpointField: { endpointId: ctx.endpointId, field: 'contextTokens' } },
    { label: 'Shrink Stage 1 chunks', settingKey: 'analyzer.stage1.localInputFraction' },
    { label: 'Shrink Stage 2 chunks', settingKey: 'analyzer.stage2.localInputFraction' },
  );
}
```
Per F7: reasoning-level (5a) and payload (5b) fixes are **not** added here — only the endpoint's own
`maxOutputTokens` / `contextTokens` fields and the stage input fractions.

**No `wikiPage` on these two rows, and that is deliberate, not an omission.** The decision record's F7
section says the endpoint fixes' wiki anchor lands in **PR 3d** ("3d: the endpoint-editor deep link and
the endpoint wiki anchor"), and item 3's new guard (below) asserts every `wikiPage` a fix names is a
real file under `docs/wiki/` — but `docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md` (F3) is written
in PR 3d, which merges strictly after 3b. Setting `wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints'`
here would make the guard fail on `main` for the entire window between 3b's merge and 3d's — this task
leaves `wikiPage` unset on both endpoint rows, and PR 3d adds it in the same diff that adds the page
file, so the guard is never red on `main`. Say this explicitly in 3d's task so it isn't dropped.

**Files:**
- Modify: `server/src/analyzer/errors.ts` (W1/2b) — widen `AnalyzerReasoningOverflowError`'s constructor with the optional `opts?: { endpointId?: string }` 4th argument (additive).
- Modify: `server/src/analyzer/openai.ts` (Task 3b.12) — `withEndpointId`, `withEndpointIdHook`, and the stage-method overrides.
- Modify: `server/src/routes/failure-taxonomy.ts` — the overflow branch's `reasoningOverflowFixes(...)` call site (add `endpointId: err.endpointId`), and the `transport === 'openai'` branch of `reasoningOverflowFixes` itself (wave 2 owns the function; this task adds the branch, replacing wave 2's placeholder `it('openai returns no fixes yet (3b adds them)', …)` case — review pass 2, item 3).
- Modify: `server/src/routes/failure-taxonomy-fixes.test.ts` (2b) — extend the guard's `endpointField.field` coverage with this branch's two rows, and replace the placeholder `openai returns no fixes yet` case (below).
- Test: `server/src/routes/failure-taxonomy-fixes.test.ts` — the `openai` transport case, plus a case going through the real error class.
- Test: `server/src/analyzer/openai-analyzer.test.ts` (Task 3b.12) — a thrown-path and an escalation-path overflow, both through a real `OpenAIAnalyzer` with a fake transport, both ending with `endpointId` set (review pass 2, item 1).

**Interfaces:**
- Consumes: `AnalysisFailureFix`, `reasoningOverflowFixes` (wave 2, F7, `server/src/routes/failure-taxonomy.ts`); `AnalyzerEndpoint`, `analyzerEndpointSchema` (Task 3b.5); `getCachedUserSettings`, `_setUserSettingsCacheForTest` (`server/src/workspace/user-settings.ts`, already used throughout this file — e.g. Task 3b.1/3a.2 imports).
- Produces: `AnalyzerReasoningOverflowError`'s widened constructor and mutable `endpointId` field; no new exports from `failure-taxonomy.ts` — an added branch inside the existing function.

**Guard test extension (F7's "Each wave that adds a fix extends it").** The guard fails if any
`endpointField.field` is not a key of `analyzerEndpointSchema.shape` — `maxOutputTokens` and
`contextTokens` both are (Task 3b.5), so the guard passes without change to the shape it checks;
this task's job is to add THIS branch's two `endpointField` rows to the set the guard iterates, so a
future typo in this branch (e.g. `field: 'maxOutputToken'`) is caught the same way wave 2's Gemini/Ollama
rows already are. Also extend the guard's (new, item-3) `wikiPage` file-existence check: it must not
choke on a fix with no `wikiPage` at all (both of this branch's rows) — assert the guard skips
`undefined` rather than treating it as a missing file.

- [ ] **Step 1: Write the failing tests**

**Replace, don't append (review pass 2, item 3).** Wave 2 ships this file with a placeholder case —
`it('openai returns no fixes yet (3b adds them)', () => { … expect(reasoningOverflowFixes({ transport:
'openai', … })).toEqual([]); });` — that exists ONLY because 3b hadn't landed yet when 2b was written.
Once this task lands, that placeholder's own assertion (`toEqual([])`) is false: the `openai` branch now
returns real fixes. Delete that case and put the real expectation in its place, in this same commit —
leaving both is worse than either alone (one of the two is always lying about what the function does).

Append to `server/src/routes/failure-taxonomy-fixes.test.ts` (in place of the deleted placeholder):
```ts
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { AnalyzerReasoningOverflowError } from '../analyzer/errors.js';
// (merge into this file's existing imports rather than duplicating them)

describe('reasoningOverflowFixes — openai transport (#3084 F7)', () => {
  afterEach(() => _resetUserSettingsCache());

  it('offers the endpoint\'s own maxOutputTokens/contextTokens and the stage fractions, naming the endpoint, never reasoning or payload, and no wikiPage yet', () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [{ id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 }],
    });
    const fixes = reasoningOverflowFixes({ transport: 'openai', model: 'm', endpointId: 'lab' });
    expect(fixes).toEqual([
      expect.objectContaining({ label: expect.stringContaining('Lab box'), endpointField: { endpointId: 'lab', field: 'maxOutputTokens' } }),
      expect.objectContaining({ label: expect.stringContaining('Lab box'), endpointField: { endpointId: 'lab', field: 'contextTokens' } }),
      expect.objectContaining({ settingKey: 'analyzer.stage1.localInputFraction' }),
      expect.objectContaining({ settingKey: 'analyzer.stage2.localInputFraction' }),
    ]);
    expect(fixes.every((f) => f.wikiPage === undefined)).toBe(true);
    expect(fixes.some((f) => f.settingKey?.includes('reasoning') || ('endpointField' in f && f.endpointField?.field === 'reasoning'))).toBe(false);
  });

  it('falls back to the endpoint id when the endpoint has been deleted since the failure', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    const fixes = reasoningOverflowFixes({ transport: 'openai', model: 'm', endpointId: 'gone' });
    expect(fixes[0].label).toContain('gone');
  });

  it('classifyAnalysisFailure passes the real error\'s endpointId through to the fixes (review finding)', () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [{ id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 }],
    });
    const err = new AnalyzerReasoningOverflowError('openai', 'qwen3:30b', 512, { endpointId: 'lab' });
    const failure = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
    expect(failure.fixes?.some((f) => 'endpointField' in f && f.endpointField?.endpointId === 'lab')).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run `server/src/routes/failure-taxonomy-fixes.test.ts`. Expected:
- The first two cases FAIL: the `openai` branch does not exist yet (`fixes` is `[]`).
- The third FAILS at the `AnalyzerReasoningOverflowError('openai', 'qwen3:30b', 512, { endpointId: 'lab' })`
  call — the constructor does not accept a 4th argument yet (TS error, or the 4th argument is silently
  dropped and `err.endpointId` is `undefined`) — then, even once the constructor is widened, it still
  FAILS until `classifyAnalysisFailure`'s call site is changed, because `err.endpointId` never reaches
  `reasoningOverflowFixes`.
- With the placeholder deleted and not yet replaced, the file fails to compile/collect (a `describe`
  block whose body no longer exists) — that FAIL is expected too, and resolves once the replacement
  block above lands in the same edit.

Run `server/src/analyzer/openai-analyzer.test.ts` (its two new cases, Step 1 below). Expected: FAIL —
`err.endpointId` is `undefined` on both the thrown-path and the escalation-path case (the class has no
4th constructor argument yet, and `OpenAIAnalyzer` has no `withEndpointId`/`withEndpointIdHook`).

- [ ] **Step 3: Implement**

In this order: (1) widen `AnalyzerReasoningOverflowError`; (2) add `withEndpointId`, `withEndpointIdHook`
and the stage-method overrides to `OpenAIAnalyzer`; (3) change `classifyAnalysisFailure`'s call site to
pass `endpointId: err.endpointId`; (4) add the `transport === 'openai'` branch to
`reasoningOverflowFixes`, resolving `endpoint.name` from `getCachedUserSettings().analyzerEndpoints`
(fall back to `ctx.endpointId` itself if the endpoint was deleted between the failure and the fix
lookup — do not throw building a remediation list); (5) delete wave 2's `openai returns no fixes yet`
placeholder case from `failure-taxonomy-fixes.test.ts` — its own `toEqual([])` assertion is now false.

- [ ] **Step 4: Run and confirm pass**

Run `server/src/routes/failure-taxonomy-fixes.test.ts` and `server/src/analyzer/openai-analyzer.test.ts`,
plus `npm run typecheck` and the guard test. Expected: PASS — **including confirming the placeholder
case is gone, not merely passing**: `grep -n "openai returns no fixes yet" server/src/routes/failure-taxonomy-fixes.test.ts`
must return nothing, or Step 4 is not honest about what shipped (review pass 2, item 3's "keep Step 4
honest").

- [ ] **Step 5: Mutation proofs**

| Revert | Expected red test |
|---|---|
| Delete the `transport === 'openai'` branch | `offers the endpoint's own maxOutputTokens/contextTokens…` |
| `field: 'maxOutputToken'` (typo) | the guard test (`endpointField.field` is not a key of `analyzerEndpointSchema`'s shape) |
| Add a `{ endpointField: { endpointId, field: 'reasoning' } }` row to this branch | the same test's reasoning/payload assertion |
| `endpoint.name` → `ctx.endpointId` unconditionally | `offers the endpoint's own maxOutputTokens/contextTokens…` (`label` no longer contains `'Lab box'`) and `falls back to the endpoint id…` still passes (documents the fallback is intentional, not the only path) |
| Set `wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints'` on either row | `…and no wikiPage yet` (also would fail the item-3 guard once that page doesn't exist under `docs/wiki/`) |
| In `withEndpointId`, drop the `err.endpointId === undefined` guard (always overwrite) | no test currently distinguishes this (documents a gap: nothing yet exercises a re-thrown, already-annotated overflow reaching a second `OpenAIAnalyzer` layer) — add `it('does not overwrite an endpointId a caller already set')` if `FallbackAnalyzer` can wrap two `OpenAIAnalyzer`s in a later wave |
| Delete `err.endpointId === undefined` and instead never set `err.endpointId` at all in `withEndpointId` (Task 3b.12) | `classifyAnalysisFailure passes the real error's endpointId through…` (the constructed-with-opts case still passes — it never goes through `withEndpointId`) **and** Task 3b.12's own `reasoning deltas then an empty length finish stop the run…` (`err.endpointId` is `undefined`) — the hedge an earlier draft carried ("once 3b.12 exists") is gone: 3b.12 is in this PR, so both tests exist and both go red |
| In `classifyAnalysisFailure`'s overflow branch, drop `endpointId: err.endpointId` from the `reasoningOverflowFixes(...)` call | `classifyAnalysisFailure passes the real error's endpointId through to the fixes (review finding)` |

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/errors.ts server/src/analyzer/openai.ts server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy-fixes.test.ts
git commit -m "feat(server): offer endpoint-specific reasoning-overflow fixes (#3084 F7)"
```

---

### Task 3b.2: The runner throws `AnalyzerInvalidOutputError` (message text unchanged)

**Files:**
- Modify: `server/src/analyzer/runner/stage-runner.ts` (W1) — the "failed validation after retry" throw inside `runStage`.
- Modify: `server/src/analyzer/runner/retry-policy.ts` (W1) — remove the now-orphaned `finalFailureMessage` member from `ValidationRetryPolicy`, `OLLAMA_RETRY_POLICY` and `GEMINI_RETRY_POLICY`.
- Modify: every test that calls `finalFailureMessage`. Find them with `rg -n finalFailureMessage server/src`.
- Test: `server/src/analyzer/runner/invalid-output-error.test.ts` (new).

**Interfaces:**
- Consumes: `StageRunner`, `OLLAMA_RETRY_POLICY`, `GEMINI_RETRY_POLICY`, `ChatTransport`, `AnalyzerInvalidOutputError` (Task 3b.1).
- Produces: `ValidationRetryPolicy` **without** `finalFailureMessage`. This is a contract change; see the report.

**Tests kept green:**
- `server/src/analyzer/ollama.test.ts` and `server/src/analyzer/gemini.test.ts` (slow lane) — their `failed validation after retry` message assertions.
- Wave 1's runner characterisation tests.

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/runner/invalid-output-error.test.ts`:
```ts
import { afterAll, describe, expect, it } from 'vitest';
import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY, GEMINI_RETRY_POLICY } from './retry-policy.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';
import { AnalyzerInvalidOutputError } from '../errors.js';
import { stage1ChapterGrammarSchema, stage1ChapterSchema } from '../../handoff/schemas.js';
import type { HandoffKey } from '../../handoff/protocol.js';
import { classifyAnalysisFailure } from '../../routes/failure-taxonomy.js';

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'handoff');
const ID = 'm_invalid_output_error';

afterAll(async () => {
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

function fakeTransport(kind: 'ollama' | 'gemini') {
  const requests: TransportRequest[] = [];
  const transport: ChatTransport = {
    kind,
    model: 'fake-model',
    async send(req): Promise<TransportResult> {
      requests.push(req);
      return { text: 'not json at all', reasoningSeen: false, finish: 'stop', receivedBytes: 15 };
    },
  };
  return { transport, requests };
}

/* Today's exact final-failure text (ollama.ts:608-610, gemini.ts:515-517). */
const TODAY = {
  ollama: (model: string, key: string, detail: string) =>
    `Ollama ${model} ${key} failed validation after retry: ${detail}`,
  gemini: (_model: string, key: string, detail: string) =>
    `Gemini ${key} failed validation after retry: ${detail}`,
};

describe('StageRunner — final validation failure (#3084 PR 3b)', () => {
  it.each([
    ['ollama', OLLAMA_RETRY_POLICY, 'schema'],
    ['gemini', GEMINI_RETRY_POLICY, 'json'],
  ] as const)('%s throws AnalyzerInvalidOutputError carrying today\'s message', async (kind, policy, mode) => {
    const { transport, requests } = fakeTransport(kind);
    const runner = new StageRunner({
      transport,
      policy,
      settings: () => ({ structuredOutput: mode, maxOutputTokens: undefined }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    const key = '1-ch1' as HandoffKey;
    const err = await runner
      .runStage(
        {
          manuscriptId: ID,
          key,
          skillName: 'per_chapter_stage1',
          promptMd: '# p',
          grammarSchema: stage1ChapterGrammarSchema,
          validationSchema: stage1ChapterSchema,
        },
        {},
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AnalyzerInvalidOutputError);
    const e = err as AnalyzerInvalidOutputError;
    expect(e.transport).toBe(kind);
    expect(e.structuredOutputMode).toBe(mode);
    expect(e.detail.startsWith('invalid-json — ')).toBe(true);
    expect(e.message).toBe(TODAY[kind]('fake-model', '1-ch1', e.detail));
    expect(requests).toHaveLength(2);
    expect(classifyAnalysisFailure(e, 'Fake').code).toBe('analyzer-invalid-output');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm --prefix server run test -- src/analyzer/runner/invalid-output-error.test.ts`

Expected: FAIL at `expect(err).toBeInstanceOf(AnalyzerInvalidOutputError)`. Today the runner throws a plain `Error`.

- [ ] **Step 3: Implement**

In `server/src/analyzer/runner/stage-runner.ts`, add `AnalyzerInvalidOutputError` to the `../errors.js` import. Then replace the final throw. Wave 1 wrote it from `policy.finalFailureMessage({ model, key, detail })`:
```ts
// before (W1)
throw new Error(this.policy.finalFailureMessage({ model: this.transport.model, key, detail }));
// after
throw new AnalyzerInvalidOutputError(
  this.transport.kind,
  this.transport.model,
  key,
  detail,
  settings.structuredOutput,
);
```
Notes:
- `detail` is the same `` `${secondAttempt.kind} — ${summariseDetail(secondAttempt.detail)}` `` string wave 1 passes today.
- `settings` is the `EngineRequestSettings` value `runStage` already read for this call. If W1 reads `this.settings()` inline, bind it once at the top of `runStage` (`const settings = this.settings();`) and use it for both the request and this throw.

In `server/src/analyzer/runner/retry-policy.ts`, delete the `finalFailureMessage` member from `ValidationRetryPolicy` and its implementations in `OLLAMA_RETRY_POLICY` and `GEMINI_RETRY_POLICY`; the class now owns the text.

Then run `rg -n finalFailureMessage server/src`. Rewrite each remaining test hit to assert `new AnalyzerInvalidOutputError(kind, model, key, detail, mode).message` against the same expected string.

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/analyzer/runner src/analyzer/ollama.test.ts
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
npm run typecheck
```
Expected: PASS. `rg -n finalFailureMessage server/src` prints nothing.

- [ ] **Step 5: Mutation proof**

Change the Gemini branch of the `AnalyzerInvalidOutputError` message in `errors.ts` to include `${model}`. Expect red on `gemini throws AnalyzerInvalidOutputError carrying today's message`. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/stage-runner.ts server/src/analyzer/runner/retry-policy.ts server/src/analyzer/runner/invalid-output-error.test.ts
git commit -m "feat(server): throw AnalyzerInvalidOutputError after a failed validation retry"
```
Also stage every test file the `rg` step rewrote.

---

### Task 3b.3: Per-provider schema adapters, `dropped` snapshots, `structuredOutputLabel`

**Files:**
- Create: `server/src/analyzer/runner/schema-adapters.ts`
- Create: `server/src/analyzer/runner/schema-adapters.test.ts`
- Create (generated on first run, committed): `server/src/analyzer/runner/__snapshots__/schema-adapters.test.ts.snap`
- Create: `server/src/analyzer/capabilities.ts` — the two contract **types** only. PR 3c adds the functions to this same file.

**Interfaces:**
- Consumes: `StructuredOutputMode` and `StructuredOutputRequest` (W1 `runner/transport.ts`). `ReasoningLevel` does not exist until wave 5 (Task 5.1), so nothing in PR 3b names it.
- Produces (contract):
  - `AdaptedSchema`
  - `adaptSchemaForOllama`
  - `adaptSchemaForGemini`
  - `adaptSchemaForOpenAI`
  - `structuredOutputLabel`
  - `ProbeOutcome`
  - `ModelCapabilityRecord`
- Produces (additional, used by Task 3b.4): `buildStructuredOutputRequest(mode, name, draft07, adapt)` and `structuredOutputSchemaName(key)`.

**Tests kept green:** none touched. Pure new modules; Task 3b.4 wires them.

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/runner/schema-adapters.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  adaptSchemaForGemini,
  adaptSchemaForOllama,
  adaptSchemaForOpenAI,
  buildStructuredOutputRequest,
  structuredOutputLabel,
  structuredOutputSchemaName,
} from './schema-adapters.js';
import {
  stage1GrammarSchema,
  stage1ChapterGrammarSchema,
  stage2ChapterSchema,
  emotionAnnotationSchema,
  nonStoryClassificationSchema,
  scriptReviewSchema,
  stage3ChapterSchema,
  escalationSchema,
} from '../../handoff/schemas.js';
import type { ModelCapabilityRecord } from '../capabilities.js';

const draft07 = (s: z.ZodType<unknown>) =>
  z.toJSONSchema(s, { target: 'draft-07', reused: 'inline' }) as Record<string, unknown>;

/* The grammar schema each stage sends today (research 03-code-map §2). */
const STAGE_SCHEMAS = {
  stage1: stage1GrammarSchema,
  stage1Chapter: stage1ChapterGrammarSchema,
  stage2Chapter: stage2ChapterSchema,
  emotion: emotionAnnotationSchema,
  nonStory: nonStoryClassificationSchema,
  scriptReview: scriptReviewSchema,
  stage3Chapter: stage3ChapterSchema,
  escalation: escalationSchema,
} as const;

const ADAPTERS = {
  ollama: adaptSchemaForOllama,
  gemini: adaptSchemaForGemini,
  openai: adaptSchemaForOpenAI,
} as const;

describe('dropped keywords per stage schema per provider (snapshot, #3084 spec Testing)', () => {
  for (const [provider, adapt] of Object.entries(ADAPTERS)) {
    for (const [stage, schema] of Object.entries(STAGE_SCHEMAS)) {
      it(`${provider} / ${stage}`, () => {
        expect(adapt(draft07(schema)).dropped).toMatchSnapshot();
      });
    }
  }
});

describe('adaptSchemaForGemini', () => {
  const input = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['name', 'id', 'score', 'items'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^x' },
      id: { type: 'integer', exclusiveMinimum: 0, minimum: -9007199254740991 },
      half: { type: 'integer', exclusiveMinimum: 0.5 },
      score: { type: 'number', exclusiveMinimum: 0 },
      minLength: { type: 'string', description: 'a property literally named minLength' },
      items: { type: 'array', minItems: 1, items: { anyOf: [{ type: 'string', minLength: 2 }, { type: 'null' }] } },
    },
  };

  it('removes $schema without recording it as a dropped constraint', () => {
    const out = adaptSchemaForGemini(input);
    expect(out.schema).not.toHaveProperty('$schema');
    expect(out.dropped).not.toContain('$schema');
  });

  it('drops unsupported keywords and records each path', () => {
    const out = adaptSchemaForGemini(input);
    expect(out.dropped).toEqual(
      expect.arrayContaining([
        'properties.name.minLength',
        'properties.name.maxLength',
        'properties.name.pattern',
        'properties.score.exclusiveMinimum',
        'properties.items.items.anyOf[0].minLength',
      ]),
    );
    expect((out.schema.properties as Record<string, Record<string, unknown>>).name).toEqual({ type: 'string' });
  });

  it('turns an integer exclusiveMinimum into minimum floor(n)+1, keeping the tighter bound', () => {
    const props = adaptSchemaForGemini(input).schema.properties as Record<string, Record<string, unknown>>;
    expect(props.id).toEqual({ type: 'integer', minimum: 1 });
    expect(props.half).toEqual({ type: 'integer', minimum: 1 });
  });

  it('treats property names as names, not keywords', () => {
    const props = adaptSchemaForGemini(input).schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('minLength');
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(input);
    adaptSchemaForGemini(input);
    expect(input).toEqual(copy);
  });
});

describe('adaptSchemaForOpenAI and adaptSchemaForOllama', () => {
  const input = { $schema: 'x', type: 'object', properties: { a: { type: 'string', minLength: 1 } } };
  it('OpenAI removes $schema only and records nothing', () => {
    expect(adaptSchemaForOpenAI(input)).toEqual({
      schema: { type: 'object', properties: { a: { type: 'string', minLength: 1 } } },
      dropped: [],
    });
  });
  it('Ollama is the identity (today\'s `format` payload)', () => {
    expect(adaptSchemaForOllama(input)).toEqual({ schema: input, dropped: [] });
  });
});

describe('buildStructuredOutputRequest', () => {
  const adapt = (s: Record<string, unknown>) => ({ schema: { ...s, adapted: true }, dropped: ['p.minLength'] });
  it('json and off never call the adapter', () => {
    expect(buildStructuredOutputRequest('json', 'n', { type: 'object' }, () => { throw new Error('called'); })).toEqual({
      request: { mode: 'json' },
      dropped: [],
    });
    expect(buildStructuredOutputRequest('off', 'n', { type: 'object' }, () => { throw new Error('called'); })).toEqual({
      request: { mode: 'off' },
      dropped: [],
    });
  });
  it('schema sends the adapted schema and reports what was dropped', () => {
    expect(buildStructuredOutputRequest('schema', 'n', { type: 'object' }, adapt)).toEqual({
      request: { mode: 'schema', name: 'n', schema: { type: 'object', adapted: true } },
      dropped: ['p.minLength'],
    });
  });
  it('schema names satisfy the OpenAI json_schema name rule', () => {
    expect(structuredOutputSchemaName('escalation-ch3-w2')).toBe('castwright_escalation-ch3-w2');
    expect(structuredOutputSchemaName('1-ch12')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe('structuredOutputLabel', () => {
  const record = (outcome: 'enforced' | 'ignored'): ModelCapabilityRecord => ({
    serverUrl: 'http://h',
    testedAt: '2026-09-11T00:00:00.000Z',
    control: { ok: true },
    structuredOutput: { schema: { configured: outcome } },
    reasoning: {},
  });
  it('states only what was observed', () => {
    expect(structuredOutputLabel('json', [], undefined, 'configured')).toBe('json');
    expect(structuredOutputLabel('off', ['x'], undefined, 'configured')).toBe('off');
    expect(structuredOutputLabel('schema', [], undefined, 'configured')).toBe('schema');
    expect(structuredOutputLabel('schema', ['properties.a.minLength'], undefined, 'configured')).toBe('schema (partial)');
    expect(structuredOutputLabel('schema', [], record('enforced'), 'configured')).toBe('schema');
    expect(structuredOutputLabel('schema', ['x'], record('ignored'), 'configured')).toBe('schema (not enforced)');
    expect(structuredOutputLabel('schema', [], record('ignored'), 'high')).toBe('schema');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm --prefix server run test -- src/analyzer/runner/schema-adapters.test.ts`

Expected: FAIL, `Failed to resolve import "./schema-adapters.js"`.

- [ ] **Step 3: Implement**

`server/src/analyzer/capabilities.ts`:
```ts
/* Per-model capability records written by the Test action (#3084 decision 2b).
   PR 3b ships the types only, because structuredOutputLabel reads a record.
   PR 3c adds capabilityRecordFor, assertConfiguredCapabilitiesAllowed,
   runModelTest and plannedTestRequestCount to this file. */
import type { StructuredOutputMode } from './runner/transport.js';

export type ProbeOutcome = 'enforced' | 'ignored' | 'rejected' | 'accepted';

export interface ModelCapabilityRecord {
  /** endpoint baseUrl, Ollama URL, or 'gemini' */
  serverUrl: string;
  /** ISO timestamp */
  testedAt: string;
  /** control request; `error` is redacted */
  control: { ok: true } | { ok: false; error: string };
  /** mode → (reasoning level or 'configured') → outcome */
  structuredOutput: Partial<Record<StructuredOutputMode, Record<string, ProbeOutcome>>>;
  /** reasoning level → outcome. Keyed by `string`: ReasoningLevel is born in wave 5
      (Task 5.1), which narrows this key. PR 3b/3c records `{}`. */
  reasoning: Partial<Record<string, 'accepted' | 'rejected'>>;
}
```

`server/src/analyzer/runner/schema-adapters.ts`:
```ts
/* Per-provider structured-output schema adapters (#3084 decision 2, spec §2).

   Input: the draft-07 schema the runner builds with
   z.toJSONSchema(grammarSchema, { target: 'draft-07', reused: 'inline' }).
   Output: that schema rewritten into the subset the provider documents, plus
   `dropped` — the path of every constraint that could not be carried. Our Zod
   validator still enforces the FULL schema on every reply; `dropped` exists so
   the label never claims more than the wire carried ("schema (partial)").

   `$schema` is removed for Gemini and OpenAI but never recorded: it is a
   dialect marker, not a constraint, and recording it would label every
   endpoint "partial". */

import type { StructuredOutputMode, StructuredOutputRequest } from './transport.js';
import type { ModelCapabilityRecord } from '../capabilities.js';

export interface AdaptedSchema {
  schema: Record<string, unknown>;
  dropped: string[];
}

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/* Keywords whose value is a map of NAME → subschema (the names are data, not keywords). */
const SCHEMA_MAP = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
/* Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
/* Keywords whose value is a single subschema (or, for items, possibly an array). */
const SCHEMA_SINGLE = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']);

interface Rules {
  keep: (keyword: string) => boolean;
  normalize?: (node: Node) => Node;
}

function adaptNode(node: Node, path: string, dropped: Set<string>, rules: Rules): Node {
  const source = rules.normalize ? rules.normalize(node) : node;
  const out: Node = {};
  for (const [key, value] of Object.entries(source)) {
    const here = path ? `${path}.${key}` : key;
    if (key === '$schema') continue;
    if (!rules.keep(key)) {
      dropped.add(here);
      continue;
    }
    if (SCHEMA_MAP.has(key) && isNode(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [
          name,
          isNode(sub) ? adaptNode(sub, `${here}.${name}`, dropped, rules) : sub,
        ]),
      );
    } else if ((SCHEMA_ARRAY.has(key) || key === 'items') && Array.isArray(value)) {
      out[key] = value.map((sub, i) => (isNode(sub) ? adaptNode(sub, `${here}[${i}]`, dropped, rules) : sub));
    } else if (SCHEMA_SINGLE.has(key) && isNode(value)) {
      out[key] = adaptNode(value, here, dropped, rules);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function run(schema: Node, rules: Rules): AdaptedSchema {
  const dropped = new Set<string>();
  const adapted = adaptNode(schema, '', dropped, rules);
  return { schema: adapted, dropped: [...dropped].sort() };
}

/* Keywords Gemini's `responseJsonSchema` documents (@google/genai 2.19
   genai.d.ts, the `responseJsonSchema` doc comment). */
const GEMINI_KEYWORDS = new Set([
  '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum',
  'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf',
  'properties', 'additionalProperties', 'required', 'propertyOrdering',
]);

const isIntegerType = (t: unknown): boolean =>
  t === 'integer' || (Array.isArray(t) && t.includes('integer'));

/** For integers, x > n ⇔ x ≥ floor(n) + 1, so exclusiveMinimum is carried losslessly. */
function geminiNormalize(node: Node): Node {
  if (typeof node.exclusiveMinimum !== 'number' || !isIntegerType(node.type)) return node;
  const { exclusiveMinimum, ...rest } = node;
  const floor = Math.floor(exclusiveMinimum as number) + 1;
  rest.minimum = typeof rest.minimum === 'number' ? Math.max(rest.minimum, floor) : floor;
  return rest;
}

export function adaptSchemaForOllama(s: Record<string, unknown>): AdaptedSchema {
  return { schema: s, dropped: [] };
}

export function adaptSchemaForGemini(s: Record<string, unknown>): AdaptedSchema {
  return run(s, { keep: (k) => GEMINI_KEYWORDS.has(k), normalize: geminiNormalize });
}

export function adaptSchemaForOpenAI(s: Record<string, unknown>): AdaptedSchema {
  return run(s, { keep: () => true });
}

/** OpenAI requires json_schema.name to match ^[a-zA-Z0-9_-]{1,64}$. */
export function structuredOutputSchemaName(key: string): string {
  return `castwright_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

/** The runner's one place that turns a configured mode into the wire request. */
export function buildStructuredOutputRequest(
  mode: StructuredOutputMode,
  name: string,
  draft07: Record<string, unknown>,
  adapt: (s: Record<string, unknown>) => AdaptedSchema,
): { request: StructuredOutputRequest; dropped: string[] } {
  if (mode === 'json') return { request: { mode: 'json' }, dropped: [] };
  if (mode === 'off') return { request: { mode: 'off' }, dropped: [] };
  const { schema, dropped } = adapt(draft07);
  return { request: { mode: 'schema', name, schema }, dropped };
}

/** "schema" | "schema (partial)" | "schema (not enforced)" | "json" | "off" —
    only what was observed. `reasoningKey` is the configured reasoning level, or
    'configured' before wave 5. */
export function structuredOutputLabel(
  mode: StructuredOutputMode,
  dropped: string[],
  record: ModelCapabilityRecord | undefined,
  reasoningKey: string,
): string {
  if (mode !== 'schema') return mode;
  if (record?.structuredOutput.schema?.[reasoningKey] === 'ignored') return 'schema (not enforced)';
  return dropped.length > 0 ? 'schema (partial)' : 'schema';
}
```

- [ ] **Step 4: Run and confirm pass; review the snapshot**

Run: `npm --prefix server run test -- src/analyzer/runner/schema-adapters.test.ts`

Expected: PASS, and a new `__snapshots__/schema-adapters.test.ts.snap` is written.

Open the `.snap` and check it:
- every `ollama / *` entry is `[]`;
- every `openai / *` entry is `[]`;
- the `gemini / *` entries list only `minLength` / `maxLength` / `pattern` / non-integer `exclusiveMinimum` paths.

Paste the Gemini entries in the PR body. They are the first half of the "what the Gemini adapter drops" on-box record.

- [ ] **Step 5: Mutation proofs**

Revert one change at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| In `adaptNode`, replace the `SCHEMA_MAP` branch body with `out[key] = value;` | `drops unsupported keywords and records each path`, plus the `gemini / *` snapshots |
| Apply the `keep` check to property names (call `rules.keep(name)` inside the `SCHEMA_MAP` map and skip non-kept names) | `treats property names as names, not keywords` |
| In `geminiNormalize`, `Math.floor(exclusiveMinimum as number) + 1` → `exclusiveMinimum as number` | `turns an integer exclusiveMinimum into minimum floor(n)+1…` |
| In `structuredOutputLabel`, swap the order of the `ignored` and `dropped` checks | the `schema (not enforced)` assertion |

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/schema-adapters.ts server/src/analyzer/runner/schema-adapters.test.ts server/src/analyzer/runner/__snapshots__/schema-adapters.test.ts.snap server/src/analyzer/capabilities.ts
git commit -m "feat(server): add per-provider structured-output schema adapters"
```

---

### Task 3b.4: Structured-output knobs, all three modes on Ollama and Gemini, runner wiring

**Files:**
- Modify: `server/src/config/registry.ts` — insert two knobs after `analyzer.gemini.maxInputTokensPerRequest` (`:70-79` on main).
- Modify (generated): `server/.env.example`, via `npm run config:sync`.
- Modify: `server/src/analyzer/transports/ollama-transport.ts` (W1) — the `/api/chat` body's `format` field (main `ollama.ts:643`).
- Modify: `server/src/analyzer/transports/gemini-transport.ts` (W1) — the `generateContentStream` config (main `gemini.ts:728-734`).
- Modify: `server/src/analyzer/runner/stage-runner.ts` (W1) — where `TransportRequest.structuredOutput` is built from `z.toJSONSchema(...)` (main `ollama.ts:504`).
- Modify: `server/src/analyzer/ollama.ts` (W1) — `OllamaAnalyzer`'s `StageRunner` options.
- Modify: `server/src/analyzer/gemini.ts` (W1) — `GeminiAnalyzer`'s `StageRunner` options.
- Modify: `docs/wiki/Advanced-Settings.md` — two new rows in §1 "LLM sampling parameters", and the
  intro's "N knobs across M groups" count (review finding: a knob lands its Settings-UI row for free
  from the registry, but the wiki row and count are hand-maintained and gated by a separate guard —
  see below).
- Test: `server/src/config/registry.test.ts` (add)
- Test: `server/src/analyzer/transports/structured-output-wire.test.ts` (new)
- Test: `server/src/analyzer/structured-output-settings.test.ts` (new)
- Guard (existing, not new): `scripts/tests/knob-docs-sync.test.mjs` — run via `npm run test:hooks`.

**Interfaces:**
- Consumes: `buildStructuredOutputRequest`, `structuredOutputSchemaName`, `adaptSchemaForOllama`, `adaptSchemaForGemini` (Task 3b.3); `configValue` (`server/src/config/resolver.ts:176`).
- Produces:
  - knob keys `analyzer.ollama.structuredOutput` / `analyzer.gemini.structuredOutput`;
  - `export function ollamaFormatField(so: StructuredOutputRequest): unknown`;
  - `export function geminiStructuredConfig(so: StructuredOutputRequest): { responseMimeType?: string; responseJsonSchema?: unknown }`.

**Tests kept green:**
- `server/src/analyzer/ollama.test.ts` — the `format` test at `:386-410` stays valid, because the default mode is `schema` and the Ollama adapter is the identity.
- `server/src/analyzer/gemini.test.ts` (slow lane).
- `server/src/config/registry.test.ts`, `env-example.test.ts`, `direct-env-reader-guard.test.ts`.
- The #3146 `registry-knob-read.guard.test.ts` — both knobs are read through `configValue`.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/config/registry.test.ts`, inside `describe('config registry', …)`:
```ts
  it('ships the two structured-output enum knobs with today\'s request as the default (#3084 PR 3b)', () => {
    expect(knobByEnv('ANALYZER_OLLAMA_STRUCTURED_OUTPUT')).toMatchObject({
      key: 'analyzer.ollama.structuredOutput',
      group: 'analyzer-sampling',
      type: 'enum',
      options: ['schema', 'json', 'off'],
      default: 'schema',
      apply: 'live',
    });
    expect(knobByEnv('ANALYZER_GEMINI_STRUCTURED_OUTPUT')).toMatchObject({
      key: 'analyzer.gemini.structuredOutput',
      group: 'analyzer-sampling',
      type: 'enum',
      options: ['schema', 'json', 'off'],
      default: 'json',
      apply: 'live',
    });
  });
```

`server/src/analyzer/transports/structured-output-wire.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ollamaFormatField } from './ollama-transport.js';
import { geminiStructuredConfig } from './gemini-transport.js';

const schema = { type: 'object', properties: { a: { type: 'string' } } };

describe('structured-output wire mapping (#3084 spec §2 table)', () => {
  it('Ollama: schema → format <schema>, json → format "json", off → no format', () => {
    expect(ollamaFormatField({ mode: 'schema', name: 'n', schema })).toBe(schema);
    expect(ollamaFormatField({ mode: 'json' })).toBe('json');
    expect(ollamaFormatField({ mode: 'off' })).toBeUndefined();
  });
  it('Gemini: schema → mime + responseJsonSchema, json → mime only, off → neither', () => {
    expect(geminiStructuredConfig({ mode: 'schema', name: 'n', schema })).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
    });
    expect(geminiStructuredConfig({ mode: 'json' })).toEqual({ responseMimeType: 'application/json' });
    expect(geminiStructuredConfig({ mode: 'off' })).toEqual({});
  });
});
```

`server/src/analyzer/structured-output-settings.test.ts`:
```ts
/* End-to-end: the knob → analyzer constructor → runner → transport → wire.
   Ollama over a real local HTTP server (no fetch stub); Gemini through the
   same `@google/genai` module mock gemini.test.ts:57-63 uses. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const generateContentStream = vi.fn();
vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContentStream };
    },
  };
});

const { OllamaAnalyzer } = await import('./ollama.js');
const { GeminiAnalyzer } = await import('./gemini.js');
const { geminiRateLimiter } = await import('./rate-limit.js');

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');
const ID = 'm_structured_output_settings';
const VALID = JSON.stringify({
  characters: [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', evidence: [{ quote: 'a' }, { quote: 'bb' }, { quote: 'ccc' }] },
  ],
});

let server: Server;
let url = '';
let bodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  await mkdir(resolve(HANDOFF_ROOT, 'inbox'), { recursive: true });
  await mkdir(resolve(HANDOFF_ROOT, 'outbox'), { recursive: true });
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: VALID }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

beforeEach(() => {
  bodies = [];
  generateContentStream.mockReset();
  geminiRateLimiter._reset();
});

afterEach(() => {
  delete process.env.ANALYZER_OLLAMA_STRUCTURED_OUTPUT;
  delete process.env.ANALYZER_GEMINI_STRUCTURED_OUTPUT;
});

describe('analyzer.ollama.structuredOutput reaches the /api/chat body', () => {
  it('default (schema) sends the stage schema as format — today\'s request', async () => {
    await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(bodies[0].format).toMatchObject({ type: 'object' });
  });
  it('json sends format "json"', async () => {
    process.env.ANALYZER_OLLAMA_STRUCTURED_OUTPUT = 'json';
    await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(bodies[0].format).toBe('json');
  });
  it('off sends no format key at all', async () => {
    process.env.ANALYZER_OLLAMA_STRUCTURED_OUTPUT = 'off';
    await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(bodies[0]).not.toHaveProperty('format');
  });
});

describe('analyzer.gemini.structuredOutput reaches generateContentStream config', () => {
  const stream = () =>
    (async function* () {
      yield {
        text: VALID,
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: VALID }] } }],
        usageMetadata: { promptTokenCount: 10 },
      };
    })();
  const config = () => (generateContentStream.mock.calls[0][0] as { config: Record<string, unknown> }).config;

  it('default (json) sends responseMimeType only — today\'s request', async () => {
    generateContentStream.mockResolvedValue(stream());
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.5-flash-lite' }).runStage1Chapter(ID, 1, '# p', {});
    expect(config().responseMimeType).toBe('application/json');
    expect(config()).not.toHaveProperty('responseJsonSchema');
  });
  it('schema sends the Gemini-adapted schema (no $schema key)', async () => {
    process.env.ANALYZER_GEMINI_STRUCTURED_OUTPUT = 'schema';
    generateContentStream.mockResolvedValue(stream());
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.5-flash-lite' }).runStage1Chapter(ID, 1, '# p', {});
    expect(config().responseMimeType).toBe('application/json');
    expect(config().responseJsonSchema).toMatchObject({ type: 'object' });
    expect(config().responseJsonSchema).not.toHaveProperty('$schema');
  });
  it('off sends neither', async () => {
    process.env.ANALYZER_GEMINI_STRUCTURED_OUTPUT = 'off';
    generateContentStream.mockResolvedValue(stream());
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.5-flash-lite' }).runStage1Chapter(ID, 1, '# p', {});
    expect(config()).not.toHaveProperty('responseMimeType');
    expect(config()).not.toHaveProperty('responseJsonSchema');
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run:
```bash
npm --prefix server run test -- src/config/registry.test.ts src/analyzer/transports/structured-output-wire.test.ts src/analyzer/structured-output-settings.test.ts
```

Expected:
- The registry test FAILS: `knobByEnv(...)` returns `undefined`.
- The wire test FAILS: `ollamaFormatField is not a function`.
- `json sends format "json"` FAILS: an object is received.
- `schema sends the Gemini-adapted schema` FAILS: no `responseJsonSchema`.
- `off …` tests FAIL.
- The two default tests PASS already. They pin byte-identical defaults.

- [ ] **Step 3: Implement**

`server/src/config/registry.ts` — insert after the `analyzer.gemini.maxInputTokensPerRequest` knob:
```ts
  {
    key: 'analyzer.ollama.structuredOutput',
    env: 'ANALYZER_OLLAMA_STRUCTURED_OUTPUT',
    group: 'analyzer-sampling',
    label: 'Ollama structured output',
    help: '"schema" (default) sends the stage\'s JSON schema as Ollama `format`, so the model can only produce JSON of that shape. "json" asks only for syntactically valid JSON. "off" sends no format. Every reply is still validated against the full schema and retried once in every mode. A mode the server rejects fails the run as "analyzer rejected the request" — it is never dropped silently.',
    type: 'enum', options: ['schema', 'json', 'off'],
    default: 'schema', // ← today's Ollama request: format = the stage schema (ollama.ts:643 on 46e62a34)
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.gemini.structuredOutput',
    env: 'ANALYZER_GEMINI_STRUCTURED_OUTPUT',
    group: 'analyzer-sampling',
    label: 'Gemini structured output',
    help: '"json" (default) sets responseMimeType application/json only — today\'s request. "schema" also sends the stage schema as responseJsonSchema, reduced to the keywords Gemini documents (length, pattern and non-integer exclusive-minimum constraints are dropped and listed in the debug log). "off" sends neither. Every reply is still validated against the full schema and retried once in every mode. The default moves to "schema" only after on-box measurement.',
    type: 'enum', options: ['schema', 'json', 'off'],
    default: 'json', // ← today's Gemini request: responseMimeType only (gemini.ts:729 on 46e62a34)
    apply: 'live', risk: 'medium',
  },
```
The Settings **UI** rows need no hand work — `src/views/advanced.tsx` renders every descriptor in
`analyzer-sampling` from `GET /api/config`, so both knobs appear there as enum selects. The **wiki**
row is separate and hand-maintained: `docs/wiki/Advanced-Settings.md` §1 "LLM sampling parameters" is
markdown, not generated, and `scripts/tests/knob-docs-sync.test.mjs` (`:160` on `46e62a34`) fails the
build if a knob's registry `label` has no matching first-cell row there, or if the intro's "— N knobs
across M groups in total" sentence (`Advanced-Settings.md:14`) drifts from the registry's real count.
Add both rows to that table, and bump the sentence:
```markdown
| Ollama structured output | "schema" sends the stage's JSON schema as Ollama `format`; "json" asks only for syntactically valid JSON; "off" sends no format. Every reply is still validated and retried once. | schema | schema, json, off | live | medium |
| Gemini structured output | "json" sets responseMimeType only; "schema" also sends the stage schema as responseJsonSchema (reduced to Gemini's supported keywords); "off" sends neither. | json | schema, json, off | live | medium |
```
At `46e62a34` the intro reads "117 knobs across 12 groups in total" (`docs/wiki/Advanced-Settings.md:14`);
these two knobs land in the existing `analyzer-sampling` group (section 1), so the group count (12)
is unchanged and the knob count becomes 119 — **verify this against the registry at implementation
time** rather than trusting the arithmetic here, since another PR may have merged a knob in the
interim; `npm run test:hooks` (which runs `knob-docs-sync.test.mjs`) is the source of truth, not this
sentence.

`server/src/analyzer/transports/ollama-transport.ts` (W1):
1. Add near the top:
```ts
import type { StructuredOutputRequest } from '../runner/transport.js';

/** #3084 spec §2 — the Ollama `format` field per mode; `undefined` omits the key. */
export function ollamaFormatField(so: StructuredOutputRequest): unknown {
  if (so.mode === 'schema') return so.schema;
  if (so.mode === 'json') return 'json';
  return undefined;
}
```
2. In the `/api/chat` body, replace wave 1's `format: <schema expression>` with `format: ollamaFormatField(req.structuredOutput),`. `JSON.stringify` omits an `undefined` value, so `off` sends no key.

`server/src/analyzer/transports/gemini-transport.ts` (W1):
1. Add:
```ts
import type { StructuredOutputRequest } from '../runner/transport.js';

/** #3084 spec §2 — Gemini structured-output config per mode. */
export function geminiStructuredConfig(
  so: StructuredOutputRequest,
): { responseMimeType?: string; responseJsonSchema?: unknown } {
  if (so.mode === 'schema') return { responseMimeType: 'application/json', responseJsonSchema: so.schema };
  if (so.mode === 'json') return { responseMimeType: 'application/json' };
  return {};
}
```
2. In the `generateContentStream({ config: { … } })` object, replace `responseMimeType: 'application/json',` with `...geminiStructuredConfig(req.structuredOutput),`. The other config keys are unchanged.

`server/src/analyzer/runner/stage-runner.ts` (W1). Where `runStage` / `runSingleAttempt` build the request's `structuredOutput` from the draft-07 schema, replace that construction with:
```ts
    const settings = this.settings();
    const draft07 = z.toJSONSchema(spec.grammarSchema, { target: 'draft-07', reused: 'inline' }) as Record<string, unknown>;
    const { request: structuredOutput, dropped } = buildStructuredOutputRequest(
      settings.structuredOutput,
      structuredOutputSchemaName(spec.key),
      draft07,
      this.adaptSchema,
    );
    if (dropped.length > 0) {
      console.debug(`[analyzer] ${this.transport.kind} schema adapter dropped for ${spec.key}: ${dropped.join(', ')}`);
    }
```
Pass `structuredOutput` into both attempts' `TransportRequest`. Add the import:
```ts
import { buildStructuredOutputRequest, structuredOutputSchemaName } from './schema-adapters.js';
```
The debug line lists keyword paths only, never values (spec §2 "Logging").

`server/src/analyzer/ollama.ts` (W1), in `OllamaAnalyzer`'s `new StageRunner({ … })`:
- the `settings` function's `structuredOutput` becomes `configValue<StructuredOutputMode>('analyzer.ollama.structuredOutput')`;
- `adaptSchema` becomes `adaptSchemaForOllama`.

`server/src/analyzer/gemini.ts` (W1), in `GeminiAnalyzer`'s:
- `structuredOutput: configValue<StructuredOutputMode>('analyzer.gemini.structuredOutput')`;
- `adaptSchema: adaptSchemaForGemini`.

Add `import { adaptSchemaForOllama } from './runner/schema-adapters.js';` (or `adaptSchemaForGemini`) and `import type { StructuredOutputMode } from './runner/transport.js';` to each.

Finally, regenerate the managed env block:
```bash
npm run config:sync
```

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/config src/analyzer/transports/structured-output-wire.test.ts src/analyzer/structured-output-settings.test.ts src/analyzer/ollama.test.ts src/analyzer/runner
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
npm run config:check
npm run typecheck
npm run test:hooks
```

Expected:
- PASS.
- `config:check` is clean.
- `server/.env.example`'s managed block gains `# ANALYZER_OLLAMA_STRUCTURED_OUTPUT=schema` and `# ANALYZER_GEMINI_STRUCTURED_OUTPUT=json` lines.
- `npm run test:hooks` (which runs `scripts/tests/knob-docs-sync.test.mjs` among others) is clean: both new labels have a matching `Advanced-Settings.md` row, and the intro's knob count matches the registry.

- [ ] **Step 5: Mutation proofs**

Revert one change at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| In `ollama.ts`, set `structuredOutput: 'schema'` (the constant again) | `json sends format "json"` |
| In `gemini-transport.ts`, restore `responseMimeType: 'application/json'` in place of the spread | `off sends neither` and `schema sends the Gemini-adapted schema…` |
| In `gemini.ts`, `adaptSchema: adaptSchemaForOllama` (identity: keeps `$schema`) | `schema sends the Gemini-adapted schema (no $schema key)` |
| In `registry.ts`, Gemini `default: 'schema'` | the registry test **and** `default (json) sends responseMimeType only…` |
| Delete either new row from `docs/wiki/Advanced-Settings.md` §1, or don't bump the intro count | `scripts/tests/knob-docs-sync.test.mjs` (`npm run test:hooks`) — a missing-row assertion or the count-mismatch assertion |

- [ ] **Step 6: Commit**
```bash
git add server/src/config/registry.ts server/src/config/registry.test.ts server/.env.example server/src/analyzer/transports/ollama-transport.ts server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/structured-output-wire.test.ts server/src/analyzer/runner/stage-runner.ts server/src/analyzer/ollama.ts server/src/analyzer/gemini.ts server/src/analyzer/structured-output-settings.test.ts docs/wiki/Advanced-Settings.md
git commit -m "feat(server): add structured-output mode knobs for the ollama and gemini analyzers"
```

---

### Task 3b.5: `workspace/analyzer-endpoints.ts` — schema, origin rules, references, mutation decisions

**Files:**
- Create: `server/src/workspace/analyzer-endpoints.ts`
- Create: `server/src/workspace/analyzer-endpoints.test.ts`

**Interfaces:**
- Consumes: `parseEndpointModelId` (`server/src/analyzer/model-id.ts`) and `AnalyzerKeyOriginError` (Task 3b.1).
- Produces (contract):
  - `REASONING_STYLES`
  - `analyzerEndpointSchema`
  - `AnalyzerEndpoint`
  - `defaultGpuForBaseUrl`
  - `keyOriginMatches`
  - `resolveUnloadUrl`
  - `findEndpointReferences`
- Produces (additional, used by Tasks 3b.6–3b.8 and PR 3d):
  - `EndpointKeyEntry`, `EndpointKeyStatus`, `EndpointState`, `EndpointReferenceSource`
  - `MODEL_ID_SETTING_FIELDS`, `MODEL_ID_CONFIG_KNOBS`
  - `AnalyzerEndpointRefusal`
  - `parseEndpointInput`, `applyCreate`, `applyUpdate`, `applyDelete`, `applyKey`
  - `endpointKeyStatus`, `resolveEndpointApiKey`
  - `friendlyEndpointIssueMessage(path, issue)` (review, item 4) — exported so PR 3d's own test can
    assert against the real server string instead of re-deriving it by hand.

**Deliberate shape choice.** `findEndpointReferences` takes a structural `EndpointReferenceSource` rather than importing `UserSettings`. `user-settings.ts` imports this module for `analyzerEndpointSchema`, so a type import back would be a cycle, and madge counts type edges. `UserSettings` is assignable to the parameter, so every contract caller compiles unchanged.

**Tests kept green:** none touched. This is a new module.

- [ ] **Step 1: Write the failing test**

`server/src/workspace/analyzer-endpoints.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  AnalyzerEndpointRefusal,
  MODEL_ID_CONFIG_KNOBS,
  MODEL_ID_SETTING_FIELDS,
  analyzerEndpointSchema,
  applyCreate,
  applyDelete,
  applyKey,
  applyUpdate,
  defaultGpuForBaseUrl,
  ENDPOINT_KEY_CONTROL_CHARACTER_RULE,
  endpointKeyStatus,
  findEndpointReferences,
  friendlyEndpointIssueMessage,
  keyOriginMatches,
  resolveEndpointApiKey,
  resolveUnloadUrl,
  type AnalyzerEndpoint,
  type EndpointState,
} from './analyzer-endpoints.js';
import { userSettingsSchema, DEFAULT_USER_SETTINGS } from './user-settings.js';
import { KNOBS } from '../config/registry.js';
import { AnalyzerKeyOriginError } from '../analyzer/errors.js';

const base = { id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 32768 };
const empty: EndpointState = { analyzerEndpoints: [], analyzerEndpointKeys: {} };

function refusal(fn: () => unknown): AnalyzerEndpointRefusal {
  try {
    fn();
  } catch (e) {
    if (e instanceof AnalyzerEndpointRefusal) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('analyzerEndpointSchema defaults (#3084 contract)', () => {
  it('fills the contract defaults', () => {
    expect(analyzerEndpointSchema.parse({ ...base, gpu: 'any' })).toEqual({
      ...base,
      gpu: 'any',
      concurrency: 1,
      requestCeilingMs: 1_800_000,
      structuredOutput: 'schema',
      reasoningStyle: 'not_controllable',
      reasoning: 'model-default',
      maxOutputTokens: 0,
    });
  });
});

describe('defaultGpuForBaseUrl', () => {
  it.each([
    ['http://localhost:8080/v1', 'any'],
    ['http://127.0.0.1:8080/v1', 'any'],
    ['http://[::1]:8080/v1', 'any'],
    ['http://192.168.1.20:8080/v1', 'none'],
    ['https://openrouter.ai/api/v1', 'none'],
    ['not a url', 'none'],
  ])('%s → %s', (url, gpu) => {
    expect(defaultGpuForBaseUrl(url)).toBe(gpu);
  });
});

describe('keyOriginMatches', () => {
  it('matches scheme + host + port exactly', () => {
    const stored = { origin: 'http://127.0.0.1:8080' };
    expect(keyOriginMatches(stored, 'http://127.0.0.1:8080/v1/chat/completions')).toBe(true);
    expect(keyOriginMatches(stored, 'http://127.0.0.1:8081/v1')).toBe(false);
    expect(keyOriginMatches(stored, 'https://127.0.0.1:8080/v1')).toBe(false);
    expect(keyOriginMatches(stored, 'http://localhost:8080/v1')).toBe(false);
    expect(keyOriginMatches(undefined, 'http://127.0.0.1:8080/v1')).toBe(false);
    expect(keyOriginMatches(stored, 'not a url')).toBe(false);
  });
});

describe('resolveUnloadUrl', () => {
  const ep = (unloadUrl?: string) =>
    analyzerEndpointSchema.parse({ ...base, gpu: 'any', ...(unloadUrl ? { unloadUrl } : {}) });
  it('returns null without an unload URL, the URL as-is without {model}', () => {
    expect(resolveUnloadUrl(ep(), 'm')).toBeNull();
    expect(resolveUnloadUrl(ep('http://127.0.0.1:8080/api/models/unload'), undefined)).toBe(
      'http://127.0.0.1:8080/api/models/unload',
    );
  });
  it('substitutes one encoded served model (P3: the caller POSTs once per servedModels() entry), and skips when there is none', () => {
    const e = ep('http://127.0.0.1:8080/api/models/unload/{model}');
    expect(resolveUnloadUrl(e, 'org/qwen3:30b')).toBe('http://127.0.0.1:8080/api/models/unload/org%2Fqwen3%3A30b');
    expect(resolveUnloadUrl(e, undefined)).toBeNull();
  });
});

describe('create / update / delete / key decisions', () => {
  it('create fills gpu from the base URL host when omitted', () => {
    expect(applyCreate(empty, base).analyzerEndpoints[0].gpu).toBe('any');
    expect(applyCreate(empty, { ...base, baseUrl: 'http://10.0.0.5:8080/v1' }).analyzerEndpoints[0].gpu).toBe('none');
  });
  it('refuses a missing context size, naming the field', () => {
    const r = refusal(() => applyCreate(empty, { id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1' }));
    expect(r).toMatchObject({ status: 400, refusal: 'invalid' });
    expect(r.issues.some((i) => i.path.join('.') === 'contextTokens')).toBe(true);
  });
  it('pins field-aware messages for a bad URL, a missing context size and a too-big request ceiling — never raw zod text (#3084 F5 review, item 4)', () => {
    const badUrl = refusal(() => applyCreate(empty, { ...base, baseUrl: 'not a url' }));
    expect(badUrl.issues).toEqual([{ path: ['baseUrl'], message: 'Base URL must be a valid URL, e.g. http://127.0.0.1:8080/v1.' }]);
    const noContext = refusal(() => applyCreate(empty, { id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1' }));
    expect(noContext.issues.find((i) => i.path.join('.') === 'contextTokens')?.message).toBe('Context size is required.');
    const bigCeiling = refusal(() => applyCreate(empty, { ...base, requestCeilingMs: 99_000_000 }));
    expect(bigCeiling.issues).toEqual([{ path: ['requestCeilingMs'], message: 'Request ceiling must be at most 240 minutes.' }]);
    /* No-echo, still: the submitted values never appear anywhere in the refusal. */
    expect(JSON.stringify([badUrl, bigCeiling])).not.toMatch(/not a url|99000000|99_000_000/);
  });
  it('friendlyEndpointIssueMessage falls back to the raw zod message for a path/code this map does not cover', () => {
    const issue = { code: 'custom', path: ['extraParams'], message: 'made up for this test' } as unknown as Parameters<typeof friendlyEndpointIssueMessage>[1];
    expect(friendlyEndpointIssueMessage('extraParams', issue)).toBe('made up for this test');
  });
  it.each(['Lab', 'lab_1', '', 'a'.repeat(41)])('refuses the endpoint id %j', (id) => {
    expect(refusal(() => applyCreate(empty, { ...base, id }))).toMatchObject({ status: 400, refusal: 'invalid' });
  });
  it('refuses a duplicate id', () => {
    const once = applyCreate(empty, base);
    expect(refusal(() => applyCreate(once, base))).toMatchObject({ status: 409, refusal: 'duplicate-id' });
  });
  it('refuses an unload URL on another origin, accepts one on the same origin, and never echoes either URL (F5)', () => {
    const r = refusal(() => applyCreate(empty, { ...base, unloadUrl: 'http://127.0.0.1:9999/api/models/unload/{model}' }));
    expect(r).toMatchObject({ status: 400, refusal: 'unload-off-origin' });
    expect(r.issues).toEqual([{ path: ['unloadUrl'], message: 'must be on the same scheme, host and port as baseUrl' }]);
    expect(JSON.stringify({ message: r.message, issues: r.issues })).not.toContain('9999');
    expect(
      applyCreate(empty, { ...base, unloadUrl: 'http://127.0.0.1:8080/api/models/unload/{model}' }).analyzerEndpoints,
    ).toHaveLength(1);
  });
  it('until PRs 5a/5b, refuses a non-default reasoning level and a non-empty payload, naming the PR that enables each (P23)', () => {
    const reasoning = refusal(() => applyCreate(empty, { ...base, reasoning: 'high' }));
    expect(reasoning).toMatchObject({ status: 400, refusal: 'invalid' });
    expect(reasoning.issues).toEqual([
      { path: ['reasoning'], message: 'only "model-default" can be saved until PR 5a enables reasoning levels' },
    ]);
    const payload = refusal(() => applyUpdate(applyCreate(empty, base), 'lab', { ...base, extraParams: { top_k: 20 } }));
    expect(payload).toMatchObject({ status: 400, refusal: 'invalid' });
    expect(payload.issues).toEqual([
      { path: ['extraParams'], message: 'custom request parameters cannot be saved until PR 5b enables them' },
    ]);
    expect(applyCreate(empty, { ...base, reasoning: 'model-default', extraParams: {} }).analyzerEndpoints).toHaveLength(1);
  });
  it('update keeps the id immutable and 404s an unknown endpoint', () => {
    const s = applyCreate(empty, base);
    expect(refusal(() => applyUpdate(s, 'lab', { ...base, id: 'other' }))).toMatchObject({ status: 400 });
    expect(refusal(() => applyUpdate(s, 'nope', base))).toMatchObject({ status: 404, refusal: 'not-found' });
    expect(applyUpdate(s, 'lab', { ...base, name: 'Renamed' }).analyzerEndpoints[0].name).toBe('Renamed');
  });
  it('a key is bound to the base URL origin; moving the base URL marks it origin-mismatch', () => {
    const withKey = applyKey(applyCreate(empty, base), 'lab', '  sk-secret-123  ');
    expect(withKey.analyzerEndpointKeys.lab).toEqual({ origin: 'http://127.0.0.1:8080', key: 'sk-secret-123' });
    expect(endpointKeyStatus(withKey)).toEqual({ lab: 'set' });
    const moved = applyUpdate(withKey, 'lab', { ...base, baseUrl: 'http://127.0.0.1:9090/v1' });
    expect(endpointKeyStatus(moved)).toEqual({ lab: 'origin-mismatch' });
    expect(endpointKeyStatus(applyKey(moved, 'lab', null))).toEqual({ lab: 'unset' });
  });
  it('refuses a key containing any control character (C0 or C1, CR, LF, NUL), naming the rule and never echoing the key (P22)', () => {
    const s = applyCreate(empty, base);
    const ctl = (code: number) => String.fromCharCode(code);
    for (const key of ['sk-crlf-secret-1\r\nX-Injected: 1', `sk-nul-secret-1${ctl(0x00)}`, 'sk-tab-secret-1\tx', `sk-c1-secret-1${ctl(0x85)}x`, `sk-del-secret-1${ctl(0x7f)}x`, '\nsk-lead-secret-1']) {
      const r = refusal(() => applyKey(s, 'lab', key));
      expect(r).toMatchObject({ status: 400, refusal: 'invalid' });
      expect(r.message).toBe(ENDPOINT_KEY_CONTROL_CHARACTER_RULE);
      expect(JSON.stringify({ message: r.message, issues: r.issues })).not.toContain('secret-1');
    }
    expect(applyKey(s, 'lab', 'sk-printable-1234').analyzerEndpointKeys.lab.key).toBe('sk-printable-1234');
  });
  it('resolveEndpointApiKey refuses a key bound to another origin than the target URL', () => {
    const withKey = applyKey(applyCreate(empty, base), 'lab', 'sk-secret-123');
    const moved = applyUpdate(withKey, 'lab', { ...base, baseUrl: 'http://127.0.0.1:9090/v1' });
    expect(resolveEndpointApiKey(withKey, withKey.analyzerEndpoints[0], 'http://127.0.0.1:8080/v1/chat/completions')).toBe('sk-secret-123');
    expect(() => resolveEndpointApiKey(moved, moved.analyzerEndpoints[0], moved.analyzerEndpoints[0].baseUrl)).toThrow(AnalyzerKeyOriginError);
    expect(() => resolveEndpointApiKey(withKey, withKey.analyzerEndpoints[0], 'http://10.0.0.5:8080/api/models/unload/m')).toThrow(AnalyzerKeyOriginError);
    expect(resolveEndpointApiKey(applyCreate(empty, base), applyCreate(empty, base).analyzerEndpoints[0], base.baseUrl)).toBeNull();
  });
  it('delete is refused while a saved setting references the endpoint, and removes the key when allowed', () => {
    const s = applyKey(applyCreate(empty, base), 'lab', 'sk-secret-123');
    const refs = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase0Model: 'openai:lab::qwen3:30b',
      configOverrides: { 'analyzer.phase1.model': 'openai:lab::m' },
    };
    const r = refusal(() => applyDelete(s, refs, 'lab'));
    expect(r).toMatchObject({ status: 409, refusal: 'referenced' });
    expect(r.issues).toEqual([
      { path: [], message: 'Account setting "analyzerPhase0Model"' },
      { path: [], message: 'Advanced setting "analyzer.phase1.model"' },
    ]);
    const after = applyDelete(s, DEFAULT_USER_SETTINGS, 'lab');
    expect(after).toEqual(empty);
  });
});

describe('findEndpointReferences', () => {
  it('matches only ids naming this endpoint', () => {
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      defaultAnalysisModel: 'openai:lab::m',
      analyzerPhase0Model: 'openai:lab2::m',
      analyzerPhase1Model: 'openai:latest',
      configOverrides: { 'analyzer.personaGeneration.engine': 'openai:lab::m' },
    };
    expect(findEndpointReferences(settings, 'lab')).toEqual([
      'Account setting "defaultAnalysisModel"',
      'Advanced setting "analyzer.personaGeneration.engine"',
    ]);
  });

  /* Guard: a model-id setting added later (e.g. by the #3141 chain) must be
     classified here, or deleting an endpoint could orphan it silently. */
  it('every user-settings field and analyzer-models knob that can hold a model id is classified', () => {
    const FIELD_EXCLUDED = new Set([
      'analyzerKeepAliveByModel', // map keyed by Ollama tag, not a selection
      'defaultTtsModelKey', // TTS
      'defaultTtsModelKeyExplicit', // TTS
      'dualModelEnabled', // boolean toggle for the two-model pipeline (user-settings.ts:204), not an id
    ]);
    const fields = Object.keys(userSettingsSchema.shape).filter((k) => /model/i.test(k));
    for (const f of fields) {
      expect(
        (MODEL_ID_SETTING_FIELDS as readonly string[]).includes(f) || FIELD_EXCLUDED.has(f),
        `classify user-settings field "${f}" in MODEL_ID_SETTING_FIELDS or the exclusion list`,
      ).toBe(true);
    }
    const KNOB_EXCLUDED = new Set([
      'analyzer.ollama.model', // Ollama tag
      'analyzer.gemini.model', // Gemini id
      'analyzer.gemini.voiceStyleModel', // Gemini id
      'analyzer.personaGeneration.localModel', // Ollama tag
    ]);
    const knobs = KNOBS.filter((k) => k.group === 'analyzer-models' && /(\.model|Model|\.engine)$/.test(k.key));
    for (const k of knobs) {
      expect(
        (MODEL_ID_CONFIG_KNOBS as readonly string[]).includes(k.key) || KNOB_EXCLUDED.has(k.key),
        `classify knob "${k.key}" in MODEL_ID_CONFIG_KNOBS or the exclusion list`,
      ).toBe(true);
    }
  });
});
```
The `userSettingsSchema` import resolves only after Task 3b.6 adds its fields. That's fine: this test runs against the schema as it stands, and the guard reads whatever `shape` exists.

- [ ] **Step 2: Run and confirm failure**

Run: `npm --prefix server run test -- src/workspace/analyzer-endpoints.test.ts`

Expected: FAIL, `Failed to resolve import "./analyzer-endpoints.js"`.

- [ ] **Step 3: Implement**

`server/src/workspace/analyzer-endpoints.ts`:
```ts
/* Named OpenAI-compatible analyzer endpoints (#3084 decision 3, spec §3).
   Stored in user-settings.json (`analyzerEndpoints`, `analyzerEndpointKeys`).
   This module is the PURE half: the schema, defaults, the key-origin rule, the
   reference lookup, and the create/update/delete/key decisions that
   routes/analyzer-endpoints.ts applies inside ONE serialised settings write
   (mutateUserSettings). No I/O. It must not import user-settings.ts, which
   imports it. */

import { z } from 'zod';
import { parseEndpointModelId } from '../analyzer/model-id.js';
import { AnalyzerKeyOriginError } from '../analyzer/errors.js';

export const REASONING_STYLES = ['reasoning_effort', 'enable_thinking', 'not_controllable'] as const;

export const analyzerEndpointSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().url(),
  gpu: z.string().regex(/^(none|any|[a-z]+:\d+)$/),
  unloadUrl: z.string().url().optional(),
  concurrency: z.number().int().min(1).max(16).default(1),
  requestCeilingMs: z.number().int().min(60_000).max(14_400_000).default(1_800_000),
  structuredOutput: z.enum(['schema', 'json', 'off']).default('schema'),
  reasoningStyle: z.enum(REASONING_STYLES).default('not_controllable'),
  reasoning: z.string().default('model-default'),
  maxOutputTokens: z.number().int().min(0).default(0),
  contextTokens: z.number().int().min(512),
  maxInputTokensPerRequest: z.number().int().min(256).optional(),
  extraParams: z.record(z.string(), z.unknown()).optional(),
});
export type AnalyzerEndpoint = z.infer<typeof analyzerEndpointSchema>;

export interface EndpointKeyEntry {
  origin: string;
  key: string;
}
export type EndpointKeyStatus = 'set' | 'unset' | 'origin-mismatch';
export interface EndpointState {
  analyzerEndpoints: AnalyzerEndpoint[];
  analyzerEndpointKeys: Record<string, EndpointKeyEntry>;
}

/** The saved-settings slice findEndpointReferences reads. UserSettings is assignable. */
export interface EndpointReferenceSource {
  defaultAnalysisModel: string;
  analyzerPhase0Model?: string | null;
  analyzerPhase1Model?: string | null;
  configOverrides: Record<string, number | boolean | string>;
}

/** User-settings fields that hold a selectable model id, as of 46e62a34
    (#3141's phase-model settings included). analyzer-endpoints.test.ts fails
    until any new model-id field is classified here or excluded there. */
export const MODEL_ID_SETTING_FIELDS = ['defaultAnalysisModel', 'analyzerPhase0Model', 'analyzerPhase1Model'] as const;

/** Registry knobs (config overrides) that hold a selectable model id. The persona
    engine is listed now: wave 4 makes it a model-id-style selection. */
export const MODEL_ID_CONFIG_KNOBS = [
  'analyzer.phase0.model',
  'analyzer.phase1.model',
  'analyzer.personaGeneration.engine',
] as const;

export class AnalyzerEndpointRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly refusal: 'invalid' | 'duplicate-id' | 'unload-off-origin' | 'not-found' | 'referenced',
    message: string,
    /* #3084 F5 — {path, message} pairs the route echoes verbatim as the response's
       `issues`. Never a field or key value: a route renders these inline next to
       the named field, so a value here would leak it into a save-time error body.
       path is [] for a refusal that names no single field (duplicate-id,
       not-found, referenced). */
    readonly issues: { path: string[]; message: string }[] = [],
  ) {
    super(message);
    this.name = 'AnalyzerEndpointRefusal';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function defaultGpuForBaseUrl(baseUrl: string): 'any' | 'none' {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase()) ? 'any' : 'none';
  } catch {
    return 'none';
  }
}

export function keyOriginMatches(stored: { origin: string } | undefined, url: string): boolean {
  if (!stored) return false;
  try {
    return new URL(url).origin === stored.origin;
  } catch {
    return false;
  }
}

/** The unload URL for ONE model (P3). A URL with `{model}` is resolved once per
    entry of endpoint-runtime's servedModels(endpoint.id) by the caller (PR 3d's
    evictEndpointsOnDevice); `model` undefined means "no served model", which
    skips a `{model}` URL. A URL without `{model}` unloads everything, once. */
export function resolveUnloadUrl(endpoint: AnalyzerEndpoint, model: string | undefined): string | null {
  if (!endpoint.unloadUrl) return null;
  if (!endpoint.unloadUrl.includes('{model}')) return endpoint.unloadUrl;
  if (!model) return null;
  return endpoint.unloadUrl.split('{model}').join(encodeURIComponent(model));
}

/* #3084 F4 (not this PR) — PR 3d extends this to also count the
   `analyzer.fallback.target` knob (`resolveAnalyzerFallbackTarget`'s saved
   override, a bare `openai:<endpointId>::<model>` string) as a reference, so
   deleting an endpoint the fallback names is refused like any other
   reference. The fallback knob itself is not introduced in 3b (F4: it lands
   in PR 3d alongside the `'analyzer-engine'` knob type). */
export function findEndpointReferences(settings: EndpointReferenceSource, endpointId: string): string[] {
  const names = (value: unknown): boolean =>
    typeof value === 'string' && parseEndpointModelId(value.trim())?.endpointId === endpointId;
  const refs: string[] = [];
  for (const field of MODEL_ID_SETTING_FIELDS) {
    if (names(settings[field])) refs.push(`Account setting "${field}"`);
  }
  for (const knob of MODEL_ID_CONFIG_KNOBS) {
    if (names(settings.configOverrides?.[knob])) refs.push(`Advanced setting "${knob}"`);
  }
  return refs;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** #3084 F5 review, item 4 — a raw zod message is implementation detail, not
    something to show next to a form field: zod 4.4.3 ships "Invalid URL" for
    a bad `baseUrl`, "Too big: expected number to be <=14400000" for an
    over-ceiling `requestCeilingMs` (verified against the installed
    `server/node_modules/zod` — `server/package.json` pins `"zod": "^4.0.0"`,
    resolved to 4.4.3; a `.url()`/`.regex()` failure's `issue.code` is
    `invalid_format`, not zod 3's `invalid_string`). This is a template map
    per endpoint field; any path/code this map does not cover falls back to
    the raw zod message — still never a value, since zod's own message never
    echoes the input for these issue types (verified above). Exported so PR
    3d's UI test can assert against the real server string instead of
    re-deriving it by hand. */
export function friendlyEndpointIssueMessage(path: string, issue: z.ZodIssue): string {
  if (path === 'baseUrl' && issue.code === 'invalid_format') {
    return 'Base URL must be a valid URL, e.g. http://127.0.0.1:8080/v1.';
  }
  if (path === 'unloadUrl' && issue.code === 'invalid_format') {
    /* #3084 F5 review pass 2, item 5 — a bare (no {model}) unload URL unloads
       EVERY model on the server, which is exactly the P12 warning case;
       showing that form as the example would steer a user straight into it.
       Use llama-swap's per-model form instead (planning-facts doc,
       docs/superpowers/specs/2026-09-11-openai-compatible-analyzer-planning-facts.md
       line 83: "Endpoint unload for llama-swap: POST {origin}/api/models/unload/{model}
       with the key"). */
    return 'Unload URL must be a valid URL, e.g. http://127.0.0.1:8080/api/models/unload/{model}.';
  }
  if (path === 'id' && issue.code === 'invalid_format') {
    return 'Endpoint id must be lowercase letters, digits and hyphens, 1–40 characters.';
  }
  if (path === 'name' && issue.code === 'too_big') {
    return 'Name must be 80 characters or fewer.';
  }
  if (path === 'contextTokens' && issue.code === 'invalid_type') {
    return 'Context size is required.';
  }
  if (path === 'contextTokens' && issue.code === 'too_small') {
    return 'Context size must be at least 512 tokens.';
  }
  if (path === 'gpu' && (issue.code === 'invalid_type' || issue.code === 'invalid_format')) {
    return 'GPU card must be "none", "any", or a device key such as cuda:0.';
  }
  if (path === 'concurrency' && issue.code === 'too_big') {
    return `Concurrency must be at most ${'maximum' in issue ? issue.maximum : 16}.`;
  }
  if (path === 'concurrency' && issue.code === 'too_small') {
    return 'Concurrency must be at least 1.';
  }
  if (path === 'requestCeilingMs' && issue.code === 'too_big') {
    const maxMs = 'maximum' in issue && typeof issue.maximum === 'number' ? issue.maximum : 14_400_000;
    return `Request ceiling must be at most ${Math.round(maxMs / 60_000)} minutes.`;
  }
  if (path === 'requestCeilingMs' && issue.code === 'too_small') {
    const minMs = 'minimum' in issue && typeof issue.minimum === 'number' ? issue.minimum : 60_000;
    return `Request ceiling must be at least ${Math.round(minMs / 1000)} seconds.`;
  }
  if (path === 'maxInputTokensPerRequest' && issue.code === 'too_small') {
    return 'Max input tokens per request must be at least 256.';
  }
  return issue.message; // fallback — still never a value, per the no-echo rule
}

export function parseEndpointInput(input: unknown): AnalyzerEndpoint {
  const withGpu =
    isRecord(input) && typeof input.baseUrl === 'string' && input.gpu === undefined
      ? { ...input, gpu: defaultGpuForBaseUrl(input.baseUrl) }
      : input;
  const parsed = analyzerEndpointSchema.safeParse(withGpu);
  if (!parsed.success) {
    throw new AnalyzerEndpointRefusal(
      400,
      'invalid',
      'Invalid analyzer endpoint.',
      /* #3084 F5 — structured {path, message}, never the rejected value: a
         field-aware template (friendlyEndpointIssueMessage) replaces zod's own
         wording, which is implementation detail, not user-facing copy. */
      parsed.error.issues.map((i) => {
        const path = i.path.map(String);
        return { path, message: friendlyEndpointIssueMessage(path.join('.'), i) };
      }),
    );
  }
  const ep = parsed.data;
  /* #3084 P23 — until wave 5 exists, nothing validates a reasoning level or a
     custom payload, and a value saved now would bypass wave 5's checks for good
     (settings load leniently). PR 5a deletes the `reasoning` refusal; PR 5b
     deletes the `extraParams` refusal. */
  const notYet: { path: string[]; message: string }[] = [];
  if (ep.reasoning !== 'model-default') {
    notYet.push({ path: ['reasoning'], message: 'only "model-default" can be saved until PR 5a enables reasoning levels' });
  }
  if (ep.extraParams !== undefined && Object.keys(ep.extraParams).length > 0) {
    notYet.push({ path: ['extraParams'], message: 'custom request parameters cannot be saved until PR 5b enables them' });
  }
  if (notYet.length > 0) {
    throw new AnalyzerEndpointRefusal(400, 'invalid', 'Invalid analyzer endpoint.', notYet);
  }
  if (ep.unloadUrl) {
    const unloadOrigin = new URL(ep.unloadUrl).origin;
    const baseOrigin = new URL(ep.baseUrl).origin;
    if (unloadOrigin !== baseOrigin) {
      /* #3084 F5 — names the mismatched field without echoing either URL. */
      throw new AnalyzerEndpointRefusal(
        400,
        'unload-off-origin',
        'The unload URL must be on the same scheme, host and port as the base URL.',
        [{ path: ['unloadUrl'], message: 'must be on the same scheme, host and port as baseUrl' }],
      );
    }
  }
  return ep;
}

function indexOrRefuse(state: EndpointState, endpointId: string): number {
  const idx = state.analyzerEndpoints.findIndex((e) => e.id === endpointId);
  if (idx < 0) throw new AnalyzerEndpointRefusal(404, 'not-found', `No analyzer endpoint with id "${endpointId}".`);
  return idx;
}

export function applyCreate(state: EndpointState, input: unknown): EndpointState {
  const ep = parseEndpointInput(input);
  if (state.analyzerEndpoints.some((e) => e.id === ep.id)) {
    throw new AnalyzerEndpointRefusal(409, 'duplicate-id', `An analyzer endpoint with id "${ep.id}" already exists.`);
  }
  return { ...state, analyzerEndpoints: [...state.analyzerEndpoints, ep] };
}

export function applyUpdate(state: EndpointState, endpointId: string, input: unknown): EndpointState {
  const idx = indexOrRefuse(state, endpointId);
  if (isRecord(input) && input.id !== undefined && input.id !== endpointId) {
    throw new AnalyzerEndpointRefusal(
      400,
      'invalid',
      'An endpoint id cannot be changed — delete the endpoint and add it again.',
    );
  }
  const ep = parseEndpointInput(isRecord(input) ? { ...input, id: endpointId } : input);
  const next = [...state.analyzerEndpoints];
  next[idx] = ep;
  return { ...state, analyzerEndpoints: next };
}

export function applyDelete(
  state: EndpointState,
  references: EndpointReferenceSource,
  endpointId: string,
): EndpointState {
  indexOrRefuse(state, endpointId);
  const refs = findEndpointReferences(references, endpointId);
  if (refs.length > 0) {
    throw new AnalyzerEndpointRefusal(
      409,
      'referenced',
      `Analyzer endpoint "${endpointId}" is still used by ${refs.length} saved setting(s).`,
      refs.map((r) => ({ path: [], message: r })),
    );
  }
  const keys = { ...state.analyzerEndpointKeys };
  delete keys[endpointId];
  return {
    analyzerEndpoints: state.analyzerEndpoints.filter((e) => e.id !== endpointId),
    analyzerEndpointKeys: keys,
  };
}

/** #3084 P22 — a key containing any control character is refused when written:
    C0 (U+0000–U+001F, CR, LF, NUL and tab included), DEL and C1 (U+007F–U+009F).
    undici echoes a whole invalid header value in its error
    (`Headers.append: "Bearer <key>" is an invalid header value.`), so such a key
    could surface in error text. Checked BEFORE trimming: a pasted trailing newline
    is refused, never silently stripped. A code-point loop, not a regex, because
    ESLint's no-control-regex rejects a control-character class. */
export function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

export const ENDPOINT_KEY_CONTROL_CHARACTER_RULE =
  'An API key cannot contain control characters (such as a line break, tab or NUL). Paste the key again without them.';

export function applyKey(state: EndpointState, endpointId: string, key: string | null): EndpointState {
  const ep = state.analyzerEndpoints[indexOrRefuse(state, endpointId)];
  if (typeof key === 'string' && hasControlCharacter(key)) {
    /* The rule only — never the key — in the message and issues (F5 no-echo). */
    throw new AnalyzerEndpointRefusal(400, 'invalid', ENDPOINT_KEY_CONTROL_CHARACTER_RULE, [
      { path: ['key'], message: ENDPOINT_KEY_CONTROL_CHARACTER_RULE },
    ]);
  }
  const normalised = typeof key === 'string' && key.trim().length > 0 ? key.trim() : null;
  const keys = { ...state.analyzerEndpointKeys };
  if (normalised === null) delete keys[endpointId];
  else keys[endpointId] = { origin: new URL(ep.baseUrl).origin, key: normalised };
  return { ...state, analyzerEndpointKeys: keys };
}

export function endpointKeyStatus(state: EndpointState): Record<string, EndpointKeyStatus> {
  return Object.fromEntries(
    state.analyzerEndpoints.map((e) => {
      const entry = state.analyzerEndpointKeys[e.id];
      const status: EndpointKeyStatus = !entry ? 'unset' : keyOriginMatches(entry, e.baseUrl) ? 'set' : 'origin-mismatch';
      return [e.id, status];
    }),
  );
}

/** The key to send to `targetUrl` (the base URL, an unload URL, a Detect URL…), or null
    when none is saved. Throws AnalyzerKeyOriginError (→ FailureCode `auth`) when the saved
    key was bound to another origin than `targetUrl`'s. No request may be sent in that case.
    `state` is structural (UserSettings satisfies it) so this leaf never imports user-settings. */
export function resolveEndpointApiKey(
  state: Pick<EndpointState, 'analyzerEndpointKeys'>,
  endpoint: AnalyzerEndpoint,
  targetUrl: string,
): string | null {
  const entry = state.analyzerEndpointKeys[endpoint.id];
  if (!entry) return null;
  if (!keyOriginMatches(entry, targetUrl)) throw new AnalyzerKeyOriginError(endpoint.id, endpoint.name);
  return entry.key;
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm --prefix server run test -- src/workspace/analyzer-endpoints.test.ts`

Expected: PASS.

- [ ] **Step 5: Mutation proofs**

Revert one guard at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| Delete the duplicate check in `applyCreate` | `refuses a duplicate id` |
| Delete the `unloadOrigin !== baseOrigin` block | `refuses an unload URL on another origin…` |
| `keyOriginMatches` → compare `new URL(url).host` | `matches scheme + host + port exactly` (the `https` case) |
| `applyDelete` without the `refs.length > 0` refusal | `delete is refused while a saved setting references the endpoint…` |
| Remove `'analyzerPhase1Model'` from `MODEL_ID_SETTING_FIELDS` | `every user-settings field … is classified` |
| `resolveEndpointApiKey` without the origin check | `resolveEndpointApiKey refuses a key bound to another origin` |
| Delete the `ep.reasoning !== 'model-default'` push | `until PRs 5a/5b, refuses a non-default reasoning level and a non-empty payload…` |
| `Object.keys(ep.extraParams).length > 0` → `false` | the same test (the `extraParams` half) |
| Remove `'dualModelEnabled'` from `FIELD_EXCLUDED` | `every user-settings field … is classified` |
| Delete the `hasControlCharacter(key)` refusal in `applyKey` | `refuses a key containing any control character…` |
| In `parseEndpointInput`, pass `i.message` directly instead of `friendlyEndpointIssueMessage(path.join('.'), i)` | `pins field-aware messages for a bad URL, a missing context size and a too-big request ceiling…` (the message reverts to zod's raw "Invalid URL" / "Too big: expected number to be <=14400000" text) |
| In `friendlyEndpointIssueMessage`, delete the `path === 'baseUrl' && issue.code === 'invalid_format'` branch | the same test (`badUrl.issues[0].message` falls through to the raw zod message) |
| In `friendlyEndpointIssueMessage`, delete the `path === 'requestCeilingMs' && issue.code === 'too_big'` branch, or drop the `/ 60_000` conversion | the same test (either the raw zod message reappears, or the message reads "at most 14400000 minutes" instead of "240 minutes") |
| In `hasControlCharacter`, drop `\|\| (c >= 0x7f && c <= 0x9f)` | the same test (the DEL and C1 keys are accepted) |

**Contract note (reported).** The contract names `resolveUnloadUrl`'s second parameter `lastUsedModel`. It is `model` here, because P3 replaced the single last-used model with `servedModels()` (Task 3b.10); PR 3d's `evictEndpointsOnDevice` calls it once per served model.

- [ ] **Step 6: Commit**
```bash
git add server/src/workspace/analyzer-endpoints.ts server/src/workspace/analyzer-endpoints.test.ts
git commit -m "feat(server): add analyzer endpoint schema, key-origin rule and reference lookup"
```

---

### Task 3b.6: User-settings fields `analyzerEndpoints` / `analyzerEndpointKeys`, key status on GET, serialised mutation

**Files:**
- Modify: `server/src/workspace/user-settings.ts`:
  - top imports;
  - `:246-254` (schema, after `analyzerKeepAliveByModel`);
  - `:330-334` (defaults);
  - `:643-661` (`FORBIDDEN_KEYS`);
  - `:472-530` (`performUserSettingsRead` — entries parsed one by one between the migration write and the whole-object `safeParse` at `:522`, P25) and `:439` (the warm-cache branch of `readUserSettings`, for the append retry only — `:438`'s `inFlightRead` single flight is left exactly as PR #3195 shipped it);
  - `stampCacheAfterWrite` (`:583`) — parameter widened to the object actually written;
  - `knownAnalyzerSecrets` (Task 3b.1), plus `loadKnownAnalyzerSecrets`;
  - new `mutateUserSettings` after `writeUserSettings` (`:638`).
- Modify: `server/src/routes/user-settings.ts:19-28` (imports), `:33-72` (`UserSettingsResponse`, `envDerived` — now exported).
- Test: `server/src/routes/user-settings.test.ts` (add)
- Test: `server/src/workspace/user-settings.endpoints.test.ts` (new)

**Interfaces:**
- Consumes: `analyzerEndpointSchema`, `endpointKeyStatus`, `EndpointKeyStatus` (Task 3b.5).
- Produces:
  - `UserSettings.analyzerEndpoints: AnalyzerEndpoint[]`;
  - `UserSettings.analyzerEndpointKeys: Record<string, { origin: string; key: string }>`;
  - `export async function mutateUserSettings(decide: (current: UserSettings) => Partial<UserSettings>): Promise<UserSettings>`;
  - `export function envDerived(settings: UserSettings): UserSettingsResponse`;
  - a response field `analyzerEndpointKeyStatus: Record<string, EndpointKeyStatus>`;
  - `export function invalidEndpointsArchivePath(): string` — `user-settings.invalid-endpoints.json` beside the settings file, where a dropped endpoint or key entry is appended before any write can persist the drop (P25);
  - `export async function loadKnownAnalyzerSecrets(): Promise<string[]>` — `knownAnalyzerSecrets()` after `readUserSettings()` has run. The boot warm at `server/src/index.ts:188` is `void bootWarmUserSettings()` — it awaits `readUserSettings()` inside its own try/catch (`:135-144`), but the caller does not await it, so the cache can be cold on an early request. It becomes the gate's `load` provider, so the transports (Tasks 3b.6a, 3b.11) reach it through `known-secrets-gate.ts`'s `loadKnownAnalyzerSecrets()` without importing `user-settings.ts` (A9).
  - P25 archive guarantees (Q3): the cold read is single-flight — **already shipped**, by PR #3195's `inFlightRead` (`:375-378`, `:438`), so this task adds no wrapper of its own; an entry is marked archived only after its append succeeds; a failed append is retried on the next read and, until it lands, every settings writer still saves and writes the unarchived entries back raw and unchanged (the private `withUnarchivedEntries`), so a write never refuses because an append failed; a dropped key entry is archived as `{ origin }` only; `_resetUserSettingsCache()` also forgets archived and unarchived drops and any in-flight read.

**`mockPutUserSettings` whitelist note (Task 3b.9).** The three new fields are **not** added to `mockPutUserSettings`'s whitelist (`src/lib/api.ts:7324-7337` destructure, `:7341-7354` mirrored object, at the `46e62a34` pin; `mockPutUserSettings` moved to `:7331` on `4a545750`, so locate it by name). That mirrors the server's `FORBIDDEN_KEYS`: the general PUT cannot write them. The mock CRUD functions mutate `MOCK_USER_SETTINGS` directly.

**Tests kept green:**
- `server/src/routes/user-settings.test.ts`
- `server/src/workspace/user-settings.test.ts`
- `server/src/routes/failure-taxonomy.test.ts` (the redaction case)

- [ ] **Step 1: Write the failing tests**

Append to `server/src/routes/user-settings.test.ts`, inside `describe('user-settings router', …)`:
```ts
  it('GET exposes analyzer endpoints and key status, never the keys (#3084 PR 3b)', async () => {
    writeFileSync(
      userSettingsPath,
      JSON.stringify({
        analyzerEndpoints: [
          { id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 },
          { id: 'moved', name: 'Moved', baseUrl: 'http://127.0.0.1:9090/v1', gpu: 'any', contextTokens: 32768 },
        ],
        analyzerEndpointKeys: {
          lab: { origin: 'http://127.0.0.1:8080', key: 'sk-lab-secret-1234' },
          moved: { origin: 'http://127.0.0.1:8080', key: 'sk-moved-secret-1234' },
        },
      }),
    );
    resetCache();
    const res = await request(app).get('/api/user/settings');
    expect(res.status).toBe(200);
    expect(res.body.analyzerEndpoints.map((e: { id: string }) => e.id)).toEqual(['lab', 'moved']);
    expect(res.body.analyzerEndpointKeyStatus).toEqual({ lab: 'set', moved: 'origin-mismatch' });
    expect(res.body).not.toHaveProperty('analyzerEndpointKeys');
    expect(JSON.stringify(res.body)).not.toMatch(/sk-(lab|moved)-secret/);
  });

  it('the general PUT cannot write analyzer endpoints, their keys, or the key status (#3084 PR 3b)', async () => {
    const res = await request(app)
      .put('/api/user/settings')
      .send({
        displayName: 'Still writable',
        analyzerEndpoints: [{ id: 'x', name: 'X', baseUrl: 'http://127.0.0.1:1/v1', gpu: 'any', contextTokens: 4096 }],
        analyzerEndpointKeys: { x: { origin: 'http://127.0.0.1:1', key: 'sk-smuggled-1234' } },
        analyzerEndpointKeyStatus: { x: 'set' },
      });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Still writable');
    expect(res.body.analyzerEndpoints).toEqual([]);
    expect(res.body.analyzerEndpointKeyStatus).toEqual({});
    expect(readFileSync(userSettingsPath, 'utf8')).not.toContain('sk-smuggled');
  });
```

`server/src/workspace/user-settings.endpoints.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  USER_SETTINGS_PATH,
  _resetUserSettingsCache,
  knownAnalyzerSecrets,
  loadKnownAnalyzerSecrets,
  mutateUserSettings,
  readUserSettings,
  writeGeminiApiKey,
  writeSetupCompletedAt,
  writeTourCompletedAt,
  writeUpgradeMeta,
  writeUserSettings,
} from './user-settings.js';
import { loadKnownAnalyzerSecrets as loadKnownAnalyzerSecretsViaGate } from '../analyzer/known-secrets-gate.js';

/* #3084 P25 — beside the settings file, whatever test-setup.ts redirected it to.
   A test that needs every append to fail puts a DIRECTORY at this path: appendFile
   on a directory rejects on every OS, with no module mock. */
const ARCHIVE = join(dirname(USER_SETTINGS_PATH), 'user-settings.invalid-endpoints.json');

const ep = (id: string) => ({
  id,
  name: id,
  baseUrl: 'http://127.0.0.1:8080/v1',
  gpu: 'any',
  concurrency: 1,
  requestCeilingMs: 1_800_000,
  structuredOutput: 'schema' as const,
  reasoningStyle: 'not_controllable' as const,
  reasoning: 'model-default',
  maxOutputTokens: 0,
  contextTokens: 32768,
});

beforeEach(() => {
  if (existsSync(USER_SETTINGS_PATH)) rmSync(USER_SETTINGS_PATH, { force: true });
  rmSync(ARCHIVE, { force: true, recursive: true });
  _resetUserSettingsCache();
});
afterAll(() => {
  if (existsSync(USER_SETTINGS_PATH)) rmSync(USER_SETTINGS_PATH, { force: true });
  rmSync(ARCHIVE, { force: true, recursive: true });
  _resetUserSettingsCache();
});

/* Silences the drop warnings and the append-failure error for one test body. */
async function quietly(body: () => Promise<void>): Promise<void> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await body();
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
}

describe('mutateUserSettings (#3084 PR 3b)', () => {
  it('serialises concurrent decisions so neither change is lost', async () => {
    await Promise.all([
      mutateUserSettings((cur) => ({ analyzerEndpoints: [...cur.analyzerEndpoints, ep('a')] })),
      mutateUserSettings((cur) => ({ analyzerEndpoints: [...cur.analyzerEndpoints, ep('b')] })),
    ]);
    _resetUserSettingsCache();
    const ids = (await readUserSettings()).analyzerEndpoints.map((e) => e.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('a throwing decision writes nothing and propagates', async () => {
    await mutateUserSettings(() => ({ analyzerEndpoints: [ep('a')] }));
    await expect(
      mutateUserSettings(() => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    _resetUserSettingsCache();
    expect((await readUserSettings()).analyzerEndpoints.map((e) => e.id)).toEqual(['a']);
  });

  it('knownAnalyzerSecrets includes every saved endpoint key', async () => {
    await mutateUserSettings(() => ({
      analyzerEndpoints: [ep('a')],
      analyzerEndpointKeys: { a: { origin: 'http://127.0.0.1:8080', key: 'sk-endpoint-secret-1' } },
    }));
    expect(knownAnalyzerSecrets()).toContain('sk-endpoint-secret-1');
  });

  it('loadKnownAnalyzerSecrets reads settings when the cache is cold (the boot read is not awaited)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        analyzerEndpoints: [ep('a')],
        analyzerEndpointKeys: { a: { origin: 'http://127.0.0.1:8080', key: 'sk-cold-cache-secret-1' } },
      }),
    );
    _resetUserSettingsCache();
    expect(knownAnalyzerSecrets()).not.toContain('sk-cold-cache-secret-1');
    expect(await loadKnownAnalyzerSecrets()).toContain('sk-cold-cache-secret-1');
    /* A9 — the gate's load reaches the same provider, cold cache included. */
    _resetUserSettingsCache();
    expect(await loadKnownAnalyzerSecretsViaGate()).toContain('sk-cold-cache-secret-1');
  });
});

describe('readUserSettings — endpoint entries parse one by one (#3084 P25)', () => {
  it('drops one malformed endpoint and one malformed key entry with a warning, and keeps everything else, the Gemini key included', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        displayName: 'Kept',
        geminiApiKey: 'AIzaSy-kept-across-a-bad-entry',
        analyzerEndpoints: [
          { id: 'Bad_Id', name: 'Bad', baseUrl: 'not a url' },
          { id: 'good', name: 'Good', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 },
        ],
        analyzerEndpointKeys: {
          good: { origin: 'http://127.0.0.1:8080', key: 'sk-good-1234' },
          broken: { origin: 42 },
        },
      }),
    );
    _resetUserSettingsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = await readUserSettings();
      expect(s.displayName).toBe('Kept');
      expect(s.geminiApiKey).toBe('AIzaSy-kept-across-a-bad-entry');
      expect(s.analyzerEndpoints.map((e) => e.id)).toEqual(['good']);
      expect(s.analyzerEndpointKeys).toEqual({ good: { origin: 'http://127.0.0.1:8080', key: 'sk-good-1234' } });
      const lines = warn.mock.calls.map((c) => c.join(' '));
      expect(lines).toContainEqual(expect.stringContaining('dropping invalid analyzer endpoint #0 (id "Bad_Id")'));
      expect(lines).toContainEqual(expect.stringContaining('dropping invalid key entry for analyzer endpoint "broken"'));
      expect(lines.join('\n')).not.toContain('sk-good-1234');
    } finally {
      warn.mockRestore();
    }
  });

  it('a non-list analyzerEndpoints value is ignored, never resetting the file', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ displayName: 'Kept', analyzerEndpoints: 'garbage' }));
    _resetUserSettingsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = await readUserSettings();
      expect(s.displayName).toBe('Kept');
      expect(s.analyzerEndpoints).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('appends every dropped entry to user-settings.invalid-endpoints.json beside the settings file, never overwriting it, and each warning names that file (P25)', async () => {
    writeFileSync(ARCHIVE, '{"earlier":"line kept"}\n');
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        displayName: 'Kept',
        analyzerEndpoints: [{ id: 'Archive_Bad', name: 'Bad', baseUrl: 'not a url' }],
        analyzerEndpointKeys: { 'archive-broken': { origin: 7 } },
      }),
    );
    _resetUserSettingsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await readUserSettings();
      const lines = readFileSync(ARCHIVE, 'utf8').trimEnd().split('\n');
      expect(lines[0]).toBe('{"earlier":"line kept"}');
      const records = lines.slice(1).map((l) => JSON.parse(l) as { droppedAt: string; issues: string[] });
      expect(records).toEqual([
        expect.objectContaining({
          field: 'analyzerEndpoints',
          position: 0,
          id: 'Archive_Bad',
          entry: { id: 'Archive_Bad', name: 'Bad', baseUrl: 'not a url' },
        }),
        expect.objectContaining({ field: 'analyzerEndpointKeys', position: 'archive-broken', entry: { origin: 7 } }),
      ]);
      for (const r of records) {
        expect(Number.isNaN(Date.parse(r.droppedAt))).toBe(false);
        expect(r.issues.length).toBeGreaterThan(0);
      }
      const drops = warn.mock.calls.map((c) => c.join(' ')).filter((w) => w.includes('dropping invalid'));
      expect(drops).toHaveLength(2);
      for (const w of drops) expect(w).toContain(ARCHIVE);
    } finally {
      warn.mockRestore();
    }
  });

  it('the drop is archived before a write can persist it (P25)', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Persist_Bad', name: 'Bad', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mutateUserSettings(() => ({ displayName: 'After' }));
      expect(readFileSync(USER_SETTINGS_PATH, 'utf8')).not.toContain('Persist_Bad');
      expect(readFileSync(ARCHIVE, 'utf8')).toContain('"id":"Persist_Bad"');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the first of two endpoints sharing an id and archives the later one (P25)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        analyzerEndpoints: [
          { id: 'dup', name: 'First', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 },
          { id: 'dup', name: 'Second', baseUrl: 'http://127.0.0.1:9090/v1', gpu: 'any', contextTokens: 16384 },
        ],
      }),
    );
    _resetUserSettingsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = await readUserSettings();
      expect(s.analyzerEndpoints.map((e) => e.name)).toEqual(['First']);
      const records = readFileSync(ARCHIVE, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { issues: string[] });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ field: 'analyzerEndpoints', position: 1, id: 'dup', entry: { name: 'Second' } });
      expect(records[0].issues.join(' ')).toContain('repeats the id of an earlier endpoint');
    } finally {
      warn.mockRestore();
    }
  });

  it('two concurrent cold reads and a write share one read: the drop is appended once, before the write persists it (P25)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({ displayName: 'Before', analyzerEndpoints: [{ id: 'Race_Bad', name: 'Bad', baseUrl: 'nope' }] }),
    );
    _resetUserSettingsCache();
    await quietly(async () => {
      await Promise.all([readUserSettings(), readUserSettings(), mutateUserSettings(() => ({ displayName: 'After' }))]);
      const records = readFileSync(ARCHIVE, 'utf8').trimEnd().split('\n');
      expect(records).toHaveLength(1);
      expect(records[0]).toContain('"id":"Race_Bad"');
      expect(readFileSync(USER_SETTINGS_PATH, 'utf8')).not.toContain('Race_Bad');
    });
  });

  it('when the append fails, two concurrent cold reads and a write all succeed, and the file keeps the unarchived entry raw (P25)', async () => {
    const bad = { id: 'Blocked_Bad', name: 'Bad', baseUrl: 'nope' };
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ displayName: 'Before', analyzerEndpoints: [bad] }));
    mkdirSync(ARCHIVE);
    _resetUserSettingsCache();
    await quietly(async () => {
      const [a, b, write] = await Promise.allSettled([
        readUserSettings(),
        readUserSettings(),
        mutateUserSettings(() => ({ displayName: 'After' })),
      ]);
      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('fulfilled');
      expect(write.status).toBe('fulfilled');
      const onDisk = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
      expect(onDisk.displayName).toBe('After');
      expect(onDisk.analyzerEndpoints).toEqual([bad]);
      /* The loaded settings still drop it; only the file keeps it until the append lands. */
      expect((await readUserSettings()).analyzerEndpoints).toEqual([]);
    });
  });

  it('a failed append is retried on the next read; once it lands, a write no longer keeps the entry (P25)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({ displayName: 'Kept', analyzerEndpoints: [{ id: 'Retry_Bad', name: 'Bad', baseUrl: 'nope' }] }),
    );
    mkdirSync(ARCHIVE);
    _resetUserSettingsCache();
    await quietly(async () => {
      expect((await readUserSettings()).displayName).toBe('Kept');
      expect(statSync(ARCHIVE).isDirectory()).toBe(true);
      rmSync(ARCHIVE, { recursive: true, force: true });
      await readUserSettings();
      expect(readFileSync(ARCHIVE, 'utf8')).toContain('"id":"Retry_Bad"');
      await mutateUserSettings(() => ({ displayName: 'After' }));
      expect(readFileSync(USER_SETTINGS_PATH, 'utf8')).not.toContain('Retry_Bad');
    });
  });

  it.each([
    ['writeUserSettings', () => writeUserSettings({ displayName: 'x' })],
    ['writeGeminiApiKey', () => writeGeminiApiKey(null)],
    ['writeUpgradeMeta', () => writeUpgradeMeta({ showWhatsNew: false })],
    ['writeSetupCompletedAt', () => writeSetupCompletedAt(null)],
    ['writeTourCompletedAt', () => writeTourCompletedAt(null)],
    ['mutateUserSettings', () => mutateUserSettings(() => ({ displayName: 'x' }))],
  ] as const)('%s saves while a dropped entry is unarchived, and writes the entry back raw and unchanged (P25)', async (_name, write) => {
    const bad = { id: 'Kept_Bad', name: 'Bad', baseUrl: 'nope' };
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [bad] }));
    mkdirSync(ARCHIVE);
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      await write(); // never refuses because the append failed
      const onDisk = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf8')) as { analyzerEndpoints: unknown };
      expect(onDisk.analyzerEndpoints).toEqual([bad]);
    });
  });

  it('a key entry whose append failed is written back raw beside a key saved for another endpoint, and only its origin is archived once the retry lands (P25)', async () => {
    const rawKey = { origin: 99, key: 'sk-pending-key-secret-1' };
    const other = { origin: 'http://127.0.0.1:9090', key: 'sk-other' };
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpointKeys: { lab: rawKey } }));
    mkdirSync(ARCHIVE);
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      await mutateUserSettings(() => ({ analyzerEndpointKeys: { other } }));
      const onDisk = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf8')) as { analyzerEndpointKeys: Record<string, unknown> };
      expect(onDisk.analyzerEndpointKeys).toEqual({ other, lab: rawKey });
      rmSync(ARCHIVE, { recursive: true, force: true });
      await readUserSettings(); // the retry lands
      const archived = readFileSync(ARCHIVE, 'utf8');
      expect(archived).toContain('"position":"lab"');
      expect(archived).not.toContain('sk-pending-key-secret-1');
    });
  });

  it('a dropped key entry is archived with its origin only, never the key (P25)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({ analyzerEndpointKeys: { lab: { origin: 99, key: 'sk-archived-key-secret-1' } } }),
    );
    _resetUserSettingsCache();
    await quietly(async () => {
      expect((await readUserSettings()).analyzerEndpointKeys).toEqual({});
      const text = readFileSync(ARCHIVE, 'utf8');
      expect(text).not.toContain('sk-archived-key-secret-1');
      const record = JSON.parse(text.trimEnd()) as { entry: Record<string, unknown> };
      expect(record).toMatchObject({ field: 'analyzerEndpointKeys', position: 'lab', entry: { origin: 99 } });
      expect(record.entry).not.toHaveProperty('key');
    });
  });

  it('_resetUserSettingsCache forgets archived entries, so a later read archives the same entry again (P25)', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Reset_Bad', name: 'Bad', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      rmSync(ARCHIVE, { force: true });
      _resetUserSettingsCache();
      await readUserSettings();
      expect(readFileSync(ARCHIVE, 'utf8')).toContain('"id":"Reset_Bad"');
    });
  });
});
```
`USER_SETTINGS_PATH` is already exported (used at `routes/user-settings.test.ts:44`), and `server/src/test-setup.ts` redirects it to a temp file.

- [ ] **Step 2: Run and confirm failures**

Run:
```bash
npm --prefix server run test -- src/routes/user-settings.test.ts src/workspace/user-settings.endpoints.test.ts
```

Expected:
- `GET exposes analyzer endpoints…` FAILS: `analyzerEndpoints` is undefined.
- `the general PUT cannot write…` FAILS: `analyzerEndpoints` is undefined.
- `user-settings.endpoints.test.ts` FAILS to load: `does not provide an export named 'loadKnownAnalyzerSecrets'` (and `mutateUserSettings`).
- With the fields and `mutateUserSettings` added but not the per-entry parse, `drops one malformed endpoint…` FAILS: `displayName` is the default rather than `'Kept'`, and `geminiApiKey` is `null`, because one bad entry makes the whole-file `safeParse` fall back to defaults (`user-settings.ts:522-525`).
- The three P25 archive cases FAIL with `ENOENT` reading `user-settings.invalid-endpoints.json`, or, for the first, with the file holding only the seeded line. `keeps the first of two endpoints sharing an id…` FAILS: received `['First', 'Second']`.
- With the archive written but none of the Q3 guarantees: `two concurrent cold reads and a write share one read…` FAILS with `ENOENT` **before** the archive exists, and once it does exist this case PASSES on the single-flight half without any new code — PR #3195's `inFlightRead` (`:438`) already shares one cold read, so the only thing this task must add for it is the append itself, inside the shared read. (It is kept as a regression test of that sharing, not as a red-then-green proof of it; its mutation proof below mutates the shipped single flight.) `when the append fails…` and the six `%s saves while a dropped entry is unarchived…` rows FAIL (the write resolves but the file loses the entry); `a key entry whose append failed is written back raw…` FAILS (the file holds only `other`); `a failed append is retried…` FAILS with `ENOENT`; `a dropped key entry is archived with its origin only…` FAILS (the archive holds `sk-archived-key-secret-1`); `_resetUserSettingsCache forgets archived entries…` FAILS with `ENOENT`.

- [ ] **Step 3: Implement**

`server/src/workspace/user-settings.ts`:

1. Top import:
```ts
import { analyzerEndpointSchema } from './analyzer-endpoints.js';
```

2. Schema. Insert after `analyzerKeepAliveByModel: …default({}),` (`:253`):
```ts
  /* #3084 PR 3b — named OpenAI-compatible analyzer endpoints. Returned by GET.
     NOT writable through the general PUT (FORBIDDEN_KEYS): the dedicated
     /api/analyzer/endpoints routes are the only writers, via mutateUserSettings. */
  analyzerEndpoints: z.array(analyzerEndpointSchema).default([]),
  /* #3084 decision 3c — per-endpoint API keys, each bound at save time to the
     base URL's origin. Never returned by GET (routes/user-settings.ts envDerived
     strips it and adds analyzerEndpointKeyStatus), never accepted by the general
     PUT (FORBIDDEN_KEYS), never logged. */
  analyzerEndpointKeys: z.record(z.string(), endpointKeyEntrySchema).default({}),
```
Declare `endpointKeyEntrySchema` above `userSettingsSchema`:
```ts
/* #3084 — one saved endpoint key, bound at save time to the base URL's origin. */
const endpointKeyEntrySchema = z.object({ origin: z.string(), key: z.string() });
```

2b. Per-entry parse and the archive (P25). Extend the top imports: `dirname` → `dirname, join` from `node:path`, and `copyFile, mkdir` → `appendFile, copyFile, mkdir` from `node:fs/promises`. Insert above `readUserSettings` (`:436`):
```ts
/* #3084 P25 — endpoint entries are parsed one by one BEFORE the whole-file
   safeParse below. That parse falls back to DEFAULT_USER_SETTINGS when any
   field fails (:522-525), so one malformed endpoint would otherwise reset every
   setting, the saved Gemini key included. An invalid entry, or a later entry
   repeating an earlier id, is dropped from the loaded settings. Because every
   writer writes the whole merged object, the next write would delete it from
   disk, so readUserSettings appends it to the archive first, and while that
   append is failing every writer puts it back (withUnarchivedEntries). */
interface DroppedEndpointEntry {
  droppedAt: string;
  field: 'analyzerEndpoints' | 'analyzerEndpointKeys';
  /** list index, the key map's endpoint id, or null when the whole field was unusable */
  position: number | string | null;
  id: unknown;
  issues: string[];
  /** what the archive stores (a key entry: its origin only) */
  entry: unknown;
  /** In memory only, never appended: the value exactly as it was on disk, which a
      writer puts back while the append is failing (a key entry's raw value holds the key). */
  raw: unknown;
}

/** Beside the settings file. One JSON object per line; append-only — never truncated or rewritten. */
export function invalidEndpointsArchivePath(): string {
  return join(dirname(USER_SETTINGS_PATH), 'user-settings.invalid-endpoints.json');
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(entry)'}: ${i.message}`);
}

function dropInvalidEndpointEntries(raw: unknown, now: Date): { value: unknown; dropped: DroppedEndpointEntry[] } {
  const dropped: DroppedEndpointEntry[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, dropped };
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  const droppedAt = now.toISOString();
  if ('analyzerEndpoints' in obj) {
    if (!Array.isArray(obj.analyzerEndpoints)) {
      dropped.push({ droppedAt, field: 'analyzerEndpoints', position: null, id: null, issues: ['analyzerEndpoints: not a list'], entry: obj.analyzerEndpoints, raw: obj.analyzerEndpoints });
      out.analyzerEndpoints = [];
    } else {
      const seenIds = new Set<string>();
      out.analyzerEndpoints = obj.analyzerEndpoints.filter((entry, i) => {
        const parsed = analyzerEndpointSchema.safeParse(entry);
        if (parsed.success && !seenIds.has(parsed.data.id)) {
          seenIds.add(parsed.data.id);
          return true;
        }
        const id = entry && typeof entry === 'object' ? ((entry as { id?: unknown }).id ?? null) : null;
        const issues = parsed.success
          ? [`id: repeats the id of an earlier endpoint (${JSON.stringify(parsed.data.id)}); the first is kept`]
          : zodIssues(parsed.error);
        dropped.push({ droppedAt, field: 'analyzerEndpoints', position: i, id, issues, entry, raw: entry });
        return false;
      });
    }
  }
  if ('analyzerEndpointKeys' in obj) {
    const keys = obj.analyzerEndpointKeys;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
      /* P25 — origin only, never a key, even from a malformed field. */
      const entry = Array.isArray(keys) ? keys.map(keyEntryOriginOnly) : keyEntryOriginOnly(keys);
      dropped.push({ droppedAt, field: 'analyzerEndpointKeys', position: null, id: null, issues: ['analyzerEndpointKeys: not a map'], entry, raw: keys });
      out.analyzerEndpointKeys = {};
    } else {
      out.analyzerEndpointKeys = Object.fromEntries(
        Object.entries(keys as Record<string, unknown>).filter(([endpointId, entry]) => {
          const parsed = endpointKeyEntrySchema.safeParse(entry);
          if (parsed.success) return true;
          dropped.push({
            droppedAt,
            field: 'analyzerEndpointKeys',
            position: endpointId,
            id: endpointId,
            issues: zodIssues(parsed.error),
            entry: keyEntryOriginOnly(entry),
            raw: entry,
          });
          return false;
        }),
      );
    }
  }
  return { value: out, dropped };
}

/* #3084 P25 — a dropped key entry is archived with its origin only, never the key:
   the archive is a plain file beside the settings, and a key can be re-entered. A
   value with no `origin` (a bare string may BE the key) archives as {}. */
function keyEntryOriginOnly(entry: unknown): { origin?: unknown } {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'origin' in entry
    ? { origin: (entry as { origin: unknown }).origin }
    : {};
}

/* Entries this process has already archived: a cold re-read of the same file does
   not append them twice. (A restart before any write can append them again; the
   archive is append-only, so a repeat costs a line, never an entry.) */
const archivedDrops = new Set<string>();

const archiveKey = (d: DroppedEndpointEntry): string => JSON.stringify([d.field, d.position, d.entry]);

async function archiveDroppedEndpointEntries(dropped: DroppedEndpointEntry[], archive: string): Promise<void> {
  const fresh = dropped.filter((d) => !archivedDrops.has(archiveKey(d)));
  if (fresh.length === 0) return;
  await mkdir(dirname(archive), { recursive: true });
  /* P25 — field by field, never the whole object: `raw` is in-memory only (a key entry's
     raw value holds the key), and only `entry` is safe to write. */
  const lines = fresh.map((d) =>
    `${JSON.stringify({ droppedAt: d.droppedAt, field: d.field, position: d.position, id: d.id, issues: d.issues, entry: d.entry })}\n`,
  );
  await appendFile(archive, lines.join(''), { encoding: 'utf8', flag: 'a' });
  /* #3084 P25 — marked only once the append has succeeded; a failed append leaves the
     entries unmarked, so the retry appends them. */
  for (const d of fresh) archivedDrops.add(archiveKey(d));
}

/* #3084 P25 — dropped entries whose append failed. The next read retries them. Until
   that succeeds, every writer writes them back into the file raw (withUnarchivedEntries):
   each writer writes the whole merged object, which no longer holds them, so without
   that a write would delete them from disk before they are saved anywhere. */
let unarchivedDrops: DroppedEndpointEntry[] = [];
let archiveRetry: Promise<void> | null = null;

/* Never rejects: a failure is logged and kept pending. */
async function archiveOrKeepPending(dropped: DroppedEndpointEntry[]): Promise<void> {
  const archive = invalidEndpointsArchivePath();
  try {
    await archiveDroppedEndpointEntries(dropped, archive);
    unarchivedDrops = [];
  } catch (err) {
    unarchivedDrops = dropped;
    console.error(
      `[user-settings] could not append dropped analyzer endpoint entries to ${archive}; the next settings read retries, and until then settings writes keep those entries in the file unchanged:`,
      (err as Error)?.message,
    );
  }
}

/* Single-flight, like the cold read: concurrent warm reads share one retry. */
function retryUnarchivedDrops(): Promise<void> {
  if (!archiveRetry) {
    const retry = archiveOrKeepPending(unarchivedDrops);
    archiveRetry = retry;
    void retry.then(() => {
      if (archiveRetry === retry) archiveRetry = null;
    });
  }
  return archiveRetry;
}

/** #3084 P25 — what every settings writer puts on disk. A write never refuses because an
    append failed: the merged settings are written with each still-unarchived dropped
    entry put back raw and unchanged, so the entry stays in the file until its append
    lands. The cache keeps `merged`, so the entry stays dropped from the loaded settings.
    - An endpoint list entry goes after the merged list's entries.
    - A key-map entry goes back under its endpoint id, unless this write saved a key for
      that id: the new key replaces it, and the dropped entry stays pending for the archive.
    - A whole field that was not a list or map goes back only while the merged field is
      still empty. */
function withUnarchivedEntries(merged: UserSettings): Record<string, unknown> {
  if (unarchivedDrops.length === 0) return merged;
  const endpoints: unknown[] = [...merged.analyzerEndpoints];
  const keys: Record<string, unknown> = { ...merged.analyzerEndpointKeys };
  let endpointsField: unknown = endpoints;
  let keysField: unknown = keys;
  for (const d of unarchivedDrops) {
    if (d.field === 'analyzerEndpoints') {
      if (d.position !== null) endpoints.push(d.raw);
      else if (merged.analyzerEndpoints.length === 0) endpointsField = d.raw;
    } else if (d.position === null) {
      if (Object.keys(merged.analyzerEndpointKeys).length === 0) keysField = d.raw;
    } else if (!Object.hasOwn(merged.analyzerEndpointKeys, String(d.position))) {
      keys[String(d.position)] = d.raw;
    }
  }
  return { ...merged, analyzerEndpoints: endpointsField, analyzerEndpointKeys: keysField };
}

/* Names the entry's position and id, never its values (a key entry holds a key). */
function droppedEntryWarning(d: DroppedEndpointEntry, archive: string): string {
  const what =
    d.field === 'analyzerEndpointKeys'
      ? d.position === null
        ? 'analyzerEndpointKeys is not a map; ignoring it'
        : `dropping invalid key entry for analyzer endpoint ${JSON.stringify(d.position)}`
      : d.position === null
        ? 'analyzerEndpoints is not a list; ignoring it'
        : `dropping invalid analyzer endpoint #${d.position} (id ${JSON.stringify(d.id)})`;
  return `[user-settings] ${what}; the entry was saved to ${archive}`;
}
```
Then hook the per-entry drop into the read path **PR #3195 already shipped**. Do not rewrite that path.

**The single-flight requirement is already met — add no wrapper.** PR #3195 made the cold read single-flight: `inFlightRead` (declared `:375-378`) is set to one `performUserSettingsRead()` promise before any `await`, and `readUserSettings`'s first line (`:438`) returns it to every concurrent caller. That is exactly P25's "concurrent callers share one in-flight read, and so one append". An earlier draft of this task proposed its own `coldRead` wrapper plus a `readUserSettingsFromDisk` rewrite; both are **deleted here as already-shipped**, and reintroducing either would clobber #3195's stamp-based cache invalidation (`cacheMatchesDisk`, `cachedFileStamp`), its `.bak.N` recovery through `readJsonWithRecovery`, and its `commitRead` single-step commit.

Two edits, both surgical.

**(i) `readUserSettings` (`:436-450`) — the append retry only.** Replace the warm-cache line `:439`:
```ts
  if (cached && cacheMatchesDisk()) {
    /* #3084 P25 — a failed append left entries unarchived: retry it on this read. The
       stamp check is unchanged; this only adds the retry to the warm path. */
    if (unarchivedDrops.length > 0) await retryUnarchivedDrops();
    return cached;
  }
```
`if (inFlightRead) return inFlightRead;` (`:438`) and the whole `readPromise` / `finally` block (`:443-449`) stay **byte-identical**: that is the single flight.

**(ii) `performUserSettingsRead` (`:472-530`) — the drop, before the whole-object parse.** Insert between the migration write (its `.catch(…)` closes at `:521`) and the `safeParse` (`:522`):
```ts
  const { value: loaded, dropped } = dropInvalidEndpointEntries(migrated, new Date());
  if (dropped.length > 0) {
    /* #3084 P25 — the append runs BEFORE commitRead publishes the cache and this read
       resolves, so no writer (they all read first, inside writeChain) can persist the
       drop before the entry is saved. A failed append keeps the entries pending: the
       next read retries it, and until it lands every writer writes them back into the
       file raw (withUnarchivedEntries) instead of refusing. The migration write above
       writes `migrated`, which still holds the entries. */
    await archiveOrKeepPending(dropped);
    const archive = invalidEndpointsArchivePath();
    for (const d of dropped) console.warn(droppedEntryWarning(d, archive));
  }
```
and change the `safeParse` argument from `migrated` to `loaded`:
```ts
  const parsed = userSettingsSchema.safeParse({ ...DEFAULT_USER_SETTINGS, ...(loaded as object) });
```
The `commitRead({ … })` call below (`:524-529`) is **unchanged**, `corrupt: false` included — see the next paragraph. `explicitKeys` (`:512`) is still derived from `raw`, before the drop, so a file that *had* an `analyzerEndpoints` key still counts it as explicitly set even when every entry in it was dropped.

**A dropped endpoint entry does NOT set `corruptSettingsFile`. This is decided; do not re-open it.** That flag (`settingsFileCorrupt`, `:361`; read by `isUserSettingsFileCorrupt()`, `:409-411`; surfaced read-only on `GET /api/user/settings` and driving the frontend corruption banner) means the settings **file** was unreadable and had to be recovered from a `.bak.N` snapshot or fall back to in-memory defaults (`:479-498`). A dropped endpoint entry is a schema failure on **one entry** of a file that parsed perfectly well, and it is reported by its own `console.warn` naming the archive file — nothing else. So: do not set `corrupt: true` in either `commitRead` call, and do not wire the banner to this path.

Untouched by this task, and deliberately so: the all-backups-unreadable fallback (`:479-498`), the absent-file branch (`:499-509`), and `readJsonWithRecovery` itself. `dropInvalidEndpointEntries` only ever sees a value that already parsed as JSON, so none of those three can reach it.

2c. Writers. Each of `writeUserSettings` (`:592`, its write at `:626`), `writeGeminiApiKey` (`:1003`, write `:1009`), `writeUpgradeMeta` (`:1039`, write `:1048`), `writeSetupCompletedAt` (`:1069`, write `:1074`) and `writeTourCompletedAt` (`:1092`, write `:1097`) writes `merged` from inside `writeChain.then`. Their `const current = await readUserSettings();` line is **unchanged** — the read is what runs (and retries) the archive append before the write. Each write becomes (keeping #3195's `rotate` option, which every one of the five already passes):
```ts
    const written = withUnarchivedEntries(merged);
    await snapshotCorruptBytesBeforeWrite();
    await writeJsonAtomic(USER_SETTINGS_PATH, written, { rotate: { keep: USER_SETTINGS_BACKUP_KEEP } });
    clearCorruptFlagAfterWrite();
    stampCacheAfterWrite(written);
    cached = merged;
```
`cached = merged` stays as it is: the loaded settings keep the entry dropped; only the file keeps it until the append lands (P25).

**`stampCacheAfterWrite` must be stamped against what was written, not against `merged`.** It compares the stat'd file size to `Buffer.byteLength(JSON.stringify(written, null, 2))` (`:583-587`) to decide whether this process's own write can be trusted. While an append is pending, `withUnarchivedEntries(merged)` serialises *longer* than `merged`, so passing `merged` makes every such write record `STAMP_FORCE_REREAD` and forces a needless full re-parse on the next read. Passing the object actually written keeps #3195's check honest. Its signature widens accordingly — the body only stringifies:
```ts
function stampCacheAfterWrite(written: object): void {
```
(`withUnarchivedEntries` returns `UserSettings` unchanged when nothing is pending and a `Record<string, unknown>` when something is, so `object` is the type that accepts both.)

Afterwards `git grep -n "writeJsonAtomic(USER_SETTINGS_PATH" server/src/workspace/user-settings.ts` must show exactly seven lines: the eager-load migration write inside `performUserSettingsRead` (`:516`, unchanged — it writes `migrated`, which still holds the dropped entries), and six `withUnarchivedEntries` writes (the five writers above plus `mutateUserSettings`), each carrying the `rotate` option.

2d. `_resetUserSettingsCache` (`:1134-1148`). After `writeChain = Promise.resolve();` (`:1139`), add:
```ts
  /* #3084 P25 — forget archived and unarchived drops and any in-flight archive retry,
     so a later test that reuses an entry archives it again. */
  archivedDrops.clear();
  unarchivedDrops = [];
  archiveRetry = null;
```
No `coldRead = null;` — there is no `coldRead`. #3195's `_resetUserSettingsCache` already clears the in-flight **read** (`inFlightRead = null`, `:1137`) along with `cached` and `cachedFileStamp`; only the archive state is new here.

3. Defaults. After `analyzerKeepAliveByModel: {},` (`:334`):
```ts
  /* #3084 — no endpoints and no keys on a fresh install. */
  analyzerEndpoints: [],
  analyzerEndpointKeys: {},
```

4. `FORBIDDEN_KEYS`. After `'tourCompletedAt',` (`:660`):
```ts
  /* #3084 PR 3b — analyzer endpoints are written only by the endpoint routes;
     their keys only by PUT /api/analyzer/endpoints/{id}/key; the key status is
     derived on GET. */
  'analyzerEndpoints',
  'analyzerEndpointKeys',
  'analyzerEndpointKeyStatus',
```

5. After `writeUserSettings` (ends `:638`):
```ts
/** Serialised read-decide-write for fields the general PUT may not touch
    (#3084 endpoint routes). `decide` runs INSIDE writeChain against the
    freshly read settings, so two concurrent endpoint edits cannot lose each
    other's change, and a refusal (duplicate id, still referenced, …) is
    decided against exactly the settings it would have overwritten. A throw
    from `decide` writes nothing and propagates. */
export async function mutateUserSettings(
  decide: (current: UserSettings) => Partial<UserSettings>,
): Promise<UserSettings> {
  const next = writeChain.then(async () => {
    /* P25 — the read runs (and retries) the archive append first; the write then puts any
       still-unarchived entry back into the file raw, so saving never refuses and nothing
       is lost. */
    const current = await readUserSettings();
    const patch = decide(current);
    const merged = userSettingsSchema.parse({ ...current, ...patch });
    /* Same write discipline as the five shipped writers (#3195): rotate a `.bak.N`
       snapshot so an endpoint write is recoverable like any other, preserve any corrupt
       bytes first, clear the flag on success, and stamp the cache from what was actually
       written so the next read doesn't mistake our own write for an out-of-band change. */
    const written = withUnarchivedEntries(merged);
    await snapshotCorruptBytesBeforeWrite();
    await writeJsonAtomic(USER_SETTINGS_PATH, written, { rotate: { keep: USER_SETTINGS_BACKUP_KEEP } });
    clearCorruptFlagAfterWrite();
    stampCacheAfterWrite(written);
    cached = merged;
    for (const key of Object.keys(patch)) explicitlySetKeys.add(key);
    return merged;
  });
  writeChain = next.catch(() => undefined);
  return next;
}
```

6. `knownAnalyzerSecrets` body becomes the first function below, and `loadKnownAnalyzerSecrets` is added after it:
```ts
export function knownAnalyzerSecrets(): string[] {
  const out: string[] = [];
  const gemini = getResolvedGeminiApiKey();
  if (gemini) out.push(gemini);
  for (const entry of Object.values(cached?.analyzerEndpointKeys ?? {})) out.push(entry.key);
  return out;
}

/** #3084 P22 — the same list after settings have been read at least once. The
    boot warm (index.ts:188, void bootWarmUserSettings()) is not awaited, so an error could
    redacted against a cold cache. readUserSettings() returns the cache when warm. */
export async function loadKnownAnalyzerSecrets(): Promise<string[]> {
  await readUserSettings();
  return knownAnalyzerSecrets();
}
```
Its doc comment's "Task 3b.6 adds the endpoint keys." sentence is deleted. Task 3b.1's gate registration becomes (A9):
```ts
/* #3084 A9 — the provider behind analyzer/known-secrets-gate.ts. */
registerKnownSecretsProvider({ known: knownAnalyzerSecrets, load: loadKnownAnalyzerSecrets });
```

`server/src/routes/user-settings.ts`:

1. Imports. Add:
```ts
import { endpointKeyStatus, type EndpointKeyStatus } from '../workspace/analyzer-endpoints.js';
```

2. Replace `:33-72` with the block below. **It must keep PR #3195's `corruptSettingsFile` field and its `isUserSettingsFileCorrupt()` overlay** — that field is what the frontend corruption banner reads, and dropping it from this interface (or from the returned object) would silently delete the banner's only data source. `isUserSettingsFileCorrupt` therefore stays in the `../workspace/user-settings.js` import at `:19-28`, untouched. Note it is unrelated to the endpoint drop: a dropped entry never sets it (P25).
```ts
export interface UserSettingsResponse extends Omit<UserSettings, 'geminiApiKey' | 'analyzerEndpointKeys'> {
  apiKeyStatus: 'set' | 'unset';
  /* #3084 — per endpoint id; the keys themselves are never returned. */
  analyzerEndpointKeyStatus: Record<string, EndpointKeyStatus>;
  workspaceRoot: string;
  workspaceSource: 'env' | 'default' | 'override';
  /* The EFFECTIVE default TTS model after the Qwen-when-installed resolution
     (getResolvedTtsModelKey). Distinct from the STORED `defaultTtsModelKey`
     (which the Account picker shows + round-trips): the frontend seeds the
     session engine from this so a fresh box with Qwen installed defaults to
     Qwen, while the stored key stays Kokoro until the user explicitly picks. */
  resolvedTtsModelKey: UserSettings['defaultTtsModelKey'];
  /* #3195 — server-computed, not part of the persisted UserSettings shape; see
     isUserSettingsFileCorrupt() in workspace/user-settings.ts. Recomputed fresh on
     every response, same as apiKeyStatus/workspaceRoot/workspaceSource. Means the
     settings FILE was unreadable and recovered — never set by a dropped analyzer
     endpoint entry (P25). */
  corruptSettingsFile: boolean;
}

/** Exported for routes/analyzer-endpoints.ts, whose writes answer in this shape. */
export function envDerived(settings: UserSettings): UserSettingsResponse {
  /* Drop the plaintext keys — the frontend only ever sees the status fields. */
  const rest = { ...settings } as Partial<UserSettings>;
  delete rest.geminiApiKey;
  delete rest.analyzerEndpointKeys;
  return {
    ...(rest as Omit<UserSettings, 'geminiApiKey' | 'analyzerEndpointKeys'>),
    apiKeyStatus: getResolvedGeminiApiKey() ? 'set' : 'unset',
    analyzerEndpointKeyStatus: endpointKeyStatus(settings),
    /* Surface the ENV-resolved worker count (GEN_WORKERS env > account setting >
       default 2), mirroring apiKeyStatus. The client queue-dispatcher reads
       `account.generationWorkers` from this response, so without this overlay
       the GEN_WORKERS env never reaches the dispatcher and can't cap concurrency
       — it was a deploy knob that did nothing. When the env is unset,
       getResolvedGenerationWorkers() returns the on-disk account value, so the
       Account-tab UI is unchanged. */
    generationWorkers: getResolvedGenerationWorkers(),
    /* Read-only effective default (Qwen-when-installed, else Kokoro). The
       stored `defaultTtsModelKey` above is left untouched so the Account
       picker shows what's saved and a no-op round-trip can't pollute it. */
    resolvedTtsModelKey: getResolvedTtsModelKey(),
    workspaceRoot: WORKSPACE_ROOT,
    workspaceSource: WORKSPACE_SOURCE,
    corruptSettingsFile: isUserSettingsFileCorrupt(),
  };
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/routes/user-settings.test.ts src/workspace/user-settings.endpoints.test.ts src/workspace/user-settings.test.ts src/workspace/analyzer-endpoints.test.ts src/routes/failure-taxonomy.test.ts
npm run typecheck
npm run check:cycles
```

Expected:
- PASS.
- No new cycle: the `OK` line with the count `N` recorded in Task 3b.1. `user-settings.ts` → `analyzer-endpoints.ts` → (`model-id.ts`, `errors.ts`); neither of those imports `user-settings.ts`, and `known-secrets-gate.ts` is a leaf.

- [ ] **Step 5: Mutation proofs**

Revert one change at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| Delete `delete rest.analyzerEndpointKeys;` | `GET exposes analyzer endpoints and key status, never the keys` |
| Remove `'analyzerEndpointKeys'` from `FORBIDDEN_KEYS` | `the general PUT cannot write…` (the smuggled key reaches the file) |
| In `mutateUserSettings`, read `current` **outside** `writeChain.then` | `serialises concurrent decisions so neither change is lost` (one id lost) |
| In `readUserSettings`, spread `migrated` instead of `loaded` into the `safeParse` | `drops one malformed endpoint and one malformed key entry…` (the file resets: `geminiApiKey` is `null`) |
| In `dropInvalidEndpointEntries`, delete the `analyzerEndpointKeys` block | the same test (`broken` makes the whole parse fail) |
| Delete the `await archiveOrKeepPending(dropped);` statement | `appends every dropped entry…` and `the drop is archived before a write can persist it` |
| `readUserSettings`: delete `if (inFlightRead) return inFlightRead;` (`:438`, #3195's single flight) | `two concurrent cold reads and a write share one read…` (3 archive lines). Restoring it is the fix — this proves the shipped single flight is what carries P25's once-only append, not new code |
| `performUserSettingsRead`: move the `archiveOrKeepPending(dropped)` block to **after** `commitRead(…)` | `the drop is archived before a write can persist it` and `two concurrent cold reads and a write share one read…` (the write sees a published cache and persists the drop first) |
| `envDerived`: delete `corruptSettingsFile: isUserSettingsFileCorrupt(),` | `routes/user-settings.test.ts`'s existing #3195 corruption-banner case (the field is absent from GET) — the regression this task's `:33-72` replacement must not reintroduce |
| `archiveDroppedEndpointEntries`: mark `archivedDrops` before `await mkdir(…)` (the pre-Q3 order) | `a failed append is retried on the next read…` (`ENOENT`: the retry finds the entry marked) |
| `archiveDroppedEndpointEntries`: append `JSON.stringify(d)` (the whole object, `raw` included) instead of the field-by-field line | `a key entry whose append failed is written back raw…` (the archive holds `sk-pending-key-secret-1`) |
| `readUserSettings`: `if (cached) return cached;` without `retryUnarchivedDrops()` | `a failed append is retried on the next read…` |
| `archiveOrKeepPending`: in the `catch`, delete `unarchivedDrops = dropped;` | `when the append fails, two concurrent cold reads and a write all succeed…`, the six `%s saves while a dropped entry is unarchived…` rows and `a key entry whose append failed is written back raw…` (every file check loses the entry) |
| `withUnarchivedEntries`: `return merged;` unconditionally | the same eight cases |
| `writeTourCompletedAt` writes `merged` instead of `withUnarchivedEntries(merged)` (repeat for each writer) | that writer's `%s saves while a dropped entry is unarchived…` row |
| `withUnarchivedEntries`: drop the `!Object.hasOwn(merged.analyzerEndpointKeys, String(d.position))` guard | `a key entry whose append failed is written back raw…` (the raw entry overwrites the key the write just saved for the same id) |
| Key block: `entry` instead of `entry: keyEntryOriginOnly(entry)` | `a dropped key entry is archived with its origin only, never the key` |
| `_resetUserSettingsCache`: delete `archivedDrops.clear();` | `_resetUserSettingsCache forgets archived entries…` |
| Gate registration back to `load: async () => knownAnalyzerSecrets()` (3b.1's) | `loadKnownAnalyzerSecrets reads settings when the cache is cold…` (the gate assertion) |
| In `archiveDroppedEndpointEntries`, `appendFile(archive, …)` → `writeFile(archive, …)` (imported from `node:fs/promises`) | `appends every dropped entry … never overwriting it` (`lines[0]` is no longer the seeded line) |
| In `dropInvalidEndpointEntries`, `parsed.success && !seenIds.has(parsed.data.id)` → `parsed.success` | `keeps the first of two endpoints sharing an id and archives the later one` (received `['First', 'Second']`) |
| In `droppedEntryWarning`, drop `; the entry was saved to ${archive}` | `appends every dropped entry … each warning names that file` |
| `loadKnownAnalyzerSecrets` body → `return knownAnalyzerSecrets();` | `loadKnownAnalyzerSecrets reads settings when the cache is cold…` |

- [ ] **Step 6: Commit**
```bash
git add server/src/workspace/user-settings.ts server/src/routes/user-settings.ts server/src/routes/user-settings.test.ts server/src/workspace/user-settings.endpoints.test.ts
git commit -m "feat(server): store analyzer endpoints and origin-bound keys in user settings"
```

---

### Task 3b.6b: Surface dropped endpoint entries on GET, and an acknowledge route (F5, server half)

Owner decision (F5): a drop at read time (Task 3b.6, P25) is not silent. `GET /api/user/settings`
exposes every unacknowledged drop read-only; an acknowledge route retires the ones the user has
seen; a new drop after acknowledgement shows again. The UI banner is PR 3d's job — this task ships
the data only.

**Archive stays append-only (P25, unchanged).** `user-settings.invalid-endpoints.json` is still never
truncated or rewritten (Task 3b.6). Acknowledgement therefore cannot mark a line in that file. A
second, small sidecar file records which **content hashes** are acknowledged (never archiveIds —
review pass 2, item 4: an archiveId is minted fresh every time an entry is re-archived, so acknowledging
by id would stop applying the moment that happens); `listDroppedEndpointEntries` joins the two at read
time. This is a design decision this task makes, not one the decision record specified — recorded
here because it is the one place F5(c) could have contradicted P25's append-only rule if done
carelessly.

**Unarchived pending entries ARE listed.** An entry whose append is still retrying (`unarchivedDrops`,
Task 3b.6) has no `archiveId` yet. It is listed with `archiveId: null` — the user must still be told
even though the archive write hasn't landed — and `acknowledgeDroppedEndpointEntries` ignores a
`null` or unknown id rather than refusing (an ack racing a retry is not an error).

**Issues are `path: code`, never `path: message`.** Task 3b.6's `DroppedEndpointEntry.issues` is
kept as-is (human-readable, used by the console warning and by Task 3b.6's own
`'repeats the id of an earlier endpoint'` / duplicate-id test). This task adds a parallel
`codes: string[]` — `path: code` from the same zod issues (or a synthetic code for the two
non-zod refusals: `duplicate_id`, `invalid_type`) — because a raw zod `.message` can echo shape
hints an attacker-controlled entry chose, while `.code` is a fixed enum. The summary's `issues`
field is `codes`, never `issues`.

**Files:**
- Modify: `server/src/workspace/user-settings.ts` — `DroppedEndpointEntry` (Task 3b.6, after `entry`/`raw`): add `codes: string[]` and `contentHash: string` (item 5, below); `zodIssues` (add sibling `zodIssueCodes`); the three `dropped.push(…)` call sites in `dropInvalidEndpointEntries` (whole-field, per-entry, key-entry) each gain a `codes` value alongside `issues`, and a `contentHash`; `archiveDroppedEndpointEntries` (skip a hash already archived — item 5 — and assign `archiveId: randomUUID()` per line in the serialised object); add `droppedEndpointEntriesAcknowledgedPath()`, `readAcknowledgedHashes()`, `listDroppedEndpointEntriesSync()`, `listDroppedEndpointEntries()`, `acknowledgeDroppedEndpointEntries()` after `invalidEndpointsArchivePath()` (acknowledgement is serialised through `writeChain`, item 6 — not a bare `writeJsonAtomic` race). Add `randomUUID`, `createHash` to the top `node:crypto` import (new), and `readFileSync` to the existing top `node:fs` import (`:14`, today only `existsSync, statSync` — see "Wrong locations" below). `FORBIDDEN_KEYS` (Task 3b.6, `:643` on `main`, THIS file — never `routes/user-settings.ts`) gains `'droppedEndpointEntries'` in the same block as `'analyzerEndpoints'`.
- Modify: `server/src/routes/user-settings.ts`:
  - `UserSettingsResponse` — add `droppedEndpointEntries: DroppedEndpointEntrySummary[]`;
  - `envDerived` — add `droppedEndpointEntries: listDroppedEndpointEntriesSync()` (envDerived is synchronous and shared by every endpoint-CRUD 200 response, Task 3b.7; the archive and ack files are tiny, so a sync read costs nothing worth an async threading-through);
  - new route `POST /dropped-endpoint-entries/acknowledge` on `userSettingsRouter` (not `analyzerEndpointsRouter` — the decision names it under `/api/user/settings`), body `{ archiveIds: string[] }`, 200 with the `GET` body.

**Wrong locations (review, item 9).** `FORBIDDEN_KEYS` is declared and consumed entirely inside
`server/src/workspace/user-settings.ts` (`stripForbiddenKeys`, called from `writeUserSettings`) —
`routes/user-settings.ts` never references it. An earlier draft of this task put the `FORBIDDEN_KEYS`
edit under the routes file; it belongs with the other `workspace/user-settings.ts` edits above.
Likewise `readFileSync` is not already imported in `workspace/user-settings.ts` at `46e62a34` (only
`existsSync, statSync` at `:14`) — an earlier draft assumed it was; this task adds it explicitly.
- Modify: `openapi.yaml`:
  - `UserSettings.properties` — add `droppedEndpointEntries` (readOnly array of `DroppedEndpointEntry` — renamed in this schema to avoid colliding with Task 3b.6's internal type of the same name; call the OpenAPI schema `DroppedEndpointEntrySummary`);
  - new schema `DroppedEndpointEntrySummary`;
  - new path `/api/user/settings/dropped-endpoint-entries/acknowledge`, operationId `acknowledgeDroppedEndpointEntries`.
- Regenerate: `src/lib/api-types.ts`.
- Modify: `src/lib/api.ts` — `MOCK_USER_SETTINGS` gains `droppedEndpointEntries: []`; a mock `acknowledgeDroppedEndpointEntries` alongside the other mock endpoint functions (Task 3b.9), added to `real`/`mock`. No account-slice thunk yet — PR 3d wires the banner and dispatches it.
- Test: `server/src/workspace/user-settings.dropped-entries.test.ts` (new).
- Test: `server/src/routes/user-settings.test.ts` (add).

**Interfaces:**
- Consumes: `DroppedEndpointEntry`, `unarchivedDrops`, `invalidEndpointsArchivePath`, `writeChain`, `USER_SETTINGS_PATH` (Task 3b.6).
- Produces:
  - `export interface DroppedEndpointEntrySummary { archiveId: string | null; kind: 'endpoint' | 'key'; endpointId?: string; name?: string; origin?: string; issues: string[]; droppedAt: string }` — `name` is capped at 80 characters (item 10, below: it comes from a raw entry that FAILED validation, so it never went through `analyzerEndpointSchema`'s own `.max(80)`). No `acknowledgedAt`: acknowledgement lives only in the sidecar file, and a listed entry is by definition unacknowledged, so nothing would ever set it. No `contentHash` (item 5): it never leaves the server.
  - `export async function listDroppedEndpointEntries(): Promise<DroppedEndpointEntrySummary[]>`
  - `export async function acknowledgeDroppedEndpointEntries(archiveIds: string[]): Promise<void>` — serialised through `writeChain` (item 6), not a bare read-then-write.
  - `export function droppedEndpointEntriesAcknowledgedPath(): string` — beside the settings file, like `invalidEndpointsArchivePath()`.

**Content-hash de-duplication and durable acknowledgement (review, item 5).** "Got it" must survive a
restart for the same unchanged entry — it did not, in the first draft of this task: Task 3b.6's
`archivedDrops` de-dupe (which stops the SAME process from appending an unchanged entry twice) is an
in-memory `Set`, so a restart forgets it, and the next read appends a FRESH archive line with a FRESH
`archiveId` for the very same bad entry, un-acknowledged — the acknowledgement the user gave the OLD
`archiveId` no longer applies to anything. Each archive record gains `contentHash` — sha256 of a
canonical (sorted-key) JSON encoding of the dropped entry's raw value (`entry`/`raw`, never `droppedAt`
or `id`, so the hash depends only on what makes it invalid). Two things use it:
- **On append** (`archiveDroppedEndpointEntries`, Task 3b.6): before appending, also check the hashes
  already present in the ON-DISK archive file (not just the in-memory `archivedDrops` Set) — an entry
  whose hash is already archived is not appended again, durably, across restarts.
- **On acknowledge:** the sidecar stores acknowledged **content hashes**, not archiveIds.
  `acknowledgeDroppedEndpointEntries(archiveIds)` resolves each given `archiveId` to its `contentHash`
  by reading the current archive (archiveIds map to hashes only for this one lookup — the caller still
  passes archiveIds, matching what `listDroppedEndpointEntries` returned) and acknowledges the hash.
  `listDroppedEndpointEntriesSync` then hides any archive line whose `contentHash` is acknowledged,
  regardless of which `archiveId` that line currently carries. A changed or genuinely new bad entry
  hashes differently, so it is never hidden by an old acknowledgement — it shows again.

**Tests kept green:** `server/src/workspace/user-settings.endpoints.test.ts` (Task 3b.6) — `codes` and
`contentHash` are additive, so its `issues`-based assertions are untouched.

- [ ] **Step 1: Write the failing tests**

`server/src/workspace/user-settings.dropped-entries.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  USER_SETTINGS_PATH,
  _resetUserSettingsCache,
  acknowledgeDroppedEndpointEntries,
  droppedEndpointEntriesAcknowledgedPath,
  invalidEndpointsArchivePath,
  listDroppedEndpointEntries,
  readUserSettings,
} from './user-settings.js';

const ARCHIVE = join(dirname(USER_SETTINGS_PATH), 'user-settings.invalid-endpoints.json');
const ACK = droppedEndpointEntriesAcknowledgedPath();

beforeEach(() => {
  if (existsSync(USER_SETTINGS_PATH)) rmSync(USER_SETTINGS_PATH, { force: true });
  rmSync(ARCHIVE, { force: true, recursive: true });
  rmSync(ACK, { force: true, recursive: true });
  _resetUserSettingsCache();
});
afterAll(() => {
  if (existsSync(USER_SETTINGS_PATH)) rmSync(USER_SETTINGS_PATH, { force: true });
  rmSync(ARCHIVE, { force: true, recursive: true });
  rmSync(ACK, { force: true, recursive: true });
  _resetUserSettingsCache();
});

async function quietly(body: () => Promise<void>): Promise<void> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await body();
  } finally {
    warn.mockRestore();
  }
}

describe('listDroppedEndpointEntries / acknowledgeDroppedEndpointEntries (#3084 F5)', () => {
  it('lists a dropped endpoint entry with a code, not a message, and never the rejected value', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Bad_Id', name: 'Lab', baseUrl: 'not a url' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [entry] = await listDroppedEndpointEntries();
      expect(entry).toMatchObject({ kind: 'endpoint', endpointId: 'Bad_Id', name: 'Lab' });
      expect(typeof entry.archiveId).toBe('string');
      /* zod 4.4.3 (server/package.json "zod": "^4", installed 4.4.3): a .url()
         failure is code "invalid_format" (message "Invalid URL"), not the zod-3
         "invalid_string" this test asserted before — review item 4. */
      expect(entry.issues.some((c) => c.endsWith(': invalid_format'))).toBe(true);
      /* No-echo: zod's own message never contains the submitted value either
         ("Invalid URL" names no URL), but assert on the submitted value's
         absence directly rather than on today's exact zod wording, which is
         not this test's contract to pin. */
      expect(entry.issues.join(' ')).not.toContain('not a url');
      expect(JSON.stringify(entry)).not.toContain('not a url');
    });
  });

  it('lists a dropped key entry with the origin only, never the key, and asserts its issues', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpointKeys: { lab: { origin: 99, key: 'sk-listed-secret-1' } } }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [entry] = await listDroppedEndpointEntries();
      expect(entry).toMatchObject({ kind: 'key', endpointId: 'lab' });
      expect(entry.origin).toBeUndefined(); // origin itself (99) failed its own schema check
      /* #3084 F5 review, item 8 (~6250) — this case previously asserted no
         issues content at all. `origin: 99` fails endpointKeyEntrySchema's
         `z.string()` check on `origin`, so the code names that field. */
      expect(entry.issues).toEqual(['origin: invalid_type']);
      expect(JSON.stringify(entry)).not.toContain('sk-listed-secret-1');
    });
  });

  it('a dropped key entry\'s archive line and the acknowledged-hashes sidecar hold no substring of the key, and no hash is computed over it (#3084 F5 review pass 2, item 2)', async () => {
    const KEY = 'sk-no-material-on-disk-secret-1';
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpointKeys: { lab: { origin: 99, key: KEY } } }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [entry] = await listDroppedEndpointEntries();
      /* Not `droppedEntryContentHash(entry)` (the raw value, which holds KEY) —
         computed over the origin-only projection plus the endpoint id instead,
         so a hash of the raw key never exists anywhere, including in memory
         long enough to write it. Built the same way `canonicalStringify`
         would (sorted keys), so this genuinely matches what a raw-entry hash
         would put on disk if the mutation in Step 5's table were applied —
         not a string that merely looks plausible. */
      const wrongHash = createHash('sha256').update('{"key":' + JSON.stringify(KEY) + ',"origin":99}').digest('hex');
      const archiveText = readFileSync(ARCHIVE, 'utf8');
      expect(archiveText).not.toContain(KEY);
      expect(archiveText).not.toContain(wrongHash);
      await acknowledgeDroppedEndpointEntries([entry.archiveId as string]);
      const sidecarText = readFileSync(ACK, 'utf8');
      expect(sidecarText).not.toContain(KEY);
      expect(sidecarText).not.toContain(wrongHash);
      expect(await listDroppedEndpointEntries()).toEqual([]);
    });
  });

  it('acknowledgement is keyed on content hash, not on the archiveId that happens to be current, so it survives the archive being re-created with a fresh archiveId (#3084 F5 review pass 2, item 4)', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Hashkey_Bad', name: 'H', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [first] = await listDroppedEndpointEntries();
      await acknowledgeDroppedEndpointEntries([first.archiveId as string]);
      expect(await listDroppedEndpointEntries()).toEqual([]);
      /* Delete the archive itself (not just reset the cache): the on-disk
         hash-dedupe (Task 3b.6, review item 5) has nothing left to match, so
         the next cold read re-archives the SAME entry under a BRAND NEW
         archiveId — exactly the case that distinguishes hash-keyed
         acknowledgement from id-keyed. Under id-keyed acknowledgement this
         entry would reappear here, because the id the sidecar remembers no
         longer names any current line. */
      rmSync(ARCHIVE, { force: true });
      _resetUserSettingsCache();
      await readUserSettings();
      const after = await listDroppedEndpointEntries();
      expect(after).toEqual([]);
      const onDiskNow = JSON.parse(readFileSync(ARCHIVE, 'utf8').trimEnd()) as { archiveId: string };
      expect(onDiskNow.archiveId).not.toBe(first.archiveId);
    });
  });

  it('an unarchived pending entry is listed with archiveId null', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Pending_Bad', name: 'P', baseUrl: 'nope' }] }));
    mkdirSync(ARCHIVE);
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [entry] = await listDroppedEndpointEntries();
      expect(entry).toMatchObject({ archiveId: null, endpointId: 'Pending_Bad' });
    });
  });

  it('a name over 80 characters is capped in the summary (review item 10)', async () => {
    const longName = 'x'.repeat(200);
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Long_Name', name: longName, baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [entry] = await listDroppedEndpointEntries();
      expect(entry.name).toHaveLength(80);
      expect(entry.name).toBe(longName.slice(0, 80));
    });
  });

  it('acknowledging an archiveId hides it, and it stays hidden across a simulated restart for the SAME unchanged entry, with no new archive line written (#3084 F5 review, item 5)', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Ack_Bad', name: 'A', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [first] = await listDroppedEndpointEntries();
      await acknowledgeDroppedEndpointEntries([first.archiveId as string]);
      expect(await listDroppedEndpointEntries()).toEqual([]);
      const archiveLinesBefore = readFileSync(ARCHIVE, 'utf8').trimEnd().split('\n').length;
      /* Simulated restart: a cold cache re-reading the SAME on-disk settings
         file. Task 3b.6's per-process archivedDrops Set would be empty here
         (a real restart), so this is exactly the case item 5 fixes. */
      _resetUserSettingsCache();
      await readUserSettings();
      expect(await listDroppedEndpointEntries()).toEqual([]);
      const archiveLinesAfter = readFileSync(ARCHIVE, 'utf8').trimEnd().split('\n').length;
      expect(archiveLinesAfter).toBe(archiveLinesBefore); // no duplicate line for the same hash
    });
  });

  it('a MODIFIED bad entry (different content, same id) is listed again even after the original was acknowledged', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Changed_Bad', name: 'Before', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [first] = await listDroppedEndpointEntries();
      await acknowledgeDroppedEndpointEntries([first.archiveId as string]);
      writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Changed_Bad', name: 'After', baseUrl: 'still nope' }] }));
      _resetUserSettingsCache();
      await readUserSettings();
      const after = await listDroppedEndpointEntries();
      expect(after).toHaveLength(1);
      expect(after[0].name).toBe('After');
      expect(after[0].archiveId).not.toBe(first.archiveId);
    });
  });

  it('acknowledging twice keeps the first acknowledgement (union, not replace) (#3084 F5 review, item 8)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        analyzerEndpoints: [
          { id: 'Union_A', name: 'A', baseUrl: 'nope-a' },
          { id: 'Union_B', name: 'B', baseUrl: 'nope-b' },
        ],
      }),
    );
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [a, b] = await listDroppedEndpointEntries();
      await acknowledgeDroppedEndpointEntries([a.archiveId as string]);
      await acknowledgeDroppedEndpointEntries([b.archiveId as string]);
      expect(await listDroppedEndpointEntries()).toEqual([]);
    });
  });

  it('two concurrent acknowledge calls do not lose either one (serialised through writeChain, review item 6)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        analyzerEndpoints: [
          { id: 'Race_A', name: 'A', baseUrl: 'nope-a' },
          { id: 'Race_B', name: 'B', baseUrl: 'nope-b' },
        ],
      }),
    );
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [a, b] = await listDroppedEndpointEntries();
      await Promise.all([
        acknowledgeDroppedEndpointEntries([a.archiveId as string]),
        acknowledgeDroppedEndpointEntries([b.archiveId as string]),
      ]);
      expect(await listDroppedEndpointEntries()).toEqual([]);
    });
  });

  it('acknowledging an unknown or null archiveId is a no-op, not a refusal', async () => {
    await expect(acknowledgeDroppedEndpointEntries(['does-not-exist'])).resolves.toBeUndefined();
  });

  it('GET /api/user/settings exposes droppedEndpointEntries and refuses it on the general PUT', async () => {
    const { default: request } = await import('supertest');
    process.env.WORKSPACE_DIR = dirname(USER_SETTINGS_PATH);
    const [{ userSettingsRouter }] = await Promise.all([import('../routes/user-settings.js')]);
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/user/settings', userSettingsRouter);
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Route_Bad', name: 'R', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      const get = await request(app).get('/api/user/settings');
      expect(get.body.droppedEndpointEntries).toHaveLength(1);
      const put = await request(app).put('/api/user/settings').send({ droppedEndpointEntries: [] });
      expect(put.status).toBe(200);
      expect((await request(app).get('/api/user/settings')).body.droppedEndpointEntries).toHaveLength(1);
      /* The acknowledge route's malformed-body refusal matches every other
         refusal in this file: { error, code, issues }. */
      const bad = await request(app).post('/api/user/settings/dropped-endpoint-entries/acknowledge').send({ archiveIds: 'not-an-array' });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ error: 'Invalid payload.', code: 'invalid' });
      expect(bad.body.issues[0]).toMatchObject({ path: ['archiveIds'] });
    });
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm --prefix server run test -- src/workspace/user-settings.dropped-entries.test.ts`

Expected: FAIL, `does not provide an export named 'listDroppedEndpointEntries'`.

- [ ] **Step 3: Implement**

`server/src/workspace/user-settings.ts`:

1. Imports. Add `readFileSync` to the existing top `node:fs` import (`:14` on `46e62a34` is
   `import { existsSync, statSync } from 'node:fs';` — `readFileSync` is **not** already there, unlike
   an earlier draft of this task assumed; item 9 of the review). Add `randomUUID, createHash` from
   `node:crypto` (new import).

2. Extend `DroppedEndpointEntry` (Task 3b.6) with two fields after `raw: unknown;`:
```ts
  /** #3084 F5 — "path: code" strings, one per zodIssues() entry (or a synthetic
      code for the two non-zod refusals). Never a value: exposed to the client
      via listDroppedEndpointEntries, where `issues` (path: message) is not. */
  codes: string[];
  /** #3084 F5 review, item 2 — sha256 of a canonical (sorted-key) JSON encoding
      of the value that is SAFE to hash: `entry` for an endpoint-list or
      whole-field drop, but for a KEY entry `{ id: endpointId, ...keyEntryOriginOnly(entry) }`
      — the origin-only projection plus the endpoint id, NEVER the raw entry,
      because the raw entry holds the key. Never `droppedAt`/`id` for the
      other two cases either, so the hash depends only on what makes the entry
      invalid. Drives durable de-duplication and durable "Got it" — never
      leaves the server, never appears in DroppedEndpointEntrySummary, and (by
      construction, for a key entry) is never computed over key material. */
  contentHash: string;
```

3. Add beside `zodIssues`:
```ts
function zodIssueCodes(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(entry)'}: ${i.code}`);
}

/** #3084 F5 review — stable regardless of key insertion order, so re-parsing
    the same bad entry on a later read (same process or after a restart)
    always hashes identically. */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function droppedEntryContentHash(entry: unknown): string {
  return createHash('sha256').update(canonicalStringify(entry)).digest('hex');
}
```

4. In `dropInvalidEndpointEntries`, add a `codes` **and** `contentHash` entry to each of the three
   `dropped.push(…)` calls. **Review pass 2, item 2 — no key material on disk, in any form, including
   hashed:** for the endpoint-list and whole-field cases, `contentHash` is `droppedEntryContentHash(entry)`
   (the raw dropped value — never a secret). For the **key-entry** case specifically, it is
   `droppedEntryContentHash({ id: endpointId, ...keyEntryOriginOnly(entry) })` — the origin-only
   projection this file already archives (`keyEntryOriginOnly`, Task 3b.6) plus the endpoint id,
   **never the raw `entry`**, because the raw value holds the key. This accepts a real trade,
   stated so it isn't rediscovered as a bug later: a key entry that stays malformed under the SAME
   origin, with a DIFFERENT (still-invalid) key value, hashes identically and so stays acknowledged —
   an earlier draft of this task claimed the opposite ("a changed key value still counts as a
   genuinely different entry"), which is false once the hash cannot see the key at all, and is also
   the wrong thing to want: hashing the raw key would put key-derived material in a plain file
   (the archive), for exactly the entries this mechanism exists to protect.
   - whole-list-invalid: `codes: ['analyzerEndpoints: invalid_type']`
   - per-entry: `codes: parsed.success ? ['id: duplicate_id'] : zodIssueCodes(parsed.error)`
   - whole-map-invalid: `codes: ['analyzerEndpointKeys: invalid_type']`
   - key-entry: `codes: zodIssueCodes(parsed.error)`

5. In `archiveDroppedEndpointEntries`, also skip a hash the ON-DISK archive already has (durable
   de-dupe, item 5 — the existing in-memory `archivedDrops` Set only survives one process), and the
   serialised line gains `archiveId` and `codes`. No `acknowledgedAt`: acknowledgement lives only in
   the sidecar file, never on the archive record.
```ts
function readExistingArchiveHashes(archive: string): Set<string> {
  try {
    return new Set(
      readFileSync(archive, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return (JSON.parse(l) as { contentHash?: unknown }).contentHash;
          } catch {
            return undefined;
          }
        })
        .filter((h): h is string => typeof h === 'string'),
    );
  } catch {
    return new Set();
  }
}
```
Change the `fresh` filter to also exclude an already-archived hash:
```ts
  const onDisk = readExistingArchiveHashes(archive);
  const fresh = dropped.filter((d) => !archivedDrops.has(archiveKey(d)) && !onDisk.has(d.contentHash));
```
and the serialised-line builder:
```ts
  const lines = fresh.map((d) =>
    `${JSON.stringify({
      archiveId: randomUUID(),
      droppedAt: d.droppedAt,
      field: d.field,
      position: d.position,
      id: d.id,
      issues: d.issues,
      codes: d.codes,
      contentHash: d.contentHash,
      entry: d.entry,
    })}\n`,
  );
```

6. After `invalidEndpointsArchivePath`:
```ts
export interface DroppedEndpointEntrySummary {
  archiveId: string | null;
  kind: 'endpoint' | 'key';
  endpointId?: string;
  name?: string;
  origin?: string;
  issues: string[]; // path: code — never a value
  droppedAt: string;
}

const DROPPED_ENTRY_NAME_MAX = 80; // #3084 F5 review, item 10 — a raw entry never went through
                                    // analyzerEndpointSchema's own .max(80), so cap it here.

/** Beside the settings file, like the archive itself. A tiny JSON array of
    acknowledged CONTENT HASHES (item 5 — never archiveIds: an archiveId is
    minted fresh on every append, including a restart's re-drop of the same
    unchanged entry, so an ack keyed on archiveId would stop applying the
    moment the process restarts). This sidecar is what acknowledgement
    actually mutates; the archive file itself stays append-only (P25). */
export function droppedEndpointEntriesAcknowledgedPath(): string {
  return join(dirname(USER_SETTINGS_PATH), 'user-settings.invalid-endpoints.acknowledged.json');
}

function readAcknowledgedHashes(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(droppedEndpointEntriesAcknowledgedPath(), 'utf8'));
    return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Parses one archive line; returns its contentHash alongside the built
    summary (or null for a line this function itself rejects),
    so callers with different jobs (list vs. resolve-archiveId-to-hash) each
    read the hash without re-deriving it. */
function parseArchiveLine(line: string): { summary: DroppedEndpointEntrySummary; contentHash: string | undefined } | null {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof rec.archiveId !== 'string') return null; // a pre-F5 line, from before this task shipped
  const kind: 'endpoint' | 'key' = rec.field === 'analyzerEndpoints' ? 'endpoint' : 'key';
  const entry = rec.entry as Record<string, unknown> | undefined;
  const rawName = kind === 'endpoint' && entry && typeof entry.name === 'string' ? entry.name : undefined;
  return {
    summary: {
      archiveId: rec.archiveId,
      kind,
      endpointId: kind === 'endpoint' ? (typeof rec.id === 'string' ? rec.id : undefined) : (typeof rec.position === 'string' ? rec.position : undefined),
      name: rawName?.slice(0, DROPPED_ENTRY_NAME_MAX),
      origin: kind === 'key' && entry && typeof entry.origin === 'string' ? entry.origin : undefined,
      issues: Array.isArray(rec.codes) ? (rec.codes as string[]) : [],
      droppedAt: typeof rec.droppedAt === 'string' ? rec.droppedAt : new Date(0).toISOString(),
    },
    contentHash: typeof rec.contentHash === 'string' ? rec.contentHash : undefined,
  };
}

function summarisePending(d: DroppedEndpointEntry): DroppedEndpointEntrySummary {
  const kind: 'endpoint' | 'key' = d.field === 'analyzerEndpoints' ? 'endpoint' : 'key';
  const entry = d.entry as Record<string, unknown> | undefined;
  const rawName = kind === 'endpoint' && entry && typeof entry.name === 'string' ? entry.name : undefined;
  return {
    archiveId: null,
    kind,
    endpointId: kind === 'endpoint' ? (typeof d.id === 'string' ? d.id : undefined) : (typeof d.position === 'string' ? d.position : undefined),
    name: rawName?.slice(0, DROPPED_ENTRY_NAME_MAX),
    origin: kind === 'key' && entry && typeof entry.origin === 'string' ? entry.origin : undefined,
    issues: d.codes,
    droppedAt: d.droppedAt,
  };
}

/** #3084 F5 — every unacknowledged drop: archived (from the append-only archive
    file, minus anything whose contentHash is in the acknowledged sidecar)
    plus whatever is still pending an archive append (unarchivedDrops, Task
    3b.6, listed with archiveId: null — the user must still be told even
    though the append hasn't landed; also filtered against the acknowledged
    set, for the edge case of a retried entry whose earlier attempt was
    already acknowledged). Synchronous: both files are small, and envDerived
    (sync, shared by every endpoint-CRUD 200 response) needs this too. */
function listDroppedEndpointEntriesSync(): DroppedEndpointEntrySummary[] {
  const acknowledged = readAcknowledgedHashes();
  let archived: DroppedEndpointEntrySummary[] = [];
  try {
    archived = readFileSync(invalidEndpointsArchivePath(), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map(parseArchiveLine)
      .filter((p): p is NonNullable<typeof p> => p !== null && !(p.contentHash && acknowledged.has(p.contentHash)))
      .map((p) => p.summary);
  } catch {
    archived = [];
  }
  const pending = unarchivedDrops.filter((d) => !acknowledged.has(d.contentHash)).map(summarisePending);
  return [...archived, ...pending];
}

export async function listDroppedEndpointEntries(): Promise<DroppedEndpointEntrySummary[]> {
  return listDroppedEndpointEntriesSync();
}

/** #3084 F5 review, item 6 — serialised through `writeChain` (the same chain
    every settings writer and mutateUserSettings use), so two concurrent
    acknowledge calls (a double click) read-modify-write the sidecar one at a
    time instead of racing a lost update. */
function readAndUnionAcknowledgedHashes(hashes: Iterable<string>): Promise<void> {
  const next = writeChain.then(async () => {
    const current = readAcknowledgedHashes();
    for (const h of hashes) current.add(h);
    await writeJsonAtomic(droppedEndpointEntriesAcknowledgedPath(), [...current]);
  });
  writeChain = next.catch(() => undefined);
  return next;
}

/** #3084 F5 — an archiveId not currently on disk (already acknowledged, still
    pending an archive append and so never had one, or simply unknown) is
    ignored rather than refused: an ack racing a retry or a duplicate click is
    not an error. Resolves each archiveId to its contentHash (item 5 — the
    sidecar stores hashes, never archiveIds) by re-reading the archive once. */
export async function acknowledgeDroppedEndpointEntries(archiveIds: string[]): Promise<void> {
  if (archiveIds.length === 0) return;
  const wanted = new Set(archiveIds);
  const hashesToAck = new Set<string>();
  try {
    for (const line of readFileSync(invalidEndpointsArchivePath(), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseArchiveLine(line);
      if (parsed && wanted.has(parsed.summary.archiveId as string) && parsed.contentHash) {
        hashesToAck.add(parsed.contentHash);
      }
    }
  } catch {
    return; // no archive file yet — nothing to acknowledge
  }
  if (hashesToAck.size === 0) return;
  await readAndUnionAcknowledgedHashes(hashesToAck);
}
```
7. `FORBIDDEN_KEYS` (`:643` on `46e62a34`, Task 3b.6's edit — **this file, not `routes/user-settings.ts`**,
   item 9 of the review) gains `'droppedEndpointEntries'` in the same block as `'analyzerEndpoints'`.

Export `listDroppedEndpointEntriesSync` alongside the async wrapper — `routes/user-settings.ts`'s
`envDerived` needs the sync form.

`server/src/routes/user-settings.ts`:
1. Import `listDroppedEndpointEntriesSync, acknowledgeDroppedEndpointEntries, type DroppedEndpointEntrySummary` from `../workspace/user-settings.js`.
2. `UserSettingsResponse` (Task 3b.6's replacement block) gains:
```ts
  /* #3084 F5 — every unacknowledged drop from Task 3b.6's read-time safety net.
     Read-only; POST /dropped-endpoint-entries/acknowledge is the only writer. */
  droppedEndpointEntries: DroppedEndpointEntrySummary[];
```
3. `envDerived`'s returned object gains `droppedEndpointEntries: listDroppedEndpointEntriesSync(),`.
   (`FORBIDDEN_KEYS` is NOT edited here — item 9: it lives entirely in `workspace/user-settings.ts`,
   step 1 above.)
4. After the GET handler, add:
```ts
const acknowledgeSchema = z.object({ archiveIds: z.array(z.string()) });

userSettingsRouter.post('/dropped-endpoint-entries/acknowledge', async (req: Request, res: Response) => {
  const parsed = acknowledgeSchema.safeParse(req.body);
  if (!parsed.success) {
    /* Same shape and code as every other malformed-body 400 in this file
       (Task 3b.7's key-payload refusal, AnalyzerEndpointRefusal's 'invalid'). */
    return res.status(400).json({
      error: 'Invalid payload.',
      code: 'invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  await acknowledgeDroppedEndpointEntries(parsed.data.archiveIds);
  res.json(envDerived(await readUserSettings()));
});
```
(`z`, `readUserSettings` and `envDerived` are already in scope in this file.)

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/workspace/user-settings.dropped-entries.test.ts src/workspace/user-settings.endpoints.test.ts src/routes/user-settings.test.ts
npm run typecheck
npm run openapi:types
```
Expected: PASS; `openapi:types` leaves no diff once the schema edits below land.

`openapi.yaml` — `UserSettings.properties`, after `analyzerEndpointKeyStatus`:
```yaml
        droppedEndpointEntries:
          type: array
          readOnly: true
          items: { $ref: '#/components/schemas/DroppedEndpointEntrySummary' }
          description: |
            #3084 F5 — every unacknowledged analyzer-endpoint entry dropped at
            read time (Task 3b.6). Never a key or field value.
```
New schema, after `AnalyzerEndpointDetectResult`:
```yaml
    DroppedEndpointEntrySummary:
      type: object
      required: [kind, issues, droppedAt]
      properties:
        archiveId: { type: string, nullable: true, description: 'null while the archive append is still pending.' }
        kind: { type: string, enum: [endpoint, key] }
        endpointId: { type: string }
        name: { type: string }
        origin: { type: string }
        issues: { type: array, items: { type: string }, description: '"path: code" strings, never a value.' }
        droppedAt: { type: string, format: date-time }
```
New path, after the `/api/analyzer/endpoints/{endpointId}/key` block:
```yaml
  /api/user/settings/dropped-endpoint-entries/acknowledge:
    post:
      summary: Acknowledge dropped analyzer endpoint entries
      operationId: acknowledgeDroppedEndpointEntries
      description: |
        #3084 F5 — marks each named archiveId acknowledged; it stops appearing
        in droppedEndpointEntries. An unknown or already-acknowledged id is
        ignored, not refused.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [archiveIds]
              properties:
                archiveIds: { type: array, items: { type: string } }
      responses:
        '200':
          description: Updated settings
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UserSettings' }
        '400':
          description: Malformed body (archiveIds is not an array of strings)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerEndpointRefusal' }
```

`src/lib/api.ts`:
1. `MOCK_USER_SETTINGS` gains `droppedEndpointEntries: [],`.
2. After the mock endpoint functions (Task 3b.9), add:
```ts
/* #3084 F5 review, item 7 — mockEndpointFromInput refuses at save time (matching
   the server), so the mock CRUD functions never populate
   MOCK_USER_SETTINGS.droppedEndpointEntries themselves. PR 3d's own tests seed
   it directly (its mock-mode UI tests need a dropped entry to show the banner
   against), so this must actually filter, not no-op, or 3d's "Got it" test
   would pass for the wrong reason (nothing to hide in the first place). */
async function mockAcknowledgeDroppedEndpointEntries(archiveIds: string[]): Promise<UserSettings> {
  await wait(50);
  const acked = new Set(archiveIds);
  MOCK_USER_SETTINGS.droppedEndpointEntries = (MOCK_USER_SETTINGS.droppedEndpointEntries ?? []).filter(
    (e) => !acked.has(e.archiveId ?? ''),
  );
  return mockSettingsWithEndpoints(mockEndpoints());
}
async function realAcknowledgeDroppedEndpointEntries(archiveIds: string[]): Promise<UserSettings> {
  return analyzerEndpointRequest('/api/user/settings/dropped-endpoint-entries/acknowledge', {
    method: 'POST',
    body: JSON.stringify({ archiveIds }),
  });
}
```
3. Add `acknowledgeDroppedEndpointEntries: realAcknowledgeDroppedEndpointEntries` / `: mockAcknowledgeDroppedEndpointEntries` to the `real` / `mock` objects.
4. Test: `src/lib/api-analyzer-endpoints-mock.test.ts` (Task 3b.9) gains:
```ts
it('mock acknowledgeDroppedEndpointEntries removes only the named entries (#3084 F5 review, item 7)', async () => {
  _setMockUserSettingsForTest({
    droppedEndpointEntries: [
      { archiveId: 'ack-1', kind: 'endpoint', endpointId: 'a', issues: ['baseUrl: invalid_format'], droppedAt: new Date().toISOString() },
      { archiveId: 'ack-2', kind: 'endpoint', endpointId: 'b', issues: ['baseUrl: invalid_format'], droppedAt: new Date().toISOString() },
    ] as never,
  });
  const s = await api.acknowledgeDroppedEndpointEntries(['ack-1']);
  expect(s.droppedEndpointEntries?.map((e) => e.archiveId)).toEqual(['ack-2']);
});
```

- [ ] **Step 5: Mutation proofs**

| Revert | Expected red test |
|---|---|
| `parseArchiveLine`: use `rec.issues` instead of `rec.codes` for the summary's `issues` | `lists a dropped endpoint entry with a code, not a message…` (the message text, including `'not a url'`, appears) |
| Delete the `acknowledged.has(p.contentHash)` filter in `listDroppedEndpointEntriesSync` | `acknowledging an archiveId hides it, and it stays hidden across a simulated restart…` (still listed after ack) |
| `readAndUnionAcknowledgedHashes`: skip reading the existing set first (`current = new Set()`) | `acknowledging twice keeps the first acknowledgement (union, not replace)` (the first entry reappears) |
| `archiveDroppedEndpointEntries`: drop `archiveId: randomUUID()` from the serialised line | `lists a dropped endpoint entry…` (`typeof entry.archiveId).toBe('string')` fails — `parseArchiveLine` returns null) |
| `archiveDroppedEndpointEntries`: drop the `!onDisk.has(d.contentHash)` half of the `fresh` filter | `acknowledging an archiveId hides it, and it stays hidden across a simulated restart…` (`archiveLinesAfter` grows — a duplicate line for the unchanged entry, and the acknowledgement on the OLD archiveId no longer covers the NEW one, so the entry reappears) |
| `dropInvalidEndpointEntries`: hash `{ id: d.id, ...entry }` instead of the raw `entry` (id folded into the hash) | `a MODIFIED bad entry (different content, same id) is listed again…` still passes by coincidence; add `it('two entries with different ids but byte-identical content hash the same')` if this distinction ever matters — flagged as a gap, not a currently-failing case |
| `acknowledgeDroppedEndpointEntries`: resolve archiveId → hash by re-deriving a fresh hash from the archived `entry` (`droppedEntryContentHash(rec.entry)`) instead of reading the archived `contentHash` off disk | `a dropped key entry's archive line and the acknowledged-hashes sidecar hold no substring of the key…` (review pass 2, item 4 — for an ENDPOINT row this re-derivation happens to match, since `contentHash` already IS `droppedEntryContentHash(entry)` there; only a KEY row's hash is `{id, ...keyEntryOriginOnly(entry)}`, so re-deriving from the raw `entry` alone produces a DIFFERENT hash, the key row never gets acknowledged, and `listDroppedEndpointEntries()` is not `[]` at the end) |
| In `dropInvalidEndpointEntries`'s key-entry `dropped.push(…)`, hash the raw `entry` (`droppedEntryContentHash(entry)`) instead of `droppedEntryContentHash({ id: endpointId, ...keyEntryOriginOnly(entry) })` | `a dropped key entry's archive line and the acknowledged-hashes sidecar hold no substring of the key…` (the `wrongHash` computed the SAME way in the test now matches what's on disk — the assertions that it is absent fail) |
| `readAndUnionAcknowledgedHashes`: write directly with `writeJsonAtomic` instead of chaining onto `writeChain` | `two concurrent acknowledge calls do not lose either one (serialised through writeChain, review item 6)` (flaky: one call's read-modify-write can be clobbered by the other's) |
| `envDerived`: delete `droppedEndpointEntries: listDroppedEndpointEntriesSync()` | `GET /api/user/settings exposes droppedEndpointEntries…` |
| `summarisePending`: `archiveId: 'placeholder'` instead of `null` | `an unarchived pending entry is listed with archiveId null` |
| Key-entry `codes` push → reuse the endpoint entry's `zodIssueCodes(...)` unconditionally instead of the key schema's | `lists a dropped key entry with the origin only, never the key, and asserts its issues` (`['origin: invalid_type']` becomes a different path) |
| `parseArchiveLine` / `summarisePending`: drop the `.slice(0, DROPPED_ENTRY_NAME_MAX)` | `a name over 80 characters is capped in the summary (review item 10)` |

**Dropped, not fixed (review item 8, first sub-item).** An earlier draft had a row "remove
`'droppedEndpointEntries'` from `FORBIDDEN_KEYS` → the general-PUT test goes red." It does not:
`droppedEndpointEntries` is never added to `userSettingsSchema`'s shape (it is response-only, built by
`envDerived`), so `writeUserSettings`'s `patchSchema.parse(sanitised)` (`userSettingsSchema.partial()`)
silently strips it as an unrecognized key regardless of `FORBIDDEN_KEYS` membership — same as
`corruptSettingsFile`, which is in `FORBIDDEN_KEYS` for the same defensive-only reason and is
likewise unreachable via that mechanism today. The `FORBIDDEN_KEYS` entry stays (matching that
precedent), but no mutation row claims it is what a test observes.

- [ ] **Step 6: Commit**
```bash
git add server/src/workspace/user-settings.ts server/src/routes/user-settings.ts server/src/workspace/user-settings.dropped-entries.test.ts openapi.yaml src/lib/api-types.ts src/lib/api.ts
git commit -m "feat(server,frontend): surface dropped analyzer endpoint entries and an acknowledge route (#3084 F5)"
```

---

### Task 3b.6a: Construction-time redaction in the Ollama and Gemini transports (P22)

P22 redacts known secrets where errors are built in **all three** transports. Task 3b.11 does it for the OpenAI transport. This task does it for the Ollama and Gemini paths, at every place they build or rethrow error text from an upstream body: Ollama's non-OK body, Ollama's in-stream `parsed.error` echo, the Ollama persona call's non-OK body (A8), and Gemini's rethrown error. With no secret in the text, every message, snapshot and taxonomy outcome is byte-identical, and a Gemini error with no secret is rethrown as the same object.

**Files:**
- Modify: `server/src/analyzer/transports/ollama-transport.ts` (W1 Task 1.8) — in `OllamaTransport.send`, the `if (!response.ok) { … throw new AnalyzerHttpError(…) }` block W1 Task 1.4 wrote; the in-stream `if (parsed.error) { throw new Error(`…stream error: …`) }` branch W1 moved from `ollama.ts:792-794` (locate it by the `stream error:` text, since W1's line numbers differ); and the imports.
- Modify: `server/src/analyzer/ollama.ts` — the persona call's non-OK body: `generatePersonaViaOllama`'s `if (!response.ok) { … }` (main `:1019-1022`). **Its home at PR 3b is still `ollama.ts`**: W1 leaves `generatePersonaViaOllama` unchanged (w1 "Must NOT change"), and wave 4, which comes after this PR, moves the body into `OllamaTransport.sendFreeText`. Wave 4 must carry this redaction with the move. Locate the function by name. Also the imports.
- Modify: `server/src/analyzer/transports/gemini-transport.ts` (W1 Task 1.9) — in `GeminiTransport.generate`'s `catch`, the tail that calls `logGenerateFailed(this.model, err, req);` and then rethrows `err`; a new `redactGeminiError` function; and the imports.
- Create: `server/src/analyzer/transport-redaction.test.ts`.

**Interfaces:**
- Consumes: `redactKnownSecrets` (Task 3b.1); `loadKnownAnalyzerSecrets` **from the leaf `server/src/analyzer/known-secrets-gate.ts`** (Task 3b.1's gate; its `load` provider is Task 3b.6's), never from `user-settings.ts` (A9); `AnalyzerHttpError` (W1); `ApiError` (`@google/genai`); `generatePersonaViaOllama` (`ollama.ts`).
- Produces: nothing exported.

**Import-cycle baseline (A9).** Before Step 1, run `npm run check:cycles` and record the count `N` it prints (`check-import-cycles: OK — N circular dependencies found, all allowlisted …`). Step 4 expects the same `N`.

**Tests kept green:**
- `server/src/analyzer/ollama-http-failure-taxonomy.test.ts` — wave 1's 404 / 500 / 503 snapshots and its exact `bodyExcerpt` / message assertions (no secret in those bodies).
- `server/src/analyzer/ollama.test.ts`
- slow `server/src/analyzer/gemini.test.ts`
- `server/src/routes/failure-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/transport-redaction.test.ts`:
```ts
/* #3084 P22 — construction-time redaction in the Ollama and Gemini transports. A body
   that echoes a saved analyzer secret never reaches the thrown error, its stack,
   inspect(), the classified failure, or a log line. The Ollama case is a REAL
   http.createServer; the Gemini case uses GeminiTransport's injectable `client`
   (W1 Task 1.9) rejecting with the SDK's own ApiError. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, type GoogleGenAI } from '@google/genai';
import { OllamaAnalyzer, generatePersonaViaOllama } from './ollama.js';
import { GeminiTransport } from './transports/gemini-transport.js';
import { AnalyzerHttpError } from './errors.js';
import { classifyAnalysisFailure } from '../routes/failure-taxonomy.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import type { TransportRequest } from './runner/transport.js';

const SECRET = 'AIzaSy-transport-echo-secret-1';
const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');
const ID = 'm_transport_redaction';
const savedEnvKey = process.env.GEMINI_API_KEY;
let server: Server | undefined;
let lines: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  _setUserSettingsCacheForTest({ geminiApiKey: SECRET });
  lines = [];
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
    }),
  );
});

afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  _resetUserSettingsCache();
  if (savedEnvKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedEnvKey;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

afterAll(async () => {
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

const surfaces = (err: unknown): string[] => [(err as Error).message, (err as Error).stack ?? '', inspect(err, { depth: 8 })];

const geminiRequest: TransportRequest = {
  system: 's',
  messages: [{ role: 'user', content: 'u' }],
  structuredOutput: { mode: 'json' },
  temperature: 0.2,
  estimatedInputTokens: 10,
  call: {},
};

const rejectingClient = (err: unknown) =>
  ({ models: { generateContentStream: () => Promise.reject(err) } }) as unknown as GoogleGenAI;

describe('Ollama transport redaction (#3084 P22)', () => {
  it('a 500 body echoing a saved secret never reaches the error, its stack, inspect(), the classified failure or a log line', async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `runner failed for key ${SECRET}` }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const err = await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect((err as AnalyzerHttpError).bodyExcerpt).toBe('{"error":"runner failed for key [redacted]"}');
    const classified = classifyAnalysisFailure(err, 'Ollama (qwen3.5:4b)');
    for (const s of [...surfaces(err), classified.userMessage, classified.detail ?? '', ...lines]) {
      expect(s).not.toContain(SECRET);
    }
  });

  it('an in-stream error line echoing a saved secret never reaches the error, its stack, inspect(), the classified failure or a log line (A8)', async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(`${JSON.stringify({ error: `model runner crashed for key ${SECRET}` })}\n`);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const err = await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`Ollama ${url} stream error: model runner crashed for key [redacted]`);
    const classified = classifyAnalysisFailure(err, 'Ollama (qwen3.5:4b)');
    for (const s of [...surfaces(err), classified.userMessage, classified.detail ?? '', ...lines]) {
      expect(s).not.toContain(SECRET);
    }
  });
});

describe('Ollama persona call redaction (#3084 P22, A8)', () => {
  it('a non-OK persona body echoing a saved secret never reaches the error, its stack, inspect() or a log line', async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `persona runner failed for key ${SECRET}` }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    /* generatePersonaViaOllama reads its URL from settings (getResolvedOllamaUrl). */
    _setUserSettingsCacheForTest({ geminiApiKey: SECRET, ollamaUrl: url });
    const err = await generatePersonaViaOllama('Describe the voice.', 'qwen3.5:4b').then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(
      `Ollama ${url} returned 500 Internal Server Error: {"error":"persona runner failed for key [redacted]"}`,
    );
    for (const s of [...surfaces(err), ...lines]) {
      expect(s).not.toContain(SECRET);
    }
  });
});

describe('Gemini transport redaction (#3084 P22)', () => {
  it('an ApiError whose body echoes a saved secret is rebuilt redacted: still an ApiError with its status, and the [gemini] generate failed line carries no secret', async () => {
    const upstream = new ApiError({
      status: 400,
      message: `got status: 400 Bad Request. {"error":{"code":400,"message":"API key ${SECRET} not valid","status":"INVALID_ARGUMENT"}}`,
    });
    const err = await new GeminiTransport({ apiKey: 'unused-by-a-stub-client', model: 'gemini-3.5-flash-lite', client: rejectingClient(upstream) })
      .send(geminiRequest)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as Error).message).toContain('API key [redacted] not valid');
    /* A line the code under test wrote: logGenerateFailed (W1 Task 1.9). */
    expect(lines.some((l) => l.startsWith('[gemini] generate failed'))).toBe(true);
    const classified = classifyAnalysisFailure(err, 'Gemini');
    expect(classified.code).toBe('analyzer-request-rejected');
    for (const s of [...surfaces(err), classified.userMessage, classified.detail ?? '', ...lines]) {
      expect(s).not.toContain(SECRET);
    }
  });

  it('an error with no secret in it is rethrown as the same object, so every existing outcome is unchanged', async () => {
    const upstream = new ApiError({
      status: 400,
      message: 'got status: 400 Bad Request. {"error":{"code":400,"message":"no secret here","status":"INVALID_ARGUMENT"}}',
    });
    const err = await new GeminiTransport({ apiKey: 'unused-by-a-stub-client', model: 'gemini-3.5-flash-lite', client: rejectingClient(upstream) })
      .send(geminiRequest)
      .then(() => null, (e: unknown) => e);
    expect(err).toBe(upstream);
  });
});
```
If W1's or wave 2b's `generate` calls any client method other than `models.generateContentStream` before streaming, add that method to `rejectingClient`'s object, resolving to what `generate` expects. Do not replace the stub with a module mock.

- [ ] **Step 2: Run and confirm failure**

Run: `npm --prefix server run test -- src/analyzer/transport-redaction.test.ts --retry=0`

Expected:
- `a 500 body echoing a saved secret…` FAILS: `bodyExcerpt` holds the secret.
- `an in-stream error line echoing a saved secret…` FAILS: the message holds the secret.
- `a non-OK persona body echoing a saved secret…` FAILS: received `…persona runner failed for key AIzaSy-transport-echo-secret-1"}`.
- `an ApiError whose body echoes a saved secret…` FAILS: the message holds the secret.
- `an error with no secret in it…` PASSES already; it pins that the rebuild leaves unaffected errors alone.

- [ ] **Step 3: Implement**

`server/src/analyzer/transports/ollama-transport.ts`:
1. Imports — add:
   ```ts
   import { redactKnownSecrets } from '../redact.js';
   /* #3084 A9 — through the leaf gate: no import edge to workspace/user-settings.ts. */
   import { loadKnownAnalyzerSecrets } from '../known-secrets-gate.js';
   ```
2. In `OllamaTransport.send`, replace the `if (!response.ok) { … }` block with:
   ```ts
      if (!response.ok) {
        /* Reachable but errored — hard-fail. Surface the body so the operator can
           diagnose ("model not found", "invalid format", …), with every known
           analyzer secret removed where the error is built (#3084 P22). Redacted
           BEFORE truncating, so a secret the slice would cut in half cannot
           survive. With no secret in the body the text is byte-identical. */
        const text = await response.text().catch(() => '');
        const bodyExcerpt = redactKnownSecrets(text, await loadKnownAnalyzerSecrets()).slice(0, 500);
        throw new AnalyzerHttpError(
          'ollama',
          response.status,
          bodyExcerpt,
          `Ollama ${this.url} returned ${response.status} ${response.statusText}: ${bodyExcerpt}`,
        );
      }
   ```
3. In `OllamaTransport.send`'s stream loop, replace the in-stream error branch W1 moved from `ollama.ts:792-794`:
   ```ts
            if (parsed.error) {
              throw new Error(`Ollama ${this.url} stream error: ${parsed.error}`);
            }
   ```
   with:
   ```ts
            if (parsed.error) {
              /* #3084 P22, A8 — the daemon's in-stream error can echo request text; every
                 known analyzer secret is removed where the error is built. With no secret
                 the message is byte-identical. */
              const streamError = redactKnownSecrets(String(parsed.error), await loadKnownAnalyzerSecrets());
              throw new Error(`Ollama ${this.url} stream error: ${streamError}`);
            }
   ```
   If W1 changed that branch's error class, keep W1's class and change only the embedded value.

`server/src/analyzer/ollama.ts` (the persona call, still here at PR 3b):
1. Imports — add:
   ```ts
   import { redactKnownSecrets } from './redact.js';
   /* #3084 A9 — through the leaf gate. */
   import { loadKnownAnalyzerSecrets } from './known-secrets-gate.js';
   ```
2. In `generatePersonaViaOllama`, replace
   ```ts
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Ollama ${url} returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
   ```
   with:
   ```ts
    if (!response.ok) {
      /* #3084 P22, A8 — redacted where the error is built, BEFORE truncating, so a secret
         the slice would cut in half cannot survive. With no secret the text is
         byte-identical. Wave 4 moves this body into OllamaTransport.sendFreeText and
         keeps these lines. */
      const text = await response.text().catch(() => '');
      const excerpt = redactKnownSecrets(text, await loadKnownAnalyzerSecrets()).slice(0, 500);
      throw new Error(`Ollama ${url} returned ${response.status} ${response.statusText}: ${excerpt}`);
    }
   ```

`server/src/analyzer/transports/gemini-transport.ts`:
1. Imports — add `ApiError` to the existing `@google/genai` import, and:
   ```ts
   import { redactKnownSecrets } from '../redact.js';
   /* #3084 A9 — through the leaf gate. */
   import { loadKnownAnalyzerSecrets } from '../known-secrets-gate.js';
   ```
2. Above `logGenerateFailed`, add:
   ```ts
   /* #3084 P22 — the SDK's ApiError keeps the upstream body in `.message`, and so in
      `.stack`. An error whose message holds a known secret is rebuilt with it removed:
      an ApiError stays an ApiError with its status, so the taxonomy's envelope parse and
      the retry classifier read it exactly as before. An error with no secret is returned
      as the same object. */
   function redactGeminiError(err: unknown, secrets: readonly string[]): unknown {
     if (!(err instanceof Error)) return err;
     const message = redactKnownSecrets(err.message, secrets);
     if (message === err.message) return err;
     if (err instanceof ApiError) return new ApiError({ status: err.status, message });
     const rebuilt = new Error(message);
     rebuilt.name = err.name;
     return rebuilt;
   }
   ```
3. In `generate`'s `catch`, replace the tail
   ```ts
        logGenerateFailed(this.model, err, req);
        throw err;
   ```
   with
   ```ts
        /* #3084 P22 — redacted before it is logged or rethrown. */
        const safe = redactGeminiError(err, await loadKnownAnalyzerSecrets());
        logGenerateFailed(this.model, safe, req);
        throw safe;
   ```
   The abort, idle and truncation branches above it are unchanged; they build their own messages from the model name.

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/analyzer/transport-redaction.test.ts src/analyzer/ollama-http-failure-taxonomy.test.ts src/analyzer/ollama.test.ts src/routes/failure-taxonomy.test.ts --retry=0
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
npm run typecheck
npm run check:cycles
```
Expected: PASS. `ollama-http-failure-taxonomy.test.ts`'s snapshots are unmoved. `check:cycles` prints the `OK` line with the same count `N` recorded before Step 1 (A9): `ollama-transport.ts`, `gemini-transport.ts` and `ollama.ts` read known secrets through the leaf `known-secrets-gate.ts`, so no import edge to `user-settings.ts` is added. Any other count fails this task: route the new edge through the gate, never allowlist it.

- [ ] **Step 5: Mutation proofs**

| Revert | Expected red test |
|---|---|
| Ollama: `const bodyExcerpt = text.slice(0, 500);` (wave 1's line) | `a 500 body echoing a saved secret never reaches…` |
| Gemini: `logGenerateFailed(this.model, err, req); throw err;` (the raw error) | `an ApiError whose body echoes a saved secret is rebuilt redacted…` |
| `redactGeminiError`: delete the `if (message === err.message) return err;` line | `an error with no secret in it is rethrown as the same object…` |
| `redactGeminiError`: for an ApiError, `return new Error(message)` | `an ApiError whose body echoes a saved secret…` (`toBeInstanceOf(ApiError)`) |
| Ollama in-stream: `throw new Error(\`Ollama ${this.url} stream error: ${parsed.error}\`);` (W1's line, A8) | `an in-stream error line echoing a saved secret…` |
| Persona: `throw new Error(\`Ollama ${url} returned … ${text.slice(0, 500)}\`);` (main's line, A8) | `a non-OK persona body echoing a saved secret…` |
| In `known-secrets-gate.ts`, `loadKnownAnalyzerSecrets` body → `return [];` (A9) | `a 500 body echoing a saved secret…`, `an in-stream error line…`, `a non-OK persona body…` and `an ApiError whose body echoes a saved secret…` (proves all four read through the gate) |

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports/ollama-transport.ts server/src/analyzer/ollama.ts server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transport-redaction.test.ts
git commit -m "fix(server): redact known analyzer secrets where the ollama and gemini transports build errors"
```

---

### Task 3b.7: Endpoint CRUD and key routes

**Files:**
- Create: `server/src/routes/analyzer-endpoints.ts`
- Modify: `server/src/app.ts` — import next to `:82`; mount after `:252`.
- Test: `server/src/routes/analyzer-endpoints.test.ts` (new)

**Interfaces:**
- Consumes:
  - `mutateUserSettings`, `envDerived` (Task 3b.6);
  - `applyCreate`, `applyUpdate`, `applyDelete`, `applyKey`, `AnalyzerEndpointRefusal`, `EndpointState` (Task 3b.5).
- Produces:
  - `export const analyzerEndpointsRouter` mounted at `/api/analyzer/endpoints`;
  - `POST /` → 201;
  - `PUT /:endpointId`, `DELETE /:endpointId`, `PUT /:endpointId/key` → 200 with the `GET /api/user/settings` body;
  - refusals as `{ error, code, issues }` with status 400 / 404 / 409 (F5 — `issues: { path: string[]; message: string }[]`, never a field or key value).

**Tests kept green:** `server/src/routes/user-settings.test.ts`, and any app-level integration test that imports `app.ts`.

- [ ] **Step 1: Write the failing test**

`server/src/routes/analyzer-endpoints.test.ts`:
```ts
/* Integration test for the analyzer endpoint routes (#3084 PR 3b), mirroring
   routes/user-settings.test.ts: real express, real user-settings file under a
   temp workspace, supertest. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let userSettingsPath: string;
let resetCache: () => void;

const lab = { id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 32768 };

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-analyzer-endpoints-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ analyzerEndpointsRouter }, { userSettingsRouter }, settings] = await Promise.all([
    import('./analyzer-endpoints.js'),
    import('./user-settings.js'),
    import('../workspace/user-settings.js'),
  ]);
  userSettingsPath = settings.USER_SETTINGS_PATH;
  resetCache = settings._resetUserSettingsCache;
  app = express();
  app.use(express.json());
  app.use('/api/user/settings', userSettingsRouter);
  app.use('/api/analyzer/endpoints', analyzerEndpointsRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  if (userSettingsPath && existsSync(userSettingsPath)) rmSync(userSettingsPath, { force: true });
  resetCache();
});

describe('POST /api/analyzer/endpoints', () => {
  it('creates an endpoint with contract defaults and answers with the settings shape', async () => {
    const res = await request(app).post('/api/analyzer/endpoints').send(lab);
    expect(res.status).toBe(201);
    expect(res.body.analyzerEndpoints).toEqual([
      expect.objectContaining({ ...lab, gpu: 'any', concurrency: 1, requestCeilingMs: 1_800_000, structuredOutput: 'schema' }),
    ]);
    expect(res.body.analyzerEndpointKeyStatus).toEqual({ lab: 'unset' });
  });

  it('defaults gpu to none for a non-loopback host', async () => {
    const res = await request(app).post('/api/analyzer/endpoints').send({ ...lab, baseUrl: 'http://192.168.1.20:8080/v1' });
    expect(res.body.analyzerEndpoints[0].gpu).toBe('none');
  });

  it('refuses a missing context size with 400 naming contextTokens (F5: {error, issues})', async () => {
    const noContext = { id: lab.id, name: lab.name, baseUrl: lab.baseUrl };
    const res = await request(app).post('/api/analyzer/endpoints').send(noContext);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid');
    expect(res.body.issues.some((i: { path: string[] }) => i.path.join('.') === 'contextTokens')).toBe(true);
  });

  it('refuses a bad base URL with 400 and never echoes it in the response body (F5 no-echo)', async () => {
    const badUrl = 'http://[not-a-real-host/v1';
    const res = await request(app).post('/api/analyzer/endpoints').send({ ...lab, baseUrl: badUrl });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid');
    expect(JSON.stringify(res.body)).not.toContain(badUrl);
  });

  it('refuses a bad endpoint id with 400', async () => {
    const res = await request(app).post('/api/analyzer/endpoints').send({ ...lab, id: 'Lab_1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid');
  });

  it('refuses a duplicate id with 409', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    const res = await request(app).post('/api/analyzer/endpoints').send(lab);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate-id');
  });

  it('refuses an off-origin unload URL with 400', async () => {
    const res = await request(app)
      .post('/api/analyzer/endpoints')
      .send({ ...lab, unloadUrl: 'http://127.0.0.1:9999/api/models/unload/{model}' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unload-off-origin');
  });

  it('until PRs 5a/5b, refuses a non-default reasoning level and a non-empty payload, on create and update (P23)', async () => {
    const reasoning = await request(app).post('/api/analyzer/endpoints').send({ ...lab, reasoning: 'high' });
    expect(reasoning.status).toBe(400);
    expect(reasoning.body).toMatchObject({
      code: 'invalid',
      issues: [{ path: ['reasoning'], message: 'only "model-default" can be saved until PR 5a enables reasoning levels' }],
    });
    await request(app).post('/api/analyzer/endpoints').send(lab);
    const payload = await request(app).put('/api/analyzer/endpoints/lab').send({ ...lab, extraParams: { top_k: 20 } });
    expect(payload.status).toBe(400);
    expect(payload.body.issues).toEqual([
      { path: ['extraParams'], message: 'custom request parameters cannot be saved until PR 5b enables them' },
    ]);
    expect(JSON.parse(readFileSync(userSettingsPath, 'utf8')).analyzerEndpoints[0]).not.toHaveProperty('extraParams');
  });

  it('keeps both endpoints when two creates race', async () => {
    await Promise.all([
      request(app).post('/api/analyzer/endpoints').send(lab),
      request(app).post('/api/analyzer/endpoints').send({ ...lab, id: 'lab2' }),
    ]);
    const res = await request(app).get('/api/user/settings');
    expect(res.body.analyzerEndpoints.map((e: { id: string }) => e.id).sort()).toEqual(['lab', 'lab2']);
  });
});

describe('PUT /api/analyzer/endpoints/:id and the key route', () => {
  it('stores a key bound to the base URL origin, never echoes it, and marks it on a host change', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    const keyRes = await request(app).put('/api/analyzer/endpoints/lab/key').send({ key: 'sk-route-secret-1234' });
    expect(keyRes.status).toBe(200);
    expect(keyRes.body.analyzerEndpointKeyStatus).toEqual({ lab: 'set' });
    expect(JSON.stringify(keyRes.body)).not.toContain('sk-route-secret-1234');
    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    expect(onDisk.analyzerEndpointKeys.lab).toEqual({ origin: 'http://127.0.0.1:8080', key: 'sk-route-secret-1234' });

    const moved = await request(app)
      .put('/api/analyzer/endpoints/lab')
      .send({ ...lab, baseUrl: 'http://127.0.0.1:9090/v1' });
    expect(moved.status).toBe(200);
    expect(moved.body.analyzerEndpointKeyStatus).toEqual({ lab: 'origin-mismatch' });

    const cleared = await request(app).put('/api/analyzer/endpoints/lab/key').send({ key: null });
    expect(cleared.body.analyzerEndpointKeyStatus).toEqual({ lab: 'unset' });
  });

  it('404s an unknown endpoint for update and key write; 400s a changed id', async () => {
    expect((await request(app).put('/api/analyzer/endpoints/nope').send(lab)).status).toBe(404);
    expect((await request(app).put('/api/analyzer/endpoints/nope/key').send({ key: 'k' })).status).toBe(404);
    await request(app).post('/api/analyzer/endpoints').send(lab);
    expect((await request(app).put('/api/analyzer/endpoints/lab').send({ ...lab, id: 'other' })).status).toBe(400);
  });

  it('400s a key payload that is not { key: string | null }', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    expect((await request(app).put('/api/analyzer/endpoints/lab/key').send({ key: 42 })).status).toBe(400);
  });

  it('refuses a key containing a control character with 400 naming the rule, never echoing or storing it (P22)', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    const ctl = (code: number) => String.fromCharCode(code);
    for (const key of ['sk-route-crlf-1\r\nX-Injected: 1', `sk-route-nul-1${ctl(0x00)}x`, `sk-route-c1-1${ctl(0x85)}x`]) {
      const res = await request(app).put('/api/analyzer/endpoints/lab/key').send({ key });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid',
        error: 'An API key cannot contain control characters (such as a line break, tab or NUL). Paste the key again without them.',
      });
      expect(JSON.stringify(res.body)).not.toContain('sk-route-');
    }
    expect(readFileSync(userSettingsPath, 'utf8')).not.toContain('sk-route-');
  });
});

describe('redactedFailureLine (#3084 P22)', () => {
  it('logs the error name and message with known secrets removed, never its stack or cause chain', async () => {
    const { redactedFailureLine } = await import('./analyzer-endpoints.js');
    const err = Object.assign(new Error('write failed near sk-route-log-secret-1'), { cause: new Error('inner sk-route-cause-secret-1') });
    expect(redactedFailureLine('save the analyzer endpoint key', err, ['sk-route-log-secret-1'])).toBe(
      '[analyzer-endpoints] save the analyzer endpoint key failed: Error: write failed near [redacted]',
    );
  });
});

describe('DELETE /api/analyzer/endpoints/:id', () => {
  it('is refused with 409 while a saved setting references the endpoint, listing each reference', async () => {
    /* Seeded on disk, not through PUT /api/user/settings: that PUT refuses endpoint
       ids until PR 3d (P23, Task 3a.5). A file written before PR 3d, or by PR 3d
       itself, is exactly what this refusal protects. */
    writeFileSync(
      userSettingsPath,
      JSON.stringify({
        analyzerEndpoints: [{ ...lab, gpu: 'any' }],
        analyzerPhase0Model: 'openai:lab::qwen3:30b',
        configOverrides: { 'analyzer.phase1.model': 'openai:lab::m' },
      }),
    );
    resetCache();
    const res = await request(app).delete('/api/analyzer/endpoints/lab');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('referenced');
    expect(res.body.issues).toEqual([
      { path: [], message: 'Account setting "analyzerPhase0Model"' },
      { path: [], message: 'Advanced setting "analyzer.phase1.model"' },
    ]);
  });

  it('deletes the endpoint and its key once nothing references it', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    await request(app).put('/api/analyzer/endpoints/lab/key').send({ key: 'sk-route-secret-1234' });
    const res = await request(app).delete('/api/analyzer/endpoints/lab');
    expect(res.status).toBe(200);
    expect(res.body.analyzerEndpoints).toEqual([]);
    expect(readFileSync(userSettingsPath, 'utf8')).not.toContain('sk-route-secret-1234');
  });

  it('404s an unknown endpoint', async () => {
    expect((await request(app).delete('/api/analyzer/endpoints/nope')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm --prefix server run test -- src/routes/analyzer-endpoints.test.ts`

Expected: FAIL, `Failed to resolve import "./analyzer-endpoints.js"`.

- [ ] **Step 3: Implement**

`server/src/routes/analyzer-endpoints.ts`:
```ts
/* #3084 PR 3b — analyzer endpoint CRUD and the per-endpoint key write
   (Task 3b.8 adds Detect to this router).

   Every write goes through mutateUserSettings, so each refusal (duplicate id,
   still referenced, …) is decided against exactly the settings it would
   overwrite. Writes answer with the GET /api/user/settings body (envDerived),
   so the account slice swaps it in without a follow-up GET — the same contract
   as PUT /api/user/settings/gemini-key. Keys are never echoed or logged. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { z } from 'zod';
import { knownAnalyzerSecrets, mutateUserSettings, type UserSettings } from '../workspace/user-settings.js';
import { redactKnownSecrets } from '../analyzer/redact.js';
import {
  AnalyzerEndpointRefusal,
  applyCreate,
  applyDelete,
  applyKey,
  applyUpdate,
  type EndpointState,
} from '../workspace/analyzer-endpoints.js';
import { envDerived } from './user-settings.js';

export const analyzerEndpointsRouter = Router();

function stateOf(s: UserSettings): EndpointState {
  return { analyzerEndpoints: s.analyzerEndpoints, analyzerEndpointKeys: s.analyzerEndpointKeys };
}

/** Sends a refusal and returns true, or returns false for any other error.
    #3084 F5 — the body is `{ error, code, issues }`: `issues` is the decided
    save-time-validation shape ({path, message}[]), never a field or key value
    (AnalyzerEndpointRefusal.issues already carries that shape); `code` stays
    as an additional machine-readable refusal kind for existing callers. */
function sendRefusal(res: Response, err: unknown): boolean {
  if (!(err instanceof AnalyzerEndpointRefusal)) return false;
  res.status(err.status).json({ error: err.message, code: err.refusal, issues: err.issues });
  return true;
}

/** #3084 P22 — the log line for an unexpected route failure: the error's name and
    message with every known secret removed. Never the stack or the cause chain,
    which a logged Error object would print. */
export function redactedFailureLine(what: string, err: unknown, secrets: readonly string[]): string {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return redactKnownSecrets(`[analyzer-endpoints] ${what} failed: ${name}: ${message}`, secrets);
}

/* `extraSecrets`: a key this request carries that is not saved yet (the key route). */
function fail(res: Response, what: string, err: unknown, extraSecrets: readonly string[] = []): void {
  console.error(redactedFailureLine(what, err, [...extraSecrets, ...knownAnalyzerSecrets()]));
  res.status(500).json({ error: `Failed to ${what}.` });
}

analyzerEndpointsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const updated = await mutateUserSettings((current) => applyCreate(stateOf(current), req.body));
    res.status(201).json(envDerived(updated));
  } catch (err) {
    if (!sendRefusal(res, err)) fail(res, 'save the analyzer endpoint', err);
  }
});

analyzerEndpointsRouter.put('/:endpointId', async (req: Request, res: Response) => {
  try {
    const updated = await mutateUserSettings((current) =>
      applyUpdate(stateOf(current), req.params.endpointId, req.body),
    );
    res.json(envDerived(updated));
  } catch (err) {
    if (!sendRefusal(res, err)) fail(res, 'update the analyzer endpoint', err);
  }
});

analyzerEndpointsRouter.delete('/:endpointId', async (req: Request, res: Response) => {
  try {
    const updated = await mutateUserSettings((current) =>
      applyDelete(stateOf(current), current, req.params.endpointId),
    );
    res.json(envDerived(updated));
  } catch (err) {
    if (!sendRefusal(res, err)) fail(res, 'delete the analyzer endpoint', err);
  }
});

const keyPayloadSchema = z.object({ key: z.string().nullable() });

/* PUT /api/analyzer/endpoints/:endpointId/key { key: string | null }
   Stores { origin: new URL(endpoint.baseUrl).origin, key }; null clears it.
   Changing the base URL later does not move the key — its status turns
   'origin-mismatch' and it is not sent until re-entered (decision 3c). */
analyzerEndpointsRouter.put('/:endpointId/key', async (req: Request, res: Response) => {
  const parsed = keyPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    /* #3084 F5 — same shape as sendRefusal: {path, message}, never the value. */
    return res.status(400).json({
      error: 'Invalid payload.',
      code: 'invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  try {
    const updated = await mutateUserSettings((current) =>
      applyKey(stateOf(current), req.params.endpointId, parsed.data.key),
    );
    res.json(envDerived(updated));
  } catch (err) {
    if (!sendRefusal(res, err)) fail(res, 'save the analyzer endpoint key', err, parsed.data.key ? [parsed.data.key] : []);
  }
});
```

`server/src/app.ts`:
1. After `:82`, add `import { analyzerEndpointsRouter } from './routes/analyzer-endpoints.js';`.
2. After `:252`, add:
```ts
app.use('/api/analyzer/endpoints', analyzerEndpointsRouter); // #3084 — analyzer endpoint CRUD, key write, Detect
```

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/routes/analyzer-endpoints.test.ts src/routes/user-settings.test.ts
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Mutation proofs**

Revert one change at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| In the DELETE handler, pass `DEFAULT_USER_SETTINGS` instead of `current` to `applyDelete` | `is refused with 409 while a saved setting references the endpoint…` |
| Replace `envDerived(updated)` with `updated` in the key route | `stores a key bound to the base URL origin, never echoes it…` |
| In `mutateUserSettings` (Task 3b.6), move `const current = await readUserSettings();` above `writeChain.then(…)` and capture it in the closure | `keeps both endpoints when two creates race` (both creates decide against the same empty list; the second write drops `lab`) |
| Delete the `if (notYet.length > 0) { throw … }` block in `parseEndpointInput` (Task 3b.5) | `until PRs 5a/5b, refuses a non-default reasoning level and a non-empty payload, on create and update (P23)` |
| Delete the `hasControlCharacter(key)` refusal in `applyKey` (Task 3b.5) | `refuses a key containing a control character with 400 naming the rule…` |
| `redactedFailureLine` returns the unredacted string | `redactedFailureLine … logs the error name and message with known secrets removed…` |
| `redactedFailureLine` builds its line from `inspect(err)` instead of `name: message` | the same test (the stack and the `cause` secret appear) |

- [ ] **Step 6: Commit**
```bash
git add server/src/routes/analyzer-endpoints.ts server/src/routes/analyzer-endpoints.test.ts server/src/app.ts
git commit -m "feat(server): add analyzer endpoint CRUD and origin-bound key routes"
```

---

### Task 3b.8: Detect — `POST /api/analyzer/endpoints/detect-context` (+ CLAUDE.md local-machine exception)

**Files:**
- Create: `server/src/analyzer/endpoint-detect.ts`
- Modify: `server/src/routes/analyzer-endpoints.ts` — add the Detect handler **above** the `/:endpointId` handlers.
- Modify: `CLAUDE.md`, in "Conventions worth preserving" → "Mocks behind `VITE_USE_MOCKS`" (the exception-set sentence).
- Test: `server/src/analyzer/endpoint-detect.test.ts` (new)
- Test: `server/src/routes/analyzer-endpoints-detect.test.ts` (new)

**Interfaces:**
- Consumes: `keyOriginMatches` (Task 3b.5), `readUserSettings`, `ENDPOINT_ID_PATTERN` (`model-id.ts`), `Agent` and `fetch` from `undici`.
- Produces:
  - `propsUrl(baseUrl): URL` (P25);
  - `detectServedContext(input): Promise<{ ok: true; contextTokens: number; source: 'llama.cpp /props' | 'llama-swap /props' } | { ok: false; error: string; upstreamStatus?: number }>`;
  - the route: body `{ baseUrl, model?, apiKey?, endpointId?, flavor: 'llama.cpp' | 'llama-swap', allowModelLoad? }` → `200 { contextTokens, source }` / `400 { error, code }` / `502 { error, code: 'detect-failed', upstreamStatus? }`.

**Research facts applied (06-local-server-facts).**
- llama.cpp `/props` → `default_generation_settings.n_ctx` is the per-slot **served** context. `n_ctx_train` is never read.
- llama-swap `GET /props?model=<id>` **loads** the model, hence `allowModelLoad: true` is required.
- Both servers read the key from `Authorization: Bearer`.
- `/props` lives at the server root, not under `/v1`. Behind a reverse proxy that root is the base URL's path prefix, so `props` is built relative to the base URL with a trailing `/v1` removed (P25, `propsUrl`).

**Key rule (decision 3c).** A key typed in the request body is sent only to that request's `baseUrl`. A stored key (`endpointId`) is sent only when `keyOriginMatches`; on a mismatch nothing is sent, and the response is `400 { code: 'auth' }`.

**Tests kept green:** `server/src/routes/analyzer-endpoints.test.ts` (route order).

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/endpoint-detect.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { detectServedContext, propsUrl } from './endpoint-detect.js';

let server: Server | undefined;
let seen: Array<{ url: string; auth: string | undefined }> = [];

async function upstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  seen = [];
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('detectServedContext (#3084 decision 3b)', () => {
  it('reads default_generation_settings.n_ctx from the server-root /props, never n_ctx_train', async () => {
    const origin = await upstream((_req, res) =>
      json(res, 200, { n_ctx_train: 262144, default_generation_settings: { n_ctx: 32768 } }),
    );
    const r = await detectServedContext({ baseUrl: `${origin}/v1`, flavor: 'llama.cpp', apiKey: null });
    expect(r).toEqual({ ok: true, contextTokens: 32768, source: 'llama.cpp /props' });
    expect(seen).toEqual([{ url: '/props', auth: undefined }]);
  });

  it.each([
    ['https://host/llm/v1', 'https://host/llm/props'],
    ['https://host/llm/v1/', 'https://host/llm/props'],
    ['https://host/llm', 'https://host/llm/props'],
    ['http://127.0.0.1:8080/v1', 'http://127.0.0.1:8080/props'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/props'],
  ])('builds props relative to the base URL with a trailing /v1 removed (P25): %s → %s', (base, expected) => {
    expect(propsUrl(base).href).toBe(expected);
  });

  it('keeps a reverse-proxy path prefix on the wire (P25)', async () => {
    const origin = await upstream((_req, res) => json(res, 200, { default_generation_settings: { n_ctx: 8192 } }));
    const r = await detectServedContext({ baseUrl: `${origin}/llm/v1`, flavor: 'llama.cpp', apiKey: null });
    expect(r).toEqual({ ok: true, contextTokens: 8192, source: 'llama.cpp /props' });
    expect(seen).toEqual([{ url: '/llm/props', auth: undefined }]);
  });

  it('llama-swap passes the model as a query parameter and sends the key as a Bearer token', async () => {
    const origin = await upstream((_req, res) => json(res, 200, { default_generation_settings: { n_ctx: 65536 } }));
    const r = await detectServedContext({ baseUrl: `${origin}/v1`, flavor: 'llama-swap', model: 'qwen3:30b', apiKey: 'sk-detect-1234' });
    expect(r).toEqual({ ok: true, contextTokens: 65536, source: 'llama-swap /props' });
    expect(new URL(seen[0].url, 'http://x').pathname).toBe('/props');
    expect(new URL(seen[0].url, 'http://x').searchParams.get('model')).toBe('qwen3:30b');
    expect(seen[0].auth).toBe('Bearer sk-detect-1234');
  });

  it('reports an upstream HTTP error with its status', async () => {
    const origin = await upstream((_req, res) => json(res, 401, { error: 'bad key' }));
    const r = await detectServedContext({ baseUrl: origin, flavor: 'llama.cpp', apiKey: null });
    expect(r).toMatchObject({ ok: false, upstreamStatus: 401 });
  });

  it('refuses a response without a positive integer n_ctx', async () => {
    const origin = await upstream((_req, res) => json(res, 200, { n_ctx_train: 262144 }));
    const r = await detectServedContext({ baseUrl: origin, flavor: 'llama.cpp', apiKey: null });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('default_generation_settings.n_ctx');
  });

  it('reports an unreachable server', async () => {
    const origin = await upstream((_req, res) => json(res, 200, {}));
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const r = await detectServedContext({ baseUrl: origin, flavor: 'llama.cpp', apiKey: null });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('Could not reach');
  });
});
```

`server/src/routes/analyzer-endpoints-detect.test.ts`:
```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let userSettingsPath: string;
let resetCache: () => void;
const servers: Server[] = [];
let hits: Array<{ port: number; url: string; auth: string | undefined }> = [];

async function upstream(): Promise<string> {
  const s = createServer((req, res) => {
    const port = (s.address() as { port: number }).port;
    hits.push({ port, url: req.url ?? '', auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 } }));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-detect-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ analyzerEndpointsRouter }, settings] = await Promise.all([
    import('./analyzer-endpoints.js'),
    import('../workspace/user-settings.js'),
  ]);
  userSettingsPath = settings.USER_SETTINGS_PATH;
  resetCache = settings._resetUserSettingsCache;
  app = express();
  app.use(express.json());
  app.use('/api/analyzer/endpoints', analyzerEndpointsRouter);
});

beforeEach(() => {
  hits = [];
  if (userSettingsPath && existsSync(userSettingsPath)) rmSync(userSettingsPath, { force: true });
  resetCache();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/analyzer/endpoints/detect-context (#3084 PR 3b)', () => {
  it('llama.cpp: returns the served context', async () => {
    const origin = await upstream();
    const res = await request(app).post('/api/analyzer/endpoints/detect-context').send({ baseUrl: `${origin}/v1`, flavor: 'llama.cpp' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contextTokens: 16384, source: 'llama.cpp /props' });
  });

  it('llama-swap without allowModelLoad is refused and never contacts the server', async () => {
    const origin = await upstream();
    const res = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: `${origin}/v1`, flavor: 'llama-swap', model: 'qwen3:30b' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('model-load-confirmation-required');
    expect(hits).toHaveLength(0);
  });

  it('llama-swap without a model is refused', async () => {
    const origin = await upstream();
    const res = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: origin, flavor: 'llama-swap', allowModelLoad: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('model-required');
  });

  it('sends a stored key only to its own origin; a mismatch is refused as auth without a request', async () => {
    const home = await upstream();
    const elsewhere = await upstream();
    await request(app).post('/api/analyzer/endpoints').send({ id: 'lab', name: 'Lab', baseUrl: `${home}/v1`, contextTokens: 4096 });
    await request(app).put('/api/analyzer/endpoints/lab/key').send({ key: 'sk-stored-secret-1' });

    const ok = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: `${home}/v1`, flavor: 'llama.cpp', endpointId: 'lab' });
    expect(ok.status).toBe(200);
    expect(hits.at(-1)?.auth).toBe('Bearer sk-stored-secret-1');

    const before = hits.length;
    const refused = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: `${elsewhere}/v1`, flavor: 'llama.cpp', endpointId: 'lab' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('auth');
    expect(JSON.stringify(refused.body)).not.toContain('sk-stored-secret-1');
    expect(hits).toHaveLength(before);
  });

  it('a body apiKey is sent to the body baseUrl', async () => {
    const origin = await upstream();
    await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: origin, flavor: 'llama.cpp', apiKey: 'sk-typed-now-1' });
    expect(hits[0].auth).toBe('Bearer sk-typed-now-1');
  });

  it('502s when the upstream cannot answer', async () => {
    const origin = await upstream();
    await new Promise<void>((r) => {
      const s = servers.pop()!;
      s.closeAllConnections();
      s.close(() => r());
    });
    const res = await request(app).post('/api/analyzer/endpoints/detect-context').send({ baseUrl: origin, flavor: 'llama.cpp' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('detect-failed');
  });

  it('400s an invalid body', async () => {
    const res = await request(app).post('/api/analyzer/endpoints/detect-context').send({ baseUrl: 'nope', flavor: 'vllm' });
    expect(res.status).toBe(400);
  });

  it('the 502 body never carries a typed key that the HTTP client echoed in its error (P22)', async () => {
    /* undici refuses the header value before dispatching and throws
       `Headers.append: "Bearer <key>" is an invalid header value.` (undici
       lib/web/webidl/index.js:68-73, lib/web/fetch/headers.js:101-105). */
    const origin = await upstream();
    const res = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: origin, flavor: 'llama.cpp', apiKey: 'sk-detect-echo-1\nX-Injected: 1' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('detect-failed');
    expect(JSON.stringify(res.body)).not.toContain('sk-detect-echo-1');
    expect(res.body.error).toContain('[redacted]');
    expect(hits).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run:
```bash
npm --prefix server run test -- src/analyzer/endpoint-detect.test.ts src/routes/analyzer-endpoints-detect.test.ts
```

Expected:
- `endpoint-detect.test.ts` fails to resolve `./endpoint-detect.js`.
- The route tests FAIL: 404, because there is no handler, and the `PUT /:endpointId` pattern does not match POST.

- [ ] **Step 3: Implement**

`server/src/analyzer/endpoint-detect.ts`:
```ts
/* On-demand served-context detection for a user-run llama.cpp / llama-swap
   server (#3084 decision 3b). Called ONLY when the user clicks Detect — nothing
   probes an endpoint automatically. Reads `default_generation_settings.n_ctx`
   (llama.cpp per-slot served context), never `n_ctx_train`. A local-machine
   surface: no mock counterpart (CLAUDE.md "Mocks behind VITE_USE_MOCKS"). */

import { Agent, fetch as undiciFetch } from 'undici';
import { redactKnownSecrets } from './redact.js';

/* headers/body timeouts off: llama-swap's /props?model= blocks while it loads
   the model. The absolute bound is the per-flavor AbortSignal.timeout below. */
const DETECT_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });

export const DETECT_TIMEOUT_MS = { 'llama.cpp': 15_000, 'llama-swap': 300_000 } as const;

export type DetectResult =
  | { ok: true; contextTokens: number; source: 'llama.cpp /props' | 'llama-swap /props' }
  | { ok: false; error: string; upstreamStatus?: number };

/** #3084 P25 — `/props` sits at the server's root, which behind a reverse proxy is
    the base URL's own path prefix: `https://host/llm/v1` → `https://host/llm/props`.
    A trailing `/v1` is removed and any prefix is kept; `new URL('/props', base)`
    would drop the prefix and ask the proxy's own root. */
export function propsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  url.pathname = `${prefix}/props`;
  url.search = '';
  url.hash = '';
  return url;
}

export async function detectServedContext(input: {
  baseUrl: string;
  flavor: 'llama.cpp' | 'llama-swap';
  model?: string;
  apiKey: string | null;
  /** #3084 P22 — every saved analyzer secret; the typed or stored `apiKey` is always redacted too. */
  secrets?: readonly string[];
  timeoutMs?: number;
  dispatcher?: Agent;
}): Promise<DetectResult> {
  /* #3084 P22 — redacted where the error text is built. An invalid header value
     (a key with a line break) makes undici throw an error embedding the whole
     `Bearer <key>` value, and that message is what `why` reads. */
  const redact = (text: string) => redactKnownSecrets(text, [input.apiKey, ...(input.secrets ?? [])]);
  const url = propsUrl(input.baseUrl);
  if (input.flavor === 'llama-swap' && input.model) url.searchParams.set('model', input.model);
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(url, {
      method: 'GET',
      headers: input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {},
      dispatcher: input.dispatcher ?? DETECT_DISPATCHER,
      signal: AbortSignal.timeout(input.timeoutMs ?? DETECT_TIMEOUT_MS[input.flavor]),
    });
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    const why = e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message ?? 'unknown error');
    return { ok: false, error: redact(`Could not reach ${url.origin} (${why}).`) };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, error: redact(`${url.origin}${url.pathname} returned ${response.status}.`), upstreamStatus: response.status };
  }
  const body = (await response.json().catch(() => null)) as {
    default_generation_settings?: { n_ctx?: unknown };
  } | null;
  const nCtx = body?.default_generation_settings?.n_ctx;
  if (typeof nCtx !== 'number' || !Number.isInteger(nCtx) || nCtx <= 0) {
    return { ok: false, error: `${url.origin}${url.pathname} did not report default_generation_settings.n_ctx.` };
  }
  return { ok: true, contextTokens: nCtx, source: input.flavor === 'llama-swap' ? 'llama-swap /props' : 'llama.cpp /props' };
}
```

`server/src/routes/analyzer-endpoints.ts`:

1. Extend imports:
```ts
import { loadKnownAnalyzerSecrets, readUserSettings } from '../workspace/user-settings.js';
import { keyOriginMatches } from '../workspace/analyzer-endpoints.js';
import { ENDPOINT_ID_PATTERN } from '../analyzer/model-id.js';
import { detectServedContext } from '../analyzer/endpoint-detect.js';
```
Merge these into the existing import statements from those modules.

2. Insert **before** `analyzerEndpointsRouter.put('/:endpointId', …)`:
```ts
const detectSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  endpointId: z.string().regex(ENDPOINT_ID_PATTERN).optional(),
  flavor: z.enum(['llama.cpp', 'llama-swap']),
  allowModelLoad: z.boolean().optional(),
});

/* POST /api/analyzer/endpoints/detect-context — reads a user-run server's
   served context size when the user clicks Detect. llama-swap's
   /props?model= loads the model, so it needs an explicit allowModelLoad. */
analyzerEndpointsRouter.post('/detect-context', async (req: Request, res: Response) => {
  const parsed = detectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload.', code: 'invalid', details: parsed.error.issues.map((i) => i.message) });
  }
  const body = parsed.data;
  if (body.flavor === 'llama-swap' && !body.model) {
    return res.status(400).json({ error: 'llama-swap needs the model name to report its context size.', code: 'model-required' });
  }
  if (body.flavor === 'llama-swap' && body.allowModelLoad !== true) {
    return res.status(400).json({
      error: 'Reading the context size from llama-swap may load the model. Confirm to continue.',
      code: 'model-load-confirmation-required',
    });
  }
  let apiKey = body.apiKey ?? null;
  if (!apiKey && body.endpointId) {
    const settings = await readUserSettings();
    const stored = settings.analyzerEndpointKeys[body.endpointId];
    if (stored && !keyOriginMatches(stored, body.baseUrl)) {
      const name = settings.analyzerEndpoints.find((e) => e.id === body.endpointId)?.name ?? body.endpointId;
      return res.status(400).json({
        error: `The key saved for ${name} was entered for a different host — re-enter the key for ${name}.`,
        code: 'auth',
      });
    }
    apiKey = stored?.key ?? null;
  }
  const result = await detectServedContext({
    baseUrl: body.baseUrl,
    flavor: body.flavor,
    model: body.model,
    apiKey,
    secrets: await loadKnownAnalyzerSecrets(),
  });
  if (result.ok) return res.json({ contextTokens: result.contextTokens, source: result.source });
  return res.status(502).json({ error: result.error, code: 'detect-failed', upstreamStatus: result.upstreamStatus });
});
```

`CLAUDE.md`: in "Mocks behind `VITE_USE_MOCKS`", replace
```
surfaces (`/api/{ollama,qwen,kokoro,coqui,whisper}/{detect,install}`,
  `/api/ollama/{pull,refresh}`, `/api/setup/venv/bootstrap`) talk to the
  local machine and have no mock counterpart;
```
with
```
surfaces (`/api/{ollama,qwen,kokoro,coqui,whisper}/{detect,install}`,
  `/api/ollama/{pull,refresh}`, `/api/setup/venv/bootstrap`,
  `POST /api/analyzer/endpoints/detect-context`) talk to the local machine
  (Detect reads a user-run llama.cpp / llama-swap server's `/props`) and have
  no mock counterpart;
```

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/analyzer/endpoint-detect.test.ts src/routes/analyzer-endpoints-detect.test.ts src/routes/analyzer-endpoints.test.ts
```
Expected: PASS.

- [ ] **Step 5: Mutation proofs**

Revert one change at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| Read `body?.n_ctx_train` instead of `default_generation_settings.n_ctx` | `reads default_generation_settings.n_ctx…, never n_ctx_train` |
| In `propsUrl`, go back to `return new URL('/props', baseUrl);` | `keeps a reverse-proxy path prefix on the wire (P25)` and `builds props relative to the base URL… https://host/llm/v1` |
| In `propsUrl`, drop `.replace(/\/v1$/, '')` | `reads default_generation_settings.n_ctx…, never n_ctx_train` (`url` is `/v1/props`) |
| Delete the `allowModelLoad !== true` refusal | `llama-swap without allowModelLoad is refused and never contacts the server` |
| Delete the `!keyOriginMatches` branch | `sends a stored key only to its own origin…` |
| In `detectServedContext`, `redact` → `(text: string) => text` | `the 502 body never carries a typed key that the HTTP client echoed in its error (P22)` |

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/endpoint-detect.ts server/src/analyzer/endpoint-detect.test.ts server/src/routes/analyzer-endpoints.ts server/src/routes/analyzer-endpoints-detect.test.ts CLAUDE.md
git commit -m "feat(server,docs): add on-demand served-context detect for llama.cpp and llama-swap endpoints"
```

---

### Task 3b.9: OpenAPI, regenerated types, mocks, and account-slice wiring (no UI)

**Files:**
- Modify: `openapi.yaml`:
  - paths — insert after the `/api/user/settings/sync-folder/test` block, before `/api/books/{bookId}/backups:` (`:179`);
  - `components.schemas.UserSettings.properties` — after `analyzerKeepAliveByModel` (`:4758-4762`);
  - new schemas — after `UserSettingsPatch` (ends `:4885`).
- Regenerate: `src/lib/api-types.ts`
- Modify: `src/lib/types.ts` — after `UserSettingsPatch` (`:141-145`).
- Modify: `src/lib/api.ts`:
  - imports `:35-36`;
  - `MOCK_USER_SETTINGS` `:6930-6940`;
  - add real functions after `realPutGeminiKey` (`:6979`);
  - add mock functions after `mockPutUserSettings` (`:7346`);
  - `real` object `:9947-9953`;
  - `mock` object `:10259-10265`.
- Modify: `src/store/account-slice.ts:9-12` (imports), after `:68` (thunks), `:193-196` (reducers).
- Test: `src/lib/api-analyzer-endpoints-mock.test.ts` (new)
- Test: `src/store/account-slice.analyzer-endpoints.test.ts` (new)

**Interfaces:**
- Consumes: the route contracts of Tasks 3b.7 and 3b.8.
- Produces:
  - operationIds `createAnalyzerEndpoint`, `updateAnalyzerEndpoint`, `deleteAnalyzerEndpoint`, `putAnalyzerEndpointKey`, `detectAnalyzerEndpointContext`;
  - `api.createAnalyzerEndpoint(input)`, `api.updateAnalyzerEndpoint(id, input)`, `api.deleteAnalyzerEndpoint(id)`, `api.putAnalyzerEndpointKey(id, key)`;
  - a standalone `export async function detectAnalyzerEndpointContext(body)`, not on `real`/`mock`;
  - `export class AnalyzerEndpointError`;
  - test-only `export function _setMockUserSettingsForTest(patch)` — the mock PUT refuses endpoint model ids until PR 3d (Task 3a.5), so a reference is seeded through this;
  - types `AnalyzerEndpoint`, `AnalyzerEndpointInput`, `AnalyzerEndpointKeyStatus`, `AnalyzerEndpointDetectRequest`, `AnalyzerEndpointDetectResult`;
  - thunks `createAnalyzerEndpoint`, `updateAnalyzerEndpoint`, `deleteAnalyzerEndpoint`, `saveAnalyzerEndpointKey`, each typed `{ rejectValue: AnalyzerEndpointRejection }` (F5 — see "Reducers" below) and exported alongside `export interface AnalyzerEndpointRejection { error: string; code: string; issues: { path: string[]; message: string }[] }` from `src/store/account-slice.ts`.

**Why Detect is not on `api`.** `export const api = USE_MOCKS ? mock : real` (`src/lib/api.ts:10625`) unions the two objects. A member only on `real` would not be callable through `api`. Detect has no mock by design, so PR 3d's form imports the standalone function.

**Tests kept green:**
- `src/lib/api-put-user-settings-mock.test.ts`
- `src/components/api-fetch.guard.test.ts` — no component `fetch` is added.
- `src/store/*`
- Every test that builds `UserSettings` fixtures. The new fields are optional in OpenAPI, so fixtures compile unchanged.

- [ ] **Step 1: Write the failing tests**

`src/lib/api-analyzer-endpoints-mock.test.ts`:
```ts
/* #3084 PR 3b — the mock endpoint API mirrors the server's refusals so the
   PR 3d e2e (mock mode) exercises the same rules. Module state persists across
   tests in this file, so every test uses its own endpoint id. */
import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('VITE_USE_MOCKS', 'true');
const { api, AnalyzerEndpointError, _setMockUserSettingsForTest } = await import('./api');

const input = (id: string, baseUrl = 'http://127.0.0.1:8080/v1') => ({ id, name: `Box ${id}`, baseUrl, contextTokens: 32768 });

async function refusal(p: Promise<unknown>) {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AnalyzerEndpointError);
  return e as InstanceType<typeof AnalyzerEndpointError>;
}

describe('mock analyzer endpoint API', () => {
  it('creates with contract defaults and unset key status', async () => {
    const s = await api.createAnalyzerEndpoint(input('m-create'));
    expect(s.analyzerEndpoints?.find((e) => e.id === 'm-create')).toMatchObject({
      gpu: 'any',
      concurrency: 1,
      requestCeilingMs: 1_800_000,
      structuredOutput: 'schema',
      reasoningStyle: 'not_controllable',
      reasoning: 'model-default',
      maxOutputTokens: 0,
    });
    expect(s.analyzerEndpointKeyStatus?.['m-create']).toBe('unset');
  });

  it('mirrors the server refusals', async () => {
    await api.createAnalyzerEndpoint(input('m-dup'));
    expect((await refusal(api.createAnalyzerEndpoint(input('m-dup')))).code).toBe('duplicate-id');
    expect((await refusal(api.createAnalyzerEndpoint({ ...input('m-bad'), id: 'Bad_Id' }))).code).toBe('invalid');
    expect(
      (await refusal(api.createAnalyzerEndpoint({ ...input('m-nocontext'), contextTokens: undefined as unknown as number }))).code,
    ).toBe('invalid');
    expect(
      (await refusal(api.createAnalyzerEndpoint({ ...input('m-unload'), unloadUrl: 'http://127.0.0.1:9999/api/models/unload/{model}' }))).code,
    ).toBe('unload-off-origin');
  });

  it('key status follows the origin; the key is never returned', async () => {
    await api.createAnalyzerEndpoint(input('m-key'));
    const withKey = await api.putAnalyzerEndpointKey('m-key', 'sk-mock-secret-1234');
    expect(withKey.analyzerEndpointKeyStatus?.['m-key']).toBe('set');
    expect(JSON.stringify(withKey)).not.toContain('sk-mock-secret-1234');
    const moved = await api.updateAnalyzerEndpoint('m-key', input('m-key', 'http://127.0.0.1:9090/v1'));
    expect(moved.analyzerEndpointKeyStatus?.['m-key']).toBe('origin-mismatch');
  });

  it('refuses a key containing a control character, as the server does, without echoing or saving it (P22)', async () => {
    await api.createAnalyzerEndpoint(input('m-ctrl'));
    const r = await refusal(api.putAnalyzerEndpointKey('m-ctrl', 'sk-mock-ctrl-1\r\nX-Injected: 1'));
    expect(r.code).toBe('invalid');
    expect(`${r.message} ${JSON.stringify(r.issues)}`).not.toContain('sk-mock-ctrl-1');
    expect((await api.getUserSettings()).analyzerEndpointKeyStatus?.['m-ctrl']).toBe('unset');
  });

  it('refuses to delete an endpoint that a saved setting or a model-id override references, as the server does, then deletes it once unreferenced', async () => {
    await api.createAnalyzerEndpoint(input('m-ref'));
    _setMockUserSettingsForTest({
      analyzerPhase0Model: 'openai:m-ref::qwen3',
      configOverrides: { 'analyzer.phase1.model': 'openai:m-ref::m', 'analyzer.phase0.model': 'openai:m-ref2::m' },
    });
    const r = await refusal(api.deleteAnalyzerEndpoint('m-ref'));
    expect(r.code).toBe('referenced');
    expect(r.issues).toEqual([
      { path: [], message: 'Account setting "analyzerPhase0Model"' },
      { path: [], message: 'Advanced setting "analyzer.phase1.model"' },
    ]);
    _setMockUserSettingsForTest({ analyzerPhase0Model: null, configOverrides: {} });
    const s = await api.deleteAnalyzerEndpoint('m-ref');
    expect(s.analyzerEndpoints?.some((e) => e.id === 'm-ref')).toBe(false);
  });

  it('until PRs 5a/5b, refuses a non-default reasoning level and a non-empty payload, as the server does', async () => {
    const r = await refusal(api.createAnalyzerEndpoint({ ...input('m-reasoning'), reasoning: 'high' }));
    expect(r).toMatchObject({
      code: 'invalid',
      issues: [{ path: ['reasoning'], message: 'only "model-default" can be saved until PR 5a enables reasoning levels' }],
    });
    const p = await refusal(api.createAnalyzerEndpoint({ ...input('m-payload'), extraParams: { top_k: 20 } }));
    expect(p.issues).toEqual([
      { path: ['extraParams'], message: 'custom request parameters cannot be saved until PR 5b enables them' },
    ]);
  });

  it('the general PUT cannot write analyzerEndpoints (same as the server FORBIDDEN_KEYS)', async () => {
    const before = (await api.getUserSettings()).analyzerEndpoints ?? [];
    await api.putUserSettings({ analyzerEndpoints: [] } as never);
    expect((await api.getUserSettings()).analyzerEndpoints).toEqual(before);
  });
});
```

`src/store/account-slice.analyzer-endpoints.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

vi.stubEnv('VITE_USE_MOCKS', 'true');
const { accountSlice, createAnalyzerEndpoint, updateAnalyzerEndpoint, saveAnalyzerEndpointKey, deleteAnalyzerEndpoint } = await import('./account-slice');
const { api } = await import('../lib/api');

describe('account slice analyzer-endpoint thunks (#3084 PR 3b)', () => {
  it('swaps the settings response into state on each write', async () => {
    const store = configureStore({ reducer: { account: accountSlice.reducer } });
    await store.dispatch(createAnalyzerEndpoint({ id: 'slice-lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 }));
    expect(store.getState().account.analyzerEndpoints?.map((e) => e.id)).toContain('slice-lab');
    await store.dispatch(saveAnalyzerEndpointKey({ endpointId: 'slice-lab', key: 'sk-slice-1234' }));
    expect(store.getState().account.analyzerEndpointKeyStatus?.['slice-lab']).toBe('set');
    await store.dispatch(deleteAnalyzerEndpoint('slice-lab'));
    expect(store.getState().account.analyzerEndpoints?.map((e) => e.id)).not.toContain('slice-lab');
    expect(store.getState().account.status).toBe('idle');
  });

  it('records a refusal as an error without changing endpoints', async () => {
    const store = configureStore({ reducer: { account: accountSlice.reducer } });
    await store.dispatch(createAnalyzerEndpoint({ id: 'slice-dup', name: 'Dup', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 }));
    const before = store.getState().account.analyzerEndpoints;
    await store.dispatch(createAnalyzerEndpoint({ id: 'slice-dup', name: 'Dup', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 }));
    expect(store.getState().account.status).toBe('error');
    expect(store.getState().account.error).toContain('already exists');
    expect(store.getState().account.analyzerEndpoints).toEqual(before);
  });

  /* #3084 F5 defect — found in review. Without a typed rejectValue and a catch
     for AnalyzerEndpointError, createAsyncThunk's default rejection path drops
     `issues` (miniSerializeError keeps only name/message/stack/code), so
     .unwrap() rejects with a plain object that has no issues at all. */
  it('a refused create rejects .unwrap() with EXACTLY the {error, code, issues} payload — not the raw AnalyzerEndpointError instance (#3084 F5 review pass 2, item 4)', async () => {
    const store = configureStore({ reducer: { account: accountSlice.reducer } });
    await store.dispatch(
      createAnalyzerEndpoint({ id: 'slice-bad', name: 'Bad', baseUrl: 'http://127.0.0.1:8080/v1' } as never),
    );
    const rejection = await store
      .dispatch(createAnalyzerEndpoint({ id: 'slice-bad', name: 'Bad', baseUrl: 'http://127.0.0.1:8080/v1' } as never))
      .unwrap()
      .then(
        () => null,
        (e: unknown) => e,
      );
    /* toEqual, not toMatchObject: a plain {error, code, issues} object passes,
       but the RAW AnalyzerEndpointError instance (which also carries `code`
       and `issues` as its own fields, so a toMatchObject on just those two
       would pass either way) fails — it additionally carries `message`,
       `name` and `status`, and is missing `error`. This is what actually
       distinguishes "rejectAnalyzerEndpointError built the payload" from
       "rejectWithValue(e as never) forwarded the raw error", which an
       earlier draft's toMatchObject assertion could not tell apart. */
    expect(rejection).toEqual({
      error: 'An analyzer endpoint with id "slice-bad" already exists.',
      code: 'duplicate-id',
      issues: [],
    });
  });

  it('a non-refusal rejection still rejects .unwrap() as before, with no issues array (F5)', async () => {
    const store = configureStore({ reducer: { account: accountSlice.reducer } });
    await store.dispatch(createAnalyzerEndpoint({ id: 'slice-network', name: 'N', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 }));
    const spy = vi.spyOn(api, 'updateAnalyzerEndpoint').mockRejectedValueOnce(new TypeError('network down'));
    const rejection = await store
      .dispatch(
        updateAnalyzerEndpoint({
          endpointId: 'slice-network',
          input: { id: 'slice-network', name: 'N', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 },
        }),
      )
      .unwrap()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((rejection as { message: string }).message).toBe('network down');
    expect(rejection).not.toHaveProperty('issues');
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run:
```bash
npx vitest run src/lib/api-analyzer-endpoints-mock.test.ts src/store/account-slice.analyzer-endpoints.test.ts
```
Expected: FAIL, `api.createAnalyzerEndpoint is not a function` / `createAnalyzerEndpoint is not exported`.
Once the plain (non-`rejectWithValue`) thunks from an earlier draft exist but before the F5 catch is
added, the two new F5 tests fail differently: `a refused create rejects .unwrap() with the {error,
code, issues} payload intact…` fails because the unwrapped rejection has no `issues` property at all
(RTK's `miniSerializeError` kept only `name`/`message`/`stack`/`code`); `a non-refusal rejection still
rejects…` passes even on the plain thunks, since that path was never broken — it stays green
throughout as the "already worked" half of the regression pair.

- [ ] **Step 3: Implement**

`openapi.yaml` — **paths**. Insert before `  /api/books/{bookId}/backups:`:
```yaml
  /api/analyzer/endpoints:
    post:
      summary: Add a named OpenAI-compatible analyzer endpoint
      operationId: createAnalyzerEndpoint
      description: |
        #3084 — adds an endpoint to user settings. `contextTokens` is required.
        `gpu` defaults to `any` for a localhost / 127.0.0.1 / ::1 base URL,
        else `none`. An `unloadUrl` must share the base URL's origin and may
        contain `{model}`. The response is the GET /api/user/settings body;
        API keys are never returned. Endpoints are NOT writable through
        PUT /api/user/settings.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AnalyzerEndpointInput' }
      responses:
        '201':
          description: Created — updated settings (same shape as GET /api/user/settings)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UserSettings' }
        '400':
          description: Invalid endpoint (missing contextTokens, bad id, off-origin unload URL)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerEndpointRefusal' }
        '409':
          description: An endpoint with this id already exists
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerEndpointRefusal' }

  /api/analyzer/endpoints/detect-context:
    post:
      summary: Read a llama.cpp / llama-swap server's served context size
      operationId: detectAnalyzerEndpointContext
      description: |
        #3084 decision 3b — runs only when the user clicks Detect. Reads
        `GET <origin>/props` → `default_generation_settings.n_ctx`
        (llama.cpp), or `GET <origin>/props?model=<model>` (llama-swap), which
        loads the model and therefore requires `allowModelLoad: true`. A body
        `apiKey` is sent to the body `baseUrl`; a stored key (`endpointId`) is
        sent only when its saved origin matches, else 400 `auth` with no
        request. Local-machine surface: no mock in src/lib/api.ts.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AnalyzerEndpointDetectRequest' }
      responses:
        '200':
          description: Served context size
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerEndpointDetectResult' }
        '400':
          description: Invalid body, missing model / load confirmation, or key origin mismatch (code auth)
          content:
            application/json:
              schema:
                type: object
                required: [error, code]
                properties:
                  error: { type: string }
                  code: { type: string, enum: [invalid, model-required, model-load-confirmation-required, auth] }
        '502':
          description: The server could not be reached or did not report n_ctx
          content:
            application/json:
              schema:
                type: object
                required: [error, code]
                properties:
                  error: { type: string }
                  code: { type: string, enum: [detect-failed] }
                  upstreamStatus: { type: integer }

  /api/analyzer/endpoints/{endpointId}:
    parameters:
      - in: path
        name: endpointId
        required: true
        schema: { type: string, pattern: '^[a-z0-9-]{1,40}$' }
    put:
      summary: Replace an analyzer endpoint's settings
      operationId: updateAnalyzerEndpoint
      description: |
        #3084 — the id cannot change. Changing `baseUrl` to another origin does
        not move a saved key: its status becomes `origin-mismatch` and it is
        not sent until re-entered.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AnalyzerEndpointInput' }
      responses:
        '200':
          description: Updated settings
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UserSettings' }
        '400':
          description: Invalid endpoint or a changed id
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerEndpointRefusal' }
        '404':
          description: No endpoint with this id
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerEndpointRefusal' }
    delete:
      summary: Delete an analyzer endpoint and its key
      operationId: deleteAnalyzerEndpoint
      description: |
        #3084 — refused with 409 while a saved setting references the endpoint
        (defaultAnalysisModel, analyzerPhase0Model, analyzerPhase1Model, or the
        analyzer.phase0.model / analyzer.phase1.model /
        analyzer.personaGeneration.engine overrides); `issues` lists them.
      responses:
        '200':
          description: Updated settings
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UserSettings' }
        '404':
          description: No endpoint with this id
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerEndpointRefusal' }
        '409':
          description: Still referenced by saved settings
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerEndpointRefusal' }

  /api/analyzer/endpoints/{endpointId}/key:
    parameters:
      - in: path
        name: endpointId
        required: true
        schema: { type: string, pattern: '^[a-z0-9-]{1,40}$' }
    put:
      summary: Save (or clear) an analyzer endpoint's API key
      operationId: putAnalyzerEndpointKey
      description: |
        #3084 decision 3c — stores the key bound to the endpoint base URL's
        origin. Pass `{ "key": null }` to clear it. The key is never returned;
        GET exposes `analyzerEndpointKeyStatus` only.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [key]
              properties:
                key: { type: string, nullable: true }
      responses:
        '200':
          description: Updated settings
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UserSettings' }
        '400':
          description: Malformed body
        '404':
          description: No endpoint with this id
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AnalyzerEndpointRefusal' }

```

`openapi.yaml` — `UserSettings.properties`. After the `analyzerKeepAliveByModel` property:
```yaml
        analyzerEndpoints:
          type: array
          items: { $ref: '#/components/schemas/AnalyzerEndpoint' }
          description: |
            #3084 — named OpenAI-compatible analyzer endpoints. Written only by
            the /api/analyzer/endpoints routes, never by PUT /api/user/settings.
        analyzerEndpointKeyStatus:
          type: object
          readOnly: true
          additionalProperties: { $ref: '#/components/schemas/AnalyzerEndpointKeyStatus' }
          description: Per endpoint id — whether a key is saved and still bound to its base URL's origin. Keys are never returned.
```

`openapi.yaml` — new schemas, after `UserSettingsPatch`:
```yaml
    AnalyzerEndpoint:
      type: object
      required: [id, name, baseUrl, gpu, concurrency, requestCeilingMs, structuredOutput, reasoningStyle, reasoning, maxOutputTokens, contextTokens]
      properties:
        id: { type: string, pattern: '^[a-z0-9-]{1,40}$' }
        name: { type: string, minLength: 1, maxLength: 80 }
        baseUrl: { type: string, format: uri }
        gpu:
          type: string
          pattern: '^(none|any|[a-z]+:\d+)$'
          description: '`none`, `any`, or a device key such as `cuda:0`.'
        unloadUrl: { type: string, format: uri, description: 'Same origin as baseUrl; may contain `{model}`.' }
        concurrency: { type: integer, minimum: 1, maximum: 16 }
        requestCeilingMs: { type: integer, minimum: 60000, maximum: 14400000 }
        structuredOutput: { type: string, enum: [schema, json, 'off'] }
        reasoningStyle: { type: string, enum: [reasoning_effort, enable_thinking, not_controllable] }
        reasoning: { type: string }
        maxOutputTokens: { type: integer, minimum: 0, description: '0 = Auto.' }
        contextTokens: { type: integer, minimum: 512 }
        maxInputTokensPerRequest: { type: integer, minimum: 256 }
        extraParams: { type: object, additionalProperties: true }

    AnalyzerEndpointInput:
      type: object
      description: Same fields as AnalyzerEndpoint; everything but id, name, baseUrl and contextTokens has a server default.
      required: [id, name, baseUrl, contextTokens]
      properties:
        id: { type: string, pattern: '^[a-z0-9-]{1,40}$' }
        name: { type: string, minLength: 1, maxLength: 80 }
        baseUrl: { type: string, format: uri }
        gpu: { type: string, pattern: '^(none|any|[a-z]+:\d+)$' }
        unloadUrl: { type: string, format: uri }
        concurrency: { type: integer, minimum: 1, maximum: 16 }
        requestCeilingMs: { type: integer, minimum: 60000, maximum: 14400000 }
        structuredOutput: { type: string, enum: [schema, json, 'off'] }
        reasoningStyle: { type: string, enum: [reasoning_effort, enable_thinking, not_controllable] }
        reasoning: { type: string }
        maxOutputTokens: { type: integer, minimum: 0 }
        contextTokens: { type: integer, minimum: 512 }
        maxInputTokensPerRequest: { type: integer, minimum: 256 }
        extraParams: { type: object, additionalProperties: true }

    AnalyzerEndpointKeyStatus:
      type: string
      enum: [set, unset, origin-mismatch]

    AnalyzerEndpointRefusal:
      type: object
      required: [error, code, issues]
      description: |
        #3084 F5 — issues are {path, message} pairs, never a field or key value:
        a UI shows each one inline next to the named field. path is [] for a
        refusal naming no single field (duplicate-id, not-found, referenced).
      properties:
        error: { type: string }
        code: { type: string, enum: [invalid, duplicate-id, unload-off-origin, not-found, referenced] }
        issues:
          type: array
          items:
            type: object
            required: [path, message]
            properties:
              path: { type: array, items: { type: string } }
              message: { type: string }

    AnalyzerEndpointDetectRequest:
      type: object
      required: [baseUrl, flavor]
      properties:
        baseUrl: { type: string, format: uri }
        model: { type: string }
        apiKey: { type: string }
        endpointId: { type: string, pattern: '^[a-z0-9-]{1,40}$' }
        flavor: { type: string, enum: [llama.cpp, llama-swap] }
        allowModelLoad: { type: boolean }

    AnalyzerEndpointDetectResult:
      type: object
      required: [contextTokens, source]
      properties:
        contextTokens: { type: integer }
        source: { type: string, enum: [llama.cpp /props, llama-swap /props] }
```
`'off'` is quoted: a YAML 1.1 loader would read the bare word as a boolean.

Then run `npm run openapi:types`.

`src/lib/types.ts`: after `UserSettingsPatch` (`:145`), add:
```ts
/* #3084 — analyzer endpoints (generated shapes). */
export type AnalyzerEndpoint = components['schemas']['AnalyzerEndpoint'];
export type AnalyzerEndpointInput = components['schemas']['AnalyzerEndpointInput'];
export type AnalyzerEndpointKeyStatus = components['schemas']['AnalyzerEndpointKeyStatus'];
export type AnalyzerEndpointDetectRequest = components['schemas']['AnalyzerEndpointDetectRequest'];
export type AnalyzerEndpointDetectResult = components['schemas']['AnalyzerEndpointDetectResult'];
```

`src/lib/api.ts`:

1. In the `./types` import (`:35-36`), add `AnalyzerEndpoint, AnalyzerEndpointInput, AnalyzerEndpointDetectRequest, AnalyzerEndpointDetectResult,`.

2. `MOCK_USER_SETTINGS` (`:6930-6940`) gains `analyzerEndpoints: [],` and `analyzerEndpointKeyStatus: {},`.

3. After `realPutGeminiKey` (`:6979`):
```ts
/* #3084 F5 — analyzer endpoint writes. A refusal keeps its machine code and
   the structured {path, message} issues so the PR 3d form can show each one
   next to the right input, without ever holding a rejected field or key
   value (the server never sends one). */
export class AnalyzerEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { path: string[]; message: string }[] = [],
  ) {
    super(message);
    this.name = 'AnalyzerEndpointError';
  }
}

async function analyzerEndpointRequest<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      issues?: { path: string[]; message: string }[];
    };
    throw new AnalyzerEndpointError(res.status, body.code ?? 'unknown', body.error ?? res.statusText, body.issues ?? []);
  }
  return res.json() as Promise<T>;
}

const endpointPath = (id: string) => `/api/analyzer/endpoints/${encodeURIComponent(id)}`;

async function realCreateAnalyzerEndpoint(input: AnalyzerEndpointInput): Promise<UserSettings> {
  return analyzerEndpointRequest('/api/analyzer/endpoints', { method: 'POST', body: JSON.stringify(input) });
}
async function realUpdateAnalyzerEndpoint(id: string, input: AnalyzerEndpointInput): Promise<UserSettings> {
  return analyzerEndpointRequest(endpointPath(id), { method: 'PUT', body: JSON.stringify(input) });
}
async function realDeleteAnalyzerEndpoint(id: string): Promise<UserSettings> {
  return analyzerEndpointRequest(endpointPath(id), { method: 'DELETE' });
}
async function realPutAnalyzerEndpointKey(id: string, key: string | null): Promise<UserSettings> {
  return analyzerEndpointRequest(`${endpointPath(id)}/key`, { method: 'PUT', body: JSON.stringify({ key }) });
}

/* #3084 — Detect talks to a user-run server through the Castwright server. It
   is a local-machine surface with NO mock counterpart (CLAUDE.md "Mocks behind
   VITE_USE_MOCKS"), so it is not on the `real`/`mock` objects: `api` is their
   union and could not expose a member only one of them has. */
export async function detectAnalyzerEndpointContext(
  body: AnalyzerEndpointDetectRequest,
): Promise<AnalyzerEndpointDetectResult> {
  return analyzerEndpointRequest('/api/analyzer/endpoints/detect-context', { method: 'POST', body: JSON.stringify(body) });
}
```

4. Add `parseEndpointModelId` to the `./model-id` import (Task 3a.5 made it a value import). After `mockPutUserSettings` (`:7346`):
```ts
/* #3084 — mock analyzer endpoints. Mirrors the server's defaults and refusals
   (server/src/workspace/analyzer-endpoints.ts) for mock-mode e2e. Keys are not
   stored — only the origin they were bound to, which is all the status needs. */
const mockEndpointKeyOrigins: Record<string, string> = {};
const MOCK_ENDPOINT_ID = /^[a-z0-9-]{1,40}$/;
const MOCK_LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function mockOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function mockEndpointFromInput(input: AnalyzerEndpointInput): AnalyzerEndpoint {
  /* #3084 F5 — {path, message}, never the rejected value (mirrors the server). */
  const problems: { path: string[]; message: string }[] = [];
  if (!MOCK_ENDPOINT_ID.test(input.id ?? '')) problems.push({ path: ['id'], message: 'must match ^[a-z0-9-]{1,40}$' });
  if (!input.name?.trim()) problems.push({ path: ['name'], message: 'required' });
  const baseOrigin = mockOrigin(input.baseUrl ?? '');
  if (!baseOrigin) problems.push({ path: ['baseUrl'], message: 'must be a URL' });
  if (typeof input.contextTokens !== 'number' || input.contextTokens < 512) {
    problems.push({ path: ['contextTokens'], message: 'required, at least 512' });
  }
  if (problems.length > 0) throw new AnalyzerEndpointError(400, 'invalid', 'Invalid analyzer endpoint.', problems);
  /* #3084 P23 — mirrors the server's parseEndpointInput until PRs 5a/5b. */
  const notYet: { path: string[]; message: string }[] = [];
  if (input.reasoning !== undefined && input.reasoning !== 'model-default') {
    notYet.push({ path: ['reasoning'], message: 'only "model-default" can be saved until PR 5a enables reasoning levels' });
  }
  if (input.extraParams !== undefined && Object.keys(input.extraParams).length > 0) {
    notYet.push({ path: ['extraParams'], message: 'custom request parameters cannot be saved until PR 5b enables them' });
  }
  if (notYet.length > 0) throw new AnalyzerEndpointError(400, 'invalid', 'Invalid analyzer endpoint.', notYet);
  if (input.unloadUrl && mockOrigin(input.unloadUrl) !== baseOrigin) {
    /* F5 no-echo — names the field, never either URL. */
    throw new AnalyzerEndpointError(400, 'unload-off-origin', 'The unload URL must be on the same scheme, host and port as the base URL.', [
      { path: ['unloadUrl'], message: 'must be on the same scheme, host and port as baseUrl' },
    ]);
  }
  return {
    ...input,
    name: input.name.trim(),
    gpu: input.gpu ?? (MOCK_LOOPBACK.has(new URL(input.baseUrl).hostname) ? 'any' : 'none'),
    concurrency: input.concurrency ?? 1,
    requestCeilingMs: input.requestCeilingMs ?? 1_800_000,
    structuredOutput: input.structuredOutput ?? 'schema',
    reasoningStyle: input.reasoningStyle ?? 'not_controllable',
    reasoning: input.reasoning ?? 'model-default',
    maxOutputTokens: input.maxOutputTokens ?? 0,
  };
}

function mockSettingsWithEndpoints(endpoints: AnalyzerEndpoint[]): UserSettings {
  const status = Object.fromEntries(
    endpoints.map((e) => {
      const origin = mockEndpointKeyOrigins[e.id];
      return [e.id, !origin ? 'unset' : origin === mockOrigin(e.baseUrl) ? 'set' : 'origin-mismatch'] as const;
    }),
  );
  Object.assign(MOCK_USER_SETTINGS, { analyzerEndpoints: endpoints, analyzerEndpointKeyStatus: status });
  return { ...MOCK_USER_SETTINGS };
}

const mockEndpoints = () => MOCK_USER_SETTINGS.analyzerEndpoints ?? [];

function mockEndpointOrThrow(id: string): AnalyzerEndpoint {
  const found = mockEndpoints().find((e) => e.id === id);
  if (!found) throw new AnalyzerEndpointError(404, 'not-found', `No analyzer endpoint with id "${id}".`);
  return found;
}

async function mockCreateAnalyzerEndpoint(input: AnalyzerEndpointInput): Promise<UserSettings> {
  await wait(50);
  const ep = mockEndpointFromInput(input);
  if (mockEndpoints().some((e) => e.id === ep.id)) {
    throw new AnalyzerEndpointError(409, 'duplicate-id', `An analyzer endpoint with id "${ep.id}" already exists.`);
  }
  return mockSettingsWithEndpoints([...mockEndpoints(), ep]);
}

async function mockUpdateAnalyzerEndpoint(id: string, input: AnalyzerEndpointInput): Promise<UserSettings> {
  await wait(50);
  mockEndpointOrThrow(id);
  if (input.id !== id) throw new AnalyzerEndpointError(400, 'invalid', 'An endpoint id cannot be changed.');
  const ep = mockEndpointFromInput(input);
  return mockSettingsWithEndpoints(mockEndpoints().map((e) => (e.id === id ? ep : e)));
}

async function mockDeleteAnalyzerEndpoint(id: string): Promise<UserSettings> {
  await wait(50);
  mockEndpointOrThrow(id);
  /* The server's references, labels and grammar (findEndpointReferences in
     server/src/workspace/analyzer-endpoints.ts): the three model-id account
     fields, then the three model-id overrides. `configOverrides` is server-side
     only in OpenAPI, so the mock reads it structurally. */
  const names = (v: unknown) => typeof v === 'string' && parseEndpointModelId(v.trim())?.endpointId === id;
  const overrides = (MOCK_USER_SETTINGS as { configOverrides?: Record<string, unknown> }).configOverrides ?? {};
  const refs = [
    ...(['defaultAnalysisModel', 'analyzerPhase0Model', 'analyzerPhase1Model'] as const)
      .filter((f) => names(MOCK_USER_SETTINGS[f]))
      .map((f) => `Account setting "${f}"`),
    ...(['analyzer.phase0.model', 'analyzer.phase1.model', 'analyzer.personaGeneration.engine'] as const)
      .filter((k) => names(overrides[k]))
      .map((k) => `Advanced setting "${k}"`),
  ];
  if (refs.length > 0) {
    throw new AnalyzerEndpointError(
      409,
      'referenced',
      `Analyzer endpoint "${id}" is still used by ${refs.length} saved setting(s).`,
      refs.map((r) => ({ path: [], message: r })),
    );
  }
  delete mockEndpointKeyOrigins[id];
  return mockSettingsWithEndpoints(mockEndpoints().filter((e) => e.id !== id));
}

/* #3084 P22 — the server's applyKey rule and text (server/src/workspace/analyzer-endpoints.ts). */
const MOCK_ENDPOINT_KEY_CONTROL_CHARACTER_RULE =
  'An API key cannot contain control characters (such as a line break, tab or NUL). Paste the key again without them.';

function mockHasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

async function mockPutAnalyzerEndpointKey(id: string, key: string | null): Promise<UserSettings> {
  await wait(50);
  const ep = mockEndpointOrThrow(id);
  if (typeof key === 'string' && mockHasControlCharacter(key)) {
    throw new AnalyzerEndpointError(400, 'invalid', MOCK_ENDPOINT_KEY_CONTROL_CHARACTER_RULE, [
      { path: ['key'], message: MOCK_ENDPOINT_KEY_CONTROL_CHARACTER_RULE },
    ]);
  }
  if (key && key.trim().length > 0) mockEndpointKeyOrigins[id] = new URL(ep.baseUrl).origin;
  else delete mockEndpointKeyOrigins[id];
  return mockSettingsWithEndpoints(mockEndpoints());
}

/** Test-only (#3084): seed mock settings the way a file saved before PR 3d would
    look. The mock PUT refuses endpoint model ids until PR 3d (P23, Task 3a.5), so
    a reference cannot be created through it. */
export function _setMockUserSettingsForTest(
  patch: Partial<UserSettings> & { configOverrides?: Record<string, string> },
): void {
  Object.assign(MOCK_USER_SETTINGS, patch);
}
```

5. `real` object — after `putGeminiKey: realPutGeminiKey,` (`:9953`):
```ts
  createAnalyzerEndpoint: realCreateAnalyzerEndpoint,
  updateAnalyzerEndpoint: realUpdateAnalyzerEndpoint,
  deleteAnalyzerEndpoint: realDeleteAnalyzerEndpoint,
  putAnalyzerEndpointKey: realPutAnalyzerEndpointKey,
```

6. `mock` object — after `putGeminiKey: mockPutGeminiKey,` (`:10265`):
```ts
  createAnalyzerEndpoint: mockCreateAnalyzerEndpoint,
  updateAnalyzerEndpoint: mockUpdateAnalyzerEndpoint,
  deleteAnalyzerEndpoint: mockDeleteAnalyzerEndpoint,
  putAnalyzerEndpointKey: mockPutAnalyzerEndpointKey,
```

`mockPutUserSettings` (`:7308-7346`) is **not** changed. `analyzerEndpoints` and `analyzerEndpointKeyStatus` stay off its whitelist, matching the server's `FORBIDDEN_KEYS`; the last mock test pins that.

`src/store/account-slice.ts`:

1. Imports. `:9` becomes `import { createSlice, createAsyncThunk, isAnyOf, type PayloadAction } from '@reduxjs/toolkit';`, and `:10` becomes `import type { AnalyzerEndpointInput, UserSettings, UserSettingsPatch } from '../lib/types';`. Add `AnalyzerEndpointError` to whichever existing import already brings in `api` from `../lib/api` (the module `saveGeminiApiKey`, below, already calls into).

2. After `saveGeminiApiKey` (`:68`):
```ts
/* #3084 PR 3b — analyzer endpoint writes. Each response is the full settings
   body, swapped in like saveGeminiApiKey. PR 3d's Settings form dispatches these.

   F5 defect (found in review): a bare `(input) => api.createAnalyzerEndpoint(input)`
   thunk lets a thrown AnalyzerEndpointError fall through to createAsyncThunk's
   default rejection path, which RTK serialises via miniSerializeError — that
   keeps only name/message/stack/code and drops the class and its `issues`
   array. `.unwrap()` then rejects with a plain object with no `issues` at all,
   so PR 3d's form has nothing to show inline next to a field. Each thunk
   below is typed with `rejectValue: AnalyzerEndpointRejection` and explicitly
   catches AnalyzerEndpointError to carry `issues` through `rejectWithValue`;
   anything else is rethrown and takes RTK's normal (unrelated) rejection path. */
export interface AnalyzerEndpointRejection {
  error: string;
  code: string;
  issues: { path: string[]; message: string }[];
}

function rejectAnalyzerEndpointError(e: unknown, rejectWithValue: (v: AnalyzerEndpointRejection) => unknown): unknown {
  if (e instanceof AnalyzerEndpointError) {
    return rejectWithValue({ error: e.message, code: e.code, issues: e.issues });
  }
  throw e;
}

export const createAnalyzerEndpoint = createAsyncThunk<UserSettings, AnalyzerEndpointInput, { rejectValue: AnalyzerEndpointRejection }>(
  'account/createAnalyzerEndpoint',
  async (input, { rejectWithValue }) => {
    try {
      return await api.createAnalyzerEndpoint(input);
    } catch (e) {
      return rejectAnalyzerEndpointError(e, rejectWithValue);
    }
  },
);
export const updateAnalyzerEndpoint = createAsyncThunk<
  UserSettings,
  { endpointId: string; input: AnalyzerEndpointInput },
  { rejectValue: AnalyzerEndpointRejection }
>('account/updateAnalyzerEndpoint', async ({ endpointId, input }, { rejectWithValue }) => {
  try {
    return await api.updateAnalyzerEndpoint(endpointId, input);
  } catch (e) {
    return rejectAnalyzerEndpointError(e, rejectWithValue);
  }
});
export const deleteAnalyzerEndpoint = createAsyncThunk<UserSettings, string, { rejectValue: AnalyzerEndpointRejection }>(
  'account/deleteAnalyzerEndpoint',
  async (endpointId, { rejectWithValue }) => {
    try {
      return await api.deleteAnalyzerEndpoint(endpointId);
    } catch (e) {
      return rejectAnalyzerEndpointError(e, rejectWithValue);
    }
  },
);
export const saveAnalyzerEndpointKey = createAsyncThunk<
  UserSettings,
  { endpointId: string; key: string | null },
  { rejectValue: AnalyzerEndpointRejection }
>('account/saveAnalyzerEndpointKey', async ({ endpointId, key }, { rejectWithValue }) => {
  try {
    return await api.putAnalyzerEndpointKey(endpointId, key);
  } catch (e) {
    return rejectAnalyzerEndpointError(e, rejectWithValue);
  }
});

const endpointWrites = [createAnalyzerEndpoint, updateAnalyzerEndpoint, deleteAnalyzerEndpoint, saveAnalyzerEndpointKey] as const;
```

3. Reducers. Replace the builder chain's last case (`:193-196`) with:
```ts
      .addCase(fetchAnalyzerModels.fulfilled, (state, action) => {
        state.localAnalyzerModels = action.payload.localTags;
        state.pullableModels = action.payload.pullable;
      })
      .addMatcher(isAnyOf(...endpointWrites.map((t) => t.pending)), (s) => {
        s.status = 'saving';
        s.error = null;
      })
      .addMatcher(isAnyOf(...endpointWrites.map((t) => t.fulfilled)), (s, a) => {
        Object.assign(s, a.payload);
        s.status = 'idle';
        s.error = null;
        s.hydrated = true;
      })
      .addMatcher(isAnyOf(...endpointWrites.map((t) => t.rejected)), (s, a) => {
        /* #3084 F5 — a.payload is set only via rejectWithValue (an
           AnalyzerEndpointError); a non-refusal rejection (rethrown above)
           carries no payload and falls back to RTK's own a.error.message,
           same as before this task. */
        s.status = 'error';
        s.error = a.payload?.error ?? a.error.message ?? 'Failed to save the analyzer endpoint.';
      });
```
If `isAnyOf` rejects the spread of a mapped tuple at typecheck, list the four action creators explicitly in each `isAnyOf(...)` call instead.

- [ ] **Step 4: Run and confirm pass**

```bash
npx vitest run src/lib/api-analyzer-endpoints-mock.test.ts src/store/account-slice.analyzer-endpoints.test.ts src/lib/api-put-user-settings-mock.test.ts src/components/api-fetch.guard.test.ts src/store
npm run typecheck
npm run openapi:types
git diff --exit-code src/lib/api-types.ts
```
Expected: PASS, and no diff after regeneration.

- [ ] **Step 5: Mutation proofs**

Revert one change at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| Delete the duplicate check in `mockCreateAnalyzerEndpoint` | `mirrors the server refusals` |
| Add `analyzerEndpoints` to `mockPutUserSettings`'s destructure and `Object.entries` blocks | `the general PUT cannot write analyzerEndpoints…` |
| Delete the rejected matcher | `records a refusal as an error…` |
| In `mockDeleteAnalyzerEndpoint`, delete the overrides half of `refs` | `refuses to delete an endpoint that a saved setting or a model-id override references…` |
| In `names`, match with a plain prefix test on `'openai:' + id` (no `::` and no grammar) | the same test (`openai:m-ref2::m` is then read as `m-ref`) |
| Delete the `notYet` block in `mockEndpointFromInput` | `until PRs 5a/5b, refuses a non-default reasoning level and a non-empty payload, as the server does` |
| Delete the `mockHasControlCharacter(key)` refusal in `mockPutAnalyzerEndpointKey` | `refuses a key containing a control character, as the server does…` |
| `mockAcknowledgeDroppedEndpointEntries`: return `mockSettingsWithEndpoints(mockEndpoints())` without filtering `droppedEndpointEntries` first (the pre-fix no-op) | `mock acknowledgeDroppedEndpointEntries removes only the named entries (#3084 F5 review, item 7)` |
| In `createAnalyzerEndpoint`, drop the `try/catch` and `rejectWithValue` (back to a bare `(input) => api.createAnalyzerEndpoint(input)`) | `a refused create rejects .unwrap() with the {error, code, issues} payload intact…` (the unwrapped rejection has no `issues` property) |
| `rejectAnalyzerEndpointError`: build the payload as `{ error: e.message }` only (drop `code`/`issues`) | the same test (`toMatchObject({ code: 'duplicate-id' })` fails, and `issues` is `undefined`) |
| `rejectAnalyzerEndpointError`: drop the `instanceof AnalyzerEndpointError` check and unconditionally `return rejectWithValue(e as never)` (never throw) | `a refused create rejects .unwrap() with EXACTLY the {error, code, issues} payload — not the raw AnalyzerEndpointError instance` — **this is now the genuinely red case; an earlier draft's `toMatchObject({ code: 'duplicate-id' })` could not tell a `{error, code, issues}` object from the raw `AnalyzerEndpointError` instance, since the instance ALSO has `.code` and `.issues` as its own fields — a `TypeError` mutation test could not distinguish this either, since `rejectWithValue(typeError)` still rejects with something whose `.message` is `'network down'` and has no `issues` property, identical to the correctly-thrown case** |
| Reducer's rejected matcher: `s.error = a.error.message ?? '…'` (drop the `a.payload?.error ??` half) | `records a refusal as an error without changing endpoints` (the message reverts to RTK's generic serialised-error text instead of the server's `'…already exists.'` wording) |

- [ ] **Step 6: Commit**
```bash
git add openapi.yaml src/lib/api-types.ts src/lib/types.ts src/lib/api.ts src/lib/api-analyzer-endpoints-mock.test.ts src/store/account-slice.ts src/store/account-slice.analyzer-endpoints.test.ts
git commit -m "feat(openapi,frontend): add analyzer endpoint contract, mocks and account thunks"
```

---

### Task 3b.10: Endpoint runtime state and the limiter's endpoint branch

**Files:**
- Create: `server/src/analyzer/transports/endpoint-runtime.ts`
- Create: `server/src/analyzer/transports/endpoint-runtime.test.ts`
- Modify: `server/src/analyzer/rate-limit.ts` — imports `:22`; `resolveLimits` `:76-84` (as #3139 left it); singleton `:341-344`
- Test: `server/src/analyzer/rate-limit.endpoint.test.ts` (new)

**Interfaces:**
- Consumes:
  - `CountSemaphore` (`server/src/gpu/count-semaphore.ts:19`)
  - `AnalyzerEndpoint` (Task 3b.5)
  - `inferEngineFromModelId`
- Produces (contract):
  - `noteEndpointModelUsed(endpointId, model)` — records a model whose request was **sent** to the endpoint (P3, N2): a run's call, a Test request, or a call that then fails, because any of them can leave the model loaded on the server. Task 3b.11 calls it after the semaphore has admitted the call and immediately before `create()`, so a call aborted while still queued records nothing.
  - `servedModels(endpointId): readonly string[]` — every model recorded for the endpoint since server start, in first-sent order, without duplicates. **Contract deviation (reported):** it replaces the contract's `lastUsedModel(endpointId)`. P3 needs a set, because a single last-used model is retargeted by the next call and misses the second model of a phase-0/phase-1 split on one endpoint.
  - `forgetEndpointModel(endpointId, model)` — removes `model` from the endpoint's served set, or clears the whole set when `model` is `undefined` (the all-models unload URL, which has no `{model}`). Removing from an empty or unknown endpoint is a no-op and never throws. PR 3d's `evictEndpointsOnDevice` (Task 3d.2) calls this after a 2xx or 404 unload response, as `deps.forgetServedModel`'s default.
  - `endpointSemaphore(endpoint): CountSemaphore`
  - `export const analyzerRateLimiter = geminiRateLimiter`
- Produces (additional):
  - `_resetEndpointRuntimeForTest()`
  - an endpoint id resolves to `{ rpm: Infinity, tpm: Infinity, rpd: Infinity }`

**Scope note for PR 3c:**
- PR 3c inserts the `analyzerRateLimitsByModel` read in front of this early return.
- PR 3c also exports `resolveLimits`.
- PR 3b adds only the unlimited default, plus the alias the transport needs.

**Tests kept green:**
- `server/src/analyzer/rate-limit.test.ts`
- `server/src/analyzer/output-heavy-tpm.test.ts`
- `server/src/config/direct-env-reader-guard.test.ts` — the computed `GEMINI_*_<slug>` env read is untouched.

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/transports/endpoint-runtime.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetEndpointRuntimeForTest,
  endpointSemaphore,
  forgetEndpointModel,
  noteEndpointModelUsed,
  servedModels,
} from './endpoint-runtime.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';

const ep = (id: string, concurrency: number): AnalyzerEndpoint => ({
  id,
  name: id,
  baseUrl: 'http://127.0.0.1:8080/v1',
  gpu: 'any',
  concurrency,
  requestCeilingMs: 1_800_000,
  structuredOutput: 'schema',
  reasoningStyle: 'not_controllable',
  reasoning: 'model-default',
  maxOutputTokens: 0,
  contextTokens: 32768,
});

beforeEach(() => _resetEndpointRuntimeForTest());

describe('endpoint runtime (#3084 PR 3b)', () => {
  it('keeps one semaphore per endpoint id, sized by its concurrency', () => {
    expect(endpointSemaphore(ep('a', 2))).toBe(endpointSemaphore(ep('a', 2)));
    expect(endpointSemaphore(ep('a', 2)).max).toBe(2);
    expect(endpointSemaphore(ep('b', 1))).not.toBe(endpointSemaphore(ep('a', 2)));
  });

  it('resizes the existing semaphore when the saved concurrency changes', async () => {
    const s = endpointSemaphore(ep('a', 1));
    const release = await s.acquire();
    expect(endpointSemaphore(ep('a', 3))).toBe(s);
    expect(s.max).toBe(3);
    release();
  });

  it('keeps every model sent to each endpoint (P3): first-sent order, no duplicates, nothing before the first', () => {
    expect(servedModels('a')).toEqual([]);
    noteEndpointModelUsed('a', 'qwen3:30b');
    noteEndpointModelUsed('a', 'gemma3:12b');
    noteEndpointModelUsed('a', 'qwen3:30b');
    expect(servedModels('a')).toEqual(['qwen3:30b', 'gemma3:12b']);
    expect(servedModels('b')).toEqual([]);
  });

  it('forgetEndpointModel removes one model, or the whole set when model is undefined; unknown endpoints are a no-op', () => {
    noteEndpointModelUsed('a', 'qwen3:30b');
    noteEndpointModelUsed('a', 'gemma3:12b');
    forgetEndpointModel('a', 'qwen3:30b');
    expect(servedModels('a')).toEqual(['gemma3:12b']);
    forgetEndpointModel('a', undefined);
    expect(servedModels('a')).toEqual([]);
    expect(() => forgetEndpointModel('nope', 'qwen3:30b')).not.toThrow();
    expect(() => forgetEndpointModel('nope', undefined)).not.toThrow();
  });

  it('servedModels still returns a fresh copy after forgetEndpointModel (no aliasing into the internal set)', () => {
    noteEndpointModelUsed('a', 'qwen3:30b');
    const first = servedModels('a');
    forgetEndpointModel('a', 'qwen3:30b');
    expect(first).toEqual(['qwen3:30b']);
    expect(servedModels('a')).toEqual([]);
  });
});
```

`server/src/analyzer/rate-limit.endpoint.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzerRateLimiter, geminiRateLimiter } from './rate-limit.js';

beforeEach(() => geminiRateLimiter._reset());

describe('analyzer limiter — OpenAI-compatible endpoint ids (#3084 decision 5)', () => {
  it('is the same singleton as the Gemini limiter', () => {
    expect(analyzerRateLimiter).toBe(geminiRateLimiter);
  });

  it('never throttles an endpoint id by default (Infinity limits are handled)', async () => {
    const start = Date.now();
    for (let i = 0; i < 200; i += 1) {
      await analyzerRateLimiter.acquire('openai:lab::qwen3:30b', 1_000_000);
    }
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('still honours a server retry-after for an endpoint id', async () => {
    analyzerRateLimiter.recordRejection('openai:lab::qwen3:30b', 300);
    const start = Date.now();
    await analyzerRateLimiter.acquire('openai:lab::qwen3:30b', 10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
  });

  it('a GEMINI_RPM_<slug> env var cannot throttle an endpoint', async () => {
    process.env.GEMINI_RPM_OPENAI_LAB_QWEN3_30B = '1';
    try {
      await analyzerRateLimiter.acquire('openai:lab::qwen3:30b', 10);
      const start = Date.now();
      await analyzerRateLimiter.acquire('openai:lab::qwen3:30b', 10);
      expect(Date.now() - start).toBeLessThan(500);
    } finally {
      delete process.env.GEMINI_RPM_OPENAI_LAB_QWEN3_30B;
    }
  });
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `npm --prefix server run test -- src/analyzer/transports/endpoint-runtime.test.ts src/analyzer/rate-limit.endpoint.test.ts`

Expected:
- `endpoint-runtime.test.ts` fails to resolve: `forgetEndpointModel` (and `noteEndpointModelUsed`, `servedModels`) do not exist yet.
- `is the same singleton` FAILS: `analyzerRateLimiter` is undefined.
- `never throttles an endpoint id` FAILS: `RequestExceedsTpmError`, because `FALLBACK_LIMITS.tpm` is 100 000.
- `a GEMINI_RPM_<slug> env var cannot throttle an endpoint` FAILS: the second acquire waits about 60 s and hits the 15 s test timeout.

- [ ] **Step 3: Implement**

`server/src/analyzer/transports/endpoint-runtime.ts`:
```ts
/* Per-endpoint runtime state that is never persisted (#3084 contract):
   - one concurrency semaphore per endpoint id (decision 5; same count-semaphore
     mechanism as acquireAnalyzerSlot), resized live when the saved
     concurrency changes;
   - every model whose request has been SENT to each endpoint since server
     start, for the `{model}` unload-URL substitution (P3: one unload POST per
     model). A run's call, a Test request and a call that then fails all count:
     the server may have loaded the model for any of them, and a 5xx after the
     load is exactly the case an unload has to clean up. Only a call aborted
     while still queued records nothing, because it never left. An unload URL
     with `{model}` and no recorded model is skipped, and PR 3d's give-up
     message names that endpoint (N2). */
import { CountSemaphore } from '../../gpu/count-semaphore.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';

const semaphores = new Map<string, CountSemaphore>();
const served = new Map<string, Set<string>>();

export function endpointSemaphore(endpoint: AnalyzerEndpoint): CountSemaphore {
  const existing = semaphores.get(endpoint.id);
  if (existing) {
    existing.resize(endpoint.concurrency);
    return existing;
  }
  const created = new CountSemaphore(endpoint.concurrency);
  semaphores.set(endpoint.id, created);
  return created;
}

/** Record a model whose request was sent to this endpoint (P3, N2). */
export function noteEndpointModelUsed(endpointId: string, model: string): void {
  const set = served.get(endpointId) ?? new Set<string>();
  set.add(model);
  served.set(endpointId, set);
}

/** Every model that has served this endpoint since server start (a copy). */
export function servedModels(endpointId: string): readonly string[] {
  return [...(served.get(endpointId) ?? [])];
}

/** Remove a model from the endpoint's served set, or clear the whole set
    when `model` is `undefined` (the all-models unload URL, which has no
    `{model}`). An empty or unknown endpoint is a no-op. */
export function forgetEndpointModel(endpointId: string, model: string | undefined): void {
  if (model === undefined) {
    served.delete(endpointId);
    return;
  }
  served.get(endpointId)?.delete(model);
}

/** Test-only. */
export function _resetEndpointRuntimeForTest(): void {
  semaphores.clear();
  served.clear();
}
```

`server/src/analyzer/rate-limit.ts` has three changes.

1. After the existing `:22` import, add:
```ts
import { inferEngineFromModelId } from './model-id.js';
```

2. At the **top** of `resolveLimits`'s body (#3139 may have changed the rest of it), insert:
```ts
  /* #3084 PR 3b — an OpenAI-compatible endpoint id is unlimited by default
     (decision 5). PR 3c puts the per-model settings map in front of this. The
     Gemini env / builtin chain below never sees an endpoint id, so a
     GEMINI_{RPM,TPM,RPD}_<slug> env var cannot throttle an endpoint. */
  if (inferEngineFromModelId(model) === 'openai') return UNLIMITED;
```
Declare this next to `FALLBACK_LIMITS` (`:33`):
```ts
const UNLIMITED: ModelLimits = { rpm: Infinity, tpm: Infinity, rpd: Infinity };
```
`acquire` already handles `Infinity`, so no other change is needed there:
- the TPM fail-fast is guarded by `Number.isFinite` (`:207`);
- `rpdCount >= Infinity` is false (`:216`);
- `rpmWindow.length < Infinity` is true (`:230`);
- `sum + est <= Infinity` is true (`:231`).

3. After `export const geminiRateLimiter = new GeminiRateLimiter();` (`:344`), add:
```ts
/** #3084 — the one model-keyed analyzer limiter (Gemini, endpoints, persona). */
export const analyzerRateLimiter = geminiRateLimiter;
```

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/analyzer/transports/endpoint-runtime.test.ts src/analyzer/rate-limit.endpoint.test.ts src/analyzer/rate-limit.test.ts src/analyzer/output-heavy-tpm.test.ts src/config/direct-env-reader-guard.test.ts
npm run check:cycles
```

Expected:
- PASS.
- No new cycle: `model-id.ts` is a leaf.

- [ ] **Step 5: Mutation proofs**

Apply each change, check that the named test fails, then restore it.

| Change | Expected failure |
|---|---|
| Delete the `if (… === 'openai') return UNLIMITED;` line | `never throttles an endpoint id by default…` and `a GEMINI_RPM_<slug> env var cannot throttle an endpoint` |
| In `endpointSemaphore`, delete `existing.resize(endpoint.concurrency);` | `resizes the existing semaphore…` |
| In `noteEndpointModelUsed`, replace the body with `served.set(endpointId, new Set([model]));` (a last-used model again) | `keeps every model sent to each endpoint (P3)…` |
| In `forgetEndpointModel`, delete the `served.delete(endpointId);` line (fall through to the single-model branch, which does nothing for `undefined`) | `forgetEndpointModel removes one model, or the whole set when model is undefined…` |
| In `forgetEndpointModel`, delete `served.get(endpointId)?.delete(model);` | `forgetEndpointModel removes one model, or the whole set when model is undefined…` |
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports/endpoint-runtime.ts server/src/analyzer/transports/endpoint-runtime.test.ts server/src/analyzer/rate-limit.ts server/src/analyzer/rate-limit.endpoint.test.ts
git commit -m "feat(server): add endpoint runtime state and unlimited limiter default for endpoints"
```

---

### Task 3b.11: `openai` dependency, `OpenAITransport`, and the transport contract suite

**Files:**
- Modify: `server/package.json` — add `"openai": "^7.15.0"` to `dependencies`
- Modify: `server/package-lock.json`
- Create: `server/src/analyzer/transports/allowlisted-fetch.ts` (P22 leaf: imports only `undici`)
- Create: `server/src/analyzer/transports/openai-transport.ts`
- Create: `server/src/analyzer/transports/openai-outcome.test.ts` (pure classification table)
- Create: `server/src/analyzer/transports/openai-transport.contract.test.ts` (real `http.createServer` plus a real undici `Agent`)
- Create: `server/src/analyzer/transports/openai-request-body.test.ts` (pure: endpoint Auto `max_tokens`, P24)

**Interfaces:**
- Consumes:
  - `ChatTransport`, `TransportRequest`, `TransportResult`, `TransportUsage`, `StructuredOutputRequest` (W1 `runner/transport.ts`)
  - `withTransportRetry`, `RetryClassifier` (W1 `runner/transport-retry.ts`)
  - `AnalysisAbortedError`, `AnalyzerUnreachableError`, `AnalyzerHttpError` (W1)
  - `AnalyzerTimeoutError` (wave 2b), `AnalyzerStreamIncompleteError` (Task 3b.1)
  - `analyzerRateLimiter`, `endpointSemaphore`, `noteEndpointModelUsed` (Task 3b.10)
  - `endpointModelId` (`model-id.ts`)
  - `redactKnownSecrets`, `AnalyzerTransportError`, `sanitizeCauseCode`, `causeCodeSuffix` (Task 3b.1), `loadKnownAnalyzerSecrets` **from the leaf `known-secrets-gate.ts`** (Task 3b.1's gate, Task 3b.6's provider; never from `user-settings.ts`, A9), `AnalyzerKeyOriginError` (Task 3b.1), `AnalyzerReasoningOverflowError` (wave 2)

**Import-cycle baseline (A9).** Before Step 1, run `npm run check:cycles` and record the count `N` it prints. Step 5 expects the same `N`.
  - `resolveStreamIdleTimeoutMs`, `BACKOFFS_MS`, `appendBounded` (exported by `gemini.ts:73`, `:102`, `:66` on main)
    - If wave 1 moved them, import from wherever `rg -n "export (function resolveStreamIdleTimeoutMs|const BACKOFFS_MS|function appendBounded)" server/src/analyzer` finds them.
- Produces (contract):
  - `class OpenAITransport implements ChatTransport`
  - constructor `{ endpoint: AnalyzerEndpoint; apiKey: string | null; model: string; dispatcher?: Agent; now?: () => number }` — the contract's constructor, unchanged. There is **no** `noteServedModel` flag: a model counts as served once its request is sent, Tests included (P3, N2), because a Test leaves the model loaded on the server exactly as a run does, and an unload URL with `{model}` needs that name.
- Produces (additional, for tests and PR 3d):
  - `OPENAI_DISPATCHER`
  - `OPENAI_UNREACHABLE_CODES` (connect-phase only) and `OPENAI_PRE_HEADER_TRANSIENT_CODES` (P21)
  - `OPENAI_RETRY_CLASSIFIER`
  - `classifyOpenAIOutcome(err, ctx)`
  - `buildOpenAIRequestBody(endpoint, model, req)`
  - `openAIResponseFormat(so)`
  - `allowlistedFetch(apiKey, keyOrigin)` and `ANALYZER_USER_AGENT` — the one place that decides which headers reach an endpoint (P22). **Defined in the leaf `server/src/analyzer/transports/allowlisted-fetch.ts`**, which imports only `undici`; `openai-transport.ts` re-exports both. PR 3c's catalog listing, preview and served-limits clients import it **from the leaf**: importing it from `openai-transport.ts` would close a transport → served-limits → catalog → transport cycle. Name and signature are fixed: w3cd calls `allowlistedFetch(apiKey, origin)`.
  - `endpointAutoOutputMargin(contextTokens)` and `resolveEndpointMaxOutputTokens(endpoint, servedOutputLimit?)` (P24). `OpenAIAnalyzer` (Task 3b.12) resolves its engine-level cap with the second; PR 3c passes the served output limit into it.
  - `OutcomeContext.secrets` — the values `classifyOpenAIOutcome` redacts from every error it builds (P22)

**Classification order.** This follows research `04-openai-sdk-facts.md` "Consequences". After the stream loop (clean end) and on any thrown error, the checks run in this order:
1. The caller signal aborted → `AnalysisAbortedError`.
2. The error is **connection-level**, and the cause chain (≤ 4 levels) holds a **connect-phase** code in `OPENAI_UNREACHABLE_CODES` (`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT`), or the chain has **no codes at all** and says `fetch failed` → `AnalyzerUnreachableError` (P21). It is rebuilt with no `cause`, carrying only the sanitized code as `causeCode` (P22). A connection-level error before headers whose chain holds `ECONNRESET`, `UND_ERR_SOCKET` or `EAI_AGAIN` (`OPENAI_PRE_HEADER_TRANSIENT_CODES`) comes from a server that may be up → `AnalyzerStreamIncompleteError(…, { causeCode })`: retried, never a fallback (P21). Its message names that sanitized code, `Endpoint <model> dropped the connection before a response (EAI_AGAIN).`, so a persistent DNS failure never reads as a mid-answer drop (P22, Q1).
   - Connection-level means `APIConnectionError` (its timeout subclass included), or an error that is not an `APIError` at all and was raised before `create()` resolved.
   - **An `APIError` that carries an HTTP status is never unreachable**, whatever its body says. The SDK builds a status error only after the response arrived (`openai` `core/error.mjs:35-65`) and copies the body's `error.code` and `error.message` onto it (`:12`, `:16-26`). A proxy's 502 with `code: "ECONNREFUSED"` would otherwise read as unreachable, and `FallbackAnalyzer` would swap an endpoint that answered for Gemini.
3. The ceiling signal aborted, or `APIConnectionTimeoutError` → `AnalyzerTimeoutError` (`ceiling` / `connect-timeout`).
4. An `APIError` with a numeric status (not a connection or user-abort error) → `AnalyzerHttpError(status)`. Its excerpt and message are redacted against `OutcomeContext.secrets` before they are built (P22), and the raw SDK error is not attached as `cause`: it holds the unredacted body, and a logged error prints its cause chain. Only the `retry-after` hint travels, as `retryAfterMs`.
5. An `APIError` without a status (an error event in the stream) → `AnalyzerHttpError(0)`, redacted the same way. This is not retried.
6. Headers received, and one of:
   - the idle watchdog fired **before** a `finish_reason` arrived;
   - a socket drop (`terminated` / `UND_ERR_SOCKET` / `ECONNRESET`);
   - a clean end with no `finish_reason`.

   → `AnalyzerStreamIncompleteError`, retried like an idle stream. A stream that has sent a `finish_reason` is complete even if the watchdog fires, or the socket drops, while waiting for the usage chunk or `[DONE]`: its text is returned (P25).
7. One of **our own** analyzer errors (`AnalyzerReasoningOverflowError`, `AnalysisAbortedError`, `AnalyzerTimeoutError`, `AnalyzerHttpError`, `AnalyzerUnreachableError`, `AnalyzerStreamIncompleteError`, `AnalyzerTransportError`, `AnalyzerKeyOriginError`) → returned unchanged. The analysis routes rethrow a reasoning overflow to stop the run (P20), so nothing here may wrap or reclassify it. **Anything else → rebuilt as `AnalyzerTransportError`** (P22): its message holds only the model, whether headers had arrived, the sanitized code as a ` (CODE)` suffix (`causeCodeSuffix`), and the error class names in the cause chain, for example `Endpoint qwen3:30b request failed before a response (ERR_SSL_WRONG_VERSION_NUMBER) (APIConnectionError <- TypeError <- Error).`; `causeCode` holds the same code; there is no `cause`. The code in the message is what makes a first-run mistake (`https://` against plain HTTP, an untrusted mkcert certificate, a hostname mismatch) diagnosable from the run failure, the log and the Test action (Q1). The SDK's error is never rethrown or attached, because undici's header errors embed the header value (`Headers.append: "Bearer <key>" is an invalid header value.`, `undici/lib/web/webidl/index.js:68-73`) and the SDK keeps that as `cause` (`openai/client.mjs:817-820`).

**Three deliberate refinements of the research order:**
- **Rule 2 is gated on the error's class, not on `headersReceived` alone (P21).** `headersReceived` is set only when `create()` resolves, and an HTTP status error is thrown *from* `create()`. So "no headers" is true for every HTTP error, and the research order's rule 2 would scan an error body's copied `code`.
- **Bare `fetch failed` only counts when the chain has no string code.** A headers-timeout chain carries `UND_ERR_HEADERS_TIMEOUT` under a `fetch failed` TypeError. Without this rule a slow-but-healthy server would read as unreachable, which is the exact misclassification `ollama-timeout.test.ts` guards.
- **`OPENAI_UNREACHABLE_CODES` is connect-phase only (P21).** It is not Ollama's `UNREACHABLE_CODES` (`ollama.ts:147-153`), whose `ECONNRESET`, `UND_ERR_SOCKET` and `EAI_AGAIN` can come from an up server resetting before headers or a DNS hiccup; for an endpoint those retry as an incomplete stream instead of silently switching to Gemini. It adds `EHOSTUNREACH`, `ENETUNREACH` and `UND_ERR_CONNECT_TIMEOUT`: an unroutable address returns one of the three depending on the host's routing table. Ollama's own set and classification are unchanged (P28).

**Tests kept green:** `server/src/analyzer/ollama-timeout.test.ts`. This task does not change `ANALYZER_DISPATCHER` or Ollama classification.

- [ ] **Step 1: Add the dependency**
```bash
npm --prefix server install openai@^7.15.0
npm run audit:server
```

Expected:
- `server/package.json` gains `"openai": "^7.15.0"`.
- `audit:server` exits 0. openai 7.15.0 has no runtime dependencies; undici is an optional peer that `server/node_modules/undici` 8.x already satisfies.

- [ ] **Step 2: Write the failing tests**

`server/src/analyzer/transports/openai-outcome.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { classifyOpenAIOutcome, OPENAI_RETRY_CLASSIFIER, type OutcomeContext } from './openai-transport.js';
import { classifyAnalysisFailure } from '../../routes/failure-taxonomy.js';
import {
  AnalysisAbortedError,
  AnalyzerHttpError,
  AnalyzerReasoningOverflowError,
  AnalyzerStreamIncompleteError,
  AnalyzerTimeoutError,
  AnalyzerTransportError,
  AnalyzerUnreachableError,
} from '../errors.js';

const ctx = (over: Partial<OutcomeContext> = {}): OutcomeContext => ({
  callerAborted: false,
  ceilingAborted: false,
  idleAborted: false,
  headersReceived: false,
  sawFinish: false,
  elapsedMs: 1234,
  model: 'qwen3:30b',
  secrets: [],
  ...over,
});

/* The shapes observed in research probes P06–P11 (04-openai-sdk-facts). */
const chain = (code: string) =>
  new APIConnectionError({ cause: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }) });

describe('classifyOpenAIOutcome — order (#3084 decision 1c)', () => {
  it('1. a caller abort wins over everything, including a fired ceiling', () => {
    expect(classifyOpenAIOutcome(new APIUserAbortError(), ctx({ callerAborted: true, ceilingAborted: true }))).toBeInstanceOf(
      AnalysisAbortedError,
    );
    expect(classifyOpenAIOutcome(undefined, ctx({ callerAborted: true, headersReceived: true }))).toBeInstanceOf(AnalysisAbortedError);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])(
    '2. %s (a connect-phase code) before headers is unreachable, carrying only the sanitized code (P21, P22)',
    (code) => {
      const out = classifyOpenAIOutcome(chain(code), ctx());
      expect(out).toBeInstanceOf(AnalyzerUnreachableError);
      expect((out as AnalyzerUnreachableError).transport).toBe('openai');
      expect((out as AnalyzerUnreachableError & { causeCode?: string }).causeCode).toBe(code);
      expect((out as Error & { cause?: unknown }).cause).toBeUndefined();
    },
  );

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN'])(
    '2. %s before headers comes from a server that may be up: an incomplete stream (retried), never unreachable (P21)',
    (code) => {
      const out = classifyOpenAIOutcome(chain(code), ctx());
      expect(out).toBeInstanceOf(AnalyzerStreamIncompleteError);
      expect(out).not.toBeInstanceOf(AnalyzerUnreachableError);
      expect(OPENAI_RETRY_CLASSIFIER.classify(out)).toBe('idle');
      /* Q1 — the pre-header case names its code. */
      expect((out as AnalyzerStreamIncompleteError).causeCode).toBe(code);
      expect((out as Error).message).toBe(`Endpoint qwen3:30b dropped the connection before a response (${code}).`);
    },
  );

  it('2. a non-APIError reset raised before create() resolved is an incomplete stream too (P21)', () => {
    const raw = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    expect(classifyOpenAIOutcome(raw, ctx())).toBeInstanceOf(AnalyzerStreamIncompleteError);
  });

  it('2. the unreachable error is rebuilt: no cause, and text in the chain reaches neither its message nor inspect() (P22)', () => {
    const err = new APIConnectionError({
      cause: Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED while sending Bearer sk-rule2-secret-1'), { code: 'ECONNREFUSED' }),
      }),
    });
    /* secrets: [] — only the rebuild (no cause, no upstream text) can keep the key out. */
    const out = classifyOpenAIOutcome(err, ctx({ secrets: [] }));
    expect(out).toBeInstanceOf(AnalyzerUnreachableError);
    expect((out as Error).message).toBe('Endpoint qwen3:30b is unreachable (ECONNREFUSED).');
    expect(inspect(out, { depth: 8 })).not.toContain('sk-rule2-secret-1');
  });

  it('2. a bare "fetch failed" with no code anywhere is unreachable', () => {
    expect(classifyOpenAIOutcome(new APIConnectionError({ cause: new TypeError('fetch failed') }), ctx())).toBeInstanceOf(
      AnalyzerUnreachableError,
    );
  });

  it('2. an HTTP 502 whose body says code ECONNREFUSED is an AnalyzerHttpError, never unreachable (P21)', () => {
    /* Exactly what the SDK throws from create(): status, parsed body, headers; err.code copied from the body. */
    const err = new APIError(502, { code: 'ECONNREFUSED', message: 'upstream down' }, 'upstream down', new Headers());
    const out = classifyOpenAIOutcome(err, ctx());
    expect(out).toBeInstanceOf(AnalyzerHttpError);
    expect(out).not.toBeInstanceOf(AnalyzerUnreachableError);
    expect((out as AnalyzerHttpError).httpStatus).toBe(502);
  });

  it('2. an HTTP 500 whose message is "fetch failed" is an AnalyzerHttpError, never unreachable (P21)', () => {
    const out = classifyOpenAIOutcome(new APIError(500, { message: 'fetch failed' }, 'fetch failed', new Headers()), ctx());
    expect(out).toBeInstanceOf(AnalyzerHttpError);
    expect((out as AnalyzerHttpError).httpStatus).toBe(500);
  });

  it('2. a non-APIError transport error raised before create() resolved is connection-level', () => {
    const raw = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    expect(classifyOpenAIOutcome(raw, ctx())).toBeInstanceOf(AnalyzerUnreachableError);
  });

  it('2. a headers-timeout chain is NOT unreachable (a slow server must never trigger fallback)', () => {
    const headersTimeout = Object.assign(
      new APIConnectionTimeoutError({ message: 'Request timed out.' }),
      { cause: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) }) },
    );
    const out = classifyOpenAIOutcome(headersTimeout, ctx());
    expect(out).toBeInstanceOf(AnalyzerTimeoutError);
    expect((out as AnalyzerTimeoutError).reason).toBe('connect-timeout');
  });

  it('2. an unreachable-looking code AFTER headers is not unreachable', () => {
    const drop = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    expect(classifyOpenAIOutcome(drop, ctx({ headersReceived: true }))).toBeInstanceOf(AnalyzerStreamIncompleteError);
  });

  it('3. the ceiling firing (before or after headers) is a timeout, never a fallback', () => {
    const before = classifyOpenAIOutcome(new APIUserAbortError(), ctx({ ceilingAborted: true }));
    expect(before).toBeInstanceOf(AnalyzerTimeoutError);
    expect((before as AnalyzerTimeoutError).reason).toBe('ceiling');
    expect(classifyOpenAIOutcome(undefined, ctx({ ceilingAborted: true, headersReceived: true }))).toBeInstanceOf(AnalyzerTimeoutError);
  });

  it('4. an HTTP status becomes AnalyzerHttpError with that status, a redacted body excerpt, the retry hint, and no raw cause', () => {
    const err = new APIError(
      429,
      { message: 'slow down, key sk-outcome-secret-1', type: 'rate_limit_error' },
      'slow down',
      new Headers({ 'retry-after': '2' }),
    );
    const out = classifyOpenAIOutcome(err, ctx({ secrets: ['sk-outcome-secret-1'] }));
    expect(out).toBeInstanceOf(AnalyzerHttpError);
    expect((out as AnalyzerHttpError).httpStatus).toBe(429);
    expect((out as AnalyzerHttpError).bodyExcerpt).toContain('slow down, key [redacted]');
    expect(`${(out as Error).message}\n${(out as AnalyzerHttpError).bodyExcerpt}`).not.toContain('sk-outcome-secret-1');
    expect(OPENAI_RETRY_CLASSIFIER.retryAfterMs(out)).toBe(2000);
    expect((out as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('5. an in-stream error event (no status) becomes AnalyzerHttpError(0)', () => {
    const err = new APIError(undefined, { message: 'context exceeded' }, 'context exceeded', undefined);
    const out = classifyOpenAIOutcome(err, ctx({ headersReceived: true }));
    expect(out).toBeInstanceOf(AnalyzerHttpError);
    expect((out as AnalyzerHttpError).httpStatus).toBe(0);
  });

  it('6. a clean end without finish_reason, or an idle abort before one, after headers is incomplete', () => {
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true }))).toBeInstanceOf(AnalyzerStreamIncompleteError);
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true, idleAborted: true }))).toBeInstanceOf(
      AnalyzerStreamIncompleteError,
    );
  });

  it('6. an idle abort AFTER a finish_reason is success: the answer was complete (P25)', () => {
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true, idleAborted: true, sawFinish: true }))).toBeNull();
  });

  it('6. a socket drop AFTER a finish_reason is success: the answer was complete (P25)', () => {
    const drop = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    expect(classifyOpenAIOutcome(drop, ctx({ headersReceived: true, sawFinish: true }))).toBeNull();
  });

  it('a clean end with a finish reason is success (null)', () => {
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true, sawFinish: true }))).toBeNull();
  });

  it('7. anything else is rebuilt as AnalyzerTransportError: class names and a sanitized code only, no cause (P22)', () => {
    const odd = Object.assign(new RangeError('weird sk-rule7-secret-1'), { code: 'ERR_WEIRD' });
    const out = classifyOpenAIOutcome(odd, ctx({ headersReceived: true, sawFinish: true }));
    expect(out).toBeInstanceOf(AnalyzerTransportError);
    expect(out).not.toBe(odd);
    expect((out as InstanceType<typeof AnalyzerTransportError>).causeCode).toBe('ERR_WEIRD');
    expect((out as Error).message).toBe('Endpoint qwen3:30b request failed (ERR_WEIRD) (RangeError).');
    expect('cause' in (out as Error)).toBe(false);
    expect(inspect(out, { depth: 8 })).not.toContain('sk-rule7-secret-1');
  });

  it('7. an invalid header value, which undici echoes as "Bearer <key>", never surfaces the key (P22)', () => {
    const headerError = new TypeError('Headers.append: "Bearer sk-inject-secret-1\nX: y" is an invalid header value.');
    /* secrets: [] — the rebuild alone must keep the key out. */
    const out = classifyOpenAIOutcome(new APIConnectionError({ cause: headerError }), ctx({ secrets: [] }));
    expect(out).toBeInstanceOf(AnalyzerTransportError);
    expect((out as Error).message).toBe('Endpoint qwen3:30b request failed before a response (APIConnectionError <- TypeError).');
    for (const s of [(out as Error).message, (out as Error).stack ?? '', inspect(out, { depth: 8 })]) {
      expect(s).not.toContain('sk-inject-secret-1');
    }
  });

  it('7. P20: an AnalyzerReasoningOverflowError crossing the transport catch is returned unchanged, before or after headers', () => {
    const overflow = new AnalyzerReasoningOverflowError('openai', 'qwen3:30b', 512);
    expect(classifyOpenAIOutcome(overflow, ctx())).toBe(overflow);
    expect(classifyOpenAIOutcome(overflow, ctx({ headersReceived: true, sawFinish: true }))).toBe(overflow);
  });
});

describe('the classified run failure shows the cause code (#3084 P22, Q1)', () => {
  it('an injected ERR_SSL_WRONG_VERSION_NUMBER (https:// against a plain-HTTP server) reaches rule 7, and the classified failure names it', () => {
    const out = classifyOpenAIOutcome(chain('ERR_SSL_WRONG_VERSION_NUMBER'), ctx());
    expect(out).toBeInstanceOf(AnalyzerTransportError);
    expect((out as Error).message).toBe(
      'Endpoint qwen3:30b request failed before a response (ERR_SSL_WRONG_VERSION_NUMBER) (APIConnectionError <- TypeError <- Error).',
    );
    const r = classifyAnalysisFailure(out, 'Endpoint lab (qwen3:30b)');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) request failed (ERR_SSL_WRONG_VERSION_NUMBER).');
  });

  it('an injected EAI_AGAIN before headers is retried as incomplete, and the classified failure names it instead of a mid-answer drop', () => {
    const out = classifyOpenAIOutcome(chain('EAI_AGAIN'), ctx());
    expect(out).toBeInstanceOf(AnalyzerStreamIncompleteError);
    const r = classifyAnalysisFailure(out, 'Endpoint lab (qwen3:30b)');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) dropped the connection before a response (EAI_AGAIN), and retrying did not help.');
    expect(r.userMessage).not.toContain('stopped streaming');
  });
});
```
These are injected chains on purpose: a real TLS-against-HTTP socket reports `ERR_SSL_WRONG_VERSION_NUMBER` or `ERR_SSL_PACKET_LENGTH_TOO_LONG` depending on the OpenSSL build, so a real-socket case would pin the host, not the rule. The contract suite's resolver-injected `EAI_AGAIN` case below is deterministic and asserts the code too.

`server/src/analyzer/transports/openai-request-body.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildOpenAIRequestBody, endpointAutoOutputMargin, resolveEndpointMaxOutputTokens } from './openai-transport.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';
import type { TransportRequest } from '../runner/transport.js';

const endpoint = (over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint => ({
  id: 'lab',
  name: 'Lab',
  baseUrl: 'http://127.0.0.1:8080/v1',
  gpu: 'any',
  concurrency: 1,
  requestCeilingMs: 1_800_000,
  structuredOutput: 'schema',
  reasoningStyle: 'not_controllable',
  reasoning: 'model-default',
  maxOutputTokens: 0,
  contextTokens: 32_768,
  ...over,
});

const req = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  system: 's',
  messages: [{ role: 'user', content: 'u' }],
  structuredOutput: { mode: 'off' },
  temperature: 0.2,
  estimatedInputTokens: 10,
  call: {},
  ...over,
});

describe('endpoint Auto max_tokens (#3084 P24)', () => {
  it('the margin is max(1024, 10% of the context)', () => {
    expect(endpointAutoOutputMargin(8_192)).toBe(1_024);
    expect(endpointAutoOutputMargin(32_768)).toBe(3_277);
  });

  it('the engine-level cap is min(served output limit if known, context − margin); a manual value is kept', () => {
    expect(resolveEndpointMaxOutputTokens(endpoint())).toBe(29_491);
    expect(resolveEndpointMaxOutputTokens(endpoint(), 8_192)).toBe(8_192);
    expect(resolveEndpointMaxOutputTokens(endpoint({ maxOutputTokens: 4_096 }))).toBe(4_096);
  });

  it('Auto on the wire also takes the estimated input off: min(cap, context − estimated input − margin)', () => {
    const ep = endpoint();
    const cap = resolveEndpointMaxOutputTokens(ep);
    expect(buildOpenAIRequestBody(ep, 'm', req({ maxOutputTokens: cap, estimatedInputTokens: 20_000 })).max_tokens).toBe(9_491);
    expect(buildOpenAIRequestBody(ep, 'm', req({ maxOutputTokens: 8_192, estimatedInputTokens: 10 })).max_tokens).toBe(8_192);
  });

  it('never sends less than 1, and sends a manual value as resolved', () => {
    expect(buildOpenAIRequestBody(endpoint(), 'm', req({ maxOutputTokens: 29_491, estimatedInputTokens: 40_000 })).max_tokens).toBe(1);
    const manual = endpoint({ maxOutputTokens: 4_096, contextTokens: 8_192 });
    expect(buildOpenAIRequestBody(manual, 'm', req({ maxOutputTokens: 4_096, estimatedInputTokens: 6_000 })).max_tokens).toBe(4_096);
  });
});
```

`server/src/analyzer/transports/openai-transport.contract.test.ts`:
```ts
/* Transport contract suite for OpenAITransport (#3084 spec "Testing →
   Transport contract suite" + 04-openai-sdk-facts). A REAL http.createServer on
   127.0.0.1:0 and the REAL undici Agent — no fetch stub, no vi.mock('undici'),
   following ollama-timeout.test.ts. Every case asserts the error CLASS.
   Env that module-load constants read (GEMINI_RETRY_BACKOFFS_MS → BACKOFFS_MS)
   is set BEFORE the dynamic imports below. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LookupFunction } from 'node:net';
import { inspect } from 'node:util';
import { Agent } from 'undici';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';
import type { TransportRequest } from '../runner/transport.js';

process.env.GEMINI_RETRY_BACKOFFS_MS = '10,10';

const { OpenAITransport, allowlistedFetch, ANALYZER_USER_AGENT, resolveEndpointMaxOutputTokens } = await import('./openai-transport.js');
const { classifyAnalysisFailure } = await import('../../routes/failure-taxonomy.js');
const { _resetUserSettingsCache, _setUserSettingsCacheForTest } = await import('../../workspace/user-settings.js');
const { endpointSemaphore, servedModels, _resetEndpointRuntimeForTest } = await import('./endpoint-runtime.js');
const { geminiRateLimiter } = await import('../rate-limit.js');
const errors = await import('../errors.js');

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void | Promise<void>;
let server: Server | undefined;
let seen: Array<{ url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];
const agents: Agent[] = [];

async function start(handler: Handler): Promise<string> {
  seen = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      void handler(req, res, seen.length);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
}

const sse = (res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.flushHeaders();
};
const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
const DONE = 'data: [DONE]\n\n';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const endpoint = (baseUrl: string, over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint => ({
  id: 'lab',
  name: 'Lab',
  baseUrl,
  gpu: 'any',
  concurrency: 1,
  requestCeilingMs: 5_000,
  structuredOutput: 'schema',
  reasoningStyle: 'not_controllable',
  reasoning: 'model-default',
  maxOutputTokens: 0,
  contextTokens: 32_768,
  ...over,
});

const request = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  system: 'sys',
  messages: [{ role: 'user', content: 'go' }],
  structuredOutput: { mode: 'json' },
  temperature: 0.2,
  maxOutputTokens: undefined,
  estimatedInputTokens: 10,
  call: {},
  ...over,
});

const transport = (baseUrl: string, over: Partial<AnalyzerEndpoint> = {}, apiKey: string | null = null, dispatcher?: Agent) =>
  new OpenAITransport({ endpoint: endpoint(baseUrl, over), apiKey, model: 'qwen3:30b', dispatcher });

const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeAll(() => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
});
afterAll(() => {
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
  delete process.env.GEMINI_RETRY_BACKOFFS_MS;
});
beforeEach(() => {
  _resetEndpointRuntimeForTest();
  geminiRateLimiter._reset();
});
afterEach(async () => {
  delete process.env.GEMINI_STREAM_IDLE_MS;
  await Promise.all(agents.splice(0).map((a) => a.destroy()));
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

describe('OpenAITransport — streamed success', () => {
  it('streams answer text, maps finish_reason stop, reads usage, and sends the wire body', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.write(chunk({ role: 'assistant', content: '{"a":' }));
      res.write(chunk({ content: '1}' }));
      res.write(chunk({}, 'stop'));
      res.write(chunk({}, null, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 } } }));
      res.end(DONE);
    });
    const received: number[] = [];
    const r = await transport(url).send(
      request({
        maxOutputTokens: resolveEndpointMaxOutputTokens(endpoint(url)),
        call: { onChunk: (i) => received.push(i.receivedBytes) },
      }),
    );
    expect(r).toMatchObject({ text: '{"a":1}', finish: 'stop', reasoningSeen: false, usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 0 } });
    expect(received).toEqual([5, 7]);
    expect(seen[0].url).toBe('/v1/chat/completions');
    expect(seen[0].body).toMatchObject({
      model: 'qwen3:30b',
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }],
      /* P24: min(32 768 − 3 277, 32 768 − 10 − 3 277) */
      max_tokens: 29_481,
    });
    expect(servedModels('lab')).toEqual(['qwen3:30b']);
  });

  describe('served models for the {model} unload URL (#3084 P3)', () => {
    const okStream = (res: ServerResponse) => {
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    };

    it('a call that fails with a 5xx still records its model: the request was sent, so the server may hold it (N2)', async () => {
      const url = await start((_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model failed to load' } }));
      });
      await failure(transport(url).send(request()));
      expect(servedModels('lab')).toEqual(['qwen3:30b']);
    });

    it('a model is recorded as soon as its request is sent, before any response (N2)', async () => {
      let onReceived!: () => void;
      const received = new Promise<void>((r) => (onReceived = r));
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const url = await start((_req, res) => {
        onReceived();
        void held.then(() => okStream(res));
      });
      const pending = transport(url).send(request());
      await received;
      expect(servedModels('lab')).toEqual(['qwen3:30b']);
      release();
      await pending;
    });

    it('a call aborted while queued on the endpoint semaphore records nothing', async () => {
      const url = await start((_req, res) => okStream(res));
      const holder = await endpointSemaphore(endpoint(url)).acquire();
      const controller = new AbortController();
      const pending = failure(transport(url).send(request({ signal: controller.signal })));
      await sleep(30);
      controller.abort();
      expect(await pending).toBeInstanceOf(errors.AnalysisAbortedError);
      holder();
      expect(seen).toHaveLength(0);
      expect(servedModels('lab')).toEqual([]);
    });

    it('two models sent to one endpoint are both recorded', async () => {
      const url = await start((_req, res) => okStream(res));
      await new OpenAITransport({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).send(request());
      await new OpenAITransport({ endpoint: endpoint(url), apiKey: null, model: 'gemma3:12b' }).send(request());
      expect(servedModels('lab')).toEqual(['qwen3:30b', 'gemma3:12b']);
    });

    it("a Test's own transport records its model too, so a {model} unload can name it (N2)", async () => {
      /* PR 3c builds the Test transport the same way, with no opt-out flag: a Test leaves the
         model loaded on the server, so the unload URL needs its name. */
      const url = await start((_req, res) => okStream(res));
      await new OpenAITransport({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).send(request());
      expect(seen).toHaveLength(1);
      expect(servedModels('lab')).toEqual(['qwen3:30b']);
    });
  });

  it('maps finish_reason length', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":' }, 'length'));
      res.end(DONE);
    });
    expect(await transport(url).send(request())).toMatchObject({ finish: 'length', text: '{"a":' });
  });

  it('schema mode sends json_schema with strict false', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    const schema = { type: 'object' };
    await transport(url).send(request({ structuredOutput: { mode: 'schema', name: 'castwright_1-ch1', schema } }));
    expect(seen[0].body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'castwright_1-ch1', schema, strict: false } });
  });
});

describe('OpenAITransport — unreachable', () => {
  /* Host-independent DNS: the resolver's answer is injected through connect.lookup,
     which undici spreads into net.connect (undici/lib/core/connect.js:108-128). No
     machine's resolver can turn ENOTFOUND into EAI_AGAIN here. */
  const resolverAgent = (code: 'ENOTFOUND' | 'EAI_AGAIN', counter: { lookups: number }): Agent => {
    const lookup: LookupFunction = (hostname, _options, callback) => {
      counter.lookups += 1;
      callback(Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), { code, syscall: 'getaddrinfo', hostname }), []);
    };
    const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000, lookup } });
    agents.push(agent);
    return agent;
  };

  it('a refused port → AnalyzerUnreachableError', async () => {
    const url = await start(() => {});
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(await failure(transport(url).send(request()))).toBeInstanceOf(errors.AnalyzerUnreachableError);
  });

  it('an unresolvable host (ENOTFOUND injected through the resolver) → AnalyzerUnreachableError', async () => {
    const counter = { lookups: 0 };
    const err = await failure(transport('http://castwright-unresolvable.test/v1', {}, null, resolverAgent('ENOTFOUND', counter)).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(counter.lookups).toBeGreaterThanOrEqual(1);
  });

  it('a DNS hiccup before headers (EAI_AGAIN injected) → retried, then AnalyzerStreamIncompleteError, never unreachable (P21)', async () => {
    const counter = { lookups: 0 };
    const err = await failure(transport('http://castwright-unresolvable.test/v1', {}, null, resolverAgent('EAI_AGAIN', counter)).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(counter.lookups).toBeGreaterThanOrEqual(3);
    /* Q1 — the code survives the retries into the message and the classified failure. */
    expect((err as Error).message).toContain('before a response (EAI_AGAIN)');
    expect(classifyAnalysisFailure(err, 'Endpoint lab (m)').userMessage).toContain('(EAI_AGAIN)');
  });

  it('a server that accepts the connection and closes the socket before writing headers → retried, then AnalyzerStreamIncompleteError, never unreachable (P21)', async () => {
    /* A REAL socket: the request reaches the server, which destroys the socket without
       writing a status line. undici reports SocketError UND_ERR_SOCKET "other side closed". */
    const url = await start((req) => {
      req.socket.destroy();
    });
    const err = await failure(transport(url).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(seen).toHaveLength(3);
  });

  it('an unroutable address with a short connect timeout → AnalyzerUnreachableError', async () => {
    /* Not port 9: undici refuses it immediately as a "bad port" (research fact 10). */
    const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 1_500 } });
    agents.push(agent);
    expect(await failure(transport('http://10.255.255.1:8080/v1', {}, null, agent).send(request()))).toBeInstanceOf(
      errors.AnalyzerUnreachableError,
    );
  }, 10_000);
});

describe('OpenAITransport — timeouts and the ceiling', () => {
  it('a post-connect stall with no headers ends at the ceiling → AnalyzerTimeoutError, semaphore released', async () => {
    const url = await start(() => {});
    const t = transport(url, { requestCeilingMs: 400 });
    const err = await failure(t.send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerTimeoutError);
    expect((err as InstanceType<typeof errors.AnalyzerTimeoutError>).reason).toBe('ceiling');
    expect(endpointSemaphore(endpoint(url)).inFlight).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('a long silent prefill (headers after 1.5 s) completes before the ceiling', async () => {
    const url = await start(async (_req, res) => {
      await sleep(1_500);
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    expect(await transport(url, { requestCeilingMs: 5_000 }).send(request())).toMatchObject({ text: '{}', finish: 'stop' });
  });

  it('CONTROL: the same prefill against a 300 ms headersTimeout Agent is a connect-timeout, never unreachable', async () => {
    const url = await start(async (_req, res) => {
      await sleep(1_500);
      if (res.destroyed) return;
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    const agent = new Agent({ headersTimeout: 300, bodyTimeout: 0, connect: { timeout: 10_000 } });
    agents.push(agent);
    const err = await failure(transport(url, {}, null, agent).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerTimeoutError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
  });

  it('headers then silence: the ceiling ends it → AnalyzerTimeoutError, semaphore released', async () => {
    const url = await start((_req, res) => sse(res));
    const err = await failure(transport(url, { requestCeilingMs: 500 }).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerTimeoutError);
    expect(endpointSemaphore(endpoint(url)).inFlight).toBe(0);
  });

  it('ceiling time is not charged while the call waits on the endpoint semaphore', async () => {
    const url = await start(async (_req, res, n) => {
      await sleep(n === 1 ? 450 : 300);
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    const t = transport(url, { concurrency: 1, requestCeilingMs: 600 });
    const results = await Promise.all([t.send(request()), t.send(request())]);
    expect(results.map((r) => r.finish)).toEqual(['stop', 'stop']);
  });
});

describe('OpenAITransport — aborts, incomplete streams, in-stream errors', () => {
  it('a caller abort mid-stream → AnalysisAbortedError, partial text never returned', async () => {
    const url = await start(async (_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"partial":' }));
      await sleep(2_000);
      if (!res.destroyed) res.end(chunk({ content: '1}' }, 'stop') + DONE);
    });
    const ac = new AbortController();
    const err = await failure(
      transport(url).send(request({ signal: ac.signal, call: { onChunk: () => ac.abort() } })),
    );
    expect(err).toBeInstanceOf(errors.AnalysisAbortedError);
  });

  it('a stream that closes without finish_reason → AnalyzerStreamIncompleteError after 3 attempts', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":1' }));
      res.end();
    });
    expect(await failure(transport(url).send(request()))).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
    expect(seen).toHaveLength(3);
  });

  it('a socket dropped mid-stream → AnalyzerStreamIncompleteError (retried)', async () => {
    const url = await start(async (_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":' }));
      await sleep(30);
      res.destroy();
    });
    expect(await failure(transport(url).send(request()))).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
    expect(seen).toHaveLength(3);
  });

  it('an in-stream error event → AnalyzerHttpError(0), not retried', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.write(chunk({ content: 'partial' }));
      res.end(`data: ${JSON.stringify({ error: { message: 'context exceeded', type: 'exceed_context_size_error', code: 400 } })}\n\n`);
    });
    const err = await failure(transport(url).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
    expect((err as InstanceType<typeof errors.AnalyzerHttpError>).httpStatus).toBe(0);
    expect(seen).toHaveLength(1);
  });
});

describe('OpenAITransport — HTTP statuses', () => {
  const jsonError = (res: ServerResponse, status: number, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: { message: `bad thing ${status}`, type: 'invalid_request_error' } }));
  };

  it.each([400, 401])('%i → AnalyzerHttpError with that status and the body excerpt, not retried', async (status) => {
    const url = await start((_req, res) => jsonError(res, status));
    const err = await failure(transport(url).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
    expect((err as InstanceType<typeof errors.AnalyzerHttpError>).httpStatus).toBe(status);
    expect((err as InstanceType<typeof errors.AnalyzerHttpError>).bodyExcerpt).toContain(`bad thing ${status}`);
    expect(seen).toHaveLength(1);
  });

  it('503 is retried and a later success returns', async () => {
    const url = await start((_req, res, n) => {
      if (n === 1) return jsonError(res, 503);
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    expect(await transport(url).send(request())).toMatchObject({ finish: 'stop' });
    expect(seen).toHaveLength(2);
  });

  it('429 with retry-after is retried and a later success returns', async () => {
    const url = await start((_req, res, n) => {
      if (n === 1) return jsonError(res, 429, { 'retry-after': '0' });
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    expect(await transport(url).send(request())).toMatchObject({ finish: 'stop' });
    expect(seen).toHaveLength(2);
  });

  it('a 502 whose body carries code ECONNREFUSED → AnalyzerHttpError(502) after the 5xx retries, never AnalyzerUnreachableError (P21)', async () => {
    const url = await start((_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'ECONNREFUSED', message: 'upstream down' } }));
    });
    const err = await failure(transport(url).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect((err as InstanceType<typeof errors.AnalyzerHttpError>).httpStatus).toBe(502);
    expect(seen).toHaveLength(3);
  });

  it('a 500 whose message is "fetch failed" → AnalyzerHttpError(500), never AnalyzerUnreachableError (P21)', async () => {
    const url = await start((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fetch failed' } }));
    });
    const err = await failure(transport(url).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect((err as InstanceType<typeof errors.AnalyzerHttpError>).httpStatus).toBe(500);
  });

  it('a 503 body echoing the endpoint key and the saved Gemini key: neither reaches the error, the classified failure or any log line (P22)', async () => {
    const savedEnvKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    _setUserSettingsCacheForTest({ geminiApiKey: 'AIzaSy-echo-secret-9876' });
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
      }),
    );
    try {
      const url = await start((_req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream refused sk-echo-secret-1234 and AIzaSy-echo-secret-9876' } }));
      });
      const err = await failure(transport(url, {}, 'sk-echo-secret-1234').send(request()));
      expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
      /* What the analysis route does with it: `[analysis] failed` logs the error's name,
         message and status (routes/analysis.ts:6433-6443), then classifyAnalysisFailure
         builds the SSE error event and the saved chapter error. Both read only what is
         asserted below. `lines` holds only what the code under test logged. */
      const classified = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
      const surfaces = [
        (err as Error).message,
        (err as InstanceType<typeof errors.AnalyzerHttpError>).bodyExcerpt,
        inspect(err, { depth: 8 }),
        classified.userMessage,
        classified.detail ?? '',
        classified.remediation,
        ...lines,
      ];
      for (const s of surfaces) {
        expect(s).not.toContain('sk-echo-secret-1234');
        expect(s).not.toContain('AIzaSy-echo-secret-9876');
      }
      expect((err as Error).message).toContain('[redacted]');
      /* A line the code under test wrote: withTransportRetry's 5xx retry line (W1 Task 1.9,
         `[${logTag}] transient ${describeStatus(err)} — retrying …`, logTag `openai:lab`).
         The loop above proved no line — this one included — carries either key. */
      expect(lines.some((l) => l.startsWith('[openai:lab] transient '))).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
      _resetUserSettingsCache();
      if (savedEnvKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedEnvKey;
    }
  });
});

describe('OpenAITransport — reasoning deltas and the idle watchdog', () => {
  it.each([
    [{ reasoning_content: 'thinking' }],
    [{ reasoning: 'thinking' }],
    [{ reasoning_details: [{ type: 'reasoning.text', text: 'thinking' }] }],
  ])('%j keeps the watchdog alive, feeds the heartbeat with the answer bytes unchanged, sets reasoningSeen, and never enters the text', async (delta) => {
    process.env.GEMINI_STREAM_IDLE_MS = '300';
    const url = await start(async (_req, res) => {
      sse(res);
      for (let i = 0; i < 4; i += 1) {
        res.write(chunk(delta));
        await sleep(200);
      }
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    const beats: Array<{ bytes: number; text: string }> = [];
    const r = await transport(url).send(
      request({ call: { onChunk: (i) => beats.push({ bytes: i.receivedBytes, text: i.receivedText }) } }),
    );
    expect(r).toMatchObject({ text: '{}', reasoningSeen: true, finish: 'stop' });
    /* Spec §1: reasoning deltas feed the route heartbeat — same convention as
       wave 2's Gemini thought-only chunk: onChunk fires, answer bytes unchanged. */
    expect(beats).toEqual([
      { bytes: 0, text: '' },
      { bytes: 0, text: '' },
      { bytes: 0, text: '' },
      { bytes: 0, text: '' },
      { bytes: 2, text: '{}' },
    ]);
    expect(seen).toHaveLength(1);
  });

  it('silence past the idle window after the first delta → AnalyzerStreamIncompleteError', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '300';
    const url = await start(async (_req, res) => {
      sse(res);
      res.write(chunk({ content: '{' }));
      await sleep(1_500);
      if (!res.destroyed) res.end(chunk({ content: '}' }, 'stop') + DONE);
    });
    expect(await failure(transport(url).send(request()))).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
  });

  it('a finish_reason, then silence past the idle window before [DONE]: the answer is returned, not retried (P25)', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '300';
    const url = await start(async (_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":1}' }));
      res.write(chunk({}, 'stop'));
      await sleep(1_500);
      if (!res.destroyed) res.end(DONE);
    });
    expect(await transport(url).send(request())).toMatchObject({ text: '{"a":1}', finish: 'stop' });
    expect(seen).toHaveLength(1);
  });

  it('a finish_reason, then the socket drops before [DONE]: the answer is returned, not retried (P25)', async () => {
    const url = await start(async (_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":1}' }));
      res.write(chunk({}, 'stop'));
      await sleep(50);
      res.destroy();
    });
    expect(await transport(url).send(request())).toMatchObject({ text: '{"a":1}', finish: 'stop' });
    expect(seen).toHaveLength(1);
  });
});

describe('OpenAITransport — credentials', () => {
  it('sends the key as a Bearer token', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    await transport(url, {}, 'sk-contract-1234').send(request());
    expect(seen[0].headers.authorization).toBe('Bearer sk-contract-1234');
  });

  it('sends no Authorization header without a key, and none of the host OPENAI_API_KEY / org / project', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-leak-1234';
    process.env.OPENAI_ORG_ID = 'org-leak';
    process.env.OPENAI_PROJECT_ID = 'proj-leak';
    try {
      const url = await start((_req, res) => {
        sse(res);
        res.end(chunk({ content: '{}' }, 'stop') + DONE);
      });
      await transport(url).send(request());
      expect(seen[0].headers.authorization).toBeUndefined();
      expect(seen[0].headers['openai-organization']).toBeUndefined();
      expect(seen[0].headers['openai-project']).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_ORG_ID;
      delete process.env.OPENAI_PROJECT_ID;
    }
  });

  it('OPENAI_CUSTOM_HEADERS in the host env never reaches the wire; the endpoint key does (P22)', async () => {
    /* The SDK merges this env into every request after its own auth header (client.mjs:240-249). */
    process.env.OPENAI_CUSTOM_HEADERS = 'Authorization: Bearer stolen\nX-Leak: 1';
    try {
      const url = await start((_req, res) => {
        sse(res);
        res.end(chunk({ content: '{}' }, 'stop') + DONE);
      });
      await transport(url, {}, 'sk-contract-1234').send(request());
      await transport(url).send(request());
      expect(seen).toHaveLength(2);
      expect(seen[0].headers.authorization).toBe('Bearer sk-contract-1234');
      expect(seen[1].headers.authorization).toBeUndefined();
      for (const s of seen) expect(s.headers['x-leak']).toBeUndefined();
    } finally {
      delete process.env.OPENAI_CUSTOM_HEADERS;
    }
  });

  it('allowlistedFetch sends the key only to the origin it was resolved for, and drops a caller-supplied Authorization (P22)', async () => {
    const url = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await allowlistedFetch('sk-origin-1234', 'http://127.0.0.1:1')(`${url}/models`, {
      headers: { authorization: 'Bearer sk-origin-1234', 'x-leak': '1' },
    });
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers['x-leak']).toBeUndefined();
    await allowlistedFetch('sk-origin-1234', new URL(url).origin)(`${url}/models`, {});
    expect(seen[1].headers.authorization).toBe('Bearer sk-origin-1234');
  });

  it('sends only the fixed accept, content-type and user-agent values and no x-stainless-* header, whatever OPENAI_CUSTOM_HEADERS says (P22)', async () => {
    process.env.OPENAI_CUSTOM_HEADERS = 'X-Stainless-Lang: evil\nUser-Agent: evil\nAccept: evil';
    try {
      const url = await start((_req, res) => {
        sse(res);
        res.end(chunk({ content: '{}' }, 'stop') + DONE);
      });
      await transport(url).send(request());
      const h = seen[0].headers;
      expect(ANALYZER_USER_AGENT).toBe('castwright-analyzer');
      expect(h['user-agent']).toBe('castwright-analyzer');
      expect(h.accept).toBe('application/json');
      expect(h['content-type']).toBe('application/json');
      expect(Object.keys(h).filter((name) => name.startsWith('x-stainless-'))).toEqual([]);
      expect(Object.values(h).join('\n')).not.toContain('evil');
    } finally {
      delete process.env.OPENAI_CUSTOM_HEADERS;
    }
  });

  it('a saved key the HTTP client rejects as a header value (a line break, saved before the write rule) never surfaces in the thrown error, inspect() or the classified failure (P22)', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    /* undici throws `Headers.append: "Bearer <key>" is an invalid header value.` before
       dispatching; the SDK wraps it as APIConnectionError's cause (client.mjs:817-820). */
    const err = await failure(transport(url, {}, 'sk-inject-secret-1\nX-Injected: 1').send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerTransportError);
    expect(seen).toHaveLength(0);
    const classified = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
    for (const s of [(err as Error).message, (err as Error).stack ?? '', inspect(err, { depth: 8 }), classified.userMessage, classified.detail ?? '']) {
      expect(s).not.toContain('sk-inject-secret-1');
    }
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npm --prefix server run test -- src/analyzer/transports/openai-outcome.test.ts src/analyzer/transports/openai-request-body.test.ts src/analyzer/transports/openai-transport.contract.test.ts`

Expected: all three FAIL with `Failed to resolve import "./openai-transport.js"`.

- [ ] **Step 4: Implement**

`server/src/analyzer/transports/openai-transport.ts`:
```ts
/* OpenAI Chat Completions transport for named endpoints (#3084 decisions
   1b, 1c; research 04-openai-sdk-facts; planning facts §A).

   Client: the official `openai` SDK with `fetch` built on undici.fetch (Node's
   global fetch rejects an npm-undici Agent) and a long-call dispatcher (no header
   or body timeout, 10 s connect), SDK retries off, SDK logging off. The SDK DOES
   read OPENAI_* environment variables when it is constructed: it merges
   OPENAI_CUSTOM_HEADERS into every request after its auth header (client.mjs:240-249).
   Every option it would take from env is passed explicitly, and allowlistedFetch
   rebuilds the outgoing headers from an allowlist, so no host env header reaches
   an endpoint and the key goes only to its own origin (P22).

   Signals: the absolute ceiling is AbortSignal.timeout(requestCeilingMs),
   created AFTER the endpoint semaphore is acquired, so queue time is never
   charged to the request. The idle watchdog arms on the first delta (answer
   OR reasoning). The SDK ends a stream SILENTLY on abort (openai
   core/streaming.ts:171-186), so a clean loop end is never trusted:
   classifyOpenAIOutcome decides from our own signals. */

import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { Agent } from 'undici';
import type {
  ChatTransport,
  StructuredOutputRequest,
  TransportRequest,
  TransportResult,
  TransportUsage,
} from '../runner/transport.js';
import { withTransportRetry, type RetryClassifier } from '../runner/transport-retry.js';
import {
  AnalysisAbortedError,
  AnalyzerHttpError,
  AnalyzerKeyOriginError,
  AnalyzerReasoningOverflowError,
  AnalyzerStreamIncompleteError,
  AnalyzerTimeoutError,
  AnalyzerTransportError,
  AnalyzerUnreachableError,
  causeCodeSuffix,
  sanitizeCauseCode,
} from '../errors.js';
import { analyzerRateLimiter } from '../rate-limit.js';
import { appendBounded, BACKOFFS_MS, resolveStreamIdleTimeoutMs } from '../gemini.js';
import { endpointModelId } from '../model-id.js';
import { endpointSemaphore, noteEndpointModelUsed } from './endpoint-runtime.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';
/* #3084 A9 — through the leaf gate: no import edge to workspace/user-settings.ts. */
import { loadKnownAnalyzerSecrets } from '../known-secrets-gate.js';
import { allowlistedFetch } from './allowlisted-fetch.js';
import { redactKnownSecrets } from '../redact.js';

type OpenAIClientOptions = NonNullable<ConstructorParameters<typeof OpenAI>[0]>;

/** #3084 P21 — connect-phase codes only: nothing on the other side was reached.
    Not ollama.ts's UNREACHABLE_CODES: its ECONNRESET, UND_ERR_SOCKET and EAI_AGAIN
    can come from an endpoint that is up (a reset before headers, a DNS hiccup), so
    for an endpoint they are OPENAI_PRE_HEADER_TRANSIENT_CODES instead. EHOSTUNREACH
    and ENETUNREACH: an unroutable address returns one of these or the connect
    timeout, depending on the host's routing table. */
export const OPENAI_UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** #3084 P21 — before headers, these mean "retry", never "fall back to Gemini". */
export const OPENAI_PRE_HEADER_TRANSIENT_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN']);

/* A llama.cpp request queued behind a busy slot gets no headers until a slot
   frees, and a long prefill streams nothing — both are bounded by the
   endpoint ceiling, never by the dispatcher. */
export const OPENAI_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });

/* #3084 P22 — allowlistedFetch lives in the leaf ./allowlisted-fetch.ts, so PR 3c's
   catalog listing, preview and served-limits clients import it without closing a
   transport → served-limits → catalog → transport cycle. Re-exported here for this
   module's tests and importers. */
export { allowlistedFetch, ANALYZER_USER_AGENT } from './allowlisted-fetch.js';

function causeChain(err: unknown): Array<{ code?: unknown; message?: unknown }> {
  const out: Array<{ code?: unknown; message?: unknown }> = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== null && typeof cur === 'object' && depth <= 4; depth += 1) {
    out.push(cur as { code?: unknown; message?: unknown });
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

export interface OutcomeContext {
  callerAborted: boolean;
  ceilingAborted: boolean;
  idleAborted: boolean;
  /** true once create() resolved — the SDK returns the Stream only after headers */
  headersReceived: boolean;
  sawFinish: boolean;
  elapsedMs: number;
  model: string;
  /** P22: redacted from every error this builds (the endpoint's key and every saved analyzer secret) */
  secrets: readonly string[];
}

/* Rule 7 (P20, P22) — our own analyzer errors pass through unchanged; the routes rethrow
   a reasoning overflow to stop the run. Anything else is rebuilt. */
function isOwnAnalyzerError(err: unknown): boolean {
  return (
    err instanceof AnalyzerReasoningOverflowError ||
    err instanceof AnalysisAbortedError ||
    err instanceof AnalyzerTimeoutError ||
    err instanceof AnalyzerHttpError ||
    err instanceof AnalyzerUnreachableError ||
    err instanceof AnalyzerStreamIncompleteError ||
    err instanceof AnalyzerTransportError ||
    err instanceof AnalyzerKeyOriginError
  );
}

/* The class names down the cause chain (the openai SDK's error classes set no `name`,
   so the constructor's name is read), each reduced to letters and digits. Never a
   message: upstream text can hold a header value, and so a key (P22). */
function chainClassNames(err: unknown): string {
  const names: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== null && typeof cur === 'object' && depth <= 4; depth += 1) {
    const ctorName = (cur as { constructor?: { name?: unknown } }).constructor?.name;
    names.push(typeof ctorName === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(ctorName) ? ctorName : 'Error');
    cur = (cur as { cause?: unknown }).cause;
  }
  return names.length > 0 ? names.join(' <- ') : typeof err;
}

/** Decision 1c classification. `err` is undefined after a loop that ended
    without throwing. Returns null for a genuine success. */
export function classifyOpenAIOutcome(err: unknown, ctx: OutcomeContext): Error | null {
  if (ctx.callerAborted) {
    return new AnalysisAbortedError(`Endpoint ${ctx.model} call aborted (paused or client disconnected).`);
  }
  const chain = err === undefined ? [] : causeChain(err);
  const codes = chain.map((c) => c.code).filter((c): c is string => typeof c === 'string');
  /* P21 — only a connection-level failure can be "unreachable". An APIError with an
     HTTP status was built after the response arrived and carries the body's error.code
     (openai core/error.mjs:12, :35-65): a proxy's 502 reporting ECONNREFUSED is an
     answer, not an outage, and must never reach FallbackAnalyzer. */
  const connectionLevel =
    !isOwnAnalyzerError(err) &&
    (err instanceof APIConnectionError || (err !== undefined && !(err instanceof APIError) && !ctx.headersReceived));
  if (connectionLevel) {
    const unreachableCode = codes.find((c) => OPENAI_UNREACHABLE_CODES.has(c));
    const bareFetchFailed =
      codes.length === 0 && chain.some((c) => typeof c.message === 'string' && /fetch failed/i.test(c.message));
    if (unreachableCode || bareFetchFailed) {
      /* P22 — rebuilt: no `cause` (the SDK error and its chain stay behind), only the
         sanitized code. */
      return Object.assign(
        new AnalyzerUnreachableError(`Endpoint ${ctx.model} is unreachable (${unreachableCode ?? 'fetch failed'}).`, 'openai'),
        { causeCode: sanitizeCauseCode(unreachableCode, ctx.secrets) },
      );
    }
    /* P21 — a reset or a DNS hiccup before headers comes from a server that may be up:
       retried as an incomplete stream, so FallbackAnalyzer never sees it. P22, Q1 — it
       carries the sanitized transient code into its message. */
    const transientCode = ctx.headersReceived ? undefined : codes.find((c) => OPENAI_PRE_HEADER_TRANSIENT_CODES.has(c));
    if (transientCode) {
      return new AnalyzerStreamIncompleteError('openai', ctx.model, { causeCode: sanitizeCauseCode(transientCode, ctx.secrets) });
    }
  }
  if (ctx.ceilingAborted) return new AnalyzerTimeoutError('openai', ctx.model, ctx.elapsedMs, 'ceiling');
  if (err instanceof APIConnectionTimeoutError) {
    return new AnalyzerTimeoutError('openai', ctx.model, ctx.elapsedMs, 'connect-timeout');
  }
  if (err instanceof APIError && !(err instanceof APIConnectionError) && !(err instanceof APIUserAbortError)) {
    const status = typeof err.status === 'number' ? err.status : 0;
    /* P22 — redact BEFORE truncating, so a key the slice would cut in half cannot survive. */
    const excerpt = redactKnownSecrets(JSON.stringify(err.error ?? err.message), ctx.secrets).slice(0, 500);
    const httpError = new AnalyzerHttpError(
      'openai',
      status,
      excerpt,
      `Endpoint ${ctx.model} returned ${status === 0 ? 'an error event mid-stream' : status}: ${excerpt}`,
    );
    /* The raw SDK error is NOT attached as `cause`: it holds the unredacted body, and a
       logged error prints its cause chain. Only the retry hint travels. */
    return Object.assign(httpError, { retryAfterMs: retryAfterMs(err.headers as Headers | undefined) });
  }
  if (ctx.headersReceived) {
    const socketDrop =
      err !== undefined &&
      chain.some(
        (c) => c.code === 'UND_ERR_SOCKET' || c.code === 'ECONNRESET' || (typeof c.message === 'string' && /terminated/i.test(c.message)),
      );
    /* P25 — a finish_reason means the answer is complete. A watchdog that fires, or a
       socket that drops, while waiting for the trailing usage chunk or [DONE] must not
       retry a finished answer away. */
    if (ctx.sawFinish && ((ctx.idleAborted && (err === undefined || err instanceof APIUserAbortError)) || socketDrop)) {
      return null;
    }
    if (ctx.idleAborted || socketDrop || (err === undefined && !ctx.sawFinish)) {
      return new AnalyzerStreamIncompleteError('openai', ctx.model);
    }
  }
  if (err === undefined) return null;
  if (isOwnAnalyzerError(err)) return err as Error;
  /* P22 — never rethrow the SDK's error or keep its cause: undici's header errors embed
     the header value (`Headers.append: "Bearer <key>" is an invalid header value.`), and
     a logged error prints its whole cause chain. */
  /* Q1 — the sanitized code goes in the message too (causeCodeSuffix, the same ` (CODE)`
     shape as PR 3c's catalog listing error), so the run failure, the log and the Test
     action all show it. */
  const causeCode = sanitizeCauseCode(codes[0], ctx.secrets);
  return new AnalyzerTransportError(
    'openai',
    ctx.model,
    `Endpoint ${ctx.model} request failed${ctx.headersReceived ? '' : ' before a response'}${causeCodeSuffix(causeCode)} (${chainClassNames(err)}).`,
    causeCode,
  );
}

function retryAfterMs(headers: Headers | undefined): number | null {
  const ms = headers?.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const value = headers?.get('retry-after');
  if (!value) return null;
  if (Number.isFinite(Number(value))) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export const OPENAI_RETRY_CLASSIFIER: RetryClassifier = {
  classify(err) {
    if (err instanceof AnalysisAbortedError) return 'abort';
    if (err instanceof AnalyzerStreamIncompleteError) return 'idle';
    if (err instanceof AnalyzerHttpError) {
      if (err.httpStatus === 429) return 'rate-limit';
      if ([500, 502, 503, 504].includes(err.httpStatus)) return 'server-error';
    }
    return 'no-retry';
  },
  retryAfterMs(err) {
    /* Set by classifyOpenAIOutcome from the SDK error's headers (no raw cause is kept, P22). */
    const value = (err as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof value === 'number' ? value : null;
  },
};

export function openAIResponseFormat(so: StructuredOutputRequest): { response_format?: Record<string, unknown> } {
  if (so.mode === 'schema') {
    return { response_format: { type: 'json_schema', json_schema: { name: so.name, schema: so.schema, strict: false } } };
  }
  if (so.mode === 'json') return { response_format: { type: 'json_object' } };
  return {};
}

/** #3084 P24 — the margin endpoint Auto leaves between prompt + output and the
    served context: max(1024, 10% of contextTokens). The input size is an estimate,
    not a tokenizer count, and strict servers (vLLM) reject a prompt plus
    max_tokens above the served context. */
export function endpointAutoOutputMargin(contextTokens: number): number {
  return Math.max(1024, Math.ceil(contextTokens * 0.1));
}

/** #3084 P24 — the engine-level output cap OpenAIAnalyzer resolves into
    EngineRequestSettings.maxOutputTokens, a number (wave 2b resolves every engine's
    cap). A manual value is returned as saved; PR 3c clamps it to the served limit.
    Auto returns min(served output limit if known, contextTokens − margin). The
    request builder then takes each request's estimated input off Auto. */
export function resolveEndpointMaxOutputTokens(endpoint: AnalyzerEndpoint, servedOutputLimit?: number): number {
  if (endpoint.maxOutputTokens > 0) return endpoint.maxOutputTokens;
  const contextBound = Math.max(1, endpoint.contextTokens - endpointAutoOutputMargin(endpoint.contextTokens));
  return servedOutputLimit !== undefined ? Math.min(servedOutputLimit, contextBound) : contextBound;
}

/** Reasoning / extraParams: wave 5. */
export function buildOpenAIRequestBody(
  endpoint: AnalyzerEndpoint,
  model: string,
  req: TransportRequest,
): Record<string, unknown> {
  /* P24 — Auto (endpoint.maxOutputTokens 0) sends
     min(resolved cap, contextTokens − estimated input − margin), never below 1.
     A manual value is sent as resolved. */
  const perRequestBound = Math.max(
    1,
    endpoint.contextTokens - req.estimatedInputTokens - endpointAutoOutputMargin(endpoint.contextTokens),
  );
  const maxTokens =
    endpoint.maxOutputTokens > 0 && req.maxOutputTokens !== undefined
      ? req.maxOutputTokens
      : Math.min(req.maxOutputTokens ?? perRequestBound, perRequestBound);
  return {
    model,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
    stream: true,
    stream_options: { include_usage: true },
    temperature: req.temperature,
    max_tokens: maxTokens,
    ...openAIResponseFormat(req.structuredOutput),
  };
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; reasoning_details?: unknown[] | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null;
}

function mapFinishReason(reason: string): { finish: TransportResult['finish']; blockReason?: string } {
  if (reason === 'length') return { finish: 'length' };
  if (reason === 'content_filter') return { finish: 'blocked', blockReason: reason };
  return { finish: 'stop' };
}

export class OpenAITransport implements ChatTransport {
  readonly kind = 'openai' as const;
  readonly model: string;
  private readonly endpoint: AnalyzerEndpoint;
  private readonly client: OpenAI;
  private readonly now: () => number;
  /** P22: this endpoint's key, redacted from every error the transport builds. PR 3c's
      prepare() also reads it (w3cd Task 3c.9 must not add the field a second time). */
  private readonly apiKey: string | null;

  constructor(opts: { endpoint: AnalyzerEndpoint; apiKey: string | null; model: string; dispatcher?: Agent; now?: () => number }) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.now = opts.now ?? Date.now;
    this.apiKey = opts.apiKey;
    this.client = new OpenAI({
      baseURL: opts.endpoint.baseUrl,
      /* A placeholder only: the SDK requires a string and would otherwise read
         OPENAI_API_KEY. allowlistedFetch drops the Authorization header the SDK
         builds from it and adds the real key, on its own origin only (P22). */
      apiKey: 'castwright-placeholder-key',
      organization: null,
      project: null,
      maxRetries: 0,
      timeout: opts.endpoint.requestCeilingMs,
      logLevel: 'off',
      fetch: allowlistedFetch(opts.apiKey, new URL(opts.endpoint.baseUrl).origin) as unknown as OpenAIClientOptions['fetch'],
      fetchOptions: { dispatcher: opts.dispatcher ?? OPENAI_DISPATCHER } as unknown as OpenAIClientOptions['fetchOptions'],
    });
  }

  async send(req: TransportRequest): Promise<TransportResult> {
    return withTransportRetry(() => this.attempt(req), {
      model: endpointModelId(this.endpoint.id, this.model),
      limiter: analyzerRateLimiter,
      estimatedInputTokens: req.estimatedInputTokens,
      classifier: OPENAI_RETRY_CLASSIFIER,
      signal: req.signal,
      onThrottle: req.call.onThrottle,
      maxAttempts: 3,
      maxTotalMs: this.endpoint.requestCeilingMs,
      backoffsMs: BACKOFFS_MS,
      /* W1's withTransportRetry requires both: the log prefix and the name in its
         "retry budget exhausted" error. Neither carries a key. */
      logTag: `openai:${this.endpoint.id}`,
      displayName: `Endpoint ${this.endpoint.name}`,
      recordActualTokens: (r) => r.usage?.inputTokens,
    });
  }

  private async attempt(req: TransportRequest): Promise<TransportResult> {
    const caller = req.signal;
    if (caller?.aborted) throw new AnalysisAbortedError(`Endpoint ${this.model} call aborted before sending.`);
    let release: () => void;
    try {
      release = await endpointSemaphore(this.endpoint).acquire({ signal: caller });
    } catch (err) {
      if (caller?.aborted) throw new AnalysisAbortedError(`Endpoint ${this.model} call aborted while queued.`);
      throw err;
    }

    const startedAt = this.now();
    const ceiling = AbortSignal.timeout(this.endpoint.requestCeilingMs);
    const idle = new AbortController();
    const combined = AbortSignal.any([ceiling, idle.signal, ...(caller ? [caller] : [])]);
    const idleMs = resolveStreamIdleTimeoutMs();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), idleMs);
    };

    let headersReceived = false;
    let finishReason: string | null = null;
    let text = '';
    let reasoningSeen = false;
    let usage: TransportUsage | undefined;
    let lastChunkAt = startedAt;
    let streamError: unknown;

    /* P3, N2: the request is about to leave, so the server may load this model whether or
       not it answers — a run's call, a Test request and a call that then 5xxes all make it a
       valid `{model}` unload target. Recorded here, after the semaphore admitted the call and
       before `create()`: a call aborted while still queued threw above and records nothing. */
    noteEndpointModelUsed(this.endpoint.id, this.model);
    try {
      const stream = await this.client.chat.completions.create(
        buildOpenAIRequestBody(this.endpoint, this.model, req) as unknown as ChatCompletionCreateParamsStreaming,
        { signal: combined },
      );
      headersReceived = true;
      for await (const raw of stream) {
        const chunk = raw as unknown as StreamChunk;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const reasoningDelta =
          (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
          (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) ||
          (Array.isArray(delta?.reasoning_details) && delta.reasoning_details.length > 0);
        const content = typeof delta?.content === 'string' ? delta.content : '';
        if (reasoningDelta) reasoningSeen = true;
        if (reasoningDelta || content) {
          armIdle();
          const now = this.now();
          if (content) text = appendBounded(text, content);
          /* Spec §1: reasoning deltas feed the route heartbeat too. A
             reasoning-only delta reports the answer bytes unchanged — the same
             convention as wave 2's Gemini thought-only chunk. */
          req.call.onChunk?.({ receivedBytes: text.length, receivedText: text, sinceLastChunkMs: now - lastChunkAt, elapsedMs: now - startedAt });
          lastChunkAt = now;
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
          };
        }
      }
    } catch (err) {
      streamError = err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      release();
    }

    /* P22 — every error this attempt builds is redacted against this endpoint's key and
       every saved analyzer secret, read from settings if the cache is still cold. */
    const secrets = [...(this.apiKey ? [this.apiKey] : []), ...(await loadKnownAnalyzerSecrets())];
    const failure = classifyOpenAIOutcome(streamError, {
      callerAborted: caller?.aborted === true,
      ceilingAborted: ceiling.aborted,
      idleAborted: idle.signal.aborted,
      headersReceived,
      sawFinish: finishReason !== null,
      elapsedMs: this.now() - startedAt,
      model: this.model,
      secrets,
    });
    if (failure) throw failure;
    return { text, reasoningSeen, ...mapFinishReason(finishReason as string), usage, receivedBytes: text.length };
  }
}
```

`server/src/analyzer/transports/allowlisted-fetch.ts` (the P22 leaf; it imports only `undici`, and nothing from the analyzer or the workspace):
```ts
/* #3084 P22 — the ONE place that decides which headers reach an OpenAI-compatible
   endpoint, for every OpenAI client this app builds: the transport here, and PR 3c's
   catalog listing, preview and served-limits clients. A leaf, so any of them can
   import it without an import cycle.

   The SDK builds each request's headers from its own defaults (Accept, User-Agent,
   X-Stainless-*: openai client.mjs:1150-1168), the host's OPENAI_CUSTOM_HEADERS env
   (merged after its auth header: :240-249) and the placeholder key, then calls
   `fetch(url, { headers, … })` (fetchWithTimeout, :960-982). NONE of that is
   forwarded. The wire carries exactly FIXED_HEADERS, plus `Authorization: Bearer
   <key>` when the request URL is on the origin the key was resolved for. No
   `x-stainless-*` header is ever sent. undici drops `authorization` on a cross-origin
   redirect (lib/web/fetch/index.js:1352). */
import { fetch as undiciFetch } from 'undici';

export const ANALYZER_USER_AGENT = 'castwright-analyzer';

const FIXED_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': ANALYZER_USER_AGENT,
};

/* The comparison keyOriginMatches (Task 3b.5) makes — scheme, host and port — inlined
   so this leaf imports nothing from the workspace. */
function sameOrigin(keyOrigin: string, target: string): boolean {
  try {
    return new URL(target).origin === keyOrigin;
  } catch {
    return false;
  }
}

export function allowlistedFetch(apiKey: string | null, keyOrigin: string): typeof undiciFetch {
  return ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = { ...FIXED_HEADERS };
    if (apiKey !== null && sameOrigin(keyOrigin, target)) headers.authorization = `Bearer ${apiKey}`;
    return undiciFetch(input, { ...init, headers });
  }) as typeof undiciFetch;
}
```

**Reasoning deltas and `onChunk`.** A delta carrying `reasoning_content`, `reasoning` or a non-empty `reasoning_details` re-arms the idle watchdog and calls `onChunk` with `receivedBytes` / `receivedText` unchanged, so the route heartbeat (`routes/analysis.ts:1184`, silence warning `:4417-4423`) sees a long think as activity. This is the convention wave 2 Task 2.7 uses for Gemini thought-only chunks. A chunk that carries both reasoning and content fires `onChunk` once.

**Stop-the-run errors (P20).** This task adds two catches:
- `attempt()`'s semaphore-acquire catch rethrows anything that is not a caller abort.
- The stream catch hands every error to `classifyOpenAIOutcome`. Its rule 7 returns our own analyzer errors unchanged (`isOwnAnalyzerError`), so an `AnalyzerReasoningOverflowError` reaches the routes' Phase-0 rethrow exactly as a `GeminiContentBlockedError` does. The outcome test `7. P20: …` pins that. Every other error is rebuilt as `AnalyzerTransportError` (P22).

The overflow itself is raised by wave 2's `mapFinish` in the runner, outside the transport. Task 3b.12 pins it end to end.

**If `tsc` reports that the `openai/resources/chat/completions` subpath doesn't export `ChatCompletionCreateParamsStreaming`:** use `OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming` instead. The package's `exports` map has `"./resources/*"`, and `completions.d.mts:57` declares the overload. Record which form compiled.

- [ ] **Step 5: Run and confirm pass**

```bash
npm --prefix server run test -- src/analyzer/transports/openai-outcome.test.ts src/analyzer/transports/openai-request-body.test.ts src/analyzer/transports/openai-transport.contract.test.ts src/analyzer/ollama-timeout.test.ts
npm run typecheck
npm run check:cycles
```

Expected:
- PASS.
- The unroutable-address case finishes in about 2 s.
- `check:cycles` prints the `OK` line with the same count `N` recorded before Step 1 (A9): `openai-transport.ts` reads known secrets through the leaf `known-secrets-gate.ts`, and its other new imports are leaves or modules that do not import it. Any other count fails this task: route the new edge through the gate, never allowlist it.

**If that one case is not unreachable on a CI runner** (a runner whose network answers 10.255.255.1), handle it this way:
- do not skip it;
- record the observed cause chain in the PR;
- route it through `quarantinedIt` with a `docs/testing/flaky-register.md` line, per CLAUDE.md "Flaky tests".

- [ ] **Step 6: Mutation proofs** (paste each red output)

Apply each change, check that the named test fails, then restore it.

| Change | Expected failure |
|---|---|
| Move the `ceiling` creation above the `endpointSemaphore(...).acquire` call | `ceiling time is not charged while the call waits on the endpoint semaphore` |
| Delete the `err === undefined && !ctx.sawFinish` condition | `a stream that closes without finish_reason…` (partial text returned) |
| Delete the `codes.length === 0 &&` guard | `2. a headers-timeout chain is NOT unreachable…` |
| In `connectionLevel`, delete `&& !ctx.headersReceived` | `2. an unreachable-looking code AFTER headers is not unreachable` |
| `connectionLevel` → `err !== undefined && !ctx.headersReceived` (the pre-P21 rule) | `2. an HTTP 502 whose body says code ECONNREFUSED…`, `2. an HTTP 500 whose message is "fetch failed"…`, and the contract suite's `a 502 whose body carries code ECONNREFUSED…` and `a 500 whose message is "fetch failed"…` |
| Move the `ctx.callerAborted` check below the ceiling check | `1. a caller abort wins over everything…` |
| `if (reasoningDelta \|\| content) { armIdle(); …` → `if (content) { armIdle(); …` | the three `…keeps the watchdog alive…` cases |
| Move `req.call.onChunk?.(…)` back inside `if (content) { … }` | the three `…feeds the heartbeat with the answer bytes unchanged…` cases (only one beat recorded) |
| `OPENAI_DISPATCHER` → `new Agent({ headersTimeout: 500, bodyTimeout: 0, connect: { timeout: 10_000 } })` | `a long silent prefill (headers after 1.5 s) completes before the ceiling` |
| `fetch: undiciFetch as …` (with `import { fetch as undiciFetch } from 'undici'` added back) instead of `allowlistedFetch(…)` | `OPENAI_CUSTOM_HEADERS in the host env never reaches the wire…` (the server sees `Bearer stolen` and `x-leak`) and `sends no Authorization header without a key…` |
| In `allowlistedFetch`, copy every incoming header instead of `FIXED_HEADERS` | `OPENAI_CUSTOM_HEADERS in the host env never reaches the wire…`, `allowlistedFetch sends the key only to the origin…` and `sends only the fixed accept, content-type and user-agent values…` |
| In `allowlistedFetch`, drop the `sameOrigin(…)` condition | `allowlistedFetch sends the key only to the origin it was resolved for…` |
| In `allowlistedFetch`, also copy incoming `x-stainless-*` and `user-agent` headers onto `headers` (the pre-P22-extension allowlist) | `sends only the fixed accept, content-type and user-agent values and no x-stainless-* header…` |
| Remove `'user-agent'` from `FIXED_HEADERS` | the same test (`user-agent` is undici's default, not `castwright-analyzer`) |
| Put `'ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN'` back into `OPENAI_UNREACHABLE_CODES` (the pre-P21 set) | the three `2. %s before headers comes from a server that may be up…` cases, `a DNS hiccup before headers (EAI_AGAIN injected)…`, `a server that accepts the connection and closes the socket before writing headers…`, and Task 3b.12's `…never falls back to Gemini (P21)` reset case |
| Delete the `OPENAI_PRE_HEADER_TRANSIENT_CODES` branch | the three `2. %s before headers comes from a server that may be up…` cases (they become `AnalyzerTransportError`), `2. a non-APIError reset…`, and the two P21 contract cases |
| Unreachable rebuild → `new AnalyzerUnreachableError(…, 'openai', err)` (attach the SDK error) | `2. %s (a connect-phase code)…` (`cause` defined) and `2. the unreachable error is rebuilt: no cause…` (`inspect` prints the key) |
| Rule 7 → `return err instanceof Error ? err : new Error(String(err));` (the pre-P22 rethrow) | `7. anything else is rebuilt as AnalyzerTransportError…`, `7. an invalid header value…`, and the contract `a saved key the HTTP client rejects as a header value…` |
| Rule 7's message built from `(err as Error).message` instead of `chainClassNames(err)` | `7. anything else is rebuilt…` and `7. an invalid header value…` (the key appears) |
| In the P25 success line, drop `\|\| socketDrop` | `6. a socket drop AFTER a finish_reason is success…` and the contract `a finish_reason, then the socket drops before [DONE]…` (three requests) |
| In `send`, `logTag: \`openai:${this.endpoint.id}\`` → `logTag: 'openai'` | `a 503 body echoing the endpoint key…` (no line starts `[openai:lab] transient `) — proves that assertion can fail |
| Delete the `ctx.sawFinish && ctx.idleAborted` success line | `6. an idle abort AFTER a finish_reason is success…` and `a finish_reason, then silence past the idle window before [DONE]…` |
| In the `APIError` branch, drop `redactKnownSecrets(…)` | `4. an HTTP status becomes AnalyzerHttpError with … a redacted body excerpt…` and `a 503 body echoing the endpoint key…` |
| Replace `return Object.assign(httpError, { retryAfterMs: … })` with `httpError.cause = err; return httpError;` | `4. … no raw cause` and `a 503 body echoing the endpoint key…` (`inspect(err)` prints the body) |
| In `attempt()`, pass `secrets: []` | `a 503 body echoing the endpoint key…` |
| Delete `err instanceof AnalyzerReasoningOverflowError \|\|` from `isOwnAnalyzerError` | `7. P20: an AnalyzerReasoningOverflowError crossing the transport catch is returned unchanged…` |
| In `buildOpenAIRequestBody`, drop `- req.estimatedInputTokens` from `perRequestBound` | `Auto on the wire also takes the estimated input off…` |
| `endpointAutoOutputMargin` → `return 0;` | `the margin is max(1024, 10% of the context)` and `streams answer text, maps finish_reason stop…` (`max_tokens` is 32 758) |
| In `send`, delete the `logTag` and `displayName` lines | `npm run typecheck` (W1's `withTransportRetry` requires both) |
| `release();` moved out of `finally` into the success path only | `a post-connect stall … semaphore released` |
| Move `noteEndpointModelUsed(this.endpoint.id, this.model);` above the `endpointSemaphore(this.endpoint).acquire` call | `a call aborted while queued on the endpoint semaphore records nothing` |
| Move `noteEndpointModelUsed(this.endpoint.id, this.model);` below the `await this.client.chat.completions.create(…)` line (the pre-N2 2xx rule) | `a call that fails with a 5xx still records its model…` and `a model is recorded as soon as its request is sent…` |
| Pre-header branch: `return new AnalyzerStreamIncompleteError('openai', ctx.model);` (no cause code, Q1) | the three `2. %s before headers comes from a server that may be up…` cases (message), `an injected EAI_AGAIN before headers is retried as incomplete, and the classified failure names it…`, and the contract `a DNS hiccup before headers (EAI_AGAIN injected)…` |
| Rule 7: drop `${causeCodeSuffix(causeCode)}` from the message (Q1) | `7. anything else is rebuilt as AnalyzerTransportError…` and `an injected ERR_SSL_WRONG_VERSION_NUMBER … the classified failure names it` (message) |
- [ ] **Step 7: Commit**
```bash
git add server/package.json server/package-lock.json server/src/analyzer/transports/allowlisted-fetch.ts server/src/analyzer/transports/openai-transport.ts server/src/analyzer/transports/openai-outcome.test.ts server/src/analyzer/transports/openai-request-body.test.ts server/src/analyzer/transports/openai-transport.contract.test.ts
git commit -m "feat(server): add openai-compatible chat transport with ceiling, idle and abort classification"
```

---

### Task 3b.12: `OPENAI_RETRY_POLICY` and `OpenAIAnalyzer` (end to end over a real server)

**Files:**
- Modify: `server/src/analyzer/runner/retry-policy.ts` (W1)
- Create: `server/src/analyzer/openai.ts`
- Create: `server/src/analyzer/openai-analyzer.test.ts`

**Interfaces:**
- Consumes:
  - `ValidationRetryPolicy`, `buildRetryMessage` (W1 `runner/parse.ts`)
  - `StageRunner`, `TransportAnalyzer` (W1)
  - `OpenAITransport`, `resolveEndpointMaxOutputTokens` (Task 3b.11)
  - `adaptSchemaForOpenAI` (Task 3b.3)
  - `FallbackAnalyzer` (`index.ts`, W1) — test only
  - `AnalyzerEndpoint` (Task 3b.5)
  - `AnalysisAbortedError`, `AnalyzerUnreachableError` (W1)
- Produces (contract):
  - `OPENAI_RETRY_POLICY`
  - `class OpenAIAnalyzer extends TransportAnalyzer`, constructor `{ endpoint: AnalyzerEndpoint; apiKey: string | null; model: string; dispatcher?: Agent }`
- Produces (additional): `OPENAI_DEFAULT_TEMPERATURE = 0.2`, `OPENAI_RETRY_TEMPERATURE = 0.6`; `export function openAIRequestSettings(endpoint: AnalyzerEndpoint, servedOutputLimit?: number): EngineRequestSettings` — the settings the endpoint's runner reads, with `maxOutputTokens` always a number (P24). **Later waves target this function:** w3cd Task 3c.9 passes the served output limit here instead of replacing a `maxOutputTokens: … : undefined` line in the closure, and wave 5 (Tasks 5.3, 5.10) adds `reasoning` / `extraParams` here.

**Temperatures.** The contract says "retry temperature from its endpoint", but `analyzerEndpointSchema` has no temperature field. Endpoints therefore use constants equal to the Ollama knob defaults: `registry.ts:27` (0.2) and `:37` (0.6). Wave 5's custom payload can set the first-attempt temperature.

**How attempt 1 gets its temperature.** Wave 1's `ValidationRetryPolicy` (Task 1.10) has `initialTemperature(): number`: the temperature of the first attempt and of escalation's single attempt. The runner calls it for both. It also has `readonly warnsOnRepair: boolean`. `OPENAI_RETRY_POLICY` implements both. `initialTemperature` returns `OPENAI_DEFAULT_TEMPERATURE`. `warnsOnRepair` is `true`, following Ollama's retry shape, whose policy logs "required JSON cleanup".

**Retry shape.** It is Ollama's (`ollama.ts:559-571`):
- invalid JSON → drop the assistant turn, use the retry temperature;
- a schema failure → replay the output plus `buildRetryMessage`, at the default temperature.

Also: `writesRawAttempts: true`, and escalation rethrows abort and unreachable (the contract).

**Stop-the-run errors (P20).** Escalation follows the content-block precedent. W1's Gemini escalation resolves `null` for a `GeminiContentBlockedError`, and wave 2 changes no policy's `escalationRethrows`, so an overflow inside escalation resolves `null` too. The run-stopping rethrow lives in the routes' Phase-0 catches (wave 2), which this PR does not touch. The test `reasoning deltas then an empty length finish stop the run…` pins that a stage call through `OpenAIAnalyzer` surfaces the overflow unwrapped.

**Tests kept green:** `server/src/analyzer/runner/*`, `server/src/analyzer/ollama.test.ts`.

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/openai-analyzer.test.ts`:
```ts
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Analyzer } from './types.js';
import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';

process.env.GEMINI_RETRY_BACKOFFS_MS = '10,10';

const { OpenAIAnalyzer, openAIRequestSettings } = await import('./openai.js');
const { FallbackAnalyzer } = await import('./index.js');
const { OPENAI_RETRY_POLICY, OPENAI_DEFAULT_TEMPERATURE, OPENAI_RETRY_TEMPERATURE } = await import('./runner/retry-policy.js');
const { _resetEndpointRuntimeForTest } = await import('./transports/endpoint-runtime.js');
const { geminiRateLimiter } = await import('./rate-limit.js');
const errors = await import('./errors.js');
const { classifyAnalysisFailure } = await import('../routes/failure-taxonomy.js');
/* #3084 F7 review pass 2, item 1 — TransportAnalyzer, so the escalation-path
   test can spy on its prototype method to capture the StageCall options
   OpenAIAnalyzer builds. If wave 1 splits it into its own module
   (`runner/transport-analyzer.js`) rather than `runner/stage-runner.js`,
   import it from wherever it actually lands. */
const { TransportAnalyzer } = await import('./runner/stage-runner.js');

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');
const ID = 'm_openai_analyzer';
const VALID = JSON.stringify({
  characters: [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', evidence: [{ quote: 'a' }, { quote: 'bb' }, { quote: 'ccc' }] },
  ],
});

let server: Server | undefined;
let bodies: Array<{ messages: Array<{ role: string; content: string }>; temperature: number; response_format?: unknown }> = [];

async function start(reply: (n: number, res: ServerResponse, req: IncomingMessage) => void): Promise<string> {
  bodies = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      reply(bodies.length, res, req);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
}

const streamText = (res: ServerResponse, content: string) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};

const endpoint = (baseUrl: string, over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint => ({
  id: 'lab',
  name: 'Lab',
  baseUrl,
  gpu: 'any',
  concurrency: 1,
  requestCeilingMs: 10_000,
  structuredOutput: 'schema',
  reasoningStyle: 'not_controllable',
  reasoning: 'model-default',
  maxOutputTokens: 0,
  contextTokens: 32_768,
  ...over,
});

beforeEach(() => {
  _resetEndpointRuntimeForTest();
  geminiRateLimiter._reset();
});
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});
afterAll(async () => {
  delete process.env.GEMINI_RETRY_BACKOFFS_MS;
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

describe('OpenAIAnalyzer (#3084 PR 3b)', () => {
  it('runs a stage over the endpoint with the OpenAI-adapted schema', async () => {
    const url = await start((_n, res) => streamText(res, VALID));
    const out = await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(out.characters.map((c) => c.id)).toEqual(['narrator']);
    expect(bodies[0].temperature).toBe(OPENAI_DEFAULT_TEMPERATURE);
    const format = bodies[0].response_format as { type: string; json_schema: { schema: Record<string, unknown>; strict: boolean } };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(false);
    expect(format.json_schema.schema).not.toHaveProperty('$schema');
  });

  it('invalid JSON: retries without the assistant turn at the retry temperature', async () => {
    const url = await start((n, res) => streamText(res, n === 1 ? 'not json' : VALID));
    await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(bodies).toHaveLength(2);
    expect(bodies[1].temperature).toBe(OPENAI_RETRY_TEMPERATURE);
    expect(bodies[1].messages.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('schema failure: replays the output with a correction message at the default temperature', async () => {
    const url = await start((n, res) => streamText(res, n === 1 ? '{"characters":[{"id":"narrator"}]}' : VALID));
    await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(bodies).toHaveLength(2);
    expect(bodies[1].temperature).toBe(OPENAI_DEFAULT_TEMPERATURE);
    expect(bodies[1].messages.at(-2)).toEqual({ role: 'assistant', content: '{"characters":[{"id":"narrator"}]}' });
    expect(bodies[1].messages.at(-1)?.content).toContain('failed schema validation');
  });

  it('a 400 fails as analyzer-request-rejected with no second request', async () => {
    const url = await start((_n, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "'response_format.type' must be 'json_schema' or 'text'" } }));
    });
    const err = await new OpenAIAnalyzer({ endpoint: endpoint(url, { structuredOutput: 'json' }), apiKey: null, model: 'm' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(bodies).toHaveLength(1);
    const classified = classifyAnalysisFailure(err, 'Endpoint lab (m)');
    expect(classified.code).toBe('analyzer-request-rejected');
    expect(classified.remediation).toContain("the endpoint's Structured output field");
  });

  it('two invalid replies fail as AnalyzerInvalidOutputError(openai) with today\'s message shape', async () => {
    const url = await start((_n, res) => streamText(res, 'not json'));
    const err = await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(errors.AnalyzerInvalidOutputError);
    expect((err as Error).message).toMatch(/^Endpoint qwen3:30b 1-ch1 failed validation after retry: invalid-json — /);
  });

  it('escalation returns null on unusable output but rethrows unreachable', async () => {
    expect(OPENAI_RETRY_POLICY.escalationRethrows(new errors.AnalyzerUnreachableError('x', 'openai'))).toBe(true);
    expect(OPENAI_RETRY_POLICY.escalationRethrows(new errors.AnalysisAbortedError('x'))).toBe(true);
    expect(OPENAI_RETRY_POLICY.escalationRethrows(new Error('bad json'))).toBe(false);
    expect(OPENAI_RETRY_POLICY.writesRawAttempts).toBe(true);
  });

  it('resolves a numeric output cap for Auto and manual endpoints — never undefined (P24)', () => {
    /* The wire cannot tell `undefined` from Auto's number (the transport takes the same
       per-request bound either way), so the resolved setting is asserted directly. */
    expect(openAIRequestSettings(endpoint('http://127.0.0.1:8080/v1'))).toEqual({ structuredOutput: 'schema', maxOutputTokens: 29_491 });
    expect(openAIRequestSettings(endpoint('http://127.0.0.1:8080/v1'), 8_192).maxOutputTokens).toBe(8_192);
    expect(openAIRequestSettings(endpoint('http://127.0.0.1:8080/v1', { maxOutputTokens: 4_096 })).maxOutputTokens).toBe(4_096);
  });

  it('a 502 whose body says ECONNREFUSED fails as that HTTP error and never falls back to Gemini (P21)', async () => {
    const url = await start((_n, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'ECONNREFUSED', message: 'upstream down' } }));
    });
    const fallbackStage = vi.fn();
    const fallback = { runStage1Chapter: fallbackStage } as unknown as Analyzer;
    const primary = new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' });
    const err = await new FallbackAnalyzer(primary, fallback)
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(fallbackStage).not.toHaveBeenCalled();
  });

  it('a server that closes the socket before writing headers is retried and never falls back to Gemini (P21)', async () => {
    /* A REAL socket: the server accepts the connection, reads the request, and
       destroys the socket without writing headers — an up server that reset. */
    const url = await start((_n, _res, req) => {
      req.socket.destroy();
    });
    const fallbackStage = vi.fn();
    const fallback = { runStage1Chapter: fallbackStage } as unknown as Analyzer;
    const primary = new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' });
    const err = await new FallbackAnalyzer(primary, fallback)
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(fallbackStage).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(3);
  });

  it('reasoning deltas then an empty length finish stop the run as AnalyzerReasoningOverflowError, never a split (P20)', async () => {
    const url = await start((_n, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const err = await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(errors.AnalyzerReasoningOverflowError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerTruncatedError);
    expect(classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)').code).toBe('analyzer-reasoning-overflow');
    /* #3084 F7 review pass 2, item 1 — the THROWN path: withEndpointId's catch
       annotates it before it reaches the caller. endpoint(url) (this file's
       helper, above) sets id: 'lab'. */
    expect((err as errors.AnalyzerReasoningOverflowError).endpointId).toBe('lab');
  });

  it('an escalation-path overflow (reported through StageCall.onReasoningOverflow, never thrown at the point it happens — w2 runSingleAttempt/throwIfReasoningOverflowed) is annotated too, before it can ever reach a caller (#3084 F7 review pass 2, item 1)', async () => {
    /* This does not drive wave 2's actual escalation control flow — that
       machinery (runSingleAttempt's escalation mode, throwIfReasoningOverflowed)
       does not exist on `main` at the time this task is written, and its exact
       call site relative to OpenAIAnalyzer's own stage methods is wave 2's to
       fix. What IS this file's to prove is narrower and fully testable today:
       whatever StageCall options object OpenAIAnalyzer passes to
       `super.runStage1Chapter(...)` has an `onReasoningOverflow` that, when
       invoked with a fresh (unannotated) AnalyzerReasoningOverflowError,
       stamps this analyzer's own endpoint id onto it — which is exactly what
       lets a LATER rethrow (wherever wave 2 places it) carry the id. */
    const captured: { onReasoningOverflow?: (err: errors.AnalyzerReasoningOverflowError) => void }[] = [];
    const runStage1Spy = vi
      .spyOn(TransportAnalyzer.prototype, 'runStage1Chapter')
      .mockImplementation(async (_id, _chapterId, _text, opts) => {
        captured.push(opts as never);
        return { characters: [] } as never;
      });
    try {
      const analyzer = new OpenAIAnalyzer({ endpoint: endpoint('http://127.0.0.1:1'), apiKey: null, model: 'qwen3:30b' });
      await analyzer.runStage1Chapter(ID, 1, '# p', {});
      expect(captured).toHaveLength(1);
      expect(typeof captured[0].onReasoningOverflow).toBe('function');
      const raw = new errors.AnalyzerReasoningOverflowError('openai', 'qwen3:30b', 512);
      expect(raw.endpointId).toBeUndefined();
      captured[0].onReasoningOverflow!(raw);
      expect(raw.endpointId).toBe('lab');
    } finally {
      runStage1Spy.mockRestore();
    }
  });
});
```
The schema-failure fixture `{"characters":[{"id":"narrator"}]}` parses but fails `stage1ChapterSchema` (missing `name`, `role`, `color`, `evidence`). `parseAndValidate` strips only unrecognized-keys-only failures (`ollama.ts:500-503`), so it stays a schema failure.

- [ ] **Step 2: Run and confirm failure**

Run: `npm --prefix server run test -- src/analyzer/openai-analyzer.test.ts`

Expected: FAIL with `Failed to resolve import "./openai.js"`.

- [ ] **Step 3: Implement**

Append to `server/src/analyzer/runner/retry-policy.ts`:
```ts
/* #3084 PR 3b — OpenAI-compatible endpoints use Ollama's retry SHAPE
   (ollama.ts:559-571): invalid JSON drops the assistant turn and raises the
   temperature so the sampler can leave the failure path; a schema failure
   replays the output with the field list. Endpoints carry no temperature
   field, so the temperatures are these constants (= the Ollama knob defaults,
   registry.ts:27 and :37). */
export const OPENAI_DEFAULT_TEMPERATURE = 0.2;
export const OPENAI_RETRY_TEMPERATURE = 0.6;

export const OPENAI_RETRY_POLICY: ValidationRetryPolicy = {
  name: 'openai',
  initialTemperature: () => OPENAI_DEFAULT_TEMPERATURE,
  buildRetry({ messages, firstRaw, failure }) {
    if (failure.kind === 'invalid-json') {
      return { messages, temperature: OPENAI_RETRY_TEMPERATURE };
    }
    return {
      messages: [...messages, { role: 'assistant', content: firstRaw }, { role: 'user', content: buildRetryMessage(failure) }],
      temperature: OPENAI_DEFAULT_TEMPERATURE,
    };
  },
  writesRawAttempts: true,
  warnsOnRepair: true,
  escalationRethrows: (err) => err instanceof AnalysisAbortedError || err instanceof AnalyzerUnreachableError,
};
```
Add `AnalyzerUnreachableError` and `AnalysisAbortedError` to the file's `../errors.js` import, and `buildRetryMessage` to its `./parse.js` import.

`server/src/analyzer/openai.ts`:
```ts
/* #3084 PR 3b — the analyzer for a named OpenAI-compatible endpoint. Same
   stage table and runner as OllamaAnalyzer / GeminiAnalyzer; only the
   transport, retry policy, request settings and schema adapter differ.
   Not constructed by selectAnalyzer until PR 3d. */
import type { Agent } from 'undici';
import { StageRunner, TransportAnalyzer } from './runner/stage-runner.js';
import { OPENAI_RETRY_POLICY } from './runner/retry-policy.js';
import { adaptSchemaForOpenAI } from './runner/schema-adapters.js';
import type { EngineRequestSettings } from './runner/stage-runner.js';
import { OpenAITransport, resolveEndpointMaxOutputTokens } from './transports/openai-transport.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';

/** #3084 P24 — the request settings an endpoint's runner reads. `maxOutputTokens` is
    always a number: a manual value, or Auto's min(served output limit if known,
    contextTokens − margin). The transport takes each request's estimated input off
    Auto. PR 3c passes the served output limit its prepare() warms. */
export function openAIRequestSettings(endpoint: AnalyzerEndpoint, servedOutputLimit?: number): EngineRequestSettings {
  return {
    structuredOutput: endpoint.structuredOutput,
    maxOutputTokens: resolveEndpointMaxOutputTokens(endpoint, servedOutputLimit),
    /* No reasoning / extraParams: EngineRequestSettings has neither field until
       wave 5 (Task 5.1). Task 5.3 adds `reasoning:` and Task 5.10 adds `extraParams:` here. */
  };
}

export class OpenAIAnalyzer extends TransportAnalyzer {
  constructor(opts: { endpoint: AnalyzerEndpoint; apiKey: string | null; model: string; dispatcher?: Agent }) {
    super(
      new StageRunner({
        transport: new OpenAITransport({
          endpoint: opts.endpoint,
          apiKey: opts.apiKey,
          model: opts.model,
          dispatcher: opts.dispatcher,
        }),
        policy: OPENAI_RETRY_POLICY,
        settings: () => openAIRequestSettings(opts.endpoint),
        adaptSchema: adaptSchemaForOpenAI,
      }),
    );
  }
}
```
If wave 1 exported `StageRunner` and `TransportAnalyzer` from separate files (`stage-runner.ts` and `transport-analyzer.ts`, as the contract heading lists), split the import to match.

**The API key.** Callers resolve it with `resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl)` (Task 3b.5), so an origin mismatch throws `AnalyzerKeyOriginError` before any request exists. PR 3d wires that call into selection.

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/analyzer/openai-analyzer.test.ts src/analyzer/runner src/analyzer/ollama.test.ts
npm run typecheck
npm run check:cycles
```
Expected: PASS.

- [ ] **Step 5: Mutation proofs**

Apply each change, check that the named test fails, then restore it.

| Change | Expected failure |
|---|---|
| In `buildRetry`, return the replay shape for `invalid-json` too | `invalid JSON: retries without the assistant turn…` |
| `adaptSchema: adaptSchemaForOllama` in `openai.ts` (keeps `$schema`) | `runs a stage over the endpoint with the OpenAI-adapted schema` |
| `escalationRethrows: (err) => err instanceof AnalysisAbortedError` | `escalation returns null on unusable output but rethrows unreachable` |
| In `openAIRequestSettings`, `maxOutputTokens: endpoint.maxOutputTokens > 0 ? endpoint.maxOutputTokens : undefined` (the pre-P24 line) | `resolves a numeric output cap for Auto and manual endpoints — never undefined (P24)` |
| In `classifyOpenAIOutcome` (Task 3b.11), restore the pre-P21 gate `err !== undefined && !ctx.headersReceived` | `a 502 whose body says ECONNREFUSED fails as that HTTP error and never falls back to Gemini (P21)` (the fallback's `runStage1Chapter` is called) |
| In `OpenAITransport.attempt` (Task 3b.11), delete `if (reasoningDelta) reasoningSeen = true;` | `reasoning deltas then an empty length finish stop the run…` (no reasoning evidence, so the empty `length` finish is not an overflow) |
| In Task 3b.11, add `'ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN'` back to `OPENAI_UNREACHABLE_CODES` (the pre-P21 set) | `a server that closes the socket before writing headers is retried and never falls back to Gemini (P21)` (the fallback's `runStage1Chapter` is called, `bodies` has length 1) |
| In `withEndpointId` (Task 3b.1b), delete the `err.endpointId === undefined` branch entirely (never annotate) | `reasoning deltas then an empty length finish stop the run…` (`err.endpointId` is `undefined`, not `'lab'`) — this row is now a REAL failure, not the "add once 3b.12 exists" hedge an earlier draft carried: 3b.12 is this task, so it exists now |
| Delete `this.withEndpointIdHook(opts)` from the `runStage1Chapter` override (pass `opts` straight through) | `an escalation-path overflow (reported through StageCall.onReasoningOverflow…) is annotated too…` (`captured[0].onReasoningOverflow` is `undefined`, or is whatever the caller passed with no wrapping — `raw.endpointId` stays `undefined` after the manual invoke) |
| In `withEndpointIdHook`, drop the `call.onReasoningOverflow?.(err);` forwarding call | the same test still passes (documents a gap: nothing yet asserts the ORIGINAL caller-supplied hook, if any, still fires — add `it('still calls a caller-supplied onReasoningOverflow after annotating')` passing a spy as `opts.onReasoningOverflow` once a real caller in this codebase supplies one) |

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/retry-policy.ts server/src/analyzer/openai.ts server/src/analyzer/openai-analyzer.test.ts
git commit -m "feat(server): add OpenAIAnalyzer and the openai validation retry policy"
```

---

### Task 3b.13: Ship PR 3b

**Files:**
- Modify: `docs/release-notes-next.md` — new entry in the in-progress body.
- Modify: `RELEASE_NOTES.md` — new bullet under `# Castwright 1.15.0`.
- Modify: `docs/testing/onbox-acceptance-register.md` — two rows: one in Group B (its `next-id` marker is at `:4509` on 46e62a34), one in Group E (marker at `:4926`). Bump both markers.
- Modify: `docs/testing/3084-openai-analyzer-onbox-acceptance.md` — the #3084 run sheet wave 2 created (§1–§3); append §4 and §5.
- Modify: `docs/testing/onbox-acceptance-register-live-view.html`.
- Modify: the wave plan doc (`rg -l "3084" docs/features`) — mark PR 3b delivered in its sequencing section.

- [ ] **Step 1: Regenerate derived artifacts and run the full local checks**

```bash
npm run openapi:types
git diff --exit-code src/lib/api-types.ts
npm run config:sync
npm run config:check
npm run typecheck
npm run lint
npm run check:cycles
npm run audit:server
npm run verify:fast:branch
git grep -nP '\bANALYZER\b(?!_)' -- server/src/routes/failure-remediations.ts server/src/routes/failure-taxonomy.ts src/data/help-failures.ts
```
Expected: every command green, and no diff from either regenerator. The last `git grep` prints nothing: no copy this PR adds or edits names the retired `ANALYZER` env var (#3201, a PR 3a entry criterion, removed it from `analyzer-unreachable`). If it prints a line, fix that copy in this PR.

- [ ] **Step 2: Release notes (both files)**

The shippable delta is the two structured-output settings, which are user-visible in Advanced Settings. The four failure codes also add Help entries.

Append to `docs/release-notes-next.md`, under the analysis section of the in-progress body:
```markdown
- **Structured-output mode per analyzer engine.** New Advanced Settings knobs `analyzer.ollama.structuredOutput` (`schema` default — today's `format` request) and `analyzer.gemini.structuredOutput` (`json` default — today's `responseMimeType`-only request) choose `schema` / `json` / `off`. Gemini's `schema` mode sends a schema reduced to the keywords `responseJsonSchema` documents; dropped constraints are logged, and every reply is still validated against the full schema. New failure codes `analyzer-request-rejected` (any HTTP 400, with the redacted provider message and the request-shaping settings named — never retried with a setting removed), `analyzer-invalid-output` and `analyzer-endpoint-missing` (`analyzer-timeout` shipped with PR 2b). **Changed failure outcomes:**
  - any HTTP 400 from Ollama or Gemini: `unknown` → `analyzer-request-rejected` (a Gemini 400 keeps its status/details detail);
  - an Ollama 401/403: `unknown` → `auth`;
  - a reply that still fails validation after the retry: `unknown` → `analyzer-invalid-output`;
  - an analyzer selection that names an unconfigured endpoint, in annotate-emotion, instruct-annotation and script review: no error event / `internal_error` → `analyzer-endpoint-missing` (unreachable from the UI until PR 3d).

  Ollama 404/500/503 and every Ollama unreachable outcome (closed port, unresolvable host, reset before the first byte) are unchanged. Saved API keys are removed from analyzer error text before it is shown, saved or logged, in all three transports and the endpoint routes. A settings file with an invalid or duplicate analyzer endpoint entry keeps every other setting, and the dropped entry is saved to `user-settings.invalid-endpoints.json`. Groundwork for OpenAI-compatible endpoints (storage, origin-bound keys that refuse control characters, Detect, transport) ships unselectable, and the host's `OPENAI_CUSTOM_HEADERS` never reaches an endpoint. (#PR, Refs #3084)
```

Add under `# Castwright 1.15.0` in `RELEASE_NOTES.md`:
```markdown
- **You can now choose how strictly the analyzer is told to answer in Castwright's format.** In Advanced Settings, the local analyzer and Gemini each have a "structured output" setting: "schema" spells out the exact shape of the answer, "json" only asks for valid JSON, and "off" asks for neither. Nothing changes unless you change it — the local analyzer keeps spelling out the shape, and Gemini keeps asking only for JSON, exactly as before. And when an analyzer turns a request down as invalid, Castwright now tells you which of your settings shaped that request, instead of a bare error. A few other analyzer failures that used to read as an unrecognised error now say what happened: a key the analyzer refused, or a reply that never matched the expected shape.
```

- [ ] **Step 3: On-box acceptance — owed; record it on all three surfaces**

Two behaviours only real services can prove:
1. Ollama honouring `format: "json"` or no format.
2. Gemini accepting or ignoring the adapted `responseJsonSchema`.

These are the first half of the spec's "Live structured output" row. PR 3c extends that row with the Test action and the llama-swap endpoint.

Register rows. Each row's id is the next id from that group's `next-id` marker, minted at ship time (`npm run check:onbox-register`). Bump each marker in the same commit. Below, `B<next>` and `E<next>` stand for the minted Group B and Group E ids. Write the minted ids in their place everywhere, including the run sheet and the live view.

`## Group B — local Ollama analyzer only` — new row `B<next>`:
```markdown
### B<next> · Ollama structured-output modes on a real model (#3084 PR 3b)

With `analyzer.ollama.structuredOutput` set to `json`, then `off`, analyse one real chapter each on `qwen3.5:4b`. Observe:
- in `server/handoff/inbox/…` and the debug log, the request carried `format: "json"`, then no `format` key;
- the chapter still validates (or fails as "analyzer reply failed validation", never as `unknown`);
- a daemon that rejects a mode fails as "analyzer rejected the request" naming `analyzer.ollama.structuredOutput`.

Record the validation-retry count for each mode against the default `schema` run on the same chapter. Criteria: `docs/testing/3084-openai-analyzer-onbox-acceptance.md` §4.
```

`## Group E — not the GPU box` — new row `E<next>`:
```markdown
### E<next> · Gemini `schema` mode on a real key (#3084 PR 3b)

With a Gemini key and `analyzer.gemini.structuredOutput` = `schema`, analyse one real chapter on `gemma-4-31b-it` and one on `gemini-3.5-flash-lite`. Observe:
- whether Gemini returns HTTP 400 for the adapted `responseJsonSchema`, or accepts it;
- the debug log's "schema adapter dropped" list, which must match the PR's `gemini / *` snapshot;
- whether replies conform on the first attempt.

This row does not by itself move Gemini's default: the spec gates that on attribution quality, which PR 3c's Test-action row records. Criteria: `docs/testing/3084-openai-analyzer-onbox-acceptance.md` §5.
```
Also add a glance-table row for each group, matching the file's existing format for its group.

Append to `docs/testing/3084-openai-analyzer-onbox-acceptance.md`, the run sheet wave 2 created with §1–§3. If a later PR has already added sections, number these after the last one and use those numbers in the two register rows:
```markdown
## §4 — Ollama structured-output modes (#3084 PR 3b, register row B<next>)

Book: *The Coalfall Commission* chapter one (`server/src/__fixtures__/the-coalfall-commission.md`). Write the minted row id in place of B<next>.

Prerequisites: a real Ollama daemon with `qwen3.5:4b` pulled; no TTS engine resident.

1. Default (`schema`): analyse chapter one. Note the validation retries (count `*.attempt1.raw.txt` files).
   Result:
2. Set `analyzer.ollama.structuredOutput` = `json`. Re-analyse chapter one. Confirm the inbox request had `format: "json"`. Note retries and outcome.
   Result:
3. Set it to `off`. Re-analyse. Confirm the request had no `format` key. Note retries and outcome.
   Result:
4. Restore `schema`.

## §5 — Gemini `schema` mode (#3084 PR 3b, register row E<next>)

Book: as §4. Prerequisites: a Gemini API key; no local analyzer needed.

1. Set `analyzer.gemini.structuredOutput` = `schema`. Analyse chapter one on `gemma-4-31b-it`. Record: HTTP 400 or accepted; the debug "schema adapter dropped" list; first-attempt conformance.
   Result:
2. Repeat on `gemini-3.5-flash-lite`.
   Result:
3. Restore `json`.
```

Live view. Follow the register's own "Live view" section: `npm run register:build`, `npm run check:onbox-register`, `npm run check:onbox-register -- --against-published <saved copy of the live page>`. Publish `docs/testing/onbox-acceptance-register-live-view.html` to the URL recorded in the register header (`:28`), never to a new artifact.

- [ ] **Step 4: Open the PR**

Title: `feat(server,openapi): analyzer endpoints, keys and openai transport (not yet selectable)`

Body:
- `## Summary`:
  - the delivered list above;
  - the Gemini `dropped` snapshot entries;
  - "Contract changes":
    - `ValidationRetryPolicy.finalFailureMessage` was removed (the class owns the text);
    - `AnalyzerEndpointMissingError` was born in PR 3a;
    - `servedModels()` replaces `lastUsedModel` and `resolveUnloadUrl`'s parameter is `model` (P3);
    - a model counts as served when its request is **sent** — runs, Tests and requests that then fail (P3, N2); there is no `noteServedModel` flag, and PR 3c's Test transport is built like any other;
    - `LIMIT_400_PATTERNS` / `namesContextOrTokenLimit` live in `analyzer/limit-400-patterns.ts`;
    - `OpenAIAnalyzer`'s settings are `openAIRequestSettings(endpoint, servedOutputLimit?)`.
    - `allowlistedFetch` / `ANALYZER_USER_AGENT` live in the leaf `transports/allowlisted-fetch.ts` (re-exported by `openai-transport.ts`) and send fixed `accept` / `content-type` / `user-agent` values with no `x-stainless-*` header (P22).
    - `AnalyzerTransportError(transport, model, message, causeCode)` and `sanitizeCauseCode` are added; P22's "sanitized `code`" field is named `causeCode`, because `code` is each class's own sentinel.
    - `OPENAI_UNREACHABLE_CODES` is connect-phase only; `OPENAI_PRE_HEADER_TRANSIENT_CODES` is added (P21).
    - `analyzerSelectionErrorEvent` (Task 3b.1a) and `invalidEndpointsArchivePath` (Task 3b.6) are added. `analyzerSelectionErrorEvent` codes every error, never null (Q2).
    - `AnalyzerStreamIncompleteError` gains an optional `beforeResponse: { causeCode }` argument and `phase` / `causeCode` fields; `causeCodeSuffix` is added; rule 7's message carries the ` (CODE)` suffix (Q1).
    - `known-secrets-gate.ts` is an unconditional leaf gate (`registerKnownSecretsProvider`, `knownAnalyzerSecrets`, `loadKnownAnalyzerSecrets`) that every route, analyzer and transport module uses instead of importing `user-settings.ts` (A9).
  - "Declared outcome changes", each with the test that pins it:
    1. Any HTTP 400, from any transport: `unknown` → `analyzer-request-rejected`. Pinned by Task 3b.1; paste wave 1's `400 invalid format` snapshot diff.
    2. Ollama 401 / 403: `unknown` → `auth` (`401 unauthorised → auth…`).
    3. Validation failed after the retry: `unknown` → `analyzer-invalid-output` (Task 3b.2).
    4. A selection naming an unconfigured endpoint in annotate-emotion / instruct-annotation (no error event) and script review (`internal_error`): → `analyzer-endpoint-missing` (Task 3b.1a).
    5. Any other error selection throws (Task 3b.1a, Q2) now carries its classified code: phase 0 / subset retry sent it with no code; annotate-emotion / instruct-annotation let it escape with no error event; script review sent `internal_error` (`when the job runner throws synchronously…`, updated). A plain `Error` is `unknown` with its own message; selection's missing-Gemini-key error matches the `auth` signature and so shows the `auth` copy instead of its own text (`selection's own missing-Gemini-key error classifies as auth`). A script-review throw after selection still ends as `internal_error` (`a throw after selection … still reaches the launch catch as internal_error`).
    6. Ollama's in-stream error echo and the persona call's non-OK body are redacted like its non-OK body (Task 3b.6a, A8); byte-identical when no secret is present.
    7. A settings write while an invalid endpoint entry could not be archived still saves, and writes that entry back into the file raw and unchanged until the append lands (Task 3b.6, Q3).

    Unchanged, and pinned:
    - Ollama 404 / 500 / 503 (wave 1's snapshots, not re-captured);
    - every Ollama unreachable outcome — closed port, unresolvable host, reset before the first byte — exactly `main`'s code, copy and detail (P28; `unreachable-failure-taxonomy.test.ts`'s three snapshots, captured on `main` and pasted under "Captured taxonomy outcomes");
    - a Gemini 400's status/details `detail` block (`…keeping the status/details detail block`).
  - "Also fixed, found in passing": none, or list any findings.
- `## Test plan`: every new test file, every mutation-proof red output (Tasks 3b.1–3b.12), and the contract-suite run time.
- `Refs #3084`.

- [ ] **Step 5: `pr-review-gate`** at depth **high**: a multi-scope `feat` across `server,openapi,frontend,docs`. Triage and fold every finding before merge.

---

**End of PRs 3a and 3b.** PR 3c consumes these names:
- `analyzerEndpoints` / `analyzerEndpointKeys`, `resolveEndpointApiKey`, `findEndpointReferences` (+ its classification guard — 3c's new `analyzerCapabilitiesByModel` / `analyzerRateLimitsByModel` fields must be added to that test's exclusion list);
- the `ModelCapabilityRecord` types in `capabilities.ts`;
- the endpoint early return in `resolveLimits`;
- `OpenAIAnalyzer`, `OpenAITransport`, `structuredOutputLabel`, `AnalyzerEndpointMissingError`;
- `LIMIT_400_PATTERNS` and `namesContextOrTokenLimit` from `server/src/analyzer/limit-400-patterns.ts` (Task 3c.4 imports them rather than defining them);
- `allowlistedFetch(apiKey, origin)` and `ANALYZER_USER_AGENT` **from the leaf `server/src/analyzer/transports/allowlisted-fetch.ts`**, never from `openai-transport.ts` (the catalog listing, preview and served-limits clients; importing from the transport closes a cycle). It sends no `x-stainless-*` header;
- `redactKnownSecrets`, `loadKnownAnalyzerSecrets`, `AnalyzerTransportError` and `sanitizeCauseCode` — 3c's preview route must redact the error text it returns or logs, and its OpenAI clients must not rethrow a raw SDK error (P22). An analyzer or transport module (the catalog, served limits) takes `knownAnalyzerSecrets` / `loadKnownAnalyzerSecrets` **from the leaf `server/src/analyzer/known-secrets-gate.ts`**, never from `user-settings.ts` (A9);
- `causeCodeSuffix(causeCode)` from `errors.ts`, the one ` (CODE)` shape. Rule 7's message is now `Endpoint <model> request failed[ before a response] (CODE) (<class chain>).`, and the pre-header `AnalyzerStreamIncompleteError` reads `Endpoint <model> dropped the connection before a response (CODE).` 3c's Test action shows `err.message`, so it shows the code without reading `causeCode`, and its hand-built rule-7 fixtures must use this shape (Q1);
- `analyzerSelectionErrorEvent(err)`, which codes every error and never returns null; 3d's selection branch needs no call-site change to code `AnalyzerKeyOriginError` (Q2);
- `OpenAITransport`'s existing `private readonly apiKey` field (Task 3c.9 adds only `prepare()`);
- `openAIRequestSettings(endpoint, servedOutputLimit?)` and `resolveEndpointMaxOutputTokens` — Task 3c.9 passes `getEndpointServedLimits(endpoint.baseUrl, model)?.maxOutputTokens` as the second argument, keeping the cap a number (P24).

PR 3d consumes:
- `engineForModelId`, `analyzerEngineName`;
- the account-slice thunks and `detectAnalyzerEndpointContext`;
- `servedModels` and `forgetEndpointModel` (Task 3b.10), `resolveUnloadUrl(endpoint, model)`, `defaultGpuForBaseUrl`;
- `SelectAnalyzerOptions.modelSource` (Task 3a.2).

**What PR 3d lifts (P23).** PRs 3a and 3b refuse endpoint model ids everywhere a selection can be saved or read. PR 3d, which makes endpoints selectable, removes exactly these, in the task beside Task 3d.4:
1. **Server helper.** Delete `ENDPOINT_ID_REFUSED_FIELDS`, `ENDPOINT_ID_REFUSED_KNOBS`, `ENDPOINT_ID_REFUSAL` and `endpointModelIdRefusals` from `server/src/workspace/user-settings.ts` (Task 3a.5).
2. **General PUT.** Delete the `/* #3084 P23 — PR 3d deletes this refusal. */` block at the top of `userSettingsRouter.put('/')` in `server/src/routes/user-settings.ts`, and `endpointModelIdRefusals` from that file's import.
3. **Config PUT.** Delete the same-commented block in pass 1 of `configRouter.put('/')` in `server/src/routes/config.ts`, and its import.
4. **Mock PUT.** Delete the `/* #3084 P23 — mirrors the server's refusal… */` block at the top of `mockPutUserSettings` in `src/lib/api.ts`. Drop `engineForModelId` from its `./model-id` import only if nothing else in the file uses it. `_setMockUserSettingsForTest` stays.
5. **Tests flip to accepts:**
   - In `server/src/routes/user-settings.test.ts`, the three `refuses an endpoint model id in %s…` cases and `refuses an endpoint model id in a phase-model override…` expect status 200 and the value saved.
   - In `server/src/routes/config.endpoint-ids.test.ts`, the two refusal cases expect status 200 and `applied: [key]`.
   - In `src/lib/api-put-user-settings-endpoint-ids-mock.test.ts`, the three refusal cases expect the saved value.
6. **Selection.** Task 3d.4 replaces 3a's `if (engine === 'openai') { … throw new AnalyzerEndpointMissingError(…) }` branch, as it already plans. Its missing-endpoint throw passes `opts.modelSource ?? (opts.model ? 'run-pick' : 'settings')` — never the literal `'settings'`, and never `opts.modelSource ?? 'settings'`. So a missing endpoint named by `ANALYZER_PHASE{0,1}_MODEL` still says env, and a direct `selectAnalyzer({ model })` caller that sets no `modelSource` says run pick, matching 3a's `?? 'run-pick'`. 3a's cases `refuses an openai:<endpoint>::<model> id…` and `each phase source is named…` are deleted with that branch. 3d.4 must replace them with cases that pin the default:
   - `selectAnalyzer({ model: 'openai:gone::m' })` (no `modelSource`, no endpoint `gone` saved) throws `AnalyzerEndpointMissingError` with `source: 'run-pick'`;
   - a saved `analyzerPhase1Model: 'openai:gone::m'` through `selectAnalyzerForPhase({ phase: 'phase1' })` throws it with `source: 'settings'`.

   Mutation proof: `?? (opts.model ? 'run-pick' : 'settings')` → `?? 'settings'` turns the first case red.
7. **Keep:**
   - 3a's saved-default check at the top of the `local` branch (`a saved endpoint default is refused as settings-sourced…`): a `local` engine with an endpoint-id default must still never run on Ollama's default model.
   - Selection's `AnalyzerEndpointMissingError` for an id whose endpoint is not saved.

Not PR 3d's to lift: the endpoint routes' `reasoning` refusal (PR 5a) and `extraParams` refusal (PR 5b) in `parseEndpointInput` and `mockEndpointFromInput` (Task 3b.5 / 3b.9). Wave 5 deletes each `notYet` push and flips the `until PRs 5a/5b…` tests.

