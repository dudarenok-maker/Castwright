# OpenAI-compatible analyzer — Wave 1 plan

> Part of the [OpenAI-compatible analyzer implementation plan](2026-09-11-openai-compatible-analyzer.md). Read that file first: its Global Constraints, planning decisions (P1–P11) and interface contract bind every task below. Spec: [2026-09-10-openai-compatible-analyzer-design.md](../specs/2026-09-10-openai-compatible-analyzer-design.md).

## Wave 1 — One stage runner + Ollama/Gemini transports (behaviour-preserving)

**Goal.** Replace the two hand-rolled stage runners (`OllamaAnalyzer.runStage`, `GeminiAnalyzer.runStage`) with one `StageRunner` driving a per-engine `ChatTransport` + `ValidationRetryPolicy`, without changing a single request body, error message, forensic file, retry, telemetry call or failure-taxonomy outcome. The one intended behaviour change is the leading-`<think>` strip in `parseAndValidate` (PR 1b, Task 1.12).

**Line numbers** below are as of `origin/main` 2b63b451. Wave 0 (#3139, #3141) touches `rate-limit.ts`, `select-analyzer.ts`, `user-settings.ts`; re-read every cited range before editing (Global Constraints).

### Commands used throughout (run from the worktree root; never `cd`)

| What | Command |
|---|---|
| One main-lane server test file | `npm --prefix server run test -- <path relative to server/>` (e.g. `src/analyzer/ollama.test.ts`) |
| `gemini.test.ts` (it is in `SLOW_FILES`, `server/vitest.config.slow.ts:45-57`, and excluded from the main config — the main command reports "No test files found" for it) | `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts` |
| Red-phase / mutation runs (the main config has `retry: 1`, `server/vitest.config.ts:255`, which can turn a genuine red green — #2028) | append `--retry=0` |
| Analyzer subtree (main lane) | `npm run test:server:analyzer` |
| Route subtree | `npm run test:server:routes` |
| Typecheck (frontend + server) | `npm run typecheck` |
| Import-cycle guard (`scripts/check-import-cycles.mjs`, subset check against `server/madge-cycles-allowlist.json`; network `npx madge@8.0.0`) | `npm run check:cycles` |

**Madge counts `import type` edges.** Proof: `server/madge-cycles-allowlist.json:2` lists `analyzer/index.ts ↔ analyzer/gemini.ts`, whose only back-edge is `import type { Analyzer, StageCall, StageChunkInfo } from './index.js'` (`gemini.ts:36`). Every new file in this wave therefore imports the analyzer interface types from the new leaf `server/src/analyzer/types.ts` (Task 1.5), never from `./index.js`.

---

### PR 1a — Characterise, type the errors, move the shared helpers

- **Branch:** `node scripts/wt-new.mjs refactor/server-3084-w1a-characterise` (the contract's `test/…` placeholder renamed per content: the PR also refactors).
- **Delivers:** characterisation tests pinning every runner difference in spec §1 and the Ollama HTTP taxonomy outcomes (green on unmodified code, written first); `TransportKind`, `AnalyzerUnreachableError`, `AnalyzerHttpError` in `errors.ts`; `AnalysisAbortedError` + `LocalUnreachableError` moved to `errors.ts` with re-exports from `ollama.ts`; the plain `Error` at `ollama.ts:709-716` replaced by `AnalyzerHttpError`; `FallbackAnalyzer` keyed on `AnalyzerUnreachableError`; the analyzer interface types moved to a leaf `types.ts`; shared helpers moved from `gemini.ts` to `runner/parse.ts` + `runner/prompt.ts` with re-exports; all three `analyzer/` import cycles removed from the allowlist.
- **Must NOT change:** any error message text, error `name`/`code` of `AnalysisAbortedError`/`LocalUnreachableError`, any request body, any handoff file, any `classifyAnalysisFailure` outcome, `generatePersonaViaOllama` (wave 4 owns persona; its own non-OK throw at `ollama.ts:1019-1022` stays a plain `Error`).
- **Entry:** wave 0 merged; cited ranges re-verified on the new `main`.
- **Exit:** Tasks 1.1–1.6 committed; `test:server:analyzer`, the slow `gemini.test.ts`, `src/routes/failure-taxonomy.test.ts`, `npm run typecheck`, `npm run check:cycles` all green; `pr-review-gate` pass recorded.

### Task 1.1: Characterise the Ollama runner's retry, forensics and escalation policy

**Files:**
- Modify: `server/src/analyzer/ollama.test.ts` (append one `describe` before the final `afterAll` at `:1454`)
- Test: `server/src/analyzer/ollama.test.ts`

**Interfaces:**
- Consumes: `OllamaAnalyzer`, `LocalUnreachableError`, `AnalysisAbortedError` from `./ollama.js` (today's exports); the file's existing helpers `fetchMock`, `okResponse`, `ndjsonStream`, `ndjsonStreamWithDoneReason`, `ndjsonStreamWithTiming`, `chunksOf`, `VALID_RESPONSE`, `HANDOFF_ROOT`.
- Produces: pins later tasks must keep green — exact final-failure message prefix, `errors.json` attempt-2 shape, schema-retry replay contents, escalation rethrow set `{AnalysisAbortedError, LocalUnreachableError}`, escalation `null` on non-OK and on truncation, escalation passes no `onEvalTiming`.

Existing coverage this task deliberately does NOT duplicate: invalid-JSON retry drops the assistant turn at the retry temperature (`ollama.test.ts:711-749`); schema retry role shape + 0.2 (`:668-704`); `attempt{1,2}.raw.txt` forensics (`:785-831`); escalation null on empty/malformed (`:1327-1358`); 404/500 not unreachable (`:617-648`).

- [ ] **Step 1: Write the characterisation tests**
```ts
describe('OllamaAnalyzer — runner characterisation (#3084 wave 1)', () => {
  const IDS = [
    'm_ollama_char_final',
    'm_ollama_char_replay',
    'm_ollama_char_esc_down',
    'm_ollama_char_esc_abort',
    'm_ollama_char_esc_500',
    'm_ollama_char_esc_trunc',
    'm_ollama_char_esc_timing',
  ];

  afterEach(async () => {
    for (const id of IDS) {
      for (const key of ['stage1-ch1', 'stageescalation-ch1-w0']) {
        await rm(resolve(HANDOFF_ROOT, 'inbox', `${id}-${key}.md`), { force: true });
        await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-${key}.json`), { force: true });
        await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-${key}.errors.json`), { force: true });
        await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-${key}.attempt1.raw.txt`), { force: true });
        await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-${key}.attempt2.raw.txt`), { force: true });
      }
    }
  });

  it('pins the final validation-failure message and the attempt-2 errors.json payload', async () => {
    const bad = JSON.stringify({ characters: 'nope' });
    fetchMock.mockImplementation(() => Promise.resolve(okResponse(ndjsonStream(chunksOf(bad, 32)))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const { readFile } = await import('node:fs/promises');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    const err = await analyzer
      .runStage1Chapter('m_ollama_char_final', 1, '# prompt', {})
      .then(() => null, (e: Error) => e);

    expect(err?.message.startsWith('Ollama qwen3.5:9b 1-ch1 failed validation after retry: schema-validation — ')).toBe(true);
    const errorsJson = JSON.parse(
      await readFile(resolve(HANDOFF_ROOT, 'outbox', 'm_ollama_char_final-stage1-ch1.errors.json'), 'utf8'),
    );
    expect(errorsJson).toMatchObject({ kind: 'schema-validation', attempt: 2, firstError: { kind: 'schema-validation' } });
  });

  it('a schema-validation retry replays the exact first output and buildRetryMessage text', async () => {
    const strictlyInvalid = JSON.stringify({ characters: 'nope' });
    fetchMock
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(strictlyInvalid, 32))))
      .mockResolvedValueOnce(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });

    await analyzer.runStage1Chapter('m_ollama_char_replay', 1, '# prompt', {});

    const first = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    expect(second.messages).toHaveLength(4);
    expect(second.messages[0]).toEqual(first.messages[0]); // same system instruction
    expect(second.messages[1]).toEqual({ role: 'user', content: '# prompt' });
    expect(second.messages[2]).toEqual({ role: 'assistant', content: strictlyInvalid });
    expect(second.messages[3].role).toBe('user');
    expect(second.messages[3].content.startsWith('Your previous response failed schema validation.')).toBe(true);
    expect(second.format).toEqual(first.format); // same grammar on the retry
  });

  it('escalation rethrows LocalUnreachableError instead of resolving null', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    await expect(
      analyzer.runAttributionEscalation('m_ollama_char_esc_down', 1, 0, 'resolve these lines', {}),
    ).rejects.toBeInstanceOf(LocalUnreachableError);
  });

  it('escalation rethrows AnalysisAbortedError for an already-aborted signal, before any fetch', async () => {
    const ac = new AbortController();
    ac.abort();
    const { OllamaAnalyzer, AnalysisAbortedError } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    await expect(
      analyzer.runAttributionEscalation('m_ollama_char_esc_abort', 1, 0, 'resolve these lines', { signal: ac.signal }),
    ).rejects.toBeInstanceOf(AnalysisAbortedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escalation resolves null on a non-OK 500 and on a done_reason:length stream', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500, statusText: 'Internal Server Error' }))
      .mockResolvedValueOnce(okResponse(ndjsonStreamWithDoneReason(['{"assignments":[{"line":1'], 'length')));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    expect(await analyzer.runAttributionEscalation('m_ollama_char_esc_500', 1, 0, 'p', {})).toBeNull();
    expect(await analyzer.runAttributionEscalation('m_ollama_char_esc_trunc', 1, 0, 'p', {})).toBeNull();
  });

  it('escalation does not forward onEvalTiming (only runStage calls pass the telemetry sink)', async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        ndjsonStreamWithTiming(chunksOf(JSON.stringify({ assignments: [] }), 8), {
          eval_count: 10,
          eval_duration: 1_000_000,
          prompt_eval_count: 20,
          prompt_eval_duration: 1_000_000,
          load_duration: 0,
        }),
      ),
    );
    const onEvalTiming = vi.fn();
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    expect(await analyzer.runAttributionEscalation('m_ollama_char_esc_timing', 1, 0, 'p', { onEvalTiming })).toEqual({
      assignments: [],
    });
    expect(onEvalTiming).not.toHaveBeenCalled();
  });
});
```
- [ ] **Step 2: Run on unmodified code**  Run: `npm --prefix server run test -- src/analyzer/ollama.test.ts --retry=0`  Expected: PASS (characterisation — these describe `main`; if any fails, the test is wrong, not the code: fix the test to what `main` does and note it in the PR body).
- [ ] **Step 3: Implement** — none (characterisation only).
- [ ] **Step 4: Confirm stable**  Run the Step 2 command again. Expected: PASS.
- [ ] **Step 5: Mutation proofs** (paste each red run in the PR body, then restore with `git checkout -- server/src/analyzer/ollama.ts`):
  1. Delete `ollama.ts:456` (`if (err instanceof LocalUnreachableError) throw err;`) → red: "escalation rethrows LocalUnreachableError instead of resolving null".
  2. At `ollama.ts:568` replace `content: firstText` with `content: ''` → red: "a schema-validation retry replays the exact first output…".
  3. At `ollama.ts:453` add `call.onEvalTiming,` as the sixth `this.chat(...)` argument → red: "escalation does not forward onEvalTiming…".
  4. At `ollama.ts:609` replace `${this.model} ${key}` with `${key}` → red: "pins the final validation-failure message…".
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/ollama.test.ts
git commit -m "test(server): characterise ollama runner retry, forensics and escalation policy"
```

### Task 1.2: Characterise the Gemini runner's retry and escalation policy

**Files:**
- Modify: `server/src/analyzer/gemini.test.ts` (append one `describe` at end of file, after `:1067`)
- Test: `server/src/analyzer/gemini.test.ts` (slow lane)

**Interfaces:**
- Consumes: `GeminiAnalyzer` (`./gemini.js`), `AnalysisAbortedError` (`./ollama.js` today), `generateContentStream` mock, `asyncFromArray`, `chunksOf`, `HANDOFF_ROOT`, `rm`.
- Produces: pins — Gemini always replays the model turn (for BOTH failure kinds) at the same temperature and system instruction; writes `errors.json` but no `attempt*.raw.txt`; final message `Gemini <key> failed validation after retry: <kind> — …`; escalation resolves `null` on `DailyQuotaExhaustedError` with no retry and rethrows only `AnalysisAbortedError`.

`gemini.test.ts` has no assertion on the retry request today (spec §1 "Characterisation first").

- [ ] **Step 1: Write the characterisation tests**
```ts
describe('GeminiAnalyzer — runner characterisation (#3084 wave 1)', () => {
  const PER_CHAPTER = JSON.stringify({
    characters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' }],
  });
  const IDS = ['m_gem_char_schema', 'm_gem_char_json', 'm_gem_char_final', 'm_gem_char_daily', 'm_gem_char_abort'];

  /* An earlier describe calls vi.resetModules(), detaching this file's static
     geminiRateLimiter import from the instance gemini.js uses — reset the live
     one, and use model ids no other test uses so a daily-quota block cannot leak. */
  beforeEach(async () => {
    const { geminiRateLimiter: limiter } = await import('./rate-limit.js');
    limiter._reset();
  });

  afterAll(async () => {
    for (const id of IDS) {
      for (const key of ['stage1-ch1', 'stageescalation-ch1-w0']) {
        await rm(resolve(HANDOFF_ROOT, 'inbox', `${id}-${key}.md`), { force: true });
        await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-${key}.json`), { force: true });
        await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-${key}.errors.json`), { force: true });
      }
    }
  });

  function apiError429PerDay(): Error {
    const body = {
      error: {
        code: 429,
        message: 'Quota exceeded for metric: generate_requests_per_model_per_day_free_tier, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier',
        status: 'RESOURCE_EXHAUSTED',
      },
    };
    return Object.assign(new Error(`got status: 429. ${JSON.stringify(body)}`), { status: 429 });
  }

  it('schema-validation retry replays [user, model(firstText), user(buildRetryMessage)] at the same temperature and system', async () => {
    const strictlyInvalid = JSON.stringify({ characters: 'nope' });
    generateContentStream
      .mockResolvedValueOnce(asyncFromArray([{ text: strictlyInvalid }]))
      .mockResolvedValueOnce(asyncFromArray([{ text: PER_CHAPTER }]));
    const { GeminiAnalyzer } = await import('./gemini.js');
    const { existsSync } = await import('node:fs');
    const analyzer = new GeminiAnalyzer({ apiKey: 'k', model: 'gemma-char-schema' });

    await analyzer.runStage1Chapter('m_gem_char_schema', 1, '# prompt', {});

    const first = generateContentStream.mock.calls[0][0];
    const second = generateContentStream.mock.calls[1][0];
    expect(first.contents).toEqual([{ role: 'user', parts: [{ text: '# prompt' }] }]);
    expect(second.contents).toHaveLength(3);
    expect(second.contents[0]).toEqual({ role: 'user', parts: [{ text: '# prompt' }] });
    expect(second.contents[1]).toEqual({ role: 'model', parts: [{ text: strictlyInvalid }] });
    expect(second.contents[2].role).toBe('user');
    expect(second.contents[2].parts[0].text.startsWith('Your previous response failed schema validation.')).toBe(true);
    expect(second.config.temperature).toBe(first.config.temperature);
    expect(second.config.systemInstruction).toBe(first.config.systemInstruction);
    expect(second.config.responseMimeType).toBe('application/json');
    expect(existsSync(resolve(HANDOFF_ROOT, 'outbox', 'm_gem_char_schema-stage1-ch1.errors.json'))).toBe(true);
    expect(existsSync(resolve(HANDOFF_ROOT, 'outbox', 'm_gem_char_schema-stage1-ch1.attempt1.raw.txt'))).toBe(false);
  });

  it('invalid-json retry ALSO replays the model turn at the same temperature (unlike Ollama)', async () => {
    const malformed = '{ "characters": [ { "id": "narrator"';
    generateContentStream
      .mockResolvedValueOnce(asyncFromArray([{ text: malformed }]))
      .mockResolvedValueOnce(asyncFromArray([{ text: PER_CHAPTER }]));
    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'k', model: 'gemma-char-json' });

    await analyzer.runStage1Chapter('m_gem_char_json', 1, '# prompt', {});

    const first = generateContentStream.mock.calls[0][0];
    const second = generateContentStream.mock.calls[1][0];
    expect(second.contents).toHaveLength(3);
    expect(second.contents[1]).toEqual({ role: 'model', parts: [{ text: malformed }] });
    expect(second.contents[2].parts[0].text.startsWith('Your previous response was not valid JSON:')).toBe(true);
    expect(second.config.temperature).toBe(first.config.temperature);
  });

  it('pins the final validation-failure message', async () => {
    const bad = JSON.stringify({ characters: 'nope' });
    generateContentStream
      .mockResolvedValueOnce(asyncFromArray([{ text: bad }]))
      .mockResolvedValueOnce(asyncFromArray([{ text: bad }]));
    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'k', model: 'gemma-char-final' });
    const err = await analyzer.runStage1Chapter('m_gem_char_final', 1, '# prompt', {}).then(() => null, (e: Error) => e);
    expect(err?.message.startsWith('Gemini 1-ch1 failed validation after retry: schema-validation — ')).toBe(true);
  });

  it('escalation resolves null on DailyQuotaExhaustedError, with exactly one upstream call', async () => {
    generateContentStream.mockRejectedValueOnce(apiError429PerDay());
    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'k', model: 'gemma-char-daily' });
    expect(await analyzer.runAttributionEscalation('m_gem_char_daily', 1, 0, 'p', {})).toBeNull();
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it('escalation rethrows AnalysisAbortedError', async () => {
    const ac = new AbortController();
    ac.abort();
    const { GeminiAnalyzer } = await import('./gemini.js');
    const { AnalysisAbortedError } = await import('./ollama.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'k', model: 'gemma-char-abort' });
    await expect(
      analyzer.runAttributionEscalation('m_gem_char_abort', 1, 0, 'p', { signal: ac.signal }),
    ).rejects.toBeInstanceOf(AnalysisAbortedError);
  });
});
```
(The abort case: `geminiRateLimiter.acquire` honours an already-aborted signal and throws `AnalysisAbortedError` — `rate-limit.ts` imports that class today. If on `main` the rejection is instead raised by `generate()`'s abort race, the assertion is the same.)
- [ ] **Step 2: Run on unmodified code**  Run: `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`  Expected: PASS.
- [ ] **Step 3: Implement** — none.
- [ ] **Step 4: Confirm stable**  Re-run Step 2. Expected: PASS.
- [ ] **Step 5: Mutation proofs** (restore with `git checkout -- server/src/analyzer/gemini.ts`):
  1. Delete `gemini.ts:488` (`{ role: 'model', parts: [{ text: firstText }] },`) → red: both retry-replay tests.
  2. At `gemini.ts:421` change the guard to `if (err instanceof AnalysisAbortedError || err instanceof DailyQuotaExhaustedError) throw err;` → red: "escalation resolves null on DailyQuotaExhaustedError…".
  3. At `gemini.ts:516` prefix the message with `${this.model} ` → red: "pins the final validation-failure message".
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/gemini.test.ts
git commit -m "test(server): characterise gemini runner retry replay and escalation policy"
```

### Task 1.3: Capture `classifyAnalysisFailure` outcomes for Ollama non-OK responses (400, 404, 500, 503)

**Files:**
- Create: `server/src/analyzer/ollama-http-failure-taxonomy.test.ts`
- Test: same

**Interfaces:**
- Consumes: `OllamaAnalyzer` (`./ollama.js`), `classifyAnalysisFailure` (`../routes/failure-taxonomy.js`); the route's label shape `Ollama (${modelId})` (`routes/analysis.ts:561-563` `engineLabel`).
- Produces: four inline snapshots `{ code, userMessage, detail }` captured from `main`. Task 1.4 must leave them byte-identical.

**Capture procedure (do not hand-write the snapshot bodies).** The bodies below are realistic Ollama `{"error": "..."}` envelopes; which `FailureCode` each maps to depends on `classifyAnalysisFailure`'s envelope parse (`failure-taxonomy.ts:545`), bare-status branch (`:562`) and signature scan (`:567`), so it is captured, not predicted.

