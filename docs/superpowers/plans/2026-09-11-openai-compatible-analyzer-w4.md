# OpenAI-compatible analyzer — Wave 4 plan

> Part of the [OpenAI-compatible analyzer implementation plan](2026-09-11-openai-compatible-analyzer.md). Read that file first: its Global Constraints, planning decisions (P1–P11) and interface contract bind every task below. Spec: [2026-09-10-openai-compatible-analyzer-design.md](../specs/2026-09-10-openai-compatible-analyzer-design.md).

## Wave 4 — Persona generation through the transports (spec D10, §10)

### PR 4 — persona generation runs through the stage runner's free-text path

**Branch:** `feat/server,frontend-3084-w4-persona` — created with `node scripts/wt-new.mjs feat/server,frontend-3084-w4-persona` off the latest `main`. The wave map says `feat/server-3084-w4-persona`; this PR also changes the Advanced Settings picker, so the scope is multi-scope.

**Delivers:**
- `analyzer.personaGeneration.engine` (`PERSONA_GEN_ENGINE`) accepts `local`, `gemini`, or `openai:<endpointId>::<model>`.
  - It is a new knob type, `analyzer-engine`: a string knob with a `pattern`, rendered as a select.
  - The select offers `local`, `gemini`, every endpoint model from `GET /api/analyzer/models`, and the saved value.
  - `PERSONA_GEN_ENGINE=local|gemini` stays valid.
- `StageRunner.runFreeText` sends one unstructured, single-attempt call through whichever transport the selection names.
- `generateVoiceStylePersona` uses `runFreeText` for all three engines.
- **Ollama:** its free-text request is served by a non-streaming branch of `OllamaTransport`. That branch is today's `generatePersonaViaOllama` body, moved: `keep_alive`, `onCpu`, the 600 s bound after slot acquisition and the slot release in `finally` are all unchanged.
- **Gemini:** its free-text request keeps the persona wire shape: no system instruction, temperature, output cap or JSON mime type. It uses the limiter estimate `ceil(prompt.length/4)+200`, and now gets the shared transport retry helper.
- **Endpoint personas** get, from `OpenAITransport`: the limiter, per-endpoint concurrency, in-flight registration when `gpu !== 'none'`, and the request ceiling. They also get two checks, both applied before any call:
  - the key-origin rule;
  - a missing endpoint → `AnalyzerEndpointMissingError(endpointId, 'persona')`.
