# OpenAI-compatible analyzer — Wave 4 plan

> Part of the [OpenAI-compatible analyzer implementation plan](2026-09-11-openai-compatible-analyzer.md). Read that file first: its Global Constraints, planning decisions (P1–P29) and interface contract bind every task below. Spec: [2026-09-10-openai-compatible-analyzer-design.md](../specs/2026-09-10-openai-compatible-analyzer-design.md).

## Wave 4 — Persona generation through the transports (spec D10, §10)

### PR 4 — persona generation runs through the stage runner's free-text path

**Branch:** `feat/server-3084-w4-persona` — created with `node scripts/wt-new.mjs feat/server-3084-w4-persona` off the latest `main`. Corrected 2026-09-13: `scripts/lib/branch-name.mjs`'s `SCOPE_GROUP` takes a single scope; `wt-new.mjs` refuses a comma-joined `feat/server,frontend-…` branch name outright. CONTRIBUTING.md's comma form (`feat(server,frontend): …`) is for commit-subject and PR-title scopes only, not branch names. This PR still changes both server and frontend code, and its commits/PR title keep the multi-scope `server,frontend` form — only the branch name is single-scope.

**Re-pinned 2026-10-23 against `main` `b015aae9`** (written against `80be2f1d`; re-audited at `6c3a0a49`, then re-checked at `b015aae9`). The plan's prerequisites have merged: PR 3d (#3710, `b015aae9`) and waves 1–3, plus #3714 (the per-book book-op lock, which put `cast-design.ts`'s start path inside `runBookJob`) and #3725 (the Gemini SDK timeouts). Line numbers, some snippets and a few decisions below were stale. Each task now opens with a **Re-pin notes** block; where a note and a step differ, the note wins. The branch `feat/server-3084-w4-persona` is already cut off `b015aae9` in worktree `C:\Claude\Projects\wt-3084-w4-persona`, so do not run `wt-new.mjs` again.