- [ ] **Step 1: Write the capture test (empty inline snapshots)**
```ts
/* #3084 wave 1 — pins how a non-OK Ollama response classifies at the run level,
   captured from main BEFORE the plain Error at ollama.ts:709-716 became
   AnalyzerHttpError. The snapshots are the contract: the swap must not move
   any of them (spec §1 "Typed HTTP errors"; plan-29 rule, index.ts:251-256). */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});

async function classifyOllamaHttp(status: number, statusText: string, body: string) {
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response(body, { status, statusText }));
  const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
  const { classifyAnalysisFailure } = await import('../routes/failure-taxonomy.js');
  const err = await new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' })
    .runStage1Chapter(`m_ollama_http_${status}`, 1, '# p', {})
    .then(() => null, (e: unknown) => e);
  expect(err).not.toBeNull();
  expect(err).not.toBeInstanceOf(LocalUnreachableError);
  const r = classifyAnalysisFailure(err, 'Ollama (qwen3.5:9b)');
  return { err: err as Error, outcome: { code: r.code, userMessage: r.userMessage, detail: r.detail } };
}

afterAll(async () => {
  for (const s of [400, 404, 500, 503]) {
    await rm(resolve(HANDOFF_ROOT, 'inbox', `m_ollama_http_${s}-stage1-ch1.md`), { force: true });
  }
});

describe('Ollama non-OK responses → classifyAnalysisFailure (captured from main)', () => {
  it('400 invalid format', async () => {
    const { outcome } = await classifyOllamaHttp(400, 'Bad Request', '{"error":"invalid format: expected \\"json\\" or a valid JSON schema"}');
    expect(outcome).toMatchInlineSnapshot();
  });
  it('404 model not found', async () => {
    const { outcome } = await classifyOllamaHttp(404, 'Not Found', '{"error":"model \\"qwen3.5:9b\\" not found, try pulling it first"}');
    expect(outcome).toMatchInlineSnapshot();
  });
  it('500 runner terminated', async () => {
    const { outcome } = await classifyOllamaHttp(500, 'Internal Server Error', '{"error":"llama runner process has terminated: exit status 2"}');
    expect(outcome).toMatchInlineSnapshot();
  });
  it('503 server busy', async () => {
    const { outcome } = await classifyOllamaHttp(503, 'Service Unavailable', '{"error":"server busy, please try again.  maximum pending requests exceeded"}');
    expect(outcome).toMatchInlineSnapshot();
  });
});
```
- [ ] **Step 2: Capture on unmodified code**  Run (locally, with `CI` unset — vitest refuses to write new snapshots under CI): `npm --prefix server run test -- src/analyzer/ollama-http-failure-taxonomy.test.ts -u --retry=0`  Expected: PASS and vitest writes the four inline snapshots into the file. Read them; paste the four `code` values into the PR body under "Captured taxonomy outcomes". Do not edit them.
- [ ] **Step 3: Implement** — none.
- [ ] **Step 4: Confirm the snapshot now gates**  Run without `-u`: `npm --prefix server run test -- src/analyzer/ollama-http-failure-taxonomy.test.ts --retry=0`  Expected: PASS.
- [ ] **Step 5: Mutation proof**  At `ollama.ts:714` change `returned ${response.status} ${response.statusText}` to `returned ${response.statusText}` → red on all four (userMessage drift). Restore with `git checkout -- server/src/analyzer/ollama.ts`. Second proof: at `ollama.ts:713` throw `Object.assign(new Error(<same message>), { status: response.status })` → at least the 500 and 503 snapshots go red (bare-status branch `failure-taxonomy.ts:562-563` maps 500/503 to `analyzer-unreachable`) — this is the regression `AnalyzerHttpError`'s missing `status` property exists to prevent. Restore.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/ollama-http-failure-taxonomy.test.ts
git commit -m "test(server): capture failure-taxonomy outcomes for ollama 400/404/500/503"
```

### Task 1.4: Typed analyzer errors, `AnalyzerHttpError` for Ollama non-OK, `FallbackAnalyzer` on the base class

**Files:**
- Modify: `server/src/analyzer/errors.ts:16-18` (header sentence), `:23` (`engine` type); new declarations added above `:19`
- Modify: `server/src/analyzer/ollama.ts:68` (import), `:83-107` (class bodies removed → re-export), `:709-716` (throw)
- Modify: `server/src/analyzer/gemini.ts:39-40` (import `AnalysisAbortedError` from `./errors.js`)
- Modify: `server/src/analyzer/rate-limit.ts:22` (import from `./errors.js` — required, not tidying: in PR 1b `transport-retry.ts` imports `rate-limit.ts` and `ollama.ts` imports that chain, so a surviving `rate-limit → ollama` edge would close a new cycle)
- Modify: `server/src/analyzer/index.ts:23` (imports), `:251-253` (comment), `:268,285,306,325,342,365,383,400` (`instanceof`)
- Modify: `server/src/analyzer/fallback-analyzer.test.ts:3` (comment only; it says "errors.ts only exports AnalyzerTruncatedError", which this task makes false)
- Create: `server/src/analyzer/errors.test.ts`
- Modify: `server/src/analyzer/fallback.test.ts` (append one `describe`)
- Modify: `server/src/analyzer/ollama-http-failure-taxonomy.test.ts` (append typed-error assertions; snapshots untouched)

**Interfaces:**
- Consumes: nothing new.
- Produces (contract, `errors.ts`): `type TransportKind = 'ollama' | 'gemini' | 'openai'`; `class AnalysisAbortedError`; `class AnalyzerUnreachableError(message, transport, cause?)`, `code: string = 'ANALYZER_UNREACHABLE'`; `class LocalUnreachableError extends AnalyzerUnreachableError` (`constructor(message, cause?)`, `code 'LOCAL_UNREACHABLE'`, `transport 'ollama'`); `class AnalyzerHttpError(transport, httpStatus, bodyExcerpt, message)` with NO `status` property; `AnalyzerTruncatedError.engine: TransportKind`. `ollama.ts` re-exports `AnalysisAbortedError`, `LocalUnreachableError`.

Suites that could break and must stay green: `ollama.test.ts`, `ollama-timeout.test.ts` (`toBeInstanceOf(LocalUnreachableError)` via `./ollama.js`), `fallback.test.ts`, `fallback-analyzer.test.ts`, `select-analyzer.test.ts`, `rate-limit.test.ts`, `routes/failure-taxonomy.test.ts`, `routes/analysis.phase-model.test.ts`, `routes/cast-design.test.ts`, slow `gemini.test.ts` (imports `AnalysisAbortedError` from `./ollama.js` after `vi.resetModules()`; the re-export resolves to the same fresh `errors.js` instance).

The only literal readers of the `code` strings are the class declarations themselves (`LOCAL_UNREACHABLE` / `ANALYSIS_ABORTED` appear nowhere else in `server/src`, `src/` or `openapi.yaml`), so widening `LocalUnreachableError.code` from a literal type to `string` breaks no comparison.

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/errors.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  AnalysisAbortedError,
  AnalyzerHttpError,
  AnalyzerTruncatedError,
  AnalyzerUnreachableError,
  LocalUnreachableError,
} from './errors.js';
import * as ollama from './ollama.js';
import { classifyAnalysisFailure } from '../routes/failure-taxonomy.js';

describe('analyzer error taxonomy (#3084 wave 1)', () => {
  it('LocalUnreachableError is an AnalyzerUnreachableError that keeps its name, code, message and cause', () => {
    const cause = new Error('inner');
    const err = new LocalUnreachableError('Ollama at u is unreachable (ECONNREFUSED).', cause);
    expect(err).toBeInstanceOf(AnalyzerUnreachableError);
    expect(err.name).toBe('LocalUnreachableError');
    expect(err.code).toBe('LOCAL_UNREACHABLE');
    expect(err.transport).toBe('ollama');
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('Ollama at u is unreachable (ECONNREFUSED).');
  });

  it('a bare AnalyzerUnreachableError carries its transport and the generic code', () => {
    const err = new AnalyzerUnreachableError('endpoint down', 'openai');
    expect(err.name).toBe('AnalyzerUnreachableError');
    expect(err.code).toBe('ANALYZER_UNREACHABLE');
    expect(err.transport).toBe('openai');
  });

  it('ollama.js re-exports the SAME class objects, so existing importers keep working', () => {
    expect(ollama.AnalysisAbortedError).toBe(AnalysisAbortedError);
    expect(ollama.LocalUnreachableError).toBe(LocalUnreachableError);
  });

  it('AnalysisAbortedError keeps its name and code', () => {
    const err = new AnalysisAbortedError('x');
    expect(err.name).toBe('AnalysisAbortedError');
    expect(err.code).toBe('ANALYSIS_ABORTED');
  });

  it('AnalyzerHttpError exposes httpStatus/bodyExcerpt/transport and has NO status property', () => {
    const err = new AnalyzerHttpError('ollama', 503, 'busy', 'Ollama http://h returned 503 Service Unavailable: busy');
    expect(err.name).toBe('AnalyzerHttpError');
    expect(err.transport).toBe('ollama');
    expect(err.httpStatus).toBe(503);
    expect(err.bodyExcerpt).toBe('busy');
    expect('status' in err).toBe(false);
  });

  it.each([400, 404, 500, 503])('AnalyzerHttpError %i classifies exactly like the plain Error it replaces', (status) => {
    const message = `Ollama http://localhost:11434 returned ${status} X: {"error":"boom"}`;
    const typed = classifyAnalysisFailure(
      new AnalyzerHttpError('ollama', status, '{"error":"boom"}', message),
      'Ollama (m)',
    );
    const plain = classifyAnalysisFailure(new Error(message), 'Ollama (m)');
    expect(typed).toEqual(plain);
  });

  it('AnalyzerTruncatedError accepts every TransportKind', () => {
    expect(new AnalyzerTruncatedError('openai', 'length', 10).message).toMatch(/^openai output truncated/);
  });
});
```

Append to `server/src/analyzer/fallback.test.ts`:
```ts
describe('FallbackAnalyzer — keyed on AnalyzerUnreachableError (#3084 wave 1)', () => {
  it('falls back on a bare AnalyzerUnreachableError from any transport, announcing the switch', async () => {
    const { AnalyzerUnreachableError } = await import('./errors.js');
    const primary = makeAnalyzer({
      runStage2Chapter: () => Promise.reject(new AnalyzerUnreachableError('endpoint down', 'openai')),
    });
    const fallback = makeAnalyzer({});
    const onFallback = vi.fn();
    const out = await new FallbackAnalyzer(primary, fallback).runStage2Chapter('m', 1, 'p', {
      onFallback,
    } as StageCall);
    expect(out).toEqual(STAGE2_RESULT);
    expect(fallback.runStage2Chapter).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({ reason: 'Ollama unreachable' });
  });

  it('does NOT fall back on AnalyzerHttpError (reachable but misbehaving, plan 29)', async () => {
    const { AnalyzerHttpError } = await import('./errors.js');
    const httpErr = new AnalyzerHttpError('ollama', 500, 'x', 'Ollama u returned 500 Internal Server Error: x');
    const primary = makeAnalyzer({ runStage2Chapter: () => Promise.reject(httpErr) });
    const fallback = makeAnalyzer({});
    await expect(new FallbackAnalyzer(primary, fallback).runStage2Chapter('m', 1, 'p', {})).rejects.toBe(httpErr);
    expect(fallback.runStage2Chapter).not.toHaveBeenCalled();
  });
});
```

Append inside the `describe` of `ollama-http-failure-taxonomy.test.ts`:
```ts
  it.each([
    [400, 'Bad Request'],
    [404, 'Not Found'],
    [500, 'Internal Server Error'],
    [503, 'Service Unavailable'],
  ] as const)('%i surfaces as AnalyzerHttpError with the unchanged message and no status', async (status, statusText) => {
    const body = '{"error":"boom"}';
    const { err } = await classifyOllamaHttp(status, statusText, body);
    const { AnalyzerHttpError } = await import('./errors.js');
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    const typed = err as InstanceType<typeof AnalyzerHttpError>;
    expect(typed.httpStatus).toBe(status);
    expect(typed.bodyExcerpt).toBe(body);
    expect(typed.transport).toBe('ollama');
    expect('status' in err).toBe(false);
    expect(err.message).toBe(`Ollama http://localhost:11434 returned ${status} ${statusText}: ${body}`);
  });
```
- [ ] **Step 2: Run and confirm they fail**  Run: `npm --prefix server run test -- src/analyzer/errors.test.ts src/analyzer/fallback.test.ts src/analyzer/ollama-http-failure-taxonomy.test.ts --retry=0`  Expected: FAIL — `errors.test.ts` cannot import `AnalyzerHttpError`/`AnalyzerUnreachableError` ("does not provide an export named"); "falls back on a bare AnalyzerUnreachableError from any transport…" red (the error is rethrown); the four new `it.each` cases red on `toBeInstanceOf(AnalyzerHttpError)`. The four captured inline snapshots stay green.
- [ ] **Step 3: Implement**

`errors.ts` — insert above `:19`:
```ts
/** Every transport the stage runner can drive. Wave 1 uses 'ollama' and 'gemini'. */
export type TransportKind = 'ollama' | 'gemini' | 'openai';

/** Sentinel error for "the SSE client disconnected, drop work silently."
    The analysis route uses `err instanceof AnalysisAbortedError` to skip
    its own error-reporting path (the client is gone — there's no one to
    tell) and to NOT trigger the Gemini fallback decorator. */
export class AnalysisAbortedError extends Error {
  readonly code = 'ANALYSIS_ABORTED';
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisAbortedError';
  }
}

/** "Couldn't reach the analyzer at all", from any transport. FallbackAnalyzer
    (index.ts) uses `instanceof AnalyzerUnreachableError` as the SOLE trigger
    for Gemini fallback; every other error propagates and hard-fails. */
export class AnalyzerUnreachableError extends Error {
  readonly code: string = 'ANALYZER_UNREACHABLE';
  constructor(
    message: string,
    public readonly transport: TransportKind,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AnalyzerUnreachableError';
  }
}

/** Ollama's unreachable sentinel — produced only by classifyConnectError. */
export class LocalUnreachableError extends AnalyzerUnreachableError {
  readonly code: string = 'LOCAL_UNREACHABLE';
  constructor(message: string, cause?: unknown) {
    super(message, 'ollama', cause);
    this.name = 'LocalUnreachableError';
  }
}

/** A reachable analyzer answered with a non-OK HTTP status. Deliberately has
    NO `status` property: failure-taxonomy.ts reads `.status` (its bare-status
    branch maps 500/503 to analyzer-unreachable), and wave 1 must not move any
    taxonomy outcome. */
export class AnalyzerHttpError extends Error {
  constructor(
    public readonly transport: TransportKind,
    public readonly httpStatus: number,
    public readonly bodyExcerpt: string,
    message: string,
  ) {
    super(message);
    this.name = 'AnalyzerHttpError';
  }
}
```
`errors.ts:23` → `public readonly engine: TransportKind,`. `errors.ts:17-18` → `can import it without a circular dependency. Mirrors the sentinel shape of AnalysisAbortedError / LocalUnreachableError below. */` (the old "in ollama.ts" is now false).

`ollama.ts`: delete `:83-107` (both classes and their doc comments). Replace `:68` with:
```ts
import { AnalyzerTruncatedError, AnalysisAbortedError, LocalUnreachableError, AnalyzerHttpError } from './errors.js';
export { AnalysisAbortedError, LocalUnreachableError } from './errors.js';
```
Replace `:709-716`:
```ts
      if (!response.ok) {
        /* Reachable but errored — hard-fail. Surface the body verbatim so
           operator can diagnose ("model not found", "invalid format", …). */
        const text = await response.text().catch(() => '');
        const bodyExcerpt = text.slice(0, 500);
        throw new AnalyzerHttpError(
          'ollama',
          response.status,
          bodyExcerpt,
          `Ollama ${this.url} returned ${response.status} ${response.statusText}: ${bodyExcerpt}`,
        );
      }
