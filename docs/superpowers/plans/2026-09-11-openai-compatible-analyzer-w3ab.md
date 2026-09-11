# OpenAI-compatible analyzer — Wave 3 (PRs 3a, 3b) plan

> Part of the [OpenAI-compatible analyzer implementation plan](2026-09-11-openai-compatible-analyzer.md). Read that file first: its Global Constraints, planning decisions (P1–P11) and interface contract bind every task below. Spec: [2026-09-10-openai-compatible-analyzer-design.md](../specs/2026-09-10-openai-compatible-analyzer-design.md).

## Wave 3 — Endpoints become selectable (this section: PRs 3a and 3b)

This section covers PRs **3a** (engine value + id grammar) and **3b** (endpoints, keys, OpenAI transport, structured output, failure codes). PRs 3c/3d are drafted separately. Nothing in 3a or 3b makes an endpoint selectable in any picker, saved default or env-accepted value (Global Constraints).

**How to read the citations.** `file:line` references are to `origin/main` 2b63b451. Files that waves 1–2 create (`server/src/analyzer/runner/*`, `server/src/analyzer/transports/*`, `server/src/analyzer/capacity.ts`, `server/src/analyzer/reasoning.ts`) do not exist on that commit, so they are cited **by symbol**, marked **(W1)** / **(W2)**. Before each task, re-read every cited line on current `main`: waves 0–2 touch `user-settings.ts`, `select-analyzer.ts`, `rate-limit.ts`, `gemini.ts`, `ollama.ts`, and the analysing view.

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

**Branch:** `refactor/server,frontend-3084-w3a-engine-ids`
Create the worktree with `node scripts/wt-new.mjs refactor/server,frontend-3084-w3a-engine-ids`, off the latest `main`.

**What it delivers.**
- `AnalysisEngine = 'local' | 'gemini' | 'openai'` at every analyzer-engine **type** site.
- One id grammar, implemented twice — `server/src/analyzer/model-id.ts` and `src/lib/model-id.ts` — driven by one shared case table.
- Every site that turns a **selection id** into an Ollama call now uses that inference, so an `openai:<endpointId>::<model>` id can never reach Ollama.
- The `'local'` comparison classification table below (spec §1 last bullet), recorded as the design of record.