> **Re-pin notes (2026-10-23, against b015aae9) — read first; these override the steps below where they differ.**
> - **Entry criterion 2's grep misses an async export.** `warmEndpointServedLimits` is `export async function` at `server/src/analyzer/catalog/endpoint-served-limits.ts:90`, which the arm `export function (…)` does not match. Use `export (async )?function (…)` there. Every other name is found. Criteria 1, 3 and 5 pass (`'analyzer-engine'` at `server/src/config/types.ts:2` and `src/lib/types.ts:932`; `generatePersonaViaOllama` defined at `ollama.ts:78`; `transport-analyzer.ts:28` reads `constructor(readonly runner: StageRunner) {}`). Criterion 4 is moot.
> - **`cast-design.ts` line map at `b015aae9`** (the file is 978 lines; every `cast-design.ts:NNN` citation in the text below is stale, use this): backstop `.catch` `:917–945` (lock-contention branch `:932–937`, `code: 'unknown'` `:939–943`), nested inside the `runBookJob(bookId, 'design', async (located) => {…})` callback `:792–946`, with registration errors in a separate `catch` `:947–950`; lazy persona `try` `:527`, call `:528`, `writeVoiceStylePersona` `:529`, catch body `:530–545` (first statement `:535`); top-of-iteration abort check `:391`; final idle `endJob` `:742–749`; `runPersonaPrePass` `:293–344` (in-loop abort return `:311`, call `:323`, rethrow `:325`).
> - **`itemFailureReason`** is `workspace/file-lock.ts:194–196` (the text says `:183-185`).
> - **Busy accounting.** `markEndpointRunActive` is also held by `annotate-emotion.ts` (`:198`, `:262`), `instruct-annotation.ts` (`:197`, `:261`) and `analyzer-models.ts:59` (the Test request), besides analysis and script review. No cast-design or voice-style route calls it, so the "a design job marks no endpoint run" decision stands.
> - **`gpu: 'any'`.** `endpointsSharingDevice` (`server/src/gpu/endpoint-eviction.ts:48–50`) keeps `e.gpu === 'any' || e.gpu === deviceKey`, so `personaSharesGpu()` treats an `any` endpoint as on Qwen's card.
> - **#3725 is merged (`a33869dd`) and is in `b015aae9`.** `voice-style.ts:38` imports `PERSONA_ABSOLUTE_MAX_MS` from `./ollama.js` and `:233` passes `httpOptions: { timeout: PERSONA_ABSOLUTE_MAX_MS }`; `voice-style.timeout.test.ts` exists. **Owner decision (4.3-B1 option b, 2026-10-23):** the persona ceiling lives in the transports. `PERSONA_ABSOLUTE_MAX_MS` moves to `runner/transport.ts` (Task 4.1), every transport bounds a free-text request at `min(its request ceiling, absoluteMaxMs ?? PERSONA_ABSOLUTE_MAX_MS)`, and `voice-style.ts` passes `absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS` (imported from `./ollama.js`) for every engine. The ceiling is terminal (`GEMINI_RETRY_CLASSIFIER` returns `'no-retry'` for an `AnalyzerTimeoutError`, `gemini-transport.ts:129`). Tasks 4.1, 4.2, 4.3 and 4.5 carry the details.
> - **`gemini-transport.ts` shifted by one line after `:82`** (#3725 added a comment line in the `:76–83` block). Every gemini-transport anchor in this plan was re-derived from the file; do not copy a number from the audit.
> - **The header claim that a Gemini persona now gets the shared transport retry helper holds** (`GeminiTransport.send`, `gemini-transport.ts:196–211`: `withTransportRetry`, 3 attempts, `maxTotalMs: 90_000`).
> - **#3230 is CLOSED** (2026-09-12). The text above says "still OPEN"; it is not.
> - **Global constraint added by the re-pin (#3721).** Any log line this wave adds (`console.*`) must not carry a printf placeholder (`%s %d %i %f %j %o %O %c %%`) in the static text of its first argument: use template literals. `server/src/console-format-placeholder.guard.test.ts` scans every non-test server source and fails the build, because `logger.ts`'s `installTimestamps()` passes the timestamp as the format string and a `%s` would print literally.

**Delivers:**
- `analyzer.personaGeneration.engine` (`PERSONA_GEN_ENGINE`) accepts `local`, `gemini`, or `openai:<endpointId>::<model>`.
  - It is a new knob type, `analyzer-engine`: a string knob with a `pattern`, rendered as a select.
  - The select offers `local`, `gemini`, every endpoint model from `GET /api/analyzer/models`, and the saved value.
  - `PERSONA_GEN_ENGINE=local|gemini` stays valid.
- `StageRunner.runFreeText` sends one unstructured, single-attempt call through whichever transport the selection names.
- `generateVoiceStylePersona` uses `runFreeText` for all three engines.
- **Ollama:** its free-text request is served by a non-streaming branch of `OllamaTransport`. That branch is `generatePersonaViaOllama`'s body as PR 3b left it, moved: `keep_alive`, `onCpu`, the 600 s bound after slot acquisition, the slot release in `finally`, and W3b Task 3b.6a's known-secret redaction of a non-OK body (P22) are all unchanged. Two things change: a caller abort before the first byte reports `AnalysisAbortedError` (the job signal now reaches it), and the non-OK error is an `AnalyzerHttpError` carrying the status and the redacted excerpt instead of a plain `Error`.
- **Gemini:** its free-text request keeps the persona wire shape: no system instruction, temperature, output cap, JSON mime type or `thinkingConfig` (wave 2's `includeThoughts` stays on stage requests only; P19). The same flag gates W2's reasoning-token count, so a persona response's `thoughtsTokenCount` is not reasoning evidence (P27, A3). It uses the limiter estimate `ceil(prompt.length/4)+200`, and now gets the shared transport retry helper. Its outcomes change: a blocked reply fails as `GeminiContentBlockedError` (`analyzer-content-blocked`) where `main` read the empty text as the empty-persona error, and a reply that is only an unterminated `<think>` block is the empty-persona error (or, on a length stop, `analyzer-reasoning-overflow`) where `main` saved it.
- **Endpoint personas** get, from `OpenAITransport`:
  - the limiter and per-endpoint concurrency;
  - W3d's per-call busy registration (`registerEndpointCallInFlight`, when `gpu !== 'none'`);
  - the served-limits warm-up (`prepare()`, which `runFreeText` awaits);
  - the request ceiling.

  A persona request that leaves the endpoint semaphore is recorded in `servedModels` (any outcome: `OpenAITransport` writes the record just before `create()`), so a same-card persona model is an unload target like any analysis model. They also get two checks, both applied before any call:
  - the key-origin rule, through W3b's `resolveEndpointApiKey` (no second copy);
  - a missing endpoint → `AnalyzerEndpointMissingError(endpointId, 'persona')`.
- **Shared GPU:** `personaSharesGpu()` (local, or an endpoint that W3d's `endpointsSharingDevice` places on Qwen's card) replaces the `engine === 'local'` tests in:
  - `persona-gpu-plan.ts`;
  - `cast-design.ts`'s pre-pass and lazy-persona skip.
- **Design pre-pass:** it rethrows the whole-job error classes instead of recording them per character: `AnalyzerUnreachableError`, `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError`, `AnalyzerTimeoutError`, and `AnalyzerHttpError` with status 401 or 403.
- **Failure codes:** the design job's backstop ends the job with the analysis failure taxonomy's code for any error that reaches it (`auth` for a 401/403 or key-origin error, `analyzer-timeout`, `analyzer-endpoint-missing`, …) instead of `unknown` (`cast-design.ts:908-936`). **What reaches it on `80be2f1d` is the pre-pass's five wholesale rethrows — not a lazy-path persona failure.** `6222e483` (second half of #3027, follow-ups `b8b12be5`, `f3d3a341`) gave the lazy `generateVoiceStylePersona` + `writeVoiceStylePersona` pair its own try/catch (`cast-design.ts:525-543`): it records a per-character failure, broadcasts `character_failed`, and continues to the next character. So this PR's backstop change is scoped to those whole-job classes, which today end as `unknown`. A lazy persona failure — a reasoning overflow included — stays a per-character failure carrying `itemFailureReason`'s reason **string** (`workspace/file-lock.ts:183-185`); it records no `FailureCode` today, and this PR adds none, because putting a code on `character_failed` is a new wire field and a separate decision. #3230 (CLOSED 2026-09-12) asked whether the lazy path should continue per character; `6222e483` makes it do so, so it looks resolved by that commit and nothing here is blocked on it.
- **Cancellation:** the design job's abort signal reaches every persona call (pre-pass and lazy) through `generateVoiceStylePersona(…, { signal })` and `runFreeText` to the transport, so pausing a design job aborts an in-flight persona request. A pause is a clean stop, never a per-character failure or an error event.
  - **On the lazy path that takes an explicit abort check,** as the first statement of the per-character catch `6222e483` added (`cast-design.ts:528-543`), mirroring the pre-pass's (`:2304` in this plan's Step 3 text). Without it that catch swallows the `AnalysisAbortedError` into a `character_failed` and the loop's top-of-iteration abort check (`:388-389`) then breaks to `endJob({type:'idle'})` (`:740`) — so the job ends with no error event but WITH a spurious failure recorded against the character the user paused on. That is why this wave's pause test asserts the absence of `character_failed`, not just the absence of `error`: without that assertion it passes either way.
  - **The backstop's `AnalysisAbortedError` branch is therefore defence in depth, not the live path.** With the lazy check in place and the pre-pass returning on abort, nothing routinely reaches it.
- **Busy accounting — a design job marks no endpoint run (decision).** Analysis jobs and script review hold `markEndpointRunActive` for their whole life (W3d Task 3d.1). A design job does not. After the pre-pass, VoiceDesign loads on the Qwen card and must be able to evict a same-card persona endpoint, and a run mark would block that for the whole job. The transport still registers each persona call as busy, so no unload lands mid-call. Ollama's slot gate is unchanged.

**Must NOT change:**
- **Prompt and cleanup:** `buildVoiceStylePrompt`, `cleanPersona`, and the empty-persona error text.
- **Unchanged constants and knobs:**
  - `PERSONA_KEEP_ALIVE_SECONDS` (300);
  - `PERSONA_ABSOLUTE_MAX_MS` (600 000);
  - `analyzer.gemini.voiceStyleModel`;
  - `analyzer.personaGeneration.localModel`.
- **Stage calls:** the wire shape of every transport's stage (non-free-text) request.
- **No fallback:** no cross-provider fallback for personas. `FallbackAnalyzer` is never used.
- **Routes:** `/voice-style` route response shapes and the cast-design SSE event shapes, except that `CastDesignEvent.code` also admits a `FailureCode` (Task 4.6).
- **Local ordering:** personas are generated before VoiceDesign loads (plan 108).
- **Scope:** reasoning and custom payload stay W5's. This PR adds no reasoning or payload field to any request: wave 1's `TransportRequest` / `EngineRequestSettings` have neither, and wave 5 (Task 5.1) adds both fields and their forwarding from `runStage`, `runSingleAttempt` and `runFreeText`.

**Entry criteria:**
1. PR 3d is merged. **This is now also a hard type dependency (F4, owner 2026-09-13), not only an ordering one:** Task 3d.4b introduces the `'analyzer-engine'` `KnobType` (P10) for `analyzer.fallback.target`, and Task 3d.4c builds the generic picker UI for it; this wave's persona-engine knob (Task 4.4) and its Advanced Settings row (Task 4.7) both reuse that type and its UI wiring rather than creating either. Confirm before cutting this wave's branch: `git grep -n "'analyzer-engine'" server/src/config/types.ts src/lib/types.ts` finds it in both files, and `src/lib/analyzer-engine-options.ts` exists.
2. Run from the worktree root:
   `git grep -n -E "export class (OllamaAnalyzer|GeminiAnalyzer|OpenAIAnalyzer|OllamaTransport|GeminiTransport|OpenAITransport|StageRunner|TransportAnalyzer)|export function (resolveEndpointApiKey|endpointsSharingDevice|parseEndpointModelId|isEndpointBusy|registerEndpointCallInFlight|markEndpointRunActive|servedModels|warmEndpointServedLimits|stripThink|hasReasoningEvidence)|class (AnalyzerEndpointMissingError|AnalyzerKeyOriginError|AnalyzerUnreachableError|AnalyzerReasoningOverflowError|AnalyzerTimeoutError|AnalyzerHttpError)|getAnalyzerModels|analyzerRateLimiter =" -- server/src src/lib`
   Every name must be found. `OpenAIAnalyzer` lives in `server/src/analyzer/openai.ts` (W3b Task 3b.12); this wave imports it as `./openai.js` and `../openai.js`.
3. `git grep -n "generatePersonaViaOllama" -- server/src` still shows it defined in `server/src/analyzer/ollama.ts`.
4. If W1–W3 moved it, apply Task 4.2's move from that location instead.
5. `git grep -n "runner: StageRunner" -- server/src/analyzer/runner/transport-analyzer.ts` shows `constructor(readonly runner: StageRunner)` with no `private` or `protected`. The coordinator is making W1 declare the runner public, so this wave does not patch W1's file. If a modifier is still there, stop and report it to the coordinator.

**Exit criteria:**
- **Tests:** every test named below is green, and each mutation proof is pasted in the PR body.
- **Checks:** `npm run typecheck`, `npm run config:check` and `npm run verify:fast:branch` are green.
- **Review:** the `pr-review-gate` pass at depth `high` (multi-scope `feat`) is folded in.

Test commands used below (from the worktree root, no `cd`):
- **Server file:** `npm --prefix server run test -- <path relative to server/>`. None of this wave's server test files are in `server/vitest.config.slow.ts` `SLOW_FILES`.
- **Frontend file:** `npm test -- <path>`.

## Child decomposition (Open Engine)

Ten children, in this order. They all land on `feat/server-3084-w4-persona` and ship as ONE PR, so a child may leave a seam the next one closes (Task 4.4 changes what the knob accepts before 4.5 reads it; 4.5 keeps a temporary shim 4.6a deletes).

| # | Child | Plan steps | Needs |
|---|---|---|---|
| 1 | **4.1** `runFreeText` (+ `absoluteMaxMs`, `PERSONA_ABSOLUTE_MAX_MS`) | Task 4.1, Steps 1–6 | none |
| 2 | **4.4** knob + save check | Task 4.4, Steps 1–6 | PR 3d merged |
| 3 | **4.2** Ollama non-streaming free-text branch | Task 4.2, Steps 1–6 | 1 |
| 4 | **4.3a** Gemini free text + ceiling | Task 4.3, Gemini half of Steps 1–6 | 1 |
| 5 | **4.3b** OpenAI free text + ceiling | Task 4.3, OpenAI half of Steps 1–6 | 1 |
| 6 | **4.5** (audit label C1) `voice-style.ts` through `runFreeText`, with the temporary `resolvePersonaEngine` shim and the #3725 test amendment | Task 4.5, Steps 1–5 and its own commit | 1–5 |
| 7 | **4.6a** (C2) gates, signal, lazy `break`, pre-pass rethrow incl. taxonomy `auth`; deletes the shim; fixes `book-op.design-jobs.test.ts:41-44` | Task 4.6, Steps 1–5 minus the backstop and OpenAPI parts | 6 |
| 8 | **4.6b** (C3) backstop codes, OpenAPI `anyOf`, parity test, `api-types.ts` regen | Task 4.6: the backstop branches, the `openapi.yaml` edit, the `.code` assertions, mutations 6 and 8c | 7 |
| 9 | **4.7** Advanced Settings persona test | Task 4.7, Steps 1–6 | 2 |
| 10 | **verify/ship (4.8)** | Task 4.8, Steps 1–6 | 1–9 |

- **4.4 sits second** because its knob type is what 4.5 reads: `voice-style.endpoint.test.ts` goes through the real `configValue`, so the knob must already accept `openai:…`. 4.4 must not ship alone (until 4.5, `resolvePersonaEngine()` reads an endpoint id as `gemini`, and the Advanced row already offers endpoint models). That is fine because everything lands as one PR.
- **Step boundaries follow the audit and differ from the plan's commits in two places.** Task 4.3 is two commits (the Gemini pair, then the OpenAI pair) instead of one; Tasks 4.5 + 4.6 are three commits (4.5, 4.6a, 4.6b) instead of one. Typecheck stays green after 4.5 only because of the shim. If the owner insists on the plan's single 4.5 + 4.6 commit, merge children 6–8.
- **Parallelism.** The audit found children 3, 4 and 5 touch disjoint files (`ollama-transport.ts` plus the Ollama tests / `gemini-transport.ts` / `openai-transport.ts`) and that 4.7 needs only 4.4, so they could run in parallel. The order above is the sequential one.

---

### Task 4.1: Free-text request contract and `StageRunner.runFreeText`

> **Re-pin notes (2026-10-23, against b015aae9) — read first; these override the steps below where they differ.**
> - **Owner decision 4.3-B1(b): the persona ceiling is part of this contract.**
>   - `runner/transport.ts` defines `export const PERSONA_ABSOLUTE_MAX_MS = 600_000;`, with the rationale comment moved from `ollama.ts:44–50` (copy it as it stands there). The file has type-only imports, so the constant adds no import cycle (Step 4 adds `npm run check:cycles`).
>   - `FreeTextOptions.absoluteMaxMs` is documented as: "Every transport: absolute ceiling for a free-text request; default `PERSONA_ABSOLUTE_MAX_MS`. Ollama starts it after the slot; Gemini/OpenAI use `min(request ceiling, this)`." `onCpu` and `keepAlive` are Ollama-only.
>   - `FreeTextInput` gains a top-level `absoluteMaxMs?: number`. `runFreeText` sets `freeText: { ...input.ollama, ...(input.absoluteMaxMs !== undefined ? { absoluteMaxMs: input.absoluteMaxMs } : {}) }`.
>   - New test: `runFreeText({ prompt: 'P', absoluteMaxMs: 250 })` leaves `req.freeText` equal to `{ absoluteMaxMs: 250 }`. New mutation 7: drop the spread; expect red.
> - **Anchors at `b015aae9`.**
>   - `TransportRequest` is `runner/transport.ts:30–45`: `temperature: number;` `:34`, `signal?: AbortSignal;` `:38`, then a comment block, then `call: Pick<StageCall, …>;`. Put `freeText?` after `signal` and before that comment block. `maxOutputTokens?` is already optional. `ChatTransport.prepare?(signal?)` is `:74`.
>   - `stage-runner.ts`: the private `send` is `:194` (its `await this.transport.prepare?.(call.signal);` is `:208`). Extend the EXISTING import lines instead of adding second ones: `./parse.js` (`:11`) gains `stripThink`; `./finish.js` (`:10`) gains `hasReasoningEvidence`; `../errors.js` (`:9`) already brings `AnalyzerInvalidOutputError, AnalyzerReasoningOverflowError`, so add only `GeminiContentBlockedError`; the `./transport.js` type import (`:14`) gains `FreeTextInput, TransportResult`.
>   - The persona estimate the comment cites is `voice-style.ts:219` at `6c3a0a49` (`const estTokens = Math.ceil(prompt.length / 4) + 200;`), not `:212`. The Step 3 snippet carries the corrected comment.
>   - `GeminiContentBlockedError(model, reason?)` is `errors.ts:142–161`; `AnalyzerReasoningOverflowError(transport, model, reasoningTokens, opts?)` is `:198–227`; `stripThink` returns `{ text, unterminated }`.
> - **Widening `temperature` to `number | undefined` is type-safe.** The only readers pass it straight into a request body: `gemini-transport.ts:229`, `ollama-transport.ts:149`, `openai-transport.ts:301`. No arithmetic anywhere.
> - **Wave 3d added nothing that overlaps.** No `runFreeText` or `freeText` exists on `main`. `fallback.test.ts` exists.
> - **Cross-task note for 4.5/4.6.** `runFreeText` runs on `analyzer.runner`, so it bypasses `OpenAIAnalyzer.withEndpointId` (`openai.ts:57–67`). A persona `AnalyzerReasoningOverflowError` from an endpoint therefore has `endpointId === undefined`, and the failure-taxonomy fix text cannot name the endpoint unless 4.5 stamps it.
> - **Step boundary.** One child, small. Steps: test file, types, method, run, 7 mutations, commit. Tasks 4.2, 4.3a and 4.3b all need it.

**Files:**
- Modify: `server/src/analyzer/runner/transport.ts` — add `FreeTextOptions` and `FreeTextInput`; widen `TransportRequest.temperature`; add `TransportRequest.freeText`; define the exported `PERSONA_ABSOLUTE_MAX_MS`.
- Modify: `server/src/analyzer/runner/stage-runner.ts` — add `runFreeText`.
- Read only: `server/src/analyzer/runner/transport-analyzer.ts` — W1 declares `constructor(readonly runner: StageRunner)` (entry criterion 5). This task does not modify it.
- Test: Create `server/src/analyzer/runner/stage-runner.free-text.test.ts`.

**Interfaces:**
- **Consumes:** `StageRunner`, `ChatTransport`, `TransportRequest`, `TransportResult`, `OLLAMA_RETRY_POLICY` (W1), `stripThink` (W1, `runner/parse.ts`), `hasReasoningEvidence` (W2, `runner/finish.ts`), `ChatTransport.prepare?(signal?: AbortSignal)` (W2, bounded at 10 s and released by the caller's abort, P26), `TransportAnalyzer.runner` (W1, public `readonly`), `AnalyzerReasoningOverflowError` and `GeminiContentBlockedError` (`errors.ts`).
- **Produces:**
  ```ts
  export const PERSONA_ABSOLUTE_MAX_MS = 600_000;
  export interface FreeTextOptions { onCpu?: boolean; keepAlive?: string | number; absoluteMaxMs?: number }
  export interface FreeTextInput { system?: string; prompt: string; signal?: AbortSignal; temperature?: number; absoluteMaxMs?: number; ollama?: FreeTextOptions }
  // TransportRequest: temperature: number | undefined;  freeText?: FreeTextOptions;
  StageRunner.runFreeText(input: FreeTextInput): Promise<string>
  ```
- **Keeps green:**
  - every W1–W3 runner and transport suite: `npm --prefix server run test -- src/analyzer/runner src/analyzer/transports`;
  - `src/analyzer/ollama.test.ts`;
  - `src/analyzer/fallback.test.ts`;
  - `npm run typecheck`, which catches any transport that does arithmetic on `req.temperature`.

- [ ] **Step 1: Write the failing test** — `server/src/analyzer/runner/stage-runner.free-text.test.ts`
```ts
/* #3084 W4 — StageRunner.runFreeText (spec §10): one unstructured, single-attempt call.
   A fake transport records the request, so every field the persona path depends on is pinned. */
import { describe, it, expect } from 'vitest';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './retry-policy.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';
import { AnalyzerReasoningOverflowError, GeminiContentBlockedError } from '../errors.js';

class FakeTransport implements ChatTransport {
  readonly kind = 'openai' as const;
  readonly model = 'fake-model';
  readonly requests: TransportRequest[] = [];
  constructor(private readonly result: TransportResult) {}
  async send(req: TransportRequest): Promise<TransportResult> {
    this.requests.push(req);
    return this.result;
  }
}

function result(text: string, over: Partial<TransportResult> = {}): TransportResult {
  return { text, reasoningSeen: false, finish: 'stop', receivedBytes: text.length, ...over };
}

function runnerFor(r: TransportResult) {
  const transport = new FakeTransport(r);
  const runner = new StageRunner({
    transport,
    policy: OLLAMA_RETRY_POLICY,
    settings: () => ({ structuredOutput: 'schema', maxOutputTokens: 4096 }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });
  return { transport, runner };
}

describe('StageRunner.runFreeText', () => {
  it('sends ONE unstructured request with no output cap, no temperature and the persona token estimate', async () => {
    const { transport, runner } = runnerFor(result('not json at all'));
    await expect(runner.runFreeText({ prompt: 'PROMPT' })).resolves.toBe('not json at all');
    expect(transport.requests).toHaveLength(1);
    const req = transport.requests[0];
    expect(req.system).toBe('');
    expect(req.messages).toEqual([{ role: 'user', content: 'PROMPT' }]);
    expect(req.structuredOutput).toEqual({ mode: 'off' });
    expect(req.maxOutputTokens).toBeUndefined(); // the engine's 4096 cap is NOT applied to free text
    expect(req.temperature).toBeUndefined();
    expect(req.freeText).toEqual({});
    expect(req.call).toEqual({});
    expect(req.estimatedInputTokens).toBe(Math.ceil('PROMPT'.length / 4) + 200);
  });

  it('counts the system text in the estimate and forwards it', async () => {
    const { transport, runner } = runnerFor(result('ok'));
    await runner.runFreeText({ system: 'SYS', prompt: 'PROMPT' });
    expect(transport.requests[0].system).toBe('SYS');
    expect(transport.requests[0].estimatedInputTokens).toBe(Math.ceil(('SYS'.length + 'PROMPT'.length) / 4) + 200);
  });

  it('forwards temperature and Ollama placement', async () => {
    const { transport, runner } = runnerFor(result('ok'));
    await runner.runFreeText({ prompt: 'P', temperature: 0.2, ollama: { onCpu: true, keepAlive: 300, absoluteMaxMs: 250 } });
    const req = transport.requests[0];
    expect(req.temperature).toBe(0.2);
    expect(req.freeText).toEqual({ onCpu: true, keepAlive: 300, absoluteMaxMs: 250 });
  });

  it('forwards a top-level absoluteMaxMs into req.freeText for every engine (the persona ceiling)', async () => {
    const { transport, runner } = runnerFor(result('ok'));
    await runner.runFreeText({ prompt: 'P', absoluteMaxMs: 250 });
    expect(transport.requests[0].freeText).toEqual({ absoluteMaxMs: 250 });
  });

  it('strips a leading <think> block from the answer', async () => {
    const { runner } = runnerFor(result('<think>plan the voice</think>A warm voice.'));
    await expect(runner.runFreeText({ prompt: 'P' })).resolves.toBe('A warm voice.');
  });

  it('returns an empty string for a clean stop with an unterminated <think> (the caller judges emptiness)', async () => {
    const { runner } = runnerFor(result('<think>still thinking'));
    await expect(runner.runFreeText({ prompt: 'P' })).resolves.toBe('');
  });

  it('returns the text of a length stop that has answer text (free text never splits)', async () => {
    const { runner } = runnerFor(result('A warm, low', { finish: 'length' }));
    await expect(runner.runFreeText({ prompt: 'P' })).resolves.toBe('A warm, low');
  });

  it('throws AnalyzerReasoningOverflowError for an empty length stop with reasoning tokens', async () => {
    const { runner } = runnerFor(result('', { finish: 'length', usage: { reasoningTokens: 900 } }));
    const err = await runner.runFreeText({ prompt: 'P' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
  });

  it('treats an unterminated <think> on a length stop as reasoning evidence', async () => {
    const { runner } = runnerFor(result('<think>and on and on', { finish: 'length' }));
    await expect(runner.runFreeText({ prompt: 'P' })).rejects.toBeInstanceOf(AnalyzerReasoningOverflowError);
  });

  it('throws GeminiContentBlockedError for a blocked response instead of returning empty text', async () => {
    const { runner } = runnerFor(result('', { finish: 'blocked', blockReason: 'SAFETY' }));
    const err = (await runner.runFreeText({ prompt: 'P' }).catch((e: unknown) => e)) as GeminiContentBlockedError;
    expect(err).toBeInstanceOf(GeminiContentBlockedError);
    expect(err.model).toBe('fake-model');
    expect(err.reason).toBe('SAFETY');
  });

  it('awaits the transport prepare(signal) with the caller signal before sending (Gemini catalog warm-up)', async () => {
    const order: string[] = [];
    let prepareSignal: AbortSignal | undefined;
    const transport: ChatTransport = {
      kind: 'gemini',
      model: 'fake-model',
      prepare: async (signal?: AbortSignal) => {
        prepareSignal = signal;
        await Promise.resolve();
        order.push('prepare');
      },
      send: async () => {
        order.push('send');
        return result('ok');
      },
    };
    const runner = new StageRunner({
      transport,
      policy: OLLAMA_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'schema', maxOutputTokens: 4096 }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    const ac = new AbortController();
    await runner.runFreeText({ prompt: 'P', signal: ac.signal });
    expect(order).toEqual(['prepare', 'send']);
    /* P26: a pause must be able to release a stalled warm-up, so the warm-up gets the caller's signal. */
    expect(prepareSignal).toBe(ac.signal);
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
  - **Run:** `npm --prefix server run test -- src/analyzer/runner/stage-runner.free-text.test.ts`
  - **Expected:** FAIL with `runner.runFreeText is not a function`.
- [ ] **Step 3: Implement**

In `server/src/analyzer/runner/transport.ts`, add these exports above `TransportRequest`:
```ts
/* Absolute ceiling for a one-shot free-text (persona) request. COPY the rationale comment from
   ollama.ts:44-50 as it stands there when you move it (ANALYZER_DISPATCHER removes undici's implicit
   300s bound; deliberately generous because a large model on CPU legitimately takes minutes; mirrors
   DESIGN_ABSOLUTE_MAX_MS in tts/design-voice-core.ts) and add: every transport bounds a free-text
   request at min(its own request ceiling, this). */
export const PERSONA_ABSOLUTE_MAX_MS = 600_000;

/** #3084 W4 — per-call options for a free-text request. `absoluteMaxMs` is read by EVERY transport;
    `onCpu` and `keepAlive` are Ollama-only (the Gemini and OpenAI transports otherwise use the
    PRESENCE of `TransportRequest.freeText`). */
export interface FreeTextOptions {
  /** Ollama: run on system RAM (`num_gpu: 0`). The analyzer slot is still acquired (with onCpu=true). */
  onCpu?: boolean;
  /** Ollama: `keep_alive` when no analysis run is busy (a busy run pins -1). Default 0. */
  keepAlive?: string | number;
  /** Every transport: absolute ceiling for a free-text request; default PERSONA_ABSOLUTE_MAX_MS.
      Ollama starts it after the slot; Gemini/OpenAI use min(request ceiling, this). Tests pass a
      small value to prove the bound fires. */
  absoluteMaxMs?: number;
}

/** #3084 W4 — input to StageRunner.runFreeText. */
export interface FreeTextInput {
  system?: string;
  prompt: string;
  signal?: AbortSignal;
  /** Omitted → the transport omits temperature (server/model default), as the pre-transport
      Gemini persona call did. The Ollama persona caller passes resolveOllamaTemperature(). */
  temperature?: number;
  /** The persona ceiling for ANY engine (see FreeTextOptions.absoluteMaxMs); merged into `freeText`. */
  absoluteMaxMs?: number;
  /** Ollama placement (`onCpu`, `keepAlive`); an `absoluteMaxMs` set here is also honoured. */
  ollama?: FreeTextOptions;
}
```
In `TransportRequest`, change the `temperature` line and add `freeText` after `signal`:
```ts
  temperature: number | undefined;      // W4: undefined only on a free-text request → the transport omits it
  ...
  /** W4: set only by StageRunner.runFreeText — a one-shot, unstructured, single-attempt call. */
  freeText?: FreeTextOptions;
```
In `server/src/analyzer/runner/stage-runner.ts`:
- Extend the existing import lines (no second import from the same module): `./parse.js` gains `stripThink`; `./finish.js` gains `hasReasoningEvidence`.
- `../errors.js` already brings `AnalyzerReasoningOverflowError`; add only `GeminiContentBlockedError`.
- Add `FreeTextInput` and `TransportResult` to the `./transport.js` type import.
- Add the method below.

The method reads one member: the constructor's `transport` (W1 Task 1.11 declares it `readonly transport`).
```ts
  /** #3084 W4 — one unstructured, single-attempt call (persona generation, spec §10).
      No schema, no validation retry, no chunking, and NO engine output cap: free text gets the
      model's default length, as the persona calls had before they ran through a transport.
      Wave 5 adds the engine's reasoning level and custom payload to this request.
      Returns the answer text with a leading <think> block removed. An empty string is returned
      as-is for the caller to judge; a blocked response and a length stop that produced only
      reasoning throw, so neither failure is collapsed into an empty answer. */
  async runFreeText(input: FreeTextInput): Promise<string> {
    /* Master contract: the runner awaits prepare(signal) before it reads settings (the Gemini transport
       warms its model catalog there; P26 bounds it, and the caller's abort releases it). This is the
       same inline call wave 2 put in the private `send`: `await this.transport.prepare?.(call.signal);`
       followed by `const settings = this.settings();`. Free text reads no settings in wave 4; wave 5
       (Task 5.1) adds `const settings = this.settings();` directly after this line. */
    await this.transport.prepare?.(input.signal);
    const system = input.system ?? '';
    const sent = await this.transport.send({
      system,
      messages: [{ role: 'user', content: input.prompt }],
      structuredOutput: { mode: 'off' },
      temperature: input.temperature,
      maxOutputTokens: undefined,
      /* The persona limiter estimate from voice-style.ts:219 at 6c3a0a49 (its Gemini branch's `const estTokens`): ~chars/4 plus a flat margin. */
      estimatedInputTokens: Math.ceil((system.length + input.prompt.length) / 4) + 200,
      signal: input.signal,
      call: {},
      /* The persona ceiling is the one free-text field EVERY transport reads (owner decision 4.3-B1). */
      freeText: {
        ...input.ollama,
        ...(input.absoluteMaxMs !== undefined ? { absoluteMaxMs: input.absoluteMaxMs } : {}),
      },
    });
    const think = stripThink(sent.text);
    const answer: TransportResult = think.unterminated
      ? { ...sent, text: '', reasoningSeen: true }
      : { ...sent, text: think.text };
    if (answer.finish === 'blocked') {
      throw new GeminiContentBlockedError(this.transport.model, answer.blockReason);
    }
    if (answer.finish === 'length' && answer.text.trim() === '' && hasReasoningEvidence(answer)) {
      throw new AnalyzerReasoningOverflowError(this.transport.kind, this.transport.model, answer.usage?.reasoningTokens);
    }
    return answer.text;
  }
```
Do not edit `server/src/analyzer/runner/transport-analyzer.ts`. Entry criterion 5 has already confirmed that W1's `constructor(readonly runner: StageRunner)` is public; every test in this wave reads `.runner` from outside the class.

- [ ] **Step 4: Run and confirm it passes**
  - **Run:** `npm --prefix server run test -- src/analyzer/runner/stage-runner.free-text.test.ts src/analyzer/runner src/analyzer/transports`, then `npm run typecheck`, then `npm run check:cycles`.
  - **Expected:** PASS, tsc reports no errors, and `check:cycles` reports no new cycle (`runner/transport.ts` has type-only imports).
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Output cap:** change `maxOutputTokens: undefined,` to `maxOutputTokens: this.settings().maxOutputTokens,`. Expected red: `sends ONE unstructured request…` (`expected 4096 to be undefined`).
  2. **Token estimate:** change `+ 200` to `+ 0`. Expected red: `sends ONE unstructured request…` and `counts the system text…`.
  3. **Blocked response:** delete the `if (answer.finish === 'blocked') {…}` block. Expected red: `throws GeminiContentBlockedError…` (resolves `''`).
  4. **Unterminated think:** replace the `answer` ternary with `const answer: TransportResult = { ...sent, text: think.text };`. Expected red: `treats an unterminated <think> on a length stop as reasoning evidence`.
  5. **Warm-up:** delete `await this.transport.prepare?.(input.signal);`. Expected red: `awaits the transport prepare(signal) with the caller signal before sending` (`expected [ 'send' ] to deeply equal [ 'prepare', 'send' ]`).
  6. **Warm-up signal:** change `prepare?.(input.signal)` to `prepare?.()`. Expected red: the same test (`expected undefined to be AbortSignal{}`).
  7. **Persona ceiling:** drop the `...(input.absoluteMaxMs !== undefined ? … : {})` spread. Expected red: `forwards a top-level absoluteMaxMs into req.freeText…`.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/transport.ts server/src/analyzer/runner/stage-runner.ts server/src/analyzer/runner/stage-runner.free-text.test.ts
git commit -m "feat(server): add StageRunner.runFreeText for unstructured single-attempt calls"
```

---

### Task 4.2: Ollama transport — the non-streaming free-text branch

> **Re-pin notes (2026-10-23, against b015aae9) — read first; these override the steps below where they differ.**
> - **The constant is NOT defined in this task any more (owner decision 4.3-B1(b)).** `PERSONA_ABSOLUTE_MAX_MS` is defined in `runner/transport.ts` by Task 4.1.
>   - `ollama-transport.ts` imports it as a VALUE from `../runner/transport.js` (the existing import at `:49` is `import type`, so add a separate line) and re-exports it.
>   - `ollama.ts` deletes its definition and comment (`:44–50`), adds the constant to the `:8` import (`import { OllamaTransport, ANALYZER_DISPATCHER, classifyConnectError } from './transports/ollama-transport.js';`, which `generatePersonaViaOllama` still uses), AND to the `:20` re-export, which becomes `export { ANALYZER_DISPATCHER, classifyConnectError, PERSONA_ABSOLUTE_MAX_MS } from './transports/ollama-transport.js';`. `voice-style.ts:38` (#3725) and `voice-style.timeout.test.ts`'s `vi.mock('./ollama.js', …)` read it from there, so an import-only move breaks typecheck.
>   - New mutation 7: remove the `:20` re-export; expect red on `npm run typecheck` and on `voice-style.timeout.test.ts`.
>   - The runs in Step 4 add `src/analyzer/voice-style.timeout.test.ts` and `src/analyzer/transport-redaction.test.ts`; both stay green until Task 4.5 retargets them.
> - **Anchors at `b015aae9`.** `ollama.ts`: the constant and its comment `:44–50`; `generatePersonaViaOllama` doc `:70`, body `:78–173` (its comments are at `:90–172`). `ollama-transport.ts`: imports `:36–49` (`undiciFetch`, `Agent`, `acquireAnalyzerSlot`, `AnalysisAbortedError`, `LocalUnreachableError`, `AnalyzerHttpError`, `redactKnownSecrets` from `../redact.js`, `loadKnownAnalyzerSecrets` from `../known-secrets-gate.js` (the A9 leaf gate, not user-settings)); `ANALYZER_DISPATCHER` `:60`; `classifyConnectError` `:461`, whose `AbortError` arm is `:482–487` (this is why `sendFreeText`'s `req.signal?.aborted` guard is needed).
> - **The streaming body does NOT import `isAnyAnalyzerRunBusy`.** Add `import { isAnyAnalyzerRunBusy } from '../../tts/design-lock.js';` (no new cycle: `design-lock.ts` imports nothing, and `ollama-settings.ts`, already imported here, imports it at `:6`).
> - **Copy the comments in `sendFreeText` from `ollama.ts:90–172` as they stand, not from the plan snippet's wording.** The code says "unlike OllamaTransport.send() (whose request carries the analysis signal)" and "Same ANALYZER_DISPATCHER as OllamaTransport.send()"; the non-OK comment (`:160–163`) already says "Wave 4 moves this body into OllamaTransport.sendFreeText and keeps these lines"; the `finally` reads `releaseSlot(); // non-nullable (unlike the old acquireGpuTokenIfOnGpu release)`. Keep only the plan's `CHANGED` edits.
> - **The dispatcher field is non-optional** (`private readonly dispatcher: Agent`, defaulted in the constructor, `ollama-transport.ts:110`). Use `dispatcher: this.dispatcher,`. `this.url` and `this.model` match the plan.
> - **Test anchors.** `ollama.test.ts`: `vi.hoisted` + `vi.mock('undici')` `:161–165`; `mockChatResponse` `:1389–1395`; the header comment plus `describe('generatePersonaViaOllama', …)` to replace is `:1397–1455` (the plan said `1394-1452`). That header comment starts `/* generatePersonaViaOllama shares OllamaTransport's wire path…`. `afterEach`, `vi` and `* as conc` are already imported (`:17`, `:22`). `ollama-timeout.test.ts`: the plan's citations are correct (imports `:30–34`, `it('REGRESSION…` `:149–215`, the call `:161–171`, the `OLLAMA_URL` save `:162–164` and outer `finally` `:211–214`, the capacity-1 probe `:191–210`).
> - **Step 2's expected-failure list is incomplete.** `a non-OK response is an AnalyzerHttpError carrying the pre-transport message text` also PASSES before Step 3: the streaming `send()` builds an identical `AnalyzerHttpError` (`ollama-transport.ts:202–216`). Its lock is mutation 6 in `ollama-timeout.test.ts`. `a length stop with only thinking…` does fail before Step 3 (`mockChatResponse`'s single JSON has no trailing newline, so the NDJSON loop yields `''` with `finish: 'stop'`).
> - **The redaction test needs a static import of user-settings.** `_setUserSettingsCacheForTest(partial)` is `user-settings.ts:2111`, and importing `user-settings.js` registers the known-secrets provider at module load (`:1973`); the new import line in `ollama-timeout.test.ts` is what makes `loadKnownAnalyzerSecrets` return the secret.
> - **Other consumers left for Task 4.5:** `transport-redaction.test.ts:13` and `:137` call `generatePersonaViaOllama`; `voice-style.test.ts:332` and `:341` spy on it. `noUnusedLocals` is on: after this task `ollama.ts` still uses every import until 4.5.
> - **Step boundary.** One child, medium. Do not split it: mutations 1, 2, 5 and 6 are proven by the `ollama-timeout` cases, 3 and 4 by `ollama.test.ts`. It needs Task 4.1 and can run in parallel with 4.3a and 4.3b.

**Files:**
- Modify: `server/src/analyzer/transports/ollama-transport.ts`:
  - `send()` gains a first-line dispatch;
  - new private `sendFreeText`;
  - re-export of `PERSONA_ABSOLUTE_MAX_MS` (defined in `runner/transport.ts`, Task 4.1).
- Modify: `server/src/analyzer/ollama.ts` — delete the `PERSONA_ABSOLUTE_MAX_MS` definition and its comment (`:44–50`); add the constant to the `:8` import and to the `:20` re-export (see the Re-pin notes). `generatePersonaViaOllama` still uses it until Task 4.5.
- Test: Modify `server/src/analyzer/ollama.test.ts:1397-1455` (retarget the persona describe to the runner free-text path).
- Test: Modify `server/src/analyzer/ollama-timeout.test.ts`:
  - `:30-34` — imports;
  - `:149-215` — the call site only; the assertions stay identical;
  - append two cases: a caller abort before the first byte, and a non-OK body echoing a known secret.

**Interfaces:**
- **Consumes:** `FreeTextOptions`, `TransportRequest.freeText`, `StageRunner.runFreeText` (Task 4.1), `TransportAnalyzer.runner` (W1, public). From W1 it also needs `classifyConnectError`, `ANALYZER_DISPATCHER`, `acquireAnalyzerSlot`, `isAnyAnalyzerRunBusy`, `undiciFetch`, `AnalyzerHttpError` and `AnalysisAbortedError`, and from W3b Task 3b.6a `redactKnownSecrets` and `loadKnownAnalyzerSecrets`; the file already imports all of them except `isAnyAnalyzerRunBusy`, which Step 3 adds.
- **Produces:** `PERSONA_ABSOLUTE_MAX_MS` re-exported from `transports/ollama-transport.ts` and from `ollama.ts` (defined in `runner/transport.ts`, Task 4.1). `OllamaTransport.send(req)` serves `req.freeText` with one non-streaming call.
- **Keeps green:**
  - the whole of `src/analyzer/ollama.test.ts` (the streaming stage path is untouched);
  - `src/analyzer/ollama-timeout.test.ts` — its 4 existing cases (plus the 2 this task adds);
  - W1's Ollama transport suite: `npm --prefix server run test -- src/analyzer/transports`;
  - `src/analyzer/voice-style.timeout.test.ts` and `src/analyzer/transport-redaction.test.ts` (both still reach the old persona function until Task 4.5).

- [ ] **Step 1: Write the failing tests**

In `server/src/analyzer/ollama.test.ts`, replace lines 1397-1455 (the header comment and `describe('generatePersonaViaOllama', …)`) with the block below. `mockChatResponse` (1389-1395) and `fetchMock` (`vi.hoisted` plus `vi.mock('undici')` at 161-165) stay.
```ts
/* Persona generation's Ollama path (#3084 W4, spec §10): OllamaAnalyzer's runner free-text call,
   which OllamaTransport serves with ONE non-streaming /api/chat call — the body that was
   generatePersonaViaOllama on main 80be2f1d. It carries ANALYZER_DISPATCHER too (`stream:false`
   withholds headers for the WHOLE generation), so these drive the same undici fetchMock as chat(). */
describe('Ollama free-text (persona) call', () => {
  afterEach(() => vi.restoreAllMocks());

  async function freeText(
    ollama: { onCpu?: boolean; keepAlive?: string | number },
    model = 'qwen3.5:9b',
  ): Promise<string> {
    const { OllamaAnalyzer } = await import('./ollama.js');
    return new OllamaAnalyzer({ url: 'http://ollama.test', model }).runner.runFreeText({
      prompt: 'PROMPT',
      temperature: 0.2,
      ollama,
    });
  }

  it('GPU path: sends the caller keep_alive, leaves num_gpu unset, and keeps the persona wire shape', async () => {
    fetchMock.mockResolvedValue(mockChatResponse('A warm voice.'));
    const out = await freeText({ onCpu: false, keepAlive: '5m' });
    expect(out).toBe('A warm voice.');
    expect(fetchMock.mock.calls[0][0]).toBe('http://ollama.test/api/chat');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.keep_alive).toBe('5m');
    expect(body.stream).toBe(false);
    expect(body.format).toBeUndefined();
    expect(body.think).toBe(false);
    expect(body.options?.num_gpu).toBeUndefined(); // GPU path leaves num_gpu unset
    /* No num_ctx / num_predict, and a single user turn with no system message — exactly main's persona body. */
    expect(Object.keys(body.options).sort()).toEqual(['temperature']);
    expect(body.options.temperature).toBe(0.2);
    expect(body.messages).toEqual([{ role: 'user', content: 'PROMPT' }]);
  });

  it('CPU path: num_gpu:0, keep_alive:0', async () => {
    fetchMock.mockResolvedValue(mockChatResponse('A cool voice.'));
    const out = await freeText({ onCpu: true });
    expect(out).toBe('A cool voice.');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.options.num_gpu).toBe(0);
    expect(body.keep_alive).toBe(0);
  });

  it('connection refusal surfaces LocalUnreachableError', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    );
    const { LocalUnreachableError } = await import('./ollama.js');
    await expect(freeText({ onCpu: true })).rejects.toBeInstanceOf(LocalUnreachableError);
  });

  it('a non-OK response is an AnalyzerHttpError carrying the pre-transport message text', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500, statusText: 'Internal Server Error' }));
    const { AnalyzerHttpError } = await import('./errors.js');
    const err = (await freeText({ onCpu: true }).catch((e: unknown) => e)) as InstanceType<typeof AnalyzerHttpError>;
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect(err.httpStatus).toBe(500);
    expect(err.message).toBe('Ollama http://ollama.test returned 500 Internal Server Error: boom');
  });

  it('a length stop with only thinking is a reasoning overflow, not an empty persona', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ message: { content: '', thinking: 'weighing the voice…' }, done: true, done_reason: 'length' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const { AnalyzerReasoningOverflowError } = await import('./errors.js');
    await expect(freeText({ onCpu: false })).rejects.toBeInstanceOf(AnalyzerReasoningOverflowError);
  });

  it('persona gen goes through the analyzer slot, keyed on its model (GPU path)', async () => {
    const spy = vi.spyOn(conc, 'acquireAnalyzerSlot');
    fetchMock.mockResolvedValue(mockChatResponse('A warm voice.'));
    await freeText({ onCpu: false, keepAlive: '5m' });
    expect(spy).toHaveBeenCalledWith('qwen3.5:9b', false);
    expect(conc.analyzerConcurrency.inFlight).toBe(0);
    spy.mockRestore();
  });

  it('persona gen on CPU takes the limiter but no GPU slot', async () => {
    const spy = vi.spyOn(conc, 'acquireAnalyzerSlot');
    fetchMock.mockResolvedValue(mockChatResponse('A cool voice.'));
    await freeText({ onCpu: true }, 'qwen3.5:4b');
    expect(spy).toHaveBeenCalledWith('qwen3.5:4b', true); // onCpu forwarded → lease no-ops
    spy.mockRestore();
  });
});
```
In `server/src/analyzer/ollama-timeout.test.ts`, change lines 30-34 to:
```ts
import { OllamaAnalyzer, LocalUnreachableError } from './ollama.js';
import { AnalysisAbortedError, AnalyzerHttpError } from './errors.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
```
Then replace lines 149-171 — from the `it('REGRESSION: …` line through the `.then(() => null, (e: Error) => e);` that closes the call. Lines 173-210 (both `expect`s and the capacity-1 slot probe) stay verbatim.
```ts
  it('REGRESSION: the Ollama free-text (persona) call stays bounded — the dispatcher must not make it hang forever', async () => {
    /* This call site passes NO caller signal (voice-style.ts hands the runner only
       { onCpu, keepAlive }), so undici's hidden 300s cap was the ONLY thing
       stopping it. ANALYZER_DISPATCHER removes that, and the analyzer slot it
       holds is released only in a `finally` AFTER the await — so an unbounded
       hang leaks a token from a bounded semaphore and silently blocks every
       later analyzer call. PERSONA_ABSOLUTE_MAX_MS is the replacement bound;
       absoluteMaxMs proves it FIRES without waiting out ten minutes.

       The URL goes straight into OllamaAnalyzer (voice-style.ts resolves it from
       settings in production), so the call cannot reach the real daemon on :11434. */
    const url = await startSlowOllama(5_000);
    const err = await new OllamaAnalyzer({ url, model: 'qwen3.5:9b' }).runner
      .runFreeText({ prompt: 'PROMPT', ollama: { onCpu: true, absoluteMaxMs: 250 } })
      .then(
        () => null,
        (e: Error) => e,
      );
```
Then delete the now-unused `OLLAMA_URL` wrapper. Remove the outer `try {` that followed `process.env.OLLAMA_URL = url;` and its `} finally { … process.env.OLLAMA_URL … }` (main lines 162-164 and 211-214), keeping the inner capacity-1 `try/finally` intact.

Then append these two cases inside `describe('OllamaAnalyzer fetch timeout', …)`, after `still honours a caller AbortSignal…`:
```ts
  it('a caller abort before the first byte of the free-text (persona) call is AnalysisAbortedError, not an unreachable daemon', async () => {
    /* #3084 W4 — the design job's signal now reaches this call. The fetch signal is
       AbortSignal.any([budget, req.signal]), so a pause aborts it before the first byte, and
       classifyConnectError would read that AbortError as LocalUnreachableError: a paused design
       job reported as a down daemon. The 5 s header delay keeps the abort before the first byte. */
    const url = await startSlowOllama(5_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const err = await new OllamaAnalyzer({ url, model: 'qwen3.5:9b' }).runner
      .runFreeText({ prompt: 'PROMPT', signal: ac.signal, ollama: { onCpu: true } })
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err).toBeInstanceOf(AnalysisAbortedError);
    expect(err).not.toBeInstanceOf(LocalUnreachableError);
  });

  it('a non-OK free-text (persona) body is redacted against the known analyzer secrets before the error is built (P22)', async () => {
    const SECRET = 'AIzaSy-persona-echo-secret-1';
    const savedEnvKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    _setUserSettingsCacheForTest({ geminiApiKey: SECRET });
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `runner failed for key ${SECRET}` }));
      });
    });
    const url = await new Promise<string>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
      });
    });
    try {
      const err = await new OllamaAnalyzer({ url, model: 'qwen3.5:9b' }).runner
        .runFreeText({ prompt: 'PROMPT', ollama: { onCpu: true } })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(AnalyzerHttpError);
      expect((err as InstanceType<typeof AnalyzerHttpError>).bodyExcerpt).toBe('{"error":"runner failed for key [redacted]"}');
      expect(`${(err as Error).message}\n${(err as Error).stack ?? ''}`).not.toContain(SECRET);
    } finally {
      _resetUserSettingsCache();
      if (savedEnvKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedEnvKey;
    }
  });
```

- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm --prefix server run test -- src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts`
  - **Expected:** FAIL.
    - `GPU path…` fails with `expected true to be false` (the streaming `chat()` body sends `stream: true`).
    - `REGRESSION…` fails. The streaming path has no absolute bound, so the 5 s slow server answers and the error is `null`: `the call must terminate, not hang: expected null not to be null`.
  - `a non-OK response is an AnalyzerHttpError carrying the pre-transport message text` also PASSES before Step 3 (the streaming `send()` builds an identical `AnalyzerHttpError`); its lock is mutation 6.
  - The two appended cases PASS before Step 3: until the dispatch line exists, a free-text request takes `send()`'s streaming body, which already reports a caller abort as `AnalysisAbortedError` and redacts its non-OK body (W3b Task 3b.6a). They lock the non-streaming branch Step 3 adds; Step 5's mutations 5 and 6 show each can fail.

- [ ] **Step 3: Implement**

At the top of `server/src/analyzer/transports/ollama-transport.ts`:
- Add `FreeTextOptions` to the `../runner/transport.js` type import (`:49`), and add a SEPARATE value import, because that line is `import type`: `import { PERSONA_ABSOLUTE_MAX_MS } from '../runner/transport.js';`.
- Add `import { isAnyAnalyzerRunBusy } from '../../tts/design-lock.js';` (not imported today).
- Re-export the constant, which Task 4.1 defines in `runner/transport.ts` (owner decision 4.3-B1(b)); do NOT define it here: `export { PERSONA_ABSOLUTE_MAX_MS };`

Make this the first statement of `OllamaTransport.send(req)`:
```ts
    if (req.freeText) return this.sendFreeText(req, req.freeText);
```
Add the private method. Its body is `generatePersonaViaOllama` as PR 3b left it: main's `ollama.ts:951-1028` at `80be2f1d` (re-pinned from `:950-1027`) with W3b Task 3b.6a's redacted non-OK excerpt. Every line not marked `CHANGED` is verbatim from that state, including comments. The redaction call is 3b's, carried through the move unchanged.
```ts
  /** #3084 W4 — the free-text path (spec §10): one NON-streaming /api/chat call with no response
      `format`, GPU-plan aware. Moved from ollama.ts `generatePersonaViaOllama` (main 80be2f1d).
        - onCpu  → num_gpu:0 (system RAM only); the analyzer slot is still taken with onCpu=true.
        - keepAlive is caller-controlled (resident window for a bulk pre-pass; 0 for one-shot / CPU). */
  private async sendFreeText(req: TransportRequest, freeText: FreeTextOptions): Promise<TransportResult> {
    const onCpu = freeText.onCpu === true;
    const url = this.url; // CHANGED: was getResolvedOllamaUrl() — voice-style.ts resolves it into the analyzer
    const body = {
      model: this.model, // CHANGED: was the `model` parameter
      /* CHANGED: was [{ role: 'user', content: prompt }]. A persona passes system '' and one user
         turn, so the wire is identical. */
      messages: [
        ...(req.system !== '' ? [{ role: 'system' as const, content: req.system }] : []),
        ...req.messages,
      ],
      stream: false,
      think: false,
      /* Pin during an active analysis run (same rationale as keepAliveFor); the
         caller-supplied keepAlive is the post-run idle window otherwise. */
      keep_alive: isAnyAnalyzerRunBusy() ? -1 : (freeText.keepAlive ?? 0), // CHANGED: opts → freeText
      options: {
        temperature: req.temperature, // CHANGED: was resolveOllamaTemperature(); voice-style.ts passes that value
        ...(onCpu ? { num_gpu: 0 } : {}),
      },
    };

    /* ANALYZER_DISPATCHER disables undici's header/body timeouts, so SOMETHING
       else must bound this call — and unlike chat() (whose StageCall carries the
       analysis signal) and warmOllamaModel (which builds its own controller from
       warmTimeoutMs), nothing upstream of here supplies one: voice-style.ts
       passes only { onCpu, keepAlive }. Without this, a daemon wedged in the
       connected-but-never-responding state (mid-/api/pull, hung GPU driver — the
       listener stays up so connectTimeout never fires) would hang FOREVER, and
       because the analyzer slot above is released only in the finally below,
       it would leak a token from a bounded semaphore and silently block every
       later analyzer call. The hidden 300s cap used to be the only stop; removing
       it without replacing it would have traded a wrong diagnosis for a deadlock.
       Ceiling matches design-voice-core.ts's DESIGN_ABSOLUTE_MAX_MS — the same
       "a big local model on CPU is slow but not infinite" judgement. */
    const releaseSlot = await acquireAnalyzerSlot(this.model, onCpu); // CHANGED: model → this.model
    /* Start the clock AFTER the semaphore, not before: AbortSignal.timeout
       cannot be paused, so building it above the acquire charges FIFO queue
       time to the request. With K=2 held by two slow chapter calls, a persona
       request could exhaust its whole budget waiting and then reject without
       sending a byte — reported as a bare "operation was aborted due to
       timeout" naming neither daemon nor model, about an Ollama that never saw
       it. undici's implicit clock started at socket dispatch too, so this also
       keeps the replacement bound faithful to what it replaced. */
    try {
      /* Built INSIDE the try: AbortSignal.timeout/any can throw (ERR_OUT_OF_RANGE
         on a bad ceiling, TypeError on a non-signal), and the slot is already
         held by this point — anything that throws between the acquire and the
         try would leak it, which is the exact harm the regression test guards. */
      const maxMs =
        freeText.absoluteMaxMs && freeText.absoluteMaxMs > 0 ? freeText.absoluteMaxMs : PERSONA_ABSOLUTE_MAX_MS; // CHANGED: opts → freeText
      const budget = AbortSignal.timeout(maxMs);
      const signal = req.signal ? AbortSignal.any([budget, req.signal]) : budget; // CHANGED: opts.signal → req.signal
      let response: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        /* Same ANALYZER_DISPATCHER as chat(), and this call needs it MORE:
           `stream: false` above means Ollama withholds response headers until
           the ENTIRE generation is finished, so undici's 300s default would
           cover load + prefill + full decode rather than prefill alone. The
           CPU path (`num_gpu: 0`, set by voice-style.ts for persona
           generation) blows through that on any large local tag — and there is
           no Gemini fallback on this path, so the misclassified
           LocalUnreachableError below surfaces to the user as "Ollama is
           unreachable, start the daemon" about a daemon that is running fine
           and still generating. */
        response = await undiciFetch(`${url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
          dispatcher: this.dispatcher, // CHANGED: the field is non-optional (defaulted to ANALYZER_DISPATCHER in the constructor), so the injected test dispatcher is honoured, like send()
        });
      } catch (err) {
        /* CHANGED: the design job's abort signal now reaches this call (req.signal, #3084 W4). A pause
           aborts the fetch before the first byte; report the clean stop it is, as send()'s streaming
           body does, never an unreachable daemon. A budget timeout (no caller abort) classifies as before. */
        if (req.signal?.aborted) {
          throw new AnalysisAbortedError(`Ollama ${this.model} persona call aborted (paused or client disconnected).`);
        }
        throw classifyConnectError(err, url);
      }
      if (!response.ok) {
        /* CHANGED: typed per spec §1 (was a plain Error, and the excerpt local was `excerpt`). The
           redaction is PR 3b's (W3b Task 3b.6a), carried through the move: every known analyzer secret
           is removed BEFORE the body is sliced (P22). With no secret in the body the message text is
           byte-identical to main's. */
        const text = await response.text().catch(() => '');
        const bodyExcerpt = redactKnownSecrets(text, await loadKnownAnalyzerSecrets()).slice(0, 500);
        throw new AnalyzerHttpError(
          'ollama',
          response.status,
          bodyExcerpt,
          `Ollama ${url} returned ${response.status} ${response.statusText}: ${bodyExcerpt}`,
        );
      }
      /* CHANGED: also reads done_reason and message.thinking, so runFreeText can tell a length stop
         that only reasoned apart from an empty answer. */
      const json = (await response.json().catch(() => ({}))) as {
        message?: { content?: string; thinking?: string };
        done_reason?: string;
      };
      const text = json.message?.content ?? '';
      return {
        text,
        reasoningSeen: typeof json.message?.thinking === 'string' && json.message.thinking.length > 0,
        finish: json.done_reason === 'length' ? 'length' : 'stop',
        receivedBytes: text.length,
      };
    } finally {
      releaseSlot(); // non-nullable
    }
  }
```
If W1 names the constructor URL, model or dispatcher fields differently (`this.url`, `this.model`, `this.dispatcher`), use its names. They are the same fields `send()`'s streaming body reads.

In `server/src/analyzer/ollama.ts`:
- Delete the `PERSONA_ABSOLUTE_MAX_MS` comment block and definition (`:44–50`).
- Add `PERSONA_ABSOLUTE_MAX_MS` to the existing value import from `./transports/ollama-transport.js` (`:8`). `generatePersonaViaOllama` still reads the constant until Task 4.5 deletes that function.
- Add it to the existing re-export too (`:20`), which becomes `export { ANALYZER_DISPATCHER, classifyConnectError, PERSONA_ABSOLUTE_MAX_MS } from './transports/ollama-transport.js';`. `voice-style.ts:38` and `voice-style.timeout.test.ts` read the constant from `./ollama.js`.

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm --prefix server run test -- src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts src/analyzer/transports src/analyzer/voice-style.timeout.test.ts src/analyzer/transport-redaction.test.ts`, then `npm run typecheck`.
  - **Expected:** PASS (all 6 `ollama-timeout` cases; the last two files stay green).
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Slot release:** in `sendFreeText`, delete `releaseSlot();` from the `finally`. Expected red: `REGRESSION: the Ollama free-text (persona) call stays bounded…` with `the analyzer slot must be released on the timeout path (capacity 1)`.
  2. **Absolute bound:** change `const signal = req.signal ? … : budget;` to `const signal = req.signal;`. Expected red: the same `REGRESSION` test, with `the call must terminate, not hang`.
  3. **Free-text dispatch:** delete the `if (req.freeText) return this.sendFreeText(…)` line. Expected red: `GPU path: sends the caller keep_alive…`.
  4. **Placement:** change `acquireAnalyzerSlot(this.model, onCpu)` to `acquireAnalyzerSlot(this.model, false)`. Expected red: `persona gen on CPU takes the limiter but no GPU slot`.
  5. **Pause is not unreachable:** in `sendFreeText`'s fetch `catch`, delete the `if (req.signal?.aborted) { … }` block. Expected red: `a caller abort before the first byte of the free-text (persona) call is AnalysisAbortedError…` (a `LocalUnreachableError`).
  6. **Redaction:** replace `redactKnownSecrets(text, await loadKnownAnalyzerSecrets()).slice(0, 500)` with `text.slice(0, 500)`. Expected red: `a non-OK free-text (persona) body is redacted…` (`bodyExcerpt` holds the secret).
  7. **Re-export:** delete `PERSONA_ABSOLUTE_MAX_MS` from the `:20` re-export in `ollama.ts`. Expected red: `npm run typecheck` and `voice-style.timeout.test.ts` (both read the constant from `./ollama.js`).
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports/ollama-transport.ts server/src/analyzer/ollama.ts server/src/analyzer/ollama.test.ts server/src/analyzer/ollama-timeout.test.ts
git commit -m "feat(server): serve Ollama free-text requests with the bounded non-streaming persona call"
```

---

### Task 4.3: Gemini and OpenAI transports honour a free-text request

> **Re-pin notes (2026-10-23, against b015aae9) — read first; these override the steps below where they differ.**
> - **Two children, two commits (4.3a Gemini, 4.3b OpenAI).** Both need only Task 4.1 and are independent of each other and of 4.2. Split the plan's single commit: `git add` the Gemini pair, commit; then the OpenAI pair, commit.
> - **Owner decision 4.3-B1(b): both transports bound a free-text request at the persona ceiling.** A free-text request uses `min(request ceiling, req.freeText.absoluteMaxMs ?? PERSONA_ABSOLUTE_MAX_MS)` for its `ceiling` timer, and the constant comes from `../runner/transport.js` (Task 4.1). This replaces #3725's bare-SDK `httpOptions.timeout`, which Task 4.5 removes along with the bare `generateContent`. Steps 1, 3 and 5 carry the code, tests and mutations.
> - **Gemini anchors at `b015aae9`** (one line later than the audit, because #3725 added a comment line in the `:76–83` block; keep that comment): `const includeThoughts = geminiModelThinks(this.model);` `:226`; the `config` is NOT an inline literal in the SDK call but `const config: Record<string, unknown> = { … }` `:227–232`, followed by `Object.assign(config, geminiStructuredConfig(req.structuredOutput));` `:233`; `config.abortSignal = combined;` `:251`. `includeThoughts` is read at `:230` and at the evidence gate `:418` (`if (includeThoughts && thoughtsTokenCount !== undefined)`), so the single-flag change drives both. The ceiling is `:240–241`; its `AnalyzerTimeoutError('ceiling')` throw is the catch at `:480–481`; `GEMINI_RETRY_CLASSIFIER` returns `'no-retry'` for an `AnalyzerTimeoutError` (`:129`), so the ceiling is terminal. Step 3's Gemini snippet is the corrected replacement for `:226–232`. Leave `:233` and `:251` untouched. The `?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS` wrapper (`capacity.ts:39`, 8192) stays in the stage branch.
> - **OpenAI anchors:** the params are built in the exported pure function `buildOpenAIRequestBody(endpoint, model, req)` (`openai-transport.ts:280–305`), called at `:431–434`, not inline in `create()`. `max_tokens` is derived inside it (P24 Auto). For free text `req.maxOutputTokens` is undefined, so without the change it would send `perRequestBound`. The ceiling is `:407`; the SDK `timeout` (`:355`) and `maxTotalMs` (`:375`) stay as they are. `noteEndpointModelUsed` is `:429`.
> - **Gemini test hygiene.** `runFreeText` awaits `GeminiTransport.prepare` = `warmGeminiCatalog(apiKey, { client, signal })`. The mocked client has no `models.list`, so the listing rejects inside its own async IIFE and `warmGeminiCatalog` still resolves, but it leaves module state (`lastFailure`, `warnedFailure`) and a 10 s listing timer. Call `_resetGeminiCatalogForTest()` (`gemini-catalog.ts:279`) in the new file's `beforeEach` (or seed with `_seedGeminiCatalogForTest('k', [])`, `:294`). `analyzerRateLimiter` is the same object as `geminiRateLimiter` (`rate-limit.ts:396`), with `_reset()` and `acquire(model, estimatedTokens, opts)`.
> - **The OpenAI CONTROL expectations hold.** Mode `json` maps to `{ type: 'json_object' }` (`:254`); `max_tokens: 1024` survives because Auto's per-request bound (29 481) is above it; W3 sends `max_tokens`, not `max_completion_tokens`, so the plan's fallback clause is unused. The `AnalyzerEndpoint` literal fills every required field; `OpenAIAnalyzer`'s constructor is `{ endpoint, apiKey: string | null, model, dispatcher? }` (`openai.ts:36`).
> - **Mutation 2's original line** is `maxOutputTokens: req.maxOutputTokens ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,`, and mutation 3's "W3's original unconditional entry" is `max_tokens: maxTokens,`.
> - **Omitting `max_tokens` for endpoint free text is deliberate** (safe against vLLM's prompt-plus-`max_tokens` check) and not an open decision.

**Files:**
- Modify: `server/src/analyzer/transports/gemini-transport.ts` — the `config` object (`:227–232`), the `includeThoughts` local (`:226`) and the ceiling (`:240`).
- Modify: `server/src/analyzer/transports/openai-transport.ts` — `buildOpenAIRequestBody` (`:280–305`) and the ceiling (`:407`).
- Test: Create `server/src/analyzer/transports/gemini-transport.free-text.test.ts`.
- Test: Create `server/src/analyzer/transports/openai-transport.free-text.test.ts`.

**Interfaces:**
- **Consumes:**
  - `TransportRequest.freeText` and `runFreeText` (Task 4.1);
  - `GeminiAnalyzer` / `GeminiTransport` (W1);
  - `OpenAIAnalyzer` / `OpenAITransport` and the `AnalyzerEndpoint` type (W3);
  - `analyzerRateLimiter` (W3).
- **Produces:**
  - **Gemini:** a free-text request carries no `systemInstruction` when `system === ''`, no `temperature` when undefined, no `maxOutputTokens` when undefined, and no `thinkingConfig` at all (so no wave 2 `includeThoughts`; P19). One flag, W2's `includeThoughts` local, drives both that omission and W2's `reasoningTokens` gate, so a free-text response's `thoughtsTokenCount` is not reasoning evidence (P27, A3).
  - **OpenAI:** a free-text request carries no system message when `system === ''`, no `temperature` when undefined, and no `max_tokens` when undefined.
  - **Stage requests** are unchanged on both.
- **Keeps green:**
  - W1–W3 Gemini and OpenAI transport suites (`npm --prefix server run test -- src/analyzer/transports`);
  - the W3 OpenAI transport contract suite;
  - `src/analyzer/gemini.test.ts` via `npm --prefix server run test -- --config vitest.config.slow.ts src/analyzer/gemini.test.ts` (a slow-lane file).

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/transports/gemini-transport.free-text.test.ts`:
```ts
/* #3084 W4 — a free-text (persona) request through GeminiTransport keeps main's persona wire shape:
   the pre-transport call was `generateContent({ model, contents })` with no config at all. The stage
   request below is the control that proves the omission is gated on `freeText`, not blanket. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzerRateLimiter } from '../rate-limit.js';
import { _resetGeminiCatalogForTest } from '../catalog/gemini-catalog.js';
import { AnalyzerTimeoutError } from '../errors.js';

const generateContentStream = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContentStream };
  },
}));

async function* chunks(items: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const item of items) yield item;
}
const STOP = (text: string) => chunks([{ text, candidates: [{ finishReason: 'STOP' }] }]);

beforeEach(() => {
  generateContentStream.mockReset();
  analyzerRateLimiter._reset();
  /* prepare() warms the model catalog; the mocked client has no models.list, so reset the module state
     (and its listing timer) the failed warm-up would leave behind. */
  _resetGeminiCatalogForTest();
});

describe('GeminiTransport — free-text request', () => {
  it('omits systemInstruction, JSON mode, temperature, maxOutputTokens and thinkingConfig', async () => {
    generateContentStream.mockResolvedValue(STOP('A warm voice.'));
    const { GeminiAnalyzer } = await import('../gemini.js');
    const out = await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.1-flash-lite' }).runner.runFreeText({
      prompt: 'PROMPT',
    });
    expect(out).toBe('A warm voice.');
    const { model, contents, config } = generateContentStream.mock.calls[0][0] as {
      model: string;
      contents: unknown;
      config: Record<string, unknown>;
    };
    expect(model).toBe('gemini-3.1-flash-lite');
    expect(JSON.stringify(contents)).toContain('PROMPT');
    expect(config).not.toHaveProperty('systemInstruction');
    expect(config).not.toHaveProperty('responseMimeType');
    expect(config).not.toHaveProperty('responseJsonSchema');
    expect(config).not.toHaveProperty('temperature');
    expect(config).not.toHaveProperty('maxOutputTokens');
    /* gemini-3.1-flash-lite thinks by wave 2's id rule, so a STAGE request carries includeThoughts (CONTROL below). */
    expect(config).not.toHaveProperty('thinkingConfig');
  });

  it('acquires the limiter for the model with the persona estimate', async () => {
    generateContentStream.mockResolvedValue(STOP('x'));
    const acquire = vi.spyOn(analyzerRateLimiter, 'acquire');
    const { GeminiAnalyzer } = await import('../gemini.js');
    const prompt = 'P'.repeat(1001);
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.1-flash-lite' }).runner.runFreeText({ prompt });
    expect(acquire.mock.calls[0][0]).toBe('gemini-3.1-flash-lite');
    expect(acquire.mock.calls[0][1]).toBe(Math.ceil(1001 / 4) + 200);
    acquire.mockRestore();
  });

  it('reports no reasoning tokens: a free-text request asks for no thoughts, so its thoughtsTokenCount is not evidence (P27, A3)', async () => {
    /* A fresh generator per call: a resolved value would hand the second call an exhausted one. */
    generateContentStream.mockImplementation(async () =>
      chunks([{ text: 'A warm voice.', candidates: [{ finishReason: 'STOP' }], usageMetadata: { thoughtsTokenCount: 321 } }]),
    );
    const { GeminiTransport } = await import('./gemini-transport.js');
    const transport = new GeminiTransport({ apiKey: 'k', model: 'gemini-3.1-flash-lite' });
    const turn = { messages: [{ role: 'user' as const, content: 'P' }], estimatedInputTokens: 10, call: {} };
    const free = await transport.send({ ...turn, system: '', structuredOutput: { mode: 'off' }, temperature: undefined, freeText: {} });
    const stage = await transport.send({ ...turn, system: 'SYS', structuredOutput: { mode: 'json' }, temperature: 0.2, maxOutputTokens: 8192 });
    expect(free.usage?.reasoningTokens).toBeUndefined();
    /* CONTROL: this model thinks by wave 2's id rule, and the stage request asked for thoughts. */
    expect(stage.usage?.reasoningTokens).toBe(321);
  });

  it('CONTROL: a stage request still sends its system instruction, temperature, output cap and thought summaries', async () => {
    generateContentStream.mockResolvedValue(STOP('{}'));
    const { GeminiTransport } = await import('./gemini-transport.js');
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.1-flash-lite' }).send({
      system: 'SYS',
      messages: [{ role: 'user', content: 'P' }],
      structuredOutput: { mode: 'json' },
      temperature: 0.2,
      maxOutputTokens: 8192,
      estimatedInputTokens: 10,
      call: {},
    });
    const { config } = generateContentStream.mock.calls[0][0] as { config: Record<string, unknown> };
    expect(config).toHaveProperty('systemInstruction');
    expect(config.temperature).toBe(0.2);
    expect(config.maxOutputTokens).toBe(8192);
    expect(config.responseMimeType).toBe('application/json');
    expect(config.thinkingConfig).toEqual({ includeThoughts: true });
  });

  /* Owner decision 4.3-B1(b): a free-text request is bounded at min(request ceiling, absoluteMaxMs), and
     that ceiling is TERMINAL (GEMINI_RETRY_CLASSIFIER never retries an AnalyzerTimeoutError). */
  it('a free-text request stops at its absoluteMaxMs ceiling (one call, AnalyzerTimeoutError ceiling) though the request ceiling is 60 s', async () => {
    generateContentStream.mockImplementation(
      (params: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          params.config.abortSignal.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })),
          );
        }),
    );
    const { GeminiTransport } = await import('./gemini-transport.js');
    const t0 = Date.now();
    const err = await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.1-flash-lite', requestCeilingMs: 60_000 })
      .send({
        system: '',
        messages: [{ role: 'user', content: 'P' }],
        structuredOutput: { mode: 'off' },
        temperature: undefined,
        estimatedInputTokens: 10,
        call: {},
        freeText: { absoluteMaxMs: 200 },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerTimeoutError);
    expect((err as AnalyzerTimeoutError).reason).toBe('ceiling');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: a stage request is not cut by a free-text ceiling and succeeds after a 300 ms delay', async () => {
    generateContentStream.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return STOP('{}');
    });
    const { GeminiTransport } = await import('./gemini-transport.js');
    const out = await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.1-flash-lite', requestCeilingMs: 60_000 }).send({
      system: 'SYS',
      messages: [{ role: 'user', content: 'P' }],
      structuredOutput: { mode: 'json' },
      temperature: 0.2,
      maxOutputTokens: 8192,
      estimatedInputTokens: 10,
      call: {},
    });
    expect(out.text).toBe('{}');
  });
});
```
`server/src/analyzer/transports/openai-transport.free-text.test.ts` uses a real `http.createServer` on `127.0.0.1:0` (Global Constraints; no stubbed fetch):
```ts
/* #3084 W4 — a free-text (persona) request through OpenAITransport sends no response_format,
   max_tokens, temperature or empty system message. Stage requests are the control. */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAIAnalyzer } from '../openai.js';