```
`gemini.ts:39-40` → `import { AnalysisAbortedError, AnalyzerTruncatedError, GeminiContentBlockedError } from './errors.js';`. `rate-limit.ts:22` → `import { AnalysisAbortedError } from './errors.js';`.

`index.ts:23` → 
```ts
import { OllamaAnalyzer } from './ollama.js';
import { AnalysisAbortedError, AnalyzerUnreachableError } from './errors.js';
```
In `FallbackAnalyzer`, replace all eight `err instanceof LocalUnreachableError` (`:268, :285, :306, :325, :342, :365, :383, :400`) with `err instanceof AnalyzerUnreachableError`. `:251-253` → `/* Decorator that delegates to a primary analyzer and falls back to a secondary only when the primary throws AnalyzerUnreachableError (Ollama's LocalUnreachableError is one). Every`. The `onFallback` reason `'Ollama unreachable'` is unchanged (wave 3 owns endpoint wording).

`fallback-analyzer.test.ts:3` → `import { LocalUnreachableError } from './ollama.js'; // re-exported from ./errors.js`.
- [ ] **Step 4: Run and confirm they pass**  Run: `npm --prefix server run test -- src/analyzer/errors.test.ts src/analyzer/fallback.test.ts src/analyzer/fallback-analyzer.test.ts src/analyzer/ollama-http-failure-taxonomy.test.ts src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts src/analyzer/select-analyzer.test.ts src/analyzer/rate-limit.test.ts src/routes/failure-taxonomy.test.ts --retry=0`, then `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`, then `npm run typecheck`  Expected: PASS; `git diff server/src/analyzer/ollama-http-failure-taxonomy.test.ts` shows only the appended `it.each` (snapshots unmoved).
- [ ] **Step 5: Mutation proofs** (re-apply Step 3 after each):
  1. In `FallbackAnalyzer.runStage2Chapter`'s catch, revert to `instanceof LocalUnreachableError` (re-add that import) → red: "falls back on a bare AnalyzerUnreachableError from any transport, announcing the switch".
  2. Add `get status() { return this.httpStatus; }` to `AnalyzerHttpError` → red: "has NO status property", the 500 and 503 cases of "classifies exactly like the plain Error it replaces", and the 500/503 inline snapshots from Task 1.3.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/errors.ts server/src/analyzer/errors.test.ts server/src/analyzer/ollama.ts server/src/analyzer/gemini.ts server/src/analyzer/rate-limit.ts server/src/analyzer/index.ts server/src/analyzer/fallback.test.ts server/src/analyzer/fallback-analyzer.test.ts server/src/analyzer/ollama-http-failure-taxonomy.test.ts
git commit -m "refactor(server): typed analyzer errors and AnalyzerHttpError for ollama non-OK responses"
```

### Task 1.5: Leaf `types.ts`; move shared helpers to `runner/parse.ts` + `runner/prompt.ts`; remove the analyzer import cycles

**Files:**
- Create: `server/src/analyzer/types.ts` (moved from `index.ts:12-21,24,34-165`)
- Modify: `server/src/analyzer/index.ts:24,34-165`
- Create: `server/src/analyzer/runner/parse.ts` (moved from `gemini.ts:1001-1391`)
- Create: `server/src/analyzer/runner/prompt.ts` (moved from `gemini.ts:129-264`)
- Modify: `server/src/analyzer/gemini.ts:8-15,36-38,129-264,1001-1391`
- Modify: `server/src/analyzer/ollama.ts:66,69-77`
- Modify: `server/madge-cycles-allowlist.json:2-4` (delete the three `analyzer/` entries)
- Create: `server/src/analyzer/runner/moved-helpers.test.ts`

**Interfaces:**
- Consumes: Task 1.4's `errors.ts`.
- Produces: `types.ts` exporting `StageChunkInfo`, `StageCall`, `Analyzer` (re-exported by `index.ts`, so every `from './index.js'` type import elsewhere still compiles); `runner/parse.ts` exporting `ParseResult`, `parseAndValidate`, `stripCodeFences`, `repairUnescapedQuotes`, `trimTrailingProse`, `repairStructuralPunctuation`, `buildRetryMessage`, `summariseDetail`, `persistResponse`; `runner/prompt.ts` exporting `SkillName`, `loadSkill`, `buildSystemInstruction`, `languagePreamble` (`SKILL_FILES` / `SKILL_TO_PROMPT_ID` stay module-private, as today). `gemini.ts` re-exports every one of those names.

Suites that could break: `parse-and-repair.test.ts`, `language-preamble.test.ts`, `output-heavy-tpm.test.ts`, `stage1-chunk.test.ts` (all import from `./gemini.js`); `voice-style.test.ts` (`voice-style.ts:32` imports `stripCodeFences` from `./gemini.js` — left pointing there, wave 4 owns persona); `ollama.test.ts`; slow `gemini.test.ts`; `handoff/schemas.test.ts`.

- [ ] **Step 1: Write the failing test** — `server/src/analyzer/runner/moved-helpers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import * as gemini from '../gemini.js';
import * as parse from './parse.js';
import * as prompt from './prompt.js';

describe('helpers moved out of gemini.ts (#3084 wave 1)', () => {
  it('gemini.js re-exports the moved parse helpers as the same function objects', () => {
    for (const name of [
      'parseAndValidate',
      'stripCodeFences',
      'repairUnescapedQuotes',
      'trimTrailingProse',
      'repairStructuralPunctuation',
      'buildRetryMessage',
      'summariseDetail',
      'persistResponse',
    ] as const) {
      expect(gemini[name], name).toBe(parse[name]);
    }
  });

  it('gemini.js re-exports the moved prompt helpers as the same function objects', () => {
    for (const name of ['loadSkill', 'buildSystemInstruction', 'languagePreamble'] as const) {
      expect(gemini[name], name).toBe(prompt[name]);
    }
  });

  it('loadSkill still resolves on-disk skills from the new directory depth', async () => {
    /* whole_book_stage1 and non_story_classification are NOT prompt-registry
       backed (absent from SKILL_TO_PROMPT_ID), so they read SKILLS_DIR
       directly — the one path whose relative depth changed with the move. */
    expect((await prompt.loadSkill('whole_book_stage1')).length).toBeGreaterThan(100);
    expect((await prompt.loadSkill('non_story_classification')).length).toBeGreaterThan(100);
  });
});
```
- [ ] **Step 2: Run and confirm it fails**  Run: `npm --prefix server run test -- src/analyzer/runner/moved-helpers.test.ts --retry=0`  Expected: FAIL — `Failed to resolve import "./parse.js"`.
- [ ] **Step 3: Implement (mechanical moves; the changed lines are listed exhaustively)**
  1. **`types.ts`** = header `/* Analyzer interface types. A leaf module (type-only imports) so runner/transport files can reference StageCall/Analyzer without an edge back to index.ts — madge counts type-only imports as cycle edges. */` + `index.ts:12-21` (the `import type { Stage1Output, … } from '../handoff/schemas.js'` block) + `index.ts:24` (`import type { RawEvalTiming } …`) + `index.ts:34-165` verbatim.
  2. **`index.ts`**: delete `:34-165` and `:24`; below the remaining imports add
     ```ts
     export type { StageChunkInfo, StageCall, Analyzer } from './types.js';
     import type { Analyzer, StageCall } from './types.js';
     ```
     (`:12-21` stay — `FallbackAnalyzer` uses the schema output types.)
  3. **`runner/parse.ts`** = header `/* JSON parse, repair and validation helpers shared by every analyzer transport. Moved verbatim from gemini.ts (#3084 wave 1). */` + imports
     ```ts
     import { writeFile } from 'node:fs/promises';
     import type { z } from 'zod';
     import { outboxPath, type HandoffKey } from '../../handoff/protocol.js';
     ```
     + `gemini.ts:1001-1391` verbatim (including the private `stripUnrecognizedKeys`). No line changes meaning.
  4. **`runner/prompt.ts`** = header `/* Skill loading and system-instruction assembly shared by every analyzer transport. Moved from gemini.ts (#3084 wave 1). */` + imports
     ```ts
     import { readFile } from 'node:fs/promises';
     import { dirname, resolve } from 'node:path';
     import { fileURLToPath } from 'node:url';
     import { readPrompt } from '../../config/prompts.js';
     import { isNonEnglish, normaliseBookLanguage } from '../../tts/language.js';
     import { getLanguageEntry } from '../../tts/language-registry.js';
     ```
     + `gemini.ts:129-264` verbatim with exactly ONE changed line — `gemini.ts:130` becomes
     ```ts
     const SKILLS_DIR = resolve(__dirname, '..', '..', '..', '..', 'skills');
     ```
     (one extra `'..'` because the file is one directory deeper; the same depth holds under `server/dist/analyzer/runner`).
  5. **`gemini.ts`**: delete `:129-264` and `:1001-1391`. Imports: keep `import { writeFile } from 'node:fs/promises';`, `configValue`, `GoogleGenAI`, `import type { z } from 'zod';`; `:15` → `import { writeInbox, errorPath, stage2HandoffKey, type HandoffKey } from '../handoff/protocol.js';`; drop `readFile`, `readPrompt`, `dirname`, `resolve`, `fileURLToPath`, `outboxPath`; delete `:37-38`; `:36` → `import type { Analyzer, StageCall, StageChunkInfo } from './types.js';`. Add:
     ```ts
     import { buildSystemInstruction, loadSkill, type SkillName } from './runner/prompt.js';
     import { parseAndValidate, buildRetryMessage, summariseDetail, persistResponse } from './runner/parse.js';
     export { buildSystemInstruction, languagePreamble, loadSkill, type SkillName } from './runner/prompt.js';
     export {
       parseAndValidate,
       stripCodeFences,
       repairUnescapedQuotes,
       trimTrailingProse,
       repairStructuralPunctuation,
       buildRetryMessage,
       summariseDetail,
       persistResponse,
       type ParseResult,
     } from './runner/parse.js';
     ```
  6. **`ollama.ts`**: `:66` → `import type { Analyzer, StageCall, StageChunkInfo } from './types.js';`; `:69-77` →
     ```ts
     import { buildSystemInstruction, loadSkill, type SkillName } from './runner/prompt.js';
     import { parseAndValidate, buildRetryMessage, summariseDetail, persistResponse } from './runner/parse.js';
     ```
  7. **Allowlist**: delete `server/madge-cycles-allowlist.json:2-4`. After this task nothing under `analyzer/` imports `index.ts`; `ollama.ts` imports nothing from `gemini.ts`; `gemini.ts` and `rate-limit.ts` import nothing from `ollama.ts`.
- [ ] **Step 4: Run and confirm it passes**  Run, in order: `npm --prefix server run test -- src/analyzer/runner/moved-helpers.test.ts --retry=0`; `npm run test:server:analyzer`; `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`; `npm run typecheck`; `npm run check:cycles`  Expected: all PASS; `check:cycles` prints `OK — N circular dependencies found, all allowlisted` with N equal to the edited allowlist's entry count. If madge still reports an `analyzer/` cycle the check FAILS naming it — find and remove the remaining edge; never re-add the entry.
- [ ] **Step 5: Mutation proofs**
  1. Revert the Step-3.4 `SKILLS_DIR` line to three `'..'` → red: "loadSkill still resolves on-disk skills from the new directory depth" (ENOENT). Restore.
  2. Change `ollama.ts:66` back to `from './index.js'` → `npm run check:cycles` FAILS listing a cycle through `analyzer/index.ts` and `analyzer/ollama.ts`. Restore. Paste the output in the PR body.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/types.ts server/src/analyzer/index.ts server/src/analyzer/runner/parse.ts server/src/analyzer/runner/prompt.ts server/src/analyzer/runner/moved-helpers.test.ts server/src/analyzer/gemini.ts server/src/analyzer/ollama.ts server/madge-cycles-allowlist.json
git commit -m "refactor(server): move shared analyzer helpers out of gemini.ts and break analyzer import cycles"
```

### Task 1.6: Ship PR 1a

**Files:** none beyond Tasks 1.1–1.5.

- [ ] **Step 1: Derived artifacts** — no `openapi.yaml` change (no `npm run openapi:types`); no registry knob (no `npm run config:sync`).
- [ ] **Step 2: Release notes — skipped, reason stated in the PR body:** "No shippable delta: characterisation tests and an internal refactor; every error message, request body, forensic file and failure-taxonomy outcome is byte-identical (pinned by Tasks 1.1–1.3)."
- [ ] **Step 3: On-box acceptance — not applicable** (no hardware-only behaviour); say so in the PR body.
- [ ] **Step 4: Verify** — `npm run verify:fast:branch`; then, because that battery runs neither the slow lane nor the cycle guard, `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts` and `npm run check:cycles`. Expected: all green.
- [ ] **Step 5: PR** — `gh pr create --base main --title "refactor(server): characterise analyzer runners and type analyzer errors"`. Body: `## Summary` (Tasks 1.1–1.5; the four captured `FailureCode`s from Task 1.3), `## Test plan` (Step 4 commands; every mutation-proof red output), `Refs #3084`, "Also fixed, found in passing: comments at `errors.ts:16-18`, `index.ts:251-253` and `fallback-analyzer.test.ts:3` that this change made false", attribution lines.
- [ ] **Step 6: Review gate** — run the `pr-review-gate` skill at depth **high** (the PR contains `refactor` commits). Fold findings, re-run Step 4, merge with a merge commit.

---

### PR 1b — Transports, one stage runner, `<think>` strip

- **Branch:** `node scripts/wt-new.mjs refactor/server-3084-w1b-runner`, cut from `main` after PR 1a merged.
- **Line numbers in this PR** refer to `2b63b451`. PR 1a removed `ollama.ts:83-107`, rewrote the import blocks of `ollama.ts`/`gemini.ts`, and deleted `gemini.ts:129-264,1001-1391`, so locate each range by the **symbol named next to it** before editing.
- **Delivers:** `runner/transport.ts`, `runner/finish.ts`, `runner/transport-retry.ts`, `runner/retry-policy.ts`, `runner/stage-runner.ts`, `runner/transport-analyzer.ts`, `transports/ollama-transport.ts`, `transports/gemini-transport.ts`, leaf `ollama-settings.ts`; `OllamaAnalyzer` / `GeminiAnalyzer` become `TransportAnalyzer` subclasses with unchanged constructors; `stripThink` in `parseAndValidate`; stale references the moves made false.
- **Must NOT change:** any request body field or value; message-turn shapes on first attempt or retry; temperatures; forensic files (`inbox`, `outbox`, `errors.json`, `attempt{1,2}.raw.txt`); log lines; retry counts/backoffs/limiter calls; which errors fall back, rethrow or resolve `null`; telemetry ordering (a truncated or empty Ollama stream still skips VRAM sampling, GPU-split detection and eval timing); `generatePersonaViaOllama` and `voice-style.ts` (wave 4). No `includeThoughts`/`thinkingConfig` is sent.
- **The one behaviour change:** a response that begins with `<think>…</think>` now parses (Task 1.12).
- **Entry:** PR 1a merged; its characterisation suites green on `main`.
- **Exit:** Tasks 1.7–1.14 committed; every suite named in the tasks green with no assertion weakened; `npm run check:cycles` OK with no `analyzer/` entry; `pr-review-gate` pass recorded.

### Task 1.7: Transport contract types and finish mapping

**Files:**
- Create: `server/src/analyzer/runner/transport.ts`
- Create: `server/src/analyzer/runner/finish.ts`
- Test: `server/src/analyzer/runner/finish.test.ts`

**Interfaces:**
- Consumes: `TransportKind`, `AnalyzerTruncatedError`, `GeminiContentBlockedError` (`errors.ts`); `StageCall` (`types.ts`).
- Produces: `ChatMessage`, `StructuredOutputMode`, `StructuredOutputRequest`, `TransportRequest`, `TransportUsage`, `TransportResult` (with the extra `finishReason?: string`, see the contract-conflict note in the report), `ChatTransport`; `mapFinish(r, ctx)`.

- [ ] **Step 1: Write the failing test** — `server/src/analyzer/runner/finish.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mapFinish } from './finish.js';
import { AnalyzerTruncatedError, GeminiContentBlockedError } from '../errors.js';
import type { TransportResult } from './transport.js';

const res = (over: Partial<TransportResult>): TransportResult => ({
  text: '',
  reasoningSeen: false,
  finish: 'stop',
  receivedBytes: 0,
  ...over,
});
const OLLAMA = { kind: 'ollama', model: 'qwen3.5:9b' } as const;
const GEMINI = { kind: 'gemini', model: 'gemma-4-31b-it' } as const;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('mapFinish — wave 1 reproduces each engine\'s pre-W1 finish handling', () => {
  it('ollama stop with text returns the text', () => {
    expect(mapFinish(res({ text: '{"a":1}', receivedBytes: 7 }), OLLAMA)).toBe('{"a":1}');
  });

  it('ollama empty stop throws the empty-response Error', () => {
    const err = thrown(() => mapFinish(res({}), OLLAMA));
    expect(err).not.toBeInstanceOf(AnalyzerTruncatedError);
    expect((err as Error).message).toBe('Ollama qwen3.5:9b returned an empty response.');
  });

  it('ollama EMPTY length is still the empty-response Error (emptiness is checked before done_reason)', () => {
    const err = thrown(() => mapFinish(res({ finish: 'length', finishReason: 'length' }), OLLAMA));
    expect(err).not.toBeInstanceOf(AnalyzerTruncatedError);
    expect((err as Error).message).toBe('Ollama qwen3.5:9b returned an empty response.');
  });

  it('ollama non-empty length throws AnalyzerTruncatedError(ollama, length, bytes) with no token count', () => {
    const err = thrown(() =>
      mapFinish(res({ text: '{"characters":[{"id":"narr', finish: 'length', finishReason: 'length', receivedBytes: 26 }), OLLAMA),
    );
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).toMatchObject({ engine: 'ollama', reason: 'length', receivedBytes: 26, outputTokens: undefined });
  });

  it('gemini blocked throws GeminiContentBlockedError naming the reason', () => {
    const err = thrown(() => mapFinish(res({ finish: 'blocked', blockReason: 'RECITATION' }), GEMINI));
    expect(err).toBeInstanceOf(GeminiContentBlockedError);
    expect(err).toMatchObject({ model: 'gemma-4-31b-it', reason: 'RECITATION' });
  });

  it('gemini empty MAX_TOKENS is truncation with 0 bytes and the output token count (splittable, not a block)', () => {
    const err = thrown(() =>
      mapFinish(res({ finish: 'length', finishReason: 'MAX_TOKENS', usage: { outputTokens: 8192 } }), GEMINI),
    );
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).toMatchObject({ engine: 'gemini', reason: 'MAX_TOKENS', receivedBytes: 0, outputTokens: 8192 });
  });

  it('gemini non-empty SAFETY is truncation, not a block (a non-empty abnormal stop splits today)', () => {
    const err = thrown(() =>
      mapFinish(res({ text: '{"a":', finish: 'length', finishReason: 'SAFETY', receivedBytes: 5 }), GEMINI),
    );
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).toMatchObject({ engine: 'gemini', reason: 'SAFETY', receivedBytes: 5 });
  });

  it('gemini stop returns the text', () => {
    expect(mapFinish(res({ text: 'x', receivedBytes: 1 }), GEMINI)).toBe('x');
  });
});
```
- [ ] **Step 2: Run and confirm it fails**  Run: `npm --prefix server run test -- src/analyzer/runner/finish.test.ts --retry=0`  Expected: FAIL — `Failed to resolve import "./finish.js"`.
- [ ] **Step 3: Implement**

`server/src/analyzer/runner/transport.ts`:
```ts
/* The chat-transport contract (#3084). A transport owns the wire format, the
   HTTP client, streaming, limiter/concurrency acquisition and transport-level
   retries. It returns a normalised result and NEVER throws for a completed
   response: truncation and content blocks are reported through `finish` and
   mapped to errors by the runner (finish.ts). It DOES throw abort /
   unreachable / HTTP / quota errors. */
import type { StageCall } from '../types.js';
import type { TransportKind } from '../errors.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type StructuredOutputMode = 'schema' | 'json' | 'off';

export type StructuredOutputRequest =
  | { mode: 'schema'; name: string; schema: Record<string, unknown> } // already adapted for this transport
  | { mode: 'json' }
  | { mode: 'off' };

export interface TransportRequest {
  system: string;
  messages: ChatMessage[];
  structuredOutput: StructuredOutputRequest;
  temperature: number;
  /** undefined = the transport's pre-wave-2 default (Ollama resolveNumPredict, Gemini resolveMaxOutputTokens). */
  maxOutputTokens?: number;
  estimatedInputTokens: number;
  signal?: AbortSignal;
  call: Pick<StageCall, 'onChunk' | 'onWaiting' | 'onThrottle' | 'onEvalTiming'>;
}

export interface TransportUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface TransportResult {
  /** Answer text only — never reasoning/thought text. */
  text: string;
  reasoningSeen: boolean;
  finish: 'stop' | 'length' | 'blocked';
  /** The provider's raw stop reason (Ollama done_reason, Gemini finishReason) — the AnalyzerTruncatedError `reason`. */
  finishReason?: string;
  /** Gemini SAFETY/RECITATION/prompt blockReason when finish === 'blocked'. */
  blockReason?: string;
  usage?: TransportUsage;
  receivedBytes: number;
}

export interface ChatTransport {
  readonly kind: TransportKind;
  readonly model: string;
  send(req: TransportRequest): Promise<TransportResult>;
}
```
`server/src/analyzer/runner/finish.ts`:
```ts
/* Maps a completed TransportResult to answer text or the classified error the
   stage-2 chunker / failure taxonomy key off. Wave 1 reproduces each engine's
   pre-extraction order exactly (ollama.ts chat() :829-843, gemini.ts
   generate() :783-818 on 2b63b451). Wave 2 adds the reasoning-overflow rule. */
import { AnalyzerTruncatedError, GeminiContentBlockedError, type TransportKind } from '../errors.js';
import type { TransportResult } from './transport.js';

export function mapFinish(r: TransportResult, ctx: { kind: TransportKind; model: string }): string {
  if (ctx.kind === 'ollama') {
    /* Emptiness first: an empty stream that also reports done_reason 'length'
       has always been the empty-response error, never a split. */
    if (!r.text) throw new Error(`Ollama ${ctx.model} returned an empty response.`);
    if (r.finish === 'length') {
      throw new AnalyzerTruncatedError('ollama', r.finishReason ?? 'length', r.receivedBytes);
    }
    return r.text;
  }
  if (r.finish === 'blocked') throw new GeminiContentBlockedError(ctx.model, r.blockReason);
  if (r.finish === 'length') {
    throw new AnalyzerTruncatedError(ctx.kind, r.finishReason ?? 'length', r.receivedBytes, r.usage?.outputTokens);
  }
  return r.text;
}
```
(Transports log their own truncation/blocked lines, exactly where today's code logs them — Tasks 1.8, 1.9.)
- [ ] **Step 4: Run and confirm it passes**  Run: `npm --prefix server run test -- src/analyzer/runner/finish.test.ts --retry=0` and `npm run typecheck`  Expected: PASS.
- [ ] **Step 5: Mutation proof**  Swap the two `if`s in the Ollama branch (length check before the empty check) → red: "ollama EMPTY length is still the empty-response Error…". Restore.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/transport.ts server/src/analyzer/runner/finish.ts server/src/analyzer/runner/finish.test.ts
git commit -m "refactor(server): add chat transport contract and finish mapping"
```

### Task 1.8: `ollama-settings.ts` + `OllamaTransport` (today's `chat()`), wired through a temporary adapter

**Files:**
- Create: `server/src/analyzer/ollama-settings.ts` (moved from `ollama.ts` `DEFAULT_TEMPERATURE`…`resolveOllamaRetryTemperature` `:155-175`, `DEFAULT_ANALYZER_KEEP_ALIVE_SECONDS` `:177-188`, `RAM_HEAVY_MODELS` `:190-193`, `normalizeModelTag`…`keepAliveFor` `:201-241`, `ANALYZER_NUM_CTX`…`resolveNumPredict` `:243-294`)
- Create: `server/src/analyzer/transports/ollama-transport.ts` (moved from `ollama.ts` `ANALYZER_DISPATCHER` `:120-133`, `UNREACHABLE_CODES` `:143-153`, `warnedGpuSplitSignatures` `:195-199`, `chat()` body `:631-926`, `classifyConnectError` `:1030-1062`)
- Modify: `server/src/analyzer/ollama.ts` (delete moved ranges; re-exports; `OllamaAnalyzer` fields/ctor `:296-305`; `chat()` `:616-927` becomes an adapter)
- Test: `server/src/analyzer/transports/ollama-transport.test.ts`

**Interfaces:**
- Consumes: Task 1.7 types and `mapFinish`; `AnalysisAbortedError`, `AnalyzerHttpError`, `LocalUnreachableError`.
- Produces: `ollama-settings.ts` exports exactly the moved names (same signatures); `transports/ollama-transport.ts` exports `ANALYZER_DISPATCHER`, `classifyConnectError(err, url): Error`, `interface OllamaTransportOptions { url: string; model: string; dispatcher?: Agent }`, `class OllamaTransport implements ChatTransport` (`kind 'ollama'`). `ollama.ts` re-exports every moved name.

**Why a leaf `ollama-settings.ts`:** the transport needs `keepAliveFor`/`resolveAnalyzerNumCtx`/`resolveAnalyzerNumGpu`/`resolveNumPredict` and `ollama.ts` must import the transport; leaving the helpers in `ollama.ts` closes an `ollama.ts ↔ ollama-transport.ts` cycle. `retry-policy.ts` (Task 1.10) needs the temperatures for the same reason.

Suites that could break: `ollama.test.ts` (mocks `'undici'`, `'../gpu/ollama-gpu-split.js'`, `'../config/resolver.js'` by module path — the new files import the same absolute modules, so the mocks still apply; `vi.spyOn(conc, 'acquireAnalyzerSlot')` still intercepts), `ollama-timeout.test.ts` (injects `dispatcher`, real server), `ollama-resolver.test.ts`, `routes/ollama-health.test.ts` + `routes/ollama-health.ts:13-18` (imports `resolveAnalyzerNumCtx`, `resolveAnalyzerNumGpu`, `keepAliveFor`, `ANALYZER_DISPATCHER` via re-export), `routes/models-inventory.ts:25` (via re-export), `config/direct-env-reader-guard.test.ts` (`CASTWRIGHT_VRAM_SAMPLE` is not a registered knob env — `ollama.ts` is not in its `ALLOWLISTED_SITES` — so moving that read changes no count).

- [ ] **Step 1: Write the failing test** — `server/src/analyzer/transports/ollama-transport.test.ts`:
```ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TransportRequest } from '../runner/transport.js';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});
const { splitMock } = vi.hoisted(() => ({ splitMock: vi.fn() }));
vi.mock('../../gpu/ollama-gpu-split.js', () => ({ detectOllamaGpuSplit: splitMock }));