- **Shared GPU:** `personaSharesGpu()` (local, or an endpoint on `any` or on Qwen's card) replaces the `engine === 'local'` tests in:
  - `persona-gpu-plan.ts`;
  - `cast-design.ts`'s pre-pass and lazy-persona skip.
- **Design pre-pass:** it rethrows the whole-job error classes (`AnalyzerUnreachableError`, `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError`) instead of recording them per character.

**Must NOT change:**
- **Prompt and cleanup:** `buildVoiceStylePrompt`, `cleanPersona`, and the empty-persona error text.
- **Unchanged constants and knobs:**
  - `PERSONA_KEEP_ALIVE_SECONDS` (300);
  - `PERSONA_ABSOLUTE_MAX_MS` (600 000);
  - `analyzer.gemini.voiceStyleModel`;
  - `analyzer.personaGeneration.localModel`.
- **Stage calls:** the wire shape of every transport's stage (non-free-text) request.
- **No fallback:** no cross-provider fallback for personas. `FallbackAnalyzer` is never used.
- **Routes:** `/voice-style` route response shapes and the cast-design SSE event shapes.
- **Local ordering:** personas are generated before VoiceDesign loads (plan 108).
- **Scope:** reasoning and custom payload stay W5's. This PR adds no reasoning or payload field to any request: wave 1's `TransportRequest` / `EngineRequestSettings` have neither, and wave 5 (Task 5.1) adds both fields and their forwarding from `runStage`, `runSingleAttempt` and `runFreeText`.

**Entry criteria:**
1. PR 3d is merged.
2. Run from the worktree root:
   `git grep -n -E "export class (OllamaAnalyzer|GeminiAnalyzer|OpenAIAnalyzer|OllamaTransport|GeminiTransport|OpenAITransport|StageRunner|TransportAnalyzer)|export function (keyOriginMatches|parseEndpointModelId|isAnyAnalyzerCallInFlight|stripThink|hasReasoningEvidence)|class (AnalyzerEndpointMissingError|AnalyzerKeyOriginError|AnalyzerUnreachableError|AnalyzerReasoningOverflowError)|getAnalyzerModels|analyzerRateLimiter =" -- server/src src/lib`
   Every name must be found. `OpenAIAnalyzer` lives in `server/src/analyzer/openai.ts` (W3b Task 3b.12); this wave imports it as `./openai.js` and `../openai.js`.
3. `git grep -n "generatePersonaViaOllama" -- server/src` still shows it defined in `server/src/analyzer/ollama.ts`.
4. If W1–W3 moved it, apply Task 4.2's move from that location instead.

**Exit criteria:**
- **Tests:** every test named below is green, and each mutation proof is pasted in the PR body.
- **Checks:** `npm run typecheck`, `npm run config:check` and `npm run verify:fast:branch` are green.
- **Review:** the `pr-review-gate` pass at depth `high` (multi-scope `feat`) is folded in.

Test commands used below (from the worktree root, no `cd`):
- **Server file:** `npm --prefix server run test -- <path relative to server/>`. None of this wave's server test files are in `server/vitest.config.slow.ts` `SLOW_FILES`.
- **Frontend file:** `npm test -- <path>`.

---

### Task 4.1: Free-text request contract and `StageRunner.runFreeText`

**Files:**
- Modify: `server/src/analyzer/runner/transport.ts` — add `FreeTextOptions` and `FreeTextInput`; widen `TransportRequest.temperature`; add `TransportRequest.freeText`.
- Modify: `server/src/analyzer/runner/stage-runner.ts` — add `runFreeText`.
- Modify: `server/src/analyzer/runner/transport-analyzer.ts` — expose `readonly runner`.
- Test: Create `server/src/analyzer/runner/stage-runner.free-text.test.ts`.

**Interfaces:**
- **Consumes:** `StageRunner`, `ChatTransport`, `TransportRequest`, `TransportResult`, `OLLAMA_RETRY_POLICY` (W1), `stripThink` (W1, `runner/parse.ts`), `hasReasoningEvidence` (W2, `runner/finish.ts`), `AnalyzerReasoningOverflowError` and `GeminiContentBlockedError` (`errors.ts`).
- **Produces:**
  ```ts
  export interface FreeTextOptions { onCpu?: boolean; keepAlive?: string | number; absoluteMaxMs?: number }
  export interface FreeTextInput { system?: string; prompt: string; signal?: AbortSignal; temperature?: number; ollama?: FreeTextOptions }
  // TransportRequest: temperature: number | undefined;  freeText?: FreeTextOptions;
  StageRunner.runFreeText(input: FreeTextInput): Promise<string>
  TransportAnalyzer.runner: StageRunner   // readonly, public
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
});
```
- [ ] **Step 2: Run it and confirm it fails**
  - **Run:** `npm --prefix server run test -- src/analyzer/runner/stage-runner.free-text.test.ts`
  - **Expected:** FAIL with `runner.runFreeText is not a function`.
- [ ] **Step 3: Implement**

In `server/src/analyzer/runner/transport.ts`, add these exports above `TransportRequest`:
```ts
/** #3084 W4 — per-call placement for a free-text request. Only the Ollama transport reads the fields;
    the Gemini and OpenAI transports use the PRESENCE of `TransportRequest.freeText` only. */
export interface FreeTextOptions {
  /** Ollama: run on system RAM (`num_gpu: 0`). The analyzer slot is still acquired (with onCpu=true). */
  onCpu?: boolean;
  /** Ollama: `keep_alive` when no analysis run is busy (a busy run pins -1). Default 0. */
  keepAlive?: string | number;
  /** Ollama: absolute ceiling in ms, started AFTER the analyzer slot is acquired.
      Default PERSONA_ABSOLUTE_MAX_MS; tests pass a small value to prove the bound fires. */
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
- Add imports: `import { stripThink } from './parse.js';` and `import { hasReasoningEvidence } from './finish.js';` (skip either one already imported).
- Add `AnalyzerReasoningOverflowError, GeminiContentBlockedError` to the `../errors.js` import.
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
    const system = input.system ?? '';
    const sent = await this.transport.send({
      system,
      messages: [{ role: 'user', content: input.prompt }],
      structuredOutput: { mode: 'off' },
      temperature: input.temperature,
      maxOutputTokens: undefined,
      /* The persona limiter estimate from main 2b63b451 (voice-style.ts:211): ~chars/4 plus a flat margin. */
      estimatedInputTokens: Math.ceil((system.length + input.prompt.length) / 4) + 200,
      signal: input.signal,
      call: {},
      freeText: { ...input.ollama },
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
In `server/src/analyzer/runner/transport-analyzer.ts`, make the runner public and read-only. Change the constructor parameter to `constructor(readonly runner: StageRunner)`. If W1 declared a `private`/`protected readonly runner` field instead, drop the access modifier. Every existing `this.runner` use keeps working.

- [ ] **Step 4: Run and confirm it passes**
  - **Run:** `npm --prefix server run test -- src/analyzer/runner/stage-runner.free-text.test.ts src/analyzer/runner src/analyzer/transports`, then `npm run typecheck`.
  - **Expected:** PASS, and tsc reports no errors.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Output cap:** change `maxOutputTokens: undefined,` to `maxOutputTokens: this.settings().maxOutputTokens,`. Expected red: `sends ONE unstructured request…` (`expected 4096 to be undefined`).
  2. **Token estimate:** change `+ 200` to `+ 0`. Expected red: `sends ONE unstructured request…` and `counts the system text…`.
  3. **Blocked response:** delete the `if (answer.finish === 'blocked') {…}` block. Expected red: `throws GeminiContentBlockedError…` (resolves `''`).
  4. **Unterminated think:** replace the `answer` ternary with `const answer: TransportResult = { ...sent, text: think.text };`. Expected red: `treats an unterminated <think> on a length stop as reasoning evidence`.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/transport.ts server/src/analyzer/runner/stage-runner.ts server/src/analyzer/runner/transport-analyzer.ts server/src/analyzer/runner/stage-runner.free-text.test.ts
git commit -m "feat(server): add StageRunner.runFreeText for unstructured single-attempt calls"
```

---

### Task 4.2: Ollama transport — the non-streaming free-text branch

**Files:**
- Modify: `server/src/analyzer/transports/ollama-transport.ts`:
  - `send()` gains a first-line dispatch;
  - new private `sendFreeText`;
  - new exported `PERSONA_ABSOLUTE_MAX_MS`.
- Modify: `server/src/analyzer/ollama.ts:135-141`. Delete the `PERSONA_ABSOLUTE_MAX_MS` definition and its comment, and import the constant from the transport; `generatePersonaViaOllama` still uses it until Task 4.5. Line numbers are main's; W1 may have shifted them, so locate the lines by symbol.
- Test: Modify `server/src/analyzer/ollama.test.ts:1394-1452` (retarget the persona describe to the runner free-text path).
- Test: Modify `server/src/analyzer/ollama-timeout.test.ts`:
  - `:30-34` — imports;
  - `:149-215` — the call site only; the assertions stay identical.

**Interfaces:**
- **Consumes:** `FreeTextOptions`, `TransportRequest.freeText`, `StageRunner.runFreeText`, `TransportAnalyzer.runner` (Task 4.1). From W1 it also needs `classifyConnectError`, `ANALYZER_DISPATCHER`, `acquireAnalyzerSlot`, `isAnyAnalyzerRunBusy`, `undiciFetch` and `AnalyzerHttpError`; the streaming body already imports all of them.
- **Produces:** `export const PERSONA_ABSOLUTE_MAX_MS = 600_000` from `transports/ollama-transport.ts`. `OllamaTransport.send(req)` serves `req.freeText` with one non-streaming call.
- **Keeps green:**
  - the whole of `src/analyzer/ollama.test.ts` (the streaming stage path is untouched);
  - `src/analyzer/ollama-timeout.test.ts` — all 4 cases;
  - W1's Ollama transport suite: `npm --prefix server run test -- src/analyzer/transports`.

- [ ] **Step 1: Write the failing tests**

In `server/src/analyzer/ollama.test.ts`, replace lines 1394-1452 (the header comment and `describe('generatePersonaViaOllama', …)`) with the block below. `mockChatResponse` (1386-1392) and `fetchMock` (the `vi.mock('undici')` at 162-165) stay.
```ts
/* Persona generation's Ollama path (#3084 W4, spec §10): OllamaAnalyzer's runner free-text call,
   which OllamaTransport serves with ONE non-streaming /api/chat call — the body that was
   generatePersonaViaOllama on main 2b63b451. It carries ANALYZER_DISPATCHER too (`stream:false`
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

- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm --prefix server run test -- src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts`
  - **Expected:** FAIL.
    - `GPU path…` fails with `expected true to be false` (the streaming `chat()` body sends `stream: true`).
    - `REGRESSION…` fails. The streaming path has no absolute bound, so the 5 s slow server answers and the error is `null`: `the call must terminate, not hang: expected null not to be null`.

- [ ] **Step 3: Implement**

At the top of `server/src/analyzer/transports/ollama-transport.ts`:
- Add `FreeTextOptions` to the `../runner/transport.js` type import.
- Add this export, moved from `ollama.ts:135-141` with its rationale:
```ts
/* Absolute ceiling for a one-shot free-text (persona) call. Moved from ollama.ts (main 2b63b451
   lines 135-141): ANALYZER_DISPATCHER removes undici's implicit 300s bound and the persona caller
   supplies no signal (see sendFreeText). Deliberately generous: the whole point of the dispatcher
   is that a large model on CPU legitimately takes minutes. Mirrors DESIGN_ABSOLUTE_MAX_MS in
   tts/design-voice-core.ts. */
export const PERSONA_ABSOLUTE_MAX_MS = 600_000;
```
Make this the first statement of `OllamaTransport.send(req)`:
```ts
    if (req.freeText) return this.sendFreeText(req, req.freeText);
```
Add the private method. Its body is main's `generatePersonaViaOllama` (`ollama.ts:950-1027`). Every line not marked `CHANGED` is verbatim, including comments.
```ts
  /** #3084 W4 — the free-text path (spec §10): one NON-streaming /api/chat call with no response
      `format`, GPU-plan aware. Moved from ollama.ts `generatePersonaViaOllama` (main 2b63b451).
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
          dispatcher: this.dispatcher ?? ANALYZER_DISPATCHER, // CHANGED: the injected test dispatcher is honoured, like send()
        });
      } catch (err) {
        throw classifyConnectError(err, url);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        /* CHANGED: typed per spec §1 (was a plain Error); the message text is byte-identical. */
        throw new AnalyzerHttpError(
          'ollama',
          response.status,
          text.slice(0, 500),
          `Ollama ${url} returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
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
- Delete the `PERSONA_ABSOLUTE_MAX_MS` comment block and definition.
- Add `PERSONA_ABSOLUTE_MAX_MS` to the existing value import from `./transports/ollama-transport.js`. `generatePersonaViaOllama` still reads the constant until Task 4.5 deletes that function.

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm --prefix server run test -- src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts src/analyzer/transports`, then `npm run typecheck`.
  - **Expected:** PASS (all 4 `ollama-timeout` cases).
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Slot release:** in `sendFreeText`, delete `releaseSlot();` from the `finally`. Expected red: `REGRESSION: the Ollama free-text (persona) call stays bounded…` with `the analyzer slot must be released on the timeout path (capacity 1)`.
  2. **Absolute bound:** change `const signal = req.signal ? … : budget;` to `const signal = req.signal;`. Expected red: the same `REGRESSION` test, with `the call must terminate, not hang`.
  3. **Free-text dispatch:** delete the `if (req.freeText) return this.sendFreeText(…)` line. Expected red: `GPU path: sends the caller keep_alive…`.
  4. **Placement:** change `acquireAnalyzerSlot(this.model, onCpu)` to `acquireAnalyzerSlot(this.model, false)`. Expected red: `persona gen on CPU takes the limiter but no GPU slot`.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports/ollama-transport.ts server/src/analyzer/ollama.ts server/src/analyzer/ollama.test.ts server/src/analyzer/ollama-timeout.test.ts
git commit -m "feat(server): serve Ollama free-text requests with the bounded non-streaming persona call"
```

---

### Task 4.3: Gemini and OpenAI transports honour a free-text request

**Files:**
- Modify: `server/src/analyzer/transports/gemini-transport.ts` — the `config` object literal passed to `this.client.models.generateContentStream`. This was `gemini.ts:728-734` on main; W1 moved it, and W2/W3 added keys.
- Modify: `server/src/analyzer/transports/openai-transport.ts` — the params object passed to `client.chat.completions.create`.
- Test: Create `server/src/analyzer/transports/gemini-transport.free-text.test.ts`.
- Test: Create `server/src/analyzer/transports/openai-transport.free-text.test.ts`.

**Interfaces:**
- **Consumes:**
  - `TransportRequest.freeText` and `runFreeText` (Task 4.1);
  - `GeminiAnalyzer` / `GeminiTransport` (W1);
  - `OpenAIAnalyzer` / `OpenAITransport` and the `AnalyzerEndpoint` type (W3);
  - `analyzerRateLimiter` (W3).
- **Produces:**
  - **Gemini:** a free-text request carries no `systemInstruction` when `system === ''`, no `temperature` when undefined, and no `maxOutputTokens` when undefined.
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
});