import { OpenAITransport } from './openai-transport.js';
import { AnalyzerTimeoutError } from '../errors.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';

let server: Server | undefined;
const bodies: Array<Record<string, unknown>> = [];
const gets: string[] = [];

function sseChunk(delta: object, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'qwen3', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function startFakeOpenAI(content: string, delayMs = 0): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === 'GET') {
      /* #3084 P15 — runFreeText awaits OpenAITransport.prepare(), which lists the served models once per base URL. */
      gets.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      /* delayMs holds the POST answer, so the ceiling tests can prove a free-text request is cut at its own bound. */
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sseChunk({ role: 'assistant', content }, null));
        res.write(sseChunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const a = server!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`);
    });
  });
}

function endpoint(baseUrl: string): AnalyzerEndpoint {
  return {
    id: 'lab', name: 'Lab', baseUrl, gpu: 'none', concurrency: 1, requestCeilingMs: 1_800_000,
    structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default',
    maxOutputTokens: 0, contextTokens: 32768,
  };
}

afterEach(async () => {
  bodies.length = 0;
  gets.length = 0;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

describe('OpenAITransport — free-text request', () => {
  it('sends one user message and no response_format, max_tokens or temperature', async () => {
    const baseUrl = await startFakeOpenAI('A calm voice.');
    const out = await new OpenAIAnalyzer({ endpoint: endpoint(baseUrl), apiKey: null, model: 'qwen3' }).runner.runFreeText({
      prompt: 'PROMPT',
    });
    expect(out).toBe('A calm voice.');
    /* runFreeText awaited the transport's prepare() (W3c Task 3c.9) before the persona request. */
    expect(gets).toHaveLength(1);
    expect(gets[0]).toMatch(/\/models$/);
    const body = bodies[0];
    expect(body.model).toBe('qwen3');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: 'PROMPT' }]);
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('CONTROL: a stage request still sends its system message, response_format, max_tokens and temperature', async () => {
    const baseUrl = await startFakeOpenAI('{}');
    await new OpenAITransport({ endpoint: endpoint(baseUrl), apiKey: null, model: 'qwen3' }).send({
      system: 'SYS',
      messages: [{ role: 'user', content: 'P' }],
      structuredOutput: { mode: 'json' },
      temperature: 0.2,
      maxOutputTokens: 1024,
      estimatedInputTokens: 10,
      call: {},
    });
    const body = bodies[0];
    expect(body.messages).toEqual([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'P' }]);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.2);
  });

  /* Owner decision 4.3-B1(b): the endpoint ceiling is 30 min, but a free-text request is bounded at
     min(endpoint ceiling, absoluteMaxMs). The fake server holds its POST answer for 600 ms. */
  it('a free-text request stops at its absoluteMaxMs ceiling (AnalyzerTimeoutError ceiling, one POST) though the endpoint ceiling is 30 min', async () => {
    const baseUrl = await startFakeOpenAI('A calm voice.', 600);
    const err = await new OpenAIAnalyzer({ endpoint: endpoint(baseUrl), apiKey: null, model: 'qwen3' }).runner
      .runFreeText({ prompt: 'PROMPT', absoluteMaxMs: 200 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerTimeoutError);
    expect((err as AnalyzerTimeoutError).reason).toBe('ceiling');
    expect(bodies).toHaveLength(1); // terminal: no retry
  });

  it('CONTROL: a stage request is not cut by the free-text ceiling (same 600 ms delay)', async () => {
    const baseUrl = await startFakeOpenAI('{}', 600);
    const out = await new OpenAITransport({ endpoint: endpoint(baseUrl), apiKey: null, model: 'qwen3' }).send({
      system: 'SYS',
      messages: [{ role: 'user', content: 'P' }],
      structuredOutput: { mode: 'json' },
      temperature: 0.2,
      maxOutputTokens: 1024,
      estimatedInputTokens: 10,
      call: {},
    });
    expect(out.text).toBe('{}');
  });
});
```
- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm --prefix server run test -- src/analyzer/transports/gemini-transport.free-text.test.ts src/analyzer/transports/openai-transport.free-text.test.ts`
  - **Expected:** the two free-text cases FAIL.
    - Gemini fails with `expected {…} not to have property "systemInstruction"`: W1–W3 always send it, together with `temperature`, `maxOutputTokens` and (for this thinking model) wave 2's `thinkingConfig`.
    - OpenAI fails with `expected {…} not to have property "max_tokens"` or a `messages` mismatch on the leading system turn.
    - Gemini's `reports no reasoning tokens…` fails with `expected 321 to be undefined`: W2's `includeThoughts` local follows the id rule on every request, free text included.
  - Both CONTROL cases, both stage-request ceiling CONTROLs and the limiter case PASS.
  - The two ceiling cases (`a free-text request stops at its absoluteMaxMs ceiling…`) FAIL: Gemini times out at the test timeout because the ceiling is still the 60 s `requestCeilingMs`; OpenAI resolves after the 600 ms delay instead of rejecting.
  - If the OpenAI CONTROL fails, W3 builds a stage request differently from the spec §2 table (for example, it sends `max_completion_tokens`). Adjust the CONTROL expectation to W3's real shape before implementing, and record that in the PR body.

- [ ] **Step 3: Implement**

**4.3a (Gemini).** In `GeminiTransport.generate`, first replace wave 2's `const includeThoughts = geminiModelThinks(this.model);` (`:226`) with the line below. Wave 2 reads that one local twice: in the `config` object's `thinkingConfig` spread (`:230`) and at the evidence gate (`:418`, `if (includeThoughts && thoughtsTokenCount !== undefined)`). Changing the local therefore changes the wire and the evidence gate together:
```ts
    /* #3084 W4 (P27, A3) — one flag for the wire and the evidence gate. A free-text (persona) request asks
       for no thought summaries, so its thoughtsTokenCount is not reasoning evidence either. Stage requests
       keep wave 2's id rule. */
    const includeThoughts = !req.freeText && geminiModelThinks(this.model);
```
Then replace the `config` object at `:227–232` (`const config: Record<string, unknown> = { … };`). It is a local declared before the SDK call, NOT an inline literal; the structured-output keys are added after it by `Object.assign(config, geminiStructuredConfig(req.structuredOutput));` (`:233`) and `abortSignal` by `config.abortSignal = combined;` (`:251`). Leave both of those untouched. In each spread, the non-free-text branch keeps the expression W1–W3 already wrote for that property:
```ts
    const config: Record<string, unknown> = {
      /* #3084 W4 — a free-text request omits what the pre-transport persona call never sent
         (it was a bare generateContent({ model, contents })). Stage requests are unchanged. */
      ...(req.freeText && req.system === '' ? {} : { systemInstruction: req.system }),
      ...(req.freeText && req.temperature === undefined ? {} : { temperature: req.temperature }),
      /* Wave 2's thought summaries (P19) go on stage requests only. A persona request keeps today's
         shape; wave 5 (Task 5.3) adds a thinkingConfig to it only for a non-default reasoning level. */
      ...(includeThoughts ? { thinkingConfig: { includeThoughts: true } } : {}),
      ...(req.freeText && req.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: req.maxOutputTokens ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS }),
    };
```
Then the ceiling (owner decision 4.3-B1(b)). Add `import { PERSONA_ABSOLUTE_MAX_MS } from '../runner/transport.js';` (the existing import at `:28` is `import type`, so this is a separate line). Replace the line `const requestCeilingMs = this.requestCeilingMs ?? configValue<number>('analyzer.gemini.requestCeilingMs');` (`:240`) with the two lines below; the next line, `const ceiling = AbortSignal.timeout(requestCeilingMs);` (`:241`), stays. The catch at `:480` already maps `ceiling.aborted` to `AnalyzerTimeoutError('ceiling')`, and the retry classifier does not retry it. Keep #3725's comment (`:76–83`):
```ts
    const baseCeilingMs = this.requestCeilingMs ?? configValue<number>('analyzer.gemini.requestCeilingMs');
    const requestCeilingMs = req.freeText
      ? Math.min(baseCeilingMs, req.freeText.absoluteMaxMs ?? PERSONA_ABSOLUTE_MAX_MS)
      : baseCeilingMs;