function ndjson(lines: object[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}
const req = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  system: 'SYS',
  messages: [{ role: 'user', content: 'hi' }],
  structuredOutput: { mode: 'schema', name: 's', schema: { type: 'object' } },
  temperature: 0.2,
  estimatedInputTokens: 0,
  call: {},
  ...over,
});
const bodyOf = (i: number) => JSON.parse((fetchMock.mock.calls[i][1] as { body: string }).body);
const OK_LINES = [{ message: { content: '{"a":1}' }, done: false }, { message: { content: '' }, done: true, done_reason: 'stop' }];

beforeAll(() => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
});
afterAll(() => {
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
});
beforeEach(() => {
  fetchMock.mockReset();
  splitMock.mockReset();
  splitMock.mockResolvedValue({ reachable: true, split: false, deviceIndices: [], totalUsedMb: 0, wouldFitSingleDevice: false, dataUnavailable: false });
});

describe('OllamaTransport (#3084 wave 1)', () => {
  it('prepends the system message only when system is non-empty', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    const t = new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    fetchMock.mockResolvedValueOnce(ndjson(OK_LINES)).mockResolvedValueOnce(ndjson(OK_LINES));
    await t.send(req());
    await t.send(req({ system: '' }));
    expect(bodyOf(0).messages).toEqual([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]);
    expect(bodyOf(1).messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('maps structured output: schema → format object, json → "json", off → no format key', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    const t = new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    fetchMock.mockImplementation(async () => ndjson(OK_LINES));
    await t.send(req());
    await t.send(req({ structuredOutput: { mode: 'json' } }));
    await t.send(req({ structuredOutput: { mode: 'off' } }));
    expect(bodyOf(0).format).toEqual({ type: 'object' });
    expect(bodyOf(1).format).toBe('json');
    expect('format' in bodyOf(2)).toBe(false);
    expect(bodyOf(0).think).toBe(false);
  });

  it('maxOutputTokens overrides num_predict; undefined keeps resolveNumPredict()', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    const { resolveNumPredict } = await import('../ollama-settings.js');
    const t = new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    fetchMock.mockImplementation(async () => ndjson(OK_LINES));
    await t.send(req());
    await t.send(req({ maxOutputTokens: 777 }));
    expect(bodyOf(0).options.num_predict).toBe(resolveNumPredict());
    expect(bodyOf(1).options.num_predict).toBe(777);
    expect(bodyOf(1).options.temperature).toBe(0.2);
  });

  it('stop returns text, finish, raw reason and bytes, and runs GPU-split detection', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    fetchMock.mockResolvedValueOnce(ndjson(OK_LINES));
    const r = await new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' }).send(req());
    expect(r).toEqual({ text: '{"a":1}', reasoningSeen: false, finish: 'stop', finishReason: 'stop', receivedBytes: 7 });
    expect(splitMock).toHaveBeenCalledTimes(1);
  });

  it('length with text returns finish length WITHOUT GPU-split detection or eval-timing telemetry, and frees the slot', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    const conc = await import('../analyzer-concurrency.js');
    fetchMock.mockResolvedValueOnce(
      ndjson([
        { message: { content: '{"a":' }, done: false },
        { message: { content: '' }, done: true, done_reason: 'length', eval_count: 5, eval_duration: 1, prompt_eval_count: 1, prompt_eval_duration: 1, load_duration: 0 },
      ]),
    );
    const onEvalTiming = vi.fn();
    const r = await new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' }).send(req({ call: { onEvalTiming } }));
    expect(r).toEqual({ text: '{"a":', reasoningSeen: false, finish: 'length', finishReason: 'length', receivedBytes: 5 });
    expect(splitMock).not.toHaveBeenCalled();
    expect(onEvalTiming).not.toHaveBeenCalled();
    expect(conc.analyzerConcurrency.inFlight).toBe(0);
  });

  it('an empty stream returns text "" without throwing (mapFinish owns the empty-response error)', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    fetchMock.mockResolvedValueOnce(ndjson([{ message: { content: '' }, done: true, done_reason: 'length' }]));
    const r = await new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' }).send(req());
    expect(r).toMatchObject({ text: '', finish: 'length', receivedBytes: 0 });
    expect(splitMock).not.toHaveBeenCalled();
  });
});
```
- [ ] **Step 2: Run and confirm it fails**  Run: `npm --prefix server run test -- src/analyzer/transports/ollama-transport.test.ts --retry=0`  Expected: FAIL — `Failed to resolve import "./ollama-transport.js"`.
- [ ] **Step 3: Implement**
  1. **`ollama-settings.ts`** = header `/* Ollama analyzer settings resolvers and keep-alive policy (moved verbatim from ollama.ts, #3084 wave 1). A leaf: transports and retry policies import it without importing ollama.ts. */` + imports
     ```ts
     import { configValue } from '../config/resolver.js';
     import { getCachedUserSettings } from '../workspace/user-settings.js';
     import { isAnyAnalyzerRunBusy } from '../tts/design-lock.js';
     import type { Accelerator } from '../gpu/vram-state.js';
     ```
     + the five listed ranges verbatim (no changed lines).
  2. **`transports/ollama-transport.ts`** = header (move `ollama.ts:1-31`'s dispatcher/classification rationale paragraphs verbatim here; leave a one-line pointer in `ollama.ts`: `/* Wire code, dispatcher and unreachable classification live in transports/ollama-transport.ts. */`) + imports
     ```ts
     import { fetch as undiciFetch, Agent } from 'undici';
     import { sampleAndRecordVram } from '../model-vram-stats.js';
     import { acquireAnalyzerSlot } from '../analyzer-concurrency.js';
     import { getLastKnownAnalyzerDevice } from '../../gpu/analyzer-device-state.js';
     import { detectOllamaGpuSplit } from '../../gpu/ollama-gpu-split.js';
     import { configValue } from '../../config/resolver.js';
     import { getLastKnownVram } from '../../gpu/vram-state.js';
     import type { RawEvalTiming } from '../analyzer-eval-stats.js';
     import { AnalysisAbortedError, AnalyzerHttpError, LocalUnreachableError } from '../errors.js';
     import { keepAliveFor, resolveAnalyzerNumCtx, resolveAnalyzerNumGpu, resolveNumPredict } from '../ollama-settings.js';
     import type { ChatTransport, StructuredOutputRequest, TransportRequest, TransportResult } from '../runner/transport.js';
     ```
     + `ANALYZER_DISPATCHER`, `UNREACHABLE_CODES`, `warnedGpuSplitSignatures`, `classifyConnectError` verbatim, plus:
     ```ts
     export interface OllamaTransportOptions {
       url: string;
       model: string;
       /** Injected undici dispatcher — for testing only. Defaults to ANALYZER_DISPATCHER. */
       dispatcher?: Agent;
     }

     function ollamaFormat(so: StructuredOutputRequest): Record<string, unknown> | 'json' | undefined {
       switch (so.mode) {
         case 'schema':
           return so.schema;
         case 'json':
           return 'json';
         case 'off':
           return undefined; // JSON.stringify drops the key
       }
     }

     export class OllamaTransport implements ChatTransport {
       readonly kind = 'ollama' as const;
       readonly model: string;
       private readonly url: string;
       private readonly dispatcher: Agent;

       constructor(opts: OllamaTransportOptions) {
         this.url = opts.url;
         this.model = opts.model;
         this.dispatcher = opts.dispatcher ?? ANALYZER_DISPATCHER;
       }

       async send(req: TransportRequest): Promise<TransportResult> {
         const { signal } = req;
         const { onChunk } = req.call;
         const onEvalTiming: ((t: RawEvalTiming) => void) | undefined = req.call.onEvalTiming;
         /* body: ollama.ts:631-674 with the changed lines below */
         /* …ollama.ts:676-926 with the changed lines below… */
       }
     }
     ```
     Body = `ollama.ts:631-926` (the `chat()` doc comment `:616-622` moves above `send`), with exactly these line changes:
     - `:633` `messages,` → `messages: req.system ? [{ role: 'system' as const, content: req.system }, ...req.messages] : req.messages,`
     - `:643` `format: responseFormat,` → `format: ollamaFormat(req.structuredOutput),`
     - `:656` `temperature,` → `temperature: req.temperature,`
     - `:672` `num_predict: resolveNumPredict(),` → `num_predict: req.maxOutputTokens ?? resolveNumPredict(),`
     - `:829-831` → `if (!buf) { return { text: '', reasoningSeen: false, finish: doneReason === 'length' ? 'length' : 'stop', finishReason: doneReason, receivedBytes: 0 }; }`
     - `:838-843` → keep the `console.warn` at `:839-841` verbatim; replace `:842` `throw new AnalyzerTruncatedError('ollama', 'length', buf.length);` with `return { text: buf, reasoningSeen: false, finish: 'length', finishReason: 'length', receivedBytes: buf.length };`
     - `:923` `return buf;` → `return { text: buf, reasoningSeen: false, finish: 'stop', finishReason: doneReason, receivedBytes: buf.length };`

     Both early returns sit inside the `try` whose `finally` (`:924-926`) calls `releaseSlot()`, and before the VRAM sample (`:846`), split detection (`:854`) and eval timing (`:916`) — the pre-W1 telemetry order.
  3. **`ollama.ts`**: delete every moved range. Add
     ```ts
     import { OllamaTransport, ANALYZER_DISPATCHER, classifyConnectError } from './transports/ollama-transport.js';
     import { resolveOllamaTemperature } from './ollama-settings.js';
     import { mapFinish } from './runner/finish.js';
     import type { ChatMessage } from './runner/transport.js';
     export { ANALYZER_DISPATCHER, classifyConnectError } from './transports/ollama-transport.js';
     export {
       DEFAULT_TEMPERATURE,
       INVALID_JSON_RETRY_TEMPERATURE,
       resolveOllamaTemperature,
       resolveOllamaRetryTemperature,
       normalizeModelTag,
       resolveKeepAliveSeconds,
       hasKeepAliveOverride,
       keepAliveFor,
       ANALYZER_NUM_CTX,
       ANALYZER_NUM_GPU,
       resolveAnalyzerNumCtx,
       resolveAnalyzerNumGpu,
       resolveNumPredict,
     } from './ollama-settings.js';
     ```
     and add `resolveOllamaRetryTemperature` to the `./ollama-settings.js` import (the still-present `runStage` uses it). `OllamaAnalyzer` `:297-305` →
     ```ts
       private readonly model: string;
       private readonly transport: OllamaTransport;

       constructor(opts: OllamaOptions) {
         this.model = opts.model;
         this.transport = new OllamaTransport({ url: opts.url, model: opts.model, dispatcher: opts.dispatcher });
       }
     ```
     Replace `chat()` (`:616-927`) with the adapter (deleted in Task 1.11):
     ```ts
       /* TEMPORARY (#3084 wave 1, removed by Task 1.11): keeps runStage and
          runAttributionEscalation unchanged while the wire code lives in
          OllamaTransport. */
       private async chat(
         messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
         responseFormat: unknown,
         temperature: number,
         onChunk?: (info: StageChunkInfo) => void,
         signal?: AbortSignal,
         onEvalTiming?: (t: RawEvalTiming) => void,
       ): Promise<string> {
         const hasSystem = messages[0]?.role === 'system';
         const result = await this.transport.send({
           system: hasSystem ? messages[0].content : '',
           messages: (hasSystem ? messages.slice(1) : messages) as ChatMessage[],
           structuredOutput: { mode: 'schema', name: 'stage', schema: responseFormat as Record<string, unknown> },
           temperature,
           estimatedInputTokens: 0,
           signal,
           call: { onChunk, onEvalTiming },
         });
         return mapFinish(result, { kind: 'ollama', model: this.model });
       }
     ```
     `generatePersonaViaOllama` is unchanged; it now takes `ANALYZER_DISPATCHER` and `classifyConnectError` from the import above. Delete every import `npm run typecheck` reports as unused (`noUnusedLocals`), and nothing else.
- [ ] **Step 4: Run and confirm it passes**  Run: `npm --prefix server run test -- src/analyzer/transports/ollama-transport.test.ts --retry=0`; `npm run test:server:analyzer`; `npm --prefix server run test -- src/routes/ollama-health.test.ts src/config/direct-env-reader-guard.test.ts --retry=0`; `npm run typecheck`; `npm run check:cycles`  Expected: all PASS; no existing assertion edited.
- [ ] **Step 5: Mutation proof**  In `OllamaTransport.send`, move the `doneReason === 'length'` early return below the split-detection `try { … } catch {}` block → red: "length with text returns finish length WITHOUT GPU-split detection…". Restore. Second: delete `req.system ? … :` so the system message is always prepended → red: "prepends the system message only when system is non-empty" and `ollama.test.ts` "round-trips a valid {assignments} reply" (`body.messages` equality). Restore.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/ollama-settings.ts server/src/analyzer/transports/ollama-transport.ts server/src/analyzer/transports/ollama-transport.test.ts server/src/analyzer/ollama.ts
git commit -m "refactor(server): extract OllamaTransport and ollama settings from ollama.ts"
```

### Task 1.9: Shared transport retry helper + `GeminiTransport` (today's `generateWithLimiter` + `generate`)

**Files:**
- Create: `server/src/analyzer/runner/transport-retry.ts` (moved from `gemini.ts` `BACKOFFS_MS`/`parseBackoffsEnv` `:98-111`, `isRetryable5xx`/`describeStatus` `:869-881`, `sleep` `:883-905`, `jitterMs` `:952-957`, `parseRetryDelayMs`/`nextUtcMidnight` `:959-999`; `withTransportRetry` rewritten from `generateWithLimiter` `:523-652`)
- Create: `server/src/analyzer/transports/gemini-transport.ts` (moved from `gemini.ts` `STREAM_IDLE_TIMEOUT_MS`…`resolveGeminiTemperature` `:50-96`, `GeminiStreamIdleError` `:113-127`, `generate()` `:654-866`)
- Modify: `server/src/analyzer/runner/prompt.ts` (append `estimateInputTokens`, moved from `gemini.ts:907-950`)
- Modify: `server/src/analyzer/gemini.ts` (delete moved ranges; re-exports; `GeminiAnalyzer` fields/ctor `:271-278`; `generateWithLimiter`/`generate` replaced by an adapter)
- Modify: `server/src/analyzer/gemini.test.ts:436` (describe title only — it names the deleted method `generateWithLimiter`)
- Test: `server/src/analyzer/runner/transport-retry.test.ts`, `server/src/analyzer/transports/gemini-transport.test.ts`

**Interfaces:**
- Consumes: Task 1.7 types, `mapFinish`; `geminiRateLimiter`, `GeminiRateLimiter`, `DailyQuotaExhaustedError` (`rate-limit.ts`).
- Produces: `transport-retry.ts` — `type RetryDisposition = 'abort' | 'no-retry' | 'idle' | 'daily-quota' | 'rate-limit' | 'server-error'`, `interface RetryClassifier { classify(err: unknown): RetryDisposition; retryAfterMs(err: unknown): number | null }`, `withTransportRetry<T>(attempt, opts)` (contract opts **plus** `logTag: string` and `displayName: string`), `BACKOFFS_MS`, `parseRetryDelayMs`, `nextUtcMidnight`, `isRetryable5xx`. `gemini-transport.ts` — `class GeminiTransport implements ChatTransport` (ctor `{ apiKey: string; model: string; client?: GoogleGenAI }`), `GEMINI_RETRY_CLASSIFIER`, and the moved `STREAM_IDLE_TIMEOUT_MS`, `MAX_RESPONSE_BYTES`, `appendBounded`, `resolveStreamIdleTimeoutMs`, `DEFAULT_MAX_OUTPUT_TOKENS`, `resolveMaxOutputTokens`, `resolveGeminiTemperature`, `GeminiStreamIdleError`. `prompt.ts` — `estimateInputTokens`. `gemini.ts` re-exports all of them.

Suites that could break: slow `gemini.test.ts` (idle test calls `vi.resetModules()` so `BACKOFFS_MS`, now evaluated in `transport-retry.ts`, re-reads `GEMINI_RETRY_BACKOFFS_MS`; escalation test spies the live `geminiRateLimiter.acquire`), `output-heavy-tpm.test.ts` and `stage1-chunk.test.ts` (`estimateInputTokens` via `./gemini.js`), `rate-limit.test.ts`, `voice-style.test.ts`.

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/runner/transport-retry.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { withTransportRetry, type RetryClassifier, type RetryDisposition } from './transport-retry.js';
import { AnalysisAbortedError } from '../errors.js';
import { DailyQuotaExhaustedError, type GeminiRateLimiter } from '../rate-limit.js';

const tagged = (d: RetryDisposition, retryAfter: number | null = null) =>
  Object.assign(new Error(d), { d, retryAfter });
const classifier: RetryClassifier = {
  classify: (err) => (err as { d?: RetryDisposition }).d ?? 'no-retry',
  retryAfterMs: (err) => (err as { retryAfter?: number | null }).retryAfter ?? null,
};
function fakeLimiter() {
  return { acquire: vi.fn(async () => undefined), recordActualTokens: vi.fn(), recordRejection: vi.fn() };
}
function opts(limiter: ReturnType<typeof fakeLimiter>, over: Record<string, unknown> = {}) {
  return {
    model: 'm',
    limiter: limiter as unknown as GeminiRateLimiter,
    estimatedInputTokens: 42,
    classifier,
    maxAttempts: 3,
    maxTotalMs: 90_000,
    backoffsMs: [0, 0] as readonly number[],
    logTag: 'gemini',
    displayName: 'Gemini',
    ...over,
  };
}

describe('withTransportRetry (extracted from GeminiAnalyzer.generateWithLimiter)', () => {
  it('acquires the limiter per attempt and records actual tokens only when the reconciler returns a number', async () => {
    const limiter = fakeLimiter();
    const out = await withTransportRetry(async () => 'ok', opts(limiter, { recordActualTokens: () => 900 }));
    expect(out).toBe('ok');
    expect(limiter.acquire).toHaveBeenCalledTimes(1);
    expect(limiter.acquire.mock.calls[0][0]).toBe('m');
    expect(limiter.acquire.mock.calls[0][1]).toBe(42);
    expect(limiter.recordActualTokens).toHaveBeenCalledWith('m', 900);
    const l2 = fakeLimiter();
    await withTransportRetry(async () => 'ok', opts(l2, { recordActualTokens: () => undefined }));
    expect(l2.recordActualTokens).not.toHaveBeenCalled();
  });

  it.each(['server-error', 'idle'] as const)('%s retries up to maxAttempts, then rethrows the LAST error', async (d) => {
    const limiter = fakeLimiter();
    const errs = [tagged(d), tagged(d), tagged(d)];
    const attempt = vi.fn(async () => {
      throw errs[attempt.mock.calls.length - 1];
    });
    await expect(withTransportRetry(attempt, opts(limiter))).rejects.toBe(errs[2]);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(limiter.acquire).toHaveBeenCalledTimes(3);
  });

  it('rate-limit records the rejection with retry-after on every 429 and retries', async () => {
    const limiter = fakeLimiter();
    const attempt = vi.fn().mockRejectedValueOnce(tagged('rate-limit', 2000)).mockResolvedValueOnce('ok');
    await expect(withTransportRetry(attempt, opts(limiter, { backoffsMs: [0] }))).resolves.toBe('ok');
    expect(limiter.recordRejection).toHaveBeenCalledWith('m', 2000);
  });

  it('daily-quota blocks the limiter and throws DailyQuotaExhaustedError without retrying', async () => {
    const limiter = fakeLimiter();
    const attempt = vi.fn().mockRejectedValue(tagged('daily-quota'));
    await expect(withTransportRetry(attempt, opts(limiter))).rejects.toBeInstanceOf(DailyQuotaExhaustedError);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(limiter.recordRejection.mock.calls[0][0]).toBe('m');
    expect(limiter.recordRejection.mock.calls[0][1]).toBeGreaterThan(0);
  });

  it.each(['abort', 'no-retry'] as const)('%s rethrows immediately', async (d) => {
    const err = tagged(d);
    const attempt = vi.fn().mockRejectedValue(err);
    await expect(withTransportRetry(attempt, opts(fakeLimiter()))).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('an exhausted time budget before any attempt throws the display-named budget error', async () => {
    const attempt = vi.fn();
    await expect(withTransportRetry(attempt, opts(fakeLimiter(), { maxTotalMs: 0 }))).rejects.toThrow(
      'Gemini retry budget exhausted with no recorded error.',
    );
    expect(attempt).not.toHaveBeenCalled();
  });

  it('a backoff over 1s is announced via onThrottle(…, "retry-after")', async () => {
    const onThrottle = vi.fn();
    const attempt = vi.fn().mockRejectedValueOnce(tagged('server-error')).mockResolvedValueOnce('ok');
    await withTransportRetry(attempt, opts(fakeLimiter(), { backoffsMs: [1500], onThrottle }));
    expect(onThrottle).toHaveBeenCalledWith(expect.any(Number), 'retry-after');
    expect(onThrottle.mock.calls[0][0]).toBeGreaterThan(1000);
  });

  it('aborting during a backoff rejects with AnalysisAbortedError naming the log tag', async () => {
    const ac = new AbortController();
    const attempt = vi.fn().mockRejectedValue(tagged('server-error'));
    const p = withTransportRetry(attempt, opts(fakeLimiter(), { backoffsMs: [5000], signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AnalysisAbortedError);
    expect((err as Error).message).toBe('Aborted during gemini retry backoff.');
  });
});
```

`server/src/analyzer/transports/gemini-transport.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TransportRequest } from '../runner/transport.js';

const generateContentStream = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContentStream };
  },
}));