**What it must NOT change.**
- **Persisted/validated inputs still refuse `'openai'`.** Three sites keep rejecting it until PR 3d (the former fourth, the `analyzer.engine` registry enum, was removed by #3200 / PR #3201 before this wave):
  - `ANALYSIS_ENGINE_VALUES` (`server/src/workspace/user-settings.ts:98`, used at `:141`);
  - the `PERSONA_GEN_ENGINE` enum (`registry.ts:1187`);
  - the OpenAPI `analysisEngine` enums (`openapi.yaml:4628`, `:4831`), and so the regenerated `src/lib/api-types.ts`.
- **No request changes.** No Ollama or Gemini request changes for any id that doesn't match `^openai:[a-z0-9-]+::`.
- **Budget resolvers untouched.** No budget resolver (wave 2 owns them) and no picker contents change.
- **No new FailureCode, knob, route, or OpenAPI change.**

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

#### Which engine-literal sites widen in 3a, and which flip in 3d

| Widens in 3a (TypeScript types and non-persisted validation) | Keeps rejecting `'openai'` until PR 3d (persisted/validated inputs) |
|---|---|
| `server/src/analyzer/index.ts:181` (`AnalyzerSelection.engine`) | `server/src/workspace/user-settings.ts:98,141` (`ANALYSIS_ENGINE_VALUES` — validates `user-settings.json` and the general PUT) |
| `server/src/store/analysis-state.ts:52`, `server/src/workspace/active-analyses.ts:47` (run snapshots) | `server/src/config/registry.ts:1181-1191` (`PERSONA_GEN_ENGINE` enum) |
| `server/src/routes/analysis.ts:561` (`engineLabel` param), `:1215` (`engineFallbackMsPerChar` param), `:2655` (`AnalysisJobState.engine`) | `openapi.yaml:4628` (`UserSettings.analysisEngine`) and `:4831` (`UserSettingsPatch.analysisEngine`) + regenerated `api-types.ts` |
| `server/src/routes/setup-diagnosis.ts:309`, `server/src/routes/models-inventory.ts:120` | |
| `server/src/workspace/user-settings.ts:781` (`getResolvedAnalysisEngine` **return type only**) | |
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
| 29 | `server/src/routes/analysis.ts:3203` **NEW** | `job.engine === 'local'` → `unloadResidentOllama` | ollama-specific | unchanged | endpoints unload only through decision-4 eviction (3d) |
| 30 | `server/src/routes/analysis.ts:3625` **NEW** | `usesLocalAnalyzer` → `detectOllamaDevice` | ollama-specific | unchanged | probes Ollama's device only |
| 31 | `server/src/routes/script-review.ts:724` **NEW** | warm Ollama model | ollama-specific | unchanged | |
| 32 | `server/src/routes/script-review.ts:780` **NEW** | `pinnedLocal` → Ollama keep-alive pin | ollama-specific | unchanged | `keepAliveFor` is Ollama's |
| 33 | `server/src/routes/diagnostics.ts:259` **NEW** | Ollama diagnostics row | ollama-specific | unchanged | |
| 34 | `server/src/routes/diagnostics.ts:299` **NEW** | Gemini diagnostics row | gemini-specific | unchanged | |
| 35 | `server/src/routes/setup-diagnosis.ts:309` **NEW** | `AnalyzerDiagnosisInput.engine` | type | 3a (Task 3a.2) | |
| 36 | `server/src/routes/setup-diagnosis.ts:323` **NEW** | `engine === 'gemini'` else Ollama checks | persisted-engine readiness gate | PR 3d | unreachable until `analysisEngine` can be `openai`; then an endpoint needs its own branch |
| 37 | `server/src/routes/setup-readiness.ts:204` **NEW** | `getResolvedAnalysisEngine() === 'gemini'` | persisted-engine readiness gate | PR 3d | same |
| 38 | `server/src/routes/models-inventory.ts:120` **NEW** | `InventoryDeps.analysisEngine` | type | 3a (Task 3a.2) | |
| 39 | `server/src/routes/models-inventory.ts:382` **NEW** | `analysisEngine === 'local' && tagMatches(...)` | ollama-specific | unchanged | marks which Ollama tag is the default |
| 40 | `server/src/workspace/active-analyses.ts:47` | snapshot `engine?` | type | 3a (Task 3a.2) | |
| 41 | `server/src/store/analysis-state.ts:52` **NEW** | snapshot `engine?` | type | 3a (Task 3a.2) | |
| 42 | `server/src/workspace/user-settings.ts:781-783` | `getResolvedAnalysisEngine` | coercion | 3a return type; PR 3d body (with the enum flip) | the body can't compare to `'openai'` while the stored type is narrow |
| 43 | `src/store/analysis-slice.ts:33` | `AnalysisStreamSnapshot.engine` | type (shares-gpu snapshot) | 3a type; PR 3d adds `gpu` | |
| 44 | `src/store/analysis-substage-reducers.ts:31`, `src/store/analysis-substage-selectors.ts:43` | substage `engine?` | type | 3a (Task 3a.3) | |
| 45 | `src/store/prosody-slice.ts:35` | `engine?` (verified: analyzer backend, "flips to 'gemini' on a mid-pass fallback") | type | 3a (Task 3a.3) | |
| 46 | `src/views/analysing.tsx:340` | `isLocalAnalyzer` | ollama-specific (Ollama health/residency gating) | unchanged; shared inference excludes endpoint ids | |
| 47 | `src/views/analysing.tsx:344` | `effectiveEngine` | shares-gpu (snapshot engine for the reverse guard) | 3a type; PR 3d derives endpoint engine + `gpu` | today a non-local id is tagged `'gemini'` |
| 48 | `src/views/advanced.tsx:293`, `:556` | `analyzerEngine = values['analyzer.engine']?.effective` → `group.id === 'analyzer-models' && analyzerEngine === 'local'` | removed by #3200 (PR #3201); the device block reads `account.analysisEngine === 'local'`, which already hides it for `openai`; no change | PR #3201 (before this wave) | it renders only the read-only "Analyzer (Ollama) device" row (`:557-590` on 2b63b451) |
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

### Task 3a.2: Server engine union, endpoint-id refusal in `selectAnalyzer`, label

**Files:**
- Modify: `server/src/analyzer/index.ts:23-30` (imports), `:176-197` (selection type and private inference), `:199-206` (insert the refusal branch)
- Modify: `server/src/analyzer/select-analyzer.ts:74-76` (comment made false)
- Modify: `server/src/workspace/user-settings.ts:773-783`
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
  - `export function engineLabel(engine: AnalysisEngine, modelId: string): string`.

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
import { OllamaAnalyzer } from './ollama.js';
import {
  _resetUserSettingsCache,
  _setUserSettingsCacheForTest,
} from '../workspace/user-settings.js';

describe('selectAnalyzer — endpoint-shaped model ids (#3084 PR 3a)', () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    _setUserSettingsCacheForTest({ geminiApiKey: null });
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    _resetUserSettingsCache();
  });

  it('refuses an openai:<endpoint>::<model> id instead of handing it to Ollama', () => {
    expect(() => selectAnalyzer({ model: 'openai:lab::qwen3:30b' })).toThrow(
      /OpenAI-compatible endpoint/,
    );
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
- `refuses an openai:<endpoint>::<model> id…` FAILS with `expected [Function] to throw an error`. Today the id is routed to `OllamaAnalyzer`.
- `labels an endpoint id…` FAILS with `engineLabel is not a function`. It is not exported today.
- `refuses analysisEngine "openai"…` **PASSES**, by design. It pins that 3a does *not* widen the persisted enum; its mutation proof is Step 5.

- [ ] **Step 3: Implement**

In `server/src/analyzer/index.ts`:
1. Add to the imports block (`:23-30`):
   ```ts
   import { inferEngineFromModelId, type AnalysisEngine } from './model-id.js';
   ```
2. `:181` becomes `  engine: AnalysisEngine;`.
3. Delete the private function and its comment (`:189-197`). Replace them with this comment only:
   ```ts
   /* Engine inference from a per-request model id lives in ./model-id.ts
      (shared case table with the frontend): `openai:<endpointId>::<model>` →
      openai, contains ':' → local (Ollama), else gemini. */
   ```
4. Insert immediately before `  if (engine === 'local') {` (`:206`):
   ```ts
     if (engine === 'openai') {
       /* #3084 PR 3a — endpoint ids have a grammar but no analyzer yet; PR 3d
          builds OpenAIAnalyzer here. Refusing is what keeps an `openai:` id out
          of the Ollama branch below (it contains ':'). */
       throw new Error(
         `Model "${opts.model ?? '(saved default)'}" names an OpenAI-compatible endpoint, which this build cannot run yet.`,
       );
     }
   ```

In `server/src/analyzer/select-analyzer.ts:74-76`, replace the comment text `it routes via \`inferEngineFromModelId\` (':' → local, otherwise → Gemini).` with:
```
it routes via `inferEngineFromModelId` (./model-id.ts: endpoint shape →
openai, ':' → local, otherwise → Gemini).
```

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
2. **Persisted enum.** In `user-settings.ts:98`, change `ANALYSIS_ENGINE_VALUES` to `['local', 'gemini', 'openai'] as const`. Expect red on `refuses analysisEngine "openai" until endpoints are selectable (#3084 PR 3a)`: status 200, not 400. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/index.ts server/src/analyzer/select-analyzer.ts server/src/workspace/user-settings.ts server/src/store/analysis-state.ts server/src/workspace/active-analyses.ts server/src/routes/analysis.ts server/src/routes/setup-diagnosis.ts server/src/routes/models-inventory.ts server/src/analyzer/select-analyzer-endpoint-id.test.ts server/src/routes/analysis-engine-label.test.ts server/src/routes/user-settings.test.ts
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
- `server/src/workspace/user-settings.ts:769` — `getResolvedOllamaModel`; `ollama-health.ts:199,205,218` and `models-inventory.ts:132` inherit from it.
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
- Modify: `server/src/workspace/user-settings.ts:757-771`
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
  DEFAULT_OLLAMA_MODEL,
  getResolvedOllamaModel,
  _resetUserSettingsCache,
  _setUserSettingsCacheForTest,
} from './user-settings.js';

describe('getResolvedOllamaModel — endpoint ids never reach Ollama (#3084 PR 3a)', () => {
  const saved = process.env.OLLAMA_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = saved;
    _resetUserSettingsCache();
  });

  it('ignores a saved openai:<endpoint>::<model> default and falls back to the Ollama default', () => {
    delete process.env.OLLAMA_MODEL;
    _setUserSettingsCacheForTest({ defaultAnalysisModel: 'openai:lab::qwen3:30b' });
    expect(getResolvedOllamaModel()).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it('keeps a saved Ollama tag named openai:latest', () => {
    _setUserSettingsCacheForTest({ defaultAnalysisModel: 'openai:latest' });
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
- `ignores a saved openai:<endpoint>::<model> default…` FAILS: received `'openai:lab::qwen3:30b'`.
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
    Ollama tag, so both fall through to OLLAMA_MODEL / DEFAULT_OLLAMA_MODEL. */
export function getResolvedOllamaModel(): string {
  const c = cached;
  const fromSettings = c?.defaultAnalysisModel;
  if (fromSettings && inferEngineFromModelId(fromSettings) === 'local') return fromSettings;
  return process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
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
| `getResolvedOllamaModel` back to `fromSettings.includes(':')` | `ignores a saved openai:<endpoint>::<model> default…` |
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
```

**Classification rule for every hit** of the first three commands. Apply the first rule that fits:
1. **Not a model id.** Host strings, clock strings, cover ids, sentence keys, lock keys and device keys: `src/lib/sidecar-url.ts:41`, `server/src/workspace/sidecar-url.ts:43`, `src/lib/time.ts:5`, `src/views/manuscript.tsx:1456`, `src/modals/reassign-lines.tsx:170`, `server/src/cover/search.ts:74`, `server/src/lan-auth.ts:126`, `server/src/workspace/chapter-durations.ts:8`. → Excluded, one line of reason each.
2. **Ollama-sourced.** Tags from `/api/tags` or `/api/ps`, the pull allowlist, curated `MODEL_OPTIONS` local entries, or `this.model` inside the Ollama transport (e.g. `server/src/analyzer/ollama.ts:204` `normalizeModelTag` for keep-alive). → Unchanged; name the source, as in the table above.
3. **A selection id.** A value from user settings, a registry knob, a request body/query, a run pick, or an SSE `model` field that then reaches Ollama. → It must go through `inferEngineFromModelId` / `engineForModelId` first, with a test using `openai:lab::qwen3:30b`. A hit of this kind that isn't in this task is a finding: fix it in this PR under "Also fixed, found in passing", per CLAUDE.md "Incidental findings".

For the fourth command, every hit must be a row of the classification table or its excluded list. A new hit gets a row.

- [ ] **Step 7: Commit**
```bash
git add server/src/workspace/user-settings.ts server/src/analyzer/voice-style.ts server/src/routes/ollama-health.ts src/lib/models.ts server/src/workspace/user-settings.endpoint-ids.test.ts server/src/analyzer/voice-style.persona-model.test.ts server/src/routes/ollama-health-load.endpoint-id.test.ts src/lib/models.endpoint-ids.test.ts
git commit -m "fix(server,frontend): keep endpoint model ids away from every ollama selection site"
```

---

### Task 3a.5: Ship PR 3a

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

  > No shippable delta: the engine union and id grammar are internal. The only behavioural changes refuse an `openai:<endpoint>::<model>` id at four sites no UI can reach yet (a hand-edited saved default, a hand-set persona model knob, `POST /api/ollama/load`, and `selectAnalyzer`). Release-notes entries land with PR 3d, when endpoints become selectable.

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

**Branch:** `feat/server,openapi-3084-w3b-endpoints`
Create it with `node scripts/wt-new.mjs feat/server,openapi-3084-w3b-endpoints`, off `main` with PR 3a merged. Commits also carry `frontend` and `docs` scopes where the task touches `src/` or `CLAUDE.md`.

**What it delivers.**
- **Failure codes.** `analyzer-request-rejected`, `analyzer-invalid-output`, `analyzer-timeout` and `analyzer-endpoint-missing` exist in all six places. If wave 2's Gemini Branch B (Task 2.9B) already shipped `analyzer-timeout`, it is reused, not re-added (Task 3b.1's branch check).
- **Typed errors.** `AnalyzerStreamIncompleteError`, `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError` and `AnalyzerInvalidOutputError` are added. `AnalyzerTimeoutError` is added too, unless wave 2 Branch B already added it with the same constructor.
- **Error mappings.** 401/403 and key-origin errors map to `auth`. Any 400 maps to `analyzer-request-rejected`, with a redacted provider message and the request-shaping settings named.
- **Schema adapters.** Per-provider adapters (with a `dropped` snapshot per stage schema) are wired into the runner for Ollama and Gemini now, and for OpenAI through `OpenAIAnalyzer`. `structuredOutputLabel` is exported for 3d.
- **Structured-output knobs.** `analyzer.ollama.structuredOutput` (default `schema`) and `analyzer.gemini.structuredOutput` (default `json`) are enum knobs with Settings rows and `config:sync`. The Ollama and Gemini transports honour all three modes.
- **Endpoint storage.** `workspace/analyzer-endpoints.ts` and the user-settings fields `analyzerEndpoints` (in GET, not writable by the general PUT) and `analyzerEndpointKeys` (FORBIDDEN_KEYS; GET exposes `analyzerEndpointKeyStatus`).
- **Routes.** `server/src/routes/analyzer-endpoints.ts`: create, update, delete, key write, and Detect.
- **Client side.** OpenAPI schemas plus mocks (Detect excepted), regenerated `api-types.ts`, and the account-slice thunks. There is no UI.
- **Transport.** `openai@^7.15.0`, `transports/endpoint-runtime.ts`, `transports/openai-transport.ts` with its real-socket contract suite, `OPENAI_RETRY_POLICY`, and `OpenAIAnalyzer`.

**What it must NOT change.**
- No picker, saved default, env var or `selectAnalyzer` branch accepts an endpoint id. `selectAnalyzer` still refuses it (PR 3a).
- No GPU guard, eviction or in-flight registration (PR 3d).
- No catalog, Test action, capacity branch for endpoints, or rate-limit settings map (PR 3c).
- **Default requests stay byte-identical.** Ollama sends the same `format` schema. Gemini sends only `responseMimeType`. The Ollama 404/500/503 classification stays byte-identical, and so does every existing taxonomy outcome except the deliberate 400 change.
- No reasoning or custom-payload controls (wave 5).

**Entry criteria.**
- PR 3a is merged.
- Wave 1's `withTransportRetry`, `StageRunner`/`TransportAnalyzer` and both transports exist on `main`.

**Exit criteria.**
- All of these pass: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:server`, `npm run config:check`, `npm run check:cycles`.
- The OpenAI contract suite is green, and every mutation proof is pasted in the PR.
- `npm run openapi:types` leaves no diff.
- The register row, run sheet and live view are published per Task 3b.13.

---

### Task 3b.1: Typed wave-3 errors, four failure codes, 400 / 401 / 403 mapping, redaction

**Files:**
- Modify: `server/src/analyzer/errors.ts` (W1) — append after `AnalyzerReasoningOverflowError` (W2).
- Create: `server/src/analyzer/redact.ts`, `server/src/analyzer/redact.test.ts`.
- Modify: `server/src/workspace/user-settings.ts` — add `knownAnalyzerSecrets()` after `getResolvedGeminiApiKey` (`:830-836`).
- Modify: `server/src/routes/failure-taxonomy.ts`:
  - `:23-27` imports;
  - `:29-52` union;
  - after `:156` signature rows;
  - `:463-479` `statusToFailureCode`;
  - `:492-564` `classifyAnalysisFailure`.
- Modify: `server/src/routes/failure-remediations.ts` — insert four entries before `unknown` (`:247`).
- Modify: `openapi.yaml:7033-7056` (`FailureCode` enum).
- Regenerate: `src/lib/api-types.ts`.
- Modify: `src/data/help-failures.ts:28-55` (`CATEGORIES`), `:57-81` (`TITLES`).
- Modify: `src/data/help-failures.test.ts:13`, `src/data/help-categories.test.ts:24`.
- Test: `server/src/routes/failure-taxonomy.test.ts` — sorted list `:400-428`, plus a new describe.

**Interfaces:**
- Consumes (W1): `TransportKind`, `AnalyzerHttpError`, `AnalyzerTruncatedError`, and `ApiError` from `@google/genai`.
- Produces (the contract signatures):
  - `AnalyzerTimeoutError(transport, model, elapsedMs, reason)`
  - `AnalyzerStreamIncompleteError(transport, model)`
  - `AnalyzerEndpointMissingError(endpointId, source)`
  - `AnalyzerKeyOriginError(endpointId, endpointName)`
  - `AnalyzerInvalidOutputError(transport, model, key, detail, structuredOutputMode)`
- Produces (additional): `redactKnownSecrets(text, secrets)`, `REDACTED`, `knownAnalyzerSecrets()`.

**Tests kept green:**
- `server/src/routes/failure-taxonomy.test.ts` — every existing case, including the Gemini 429/500/503 envelope cases.
- `server/src/routes/analysis.test.ts`
- `src/data/help-failures.test.ts`
- `src/data/help-categories.test.ts`
- `src/views/generation.test.tsx`
- `src/lib/router.test.ts`

**Branch check — does `AnalyzerTimeoutError` already exist?** Wave 2's Task 2.9B (Gemini Branch B) pulls `AnalyzerTimeoutError` and FailureCode `analyzer-timeout` forward from this task. Before Step 1, run:
```bash
git grep -n 'class AnalyzerTimeoutError' server/src
```
- **Found — wave 2 Branch B shipped.** Skip adding the class and the code: skip every step below marked **[timeout: skip if found]**, and apply every step marked **[timeout: only if found]**.
  - W2's class already has this task's constructor, `(transport: TransportKind, model: string, elapsedMs: number, reason: 'ceiling' | 'connect-timeout')`.
  - W2's classify branch already names "this endpoint's request ceiling" for a non-Gemini transport.
  - So this task adds only the OpenAI usage (Task 3b.11 throws it with `transport: 'openai'`), the endpoint-aware remediation copy and the tests.
- **Not found — Branch A.** Add the class and the code as written, and skip the **[timeout: only if found]** steps.

The `AnalyzerTimeoutError → analyzer-timeout` test below passes against either classify branch. Both messages carry `1800 s`, both details carry `reason=ceiling`, and both remediations name the endpoint.

**Help counts are the same in both branches.** Wave 2 left `help-failures.test.ts` / `help-categories.test.ts` at 24 / 50 (Branch A) or 25 / 51 (Branch B). This task adds four codes (Branch A) or three (Branch B), so both end at 28 / 54.

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

First, replace the sorted list at `:402-426` with this final list. Wave 2 already added `analyzer-reasoning-overflow`, and in Branch B `analyzer-timeout`. The final list is the same in both branches:
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
} from '../analyzer/errors.js';
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

  it('a Gemini ApiError 400 envelope → analyzer-request-rejected with the provider message', () => {
    const err = new ApiError({
      status: 400,
      message:
        'got status: 400 Bad Request. {"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \\"minLength\\"","status":"INVALID_ARGUMENT"}}',
    });
    const r = classifyAnalysisFailure(err, 'Gemini 3.6 Flash');
    expect(r.code).toBe('analyzer-request-rejected');
    expect(r.userMessage).toContain('Unknown name');
    expect(r.remediation).toContain('analyzer.gemini.structuredOutput');
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

describe('classifyAnalysisFailure — Ollama HTTP outcomes other than 400 stay exactly as on main', () => {
  /* Differential: the typed error must classify identically to the plain Error
     main throws today with the same message (ollama.ts:713-715). No expected
     code is written down here — main's own classifier is the oracle. */
  const base = 'http://127.0.0.1:11434';
  it.each([
    [404, 'Not Found', '{"error":"model \\"qwen3.5:9b\\" not found, try pulling it first"}'],
    [500, 'Internal Server Error', '{"error":"llama runner process has terminated: exit status 2"}'],
    [503, 'Service Unavailable', '{"error":"server busy, please try again.  maximum pending requests exceeded"}'],
  ])('AnalyzerHttpError(ollama, %i) classifies like the pre-wave-1 plain Error', (status, statusText, body) => {
    const message = `Ollama ${base} returned ${status} ${statusText}: ${body}`;
    const legacy = classifyAnalysisFailure(new Error(message), 'Ollama (qwen3.5:9b)');
    const typed = classifyAnalysisFailure(
      new AnalyzerHttpError('ollama', status, body, message),
      'Ollama (qwen3.5:9b)',
    );
    expect(typed).toEqual(legacy);
  });
});
```

Change `src/data/help-failures.test.ts:13` to `    expect(HELP_FAILURE_ENTRIES.length).toBe(28);`, and the expected count at `src/data/help-categories.test.ts:24` to `54`. Both numbers are the same in either branch (see "Help counts" above).

- [ ] **Step 2: Run and confirm failures**

Run:
```bash
npm --prefix server run test -- src/analyzer/redact.test.ts src/routes/failure-taxonomy.test.ts
npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts
```

Expected:
- `redact.test.ts` fails to resolve `./redact.js`.
- `failure-taxonomy.test.ts` fails on the new error-class imports: `does not provide an export named 'AnalyzerKeyOriginError'`.
- `help-failures` FAILS with `expected 24 to be 28` (Branch A) or `expected 25 to be 28` (Branch B). `help-categories` fails the same way against `54` (received 50 or 51).

The differential describe is expected to pass immediately after implementation; it pins main's outcome for 404/500/503.

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

`server/src/workspace/user-settings.ts` — insert after `getResolvedGeminiApiKey` (`:836`):
```ts
/** Every analyzer credential this process could send, for redacting upstream
    error text (#3084). Task 3b.6 adds the endpoint keys. */
export function knownAnalyzerSecrets(): string[] {
  const out: string[] = [];
  const gemini = getResolvedGeminiApiKey();
  if (gemini) out.push(gemini);
  return out;
}
```

Append the block below to `server/src/analyzer/errors.ts`. **[timeout: skip if found]** applies to its `AnalyzerTimeoutError` class: if the branch check found wave 2's class, delete that class and its doc comment from the block before appending, and leave W2's class exactly as it is. `TRANSPORT_LABEL` is appended either way, because the other classes use it.
```ts
/* ── #3084 PR 3b — wave-3 analyzer errors ───────────────────────────────── */

const TRANSPORT_LABEL: Record<TransportKind, string> = {
  ollama: 'Ollama',
  gemini: 'Gemini',
  openai: 'Endpoint',
};

/** The request ceiling (decision 1c) or an SDK connect-timeout fired after the
    call left its queue. Never a fallback trigger. */
export class AnalyzerTimeoutError extends Error {
  readonly code = 'ANALYZER_TIMEOUT';
  constructor(
    readonly transport: TransportKind,
    readonly model: string,
    readonly elapsedMs: number,
    readonly reason: 'ceiling' | 'connect-timeout',
  ) {
    super(
      `${TRANSPORT_LABEL[transport]} ${model} timed out after ${Math.round(elapsedMs / 1000)} s (${reason}).`,
    );
    this.name = 'AnalyzerTimeoutError';
  }
}

/** A stream that ended — cleanly, by socket drop, or by the idle watchdog —
    after response headers but before a finish reason. Retried like an idle stream. */
export class AnalyzerStreamIncompleteError extends Error {
  readonly code = 'ANALYZER_STREAM_INCOMPLETE';
  constructor(
    readonly transport: TransportKind,
    readonly model: string,
  ) {
    super(`${TRANSPORT_LABEL[transport]} ${model} stream ended before a finish reason.`);
    this.name = 'AnalyzerStreamIncompleteError';
  }
}

const ENDPOINT_SOURCE_LABEL: Record<AnalyzerEndpointMissingError['source'], string> = {
  settings: 'a saved setting',
  env: 'ANALYZER_PHASE0_MODEL / ANALYZER_PHASE1_MODEL',
  'run-pick': "this run's model pick",
  persona: 'the persona generation engine',
};

/** A model id names an endpoint id that is not in saved settings. Thrown by
    PR 3c's pre-run checks, before the first call. */
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
  'analyzer-timeout': {
    userMessage: 'The analyzer did not finish the request within its time limit.',
    remediation:
      "Retry the chapter. For an OpenAI-compatible endpoint, raise the endpoint's request time limit " +
      'or use a smaller model. The limit starts only after the request leaves the rate limiter and the ' +
      "endpoint's queue, so time spent waiting behind another request does not count.",
  },
  'analyzer-endpoint-missing': {
    userMessage: 'The run names an analyzer endpoint that is not configured.',
    remediation:
      'Add the endpoint in Settings, or pick a different model for this run. If the model came from ' +
      'ANALYZER_PHASE0_MODEL / ANALYZER_PHASE1_MODEL in server/.env, fix or clear that value.',
  },
```
**[timeout: skip if found]** the `'analyzer-timeout'` entry above.

**[timeout: only if found]** Instead of adding that entry, replace the `remediation` of wave 2's existing `'analyzer-timeout'` entry, which names only the Gemini ceiling, with:
```ts
    remediation:
      "Retry the chapter. If it recurs, raise the time limit of the engine that timed out — 'Gemini request " +
      "ceiling' (ANALYZER_GEMINI_REQUEST_CEILING_MS) for Gemini, or the endpoint's request time limit for an " +
      "OpenAI-compatible endpoint — lower the model's reasoning level, or switch to a faster analyzer model.",
```

`server/src/routes/failure-taxonomy.ts`:

1. Imports. Replace `:25-26` with the block below. In Branch B this also replaces wave 2's `import { AnalyzerTimeoutError, AnalyzerTruncatedError } from '../analyzer/errors.js';` line.
```ts
import { ApiError } from '@google/genai';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import {
  AnalyzerTruncatedError,
  AnalyzerHttpError,
  AnalyzerKeyOriginError,
  AnalyzerTimeoutError,
  AnalyzerEndpointMissingError,
  AnalyzerInvalidOutputError,
  type TransportKind,
} from '../analyzer/errors.js';
import { redactKnownSecrets } from '../analyzer/redact.js';
import { knownAnalyzerSecrets } from '../workspace/user-settings.js';
```

2. Union. After `  | 'analyzer-content-blocked'` (`:37`), add:
```ts
  | 'analyzer-request-rejected'
  | 'analyzer-invalid-output'
  | 'analyzer-timeout'
  | 'analyzer-endpoint-missing'
```
**[timeout: skip if found]** the `| 'analyzer-timeout'` line: in Branch B the union already has it.

3. Signature rows. After the `analyzer-content-blocked` row (ends `:156`), insert:
```ts
  /* #3084 PR 3b — typed wave-3 analyzer errors, name-driven like
     analyzer-truncated. classifyAnalysisFailure handles each first with a
     dynamic message; these rows keep the bare classifyAnalysisError scan in
     step. Status-driven outcomes (request-rejected, auth for endpoint keys)
     have no row: they need the error's HTTP status, read in
     classifyAnalysisFailure. */
  {
    code: 'analyzer-timeout',
    fatal: true,
    source: 'analysis',
    matchName: 'AnalyzerTimeoutError',
    match: () => false,
  },
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
**[timeout: skip if found]** the `analyzer-timeout` row above. Wave 2's row stays as it is; it is also `fatal: true`. `fatal` is the table's legacy stop-the-run-vs-skip-and-advance flag. A fired request ceiling is never retried and never falls back, so it sits with `analyzer-unreachable` (`fatal: true`). It does not sit with `analyzer-truncated` (`fatal: false`), which a chunk split recovers.

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

function requestRejected(
  modelLabel: string,
  transport: TransportKind | undefined,
  providerMessage: string,
): AnalysisFailure {
  const redacted = redactKnownSecrets(providerMessage, knownAnalyzerSecrets()).slice(0, 500);
  const settings = transport
    ? REQUEST_SHAPING_SETTINGS[transport]
    : Object.values(REQUEST_SHAPING_SETTINGS).flat();
  return {
    code: 'analyzer-request-rejected',
    userMessage: `${modelLabel} rejected the request (400): ${redacted}`,
    remediation: `${FAILURE_REMEDIATIONS['analyzer-request-rejected'].remediation} Settings that shape this request: ${settings.join('; ')}.`,
    detail: redacted || undefined,
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
  if (err instanceof AnalyzerHttpError) {
    if (err.httpStatus === 401 || err.httpStatus === 403) {
      return withCopy(
        'auth',
        `${modelLabel} refused the credentials (${err.httpStatus}) — check ${KEY_SETTING[err.transport]}.`,
        redactKnownSecrets(err.bodyExcerpt, knownAnalyzerSecrets()) || undefined,
      );
    }
    if (err.httpStatus === 400) return requestRejected(modelLabel, err.transport, err.bodyExcerpt);
  }
  if (err instanceof AnalyzerTimeoutError) {
    return withCopy(
      'analyzer-timeout',
      `${modelLabel} did not finish within its request time limit (${Math.round(err.elapsedMs / 1000)} s).`,
      `transport=${err.transport} reason=${err.reason} elapsedMs=${err.elapsedMs}`,
    );
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
**[timeout: skip if found]** the `if (err instanceof AnalyzerTimeoutError) { … }` branch above. Wave 2's branch, inserted after the `AnalyzerTruncatedError` branch, stays, and it already covers `transport: 'openai'`.

In the envelope branch, directly after `const code = statusToFailureCode(parsed.code ?? status, parsed.message);` (`:547`), insert:
```ts
    if (code === 'analyzer-request-rejected') {
      return requestRejected(modelLabel, err instanceof ApiError ? 'gemini' : undefined, parsed.message);
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

`openapi.yaml`: after `        - language-unset` (`:7056`), add:
```yaml
        - analyzer-request-rejected
        - analyzer-invalid-output
        - analyzer-timeout
        - analyzer-endpoint-missing
```
**[timeout: skip if found]** the `- analyzer-timeout` line. Then run `npm run openapi:types`.

`src/data/help-failures.ts`:
- In `CATEGORIES`, after `'analyzer-content-blocked': 'analysis',` (`:36`):
  ```ts
    'analyzer-request-rejected': 'analysis',
    'analyzer-invalid-output': 'analysis',
    'analyzer-timeout': 'analysis',
    'analyzer-endpoint-missing': 'analysis',
  ```
- In `TITLES`, after `'analyzer-content-blocked': …,` (`:65`):
  ```ts
    'analyzer-request-rejected': 'Analyzer rejected the request',
    'analyzer-invalid-output': 'Analyzer reply failed validation',
    'analyzer-timeout': 'Analyzer request timed out',
    'analyzer-endpoint-missing': 'Analyzer endpoint not configured',
  ```
- **[timeout: skip if found]** both `'analyzer-timeout'` lines above. Wave 2 added its own category and title.

- [ ] **Step 4: Run and confirm pass**

```bash
npm --prefix server run test -- src/analyzer/redact.test.ts src/routes/failure-taxonomy.test.ts src/routes/analysis.test.ts
npx vitest run src/data src/lib/router.test.ts src/views/generation.test.tsx
npm run typecheck
npm run check:cycles
```

Expected: PASS. `check:cycles` must show no new cycle from `routes/failure-taxonomy.ts` → `workspace/user-settings.ts`. If it does, move `knownAnalyzerSecrets` into `analyzer/redact.ts`, taking `getCachedUserSettings` as a parameter, and re-run.

- [ ] **Step 5: Mutation proofs**

Revert one line at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| Delete `if (status === 400) return 'analyzer-request-rejected';` | `a Gemini ApiError 400 envelope → analyzer-request-rejected…` |
| Delete `if (err.httpStatus === 400) return requestRejected(…);` | `AnalyzerHttpError(openai, 400) → analyzer-request-rejected…` |
| `redactKnownSecrets` body → `return text;` | `redacts a saved API key…` |
| Remove the `(err.httpStatus === 401 \|\| err.httpStatus === 403)` branch | `AnalyzerHttpError(openai, 401) → auth` |
| Change the branch to `err.httpStatus >= 400` (catches 404/500/503) | the differential `AnalyzerHttpError(ollama, 500) classifies like the pre-wave-1 plain Error` |

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/errors.ts server/src/analyzer/redact.ts server/src/analyzer/redact.test.ts server/src/workspace/user-settings.ts server/src/routes/failure-taxonomy.ts server/src/routes/failure-remediations.ts server/src/routes/failure-taxonomy.test.ts openapi.yaml src/lib/api-types.ts src/data/help-failures.ts src/data/help-failures.test.ts src/data/help-categories.test.ts
git commit -m "feat(server,openapi): add request-rejected, invalid-output, timeout and endpoint-missing failure codes"
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
- Test: `server/src/config/registry.test.ts` (add)
- Test: `server/src/analyzer/transports/structured-output-wire.test.ts` (new)
- Test: `server/src/analyzer/structured-output-settings.test.ts` (new)

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
    default: 'schema', // ← today's Ollama request: format = the stage schema (ollama.ts:643 on 2b63b451)
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.gemini.structuredOutput',
    env: 'ANALYZER_GEMINI_STRUCTURED_OUTPUT',
    group: 'analyzer-sampling',
    label: 'Gemini structured output',
    help: '"json" (default) sets responseMimeType application/json only — today\'s request. "schema" also sends the stage schema as responseJsonSchema, reduced to the keywords Gemini documents (length, pattern and non-integer exclusive-minimum constraints are dropped and listed in the debug log). "off" sends neither. Every reply is still validated against the full schema and retried once in every mode. The default moves to "schema" only after on-box measurement.',
    type: 'enum', options: ['schema', 'json', 'off'],
    default: 'json', // ← today's Gemini request: responseMimeType only (gemini.ts:729 on 2b63b451)
    apply: 'live', risk: 'medium',
  },
```
The Settings rows need no hand work. `src/views/advanced.tsx` renders every descriptor in `analyzer-sampling` from `GET /api/config`, so both knobs appear there as enum selects.

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
```

Expected:
- PASS.
- `config:check` is clean.
- `server/.env.example`'s managed block gains `# ANALYZER_OLLAMA_STRUCTURED_OUTPUT=schema` and `# ANALYZER_GEMINI_STRUCTURED_OUTPUT=json` lines.

- [ ] **Step 5: Mutation proofs**

Revert one change at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| In `ollama.ts`, set `structuredOutput: 'schema'` (the constant again) | `json sends format "json"` |
| In `gemini-transport.ts`, restore `responseMimeType: 'application/json'` in place of the spread | `off sends neither` and `schema sends the Gemini-adapted schema…` |
| In `gemini.ts`, `adaptSchema: adaptSchemaForOllama` (identity: keeps `$schema`) | `schema sends the Gemini-adapted schema (no $schema key)` |
| In `registry.ts`, Gemini `default: 'schema'` | the registry test **and** `default (json) sends responseMimeType only…` |

- [ ] **Step 6: Commit**
```bash
git add server/src/config/registry.ts server/src/config/registry.test.ts server/.env.example server/src/analyzer/transports/ollama-transport.ts server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/structured-output-wire.test.ts server/src/analyzer/runner/stage-runner.ts server/src/analyzer/ollama.ts server/src/analyzer/gemini.ts server/src/analyzer/structured-output-settings.test.ts
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
  endpointKeyStatus,
  findEndpointReferences,
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
  it('substitutes an encoded last-used model, and skips when none was used since start', () => {
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
    expect(r.details.join('\n')).toContain('contextTokens');
  });
  it.each(['Lab', 'lab_1', '', 'a'.repeat(41)])('refuses the endpoint id %j', (id) => {
    expect(refusal(() => applyCreate(empty, { ...base, id }))).toMatchObject({ status: 400, refusal: 'invalid' });
  });
  it('refuses a duplicate id', () => {
    const once = applyCreate(empty, base);
    expect(refusal(() => applyCreate(once, base))).toMatchObject({ status: 409, refusal: 'duplicate-id' });
  });
  it('refuses an unload URL on another origin, accepts one on the same origin', () => {
    expect(
      refusal(() => applyCreate(empty, { ...base, unloadUrl: 'http://127.0.0.1:9999/api/models/unload/{model}' })),
    ).toMatchObject({ status: 400, refusal: 'unload-off-origin' });
    expect(
      applyCreate(empty, { ...base, unloadUrl: 'http://127.0.0.1:8080/api/models/unload/{model}' }).analyzerEndpoints,
    ).toHaveLength(1);
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
    expect(r.details).toEqual([
      'Account setting "analyzerPhase0Model"',
      'Advanced setting "analyzer.phase1.model"',
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

/** User-settings fields that hold a selectable model id, as of 2b63b451
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
    readonly details: string[] = [],
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

export function resolveUnloadUrl(endpoint: AnalyzerEndpoint, lastUsedModel: string | undefined): string | null {
  if (!endpoint.unloadUrl) return null;
  if (!endpoint.unloadUrl.includes('{model}')) return endpoint.unloadUrl;
  if (!lastUsedModel) return null;
  return endpoint.unloadUrl.split('{model}').join(encodeURIComponent(lastUsedModel));
}

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
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const ep = parsed.data;
  if (ep.unloadUrl) {
    const unloadOrigin = new URL(ep.unloadUrl).origin;
    const baseOrigin = new URL(ep.baseUrl).origin;
    if (unloadOrigin !== baseOrigin) {
      throw new AnalyzerEndpointRefusal(
        400,
        'unload-off-origin',
        'The unload URL must be on the same scheme, host and port as the base URL.',
        [`unloadUrl origin ${unloadOrigin} is not baseUrl origin ${baseOrigin}`],
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
      refs,
    );
  }
  const keys = { ...state.analyzerEndpointKeys };
  delete keys[endpointId];
  return {
    analyzerEndpoints: state.analyzerEndpoints.filter((e) => e.id !== endpointId),
    analyzerEndpointKeys: keys,
  };
}

export function applyKey(state: EndpointState, endpointId: string, key: string | null): EndpointState {
  const ep = state.analyzerEndpoints[indexOrRefuse(state, endpointId)];
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
  - `:450-467` (`FORBIDDEN_KEYS`);
  - `knownAnalyzerSecrets` (Task 3b.1);
  - new `mutateUserSettings` after `writeUserSettings` (`:445`).
- Modify: `server/src/routes/user-settings.ts:19-27` (imports), `:32-66` (`UserSettingsResponse`, `envDerived` — now exported).
- Test: `server/src/routes/user-settings.test.ts` (add)
- Test: `server/src/workspace/user-settings.endpoints.test.ts` (new)

**Interfaces:**
- Consumes: `analyzerEndpointSchema`, `endpointKeyStatus`, `EndpointKeyStatus` (Task 3b.5).
- Produces:
  - `UserSettings.analyzerEndpoints: AnalyzerEndpoint[]`;
  - `UserSettings.analyzerEndpointKeys: Record<string, { origin: string; key: string }>`;
  - `export async function mutateUserSettings(decide: (current: UserSettings) => Partial<UserSettings>): Promise<UserSettings>`;
  - `export function envDerived(settings: UserSettings): UserSettingsResponse`;
  - a response field `analyzerEndpointKeyStatus: Record<string, EndpointKeyStatus>`.

**`mockPutUserSettings` whitelist note (Task 3b.9).** The three new fields are **not** added to `mockPutUserSettings`'s whitelist (`src/lib/api.ts:7312-7342`). That mirrors the server's `FORBIDDEN_KEYS`: the general PUT cannot write them. The mock CRUD functions mutate `MOCK_USER_SETTINGS` directly.

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
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import {
  USER_SETTINGS_PATH,
  _resetUserSettingsCache,
  knownAnalyzerSecrets,
  mutateUserSettings,
  readUserSettings,
} from './user-settings.js';

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
  _resetUserSettingsCache();
});
afterAll(() => {
  if (existsSync(USER_SETTINGS_PATH)) rmSync(USER_SETTINGS_PATH, { force: true });
  _resetUserSettingsCache();
});

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
- `user-settings.endpoints.test.ts` FAILS: `mutateUserSettings is not a function`.

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
  analyzerEndpointKeys: z.record(z.string(), z.object({ origin: z.string(), key: z.string() })).default({}),
```

3. Defaults. After `analyzerKeepAliveByModel: {},` (`:334`):
```ts
  /* #3084 — no endpoints and no keys on a fresh install. */
  analyzerEndpoints: [],
  analyzerEndpointKeys: {},
```

4. `FORBIDDEN_KEYS`. After `'tourCompletedAt',` (`:466`):
```ts
  /* #3084 PR 3b — analyzer endpoints are written only by the endpoint routes;
     their keys only by PUT /api/analyzer/endpoints/{id}/key; the key status is
     derived on GET. */
  'analyzerEndpoints',
  'analyzerEndpointKeys',
  'analyzerEndpointKeyStatus',
```

5. After `writeUserSettings` (ends `:445`):
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
    const current = await readUserSettings();
    const patch = decide(current);
    const merged = userSettingsSchema.parse({ ...current, ...patch });
    await writeJsonAtomic(USER_SETTINGS_PATH, merged);
    cached = merged;
    for (const key of Object.keys(patch)) explicitlySetKeys.add(key);
    return merged;
  });
  writeChain = next.catch(() => undefined);
  return next;
}
```

6. `knownAnalyzerSecrets` body becomes:
```ts
export function knownAnalyzerSecrets(): string[] {
  const out: string[] = [];
  const gemini = getResolvedGeminiApiKey();
  if (gemini) out.push(gemini);
  for (const entry of Object.values(cached?.analyzerEndpointKeys ?? {})) out.push(entry.key);
  return out;
}
```
Its doc comment's "Task 3b.6 adds the endpoint keys." sentence is deleted.

`server/src/routes/user-settings.ts`:

1. Imports. Add:
```ts
import { endpointKeyStatus, type EndpointKeyStatus } from '../workspace/analyzer-endpoints.js';
```

2. Replace `:32-66` with:
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
- No new cycle. `user-settings.ts` → `analyzer-endpoints.ts` → (`model-id.ts`, `errors.ts`); neither of those imports `user-settings.ts`.

- [ ] **Step 5: Mutation proofs**

Revert one change at a time, confirm the named test goes red, then restore:

| Revert | Expected red test |
|---|---|
| Delete `delete rest.analyzerEndpointKeys;` | `GET exposes analyzer endpoints and key status, never the keys` |
| Remove `'analyzerEndpointKeys'` from `FORBIDDEN_KEYS` | `the general PUT cannot write…` (the smuggled key reaches the file) |
| In `mutateUserSettings`, read `current` **outside** `writeChain.then` | `serialises concurrent decisions so neither change is lost` (one id lost) |

- [ ] **Step 6: Commit**
```bash
git add server/src/workspace/user-settings.ts server/src/routes/user-settings.ts server/src/routes/user-settings.test.ts server/src/workspace/user-settings.endpoints.test.ts
git commit -m "feat(server): store analyzer endpoints and origin-bound keys in user settings"
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
  - refusals as `{ error, code, details }` with status 400 / 404 / 409.

**Tests kept green:** `server/src/routes/user-settings.test.ts`, and any app-level integration test that imports `app.ts`.

- [ ] **Step 1: Write the failing test**

`server/src/routes/analyzer-endpoints.test.ts`:
```ts
/* Integration test for the analyzer endpoint routes (#3084 PR 3b), mirroring
   routes/user-settings.test.ts: real express, real user-settings file under a
   temp workspace, supertest. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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

  it('refuses a missing context size with 400 naming contextTokens', async () => {
    const noContext = { id: lab.id, name: lab.name, baseUrl: lab.baseUrl };
    const res = await request(app).post('/api/analyzer/endpoints').send(noContext);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid');
    expect(res.body.details.join('\n')).toContain('contextTokens');
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
});

describe('DELETE /api/analyzer/endpoints/:id', () => {
  it('is refused with 409 while a saved setting references the endpoint, listing each reference', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    await request(app)
      .put('/api/user/settings')
      .send({ analyzerPhase0Model: 'openai:lab::qwen3:30b', configOverrides: { 'analyzer.phase1.model': 'openai:lab::m' } });
    const res = await request(app).delete('/api/analyzer/endpoints/lab');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('referenced');
    expect(res.body.details).toEqual(['Account setting "analyzerPhase0Model"', 'Advanced setting "analyzer.phase1.model"']);
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
import { mutateUserSettings, type UserSettings } from '../workspace/user-settings.js';
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

/** Sends a refusal and returns true, or returns false for any other error. */
function sendRefusal(res: Response, err: unknown): boolean {
  if (!(err instanceof AnalyzerEndpointRefusal)) return false;
  res.status(err.status).json({ error: err.message, code: err.refusal, details: err.details });
  return true;
}

function fail(res: Response, what: string, err: unknown): void {
  /* err never carries a key: keys enter only through applyKey, which throws
     only AnalyzerEndpointRefusal (handled above). */
  console.error(`[analyzer-endpoints] ${what} failed`, err);
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
    return res.status(400).json({ error: 'Invalid payload.', code: 'invalid', details: parsed.error.issues.map((i) => i.message) });
  }
  try {
    const updated = await mutateUserSettings((current) =>
      applyKey(stateOf(current), req.params.endpointId, parsed.data.key),
    );
    res.json(envDerived(updated));
  } catch (err) {
    if (!sendRefusal(res, err)) fail(res, 'save the analyzer endpoint key', err);
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
  - `detectServedContext(input): Promise<{ ok: true; contextTokens: number; source: 'llama.cpp /props' | 'llama-swap /props' } | { ok: false; error: string; upstreamStatus?: number }>`;
  - the route: body `{ baseUrl, model?, apiKey?, endpointId?, flavor: 'llama.cpp' | 'llama-swap', allowModelLoad? }` → `200 { contextTokens, source }` / `400 { error, code }` / `502 { error, code: 'detect-failed', upstreamStatus? }`.

**Research facts applied (06-local-server-facts).**
- llama.cpp `/props` → `default_generation_settings.n_ctx` is the per-slot **served** context. `n_ctx_train` is never read.
- llama-swap `GET /props?model=<id>` **loads** the model, hence `allowModelLoad: true` is required.
- Both servers read the key from `Authorization: Bearer`.
- `/props` lives at the server root, not under `/v1`.

**Key rule (decision 3c).** A key typed in the request body is sent only to that request's `baseUrl`. A stored key (`endpointId`) is sent only when `keyOriginMatches`; on a mismatch nothing is sent, and the response is `400 { code: 'auth' }`.

**Tests kept green:** `server/src/routes/analyzer-endpoints.test.ts` (route order).

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/endpoint-detect.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { detectServedContext } from './endpoint-detect.js';

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

/* headers/body timeouts off: llama-swap's /props?model= blocks while it loads
   the model. The absolute bound is the per-flavor AbortSignal.timeout below. */
const DETECT_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });

export const DETECT_TIMEOUT_MS = { 'llama.cpp': 15_000, 'llama-swap': 300_000 } as const;

export type DetectResult =
  | { ok: true; contextTokens: number; source: 'llama.cpp /props' | 'llama-swap /props' }
  | { ok: false; error: string; upstreamStatus?: number };

export async function detectServedContext(input: {
  baseUrl: string;
  flavor: 'llama.cpp' | 'llama-swap';
  model?: string;
  apiKey: string | null;
  timeoutMs?: number;
  dispatcher?: Agent;
}): Promise<DetectResult> {
  const url = new URL('/props', input.baseUrl);
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
    return { ok: false, error: `Could not reach ${url.origin} (${why}).` };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, error: `${url.origin}/props returned ${response.status}.`, upstreamStatus: response.status };
  }
  const body = (await response.json().catch(() => null)) as {
    default_generation_settings?: { n_ctx?: unknown };
  } | null;
  const nCtx = body?.default_generation_settings?.n_ctx;
  if (typeof nCtx !== 'number' || !Number.isInteger(nCtx) || nCtx <= 0) {
    return { ok: false, error: `${url.origin}/props did not report default_generation_settings.n_ctx.` };
  }
  return { ok: true, contextTokens: nCtx, source: input.flavor === 'llama-swap' ? 'llama-swap /props' : 'llama.cpp /props' };
}
```

`server/src/routes/analyzer-endpoints.ts`:

1. Extend imports:
```ts
import { readUserSettings } from '../workspace/user-settings.js';
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
  const result = await detectServedContext({ baseUrl: body.baseUrl, flavor: body.flavor, model: body.model, apiKey });
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
| `new URL('/props', …)` → `new URL('props', input.baseUrl)` (resolves under `/v1/`) | the same test (`url` is `/v1/props`) |
| Delete the `allowModelLoad !== true` refusal | `llama-swap without allowModelLoad is refused and never contacts the server` |
| Delete the `!keyOriginMatches` branch | `sends a stored key only to its own origin…` |

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
  - types `AnalyzerEndpoint`, `AnalyzerEndpointInput`, `AnalyzerEndpointKeyStatus`, `AnalyzerEndpointDetectRequest`, `AnalyzerEndpointDetectResult`;
  - thunks `createAnalyzerEndpoint`, `updateAnalyzerEndpoint`, `deleteAnalyzerEndpoint`, `saveAnalyzerEndpointKey`.

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
const { api, AnalyzerEndpointError } = await import('./api');

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

  it('refuses to delete a referenced endpoint, then deletes it once unreferenced', async () => {
    await api.createAnalyzerEndpoint(input('m-ref'));
    await api.putUserSettings({ analyzerPhase0Model: 'openai:m-ref::qwen3' });
    const r = await refusal(api.deleteAnalyzerEndpoint('m-ref'));
    expect(r.code).toBe('referenced');
    expect(r.details).toContain('Account setting "analyzerPhase0Model"');
    await api.putUserSettings({ analyzerPhase0Model: null });
    const s = await api.deleteAnalyzerEndpoint('m-ref');
    expect(s.analyzerEndpoints?.some((e) => e.id === 'm-ref')).toBe(false);
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
const { accountSlice, createAnalyzerEndpoint, saveAnalyzerEndpointKey, deleteAnalyzerEndpoint } = await import('./account-slice');

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
});
```

- [ ] **Step 2: Run and confirm failures**

Run:
```bash
npx vitest run src/lib/api-analyzer-endpoints-mock.test.ts src/store/account-slice.analyzer-endpoints.test.ts
```
Expected: FAIL, `api.createAnalyzerEndpoint is not a function` / `createAnalyzerEndpoint is not exported`.

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
        analyzer.personaGeneration.engine overrides); `details` lists them.
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
      required: [error, code, details]
      properties:
        error: { type: string }
        code: { type: string, enum: [invalid, duplicate-id, unload-off-origin, not-found, referenced] }
        details: { type: array, items: { type: string } }

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
/* #3084 — analyzer endpoint writes. A refusal keeps its machine code and the
   per-field details so the PR 3d form can show them next to the right input. */
export class AnalyzerEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'AnalyzerEndpointError';
  }
}

async function analyzerEndpointRequest<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; details?: string[] };
    throw new AnalyzerEndpointError(res.status, body.code ?? 'unknown', body.error ?? res.statusText, body.details ?? []);
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

4. After `mockPutUserSettings` (`:7346`):
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
  const problems: string[] = [];
  if (!MOCK_ENDPOINT_ID.test(input.id ?? '')) problems.push('id: must match ^[a-z0-9-]{1,40}$');
  if (!input.name?.trim()) problems.push('name: required');
  const baseOrigin = mockOrigin(input.baseUrl ?? '');
  if (!baseOrigin) problems.push('baseUrl: must be a URL');
  if (typeof input.contextTokens !== 'number' || input.contextTokens < 512) problems.push('contextTokens: required, at least 512');
  if (problems.length > 0) throw new AnalyzerEndpointError(400, 'invalid', 'Invalid analyzer endpoint.', problems);
  if (input.unloadUrl && mockOrigin(input.unloadUrl) !== baseOrigin) {
    throw new AnalyzerEndpointError(400, 'unload-off-origin', 'The unload URL must be on the same scheme, host and port as the base URL.');
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
  const names = (v: unknown) => typeof v === 'string' && v.startsWith(`openai:${id}::`);
  const refs = (['defaultAnalysisModel', 'analyzerPhase0Model', 'analyzerPhase1Model'] as const)
    .filter((f) => names(MOCK_USER_SETTINGS[f]))
    .map((f) => `Account setting "${f}"`);
  if (refs.length > 0) {
    throw new AnalyzerEndpointError(409, 'referenced', `Analyzer endpoint "${id}" is still used by ${refs.length} saved setting(s).`, refs);
  }
  delete mockEndpointKeyOrigins[id];
  return mockSettingsWithEndpoints(mockEndpoints().filter((e) => e.id !== id));
}

async function mockPutAnalyzerEndpointKey(id: string, key: string | null): Promise<UserSettings> {
  await wait(50);
  const ep = mockEndpointOrThrow(id);
  if (key && key.trim().length > 0) mockEndpointKeyOrigins[id] = new URL(ep.baseUrl).origin;
  else delete mockEndpointKeyOrigins[id];
  return mockSettingsWithEndpoints(mockEndpoints());
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

1. Imports. `:9` becomes `import { createSlice, createAsyncThunk, isAnyOf, type PayloadAction } from '@reduxjs/toolkit';`, and `:10` becomes `import type { AnalyzerEndpointInput, UserSettings, UserSettingsPatch } from '../lib/types';`.

2. After `saveGeminiApiKey` (`:68`):
```ts
/* #3084 PR 3b — analyzer endpoint writes. Each response is the full settings
   body, swapped in like saveGeminiApiKey. PR 3d's Settings form dispatches these. */
export const createAnalyzerEndpoint = createAsyncThunk<UserSettings, AnalyzerEndpointInput>(
  'account/createAnalyzerEndpoint',
  (input) => api.createAnalyzerEndpoint(input),
);
export const updateAnalyzerEndpoint = createAsyncThunk<UserSettings, { endpointId: string; input: AnalyzerEndpointInput }>(
  'account/updateAnalyzerEndpoint',
  ({ endpointId, input }) => api.updateAnalyzerEndpoint(endpointId, input),
);
export const deleteAnalyzerEndpoint = createAsyncThunk<UserSettings, string>(
  'account/deleteAnalyzerEndpoint',
  (endpointId) => api.deleteAnalyzerEndpoint(endpointId),
);
export const saveAnalyzerEndpointKey = createAsyncThunk<UserSettings, { endpointId: string; key: string | null }>(
  'account/saveAnalyzerEndpointKey',
  ({ endpointId, key }) => api.putAnalyzerEndpointKey(endpointId, key),
);

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
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to save the analyzer endpoint.';
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
  - `noteEndpointModelUsed(endpointId, model)`
  - `lastUsedModel(endpointId)`
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
  lastUsedModel,
  noteEndpointModelUsed,
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

  it('remembers the last model used per endpoint, and nothing before first use', () => {
    expect(lastUsedModel('a')).toBeUndefined();
    noteEndpointModelUsed('a', 'qwen3:30b');
    noteEndpointModelUsed('a', 'gemma3:12b');
    expect(lastUsedModel('a')).toBe('gemma3:12b');
    expect(lastUsedModel('b')).toBeUndefined();
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
- `endpoint-runtime.test.ts` fails to resolve.
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
   - the last model each endpoint served, for the `{model}` unload-URL
     substitution (decision 4). An unload URL with `{model}` and no model used
     since server start is skipped (resolveUnloadUrl returns null). */
import { CountSemaphore } from '../../gpu/count-semaphore.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';

const semaphores = new Map<string, CountSemaphore>();
const lastModels = new Map<string, string>();

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

export function noteEndpointModelUsed(endpointId: string, model: string): void {
  lastModels.set(endpointId, model);
}

export function lastUsedModel(endpointId: string): string | undefined {
  return lastModels.get(endpointId);
}

/** Test-only. */
export function _resetEndpointRuntimeForTest(): void {
  semaphores.clear();
  lastModels.clear();
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
- Create: `server/src/analyzer/transports/openai-transport.ts`
- Create: `server/src/analyzer/transports/openai-outcome.test.ts` (pure classification table)
- Create: `server/src/analyzer/transports/openai-transport.contract.test.ts` (real `http.createServer` plus a real undici `Agent`)

**Interfaces:**
- Consumes:
  - `ChatTransport`, `TransportRequest`, `TransportResult`, `TransportUsage`, `StructuredOutputRequest` (W1 `runner/transport.ts`)
  - `withTransportRetry`, `RetryClassifier` (W1 `runner/transport-retry.ts`)
  - `AnalysisAbortedError`, `AnalyzerUnreachableError`, `AnalyzerHttpError` (W1)
  - `AnalyzerTimeoutError` (Task 3b.1, or wave 2 Task 2.9B if Branch B shipped it), `AnalyzerStreamIncompleteError` (Task 3b.1)
  - `analyzerRateLimiter`, `endpointSemaphore`, `noteEndpointModelUsed` (Task 3b.10)
  - `endpointModelId` (`model-id.ts`)
  - `resolveStreamIdleTimeoutMs`, `BACKOFFS_MS`, `appendBounded` (exported by `gemini.ts:73`, `:102`, `:66` on main)
    - If wave 1 moved them, import from wherever `rg -n "export (function resolveStreamIdleTimeoutMs|const BACKOFFS_MS|function appendBounded)" server/src/analyzer` finds them.
- Produces (contract):
  - `class OpenAITransport implements ChatTransport`
  - constructor `{ endpoint: AnalyzerEndpoint; apiKey: string | null; model: string; dispatcher?: Agent; now?: () => number }`
- Produces (additional, for tests and PR 3d):
  - `OPENAI_DISPATCHER`
  - `OPENAI_UNREACHABLE_CODES`
  - `OPENAI_RETRY_CLASSIFIER`
  - `classifyOpenAIOutcome(err, ctx)`
  - `buildOpenAIRequestBody(endpoint, model, req)`
  - `openAIResponseFormat(so)`

**Classification order.** This follows research `04-openai-sdk-facts.md` "Consequences". After the stream loop (clean end) and on any thrown error, the checks run in this order:
1. The caller signal aborted → `AnalysisAbortedError`.
2. No response headers yet, and the cause chain (≤ 4 levels) holds a code in `OPENAI_UNREACHABLE_CODES`, or the chain has **no codes at all** and says `fetch failed` → `AnalyzerUnreachableError`.
3. The ceiling signal aborted, or `APIConnectionTimeoutError` → `AnalyzerTimeoutError` (`ceiling` / `connect-timeout`).
4. An `APIError` with a numeric status (not a connection or user-abort error) → `AnalyzerHttpError(status)`.
5. An `APIError` without a status (an error event in the stream) → `AnalyzerHttpError(0)`. This is not retried.
6. Headers received, and one of:
   - the idle watchdog fired;
   - a socket drop (`terminated` / `UND_ERR_SOCKET` / `ECONNRESET`);
   - a clean end with no `finish_reason`.

   → `AnalyzerStreamIncompleteError`, retried like an idle stream.
7. Anything else → rethrown unchanged.

**Two deliberate refinements of the research order:**
- **Bare `fetch failed` only counts when the chain has no string code.** A headers-timeout chain carries `UND_ERR_HEADERS_TIMEOUT` under a `fetch failed` TypeError. Without this rule a slow-but-healthy server would read as unreachable, which is the exact misclassification `ollama-timeout.test.ts` guards.
- **`OPENAI_UNREACHABLE_CODES` adds `EHOSTUNREACH` and `ENETUNREACH`** to Ollama's set plus `UND_ERR_CONNECT_TIMEOUT`. An unroutable address returns one of the three depending on the host's routing table.

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
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { classifyOpenAIOutcome, type OutcomeContext } from './openai-transport.js';
import {
  AnalysisAbortedError,
  AnalyzerHttpError,
  AnalyzerStreamIncompleteError,
  AnalyzerTimeoutError,
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

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH'])(
    '2. %s before headers is unreachable',
    (code) => {
      const out = classifyOpenAIOutcome(chain(code), ctx());
      expect(out).toBeInstanceOf(AnalyzerUnreachableError);
      expect((out as AnalyzerUnreachableError).transport).toBe('openai');
    },
  );

  it('2. a bare "fetch failed" with no code anywhere is unreachable', () => {
    expect(classifyOpenAIOutcome(new APIConnectionError({ cause: new TypeError('fetch failed') }), ctx())).toBeInstanceOf(
      AnalyzerUnreachableError,
    );
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

  it('4. an HTTP status becomes AnalyzerHttpError with that status and the body excerpt', () => {
    const err = new APIError(400, { message: 'bad schema', type: 'invalid_request_error' }, 'bad schema', new Headers());
    const out = classifyOpenAIOutcome(err, ctx());
    expect(out).toBeInstanceOf(AnalyzerHttpError);
    expect((out as AnalyzerHttpError).httpStatus).toBe(400);
    expect((out as AnalyzerHttpError).bodyExcerpt).toContain('bad schema');
    expect((out as Error & { cause?: unknown }).cause).toBe(err);
  });

  it('5. an in-stream error event (no status) becomes AnalyzerHttpError(0)', () => {
    const err = new APIError(undefined, { message: 'context exceeded' }, 'context exceeded', undefined);
    const out = classifyOpenAIOutcome(err, ctx({ headersReceived: true }));
    expect(out).toBeInstanceOf(AnalyzerHttpError);
    expect((out as AnalyzerHttpError).httpStatus).toBe(0);
  });

  it('6. a clean end without finish_reason, or an idle abort, after headers is incomplete', () => {
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true }))).toBeInstanceOf(AnalyzerStreamIncompleteError);
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true, idleAborted: true, sawFinish: true }))).toBeInstanceOf(
      AnalyzerStreamIncompleteError,
    );
  });

  it('a clean end with a finish reason is success (null)', () => {
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true, sawFinish: true }))).toBeNull();
  });

  it('7. anything else is rethrown unchanged', () => {
    const odd = new RangeError('weird');
    expect(classifyOpenAIOutcome(odd, ctx({ headersReceived: true, sawFinish: true }))).toBe(odd);
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Agent } from 'undici';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';
import type { TransportRequest } from '../runner/transport.js';

process.env.GEMINI_RETRY_BACKOFFS_MS = '10,10';

const { OpenAITransport } = await import('./openai-transport.js');
const { endpointSemaphore, lastUsedModel, _resetEndpointRuntimeForTest } = await import('./endpoint-runtime.js');
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
    const r = await transport(url).send(request({ call: { onChunk: (i) => received.push(i.receivedBytes) } }));
    expect(r).toMatchObject({ text: '{"a":1}', finish: 'stop', reasoningSeen: false, usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 0 } });
    expect(received).toEqual([5, 7]);
    expect(seen[0].url).toBe('/v1/chat/completions');
    expect(seen[0].body).toMatchObject({
      model: 'qwen3:30b',
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }],
      max_tokens: 32_758,
    });
    expect(lastUsedModel('lab')).toBe('qwen3:30b');
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
  it('a refused port → AnalyzerUnreachableError', async () => {
    const url = await start(() => {});
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(await failure(transport(url).send(request()))).toBeInstanceOf(errors.AnalyzerUnreachableError);
  });

  it('an unresolvable host → AnalyzerUnreachableError', async () => {
    expect(await failure(transport('http://castwright-no-such-host.invalid/v1').send(request()))).toBeInstanceOf(
      errors.AnalyzerUnreachableError,
    );
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

  it('sends no Authorization header without a key and never reads OPENAI_* env', async () => {
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
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npm --prefix server run test -- src/analyzer/transports/openai-outcome.test.ts src/analyzer/transports/openai-transport.contract.test.ts`

Expected: both FAIL with `Failed to resolve import "./openai-transport.js"`.

- [ ] **Step 4: Implement**

`server/src/analyzer/transports/openai-transport.ts`:
```ts
/* OpenAI Chat Completions transport for named endpoints (#3084 decisions
   1b, 1c; research 04-openai-sdk-facts).

   Client: the official `openai` SDK with `fetch: undici.fetch` (Node's global
   fetch rejects an npm-undici Agent) and a long-call dispatcher (no header or
   body timeout, 10 s connect), SDK retries off, SDK logging off, and no
   OPENAI_* environment reads (endpoints are configured in Settings only).

   Signals: the absolute ceiling is AbortSignal.timeout(requestCeilingMs),
   created AFTER the endpoint semaphore is acquired, so queue time is never
   charged to the request. The idle watchdog arms on the first delta (answer
   OR reasoning). The SDK ends a stream SILENTLY on abort (openai
   core/streaming.ts:171-186), so a clean loop end is never trusted:
   classifyOpenAIOutcome decides from our own signals. */

import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { Agent, fetch as undiciFetch } from 'undici';
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
  AnalyzerStreamIncompleteError,
  AnalyzerTimeoutError,
  AnalyzerUnreachableError,
} from '../errors.js';
import { analyzerRateLimiter } from '../rate-limit.js';
import { appendBounded, BACKOFFS_MS, resolveStreamIdleTimeoutMs } from '../gemini.js';
import { endpointModelId } from '../model-id.js';
import { endpointSemaphore, noteEndpointModelUsed } from './endpoint-runtime.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';

type OpenAIClientOptions = NonNullable<ConstructorParameters<typeof OpenAI>[0]>;

/** ollama.ts UNREACHABLE_CODES + connect timeout + the two no-route codes an
    unroutable address returns depending on the host's routing table. */
export const OPENAI_UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/* A llama.cpp request queued behind a busy slot gets no headers until a slot
   frees, and a long prefill streams nothing — both are bounded by the
   endpoint ceiling, never by the dispatcher. */
export const OPENAI_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });

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
}

/** Decision 1c classification. `err` is undefined after a loop that ended
    without throwing. Returns null for a genuine success. */
export function classifyOpenAIOutcome(err: unknown, ctx: OutcomeContext): Error | null {
  if (ctx.callerAborted) {
    return new AnalysisAbortedError(`Endpoint ${ctx.model} call aborted (paused or client disconnected).`);
  }
  if (err !== undefined && !ctx.headersReceived) {
    const chain = causeChain(err);
    const codes = chain.map((c) => c.code).filter((c): c is string => typeof c === 'string');
    const unreachableCode = codes.find((c) => OPENAI_UNREACHABLE_CODES.has(c));
    const bareFetchFailed =
      codes.length === 0 && chain.some((c) => typeof c.message === 'string' && /fetch failed/i.test(c.message));
    if (unreachableCode || bareFetchFailed) {
      return new AnalyzerUnreachableError(
        `Endpoint ${ctx.model} is unreachable (${unreachableCode ?? 'fetch failed'}).`,
        'openai',
        err,
      );
    }
  }
  if (ctx.ceilingAborted) return new AnalyzerTimeoutError('openai', ctx.model, ctx.elapsedMs, 'ceiling');
  if (err instanceof APIConnectionTimeoutError) {
    return new AnalyzerTimeoutError('openai', ctx.model, ctx.elapsedMs, 'connect-timeout');
  }
  if (err instanceof APIError && !(err instanceof APIConnectionError) && !(err instanceof APIUserAbortError)) {
    const status = typeof err.status === 'number' ? err.status : 0;
    const excerpt = JSON.stringify(err.error ?? err.message).slice(0, 500);
    const httpError = new AnalyzerHttpError(
      'openai',
      status,
      excerpt,
      `Endpoint ${ctx.model} returned ${status === 0 ? 'an error event mid-stream' : status}: ${excerpt}`,
    );
    httpError.cause = err;
    return httpError;
  }
  if (ctx.headersReceived) {
    const socketDrop =
      err !== undefined &&
      causeChain(err).some(
        (c) => c.code === 'UND_ERR_SOCKET' || c.code === 'ECONNRESET' || (typeof c.message === 'string' && /terminated/i.test(c.message)),
      );
    if (ctx.idleAborted || socketDrop || (err === undefined && !ctx.sawFinish)) {
      return new AnalyzerStreamIncompleteError('openai', ctx.model);
    }
  }
  if (err === undefined) return null;
  return err instanceof Error ? err : new Error(String(err));
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
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof APIError ? retryAfterMs(cause.headers as Headers | undefined) : null;
  },
};

export function openAIResponseFormat(so: StructuredOutputRequest): { response_format?: Record<string, unknown> } {
  if (so.mode === 'schema') {
    return { response_format: { type: 'json_schema', json_schema: { name: so.name, schema: so.schema, strict: false } } };
  }
  if (so.mode === 'json') return { response_format: { type: 'json_object' } };
  return {};
}

/** Auto output (maxOutputTokens undefined) = context − estimated input until
    PR 3c's catalog limit joins the min(). Reasoning / extraParams: wave 5. */
export function buildOpenAIRequestBody(
  endpoint: AnalyzerEndpoint,
  model: string,
  req: TransportRequest,
): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
    stream: true,
    stream_options: { include_usage: true },
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens ?? Math.max(1, endpoint.contextTokens - req.estimatedInputTokens),
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

  constructor(opts: { endpoint: AnalyzerEndpoint; apiKey: string | null; model: string; dispatcher?: Agent; now?: () => number }) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.now = opts.now ?? Date.now;
    this.client = new OpenAI({
      baseURL: opts.endpoint.baseUrl,
      /* The SDK requires a string and would otherwise read OPENAI_API_KEY; with
         no saved key the Authorization header is removed below. */
      apiKey: opts.apiKey ?? 'castwright-no-key',
      organization: null,
      project: null,
      maxRetries: 0,
      timeout: opts.endpoint.requestCeilingMs,
      logLevel: 'off',
      ...(opts.apiKey === null ? { defaultHeaders: { Authorization: null } } : {}),
      fetch: undiciFetch as unknown as OpenAIClientOptions['fetch'],
      fetchOptions: { dispatcher: opts.dispatcher ?? OPENAI_DISPATCHER } as unknown as OpenAIClientOptions['fetchOptions'],
    });
  }

  async send(req: TransportRequest): Promise<TransportResult> {
    noteEndpointModelUsed(this.endpoint.id, this.model);
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

    const failure = classifyOpenAIOutcome(streamError, {
      callerAborted: caller?.aborted === true,
      ceilingAborted: ceiling.aborted,
      idleAborted: idle.signal.aborted,
      headersReceived,
      sawFinish: finishReason !== null,
      elapsedMs: this.now() - startedAt,
      model: this.model,
    });
    if (failure) throw failure;
    return { text, reasoningSeen, ...mapFinishReason(finishReason as string), usage, receivedBytes: text.length };
  }
}
```

**Reasoning deltas and `onChunk`.** A delta carrying `reasoning_content`, `reasoning` or a non-empty `reasoning_details` re-arms the idle watchdog and calls `onChunk` with `receivedBytes` / `receivedText` unchanged, so the route heartbeat (`routes/analysis.ts:1184`, silence warning `:4329-4335`) sees a long think as activity. This is the convention wave 2 Task 2.8 uses for Gemini thought-only chunks. A chunk that carries both reasoning and content fires `onChunk` once.

**If `tsc` reports that the `openai/resources/chat/completions` subpath doesn't export `ChatCompletionCreateParamsStreaming`:** use `OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming` instead. The package's `exports` map has `"./resources/*"`, and `completions.d.mts:57` declares the overload. Record which form compiled.

- [ ] **Step 5: Run and confirm pass**

```bash
npm --prefix server run test -- src/analyzer/transports/openai-outcome.test.ts src/analyzer/transports/openai-transport.contract.test.ts src/analyzer/ollama-timeout.test.ts
npm run typecheck
npm run check:cycles
```

Expected:
- PASS.
- The unroutable-address case finishes in about 2 s.

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
| Delete `&& !ctx.headersReceived` from rule 2 | `2. an unreachable-looking code AFTER headers is not unreachable` |
| Move the `ctx.callerAborted` check below the ceiling check | `1. a caller abort wins over everything…` |
| `if (reasoningDelta \|\| content) { armIdle(); …` → `if (content) { armIdle(); …` | the three `…keeps the watchdog alive…` cases |
| Move `req.call.onChunk?.(…)` back inside `if (content) { … }` | the three `…feeds the heartbeat with the answer bytes unchanged…` cases (only one beat recorded) |
| `OPENAI_DISPATCHER` → `new Agent({ headersTimeout: 500, bodyTimeout: 0, connect: { timeout: 10_000 } })` | `a long silent prefill (headers after 1.5 s) completes before the ceiling` |
| Delete the `...(opts.apiKey === null ? { defaultHeaders: { Authorization: null } } : {})` spread | `sends no Authorization header without a key…` |
| `release();` moved out of `finally` into the success path only | `a post-connect stall … semaphore released` |

- [ ] **Step 7: Commit**
```bash
git add server/package.json server/package-lock.json server/src/analyzer/transports/openai-transport.ts server/src/analyzer/transports/openai-outcome.test.ts server/src/analyzer/transports/openai-transport.contract.test.ts
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
  - `OpenAITransport` (Task 3b.11)
  - `adaptSchemaForOpenAI` (Task 3b.3)
  - `AnalyzerEndpoint` (Task 3b.5)
  - `AnalysisAbortedError`, `AnalyzerUnreachableError` (W1)
- Produces (contract):
  - `OPENAI_RETRY_POLICY`
  - `class OpenAIAnalyzer extends TransportAnalyzer`, constructor `{ endpoint: AnalyzerEndpoint; apiKey: string | null; model: string; dispatcher?: Agent }`
- Produces (additional): `OPENAI_DEFAULT_TEMPERATURE = 0.2`, `OPENAI_RETRY_TEMPERATURE = 0.6`

**Temperatures.** The contract says "retry temperature from its endpoint", but `analyzerEndpointSchema` has no temperature field. Endpoints therefore use constants equal to the Ollama knob defaults: `registry.ts:27` (0.2) and `:37` (0.6). Wave 5's custom payload can set the first-attempt temperature.

**How attempt 1 gets its temperature.** Wave 1's `ValidationRetryPolicy` (Task 1.10) has `initialTemperature(): number`: the temperature of the first attempt and of escalation's single attempt. The runner calls it for both. It also has `readonly warnsOnRepair: boolean`. `OPENAI_RETRY_POLICY` implements both. `initialTemperature` returns `OPENAI_DEFAULT_TEMPERATURE`. `warnsOnRepair` is `true`, following Ollama's retry shape, whose policy logs "required JSON cleanup".

**Retry shape.** It is Ollama's (`ollama.ts:559-571`):
- invalid JSON → drop the assistant turn, use the retry temperature;
- a schema failure → replay the output plus `buildRetryMessage`, at the default temperature.

Also: `writesRawAttempts: true`, and escalation rethrows abort and unreachable (the contract).

**Tests kept green:** `server/src/analyzer/runner/*`, `server/src/analyzer/ollama.test.ts`.

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/openai-analyzer.test.ts`:
```ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';

process.env.GEMINI_RETRY_BACKOFFS_MS = '10,10';

const { OpenAIAnalyzer } = await import('./openai.js');
const { OPENAI_RETRY_POLICY, OPENAI_DEFAULT_TEMPERATURE, OPENAI_RETRY_TEMPERATURE } = await import('./runner/retry-policy.js');
const { _resetEndpointRuntimeForTest } = await import('./transports/endpoint-runtime.js');
const { geminiRateLimiter } = await import('./rate-limit.js');
const errors = await import('./errors.js');
const { classifyAnalysisFailure } = await import('../routes/failure-taxonomy.js');

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
import { OpenAITransport } from './transports/openai-transport.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';

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
        settings: () => ({
          structuredOutput: opts.endpoint.structuredOutput,
          maxOutputTokens: opts.endpoint.maxOutputTokens > 0 ? opts.endpoint.maxOutputTokens : undefined,
          /* No reasoning / extraParams: EngineRequestSettings has neither field until
             wave 5 (Task 5.1). Task 5.3 adds `reasoning:` and Task 5.10 adds `extraParams:` here. */
        }),
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
- Modify: `docs/testing/onbox-acceptance-register.md` — two rows: one in Group B (its `next-id` marker is at `:4509` on 2b63b451), one in Group E (marker at `:4926`). Bump both markers.
- Create: `docs/testing/structured-output-knobs-onbox-acceptance.md` — the run sheet.
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
```
Expected: every command green, and no diff from either regenerator.

- [ ] **Step 2: Release notes (both files)**

The shippable delta is the two structured-output settings, which are user-visible in Advanced Settings. The four failure codes also add Help entries.

Append to `docs/release-notes-next.md`, under the analysis section of the in-progress body:
```markdown
- **Structured-output mode per analyzer engine.** New Advanced Settings knobs `analyzer.ollama.structuredOutput` (`schema` default — today's `format` request) and `analyzer.gemini.structuredOutput` (`json` default — today's `responseMimeType`-only request) choose `schema` / `json` / `off`. Gemini's `schema` mode sends a schema reduced to the keywords `responseJsonSchema` documents; dropped constraints are logged, and every reply is still validated against the full schema. New failure codes `analyzer-request-rejected` (any HTTP 400, with the redacted provider message and the request-shaping settings named — never retried with a setting removed), `analyzer-invalid-output`, `analyzer-timeout`, `analyzer-endpoint-missing`; 401/403 map to `auth`. Groundwork for OpenAI-compatible endpoints (storage, origin-bound keys, Detect, transport) ships unselectable. (#PR, Refs #3084)
```

Add under `# Castwright 1.15.0` in `RELEASE_NOTES.md`:
```markdown
- **You can now choose how strictly the analyzer is told to answer in Castwright's format.** In Advanced Settings, the local analyzer and Gemini each have a "structured output" setting: "schema" spells out the exact shape of the answer, "json" only asks for valid JSON, and "off" asks for neither. Nothing changes unless you change it — the local analyzer keeps spelling out the shape, and Gemini keeps asking only for JSON, exactly as before. And when an analyzer turns a request down as invalid, Castwright now tells you which of your settings shaped that request, instead of a bare error.
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

Record the validation-retry count for each mode against the default `schema` run on the same chapter. Criteria: `docs/testing/structured-output-knobs-onbox-acceptance.md`.
```

`## Group E — not the GPU box` — new row `E<next>`:
```markdown
### E<next> · Gemini `schema` mode on a real key (#3084 PR 3b)

With a Gemini key and `analyzer.gemini.structuredOutput` = `schema`, analyse one real chapter on `gemma-4-31b-it` and one on `gemini-3.5-flash-lite`. Observe:
- whether Gemini returns HTTP 400 for the adapted `responseJsonSchema`, or accepts it;
- the debug log's "schema adapter dropped" list, which must match the PR's `gemini / *` snapshot;
- whether replies conform on the first attempt.

This row does not by itself move Gemini's default: the spec gates that on attribution quality, which PR 3c's Test-action row records. Criteria: `docs/testing/structured-output-knobs-onbox-acceptance.md`.
```
Also add a glance-table row for each group, matching the file's existing format for its group.

`docs/testing/structured-output-knobs-onbox-acceptance.md`:
```markdown
# Structured-output knobs — on-box acceptance (#3084 PR 3b)

Register rows: B<next> (Ollama), E<next> (Gemini) — the minted ids. Book: *The Coalfall Commission* chapter one
(`server/src/__fixtures__/the-coalfall-commission.md`).

## B<next> — Ollama

Prerequisites: a real Ollama daemon with `qwen3.5:4b` pulled; no TTS engine resident.

1. Default (`schema`): analyse chapter one. Note the validation retries (count `*.attempt1.raw.txt` files).
   Result:
2. Set `analyzer.ollama.structuredOutput` = `json`. Re-analyse chapter one. Confirm the inbox request had `format: "json"`. Note retries and outcome.
   Result:
3. Set it to `off`. Re-analyse. Confirm the request had no `format` key. Note retries and outcome.
   Result:
4. Restore `schema`.

## E<next> — Gemini

Prerequisites: a Gemini API key; no local analyzer needed.

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
  - "Contract changes": `ValidationRetryPolicy.finalFailureMessage` was removed (the class owns the text);
  - "Also fixed, found in passing": none, or list any findings.
- `## Test plan`: every new test file, every mutation-proof red output (Tasks 3b.1–3b.12), and the contract-suite run time.
- `Refs #3084`.

- [ ] **Step 5: `pr-review-gate`** at depth **high**: a multi-scope `feat` across `server,openapi,frontend,docs`. Triage and fold every finding before merge.

---

**End of PRs 3a and 3b.** PR 3c consumes these names:
- `analyzerEndpoints` / `analyzerEndpointKeys`, `resolveEndpointApiKey`, `findEndpointReferences` (+ its classification guard — 3c's new `analyzerCapabilitiesByModel` / `analyzerRateLimitsByModel` fields must be added to that test's exclusion list);
- the `ModelCapabilityRecord` types in `capabilities.ts`;
- the endpoint early return in `resolveLimits`;
- `OpenAIAnalyzer`, `OpenAITransport`, `structuredOutputLabel`, `AnalyzerEndpointMissingError`.

PR 3d consumes:
- `engineForModelId`, `analyzerEngineName`;
- the account-slice thunks and `detectAnalyzerEndpointContext`;
- `lastUsedModel`, `resolveUnloadUrl`, `defaultGpuForBaseUrl`.