```
**4.3b (OpenAI).** In `buildOpenAIRequestBody` (`openai-transport.ts:280–305`, the function `send` calls at `:431–434`), rewrite the `messages`, `temperature` and `max_tokens` entries of its returned object. Keep the `maxTokens` computation above it exactly as it is (P24 Auto); the free-text branch only omits the key. Other keys (`model`, `stream`, `stream_options`, `...openAIResponseFormat(req.structuredOutput)`) stay as W3 left them:
```ts
  return {
    model,
    /* #3084 W4 — free text sends no empty system turn and leaves temperature / max_tokens to the server. */
    messages: [
      ...(req.freeText && req.system === '' ? [] : [{ role: 'system', content: req.system }]),
      ...req.messages,
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(req.freeText && req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.freeText && req.maxOutputTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...openAIResponseFormat(req.structuredOutput),
  };
```
Optional extra, cheap: a unit case in the existing `openai-request-body.test.ts` (its `req()` and `endpoint()` builders are at `:6–29`) asserting `buildOpenAIRequestBody(endpoint(), 'm', req({ system: '', temperature: undefined, freeText: {} }))` has no `max_tokens`, no `temperature` and no system turn.

Then the ceiling (owner decision 4.3-B1(b)). Add `PERSONA_ABSOLUTE_MAX_MS` as a value import from `../runner/transport.js` (the existing import at `:29` is a type import; add a separate line). Replace `const ceiling = AbortSignal.timeout(this.endpoint.requestCeilingMs);` (`:407`) with the two lines below. Leave the SDK `timeout` (`:355`) and `maxTotalMs` (`:375`) alone:
```ts
    const ceilingMs = req.freeText
      ? Math.min(this.endpoint.requestCeilingMs, req.freeText.absoluteMaxMs ?? PERSONA_ABSOLUTE_MAX_MS)
      : this.endpoint.requestCeilingMs;
    const ceiling = AbortSignal.timeout(ceilingMs);
```

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm --prefix server run test -- src/analyzer/transports`, then `npm --prefix server run test -- --config vitest.config.slow.ts src/analyzer/gemini.test.ts`, then `npm run typecheck`.
  - **Expected:** PASS.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Gemini temperature:** replace the `temperature` spread with `temperature: req.temperature,`. Expected red: `omits systemInstruction, JSON mode, temperature, maxOutputTokens and thinkingConfig` (`not to have property "temperature"`; JSON drops `undefined`, but `toHaveProperty` sees the key).
  2. **Gemini output cap:** replace the `maxOutputTokens` spread with the unconditional `maxOutputTokens: req.maxOutputTokens ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,`. Expected red: `omits systemInstruction, JSON mode, temperature, maxOutputTokens and thinkingConfig` (`not to have property "maxOutputTokens"`).
  3. **OpenAI output cap:** replace the `max_tokens` spread in `buildOpenAIRequestBody` with W3's original unconditional `max_tokens: maxTokens,`. Expected red: `sends one user message and no response_format, max_tokens or temperature`.
  4. **Gemini thought summaries:** delete `!req.freeText && ` from the `includeThoughts` local. Expected red: `omits systemInstruction, JSON mode, temperature, maxOutputTokens and thinkingConfig` (`not to have property "thinkingConfig"`) and `reports no reasoning tokens…` (`expected 321 to be undefined`).
  5. **One flag:** restore the local, then change it back to `geminiModelThinks(this.model)` and make the spread read `!req.freeText && geminiModelThinks(this.model)` (two flags, as before this task). Expected red: `reports no reasoning tokens…` only; the wire test stays green, which is why the flag is shared.
  6. **Gemini ceiling:** replace the `requestCeilingMs` ternary with `baseCeilingMs`. Expected red: `a free-text request stops at its absoluteMaxMs ceiling…` (the request waits on the 60 s ceiling and the test times out).
  7. **OpenAI ceiling:** use `this.endpoint.requestCeilingMs` unconditionally in `AbortSignal.timeout(…)`. Expected red: `a free-text request stops at its absoluteMaxMs ceiling…` (the answer arrives after 600 ms instead of a `ceiling` rejection). The decision log numbers this one "mutation 4" inside 4.3b.
- [ ] **Step 6: Commit** — two commits, one per child (Re-pin notes):
```bash
git add server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/gemini-transport.free-text.test.ts
git commit -m "feat(server): keep the persona wire shape and ceiling for free-text Gemini requests"
git add server/src/analyzer/transports/openai-transport.ts server/src/analyzer/transports/openai-transport.free-text.test.ts server/src/analyzer/transports/openai-request-body.test.ts
git commit -m "feat(server): keep the persona wire shape and ceiling for free-text OpenAI requests"
```
(`openai-request-body.test.ts` only if you added the optional case.)

---

### Task 4.4: `analyzer.personaGeneration.engine` becomes a model-id selection (consumes Task 3d.4b's `analyzer-engine` knob type)

> **Re-pin notes (2026-10-23, against b015aae9) — read first; these override the steps below where they differ.**
> - **Owner decision 4.4-B1: the persona knob gets a SAVE-TIME check mirroring 3d's `fallbackTargetSaveError`.** The plan's test pinned the opposite (200 with no saved endpoint); that is replaced.
>   - Add `personaEngineSaveError(value, { endpointIds })` beside `fallbackTargetSaveError` in `server/src/analyzer/fallback-target.ts:23` (or a new `analyzer/persona-engine.ts`). It returns `null` for `local` and `gemini`, and for an endpoint model id returns an error unless that endpoint id is saved. No Gemini-key check: a missing key stays a run-time error. Read 3d's wording first (`fallback-target.ts:24–31`: `analyzer.fallback.target: no analyzer endpoint "gone" is saved. Add it in Model Manager → Analyzer endpoints, or pick another target.`) and parallel it.
>   - `routes/config.ts` PUT: after the fallback block (`#3084 P30`, `:150–163`; the block's body is `readUserSettings()` first because a cold cache after a restart would report a saved endpoint as missing), add the block in Step 3.
>   - Tests: the store case seeds endpoint `lab` first; a new refusal case sends `openai:ghost::m` and expects 400 with the endpoint named; unit tests go beside 3d's in `fallback-target.test.ts:33`. 3d's seeding pattern is in `routes/config.fallback-target.test.ts`: `analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 })` saved with `mutateUserSettings(() => ({ analyzerEndpoints: [lab] }))`. `config.test.ts` wipes settings in `beforeEach`, so seed inside the test (Step 1 shows it).
>   - New mutations 5–7 (Step 5). Wiki row and registry help gain "Saving an endpoint model whose endpoint is not configured is refused." (Step 3).
> - **The 3d pieces this task consumes are already landed; nothing to add.** `server/src/config/types.ts:2` (comment `:6–8`); the options/pattern doc comments `:30–38` (they already say "case-sensitive unless the RegExp carries `i`"); `src/lib/types.ts:929–932`; `registry.test.ts` imports `:1–4` and the allowed-types array `:214–223` (already `['string', 'device', 'analyzer-engine']`); 3d's describe `:251–283`.
> - **`registry.test.ts` imports differ from the plan's list.** Current lines: `import { describe, it, expect } from 'vitest';`, `import { GROUPS, KNOBS, allKnobs, getKnob, knobByEnv, knobsInGroup } from './registry.js';`, `import { coerceAndValidate } from './resolver.js';`, `import { parseEndpointModelId } from '../analyzer/model-id.js';`. The persona describe also needs `afterEach`, `configValue`, `readFileSync` and `fileURLToPath`: Step 1 shows the exact import edits. `parseEndpointModelId` is already imported.
> - **The fixture is present and supports every assertion.** `server/src/analyzer/__fixtures__/model-id-cases.json` holds the six `arrayContaining` negatives, `openai:lab::` (empty model), the 41-character endpoint id, `openai:a::b::c` and `openai:lab::qwen3:30b`. The parser is `/^openai:([a-z0-9-]+)::([\s\S]*)$/` (`model-id.ts:22`), so mutation 4 (`[a-z0-9_-]`) turns `openai:lab_1::qwen3` red as stated.
> - **Anchors at `b015aae9`.** The descriptor to replace is `registry.ts:1164–1175` (`type: 'enum'`, `options: ['local', 'gemini']`, `default: 'gemini'`, `apply: 'live'`, `risk: 'medium'`); 3d's fallback descriptor, with its pattern comment, is `:1138–1153`. The `.env.example` help comment is `server/.env.example:579` (the plan said main line 558) above `# PERSONA_GEN_ENGINE=gemini` at `:580`. The wiki row is `docs/wiki/Advanced-Settings.md:140` (the plan said `:138`, which is now the `Analyzer fallback` row): change its type column to read like `:138`'s, "local / gemini / endpoint model". `src/lib/api.ts`: `MOCK_CONFIG_DESCRIPTORS = allKnobDescriptors()` is `:9138` and `mockGetConfig` is `:9348`; `allKnobDescriptors` is `server/src/config/descriptors.ts:11–31` and drops `pattern`. No mock edit is needed.
> - **The PUT path** (confirmed): `endpointModelIdRefusals` refuses only `analyzer.ollama.model` (`user-settings.ts:1550–1567`); `coerceAndValidate`'s default case trims and pattern-matches with the error `does not match the required shape (…)` (`resolver.ts:206–221`); the route prefixes `${key}: ` (`routes/config.ts:138–141`). `config.test.ts` has `app`, `request` and per-test settings reset (`:12–57`). `config:sync` and `config:check` are root `package.json:108–109`.
> - **Sequencing: do not ship 4.4 alone.** `override-row.tsx:451` renders a select for every `descriptor.type === 'analyzer-engine'`, but the `analyzerEngine` value state (labels, source note, local-not-installed warning) exists only for the fallback knob (`config/types.ts:74`, `routes/config.ts:47–51`), so after this task the persona row offers endpoint models with raw labels. At run time `resolvePersonaEngine()` (`voice-style.ts:65–67`) reads an endpoint id as `gemini` until Task 4.5 (its other callers: `cast-design.ts:294`, `:511`; `persona-gpu-plan.ts:57`). Fine inside the one PR.
> - **Step boundary.** One child, small; it depends on nothing in 4.1–4.3 and goes second so 4.5 can read the knob.

**F4 (owner, 2026-09-13): the `'analyzer-engine'` knob type (P10) is no longer created here — it is landed, not merely planned, by `docs/superpowers/plans/2026-09-11-openai-compatible-analyzer-w3cd.md`'s Task 3d.4b.** That task introduces the type for `analyzer.fallback.target` (env `ANALYZER_FALLBACK_TARGET`, group `analyzer-models`, label `Analyzer fallback`, `options: ['off', 'local', 'gemini']`, `pattern: /^(off|local|gemini|openai:[a-z0-9-]{1,40}::.+)$/`, `default: 'gemini'`). This task now only adds the persona knob's own descriptor, reusing that type. Each knob keeps its own literal id regex; **only the fallback knob's regex admits `off`** — the persona knob's does not, since persona generation never falls back (spec §10, this wave's PR-level "No fallback" rule, kept unchanged).

**Consumes, verbatim, from Task 3d.4b (`w3cd.md:9216-9274`) — none of the following is rebuilt here:**
- `server/src/config/types.ts:2-5` — `KnobType` gains `'analyzer-engine'`;
- `server/src/config/types.ts:27-35` — the `options`/`pattern` doc comments, including 3d.4b's own fix of the false "validated case-insensitively" claim (this plan's earlier draft had proposed the identical fix independently; 3d.4b's version is the one that lands, so it is not repeated here);
- `src/lib/types.ts:892-894` — the frontend `KnobDescriptor.type` union;
- `server/src/config/registry.test.ts:1-3` (imports) and `:189-198` (the allowed-pattern-types array `['string', 'device']` → `['string', 'device', 'analyzer-engine']`, and its test title/message) — 3d.4b's own describe (`analyzer.fallback.target`, `w3cd.md:9334-9367`) is the one that exercises the type generically; this task's Step 1 adds only the persona-knob-specific describe beside it.
Before starting this task, confirm 3d.4b has merged: `git grep -n "'analyzer-engine'" server/src/config/types.ts src/lib/types.ts` finds it in both files, and `git grep -n "getKnob('analyzer.fallback.target')" server/src/config/registry.test.ts` finds 3d.4b's describe already in place. If either is missing, stop and report it as a dependency gap rather than re-adding either piece here.

**Files:**
- Modify: `server/src/config/registry.ts` (the persona engine descriptor — same key, same shape as `main`'s enum descriptor, changed to `type: 'analyzer-engine'`, `options`, `pattern`).
- Modify: `server/src/config/registry.test.ts` — append a describe for the persona knob (no change to the allowed-types array; that is Task 3d.4b's).
- Modify: `server/src/routes/config.test.ts` — append a describe.
- Modify: `server/src/analyzer/fallback-target.ts` — add `personaEngineSaveError` (owner decision 4.4-B1). Test: `server/src/analyzer/fallback-target.test.ts`.
- Modify: `server/src/routes/config.ts` — the PUT save check for the persona engine, after the `analyzer.fallback.target` block.
- Regenerate: `server/.env.example`, via `npm run config:sync`. Only the help comment above `# PERSONA_GEN_ENGINE=gemini` (`:579–580`) changes.
- **Update `docs/wiki/Advanced-Settings.md`'s existing "Analyzer models & endpoints" row for the persona engine knob in this same PR**, to reflect its new options/pattern text. **Corrected (review pass 1, 2026-09-13):** this task does not change the label `'Persona generation engine'`, and that row already exists at `Advanced-Settings.md:140`, keyed by that unchanged label — so `scripts/tests/knob-docs-sync.test.mjs` (#2012, `test:hooks`), which only checks that every registry knob's *label* has a matching row, does **not** fire here; there is no new-row guard to satisfy. Updating the row's content is still owed on its own terms (a derived-doc-staleness chore, CLAUDE.md's Incidental findings), because the row's options/help text now describes a knob type this PR changes — it just is not the guard's own job to catch that.
- **No frontend mock config catalogue edit needed — confirmed, not assumed (review pass 2, item 5 conflict).** `src/lib/api.ts`'s `mockGetConfig()` (`:9348` at `b015aae9`) returns `{ groups: MOCK_CONFIG_GROUPS, descriptors: MOCK_CONFIG_DESCRIPTORS, values: MOCK_CONFIG_VALUES, … }`, and `MOCK_CONFIG_DESCRIPTORS = allKnobDescriptors()` (`src/lib/api.ts:9138` at `b015aae9`, imported from **`server/src/config/descriptors.ts`** — a frontend file importing a server file directly). `allKnobDescriptors()` is `allKnobs().map(toKnobDescriptor)` (`server/src/config/descriptors.ts:29-31`), and that file's own header comment says why: "so the frontend mock catalogue (`src/lib/api.ts`) can build itself from the same projection instead of hand-copying it (#2259)". There is no separate, hand-maintained persona-knob mock entry to add or update — this task's `registry.ts` change alone is what `mockGetConfig()` reflects, automatically, the moment it next runs. **This item's own coordinator-supplied instruction ("4.4 ADDS the persona knob's entry to that mock catalogue") conflicts with this — reported per the task's own instruction to report rather than improvise when a rule conflicts with the pinned commit.** Task 4.7's regression test (below) calls `mockGetConfig()` directly rather than assuming a separate entry exists, so it still catches a missing registry change correctly.

**Dependency:** this wave's `feat/server-3084-w4-persona` branch cuts off `main` only after PR 3d has merged (Entry criterion 1, unchanged), because `analyzer-engine` must already exist in `KnobType`.

**`findEndpointReferences` needs no new wave 4 step — corrected reason (review pass 1, 2026-09-13).** `findEndpointReferences` walks the explicit array `MODEL_ID_CONFIG_KNOBS` (`server/src/workspace/analyzer-endpoints.ts`, Task 3b.5), and `analyzer.personaGeneration.engine` is already on that array (`w3ab.md:4730`'s list; kept unchanged through 3d.4b, `w3cd.md:10382`: `['analyzer.phase0.model', 'analyzer.phase1.model', 'analyzer.personaGeneration.engine', 'analyzer.fallback.target']`). So the persona knob was already covered by `findEndpointReferences` **before** this task, regardless of its `KnobType` — this task's relabel to `type: 'analyzer-engine'` changes nothing about that coverage. The `type === 'analyzer-engine'` clause the earlier draft cited (`w3cd.md:9281`) belongs to a **different** mechanism: the classification **guard test** in `analyzer-endpoints.test.ts`, which checks every registry knob is *either* on `MODEL_ID_CONFIG_KNOBS` *or* on an exclusion list, catching a knob nobody remembered to list. Since the persona knob is already on `MODEL_ID_CONFIG_KNOBS`, that guard test needs nothing from this task either. This wave adds no step and no test for either mechanism.

**Interfaces:**
- **Consumes:** the `'analyzer-engine'` `KnobType` member and its `OverrideRow`/`AdvancedView` UI wiring (Task 3d.4b/3d.4c, per F4); `MODEL_ID_CONFIG_KNOBS`'s existing `analyzer.personaGeneration.engine` entry (Task 3b.5, unchanged by this task — see the corrected note above); `parseEndpointModelId` (W3, `server/src/analyzer/model-id.ts`) and the shared case table `server/src/analyzer/__fixtures__/model-id-cases.json` (W3). Test-only: `registry.ts` must stay pure data (`registry-imports.guard.test.ts`), so the grammar is a literal regex pinned against `parseEndpointModelId`.
- **Produces:**
  - The persona engine knob: `type: 'analyzer-engine'`, `options: ['local', 'gemini']`, `pattern: /^(local|gemini|openai:[a-z0-9-]{1,40}::.+)$/` (no `off` — F4's per-knob rule), `default: 'gemini'`.
- **Keeps green:**
  - `src/config/registry.test.ts`, including `every knob's own default satisfies its own pattern/options/min/max`;
  - `src/config/resolver.test.ts`;
  - `src/config/registry-imports.guard.test.ts`;
  - `src/routes/config.test.ts`, including `descriptor fields are exactly the client-safe set`;
  - `src/lib/api.config.test.ts` (frontend mock catalogue).

- [ ] **Step 1: Write the failing tests**

In `server/src/config/registry.test.ts`, edit the imports (`:1–4`). Change the vitest import to `import { describe, it, expect, afterEach } from 'vitest';` and the resolver import to `import { coerceAndValidate, configValue } from './resolver.js';`, and add the two node imports. `parseEndpointModelId` is already imported:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
```
Append (no change to the allowed-types array — 3d already added `'analyzer-engine'` to it):
```ts
/* #3084 W4 (spec §10) — persona generation's engine is a model-id-style selection. */
describe('analyzer.personaGeneration.engine', () => {
  const knob = () => getKnob('analyzer.personaGeneration.engine')!;
  const CASES = JSON.parse(
    readFileSync(fileURLToPath(new URL('../analyzer/__fixtures__/model-id-cases.json', import.meta.url)), 'utf8'),
  ) as Array<{ id: string; engine: string; endpointId?: string; model?: string }>;
  afterEach(() => {
    delete process.env.PERSONA_GEN_ENGINE;
  });

  it('is an analyzer-engine knob offering local and gemini, default gemini, env PERSONA_GEN_ENGINE', () => {
    expect(knob().type).toBe('analyzer-engine');
    expect(knob().options).toEqual(['local', 'gemini']);
    expect(knob().default).toBe('gemini');
    expect(knob().env).toBe('PERSONA_GEN_ENGINE');
    expect(knob().apply).toBe('live');
  });

  it.each(['local', 'gemini', ' local ', 'openai:lab::qwen3-30b', 'openai:my-box-2::meta-llama/llama-3.1-8b:free'])(
    'accepts %j',
    (v) => {
      expect(coerceAndValidate(knob(), v)).toEqual({ ok: true, value: v.trim() });
    },
  );

  it.each([
    '',
    'Local',
    'GEMINI',
    'openai',
    'openai:lab:qwen3',
    'openai:lab::',
    'openai:Lab::qwen3',
    'openai:latest',
    'qwen3.5:9b',
    'gemini-3.1-flash-lite',
    `openai:${'a'.repeat(41)}::m`,
  ])('rejects %j', (v) => {
    expect(coerceAndValidate(knob(), v).ok).toBe(false);
  });

  it('accepts no id that parseEndpointModelId rejects, including the table\'s endpoint-shaped negatives', () => {
    const endpointShaped = CASES.filter((c) => c.id.startsWith('openai'));
    const negatives = endpointShaped.filter((c) => c.engine !== 'openai');
    expect(negatives.map((c) => c.id)).toEqual(
      expect.arrayContaining(['openai:latest', 'openai:Lab::qwen3', 'openai:lab_1::qwen3', 'openai:::qwen3', 'openai:lab:qwen3', 'openai']),
    );
    for (const c of negatives) {
      expect(parseEndpointModelId(c.id), c.id).toBeNull();
      expect(coerceAndValidate(knob(), c.id).ok, c.id).toBe(false);
    }
    /* The knob is deliberately STRICTER than the parser (non-empty model, endpoint id ≤ 40), never looser. */
    for (const c of endpointShaped) {
      if (coerceAndValidate(knob(), c.id).ok) expect(parseEndpointModelId(c.id), c.id).not.toBeNull();
    }
    for (const c of endpointShaped.filter((e) => e.engine === 'openai' && e.model !== '' && (e.endpointId ?? '').length <= 40)) {
      expect(coerceAndValidate(knob(), c.id).ok, c.id).toBe(true);
    }
  });

  it('PERSONA_GEN_ENGINE=local and =gemini still resolve (existing .env files keep working)', () => {
    for (const v of ['local', 'gemini']) {
      process.env.PERSONA_GEN_ENGINE = v;
      expect(configValue<string>('analyzer.personaGeneration.engine')).toBe(v);
    }
  });
});
```
Append to `server/src/routes/config.test.ts`:
```ts
/* #3084 W4 — the persona engine knob accepts a saved endpoint's model id, and refuses a malformed id or an
   unsaved endpoint at save (owner decision 4.4-B1; mirrors analyzer.fallback.target's save check). */
describe('PUT /api/config — analyzer.personaGeneration.engine', () => {
  it('stores an openai:<endpointId>::<model> value whose endpoint is saved', async () => {
    /* beforeEach wipes settings, so seed the endpoint here. The route reads it from disk. */
    const { mutateUserSettings } = await import('../workspace/user-settings.js');
    const { analyzerEndpointSchema } = await import('../workspace/analyzer-endpoints.js');
    const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 });
    await mutateUserSettings(() => ({ analyzerEndpoints: [lab] }));
    const res = await request(app)
      .put('/api/config')
      .send({ 'analyzer.personaGeneration.engine': 'openai:lab::qwen3' });
    expect(res.status).toBe(200);
    expect(res.body.values['analyzer.personaGeneration.engine'].effective).toBe('openai:lab::qwen3');
  });

  it('refuses an endpoint model whose endpoint is not saved, naming the endpoint', async () => {
    const res = await request(app)
      .put('/api/config')
      .send({ 'analyzer.personaGeneration.engine': 'openai:ghost::m' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^analyzer\.personaGeneration\.engine: no analyzer endpoint "ghost" is saved/);
  });

  it('refuses a malformed id with the shape error', async () => {
    const res = await request(app)
      .put('/api/config')
      .send({ 'analyzer.personaGeneration.engine': 'openai:lab:qwen3' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^analyzer\.personaGeneration\.engine: does not match the required shape/);
  });
});
```
Append to `server/src/analyzer/fallback-target.test.ts` (extend its line-2 import with `personaEngineSaveError`):
```ts
describe('personaEngineSaveError (#3084 W4, owner decision 4.4-B1)', () => {
  it('always saves local and gemini: a missing Gemini key stays a run-time error for personas', () => {
    expect(personaEngineSaveError('local', { endpointIds: [] })).toBeNull();
    expect(personaEngineSaveError('gemini', { endpointIds: [] })).toBeNull();
  });

  it('refuses an endpoint model whose endpoint is not saved, naming it', () => {
    expect(personaEngineSaveError('openai:gone::m', { endpointIds: ['lab'] })).toMatch(
      /^analyzer\.personaGeneration\.engine: no analyzer endpoint "gone" is saved/,
    );
  });

  it('saves an endpoint model whose endpoint is saved', () => {
    expect(personaEngineSaveError('openai:lab::m', { endpointIds: ['lab'] })).toBeNull();
  });
});
```
- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm --prefix server run test -- src/config/registry.test.ts src/routes/config.test.ts src/analyzer/fallback-target.test.ts`
  - **Expected:** FAIL.
    - `is an analyzer-engine knob…` fails with `expected 'enum' to be 'analyzer-engine'`.
    - `accepts "openai:lab::qwen3-30b"` fails (`ok: false, error: 'not an allowed option'`).
    - `stores an openai:<endpointId>::<model> value whose endpoint is saved` fails with `expected 400 to be 200`.
    - `refuses an endpoint model whose endpoint is not saved…` fails with `expected 400 to be …`/a shape error (the id is refused as an unknown option today, with a different message), and `personaEngineSaveError` does not exist yet (the unit file fails at import).
    - `accepts no id that parseEndpointModelId rejects…` fails in its last loop (`openai:lab::qwen3:30b`: `expected false to be true`), because main's enum refuses every endpoint id.
- [ ] **Step 3: Implement**

The `KnobType` union, its `options`/`pattern` doc comments, and the frontend `KnobDescriptor.type` union already carry `'analyzer-engine'` from Task 3d.4b — no change to `server/src/config/types.ts` or `src/lib/types.ts` in this task (F4, consumes 3d.4b).

Replace the descriptor in `server/src/config/registry.ts` (`:1164–1175`, the enum descriptor for `analyzer.personaGeneration.engine`):
```ts
  {
    key: 'analyzer.personaGeneration.engine',
    env: 'PERSONA_GEN_ENGINE',
    group: 'analyzer-models',
    label: 'Persona generation engine',
    help: '"gemini" (default) designs each cast member\'s voice persona via the Gemini API (Voice-style model) — the locked quality choice. "local" routes it through the local Ollama daemon (Persona local model) so a no-Gemini install can still design voices. An OpenAI-compatible endpoint model (openai:<endpoint>::<model>, picked from the list) routes it to that endpoint, with its rate limits, concurrency and GPU card. No silent cross-provider fallback: gemini with no key, local with the daemon down, or an endpoint that is missing or unreachable, fails with a clear message. Saving an endpoint model whose endpoint is not configured is refused.',
    type: 'analyzer-engine',
    options: ['local', 'gemini'],
    /* local | gemini | an endpoint model id — the grammar of analyzer/model-id.ts, repeated as a literal
       because registry.ts must stay pure data (registry-imports.guard.test.ts); registry.test.ts pins it
       against parseEndpointModelId over the shared id case table. Case-sensitive, like the old enum. */
    pattern: /^(local|gemini|openai:[a-z0-9-]{1,40}::.+)$/,
    default: 'gemini',
    apply: 'live',
    risk: 'medium',
  },
```
Add the save check (owner decision 4.4-B1). In `server/src/analyzer/fallback-target.ts`, beside `fallbackTargetSaveError` (it already imports `parseEndpointModelId`):
```ts
/** A save-time refusal for the persona engine, or null (#3084 W4; mirrors fallbackTargetSaveError).
    `local` and `gemini` always save: a missing Gemini key stays a run-time error for personas. */
export function personaEngineSaveError(value: string, saved: { endpointIds: readonly string[] }): string | null {
  const parsed = parseEndpointModelId(value);
  if (parsed && !saved.endpointIds.includes(parsed.endpointId)) {
    return `analyzer.personaGeneration.engine: no analyzer endpoint "${parsed.endpointId}" is saved. Add it in Model Manager → Analyzer endpoints, or pick another engine.`;
  }
  return null;
}
```
In `server/src/routes/config.ts`, import `personaEngineSaveError` and `parseEndpointModelId` (the file already imports `fallbackTargetSaveError` from `'../analyzer/fallback-target.js'` at `:34`), then add this after the `analyzer.fallback.target` block (`:150–163`):
```ts
  const personaEngine = coerced['analyzer.personaGeneration.engine'];
  if (typeof personaEngine === 'string' && parseEndpointModelId(personaEngine)) {
    const saved = await readUserSettings();
    const error = personaEngineSaveError(personaEngine, { endpointIds: saved.analyzerEndpoints.map((e) => e.id) });
    if (error) {
      res.status(400).json({ error });
      return;
    }
  }
```
Then run `npm run config:sync` (the new help sentence changes the `.env.example` comment at `:579`), and update the persona engine knob's existing row (`Advanced-Settings.md:140`, keyed by its unchanged label) in `docs/wiki/Advanced-Settings.md`'s "Analyzer models & endpoints" section: the type column becomes "local / gemini / endpoint model" (as `:138`'s), and the text gains "Saving an endpoint model whose endpoint is not configured is refused." This is not a new row, and not something `knob-docs-sync` (`test:hooks`) checks, since that guard only verifies a label has a row at all.

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm --prefix server run test -- src/config src/routes/config.test.ts src/routes/config.fallback-target.test.ts src/analyzer/fallback-target.test.ts`, then `npm test -- src/lib/api.config.test.ts`, then `npm run config:check` and `npm run typecheck`.
  - **Expected:** PASS. `config:check` reports the block is in sync.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Endpoint id length:** change `{1,40}` to `+`. Expected red: `rejects "openai:aaaa…::m"`.
  2. **Separator:** change `::` to `::?`. Expected red: `rejects "openai:lab:qwen3"`, and `refuses a malformed id with the shape error` (`expected 200 to be 400`).
  3. **Knob type:** change `type: 'analyzer-engine'` back to `type: 'string'`. Expected red: `is an analyzer-engine knob…`.
  4. **Parser agreement:** in the pattern, change the endpoint-id class `[a-z0-9-]` to `[a-z0-9_-]`. Expected red: `accepts no id that parseEndpointModelId rejects…` (`openai:lab_1::qwen3`: `expected true to be false`). The `rejects %j` list alone stays green under this mutation.
  5. **Route check:** delete the persona block in `routes/config.ts`. Expected red: `refuses an endpoint model whose endpoint is not saved, naming the endpoint` (`expected 200 to be 400`).
  6. **Unit check:** make `personaEngineSaveError` always `return null`. Expected red: its `refuses an endpoint model whose endpoint is not saved, naming it` case and the route refusal case.
  7. **Seed:** delete the `mutateUserSettings` seed in `stores an openai:<endpointId>::<model> value whose endpoint is saved`. Expected red: that case (`expected 400 to be 200`), which shows the check reads the saved endpoint list.
- [ ] **Step 6: Commit**
```bash
git add server/src/config/registry.ts server/src/config/registry.test.ts server/src/routes/config.test.ts server/src/routes/config.ts server/src/analyzer/fallback-target.ts server/src/analyzer/fallback-target.test.ts server/.env.example docs/wiki/Advanced-Settings.md
git commit -m "feat(server): let the persona engine knob name an OpenAI-compatible endpoint model"
```

---

### Task 4.5: `generateVoiceStylePersona` dispatches every engine through `runFreeText`

> **Re-pin notes (2026-10-23, against b015aae9) — read first; these override the steps below where they differ.**
> - **This is its own child and commit (audit label C1), with a temporary shim.** Keep `export function resolvePersonaEngine(): 'local' | 'gemini' { return resolvePersonaSelection().engine === 'local' ? 'local' : 'gemini'; }` in `voice-style.ts` so typecheck stays green after this task. Task 4.6a deletes it and every reader. This supersedes the plan's "`resolvePersonaEngine` is removed", its Step 4 expectation that typecheck fails, and its Step 6 "held until Task 4.6".
> - **#3725 is merged: what this task does about it** (find code by symbol, not by line).
>   1. `voice-style.ts:38` imports `{ generatePersonaViaOllama, PERSONA_ABSOLUTE_MAX_MS }` from `./ollama.js`, and the Gemini call passes `config: { httpOptions: { timeout: PERSONA_ABSOLUTE_MAX_MS } }` (`:233`). The new `voice-style.ts` imports only `PERSONA_ABSOLUTE_MAX_MS` from `./ollama.js` (the re-export Task 4.2 keeps) and passes `absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS` to `runFreeText` for EVERY engine. Never re-add a Gemini client in `voice-style.ts`.
>   2. The bound must come from the transports (Tasks 4.1–4.3, owner decision 4.3-B1(b)). If `GeminiTransport` does not apply `min(request ceiling, absoluteMaxMs)`, stop and report a 4.3a gap.
>   3. **Amend `server/src/analyzer/voice-style.timeout.test.ts`** (owner decision 2026-10-23; Step 1 shows the edit): assert `AnalyzerTimeoutError` with `reason: 'ceiling'` instead of `name: 'AbortError'`; count only POST generate requests, which must be exactly 1; seed the Gemini catalog with `_seedGeminiCatalogForTest` so `prepare()` makes no listing request; keep the elapsed-time window. The free-text ceiling must be terminal: one request, no retry by the shared retry helper (`GEMINI_RETRY_CLASSIFIER` returns `'no-retry'` for an `AnalyzerTimeoutError`). The test's `vi.mock('./ollama.js', …)` of `PERSONA_ABSOLUTE_MAX_MS: 400` still reaches `absoluteMaxMs`, because `voice-style.ts` reads the constant from `./ollama.js`.
>   4. That test's `vi.mock('../workspace/user-settings.js', …)` is a plain factory (`getResolvedGeminiApiKey`, `readConfigOverrides`, `getCachedUserSettings`). Add anything new that `voice-style.ts` or the transports import from user-settings.
> - **`voice-style.ts` anchors at `b015aae9`.** Header `:1–26` (unchanged). Imports are `:28–39`: `GoogleGenAI`; `buildHintFromCast`; `getResolvedGeminiApiKey`; `loadKnownAnalyzerSecrets` (`./known-secrets-gate.js`); `redactGeminiError` (`./transports/gemini-transport.js`); `getResolvedOllamaModel`; `geminiRateLimiter`; `stripCodeFences`; `readPrompt`; `configValue`; `{ generatePersonaViaOllama, PERSONA_ABSOLUTE_MAX_MS }`; `inferEngineFromModelId`. `resolvePersonaEngine` is `:64–67`; `resolvePersonaLocalModel` is `:73–78`. The dispatcher doc comment starts at `:171` and everything to the end of the file (`:241`) is replaced: it covers `generateVoiceStylePersona`, `generateViaOllama` and `generateViaGemini`. Replace `:28–39`, `:64–67` and `:171–241`.
> - **Keep `inferEngineFromModelId`.** `resolvePersonaLocalModel` now reads `explicit.length > 0 && inferEngineFromModelId(explicit) !== 'openai' ? explicit : getResolvedOllamaModel();`. The new import is `import { inferEngineFromModelId, parseEndpointModelId } from './model-id.js';` (the plan's snippet has only `parseEndpointModelId`). Leave `resolvePersonaLocalModel` exactly as it is.
> - **Gemini persona redaction (P22) moved.** `voice-style.ts:225–238` wraps the call in try/catch and does `throw redactGeminiError(err, await loadKnownAnalyzerSecrets())`. The plan's replacement drops it, which is right only because `GeminiTransport` redacts the same way (`redactGeminiError`, `gemini-transport.ts:59`). Drop both imports, and keep the coverage (next bullet).
> - **ollama.ts deletions.** Delete the doc comment (`:70`) and body (`:78–173`) of `generatePersonaViaOllama`, plus every import only it used, or ESLint `--max-warnings 0` fails: `fetch as undiciFetch` from `undici` (keep `Agent`, `:4`); `acquireAnalyzerSlot` (keep `describeAnalyzerConcurrency`, `:5`); `isAnyAnalyzerRunBusy` (`:6`); `getResolvedOllamaUrl` (`:7`); `ANALYZER_DISPATCHER` and `classifyConnectError` from the `:8` import (keep `OllamaTransport`) and the `PERSONA_ABSOLUTE_MAX_MS` entry Task 4.2 added there; `redactKnownSecrets` (`:9`); `loadKnownAnalyzerSecrets` (`:11`); `resolveOllamaTemperature` from the `:12` import (keep `resolveNumPredict`). KEEP the `export { … } from` re-statements at `:19–27`, including the `:20` one that carries `PERSONA_ABSOLUTE_MAX_MS`. Re-check this list against what Task 4.2 leaves.
> - **`voice-style.test.ts` anchors.** Imports and mocks are `:15–44` (line 17 imports `registerKnownSecretsProvider`; keep it). The `@google/genai` mock (`:28–33`) spreads `importOriginal`, and the new one MUST keep that spread: `gemini-transport.ts:11` imports `ApiError` and uses it at runtime (`redactGeminiError`, `:63`), so the plan's bare factory would leave that export missing. The user-settings mock (`:36–40`) is a plain factory; the plan's `importOriginal` version replaces it. `delegateConfigValue` is `:59–63` (the hoisted `configValue` mock block `:46–69` stays); `beforeEach` is `:122–132` (the edits land on `:123`, `:124` and `:127–129`); `describe('persona generation config')` starts at `:244` and the file ends at `:388`. Replace `:15–44` and `:244–388`, except that the P22 describe at `:365–388` is KEPT (next bullet).
> - **Keep the P22 describe, retargeted.** `describe('generateVoiceStylePersona gemini branch redaction (#3084 P22)')` has two cases: an echoed secret reaches the caller as `[redacted]` and not in `stack`, and a no-secret error is rethrown as the same object. The plan's replace-to-end would delete it. Append it after the new describes with `generateContent.mockRejectedValue(…)` → `generateContentStream.mockRejectedValue(…)` and `vi.spyOn(geminiRateLimiter, 'acquire')` → `analyzerRateLimiter` (Step 1 shows it). If the second case fails because the runner or retry helper wraps the error, report it; do not weaken the assertion.
> - **`servedModels` is written when the request is sent, not after a 2xx.** `OpenAITransport.attempt` calls `noteEndpointModelUsed(this.endpoint.id, this.model)` (`openai-transport.ts:429`) after the semaphore admits the call and before `create()`; register row A116 says the same. The endpoint test still passes; the comment and the closing prose of Step 1 are corrected below.
> - **`transport-redaction.test.ts`** (the replace text in the plan is not verbatim). Line 13 is `import { OllamaAnalyzer, generatePersonaViaOllama } from './ollama.js';`: make it `import { OllamaAnalyzer } from './ollama.js';`. Lines 129–140 hold a 4-line comment ("generatePersonaViaOllama reads its URL via getResolvedOllamaUrl (A3 …"), `_setUserSettingsCacheForTest({ geminiApiKey: SECRET, configOverrides: { 'analyzer.ollama.url': url } });`, the `OLLAMA_URL` comment, `vi.stubEnv('OLLAMA_URL', undefined);`, the `generatePersonaViaOllama(…)` call and the `expect(…).toBe(…)`. Replace lines 129–140 with the block in Step 3 (the URL now goes straight into `OllamaAnalyzer`, so the override and `stubEnv` lines go). Lines 141–143 (the `surfaces(err)` / `lines` loop) stay. `AnalyzerHttpError` is already imported (`:15`); drop any import the edit leaves unused.
> - **Defining modules.** `stripCodeFences` is `runner/parse.ts:159`, re-exported from `gemini.ts:20`; `resolveOllamaTemperature` is `ollama-settings.ts:23`, re-exported from `ollama.ts:22`. The plan's imports work as written.
> - **The step 3 grep adds a hit.** `git grep -n -E "generatePersonaViaOllama|resolvePersonaEngine\b" -- server/src` also finds `server/src/routes/book-op.design-jobs.test.ts:41-44` (a factory mock with `resolvePersonaEngine: vi.fn().mockReturnValue('gemini')`); Task 4.6a fixes it. `itemFailureReason` is `workspace/file-lock.ts:194–196`.
> - **Optional, for the PR body.** `getCachedUserSettings()` returns `DEFAULT_USER_SETTINGS` (no endpoints) while the cache is cold, so a design started before the detached boot warm-up (`index.ts:121–140`) would report a saved persona endpoint as missing. #3710 made its book routes `await readUserSettings()` first. Parity would need an async read in `personaRunner` and `personaSharesGpu`, which changes the sync signature the plan specifies; mention it, do not change it. Also optional: stamp `endpointId` on a persona `AnalyzerReasoningOverflowError` (Task 4.1's cross-task note).
> - **Step boundary.** Large. Depends on Tasks 4.1–4.4 (4.4 because `voice-style.endpoint.test.ts` goes through the real `configValue`, so the knob must accept `openai:…`).

**Files:**
- Modify: `server/src/analyzer/voice-style.ts`:
  - `:1-26` — header comment; `:28-39` — imports;
  - `:64-67` — replace `resolvePersonaEngine` (a shim stays, see the notes);
  - `:171-241` — the dispatcher doc comment through `generateViaGemini`, the end of the file.
- Modify: `server/src/analyzer/ollama.ts` — delete `generatePersonaViaOllama` (doc comment `:70`, body `:78-173`), the `PERSONA_ABSOLUTE_MAX_MS` entry Task 4.2 added to the `:8` import, and the imports only it used (see the notes). Keep the `:20` re-export.
- Test: Modify `server/src/analyzer/voice-style.timeout.test.ts` (#3725's test) as the notes and Step 1 say.
- Test: Modify `server/src/analyzer/voice-style.test.ts`:
  - `:15-44` — imports and mocks;
  - `:122-132` — `beforeEach`;
  - `:244-388` — the config, Gemini and dispatch describes, keeping the P22 describe (`:365-388`) retargeted.
- Test: Create `server/src/analyzer/voice-style.endpoint.test.ts`, a real-HTTP wiring proof.
- Test: Modify W3b Task 3b.6a's `server/src/analyzer/transport-redaction.test.ts` — its `Ollama persona call redaction` case calls `generatePersonaViaOllama`, which this task deletes; retarget it to the moved call (Step 3).

**Interfaces:**
- **Consumes:**
  - From W1–W3: `OllamaAnalyzer`, `GeminiAnalyzer`, `OpenAIAnalyzer`, `TransportAnalyzer.runner`, `parseEndpointModelId`, `AnalyzerEndpoint`, `resolveEndpointApiKey` (W3b Task 3b.5), `endpointsSharingDevice` (W3d Task 3d.2, `server/src/gpu/endpoint-eviction.ts`), `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError`, `AnalyzerUnreachableError`, `AnalysisAbortedError`, `LocalUnreachableError`, `isEndpointBusy` (W3d Task 3d.1), `servedModels` and `_resetEndpointRuntimeForTest` (W3b Task 3b.10), `analyzerRateLimiter`, `endpointModelId`.
  - User settings `analyzerEndpoints` and `analyzerEndpointKeys` (W3).
  - Task 4.1 `runFreeText`.
  - Task 4.4 knob.
- **Produces:** from `server/src/analyzer/voice-style.ts`:
  ```ts
  export type PersonaSelection =
    | { engine: 'local'; model: string }
    | { engine: 'gemini'; model: string }
    | { engine: 'openai'; endpointId: string; model: string };
  export function resolvePersonaSelection(): PersonaSelection;
  export function personaSharesGpu(): boolean;
  export async function generateVoiceStylePersona(character: CastCharacter, opts?: { onCpu?: boolean; keepAlive?: string | number; signal?: AbortSignal }): Promise<string>; // opts gains `signal` (every engine)
  ```
  `resolvePersonaEngine` stays as the shim described in the Re-pin notes until Task 4.6a, which replaces its two production readers with `personaSharesGpu` and deletes it.
- **Keeps green:**
  - `src/routes/voice-style.test.ts` and `src/workspace/cast-lock.race.test.ts`. Both mock `generateVoiceStylePersona` and `preparePersonaBatch` by factory, and neither calls the removed or added exports.
  - `src/analyzer/ollama.test.ts` and `src/analyzer/ollama-timeout.test.ts`;
  - `src/routes/book-op.design-jobs.test.ts` (it mocks `resolvePersonaEngine`, which the shim keeps alive until Task 4.6a);
  - `src/analyzer/voice-style.timeout.test.ts`, amended below.

**Reused W3 helpers (no second copies).**
- `personaRunner` resolves the endpoint key with W3b's `resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl)` (`server/src/workspace/analyzer-endpoints.ts`, Task 3b.5). It throws `AnalyzerKeyOriginError` before any request exists.
- `personaSharesGpu` decides "same card" with W3d's `endpointsSharingDevice` (`server/src/gpu/endpoint-eviction.ts`, Task 3d.2).
- Entry criterion 2 has already found both.

- [ ] **Step 1: Write the failing tests**

In `server/src/analyzer/voice-style.test.ts`, replace lines 15-44 with:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzerRateLimiter } from './rate-limit.js';
import { registerKnownSecretsProvider } from './known-secrets-gate.js';
import { PERSONA_ABSOLUTE_MAX_MS } from './ollama.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import {
  resolveVoiceStyleModel,
  resolvePersonaSelection,
  resolvePersonaLocalModel,
  personaSharesGpu,
  generateVoiceStylePersona,
} from './voice-style.js';

const generateContentStream = vi.fn();

/* Keep the importOriginal spread: gemini-transport.ts imports ApiError and uses it at runtime (redactGeminiError). */
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class {
    models = { generateContentStream };
  },
}));

async function* stream(items: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const item of items) yield item;
}
const STOP = (text: string) => stream([{ text, candidates: [{ finishReason: 'STOP' }] }]);

let mockApiKey: string | null = 'test-key';
let mockSettingsPatch: Record<string, unknown> = {};
vi.mock('../workspace/user-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/user-settings.js')>();
  return {
    ...actual,
    getResolvedGeminiApiKey: () => mockApiKey,
    readConfigOverrides: () => ({}),
    getCachedUserSettings: () => ({ ...actual.DEFAULT_USER_SETTINGS, ...mockSettingsPatch }),
  };
});
// Re-pinned to 80be2f1d (#3192, A1): getResolvedOllamaModel/getResolvedOllamaUrl moved out of
// workspace/user-settings.ts into server/src/config/ollama-resolved.ts — main's own
// voice-style.test.ts mocks that module separately, not through the user-settings.js factory above.
vi.mock('../config/ollama-resolved.js', () => ({
  getResolvedOllamaModel: () => 'llama2',
  getResolvedOllamaUrl: () => 'http://ollama.test',
}));

function ENDPOINT(over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint {
  return {
    id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:18080/v1', gpu: 'none', concurrency: 1,
    requestCeilingMs: 1_800_000, structuredOutput: 'schema', reasoningStyle: 'not_controllable',
    reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 32768, ...over,
  };
}
```
In `beforeEach` (`:122-132`; the edits land on `:123`, `:124` and `:127-129`):
- Replace `generateContent.mockReset();` with `generateContentStream.mockReset();`.
- Replace `geminiRateLimiter._reset();` with `analyzerRateLimiter._reset();`.
- Add `mockSettingsPatch = {};`.
- Replace the `generateContent.mockResolvedValue({ … })` call with:
```ts
  generateContentStream.mockImplementation(async () =>
    STOP('a poised, confident teenage girl, warm and a little playful, mid-paced'),
  );
```
Replace everything from line 244 (`describe('persona generation config', …)`) through line 364 (the end of the Gemini and dispatch describes) with the blocks below, and then re-append the P22 describe (`:365-388`) retargeted as the last block of this step:
```ts
describe('persona generation config', () => {
  const ENV_KEYS = ['VOICE_STYLE_MODEL', 'PERSONA_GEN_ENGINE', 'PERSONA_GEN_LOCAL_MODEL'];
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    vi.restoreAllMocks();
  });

  it('resolveVoiceStyleModel reflects the registry default and an env override', () => {
    expect(resolveVoiceStyleModel()).toBe('gemini-3.1-flash-lite');
    process.env.VOICE_STYLE_MODEL = 'gemini-3.1-pro';
    expect(resolveVoiceStyleModel()).toBe('gemini-3.1-pro');
    resolveVoiceStyleModel();
    expect(configValueMock).toHaveBeenCalledWith('analyzer.gemini.voiceStyleModel');
  });

  it('resolvePersonaSelection: gemini by default, local, and an endpoint model id', () => {
    expect(resolvePersonaSelection()).toEqual({ engine: 'gemini', model: 'gemini-3.1-flash-lite' });
    process.env.PERSONA_GEN_ENGINE = 'local';
    expect(resolvePersonaSelection()).toEqual({ engine: 'local', model: 'llama2' });
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3-30b';
    expect(resolvePersonaSelection()).toEqual({ engine: 'openai', endpointId: 'lab', model: 'qwen3-30b' });
  });

  it('resolvePersonaLocalModel: blank inherits the analyzer model; explicit wins', async () => {
    // Re-pinned to 80be2f1d (#3192, A1) — getResolvedOllamaModel moved to config/ollama-resolved.js.
    const { getResolvedOllamaModel } = await import('../config/ollama-resolved.js');
    expect(resolvePersonaLocalModel()).toBe(getResolvedOllamaModel());
    process.env.PERSONA_GEN_LOCAL_MODEL = 'qwen3.5:9b';
    expect(resolvePersonaLocalModel()).toBe('qwen3.5:9b');
  });
});

describe('personaSharesGpu', () => {
  afterEach(() => {
    delete process.env.PERSONA_GEN_ENGINE;
    delete process.env.QWEN_DEVICE;
    mockSettingsPatch = {};
  });
  const onEndpoint = (gpu: string) => {
    mockSettingsPatch = { analyzerEndpoints: [ENDPOINT({ gpu })] };
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
  };

  it('local shares the GPU (today\'s rule); gemini never does', () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    expect(personaSharesGpu()).toBe(true);
    process.env.PERSONA_GEN_ENGINE = 'gemini';
    expect(personaSharesGpu()).toBe(false);
  });

  it('an endpoint on no card does not share; one on any card does', () => {
    onEndpoint('none');
    expect(personaSharesGpu()).toBe(false);
    onEndpoint('any');
    expect(personaSharesGpu()).toBe(true);
  });

  it('an endpoint pinned to a card shares only with a Qwen on that card (unknown card fails closed)', () => {
    onEndpoint('cuda:1');
    process.env.QWEN_DEVICE = 'cuda:1';
    expect(personaSharesGpu()).toBe(true);
    process.env.QWEN_DEVICE = 'cuda:0';
    expect(personaSharesGpu()).toBe(false);
    process.env.QWEN_DEVICE = 'cpu';
    expect(personaSharesGpu()).toBe(false);
    process.env.QWEN_DEVICE = 'auto';
    expect(personaSharesGpu()).toBe(true);
  });

  it('an endpoint id missing from settings fails closed', () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:gone::qwen3';
    expect(personaSharesGpu()).toBe(true);
  });

  it('an endpoint on any card shares only with a Qwen on a card (W3d same-card rule)', () => {
    onEndpoint('any');
    process.env.QWEN_DEVICE = 'cpu';
    expect(personaSharesGpu()).toBe(false);
    process.env.QWEN_DEVICE = 'cuda:1';
    expect(personaSharesGpu()).toBe(true);
  });
});

describe('generateVoiceStylePersona — gemini', () => {
  it('pins the model to gemini-3.1-flash-lite and returns the cleaned persona', async () => {
    const persona = await generateVoiceStylePersona(MAERIN);
    expect(persona).toBe('a poised, confident teenage girl, warm and a little playful, mid-paced');
    expect(generateContentStream).toHaveBeenCalledTimes(1);
    const call = generateContentStream.mock.calls[0][0] as { model: string; contents: unknown };
    expect(call.model).toBe('gemini-3.1-flash-lite');
    expect(JSON.stringify(call.contents)).toContain('Maerin');
  });

  it('honours the VOICE_STYLE_MODEL env override', async () => {
    process.env.VOICE_STYLE_MODEL = 'gemini-3-flash-preview';
    await generateVoiceStylePersona(MAERIN);
    expect((generateContentStream.mock.calls[0][0] as { model: string }).model).toBe('gemini-3-flash-preview');
    delete process.env.VOICE_STYLE_MODEL;
  });

  it('cleans a fenced/labelled model response', async () => {
    generateContentStream.mockImplementation(async () =>
      STOP('```\nPersona: a warm, gravelly older man, slow and weary\n```'),
    );
    await expect(generateVoiceStylePersona(MAERIN)).resolves.toBe('a warm, gravelly older man, slow and weary');
  });

  it('throws a clear message when no Gemini API key resolves (no network call)', async () => {
    mockApiKey = null;
    await expect(generateVoiceStylePersona(MAERIN)).rejects.toThrow(/GEMINI_API_KEY is required/);
    expect(generateContentStream).not.toHaveBeenCalled();
    mockApiKey = 'test-key';
  });

  it('throws when the model returns an empty persona', async () => {
    generateContentStream.mockImplementation(async () => STOP('   '));
    await expect(generateVoiceStylePersona(MAERIN)).rejects.toThrow(/empty persona/);
  });

  it('acquires the limiter with today\'s estimate: ceil(prompt.length / 4) + 200', async () => {
    const acquire = vi.spyOn(analyzerRateLimiter, 'acquire');
    const { buildVoiceStylePrompt } = await import('./voice-style.js');
    const prompt = await buildVoiceStylePrompt(MAERIN);
    await generateVoiceStylePersona(MAERIN);
    expect(acquire.mock.calls[0][0]).toBe('gemini-3.1-flash-lite');
    expect(acquire.mock.calls[0][1]).toBe(Math.ceil(prompt.length / 4) + 200);
    acquire.mockRestore();
  });
});

const CHAR = { id: 'miner', name: 'Old Tom' } as CastCharacter;

describe('generateVoiceStylePersona — local and endpoint dispatch', () => {
  afterEach(() => {
    delete process.env.PERSONA_GEN_ENGINE;
    mockApiKey = 'test-key';
    mockSettingsPatch = {};
    vi.restoreAllMocks();
  });
  const DONE = (text: string) => ({ text, reasoningSeen: false, finish: 'stop' as const, receivedBytes: text.length });

  it('local: one free-text request through the Ollama transport with the caller placement; never Gemini', async () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    const { OllamaTransport } = await import('./transports/ollama-transport.js');
    const send = vi.spyOn(OllamaTransport.prototype, 'send').mockResolvedValue(DONE("A weary miner's voice."));
    await expect(generateVoiceStylePersona(CHAR, { onCpu: true, keepAlive: 300 })).resolves.toBe("A weary miner's voice.");
    expect(send).toHaveBeenCalledOnce();
    const req = send.mock.calls[0][0];
    expect(req.structuredOutput).toEqual({ mode: 'off' });
    expect(req.freeText).toEqual({ onCpu: true, keepAlive: 300, absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS });
    expect(req.temperature).toBe(0.2); // analyzer.ollama.temperature default — main's persona call sent it
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('local with the daemon down throws LocalUnreachableError (no Gemini fallback)', async () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    const { OllamaTransport } = await import('./transports/ollama-transport.js');
    const { LocalUnreachableError } = await import('./ollama.js');
    vi.spyOn(OllamaTransport.prototype, 'send').mockRejectedValue(new LocalUnreachableError('Ollama unreachable'));
    await expect(generateVoiceStylePersona(CHAR)).rejects.toBeInstanceOf(LocalUnreachableError);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('endpoint: routes through OpenAITransport with no Ollama placement and no temperature', async () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
    mockSettingsPatch = { analyzerEndpoints: [ENDPOINT()] };
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const send = vi.spyOn(OpenAITransport.prototype, 'send').mockResolvedValue(DONE('A calm voice.'));
    await expect(generateVoiceStylePersona(CHAR, { onCpu: true, keepAlive: 300 })).resolves.toBe('A calm voice.');
    const req = send.mock.calls[0][0];
    expect(req.freeText).toEqual({ absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS }); // no onCpu / keepAlive for an endpoint
    expect(req.temperature).toBeUndefined();
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('endpoint missing from settings → AnalyzerEndpointMissingError(source persona) before any call', async () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:gone::qwen3';
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const { AnalyzerEndpointMissingError } = await import('./errors.js');
    const send = vi.spyOn(OpenAITransport.prototype, 'send');
    const err = (await generateVoiceStylePersona(CHAR).catch((e: unknown) => e)) as InstanceType<typeof AnalyzerEndpointMissingError>;
    expect(err).toBeInstanceOf(AnalyzerEndpointMissingError);
    expect(err.endpointId).toBe('gone');
    expect(err.source).toBe('persona');
    expect(send).not.toHaveBeenCalled();
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('endpoint key stored for another origin → AnalyzerKeyOriginError before any call', async () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
    mockSettingsPatch = {
      analyzerEndpoints: [ENDPOINT()],
      analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.9:18080', key: 'sk-test' } },
    };
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const { AnalyzerKeyOriginError } = await import('./errors.js');
    const send = vi.spyOn(OpenAITransport.prototype, 'send');
    await expect(generateVoiceStylePersona(CHAR)).rejects.toBeInstanceOf(AnalyzerKeyOriginError);
    expect(send).not.toHaveBeenCalled();
  });

  it('an unreachable endpoint propagates AnalyzerUnreachableError (no Gemini fallback)', async () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
    mockSettingsPatch = { analyzerEndpoints: [ENDPOINT()] };
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const { AnalyzerUnreachableError } = await import('./errors.js');
    vi.spyOn(OpenAITransport.prototype, 'send').mockRejectedValue(new AnalyzerUnreachableError('Lab is unreachable', 'openai'));
    await expect(generateVoiceStylePersona(CHAR)).rejects.toBeInstanceOf(AnalyzerUnreachableError);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('forwards the caller abort signal to the transport request (every engine)', async () => {
    const ac = new AbortController();
    process.env.PERSONA_GEN_ENGINE = 'local';
    const { OllamaTransport } = await import('./transports/ollama-transport.js');
    const ollamaSend = vi.spyOn(OllamaTransport.prototype, 'send').mockResolvedValue(DONE('A voice.'));
    await generateVoiceStylePersona(CHAR, { onCpu: false, keepAlive: 0, signal: ac.signal });
    expect(ollamaSend.mock.calls[0][0].signal).toBe(ac.signal);
    expect(ollamaSend.mock.calls[0][0].freeText).toEqual({ onCpu: false, keepAlive: 0, absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS });

    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
    mockSettingsPatch = { analyzerEndpoints: [ENDPOINT()] };
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const openaiSend = vi.spyOn(OpenAITransport.prototype, 'send').mockResolvedValue(DONE('A voice.'));
    await generateVoiceStylePersona(CHAR, { signal: ac.signal });
    expect(openaiSend.mock.calls[0][0].signal).toBe(ac.signal);
  });
});
```
Then append the retargeted P22 describe (it was `:365-388`; `generateContent` → `generateContentStream`, `geminiRateLimiter` → `analyzerRateLimiter`):
```ts
describe('generateVoiceStylePersona gemini branch redaction (#3084 P22)', () => {
  const SECRET = 'AIzaSy-persona-echo-secret-1';
  afterEach(() => {
    delete process.env.PERSONA_GEN_ENGINE;
    registerKnownSecretsProvider({ known: () => [], load: async () => [] });
  });

  it('an error whose message echoes a saved secret reaches the caller redacted, as the Ollama persona path does', async () => {
    process.env.PERSONA_GEN_ENGINE = 'gemini';
    registerKnownSecretsProvider({ known: () => [SECRET], load: async () => [SECRET] });
    vi.spyOn(analyzerRateLimiter, 'acquire').mockResolvedValue(undefined as any);
    generateContentStream.mockRejectedValue(new Error(`upstream said key ${SECRET} is invalid`));
    const err = await generateVoiceStylePersona(CHAR).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe('upstream said key [redacted] is invalid');
    expect(`${(err as Error).stack}`).not.toContain(SECRET);
  });

  it('an error with no secret in it is rethrown as the same object', async () => {
    process.env.PERSONA_GEN_ENGINE = 'gemini';
    vi.spyOn(analyzerRateLimiter, 'acquire').mockResolvedValue(undefined as any);
    const upstream = new Error('quota exceeded');
    generateContentStream.mockRejectedValue(upstream);
    await expect(generateVoiceStylePersona(CHAR)).rejects.toBe(upstream);
  });
});
```
Also check that the kept `delegateConfigValue` helper (`:59-63`) delegates every other key to the real `configValue`. `QWEN_DEVICE` and `analyzer.ollama.temperature` resolve through it, so no change is needed.

`server/src/analyzer/voice-style.endpoint.test.ts` is the wiring proof: the transport's limiter, concurrency, in-flight registration and key header reach a persona. It uses a real server and no SDK mock:
```ts
/* #3084 W4 — an endpoint persona (PERSONA_GEN_ENGINE=openai:lab::qwen3) runs through OpenAITransport for
   real: limiter keyed by the model id, the endpoint's concurrency, W3d's per-call busy registration for a
   GPU endpoint, the served-model record, and the key sent only under a matching origin. The server also
   answers the served-models listing prepare() sends. Real http.createServer on 127.0.0.1:0. */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { _setUserSettingsCacheForTest, _resetUserSettingsCache } from '../workspace/user-settings.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { isEndpointBusy } from './analyzer-concurrency.js';
import { servedModels, _resetEndpointRuntimeForTest } from './transports/endpoint-runtime.js';
import { analyzerRateLimiter } from './rate-limit.js';
import { endpointModelId } from './model-id.js';
import { AnalysisAbortedError } from './errors.js';
import { generateVoiceStylePersona } from './voice-style.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

let server: Server | undefined;
let active = 0;
let peak = 0;
let listings = 0;
const seen: Array<{ headers: IncomingHttpHeaders; busyDuringCall: boolean }> = [];

function startHeldServer(holdMs: number): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === 'GET') {
      /* #3084 P15 — runFreeText awaits OpenAITransport.prepare(), which lists the served models. */
      listings += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    active += 1;
    peak = Math.max(peak, active);
    req.resume();
    req.on('end', () => {
      seen.push({ headers: req.headers, busyDuringCall: isEndpointBusy('lab') });
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'qwen3', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: 'assistant', content: 'A calm, low voice.' }, null));
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
        active -= 1;
      }, holdMs);
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const a = server!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`);
    });
  });
}

function endpoint(baseUrl: string, over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint {
  return {
    id: 'lab', name: 'Lab', baseUrl, gpu: 'any', concurrency: 1, requestCeilingMs: 1_800_000,
    structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default',
    maxOutputTokens: 0, contextTokens: 32768, ...over,
  };
}

const CHAR = { id: 'miner', name: 'Old Tom' } as CastCharacter;

beforeEach(() => {
  process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
  analyzerRateLimiter._reset();
  active = 0;
  peak = 0;
  listings = 0;
  seen.length = 0;
  _resetEndpointRuntimeForTest();
});

afterEach(async () => {
  delete process.env.PERSONA_GEN_ENGINE;
  _resetUserSettingsCache();
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

describe('endpoint persona wiring', () => {
  it('sends the key under a matching origin, registers the call busy (gpu any), records the served model and keys the limiter by model id', async () => {
    const baseUrl = await startHeldServer(50);
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [endpoint(baseUrl)],
      analyzerEndpointKeys: { lab: { origin: new URL(baseUrl).origin, key: 'sk-test' } },
    });
    const acquire = vi.spyOn(analyzerRateLimiter, 'acquire');
    await expect(generateVoiceStylePersona(CHAR)).resolves.toBe('A calm, low voice.');
    expect(seen[0].headers.authorization).toBe('Bearer sk-test');
    expect(seen[0].busyDuringCall).toBe(true);
    expect(isEndpointBusy('lab')).toBe(false); // a call registration only: no run mark outlives the persona
    expect(servedModels('lab')).toEqual(['qwen3']); // recorded once the request is sent (after the semaphore admits it): an unload target (P3)
    expect(listings).toBe(1); // prepare() warmed the served limits first
    expect(acquire.mock.calls[0][0]).toBe(endpointModelId('lab', 'qwen3'));
  });

  it('does not register an endpoint on no card as busy', async () => {
    const baseUrl = await startHeldServer(50);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint(baseUrl, { gpu: 'none' })] });
    await generateVoiceStylePersona(CHAR);
    expect(seen[0].busyDuringCall).toBe(false);
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it('serialises concurrent personas at the endpoint concurrency of 1', async () => {
    const baseUrl = await startHeldServer(150);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint(baseUrl, { concurrency: 1 })] });
    await Promise.all([generateVoiceStylePersona(CHAR), generateVoiceStylePersona(CHAR)]);
    expect(seen).toHaveLength(2);
    expect(peak).toBe(1);
  });

  it('aborting the caller signal aborts an in-flight endpoint persona call', async () => {
    let closedBeforeResponse = false;
    let arrived!: () => void;
    const requestArrived = new Promise<void>((r) => (arrived = r));
    server = createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      res.on('close', () => {
        if (!res.writableEnded) closedBeforeResponse = true;
      });
      req.resume();
      req.on('end', () => arrived()); // never answers: only the caller's abort can end this call
    });
    const baseUrl = await new Promise<string>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`);
      });
    });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint(baseUrl, { gpu: 'none' })] });
    const ac = new AbortController();
    const pending = generateVoiceStylePersona(CHAR, { signal: ac.signal }).catch((e: unknown) => e);
    await requestArrived;
    ac.abort();
    expect(await pending).toBeInstanceOf(AnalysisAbortedError);
    await vi.waitFor(() => expect(closedBeforeResponse).toBe(true));
  });
});
```
The limiter key assertion follows spec §5 (the analyzer limiter is keyed by the full model id). Busy state is W3d Task 3d.1's per-endpoint registry (`isEndpointBusy`); `servedModels` is W3b Task 3b.10's, recorded once the request is sent (after the endpoint semaphore admits it, before `create()`, whatever the outcome). If W3 keys endpoint limits by the bare model, that is a W3 contract deviation: report it in the PR body and do not weaken this assertion silently.