async function* stream<T>(items: T[], delayMs = 0): AsyncGenerator<T> {
  for (const item of items) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield item;
  }
}
const req = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  system: 'SYS',
  messages: [{ role: 'user', content: 'hi' }],
  structuredOutput: { mode: 'json' },
  temperature: 0.2,
  estimatedInputTokens: 100,
  call: {},
  ...over,
});
const ORIGINAL_IDLE = process.env.GEMINI_STREAM_IDLE_MS;

beforeEach(async () => {
  generateContentStream.mockReset();
  const { geminiRateLimiter } = await import('../rate-limit.js');
  geminiRateLimiter._reset();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_IDLE === undefined) delete process.env.GEMINI_STREAM_IDLE_MS;
  else process.env.GEMINI_STREAM_IDLE_MS = ORIGINAL_IDLE;
});

describe('GeminiTransport (#3084 wave 1)', () => {
  it('builds today\'s request: model turn mapping, verbatim system, json mime type, no thinkingConfig', async () => {
    generateContentStream.mockImplementation(async () => stream([{ text: '{}' }]));
    const { GeminiTransport, resolveMaxOutputTokens } = await import('./gemini-transport.js');
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-shape' });
    await t.send(
      req({
        system: '',
        messages: [
          { role: 'user', content: 'p' },
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'fix' },
        ],
      }),
    );
    const args = generateContentStream.mock.calls[0][0];
    expect(args.model).toBe('gemma-gt-shape');
    expect(args.contents).toEqual([
      { role: 'user', parts: [{ text: 'p' }] },
      { role: 'model', parts: [{ text: 'a' }] },
      { role: 'user', parts: [{ text: 'fix' }] },
    ]);
    expect(args.config.systemInstruction).toBe('');
    expect(args.config.responseMimeType).toBe('application/json');
    expect(args.config.temperature).toBe(0.2);
    expect(args.config.maxOutputTokens).toBe(resolveMaxOutputTokens());
    expect(args.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect('thinkingConfig' in args.config).toBe(false);
    expect('responseJsonSchema' in args.config).toBe(false);
  });

  it('maps structured output off → no mime type, schema → mime type + responseJsonSchema', async () => {
    generateContentStream.mockImplementation(async () => stream([{ text: '{}' }]));
    const { GeminiTransport } = await import('./gemini-transport.js');
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-modes' });
    await t.send(req({ structuredOutput: { mode: 'off' } }));
    await t.send(req({ structuredOutput: { mode: 'schema', name: 's', schema: { type: 'object' } } }));
    expect('responseMimeType' in generateContentStream.mock.calls[0][0].config).toBe(false);
    expect(generateContentStream.mock.calls[1][0].config).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
    });
  });

  it('thought parts set reasoningSeen, keep the idle watchdog alive, and never enter text or onChunk', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '150';
    const thought = { text: undefined, candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }] };
    generateContentStream.mockResolvedValueOnce(
      stream(
        [thought, thought, thought, thought, { text: '{"a":1}', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"a":1}' }] } }] }],
        100,
      ),
    );
    const onChunk = vi.fn();
    const { GeminiTransport } = await import('./gemini-transport.js');
    const r = await new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-thought' }).send(req({ call: { onChunk } }));
    expect(r.text).toBe('{"a":1}');
    expect(r.reasoningSeen).toBe(true);
    expect(r.finish).toBe('stop');
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it('no thought parts → reasoningSeen false; STOP reconciles prompt tokens with the limiter', async () => {
    generateContentStream.mockResolvedValueOnce(
      stream([{ text: '{"a":1}', usageMetadata: { promptTokenCount: 1234 }, candidates: [{ finishReason: 'STOP' }] }]),
    );
    const { geminiRateLimiter } = await import('../rate-limit.js');
    const spy = vi.spyOn(geminiRateLimiter, 'recordActualTokens');
    const { GeminiTransport } = await import('./gemini-transport.js');
    const r = await new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-usage' }).send(req());
    expect(r).toMatchObject({ text: '{"a":1}', reasoningSeen: false, finish: 'stop', receivedBytes: 7, usage: { inputTokens: 1234 } });
    expect(spy).toHaveBeenCalledWith('gemma-gt-usage', 1234);
  });

  it('empty MAX_TOKENS → finish length with 0 bytes; the limiter is NOT reconciled (pre-W1 only reconciled a returned text)', async () => {
    generateContentStream.mockResolvedValueOnce(
      stream([{ text: '', usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8192 }, candidates: [{ finishReason: 'MAX_TOKENS' }] }]),
    );
    const { geminiRateLimiter } = await import('../rate-limit.js');
    const spy = vi.spyOn(geminiRateLimiter, 'recordActualTokens');
    const { GeminiTransport } = await import('./gemini-transport.js');
    const r = await new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-maxtok' }).send(req());
    expect(r).toMatchObject({ text: '', finish: 'length', finishReason: 'MAX_TOKENS', receivedBytes: 0, usage: { outputTokens: 8192 } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('empty RECITATION → finish blocked naming the reason; non-empty SAFETY → finish length', async () => {
    generateContentStream
      .mockResolvedValueOnce(stream([{ text: '', candidates: [{ finishReason: 'RECITATION' }] }]))
      .mockResolvedValueOnce(stream([{ text: '{"a":', candidates: [{ finishReason: 'SAFETY' }] }]));
    const { GeminiTransport } = await import('./gemini-transport.js');
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-stops' });
    expect(await t.send(req())).toMatchObject({ finish: 'blocked', blockReason: 'RECITATION' });
    expect(await t.send(req())).toMatchObject({ finish: 'length', finishReason: 'SAFETY', receivedBytes: 5 });
  });
});
```
- [ ] **Step 2: Run and confirm they fail**  Run: `npm --prefix server run test -- src/analyzer/runner/transport-retry.test.ts src/analyzer/transports/gemini-transport.test.ts --retry=0`  Expected: FAIL — `Failed to resolve import "./transport-retry.js"` / `"./gemini-transport.js"`.
- [ ] **Step 3: Implement**
  1. **`runner/prompt.ts`**: append `gemini.ts:907-950` (`estimateInputTokens` and its comment) verbatim; add imports `import { countCjkChars } from '../../util/cjk.js';` and `import { LATIN_CHARS_PER_TOKEN, CYRILLIC_CHARS_PER_TOKEN, HAN_KANA_CHARS_PER_TOKEN, countCyrillic } from '../token-budget.js';` (`token-budget.ts` imports only `config/resolver` and `util/cjk`, so no cycle).
  2. **`runner/transport-retry.ts`** = header `/* Transport-level retry shared by limiter-governed transports (Gemini today; OpenAI endpoints in wave 3). Extracted from GeminiAnalyzer.generateWithLimiter (#3084 wave 1); the policy comment gemini.ts:523-535 moves above withTransportRetry. */` + imports
     ```ts
     import { AnalysisAbortedError } from '../errors.js';
     import { DailyQuotaExhaustedError, type GeminiRateLimiter } from '../rate-limit.js';
     import type { StageCall } from '../types.js';
     ```
     + `BACKOFFS_MS`/`parseBackoffsEnv`, `isRetryable5xx` (now `export`), `describeStatus`, `jitterMs`, `parseRetryDelayMs`, `nextUtcMidnight` verbatim; `sleep` verbatim except the signature `function sleep(ms: number, signal: AbortSignal | undefined, logTag: string): Promise<void>` and `:901` → `reject(new AnalysisAbortedError(\`Aborted during ${logTag} retry backoff.\`));`. Then:
     ```ts
     export type RetryDisposition = 'abort' | 'no-retry' | 'idle' | 'daily-quota' | 'rate-limit' | 'server-error';

     export interface RetryClassifier {
       classify(err: unknown): RetryDisposition;
       retryAfterMs(err: unknown): number | null;
     }

     export async function withTransportRetry<T>(
       attempt: () => Promise<T>,
       opts: {
         model: string;
         limiter: GeminiRateLimiter;
         estimatedInputTokens: number;
         classifier: RetryClassifier;
         signal?: AbortSignal;
         onThrottle?: StageCall['onThrottle'];
         maxAttempts: number;
         maxTotalMs: number;
         backoffsMs: readonly number[];
         recordActualTokens?: (result: T) => number | undefined;
         /** Log prefix without brackets, e.g. 'gemini'. */
         logTag: string;
         /** Human engine name for the budget-exhausted error, e.g. 'Gemini'. */
         displayName: string;
       },
     ): Promise<T> {
       const start = Date.now();
       let lastErr: unknown = null;

       const onWaitForLimiter = (waitMs: number, reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after') => {
         if (waitMs > 1000) opts.onThrottle?.(waitMs, reason);
       };

       for (let i = 0; i < opts.maxAttempts; i += 1) {
         if (Date.now() - start >= opts.maxTotalMs) break;

         await opts.limiter.acquire(opts.model, opts.estimatedInputTokens, {
           signal: opts.signal,
           onWait: onWaitForLimiter,
         });

         try {
           const out = await attempt();
           const actual = opts.recordActualTokens?.(out);
           if (actual && Number.isFinite(actual)) opts.limiter.recordActualTokens(opts.model, actual);
           return out;
         } catch (err) {
           lastErr = err;
           const disposition = opts.classifier.classify(err);
           if (disposition === 'abort' || disposition === 'no-retry') throw err;

           if (disposition === 'daily-quota') {
             const resetAt = nextUtcMidnight();
             opts.limiter.recordRejection(opts.model, resetAt.getTime() - Date.now());
             throw new DailyQuotaExhaustedError(opts.model, resetAt);
           }

           let backoff: number;
           if (disposition === 'idle') {
             if (i >= opts.maxAttempts - 1) break;
             backoff = jitterMs(opts.backoffsMs[i] ?? 6000);
             console.warn(
               `[${opts.logTag}] stream idle ${(err as { idleMs?: number }).idleMs}ms — retrying in ${backoff}ms (attempt ${i + 2}/${opts.maxAttempts})`,
             );
           } else if (disposition === 'rate-limit') {
             const retryAfterMs = opts.classifier.retryAfterMs(err);
             opts.limiter.recordRejection(opts.model, retryAfterMs);
             if (i >= opts.maxAttempts - 1) break;
             backoff = jitterMs(Math.max(retryAfterMs ?? 0, opts.backoffsMs[i] ?? 6000));
             console.warn(`[${opts.logTag}] 429 — retrying in ${backoff}ms (attempt ${i + 2}/${opts.maxAttempts})`);
           } else {
             if (i >= opts.maxAttempts - 1) break;
             backoff = jitterMs(opts.backoffsMs[i] ?? 6000);
             console.warn(
               `[${opts.logTag}] transient ${describeStatus(err)} — retrying in ${backoff}ms (attempt ${i + 2}/${opts.maxAttempts})`,
             );
           }
           if (backoff > 1000) opts.onThrottle?.(backoff, 'retry-after');
           await sleep(backoff, opts.signal, opts.logTag);
         }
       }

       throw lastErr ?? new Error(`${opts.displayName} retry budget exhausted with no recorded error.`);
     }
     ```
     This reproduces `gemini.ts:552-651` branch for branch: abort/truncation rethrow (`:575,:580`), idle (`:586-595`), 429 per-day (`:613-617`) and per-minute (`:621-630`), 5xx (`:633-642`), rethrow (`:644`), exhausted (`:651`). The 429 per-day regex moves into the classifier below.
  3. **`transports/gemini-transport.ts`** = imports
     ```ts
     import { GoogleGenAI } from '@google/genai';
     import { configValue } from '../../config/resolver.js';
     import { AnalysisAbortedError, AnalyzerTruncatedError, GeminiContentBlockedError } from '../errors.js';
     import { geminiRateLimiter } from '../rate-limit.js';
     import { BACKOFFS_MS, isRetryable5xx, parseRetryDelayMs, withTransportRetry, type RetryClassifier } from '../runner/transport-retry.js';
     import type { ChatTransport, StructuredOutputRequest, TransportRequest, TransportResult } from '../runner/transport.js';
     ```
     + `gemini.ts:50-96` and `:113-127` verbatim, plus:
     ```ts
     export const GEMINI_RETRY_CLASSIFIER: RetryClassifier = {
       classify(err) {
         if (err instanceof AnalysisAbortedError) return 'abort';
         if (err instanceof AnalyzerTruncatedError) return 'no-retry';
         if (err instanceof GeminiStreamIdleError) return 'idle';
         if ((err as { status?: number })?.status === 429) {
           /* Same per-day marker and rationale as gemini.ts:598-613 (#1682, #1695). */
           return /per[_-]?day/i.test((err as Error)?.message ?? String(err)) ? 'daily-quota' : 'rate-limit';
         }
         if (isRetryable5xx(err)) return 'server-error';
         return 'no-retry';
       },
       retryAfterMs: parseRetryDelayMs,
     };

     function structuredOutputConfig(so: StructuredOutputRequest): Record<string, unknown> {
       switch (so.mode) {
         case 'schema':
           return { responseMimeType: 'application/json', responseJsonSchema: so.schema };
         case 'json':
           return { responseMimeType: 'application/json' };
         case 'off':
           return {};
       }
     }

     function logGenerateFailed(model: string, err: unknown, req: TransportRequest): void {
       const userTurn = req.messages[req.messages.length - 1]?.content ?? '';
       console.error('[gemini] generate failed', {
         model,
         status: (err as { status?: number })?.status,
         name: (err as Error)?.name,
         message: (err as Error)?.message ?? String(err),
         userTurnLength: userTurn.length,
         userTurnHead: userTurn.slice(0, 200),
       });
     }

     export class GeminiTransport implements ChatTransport {
       readonly kind = 'gemini' as const;
       readonly model: string;
       private readonly client: GoogleGenAI;

       constructor(opts: { apiKey: string; model: string; client?: GoogleGenAI }) {
         this.client = opts.client ?? new GoogleGenAI({ apiKey: opts.apiKey });
         this.model = opts.model;
       }

       send(req: TransportRequest): Promise<TransportResult> {
         return withTransportRetry(() => this.generate(req), {
           model: this.model,
           limiter: geminiRateLimiter,
           estimatedInputTokens: req.estimatedInputTokens,
           classifier: GEMINI_RETRY_CLASSIFIER,
           signal: req.signal,
           onThrottle: req.call.onThrottle,
           maxAttempts: 3,
           maxTotalMs: 90_000,
           backoffsMs: BACKOFFS_MS,
           /* Pre-W1 reconciled only on a returned text; a truncated or blocked
              response was thrown and never reconciled. */
           recordActualTokens: (r) => (r.finish === 'stop' ? r.usage?.inputTokens : undefined),
           logTag: 'gemini',
           displayName: 'Gemini',
         });
       }

       private async generate(req: TransportRequest): Promise<TransportResult> {
         /* gemini.ts:684-866 with the changed lines below */
       }
     }
     ```
     `generate` body = `gemini.ts:684-866` (the doc comment `:654-677` moves above it) with exactly these changes:
     - Before `:684` add `const callerSignal = req.signal; const onChunk = req.call.onChunk; const contents = req.messages.map((m) => ({ role: m.role === 'assistant' ? ('model' as const) : ('user' as const), parts: [{ text: m.content }] }));`
     - `:725-735` config → `config: { ...structuredOutputConfig(req.structuredOutput), systemInstruction: req.system, abortSignal: combined, maxOutputTokens: req.maxOutputTokens ?? resolveMaxOutputTokens(), temperature: req.temperature },`
     - `:748` add `let reasoningSeen = false;`
     - `:751-756` chunk type → add `content?: { parts?: Array<{ thought?: boolean }> }` to the `candidates` element type.
     - after `:759` (`const chunk = next.value;`) add `if (chunk.candidates?.[0]?.content?.parts?.some((p) => p.thought === true)) reasoningSeen = true;` (the SDK's `text` getter already skips `thought` parts, `@google/genai` `dist/node/index.mjs` `get text()`, so answer text is unchanged; `armIdleTimer()` at `:758` already counts every chunk as activity).
     - add before `:783`: `const usage = { inputTokens: promptTokenCount, outputTokens: candidatesTokenCount };`
     - `:801-803` → `if (finishReason === 'MAX_TOKENS') { console.warn(\`[gemini] output truncated reason=${finishReason} bytes=0\` + (candidatesTokenCount ? \` tokens=${candidatesTokenCount}\` : '') + \` model=${this.model}\`); return { text: '', reasoningSeen, finish: 'length', finishReason, receivedBytes: 0, usage }; }`
     - `:804-805` → `const stopReason = finishReason ?? blockReason; logGenerateFailed(this.model, new GeminiContentBlockedError(this.model, stopReason), req); return { text: '', reasoningSeen, finish: 'blocked', finishReason, blockReason: stopReason, receivedBytes: 0, usage };`
     - `:816-818` → `if (finishReason && finishReason !== 'STOP' && finishReason !== 'FINISH_REASON_UNSPECIFIED') { console.warn(\`[gemini] output truncated reason=${finishReason} bytes=${buf.length}\` + (candidatesTokenCount ? \` tokens=${candidatesTokenCount}\` : '') + \` model=${this.model}\`); return { text: buf, reasoningSeen, finish: 'length', finishReason, receivedBytes: buf.length, usage }; }`
     - `:819` → `return { text: buf, reasoningSeen, finish: 'stop', finishReason, receivedBytes: buf.length, usage };`
     - `:833-842` (the `instanceof AnalyzerTruncatedError` branch) → delete (the try block no longer throws it).
     - `:850-860` → `logGenerateFailed(this.model, err, req);`

     The two `console.warn` / `console.error` lines keep today's exact text and fire on the same conditions (pre-W1 they fired in the `catch` for the thrown truncation / block).
  4. **`gemini.ts`**: delete every moved range, `generateWithLimiter` (`:523-652`) and `generate` (`:654-866`). Add
     ```ts
     import { GeminiTransport, resolveGeminiTemperature } from './transports/gemini-transport.js';
     import { mapFinish } from './runner/finish.js';
     export {
       STREAM_IDLE_TIMEOUT_MS,
       MAX_RESPONSE_BYTES,
       appendBounded,
       resolveStreamIdleTimeoutMs,
       DEFAULT_MAX_OUTPUT_TOKENS,
       resolveMaxOutputTokens,
       resolveGeminiTemperature,
       GeminiStreamIdleError,
     } from './transports/gemini-transport.js';
     export { BACKOFFS_MS, parseRetryDelayMs, nextUtcMidnight } from './runner/transport-retry.js';
     ```
     and add `estimateInputTokens` to both the `./runner/prompt.js` import and its `export { … }` line. `GeminiAnalyzer` `:272-278` →
     ```ts
       private readonly transport: GeminiTransport;
       private readonly model: string;

       constructor(opts: GeminiOptions) {
         this.transport = new GeminiTransport({ apiKey: opts.apiKey, model: opts.model });
         this.model = opts.model;
       }
     ```
     Add the adapter (deleted in Task 1.11):
     ```ts
       /* TEMPORARY (#3084 wave 1, removed by Task 1.11): keeps runStage and
          runAttributionEscalation unchanged while the wire code lives in
          GeminiTransport. */
       private async generateWithLimiter(
         contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
         systemInstruction: string,
         call: StageCall,
       ): Promise<string> {
         const result = await this.transport.send({
           system: systemInstruction,
           messages: contents.map((c) => ({
             role: c.role === 'model' ? ('assistant' as const) : ('user' as const),
             content: c.parts[0]?.text ?? '',
           })),
           structuredOutput: { mode: 'json' },
           temperature: resolveGeminiTemperature(),
           estimatedInputTokens: estimateInputTokens(systemInstruction, contents),
           signal: call.signal,
           call: { onChunk: call.onChunk, onThrottle: call.onThrottle },
         });
         return mapFinish(result, { kind: 'gemini', model: this.model });
       }
     ```
     Delete every import `npm run typecheck` reports unused.
  5. **`gemini.test.ts:436`** → `describe('GeminiAnalyzer — transport retry policy (GeminiTransport + withTransportRetry)', () => {` (title only; no assertion touched).
- [ ] **Step 4: Run and confirm they pass**  Run: `npm --prefix server run test -- src/analyzer/runner/transport-retry.test.ts src/analyzer/transports/gemini-transport.test.ts --retry=0`; `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`; `npm run test:server:analyzer`; `npm run typecheck`; `npm run check:cycles`  Expected: all PASS.
- [ ] **Step 5: Mutation proofs**
  1. Delete the `if (disposition === 'daily-quota') { … }` block in `withTransportRetry` → red: "daily-quota blocks the limiter and throws DailyQuotaExhaustedError without retrying" and slow `gemini.test.ts` "throws DailyQuotaExhaustedError on a daily-quota 429, no retry". Restore.
  2. Change `recordActualTokens` in `GeminiTransport.send` to `(r) => r.usage?.inputTokens` → red: "empty MAX_TOKENS → finish length with 0 bytes; the limiter is NOT reconciled…". Restore.
  3. Delete the `reasoningSeen = true` line → red: "thought parts set reasoningSeen…". Restore.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/transport-retry.ts server/src/analyzer/runner/transport-retry.test.ts server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/gemini-transport.test.ts server/src/analyzer/runner/prompt.ts server/src/analyzer/gemini.ts server/src/analyzer/gemini.test.ts
git commit -m "refactor(server): extract GeminiTransport and the shared transport retry helper"
```

### Task 1.10: Validation retry policies

**Files:**
- Create: `server/src/analyzer/runner/retry-policy.ts`
- Test: `server/src/analyzer/runner/retry-policy.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` (Task 1.7); `ParseResult`, `buildRetryMessage` (`runner/parse.ts`); `resolveOllamaTemperature`, `resolveOllamaRetryTemperature` (`ollama-settings.ts`); `resolveGeminiTemperature` (`transports/gemini-transport.ts`); `AnalysisAbortedError`, `LocalUnreachableError`.
- Produces: `interface ValidationRetryPolicy` (contract members **plus** `initialTemperature(): number` and `readonly warnsOnRepair: boolean` — see report), `OLLAMA_RETRY_POLICY`, `GEMINI_RETRY_POLICY`. (`OPENAI_RETRY_POLICY` is wave 3.)

Encodes, one-for-one: Ollama `ollama.ts:524-533` (repair warning), `:539-548`/`:593-607` (raw forensics), `:559-571` (retry shape + temperature), `:455-456` (escalation rethrows), `:608-610` (message); Gemini `gemini.ts:467-471` (no warning), `:474-482` (no raw files), `:484-493` (always replay), `:421` (escalation rethrows abort only), `:515-517` (message).

- [ ] **Step 1: Write the failing test** — `server/src/analyzer/runner/retry-policy.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { OLLAMA_RETRY_POLICY, GEMINI_RETRY_POLICY } from './retry-policy.js';
import { buildRetryMessage, type ParseResult } from './parse.js';
import { resolveOllamaTemperature, resolveOllamaRetryTemperature } from '../ollama-settings.js';
import { resolveGeminiTemperature } from '../transports/gemini-transport.js';
import { AnalysisAbortedError, AnalyzerHttpError, LocalUnreachableError } from '../errors.js';
import { DailyQuotaExhaustedError } from '../rate-limit.js';
import type { ChatMessage } from './transport.js';

type Failure = Extract<ParseResult<unknown>, { ok: false }>;
const FIRST: ChatMessage[] = [{ role: 'user', content: '# prompt' }];
const INVALID_JSON: Failure = { ok: false, kind: 'invalid-json', detail: 'Unexpected end of JSON input' };
const SCHEMA: Failure = { ok: false, kind: 'schema-validation', detail: [] };
const ERRORS = {
  abort: new AnalysisAbortedError('x'),
  unreachable: new LocalUnreachableError('down'),
  http: new AnalyzerHttpError('ollama', 500, 'b', 'm'),
  quota: new DailyQuotaExhaustedError('gemma-x', new Date()),
  plain: new Error('empty'),
};

describe('OLLAMA_RETRY_POLICY', () => {
  it('invalid-json drops the assistant turn and uses the retry temperature', () => {
    expect(OLLAMA_RETRY_POLICY.buildRetry({ messages: FIRST, firstRaw: '{"a"', failure: INVALID_JSON })).toEqual({
      messages: FIRST,
      temperature: resolveOllamaRetryTemperature(),
    });
  });

  it('schema-validation replays the output + buildRetryMessage at the first-attempt temperature', () => {
    expect(OLLAMA_RETRY_POLICY.buildRetry({ messages: FIRST, firstRaw: 'RAW', failure: SCHEMA })).toEqual({
      messages: [...FIRST, { role: 'assistant', content: 'RAW' }, { role: 'user', content: buildRetryMessage(SCHEMA) }],
      temperature: resolveOllamaTemperature(),
    });
  });

  it('first-attempt temperature, raw forensics and repair warnings', () => {
    expect(OLLAMA_RETRY_POLICY.name).toBe('ollama');
    expect(OLLAMA_RETRY_POLICY.initialTemperature()).toBe(resolveOllamaTemperature());
    expect(OLLAMA_RETRY_POLICY.writesRawAttempts).toBe(true);
    expect(OLLAMA_RETRY_POLICY.warnsOnRepair).toBe(true);
  });

  it('escalation rethrows abort and LocalUnreachableError only', () => {
    expect(OLLAMA_RETRY_POLICY.escalationRethrows(ERRORS.abort)).toBe(true);
    expect(OLLAMA_RETRY_POLICY.escalationRethrows(ERRORS.unreachable)).toBe(true);
    expect(OLLAMA_RETRY_POLICY.escalationRethrows(ERRORS.http)).toBe(false);
    expect(OLLAMA_RETRY_POLICY.escalationRethrows(ERRORS.plain)).toBe(false);
  });

  it('final failure message names model and key', () => {
    expect(OLLAMA_RETRY_POLICY.finalFailureMessage({ model: 'qwen3.5:9b', key: '1-ch1', detail: 'schema-validation — []' })).toBe(
      'Ollama qwen3.5:9b 1-ch1 failed validation after retry: schema-validation — []',
    );
  });
});

describe('GEMINI_RETRY_POLICY', () => {
  it.each([
    ['invalid-json', INVALID_JSON],
    ['schema-validation', SCHEMA],
  ] as const)('%s replays the output + buildRetryMessage at the same temperature', (_label, failure) => {
    expect(GEMINI_RETRY_POLICY.buildRetry({ messages: FIRST, firstRaw: 'RAW', failure })).toEqual({
      messages: [...FIRST, { role: 'assistant', content: 'RAW' }, { role: 'user', content: buildRetryMessage(failure) }],
      temperature: resolveGeminiTemperature(),
    });
  });

  it('first-attempt temperature; no raw forensics; no repair warnings', () => {
    expect(GEMINI_RETRY_POLICY.name).toBe('gemini');
    expect(GEMINI_RETRY_POLICY.initialTemperature()).toBe(resolveGeminiTemperature());
    expect(GEMINI_RETRY_POLICY.writesRawAttempts).toBe(false);
    expect(GEMINI_RETRY_POLICY.warnsOnRepair).toBe(false);
  });

  it('escalation rethrows abort only — a daily-quota or unreachable error resolves null', () => {
    expect(GEMINI_RETRY_POLICY.escalationRethrows(ERRORS.abort)).toBe(true);
    expect(GEMINI_RETRY_POLICY.escalationRethrows(ERRORS.quota)).toBe(false);
    expect(GEMINI_RETRY_POLICY.escalationRethrows(ERRORS.unreachable)).toBe(false);
    expect(GEMINI_RETRY_POLICY.escalationRethrows(ERRORS.plain)).toBe(false);
  });

  it('final failure message names the key but not the model', () => {
    expect(GEMINI_RETRY_POLICY.finalFailureMessage({ model: 'gemma-x', key: '1-ch1', detail: 'invalid-json — x' })).toBe(
      'Gemini 1-ch1 failed validation after retry: invalid-json — x',
    );
  });
});
```
- [ ] **Step 2: Run and confirm it fails**  Run: `npm --prefix server run test -- src/analyzer/runner/retry-policy.test.ts --retry=0`  Expected: FAIL — `Failed to resolve import "./retry-policy.js"`.
- [ ] **Step 3: Implement** — `server/src/analyzer/runner/retry-policy.ts`:
```ts
/* Per-transport validation-retry policy (#3084 wave 1). The stage runner owns
   the attempt loop; these objects hold every place the two pre-extraction
   runners differed, so each engine's behaviour is unchanged. */
import { AnalysisAbortedError, LocalUnreachableError } from '../errors.js';
import { resolveOllamaRetryTemperature, resolveOllamaTemperature } from '../ollama-settings.js';
import { resolveGeminiTemperature } from '../transports/gemini-transport.js';
import { buildRetryMessage, type ParseResult } from './parse.js';
import type { ChatMessage } from './transport.js';

type ParseFailure = Extract<ParseResult<unknown>, { ok: false }>;

export interface ValidationRetryPolicy {
  readonly name: 'ollama' | 'gemini' | 'openai';
  /** Temperature of the first attempt (and of escalation's single attempt). */
  initialTemperature(): number;
  buildRetry(input: { messages: ChatMessage[]; firstRaw: string; failure: ParseFailure }): {
    messages: ChatMessage[];
    temperature: number;
  };
  /** Write handoff `attemptN.raw.txt` forensics on a failed attempt. */
  readonly writesRawAttempts: boolean;
  /** Log "required JSON cleanup" when a response only parsed after repair. */
  readonly warnsOnRepair: boolean;
  /** Errors the best-effort escalation pass must rethrow rather than resolve null. */
  escalationRethrows(err: unknown): boolean;
  /** Today's exact post-retry failure text; `detail` is "<kind> — <summarised detail>". */
  finalFailureMessage(input: { model: string; key: string; detail: string }): string;
}

function replayAndCorrect(messages: ChatMessage[], firstRaw: string, failure: ParseFailure): ChatMessage[] {
  return [...messages, { role: 'assistant', content: firstRaw }, { role: 'user', content: buildRetryMessage(failure) }];
}

export const OLLAMA_RETRY_POLICY: ValidationRetryPolicy = {
  name: 'ollama',
  initialTemperature: () => resolveOllamaTemperature(),
  buildRetry({ messages, firstRaw, failure }) {
    /* invalid-json: replaying broken bytes at low temperature regenerates the
       same bytes (observed failing at the same byte position twice), so drop
       the assistant turn and raise the temperature. schema-validation:
       replay-and-correct at the first-attempt temperature. */
    if (failure.kind === 'invalid-json') {
      return { messages, temperature: resolveOllamaRetryTemperature() };
    }
    return { messages: replayAndCorrect(messages, firstRaw, failure), temperature: resolveOllamaTemperature() };
  },
  writesRawAttempts: true,
  warnsOnRepair: true,
  escalationRethrows: (err) => err instanceof AnalysisAbortedError || err instanceof LocalUnreachableError,
  finalFailureMessage: ({ model, key, detail }) => `Ollama ${model} ${key} failed validation after retry: ${detail}`,
};

export const GEMINI_RETRY_POLICY: ValidationRetryPolicy = {
  name: 'gemini',
  initialTemperature: () => resolveGeminiTemperature(),
  buildRetry: ({ messages, firstRaw, failure }) => ({
    messages: replayAndCorrect(messages, firstRaw, failure),
    temperature: resolveGeminiTemperature(),
  }),
  writesRawAttempts: false,
  warnsOnRepair: false,
  escalationRethrows: (err) => err instanceof AnalysisAbortedError,
  finalFailureMessage: ({ key, detail }) => `Gemini ${key} failed validation after retry: ${detail}`,
};
```
- [ ] **Step 4: Run and confirm it passes**  Run: `npm --prefix server run test -- src/analyzer/runner/retry-policy.test.ts --retry=0` and `npm run typecheck` and `npm run check:cycles`  Expected: PASS.
- [ ] **Step 5: Mutation proofs**  (1) In `OLLAMA_RETRY_POLICY.buildRetry`'s schema branch return `resolveOllamaRetryTemperature()` → red: "schema-validation replays the output + buildRetryMessage at the first-attempt temperature". (2) Add `|| err instanceof DailyQuotaExhaustedError` to `GEMINI_RETRY_POLICY.escalationRethrows` → red: "escalation rethrows abort only…". Restore both.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/retry-policy.ts server/src/analyzer/runner/retry-policy.test.ts
git commit -m "refactor(server): encode ollama and gemini validation retry policies"
```

### Task 1.11: `StageRunner` + `TransportAnalyzer`; `OllamaAnalyzer` / `GeminiAnalyzer` become subclasses

**Files:**
- Create: `server/src/analyzer/runner/stage-runner.ts`
- Create: `server/src/analyzer/runner/transport-analyzer.ts`
- Modify: `server/src/analyzer/ollama.ts` (class `OllamaAnalyzer`, `:296-928` on 2b63b451, including the Task 1.8 adapter)
- Modify: `server/src/analyzer/gemini.ts` (class `GeminiAnalyzer`, `:266-867` on 2b63b451, including the Task 1.9 adapter)
- Test: `server/src/analyzer/runner/stage-runner.test.ts`

**Interfaces:**
- Consumes: Tasks 1.7–1.10; `writeInbox`, `errorPath`, `rawAttemptPath`, `stage2HandoffKey`, `HandoffKey` (`handoff/protocol.ts`); schemas (`handoff/schemas.ts`); `StageCall`, `Analyzer` (`types.ts`).
- Produces (contract): `StageSpec<T>`, `EngineRequestSettings` (W1 fields `structuredOutput`, `maxOutputTokens` only — see report), `StageRunner` (`constructor({ transport, policy, settings, adaptSchema })`, `runStage(spec, call)`, `runSingleAttempt(spec, call)`), `TransportAnalyzer implements Analyzer` (`constructor(runner)`); plus `type SchemaAdapter` and `identitySchemaAdapter` (W3 replaces with provider adapters). `OllamaAnalyzer` keeps `constructor({ url, model, dispatcher? })`; `GeminiAnalyzer` keeps `constructor({ apiKey, model })`. `runFreeText` is wave 4 and not declared here.

**No existing test reaches into a moved private.** The only callers of the private `chat`, `runStage` and `generateWithLimiter` are in `ollama.ts`/`gemini.ts` themselves (grep of `server/src` for `.chat(` and `generateWithLimiter(` hits only those two files); `select-analyzer.test.ts` asserts `toBeInstanceOf(OllamaAnalyzer | GeminiAnalyzer)`, which subclass instances satisfy; no test reads `url`/`model`/`client`/`dispatcher` off an analyzer instance. Every existing suite therefore stays green unedited.

Suites that could break: `ollama.test.ts`, `ollama-timeout.test.ts`, slow `gemini.test.ts`, `select-analyzer.test.ts`, `fallback.test.ts`, `stage1-chunk.test.ts`, `stage2-chunk.test.ts`, `output-heavy-tpm.test.ts`, `attribution-eval/*.test.ts`, the route suites that construct real analyzers (`routes/analysis*.test.ts`, `script-review.test.ts`, `annotate-emotion.test.ts`, `instruct-annotation.test.ts`, `cast-design.test.ts`) and the slow-lane route files.

- [ ] **Step 1: Write the failing test** — `server/src/analyzer/runner/stage-runner.test.ts`:
```ts
import { describe, it, expect, vi, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { StageRunner, identitySchemaAdapter, type EngineRequestSettings, type SchemaAdapter } from './stage-runner.js';
import { GEMINI_RETRY_POLICY, OLLAMA_RETRY_POLICY, type ValidationRetryPolicy } from './retry-policy.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';
import { AnalysisAbortedError } from '../errors.js';

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'handoff');
const IDS = ['m_sr_first', 'm_sr_json', 'm_sr_retry', 'm_sr_noraw', 'm_sr_raw', 'm_sr_single', 'm_sr_cap'];

class FakeTransport implements ChatTransport {
  readonly kind = 'ollama' as const;
  readonly model = 'fake:1';
  readonly requests: TransportRequest[] = [];
  constructor(private readonly replies: Array<string | Error>) {}
  async send(req: TransportRequest): Promise<TransportResult> {
    this.requests.push(req);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('no scripted reply');
    if (next instanceof Error) throw next;
    return { text: next, reasoningSeen: false, finish: 'stop', receivedBytes: next.length };
  }
}

const schema = z.object({ a: z.string() });
const SCHEMA_MODE: EngineRequestSettings = { structuredOutput: 'schema', maxOutputTokens: undefined };
const JSON_MODE: EngineRequestSettings = { structuredOutput: 'json', maxOutputTokens: undefined };
function makeRunner(
  transport: ChatTransport,
  policy: ValidationRetryPolicy = OLLAMA_RETRY_POLICY,
  settings: EngineRequestSettings = SCHEMA_MODE,
  adaptSchema: SchemaAdapter = identitySchemaAdapter,
) {
  return new StageRunner({ transport, policy, settings: () => settings, adaptSchema });
}
const spec = (manuscriptId: string) => ({
  manuscriptId,
  key: '1-ch1' as const,
  skillName: 'whole_book_stage1' as const,
  promptMd: '# p',
  grammarSchema: schema,
  validationSchema: schema,
});
const outbox = (id: string, suffix: string) => resolve(HANDOFF_ROOT, 'outbox', `${id}-stage1-ch1${suffix}`);

afterAll(async () => {
  for (const id of IDS) {
    for (const key of ['stage1-ch1', 'stageescalation-ch1-w0']) {
      await rm(resolve(HANDOFF_ROOT, 'inbox', `${id}-${key}.md`), { force: true });
      for (const s of ['.json', '.errors.json', '.attempt1.raw.txt', '.attempt2.raw.txt']) {
        await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-${key}${s}`), { force: true });
      }
    }
  }
});