describe('GeminiTransport — free-text request', () => {
  it('omits systemInstruction, JSON mode, temperature and maxOutputTokens', async () => {
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

  it('CONTROL: a stage request still sends its system instruction, temperature and output cap', async () => {
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
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';

let server: Server | undefined;
const bodies: Array<Record<string, unknown>> = [];

function sseChunk(delta: object, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'qwen3', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function startFakeOpenAI(content: string): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk({ role: 'assistant', content }, null));
      res.write(sseChunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
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
});
```
- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm --prefix server run test -- src/analyzer/transports/gemini-transport.free-text.test.ts src/analyzer/transports/openai-transport.free-text.test.ts`
  - **Expected:** the two free-text cases FAIL.
    - Gemini fails with `expected {…} not to have property "systemInstruction"`: W1–W3 always send it, together with `temperature` and `maxOutputTokens`.
    - OpenAI fails with `expected {…} not to have property "max_tokens"` or a `messages` mismatch on the leading system turn.
  - Both CONTROL cases and the limiter case PASS.
  - If the OpenAI CONTROL fails, W3 builds a stage request differently from the spec §2 table (for example, it sends `max_completion_tokens`). Adjust the CONTROL expectation to W3's real shape before implementing, and record that in the PR body.

- [ ] **Step 3: Implement**

In `GeminiTransport`, rewrite exactly three properties of the `config` literal. Every other key (structured output, `thinkingConfig`, `abortSignal`) stays as W1–W3 left it. In each spread, the non-free-text branch keeps the expression W1–W3 already wrote for that property. The snippet names the request field; if W2 wraps it (for example `maxOutputTokens: capFor(req)`), keep that wrapper inside the second branch.
```ts
        config: {
          /* #3084 W4 — a free-text request omits what the pre-transport persona call never sent
             (it was a bare generateContent({ model, contents })). Stage requests are unchanged. */
          ...(req.freeText && req.system === '' ? {} : { systemInstruction: req.system }),
          ...(req.freeText && req.temperature === undefined ? {} : { temperature: req.temperature }),
          ...(req.freeText && req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
          // …W1–W3's remaining keys unchanged (structured-output mode keys, thinkingConfig, abortSignal)…
        },
```
In `OpenAITransport.send`, in the params passed to `client.chat.completions.create`, rewrite the `messages`, `temperature` and `max_tokens` entries the same way. Other keys (`model`, `stream`, `stream_options`, `response_format` from the mode table) stay as W3 left them.
```ts
        /* #3084 W4 — free text sends no empty system turn and leaves temperature / max_tokens to the server. */
        messages: [
          ...(req.freeText && req.system === '' ? [] : [{ role: 'system' as const, content: req.system }]),
          ...req.messages,
        ],
        ...(req.freeText && req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.freeText && req.maxOutputTokens === undefined ? {} : { max_tokens: req.maxOutputTokens }),
```
If W3 derives `max_tokens` inside the transport — from `endpoint.maxOutputTokens` Auto, rather than from `req.maxOutputTokens` — keep that derivation inside the non-free-text branch. The free-text branch must still omit the key.

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm --prefix server run test -- src/analyzer/transports`, then `npm --prefix server run test -- --config vitest.config.slow.ts src/analyzer/gemini.test.ts`, then `npm run typecheck`.
  - **Expected:** PASS.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Gemini temperature:** replace the `temperature` spread with `temperature: req.temperature,`. Expected red: `omits systemInstruction, JSON mode, temperature and maxOutputTokens` (`not to have property "temperature"`; JSON drops `undefined`, but `toHaveProperty` sees the key).
  2. **Gemini output cap:** replace the `maxOutputTokens` spread with an unconditional `maxOutputTokens: req.maxOutputTokens ?? 8192,`. Expected red: `omits systemInstruction, JSON mode, temperature and maxOutputTokens` (`not to have property "maxOutputTokens"`).
  3. **OpenAI output cap:** replace the `max_tokens` spread with W3's original unconditional entry. Expected red: `sends one user message and no response_format, max_tokens or temperature`.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/openai-transport.ts server/src/analyzer/transports/gemini-transport.free-text.test.ts server/src/analyzer/transports/openai-transport.free-text.test.ts
git commit -m "feat(server): keep the persona wire shape for free-text Gemini and OpenAI requests"
```

---

### Task 4.4: `analyzer.personaGeneration.engine` becomes a model-id selection (knob type `analyzer-engine`)

**Files:**
- Modify: `server/src/config/types.ts:2-5` — `KnobType` gains `'analyzer-engine'`.
- Modify: `server/src/config/types.ts:27-28` — the `options` doc.
- Modify: `server/src/config/registry.ts:1180-1191`.
- Modify: `server/src/config/registry.test.ts:1-3` (imports), `:189-198` (allowed pattern types); append a describe.
- Modify: `src/lib/types.ts:892-894` — frontend `KnobDescriptor.type` union.
- Modify: `server/src/routes/config.test.ts` — append a describe.
- Regenerate: `server/.env.example`, via `npm run config:sync`. Only the help comment above `# PERSONA_GEN_ENGINE=gemini` (main line 558) changes.

**Interfaces:**
- **Consumes:** `parseEndpointModelId` (W3, `server/src/analyzer/model-id.ts`) and the shared case table `server/src/analyzer/__fixtures__/model-id-cases.json` (W3). Test-only: `registry.ts` must stay pure data (`registry-imports.guard.test.ts`), so the grammar is a literal regex pinned against `parseEndpointModelId`.
- **Produces:**
  - `KnobType` includes `'analyzer-engine'`: a string knob, validated identically (trim + `pattern`), whose UI is a select over `options` plus live endpoint models.
  - The persona engine knob: `type: 'analyzer-engine'`, `options: ['local', 'gemini']`, `pattern: /^(local|gemini|openai:[a-z0-9-]{1,40}::.+)$/`, `default: 'gemini'`.
- **Keeps green:**
  - `src/config/registry.test.ts`, including `every knob's own default satisfies its own pattern/options/min/max`;
  - `src/config/resolver.test.ts`;
  - `src/config/registry-imports.guard.test.ts`;
  - `src/routes/config.test.ts`, including `descriptor fields are exactly the client-safe set`;
  - `src/lib/api.config.test.ts` (frontend mock catalogue).

- [ ] **Step 1: Write the failing tests**

In `server/src/config/registry.test.ts`, extend the imports (lines 1-3):
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GROUPS, KNOBS, allKnobs, getKnob, knobByEnv, knobsInGroup } from './registry.js';
import { coerceAndValidate, configValue } from './resolver.js';
import { parseEndpointModelId } from '../analyzer/model-id.js';
```
Change the allowed-types array in the test at `:189-198` from `['string', 'device']` to `['string', 'device', 'analyzer-engine']`. In its message, change "only declared on string/device knobs" to "only declared on string/device/analyzer-engine knobs". Then append:
```ts
/* #3084 W4 (spec §10) — persona generation's engine is a model-id-style selection. */
describe('analyzer.personaGeneration.engine', () => {
  const knob = () => getKnob('analyzer.personaGeneration.engine')!;
  const CASES = JSON.parse(
    readFileSync(fileURLToPath(new URL('../analyzer/__fixtures__/model-id-cases.json', import.meta.url)), 'utf8'),
  ) as Array<{ id: string }>;
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

  it('accepts an endpoint model id exactly when parseEndpointModelId does (shared id case table)', () => {
    expect(CASES.length).toBeGreaterThan(0);
    for (const c of CASES) {
      if (c.id === 'local' || c.id === 'gemini') continue;
      expect(coerceAndValidate(knob(), c.id).ok, c.id).toBe(parseEndpointModelId(c.id) !== null);
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
/* #3084 W4 — the persona engine knob accepts endpoint model ids and refuses malformed ones at save. */
describe('PUT /api/config — analyzer.personaGeneration.engine', () => {
  it('stores an openai:<endpointId>::<model> value', async () => {
    const res = await request(app)
      .put('/api/config')
      .send({ 'analyzer.personaGeneration.engine': 'openai:lab::qwen3' });
    expect(res.status).toBe(200);
    expect(res.body.values['analyzer.personaGeneration.engine'].effective).toBe('openai:lab::qwen3');
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
- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm --prefix server run test -- src/config/registry.test.ts src/routes/config.test.ts`
  - **Expected:** FAIL.
    - `is an analyzer-engine knob…` fails with `expected 'enum' to be 'analyzer-engine'`.
    - `accepts "openai:lab::qwen3-30b"` fails (`ok: false, error: 'not an allowed option'`).
    - `stores an openai:<endpointId>::<model> value` fails with `expected 400 to be 200`.
- [ ] **Step 3: Implement**

`server/src/config/types.ts`, replace line 2:
```ts
export type KnobType = 'number' | 'integer' | 'boolean' | 'string' | 'enum' | 'device' | 'analyzer-engine';
// 'analyzer-engine' (#3084 W4) is a string knob (validated identically — trim + `pattern` in
// coerceAndValidate's default case) whose UI picks from its static `options` plus the live
// OpenAI-compatible endpoint models (GET /api/analyzer/models) instead of a free-text box.
```
Replace the `options` doc (lines 27-28):
```ts
  /** For type==='enum' (the closed option set), and the static entries of a type==='analyzer-engine' picker. */
  options?: string[];
```
Replace the descriptor in `server/src/config/registry.ts:1180-1191`:
```ts
  {
    key: 'analyzer.personaGeneration.engine',
    env: 'PERSONA_GEN_ENGINE',
    group: 'analyzer-models',
    label: 'Persona generation engine',
    help: '"gemini" (default) designs each cast member\'s voice persona via the Gemini API (Voice-style model) — the locked quality choice. "local" routes it through the local Ollama daemon (Persona local model) so a no-Gemini install can still design voices. An OpenAI-compatible endpoint model (openai:<endpoint>::<model>, picked from the list) routes it to that endpoint, with its rate limits, concurrency and GPU card. No silent cross-provider fallback: gemini with no key, local with the daemon down, or an endpoint that is missing or unreachable, fails with a clear message.',
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
`src/lib/types.ts:892-894`:
```ts
  /** 'device' is a string knob whose UI is a dropdown built from GET /api/gpu/devices
      (plus 'auto'/'cpu') instead of a free-text box. 'analyzer-engine' (#3084 W4) is a string
      knob whose UI is a dropdown of its static `options` plus the OpenAI-compatible endpoint
      models from GET /api/analyzer/models. */
  type: 'number' | 'integer' | 'boolean' | 'string' | 'enum' | 'device' | 'analyzer-engine';
```
Then run `npm run config:sync`.

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm --prefix server run test -- src/config src/routes/config.test.ts`, then `npm test -- src/lib/api.config.test.ts`, then `npm run config:check` and `npm run typecheck`.
  - **Expected:** PASS. `config:check` reports the block is in sync.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Endpoint id length:** change `{1,40}` to `+`. Expected red: `rejects "openai:aaaa…::m"`.
  2. **Separator:** change `::` to `::?`. Expected red: `rejects "openai:lab:qwen3"`, and `refuses a malformed id with the shape error` (`expected 200 to be 400`).
  3. **Knob type:** change `type: 'analyzer-engine'` back to `type: 'string'`. Expected red: `is an analyzer-engine knob…`.
- [ ] **Step 6: Commit**
```bash
git add server/src/config/types.ts server/src/config/registry.ts server/src/config/registry.test.ts server/src/routes/config.test.ts src/lib/types.ts server/.env.example
git commit -m "feat(server,frontend): let the persona engine knob name an OpenAI-compatible endpoint model"
```

---

### Task 4.5: `generateVoiceStylePersona` dispatches every engine through `runFreeText`

**Files:**
- Modify: `server/src/analyzer/voice-style.ts`:
  - `:1-35` — header comment and imports;
  - `:60-63` — replace `resolvePersonaEngine`;
  - `:163-226` — the dispatcher, `generateViaOllama` and `generateViaGemini`.
- Modify: `server/src/analyzer/ollama.ts` — delete `generatePersonaViaOllama` (main `:930-1028`, doc comment included) and the `PERSONA_ABSOLUTE_MAX_MS` import Task 4.2 added.
- Test: Modify `server/src/analyzer/voice-style.test.ts`:
  - `:15-38` — imports and mocks;
  - `:115-126` — `beforeEach`;
  - `:238-357` — the config, Gemini and dispatch describes.
- Test: Create `server/src/analyzer/voice-style.endpoint.test.ts`, a real-HTTP wiring proof.

**Interfaces:**
- **Consumes:**
  - From W1–W3: `OllamaAnalyzer`, `GeminiAnalyzer`, `OpenAIAnalyzer`, `TransportAnalyzer.runner`, `parseEndpointModelId`, `AnalyzerEndpoint`, `keyOriginMatches`, `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError`, `AnalyzerUnreachableError`, `LocalUnreachableError`, `isAnyAnalyzerCallInFlight`, `analyzerRateLimiter`, `endpointModelId`.
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
  export async function generateVoiceStylePersona(character: CastCharacter, opts?: { onCpu?: boolean; keepAlive?: string | number }): Promise<string>; // signature unchanged
  ```
  `resolvePersonaEngine` is **removed**. Task 4.6 replaces its two production readers with `personaSharesGpu`.
- **Keeps green:**
  - `src/routes/voice-style.test.ts` and `src/workspace/cast-lock.race.test.ts`. Both mock `generateVoiceStylePersona` and `preparePersonaBatch` by factory, and neither calls the removed or added exports.
  - `src/analyzer/ollama.test.ts` and `src/analyzer/ollama-timeout.test.ts`.

**W3 dependency check, before Step 3:** run `git grep -n "keyOriginMatches(" -- server/src ':!*.test.ts'`.
- If W3 exported a non-route helper that resolves an endpoint's API key for a selection (checking the stored origin, throwing `AnalyzerKeyOriginError`), call it in `personaRunner` instead of the inline `stored` block. The behaviour asserted by the tests below is the same.
- Otherwise keep the inline block, and name it in the PR body as a second copy to fold into W3's helper.

- [ ] **Step 1: Write the failing tests**

In `server/src/analyzer/voice-style.test.ts`, replace lines 15-38 with:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzerRateLimiter } from './rate-limit.js';
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

vi.mock('@google/genai', () => ({
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
    getResolvedOllamaModel: () => 'llama2',
    getResolvedOllamaUrl: () => 'http://ollama.test',
    readConfigOverrides: () => ({}),
    getCachedUserSettings: () => ({ ...actual.DEFAULT_USER_SETTINGS, ...mockSettingsPatch }),
  };
});

function ENDPOINT(over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint {
  return {
    id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:18080/v1', gpu: 'none', concurrency: 1,
    requestCeilingMs: 1_800_000, structuredOutput: 'schema', reasoningStyle: 'not_controllable',
    reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 32768, ...over,
  };
}
```
In `beforeEach` (`:115-126`):
- Replace `generateContent.mockReset();` with `generateContentStream.mockReset();`.
- Replace `geminiRateLimiter._reset();` with `analyzerRateLimiter._reset();`.
- Add `mockSettingsPatch = {};`.
- Replace the `generateContent.mockResolvedValue({ … })` call with:
```ts
  generateContentStream.mockImplementation(async () =>
    STOP('a poised, confident teenage girl, warm and a little playful, mid-paced'),
  );
```
Replace everything from line 238 (`describe('persona generation config', …)`) to the end of the file with:
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
    const { getResolvedOllamaModel } = await import('../workspace/user-settings.js');
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
    expect(req.freeText).toEqual({ onCpu: true, keepAlive: 300 });
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
    expect(req.freeText).toEqual({});
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
});
```
Also check that the kept `delegateConfigValue` helper (`:53-57`) delegates every other key to the real `configValue`. `QWEN_DEVICE` and `analyzer.ollama.temperature` resolve through it, so no change is needed.

`server/src/analyzer/voice-style.endpoint.test.ts` is the wiring proof: the transport's limiter, concurrency, in-flight registration and key header reach a persona. It uses a real server and no SDK mock:
```ts
/* #3084 W4 — an endpoint persona (PERSONA_GEN_ENGINE=openai:lab::qwen3) runs through OpenAITransport for
   real: limiter keyed by the model id, the endpoint's concurrency, in-flight registration for a GPU
   endpoint, and the key sent only under a matching origin. Real http.createServer on 127.0.0.1:0. */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { _setUserSettingsCacheForTest, _resetUserSettingsCache } from '../workspace/user-settings.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { isAnyAnalyzerCallInFlight } from './analyzer-concurrency.js';
import { analyzerRateLimiter } from './rate-limit.js';
import { endpointModelId } from './model-id.js';
import { generateVoiceStylePersona } from './voice-style.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

let server: Server | undefined;
let active = 0;
let peak = 0;
const seen: Array<{ headers: IncomingHttpHeaders; inFlightDuringCall: boolean }> = [];

function startHeldServer(holdMs: number): Promise<string> {
  server = createServer((req, res) => {
    active += 1;
    peak = Math.max(peak, active);
    req.resume();
    req.on('end', () => {
      seen.push({ headers: req.headers, inFlightDuringCall: isAnyAnalyzerCallInFlight() });
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
  seen.length = 0;
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
  it('sends the key under a matching origin, registers in flight (gpu any) and keys the limiter by model id', async () => {
    const baseUrl = await startHeldServer(50);
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [endpoint(baseUrl)],
      analyzerEndpointKeys: { lab: { origin: new URL(baseUrl).origin, key: 'sk-test' } },
    });
    const acquire = vi.spyOn(analyzerRateLimiter, 'acquire');
    await expect(generateVoiceStylePersona(CHAR)).resolves.toBe('A calm, low voice.');
    expect(seen[0].headers.authorization).toBe('Bearer sk-test');
    expect(seen[0].inFlightDuringCall).toBe(true);
    expect(isAnyAnalyzerCallInFlight()).toBe(false);
    expect(acquire.mock.calls[0][0]).toBe(endpointModelId('lab', 'qwen3'));
  });

  it('does not register in flight for an endpoint on no card', async () => {
    const baseUrl = await startHeldServer(50);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint(baseUrl, { gpu: 'none' })] });
    await generateVoiceStylePersona(CHAR);
    expect(seen[0].inFlightDuringCall).toBe(false);
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it('serialises concurrent personas at the endpoint concurrency of 1', async () => {
    const baseUrl = await startHeldServer(150);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint(baseUrl, { concurrency: 1 })] });
    await Promise.all([generateVoiceStylePersona(CHAR), generateVoiceStylePersona(CHAR)]);
    expect(seen).toHaveLength(2);
    expect(peak).toBe(1);
  });
});
```
The limiter key assertion follows spec §5 (the analyzer limiter is keyed by the full model id). If W3 keys endpoint limits by the bare model, that is a W3 contract deviation: report it in the PR body and do not weaken this assertion silently.

- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm --prefix server run test -- src/analyzer/voice-style.test.ts src/analyzer/voice-style.endpoint.test.ts`
  - **Expected:** FAIL.
    - `voice-style.test.ts` fails at import with `SyntaxError: The requested module './voice-style.js' does not provide an export named 'personaSharesGpu'` (vitest reports the missing export).
    - `voice-style.endpoint.test.ts` → `sends the key…` fails with `expected '…' to be 'A calm, low voice.'` or a Gemini-key error: main routes any non-`local` value to Gemini.

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
Replace the imports (lines 28-35) with:
```ts
import { buildHintFromCast, type CastCharacter } from '../tts/synthesise-chapter.js';
import {
  getCachedUserSettings,
  getResolvedGeminiApiKey,
  getResolvedOllamaModel,
  getResolvedOllamaUrl,
} from '../workspace/user-settings.js';
import { keyOriginMatches, type AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { GeminiAnalyzer, stripCodeFences } from './gemini.js';
import { OllamaAnalyzer, resolveOllamaTemperature } from './ollama.js';
import { OpenAIAnalyzer } from './openai.js';
import { parseEndpointModelId } from './model-id.js';
import { AnalyzerEndpointMissingError, AnalyzerKeyOriginError } from './errors.js';
import type { StageRunner } from './runner/stage-runner.js';
import { readPrompt } from '../config/prompts.js';
import { configValue } from '../config/resolver.js';
```
If W1 moved `stripCodeFences` to `./runner/parse.js` without the re-export from `gemini.ts` the contract promises, import it from there.

Replace `resolvePersonaEngine` (lines 60-63) with:
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

function findEndpoint(endpointId: string): AnalyzerEndpoint | undefined {
  return getCachedUserSettings().analyzerEndpoints.find((e) => e.id === endpointId);
}

/** True when the persona call can land on the card the Qwen VoiceDesign model uses — the condition
    under which cast design must generate personas BEFORE VoiceDesign loads (plan 108) and
    preparePersonaBatch must plan the GPU:
      - local Ollama: always (the rule before #3084);
      - gemini: never;
      - an endpoint: its card is `any`, or equals Qwen's pinned `cuda:N`; a Qwen device that names no
        single card (`auto`, `cuda`, an unreconciled `cuda-uuid:`) fails closed; `cpu`/`mps` never share;
        `gpu: 'none'` never shares; an endpoint id missing from settings fails closed. */
export function personaSharesGpu(): boolean {
  const selection = resolvePersonaSelection();
  if (selection.engine === 'local') return true;
  if (selection.engine === 'gemini') return false;
  const endpoint = findEndpoint(selection.endpointId);
  if (!endpoint) return true;
  if (endpoint.gpu === 'none') return false;
  if (endpoint.gpu === 'any') return true;
  const qwenDevice = configValue<string>('tts.qwen.device').trim().toLowerCase();
  if (qwenDevice === 'cpu' || qwenDevice === 'mps') return false;
  if (/^cuda:\d+$/.test(qwenDevice)) return qwenDevice === endpoint.gpu;
  return true;
}
```
Replace lines 163-226 (from the `generateVoiceStylePersona` doc comment to the end of the file) with:
```ts
const GEMINI_KEY_REQUIRED =
  'GEMINI_API_KEY is required to generate voice-style personas. ' +
  'Set it from Account → Server configuration → Gemini API key, ' +
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
      const endpoint = findEndpoint(selection.endpointId);
      if (!endpoint) throw new AnalyzerEndpointMissingError(selection.endpointId, 'persona');
      const stored: { origin: string; key: string } | undefined =
        getCachedUserSettings().analyzerEndpointKeys[endpoint.id];
      if (stored && !keyOriginMatches(stored, endpoint.baseUrl)) {
        throw new AnalyzerKeyOriginError(endpoint.id, endpoint.name);
      }
      return new OpenAIAnalyzer({ endpoint, apiKey: stored?.key ?? null, model: selection.model }).runner;
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
    Never falls back to another engine. */
export async function generateVoiceStylePersona(
  character: CastCharacter,
  opts: { onCpu?: boolean; keepAlive?: string | number } = {},
): Promise<string> {
  const selection = resolvePersonaSelection();
  const runner = personaRunner(selection);
  const prompt = await buildVoiceStylePrompt(character);
  const raw = await runner.runFreeText(
    selection.engine === 'local'
      ? {
          prompt,
          /* Main's persona call sent the analyzer's first-attempt temperature to Ollama and none to Gemini. */
          temperature: resolveOllamaTemperature(),
          ollama: { onCpu: opts.onCpu, keepAlive: opts.keepAlive },
        }
      : { prompt },
  );
  const persona = cleanPersona(raw);
  if (!persona) {
    throw new Error(`Voice-style generation for "${character.id}" returned an empty persona.`);
  }
  return persona;
}
```
In `server/src/analyzer/ollama.ts`:
- Delete the `/** One-shot freeform Ollama call for persona generation … */` doc comment and the whole `generatePersonaViaOllama` function.
- Delete the `PERSONA_ABSOLUTE_MAX_MS` entry from the transport import.
- Keep `classifyConnectError`. If W1 left it here, the transport imports it.
- Then run `git grep -n -E "generatePersonaViaOllama|resolvePersonaEngine\b" -- server/src`. Expected remaining hits: only `src/routes/cast-design.ts`, `src/routes/cast-design.test.ts`, `src/tts/persona-gpu-plan.ts` and `src/tts/prepare-persona-batch.test.ts` (Task 4.6 removes them).

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm --prefix server run test -- src/analyzer/voice-style.test.ts src/analyzer/voice-style.endpoint.test.ts src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts src/routes/voice-style.test.ts src/workspace/cast-lock.race.test.ts`.
  - **Expected:** PASS. `npm run typecheck` still fails only on `persona-gpu-plan.ts` and `cast-design.ts` importing the removed `resolvePersonaEngine`; Task 4.6 fixes both.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Missing endpoint:** delete `if (!endpoint) throw new AnalyzerEndpointMissingError(…)`. Expected red: `endpoint missing from settings → AnalyzerEndpointMissingError…`.
  2. **Key origin:** delete the `if (stored && !keyOriginMatches(…)) { … }` block. Expected red: `endpoint key stored for another origin…`, with `send` called.
  3. **Placement scope:** replace the `runFreeText(` argument ternary with the local branch for every engine. Expected red: `endpoint: routes through OpenAITransport with no Ollama placement…`.
  4. **Same-card test:** in `personaSharesGpu`, replace `return qwenDevice === endpoint.gpu;` with `return true;`. Expected red: `an endpoint pinned to a card shares only with a Qwen on that card…`.
  5. **Estimate:** in Task 4.1's `runFreeText`, change `+ 200` to `+ 100`. Expected red: `acquires the limiter with today's estimate…`.
- [ ] **Step 6: Commit** — held until Task 4.6 makes typecheck green. Tasks 4.5 and 4.6 land as one commit (see Task 4.6 Step 6).

---

### Task 4.6: The GPU plan and the design job treat a same-card endpoint like local

**Files:**
- Modify: `server/src/tts/persona-gpu-plan.ts:3` (import) and `:41-58` (`preparePersonaBatch` doc and body).
- Modify: `server/src/routes/cast-design.ts`:
  - `:16-17` — header bullet;
  - `:56-57` — imports;
  - `:273-292` — pre-pass doc and gate;
  - `:322-323` — the wholesale rethrow;
  - `:499-514` — the lazy-persona skip.
- Test: Modify `server/src/tts/prepare-persona-batch.test.ts:12-18, :36-66`.
- Test: Modify `server/src/routes/cast-design.test.ts`:
  - `:52-62` — hoisted mocks;
  - every `resolvePersonaEngineMock` use (`:1136`, `:1143`, `:1200`, `:1234`, `:1255`, `:1277`, `:1328`, `:1379`, `:1432`);
  - `:1232-1233` — title and comment;
  - append two tests inside `describe('cast-design persona pre-pass')`.

**Interfaces:**
- **Consumes:** from Task 4.5 `personaSharesGpu()`; from `errors.ts` (W1/W3) `AnalyzerUnreachableError`, `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError`.
- **Produces:**
  - `preparePersonaBatch(bookDir)` returns `resolvePersonaGpuPlan(bookDir)` whenever `personaSharesGpu()` is true, and `{ onCpu: false, keepAlive: 0 }` otherwise. The plan fields reach only the Ollama transport; an endpoint ignores them.
  - `runPersonaPrePass` runs when `personaSharesGpu()` is true, and rethrows the three whole-job error classes.
  - The design loop's lazy persona is skipped when `personaSharesGpu()` is true.
- **Keeps green:**
  - `src/routes/cast-design.test.ts` (all);
  - `src/routes/voice-style.test.ts`;
  - `src/workspace/cast-lock.race.test.ts`. Its factory mocks omit `personaSharesGpu`, and it never runs the pre-pass or the design loop, so the missing export is never read.
  - `src/tts/prepare-persona-batch.test.ts`.

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
Then apply these mechanical replacements; the line numbers are main's.
- `resolvePersonaEngineMock.mockReturnValue('local');` → `personaSharesGpuMock.mockReturnValue(true);` at `:1143`, `:1200`, `:1277`, `:1328`, `:1379`, `:1432`.
- `resolvePersonaEngineMock.mockReturnValue('gemini');` → `personaSharesGpuMock.mockReturnValue(false);` at `:1136` and `:1234`.
- `:1255`: `expect(resolvePersonaEngineMock).toHaveBeenCalled();` → `expect(personaSharesGpuMock).toHaveBeenCalled();`
- `:1232` title → `it('no shared GPU (gemini, or an endpoint on no card): pre-pass returns early — preparePersonaBatch NOT called', async () => {`
- `:1233` comment → `// personaSharesGpuMock is already reset to false by afterEach; make it explicit.`
- `:1251` comment → `// personaSharesGpu() is false → pre-pass returns immediately.`

Then, inside `describe('cast-design persona pre-pass', …)` and before its closing `});` (main `:1470`), append:
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

  it.each([
    ['AnalyzerEndpointMissingError', async () => {
      const { AnalyzerEndpointMissingError } = await import('../analyzer/errors.js');
      return new AnalyzerEndpointMissingError('lab', 'persona');
    }],
    ['AnalyzerKeyOriginError', async () => {
      const { AnalyzerKeyOriginError } = await import('../analyzer/errors.js');
      return new AnalyzerKeyOriginError('lab', 'Lab');
    }],
  ])('a %s in the pre-pass ends the job once instead of failing every character', async (_name, makeErr) => {
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
    expect(events.some((e) => e.type === 'character_failed')).toBe(false);
    expect(events.some((e) => e.type === 'idle')).toBe(false);
    expect(designSpy).not.toHaveBeenCalled();

    writeBookOnDisk(characters);
  });
```
- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm --prefix server run test -- src/tts/prepare-persona-batch.test.ts src/routes/cast-design.test.ts`
  - **Expected:** FAIL.
    - `prepare-persona-batch`: the first case fails with `expected { onCpu: false, keepAlive: 0 } to deeply equal { onCpu: false, keepAlive: 300 }`, because `preparePersonaBatch` still reads the removed `resolvePersonaEngine`.
    - `cast-design`: every test fails at import or first call, because `cast-design.ts` still imports and calls `resolvePersonaEngine`, which the mock no longer provides (`… is not a function`).
    - After Step 3's gate swap alone, the two new cases are still red: `expected 'idle' …`, since line 323 records the error per character.
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
- Lines 16-17 (header bullet) become:
```ts
     - `generateVoiceStylePersona` (the selected persona engine) when the character has no persona,
```
- Lines 56-57 become:
```ts
import { personaSharesGpu, generateVoiceStylePersona } from '../analyzer/voice-style.js';
import {
  AnalyzerUnreachableError,
  AnalyzerEndpointMissingError,
  AnalyzerKeyOriginError,
} from '../analyzer/errors.js';
```
- Lines 273-292 (the pre-pass doc through its gate) become:
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
      `AnalyzerEndpointMissingError`, `AnalyzerKeyOriginError` → PROPAGATE
      (wholesale job abort — every remaining character would fail identically).
    - Any other per-character error → recorded to `job.failures` +
      `character_failed` broadcast + continue (design loop will skip
      characters whose persona we could not set). */
async function runPersonaPrePass(job: DesignJob, tasks: DesignTask[]): Promise<void> {
  if (!personaSharesGpu()) return;
```
- Line 323 becomes:
```ts
        if (
          err instanceof AnalyzerUnreachableError ||
          err instanceof AnalyzerEndpointMissingError ||
          err instanceof AnalyzerKeyOriginError
        ) {
          throw err; // wholesale — propagate
        }
```
- Lines 499-514 (the ENGINE SPLIT comment through the `resolvePersonaEngine() === 'local'` block) become:
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
Lines 515-517 (`persona = await generateVoiceStylePersona(character);` and the write) stay.

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm --prefix server run test -- src/tts/prepare-persona-batch.test.ts src/routes/cast-design.test.ts src/routes/voice-style.test.ts src/workspace/cast-lock.race.test.ts src/analyzer/voice-style.test.ts src/analyzer/voice-style.endpoint.test.ts`.
  - **Then run:** `npm run typecheck` and `git grep -n -E "resolvePersonaEngine|generatePersonaViaOllama" -- server/src`.
  - **Expected:** PASS; tsc clean; the grep finds nothing.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Local-only rethrow:** revert line 323 to `if (err instanceof LocalUnreachableError) throw err;` (importing `LocalUnreachableError` from `../analyzer/errors.js`). Expected red: `an endpoint unreachable error in the pre-pass ends the job wholesale…` (`errorEvent` undefined).
  2. **Selection errors:** remove the `AnalyzerEndpointMissingError` and `AnalyzerKeyOriginError` alternatives. Expected red: both `it.each` cases (`character_failed` present, `idle` emitted).
  3. **Plan gate:** in `preparePersonaBatch`, replace `!personaSharesGpu()` with `true`. Expected red: `persona shares the GPU…, idle → GPU args…`.
  4. **Pre-pass gate:** in `runPersonaPrePass`, replace `if (!personaSharesGpu()) return;` with `return;`. Expected red: `local: all personas generated before the first designQwenVoiceForCharacter…` (`preparePersonaBatch` called 0 times).
- [ ] **Step 6: Commit** (Tasks 4.5 and 4.6 together)
```bash
git add server/src/analyzer/voice-style.ts server/src/analyzer/voice-style.test.ts server/src/analyzer/voice-style.endpoint.test.ts server/src/analyzer/ollama.ts server/src/tts/persona-gpu-plan.ts server/src/tts/prepare-persona-batch.test.ts server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts
git commit -m "feat(server): generate personas through the analyzer transports for every engine"
```

---

### Task 4.7: Advanced Settings — the persona engine picker offers endpoint models

**Files:**
- Create: `src/lib/persona-engine-options.ts`.
- Test: Create `src/lib/persona-engine-options.test.ts`.
- Modify: `src/components/settings/override-row.tsx`:
  - `:1-7` — imports;
  - `:206-211` — the `inputRef` doc;
  - `:200-245` — `ControlProps` and destructure;
  - a new branch after the `enum` branch (`:437`);
  - `:541-560` — `OverrideRowProps` and destructure;
  - `:632-643` — the prop pass-through.
- Modify: `src/views/advanced.tsx`:
  - `:32` area — import;
  - `:249-253` — state;
  - `:255-285` — effect;
  - `:542-553` — prop.
- Test: Modify `src/components/settings/override-row.test.tsx` (append a describe).
- Test: Modify `src/views/advanced.test.tsx`:
  - `:16-30` — api mock;
  - `:32-38` — mocked handles;
  - `:173-194` — `beforeEach`;
  - append a describe.
- Test: Modify `src/test/a11y.test.tsx:140-147` — add `getAnalyzerModels` to the api mock.

**Interfaces:**
- **Consumes:**
  - `KnobDescriptor.type` `'analyzer-engine'` (Task 4.4);
  - W3c's `api.getAnalyzerModels()`, returning `AnalyzerCatalog` (`src/lib/types.ts`, generated from `components['schemas']['AnalyzerCatalog']`, Task 3c.6).
  - Its shape (master contract): `{ groups: Array<{ kind: 'ollama' | 'gemini' | 'endpoint'; id: string; label: string; status: 'ok' | 'fallback' | 'error'; error?: string; models: Array<{ id: string; label: string; contextTokens?: number; outputTokens?: number; capability?: ModelCapabilityRecord; offeredReasoningLevels?: string[] }> }> }`. An endpoint group's `id` is the endpoint id, its `label` the endpoint name, and each entry's `label` the bare model name. W3c's entries also carry `engine`, `model`, `structuredOutput` and `testPlan`; this task reads none of them.
- **Produces:**
  ```ts
  // src/lib/persona-engine-options.ts
  export interface AnalyzerEngineOption { value: string; label: string }
  export function endpointModelOptions(catalog: AnalyzerCatalog): AnalyzerEngineOption[];
  export function analyzerEngineOptions(staticValues: readonly string[], endpointModels: readonly AnalyzerEngineOption[], current: string): AnalyzerEngineOption[];
  // OverrideRowProps.analyzerEndpointModels?: AnalyzerEngineOption[]
  ```
- **Keeps green:**
  - `src/components/settings/override-row.test.tsx` (all);
  - `src/views/advanced.test.tsx` (all, including the device-knob picker cases);
  - `src/test/a11y.test.tsx`;
  - `src/lib/api.config.test.ts`.

- [ ] **Step 1: Write the failing tests**

`src/lib/persona-engine-options.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { analyzerEngineOptions, endpointModelOptions } from './persona-engine-options';

const CATALOG = {
  groups: [
    { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [{ id: 'qwen3.5:9b', label: 'qwen3.5:9b' }] },
    { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok', models: [{ id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' }] },
    { kind: 'endpoint', id: 'lab', label: 'Lab box', status: 'ok', models: [{ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b' }] },
    { kind: 'endpoint', id: 'down', label: 'Down box', status: 'error', error: 'connect ECONNREFUSED', models: [] },
  ],
} as Parameters<typeof endpointModelOptions>[0];

describe('endpointModelOptions', () => {
  it('lists only OpenAI-compatible endpoint models, labelled with the endpoint', () => {
    expect(endpointModelOptions(CATALOG)).toEqual([{ value: 'openai:lab::qwen3-30b', label: 'Lab box · qwen3-30b' }]);
  });
});

describe('analyzerEngineOptions', () => {
  const lab = [{ value: 'openai:lab::qwen3-30b', label: 'Lab box · qwen3-30b' }];

  it('puts the static entries first, then endpoint models', () => {
    expect(analyzerEngineOptions(['local', 'gemini'], lab, 'gemini').map((o) => o.value)).toEqual([
      'local',
      'gemini',
      'openai:lab::qwen3-30b',
    ]);
  });

  it('keeps a saved value the lists no longer have, flagged, so the select never shows a different choice', () => {
    const options = analyzerEngineOptions(['local', 'gemini'], [], 'openai:gone::qwen3');
    expect(options.map((o) => o.value)).toEqual(['local', 'gemini', 'openai:gone::qwen3']);
    expect(options[2].label).toBe('openai:gone::qwen3 (not in the current model list)');
  });

  it('does not duplicate a current value that is already offered', () => {
    expect(analyzerEngineOptions(['local', 'gemini'], lab, 'openai:lab::qwen3-30b')).toHaveLength(3);
  });
});
```
Append to `src/components/settings/override-row.test.tsx`:
```tsx
/* ─── analyzer-engine picker (#3084 W4) ─────────────────────────────────── */

describe('OverrideRow — analyzer-engine picker', () => {
  const descriptor = makeDescriptor({
    key: 'analyzer.personaGeneration.engine',
    label: 'Persona generation engine',
    type: 'analyzer-engine',
    options: ['local', 'gemini'],
    default: 'gemini',
    min: undefined,
    max: undefined,
    step: undefined,
  });
  const models = [{ value: 'openai:lab::qwen3-30b', label: 'Lab box · qwen3-30b' }];

  it('offers local, gemini and every endpoint model, and saves the picked endpoint model id', () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ key: descriptor.key, effective: 'gemini' })}
        onChange={onChange}
        onRevert={vi.fn()}
        analyzerEndpointModels={models}
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Persona generation engine' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['local', 'gemini', 'openai:lab::qwen3-30b']);
    expect(select.value).toBe('gemini');
    fireEvent.change(select, { target: { value: 'openai:lab::qwen3-30b' } });
    expect(onChange).toHaveBeenCalledWith('openai:lab::qwen3-30b');
  });

  it('keeps a saved endpoint model selectable when the catalog no longer lists it', () => {
    render(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ key: descriptor.key, effective: 'openai:gone::qwen3', source: 'override', overridden: true })}
        onChange={vi.fn()}
        onRevert={vi.fn()}
        analyzerEndpointModels={[]}
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Persona generation engine' }) as HTMLSelectElement;
    expect(select.value).toBe('openai:gone::qwen3');
    expect(screen.getByRole('option', { name: 'openai:gone::qwen3 (not in the current model list)' })).toBeInTheDocument();
  });

  it('is disabled when the knob is set in .env', () => {
    render(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ key: descriptor.key, effective: 'local', source: 'env', locked: true })}
        onChange={vi.fn()}
        onRevert={vi.fn()}
        analyzerEndpointModels={models}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Persona generation engine' })).toBeDisabled();
  });
});
```
`src/views/advanced.test.tsx`:
- Add `getAnalyzerModels: vi.fn(),` to the `api` mock object (`:16-30`).
- Add `const mockGetAnalyzerModels = vi.mocked(api.getAnalyzerModels);` after `:38`.
- Add `mockGetAnalyzerModels.mockResolvedValue({ groups: [] });` as the last line of `beforeEach` (`:193`).
- Then append:
```tsx
/* ── Persona engine picker (#3084 W4) ─────────────────────────────────────── */

describe('AdvancedView — persona engine picker', () => {
  const PERSONA_CONFIG: ConfigResponse = {
    ...FIXTURE_CONFIG,
    groups: [
      { id: 'analyzer-models', label: 'Analyzer models', help: 'Models.', risk: 'low', collapsedByDefault: false },
    ],
    descriptors: [
      {
        key: 'analyzer.personaGeneration.engine',
        group: 'analyzer-models',
        label: 'Persona generation engine',
        help: 'Which engine writes voice personas.',
        type: 'analyzer-engine',
        options: ['local', 'gemini'],
        apply: 'live',
        risk: 'medium',
        isPrompt: false,
        default: 'gemini',
      },
    ],
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

  it('lists endpoint models from the analyzer catalog in the persona engine row', async () => {
    mockGetConfig.mockResolvedValue(PERSONA_CONFIG);
    mockGetAnalyzerModels.mockResolvedValue({
      groups: [
        { kind: 'endpoint', id: 'lab', label: 'Lab box', status: 'ok', models: [{ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b' }] },
      ],
    } as Awaited<ReturnType<typeof api.getAnalyzerModels>>);
    renderView();
    const select = (await screen.findByRole('combobox', { name: 'Persona generation engine' })) as HTMLSelectElement;
    await waitFor(() =>
      expect([...select.options].map((o) => o.value)).toEqual(['local', 'gemini', 'openai:lab::qwen3-30b']),
    );
  });

  it('still offers local and gemini when the catalog request fails', async () => {
    mockGetConfig.mockResolvedValue(PERSONA_CONFIG);
    mockGetAnalyzerModels.mockRejectedValue(new Error('offline'));
    renderView();
    const select = (await screen.findByRole('combobox', { name: 'Persona generation engine' })) as HTMLSelectElement;
    await waitFor(() => expect(mockGetAnalyzerModels).toHaveBeenCalled());
    expect([...select.options].map((o) => o.value)).toEqual(['local', 'gemini']);
  });
});
```
In `src/test/a11y.test.tsx`, add to the api mock object after `getAnalyzerGpuSplit: mockGetAnalyzerGpuSplit,` (`:146`):
```ts
      getAnalyzerModels: () => Promise.resolve({ groups: [] }),
```
- [ ] **Step 2: Run them and confirm they fail**
  - **Run:** `npm test -- src/lib/persona-engine-options.test.ts src/components/settings/override-row.test.tsx src/views/advanced.test.tsx`
  - **Expected:** FAIL.
    - `persona-engine-options.test.ts` fails with `Failed to resolve import "./persona-engine-options"`.
    - The override-row picker cases fail with `Unable to find an accessible element with the role "combobox" and name "Persona generation engine"`: the knob still renders as a text input.
    - The advanced cases fail with the same missing combobox.
- [ ] **Step 3: Implement**

`src/lib/persona-engine-options.ts`:
```ts
/* #3084 W4 — options for an 'analyzer-engine' knob (today only analyzer.personaGeneration.engine):
   the knob's static entries (local, gemini), then every OpenAI-compatible endpoint model the
   analyzer catalog lists, then the saved value when neither list has it (an endpoint deleted, or
   not listed right now) — so the select never silently shows a different choice than the one in
   effect. Static entries keep their raw labels, exactly as the enum row rendered them. */
import type { AnalyzerCatalog } from './types';

export interface AnalyzerEngineOption {
  value: string;
  label: string;
}

/** Endpoint groups only (`kind: 'endpoint'`): the group label is the endpoint name and each
    entry's label is the bare model name. A group whose listing failed (`status: 'error'`)
    has no models, so it contributes nothing. */
export function endpointModelOptions(catalog: AnalyzerCatalog): AnalyzerEngineOption[] {
  return catalog.groups
    .filter((group) => group.kind === 'endpoint')
    .flatMap((group) => group.models.map((model) => ({ value: model.id, label: `${group.label} · ${model.label}` })));
}

export function analyzerEngineOptions(
  staticValues: readonly string[],
  endpointModels: readonly AnalyzerEngineOption[],
  current: string,
): AnalyzerEngineOption[] {
  const options: AnalyzerEngineOption[] = staticValues.map((value) => ({ value, label: value }));
  for (const model of endpointModels) {
    if (!options.some((o) => o.value === model.value)) options.push(model);
  }
  if (current !== '' && !options.some((o) => o.value === current)) {
    options.push({ value: current, label: `${current} (not in the current model list)` });
  }
  return options;
}
```
`src/components/settings/override-row.tsx`:
- Add the import after line 7:
```ts
import { analyzerEngineOptions, type AnalyzerEngineOption } from '../../lib/persona-engine-options';
```
- In `ControlProps`, after `gpuDevices?: GpuDevice[];`:
```ts
  /** Endpoint model options from GET /api/analyzer/models — only consumed by type: 'analyzer-engine' knobs (#3084 W4). */
  analyzerEndpointModels?: AnalyzerEngineOption[];
```
- In the `inputRef` doc (`:209-210`), change "Left unattached (stays null) for boolean/enum/device rows" to "Left unattached (stays null) for boolean/enum/device/analyzer-engine rows".
- Add `analyzerEndpointModels,` to `KnobControl`'s destructure after `gpuDevices,`.
- Insert this branch immediately after the `enum` branch's closing `}` (`:437`):
```tsx
  if (descriptor.type === 'analyzer-engine') {
    const current = String(value.effective);
    const options = analyzerEngineOptions(descriptor.options ?? [], analyzerEndpointModels ?? [], current);
    return (
      <select
        aria-label={descriptor.label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        value={current}
        disabled={disabled}
        onChange={(e) => commitSimple(e.target.value)}
        className={`w-full ${base}`}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }
```
- In `OverrideRowProps`, after `gpuDevices?: GpuDevice[];`:
```ts
  /** Endpoint model options from GET /api/analyzer/models — only consumed by type: 'analyzer-engine' knobs (#3084 W4). */
  analyzerEndpointModels?: AnalyzerEngineOption[];
```
- Change the `OverrideRow` signature to `export function OverrideRow({ descriptor, value, onChange, onRevert, gpuDevices, analyzerEndpointModels }: OverrideRowProps) {`.
- Add `analyzerEndpointModels={analyzerEndpointModels}` to the `<KnobControl …>` props after `gpuDevices={gpuDevices}`.

`src/views/advanced.tsx`:
- After line 32 (`import { api } from '../lib/api';`):
```ts
import { endpointModelOptions, type AnalyzerEngineOption } from '../lib/persona-engine-options';
```
- After the `gpuSplit` state (`:253`):
```ts
  const [analyzerEndpointModels, setAnalyzerEndpointModels] = useState<AnalyzerEngineOption[]>([]);
```
- Inside the mount effect, after the `getAnalyzerGpuSplit` chain (before `}, [dispatch]);` at `:285`):
```ts
    // #3084 W4 — same best-effort contract as the device probe: a failed
    // catalog read leaves an analyzer-engine picker with its static entries
    // and the saved value, never an error.
    api
      .getAnalyzerModels()
      .then((catalog) => setAnalyzerEndpointModels(endpointModelOptions(catalog)))
      .catch(() => setAnalyzerEndpointModels([]));
```
- On the `<OverrideRow …>` (`:542-553`), add `analyzerEndpointModels={analyzerEndpointModels}` after `gpuDevices={gpuDevices}`.

- [ ] **Step 4: Run and confirm they pass**
  - **Run:** `npm test -- src/lib/persona-engine-options.test.ts src/components/settings/override-row.test.tsx src/views/advanced.test.tsx src/test/a11y.test.tsx src/lib/api.config.test.ts`, then `npm run typecheck`.
  - **Expected:** PASS.
- [ ] **Step 5: Mutation proof** (restore after each):
  1. **Saved value:** in `analyzerEngineOptions`, delete the `if (current !== '' && …)` push. Expected red: `keeps a saved value the lists no longer have…` and `keeps a saved endpoint model selectable when the catalog no longer lists it`.
  2. **Picker branch:** delete the `analyzer-engine` branch in `KnobControl`. Expected red: `offers local, gemini and every endpoint model…` (no combobox).
  3. **Catalog wiring:** in `advanced.tsx`, change `endpointModelOptions(catalog)` to `[]`. Expected red: `lists endpoint models from the analyzer catalog in the persona engine row`.
- [ ] **Step 6: Commit**
```bash
git add src/lib/persona-engine-options.ts src/lib/persona-engine-options.test.ts src/components/settings/override-row.tsx src/components/settings/override-row.test.tsx src/views/advanced.tsx src/views/advanced.test.tsx src/test/a11y.test.tsx
git commit -m "feat(frontend): offer endpoint models in the persona generation engine picker"
```

No Playwright spec. The spec's E2E list names no persona case. The change is one control inside an existing Advanced Settings row; it crosses no router, redux or layout seam; and the RTL tests drive the real `AdvancedView` → `OverrideRow` render path.

---

### Task 4.8: Ship

**Files:**
- Modify: `docs/features/284-openai-compatible-analyzer.md` — new invariant 7, a test-plan bullet, walkthrough step 5.
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`.

- [ ] **Step 1: Regression plan.**

In `docs/features/284-openai-compatible-analyzer.md`, append to `## Invariants to preserve` (after item 6):
```markdown
7. **Persona generation.** A persona runs through the selected engine's transport with no cross-provider fallback (`server/src/analyzer/voice-style.ts`).
   - **Ollama:** the call stays non-streaming with a caller `keep_alive` and CPU placement. It is bounded by `PERSONA_ABSOLUTE_MAX_MS`, which starts after the analyzer slot is acquired, and the slot is released on every path (`server/src/analyzer/transports/ollama-transport.ts`, `ollama-timeout.test.ts`).
   - **Gemini:** the limiter estimate stays `ceil(prompt.length / 4) + 200`, and the persona wire carries no system instruction, temperature or output cap.
   - **Shared card:** a persona engine that shares the Qwen card (local, or a same-card endpoint) is generated before VoiceDesign loads (`server/src/routes/cast-design.ts`).
```
Under `### Automated coverage`, add after the `Routes (server)` bullet:
```markdown
- **Persona generation (server and frontend).**
  - The runner's free-text path, and each transport's free-text wire shape against a stage-request control.
  - The persona engine knob's grammar, pinned to the shared id case table.
  - Selection errors before any call (missing endpoint, key origin), and endpoint wiring over a real server (key header, in-flight registration, concurrency 1).
  - The same-card rule, and the design pre-pass's wholesale errors.
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
  - **Endpoints:** an endpoint persona gets the analyzer limiter, the endpoint's concurrency and request ceiling, GPU in-flight accounting and the key-origin rule. A missing endpoint fails as `AnalyzerEndpointMissingError` (source `persona`) before any call.
  - **Ollama:** it keeps its non-streaming call, `keep_alive` window, CPU placement and 600 s bound.
  - **Gemini:** it keeps its request shape and limiter estimate, and now retries rate-limit and server errors through the shared transport retry helper.
  - **Shared card:** a persona engine on the Qwen card follows the local ordering in Design full cast (personas before VoiceDesign loads).
  - **Errors:** an unreachable, missing or key-mismatched persona endpoint ends the design job once instead of failing every character. There is still no cross-provider fallback. (#PR, refs #3084)
```
At the top of the in-progress `# Castwright 1.15.0` section of `RELEASE_NOTES.md`, add:
```markdown
- **You can write your cast's voice descriptions with your own model server.** If you've connected an OpenAI-compatible server — llama.cpp, LM Studio, vLLM and the like — for analysis, you can now pick one of its models to write each character's voice description too, under Persona generation engine in Advanced configuration. It shares the same limits and graphics-card coordination as analysis, and if that server is missing or can't be reached, Castwright tells you once and stops rather than quietly switching to Gemini. Gemini voice descriptions also ride out a brief rate limit or server hiccup now instead of failing that character.
```
Replace `#PR` with the PR number once it is opened.

- [ ] **Step 3: Generated artifacts and checks.**
  - **OpenAPI:** untouched. Config descriptors are not in `openapi.yaml`, and no wire shape changed, so there is no `openapi:types`.
  - **Config:** `npm run config:check`, which Task 4.4 already synced.
  - **Typecheck:** `npm run typecheck`.
  - **Branch battery:** `npm run verify:fast:branch`.
  - **Slow lane:** `npm --prefix server run test -- --config vitest.config.slow.ts src/analyzer/gemini.test.ts`, the only slow-lane file this PR can affect.

- [ ] **Step 4: On-box acceptance — no new row, stated in the PR body.**

Everything this PR adds is provable in automation: selection, the free-text wire shape per transport, the Ollama bound and slot release, the limiter estimate, key-origin and missing-endpoint refusals, endpoint wiring over a real HTTP server, the same-card rule, and the pre-pass ordering and errors.

The hardware consequence — a same-card endpoint's model yielding the card to VoiceDesign after the pre-pass — is a Qwen TTS load on that endpoint's card. That is exactly the "Same-card eviction" row W3 owns. The register, run sheet and live view are therefore unchanged.

- [ ] **Step 5: Commit the docs, push, open the PR.**
```bash
git add docs/features/284-openai-compatible-analyzer.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): record persona generation through the analyzer transports"
git push -u origin feat/server,frontend-3084-w4-persona
```
PR title: `feat(server,frontend): generate personas through the analyzer transports`. The body keeps the template's sections:
```markdown
## Summary
- `analyzer.personaGeneration.engine` accepts `local`, `gemini` or `openai:<endpointId>::<model>` (new `analyzer-engine` knob type, picked in Advanced Settings from the analyzer model catalog); `PERSONA_GEN_ENGINE=local|gemini` keeps working.
- Persona calls for every engine run through `StageRunner.runFreeText` and the engine transport. Ollama's non-streaming persona call, `keep_alive`, CPU placement and 600 s bound moved into `OllamaTransport` unchanged; Gemini keeps its wire shape and limiter estimate and gains the shared retry helper; endpoint personas get the limiter, concurrency, ceiling, in-flight accounting and key-origin rule, and a missing endpoint fails before any call.
- `personaSharesGpu()` (local, or an endpoint on the Qwen card) replaces `engine === 'local'` in `preparePersonaBatch` and Design full cast. The pre-pass ends the job once on an unreachable, missing or key-mismatched persona engine.
- Plan: docs/features/284-openai-compatible-analyzer.md (invariant 7). Spec D10 / §10.

## Test plan
- [ ] server: stage-runner.free-text, ollama, ollama-timeout, gemini/openai-transport.free-text, registry, config route, voice-style, voice-style.endpoint (real HTTP), prepare-persona-batch, cast-design
- [ ] frontend: persona-engine-options, override-row, advanced, a11y
- [ ] mutation proofs (outputs pasted below)
- [ ] `npm run typecheck`, `npm run config:check`, `npm run verify:fast:branch`, slow-lane gemini.test.ts
- On-box: no new row — see Task 4.8 Step 4 reasoning (covered by W3's same-card eviction row).

Refs #3084

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
- [ ] **Step 6: `pr-review-gate`** at depth `high` (a multi-scope `feat`). Fold its findings, re-run the affected tests, and merge once cloud `verify.yml` is green.