Amend `server/src/analyzer/voice-style.timeout.test.ts` (owner decision, #3725's test; it uses the REAL SDK against a never-answering `GOOGLE_GEMINI_BASE_URL`). Keep its header, the `vi.mock('./ollama.js', …)` that shrinks `PERSONA_ABSOLUTE_MAX_MS` to 400, its user-settings factory mock, `CEILING_MS` and the elapsed-time window. Change four things:
```ts
// imports: add
import { _seedGeminiCatalogForTest } from './catalog/gemini-catalog.js';
import { AnalyzerTimeoutError } from './errors.js';

// the fake endpoint: count only the generate POSTs (a catalog listing would be a GET)
let posts = 0;
//   server = http.createServer((req) => { if (req.method === 'POST') posts += 1; req.resume(); });

// beforeAll: seed the catalog so prepare() makes no listing request ('test-key' is the mocked getResolvedGeminiApiKey)
_seedGeminiCatalogForTest('test-key', []);

it('rejects at the persona ceiling instead of waiting on a never-answering endpoint', async () => {
  posts = 0;
  const t0 = Date.now();
  const err = await generateVoiceStylePersona(CHARACTER).catch((e: unknown) => e);
  const elapsed = Date.now() - t0;
  /* #3084 W4 — the ceiling is the transport's and it is terminal: GEMINI_RETRY_CLASSIFIER never retries an
     AnalyzerTimeoutError, so exactly ONE generate POST reaches the fake endpoint. */
  expect(err).toBeInstanceOf(AnalyzerTimeoutError);
  expect((err as AnalyzerTimeoutError).reason).toBe('ceiling');
  expect(posts).toBe(1);
  expect(elapsed).toBeGreaterThanOrEqual(CEILING_MS - 50);
  expect(elapsed).toBeLessThan(CEILING_MS + 2_000);
}, 5_000);
```
Replace the old `requests` counter (it counted every request) and the `rejects.toMatchObject({ name: 'AbortError' })` assertion; the reference to `AbortError` in the file's comments goes with them.

- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm --prefix server run test -- src/analyzer/voice-style.test.ts src/analyzer/voice-style.endpoint.test.ts src/analyzer/voice-style.timeout.test.ts`
  - **Expected:** FAIL.
    - `voice-style.test.ts` fails at import with `SyntaxError: The requested module './voice-style.js' does not provide an export named 'personaSharesGpu'` (vitest reports the missing export).
    - `voice-style.endpoint.test.ts` → `sends the key…` fails with `expected '…' to be 'A calm, low voice.'` or a Gemini-key error: main routes any non-`local` value to Gemini.
    - `voice-style.timeout.test.ts` fails on `expected … to be an instance of AnalyzerTimeoutError`: the bare `generateContent` still rejects with an `AbortError`.

- [ ] **Step 3: Implement** — `server/src/analyzer/voice-style.ts`

Replace the header comment (lines 1-26) with:
```ts
/* Voice-style persona generator (plan 108 Wave 4 dependency; engine choice #3084 W4, spec §10).

   Every cast member gets a short natural-language "voice style" persona —
   a Qwen voice-design `instruct` like:
     "A bright teenage girl's voice, medium-high pitch and mid-paced, warm
      and lightly playful with a faintly nervous edge, suited to expressive
      character dialogue."
   The Qwen sidecar designs a bespoke voice FROM such a persona
   (`POST /qwen/design-voice {voiceId, instruct, …}`), so the persona is the
   editable, durable seed of a character's designed voice.

   Locked decisions (user 2026-05-24):
     (a) the Gemini model is `analyzer.gemini.voiceStyleModel` (default
         gemini-3.1-flash-lite, its own free-tier rate-limit bucket);
     (b) ONE call PER CHARACTER — never batch multiple characters into one
         prompt, so a persona can't be contaminated by a neighbour's traits;
     (c) the persona is derived from the character's FULL profile —
         gender, age, role, description, tone metrics, AND their collected
         dialogue evidence quotes (reusing `buildHintFromCast`).

   `analyzer.personaGeneration.engine` picks `gemini`, `local` (Ollama) or an
   OpenAI-compatible endpoint model (`openai:<endpointId>::<model>`). Every
   engine runs through the analyzer's stage runner free-text path
   (`StageRunner.runFreeText`) and its transport, so the limiter, endpoint
   concurrency, GPU in-flight accounting and request ceilings apply exactly as
   they do to analysis. There is NO cross-provider fallback: a missing key, a
   down daemon, or a missing/unreachable endpoint fails with its own error. */
```
Replace the imports (lines 28-39) with:
```ts
import { buildHintFromCast, type CastCharacter } from '../tts/synthesise-chapter.js';
import { getCachedUserSettings, getResolvedGeminiApiKey } from '../workspace/user-settings.js';
// Re-pinned to 80be2f1d (#3192, A1): these two resolvers moved out of workspace/user-settings.ts
// into their own leaf, server/src/config/ollama-resolved.ts — matches main's own voice-style.ts.
import { getResolvedOllamaModel, getResolvedOllamaUrl } from '../config/ollama-resolved.js';
import { resolveEndpointApiKey, type AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { endpointsSharingDevice } from '../gpu/endpoint-eviction.js';
import { GeminiAnalyzer, stripCodeFences } from './gemini.js';
import { OllamaAnalyzer, resolveOllamaTemperature, PERSONA_ABSOLUTE_MAX_MS } from './ollama.js';
import { OpenAIAnalyzer } from './openai.js';
import { inferEngineFromModelId, parseEndpointModelId } from './model-id.js';
import { AnalyzerEndpointMissingError } from './errors.js';
import type { StageRunner } from './runner/stage-runner.js';
import { readPrompt } from '../config/prompts.js';
import { configValue } from '../config/resolver.js';
```
If W1 moved `stripCodeFences` to `./runner/parse.js` without the re-export from `gemini.ts` the contract promises, import it from there.

Replace `resolvePersonaEngine` (lines 64-67) with:
```ts
/** The persona engine selection, from `analyzer.personaGeneration.engine` (pattern-validated:
    `local`, `gemini`, or `openai:<endpointId>::<model>`). */
export type PersonaSelection =
  | { engine: 'local'; model: string }
  | { engine: 'gemini'; model: string }
  | { engine: 'openai'; endpointId: string; model: string };

export function resolvePersonaSelection(): PersonaSelection {
  const value = configValue<string>('analyzer.personaGeneration.engine');
  if (value === 'local') return { engine: 'local', model: resolvePersonaLocalModel() };
  const endpointModel = parseEndpointModelId(value);
  if (endpointModel) return { engine: 'openai', endpointId: endpointModel.endpointId, model: endpointModel.model };
  return { engine: 'gemini', model: resolveVoiceStyleModel() };
}

/* TEMPORARY shim (Task 4.5 -> 4.6a): keeps cast-design.ts and persona-gpu-plan.ts compiling until Task 4.6a
   switches them to personaSharesGpu() and deletes this. Do not add a new reader. */
export function resolvePersonaEngine(): 'local' | 'gemini' {
  return resolvePersonaSelection().engine === 'local' ? 'local' : 'gemini';
}

function findEndpoint(endpointId: string): AnalyzerEndpoint | undefined {
  return getCachedUserSettings().analyzerEndpoints.find((e) => e.id === endpointId);
}

/** True when the persona call can land on the card the Qwen VoiceDesign model uses — the condition
    under which cast design must generate personas BEFORE VoiceDesign loads (plan 108) and
    preparePersonaBatch must plan the GPU:
      - local Ollama: always (the rule before #3084);
      - gemini: never;
      - an endpoint: W3d's endpointsSharingDevice against Qwen's pinned `cuda:N` (`any` shares every card); a Qwen device that names no
        single card (`auto`, `cuda`, an unreconciled `cuda-uuid:`) fails closed; `cpu`/`mps` never share;
        `gpu: 'none'` never shares; an endpoint id missing from settings fails closed. */
export function personaSharesGpu(): boolean {
  const selection = resolvePersonaSelection();
  if (selection.engine === 'local') return true;
  if (selection.engine === 'gemini') return false;
  const endpoint = findEndpoint(selection.endpointId);
  if (!endpoint) return true;
  if (endpoint.gpu === 'none') return false;
  const qwenDevice = configValue<string>('tts.qwen.device').trim().toLowerCase();
  if (qwenDevice === 'cpu' || qwenDevice === 'mps') return false;
  if (!/^cuda:\d+$/.test(qwenDevice)) return true;
  /* W3d's same-card rule, not a second copy of it: `any` shares every card, otherwise the exact device key. */
  return endpointsSharingDevice([endpoint], qwenDevice).length > 0;
}
```
Replace lines 171-241 (from the dispatcher doc comment to the end of the file, which removes `generateViaOllama` and `generateViaGemini`) with:
```ts
const GEMINI_KEY_REQUIRED =
  // Re-pinned to 80be2f1d: main's own voice-style.ts already reads "Admin → Model Manager", not
  // "Account → Server configuration" — match it, don't regress the copy.
  'GEMINI_API_KEY is required to generate voice-style personas. ' +
  'Set it in Admin → Model Manager → Gemini API key, ' +
  'or in server/.env for CI / power users.';

/* Build the analyzer for the selected engine and hand back its stage runner. Every selection error
   (no Gemini key, endpoint missing, key stored for another origin) throws HERE, before any prompt is
   built or any request is sent. */
function personaRunner(selection: PersonaSelection): StageRunner {
  switch (selection.engine) {
    case 'local':
      return new OllamaAnalyzer({ url: getResolvedOllamaUrl(), model: selection.model }).runner;
    case 'gemini': {
      const apiKey = getResolvedGeminiApiKey();
      if (!apiKey) throw new Error(GEMINI_KEY_REQUIRED);
      return new GeminiAnalyzer({ apiKey, model: selection.model }).runner;
    }
    case 'openai': {
      const settings = getCachedUserSettings();
      const endpoint = settings.analyzerEndpoints.find((e) => e.id === selection.endpointId);
      if (!endpoint) throw new AnalyzerEndpointMissingError(selection.endpointId, 'persona');
      /* W3b's resolver: throws AnalyzerKeyOriginError for a key bound to another origin, before any request exists. */
      const apiKey = resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl);
      return new OpenAIAnalyzer({ endpoint, apiKey, model: selection.model }).runner;
    }
  }
}

/** Generate a voice-style persona for ONE character through the selected engine.
    `opts` places the LOCAL (Ollama) call only — CPU vs GPU and its keep_alive window, from
    preparePersonaBatch; the Gemini and endpoint transports ignore it.
    - local  → Ollama non-streaming call; LocalUnreachableError when the daemon is down.
    - gemini → Gemini through the limiter; a clear error when no key resolves.
    - openai → the endpoint through its transport; AnalyzerEndpointMissingError /
               AnalyzerKeyOriginError before any call, AnalyzerUnreachableError when it is down.
    `opts.signal` aborts the call on every engine (the design job passes its own).
    Every engine is bounded by PERSONA_ABSOLUTE_MAX_MS, applied by its transport as
    min(its request ceiling, this) (#3725, owner decision 4.3-B1); that ceiling is terminal.
    Never falls back to another engine. */
export async function generateVoiceStylePersona(
  character: CastCharacter,
  opts: { onCpu?: boolean; keepAlive?: string | number; signal?: AbortSignal } = {},
): Promise<string> {
  const selection = resolvePersonaSelection();
  const runner = personaRunner(selection);
  const prompt = await buildVoiceStylePrompt(character);
  const raw = await runner.runFreeText(
    selection.engine === 'local'
      ? {
          prompt,
          signal: opts.signal,
          absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS,
          /* Main's persona call sent the analyzer's first-attempt temperature to Ollama and none to Gemini. */
          temperature: resolveOllamaTemperature(),
          ollama: { onCpu: opts.onCpu, keepAlive: opts.keepAlive },
        }
      : { prompt, signal: opts.signal, absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS },
  );
  const persona = cleanPersona(raw);
  if (!persona) {
    throw new Error(`Voice-style generation for "${character.id}" returned an empty persona.`);
  }
  return persona;
}
```
In `server/src/analyzer/ollama.ts`:
- Delete the `/** One-shot freeform Ollama call for persona generation … */` doc comment (`:70`) and the whole `generatePersonaViaOllama` function (`:78-173`).
- Delete the `PERSONA_ABSOLUTE_MAX_MS` entry from the `:8` transport import, and every import only that function used (the full list is in the Re-pin notes; ESLint `--max-warnings 0` fails on an unused one).
- Keep the `export { … } from` re-statements at `:19-27`, including the `:20` one that carries `PERSONA_ABSOLUTE_MAX_MS` and `classifyConnectError`.

In W3b's `server/src/analyzer/transport-redaction.test.ts`, change line 13 to `import { OllamaAnalyzer } from './ollama.js';`. In `describe('Ollama persona call redaction (#3084 P22, A8)', …)`, replace lines 129-140 (the 4-line `generatePersonaViaOllama reads its URL via getResolvedOllamaUrl (A3 …` comment, the `_setUserSettingsCacheForTest({ geminiApiKey: SECRET, configOverrides: { 'analyzer.ollama.url': url } });` seed, the `OLLAMA_URL` comment, `vi.stubEnv('OLLAMA_URL', undefined);`, the `generatePersonaViaOllama(…)` call and the `expect((err as Error).message).toBe(…)` statement) with the block below. The server setup above it and the `surfaces(err)` / `lines` loop below it (lines 141-143) stay:
```ts
    /* #3084 W4 — the persona call is now OllamaAnalyzer's runner free-text path (Task 4.2), which
       carries 3b's redaction. The URL goes straight into the analyzer. */
    _setUserSettingsCacheForTest({ geminiApiKey: SECRET });
    const err = await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' }).runner
      .runFreeText({ prompt: 'Describe the voice.', ollama: { onCpu: true } })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect((err as Error).message).toBe(
      `Ollama ${url} returned 500 Internal Server Error: {"error":"persona runner failed for key [redacted]"}`,
    );
```
It passes as soon as it is retargeted (Task 4.2 already moved the redacted body), and Task 4.2's mutation 6 turns it red as well.

- Then run `git grep -n -E "generatePersonaViaOllama|resolvePersonaEngine\b" -- server/src`. Expected remaining hits: only `src/routes/cast-design.ts`, `src/routes/cast-design.test.ts`, `src/tts/persona-gpu-plan.ts`, `src/tts/prepare-persona-batch.test.ts` and `src/routes/book-op.design-jobs.test.ts:41-44`, plus the shim's own definition in `voice-style.ts` (Task 4.6a removes them all).

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm --prefix server run test -- src/analyzer/voice-style.test.ts src/analyzer/voice-style.endpoint.test.ts src/analyzer/voice-style.timeout.test.ts src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts src/analyzer/transport-redaction.test.ts src/routes/voice-style.test.ts src/workspace/cast-lock.race.test.ts src/routes/book-op.design-jobs.test.ts`.
  - **Expected:** PASS. `npm run typecheck` and `npm run lint` are green: the `resolvePersonaEngine` shim keeps `persona-gpu-plan.ts` and `cast-design.ts` compiling until Task 4.6a.
  - **Then run:** `npm run check:cycles`. **Expected:** no new cycle. `voice-style.ts` → `gpu/endpoint-eviction.ts` is a new edge (analyzer importing gpu, which CLAUDE.md allows; the rule forbids gpu importing routes). If madge reports a cycle through it, stop and report it rather than allowlisting it.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Missing endpoint:** delete `if (!endpoint) throw new AnalyzerEndpointMissingError(…)`. Expected red: `endpoint missing from settings → AnalyzerEndpointMissingError…`.
  2. **Key origin:** replace `resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl)` with `settings.analyzerEndpointKeys[endpoint.id]?.key ?? null`. Expected red: `endpoint key stored for another origin…`, with `send` called.
  3. **Placement scope:** replace the `runFreeText(` argument ternary with the local branch for every engine. Expected red: `endpoint: routes through OpenAITransport with no Ollama placement…`.
  4. **Same-card rule:** in `personaSharesGpu`, replace `return endpointsSharingDevice([endpoint], qwenDevice).length > 0;` with `return true;`. Expected red: `an endpoint pinned to a card shares only with a Qwen on that card…`.
  5. **Estimate:** in Task 4.1's `runFreeText`, change `+ 200` to `+ 100`. Expected red: `acquires the limiter with today's estimate…`.
  6. **Signal:** in `generateVoiceStylePersona`, delete `signal: opts.signal` from both `runFreeText` arguments. Expected red:
     - `forwards the caller abort signal to the transport request (every engine)` (`expected undefined to be AbortSignal {}`);
     - `aborting the caller signal aborts an in-flight endpoint persona call` (times out, because the held request is never cancelled).
  7. **Persona ceiling:** delete `absoluteMaxMs: PERSONA_ABSOLUTE_MAX_MS` from both `runFreeText` arguments. Expected red: `voice-style.timeout.test.ts` (no 400 ms bound: the request waits on the 30 min Gemini ceiling and the 5 s test timeout fires) and the three `freeText` equality assertions in `voice-style.test.ts`.
- [ ] **Step 6: Commit** — this task is its own commit now (the shim keeps typecheck green; Tasks 4.6a and 4.6b are the next two commits, see the Re-pin notes). `book-op.design-jobs.test.ts` is not touched yet (Task 4.6a):
```bash
git add server/src/analyzer/voice-style.ts server/src/analyzer/voice-style.test.ts server/src/analyzer/voice-style.endpoint.test.ts server/src/analyzer/voice-style.timeout.test.ts server/src/analyzer/transport-redaction.test.ts server/src/analyzer/ollama.ts
git commit -m "feat(server): generate personas through the analyzer transports for every engine"
```

---

### Task 4.6: The GPU plan and the design job treat a same-card endpoint like local

> **Re-pin notes (2026-10-23, against b015aae9) — read first; these override the steps below where they differ.**
> - **Two children, two commits.**
>   - **4.6a (audit label C2):** the `persona-gpu-plan.ts` and `cast-design.ts` gate swaps, the job signal, the lazy `break`, the pre-pass rethrow including the taxonomy `auth` clause, all the new pre-pass and lazy tests EXCEPT the `.code` assertions in the `it.each` rows, mutations 1–5, 7, 8 (first two bullets), 9, 10. It DELETES the `resolvePersonaEngine` shim Task 4.5 left, and fixes `book-op.design-jobs.test.ts:41-44`. Its final `git grep -n -E "resolvePersonaEngine|generatePersonaViaOllama" -- server/src` must be empty. Suggested subject: `feat(server): treat a same-card persona endpoint like local in the design job`.
>   - **4.6b (audit label C3):** the backstop branches and comment rewrite, `openapi.yaml` `CastDesignEvent.code`, the `api-types.ts` regeneration, the parity-test edit, the `.code` assertions in the `it.each` rows, mutations 6 and 8c. Suggested subject: `feat(server): carry the failure code on a cast design error`.
> - **Lazy abort check is `break`, NOT `return`** (a bug in the plan's snippet, now corrected below). That catch is nested in `for (const task of tasks)` (`:390`) → `try` (`:495`) → `if (!persona)` (`:510`) → `try`/`catch` (`:527`/`:530`). A `return` leaves `runDesignJob` and skips the post-loop `endJob(job, { type: 'idle', … })` (`:742–749`): the SSE response never ends, `inFlightByBook` and `markDesignBusy` leak, and the plan's own lazy-pause test hangs. `break` lets the `finally` clear the heartbeat and the loop exit reach the idle `endJob`. The pre-pass catch's `return` is correct: it returns from `runPersonaPrePass`, and `runDesignJob` (`:356–366`) ends the job idle.
> - **Book-op lock compliance (#3714) holds; do not add any.** The design job is a long `runBookJob(bookId, 'design', async (located) => …)` (`cast-design.ts:792`) and holds no book-op. `book-op-lock.guard.test.ts:554` lists `['routes/cast-design.ts', { min: 1, pending: null }]`. This task adds no `runBookJob`, `withBookOp`, `peekBook`, book resolve or new write; persona writes still go through `writeVoiceStylePersona` → `withCastLock` inside the job lease; `routes/voice-style.ts` (`min: 2`) is untouched.
> - **`cast-design.ts` line map at `b015aae9`** (the plan's numbers are main's; see the header block for the shared ones). Header bullet `:17`. Imports: `:58` (`import { resolvePersonaEngine, generateVoiceStylePersona } from '../analyzer/voice-style.js';`) and `:59` (`import { LocalUnreachableError } from '../analyzer/ollama.js';`, which the new errors import block replaces). Pre-pass doc and gate `:275–294` (the gate is `:294`). Pre-pass call `:323`, rethrow `:325`. Lazy skip `:501–516` (ENGINE SPLIT comment `:501–508`, gate `:511`). Lazy call `:528`, `writeVoiceStylePersona` `:529`, catch `:530–545`. Loop abort check `:391`. Final idle `endJob` `:742–749`. The #2292 comment is `:715–723` and "leave it alone" still holds.
> - **The backstop is no longer `void runDesignJob(…)`.** It is `await runDesignJob(job, tasks, modelKey!, language, seriesFilter).catch((e) => {` at `:917`, inside the `runBookJob` callback (`:792–946`). The catch body is a comment block `:918–931`, then `if (isLockAcquisitionTimeout(e)) { endJob(… 'lock-contention' …) } else { endJob(… code: 'unknown' …) }` (`:932–944`). Apply the new branches there; keep the `await`; never rethrow from that catch (`registered.done.catch`, `:952`, sends a 500 only when headers have not gone out). Rewrite the comment `:924–931`: its "Two literal branches, not a `code` variable, so the literal `code: '...'` stays greppable" rationale applies only to `SingleDesignEvent` (the parity test regex-scrapes `single-design.ts`, `openapi-design-parity.test.ts:209–210`), not to cast-design. Add `import { classifyAnalysisFailure } from './failure-taxonomy.js';` (the file has no import from that module yet); 4.6a needs it for the pre-pass `auth` clause.
> - **Owner decision B2: the pre-pass rethrows on the taxonomy's `auth`.** In the pre-pass catch, after the abort `return`, rethrow when the error is an `AnalyzerUnreachableError`, an `AnalyzerEndpointMissingError` or an `AnalyzerTimeoutError`, OR when `classifyAnalysisFailure(err, 'Persona generation').code === 'auth'`. The `auth` clause covers `AnalyzerKeyOriginError`, `AnalyzerHttpError` 401/403 and a 400 from an OpenAI-transport endpoint whose body matches `GEMINI_KEY_REJECTED` (`failure-taxonomy.ts:538`, applied at `:1006`: Google's OpenAI-compatible endpoint with a bad key). The plan's explicit `AnalyzerKeyOriginError` / `AnalyzerHttpError` alternatives are gone, so those two names are NOT imported into `cast-design.ts` any more (ESLint `--max-warnings 0` fails on unused imports). `AnalysisAbortedError` is imported only by 4.6b, which uses it in the backstop; 4.6a must not import it. Keep the "500 stays per-character" test and add the 400 row (Step 1).
> - **Owner decision B1: `anyOf` + a parity-test edit (4.6b).** The plan claimed `CastDesignEvent.code` "has no parity case"; that is false. `openapi-design-parity.test.ts:248–251` reads `const castBlock = schemaBlock(yaml, 'CastDesignEvent')`, then `expect(castBlock).toMatch(/code:\r?\n\s+type: string\r?\n\s+enum:.*\r?\n\s+description: \|/)` (`:250`) and `expect(castBlock).toContain('stated language with no sidecar mapping')` (`:251`). The `anyOf` form fails `:250`. Edit `:250` (Cast only) to a regex that accepts the `anyOf` and still requires the block scalar, for example `/code:\r?\n\s+anyOf:\r?\n(?:\s+.*\r?\n)*?\s+description: \|/`; keep `:251`; leave the Single case (`:254`) alone. Re-proof (paste the output): make the Cast `description` a plain scalar; the test must go red. In `openapi.yaml`, `CastDesignEvent` starts at `:5091`, its `code` block is `:5166–5175` and `FailureCode` is `:8382`. Run `npm run openapi:types` and commit `src/lib/api-types.ts`; add the parity test to the `git add`.
> - **The `openapi.yaml` description text spans a line break** (`:5134–5135`, 12-space indent inside the block scalar: `` `unknown` (defensive catch-all for any other unexpected throw `` then `escaping the design loop).`). Match across the break and keep the indentation.
> - **`cast-design.test.ts` lines moved by +54, plus uses the plan missed.** The hoisted mocks `:52–62` match the plan verbatim. Step 1 carries the corrected table. The `describe('cast-design persona pre-pass')` block closes at `:1524` (the plan said `:1470`); append the new tests before it. `writeBookOnDisk` (`:146`) and `parseSse` (`:208`) exist.
> - **An existing test breaks once the signal is added** (the plan's "Keeps green: cast-design.test.ts (all)" is wrong). "busy box: preparePersonaBatch returns CPU args" (`:1276–1279`) asserts `expect(genSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'hart' }), { onCpu: true, keepAlive: 0 })`, an exact match on the second argument. Change it to `{ onCpu: true, keepAlive: 0, signal: expect.any(AbortSignal) }`, which also proves the signal is threaded.
> - **A test the plan did not touch mocks the removed export.** `server/src/routes/book-op.design-jobs.test.ts:41-44` is `vi.mock('../analyzer/voice-style.js', () => ({ generateVoiceStylePersona: personaMock, resolvePersonaEngine: vi.fn().mockReturnValue('gemini') }))`; it drives `cast/design`, so `runPersonaPrePass` would hit vitest's missing-export error. Replace the entry with `personaSharesGpu: vi.fn().mockReturnValue(false)`, add the file to the Step 4 run list and the Step 6 `git add`.
> - **No other drift** in `persona-gpu-plan.ts` (line 3 is the import; the doc and `preparePersonaBatch` are `:41–59`, so "`:41-59`" in Step 3 is right and Files' "`:41-58`" is not) or `prepare-persona-batch.test.ts` (`:1–18`, `:36–66` match the plan verbatim). Error constructors match the new tests: `AnalyzerHttpError(transport, httpStatus, bodyExcerpt, message)`, `AnalyzerTimeoutError(transport, model, elapsedMs, reason)`, `AnalyzerReasoningOverflowError(transport, model, reasoningTokens, opts?)`, `AnalyzerKeyOriginError(endpointId, endpointName)`, `AnalyzerUnreachableError(message, transport, cause?)` (`errors.ts:49`, `:173`, `:198`, `:336`, `:24`). `classifyAnalysisFailure(err, modelLabel, ctx?)` is `failure-taxonomy.ts:871`. The frontend reads no `CastDesignEvent['code']` literal outside `api-types.ts`.

**Files:**
- Modify: `server/src/analyzer/voice-style.ts` — delete the `resolvePersonaEngine` shim Task 4.5 left (4.6a).
- Modify: `server/src/tts/persona-gpu-plan.ts:3` (import) and `:41-59` (`preparePersonaBatch` doc and body).
- Modify: `server/src/routes/cast-design.ts`:
  - `:17` — header bullet;
  - `:58-59` — imports;
  - `:275-294` — pre-pass doc and gate;
  - `:323-325` — the pre-pass persona call (job signal) and the wholesale rethrow;
  - `:501-516` — the lazy-persona skip (the ENGINE SPLIT comment and its gate);
  - `:528-545` — the lazy persona call (job signal), inside the per-character try/catch `6222e483` added. The call line changes and the catch gains one `break` line; the rest of the catch is left exactly as it is;
  - `:917-945` — the backstop `.catch` inside the `runBookJob` callback (a pause that aborted a persona call, and the classified failure code for any other error): 4.6b.
- Modify: `openapi.yaml` — `CastDesignEvent.code` also admits a `FailureCode`; regenerate `src/lib/api-types.ts` (4.6b).
- Test: Modify `server/src/routes/openapi-design-parity.test.ts:250` (4.6b, owner decision B1).
- Test: Modify `server/src/routes/book-op.design-jobs.test.ts:41-44` (4.6a).
- Test: Modify `server/src/tts/prepare-persona-batch.test.ts:12-18, :36-66`.
- Test: Modify `server/src/routes/cast-design.test.ts`:
  - `:52-62` — hoisted mocks;
  - every `resolvePersonaEngineMock` use (`:523`, `:1190`, `:1197`, `:1254`, `:1288`, `:1309`, `:1331`, `:1382`, `:1433`, `:1486`, `:1715`);
  - `:1286-1288` and `:1305-1308` — titles and comments, and the header comments at `:54-55`, `:64-68`;
  - `:1276-1279` — the busy-box second-argument match;
  - append the new tests inside `describe('cast-design persona pre-pass')`, before its close at `:1524`.

**Interfaces:**
- **Consumes:** from Task 4.5 `personaSharesGpu()` and `generateVoiceStylePersona`'s `signal` option; from `errors.ts` (W1/W3) `AnalyzerUnreachableError`, `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError`, `AnalyzerTimeoutError`, `AnalyzerHttpError`, `AnalysisAbortedError`, and (test only) W2's `AnalyzerReasoningOverflowError`; `classifyAnalysisFailure(err, modelLabel)` (`server/src/routes/failure-taxonomy.ts`, with W2/W3b's codes: `analyzer-reasoning-overflow`, `analyzer-timeout`, `analyzer-endpoint-missing`, and `auth` for a 401/403 or `AnalyzerKeyOriginError`).
- **Produces:**
  - `preparePersonaBatch(bookDir)` returns `resolvePersonaGpuPlan(bookDir)` whenever `personaSharesGpu()` is true, and `{ onCpu: false, keepAlive: 0 }` otherwise. The plan fields reach only the Ollama transport; an endpoint ignores them.
  - `runPersonaPrePass` runs when `personaSharesGpu()` is true. It rethrows the whole-job error classes: `AnalyzerUnreachableError`, `AnalyzerEndpointMissingError`, `AnalyzerTimeoutError`, and any error `classifyAnalysisFailure(err, 'Persona generation')` codes `auth` (owner decision B2: key-origin, 401/403, and a 400 whose body is Google's rejected-key text). A pause that aborts a persona call returns without recording a per-character failure.
  - Both persona calls (pre-pass and lazy) pass `signal: job.controller.signal`.
  - The design POST route's backstop ends the job with `type: 'idle'` for an `AnalysisAbortedError` after a pause. It keeps its `lock-contention` branch. Every other error carries `classifyAnalysisFailure(e, 'Persona generation').code` instead of `unknown`: `auth` for a 401/403 `AnalyzerHttpError` or an `AnalyzerKeyOriginError`, `analyzer-timeout` for an `AnalyzerTimeoutError`, `analyzer-endpoint-missing` for an `AnalyzerEndpointMissingError`, and `unknown` only for an error the taxonomy does not recognise. What reaches it is the pre-pass's wholesale rethrows; a lazy persona failure does not, because `6222e483` gave that call its own per-character catch (`:525-543`). Whether the job ends is unchanged (P20).
  - The design loop's lazy persona is skipped when `personaSharesGpu()` is true.
- **Keeps green:**
  - `src/routes/cast-design.test.ts` (all, after the mechanical edits and the busy-box second-argument fix in Step 1);
  - `src/routes/book-op.design-jobs.test.ts` (after its mock is fixed);
  - `src/routes/voice-style.test.ts`;
  - `src/workspace/cast-lock.race.test.ts`. Its factory mocks omit `personaSharesGpu`, and it never runs the pre-pass or the design loop, so the missing export is never read.
  - `src/tts/prepare-persona-batch.test.ts`;
  - `src/routes/openapi-design-parity.test.ts` (it pins `CastDesignEvent.type`, the single-design codes AND the shape of `CastDesignEvent.code` at `:248-251`, which 4.6b's `anyOf` breaks until `:250` is edited) and the frontend `src/lib/api.design-sse-event-types.test.ts`.

- [ ] **Step 1: Write the failing tests**

`server/src/tts/prepare-persona-batch.test.ts`. Replace lines 1-18 (header and the `voice-style` mock) with:
```ts
/* Tests for preparePersonaBatch. Because preparePersonaBatch and its callee
   (resolvePersonaGpuPlan) live in the same module, we cannot stub it out of
   the module itself. Instead we control its transitive dependencies so the
   real call stack runs, but hits mocked infrastructure:
   - personaSharesGpu       via vi.mock('../analyzer/voice-style.js')  (#3084 W4)
   - resolvePersonaGpuPlan  via generation.js / design-lock.js mocks
*/
import { describe, it, expect, afterEach, vi } from 'vitest';

/* --- top-level mocks -------------------------------------------------------- */

/* personaSharesGpu is the outermost gate (local Ollama, or an endpoint on the Qwen card);
   mock it so each test can flip it without re-importing. */
const mockPersonaSharesGpu = vi.fn<() => boolean>();
vi.mock('../analyzer/voice-style.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/voice-style.js')>();
  return { ...actual, personaSharesGpu: mockPersonaSharesGpu };
});
```
Replace the `describe('preparePersonaBatch', …)` block (lines 36-66) with:
```ts
describe('preparePersonaBatch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('persona shares the GPU (local, or a same-card endpoint), idle → GPU args with the resident persona keepAlive window', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');

    mockPersonaSharesGpu.mockReturnValue(true);
    vi.mocked(gen.activeGenerationBooks).mockReturnValue([]);

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: false, keepAlive: 300 });
  });

  it('persona shares the GPU, render active → CPU args', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
    const gen = await import('../routes/generation.js');

    mockPersonaSharesGpu.mockReturnValue(true);
    vi.mocked(gen.activeGenerationBooks).mockReturnValue(['book-1']); // render active → CPU

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: true, keepAlive: 0 });
  });

  it('persona does not share the GPU (gemini, or an endpoint on no card / another card) → off-GPU args', async () => {
    const { preparePersonaBatch } = await import('./persona-gpu-plan.js');

    mockPersonaSharesGpu.mockReturnValue(false);

    expect(await preparePersonaBatch('/a')).toEqual({ onCpu: false, keepAlive: 0 });
  });
});
```
`server/src/routes/cast-design.test.ts`. Replace lines 52-62 with:
```ts
const { personaMock, personaSharesGpuMock } = vi.hoisted(() => ({
  personaMock: vi.fn(),
  /* Default false (a Gemini persona) so the pre-pass is a no-op for all the existing tests
     that have nothing to do with the shared-GPU persona path (#3084 W4: local Ollama, or an
     endpoint on the Qwen card). */
  personaSharesGpuMock: vi.fn().mockReturnValue(false),
}));