describe('StageRunner (#3084 wave 1)', () => {
  it('first attempt: skill system instruction, one user turn, policy temperature, adapted schema, full call hooks', async () => {
    const t = new FakeTransport(['{"a":"ok"}']);
    const adapt = vi.fn((s: Record<string, unknown>) => ({ schema: { adapted: true, from: s.type }, dropped: [] }));
    const onEvalTiming = vi.fn();
    const onChunk = vi.fn();
    const out = await makeRunner(t, OLLAMA_RETRY_POLICY, SCHEMA_MODE, adapt).runStage(spec('m_sr_first'), { onEvalTiming, onChunk });
    expect(out).toEqual({ a: 'ok' });
    const req = t.requests[0];
    expect(req.system).toMatch(/# SKILL/);
    expect(req.messages).toEqual([{ role: 'user', content: '# p' }]);
    expect(req.temperature).toBe(OLLAMA_RETRY_POLICY.initialTemperature());
    expect(req.structuredOutput).toMatchObject({ mode: 'schema', schema: { adapted: true, from: 'object' } });
    expect(adapt).toHaveBeenCalledTimes(1);
    expect(req.call.onEvalTiming).toBe(onEvalTiming);
    expect(req.call.onChunk).toBe(onChunk);
    expect(existsSync(outbox('m_sr_first', '.json'))).toBe(true);
  });

  it('json mode sends { mode: "json" } and never builds a schema', async () => {
    const t = new FakeTransport(['{"a":"ok"}']);
    const adapt = vi.fn(identitySchemaAdapter);
    await makeRunner(t, GEMINI_RETRY_POLICY, JSON_MODE, adapt).runStage(spec('m_sr_json'), {});
    expect(t.requests[0].structuredOutput).toEqual({ mode: 'json' });
    expect(adapt).not.toHaveBeenCalled();
  });

  it('the retry uses exactly what policy.buildRetry returns, with the same system and structured output', async () => {
    const t = new FakeTransport(['{"a":1}', '{"a":"fixed"}']);
    const buildRetry = vi.fn(() => ({ messages: [{ role: 'user' as const, content: 'RETRY' }], temperature: 0.9 }));
    const policy: ValidationRetryPolicy = { ...GEMINI_RETRY_POLICY, buildRetry };
    const out = await makeRunner(t, policy, JSON_MODE).runStage(spec('m_sr_retry'), {});
    expect(out).toEqual({ a: 'fixed' });
    expect(buildRetry).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: '# p' }], firstRaw: '{"a":1}', failure: expect.objectContaining({ kind: 'schema-validation' }) }),
    );
    expect(t.requests[1].messages).toEqual([{ role: 'user', content: 'RETRY' }]);
    expect(t.requests[1].temperature).toBe(0.9);
    expect(t.requests[1].system).toBe(t.requests[0].system);
    expect(t.requests[1].structuredOutput).toEqual(t.requests[0].structuredOutput);
  });

  it('writesRawAttempts=false writes errors.json only, and throws the policy message', async () => {
    const t = new FakeTransport(['{"a":1}', '{"a":2}']);
    const err = await makeRunner(t, GEMINI_RETRY_POLICY, JSON_MODE).runStage(spec('m_sr_noraw'), {}).then(() => null, (e: Error) => e);
    expect(err?.message.startsWith('Gemini 1-ch1 failed validation after retry: schema-validation — ')).toBe(true);
    expect(existsSync(outbox('m_sr_noraw', '.errors.json'))).toBe(true);
    expect(existsSync(outbox('m_sr_noraw', '.attempt1.raw.txt'))).toBe(false);
    expect(existsSync(outbox('m_sr_noraw', '.attempt2.raw.txt'))).toBe(false);
  });

  it('writesRawAttempts=true writes both raw attempts', async () => {
    const t = new FakeTransport(['{"a":1}', '{"a":2}']);
    await makeRunner(t).runStage(spec('m_sr_raw'), {}).catch(() => undefined);
    expect(existsSync(outbox('m_sr_raw', '.attempt1.raw.txt'))).toBe(true);
    expect(existsSync(outbox('m_sr_raw', '.attempt2.raw.txt'))).toBe(true);
  });

  it('single attempt: empty system, no onEvalTiming, null on failure, policy decides what rethrows', async () => {
    const single = (id: string) => ({ manuscriptId: id, key: 'escalation-ch1-w0' as const, promptMd: 'p', grammarSchema: schema, validationSchema: schema });
    const ok = new FakeTransport(['{"a":"x"}']);
    expect(await makeRunner(ok).runSingleAttempt(single('m_sr_single'), { onEvalTiming: vi.fn() })).toEqual({ a: 'x' });
    expect(ok.requests[0].system).toBe('');
    expect(ok.requests[0].call.onEvalTiming).toBeUndefined();
    expect(await makeRunner(new FakeTransport([new Error('boom')])).runSingleAttempt(single('m_sr_single'), {})).toBeNull();
    expect(await makeRunner(new FakeTransport(['not json'])).runSingleAttempt(single('m_sr_single'), {})).toBeNull();
    await expect(
      makeRunner(new FakeTransport([new AnalysisAbortedError('gone')])).runSingleAttempt(single('m_sr_single'), {}),
    ).rejects.toBeInstanceOf(AnalysisAbortedError);
  });

  it('forwards settings().maxOutputTokens to the transport', async () => {
    const t = new FakeTransport(['{"a":"ok"}']);
    await makeRunner(t, GEMINI_RETRY_POLICY, { structuredOutput: 'json', maxOutputTokens: 1234 }).runStage(spec('m_sr_cap'), {});
    expect(t.requests[0].maxOutputTokens).toBe(1234);
  });
});
```
- [ ] **Step 2: Run and confirm it fails**  Run: `npm --prefix server run test -- src/analyzer/runner/stage-runner.test.ts --retry=0`  Expected: FAIL — `Failed to resolve import "./stage-runner.js"`.
- [ ] **Step 3: Implement**

`server/src/analyzer/runner/stage-runner.ts`:
```ts
/* One stage runner for every analyzer engine (#3084). Generalised from the
   pre-extraction OllamaAnalyzer.runStage / GeminiAnalyzer.runStage; every
   difference between them lives in the ValidationRetryPolicy, and every wire
   difference in the ChatTransport. */
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeInbox, errorPath, rawAttemptPath, type HandoffKey } from '../../handoff/protocol.js';
import type { StageCall } from '../types.js';
import { mapFinish } from './finish.js';
import { parseAndValidate, persistResponse, summariseDetail } from './parse.js';
import { buildSystemInstruction, estimateInputTokens, loadSkill, type SkillName } from './prompt.js';
import type { ValidationRetryPolicy } from './retry-policy.js';
import type { ChatMessage, ChatTransport, StructuredOutputMode, StructuredOutputRequest } from './transport.js';

export interface StageSpec<T> {
  manuscriptId: string;
  key: HandoffKey;
  skillName: SkillName;
  promptMd: string;
  grammarSchema: z.ZodType<unknown>;
  validationSchema: z.ZodType<T>;
}

export interface EngineRequestSettings {
  structuredOutput: StructuredOutputMode; // W1: ollama 'schema', gemini 'json'
  maxOutputTokens: number | undefined; // W1: undefined (transport default)
}

export type SchemaAdapter = (draft07: Record<string, unknown>) => { schema: Record<string, unknown>; dropped: string[] };
export const identitySchemaAdapter: SchemaAdapter = (schema) => ({ schema, dropped: [] });

export class StageRunner {
  readonly transport: ChatTransport;
  private readonly policy: ValidationRetryPolicy;
  private readonly settings: () => EngineRequestSettings;
  private readonly adaptSchema: SchemaAdapter;

  constructor(opts: {
    transport: ChatTransport;
    policy: ValidationRetryPolicy;
    settings: () => EngineRequestSettings;
    adaptSchema: SchemaAdapter;
  }) {
    this.transport = opts.transport;
    this.policy = opts.policy;
    this.settings = opts.settings;
    this.adaptSchema = opts.adaptSchema;
  }

  async runStage<T>(spec: StageSpec<T>, call: StageCall): Promise<T> {
    const { manuscriptId, key, promptMd } = spec;
    const tag = this.transport.kind;
    const model = this.transport.model;
    await writeInbox(manuscriptId, key, promptMd);

    const skill = await loadSkill(spec.skillName);
    const system = buildSystemInstruction(skill, call.language, spec.skillName);
    const structuredOutput = this.structuredOutput(key, spec.grammarSchema);

    const start = Date.now();
    const tick = call.onWaiting ? setInterval(() => call.onWaiting!(Date.now() - start), 500) : null;

    try {
      const firstMessages: ChatMessage[] = [{ role: 'user', content: promptMd }];
      const firstText = await this.send(system, firstMessages, this.policy.initialTemperature(), structuredOutput, call, true);

      const firstAttempt = parseAndValidate(firstText, spec.validationSchema);
      if (firstAttempt.ok) {
        if (firstAttempt.repaired && this.policy.warnsOnRepair) {
          console.warn(`[${tag}] ${model} ${key} required JSON cleanup before parse (markdown fence and/or unescaped quotes)`);
        }
        await persistResponse(manuscriptId, key, firstText);
        return firstAttempt.value;
      }

      /* Forensics: raw bytes (policy-gated) then the structured error. */
      if (this.policy.writesRawAttempts) {
        await writeFile(rawAttemptPath(manuscriptId, key, 1), firstText, 'utf8');
      }
      await writeFile(
        errorPath(manuscriptId, key),
        JSON.stringify({ kind: firstAttempt.kind, detail: firstAttempt.detail, attempt: 1 }, null, 2),
        'utf8',
      );

      const retry = this.policy.buildRetry({ messages: firstMessages, firstRaw: firstText, failure: firstAttempt });
      const secondText = await this.send(system, retry.messages, retry.temperature, structuredOutput, call, true);

      const secondAttempt = parseAndValidate(secondText, spec.validationSchema);
      if (secondAttempt.ok) {
        if (secondAttempt.repaired && this.policy.warnsOnRepair) {
          console.warn(`[${tag}] ${model} ${key} required JSON cleanup on retry (markdown fence and/or unescaped quotes)`);
        }
        await persistResponse(manuscriptId, key, secondText);
        return secondAttempt.value;
      }

      if (this.policy.writesRawAttempts) {
        await writeFile(rawAttemptPath(manuscriptId, key, 2), secondText, 'utf8');
      }
      await writeFile(
        errorPath(manuscriptId, key),
        JSON.stringify(
          {
            kind: secondAttempt.kind,
            detail: secondAttempt.detail,
            attempt: 2,
            firstError: { kind: firstAttempt.kind, detail: firstAttempt.detail },
          },
          null,
          2,
        ),
        'utf8',
      );
      throw new Error(
        this.policy.finalFailureMessage({
          model,
          key,
          detail: `${secondAttempt.kind} — ${summariseDetail(secondAttempt.detail)}`,
        }),
      );
    } finally {
      if (tick) clearInterval(tick);
    }
  }

  /* srv-59 Task 9 — flagged-window attribution escalation. Deliberately NOT
     runStage: an empty/blocked/unparseable reply must resolve to `null` so the
     caller skips the window, and there is no validation retry (Gemini's
     transport-level retries still apply inside send()). The prompt is fully
     self-contained: a single user turn, no system instruction. What rethrows
     is the policy's call (Ollama: abort + unreachable; Gemini: abort only). */
  async runSingleAttempt<T>(
    spec: Omit<StageSpec<T>, 'skillName' | 'grammarSchema'> & { grammarSchema: z.ZodType<unknown> },
    call: StageCall,
  ): Promise<T | null> {
    const tag = this.transport.kind;
    const model = this.transport.model;
    await writeInbox(spec.manuscriptId, spec.key, spec.promptMd);
    const structuredOutput = this.structuredOutput(spec.key, spec.grammarSchema);

    let text: string;
    try {
      text = await this.send('', [{ role: 'user', content: spec.promptMd }], this.policy.initialTemperature(), structuredOutput, call, false);
    } catch (err) {
      if (this.policy.escalationRethrows(err)) throw err;
      console.warn(`[${tag}] ${model} ${spec.key} produced no usable response: ${(err as Error)?.message ?? err}`);
      return null;
    }

    const attempt = parseAndValidate(text, spec.validationSchema);
    if (!attempt.ok) {
      console.warn(`[${tag}] ${model} ${spec.key} failed to parse: ${attempt.kind}`);
      return null;
    }
    await persistResponse(spec.manuscriptId, spec.key, text);
    return attempt.value;
  }

  /* The GRAMMAR schema (may differ from the validation schema — e.g.
     stage1ChapterGrammarSchema makes tone required while stage1ChapterSchema
     keeps it optional) as draft-07 with reused:'inline' so no $ref reaches the
     provider. Only built in 'schema' mode; pre-W1 Gemini never built one. */
  private structuredOutput(key: HandoffKey, grammarSchema: z.ZodType<unknown>): StructuredOutputRequest {
    const mode = this.settings().structuredOutput;
    if (mode !== 'schema') return { mode };
    const draft07 = z.toJSONSchema(grammarSchema, { target: 'draft-07', reused: 'inline' }) as Record<string, unknown>;
    return { mode: 'schema', name: String(key).replace(/[^A-Za-z0-9_-]/g, '_'), schema: this.adaptSchema(draft07).schema };
  }

  private async send(
    system: string,
    messages: ChatMessage[],
    temperature: number,
    structuredOutput: StructuredOutputRequest,
    call: StageCall,
    withEvalTiming: boolean,
  ): Promise<string> {
    const result = await this.transport.send({
      system,
      messages,
      structuredOutput,
      temperature,
      maxOutputTokens: this.settings().maxOutputTokens,
      estimatedInputTokens: estimateInputTokens(
        system,
        messages.map((m) => ({ role: m.role === 'assistant' ? ('model' as const) : ('user' as const), parts: [{ text: m.content }] })),
      ),
      signal: call.signal,
      call: {
        onChunk: call.onChunk,
        onThrottle: call.onThrottle,
        onEvalTiming: withEvalTiming ? call.onEvalTiming : undefined,
      },
    });
    return mapFinish(result, { kind: this.transport.kind, model: this.transport.model });
  }
}
```
The ordering matches both old runners: `writeInbox` → `loadSkill` → system → (schema) → tick → attempt 1 → raw 1 → errors 1 → attempt 2 → raw 2 → errors 2 → throw; escalation: `writeInbox` → (schema) → single call. The `z.toJSONSchema` comment block `ollama.ts:488-503` moves here.

`server/src/analyzer/runner/transport-analyzer.ts`:
```ts
/* Implements the Analyzer interface once, over a StageRunner (#3084). The
   stage table is identical for every engine. */
import { stage2HandoffKey } from '../../handoff/protocol.js';
import {
  stage1Schema,
  stage1ChapterSchema,
  stage2ChapterSchema,
  emotionAnnotationSchema,
  scriptReviewSchema,
  stage3ChapterSchema,
  stage1GrammarSchema,
  stage1ChapterGrammarSchema,
  escalationSchema,
  nonStoryClassificationSchema,
  type Stage1Output,
  type Stage1ChapterOutput,
  type Stage2ChapterOutput,
  type EmotionAnnotationOutput,
  type ScriptReviewOutput,
  type Stage3ChapterOutput,
  type EscalationOutput,
  type NonStoryClassificationOutput,
} from '../../handoff/schemas.js';
import type { Analyzer, StageCall } from '../types.js';
import type { StageRunner } from './stage-runner.js';

export class TransportAnalyzer implements Analyzer {
  constructor(protected readonly runner: StageRunner) {}

  async runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output> {
    return this.runner.runStage(
      { manuscriptId, key: '1', skillName: 'whole_book_stage1', promptMd, grammarSchema: stage1GrammarSchema, validationSchema: stage1Schema },
      call,
    );
  }

  async runStage1Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage1ChapterOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: `1-ch${chapterId}` as const,
        skillName: 'per_chapter_stage1',
        promptMd,
        grammarSchema: stage1ChapterGrammarSchema,
        validationSchema: stage1ChapterSchema,
      },
      call,
    );
  }

  async runStage2Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage2ChapterOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: stage2HandoffKey(chapterId, call.stage2CallSeq),
        skillName: 'per_chapter_stage2',
        promptMd,
        grammarSchema: stage2ChapterSchema,
        validationSchema: stage2ChapterSchema,
      },
      call,
    );
  }

  async runEmotionChapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<EmotionAnnotationOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: `emotion-ch${chapterId}` as const,
        skillName: 'emotion_annotation',
        promptMd,
        grammarSchema: emotionAnnotationSchema,
        validationSchema: emotionAnnotationSchema,
      },
      call,
    );
  }

  async runNonStoryClassification(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<NonStoryClassificationOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: `nonstory-ch${chapterId}` as const,
        skillName: 'non_story_classification',
        promptMd,
        grammarSchema: nonStoryClassificationSchema,
        validationSchema: nonStoryClassificationSchema,
      },
      call,
    );
  }

  async runScriptReviewChapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<ScriptReviewOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: `review-ch${chapterId}` as const,
        skillName: 'script_review',
        promptMd,
        grammarSchema: scriptReviewSchema,
        validationSchema: scriptReviewSchema,
      },
      call,
    );
  }

  async runStage3Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage3ChapterOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: `instruct-ch${chapterId}` as const,
        skillName: 'instruct_annotation',
        promptMd,
        grammarSchema: stage3ChapterSchema,
        validationSchema: stage3ChapterSchema,
      },
      call,
    );
  }

  async runAttributionEscalation(
    manuscriptId: string,
    chapterId: number,
    windowIndex: number,
    prompt: string,
    call: StageCall,
  ): Promise<EscalationOutput | null> {
    return this.runner.runSingleAttempt(
      {
        manuscriptId,
        key: `escalation-ch${chapterId}-w${windowIndex}` as const,
        promptMd: prompt,
        grammarSchema: escalationSchema,
        validationSchema: escalationSchema,
      },
      call,
    );
  }
}
```
Keys and schema pairs are exactly `ollama.ts:307-473` / `gemini.ts:280-439` (the stage table, research 03 §2).

`ollama.ts` — replace the whole `OllamaAnalyzer` class (including the Task 1.8 adapter) with:
```ts
/* W1: structured output is always 'schema' (Ollama `format`, today's default);
   wave 3 resolves it from analyzer.ollama.structuredOutput. */
const OLLAMA_W1_SETTINGS: EngineRequestSettings = { structuredOutput: 'schema', maxOutputTokens: undefined };

export class OllamaAnalyzer extends TransportAnalyzer {
  constructor(opts: OllamaOptions) {
    super(
      new StageRunner({
        transport: new OllamaTransport({ url: opts.url, model: opts.model, dispatcher: opts.dispatcher }),
        policy: OLLAMA_RETRY_POLICY,
        settings: () => OLLAMA_W1_SETTINGS,
        adaptSchema: identitySchemaAdapter,
      }),
    );
  }
}
```
with imports `import { TransportAnalyzer } from './runner/transport-analyzer.js';`, `import { StageRunner, identitySchemaAdapter, type EngineRequestSettings } from './runner/stage-runner.js';`, `import { OLLAMA_RETRY_POLICY } from './runner/retry-policy.js';`.

`gemini.ts` — replace the whole `GeminiAnalyzer` class (including the Task 1.9 adapter) with:
```ts
/* W1: structured output is always 'json' (responseMimeType only, today's
   default); wave 3 resolves it from analyzer.gemini.structuredOutput. */
const GEMINI_W1_SETTINGS: EngineRequestSettings = { structuredOutput: 'json', maxOutputTokens: undefined };

export class GeminiAnalyzer extends TransportAnalyzer {
  constructor(opts: GeminiOptions) {
    super(
      new StageRunner({
        transport: new GeminiTransport({ apiKey: opts.apiKey, model: opts.model }),
        policy: GEMINI_RETRY_POLICY,
        settings: () => GEMINI_W1_SETTINGS,
        adaptSchema: identitySchemaAdapter,
      }),
    );
  }
}
```
with the matching three imports (`GEMINI_RETRY_POLICY`). In both files delete every import `npm run typecheck` reports unused (schemas, protocol helpers, parse/prompt helpers, `mapFinish`, `z`, `writeFile`, …) and keep every `export { … } from` re-export added in Tasks 1.4, 1.5, 1.8, 1.9.
- [ ] **Step 4: Run and confirm it passes**  Run, in order: `npm --prefix server run test -- src/analyzer/runner/stage-runner.test.ts --retry=0`; `npm run test:server:analyzer`; `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`; `npm run test:server:routes`; `npm run test:server-slow`; `npm run typecheck`; `npm run check:cycles`  Expected: all PASS with zero edits to any pre-existing test file in this task (`git diff --stat` for this commit lists only the three new runner files, `ollama.ts`, `gemini.ts`).
- [ ] **Step 5: Mutation proofs**
  1. In `runSingleAttempt`, pass `true` as the last `send` argument → red: "single attempt: empty system, no onEvalTiming…" and `ollama.test.ts` "escalation does not forward onEvalTiming…" (Task 1.1). Restore.
  2. Remove the `if (this.policy.writesRawAttempts)` guard around the attempt-1 raw write → red: "writesRawAttempts=false writes errors.json only…" and slow `gemini.test.ts` "schema-validation retry replays … " (the `attempt1.raw.txt` existence assertion, Task 1.2). Restore.
  3. In `runStage`, pass `this.policy.initialTemperature()` instead of `retry.temperature` to the second `this.send(...)` → red: `ollama.test.ts` "on an invalid-json first attempt, retries WITHOUT replaying the assistant turn and at INVALID_JSON_RETRY_TEMPERATURE" and `stage-runner.test.ts` "the retry uses exactly what policy.buildRetry returns…". Restore.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/stage-runner.ts server/src/analyzer/runner/stage-runner.test.ts server/src/analyzer/runner/transport-analyzer.ts server/src/analyzer/ollama.ts server/src/analyzer/gemini.ts
git commit -m "refactor(server): run ollama and gemini analyzers through one stage runner"
```

### Task 1.12: Strip a leading `<think>` block before parsing (the wave's one behaviour change)

**Files:**
- Modify: `server/src/analyzer/runner/parse.ts` (add `stripThink`; `parseAndValidate`'s first statement, formerly `gemini.ts:1036`)
- Modify: `server/src/analyzer/runner/finish.ts` (add `withThinkEvidence`)
- Modify: `server/src/analyzer/runner/stage-runner.ts` (`send` returns `mapFinish(withThinkEvidence(result), …)`)
- Test: `server/src/analyzer/parse-and-repair.test.ts` (append), `server/src/analyzer/runner/finish.test.ts` (append), `server/src/analyzer/ollama.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 1.5, 1.7, 1.11.
- Produces: `stripThink(raw: string): { text: string; unterminated: boolean }` (contract); `withThinkEvidence(r: TransportResult): TransportResult` (sets `reasoningSeen` for an unterminated leading `<think>`; wave 2's `hasReasoningEvidence` reads it).

Regex precedent: `voice-style.ts:152` (`/^\s*<think>[\s\S]*?<\/think>\s*/i`). `cleanPersona` keeps its own copy (wave 4 owns persona).

- [ ] **Step 1: Write the failing tests**

Append to `server/src/analyzer/parse-and-repair.test.ts` (add `import { stripThink } from './runner/parse.js';` to the imports; the file already imports `z` and `parseAndValidate`):
```ts
describe('stripThink + parseAndValidate — leading <think> block (#3084)', () => {
  const schema = z.object({ a: z.number() });

  it('strips a leading <think>…</think> (case-insensitive, after whitespace) and parses the answer', () => {
    const raw = '  <THINK>\nthe user wants {"a": 2}\n</think>\n{"a":1}';
    expect(stripThink(raw)).toEqual({ text: '{"a":1}', unterminated: false });
    expect(parseAndValidate(raw, schema)).toEqual({ ok: true, value: { a: 1 }, repaired: true });
  });

  it('leaves input with no leading block byte-identical (repaired stays false)', () => {
    expect(stripThink('{"a":1}')).toEqual({ text: '{"a":1}', unterminated: false });
    expect(parseAndValidate('{"a":1}', schema)).toEqual({ ok: true, value: { a: 1 }, repaired: false });
  });

  it('an unterminated leading <think> yields no answer text and reports it', () => {
    expect(stripThink('<think>still reasoning {"a":1}')).toEqual({ text: '', unterminated: true });
    expect(parseAndValidate('<think>still reasoning {"a":1}', schema)).toMatchObject({ ok: false, kind: 'invalid-json' });
  });

  it('does not strip a <think> block that is not leading', () => {
    expect(stripThink('{"a":1}<think>x</think>')).toEqual({ text: '{"a":1}<think>x</think>', unterminated: false });
  });
});
```
Append to `server/src/analyzer/runner/finish.test.ts` (add `withThinkEvidence` to the `./finish.js` import):
```ts
describe('withThinkEvidence (#3084)', () => {
  it('marks reasoningSeen for an unterminated leading <think>', () => {
    expect(withThinkEvidence(res({ text: '<think>hmm', finish: 'length', receivedBytes: 10 })).reasoningSeen).toBe(true);
  });
  it('returns the same object for a terminated block or plain text', () => {
    const terminated = res({ text: '<think>x</think>{}' });
    const plain = res({ text: '{}' });
    expect(withThinkEvidence(terminated)).toBe(terminated);
    expect(withThinkEvidence(plain)).toBe(plain);
  });
});
```
Append to `server/src/analyzer/ollama.test.ts` (before the final `afterAll`):
```ts
describe('OllamaAnalyzer — a leading <think> block no longer costs a retry (#3084)', () => {
  afterEach(async () => {
    await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_ollama_think-stage1-ch1.md'), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_ollama_think-stage1-ch1.json'), { force: true });
  });

  it('validates on the first attempt when the model prefixes its JSON with <think>…</think>', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse(ndjsonStream(chunksOf(`<think>\nWho speaks in this chapter?\n</think>\n${VALID_RESPONSE}`, 32))),
    );
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    const result = await analyzer.runStage1Chapter('m_ollama_think', 1, '# prompt', {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.characters.map((c) => c.id)).toEqual(['narrator', 'wren']);
  });
});
```
- [ ] **Step 2: Run and confirm they fail**  Run: `npm --prefix server run test -- src/analyzer/parse-and-repair.test.ts src/analyzer/runner/finish.test.ts src/analyzer/ollama.test.ts --retry=0`  Expected: FAIL — `stripThink`/`withThinkEvidence` not exported; the Ollama case fails because the first attempt is `invalid-json` (the pre-change `trimTrailingProse` slices from index 0, `runner/parse.ts`, formerly `gemini.ts:1220-1255`) and the retry's second `fetchMock` call returns `undefined`.
- [ ] **Step 3: Implement**

`runner/parse.ts` — add below the imports:
```ts
const LEADING_THINK = /^\s*<think>[\s\S]*?<\/think>\s*/i;
const LEADING_THINK_OPEN = /^\s*<think>/i;