vi.mock('../analyzer/voice-style.js', () => ({
  generateVoiceStylePersona: personaMock,
  personaSharesGpu: personaSharesGpuMock,
}));
```
Then apply these mechanical replacements. The line numbers are `b015aae9`'s (the plan's were main's, 54 lines earlier, and it missed two uses):
- `resolvePersonaEngineMock.mockReturnValue('local');` → `personaSharesGpuMock.mockReturnValue(true);` at `:1197`, `:1254`, `:1331`, `:1382`, `:1433`, `:1486`.
- `resolvePersonaEngineMock.mockReturnValue('gemini');` → `personaSharesGpuMock.mockReturnValue(false);` at `:1190` (the `afterEach`) and `:1288`, and at two uses the plan did not list: `:523` (the #3027/2 test) and `:1715` (the PR #3161 persona-write lock test).
- `:1309`: `expect(resolvePersonaEngineMock).toHaveBeenCalled();` → `expect(personaSharesGpuMock).toHaveBeenCalled();`, and the `:1308` comment "resolvePersonaEngineMock must have been called" → `personaSharesGpuMock`.
- `:1286` title → `it('no shared GPU (gemini, or an endpoint on no card): pre-pass returns early — preparePersonaBatch NOT called', async () => {`
- `:1287` comment → `// personaSharesGpuMock is already reset to false by afterEach; make it explicit.`
- `:1305` comment → `// personaSharesGpu() is false → pre-pass returns immediately.`
- The header comments at `:54-55` and `:64-68` name `resolvePersonaEngineMock`; reword them to `personaSharesGpuMock`.
- The busy-box case (`:1276-1279`): change `{ onCpu: true, keepAlive: 0 }` in its `toHaveBeenCalledWith(expect.objectContaining({ id: 'hart' }), …)` to `{ onCpu: true, keepAlive: 0, signal: expect.any(AbortSignal) }`. The exact match would otherwise fail on the new `signal` property.

In `server/src/routes/book-op.design-jobs.test.ts`, replace the `resolvePersonaEngine: vi.fn().mockReturnValue('gemini'),` entry of the `vi.mock('../analyzer/voice-style.js', …)` factory (`:41-44`) with `personaSharesGpu: vi.fn().mockReturnValue(false),`.

Then, inside `describe('cast-design persona pre-pass', …)` and before its closing `});` (`:1524`), append:
```ts
  it('an endpoint unreachable error in the pre-pass ends the job wholesale, like Ollama\'s', async () => {
    /* #3084 W4 — AnalyzerUnreachableError from any transport (LocalUnreachableError is its Ollama
       subclass) would fail every remaining character identically: one terminal error, no designs. */
    personaSharesGpuMock.mockReturnValue(true);

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: 0 });

    const vs = await import('../analyzer/voice-style.js');
    const { AnalyzerUnreachableError } = await import('../analyzer/errors.js');
    vi.spyOn(vs, 'generateVoiceStylePersona').mockRejectedValue(
      new AnalyzerUnreachableError('Endpoint Lab at http://127.0.0.1:18080 is unreachable', 'openai'),
    );

    const qwen = await import('./qwen-voice.js');
    const designSpy = vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-hart',
      url: '/v/hart.mp3',
    });

    const extraChar = { id: 'nova', name: 'Nova', role: 'supporting', color: 'blue', voiceUuid: 'nova' };
    writeBookOnDisk([...characters, extraChar]);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['hart', 'nova'] });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.message).toContain('Endpoint Lab at http://127.0.0.1:18080 is unreachable');
    expect(events.some((e) => e.type === 'character_failed')).toBe(false);
    expect(designSpy).not.toHaveBeenCalled();

    writeBookOnDisk(characters);
  });

  it.each<[string, string, () => Promise<Error>]>([
    ['AnalyzerEndpointMissingError', 'analyzer-endpoint-missing', async () => {
      const { AnalyzerEndpointMissingError } = await import('../analyzer/errors.js');
      return new AnalyzerEndpointMissingError('lab', 'persona');
    }],
    ['AnalyzerKeyOriginError', 'auth', async () => {
      const { AnalyzerKeyOriginError } = await import('../analyzer/errors.js');
      return new AnalyzerKeyOriginError('lab', 'Lab');
    }],
    ['AnalyzerHttpError 401', 'auth', async () => {
      const { AnalyzerHttpError } = await import('../analyzer/errors.js');
      return new AnalyzerHttpError('openai', 401, 'invalid api key', 'Endpoint qwen3 returned 401: invalid api key');
    }],
    ['AnalyzerHttpError 403', 'auth', async () => {
      const { AnalyzerHttpError } = await import('../analyzer/errors.js');
      return new AnalyzerHttpError('openai', 403, 'forbidden', 'Endpoint qwen3 returned 403: forbidden');
    }],
    /* Owner decision B2: Google's OpenAI-compatible endpoint answers a bad key with a 400 whose body matches
       GEMINI_KEY_REJECTED; the taxonomy codes it `auth`, so it is a whole-job error too. */
    ['AnalyzerHttpError 400 (Google rejected the key)', 'auth', async () => {
      const { AnalyzerHttpError } = await import('../analyzer/errors.js');
      return new AnalyzerHttpError('openai', 400, 'API key not valid. Please pass a valid API key. [API_KEY_INVALID]', 'Endpoint qwen3 returned 400: API_KEY_INVALID');
    }],
    ['AnalyzerTimeoutError', 'analyzer-timeout', async () => {
      const { AnalyzerTimeoutError } = await import('../analyzer/errors.js');
      return new AnalyzerTimeoutError('openai', 'qwen3', 1_800_000, 'ceiling');
    }],
  ])('a %s in the pre-pass ends the job once (code %s) instead of failing every character', async (_name, code, makeErr) => {
    personaSharesGpuMock.mockReturnValue(true);

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: 0 });

    const vs = await import('../analyzer/voice-style.js');
    const err = await makeErr();
    vi.spyOn(vs, 'generateVoiceStylePersona').mockRejectedValue(err);

    const qwen = await import('./qwen-voice.js');
    const designSpy = vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-hart',
      url: '/v/hart.mp3',
    });

    const extraChar = { id: 'nova', name: 'Nova', role: 'supporting', color: 'blue', voiceUuid: 'nova' };
    writeBookOnDisk([...characters, extraChar]);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['hart', 'nova'] });

    const events = parseSse(res.text);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    /* Task 4.6a stops at "ends once, no character_failed": the backstop still writes `unknown` until Task 4.6b
       adds its classified code. Task 4.6b adds here: expect(events.find((e) => e.type === 'error')?.code).toBe(code); */
    expect(events.some((e) => e.type === 'character_failed')).toBe(false);
    expect(events.some((e) => e.type === 'idle')).toBe(false);
    expect(designSpy).not.toHaveBeenCalled();

    writeBookOnDisk(characters);
  });

  it('a non-auth HTTP error (500) in the pre-pass stays a per-character failure', async () => {
    personaSharesGpuMock.mockReturnValue(true);

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: 0 });

    const vs = await import('../analyzer/voice-style.js');
    const { AnalyzerHttpError } = await import('../analyzer/errors.js');
    vi.spyOn(vs, 'generateVoiceStylePersona').mockRejectedValue(
      new AnalyzerHttpError('openai', 500, 'boom', 'Endpoint qwen3 returned 500: boom'),
    );

    const qwen = await import('./qwen-voice.js');
    vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({ voiceId: 'qwen-hart', url: '/v/hart.mp3' });

    const extraChar = { id: 'nova', name: 'Nova', role: 'supporting', color: 'blue', voiceUuid: 'nova' };
    writeBookOnDisk([...characters, extraChar]);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['hart', 'nova'] });

    const events = parseSse(res.text);
    expect(events.filter((e) => e.type === 'character_failed')).toHaveLength(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    writeBookOnDisk(characters);
  });

  it('the pre-pass hands the job abort signal to each persona call; a pause mid-call records no failure', async () => {
    /* #3084 W4 — with Task 4.5's real-HTTP proof (`aborting the caller signal aborts an in-flight
       endpoint persona call`), this shows pausing a design job cancels an in-flight persona request. */
    personaSharesGpuMock.mockReturnValue(true);

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: 0 });

    const vs = await import('../analyzer/voice-style.js');
    const { AnalysisAbortedError } = await import('../analyzer/errors.js');
    let seen: AbortSignal | undefined;
    vi.spyOn(vs, 'generateVoiceStylePersona').mockImplementation(async (_character, opts) => {
      seen = opts?.signal;
      await request(app).post(`/api/books/${bookId}/cast/design/pause`).send({});
      throw new AnalysisAbortedError('Endpoint qwen3 call aborted (paused or client disconnected).');
    });

    const qwen = await import('./qwen-voice.js');
    const designSpy = vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({ voiceId: 'qwen-hart', url: '/v/hart.mp3' });

    const res = await request(app).post(`/api/books/${bookId}/cast/design`).send({ modelKey: QWEN_KEY, characterIds: ['hart'] });

    const events = parseSse(res.text);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(true);
    expect(events.some((e) => e.type === 'character_failed')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(designSpy).not.toHaveBeenCalled();
  });

  it('the lazy persona call gets the job abort signal; a pause mid-call ends the job idle, not with an error', async () => {
    personaSharesGpuMock.mockReturnValue(false);

    const vs = await import('../analyzer/voice-style.js');
    const { AnalysisAbortedError } = await import('../analyzer/errors.js');
    let seen: AbortSignal | undefined;
    vi.spyOn(vs, 'generateVoiceStylePersona').mockImplementation(async (_character, opts) => {
      seen = opts?.signal;
      await request(app).post(`/api/books/${bookId}/cast/design/pause`).send({});
      throw new AnalysisAbortedError('Endpoint qwen3 call aborted (paused or client disconnected).');
    });

    const qwen = await import('./qwen-voice.js');
    vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({ voiceId: 'qwen-hart', url: '/v/hart.mp3' });

    const res = await request(app).post(`/api/books/${bookId}/cast/design`).send({ modelKey: QWEN_KEY, characterIds: ['hart'] });

    const events = parseSse(res.text);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'idle')).toBe(true);
    /* #3084 W4 — the load-bearing half. The lazy call sits inside the per-character catch
       `6222e483` added, which would otherwise record the abort as a failure against the
       character the user paused on; the job would still end `idle` with no `error`, so the
       two assertions above pass either way. These two are what actually fail without the
       abort check at the top of that catch. */
    expect(events.some((e) => e.type === 'character_failed')).toBe(false);
    expect(events.find((e) => e.type === 'idle')?.failures).toHaveLength(0);
  });

  it('a lazy persona failure stays a per-character failure with its reason string — a reasoning overflow included (#3027/2, #3230)', async () => {
    /* #3084 W4 — CHARACTERISATION, green before and after this PR. `6222e483` (second half of
       #3027) gave the lazy call its own try/catch (cast-design.ts:525-543), so its error is
       recorded per character and the loop moves on; it never reaches the route backstop, so no
       FailureCode is written for it. P20's voice-design carve-out keeps exactly this behaviour,
       and this case is what stops Task 4.5's move of the call into runFreeText (and the new
       `signal` argument) from silently turning it back into a job halt. */
    personaSharesGpuMock.mockReturnValue(false);

    const vs = await import('../analyzer/voice-style.js');
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const overflow = new AnalyzerReasoningOverflowError('openai', 'openai:lab::qwen3', 900);
    vi.spyOn(vs, 'generateVoiceStylePersona').mockRejectedValueOnce(overflow);

    const qwen = await import('./qwen-voice.js');
    const designSpy = vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({ voiceId: 'qwen-nova', url: '/v/nova.mp3' });

    /* hart has no voiceStyle, so the lazy fallback fires and throws; nova HAS one, so it designs
       normally. Order [hart, nova] puts the failure first — a job halt would leave nova undesigned. */
    const extraChar = { id: 'nova', name: 'Nova', role: 'supporting', color: 'blue', voiceUuid: 'nova', voiceStyle: 'a dry, clipped baritone' };
    writeBookOnDisk([...characters, extraChar]);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['hart', 'nova'] });

    const events = parseSse(res.text);
    /* Per character, not job-wide: no terminal error event at all. */
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const failed = events.find((e) => e.type === 'character_failed' && e.characterId === 'hart');
    expect(failed).toBeDefined();
    /* itemFailureReason passes a non-lock error's message through verbatim — a reason STRING, no code. */
    expect(failed?.errorReason).toBe(overflow.message);
    expect(failed).not.toHaveProperty('code');
    /* The run continues to the next character and ends idle with the failure listed. */
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'nova')).toBe(true);
    expect(designSpy).toHaveBeenCalledTimes(1);
    const idle = events.find((e) => e.type === 'idle');
    expect(idle?.failures).toHaveLength(1);
    expect(idle?.failures?.[0].characterId).toBe('hart');

    writeBookOnDisk(characters);
  });

  it('a design job marks no endpoint run, so VoiceDesign can still evict a same-card persona endpoint (#3084 P1)', async () => {
    personaSharesGpuMock.mockReturnValue(true);

    const conc = await import('../analyzer/analyzer-concurrency.js');
    const mark = vi.spyOn(conc, 'markEndpointRunActive');

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: 0 });

    const vs = await import('../analyzer/voice-style.js');
    vi.spyOn(vs, 'generateVoiceStylePersona').mockResolvedValue('A persona.');

    const qwen = await import('./qwen-voice.js');
    vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({ voiceId: 'qwen-hart', url: '/v/hart.mp3' });

    const res = await request(app).post(`/api/books/${bookId}/cast/design`).send({ modelKey: QWEN_KEY, characterIds: ['hart'] });

    expect(res.status).toBe(200);
    expect(mark).not.toHaveBeenCalled();
  });
```
- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm --prefix server run test -- src/tts/prepare-persona-batch.test.ts src/routes/cast-design.test.ts`
  - **Expected:** FAIL.
    - `prepare-persona-batch`: the first case fails with `expected { onCpu: false, keepAlive: 0 } to deeply equal { onCpu: false, keepAlive: 300 }`, because `preparePersonaBatch` still reads the removed `resolvePersonaEngine`.
    - `cast-design`: every test fails at import or first call, because `cast-design.ts` still imports and calls `resolvePersonaEngine`, which the mock no longer provides (`… is not a function`).
    - After Step 3's gate swap alone, these stay red:
      - the `it.each` rows (`character_failed` present), since line 323 records the error per character;
      - both signal cases (`expected undefined to be an instance of AbortSignal`);
      - in Task 4.6b, once its `.code` assertions are added: the `AnalyzerEndpointMissingError`, `AnalyzerTimeoutError` and auth rows, with `expected 'unknown' to be …` (the backstop still writes `unknown`).
    - **Not red, and must not be:** `a lazy persona failure stays a per-character failure…` characterises behaviour already on `main` (`6222e483`). It passes before Step 3 and has to stay green through it — if Step 3 turns it red, the move into `runFreeText` has re-broken #3027's second half.
- [ ] **Step 3: Implement**

`server/src/tts/persona-gpu-plan.ts`:
- Line 3: `import { personaSharesGpu } from '../analyzer/voice-style.js';`
- Replace lines 41-59 with:
```ts
/** Resolve the GPU plan for a persona batch on `bookDir`, returning the
    per-call args to thread into generateVoiceStylePersona. Used by both
    voice-style routes and the bulk pre-pass so the decision lives in exactly
    one place.

    - persona does not share the GPU (gemini, or an OpenAI-compatible endpoint on
      no card or on a card Qwen does not use) → `{ onCpu: false, keepAlive: 0 }`.
    - persona shares the GPU (local Ollama, or an endpoint on the Qwen card, #3084 W4)
      → resolve the plan directly. Only the Ollama transport reads `onCpu`/`keepAlive`;
      for an endpoint the plan is inert, and what "like local" buys it is the design
      job's ordering (personas before VoiceDesign loads — see routes/cast-design.ts).

    `_signal` is kept in the signature for call-site compatibility
    (`routes/cast-design.ts` still passes its job's AbortSignal), but is
    unused — there is nothing here to abort. */
export async function preparePersonaBatch(
  bookDir: string,
  _signal?: AbortSignal,
): Promise<{ onCpu: boolean; keepAlive: string | number }> {
  if (!personaSharesGpu()) return { onCpu: false, keepAlive: 0 };
  return resolvePersonaGpuPlan(bookDir);
}
```
`server/src/routes/cast-design.ts`:
- Line 17 (header bullet) becomes:
```ts
     - `generateVoiceStylePersona` (the selected persona engine) when the character has no persona,
```
- Lines 58-59 (the `voice-style.js` import and `import { LocalUnreachableError } from '../analyzer/ollama.js';`) become the block below. 4.6a imports the first three errors; add `AnalysisAbortedError` in 4.6b, where the backstop uses it. `AnalyzerKeyOriginError` and `AnalyzerHttpError` are not needed (owner decision B2: the `auth` clause covers them):
```ts
import { personaSharesGpu, generateVoiceStylePersona } from '../analyzer/voice-style.js';
import {
  AnalyzerUnreachableError,
  AnalyzerEndpointMissingError,
  AnalyzerTimeoutError,
} from '../analyzer/errors.js';
import { classifyAnalysisFailure } from './failure-taxonomy.js';
```
- Lines 275-294 (the pre-pass doc through its gate) become:
```ts
/** SHARED-GPU persona engines only (local Ollama, or an OpenAI-compatible endpoint on the
    Qwen card — `personaSharesGpu()`, #3084 W4): generate `voiceStyle` personas for all
    base-task characters that lack one, BEFORE the design loop touches the sidecar — so
    persona generation and VoiceDesign don't interleave per-character on one card.
    (Historically this pre-pass also let `preparePersonaBatch`
    reverse-evict the idle resident sidecar model once on a constrained GPU;
    that eviction step is retired — VRAM arbitration for the sidecar's own
    engines now lives in its capacity admission when SEG_CAPACITY_ADMISSION
    is on, or the sequential cast-review/render workflow when it's off.)

    A persona engine that shares no GPU (gemini, or an endpoint on no card / another card)
    keeps its lazy-interleaved persona-gen inside `runDesignJob` unchanged — this function
    returns immediately for it.

    Failure modes:
    - `AnalyzerUnreachableError` (incl. Ollama's `LocalUnreachableError`),
      `AnalyzerEndpointMissingError`, `AnalyzerTimeoutError`, and any error the failure
      taxonomy codes `auth` (`AnalyzerKeyOriginError`, `AnalyzerHttpError` 401/403, a 400
      whose body is Google's rejected-key text) → PROPAGATE (wholesale job abort — every
      remaining character would fail identically).
    - A pause that aborted the call (the job signal reaches the transport) → return;
      nothing is recorded.
    - Any other per-character error → recorded to `job.failures` +
      `character_failed` broadcast + continue (design loop will skip
      characters whose persona we could not set). */
async function runPersonaPrePass(job: DesignJob, tasks: DesignTask[]): Promise<void> {
  if (!personaSharesGpu()) return;
```
- Line 323 (`persona = await generateVoiceStylePersona(character, prep);`) becomes `persona = await generateVoiceStylePersona(character, { ...prep, signal: job.controller.signal });`.
- Line 325 (`if (err instanceof LocalUnreachableError) throw err; // wholesale — propagate`) becomes the block below. The `return` here is correct (it leaves `runPersonaPrePass`; `runDesignJob` ends the job idle):
```ts
        /* A pause aborted the call (the job signal reaches the transport): a clean stop, not a failure. */
        if (job.controller.signal.aborted) return;
        if (
          err instanceof AnalyzerUnreachableError ||
          err instanceof AnalyzerEndpointMissingError ||
          err instanceof AnalyzerTimeoutError ||
          /* Owner decision B2: the taxonomy decides what is a refused key (key-origin, 401/403, and a 400 whose
             body is Google's rejected-key text), so this clause never drifts from the failure codes. */
          classifyAnalysisFailure(err, 'Persona generation').code === 'auth'
        ) {
          throw err; // wholesale — every remaining character would fail the same way
        }
```
- Lines 501-516 (the ENGINE SPLIT comment through the `resolvePersonaEngine() === 'local'` block) become:
```ts
         ENGINE SPLIT: a SHARED-GPU persona engine (local Ollama, or an endpoint on the
         Qwen card) must NOT fall back here. The pre-pass (`runPersonaPrePass`) owns its
         persona-gen; it runs before VoiceDesign loads and uses a safe GPU plan (CPU for
         Ollama when busy). If it failed for this character it already recorded a
         `character_failed` and the character ends up in `job.failures`. Retrying here —
         with VoiceDesign already resident on the GPU — would load the persona model onto
         that card inside `withGpuLoad`, the exact plan-108 OOM this pre-pass was built to
         prevent. Skip silently (no second `character_failed` broadcast — the pre-pass
         already emitted one). */
      let persona = (character.voiceStyle ?? '').trim();
      if (!persona) {
        if (personaSharesGpu()) {
          /* Skip — the pre-pass owns shared-GPU persona-gen and already recorded any
             failure; retrying here while VoiceDesign loads on the same card is the
             plan-108 OOM. */
          continue;
        }
```
Line 528 (`persona = await generateVoiceStylePersona(character);`) becomes `persona = await generateVoiceStylePersona(character, { signal: job.controller.signal });`. The `writeVoiceStylePersona` call at `:529` stays as it is.

The `catch (e)` at `:530-545` keeps its per-character shape — recording to `job.failures`, broadcasting `character_failed`, then `continue` — and this PR must not widen or bypass it. It gains exactly one line, as its first statement, because the job signal now reaches this call. **It is a `break`, not a `return`** (see the Re-pin notes: this catch sits inside the `for (const task of tasks)` loop, and a `return` would skip the final idle `endJob`, so the SSE stream would never close):
```ts
        } catch (e) {
          /* #3084 W4 — a pause aborted the call (the job signal now reaches the transport): a clean
             stop, not a failure. Mirrors the pre-pass catch, but `break`s the loop instead of returning:
             this catch is inside `for (const task of tasks)`, and breaking reaches the final idle
             `endJob` (`:742`), which closes the stream; a `return` would skip it and leak the job.
             Without the check the abort would be recorded as a `character_failed` against the
             character the user paused on, and the loop's abort check (`:391`) would then end the job
             `idle` carrying that spurious failure. */
          if (job.controller.signal.aborted) break;
```
Everything already in that catch, from `const message = …` through `continue;`, is unchanged.

**No ride-out-comment fix is owed any more.** An earlier draft of this task corrected the `#2292` comment at `main :680-687`, which named `ensureCharacterVoiceUuid` and `writeVoiceStylePersona` as persist steps inside a `try` they actually ran before. `6222e483`'s follow-ups fixed that upstream: `ensureCharacterVoiceUuid` now really does run inside the per-character `try`, and `80be2f1d`'s comment (`:713-721`, unchanged since `46e62a34` — `routes/cast-design.ts` has no diff between the two commits) correctly lists `ensureCharacterVoiceUuid`, `designQwenVoiceForCharacter`, `applyOverrideToCastFiles` and `persistEmotionVariant`. Leave it alone; do not re-apply the old edit, and do not claim it as a finding in the PR body.

**4.6b.** In the design POST route's backstop (`await runDesignJob(job, tasks, modelKey!, language, seriesFilter).catch((e) => { … })`, `:917-945`, inside the `runBookJob` callback), keep the `await` and the `lock-contention` branch, insert the pause branch after it, and replace the final `unknown` branch's body. `classifyAnalysisFailure` is already imported by 4.6a; add `AnalysisAbortedError` to the `../analyzer/errors.js` import. Rewrite the comment block at `:918-931` as the Re-pin notes say (drop the "Two literal branches, not a `code` variable" rationale). The branches at `:932-944` become:
```ts
    if (isLockAcquisitionTimeout(e)) {
      endJob(job, {
        type: 'error',
        code: 'lock-contention',
        message: requestFailureMessage(e, (e as Error).message || 'Cast design failed.'),
      });
    } else if (e instanceof AnalysisAbortedError && job.controller.signal.aborted) {
      /* #3084 W4 — defence in depth for a pause. Both persona paths now stop cleanly before this
         point: the pre-pass returns on abort, and the lazy call's own per-character catch
         (`:530-545`, from `6222e483`) breaks out of the loop on abort too. Nothing routinely reaches this branch;
         it exists so that any abort that DOES escape the loop reads as a clean stop rather than a
         `code: 'unknown'` halt. */
      endJob(job, {
        type: 'idle',
        done: job.done,
        total: job.total,
        skipped: job.skipped,
        clonedSkips: job.clonedSkips,
        failures: job.failures,
      });
    } else {
      /* #3084 W4 — every other error that escapes the design loop carries the analysis failure
         taxonomy's code: `auth` for a refused key (401/403) or a key bound to another origin,
         `analyzer-endpoint-missing`, `analyzer-timeout`, and `unknown` only when the taxonomy
         recognises nothing. In practice that is the pre-pass's wholesale rethrows. The LAZY
         persona call does NOT arrive here: it has had its own per-character catch since
         `6222e483` (second half of #3027), so its failure is a `character_failed` carrying a
         reason string and the job carries on — which is what #3230 asked for, and is P20's
         voice-design carve-out. The code is a variable, not a literal: the taxonomy owns this
         set, and `CastDesignEvent.code` admits any `FailureCode`. The message stays the curated one. */
      endJob(job, {
        type: 'error',
        code: classifyAnalysisFailure(e, 'Persona generation').code,
        message: requestFailureMessage(e, (e as Error).message || 'Cast design failed.'),
      });
    }
```
`runPersonaPrePass`'s rethrow no longer names `AnalyzerHttpError` or `AnalyzerKeyOriginError` (owner decision B2), so neither is imported here.

**4.6b.** `openapi.yaml`, `components.schemas.CastDesignEvent` (starts `:5091`; the `code` property is `:5166-5175`):
- In its `description` (`:5134-5135`; the text spans a line break after `throw`, with 12-space indentation inside the block scalar: match across the break and keep the indentation), replace `` `unknown` (defensive catch-all for any other unexpected throw escaping the design loop). `` with `` any other throw escaping the design loop — a whole-job persona-engine failure included — carries its analysis `FailureCode` (#3084 W4: `auth`, `analyzer-endpoint-missing`, `analyzer-timeout`, …), and `unknown` when the taxonomy recognises nothing. A per-character persona failure does not escape the loop and is reported as `character_failed` instead. ``
- Replace the `code` property's `type: string` + `enum: [sidecar_unavailable, gpu_contention, unsupported_language, lock-contention, language_unset, unknown]` lines with the `anyOf` below, and KEEP the `description: |` block scalar directly under it (owner decision B1; the parity test below still requires it):
```yaml
        code:
          anyOf:
            - type: string
              enum: [sidecar_unavailable, gpu_contention, unsupported_language, lock-contention, language_unset, unknown]
            - $ref: '#/components/schemas/FailureCode'
          description: |
            error only — machine-readable whole-run abort reason.
            …(the existing block-scalar text, unchanged)…
```
- Edit `server/src/routes/openapi-design-parity.test.ts:250` (the Cast case only): replace the `toMatch(/code:\r?\n\s+type: string\r?\n\s+enum:.*\r?\n\s+description: \|/)` regex with `toMatch(/code:\r?\n\s+anyOf:\r?\n(?:\s+.*\r?\n)*?\s+description: \|/)`. Keep `:251`; leave the Single case (`:254`) alone.
- Re-proof, with the output pasted in the PR body (#2509 B2): turn the Cast `description: |` into a plain scalar; the edited test must go red. Restore.

Then run `npm run openapi:types`. `src/lib/api.ts` reads no `CastDesignEvent['code']` member by literal (`git grep -n "sidecar_unavailable\|gpu_contention" -- src` prints only `src/lib/api-types.ts`), so the widened union compiles unchanged.

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm --prefix server run test -- src/tts/prepare-persona-batch.test.ts src/routes/cast-design.test.ts src/routes/book-op.design-jobs.test.ts src/routes/voice-style.test.ts src/workspace/cast-lock.race.test.ts src/analyzer/voice-style.test.ts src/analyzer/voice-style.endpoint.test.ts src/analyzer/voice-style.timeout.test.ts` (4.6a), then `npm run lint` and `npm run check:cycles`.
  - **Then run:** `npm --prefix server run test -- src/routes/openapi-design-parity.test.ts`, `npm test -- src/lib/api.design-sse-event-types.test.ts`, `npm run typecheck` and `git grep -n -E "resolvePersonaEngine|generatePersonaViaOllama" -- server/src`.
  - **Expected:** PASS; tsc clean; the grep finds nothing.
  - **What this proves together:** `the pre-pass hands the job abort signal to each persona call…` shows the job signal reaches `generateVoiceStylePersona`. Task 4.5's `aborting the caller signal aborts an in-flight endpoint persona call` shows that signal cancels a real HTTP request. So pausing a design job aborts an in-flight endpoint persona call.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Local-only rethrow:** revert line 325 to `if (err instanceof LocalUnreachableError) throw err;` (importing `LocalUnreachableError` from `../analyzer/errors.js`). Expected red: `an endpoint unreachable error in the pre-pass ends the job wholesale…` (`errorEvent` undefined).
  2. **Selection errors:** remove the `AnalyzerUnreachableError`, `AnalyzerEndpointMissingError` and `AnalyzerTimeoutError` alternatives. Expected red: `an endpoint unreachable error in the pre-pass ends the job wholesale…` and the endpoint-missing and timeout `it.each` rows (`character_failed` present, `idle` emitted). The auth rows stay green (they go through mutation 5).
  3. **Plan gate:** in `preparePersonaBatch`, replace `!personaSharesGpu()` with `true`. Expected red: `persona shares the GPU…, idle → GPU args…`.
  4. **Pre-pass gate:** in `runPersonaPrePass`, replace `if (!personaSharesGpu()) return;` with `return;`. Expected red: `local: all personas generated before the first designQwenVoiceForCharacter…` (`preparePersonaBatch` called 0 times).
  5. **Auth clause:** replace `classifyAnalysisFailure(err, 'Persona generation').code === 'auth'` with `false`. Expected red: the key-origin, 401, 403 and 400-key `it.each` rows (`character_failed` present, `idle` emitted). Control: change it to `true`; expected red: `a non-auth HTTP error (500) in the pre-pass stays a per-character failure` (an `error` event instead of two `character_failed`).
  6. **Classified code (4.6b):** in the backstop's final branch, replace `classifyAnalysisFailure(e, 'Persona generation').code` with `'unknown'`. Expected red: the `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError`, `AnalyzerHttpError 401`, `AnalyzerHttpError 403` and `AnalyzerTimeoutError` pre-pass rows (`expected 'unknown' to be 'analyzer-endpoint-missing'`, and so on). The lazy-path case is deliberately NOT among them — its failure never reaches the backstop.
  7. **Job signal:**
     - In the pre-pass call, pass `prep` instead of `{ ...prep, signal: job.controller.signal }`. Expected red: `the pre-pass hands the job abort signal to each persona call…` (`seen` undefined).
     - In the lazy call, drop `{ signal: job.controller.signal }`. Expected red: `the lazy persona call gets the job abort signal…`.
  8. **Clean pause:**
     - (4.6a) Delete `if (job.controller.signal.aborted) return;` from the pre-pass catch. Expected red: `…a pause mid-call records no failure` (`character_failed` present).
     - (4.6a) Delete `if (job.controller.signal.aborted) break;` from the **lazy** catch. Expected red: `the lazy persona call gets the job abort signal; a pause mid-call ends the job idle, not with an error` — on its `character_failed`/`failures` assertions, NOT on its `error`/`idle` ones, which stay green. If the test goes red on the `error` assertion instead, the abort is escaping the catch and the diff is wrong.
     - (4.6b, "8c") Prove the backstop's `AnalysisAbortedError` branch. Deleting it alone stays GREEN (with both per-path abort checks in place nothing reaches it), and deleting it together with the lazy check does NOT show it works either: without the lazy check the catch swallows the abort as a `character_failed` and nothing reaches the backstop, so the `error` assertion stays green. Instead, first change the lazy check to `if (job.controller.signal.aborted) throw e;`. The lazy-pause test must still be GREEN, with the backstop's `AnalysisAbortedError` branch ending the job idle. Then delete the backstop branch: expected red on `events.some((e) => e.type === 'error')` (code `unknown`). Restore both.
  9. **No run mark:** at the top of `runDesignJob`, add `const releaseRun = markEndpointRunActive(['lab']);` (importing it from `../analyzer/analyzer-concurrency.js`). Expected red: `a design job marks no endpoint run…` (`mark` called once). Remove.
  10. **Lazy per-character catch (guards `6222e483`, not this PR's own code):** in `runDesignJob`, replace the lazy persona `catch (e) { … continue; }` body with `throw e;`. Expected red: `a lazy persona failure stays a per-character failure…` (an `error` event appears, `nova` is never designed, `designSpy` called 0 times). Restore.
- [ ] **Step 6: Commit** — two commits (Task 4.5 is already its own commit):
```bash
# 4.6a
git add server/src/analyzer/voice-style.ts server/src/tts/persona-gpu-plan.ts server/src/tts/prepare-persona-batch.test.ts server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts server/src/routes/book-op.design-jobs.test.ts
git commit -m "feat(server): treat a same-card persona endpoint like local in the design job"
# 4.6b
git add server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts openapi.yaml src/lib/api-types.ts server/src/routes/openapi-design-parity.test.ts
git commit -m "feat(server): carry the failure code on a cast design error"
```

---

### Task 4.7: Advanced Settings — the persona engine picker offers endpoint models (consumes Task 3d.4c's `analyzer-engine` UI wiring)

> **Re-pin notes (2026-10-23, against b015aae9) — read first; these override the steps below where they differ.**
> - **The view does NOT fetch the catalog** (#3710 D4/D5 changed this). `advanced.tsx:263-264` reads `const analyzerCatalog = useAppSelector((s) => s.account.analyzerCatalog);` and builds `analyzerEndpointModels` with `useMemo(() => endpointModelOptions(analyzerCatalog), …)`; there is no `api.getAnalyzerModels()` call on mount, and the `advanced.test.tsx` api mock (`:17-31`) has no `getAnalyzerModels`. `renderView` (`:163`) is `renderView(analysisEngine: 'local' | 'gemini' = 'local', catalog: AnalyzerCatalog | null = null)` and dispatches `fetchAnalyzerCatalog.fulfilled(catalog, …)`; the existing comment at `:1135-1137` says "these tests seed the store rather than mocking a per-view api.getAnalyzerModels() call". The plan's intro bullet about "`advanced.tsx`'s single `api.getAnalyzerModels()` fetch on mount" is therefore stale. In the test below, delete the `mockGetAnalyzerModels.mockResolvedValue(...)` call and replace `renderView();` with the seeded form shown (Step 1). `AnalyzerCatalog` is already imported (`:15`), `mockGetConfig` is `vi.mocked(api.getConfig)` (`:33`) and `FIXTURE_CONFIG` exists (`:59`).
> - **Signatures differ from the plan's prose.** `endpointModelOptions(catalog: AnalyzerCatalog | null | undefined)`; its option labels are `` `${group.label || group.id} · ${model.label || model.model}` ``, not the bare model name; `analyzerEngineOptions(staticValues, endpointModels, current, labels = {})` has a fourth `labels` parameter. The test asserts option values only, so no test change.
> - **`allKnobDescriptors` import moved.** `src/lib/api.ts:70` is now `api.ts:87`; the path `'../../server/src/config/descriptors'` is unchanged and still resolves from `src/views/`.
> - **Confirmed, no drift.** `analyzer-engine-options.ts` exists with both exports. `override-row.tsx:451` branches on `descriptor.type === 'analyzer-engine'` and reads `descriptor.options`, so it is generic. `value.analyzerEngine` (labels, source note, local warning) is built only for the fallback knob (`analyzer/fallback-target.ts:42`), so the persona row shows raw labels and no fallback copy. 3d.4c's case "offers off, local, gemini and every endpoint model, and saves the picked endpoint model id" exists at `override-row.test.tsx:1615`, so mutation 1 holds. The persona knob is still `type: 'enum'` at `registry.ts:1170` until Task 4.4, so Step 2's predicted red holds. The pre-start grep for `analyzerEndpointModels` passes (`advanced.tsx:609`).
> - **Dependency and boundary.** Depends on Task 4.4 only (it can run in parallel with the others). Tiny: `advanced.test.tsx` persona describe, mutations 1–2.

**F4 (owner, 2026-09-13): the generic `analyzer-engine` picker UI is landed, not planned, by Task 3d.4c (`w3cd.md:10268-10306`), for `analyzer.fallback.target`.** This task only reuses it for the persona knob. Nothing here recreates any of the following:
- `src/lib/analyzer-engine-options.ts` (created by 3d.4c, **not** `persona-engine-options.ts`): `export interface AnalyzerEngineOption { value: string; label: string }`, `export function endpointModelOptions(catalog: AnalyzerCatalog): AnalyzerEngineOption[]`, `export function analyzerEngineOptions(staticValues: readonly string[], endpointModels: readonly AnalyzerEngineOption[], current: string): AnalyzerEngineOption[]` (`w3cd.md:10281-10288`);
- `src/components/settings/override-row.tsx`'s `analyzer-engine` branch in `KnobControl` (reads `descriptor.options`, not a hard-coded list), `OverrideRowProps.analyzerEndpointModels?: AnalyzerEngineOption[]`, and the `OverrideRow` signature/prop pass-through (3d.4c's Files list, `w3cd.md:10272`);
- `src/views/advanced.tsx`'s pass-through of the store-held analyzer catalog to every row (3d.4c's Files list, `w3cd.md:10273`; the catalog is read from `s.account.analyzerCatalog`, not fetched in the view, see the Re-pin notes).

**Before starting, confirm 3d.4c has merged:** `git grep -n "export function analyzerEngineOptions\|export function endpointModelOptions" src/lib/analyzer-engine-options.ts` finds both exports, and `git grep -n "analyzerEndpointModels" src/components/settings/override-row.tsx src/views/advanced.tsx` finds the prop threaded through both files. If either is missing, stop and report it as a dependency gap — do not rebuild either piece under a different name; that would produce two competing implementations of the same picker.

**What this task actually does:** nothing to `src/lib/analyzer-engine-options.ts`, `override-row.tsx` or `advanced.tsx` — the wiring is descriptor-driven (`descriptor.type === 'analyzer-engine'` and `descriptor.options`), not persona-specific, so once Task 4.4 relabels `analyzer.personaGeneration.engine` to `type: 'analyzer-engine'`, 3d.4c's existing picker renders it with no additional frontend code. This task adds only persona-specific regression coverage proving that.

**Files:**
- Test: Append a describe to `src/views/advanced.test.tsx` only, proving the **persona** knob's row specifically (not the fallback knob's, which 3d.4c's own tests at `w3cd.md:10350-10399`/`10406-10440` already cover) offers `local`, `gemini` and every endpoint model. No change to `src/components/settings/override-row.test.tsx` — see the corrected Step 1 note below for why the earlier draft's cases there are deleted rather than kept.
- No change to `src/lib/analyzer-engine-options.ts`, `src/components/settings/override-row.tsx` or `src/views/advanced.tsx`.

**Interfaces:**
- **Consumes:**
  - `KnobDescriptor.type` `'analyzer-engine'` (Task 3d.4b, reused by Task 4.4's persona descriptor);
  - `AnalyzerEngineOption`, `analyzerEngineOptions`, `endpointModelOptions` (Task 3d.4c, `src/lib/analyzer-engine-options.ts`) and `OverrideRowProps.analyzerEndpointModels` (Task 3d.4c);
  - W3c's `api.getAnalyzerModels()`, returning `AnalyzerCatalog` (`src/lib/types.ts`, generated from `components['schemas']['AnalyzerCatalog']`, Task 3c.6). Its shape (master contract): `{ groups: Array<{ kind: 'ollama' | 'gemini' | 'endpoint'; id: string; label: string; status: 'ok' | 'fallback' | 'error'; error?: string; models: Array<{ id: string; label: string; contextTokens?: number; outputTokens?: number; capability?: ModelCapabilityRecord; offeredReasoningLevels?: string[] }> }> }`. An endpoint group's `id` is the endpoint id, its `label` the endpoint name, and each entry's `label` the bare model name.
- **Produces:** persona-specific test coverage only; no new production symbol (Task 3d.4c owns the shared ones).
- **Keeps green:**
  - `src/components/settings/override-row.test.tsx` (all, including Task 3d.4c's fallback-knob cases);
  - `src/views/advanced.test.tsx` (all, including the device-knob picker cases);
  - `src/test/a11y.test.tsx`;
  - `src/lib/api.config.test.ts`.

- [ ] **Step 1: Write the failing tests**

**Corrected (review pass 1, 2026-09-13): the earlier draft's `override-row.test.tsx` cases hand-built `type: 'analyzer-engine'` directly into their fixture (`makeDescriptor({ …, type: 'analyzer-engine', … })`), so they could never fail — they exercise 3d.4c's generic picker with a persona-shaped fixture, which Task 3d.4c's own fallback-knob cases and mutation 2 (delete the `analyzer-engine` branch in `KnobControl`) already prove. Deleted here rather than kept as dead weight; do not re-add them.** The regression this task actually needs to guard — "the persona knob's registry descriptor really is `type: 'analyzer-engine'`" — is Task 4.4's own job (`registry.test.ts`'s `is an analyzer-engine knob…` case), not a frontend rendering test with a fixture that assumes the answer.

Append to `src/views/advanced.test.tsx` (reusing `renderView`'s catalog seeding — Task 3d.4c added it for the fallback knob; there is no `getAnalyzerModels` mock to reuse). `renderView()` still needs `mockGetConfig.mockResolvedValue(...)` to render anything (this file's own `vi.mocked(api.getConfig)` spy).

**Corrected, review pass 3, item 3: cannot import `mockGetConfig` through this file's mocked `'../lib/api'` at all.** `src/views/advanced.test.tsx:17-31` at `80be2f1d`, re-pinned from `:16-30` (`advanced.test.tsx` changed between the two commits) is `vi.mock('../lib/api', () => ({ api: { … } }))` — a **factory** mock that replaces the whole module with only that literal object. There is no real `mockGetConfig` (or any other named export) left to import from `'../lib/api'` in this file; any such import resolves against the factory's return value, which has none. So this task imports the same thing `src/lib/api.ts` itself imports, directly — `allKnobDescriptors` from the server module, at `src/lib/api.ts:87`'s exact path at `b015aae9` (`import { allKnobDescriptors } from '../../server/src/config/descriptors';`), adjusted for this test file's own directory. `src/views/advanced.test.tsx` sits at the same depth as `src/lib/api.ts` (`src/views/` vs. `src/lib/`), so the identical relative path resolves the same way:
```tsx
/* ── Persona engine row reuses Task 3d.4c's shared catalog fetch (#3084 W4, F4) ── */
import { allKnobDescriptors } from '../../server/src/config/descriptors';

describe('AdvancedView — persona engine row (analyzer-engine picker)', () => {
  it('lists endpoint models from the analyzer catalog in the persona engine row', async () => {
    // allKnobDescriptors() projects the real server registry (server/src/config/registry.ts) —
    // the same function src/lib/api.ts's mockGetConfig() calls to build MOCK_CONFIG_DESCRIPTORS.
    // Reading it directly here, rather than hand-typing `type: 'analyzer-engine'` into a fixture,
    // catches a regression in Task 4.4's registry change without going through the mocked api
    // module at all (review pass 1 + review pass 2 + review pass 3, item 3).
    const personaDescriptor = allKnobDescriptors().find((d) => d.key === 'analyzer.personaGeneration.engine');
    expect(personaDescriptor?.type).toBe('analyzer-engine');
    const PERSONA_CONFIG: ConfigResponse = {
      ...FIXTURE_CONFIG,
      groups: [{ id: 'analyzer-models', label: 'Analyzer models', help: 'Models.', risk: 'low', collapsedByDefault: false }],
      descriptors: [{ ...personaDescriptor!, group: 'analyzer-models' }],
      values: {
        'analyzer.personaGeneration.engine': {
          key: 'analyzer.personaGeneration.engine',
          effective: 'gemini',
          source: 'default',
          locked: false,
          overridden: false,
        },
      },
    };
    mockGetConfig.mockResolvedValue(PERSONA_CONFIG);
    /* The view reads the catalog from the store (s.account.analyzerCatalog, advanced.tsx:263), which renderView
       seeds with fetchAnalyzerCatalog.fulfilled; there is no per-view api.getAnalyzerModels() call to mock. */
    renderView(
      'local',
      { groups: [{ kind: 'endpoint', id: 'lab', label: 'Lab box', status: 'ok', models: [{ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b' }] }] } as unknown as AnalyzerCatalog,
    );
    const select = (await screen.findByRole('combobox', { name: 'Persona generation engine' })) as HTMLSelectElement;
    await waitFor(() =>
      expect([...select.options].map((o) => o.value)).toEqual(['local', 'gemini', 'openai:lab::qwen3-30b']),
    );
  });
});
```
- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm test -- src/views/advanced.test.tsx`
  - **Expected:** FAIL until Task 4.4's registry change has landed: `personaDescriptor?.type` reads `'enum'` on `main`, so `expect(personaDescriptor?.type).toBe('analyzer-engine')` fails before rendering is even reached. Once Task 4.4 lands, PASS with no further frontend code — Task 3d.4c's generic picker already renders any `'analyzer-engine'`-typed descriptor. If it still fails after Task 4.4 lands, the gap is in 3d.4c's wiring (see the note above this task); report it rather than re-adding the removed generic module here.
- [ ] **Step 3: Implement**
None expected in this task, per the note above. If Step 2 is still red after Task 4.4, the fix belongs to whatever narrow gap Task 3d.4c's diff left (e.g. `advanced.tsx` reading `descriptor.key === 'analyzer.fallback.target'` instead of `descriptor.type === 'analyzer-engine'`) — fix that one line, not a parallel module.
- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm test -- src/views/advanced.test.tsx src/test/a11y.test.tsx src/lib/api.config.test.ts`, then `npm run typecheck`.
  - **Expected:** PASS.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. In `override-row.tsx`'s `KnobControl`, delete the `'analyzer-engine'` branch. Expected red (both this task's case AND Task 3d.4c's fallback-knob cases, proving one shared code path): `lists endpoint models from the analyzer catalog in the persona engine row` here, and Task 3d.4c's own `offers off, local, gemini and every endpoint model…` case in `override-row.test.tsx`.
  2. In `registry.ts`, change the persona knob's descriptor back to `type: 'enum'` (Task 4.4's own change, reverted). Expected red: this task's own `expect(personaDescriptor?.type).toBe('analyzer-engine')` assertion, before rendering — `mockGetConfig()` reflects it immediately, since its descriptors come from `allKnobDescriptors()` reading the live registry (no separate mock entry to also revert). Restore.
- [ ] **Step 6: Commit**
```bash
git add src/views/advanced.test.tsx
git commit -m "test(frontend): cover the persona engine row through the shared analyzer-engine picker"
```

No Playwright spec. The spec's E2E list names no persona case. The change is one control inside an existing Advanced Settings row; it crosses no router, redux or layout seam; and the RTL tests drive the real `AdvancedView` → `OverrideRow` render path.

---

### Task 4.8: Ship

> **Re-pin notes (2026-10-23, against b015aae9) — read first; these override the steps below where they differ.**
> - **Invariant numbering: the new one is item 8.** `docs/features/284-openai-compatible-analyzer.md:61` already has "7. **A reasoning overflow points at the settings that fix it.**". Add "8. **Persona generation.**" and write "(invariant 8)" in the PR body. The "Routes (server)" bullet (`:81`) and "Manual acceptance walkthrough" steps 1–4 (`:88–95`) exist, so walkthrough step 5 is next. Two stale sentences in that file belong to this diff (chores the work exposed): `:45` says the `PERSONA_GEN_ENGINE` enum "gains [openai] only in PR 3d" (PR 3d did not do that; this wave does), and `:82` says the eviction latch is "shared with Ollama" (#3710 deleted the endpoint latch). Fix both.
> - **#3230 is CLOSED** (2026-09-12, COMPLETED). The PR body says that this PR keeps the per-character lazy behaviour #3230 asked for; it does not say the issue is left open. `Refs #3230` is optional.
> - **On-box: A109 stays UNCHANGED, and the PR body says so (owner decision B3).** Row A109 (`onbox-acceptance-register.md:5887`, owed against wave 4; its changelog says "wave 4's ship PR discharges or narrows it") is this wave's persona-endpoint card handover; A116 (#3710) covers the analysis-side same-card unload mechanism. Leaving the text alone means no register edit, so no `register:build`, no `check:onbox-register` and no live-view publish. The on-box Group A next-id marker (`<!-- next-id: A118 -->` at `:1845` today) is minted at commit time: if a row were ever added, re-read the marker then and bump it in the same commit; this PR adds none.
> - **The plan had no wiki step.** `docs/wiki/Advanced-Settings.md:140` is Task 4.4's row. `docs/wiki/Troubleshooting.md:307` describes the persona engine as Gemini/Local only: add the endpoint option. `docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md` never mentions personas: add a short note. `scripts/tests/knob-docs-sync.test.mjs` exists (`npm run test:hooks`); run it. The operator runs `npm run wiki:sync` after merge (#3710's precedent); the lane does not.
> - **Release notes and the battery.** `docs/release-notes-next.md` holds the #3084 entries under `## 🗣️ Analyzer, script review & manuscript` (`:315`); `RELEASE_NOTES.md` line 1 is `# Castwright 1.15.0` (only v1.14.0 is tagged, so 1.15.0 is in progress). Both instructions hold. The slow lane's cleaner form is `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts` (`test:slow` is `vitest run --config vitest.config.slow.ts`). `verify:fast:branch` runs lint, typecheck, config:check, check:onbox-register, test:hooks, check:budget-poll, test, test:server, build, test:sidecar, audit and audit:server. #3710 hit an environmental failure in `scripts/tests/stop-app-cli.test.mjs` (a `PORT=8090` collision); a verify child may hit it too. It is not caused by this wave: record it, and treat cloud `verify.yml` as the authority.
> - **The PR body needs a closing issue.** No wave-4 tracking issue existed when audited (a search for "Wave 4" and "3084 persona" found none). `pr-issue-link.yml` is satisfied by the plain `Refs #3084`. The orchestrator files a wave 4 parent; the body then carries a plain `Closes #<wave 4 parent>` (as #3710 did with `Closes #3597`) plus `Refs #3084`. Expand the PR test-plan list with `book-op.design-jobs`, lint, `check:cycles`, and `openapi:types` with no `api-types.ts` diff; call out the `openapi-design-parity.test.ts:250` edit (owner decision B1) and the amended `voice-style.timeout.test.ts`.
> - **Step 6, the review gate, runs at depth `high` AFTER the PR exists, everything is pushed and cloud `verify.yml` is green** (the plan's order, "fold findings … merge once verify.yml green", puts it too early).
>   - Dispatch a Premium-tier, non-fork, fresh-context agent that reads `references/reviewer-brief.md` itself (`.claude/skills/pr-review-gate/SKILL.md`).
>   - Tree check: run `git rev-parse HEAD && git status --porcelain` before and after; any change is a gate failure.
>   - Post ONE `## PR review — pass N (head <sha>, depth high)` comment before any fixes; triage per `references/findings-triage.md`.
>   - A re-review is triggered only by a correctness-bug finding, capped at 2 rounds (3 passes in total); a judgment-call finding suspends the loop and goes to the owner. Merge with a merge commit.
>   - A lane that cannot dispatch a Premium reviewer says "gate not run" (as #3710's body did); a Cline pass is "flash-tier independent", never the gate.
> - **The verify/ship child** therefore: rebases onto latest `main`; runs the battery (`openapi:types` with `git diff --exit-code src/lib/api-types.ts`, typecheck, lint, config:check, check:cycles, `verify:fast:branch`, slow-lane `gemini.test.ts`); does the doc edits here (invariant 8, the wiki, both release-notes files, the 284 test-plan and walkthrough lines); collects every child's mutation-proof output into the PR body; pushes and opens the PR with the corrected body; waits for `verify.yml`; runs the gate if it can dispatch Premium (otherwise states plainly it did not run); and leaves merge and any live-view publish to the operator.

**Files:**
- Modify: `docs/features/284-openai-compatible-analyzer.md` — new invariant 8, a test-plan bullet, walkthrough step 5, and the two stale sentences (`:45`, `:82`).
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`.
- Modify: `docs/wiki/Troubleshooting.md` (`:307`), `docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md` (a persona note).

- [ ] **Step 1: Regression plan.**

In `docs/features/284-openai-compatible-analyzer.md`, append to `## Invariants to preserve` (after item 7, "A reasoning overflow points at the settings that fix it"):
```markdown
8. **Persona generation.** A persona runs through the selected engine's transport with no cross-provider fallback (`server/src/analyzer/voice-style.ts`).
   - **Ollama:** the call stays non-streaming with a caller `keep_alive` and CPU placement. It is bounded by `PERSONA_ABSOLUTE_MAX_MS`, which starts after the analyzer slot is acquired, and the slot is released on every path (`server/src/analyzer/transports/ollama-transport.ts`, `ollama-timeout.test.ts`).
   - **Gemini:** the limiter estimate stays `ceil(prompt.length / 4) + 200`, and the persona wire carries no system instruction, temperature or output cap. It asks for no thoughts, so its `thoughtsTokenCount` is not reasoning evidence (one flag, P27).
   - **Shared card:** a persona engine that shares the Qwen card (local, or a same-card endpoint) is generated before VoiceDesign loads (`server/src/routes/cast-design.ts`).
   - **Cancellation and whole-job errors:** the design job's abort signal reaches every persona call, and a pause is a clean stop (a local persona call aborted before its first byte included). An unreachable, missing, key-mismatched, timed-out or 401/403 persona engine ends the job once.
   - **Failure codes:** any error that ends a design job carries its failure-taxonomy code (`auth` for a key problem), and `unknown` only when the taxonomy recognises nothing. A lazy-path persona failure does **not** end the job: since `6222e483` (#3027 second half) it is a per-character `character_failed` carrying `itemFailureReason`'s reason string, a reasoning overflow included (P20's voice-design carve-out). #3230 (closed) asked for that behaviour and that commit delivered it.
```
Under `### Automated coverage`, add after the `Routes (server)` bullet:
```markdown
- **Persona generation (server and frontend).**
  - The runner's free-text path, and each transport's free-text wire shape against a stage-request control.
  - The persona engine knob's grammar, pinned to the shared id case table.
  - Selection errors before any call (missing endpoint, key origin), and endpoint wiring over a real server (key header, per-call busy registration, served-model record, served-models listing, concurrency 1).
  - The same-card rule (W3d's `endpointsSharingDevice`), the design pre-pass's wholesale errors and their codes, and the job signal reaching the persona call (a pause aborts a real in-flight endpoint request).
  - The Advanced Settings picker.
```
Under `### Manual acceptance walkthrough`, add:
```markdown
5. Open Advanced configuration → Analyzer models. **Persona generation engine** lists `local`, `gemini` and the endpoint's models. Pick an endpoint model; the row shows it as overridden with Revert.
```
- [ ] **Step 2: Release notes** (both files; this PR has a shippable delta).

In `docs/release-notes-next.md`, find the section holding W3's `#3084` entries (`git grep -n "3084" -- docs/release-notes-next.md`) and append this bullet there:
```markdown
- **Persona generation can use any analyzer engine, including an OpenAI-compatible endpoint model.**
  - **Setting:** `analyzer.personaGeneration.engine` (`PERSONA_GEN_ENGINE`) accepts `local`, `gemini` or `openai:<endpointId>::<model>`, picked in Advanced Settings from the analyzer model catalog. Existing `local` / `gemini` values keep working.
  - **Path:** every persona call runs through `StageRunner.runFreeText` and the engine's transport.
  - **Endpoints:** an endpoint persona gets:
    - the analyzer limiter, and the endpoint's concurrency and request ceiling;
    - the served-limits warm-up;
    - per-call busy registration on a GPU endpoint. A design job marks no endpoint run, so VoiceDesign can still evict a same-card endpoint between calls;
    - the key-origin rule. A missing endpoint fails as `AnalyzerEndpointMissingError` (source `persona`) before any call.
  - **Ollama:** it keeps its non-streaming call, `keep_alive` window, CPU placement and 600 s bound.
  - **Gemini:** it keeps its request shape and limiter estimate, and now retries rate-limit and server errors through the shared transport retry helper.
  - **Shared card:** a persona engine on the Qwen card follows the local ordering in Design full cast (personas before VoiceDesign loads).
  - **Errors:** an unreachable, missing, key-mismatched or timed-out persona engine, or one that answers 401/403, ends the design job once instead of failing every character. Any error that ends the design job now carries its failure code (`auth` for a key problem, `analyzer-endpoint-missing`, `analyzer-timeout`, …) instead of `unknown`; `CastDesignEvent.code` admits a `FailureCode`. A lazy-path persona failure is not one of those — it stays a per-character failure and the job carries on, as on `main` since #3027. There is still no cross-provider fallback.
  - **Persona outcomes that change:**
    - **Every engine:** a reply that is only an unterminated `<think>` block is now the empty-persona error, or `analyzer-reasoning-overflow` when a length stop cut it off. On `main` that text was saved as the persona, because `cleanPersona` strips only a closed `<think>…</think>` block.
    - **Ollama:** a reply the length limit cut off after only thinking (`done_reason: "length"`, empty content, non-empty `thinking`) now fails as `analyzer-reasoning-overflow`, where `main` reported the empty-persona error.
    - **Gemini:** a blocked reply now fails as `GeminiContentBlockedError` (`analyzer-content-blocked`), where `main` read its empty text as the empty-persona error. A Gemini persona asks for no thought summaries, so a reported `thoughtsTokenCount` is not reasoning evidence: an empty length stop with no `<think>` block stays the empty-persona error.
  - **Ollama non-OK body:** the persona call keeps PR 3b's known-secret redaction through the move and now fails as an `AnalyzerHttpError` carrying the status and the redacted excerpt, where it was a plain `Error`.
  - **Cancellation:** pausing Design full cast now cancels a persona request in flight (the job's abort signal reaches the transport) and stops cleanly. (#PR, refs #3084)
```
At the top of the in-progress `# Castwright 1.15.0` section of `RELEASE_NOTES.md`, add:
```markdown
- **You can write your cast's voice descriptions with your own model server.** If you've connected an OpenAI-compatible server — llama.cpp, LM Studio, vLLM and the like — for analysis, you can now pick one of its models to write each character's voice description too, under Persona generation engine in Advanced configuration. It shares the same limits and graphics-card coordination as analysis, and if that server is missing or can't be reached, Castwright tells you once and stops rather than quietly switching to Gemini. Gemini voice descriptions also ride out a brief rate limit or server hiccup now instead of failing that character. And pausing Design full cast now also stops a voice description that's still being written. A model that never gets past its thinking no longer has that half-finished thinking saved as a character's voice description: Castwright reports it, and says so when the model ran out of room while thinking. And when Gemini's safety filter blocks a voice description, Castwright now says it was blocked instead of calling it empty.
```
Replace `#PR` with the PR number once it is opened.

- [ ] **Step 2b: Wiki** (added by the re-pin; write in each page's existing voice).
  - `docs/wiki/Advanced-Settings.md:140` is Task 4.4's; confirm it landed and that `scripts/tests/knob-docs-sync.test.mjs` is green (`npm run test:hooks`).
  - `docs/wiki/Troubleshooting.md:307` describes the persona engine as Gemini or Local only: add that an endpoint model is a third option, with the same limits as analysis, and that a missing endpoint is refused at save and at run time with no fallback.
  - `docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md` never mentions personas: add a short note that an endpoint model can write the voice descriptions, and where to pick it.
  - The operator runs `npm run wiki:sync` after merge. Do not run it from the lane.

- [ ] **Step 3: Generated artifacts and checks.**
  - **OpenAPI:** Task 4.6 widened `CastDesignEvent.code`. Run `npm run openapi:types`, then `git diff --exit-code src/lib/api-types.ts` (exit 0: committed in Task 4.6). Config descriptors are not in `openapi.yaml`.
  - **Config:** `npm run config:check`, which Task 4.4 already synced.
  - **Typecheck and lint:** `npm run typecheck`, `npm run lint`, `npm run check:cycles`.
  - **Branch battery:** `npm run verify:fast:branch` (an environmental `stop-app-cli.test.mjs` `PORT=8090` collision is not this wave's; see the Re-pin notes).
  - **Slow lane:** `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`, the only slow-lane file this PR can affect.

- [ ] **Step 4: On-box acceptance — no new row and no register edit, stated in the PR body (owner decision B3).**

Everything this PR adds is provable in automation: selection, the free-text wire shape per transport, the persona ceiling and the Ollama bound and slot release, the limiter estimate, key-origin and missing-endpoint refusals, endpoint wiring over a real HTTP server, the same-card rule, and the pre-pass ordering and errors.

The hardware consequence — a same-card endpoint's model yielding the card to VoiceDesign after the pre-pass — is a Qwen TTS load on that endpoint's card, and automation cannot reach it: a third-party server's model has to actually release the card. It is already recorded as **row A109**, minted by the design PR and owed against this wave. **Leave A109's text unchanged** (no register edit, so no live-view rebuild or publish; agent lanes cannot publish) and say so in the PR body: "On-box: no new row and no register edit. A109 (owed since the design PR) is this wave's persona-endpoint card handover, and stays owed. A116 (#3710) covers the same-card unload mechanism."

- [ ] **Step 5: Commit the docs, push, open the PR.**
```bash
git add docs/features/284-openai-compatible-analyzer.md docs/release-notes-next.md RELEASE_NOTES.md docs/wiki/Troubleshooting.md docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md
git commit -m "docs(docs): record persona generation through the analyzer transports"
git push -u origin feat/server-3084-w4-persona
```
PR title: `feat(server,frontend): generate personas through the analyzer transports`. The body keeps the template's sections:
```markdown
## Summary
- `analyzer.personaGeneration.engine` accepts `local`, `gemini` or `openai:<endpointId>::<model>` (the `analyzer-engine` knob type, introduced in Task 3d.4b for `analyzer.fallback.target` and reused here per F4, picked in Advanced Settings from the analyzer model catalog through Task 3d.4c's picker); `PERSONA_GEN_ENGINE=local|gemini` keeps working.
- Persona calls for every engine run through `StageRunner.runFreeText` and the engine transport. Ollama's non-streaming persona call, `keep_alive`, CPU placement and 600 s bound moved into `OllamaTransport` unchanged; Gemini keeps its wire shape and limiter estimate and gains the shared retry helper; endpoint personas get the limiter, concurrency, ceiling, served-limits warm-up, per-call busy registration and the key-origin rule, and a missing endpoint fails before any call. A design job marks no endpoint run; the reason is in the plan's Delivers section.
- `personaSharesGpu()` (local, or an endpoint that W3d's `endpointsSharingDevice` places on the Qwen card) replaces `engine === 'local'` in `preparePersonaBatch` and Design full cast. The pre-pass ends the job once on an unreachable, missing, key-mismatched, timed-out or 401/403 persona engine (`auth` for key problems). The job's abort signal reaches every persona call.
- Any error that ends Design full cast carries its failure-taxonomy code instead of `unknown` (`CastDesignEvent.code` admits a `FailureCode`). A local persona call a pause aborts before its first byte reports a clean stop, not an unreachable daemon. Persona outcomes change: an unterminated `<think>` reply is the empty-persona error on every engine; an Ollama thinking-only length stop is `analyzer-reasoning-overflow`; a blocked Gemini reply is `GeminiContentBlockedError`; and a Gemini persona's `thoughtsTokenCount` is not reasoning evidence, because it asks for no thoughts (one flag gates the wire and the count, P27).
- The Ollama persona call's non-OK body keeps PR 3b's known-secret redaction through the move (P22), and is now an `AnalyzerHttpError` carrying the status and the redacted excerpt instead of a plain `Error`. W3b's `transport-redaction.test.ts` persona case now drives the moved call.
- #3230 was closed 2026-09-12. `6222e483` (second half of #3027) made the lazy persona path per-character, and this PR keeps it that way — a lazy persona failure, reasoning overflow included, is a `character_failed` with a reason string, not a job halt.
- `openapi-design-parity.test.ts:250` is edited to accept the `anyOf` on `CastDesignEvent.code` (owner decision B1), and re-proved: with the Cast description turned into a plain scalar the test goes red. #3725's `voice-style.timeout.test.ts` now asserts `AnalyzerTimeoutError` (`ceiling`) and exactly one generate POST: every transport bounds a free-text request at `min(its request ceiling, PERSONA_ABSOLUTE_MAX_MS)` and that ceiling is terminal.
- Plan: docs/features/284-openai-compatible-analyzer.md (invariant 8). Spec D10 / §10.

## Test plan
- [ ] server: stage-runner.free-text, ollama, ollama-timeout, transport-redaction (retargeted persona case), gemini/openai-transport.free-text (incl. the persona ceiling), registry, config route, fallback-target (persona save check), voice-style, voice-style.endpoint (real HTTP), voice-style.timeout (amended), prepare-persona-batch, cast-design, book-op.design-jobs, openapi-design-parity (edited)
- [ ] frontend: override-row, advanced, a11y, api.design-sse-event-types
- [ ] mutation proofs (outputs pasted below)
- [ ] `npm run typecheck`, `npm run lint`, `npm run check:cycles`, `npm run config:check`, `npm run openapi:types` (no `api-types.ts` diff), `npm run verify:fast:branch`, slow-lane gemini.test.ts
- On-box: no new row and no register edit. A109 (owed since the design PR) is this wave's persona-endpoint card handover, and stays owed. A116 (#3710) covers the same-card unload mechanism.

Closes #<wave 4 parent>
Refs #3084

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
- [ ] **Step 6: `pr-review-gate`** at depth `high` (a multi-scope `feat`), run AFTER the PR exists, everything is pushed and cloud `verify.yml` is green (see the Re-pin notes for the mechanics). Fold its findings, re-run the affected tests, and leave the merge (and any live-view publish) to the operator.