/** Remove a leading `<think>…</think>` reasoning block (thinking models that
    ignore think:false / reasoning_effort). A leading block with no closing tag
    means the answer never started: no answer text, `unterminated: true`.
    Input with no leading block is returned unchanged (same string). */
export function stripThink(raw: string): { text: string; unterminated: boolean } {
  const closed = LEADING_THINK.exec(raw);
  if (closed) return { text: raw.slice(closed[0].length), unterminated: false };
  if (LEADING_THINK_OPEN.test(raw)) return { text: '', unterminated: true };
  return { text: raw, unterminated: false };
}
```
In `parseAndValidate`, replace `const stripped = stripCodeFences(raw);` with
```ts
  const stripped = stripCodeFences(stripThink(raw).text);
```
and in its doc comment's candidate list change `0. \`stripped\` — fence strip only.` to `0. \`stripped\` — leading <think> block removed (stripThink), then fence strip.` (`repaired = winner !== raw` is untouched, so a stripped block reports `repaired: true`, which also triggers Ollama's existing "required JSON cleanup" warning.)

`runner/finish.ts` — add `import { stripThink } from './parse.js';` and:
```ts
/** An unterminated leading <think> is reasoning evidence even when the
    transport saw no reasoning deltas (wave 2's reasoning-overflow rule reads
    reasoningSeen). Returns the same object when nothing changes. */
export function withThinkEvidence(r: TransportResult): TransportResult {
  if (r.reasoningSeen || !stripThink(r.text).unterminated) return r;
  return { ...r, reasoningSeen: true };
}
```
`runner/stage-runner.ts` — in `send`, import `withThinkEvidence` alongside `mapFinish` and change the last line to `return mapFinish(withThinkEvidence(result), { kind: this.transport.kind, model: this.transport.model });`. (`persistResponse` still writes the raw text, block included, as today.)
- [ ] **Step 4: Run and confirm they pass**  Run: the Step 2 command; `npm run test:server:analyzer`; `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`; `npm run typecheck`; `npm run check:cycles`  Expected: all PASS.
- [ ] **Step 5: Mutation proofs**  (1) Revert `parseAndValidate`'s first statement to `stripCodeFences(raw)` → red: "strips a leading <think>…</think>…" and "validates on the first attempt when the model prefixes its JSON with <think>…</think>". (2) Delete the `if (LEADING_THINK_OPEN.test(raw))` line → red: "an unterminated leading <think> yields no answer text and reports it" and "marks reasoningSeen for an unterminated leading <think>". Restore both.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/parse.ts server/src/analyzer/runner/finish.ts server/src/analyzer/runner/stage-runner.ts server/src/analyzer/parse-and-repair.test.ts server/src/analyzer/runner/finish.test.ts server/src/analyzer/ollama.test.ts
git commit -m "fix(server): strip a leading think block before parsing analyzer JSON"
```

### Task 1.13: References the moves made false (and two found in passing)

**Files:**
- Modify: `CLAUDE.md:872`
- Modify: `docs/local-llm.md:23,44,73,89,287-288,333,394`
- Modify: `server/.env.example:9-11` (hand-written header note, above the generated block that starts at `:497`)
- Modify: `server/src/routes/ollama-health.test.ts:508-509,564` (comments only)
- Modify: `server/src/tts/retry.ts:102` (comment)
- Modify: `server/src/analyzer/errors.ts:3-15,40` (comments)
- Modify: `server/src/analyzer/ollama.ts` persona comments (formerly `:930-931`, `:966-968`, `:999`)
- Modify: `server/src/analyzer/ollama.test.ts:9-15,1394` (comments only)
- Modify: `server/src/analyzer/gemini.ts:1-6` (header comment)

**Interfaces:** none (prose only; no runtime line).

Each edit below replaces a reference this PR made false (a symbol now in a different file, or a deleted method named). Two are pre-existing defects surfaced while checking these files and are declared in the PR body as found in passing: `docs/local-llm.md:89` states `ANALYZER_NUM_CTX = 16384` (it is 32768, `ollama.ts:252`), and `server/.env.example:11` cites `RESIDENT_MODELS` (removed; keep-alive is per model, `ollama.ts:177-187`).

- [ ] **Step 1: Find every stale reference first (the check this task must turn clean)**  Run: `git grep -nE "ollama\.ts:[0-9]+|gemini\.ts:[0-9]+|generateWithLimiter|OllamaAnalyzer\.chat|chat\(\)|RESIDENT_MODELS|ANALYZER_NUM_CTX = 16384|keepAliveFor\(\)\*\* at|runStage\` in" -- CLAUDE.md docs/local-llm.md server/.env.example server/src`  Expected before this task: hits at every file listed above. (Historical records — `docs/features/**`, `docs/superpowers/**`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`, `docs/BACKLOG.md` — are out of scope and are not edited.)
- [ ] **Step 2: Edit** (exact replacements)
  - `CLAUDE.md:872`: `` see `server/src/analyzer/ollama.ts:179` (`keepAliveFor`) for the equivalent in-band `` → `` see `server/src/analyzer/ollama-settings.ts` (`keepAliveFor`) for the equivalent in-band ``
  - `docs/local-llm.md:23`: `` The dispatch lives in `server/src/analyzer/ollama.ts:117` (`OllamaAnalyzer`). `` → `` The dispatch lives in `server/src/analyzer/ollama.ts` (`OllamaAnalyzer`, a `TransportAnalyzer` over `server/src/analyzer/transports/ollama-transport.ts`). ``
  - `docs/local-llm.md:44`: `` classifier is `classifyConnectError` at `server/src/analyzer/ollama.ts:441` `` → `` classifier is `classifyConnectError` in `server/src/analyzer/transports/ollama-transport.ts` `` (`:45` "documented at the top of the same file" stays true — that header moved with it in Task 1.8).
  - `docs/local-llm.md:73`: `` 1. **`keepAliveFor()`** at `server/src/analyzer/ollama.ts`. Each model's `` → `` 1. **`keepAliveFor()`** in `server/src/analyzer/ollama-settings.ts`. Each model's ``
  - `docs/local-llm.md:89` (found in passing): `` analyzer uses on real calls (`ANALYZER_NUM_CTX = 16384`), because Ollama keys `` → `` analyzer uses on real calls (`resolveAnalyzerNumCtx()`, knob `analyzer.ollama.numCtx`, default 32768), because Ollama keys ``
  - `docs/local-llm.md:287-288`: `` `server/src/analyzer/ollama.ts` (the constant lives next to `` → `` `server/src/analyzer/ollama-settings.ts` (the constant lives next to ``
  - `docs/local-llm.md:333`: `` `server/src/analyzer/ollama.ts`) and Ollama's sampler is constrained `` → `` `server/src/analyzer/runner/stage-runner.ts`) and Ollama's sampler is constrained `` and on `:332` `` (`runStage` in `` → `` (`StageRunner` in ``
  - `docs/local-llm.md:394`: `` 8K — see `ANALYZER_NUM_CTX` at `server/src/analyzer/ollama.ts:115`) or `` → `` 8K — see `ANALYZER_NUM_CTX` in `server/src/analyzer/ollama-settings.ts`) or ``
  - `server/.env.example:9-11` (found in passing): `#                     (qwen3.5:9b, llama3.1:8b) work too but unload after` / `#                     each call by design (see RESIDENT_MODELS in` / `#                     server/src/analyzer/ollama.ts).` → `#                     (qwen3.5:9b, llama3.1:8b) work too; keep-alive is` / `#                     resolved per model (see keepAliveFor in` / `#                     server/src/analyzer/ollama-settings.ts).`
  - `server/src/routes/ollama-health.test.ts:508-509`: `analyzer's runStage path passes (ANALYZER_NUM_CTX, ANALYZER_NUM_GPU` / `in server/src/analyzer/ollama.ts). Either drifting triggers a` → `analyzer's stage runner passes (ANALYZER_NUM_CTX, ANALYZER_NUM_GPU` / `in server/src/analyzer/ollama-settings.ts). Either drifting triggers a`
  - `server/src/routes/ollama-health.test.ts:564`: `VRAM now" — see analyzer/ollama.ts:92 for the equivalent on real chat` → `VRAM now" — see keepAliveFor in analyzer/ollama-settings.ts for the equivalent on real chat`
  - `server/src/tts/retry.ts:102`: `` `signal` fires. Modeled after analyzer/gemini.ts's `sleep`. */ `` → `` `signal` fires. Modeled after analyzer/runner/transport-retry.ts's `sleep`. */ ``
  - `server/src/analyzer/errors.ts:3`: `` `AnalyzerTruncatedError` is thrown by an engine (Gemini / Ollama) when the `` → `` `AnalyzerTruncatedError` is raised by the stage runner (runner/finish.ts) when the ``; `:11-12`: `- the per-engine retry loop re-throws it immediately (replaying the same` / `oversized prompt just truncates again — retrying in place is futile),` → `- transports report it as finish:'length' and it is raised without a retry` / `(replaying the same oversized prompt just truncates again),`; `:40`: `/* Thrown by GeminiAnalyzer when the stream finishes with ZERO text — the` → `/* Raised by runner/finish.ts when the Gemini transport reports a stream that finished with ZERO text — the`
  - `server/src/analyzer/ollama.ts` persona comments: `OllamaAnalyzer.chat() this sends NO response` → `OllamaTransport.send() this sends NO response`; `unlike chat() (whose StageCall carries the analysis signal)` → `unlike OllamaTransport.send() (whose request carries the analysis signal)`; `Same ANALYZER_DISPATCHER as chat(), and this call needs it MORE:` → `Same ANALYZER_DISPATCHER as OllamaTransport.send(), and this call needs it MORE:`
  - `server/src/analyzer/ollama.test.ts:11`: `` fetch rather than the global one because chat() must pass an undici `` → `` fetch rather than the global one because OllamaTransport.send() must pass an undici ``; `:1394`: `/* generatePersonaViaOllama shares chat()'s transport: it is the second` → `/* generatePersonaViaOllama shares OllamaTransport's wire path: it is the second`
  - `server/src/analyzer/gemini.ts:1-6` header → `/* GeminiAnalyzer — a TransportAnalyzer over transports/gemini-transport.ts (free-tier Google API via @google/genai). Prompt building, inbox/outbox traceability, validation with the shared Zod schemas and the single validation retry live in runner/stage-runner.ts; this engine's retry shape is GEMINI_RETRY_POLICY (runner/retry-policy.ts). */`
- [ ] **Step 3: Re-run the Step 1 grep**  Expected: no hits in the listed files.
- [ ] **Step 4: Verify nothing executable moved**  Run: `npm --prefix server run test -- src/routes/ollama-health.test.ts --retry=0`; `npm run config:check`; `npm run typecheck`  Expected: PASS.
- [ ] **Step 5: Mutation proof** — not applicable (prose only; no guard).
- [ ] **Step 6: Commit**
```bash
git add CLAUDE.md docs/local-llm.md server/.env.example server/src/routes/ollama-health.test.ts server/src/tts/retry.ts server/src/analyzer/errors.ts server/src/analyzer/ollama.ts server/src/analyzer/ollama.test.ts server/src/analyzer/gemini.ts
git commit -m "docs(server): update analyzer references moved by the stage-runner extraction"
```

### Task 1.14: Ship PR 1b

**Files:**
- Modify: `docs/release-notes-next.md` (section `## 🗣️ Analyzer, script review & manuscript`, `:284`)
- Modify: `RELEASE_NOTES.md` (top of the `# Castwright 1.15.0` bullet list, `:3`)
- Modify: `docs/testing/onbox-acceptance-register.md` (Group B: `## At a glance` row `:557`, the `**N owed.**` line `:566`, the Group B `<!-- next-id: … -->` marker `:4509`, new row after `B1` ending `:4551`, the `> **Last change: …**` line `:570`)
- Modify: `docs/testing/onbox-acceptance-register-live-view.html` (new `<details class="item">` after `B1`'s, which ends near `:751`)

- [ ] **Step 1: Derived artifacts** — no `openapi.yaml` change (no `npm run openapi:types`); no registry knob (no `npm run config:sync`; `npm run config:check` already ran in Task 1.13).
- [ ] **Step 2: Open the PR as a draft to get its number** — push the branch, `gh pr create --draft --base main --title "refactor(server): run analyzer engines through one stage runner over per-engine transports"`, then `gh pr view --json number -q .number`. Use that number as `<PR>` below.
- [ ] **Step 3: Release notes (both files)**
  - `docs/release-notes-next.md`, append as the last bullet of `## 🗣️ Analyzer, script review & manuscript`:
    `- **Analyzer responses that open with a reasoning block now parse, and both analyzer engines run through one stage runner.** A model that prefixes its JSON with a \`<think>…</think>\` block (a thinking model ignoring \`think:false\`) used to fail JSON parsing, spend its single validation retry and often fail the chapter; \`parseAndValidate\` now drops a leading block first, and an unterminated one is recorded as reasoning evidence for the upcoming reasoning-overflow rule. Internally, Ollama and Gemini now share one \`StageRunner\` over per-engine transports (\`OllamaTransport\`, \`GeminiTransport\`) with each engine's retry policy, forensics, limiter behaviour and failure-taxonomy outcomes pinned unchanged by characterisation tests; non-OK Ollama responses are now a typed \`AnalyzerHttpError\` with the same message and classification (#<PR>, refs #3084).`
  - `RELEASE_NOTES.md`, insert as the first bullet under `# Castwright 1.15.0`:
    `- **A model that "thinks out loud" before answering no longer trips up analysis.** Some models open their reply with a private reasoning note before the actual answer. Castwright used to stumble over that note, try the chapter again, and often give up on it. It now sets the note aside and reads the answer that follows.`
- [ ] **Step 4: On-box acceptance row (Group B).** The runner now sits on every real analysis call; the mocked suites cannot prove real-daemon telemetry (the `done` line's eval timing, VRAM sampling, GPU-split detection) or a real Gemini stream. The row's id is the next id from that group's `next-id` marker, minted at ship time (`npm run check:onbox-register`); allocate-once — never reuse — and bump the marker by one in the same commit. Below, `B<next>` (`B&lt;next&gt;` inside HTML) stands for that minted id; write the minted id in its place everywhere.
  - Markdown row, inserted after `B1` (before the `---` at `:4553`):
    ```md
    ### B<next> · Stage-runner extraction behaves identically on a real Ollama daemon and a real Gemini key ([#3084](https://github.com/dudarenok-maker/Castwright/issues/3084), PR [#<PR>](https://github.com/dudarenok-maker/Castwright/pull/<PR>)) · **local Ollama; the Gemini half needs the `GEMINI_API_KEY` from the primary checkout**

    Analyse chapter 1 of *The Coalfall Commission* (`server/src/__fixtures__/the-coalfall-commission.md`) from the primary checkout on `main` after this PR, once with `qwen3.5:4b` (local) and once with a `gemma-*` model (Gemini), and compare against the same run on the merge's first parent:
    - both runs finish with the same character count and the same number of attributed sentences;
    - local: the analysing view's per-pass eval stats (tokens/s) populate — proves `onEvalTiming` still fires off a real `done` line — and `server/handoff/outbox/<id>-stage1-ch1.json` is written;
    - Gemini: no `[gemini] generate failed` line in `logs/server.log`; a throttle chip appears only when the limiter actually waits;
    - if a local thinking tag that emits a leading `<think>` block is installed, its chapter validates on the first attempt (no `attempt1.raw.txt` for that key).
    ```
  - Markdown bookkeeping: `## At a glance` Group B row `| **B** | … | 1 |` → `2` (increment whatever it reads); `**48 owed.**` → increment by one; the Group B `<!-- next-id: B<next> -->` marker → the id after `B<next>`; add one line above the existing `> **Last change: …**` paragraph: `> **Last change: <YYYY-MM-DD> (#3084 wave 1b), <old> → <new>.** Row **B<next>** added (stage-runner extraction smoke).`
  - Live view, insert after `B1`'s `</details>` inside the Group B section:
    ```html
        <details class="item">
          <summary><span class="num">B&lt;next&gt;</span><span class="iname">Stage-runner extraction behaves identically on a real Ollama daemon and a real Gemini key</span><span class="risk low">4 checks</span><span class="chev">›</span></summary>
          <div class="body">
            <ul>
              <li>Chapter 1 of <i>The Coalfall Commission</i> on <code>qwen3.5:4b</code> and on a <code>gemma-*</code> model finishes with the same character and attributed-sentence counts as before the PR.</li>
              <li>Local: per-pass eval stats (tokens/s) populate and the stage outbox file is written.</li>
              <li>Gemini: no <code>[gemini] generate failed</code> log line; the throttle chip appears only on a real limiter wait.</li>
              <li>A local thinking tag with a leading <code>&lt;think&gt;</code> block validates on the first attempt.</li>
            </ul>
            <p class="src"><code>#3084 wave 1 · PR #&lt;PR&gt;</code></p>
          </div>
        </details>
    ```
  - Generate and check: `npm run register:build`; `npm run check:onbox-register`; `npm run stamp:publish-token`; commit (`docs(testing): add on-box row for the analyzer stage-runner extraction`).
  - Publish (immediately before, per the register's "Live view" four-step procedure): `git fetch origin && git merge origin/main`; read the live artifact at `https://claude.ai/code/artifact/adf22b7b-12dd-49fe-874c-4a340585b26a` (Artifact tool, `action: "read"`) and save it to a scratch file; `npm run check:onbox-register -- --against-published <saved-file>` must pass; then publish `docs/testing/onbox-acceptance-register-live-view.html` with `url` set to that exact URL (never without it, never the `.md`).
- [ ] **Step 5: Verify** — `npm run verify:fast:branch`; `npm run test:server-slow`; `npm run check:cycles`. Expected: all green. Confirm `git grep -n "analyzer/" server/madge-cycles-allowlist.json` prints nothing.
- [ ] **Step 6: PR body and review gate** — fill the draft PR: `## Summary` (Tasks 1.7–1.13; "Behaviour change: a leading `<think>` block is stripped before parsing — the only one"; the decision list from this plan's report: `finishReason` on `TransportResult`, `initialTemperature`/`warnsOnRepair` on the policy, `logTag`/`displayName` on `withTransportRetry`, the leaf `ollama-settings.ts`/`types.ts`), `## Test plan` (Step 5 commands and every mutation-proof red output from Tasks 1.7–1.12), `Refs #3084`, "Also fixed, found in passing: `docs/local-llm.md:89` stated `ANALYZER_NUM_CTX = 16384` (it is 32768); `server/.env.example:11` cited the removed `RESIDENT_MODELS`", attribution lines. `gh pr ready`, then run the `pr-review-gate` skill at depth **high** (the PR contains `refactor` commits). Fold findings, re-run Step 5, merge with a merge commit.
