# OpenAI-compatible analyzer — Wave 5 plan

> Part of the [OpenAI-compatible analyzer implementation plan](2026-09-11-openai-compatible-analyzer.md). Read that file first: its Global Constraints, planning decisions (P1–P11) and interface contract bind every task below. Spec: [2026-09-10-openai-compatible-analyzer-design.md](../specs/2026-09-10-openai-compatible-analyzer-design.md).

## Wave 5 — Reasoning controls (D8, §8) and custom payload (D9, §9)

**Preconditions for the whole wave.** Waves 1–4 are merged. Before editing, re-read every `file:line` below against `main`; the wave 1–4 files (`runner/*`, `transports/*`, `capabilities.ts`, `analyzer-endpoints.ts`, `routes/analyzer-models.ts`, `routes/analyzer-endpoints.ts`, W3d's endpoint form) are cited by the **contract name**, because they do not exist at `2b63b451`. Where this wave edits a wave 1–4 function whose body the contract does not pin, the step names the symbol to find (`git grep -n '<symbol>'`) and gives the full replacement text.

**Conventions used by every task below.**
- Commands run from the worktree root. Server single file: `npm --prefix server run test -- <path relative to server/>`. Frontend single file: `npm test -- <path>`. None of this wave's test files are in `server/vitest.config.slow.ts` `SLOW_FILES`; do not add assertions to `server/src/analyzer/gemini.test.ts` (slow lane).
- Every transport test uses a real `http.createServer` on `127.0.0.1:0` and the real undici `Agent` (pattern: `server/src/analyzer/ollama-timeout.test.ts:60-109`, including `process.env.CASTWRIGHT_VRAM_SAMPLE = '0'` in `beforeAll` and `closeAllConnections()` in `afterEach`).
- `openapi.yaml` enum values `off` / `on` are **always quoted** (`'off'`, `'on'`): an unquoted `off` is a YAML 1.1 boolean, and a boolean in a string enum breaks `openapi-typescript`.
- "Keeps green" lists name existing suites the task can break; run each one in Step 4.

---

### PR 5a — Reasoning levels, control styles, and their Test coverage

- **Branch:** `feat/server,frontend-3084-w5a-reasoning` — `node scripts/wt-new.mjs feat/server,frontend-3084-w5a-reasoning`.
- **Delivers:** `server/src/analyzer/reasoning.ts` (levels per engine family and endpoint control style, Gemini per-model table, wire fragments, control descriptions); `analyzerReasoningByEngine` user setting and endpoint `reasoning` validation; every transport sends the resolved level; the Test action probes reasoning levels, keys schema probes by level, and the pre-run check refuses a `rejected` level; catalog entries carry `offeredReasoningLevels`; the reasoning-overflow message names the actual control; Advanced Settings and the endpoint form offer only offered levels.
- **Must NOT change:** today's wire defaults — Ollama still sends `think: false` for an untouched install; Gemini and endpoints send no reasoning field for an untouched install. No new `FailureCode`. No custom-payload code (PR 5b). No structured-output default change.
- **Entry:** waves 1–4 merged; `git grep -n -E "ReasoningLevel|extraParams" server/src/analyzer/runner` prints nothing (wave 1 declared neither; Task 5.1 adds them); W3c's `runModelTest`, `plannedTestRequestCount`, `assertConfiguredCapabilitiesAllowed` and the catalog route exist.
- **Exit:** all tasks' tests green; `npm run typecheck`, `npm run check:cycles`, `npm run verify:fast:branch` green; `pr-review-gate` pass at **high** depth (multi-scope `feat`); on-box rows added.

### Task 5.1: `reasoning.ts` — levels, Gemini table, wire fragments, control descriptions; request-control fields and runner forwarding

**Files:**
- Create: `server/src/analyzer/reasoning.ts`
- Create: `server/src/analyzer/__fixtures__/reasoning-style-levels.json`
- Modify: `server/src/analyzer/runner/transport.ts` — `TransportRequest` gains `reasoning?` and `extraParams?`
- Modify: `server/src/analyzer/runner/stage-runner.ts` — `EngineRequestSettings` gains `reasoning?` and `extraParams?`; the private `send` helper (W1 Task 1.11) and `runFreeText` (W4 Task 4.1) forward both
- Test: `server/src/analyzer/reasoning.test.ts`, `server/src/analyzer/runner/stage-runner.request-controls.test.ts`

**Interfaces:**
- Consumes: `AnalysisEngine` (`server/src/analyzer/model-id.ts`, W3); `TransportKind` (`server/src/analyzer/errors.ts`, W1); `REASONING_STYLES` (`server/src/workspace/analyzer-endpoints.ts`, W3 — test-only import, see cycle note); `TransportRequest` (W1 Task 1.7, plus W4's `freeText` / optional `temperature`); `EngineRequestSettings`, `StageRunner` and its private `send(system, messages, temperature, structuredOutput, call, withEvalTiming)` helper (W1 Task 1.11); `StageRunner.runFreeText` (W4 Task 4.1).
- Produces (contract names, plus the additions marked **new**):
  - `ReasoningLevel`, declared here for the first time (wave 1 did not declare it), plus `offeredReasoningLevels`, `reasoningWireFragment`, `GEMINI_REASONING_TABLE` (contract);
  - the contract fields `TransportRequest.reasoning?: ReasoningLevel`, `TransportRequest.extraParams?: Record<string, unknown>`, `EngineRequestSettings.reasoning?: ReasoningLevel` and `EngineRequestSettings.extraParams?: Record<string, unknown>`. Wave 1 added none of them, and wave 4 forwards neither. Here they are optional, so every wave 1–4 settings closure and request literal compiles unchanged; an omitted value is the pre-W5 wire. No wave 1–4 code sets either field: W3b's `OpenAIAnalyzer` settings closure (`server/src/analyzer/openai.ts`) and its OpenAI transport contract-suite `request()` helper set neither, and its `OpenAITransport` params object sends neither. Task 5.3 adds `reasoning` to all three `settings` closures and to the OpenAI params. Task 5.10 adds `extraParams` the same way. The contract-suite helper needs no edit, because both fields are optional;
  - runner forwarding of both fields on every transport request: `runStage` (both attempts), `runSingleAttempt` and `runFreeText`;
  - **new** `REASONING_LEVELS`, `ReasoningStyle`, `levelsForReasoningStyle(style)`, `OLLAMA_NAMED_LEVELS`, `testableReasoningLevels(sel)`, `defaultReasoningLevel(engine)`, `geminiReasoningRow(model)`, `GEMINI_THINKING_BUDGETS`, `resolveReasoningSetting(settings, sel)`, `reasoningControlDescription(kind, sel)`.

**Cycle note (why the types are structural).** `workspace/user-settings.ts` (Task 5.2) and `workspace/analyzer-request-controls.ts` import values from this file, and CLAUDE.md records that even `import type` closes a madge cycle. So `reasoning.ts` imports **no** workspace or capabilities module: the endpoint, record and settings parameters are structural types that `AnalyzerEndpoint`, `ModelCapabilityRecord` and `UserSettings` satisfy. The contract's `endpoint?: AnalyzerEndpoint` / `record?: ModelCapabilityRecord` call sites type-check unchanged. `runner/transport.ts` and `runner/stage-runner.ts` add an `import type { ReasoningLevel } from '../reasoning.js'` edge; `reasoning.ts` imports nothing from `runner/`, so no cycle closes.

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/__fixtures__/reasoning-style-levels.json`:
```json
{
  "reasoning_effort": ["model-default", "none", "minimal", "low", "medium", "high"],
  "enable_thinking": ["model-default", "off", "on"],
  "not_controllable": ["model-default"]
}
```

`server/src/analyzer/reasoning.test.ts`:
```ts
import { describe, it, expect, expectTypeOf } from 'vitest';
import styleLevels from './__fixtures__/reasoning-style-levels.json' with { type: 'json' };
import { REASONING_STYLES } from '../workspace/analyzer-endpoints.js';
import {
  GEMINI_REASONING_TABLE,
  GEMINI_THINKING_BUDGETS,
  REASONING_LEVELS,
  defaultReasoningLevel,
  geminiReasoningRow,
  levelsForReasoningStyle,
  offeredReasoningLevels,
  reasoningControlDescription,
  reasoningWireFragment,
  resolveReasoningSetting,
  testableReasoningLevels,
  type ReasoningLevel,
  type ReasoningStyle,
} from './reasoning.js';

const endpoint = (reasoningStyle: ReasoningStyle) => ({ id: 'lab', name: 'Lab box', reasoningStyle });

describe('endpoint control styles', () => {
  it('ReasoningStyle is exactly the endpoint schema enum', () => {
    expectTypeOf<ReasoningStyle>().toEqualTypeOf<(typeof REASONING_STYLES)[number]>();
    expect([...REASONING_STYLES].sort()).toEqual(Object.keys(styleLevels).sort());
  });

  it.each(Object.entries(styleLevels))('%s offers exactly the shared table', (style, levels) => {
    expect([...levelsForReasoningStyle(style as ReasoningStyle)]).toEqual(levels);
    expect(
      offeredReasoningLevels({ engine: 'openai', model: 'm', endpoint: endpoint(style as ReasoningStyle) }),
    ).toEqual(levels);
  });

  it('an endpoint selection with no endpoint offers model-default only', () => {
    expect(offeredReasoningLevels({ engine: 'openai', model: 'm' })).toEqual(['model-default']);
  });
});

describe('GEMINI_REASONING_TABLE (02-gemini-facts §2)', () => {
  const THREE_X_FULL: ReasoningLevel[] = ['model-default', 'minimal', 'low', 'medium', 'high'];
  const NO_MINIMAL: ReasoningLevel[] = ['model-default', 'low', 'medium', 'high'];
  const BUDGET_WITH_OFF: ReasoningLevel[] = ['model-default', 'off', 'low', 'medium', 'high'];
  it.each<[string, string | undefined, ReasoningLevel[]]>([
    ['gemini-3.6-flash', 'thinkingLevel', THREE_X_FULL],
    ['gemini-3.5-flash', 'thinkingLevel', THREE_X_FULL],
    ['gemini-3-flash-preview', 'thinkingLevel', THREE_X_FULL],
    ['gemini-3.5-flash-lite', 'thinkingLevel', THREE_X_FULL],
    ['gemini-3.1-flash-lite', 'thinkingLevel', THREE_X_FULL],
    ['gemini-3.8-flash', 'thinkingLevel', NO_MINIMAL],
    ['gemini-3.7-flash', 'thinkingLevel', NO_MINIMAL],
    ['gemini-3.1-pro-preview', 'thinkingLevel', NO_MINIMAL],
    ['gemini-2.5-flash', 'thinkingBudget', BUDGET_WITH_OFF],
    ['gemini-2.5-flash-lite', 'thinkingBudget', BUDGET_WITH_OFF],
    ['gemini-2.5-pro', 'thinkingBudget', NO_MINIMAL],
    ['gemma-4-31b-it', 'gemmaOnOff', ['model-default', 'off', 'on']],
    ['gemma-4-26b-a4b-it', 'gemmaOnOff', ['model-default', 'off', 'on']],
    ['models/gemini-3.6-flash', 'thinkingLevel', THREE_X_FULL],
    ['gemini-3.6-flash-lite', undefined, ['model-default']],
    ['gemini-9-ultra', undefined, ['model-default']],
  ])('%s → %s', (model, control, levels) => {
    expect(geminiReasoningRow(model)?.control).toBe(control);
    expect(offeredReasoningLevels({ engine: 'gemini', model })).toEqual(levels);
  });

  it('never sends both thinkingLevel and thinkingBudget for any row and level', () => {
    const ids = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemma-4-31b-it'];
    expect(ids.map((id) => geminiReasoningRow(id)).every(Boolean)).toBe(true);
    for (const model of ids) {
      for (const level of offeredReasoningLevels({ engine: 'gemini', model })) {
        const cfg = (reasoningWireFragment('gemini', { model }, level).thinkingConfig ?? {}) as Record<string, unknown>;
        expect('thinkingLevel' in cfg && 'thinkingBudget' in cfg).toBe(false);
      }
    }
    expect(GEMINI_REASONING_TABLE.length).toBe(8);
  });

  it('maps levels to the documented wire values', () => {
    expect(reasoningWireFragment('gemini', { model: 'gemini-3.6-flash' }, 'minimal')).toEqual({ thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    expect(reasoningWireFragment('gemini', { model: 'gemini-3.6-flash' }, 'high')).toEqual({ thinkingConfig: { thinkingLevel: 'HIGH' } });
    expect(reasoningWireFragment('gemini', { model: 'gemini-2.5-flash' }, 'off')).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    expect(reasoningWireFragment('gemini', { model: 'gemini-2.5-flash-lite' }, 'low')).toEqual({ thinkingConfig: { thinkingBudget: 1024 } });
    expect(reasoningWireFragment('gemini', { model: 'gemini-2.5-pro' }, 'high')).toEqual({ thinkingConfig: { thinkingBudget: 24576 } });
    expect(GEMINI_THINKING_BUDGETS).toEqual({ off: 0, low: 1024, medium: 8192, high: 24576 });
    expect(reasoningWireFragment('gemini', { model: 'gemma-4-31b-it' }, 'on')).toEqual({ thinkingConfig: { thinkingLevel: 'HIGH' } });
    expect(reasoningWireFragment('gemini', { model: 'gemma-4-31b-it' }, 'off')).toEqual({ thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    expect(reasoningWireFragment('gemini', { model: 'gemini-3.6-flash' }, 'model-default')).toEqual({});
  });

  it('refuses a level the model does not offer instead of downgrading it', () => {
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-3.8-flash' }, 'minimal')).toThrow(/"minimal" is not available/);
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-2.5-pro' }, 'off')).toThrow(/"off" is not available/);
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-9-ultra' }, 'low')).toThrow(/"low" is not available/);
  });
});

describe('Ollama', () => {
  it('offers model-default/off/on, plus named levels only when the Test record accepted them', () => {
    expect(offeredReasoningLevels({ engine: 'local', model: 'qwen3.5:4b' })).toEqual(['model-default', 'off', 'on']);
    expect(
      offeredReasoningLevels({ engine: 'local', model: 'qwen3.5:4b', record: { reasoning: { low: 'accepted', medium: 'rejected', high: 'accepted' } } }),
    ).toEqual(['model-default', 'off', 'on', 'low', 'high']);
  });

  it('probes every Ollama level in a Test (named levels are not yet offered)', () => {
    expect(testableReasoningLevels({ engine: 'local', model: 'qwen3.5:4b' })).toEqual(['model-default', 'off', 'on', 'low', 'medium', 'high']);
    expect(testableReasoningLevels({ engine: 'gemini', model: 'gemma-4-31b-it' })).toEqual(['model-default', 'off', 'on']);
  });

  it('wire fragments', () => {
    expect(reasoningWireFragment('ollama', { model: 'q:4b' }, 'model-default')).toEqual({});
    expect(reasoningWireFragment('ollama', { model: 'q:4b' }, 'off')).toEqual({ think: false });
    expect(reasoningWireFragment('ollama', { model: 'q:4b' }, 'on')).toEqual({ think: true });
    expect(reasoningWireFragment('ollama', { model: 'q:4b' }, 'medium')).toEqual({ think: 'medium' });
    expect(() => reasoningWireFragment('ollama', { model: 'q:4b' }, 'none')).toThrow(/"none" is not available/);
  });
});

describe('endpoint wire fragments', () => {
  it('reasoning_effort sends the level verbatim, model-default sends nothing', () => {
    expect(reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('reasoning_effort') }, 'none')).toEqual({ reasoning_effort: 'none' });
    expect(reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('reasoning_effort') }, 'model-default')).toEqual({});
  });
  it('enable_thinking sends chat_template_kwargs with a boolean', () => {
    expect(reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('enable_thinking') }, 'off')).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('enable_thinking') }, 'on')).toEqual({ chat_template_kwargs: { enable_thinking: true } });
  });
  it('not_controllable refuses anything but model-default', () => {
    expect(reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('not_controllable') }, 'model-default')).toEqual({});
    expect(() => reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('not_controllable') }, 'on')).toThrow(/"on" is not available/);
  });
});

describe('defaults preserve today', () => {
  it('Ollama off; Gemini and endpoints model-default', () => {
    expect(REASONING_LEVELS).toEqual(['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high']);
    expect(defaultReasoningLevel('local')).toBe('off');
    expect(defaultReasoningLevel('gemini')).toBe('model-default');
    expect(defaultReasoningLevel('openai')).toBe('model-default');
    expect(resolveReasoningSetting({}, { engine: 'local', model: 'q:4b' })).toBe('off');
    expect(resolveReasoningSetting({}, { engine: 'gemini', model: 'gemini-3.6-flash' })).toBe('model-default');
    expect(resolveReasoningSetting({}, { engine: 'openai', model: 'm', endpoint: { reasoning: 'model-default' } })).toBe('model-default');
  });
  it('reads the saved setting per engine, per Gemini model, and per endpoint', () => {
    const s = { analyzerReasoningByEngine: { ollama: 'on' as const, gemini: { 'gemini-3.6-flash': 'low' as const } } };
    expect(resolveReasoningSetting(s, { engine: 'local', model: 'q:4b' })).toBe('on');
    expect(resolveReasoningSetting(s, { engine: 'gemini', model: 'gemini-3.6-flash' })).toBe('low');
    expect(resolveReasoningSetting(s, { engine: 'gemini', model: 'gemini-3.5-flash' })).toBe('model-default');
    expect(resolveReasoningSetting(s, { engine: 'openai', model: 'm', endpoint: { reasoning: 'none' } })).toBe('none');
  });
});

describe('reasoningControlDescription', () => {
  it('names the actual control per engine and style', () => {
    expect(reasoningControlDescription('ollama', { model: 'q:4b' })).toMatch(/Ollama reasoning setting.*"think"/);
    expect(reasoningControlDescription('gemini', { model: 'gemini-3.6-flash' })).toMatch(/thinkingLevel.*cannot turn thinking off/);
    expect(reasoningControlDescription('gemini', { model: 'gemini-2.5-flash' })).toMatch(/thinkingBudget.*"off" sets it to 0/);
    expect(reasoningControlDescription('gemini', { model: 'gemini-2.5-pro' })).toMatch(/thinkingBudget.*cannot turn thinking off/);
    expect(reasoningControlDescription('gemini', { model: 'gemma-4-31b-it' })).toMatch(/thinkingLevel.*"off" sends MINIMAL/);
    expect(reasoningControlDescription('gemini', { model: 'gemini-9-ultra' })).toMatch(/cannot be controlled/);
    expect(reasoningControlDescription('openai', { model: 'm', endpoint: endpoint('reasoning_effort') })).toMatch(/"Lab box".*reasoning_effort/);
    expect(reasoningControlDescription('openai', { model: 'm', endpoint: endpoint('enable_thinking') })).toMatch(/chat_template_kwargs\.enable_thinking/);
    expect(reasoningControlDescription('openai', { model: 'm', endpoint: endpoint('not_controllable') })).toMatch(/"not controllable"/);
    expect(reasoningControlDescription('openai', { model: 'm' })).toMatch(/this endpoint's Reasoning setting/);
  });
});
```

`server/src/analyzer/runner/stage-runner.request-controls.test.ts` (the runner half: both fields reach every transport request):
```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './retry-policy.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';

const hoisted = vi.hoisted(() => ({ dirName: `castwright-w5a-handoff-${process.pid}-${Date.now()}` }));
vi.mock('../../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../../handoff/protocol.js')>();
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = join(tmpdir(), hoisted.dirName);
  await mkdir(dir, { recursive: true });
  return {
    ...actual,
    writeInbox: async (m: string, k: string, body: string) => { const p = join(dir, `${m}-${k}.inbox.md`); await writeFile(p, body); return p; },
    outboxPath: (m: string, k: string) => join(dir, `${m}-${k}.json`),
    errorPath: (m: string, k: string) => join(dir, `${m}-${k}.errors.json`),
    rawAttemptPath: (m: string, k: string, a: number) => join(dir, `${m}-${k}.attempt${a}.raw.txt`),
  };
});

class RecordingTransport implements ChatTransport {
  readonly kind = 'ollama' as const;
  readonly model = 'q:4b';
  readonly requests: TransportRequest[] = [];
  constructor(private readonly texts: string[]) {}
  async send(req: TransportRequest): Promise<TransportResult> {
    this.requests.push(req);
    return { text: this.texts[this.requests.length - 1] ?? '', reasoningSeen: false, finish: 'stop', receivedBytes: 0 };
  }
}
const schema = z.object({ ok: z.literal(true) });
const PAYLOAD = { top_k: 20 };
const runnerWith = (t: RecordingTransport) =>
  new StageRunner({
    transport: t,
    policy: OLLAMA_RETRY_POLICY,
    settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, reasoning: 'high', extraParams: PAYLOAD }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });
const stageSpec = { manuscriptId: 'm1', key: 'review-ch1', skillName: 'script_review', promptMd: 'p', grammarSchema: schema, validationSchema: schema } as const;
const escalationSpec = { manuscriptId: 'm1', key: 'escalation-ch1-w0', promptMd: 'p', grammarSchema: schema, validationSchema: schema } as const;

describe('StageRunner forwards the configured reasoning level and custom payload (#3084 wave 5)', () => {
  it('first attempt and the validation retry both carry them', async () => {
    const t = new RecordingTransport(['not json', '{"ok":true}']);
    await runnerWith(t).runStage(stageSpec, {});
    expect(t.requests.map((r) => r.reasoning)).toEqual(['high', 'high']);
    expect(t.requests.map((r) => r.extraParams)).toEqual([PAYLOAD, PAYLOAD]);
  });

  it('the escalation single attempt carries them', async () => {
    const t = new RecordingTransport(['{"ok":true}']);
    await runnerWith(t).runSingleAttempt(escalationSpec, {});
    expect(t.requests[0].reasoning).toBe('high');
    expect(t.requests[0].extraParams).toEqual(PAYLOAD);
  });

  it('the persona free-text path carries them', async () => {
    const t = new RecordingTransport(['A warm, low voice for audiobook narration.']);
    await runnerWith(t).runFreeText({ prompt: 'persona please' });
    expect(t.requests[0].reasoning).toBe('high');
    expect(t.requests[0].extraParams).toEqual(PAYLOAD);
  });

  it('settings that omit both fields leave them undefined on every request (the pre-W5 wire)', async () => {
    const t = new RecordingTransport(['{"ok":true}', 'A voice.']);
    const runner = new StageRunner({
      transport: t,
      policy: OLLAMA_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    await runner.runSingleAttempt(escalationSpec, {});
    await runner.runFreeText({ prompt: 'persona please' });
    expect(t.requests.map((r) => [r.reasoning, r.extraParams])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/reasoning.test.ts src/analyzer/runner/stage-runner.request-controls.test.ts`
Expected: FAIL.
- `reasoning.test.ts` fails with `Failed to resolve import "./reasoning.js"`.
- `stage-runner.request-controls.test.ts`: the first three cases fail, for example `expected [ undefined, undefined ] to deeply equal [ 'high', 'high' ]`. The runner does not forward either field yet, and vitest does not typecheck. The fourth case passes; it pins the default.

- [ ] **Step 3: Implement**

`ReasoningLevel` is declared here for the first time. Wave 1 declared no `ReasoningLevel`, and added no `reasoning` / `extraParams` to `TransportRequest` or `EngineRequestSettings`; wave 4 forwards neither. This task declares the type, adds both optional fields and adds the runner forwarding.

`server/src/analyzer/reasoning.ts`:
```ts
/* #3084 wave 5 (D8, spec §8) — reasoning levels per engine family and per
   endpoint control style. Pure: no settings, capabilities or workspace import
   (those modules import THIS one; see the plan's cycle note). Every parameter
   type below is structural so AnalyzerEndpoint / ModelCapabilityRecord /
   UserSettings satisfy it.

   Sources:
   - Gemini levels per model: ai.google.dev/gemini-api/docs/generate-content/thinking
     (read 2026-09-11; 3.8/3.7 Flash reject MINIMAL, 3.1 Pro has no MINIMAL,
     3.x cannot disable thinking, 2.5 Pro cannot disable, 2.5 Flash / Flash-Lite
     disable with budget 0). Gemma 4 on/off = thinkingLevel HIGH / MINIMAL:
     ai.google.dev/gemma/docs/core/gemma_on_gemini_api.
   - Budget tiers: the Gemini OpenAI-compatibility mapping of reasoning_effort
     low/medium/high → 1024 / 8192 / 24576 thinking tokens
     (ai.google.dev/gemini-api/docs/openai, read 2026-09-11). 1024 clears
     2.5 Flash-Lite's 512 minimum; 24576 is within every 2.5 model's maximum.
   - Ollama think values: true | false | "low" | "medium" | "high"; a level or
     true on a non-thinking model is a 400 (research 06 §16-17).
   - llama.cpp accepts reasoning_effort "none" (thinking off) and passes other
     strings to the template unvalidated; vLLM accepts none…high (research 06
     §3, §11). Help text must say a server may accept a level and ignore it. */

import type { AnalysisEngine } from './model-id.js';
import type { TransportKind } from './errors.js';

export const REASONING_LEVELS = ['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Mirrors REASONING_STYLES in workspace/analyzer-endpoints.ts (pinned by reasoning.test.ts). */
export type ReasoningStyle = 'reasoning_effort' | 'enable_thinking' | 'not_controllable';

interface EndpointReasoningView {
  id: string;
  name: string;
  reasoningStyle: ReasoningStyle;
}
interface ReasoningRecordView {
  reasoning?: Partial<Record<ReasoningLevel, 'accepted' | 'rejected'>>;
}
export interface ReasoningSelection {
  engine: AnalysisEngine;
  model: string;
  endpoint?: EndpointReasoningView;
  record?: ReasoningRecordView;
}

const STYLE_LEVELS: Record<ReasoningStyle, readonly ReasoningLevel[]> = {
  reasoning_effort: ['model-default', 'none', 'minimal', 'low', 'medium', 'high'],
  enable_thinking: ['model-default', 'off', 'on'],
  not_controllable: ['model-default'],
};

export function levelsForReasoningStyle(style: ReasoningStyle): readonly ReasoningLevel[] {
  return STYLE_LEVELS[style];
}

export const OLLAMA_NAMED_LEVELS = ['low', 'medium', 'high'] as const satisfies readonly ReasoningLevel[];
const OLLAMA_BASE_LEVELS: readonly ReasoningLevel[] = ['model-default', 'off', 'on'];

type GeminiControl = 'thinkingLevel' | 'thinkingBudget' | 'gemmaOnOff';
const LEVEL_FULL: ReasoningLevel[] = ['model-default', 'minimal', 'low', 'medium', 'high'];
const LEVEL_NO_MINIMAL: ReasoningLevel[] = ['model-default', 'low', 'medium', 'high'];
const BUDGET_WITH_OFF: ReasoningLevel[] = ['model-default', 'off', 'low', 'medium', 'high'];
const BUDGET_NO_OFF: ReasoningLevel[] = ['model-default', 'low', 'medium', 'high'];

/* First match wins. Flash-Lite rows precede Flash rows, and every Flash row
   also carries (?!-lite), so a new "-lite" id never inherits a Flash row. An id
   that matches nothing offers model-default only. */
export const GEMINI_REASONING_TABLE: ReadonlyArray<{ match: RegExp; control: GeminiControl; levels: ReasoningLevel[] }> = [
  { match: /^gemini-3\.(?:5|1)-flash-lite(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_FULL },
  { match: /^gemini-3(?:\.(?:5|6))?-flash(?!-lite)(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_FULL },
  { match: /^gemini-3\.(?:7|8)-flash(?!-lite)(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_NO_MINIMAL },
  { match: /^gemini-3\.1-pro(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_NO_MINIMAL },
  { match: /^gemini-2\.5-flash-lite(?:$|-)/, control: 'thinkingBudget', levels: BUDGET_WITH_OFF },
  { match: /^gemini-2\.5-flash(?!-lite)(?:$|-)/, control: 'thinkingBudget', levels: BUDGET_WITH_OFF },
  { match: /^gemini-2\.5-pro(?:$|-)/, control: 'thinkingBudget', levels: BUDGET_NO_OFF },
  { match: /^gemma-4-/, control: 'gemmaOnOff', levels: ['model-default', 'off', 'on'] },
];

export const GEMINI_THINKING_BUDGETS = { off: 0, low: 1024, medium: 8192, high: 24576 } as const;

export function geminiReasoningRow(model: string) {
  const id = model.replace(/^models\//, '');
  return GEMINI_REASONING_TABLE.find((row) => row.match.test(id));
}

export function defaultReasoningLevel(engine: AnalysisEngine): ReasoningLevel {
  return engine === 'local' ? 'off' : 'model-default';
}

export function offeredReasoningLevels(sel: ReasoningSelection): ReasoningLevel[] {
  switch (sel.engine) {
    case 'openai':
      return sel.endpoint ? [...levelsForReasoningStyle(sel.endpoint.reasoningStyle)] : ['model-default'];
    case 'gemini':
      return [...(geminiReasoningRow(sel.model)?.levels ?? ['model-default'])];
    case 'local':
      return [...OLLAMA_BASE_LEVELS, ...OLLAMA_NAMED_LEVELS.filter((l) => sel.record?.reasoning?.[l] === 'accepted')];
  }
}

/** The levels a Test action probes: what is offered, plus Ollama's named levels,
    which are offered only after a Test has accepted them. */
export function testableReasoningLevels(sel: ReasoningSelection): ReasoningLevel[] {
  return sel.engine === 'local' ? [...OLLAMA_BASE_LEVELS, ...OLLAMA_NAMED_LEVELS] : offeredReasoningLevels(sel);
}

function unavailable(kind: TransportKind, model: string, level: ReasoningLevel): Error {
  return new Error(
    `Reasoning level "${level}" is not available for ${kind} model ${model}. ` +
      'Change the reasoning setting to a level this model offers.',
  );
}

export function reasoningWireFragment(
  kind: TransportKind,
  sel: { model: string; endpoint?: Pick<EndpointReasoningView, 'reasoningStyle'> },
  level: ReasoningLevel,
): Record<string, unknown> {
  switch (kind) {
    case 'ollama': {
      if (level === 'model-default') return {};
      if (level === 'off') return { think: false };
      if (level === 'on') return { think: true };
      if ((OLLAMA_NAMED_LEVELS as readonly string[]).includes(level)) return { think: level };
      throw unavailable(kind, sel.model, level);
    }
    case 'gemini': {
      const row = geminiReasoningRow(sel.model);
      if (!(row?.levels ?? ['model-default']).includes(level)) throw unavailable(kind, sel.model, level);
      if (level === 'model-default' || !row) return {};
      if (row.control === 'gemmaOnOff') {
        return { thinkingConfig: { thinkingLevel: level === 'on' ? 'HIGH' : 'MINIMAL' } };
      }
      if (row.control === 'thinkingBudget') {
        return { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGETS[level as keyof typeof GEMINI_THINKING_BUDGETS] } };
      }
      return { thinkingConfig: { thinkingLevel: level.toUpperCase() } };
    }
    case 'openai': {
      const style = sel.endpoint?.reasoningStyle ?? 'not_controllable';
      if (!levelsForReasoningStyle(style).includes(level)) throw unavailable(kind, sel.model, level);
      if (level === 'model-default') return {};
      if (style === 'reasoning_effort') return { reasoning_effort: level };
      return { chat_template_kwargs: { enable_thinking: level === 'on' } };
    }
  }
}

interface ReasoningSettingsView {
  analyzerReasoningByEngine?: { ollama?: ReasoningLevel; gemini?: Record<string, ReasoningLevel> };
}

export function resolveReasoningSetting(
  settings: ReasoningSettingsView,
  sel: { engine: AnalysisEngine; model: string; endpoint?: { reasoning: string } },
): ReasoningLevel {
  switch (sel.engine) {
    case 'local':
      return settings.analyzerReasoningByEngine?.ollama ?? defaultReasoningLevel('local');
    case 'gemini':
      return settings.analyzerReasoningByEngine?.gemini?.[sel.model] ?? defaultReasoningLevel('gemini');
    case 'openai':
      return (sel.endpoint?.reasoning as ReasoningLevel | undefined) ?? defaultReasoningLevel('openai');
  }
}

/** Copy for failure messages and help text: which setting controls reasoning
    for this engine/endpoint, and what it is sent as. */
export function reasoningControlDescription(
  kind: TransportKind,
  sel: { model: string; endpoint?: EndpointReasoningView },
): string {
  if (kind === 'ollama') {
    return 'the Ollama reasoning setting (Advanced settings → Analyzer request controls; sent as "think")';
  }
  if (kind === 'gemini') {
    const row = geminiReasoningRow(sel.model);
    const where = `the Gemini reasoning setting for ${sel.model} (Advanced settings → Analyzer request controls`;
    if (!row) return `${where}) — this model's reasoning cannot be controlled from Castwright yet`;
    if (row.control === 'gemmaOnOff') return `${where}; sent as thinkingLevel — "off" sends MINIMAL)`;
    if (row.control === 'thinkingLevel') {
      return `${where}; sent as thinkingLevel — this model cannot turn thinking off, the lowest level is ${row.levels[1]})`;
    }
    return row.levels.includes('off')
      ? `${where}; sent as thinkingBudget — "off" sets it to 0)`
      : `${where}; sent as thinkingBudget — this model cannot turn thinking off)`;
  }
  if (!sel.endpoint) {
    return "this endpoint's Reasoning setting (its control style decides whether it is sent as reasoning_effort or chat_template_kwargs.enable_thinking)";
  }
  const name = `the "${sel.endpoint.name}" endpoint's Reasoning setting`;
  switch (sel.endpoint.reasoningStyle) {
    case 'reasoning_effort':
      return `${name} (sent as reasoning_effort)`;
    case 'enable_thinking':
      return `${name} (sent as chat_template_kwargs.enable_thinking)`;
    case 'not_controllable':
      return `${name} — its control style is "not controllable"; switch it to reasoning_effort or enable_thinking if the server supports one`;
  }
}
```

`server/src/analyzer/runner/transport.ts`. Add `import type { ReasoningLevel } from '../reasoning.js';` below the existing type imports. In `TransportRequest`, directly after `maxOutputTokens?: number;`, add:
```ts
  /** #3084 wave 5 — the resolved reasoning level. undefined = the pre-W5 wire
      (Ollama think:false; Gemini and OpenAI-compatible send no reasoning field). */
  reasoning?: ReasoningLevel;
  /** #3084 wave 5 — the engine/endpoint custom payload, merged last by the
      transport (PR 5b). undefined = no payload. */
  extraParams?: Record<string, unknown>;
```

`server/src/analyzer/runner/stage-runner.ts`:
- **Import.** Add `import type { ReasoningLevel } from '../reasoning.js';`.
- **Settings type.** Replace the `EngineRequestSettings` interface with the version below. Keep whatever comments waves 2–3 added on the first two fields.
```ts
export interface EngineRequestSettings {
  structuredOutput: StructuredOutputMode;
  maxOutputTokens: number | undefined;
  /** #3084 wave 5 — omitted/undefined = the pre-W5 wire. */
  reasoning?: ReasoningLevel;
  /** #3084 wave 5 — omitted/undefined = no custom payload. */
  extraParams?: Record<string, unknown>;
}
```
- **Stage requests.** `runStage`'s two attempts and `runSingleAttempt` reach the transport only through the private `send(system, messages, temperature, structuredOutput, call, withEvalTiming)` helper, so its one `this.transport.send({ … })` literal covers all three calls.
  - Make `const s = this.settings();` the helper's first statement.
  - In the literal, change the `maxOutputTokens:` entry to read `s.maxOutputTokens`, keeping whatever wrapper wave 2 put around it.
  - Directly after that entry, add:
```ts
      reasoning: s.reasoning,
      extraParams: s.extraParams,
```
- **Free text.** In `runFreeText` (W4 Task 4.1), make `const s = this.settings();` the first statement, and directly after its `maxOutputTokens: undefined,` entry add:
```ts
      reasoning: s.reasoning,
      extraParams: s.extraParams,
```
  Free text still ignores `s.maxOutputTokens`. W4's mutation proof pins that.

- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/reasoning.test.ts src/analyzer/runner/stage-runner.request-controls.test.ts src/analyzer/runner src/analyzer/transports`, then `npm run typecheck` and `npm run check:cycles`.
Expected: PASS. Keeps green:
- W1's `stage-runner.test.ts`, whose settings closures omit both fields;
- W4's `stage-runner.free-text.test.ts`;
- every W1–W4 transport suite;
- `npm run typecheck`, since every existing `EngineRequestSettings` literal omits the optional fields.

- [ ] **Step 5: Mutation proof**
1. In the 3.7/3.8 row change `levels: LEVEL_NO_MINIMAL` → `LEVEL_FULL`. Expected red: `gemini-3.8-flash → thinkingLevel` and `refuses a level the model does not offer instead of downgrading it`. Restore.
2. In the `gemmaOnOff` branch swap `'HIGH' : 'MINIMAL'` → `'MINIMAL' : 'HIGH'`. Expected red: `maps levels to the documented wire values`. Restore.
3. Delete `(?!-lite)` from the 3.x Flash row (`/^gemini-3(?:\.(?:5|6))?-flash(?!-lite)(?:$|-)/` → `/^gemini-3(?:\.(?:5|6))?-flash(?:$|-)/`). Expected red: `gemini-3.6-flash-lite → undefined` (the Flash row now claims an unknown Flash-Lite id). Restore.
4. In `offeredReasoningLevels` `'local'` branch replace the filter with `...OLLAMA_NAMED_LEVELS`. Expected red: `offers model-default/off/on, plus named levels only when the Test record accepted them`. Restore.
5. In the private `send` helper delete `reasoning: s.reasoning,`. Expected red: `first attempt and the validation retry both carry them` and `the escalation single attempt carries them`. Restore.
6. In `runFreeText` delete `extraParams: s.extraParams,`. Expected red: `the persona free-text path carries them`. Restore.
Paste the six red outputs into the PR body.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/reasoning.ts server/src/analyzer/reasoning.test.ts server/src/analyzer/__fixtures__/reasoning-style-levels.json server/src/analyzer/runner/transport.ts server/src/analyzer/runner/stage-runner.ts server/src/analyzer/runner/stage-runner.request-controls.test.ts
git commit -m "feat(server): reasoning levels per engine and request-control fields on the stage runner"
```

### Task 5.2: Settings storage and write validation (`analyzerReasoningByEngine`, endpoint `reasoning`), OpenAPI, mocks

**Files:**
- Modify: `server/src/workspace/user-settings.ts:253` (schema, after `analyzerKeepAliveByModel`), `:334` (defaults, after `analyzerKeepAliveByModel: {}`), `:402-404` (`writeUserSettings` validation)
- Create: `server/src/workspace/analyzer-request-controls.ts`
- Modify: `server/src/routes/analyzer-endpoints.ts` (W3b — the create and update handlers' schema parse)
- Modify: `openapi.yaml` — `components.schemas` (new `ReasoningLevel`, `AnalyzerReasoningByEngine`), `UserSettings` (after `analyzerKeepAliveByModel`, `openapi.yaml:4758-4762` at `2b63b451`), `UserSettingsPatch` (after `:4865-4869`), W3's `AnalyzerEndpoint.reasoning`, W3c's catalog model entry schema, W3c's `ModelCapabilityRecord.reasoning`
- Regenerate: `src/lib/api-types.ts`
- Modify: `src/lib/api.ts:6939` (`MOCK_USER_SETTINGS`), `:7312-7342` (`mockPutUserSettings` whitelist)
- Test: `server/src/workspace/analyzer-request-controls.test.ts`, `server/src/routes/user-settings.test.ts` (append), W3b's `server/src/routes/analyzer-endpoints.test.ts` (append)

**Interfaces:**
- Consumes: Task 5.1 `REASONING_LEVELS`, `offeredReasoningLevels`, `testableReasoningLevels`, `levelsForReasoningStyle`; `inferEngineFromModelId` (W3); `analyzerEndpointSchema` (W3).
- Produces: `UserSettings.analyzerReasoningByEngine: { ollama?: ReasoningLevel; gemini?: Record<string, ReasoningLevel> }` (contract); `analyzerRequestControlsPatchSchema` (**new**, extended by PR 5b); `analyzerEndpointWriteSchema` (**new**, extended by PR 5b); OpenAPI `ReasoningLevel`.

**Why validation is NOT on the stored schema.** `readUserSettings` (`user-settings.ts:375-376`) falls back to **all defaults** when the stored JSON fails `userSettingsSchema`. A per-model refinement there would wipe every setting the day the Gemini table changes. The stored shape only checks the eight-value enum; the offered-level rules run on writes (`writeUserSettings`, endpoint create/update). The same applies to endpoints stored inside `analyzerEndpoints`.

- [ ] **Step 1: Write the failing tests**

`server/src/workspace/analyzer-request-controls.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { analyzerRequestControlsPatchSchema, analyzerEndpointWriteSchema } from './analyzer-request-controls.js';
import { userSettingsSchema, DEFAULT_USER_SETTINGS } from './user-settings.js';

const baseEndpoint = { id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'any', contextTokens: 32768 };
const messages = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof z.ZodError) return e.issues.map((i) => i.message); throw e; }
  return [];
};

describe('analyzerRequestControlsPatchSchema — reasoning', () => {
  it('accepts every Ollama level a Test can probe', () => {
    for (const ollama of ['model-default', 'off', 'on', 'low', 'medium', 'high'] as const) {
      expect(messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { ollama } }))).toEqual([]);
    }
  });
  it('refuses Ollama levels that only endpoints have', () => {
    expect(messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { ollama: 'none' } }))).toEqual([
      'Ollama reasoning "none" is not an Ollama level (model-default, off, on, low, medium, high).',
    ]);
  });
  it('refuses a Gemini level the model does not offer, naming model and level', () => {
    expect(
      messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { gemini: { 'gemini-3.8-flash': 'minimal', 'gemini-2.5-flash': 'off' } } })),
    ).toEqual(['Gemini reasoning "minimal" is not available for gemini-3.8-flash (offered: model-default, low, medium, high).']);
  });
  it('refuses a non-Gemini id in the Gemini map', () => {
    expect(messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { gemini: { 'qwen3.5:4b': 'model-default' } } }))).toEqual([
      'Gemini reasoning map key "qwen3.5:4b" is not a Gemini model id.',
    ]);
  });
  it('ignores patches that do not touch the field', () => {
    expect(messages(() => analyzerRequestControlsPatchSchema.parse({ displayName: 'x' }))).toEqual([]);
  });
});

describe('analyzerEndpointWriteSchema — reasoning', () => {
  it('requires reasoning to be one of its control style levels', () => {
    expect(messages(() => analyzerEndpointWriteSchema.parse({ ...baseEndpoint, reasoningStyle: 'enable_thinking', reasoning: 'off' }))).toEqual([]);
    expect(messages(() => analyzerEndpointWriteSchema.parse({ ...baseEndpoint, reasoningStyle: 'enable_thinking', reasoning: 'none' }))).toEqual([
      'Reasoning "none" is not offered by the enable_thinking control style (offered: model-default, off, on).',
    ]);
    expect(messages(() => analyzerEndpointWriteSchema.parse({ ...baseEndpoint, reasoning: 'high' }))).toEqual([
      'Reasoning "high" is not offered by the not_controllable control style (offered: model-default).',
    ]);
  });
});

describe('stored schema stays lenient', () => {
  it('loads a stored Gemini level the table no longer offers instead of resetting settings', () => {
    const parsed = userSettingsSchema.safeParse({ ...DEFAULT_USER_SETTINGS, analyzerReasoningByEngine: { gemini: { 'gemini-3.8-flash': 'minimal' } } });
    expect(parsed.success).toBe(true);
  });
  it('defaults to an empty map', () => {
    expect(DEFAULT_USER_SETTINGS.analyzerReasoningByEngine).toEqual({});
  });
});
```

Append to `server/src/routes/user-settings.test.ts` inside `describe('user-settings router', …)`:
```ts
  it('PUT refuses a Gemini reasoning level the model does not offer and writes nothing', async () => {
    const res = await request(app)
      .put('/api/user/settings')
      .send({ displayName: 'Changed', analyzerReasoningByEngine: { gemini: { 'gemini-2.5-pro': 'off' } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid user settings.');
    expect(res.body.issues.map((i: { message: string }) => i.message)).toEqual([
      'Gemini reasoning "off" is not available for gemini-2.5-pro (offered: model-default, low, medium, high).',
    ]);
    expect(existsSync(userSettingsPath)).toBe(false);
  });

  it('PUT persists analyzerReasoningByEngine and GET returns it', async () => {
    const put = await request(app)
      .put('/api/user/settings')
      .send({ analyzerReasoningByEngine: { ollama: 'on', gemini: { 'gemini-3.6-flash': 'low' } } });
    expect(put.status).toBe(200);
    resetCache();
    const get = await request(app).get('/api/user/settings');
    expect(get.body.analyzerReasoningByEngine).toEqual({ ollama: 'on', gemini: { 'gemini-3.6-flash': 'low' } });
  });
```

Append to W3b's `server/src/routes/analyzer-endpoints.test.ts` (reuse its app/supertest setup and its valid-endpoint fixture; the name below is the fixture's field set, spread so the test does not depend on the fixture's variable name):
```ts
  it('create refuses a reasoning level its control style does not offer', async () => {
    const res = await request(app).post('/api/analyzer/endpoints').send({
      id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'any', contextTokens: 32768,
      reasoningStyle: 'reasoning_effort', reasoning: 'on',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Reasoning "on" is not offered by the reasoning_effort control style');
  });
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/workspace/analyzer-request-controls.test.ts src/routes/user-settings.test.ts src/routes/analyzer-endpoints.test.ts`  Expected: FAIL — `Failed to resolve import "./analyzer-request-controls.js"`; the route tests fail with `expected 200 to be 400`.

- [ ] **Step 3: Implement**

`server/src/workspace/analyzer-request-controls.ts`:
```ts
/* #3084 wave 5 — WRITE-time validation for analyzer request controls. Kept off
   userSettingsSchema on purpose: a failed read-parse resets every setting to
   defaults (user-settings.ts readUserSettings), so rules that depend on tables
   that change (Gemini levels, protected keys) run only when a client writes. */
import { z } from 'zod';
import { REASONING_LEVELS, levelsForReasoningStyle, offeredReasoningLevels, testableReasoningLevels } from '../analyzer/reasoning.js';
import { inferEngineFromModelId } from '../analyzer/model-id.js';
import { analyzerEndpointSchema } from './analyzer-endpoints.js';

const OLLAMA_WRITABLE = testableReasoningLevels({ engine: 'local', model: '' });

const reasoningByEngineInput = z
  .object({
    ollama: z.enum(REASONING_LEVELS).optional(),
    gemini: z.record(z.string(), z.enum(REASONING_LEVELS)).optional(),
  })
  .optional();

export const analyzerRequestControlsPatchSchema = z
  .object({ analyzerReasoningByEngine: reasoningByEngineInput })
  .superRefine((patch, ctx) => {
    const r = patch.analyzerReasoningByEngine;
    if (!r) return;
    if (r.ollama !== undefined && !OLLAMA_WRITABLE.includes(r.ollama)) {
      ctx.addIssue({
        code: 'custom',
        path: ['analyzerReasoningByEngine', 'ollama'],
        message: `Ollama reasoning "${r.ollama}" is not an Ollama level (${OLLAMA_WRITABLE.join(', ')}).`,
      });
    }
    for (const [model, level] of Object.entries(r.gemini ?? {})) {
      if (inferEngineFromModelId(model) !== 'gemini') {
        ctx.addIssue({ code: 'custom', path: ['analyzerReasoningByEngine', 'gemini', model], message: `Gemini reasoning map key "${model}" is not a Gemini model id.` });
        continue;
      }
      const offered = offeredReasoningLevels({ engine: 'gemini', model });
      if (!offered.includes(level)) {
        ctx.addIssue({
          code: 'custom',
          path: ['analyzerReasoningByEngine', 'gemini', model],
          message: `Gemini reasoning "${level}" is not available for ${model} (offered: ${offered.join(', ')}).`,
        });
      }
    }
  });

export const analyzerEndpointWriteSchema = analyzerEndpointSchema.superRefine((endpoint, ctx) => {
  const offered = levelsForReasoningStyle(endpoint.reasoningStyle);
  if (!(offered as readonly string[]).includes(endpoint.reasoning)) {
    ctx.addIssue({
      code: 'custom',
      path: ['reasoning'],
      message: `Reasoning "${endpoint.reasoning}" is not offered by the ${endpoint.reasoningStyle} control style (offered: ${offered.join(', ')}).`,
    });
  }
});
```

`server/src/workspace/user-settings.ts` — add the import next to the existing imports (`:12-24`):
```ts
import { REASONING_LEVELS } from '../analyzer/reasoning.js';
import { analyzerRequestControlsPatchSchema } from './analyzer-request-controls.js';
```
After `analyzerKeepAliveByModel: z.record(z.string(), z.number().int()).default({}),` (`:253`):
```ts
  /* #3084 wave 5 — per-engine reasoning level. Ollama: one level for every
     Ollama model (absent = 'off', today's think:false). Gemini: per model id
     (absent = 'model-default', no thinking field). Endpoints carry their own
     `reasoning`. Lenient on read (enum only); offered-level rules run on write
     in analyzer-request-controls.ts. General PUT is the write path. */
  analyzerReasoningByEngine: z
    .object({
      ollama: z.enum(REASONING_LEVELS).optional(),
      gemini: z.record(z.string(), z.enum(REASONING_LEVELS)).optional(),
    })
    .default({}),
```
After `analyzerKeepAliveByModel: {},` in `DEFAULT_USER_SETTINGS` (`:334`):
```ts
  /* #3084 wave 5 — empty = today's behaviour (Ollama off, Gemini model-default). */
  analyzerReasoningByEngine: {},
```
In `writeUserSettings` replace `:403-404`:
```ts
  const sanitised = stripForbiddenKeys(patch);
  const validated = patchSchema.parse(sanitised);
```
with:
```ts
  const sanitised = stripForbiddenKeys(patch);
  const validated = patchSchema.parse(sanitised);
  /* #3084 wave 5 — offered-level (and, from PR 5b, custom-payload) rules.
     Throws ZodError, which the PUT route already maps to 400 + issues. */
  analyzerRequestControlsPatchSchema.parse(sanitised);
```

`server/src/routes/analyzer-endpoints.ts` (W3b): run `git grep -n "analyzerEndpointSchema\." server/src/routes/analyzer-endpoints.ts`. In the `POST /` and `PUT /:endpointId` handlers replace each `analyzerEndpointSchema.parse(` / `analyzerEndpointSchema.safeParse(` with `analyzerEndpointWriteSchema.parse(` / `analyzerEndpointWriteSchema.safeParse(`, and add `import { analyzerEndpointWriteSchema } from '../workspace/analyzer-request-controls.js';`. The handler's existing ZodError → 400 branch carries the issue messages.

Cycle check: `analyzer-request-controls.ts` imports `analyzer-endpoints.ts`, `reasoning.ts`, `model-id.ts`; `user-settings.ts` imports it. If W3's `analyzer-endpoints.ts` imports `user-settings.ts` (for `findEndpointReferences(settings: UserSettings, …)`), that import must be `import type` **and** the cycle must not appear in `npm run check:cycles`. If madge reports a new cycle, move the `analyzerRequestControlsPatchSchema.parse` call out of `writeUserSettings` into the PUT handler in `server/src/routes/user-settings.ts:78-80` (`analyzerRequestControlsPatchSchema.parse(req.body)` before `writeUserSettings(req.body)`) and drop the import from `user-settings.ts`; the route tests above cover both placements.

`openapi.yaml` — add under `components.schemas` (alphabetical placement is not enforced; put them directly above `UserSettings`):
```yaml
    ReasoningLevel:
      type: string
      enum: ['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high']
      description: |
        Reasoning level for one analyzer engine, Gemini model or endpoint.
        Which values apply depends on the engine family (Gemini per model,
        Ollama) or the endpoint's reasoningStyle; the server offers only those
        and refuses others on save. `model-default` sends no reasoning field.
        A server may accept a level and ignore it — that cannot be observed.
    AnalyzerReasoningByEngine:
      type: object
      properties:
        ollama:
          $ref: '#/components/schemas/ReasoningLevel'
        gemini:
          type: object
          additionalProperties:
            $ref: '#/components/schemas/ReasoningLevel'
      description: |
        #3084 — per-engine reasoning. Ollama: one level for every Ollama model
        (absent = 'off'). Gemini: keyed by model id (absent = 'model-default').
```
In `UserSettings.properties` after `analyzerKeepAliveByModel` and in `UserSettingsPatch.properties` after `analyzerKeepAliveByModel`:
```yaml
        analyzerReasoningByEngine:
          $ref: '#/components/schemas/AnalyzerReasoningByEngine'
```
In W3's `AnalyzerEndpoint` schema replace the `reasoning` property with:
```yaml
        reasoning:
          $ref: '#/components/schemas/ReasoningLevel'
```
In W3c's `AnalyzerCatalogEntry` schema (Task 3c.6, `components.schemas.AnalyzerCatalogEntry`, the item of `AnalyzerCatalogGroup.models`) add, under `properties`:
```yaml
        offeredReasoningLevels:
          type: array
          items:
            $ref: '#/components/schemas/ReasoningLevel'
          description: Levels the Settings UI may offer for this model (engine family, endpoint style, and the model's Test record).
```
W3c's `ModelCapabilityRecord.reasoning` schema (Task 3c.6) is already `type: object` with `additionalProperties: { type: string, enum: [accepted, rejected] }`. Leave it; the key narrowing is TypeScript-only (Task 5.4).

Run `npm run openapi:types`.

`src/lib/api.ts` — in `MOCK_USER_SETTINGS` after `analyzerKeepAliveByModel: {},` (`:6939`):
```ts
  analyzerReasoningByEngine: {},
```
In `mockPutUserSettings` add `analyzerReasoningByEngine,` to the destructuring list after `analyzerKeepAliveByModel,` (`:7324`) and to the object literal after `analyzerKeepAliveByModel,` (`:7341`).
In W3c's `mockGetAnalyzerModels` (`src/lib/api.ts`, Task 3c.6), extend its local `entry(id, engine, model, mode, droppedIfSchema)` helper so it gives every model entry `offeredReasoningLevels` so the Settings editor has something to offer in mock mode and e2e: Ollama entries `['model-default', 'off', 'on']`; `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3-flash-preview`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` → `['model-default', 'minimal', 'low', 'medium', 'high']`; `gemini-2.5-flash` → `['model-default', 'off', 'low', 'medium', 'high']`; `gemma-4-31b-it`, `gemma-4-26b-a4b-it` → `['model-default', 'off', 'on']`; endpoint entries → `levelsForEndpointStyle(endpoint.reasoningStyle)` from `src/lib/reasoning-levels.ts` (Task 5.6 creates it; in this task write the literal arrays from `reasoning-style-levels.json`, and Task 5.6 swaps them for the import).

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/workspace/analyzer-request-controls.test.ts src/routes/user-settings.test.ts src/routes/analyzer-endpoints.test.ts src/workspace/user-settings.test.ts`  Expected: PASS.
Then: `npm run typecheck` and `npm run check:cycles`  Expected: PASS, no new cycle.
Keeps green: `src/workspace/user-settings.test.ts` (writeUserSettings merge behaviour), `src/routes/user-settings.test.ts` (existing cases), `npm test -- src/store/account-slice.test.ts`.

- [ ] **Step 5: Mutation proof**
1. In `writeUserSettings` delete the `analyzerRequestControlsPatchSchema.parse(sanitised);` line. Expected red: `PUT refuses a Gemini reasoning level the model does not offer and writes nothing`. Restore.
2. In `analyzerEndpointWriteSchema` replace `!(offered as readonly string[]).includes(endpoint.reasoning)` with `false`. Expected red: `requires reasoning to be one of its control style levels`. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/workspace/analyzer-request-controls.ts server/src/workspace/analyzer-request-controls.test.ts server/src/workspace/user-settings.ts server/src/routes/user-settings.test.ts server/src/routes/analyzer-endpoints.ts server/src/routes/analyzer-endpoints.test.ts openapi.yaml src/lib/api-types.ts src/lib/api.ts
git commit -m "feat(server,openapi,mocks): store and validate analyzer reasoning levels"
```

### Task 5.3: Every transport sends the resolved level; the runner and the three analyzers pass it

**Files:**
- Modify: `server/src/analyzer/transports/ollama-transport.ts` — the streaming request-body literal (W1 moved it from `server/src/analyzer/ollama.ts:631-674`; the line to change is the moved `think: false,` from `ollama.ts:648-651`) **and** W4's non-streaming `sendFreeText` body literal (the persona branch moved from `ollama.ts:950-1027`, which also hard-codes `think: false,`)
- Modify: `server/src/analyzer/transports/gemini-transport.ts` — the `config` literal (W1 moved it from `gemini.ts:728-734`; W2 added `thinkingConfig.includeThoughts`)
- Modify: `server/src/analyzer/transports/openai-transport.ts` — the chat-completions params object (W3b)
- Modify: the `settings: () => …` closure in the constructors of `OllamaAnalyzer` (`server/src/analyzer/ollama.ts`), `GeminiAnalyzer` (`server/src/analyzer/gemini.ts`), `OpenAIAnalyzer` (`server/src/analyzer/openai.ts`)
- Test: `server/src/analyzer/transports/reasoning-wire.test.ts`, `server/src/analyzer/gemini-reasoning-wiring.test.ts` (the runner's forwarding is Task 5.1's `stage-runner.request-controls.test.ts`)

**Interfaces:**
- Consumes: Task 5.1 `reasoningWireFragment`, `resolveReasoningSetting`, `TransportRequest.reasoning` and `EngineRequestSettings.reasoning` (declared and forwarded by Task 5.1); `getCachedUserSettings` (`user-settings.ts:385`); `_setUserSettingsCacheForTest` (`user-settings.ts:946`).
- Produces: `mergeGeminiThinkingConfig(config, fragment)` (**new** export of `gemini-transport.ts`); wire behaviour — `req.reasoning === undefined` keeps pre-W5 wire (Ollama `think:false`, others nothing); a defined level sends exactly `reasoningWireFragment(...)`.

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/transports/reasoning-wire.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import type { GoogleGenAI } from '@google/genai';
import { OllamaTransport } from './ollama-transport.js';
import { OpenAITransport } from './openai-transport.js';
import { GeminiTransport, mergeGeminiThinkingConfig } from './gemini-transport.js';
import { analyzerEndpointSchema } from '../../workspace/analyzer-endpoints.js';
import { geminiRateLimiter } from '../rate-limit.js';
import type { TransportRequest } from '../runner/transport.js';
import type { ReasoningLevel } from '../reasoning.js';

const OLLAMA_OK =
  JSON.stringify({ model: 'q:4b', message: { role: 'assistant', content: '{"ok":true}' }, done: false }) + '\n' +
  JSON.stringify({ model: 'q:4b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n';
const sseChunk = (delta: object, finish: string | null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const OPENAI_OK = sseChunk({ role: 'assistant', content: '{"ok":true}' }, null) + sseChunk({}, 'stop') + 'data: [DONE]\n\n';

let server: Server | null = null;
const bodies: Array<Record<string, unknown>> = [];
async function startCapture(contentType: string, payload: string): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const dispatcher = () => new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });
const req = (reasoning: ReasoningLevel | undefined): TransportRequest => ({
  system: 'sys', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' },
  temperature: 0.2, reasoning, estimatedInputTokens: 10, call: {},
});

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
beforeEach(() => { bodies.length = 0; geminiRateLimiter._reset(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe('Ollama wire', () => {
  it('undefined reasoning keeps think:false (pre-W5 behaviour)', async () => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req(undefined));
    expect(bodies[0].think).toBe(false);
  });
  it.each<[ReasoningLevel, unknown]>([['off', false], ['on', true], ['medium', 'medium']])('%s sends think=%s', async (level, think) => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req(level));
    expect(bodies[0].think).toEqual(think);
  });
  it('model-default omits think entirely', async () => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req('model-default'));
    expect('think' in bodies[0]).toBe(false);
  });
});

describe('Ollama free-text (persona) wire — W4 non-streaming branch', () => {
  const PERSONA_OK = JSON.stringify({ message: { role: 'assistant', content: 'A warm, low voice for audiobook narration.' }, done: true, done_reason: 'stop' });
  const freeTextReq = (reasoning: ReasoningLevel | undefined): TransportRequest => ({ ...req(reasoning), freeText: { onCpu: false, keepAlive: 0 } });
  it('undefined reasoning keeps think:false on the persona call', async () => {
    const url = await startCapture('application/json', PERSONA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(freeTextReq(undefined));
    expect(bodies[0].stream).toBe(false);
    expect(bodies[0].think).toBe(false);
  });
  it('a saved level reaches the persona call; model-default omits think', async () => {
    const url = await startCapture('application/json', PERSONA_OK);
    const t = new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() });
    await t.send(freeTextReq('on'));
    await t.send(freeTextReq('high'));
    await t.send(freeTextReq('model-default'));
    expect(bodies[0].think).toBe(true);
    expect(bodies[1].think).toBe('high');
    expect('think' in bodies[2]).toBe(false);
    expect(bodies.every((b) => b.stream === false)).toBe(true);
  });
});

describe('OpenAI-compatible wire', () => {
  const endpointAt = (base: string, reasoningStyle: 'reasoning_effort' | 'enable_thinking' | 'not_controllable') =>
    analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `${base}/v1`, gpu: 'none', contextTokens: 32768, reasoningStyle });
  it('reasoning_effort none is sent verbatim', async () => {
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'reasoning_effort'), apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req('none'));
    expect(bodies[0].reasoning_effort).toBe('none');
    expect('chat_template_kwargs' in bodies[0]).toBe(false);
  });
  it('enable_thinking off sends chat_template_kwargs.enable_thinking=false', async () => {
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'enable_thinking'), apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req('off'));
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect('reasoning_effort' in bodies[0]).toBe(false);
  });
  it('model-default sends neither field', async () => {
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'reasoning_effort'), apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req('model-default'));
    expect('reasoning_effort' in bodies[0] || 'chat_template_kwargs' in bodies[0]).toBe(false);
  });
});

describe('Gemini wire', () => {
  function fakeClient(captured: Array<{ config: Record<string, unknown> }>) {
    return {
      models: {
        generateContentStream: vi.fn(async (params: { config: Record<string, unknown> }) => {
          captured.push(params);
          return (async function* () { yield { text: '{"ok":true}', candidates: [{ finishReason: 'STOP' }] }; })();
        }),
      },
    } as unknown as GoogleGenAI;
  }
  it('3.x low → thinkingLevel LOW, never thinkingBudget', async () => {
    const captured: Array<{ config: Record<string, unknown> }> = [];
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(captured) }).send(req('low'));
    const tc = captured[0].config.thinkingConfig as Record<string, unknown>;
    expect(tc.thinkingLevel).toBe('LOW');
    expect('thinkingBudget' in tc).toBe(false);
  });
  it('2.5 Flash off → thinkingBudget 0', async () => {
    const captured: Array<{ config: Record<string, unknown> }> = [];
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-2.5-flash', client: fakeClient(captured) }).send(req('off'));
    expect((captured[0].config.thinkingConfig as Record<string, unknown>).thinkingBudget).toBe(0);
  });
  it('undefined and model-default leave config.thinkingConfig as W2 built it', async () => {
    const a: Array<{ config: Record<string, unknown> }> = [];
    const b: Array<{ config: Record<string, unknown> }> = [];
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(a) }).send(req(undefined));
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(b) }).send(req('model-default'));
    expect(b[0].config.thinkingConfig).toEqual(a[0].config.thinkingConfig);
  });
  it('mergeGeminiThinkingConfig keeps includeThoughts, drops it only for a zero budget', () => {
    expect(mergeGeminiThinkingConfig({ temperature: 0.2, thinkingConfig: { includeThoughts: true } }, { thinkingConfig: { thinkingLevel: 'LOW' } }))
      .toEqual({ temperature: 0.2, thinkingConfig: { includeThoughts: true, thinkingLevel: 'LOW' } });
    expect(mergeGeminiThinkingConfig({ thinkingConfig: { includeThoughts: true } }, { thinkingConfig: { thinkingBudget: 0 } }))
      .toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    const same = { temperature: 0.2 };
    expect(mergeGeminiThinkingConfig(same, {})).toBe(same);
  });
});
```

`server/src/analyzer/gemini-reasoning-wiring.test.ts` (analyzer-level wiring: settings → closure → wire):
```ts
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const captured: Array<{ config: Record<string, unknown> }> = [];
vi.mock('@google/genai', async (orig) => {
  const actual = await orig<typeof import('@google/genai')>();
  class FakeGoogleGenAI {
    models = {
      generateContentStream: async (params: { config: Record<string, unknown> }) => {
        captured.push(params);
        return (async function* () { yield { text: '{}', candidates: [{ finishReason: 'STOP' }] }; })();
      },
    };
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});
vi.mock('../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../handoff/protocol.js')>();
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = join(tmpdir(), `castwright-w5a-wiring-${process.pid}`);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  return { ...actual, writeInbox: async () => join(dir, 'inbox.md'), outboxPath: () => join(dir, 'out.json'), errorPath: () => join(dir, 'err.json'), rawAttemptPath: () => join(dir, 'raw.txt') };
});

import { GeminiAnalyzer } from './gemini.js';
import { OllamaAnalyzer } from './ollama.js';
import { _setUserSettingsCacheForTest, _resetUserSettingsCache } from '../workspace/user-settings.js';
import { geminiRateLimiter } from './rate-limit.js';

let server: Server | null = null;
const ollamaBodies: Array<Record<string, unknown>> = [];
beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
beforeEach(() => { captured.length = 0; ollamaBodies.length = 0; geminiRateLimiter._reset(); _resetUserSettingsCache(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe('saved reasoning settings reach the wire', () => {
  it('Gemini: the per-model level is sent, other models send nothing', async () => {
    _setUserSettingsCacheForTest({ analyzerReasoningByEngine: { gemini: { 'gemini-2.5-flash': 'off' } } });
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-2.5-flash' }).runAttributionEscalation('m1', 1, 0, 'prompt', {});
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.6-flash' }).runAttributionEscalation('m1', 1, 1, 'prompt', {});
    expect((captured[0].config.thinkingConfig as Record<string, unknown>).thinkingBudget).toBe(0);
    expect((captured[1].config.thinkingConfig as Record<string, unknown> | undefined)?.thinkingLevel).toBeUndefined();
  });

  it('Ollama: default install still sends think:false; a saved "on" sends think:true', async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        ollamaBodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: '{}' }, done: true, done_reason: 'stop' }) + '\n');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    _setUserSettingsCacheForTest({});
    await new OllamaAnalyzer({ url, model: 'q:4b' }).runAttributionEscalation('m1', 1, 0, 'prompt', {});
    _setUserSettingsCacheForTest({ analyzerReasoningByEngine: { ollama: 'on' } });
    await new OllamaAnalyzer({ url, model: 'q:4b' }).runAttributionEscalation('m1', 1, 1, 'prompt', {});
    expect(ollamaBodies.map((b) => b.think)).toEqual([false, true]);
  });
});
```
(`runAttributionEscalation` is used because it is one call with no skill file; its `null` result on `'{}'` is irrelevant — only the captured request is asserted.)

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/transports/reasoning-wire.test.ts src/analyzer/gemini-reasoning-wiring.test.ts`
Expected: FAIL — `does not provide an export named 'mergeGeminiThinkingConfig'`; Ollama `on sends think=true` fails with `expected false to deeply equal true`.

- [ ] **Step 3: Implement**

`ollama-transport.ts` — in the body literal delete the moved line `think: false,` (and its three-line comment). Directly after the literal, before the pre-abort check, add:
```ts
    /* #3084 wave 5 — reasoning. `undefined` = a caller that predates reasoning
       settings: keep today's think:false (qwen3.5's <think> tokens break the
       parser; Ollama accepts false on non-thinking models). A defined level
       sends exactly its fragment; 'model-default' sends no `think` at all. */
    if (req.reasoning === undefined) {
      (body as Record<string, unknown>).think = false;
    } else {
      Object.assign(body, reasoningWireFragment('ollama', { model: this.model }, req.reasoning));
    }
```
and `import { reasoningWireFragment } from '../reasoning.js';`. If W1 declared `body` with `const body = { … }` whose inferred type lacks `think`, change the declaration to `const body: Record<string, unknown> = { … }` (no other line changes).

Same file, W4's `sendFreeText` (the non-streaming persona branch): delete the `think: false,` line from its `const body = { … }` literal, declare the literal as `const body: Record<string, unknown> = { … }`, and directly after the literal (before `const releaseSlot = await acquireAnalyzerSlot(…)`) add the identical block:
```ts
    /* #3084 wave 5 — same reasoning rule as the streaming body: `undefined`
       keeps the persona call's historical think:false; a defined level
       (runFreeText forwards settings().reasoning, Task 5.1) sends exactly its fragment. */
    if (req.reasoning === undefined) {
      body.think = false;
    } else {
      Object.assign(body, reasoningWireFragment('ollama', { model: this.model }, req.reasoning));
    }
```
The Gemini and OpenAI free-text requests need no separate change: W4 routes them through the same `config` literal / params object that the reasoning merge above already covers.

`gemini-transport.ts` — add the exported helper and import:
```ts
import { reasoningWireFragment } from '../reasoning.js';

/** Merge a reasoning fragment's thinkingConfig into the request config built by
    W2 (which may already carry includeThoughts). A zero thinking budget has no
    thoughts to include, so includeThoughts is dropped there. The fragment never
    carries both thinkingLevel and thinkingBudget (reasoning.test.ts pins it). */
export function mergeGeminiThinkingConfig(
  config: Record<string, unknown>,
  fragment: Record<string, unknown>,
): Record<string, unknown> {
  const add = fragment.thinkingConfig as Record<string, unknown> | undefined;
  if (!add) return config;
  const merged: Record<string, unknown> = {
    ...((config.thinkingConfig as Record<string, unknown> | undefined) ?? {}),
    ...add,
  };
  if (merged.thinkingBudget === 0) delete merged.includeThoughts;
  return { ...config, thinkingConfig: merged };
}
```
Where the transport passes `config: { responseMimeType…, thinkingConfig… }` to `this.client.models.generateContentStream({ model, contents, config })`, hoist the literal into `const baseConfig: Record<string, unknown> = { …unchanged… };` and pass:
```ts
        config: (req.reasoning === undefined
          ? baseConfig
          : mergeGeminiThinkingConfig(baseConfig, reasoningWireFragment('gemini', { model: this.model }, req.reasoning))) as GenerateContentConfig,
```
(`import type { GenerateContentConfig } from '@google/genai';` if not already imported.)

`openai-transport.ts` — where W3b builds the params object for `client.chat.completions.create(params, { signal })`, after the object literal add:
```ts
    if (req.reasoning !== undefined) {
      Object.assign(params, reasoningWireFragment('openai', { model: this.model, endpoint: this.endpoint }, req.reasoning));
    }
```
with `import { reasoningWireFragment } from '../reasoning.js';`, typing `params` as `Record<string, unknown>` at declaration and casting at the `create(` call site (`params as unknown as ChatCompletionCreateParamsStreaming`) if W3b typed it as the SDK type.

`stage-runner.ts` needs no change here: Task 5.1 already forwards `reasoning: s.reasoning` on every transport request.

Settings closures — in each analyzer constructor's `new StageRunner({ … settings: () => ({ … }) })`, add a `reasoning:` entry. No wave 1–4 closure sets the field, W3b's `OpenAIAnalyzer` included; it is optional since Task 5.1.
- `OllamaAnalyzer` (`ollama.ts`): `reasoning: resolveReasoningSetting(getCachedUserSettings(), { engine: 'local', model: opts.model }),`
- `GeminiAnalyzer` (`gemini.ts`): `reasoning: resolveReasoningSetting(getCachedUserSettings(), { engine: 'gemini', model: opts.model }),`
- `OpenAIAnalyzer`: `reasoning: resolveReasoningSetting(getCachedUserSettings(), { engine: 'openai', model: opts.model, endpoint: opts.endpoint }),`
(`opts` = the constructor parameter; import `resolveReasoningSetting` from `./reasoning.js` and `getCachedUserSettings` from `../workspace/user-settings.js` where missing.) If W4 built a separate settings closure for persona generation, apply the line matching its engine there too.

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/transports/reasoning-wire.test.ts src/analyzer/runner/stage-runner.request-controls.test.ts src/analyzer/gemini-reasoning-wiring.test.ts src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts src/analyzer/voice-style.test.ts src/analyzer/transports src/analyzer/runner`
Then: `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`
Expected: PASS. Keeps green: W1's transport and runner suites (default settings resolve to today's wire), `ollama.test.ts:386-410` (format body), W3's OpenAI transport contract suite, W4's persona tests.

- [ ] **Step 5: Mutation proof**
1. In `ollama-transport.ts` delete `(body as Record<string, unknown>).think = false;`. Expected red: `undefined reasoning keeps think:false (pre-W5 behaviour)`. Restore.
1b. In `sendFreeText` delete the `Object.assign(body, reasoningWireFragment(…))` line (leaving the `else` empty). Expected red: `a saved level reaches the persona call; model-default omits think`. Restore. Also delete `body.think = false;` there. Expected red: `undefined reasoning keeps think:false on the persona call` (and W4's own free-text test that asserts `body.think === false`). Restore.
2. Runner forwarding is proven by Task 5.1's mutation proofs 5–6; it is not repeated here.
3. In `mergeGeminiThinkingConfig` delete `if (merged.thinkingBudget === 0) delete merged.includeThoughts;`. Expected red: `mergeGeminiThinkingConfig keeps includeThoughts, drops it only for a zero budget`. Restore.
4. In `OllamaAnalyzer`'s closure replace the resolver with `reasoning: 'off',`. Expected red: `Ollama: default install still sends think:false; a saved "on" sends think:true`. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports server/src/analyzer/ollama.ts server/src/analyzer/gemini.ts server/src/analyzer/openai.ts server/src/analyzer/gemini-reasoning-wiring.test.ts
git add $(git grep -l "class OpenAIAnalyzer" server/src)
git commit -m "feat(server): send the configured reasoning level on every analyzer transport"
```

### Task 5.4: Test action reasoning coverage, level-keyed schema probes, pre-run refusal, catalog `offeredReasoningLevels`

**Files:**
- Modify: `server/src/analyzer/capabilities.ts` (W3c Tasks 3c.3–3c.4). Add the reasoning half. Change `ModelTestDeps`, `capabilityRecordFor`, `assertConfiguredCapabilitiesAllowed`, `plannedTestRequestCount` and `runModelTest`, and the private `isHttp400`, `sendProbe` and `checkMode`.
- Modify: `server/src/analyzer/model-test-deps.ts` (W3c Task 3c.6, `modelTestDepsFor`) — the Test deps
- Modify: `server/src/analyzer/catalog/analyzer-catalog.ts` (W3c Task 3c.5, `toEntry` and `endpointGroup`) — catalog entry assembly: `offeredReasoningLevels`, the level-keyed label, the test plan
- Modify: `server/src/analyzer/preflight.ts` (W3c Task 3c.10, `runAnalyzerPreflight`) — its three `assertConfiguredCapabilitiesAllowed(` calls (`git grep -n "assertConfiguredCapabilitiesAllowed(" server/src -- ':!*.test.ts'` must list only these)
- Test: Create `server/src/analyzer/capabilities.reasoning.test.ts` and `server/src/routes/analyzer-models.reasoning.test.ts`. Update W3c's `server/src/analyzer/capabilities.run-model-test.test.ts`, `server/src/analyzer/capabilities.test.ts`, `server/src/analyzer/model-test-deps.test.ts` and `server/src/analyzer/catalog/analyzer-catalog.test.ts`.

**Interfaces:**
- Consumes: Task 5.1 `defaultReasoningLevel`, `testableReasoningLevels`, `offeredReasoningLevels`, `resolveReasoningSetting`, `ReasoningSelection`. Contract `ModelCapabilityRecord`, `capabilityRecordFor`, `assertConfiguredCapabilitiesAllowed`, `runModelTest`, `plannedTestRequestCount`, `structuredOutputLabel(mode, dropped, record, reasoningKey)`, `AnalyzerCapabilityRejectedError`, `AnalyzerHttpError`, `AnalysisAbortedError`, `inferEngineFromModelId`, `parseEndpointModelId`. W3c's (Task 3c.4) `ModelTestDeps` fields `transport`, `serverUrl`, `configuredMode`, `offeredModes`, `offeredLevels`, `adaptSchema`, `now`, `markerValue`, `redact`. W3c's private `isHttp400(err)`, `sendProbe(transport, structuredOutput, prompt, maxOutputTokens)` and `checkMode(modelId, mode, deps)`, and its `CONTROL_PROMPT`, `CONTROL_MAX_OUTPUT_TOKENS`, `requireStop` and `ModelTestInconclusiveError`. W3c's `analyzerModelsRouter`, mounted at `/api/analyzer`, with routes `/models`, `/models/test` and `/models/preview`.
- Produces (**new** exports of `capabilities.ts`): `isProbeRejected(err)` (W3c's `isHttp400`, renamed and exported), `reasoningLevelsToProbe(scope, sel, configured)`, `plannedReasoningProbeCount(levels, controlLevel)`, `probeReasoningLevels(levels, deps)`, `normaliseCapabilityRecord(record, engine)`, `reasoningSelectionFor(settings, modelId)`, `configuredReasoningFor(settings, modelId)`.
- `ModelTestDeps` loses W3c's `offeredLevels` (the pre-W5 `[CONFIGURED_LEVEL_KEY]` stand-in) and gains `reasoningSelection` and `configuredReasoning`. `plannedTestRequestCount`'s deps become `Pick<ModelTestDeps, 'configuredMode' | 'offeredModes' | 'reasoningSelection' | 'configuredReasoning'>`.
- Record semantics: `record.reasoning[level]` is `accepted | rejected`, written only when the control succeeded. `record.structuredOutput[mode][<reasoning level>]` replaces W3's `'configured'` key.

**Decisions this task encodes** (from the brief; recorded so review does not re-litigate):
- **Level probes copy the control.** W3c's control request uses no structured output (`off` mode, spec §2 / P7), a trivial prompt and the 256-token cap. A level probe is that request with only `reasoning` changed, so a 400 is attributable to the level alone. A level equal to the control's level is recorded `accepted` without a second request.
- **Which levels and modes.** `scope: 'configured'` probes the configured level; `scope: 'all'` probes every `testableReasoningLevels` entry. Structured-output modes are probed **at the configured level only** in both scopes (no mode × level cross product). A mode record under another level is simply absent, so the label never claims "not enforced" for an untested level. W3c's `off` check still sends nothing, because its request is the configured level's own probe (or the control).
- **A rejected configured level** skips the mode probes: nothing could be attributed.
- **Inconclusive probes (P7).** A level probe that fails with anything but a 400 (a 5xx after the transport's retries, a timeout, an unreachable server), or finishes other than `stop`, is inconclusive. It propagates, nothing is recorded, and the route answers 502, the same as W3c's mode probes. An abort rethrows.
- **Pre-W5 records.** W3 records keyed `'configured'` were taken at the engine's pre-W5 default level (Ollama `off`, others `model-default`), so they are re-keyed to that level on read instead of discarded.

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/capabilities.reasoning.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import {
  assertConfiguredCapabilitiesAllowed,
  isProbeRejected,
  ModelTestInconclusiveError,
  normaliseCapabilityRecord,
  plannedReasoningProbeCount,
  plannedTestRequestCount,
  probeReasoningLevels,
  reasoningLevelsToProbe,
  runModelTest,
  type ModelCapabilityRecord,
  type ModelTestDeps,
} from './capabilities.js';
import { AnalysisAbortedError, AnalyzerCapabilityRejectedError, AnalyzerHttpError } from './errors.js';
import { structuredOutputLabel } from './runner/schema-adapters.js';
import type { ChatTransport, TransportRequest, TransportResult } from './runner/transport.js';
import type { ReasoningLevel } from './reasoning.js';

const rec = (over: Partial<ModelCapabilityRecord> = {}): ModelCapabilityRecord => ({
  serverUrl: 'http://127.0.0.1:11434', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true },
  structuredOutput: {}, reasoning: {}, ...over,
});
const http400 = () => new AnalyzerHttpError('ollama', 400, '"q:4b" does not support thinking', 'Ollama returned 400');
const stop = (): TransportResult => ({ text: '{"ok":true}', reasoningSeen: false, finish: 'stop', receivedBytes: 11 });

describe('isProbeRejected', () => {
  it('is true only for a 400 from any transport', () => {
    expect(isProbeRejected(http400())).toBe(true);
    expect(isProbeRejected(Object.assign(new Error('INVALID_ARGUMENT'), { status: 400 }))).toBe(true);
    expect(isProbeRejected(new AnalyzerHttpError('openai', 500, '', 'boom'))).toBe(false);
    expect(isProbeRejected(new Error('fetch failed'))).toBe(false);
  });
});

describe('probeReasoningLevels', () => {
  it('records accepted / rejected and skips the control level', async () => {
    const send = vi.fn(async (level: ReasoningLevel): Promise<TransportResult> => {
      if (level === 'on' || level === 'low') throw http400();
      return stop();
    });
    const out = await probeReasoningLevels(['model-default', 'off', 'on', 'low', 'medium', 'high'], { modelId: 'q:4b', controlLevel: 'off', send });
    expect(out).toEqual({ 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'rejected', medium: 'accepted', high: 'accepted' });
    expect(send.mock.calls.map(([level]) => level)).toEqual(['model-default', 'on', 'low', 'medium', 'high']);
  });
  it('a non-400 failure propagates instead of being recorded (P7)', async () => {
    const send = vi.fn(async (): Promise<TransportResult> => { throw new AnalyzerHttpError('ollama', 500, '', 'boom'); });
    await expect(probeReasoningLevels(['on'], { modelId: 'q:4b', controlLevel: 'off', send })).rejects.toBeInstanceOf(AnalyzerHttpError);
  });
  it('a length finish is inconclusive, not accepted (P7)', async () => {
    const send = vi.fn(async (): Promise<TransportResult> => ({ text: '', reasoningSeen: true, finish: 'length', receivedBytes: 0 }));
    await expect(probeReasoningLevels(['on'], { modelId: 'q:4b', controlLevel: 'off', send })).rejects.toBeInstanceOf(ModelTestInconclusiveError);
  });
  it('rethrows an abort', async () => {
    const send = vi.fn(async (): Promise<TransportResult> => { throw new AnalysisAbortedError('gone'); });
    await expect(probeReasoningLevels(['on'], { modelId: 'q:4b', controlLevel: 'off', send })).rejects.toBeInstanceOf(AnalysisAbortedError);
  });
});

describe('runModelTest — level probes are the off-mode control with only reasoning changed', () => {
  it('sends the control at the engine default, the configured level as a copy of it, and nothing for the off check', async () => {
    const calls: TransportRequest[] = [];
    const transport: ChatTransport = {
      kind: 'ollama',
      model: 'q:4b',
      send: vi.fn(async (req: TransportRequest) => {
        calls.push(req);
        return stop();
      }),
    };
    const deps: ModelTestDeps = {
      transport,
      serverUrl: 'http://127.0.0.1:11434',
      configuredMode: 'off',
      offeredModes: ['schema', 'json', 'off'],
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
      reasoningSelection: () => ({ engine: 'local', model: 'q:4b' }),
      configuredReasoning: () => 'on',
      now: () => new Date('2026-09-11T10:00:00.000Z'),
    };
    const record = await runModelTest({ modelId: 'q:4b', scope: 'configured' }, deps);
    expect(calls).toHaveLength(plannedTestRequestCount({ modelId: 'q:4b', scope: 'configured' }, deps));
    expect(calls).toHaveLength(2);
    const { reasoning: controlLevel, ...control } = calls[0];
    const { reasoning: probeLevel, ...probe } = calls[1];
    expect([controlLevel, probeLevel]).toEqual(['off', 'on']);
    expect(control.structuredOutput).toEqual({ mode: 'off' });
    expect(probe).toEqual(control);
    expect(record.reasoning).toEqual({ on: 'accepted' });
    expect(record.structuredOutput).toEqual({ off: { on: 'accepted' } });
  });
});

describe('levels to probe and counts', () => {
  it('configured probes one level; all probes every testable level', () => {
    expect(reasoningLevelsToProbe('configured', { engine: 'local', model: 'q:4b' }, 'on')).toEqual(['on']);
    expect(reasoningLevelsToProbe('all', { engine: 'local', model: 'q:4b' }, 'off')).toEqual(['model-default', 'off', 'on', 'low', 'medium', 'high']);
    expect(plannedReasoningProbeCount(['model-default', 'off', 'on', 'low', 'medium', 'high'], 'off')).toBe(5);
    expect(plannedReasoningProbeCount(['model-default'], 'model-default')).toBe(0);
  });
});

describe('normaliseCapabilityRecord', () => {
  it('re-keys a pre-W5 "configured" probe to the engine default level', () => {
    const legacy = rec({ structuredOutput: { schema: { configured: 'ignored' } as Record<string, 'ignored'> } });
    expect(normaliseCapabilityRecord(legacy, 'local').structuredOutput).toEqual({ schema: { off: 'ignored' } });
    expect(normaliseCapabilityRecord(legacy, 'gemini').structuredOutput).toEqual({ schema: { 'model-default': 'ignored' } });
  });
});

describe('label reflects the configured level', () => {
  it('schema (not enforced) only for the level the probe ran at', () => {
    const r = rec({ structuredOutput: { schema: { on: 'ignored', off: 'enforced' } } });
    expect(structuredOutputLabel('schema', [], r, 'on')).toBe('schema (not enforced)');
    expect(structuredOutputLabel('schema', [], r, 'off')).toBe('schema');
    expect(structuredOutputLabel('schema', [], r, 'low')).toBe('schema');
  });
});

describe('assertConfiguredCapabilitiesAllowed', () => {
  it('refuses a rejected reasoning level', () => {
    const r = rec({ reasoning: { on: 'rejected', off: 'accepted' } });
    expect(() => assertConfiguredCapabilitiesAllowed(r, { structuredOutput: 'schema', reasoning: 'on' }, 'q:4b')).toThrow(AnalyzerCapabilityRejectedError);
    try {
      assertConfiguredCapabilitiesAllowed(r, { structuredOutput: 'schema', reasoning: 'on' }, 'q:4b');
    } catch (e) {
      expect((e as AnalyzerCapabilityRejectedError).setting).toBe('reasoning');
      expect((e as AnalyzerCapabilityRejectedError).value).toBe('on');
      expect((e as AnalyzerCapabilityRejectedError).testedAt).toBe('2026-09-11T10:00:00.000Z');
    }
    expect(() => assertConfiguredCapabilitiesAllowed(r, { structuredOutput: 'schema', reasoning: 'off' }, 'q:4b')).not.toThrow();
    expect(() => assertConfiguredCapabilitiesAllowed(r, { structuredOutput: 'schema', reasoning: 'low' }, 'q:4b')).not.toThrow();
    expect(() => assertConfiguredCapabilitiesAllowed(undefined, { structuredOutput: 'schema', reasoning: 'on' }, 'q:4b')).not.toThrow();
  });
  it('checks the structured-output record under the configured level', () => {
    const r = rec({ structuredOutput: { json: { on: 'rejected' } } });
    expect(() => assertConfiguredCapabilitiesAllowed(r, { structuredOutput: 'json', reasoning: 'on' }, 'q:4b')).toThrow(/json|structuredOutput/i);
    expect(() => assertConfiguredCapabilitiesAllowed(r, { structuredOutput: 'json', reasoning: 'off' }, 'q:4b')).not.toThrow();
  });
});
```

`server/src/routes/analyzer-models.reasoning.test.ts` (black-box through W3c's routes, against a real Ollama-shaped server that 400s on thinking exactly like Ollama does for a non-thinking model — research 06 §16):
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let server: Server;
let ollamaUrl: string;
let settings: typeof import('../workspace/user-settings.js');
const thinkValues: unknown[] = [];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'w5a-models-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  delete process.env.GEMINI_API_KEY;
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/tags')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'q:4b', model: 'q:4b' }] }));
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { think?: unknown }) : {};
      thinkValues.push('think' in body ? body.think : '<absent>');
      if (body.think === true || typeof body.think === 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '"q:4b" does not support thinking' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: '{"ok":true}' }, done: true, done_reason: 'stop' }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ollamaUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const [{ analyzerModelsRouter }, s] = await Promise.all([import('./analyzer-models.js'), import('../workspace/user-settings.js')]);
  settings = s;
  app = express();
  app.use(express.json());
  app.use('/api/analyzer', analyzerModelsRouter); // W3c's router defines /models, /models/test, /models/preview
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});
beforeEach(async () => {
  thinkValues.length = 0;
  settings._resetUserSettingsCache();
  await settings.writeUserSettings({ ollamaUrl, defaultAnalysisModel: 'q:4b' });
});

function findModelEntry(node: unknown, id: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) { for (const n of node) { const hit = findModelEntry(n, id); if (hit) return hit; } return undefined; }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.id === id) return o;
    for (const v of Object.values(o)) { const hit = findModelEntry(v, id); if (hit) return hit; }
  }
  return undefined;
}

describe('Test action — reasoning', () => {
  it('scope all records named levels rejected by a non-thinking Ollama model, only after a successful control', async () => {
    const res = await request(app).post('/api/analyzer/models/test').send({ modelId: 'q:4b', scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.control).toEqual({ ok: true });
    expect(res.body.reasoning).toEqual({ 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'rejected', medium: 'rejected', high: 'rejected' });
    expect(thinkValues[0]).toBe(false); // the control request runs at Ollama's default level
  });

  it('keys the schema probe by the configured level', async () => {
    await settings.writeUserSettings({ analyzerReasoningByEngine: { ollama: 'model-default' } });
    const res = await request(app).post('/api/analyzer/models/test').send({ modelId: 'q:4b', scope: 'configured' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.structuredOutput.schema ?? {})).toEqual(['model-default']);
  });

  it('the catalog offers named Ollama levels only after a Test accepted them', async () => {
    const before = await request(app).get('/api/analyzer/models?refresh=1');
    expect(findModelEntry(before.body, 'q:4b')?.offeredReasoningLevels).toEqual(['model-default', 'off', 'on']);
    settings._setUserSettingsCacheForTest({
      ...settings.getCachedUserSettings(),
      analyzerCapabilitiesByModel: {
        'q:4b': { serverUrl: ollamaUrl, testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: {}, reasoning: { low: 'accepted', high: 'rejected' } },
      },
    });
    const after = await request(app).get('/api/analyzer/models?refresh=1');
    expect(findModelEntry(after.body, 'q:4b')?.offeredReasoningLevels).toEqual(['model-default', 'off', 'on', 'low']);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/capabilities.reasoning.test.ts src/routes/analyzer-models.reasoning.test.ts`
Expected: FAIL — `does not provide an export named 'probeReasoningLevels'`; route test `expected {} to deeply equal { 'model-default': 'accepted', … }` (W3c leaves `reasoning` empty) and `offeredReasoningLevels` `undefined`.

- [ ] **Step 3: Implement**

`capabilities.ts` — W3c already imports `AnalysisAbortedError, AnalyzerCapabilityRejectedError, AnalyzerHttpError` from `./errors.js` and `ChatTransport, StructuredOutputMode, TransportRequest, TransportResult` from `./runner/transport.js`. Add these imports:
```ts
import {
  defaultReasoningLevel,
  resolveReasoningSetting,
  testableReasoningLevels,
  type ReasoningLevel,
  type ReasoningSelection,
} from './reasoning.js';
import { inferEngineFromModelId, parseEndpointModelId, type AnalysisEngine } from './model-id.js';
import { getResolvedOllamaUrl } from '../workspace/user-settings.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
```
Rename W3c's private `isHttp400` (Task 3c.4) to the exported `isProbeRejected` (same body), and change its one call in `checkMode`. Do not add a second copy:
```ts
/** A probe is `rejected` only on a 400 (AnalyzerHttpError from Ollama/OpenAI, or
    the Gemini SDK's ApiError status 400). */
export function isProbeRejected(err: unknown): boolean {
  if (err instanceof AnalyzerHttpError) return err.httpStatus === 400;
  return (err as { status?: unknown } | null)?.status === 400; // @google/genai ApiError
}
```
Then add the new exports:
```ts

export function reasoningLevelsToProbe(
  scope: 'configured' | 'all',
  sel: ReasoningSelection,
  configured: ReasoningLevel,
): ReasoningLevel[] {
  return scope === 'all' ? testableReasoningLevels(sel) : [configured];
}

export function plannedReasoningProbeCount(levels: readonly ReasoningLevel[], controlLevel: ReasoningLevel): number {
  return levels.filter((l) => l !== controlLevel).length;
}

/** Level probes (spec §2): `send(level)` must send W3c's off-mode control request with
    only `reasoning` changed (runModelTest passes `sendProbe(…, { mode: 'off' }, CONTROL_PROMPT,
    CONTROL_MAX_OUTPUT_TOKENS, level)`). */
export async function probeReasoningLevels(
  levels: readonly ReasoningLevel[],
  deps: {
    modelId: string;
    controlLevel: ReasoningLevel;
    send: (level: ReasoningLevel) => Promise<TransportResult>;
  },
): Promise<Partial<Record<ReasoningLevel, 'accepted' | 'rejected'>>> {
  const out: Partial<Record<ReasoningLevel, 'accepted' | 'rejected'>> = {};
  for (const level of levels) {
    if (level === deps.controlLevel) {
      out[level] = 'accepted'; // the control request already ran at this level
      continue;
    }
    let result: TransportResult;
    try {
      result = await deps.send(level);
    } catch (err) {
      if (isProbeRejected(err)) {
        out[level] = 'rejected';
        continue;
      }
      /* P7: an abort, a 5xx after the transport's retries, a timeout or an unreachable
         server proves nothing about the level. Propagate, so nothing is recorded. */
      throw err;
    }
    /* P7: a length/blocked finish is inconclusive too, never `accepted`. */
    requireStop(result, deps.modelId, 'off');
    out[level] = 'accepted';
  }
  return out;
}

/** Pre-W5 records keyed mode probes 'configured'; they ran at the engine's
    default level, so re-key them to it. */
export function normaliseCapabilityRecord(record: ModelCapabilityRecord, engine: AnalysisEngine): ModelCapabilityRecord {
  const structuredOutput: ModelCapabilityRecord['structuredOutput'] = {};
  for (const [mode, byLevel] of Object.entries(record.structuredOutput) as Array<[keyof ModelCapabilityRecord['structuredOutput'], Record<string, ProbeOutcome> | undefined]>) {
    if (!byLevel) continue;
    if (!('configured' in byLevel)) {
      structuredOutput[mode] = byLevel;
      continue;
    }
    const { configured, ...rest } = byLevel;
    structuredOutput[mode] = { [defaultReasoningLevel(engine)]: configured, ...rest };
  }
  return { ...record, structuredOutput, reasoning: record.reasoning ?? {} };
}
```

`capabilityRecordFor` — replace W3c's last line, `return stored && sameServer(stored.serverUrl, currentServerUrl) ? stored : undefined;`, with:
```ts
  return stored && sameServer(stored.serverUrl, currentServerUrl)
    ? normaliseCapabilityRecord(stored, inferEngineFromModelId(modelId))
    : undefined;
```

`assertConfiguredCapabilitiesAllowed` — replace W3c's function with the version below. `configured.reasoning` narrows to `ReasoningLevel`. The structured-output lookup is keyed by that level, falling back to W3's `CONFIGURED_LEVEL_KEY` for a caller that passes none. W3c's guard (`!record || !record.control.ok`) is kept.
```ts
export function assertConfiguredCapabilitiesAllowed(
  record: ModelCapabilityRecord | undefined,
  configured: { structuredOutput: StructuredOutputMode; reasoning: ReasoningLevel | undefined },
  modelId: string,
): void {
  if (!record || !record.control.ok) return;
  const level = configured.reasoning;
  if (level !== undefined && record.reasoning[level] === 'rejected') {
    throw new AnalyzerCapabilityRejectedError(modelId, 'reasoning', level, record.testedAt);
  }
  if (record.structuredOutput[configured.structuredOutput]?.[level ?? CONFIGURED_LEVEL_KEY] === 'rejected') {
    throw new AnalyzerCapabilityRejectedError(modelId, 'structuredOutput', configured.structuredOutput, record.testedAt);
  }
}
```

`sendProbe` — W3c's private `sendProbe(transport, structuredOutput, prompt, maxOutputTokens)` gains a fifth parameter, `reasoning: ReasoningLevel`, and sends it as `TransportRequest.reasoning` (Task 5.1):
```ts
function sendProbe(
  transport: ChatTransport,
  structuredOutput: TransportRequest['structuredOutput'],
  prompt: string,
  maxOutputTokens: number,
  reasoning: ReasoningLevel,
): Promise<TransportResult> {
  const approxChars = PROBE_SYSTEM.length + prompt.length + JSON.stringify(structuredOutput).length;
  return transport.send({
    system: PROBE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    structuredOutput,
    temperature: 0,
    maxOutputTokens,
    estimatedInputTokens: Math.ceil(approxChars / 4) + 50,
    call: {},
    reasoning,
  });
}
```

`checkMode` — W3c's `checkMode(modelId, mode, deps)` becomes `checkMode(modelId, mode, level: ReasoningLevel, deps)`. Its two `sendProbe(…)` calls pass `level` as the fifth argument, and its `isHttp400(err)` becomes `isProbeRejected(err)`. Its first statement, `if (mode === 'off') return 'accepted';`, stays. An off-mode check at `level` is exactly the request that level's probe already sent, or the control when `level` is the control's level.

`ModelTestDeps` — replace W3c's interface with the one below. W3c's `offeredLevels` is removed: modes are probed at the configured level only, so nothing multiplies by a level list.
```ts
export interface ModelTestDeps {
  transport: ChatTransport;
  serverUrl: string;
  configuredMode: StructuredOutputMode;
  offeredModes: readonly StructuredOutputMode[];
  adaptSchema: (draft07: Record<string, unknown>) => AdaptedSchema;
  /** Engine, bare model, endpoint and Test record for the id (reasoning.ts shape). */
  reasoningSelection: (modelId: string) => ReasoningSelection;
  /** The level the next run would send (resolveReasoningSetting). */
  configuredReasoning: (modelId: string) => ReasoningLevel;
  now?: () => Date;
  markerValue?: () => string;
  redact?: (text: string) => string;
}
```

`runModelTest` — replace W3c's function with:
```ts
export async function runModelTest(
  input: { modelId: string; scope: 'configured' | 'all' },
  deps: ModelTestDeps,
): Promise<ModelCapabilityRecord> {
  const redact = deps.redact ?? ((t: string) => t);
  const sel = deps.reasoningSelection(input.modelId);
  const controlLevel = defaultReasoningLevel(sel.engine);
  const configuredLevel = deps.configuredReasoning(input.modelId);
  const base = {
    serverUrl: deps.serverUrl,
    testedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  try {
    /* Control: no structured output (P7), at the engine's pre-W5 default level. */
    await sendProbe(deps.transport, { mode: 'off' }, CONTROL_PROMPT, CONTROL_MAX_OUTPUT_TOKENS, controlLevel);
  } catch (err) {
    if (err instanceof AnalysisAbortedError) throw err;
    const text = err instanceof Error ? err.message : String(err);
    return { ...base, control: { ok: false, error: redact(text).slice(0, 500) }, structuredOutput: {}, reasoning: {} };
  }
  const reasoning = await probeReasoningLevels(reasoningLevelsToProbe(input.scope, sel, configuredLevel), {
    modelId: input.modelId,
    controlLevel,
    send: (level) => sendProbe(deps.transport, { mode: 'off' }, CONTROL_PROMPT, CONTROL_MAX_OUTPUT_TOKENS, level),
  });
  const structuredOutput: ModelCapabilityRecord['structuredOutput'] = {};
  /* A rejected configured level leaves nothing a mode probe could be attributed to. */
  if (reasoning[configuredLevel] !== 'rejected') {
    const modes = input.scope === 'all' ? deps.offeredModes : [deps.configuredMode];
    for (const mode of modes) {
      structuredOutput[mode] = { [configuredLevel]: await checkMode(input.modelId, mode, configuredLevel, deps) };
    }
  }
  return { ...base, control: { ok: true }, structuredOutput, reasoning };
}
```

`plannedTestRequestCount` — replace W3c's function with:
```ts
export function plannedTestRequestCount(
  input: { modelId: string; scope: 'configured' | 'all' },
  deps: Pick<ModelTestDeps, 'configuredMode' | 'offeredModes' | 'reasoningSelection' | 'configuredReasoning'>,
): number {
  const sel = deps.reasoningSelection(input.modelId);
  const levels = reasoningLevelsToProbe(input.scope, sel, deps.configuredReasoning(input.modelId));
  const modes = input.scope === 'all' ? deps.offeredModes : [deps.configuredMode];
  /* The off-mode control; level probes other than the control's level; schema/json checks at
     the configured level (an off check sends nothing). A configured level the probes reject
     skips the checks, so this is the upper bound the confirmation shows. */
  return 1 + plannedReasoningProbeCount(levels, defaultReasoningLevel(sel.engine)) + modes.filter((mode) => mode !== 'off').length;
}
```

Selection helpers — add to `capabilities.ts`:
```ts
/** Engine, bare model, saved endpoint and Test record for a model id. */
export function reasoningSelectionFor(settings: UserSettings, modelId: string): ReasoningSelection & { endpoint?: AnalyzerEndpoint } {
  const engine = inferEngineFromModelId(modelId);
  if (engine !== 'openai') {
    return { engine, model: modelId, record: capabilityRecordFor(settings, modelId, engine === 'local' ? getResolvedOllamaUrl() : 'gemini') };
  }
  const parsed = parseEndpointModelId(modelId);
  const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
  return { engine, model: parsed?.model ?? modelId, endpoint, record: endpoint ? capabilityRecordFor(settings, modelId, endpoint.baseUrl) : undefined };
}

/** The reasoning level the next run of this model would send. */
export function configuredReasoningFor(settings: UserSettings, modelId: string): ReasoningLevel {
  const sel = reasoningSelectionFor(settings, modelId);
  return resolveReasoningSetting(settings, { engine: sel.engine, model: sel.model, endpoint: sel.endpoint });
}
```

`model-test-deps.ts` (`modelTestDepsFor`, W3c Task 3c.6) — replace `const offered = { offeredModes: ALL_STRUCTURED_OUTPUT_MODES, offeredLevels: [CONFIGURED_LEVEL_KEY] };` with:
```ts
  const offered = {
    offeredModes: ALL_STRUCTURED_OUTPUT_MODES,
    reasoningSelection: (id: string) => reasoningSelectionFor(settings, id),
    configuredReasoning: (id: string) => configuredReasoningFor(settings, id),
  };
```
Change its capabilities import to `import { ALL_STRUCTURED_OUTPUT_MODES, configuredReasoningFor, reasoningSelectionFor, type ModelTestDeps } from './capabilities.js';`. `routes/analyzer-models.ts` needs no change: its `POST /models/test` handler already passes `modelTestDepsFor(modelId, await readUserSettings())` to `runModelTest`.

`catalog/analyzer-catalog.ts` (W3c Task 3c.5):
- **ctx.** `toEntry`'s `ctx` parameter type gains `endpoint?: AnalyzerEndpoint`, and `endpointGroup` passes `endpoint` in its `toEntry` ctx literal.
- **New locals.** In `toEntry`, replace W3c's `const planDeps = { ...OFFERED, configuredMode: ctx.mode };` with:
```ts
  const sel = { engine: ctx.engine, model: raw.model, endpoint: ctx.endpoint, record: capability };
  const configuredLevel = resolveReasoningSetting(ctx.settings, sel);
  const planDeps = {
    configuredMode: ctx.mode,
    offeredModes: ALL_STRUCTURED_OUTPUT_MODES,
    reasoningSelection: () => sel,
    configuredReasoning: () => configuredLevel,
  };
```
- **Return object.**
  - The label becomes `structuredOutputLabel(ctx.mode, dropped, capability, configuredLevel)` instead of `CONFIGURED_LEVEL_KEY`.
  - Add `offeredReasoningLevels: offeredReasoningLevels(sel),`.
  - Both `testPlan` counts keep passing `planDeps` (now the reasoning-aware one).
- **Clean-up.** Delete the now-unused `OFFERED` constant and the `CONFIGURED_LEVEL_KEY` import. Import `offeredReasoningLevels, resolveReasoningSetting` from `../reasoning.js`.

Pre-run call sites — `runAnalyzerPreflight` (`server/src/analyzer/preflight.ts`, W3c Task 3c.10) has three `assertConfiguredCapabilitiesAllowed(` calls, each passing `reasoning: undefined`. Replace each with `reasoning: configuredReasoningFor(settings, target.modelId)`, using the `settings` and `target` already in scope there.

Updates to W3c's tests (the behaviour this task changes):
- **`capabilities.run-model-test.test.ts`.**
  - In its `deps()` helper, remove `offeredLevels: [CONFIGURED_LEVEL_KEY],`.
  - Add `reasoningSelection: () => ({ engine: 'openai', model: 'qwen3-30b', endpoint: { id: 'lab', name: 'Lab', reasoningStyle: 'not_controllable' } }),` and `configuredReasoning: () => 'model-default',`.
  - Drop `CONFIGURED_LEVEL_KEY` from its import.
  - Change every `configured:` key in its expected `structuredOutput` records to `'model-default':`.
  - Request counts do not change: `not_controllable` offers only `model-default`, which is the control's level.
- **`capabilities.test.ts`.** In `describe('plannedTestRequestCount')`, replace `deps` with `{ configuredMode: 'schema' as const, offeredModes: ALL_STRUCTURED_OUTPUT_MODES, reasoningSelection: () => ({ engine: 'local' as const, model: 'q:4b' }), configuredReasoning: () => 'off' as const }`. The expectations become 2 for configured and 8 for all: the control, the five testable levels other than `off`, and the schema and json checks. The `off` case stays 1.
- **`model-test-deps.test.ts`.** Replace `expect(d.offeredLevels).toEqual(['configured']);` with `expect(d.configuredReasoning('openai:lab::qwen3-30b')).toBe('model-default');` and `expect(d.reasoningSelection('openai:lab::qwen3-30b')).toMatchObject({ engine: 'openai', model: 'qwen3-30b', endpoint: { id: 'lab' } });`.
- **`catalog/analyzer-catalog.test.ts`.** In "attaches a Test record only while its serverUrl matches, and labels from it":
  - Replace `expect(entry.capability).toEqual(rec);` with `expect(entry.capability).toEqual({ ...rec, structuredOutput: { schema: { 'model-default': 'ignored' } } });`. The record is re-keyed on read, and the label still reads "schema (not enforced)".
  - Add `expect(entry.offeredReasoningLevels).toEqual(['model-default']);`.

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/capabilities.reasoning.test.ts src/routes/analyzer-models.reasoning.test.ts src/analyzer/capabilities.test.ts src/analyzer/capabilities.run-model-test.test.ts src/analyzer/model-test-deps.test.ts src/analyzer/catalog/analyzer-catalog.test.ts src/routes/analyzer-models.test.ts src/analyzer/preflight.test.ts`, then `npm run typecheck` and `npm run check:cycles`.
Expected: PASS. Keeps green: W3c's `analyzer-models.test.ts` (it mocks `runModelTest` and `modelTestDepsFor`) and `preflight.test.ts` (its records carry no reasoning, so `configuredReasoningFor` changes no outcome).

- [ ] **Step 5: Mutation proof**
1. In `probeReasoningLevels` replace the `if (isProbeRejected(err)) { out[level] = 'rejected'; continue; }` block with `out[level] = 'rejected'; continue;`. Expected red: `a non-400 failure propagates instead of being recorded (P7)`. Restore.
2. In `probeReasoningLevels` delete `requireStop(result, deps.modelId, 'off');`. Expected red: `a length finish is inconclusive, not accepted (P7)`. Restore.
3. In `runModelTest` change the level probe's `{ mode: 'off' }` (inside `send: (level) => …`) to `{ mode: 'json' }`. Expected red: `sends the control at the engine default, the configured level as a copy of it, and nothing for the off check`. Restore.
4. In `runModelTest` move the `probeReasoningLevels` call before the control request. Expected red: `scope all records named levels rejected … only after a successful control` (first think value is no longer `false`). Restore.
5. In `assertConfiguredCapabilitiesAllowed` delete the reasoning `throw`. Expected red: `refuses a rejected reasoning level`. Restore.
6. In `toEntry` replace `offeredReasoningLevels(sel)` with `offeredReasoningLevels({ engine: ctx.engine, model: raw.model })`. Expected red: `the catalog offers named Ollama levels only after a Test accepted them`. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/capabilities.ts server/src/analyzer/capabilities.reasoning.test.ts server/src/analyzer/capabilities.test.ts server/src/analyzer/capabilities.run-model-test.test.ts server/src/analyzer/model-test-deps.ts server/src/analyzer/model-test-deps.test.ts server/src/analyzer/catalog/analyzer-catalog.ts server/src/analyzer/catalog/analyzer-catalog.test.ts server/src/analyzer/preflight.ts server/src/routes/analyzer-models.reasoning.test.ts
git commit -m "feat(server): Test action probes reasoning levels and pre-run refuses a rejected level"
```

### Task 5.5: Failure copy names the actual reasoning control

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts` — W2's `AnalyzerReasoningOverflowError` branch in `classifyAnalysisFailure` (`:492` onward at `2b63b451`; W2 inserted it next to the `AnalyzerTruncatedError` branch at `:526-534`), and, only if Step 2 shows it red, W3's `AnalyzerCapabilityRejectedError` branch
- Test: `server/src/routes/failure-taxonomy.reasoning.test.ts`

**Interfaces:**
- Consumes: Task 5.1 `reasoningControlDescription`; `parseEndpointModelId` (W3); `getCachedUserSettings`, `_setUserSettingsCacheForTest`; `AnalyzerReasoningOverflowError(transport, model, reasoningTokens)` (W2); `AnalyzerCapabilityRejectedError` (W3).
- Produces: copy only. No new `FailureCode`.

- [ ] **Step 1: Write the failing test**

`server/src/routes/failure-taxonomy.reasoning.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { classifyAnalysisFailure } from './failure-taxonomy.js';
import { AnalyzerCapabilityRejectedError, AnalyzerReasoningOverflowError } from '../analyzer/errors.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

beforeEach(() => _resetUserSettingsCache());

describe('analyzer-reasoning-overflow names the reasoning control', () => {
  it('Ollama → the Ollama reasoning setting sent as think', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', 812), 'Ollama (qwen3.5:4b)');
    expect(f.code).toBe('analyzer-reasoning-overflow');
    expect(f.userMessage).toContain('the Ollama reasoning setting (Advanced settings → Analyzer request controls; sent as "think")');
  });
  it('Gemini 2.5 Flash → thinkingBudget, off sets it to 0', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', 'gemini-2.5-flash', 8192), 'Gemini 2.5 Flash');
    expect(f.userMessage).toContain('sent as thinkingBudget — "off" sets it to 0');
  });
  it('Gemini 3.6 Flash → thinkingLevel, cannot turn thinking off', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8192), 'Gemini 3.6 Flash');
    expect(f.userMessage).toContain('sent as thinkingLevel — this model cannot turn thinking off, the lowest level is minimal');
  });
  it('an endpoint id resolves the endpoint name and its control style', () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'any', contextTokens: 32768, reasoningStyle: 'enable_thinking', reasoning: 'on' })],
    });
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('openai', 'openai:lab::qwen3-30b', undefined), 'Lab box · qwen3-30b');
    expect(f.userMessage).toContain('the "Lab box" endpoint\'s Reasoning setting (sent as chat_template_kwargs.enable_thinking)');
  });
  it('a bare endpoint model falls back to generic endpoint wording', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('openai', 'qwen3-30b', undefined), 'qwen3-30b');
    expect(f.userMessage).toContain("this endpoint's Reasoning setting");
  });
});

describe('a pre-run refusal names the reasoning setting', () => {
  it('maps to analyzer-request-rejected and names the level and Test date', () => {
    const f = classifyAnalysisFailure(new AnalyzerCapabilityRejectedError('qwen3.5:4b', 'reasoning', 'on', '2026-09-11T10:00:00.000Z'), 'Ollama (qwen3.5:4b)');
    expect(f.code).toBe('analyzer-request-rejected');
    expect(f.userMessage).toMatch(/reasoning/i);
    expect(f.userMessage).toContain('"on"');
    expect(f.userMessage).toContain('2026-09-11');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/routes/failure-taxonomy.reasoning.test.ts`  Expected: the five overflow cases FAIL (`expected '<W2 message>' to contain 'the Ollama reasoning setting …'`). The pre-run refusal case may already PASS on W3's copy; if it does, leave W3's branch untouched in Step 3.

- [ ] **Step 3: Implement**

Add imports to `failure-taxonomy.ts` (after `:27`):
```ts
import { AnalyzerReasoningOverflowError, AnalyzerCapabilityRejectedError } from '../analyzer/errors.js';
import { reasoningControlDescription } from '../analyzer/reasoning.js';
import { parseEndpointModelId } from '../analyzer/model-id.js';
import { getCachedUserSettings } from '../workspace/user-settings.js';
```
(merge with W2/W3's existing imports of the same names). Add this helper above `classifyAnalysisFailure`:
```ts
/* #3084 wave 5 — which setting controls reasoning for the model that overflowed.
   An endpoint model id resolves its endpoint's name and control style from
   saved settings; a bare model id gets the generic endpoint wording. */
function reasoningControlFor(err: AnalyzerReasoningOverflowError): string {
  const parsed = err.transport === 'openai' ? parseEndpointModelId(err.model) : null;
  const endpoint = parsed ? getCachedUserSettings().analyzerEndpoints?.find((e) => e.id === parsed.endpointId) : undefined;
  return reasoningControlDescription(err.transport, { model: parsed?.model ?? err.model, endpoint });
}
```
In W2's `AnalyzerReasoningOverflowError` branch, replace the substring of the `userMessage` template that names the reasoning setting (W2 wrote a fixed phrase for it) with `${reasoningControlFor(err)}`; keep W2's max-output wording, `detail`, and code unchanged. The resulting message must read `… Lower reasoning in ${reasoningControlFor(err)}, or …<W2's max-output phrase>`.

Only if the pre-run refusal test is red, replace W3's `AnalyzerCapabilityRejectedError` branch with:
```ts
  if (err instanceof AnalyzerCapabilityRejectedError) {
    const setting = err.setting === 'reasoning' ? 'Reasoning' : 'Structured output';
    return withCopy(
      'analyzer-request-rejected',
      `${modelLabel} was not started: ${setting} "${err.value}" was recorded as rejected by this model's Test on ${err.testedAt.slice(0, 10)}. Choose another ${setting.toLowerCase()} setting, or run Test again.`,
      `setting=${err.setting} value=${err.value} testedAt=${err.testedAt}`,
    );
  }
```

- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/routes/failure-taxonomy.reasoning.test.ts src/routes/failure-taxonomy.test.ts`  Then: `npm run check:cycles`
Expected: PASS; no new cycle (if madge reports `failure-taxonomy → user-settings → …`, pass the endpoints in instead: give `classifyAnalysisFailure` no new import, and have `reasoningControlFor` take `endpoints` from a module-level `setFailureTaxonomySettingsReader(() => getCachedUserSettings())` registered in `server/src/index.ts` at boot — the test then registers it in `beforeEach`). Keeps green: `failure-taxonomy.test.ts` (sorted key list, W2/W3 cases).

- [ ] **Step 5: Mutation proof**
Replace `${reasoningControlFor(err)}` with W2's original fixed phrase. Expected red: all five `analyzer-reasoning-overflow names the reasoning control` cases. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy.reasoning.test.ts
git commit -m "fix(server): name the actual reasoning control in reasoning-overflow and pre-run refusal copy"
```

### Task 5.6: Settings UI — per-engine reasoning editor and endpoint-form reasoning fields

**Files:**
- Create: `src/lib/reasoning-levels.ts`, `src/lib/settings-issues.ts`, `src/components/settings/analyzer-request-controls.tsx`
- Modify: `src/views/advanced.tsx:497` (render the editor between the Reset-all row `:482-496` and `<SettingsAccordion` `:498`)
- Modify: W3d's endpoint form, `src/components/settings/analyzer-endpoints-section.tsx` (Task 3d.8: `AnalyzerEndpointsSection`, its `EndpointDraft` type, `draftFrom`, `validateEndpointDraft`, the `draft` / `setDraft` state and the `set(key, value)` setter, `saveError`) — adds reasoning-style and reasoning fields (3d.8 renders neither; `validateEndpointDraft` copies them from the saved endpoint today)
- Modify (harness only): `src/views/advanced.test.tsx:16-30` (api mock) and `:151-159` (`makeStore`), `src/test/a11y.test.tsx:55` (api mock object)
- Test: `src/lib/reasoning-levels.test.ts`, `src/lib/settings-issues.test.ts`, `src/components/settings/analyzer-request-controls.test.tsx`, `src/components/settings/analyzer-endpoints-section.test.tsx` (W3d Task 3d.8, append)

**Interfaces:**
- Consumes: `api.getAnalyzerModels` (W3c mock + real, operationId `getAnalyzerModels`); `saveAccountSettings` (`src/store/account-slice.ts:53-58`); `useAppDispatch`/`useAppSelector` (`src/store`); `engineForModelId` (`src/lib/model-id.ts`, W3a); generated `components['schemas']['ReasoningLevel']`; server fixture `server/src/analyzer/__fixtures__/reasoning-style-levels.json`.
- Produces: `levelsForEndpointStyle`, `REASONING_LEVEL_LABELS`, `REASONING_STYLE_LABELS`, `REASONING_HELP`, `collectCatalogModels` (`src/lib/reasoning-levels.ts`); `settingsIssueMessages` (`src/lib/settings-issues.ts`); `AnalyzerRequestControls` (PR 5b adds the payload half to the same component).

**Placement decision.** Advanced settings' sections are generated from `GET /api/config` registry groups (`advanced.tsx:498-636`), and neither setting is a registry knob. The editor therefore renders as its own card above the generated sections, not inside the `analyzer-models` group (which, in mock mode, is not guaranteed to exist). It reads the catalog through `collectCatalogModels`, typed on W3c's `AnalyzerCatalog` (master-contract shape: `groups[].{kind, id, label, status, error?, models[].{id, label, …, offeredReasoningLevels?}}`).

- [ ] **Step 1: Write the failing tests**

`src/lib/reasoning-levels.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import styleLevels from '../../server/src/analyzer/__fixtures__/reasoning-style-levels.json';
import { collectCatalogModels, levelsForEndpointStyle, REASONING_LEVEL_LABELS, type ReasoningStyle } from './reasoning-levels';
import type { AnalyzerCatalog } from './types';

describe('levelsForEndpointStyle', () => {
  it.each(Object.entries(styleLevels))('%s matches the server table', (style, levels) => {
    expect([...levelsForEndpointStyle(style as ReasoningStyle)]).toEqual(levels);
  });
  it('labels every level', () => {
    expect(Object.keys(REASONING_LEVEL_LABELS).sort()).toEqual(['high', 'low', 'medium', 'minimal', 'model-default', 'none', 'off', 'on']);
  });
});

describe('collectCatalogModels', () => {
  it('reads every catalog entry that carries offered levels, in group order, and skips entries and groups without them', () => {
    const body = {
      groups: [
        { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [{ id: 'q:4b', label: 'Qwen 4B', offeredReasoningLevels: ['model-default', 'off', 'on'] }] },
        { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok', models: [{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', offeredReasoningLevels: ['model-default', 'minimal'] }, { id: 'no-levels', label: 'no-levels' }] },
        { kind: 'endpoint', id: 'down', label: 'Down', status: 'error', error: 'connect ECONNREFUSED', models: [] },
      ],
    } as unknown as AnalyzerCatalog;
    expect(collectCatalogModels(null)).toEqual([]);
    expect(collectCatalogModels(body)).toEqual([
      { id: 'q:4b', label: 'Qwen 4B', offeredReasoningLevels: ['model-default', 'off', 'on'] },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', offeredReasoningLevels: ['model-default', 'minimal'] },
    ]);
  });
});
```

`src/lib/settings-issues.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { settingsIssueMessages } from './settings-issues';

describe('settingsIssueMessages', () => {
  it('extracts zod issue messages from a failed-save error', () => {
    const msg = 'User settings save failed (400): {"error":"Invalid user settings.","issues":[{"message":"A."},{"message":"B."}]}';
    expect(settingsIssueMessages(msg)).toEqual(['A.', 'B.']);
  });
  it('falls back to the body error, then the raw message', () => {
    expect(settingsIssueMessages('failed (400): {"error":"Invalid payload."}')).toEqual(['Invalid payload.']);
    expect(settingsIssueMessages('Network down')).toEqual(['Network down']);
    expect(settingsIssueMessages('')).toEqual([]);
  });
});
```

`src/components/settings/analyzer-request-controls.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { accountSlice } from '../../store/account-slice';
import { AnalyzerRequestControls } from './analyzer-request-controls';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: { getAnalyzerModels: vi.fn(), putUserSettings: vi.fn() },
}));
const mockModels = vi.mocked(api.getAnalyzerModels);
const mockPut = vi.mocked(api.putUserSettings);

const CATALOG = {
  groups: [
    { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [{ id: 'q:4b', label: 'Qwen 4B', offeredReasoningLevels: ['model-default', 'off', 'on', 'low'] }] },
    {
      kind: 'gemini',
      id: 'gemini',
      label: 'Gemini API',
      status: 'ok',
      models: [
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', offeredReasoningLevels: ['model-default', 'low', 'medium', 'high'] },
        { id: 'gemma-4-31b-it', label: 'Gemma 4 31B', offeredReasoningLevels: ['model-default', 'off', 'on'] },
        { id: 'gemini-9-ultra', label: 'Gemini 9 Ultra', offeredReasoningLevels: ['model-default'] },
      ],
    },
  ],
};

function renderControls() {
  const store = configureStore({ reducer: { account: accountSlice.reducer } });
  render(<Provider store={store}><AnalyzerRequestControls /></Provider>);
  return store;
}
const optionValues = (testId: string) =>
  within(screen.getByTestId(testId)).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);

beforeEach(() => {
  mockModels.mockReset().mockResolvedValue(CATALOG as never);
  mockPut.mockReset();
});

describe('AnalyzerRequestControls — reasoning', () => {
  it('offers only levels the catalog says each engine/model can take', async () => {
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-gemini-gemini-3.8-flash')).toBeInTheDocument());
    expect(optionValues('analyzer-reasoning-ollama')).toEqual(['model-default', 'off', 'on', 'low']);
    expect(optionValues('analyzer-reasoning-gemini-gemini-3.8-flash')).toEqual(['model-default', 'low', 'medium', 'high']);
    expect(optionValues('analyzer-reasoning-gemini-gemma-4-31b-it')).toEqual(['model-default', 'off', 'on']);
    expect(screen.queryByTestId('analyzer-reasoning-gemini-gemini-9-ultra')).toBeNull();
    expect((screen.getByTestId('analyzer-reasoning-ollama') as HTMLSelectElement).value).toBe('off');
    expect(screen.getByText(/A server may accept a level and still ignore it/)).toBeInTheDocument();
  });

  it('saves the Ollama level and non-default Gemini levels only', async () => {
    mockPut.mockResolvedValue({} as never);
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-gemini-gemini-3.8-flash')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('analyzer-reasoning-ollama'), { target: { value: 'on' } });
    fireEvent.change(screen.getByTestId('analyzer-reasoning-gemini-gemini-3.8-flash'), { target: { value: 'low' } });
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0][0]).toEqual({ analyzerReasoningByEngine: { ollama: 'on', gemini: { 'gemini-3.8-flash': 'low' } } });
  });

  it('shows the server validation messages when the save is refused', async () => {
    mockPut.mockRejectedValue(
      new Error('User settings save failed (400): {"error":"Invalid user settings.","issues":[{"message":"Gemini reasoning \\"minimal\\" is not available for gemini-3.8-flash (offered: model-default, low, medium, high)."}]}'),
    );
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-ollama')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    expect(await screen.findByTestId('analyzer-request-controls-errors')).toHaveTextContent(
      'Gemini reasoning "minimal" is not available for gemini-3.8-flash (offered: model-default, low, medium, high).',
    );
  });
});
```

Append to `src/components/settings/analyzer-endpoints-section.test.tsx` (W3d Task 3d.8). It already mocks `api` and renders the section with `renderSection()`; the editor opens on the `add-endpoint` button:
```tsx
describe('endpoint form — reasoning fields', () => {
  it('offers only the selected control style levels and resets an orphaned level', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    const style = screen.getByTestId('endpoint-reasoning-style');
    fireEvent.change(style, { target: { value: 'enable_thinking' } });
    const reasoning = screen.getByTestId('endpoint-reasoning') as HTMLSelectElement;
    expect([...reasoning.options].map((o) => o.value)).toEqual(['model-default', 'off', 'on']);
    fireEvent.change(reasoning, { target: { value: 'on' } });
    fireEvent.change(style, { target: { value: 'reasoning_effort' } });
    expect((screen.getByTestId('endpoint-reasoning') as HTMLSelectElement).value).toBe('model-default');
    expect([...(screen.getByTestId('endpoint-reasoning') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['model-default', 'none', 'minimal', 'low', 'medium', 'high']);
    expect(screen.getByText(/A server may accept a level and still ignore it/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm test -- src/lib/reasoning-levels.test.ts src/lib/settings-issues.test.ts src/components/settings/analyzer-request-controls.test.tsx`
Expected: FAIL with `Failed to resolve import "./reasoning-levels"` / `"./settings-issues"` / `"./analyzer-request-controls"`. The endpoint-form case fails with `Unable to find an element by: [data-testid="endpoint-reasoning-style"]` (or, if W3d already rendered the fields, on the option list).

- [ ] **Step 3: Implement**

`src/lib/reasoning-levels.ts`:
```ts
/* #3084 wave 5 — frontend view of reasoning levels. The per-model/per-record
   level sets are computed server-side and arrive as `offeredReasoningLevels`
   on catalog entries; only the endpoint control-style table lives here, pinned
   to the server's table by reasoning-levels.test.ts via the shared fixture. */
import type { components } from './api-types';
import type { AnalyzerCatalog } from './types';

export type ReasoningLevel = components['schemas']['ReasoningLevel'];
export type ReasoningStyle = 'reasoning_effort' | 'enable_thinking' | 'not_controllable';

const STYLE_LEVELS: Record<ReasoningStyle, readonly ReasoningLevel[]> = {
  reasoning_effort: ['model-default', 'none', 'minimal', 'low', 'medium', 'high'],
  enable_thinking: ['model-default', 'off', 'on'],
  not_controllable: ['model-default'],
};

export function levelsForEndpointStyle(style: ReasoningStyle): readonly ReasoningLevel[] {
  return STYLE_LEVELS[style];
}

export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  'model-default': 'Model default (send nothing)',
  off: 'Off',
  on: 'On',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const REASONING_STYLE_LABELS: Record<ReasoningStyle, string> = {
  reasoning_effort: 'reasoning_effort (llama.cpp, vLLM, OpenRouter)',
  enable_thinking: 'chat_template_kwargs.enable_thinking (templates that key on it)',
  not_controllable: 'Not controllable',
};

export const REASONING_HELP =
  'Only levels this model or endpoint can take are offered. A server may accept a level and still ignore it — Castwright cannot observe that. A level the Test action recorded as rejected refuses the run before it starts.';

export interface CatalogModelReasoning {
  id: string;
  label: string;
  offeredReasoningLevels: ReasoningLevel[];
}

/** Every entry of a GET /api/analyzer/models response (W3c `AnalyzerCatalog`, contract
    shape `groups[].models[]`) that carries `offeredReasoningLevels`, in group order. */
export function collectCatalogModels(catalog: Pick<AnalyzerCatalog, 'groups'> | null | undefined): CatalogModelReasoning[] {
  return (catalog?.groups ?? []).flatMap((group) =>
    group.models.flatMap((m) =>
      m.offeredReasoningLevels
        ? [{ id: m.id, label: m.label, offeredReasoningLevels: m.offeredReasoningLevels as ReasoningLevel[] }]
        : [],
    ),
  );
}
```

`src/lib/settings-issues.ts`:
```ts
/** Turn a rejected settings save (`… failed (400): {"error":…,"issues":[…]}`,
    the shape realPutUserSettings and the endpoint routes throw) into the
    server's own validation messages. */
export function settingsIssueMessages(message: string): string[] {
  const start = message.indexOf('{');
  if (start >= 0) {
    try {
      const body = JSON.parse(message.slice(start)) as { error?: string; issues?: Array<{ message?: string }> };
      const issues = (body.issues ?? []).map((i) => i.message).filter((m): m is string => typeof m === 'string' && m.length > 0);
      if (issues.length > 0) return issues;
      if (body.error) return [body.error];
    } catch {
      /* not a JSON body — fall through to the raw message */
    }
  }
  return message ? [message] : [];
}
```

`src/components/settings/analyzer-request-controls.tsx`:
```tsx
/* #3084 wave 5 — Advanced settings → Analyzer request controls. Reasoning per
   engine (Ollama: one level; Gemini: per model). Saves a PARTIAL patch through
   the account save thunk; server-side validation messages are shown verbatim. */
import { useEffect, useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { saveAccountSettings } from '../../store/account-slice';
import { api } from '../../lib/api';
import { engineForModelId } from '../../lib/model-id';
import {
  REASONING_HELP,
  REASONING_LEVEL_LABELS,
  collectCatalogModels,
  type CatalogModelReasoning,
  type ReasoningLevel,
} from '../../lib/reasoning-levels';
import { settingsIssueMessages } from '../../lib/settings-issues';

const SELECT_CLASS =
  'w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 min-h-[44px] fine-pointer:min-h-0';
const OLLAMA_BASE: ReasoningLevel[] = ['model-default', 'off', 'on'];

function unionLevels(base: ReasoningLevel[], models: CatalogModelReasoning[], current: ReasoningLevel): ReasoningLevel[] {
  const order: ReasoningLevel[] = ['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high'];
  const set = new Set<ReasoningLevel>([...base, current, ...models.flatMap((m) => m.offeredReasoningLevels)]);
  return order.filter((l) => set.has(l));
}

export function AnalyzerRequestControls() {
  const dispatch = useAppDispatch();
  const savedOllama = useAppSelector((s) => s.account.analyzerReasoningByEngine?.ollama);
  const savedGemini = useAppSelector((s) => s.account.analyzerReasoningByEngine?.gemini);
  const [models, setModels] = useState<CatalogModelReasoning[]>([]);
  const [ollama, setOllama] = useState<ReasoningLevel>(savedOllama ?? 'off');
  const [gemini, setGemini] = useState<Record<string, ReasoningLevel>>(savedGemini ?? {});
  const [errors, setErrors] = useState<string[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => setOllama(savedOllama ?? 'off'), [savedOllama]);
  useEffect(() => setGemini(savedGemini ?? {}), [savedGemini]);
  useEffect(() => {
    let cancelled = false;
    api
      .getAnalyzerModels()
      .then((body) => {
        if (!cancelled) setModels(collectCatalogModels(body));
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ollamaModels = useMemo(() => models.filter((m) => engineForModelId(m.id) === 'local'), [models]);
  const geminiModels = useMemo(
    () => models.filter((m) => engineForModelId(m.id) === 'gemini' && m.offeredReasoningLevels.length > 1),
    [models],
  );
  const ollamaLevels = unionLevels(OLLAMA_BASE, ollamaModels, ollama);

  const onSave = async () => {
    setErrors([]);
    const geminiPatch = Object.fromEntries(Object.entries(gemini).filter(([, level]) => level !== 'model-default'));
    const action = await dispatch(saveAccountSettings({ analyzerReasoningByEngine: { ollama, gemini: geminiPatch } }));
    if (saveAccountSettings.rejected.match(action)) {
      setErrors(settingsIssueMessages(action.error.message ?? ''));
      return;
    }
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 2400);
  };

  return (
    <section
      data-testid="analyzer-request-controls"
      className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card space-y-4"
    >
      <div>
        <h2 className="text-base font-semibold text-ink">Analyzer request controls</h2>
        <p className="mt-1 text-xs text-ink/55">{REASONING_HELP}</p>
      </div>

      <label className="block">
        <span className="block text-sm font-medium text-ink">Ollama reasoning</span>
        <span className="block text-xs text-ink/55 mt-0.5">
          One level for every Ollama model, sent as &quot;think&quot;. Off is today&apos;s default. Low / Medium / High appear once a model&apos;s Test accepted them; a model that doesn&apos;t think rejects On and every level.
        </span>
        <select
          data-testid="analyzer-reasoning-ollama"
          value={ollama}
          onChange={(e) => setOllama(e.target.value as ReasoningLevel)}
          className={`mt-2 ${SELECT_CLASS}`}
        >
          {ollamaLevels.map((l) => (
            <option key={l} value={l}>
              {REASONING_LEVEL_LABELS[l]}
            </option>
          ))}
        </select>
      </label>

      {geminiModels.length > 0 && (
        <div className="space-y-3">
          <span className="block text-sm font-medium text-ink">Gemini reasoning, per model</span>
          {geminiModels.map((m) => (
            <label key={m.id} className="block">
              <span className="block text-xs text-ink/70">{m.label}</span>
              <select
                data-testid={`analyzer-reasoning-gemini-${m.id}`}
                value={gemini[m.id] ?? 'model-default'}
                onChange={(e) => setGemini((g) => ({ ...g, [m.id]: e.target.value as ReasoningLevel }))}
                className={`mt-1 ${SELECT_CLASS}`}
              >
                {m.offeredReasoningLevels.map((l) => (
                  <option key={l} value={l}>
                    {REASONING_LEVEL_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {errors.length > 0 && (
        <ul data-testid="analyzer-request-controls-errors" className="text-xs text-rose-700 space-y-1">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-4">
        <button
          type="button"
          data-testid="analyzer-request-controls-save"
          onClick={() => void onSave()}
          className="px-4 py-2 rounded-xl bg-ink text-white text-sm font-medium min-h-[44px] fine-pointer:min-h-0"
        >
          Save request controls
        </button>
        {showSaved && <span className="text-xs text-magenta font-semibold">Saved.</span>}
      </div>
    </section>
  );
}
```

`src/views/advanced.tsx` — add `import { AnalyzerRequestControls } from '../components/settings/analyzer-request-controls';` and insert between the Reset-all `</div>` (`:496`) and `<SettingsAccordion` (`:498`):
```tsx
          <AnalyzerRequestControls />
```

`src/views/advanced.test.tsx` — add `getAnalyzerModels: vi.fn(() => Promise.resolve({ groups: [] })),` and `putUserSettings: vi.fn(),` to the `api` mock object (`:17-29`; wave 4 Task 4.7 already added `getAnalyzerModels` there, so keep its entry and add only `putUserSettings`); add `import { accountSlice } from '../store/account-slice';` and `account: accountSlice.reducer,` to `makeStore`'s reducer (`:153-157`).
`src/test/a11y.test.tsx` — add `getAnalyzerModels: () => Promise.resolve({ groups: [] }),` to the `api` object (`:55`; wave 4 already added it, so keep that entry if present).

W3d endpoint form: `src/components/settings/analyzer-endpoints-section.tsx` (Task 3d.8). 3d.8 renders no reasoning fields; its `validateEndpointDraft` copies `reasoningStyle` and `reasoning` from the saved endpoint (`original?.reasoningStyle ?? 'not_controllable'`, `original?.reasoning ?? 'model-default'`). Change it as follows:
- **Import.** Add `import { REASONING_HELP, REASONING_LEVEL_LABELS, REASONING_STYLE_LABELS, levelsForEndpointStyle, type ReasoningLevel, type ReasoningStyle } from '../../lib/reasoning-levels';` and `import { settingsIssueMessages } from '../../lib/settings-issues';`.
- **`EndpointDraft`.** Directly after `structuredOutput: Mode;`, add `reasoningStyle: ReasoningStyle;` and `reasoning: ReasoningLevel;`.
- **`draftFrom(e)`.** Directly after `structuredOutput: e?.structuredOutput ?? 'schema',`, add `reasoningStyle: e?.reasoningStyle ?? 'not_controllable',` and `reasoning: (e?.reasoning as ReasoningLevel | undefined) ?? 'model-default',`.
- **`validateEndpointDraft`.** In its `input` literal, replace `reasoningStyle: original?.reasoningStyle ?? 'not_controllable',` with `reasoningStyle: d.reasoningStyle,`, and `reasoning: original?.reasoning ?? 'model-default',` with `reasoning: d.reasoning,`.
- **`save()`.** In its `catch`, replace `setSaveError(refusalText(err));` with `setSaveError(settingsIssueMessages(refusalText(err)).join(' '));`, so the Task 5.2 endpoint validation messages show instead of a raw `… (400): {…}` body.
- **Fields.** In the editor grid, directly after the "Structured output" `FieldRow` (the one holding `data-testid="endpoint-structured-output"`), insert the block below. The style select writes through the section's `setDraft` updater, because a style change also resets an orphaned `reasoning`, which the single-key `set(key, value)` helper cannot do. The level select uses `set`.
```tsx
            <FieldRow label="Reasoning control" sublabel="How this server is told to reason. Pick the field your server reads; if it reads neither, choose Not controllable.">
              <select
                data-testid="endpoint-reasoning-style"
                value={draft.reasoningStyle}
                onChange={(e) => {
                  const reasoningStyle = e.target.value as ReasoningStyle;
                  setDraft((d) => ({
                    ...d,
                    reasoningStyle,
                    reasoning: levelsForEndpointStyle(reasoningStyle).includes(d.reasoning) ? d.reasoning : 'model-default',
                  }));
                }}
                className={INPUT}
              >
                {(Object.keys(REASONING_STYLE_LABELS) as ReasoningStyle[]).map((s) => (
                  <option key={s} value={s}>{REASONING_STYLE_LABELS[s]}</option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label="Reasoning" sublabel={REASONING_HELP}>
              <select
                data-testid="endpoint-reasoning"
                value={draft.reasoning}
                onChange={(e) => set('reasoning', e.target.value as ReasoningLevel)}
                className={INPUT}
              >
                {levelsForEndpointStyle(draft.reasoningStyle).map((l) => (
                  <option key={l} value={l}>{REASONING_LEVEL_LABELS[l]}</option>
                ))}
              </select>
            </FieldRow>
```

- [ ] **Step 4: Run and confirm they pass**
Run: `npm test -- src/lib/reasoning-levels.test.ts src/lib/settings-issues.test.ts src/components/settings/analyzer-request-controls.test.tsx src/views/advanced.test.tsx src/test/a11y.test.tsx src/components/settings/analyzer-endpoints-section.test.tsx`
Then: `npx playwright test --project=chromium e2e/advanced-settings.spec.ts e2e/advanced-settings-save-error.spec.ts e2e/analyzer-endpoints.spec.ts`
Expected: PASS. Keeps green: `advanced.test.tsx` (group/OverrideRow cases), `a11y.test.tsx` (axe on AdvancedView — the new selects are labelled by their wrapping `<label>`), both Advanced e2e specs, W3d's `analyzer-endpoints-section.test.tsx` cases and `e2e/analyzer-endpoints.spec.ts` (a new endpoint still saves `not_controllable` / `model-default` by default).

- [ ] **Step 5: Mutation proof**
1. In `AnalyzerRequestControls` replace `m.offeredReasoningLevels.map` with `(['model-default','minimal','low','medium','high'] as ReasoningLevel[]).map`. Expected red: `offers only levels the catalog says each engine/model can take`. Restore.
2. In `onSave` replace `setErrors(settingsIssueMessages(action.error.message ?? ''))` with `setErrors([])`. Expected red: `shows the server validation messages when the save is refused`. Restore.
3. In `AnalyzerEndpointsSection`'s `endpoint-reasoning-style` `onChange`, replace the `levelsForEndpointStyle(reasoningStyle).includes(d.reasoning) ? d.reasoning : 'model-default'` ternary with `d.reasoning`. Expected red: `offers only the selected control style levels and resets an orphaned level`. Restore.

- [ ] **Step 6: Commit**
```bash
git add src/lib/reasoning-levels.ts src/lib/reasoning-levels.test.ts src/lib/settings-issues.ts src/lib/settings-issues.test.ts src/components/settings/analyzer-request-controls.tsx src/components/settings/analyzer-request-controls.test.tsx src/components/settings/analyzer-endpoints-section.tsx src/components/settings/analyzer-endpoints-section.test.tsx src/views/advanced.tsx src/views/advanced.test.tsx src/test/a11y.test.tsx
git add $(git grep -ln "createAnalyzerEndpoint" src/components)
git commit -m "feat(frontend): offer only takeable reasoning levels in Advanced settings and the endpoint form"
```

### Task 5.7: Ship PR 5a

**Files:**
- Modify: `docs/release-notes-next.md` (section `## 🗣️ Analyzer, script review & manuscript`, `:284`), `RELEASE_NOTES.md` (top `# Castwright <in-progress version>` section)
- Modify: `docs/testing/onbox-acceptance-register.md` (Groups A, B, E + At-a-glance table), `docs/testing/onbox-acceptance-register-live-view.html`
- Modify: `docs/features/284-openai-compatible-analyzer.md` (the #3084 regression plan created in an earlier wave) — add the reasoning invariants

- [ ] **Step 1: Regenerate and check derived artifacts**
Run: `npm run openapi:types` then `git diff --exit-code src/lib/api-types.ts` — Expected: exit 0 (committed in Task 5.2). No registry knob is added in this PR, so `npm run config:check` must pass unchanged — run it.

- [ ] **Step 2: Release notes (both files)**
Append to `docs/release-notes-next.md` under `## 🗣️ Analyzer, script review & manuscript`:
```markdown
- **Reasoning controls for every analyzer engine (#3084, wave 5a).** New `analyzerReasoningByEngine` setting (Ollama: one level, default `off` = today's `think:false`; Gemini: per model, default `model-default`) and per-endpoint `reasoningStyle` / `reasoning`. Levels are offered per Gemini model (`thinkingLevel` for 3.x, `thinkingBudget` 0/1024/8192/24576 for 2.5, Gemma 4 on/off via HIGH/MINIMAL; never both fields), per endpoint style (`reasoning_effort` none…high, `chat_template_kwargs.enable_thinking`, not controllable), and for Ollama (`low`/`medium`/`high` only after a Test accepted them). The Test action probes reasoning levels (`accepted`/`rejected`, rejected only after a successful control), keys schema probes by level, and a `rejected` level refuses the run before its first call. Reasoning-overflow and pre-run refusal copy name the actual control. (#PR)
```
Add to the top section of `RELEASE_NOTES.md`:
```markdown
- **You can now tell each analyzer how hard to think.** Thinking models spend part of their answer budget reasoning before they write a word, and on a long chapter that can leave nothing for the answer. Advanced settings now has an analyzer reasoning control for Ollama and for each Gemini model, and every OpenAI-compatible endpoint has one too — offering only the levels that model or server can actually take. Nothing changes until you pick something: Ollama stays with thinking off, and everything else keeps its own default. The Test button now checks which levels a model accepts, and a level it refused stops a run before it starts instead of failing a chapter in. One honest caveat, shown right next to the setting: a server can accept a level and quietly ignore it, and Castwright has no way to see that.
```
Replace `(#PR)` with the PR number once opened.

- [ ] **Step 3: On-box acceptance rows (CLAUDE.md Before-shipping step 3)**
Allocate each ID from its group's `<!-- next-id: … -->` marker **at ship time** (never a hard-coded number) and bump the marker in the same commit. Add one row per group:
- **Group E** (no GPU box; needs a Gemini API key): *"#3084 5a — Gemini reasoning levels take effect."* Observe: Test (`scope: all`) on `gemini-3.6-flash`, `gemini-2.5-flash` and `gemma-4-31b-it` records every offered level `accepted`; a stage-2 chapter on `gemini-2.5-flash` at `off` reports `thoughtsTokenCount` 0 or absent in the server log's usage line, and at `high` reports > 0; `gemma-4-31b-it` at `off` vs `on` differs in thought tokens. Criteria: this plan Task 5.1 table + spec §8.
- **Group B** (local Ollama only): *"#3084 5a — Ollama reasoning levels and Test attribution."* Observe: on a non-thinking tag, Test `scope: all` records `on`/`low`/`medium`/`high` `rejected` and `off`/`model-default` `accepted`; on a thinking tag (e.g. `qwen3.5:4b`), `low` is `accepted` and then appears in Advanced settings' Ollama reasoning list; a run with a `rejected` level fails before the first chapter with the refusal copy naming the level and Test date.
- **Group A** (GPU box with llama-swap): *"#3084 5a — endpoint reasoning styles on llama-swap."* Observe: a `reasoning_effort` endpoint at `none` streams no `reasoning_content` deltas for a Qwen3.6 model and at `high` streams them (visible as `reasoningSeen` / the route heartbeat continuing before answer text); an `enable_thinking` endpoint at `off`/`on` shows the same split; the schema probe at `on` records `enforced` or `ignored` and the run label shows "schema (not enforced)" only for the level recorded `ignored`.
Update the At-a-glance `Rows` counts for A, B and E (+1 each), then run `npm run register:build` and `npm run check:onbox-register` (both must pass). Edit `docs/testing/onbox-acceptance-register-live-view.html` with the same three rows, then follow the register's "Live view" four-step procedure: save the page live at the recorded URL, run `npm run check:onbox-register -- --against-published <saved file>`, and publish **this html file** with that recorded `url` (never without it, never the `.md`).

- [ ] **Step 4: Plan doc**
In `docs/features/284-openai-compatible-analyzer.md`, add to its invariants section: levels offered per family/style (Task 5.1 table), defaults preserve today's wire, never both `thinkingLevel` and `thinkingBudget`, `rejected` only after a successful control, pre-run refusal of a `rejected` level, and the three register row IDs. Status stays `active`.

- [ ] **Step 5: Verify**
Run: `npm run typecheck`, `npm run check:cycles`, `npm run verify:fast:branch`  Expected: all PASS.

- [ ] **Step 6: Commit, push, PR, review gate**
```bash
git add docs/release-notes-next.md RELEASE_NOTES.md docs/testing/onbox-acceptance-register.md docs/testing/onbox-acceptance-register-live-view.html docs/features/284-openai-compatible-analyzer.md
git commit -m "docs(docs): release notes, on-box rows and plan invariants for analyzer reasoning controls"
git push -u origin feat/server,frontend-3084-w5a-reasoning
```
PR title: `feat(server,frontend,openapi): reasoning controls for every analyzer engine`. Body: `## Summary` (the release-notes-next entry), `## Test plan` (each task's test files, the mutation-proof red outputs from Tasks 5.1–5.6, the three register rows with their IDs), `Refs #3084`, and "Also fixed, found in passing: …" if any finding was fixed. Run the `pr-review-gate` skill at **high** depth (multi-scope); fold findings, re-review per the skill's loop.

---

### PR 5b — Custom request payload

- **Branch:** `feat/server,frontend-3084-w5b-payload` — `node scripts/wt-new.mjs feat/server,frontend-3084-w5b-payload`, cut after PR 5a merges.
- **Delivers:** `server/src/analyzer/runner/extra-params.ts` (validation, merge, temperature precedence, output-cap detection, redaction); `analyzerExtraParamsByEngine` (Ollama, Gemini) and endpoint `extraParams` validated on save; every transport merges the payload last; a payload temperature sets attempt 1 only; a payload output cap disables Auto and the label says so; payload string values ≥ 8 chars redacted from Ollama/OpenAI/Gemini error text and `formatErrorDetail`; payload never logged or persisted; editors in Advanced settings and the endpoint form; run label "+ custom params" with the e2e assertion; `Closes #3084`.
- **Must NOT change:** any request for a user with no payload (byte-identical bodies); reasoning or structured-output behaviour; the retry policies' own temperatures; persisted analyzer file formats.
- **Entry:** PR 5a merged.
- **Exit:** all tasks green; `npm run typecheck`, `npm run check:cycles`, `npm run verify:fast:branch`, `npx playwright test --project=chromium e2e/analyzer-endpoints.spec.ts` green; `pr-review-gate` at **high** depth; on-box rows added; issue #3084 closes on merge.

**Spec gaps this PR resolves (recorded, not re-litigated):**
- **Gemini top level.** Spec §9 lists protected keys only inside `config`. The SDK request's other top-level keys are `model` and `contents` (both pipeline-owned), and nothing else is a Gemini request field, so a Gemini payload may contain only `config`; any other top-level key is refused naming it.
- **`chat_template_kwargs` is merged key by key.** With `reasoningStyle: enable_thinking` the transport owns `chat_template_kwargs.enable_thinking` (a protected key). A top-level replace would silently delete it when a payload sets another template kwarg, so the OpenAI transport treats `chat_template_kwargs` as its owned container (merged key by key; `null` on the container refused), exactly like Ollama `options` / Gemini `config`.
- **Payload output cap on endpoints.** When a payload sets or nulls `max_tokens` or `max_completion_tokens`, the transport's own `max_tokens` is dropped before the merge — otherwise an OpenAI reasoning model receives both fields. For Ollama and Gemini the key-by-key merge already replaces or removes the native key.
- **Temperature precedence** is implemented by the runner removing the payload's temperature key from the attempt-2 request (`stripPayloadTemperature`), so the transport's native temperature — the retry policy's — stands. `TransportRequest` is unchanged.

### Task 5.8: `extra-params.ts` — validation, merge, temperature, output cap, redaction

**Files:**
- Create: `server/src/analyzer/runner/extra-params.ts`
- Create: `server/src/analyzer/__fixtures__/extra-params-cases.json`
- Test: `server/src/analyzer/runner/extra-params.test.ts`

**Interfaces:**
- Consumes: `TransportKind` (`errors.ts`).
- Produces: contract `validateExtraParams`, `mergeExtraParams`, `payloadControlsOutputCap`, `redactPayloadValues`, `PROTECTED_KEYS`; **new** `OWNED_CONTAINERS`, `stripPayloadTemperature(kind, params)`, `requestControlsLabelParts(kind, params)`, `configuredPayloadsForRedaction(settings)`, `resolveExtraParamsSetting(settings, sel)`, `REDACTION_MIN_LENGTH`, `REDACTED`.

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/__fixtures__/extra-params-cases.json`:
```json
[
  { "kind": "openai", "params": { "top_k": 40, "min_p": 0.05 }, "controlsOutputCap": false, "labelParts": ["+ custom params"] },
  { "kind": "openai", "params": { "max_completion_tokens": 4096 }, "controlsOutputCap": true, "labelParts": ["+ custom params", "max output set by custom params"] },
  { "kind": "openai", "params": { "max_tokens": null }, "controlsOutputCap": true, "labelParts": ["+ custom params", "max output set by custom params"] },
  { "kind": "ollama", "params": { "options": { "num_predict": 2048 } }, "controlsOutputCap": true, "labelParts": ["+ custom params", "max output set by custom params"] },
  { "kind": "ollama", "params": { "options": { "min_p": 0.05 }, "top_k": 40 }, "controlsOutputCap": false, "labelParts": ["+ custom params"] },
  { "kind": "gemini", "params": { "config": { "maxOutputTokens": null } }, "controlsOutputCap": true, "labelParts": ["+ custom params", "max output set by custom params"] },
  { "kind": "gemini", "params": { "config": { "topK": 40 } }, "controlsOutputCap": false, "labelParts": ["+ custom params"] },
  { "kind": "ollama", "params": {}, "controlsOutputCap": false, "labelParts": [] }
]
```

`server/src/analyzer/runner/extra-params.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import cases from '../__fixtures__/extra-params-cases.json' with { type: 'json' };
import {
  OWNED_CONTAINERS,
  PROTECTED_KEYS,
  REDACTED,
  configuredPayloadsForRedaction,
  mergeExtraParams,
  payloadControlsOutputCap,
  redactPayloadValues,
  requestControlsLabelParts,
  resolveExtraParamsSetting,
  stripPayloadTemperature,
  validateExtraParams,
} from './extra-params.js';
import type { TransportKind } from '../errors.js';

describe('PROTECTED_KEYS is exactly spec §9 (plus Gemini model/contents)', () => {
  it('per transport', () => {
    expect(PROTECTED_KEYS.openai).toEqual(['model', 'messages', 'stream', 'stream_options', 'n', 'stop', 'tools', 'tool_choice', 'response_format', 'reasoning_effort', 'grammar', 'json_schema']);
    expect(PROTECTED_KEYS.ollama).toEqual(['model', 'messages', 'stream', 'format', 'think', 'keep_alive', 'options.num_ctx', 'options.num_gpu', 'options.stop']);
    expect(PROTECTED_KEYS.gemini).toEqual(['model', 'contents', 'config.systemInstruction', 'config.abortSignal', 'config.responseMimeType', 'config.responseJsonSchema', 'config.responseSchema', 'config.thinkingConfig', 'config.tools', 'config.toolConfig', 'config.candidateCount', 'config.responseModalities']);
    expect(OWNED_CONTAINERS).toEqual({ ollama: ['options'], gemini: ['config'], openai: ['chat_template_kwargs'] });
  });
});

describe('validateExtraParams', () => {
  it('requires a JSON object', () => {
    for (const bad of [null, [], 'x', 3]) {
      expect(validateExtraParams('openai', bad, {})).toEqual({ ok: false, errors: ['Custom parameters must be a JSON object, for example {"top_k": 40}.'] });
    }
  });
  it('names every protected key it refuses', () => {
    expect(validateExtraParams('openai', { model: 'x', top_k: 40, stream: false }, {})).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: model, stream.'],
    });
    expect(validateExtraParams('ollama', { think: true, options: { num_ctx: 8192, min_p: 0.05 } }, {})).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: think, options.num_ctx.'],
    });
    expect(validateExtraParams('gemini', { config: { thinkingConfig: {}, topK: 40 } }, {})).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: config.thinkingConfig.'],
    });
  });
  it('protects chat_template_kwargs.enable_thinking only for the enable_thinking style', () => {
    const p = { chat_template_kwargs: { enable_thinking: true } };
    expect(validateExtraParams('openai', p, { reasoningStyle: 'reasoning_effort' }).ok).toBe(true);
    expect(validateExtraParams('openai', p, { reasoningStyle: 'enable_thinking' })).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: chat_template_kwargs.enable_thinking.'],
    });
  });
  it('refuses null on an owned container, allows null on keys inside it', () => {
    expect(validateExtraParams('ollama', { options: null }, {})).toEqual({ ok: false, errors: ['"options" cannot be null — it holds settings Castwright sends. Set or null individual keys inside it instead.'] });
    expect(validateExtraParams('gemini', { config: null }, {})).toEqual({ ok: false, errors: ['"config" cannot be null — it holds settings Castwright sends. Set or null individual keys inside it instead.'] });
    expect(validateExtraParams('openai', { chat_template_kwargs: null }, {})).toEqual({ ok: false, errors: ['"chat_template_kwargs" cannot be null — it holds settings Castwright sends. Set or null individual keys inside it instead.'] });
    expect(validateExtraParams('ollama', { options: { temperature: null, num_predict: 512 } }, {}).ok).toBe(true);
  });
  it('refuses a Gemini top-level key other than config', () => {
    expect(validateExtraParams('gemini', { topK: 40 }, {})).toEqual({ ok: false, errors: ['"topK" is not a Gemini request field — put generation options inside "config".'] });
  });
  it('accepts the reporter payloads unchanged', () => {
    const p = { top_k: 20, min_p: 0.05, presence_penalty: 1.5 };
    expect(validateExtraParams('openai', p, {})).toEqual({ ok: true, value: p });
  });
});

describe('mergeExtraParams', () => {
  it('replaces top-level keys, removes on null, and never mutates the native request', () => {
    const native = { model: 'm', temperature: 0.2, top_p: 1 };
    const out = mergeExtraParams('openai', native, { temperature: 0.9, top_p: null, top_k: 40 });
    expect(out).toEqual({ model: 'm', temperature: 0.9, top_k: 40 });
    expect(native).toEqual({ model: 'm', temperature: 0.2, top_p: 1 });
  });
  it('merges the owned container key by key', () => {
    const native = { model: 'q', options: { temperature: 0.2, num_ctx: 32768, num_gpu: 999, num_predict: -1 } };
    expect(mergeExtraParams('ollama', native, { options: { min_p: 0.05, num_predict: null } })).toEqual({
      model: 'q', options: { temperature: 0.2, num_ctx: 32768, num_gpu: 999, min_p: 0.05 },
    });
    expect(mergeExtraParams('gemini', { model: 'g', config: { temperature: 0.2, maxOutputTokens: 8192 } }, { config: { topK: 40 } })).toEqual({
      model: 'g', config: { temperature: 0.2, maxOutputTokens: 8192, topK: 40 },
    });
  });
  it('keeps the reasoning-owned enable_thinking when a payload adds another template kwarg', () => {
    expect(mergeExtraParams('openai', { chat_template_kwargs: { enable_thinking: false } }, { chat_template_kwargs: { add_generation_prompt: true } })).toEqual({
      chat_template_kwargs: { enable_thinking: false, add_generation_prompt: true },
    });
  });
  it('drops the native max_tokens when the payload controls the endpoint output cap', () => {
    expect(mergeExtraParams('openai', { max_tokens: 8192 }, { max_completion_tokens: 4096 })).toEqual({ max_completion_tokens: 4096 });
    expect(mergeExtraParams('openai', { max_tokens: 8192 }, { max_tokens: null })).toEqual({});
  });
  it('returns the native request unchanged with no payload', () => {
    const native = { model: 'm' };
    expect(mergeExtraParams('openai', native, undefined)).toBe(native);
  });
});

describe('stripPayloadTemperature', () => {
  it.each<[TransportKind, Record<string, unknown>, Record<string, unknown>]>([
    ['openai', { temperature: 0.9, top_k: 40 }, { top_k: 40 }],
    ['ollama', { options: { temperature: 0.9, min_p: 0.05 }, top_k: 1 }, { options: { min_p: 0.05 }, top_k: 1 }],
    ['gemini', { config: { temperature: 0.9, topK: 40 } }, { config: { topK: 40 } }],
    ['ollama', { options: { min_p: 0.05 } }, { options: { min_p: 0.05 } }],
  ])('%s removes only the temperature key', (kind, params, expected) => {
    const copy = structuredClone(params);
    expect(stripPayloadTemperature(kind, params)).toEqual(expected);
    expect(params).toEqual(copy);
  });
});

describe('output cap and label parts (shared case table)', () => {
  it.each(cases as Array<{ kind: TransportKind; params: Record<string, unknown>; controlsOutputCap: boolean; labelParts: string[] }>)(
    '$kind $params',
    ({ kind, params, controlsOutputCap, labelParts }) => {
      expect(payloadControlsOutputCap(kind, params)).toBe(controlsOutputCap);
      expect(requestControlsLabelParts(kind, params)).toEqual(labelParts);
    },
  );
  it('no payload → no cap, no label', () => {
    expect(payloadControlsOutputCap('openai', undefined)).toBe(false);
    expect(requestControlsLabelParts('openai', undefined)).toEqual([]);
  });
});

describe('redactPayloadValues', () => {
  it('redacts string values of 8+ characters anywhere in the payload, not shorter ones', () => {
    const params = { api_extra: 'sk-lab-0123456789', mode: 'json', nested: { list: ['tenant-alpha-7', 'auto'] } };
    const text = 'upstream said: key sk-lab-0123456789 for tenant-alpha-7 in json auto mode';
    expect(redactPayloadValues(text, params)).toBe(`upstream said: key ${REDACTED} for ${REDACTED} in json auto mode`);
  });
  it('redacts the JSON-escaped form of a value', () => {
    const params = { prompt_prefix: 'say "hello" now' };
    expect(redactPayloadValues('{"error":"bad value say \\"hello\\" now"}', params)).toBe(`{"error":"bad value ${REDACTED}"}`);
  });
  it('replaces the longest value first so a shorter overlapping value leaves no fragment', () => {
    expect(redactPayloadValues('abcdefghij', { a: 'abcdefgh', b: 'abcdefghij' })).toBe(REDACTED);
  });
  it('is a no-op without a payload', () => {
    expect(redactPayloadValues('text', undefined)).toBe('text');
  });
});

describe('settings helpers', () => {
  it('collects every configured payload for redaction', () => {
    expect(
      configuredPayloadsForRedaction({
        analyzerExtraParamsByEngine: { ollama: { a: 1 }, gemini: { config: { b: 2 } } },
        analyzerEndpoints: [{ extraParams: { c: 3 } }, {}],
      }),
    ).toEqual({ ollama: { a: 1 }, gemini: { config: { b: 2 } }, endpoints: [{ c: 3 }, {}] });
  });
  it('resolves the payload per engine and per endpoint', () => {
    const s = { analyzerExtraParamsByEngine: { ollama: { top_k: 1 }, gemini: { config: { topK: 2 } } } };
    expect(resolveExtraParamsSetting(s, { engine: 'local' })).toEqual({ top_k: 1 });
    expect(resolveExtraParamsSetting(s, { engine: 'gemini' })).toEqual({ config: { topK: 2 } });
    expect(resolveExtraParamsSetting(s, { engine: 'openai', endpoint: { extraParams: { top_k: 3 } } })).toEqual({ top_k: 3 });
    expect(resolveExtraParamsSetting({}, { engine: 'local' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/runner/extra-params.test.ts`  Expected: FAIL with `Failed to resolve import "./extra-params.js"`.

- [ ] **Step 3: Implement**

`server/src/analyzer/runner/extra-params.ts`:
```ts
/* #3084 wave 5 (D9, spec §9) — custom request payload. Pure: no settings,
   logging or I/O. Every structural parameter type is satisfied by UserSettings
   / AnalyzerEndpoint without importing them (workspace/analyzer-request-controls
   imports this module).

   Privacy contract (spec §9, plan Global Constraints): callers never log a
   payload and never write one to an analyzer file; every upstream error text
   passes through redactPayloadValues before it is logged, thrown or displayed. */
import type { TransportKind } from '../errors.js';

type ReasoningStyle = 'reasoning_effort' | 'enable_thinking' | 'not_controllable';
type Json = Record<string, unknown>;

export const REDACTION_MIN_LENGTH = 8;
export const REDACTED = '[redacted]';

/** The one container per transport that is merged key by key (never replaced). */
export const OWNED_CONTAINERS: Record<TransportKind, readonly string[]> = {
  ollama: ['options'],
  gemini: ['config'],
  openai: ['chat_template_kwargs'],
};

export const PROTECTED_KEYS: Record<TransportKind, readonly string[]> = {
  openai: ['model', 'messages', 'stream', 'stream_options', 'n', 'stop', 'tools', 'tool_choice', 'response_format', 'reasoning_effort', 'grammar', 'json_schema'],
  ollama: ['model', 'messages', 'stream', 'format', 'think', 'keep_alive', 'options.num_ctx', 'options.num_gpu', 'options.stop'],
  gemini: [
    'model', 'contents',
    'config.systemInstruction', 'config.abortSignal', 'config.responseMimeType', 'config.responseJsonSchema',
    'config.responseSchema', 'config.thinkingConfig', 'config.tools', 'config.toolConfig', 'config.candidateCount',
    'config.responseModalities',
  ],
};
const ENABLE_THINKING_KEY = 'chat_template_kwargs.enable_thinking';

const OUTPUT_CAP: Record<TransportKind, { container: string | null; keys: readonly string[] }> = {
  openai: { container: null, keys: ['max_tokens', 'max_completion_tokens'] },
  ollama: { container: 'options', keys: ['num_predict'] },
  gemini: { container: 'config', keys: ['maxOutputTokens'] },
};
const TEMPERATURE: Record<TransportKind, { container: string | null }> = {
  openai: { container: null },
  ollama: { container: 'options' },
  gemini: { container: 'config' },
};

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateExtraParams(
  kind: TransportKind,
  params: unknown,
  ctx: { reasoningStyle?: ReasoningStyle },
): { ok: true; value: Json } | { ok: false; errors: string[] } {
  if (!isPlainObject(params)) {
    return { ok: false, errors: ['Custom parameters must be a JSON object, for example {"top_k": 40}.'] };
  }
  const protectedSet = new Set(PROTECTED_KEYS[kind]);
  if (kind === 'openai' && ctx.reasoningStyle === 'enable_thinking') protectedSet.add(ENABLE_THINKING_KEY);
  const hits: string[] = [];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (protectedSet.has(key)) {
      hits.push(key);
      continue;
    }
    if (OWNED_CONTAINERS[kind].includes(key)) {
      if (value === null) {
        errors.push(`"${key}" cannot be null — it holds settings Castwright sends. Set or null individual keys inside it instead.`);
        continue;
      }
      if (!isPlainObject(value)) {
        errors.push(`"${key}" must be a JSON object.`);
        continue;
      }
      for (const inner of Object.keys(value)) {
        if (protectedSet.has(`${key}.${inner}`)) hits.push(`${key}.${inner}`);
      }
      continue;
    }
    if (kind === 'gemini') errors.push(`"${key}" is not a Gemini request field — put generation options inside "config".`);
  }
  if (hits.length > 0) errors.unshift(`These keys are controlled by Castwright and cannot be set here: ${hits.join(', ')}.`);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: params };
}

export function payloadControlsOutputCap(kind: TransportKind, params: Json | undefined): boolean {
  if (!params) return false;
  const { container, keys } = OUTPUT_CAP[kind];
  const scope = container === null ? params : params[container];
  return isPlainObject(scope) && keys.some((k) => Object.hasOwn(scope, k));
}

/** Merged LAST into the native request. Top-level keys replace; the owned
    container merges key by key; `null` removes a key (validation refuses `null`
    on the container itself). Never mutates `native`. */
export function mergeExtraParams(kind: TransportKind, native: Json, params: Json | undefined): Json {
  if (!params) return native;
  const out: Json = { ...native };
  if (kind === 'openai' && payloadControlsOutputCap(kind, params)) {
    delete out.max_tokens;
    delete out.max_completion_tokens;
  }
  for (const [key, value] of Object.entries(params)) {
    if (OWNED_CONTAINERS[kind].includes(key) && isPlainObject(value)) {
      const base: Json = isPlainObject(out[key]) ? { ...(out[key] as Json) } : {};
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (innerValue === null) delete base[innerKey];
        else base[innerKey] = innerValue;
      }
      out[key] = base;
      continue;
    }
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** The validation retry's request: the payload minus its temperature key, so
    the retry policy's temperature (the transport's native value) applies. */
export function stripPayloadTemperature(kind: TransportKind, params: Json | undefined): Json | undefined {
  if (!params) return params;
  const { container } = TEMPERATURE[kind];
  if (container === null) {
    if (!Object.hasOwn(params, 'temperature')) return params;
    const { temperature: _dropped, ...rest } = params;
    return rest;
  }
  const inner = params[container];
  if (!isPlainObject(inner) || !Object.hasOwn(inner, 'temperature')) return params;
  const { temperature: _dropped, ...restInner } = inner;
  return { ...params, [container]: restInner };
}

export function requestControlsLabelParts(kind: TransportKind, params: Json | undefined): string[] {
  if (!params || Object.keys(params).length === 0) return [];
  return payloadControlsOutputCap(kind, params) ? ['+ custom params', 'max output set by custom params'] : ['+ custom params'];
}

function collectRedactable(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.length >= REDACTION_MIN_LENGTH) {
      out.push(value);
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) out.push(escaped);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRedactable(v, out);
    return;
  }
  if (isPlainObject(value)) {
    for (const v of Object.values(value)) collectRedactable(v, out);
  }
}

export function redactPayloadValues(text: string, params: unknown): string {
  if (!text || params === undefined || params === null) return text;
  const values: string[] = [];
  collectRedactable(params, values);
  let out = text;
  for (const v of [...new Set(values)].sort((a, b) => b.length - a.length)) {
    out = out.split(v).join(REDACTED);
  }
  return out;
}

export function configuredPayloadsForRedaction(settings: {
  analyzerExtraParamsByEngine?: { ollama?: Json; gemini?: Json };
  analyzerEndpoints?: Array<{ extraParams?: Json }>;
}): Json {
  return {
    ollama: settings.analyzerExtraParamsByEngine?.ollama,
    gemini: settings.analyzerExtraParamsByEngine?.gemini,
    endpoints: (settings.analyzerEndpoints ?? []).map((e) => e.extraParams ?? {}),
  };
}

export function resolveExtraParamsSetting(
  settings: { analyzerExtraParamsByEngine?: { ollama?: Json; gemini?: Json } },
  sel: { engine: 'local' | 'gemini' | 'openai'; endpoint?: { extraParams?: Json } },
): Json | undefined {
  switch (sel.engine) {
    case 'local':
      return settings.analyzerExtraParamsByEngine?.ollama;
    case 'gemini':
      return settings.analyzerExtraParamsByEngine?.gemini;
    case 'openai':
      return sel.endpoint?.extraParams;
  }
}
```
(`configuredPayloadsForRedaction` is typed so its `toEqual` in the test sees `undefined`-valued keys; `toEqual` treats them as absent.)

- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/runner/extra-params.test.ts`  Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. In `validateExtraParams` delete `if (kind === 'openai' && ctx.reasoningStyle === 'enable_thinking') protectedSet.add(ENABLE_THINKING_KEY);`. Expected red: `protects chat_template_kwargs.enable_thinking only for the enable_thinking style`. Restore.
2. In `mergeExtraParams` change `OWNED_CONTAINERS[kind].includes(key) && isPlainObject(value)` to `false`. Expected red: `merges the owned container key by key` and `keeps the reasoning-owned enable_thinking …`. Restore.
3. In `redactPayloadValues` remove `.sort((a, b) => b.length - a.length)`. Expected red: `replaces the longest value first …`. Restore.
4. Change `REDACTION_MIN_LENGTH = 8` to `4`. Expected red: `redacts string values of 8+ characters anywhere in the payload, not shorter ones` (`json`/`auto` get blanked). Restore.
5. In `mergeExtraParams` delete the `payloadControlsOutputCap` block. Expected red: `drops the native max_tokens when the payload controls the endpoint output cap`. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/extra-params.ts server/src/analyzer/runner/extra-params.test.ts server/src/analyzer/__fixtures__/extra-params-cases.json
git commit -m "feat(server): custom payload validation, merge, temperature precedence and redaction"
```

### Task 5.9: Storage and save-time validation (`analyzerExtraParamsByEngine`, endpoint `extraParams`), OpenAPI, mocks

**Files:**
- Modify: `server/src/workspace/user-settings.ts` (schema after PR 5a's `analyzerReasoningByEngine`; `DEFAULT_USER_SETTINGS`)
- Modify: `server/src/workspace/analyzer-request-controls.ts` (both schemas from Task 5.2)
- Modify: `openapi.yaml` (`AnalyzerExtraParamsByEngine`; `UserSettings`, `UserSettingsPatch`; W3's `AnalyzerEndpoint.extraParams`); regenerate `src/lib/api-types.ts`
- Modify: `src/lib/api.ts` (`MOCK_USER_SETTINGS`, `mockPutUserSettings` whitelist)
- Test: `server/src/workspace/analyzer-request-controls.test.ts` (append), `server/src/routes/user-settings.test.ts` (append), `server/src/routes/analyzer-endpoints.test.ts` (append)

**Interfaces:**
- Consumes: Task 5.8 `validateExtraParams`; Task 5.2 schemas.
- Produces: `UserSettings.analyzerExtraParamsByEngine: { ollama?: Record<string, unknown>; gemini?: Record<string, unknown> }` (contract); save-time refusal with messages naming keys.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/workspace/analyzer-request-controls.test.ts`:
```ts
describe('analyzerRequestControlsPatchSchema — custom payload', () => {
  it('prefixes each validation error with the engine', () => {
    expect(
      messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerExtraParamsByEngine: { ollama: { options: { num_ctx: 8192 } }, gemini: { topK: 4 } } })),
    ).toEqual([
      'Ollama custom parameters: These keys are controlled by Castwright and cannot be set here: options.num_ctx.',
      'Gemini custom parameters: "topK" is not a Gemini request field — put generation options inside "config".',
    ]);
  });
  it('accepts valid payloads', () => {
    expect(messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerExtraParamsByEngine: { ollama: { options: { min_p: 0.05 } }, gemini: { config: { topK: 40 } } } }))).toEqual([]);
  });
});

describe('analyzerEndpointWriteSchema — custom payload', () => {
  it('validates extraParams against the endpoint reasoning style', () => {
    expect(messages(() => analyzerEndpointWriteSchema.parse({ ...baseEndpoint, reasoningStyle: 'enable_thinking', reasoning: 'off', extraParams: { chat_template_kwargs: { enable_thinking: true } } }))).toEqual([
      'Custom parameters: These keys are controlled by Castwright and cannot be set here: chat_template_kwargs.enable_thinking.',
    ]);
    expect(messages(() => analyzerEndpointWriteSchema.parse({ ...baseEndpoint, extraParams: { top_k: 20, min_p: 0.05, presence_penalty: 1.5 } }))).toEqual([]);
  });
});

describe('stored schema stays lenient for payloads', () => {
  it('loads a stored payload that a newer protected-key list would refuse', () => {
    const parsed = userSettingsSchema.safeParse({ ...DEFAULT_USER_SETTINGS, analyzerExtraParamsByEngine: { ollama: { think: true } } });
    expect(parsed.success).toBe(true);
    expect(DEFAULT_USER_SETTINGS.analyzerExtraParamsByEngine).toEqual({});
  });
});
```
Append to `server/src/routes/user-settings.test.ts`:
```ts
  it('PUT refuses a protected payload key and names it', async () => {
    const res = await request(app).put('/api/user/settings').send({ analyzerExtraParamsByEngine: { ollama: { keep_alive: -1 } } });
    expect(res.status).toBe(400);
    expect(res.body.issues.map((i: { message: string }) => i.message)).toEqual([
      'Ollama custom parameters: These keys are controlled by Castwright and cannot be set here: keep_alive.',
    ]);
  });
  it('PUT persists a valid payload and GET returns it', async () => {
    const payload = { ollama: { options: { min_p: 0.05 } }, gemini: { config: { topK: 40 } } };
    expect((await request(app).put('/api/user/settings').send({ analyzerExtraParamsByEngine: payload })).status).toBe(200);
    resetCache();
    expect((await request(app).get('/api/user/settings')).body.analyzerExtraParamsByEngine).toEqual(payload);
  });
```
Append to `server/src/routes/analyzer-endpoints.test.ts`:
```ts
  it('update refuses a protected endpoint payload key', async () => {
    await request(app).post('/api/analyzer/endpoints').send({ id: 'lab2', name: 'Lab 2', baseUrl: 'http://127.0.0.1:8082/v1', gpu: 'any', contextTokens: 32768 });
    const res = await request(app).put('/api/analyzer/endpoints/lab2').send({
      id: 'lab2', name: 'Lab 2', baseUrl: 'http://127.0.0.1:8082/v1', gpu: 'any', contextTokens: 32768, extraParams: { response_format: { type: 'text' } },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('cannot be set here: response_format');
  });
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/workspace/analyzer-request-controls.test.ts src/routes/user-settings.test.ts src/routes/analyzer-endpoints.test.ts`  Expected: FAIL — new cases get `[]` messages / `expected 200 to be 400`; the lenient-read case fails with `expected undefined to deeply equal {}`.

- [ ] **Step 3: Implement**

`user-settings.ts` schema, after `analyzerReasoningByEngine`:
```ts
  /* #3084 wave 5 — custom request payload per engine (endpoints carry their own
     `extraParams`). Lenient on read; protected-key rules run on write
     (analyzer-request-controls.ts). Never logged, never written to analyzer
     files. General PUT is the write path. */
  analyzerExtraParamsByEngine: z
    .object({
      ollama: z.record(z.string(), z.unknown()).optional(),
      gemini: z.record(z.string(), z.unknown()).optional(),
    })
    .default({}),
```
`DEFAULT_USER_SETTINGS`, after `analyzerReasoningByEngine: {},`:
```ts
  analyzerExtraParamsByEngine: {},
```

`analyzer-request-controls.ts` — add `import { validateExtraParams } from '../analyzer/runner/extra-params.js';`. Replace the patch schema's object with:
```ts
export const analyzerRequestControlsPatchSchema = z
  .object({
    analyzerReasoningByEngine: reasoningByEngineInput,
    analyzerExtraParamsByEngine: z
      .object({ ollama: z.unknown().optional(), gemini: z.unknown().optional() })
      .optional(),
  })
```
and append inside its `superRefine`, after the reasoning checks:
```ts
    const payloads = patch.analyzerExtraParamsByEngine;
    for (const [engineKey, kind, label] of [['ollama', 'ollama', 'Ollama'], ['gemini', 'gemini', 'Gemini']] as const) {
      const value = payloads?.[engineKey];
      if (value === undefined) continue;
      const result = validateExtraParams(kind, value, {});
      if (!result.ok) {
        for (const error of result.errors) {
          ctx.addIssue({ code: 'custom', path: ['analyzerExtraParamsByEngine', engineKey], message: `${label} custom parameters: ${error}` });
        }
      }
    }
```
(The first `if (!r) return;` in the reasoning half becomes `if (r) { …existing reasoning checks… }` so the payload checks still run when reasoning is absent.)
Append inside `analyzerEndpointWriteSchema`'s `superRefine`:
```ts
  if (endpoint.extraParams !== undefined) {
    const result = validateExtraParams('openai', endpoint.extraParams, { reasoningStyle: endpoint.reasoningStyle });
    if (!result.ok) {
      for (const error of result.errors) ctx.addIssue({ code: 'custom', path: ['extraParams'], message: `Custom parameters: ${error}` });
    }
  }
```

`openapi.yaml` — add next to `AnalyzerReasoningByEngine`:
```yaml
    AnalyzerExtraParamsByEngine:
      type: object
      properties:
        ollama:
          type: object
          additionalProperties: true
          description: Merged last into Ollama /api/chat; `options` merges key by key.
        gemini:
          type: object
          additionalProperties: true
          description: Only `config` is allowed; it merges key by key into the Gemini request config.
      description: |
        #3084 — custom request parameters per engine. Protected keys are refused
        on save with a message naming them; `null` removes a key but never an
        owned container. Never logged; string values of 8+ characters are
        redacted from upstream error text.
```
In `UserSettings.properties` and `UserSettingsPatch.properties`, after `analyzerReasoningByEngine`:
```yaml
        analyzerExtraParamsByEngine:
          $ref: '#/components/schemas/AnalyzerExtraParamsByEngine'
```
Confirm W3's `AnalyzerEndpoint.extraParams` is `type: object` + `additionalProperties: true`; if not, set it to exactly that with description `Custom request parameters merged last; protected keys refused on save.` Run `npm run openapi:types`.

`src/lib/api.ts` — `MOCK_USER_SETTINGS`: add `analyzerExtraParamsByEngine: {},` after `analyzerReasoningByEngine: {},`; `mockPutUserSettings`: add `analyzerExtraParamsByEngine,` to both the destructuring and the object literal after `analyzerReasoningByEngine,`. Confirm W3's mock endpoint create/update copies the whole request object (including `extraParams`); if it whitelists fields, add `extraParams`.

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/workspace/analyzer-request-controls.test.ts src/routes/user-settings.test.ts src/routes/analyzer-endpoints.test.ts src/workspace/user-settings.test.ts` then `npm run typecheck`  Expected: PASS.

- [ ] **Step 5: Mutation proof**
In the patch schema's payload loop replace `if (!result.ok)` with `if (false)`. Expected red: `PUT refuses a protected payload key and names it`. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/workspace/user-settings.ts server/src/workspace/analyzer-request-controls.ts server/src/workspace/analyzer-request-controls.test.ts server/src/routes/user-settings.test.ts server/src/routes/analyzer-endpoints.test.ts openapi.yaml src/lib/api-types.ts src/lib/api.ts
git commit -m "feat(server,openapi,mocks): store and validate custom analyzer request payloads"
```

### Task 5.10: Transports merge the payload last; runner applies temperature precedence; analyzers pass the payload

**Files:**
- Modify: `server/src/analyzer/transports/ollama-transport.ts` (streaming body **and** W4's non-streaming `sendFreeText` body), `gemini-transport.ts`, `openai-transport.ts` (request construction, after PR 5a's reasoning block)
- Modify: `server/src/analyzer/runner/stage-runner.ts` (the private `send` helper's `extraParams` entry, added by Task 5.1, plus a `stripTemperature` parameter)
- Modify: the settings closures in `OllamaAnalyzer`, `GeminiAnalyzer`, `OpenAIAnalyzer` (`server/src/analyzer/openai.ts`) (add an `extraParams:` entry)
- Test: `server/src/analyzer/transports/extra-params-wire.test.ts`, `server/src/analyzer/runner/payload-temperature.test.ts`

**Interfaces:**
- Consumes: Task 5.8 `mergeExtraParams`, `stripPayloadTemperature`, `resolveExtraParamsSetting`; `OLLAMA_RETRY_POLICY`, `OPENAI_RETRY_POLICY` (contract); `parseAndValidate` (`runner/parse.ts`).
- Produces: wire behaviour — payload merged after the native request and the reasoning fragment; attempt 2 of a validation retry sends the payload without its temperature key.

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/transports/extra-params-wire.test.ts` (same capture-server helpers as `reasoning-wire.test.ts` — copy `startCapture`, `dispatcher`, `OLLAMA_OK`, `OPENAI_OK`, `sseChunk`, the `beforeAll/beforeEach/afterEach` block verbatim from Task 5.3 Step 1; `req` gains an `extraParams` argument):
```ts
import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import type { GoogleGenAI } from '@google/genai';
import { OllamaTransport } from './ollama-transport.js';
import { OpenAITransport } from './openai-transport.js';
import { GeminiTransport } from './gemini-transport.js';
import { analyzerEndpointSchema } from '../../workspace/analyzer-endpoints.js';
import { geminiRateLimiter } from '../rate-limit.js';
import type { TransportRequest } from '../runner/transport.js';
import type { ReasoningLevel } from '../reasoning.js';

const OLLAMA_OK =
  JSON.stringify({ model: 'q:4b', message: { role: 'assistant', content: '{"ok":true}' }, done: false }) + '\n' +
  JSON.stringify({ model: 'q:4b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n';
const sseChunk = (delta: object, finish: string | null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const OPENAI_OK = sseChunk({ role: 'assistant', content: '{"ok":true}' }, null) + sseChunk({}, 'stop') + 'data: [DONE]\n\n';

let server: Server | null = null;
const bodies: Array<Record<string, unknown>> = [];
async function startCapture(contentType: string, payload: string): Promise<string> {
  server = createServer((r, res) => {
    let raw = '';
    r.on('data', (c) => (raw += c));
    r.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const dispatcher = () => new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });
const req = (extraParams: Record<string, unknown> | undefined, reasoning?: ReasoningLevel): TransportRequest => ({
  system: 'sys', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' },
  temperature: 0.2, maxOutputTokens: 8192, reasoning, extraParams, estimatedInputTokens: 10, call: {},
});

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
beforeEach(() => { bodies.length = 0; geminiRateLimiter._reset(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe('Ollama payload merge', () => {
  it('merges options key by key and keeps pipeline-owned options', async () => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req({ top_k: 40, options: { min_p: 0.05, num_predict: 1024 } }));
    const options = bodies[0].options as Record<string, unknown>;
    expect(bodies[0].top_k).toBe(40);
    expect(options.min_p).toBe(0.05);
    expect(options.num_predict).toBe(1024);
    expect(typeof options.num_ctx).toBe('number');
    expect(options.temperature).toBe(0.2);
  });
  it('the persona (free-text) call merges the payload too, keeping its own num_gpu and stream:false', async () => {
    const url = await startCapture('application/json', JSON.stringify({ message: { role: 'assistant', content: 'A warm voice.' }, done: true, done_reason: 'stop' }));
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send({
      ...req({ top_k: 40, options: { min_p: 0.05, temperature: 0.7 } }),
      freeText: { onCpu: true, keepAlive: 0 },
    });
    const options = bodies[0].options as Record<string, unknown>;
    expect(bodies[0].stream).toBe(false);
    expect(bodies[0].top_k).toBe(40);
    expect(options.min_p).toBe(0.05);
    expect(options.num_gpu).toBe(0);
    expect(options.temperature).toBe(0.7); // single attempt: the payload temperature applies
  });

  it('a request with no payload is byte-identical to one with an empty payload', async () => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    const t = new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() });
    await t.send(req(undefined));
    await t.send(req({}));
    expect(JSON.stringify(bodies[1])).toBe(JSON.stringify(bodies[0]));
  });
});

describe('OpenAI-compatible payload merge', () => {
  const endpointAt = (base: string, reasoningStyle: 'reasoning_effort' | 'enable_thinking') =>
    analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `${base}/v1`, gpu: 'none', contextTokens: 32768, reasoningStyle });
  it('sends the reporter payload and drops max_tokens when the payload sets max_completion_tokens', async () => {
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'reasoning_effort'), apiKey: null, model: 'm', dispatcher: dispatcher() })
      .send(req({ top_k: 20, min_p: 0.05, presence_penalty: 1.5, max_completion_tokens: 4096 }));
    expect(bodies[0]).toMatchObject({ top_k: 20, min_p: 0.05, presence_penalty: 1.5, max_completion_tokens: 4096 });
    expect('max_tokens' in bodies[0]).toBe(false);
  });
  it('keeps enable_thinking from the reasoning level when the payload adds template kwargs', async () => {
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'enable_thinking'), apiKey: null, model: 'm', dispatcher: dispatcher() })
      .send(req({ chat_template_kwargs: { add_generation_prompt: true } }, 'off'));
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false, add_generation_prompt: true });
  });
});

describe('Gemini payload merge', () => {
  it('merges config key by key; payload temperature wins on this request', async () => {
    const captured: Array<{ config: Record<string, unknown> }> = [];
    const client = {
      models: {
        generateContentStream: vi.fn(async (params: { config: Record<string, unknown> }) => {
          captured.push(params);
          return (async function* () { yield { text: '{"ok":true}', candidates: [{ finishReason: 'STOP' }] }; })();
        }),
      },
    } as unknown as GoogleGenAI;
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client }).send(req({ config: { topK: 40, temperature: 0.9 } }));
    expect(captured[0].config.topK).toBe(40);
    expect(captured[0].config.temperature).toBe(0.9);
    expect(captured[0].config.responseMimeType).toBe('application/json');
    expect(captured[0].config.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
```

`server/src/analyzer/runner/payload-temperature.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { z } from 'zod';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY, OPENAI_RETRY_POLICY, type ValidationRetryPolicy } from './retry-policy.js';
import { parseAndValidate } from './parse.js';
import { OllamaTransport } from '../transports/ollama-transport.js';
import { OpenAITransport } from '../transports/openai-transport.js';
import { analyzerEndpointSchema } from '../../workspace/analyzer-endpoints.js';
import type { ChatTransport } from './transport.js';

const hoisted = vi.hoisted(() => ({ dirName: `castwright-w5b-temp-${process.pid}-${Date.now()}` }));
vi.mock('../../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../../handoff/protocol.js')>();
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = join(tmpdir(), hoisted.dirName);
  await mkdir(dir, { recursive: true });
  return {
    ...actual,
    writeInbox: async (m: string, k: string, body: string) => { const p = join(dir, `${m}-${k}.inbox.md`); await writeFile(p, body); return p; },
    outboxPath: (m: string, k: string) => join(dir, `${m}-${k}.json`),
    errorPath: (m: string, k: string) => join(dir, `${m}-${k}.errors.json`),
    rawAttemptPath: (m: string, k: string, a: number) => join(dir, `${m}-${k}.attempt${a}.raw.txt`),
  };
});

const schema = z.object({ ok: z.literal(true) });
let server: Server | null = null;
const bodies: Array<Record<string, unknown>> = [];

async function startSequence(contentType: string, responses: string[]): Promise<string> {
  server = createServer((r, res) => {
    let raw = '';
    r.on('data', (c) => (raw += c));
    r.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(responses[bodies.length - 1]);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const ollamaText = (content: string) =>
  JSON.stringify({ message: { role: 'assistant', content }, done: false }) + '\n' +
  JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n';
const sseText = (content: string) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const dispatcher = () => new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });

function expectedRetryTemperature(policy: ValidationRetryPolicy): number {
  const failure = parseAndValidate('not json', schema);
  if (failure.ok) throw new Error('fixture must fail');
  return policy.buildRetry({ messages: [{ role: 'user', content: 'p' }], firstRaw: 'not json', failure }).temperature;
}
async function runWith(transport: ChatTransport, policy: ValidationRetryPolicy, extraParams: Record<string, unknown>) {
  const runner = new StageRunner({
    transport, policy,
    settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, reasoning: undefined, extraParams }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });
  await runner.runStage({ manuscriptId: 'm1', key: 'review-ch1', skillName: 'script_review', promptMd: 'p', grammarSchema: schema, validationSchema: schema }, {});
}

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
afterEach(async () => {
  bodies.length = 0;
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe('a payload temperature sets attempt 1 only', () => {
  it('Ollama policy: attempt 2 uses the retry policy temperature, other payload options survive', async () => {
    const url = await startSequence('application/x-ndjson', [ollamaText('not json'), ollamaText('{"ok":true}')]);
    await runWith(new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }), OLLAMA_RETRY_POLICY, { options: { temperature: 0.95, min_p: 0.05 } });
    const [first, second] = bodies.map((b) => b.options as Record<string, unknown>);
    expect(first.temperature).toBe(0.95);
    expect(second.temperature).toBe(expectedRetryTemperature(OLLAMA_RETRY_POLICY));
    expect(second.temperature).not.toBe(0.95);
    expect(second.min_p).toBe(0.05);
  });

  it('OpenAI policy: attempt 2 uses the retry policy temperature, other payload keys survive', async () => {
    const base = await startSequence('text/event-stream', [sseText('not json'), sseText('{"ok":true}')]);
    const endpoint = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `${base}/v1`, gpu: 'none', contextTokens: 32768 });
    await runWith(new OpenAITransport({ endpoint, apiKey: null, model: 'm', dispatcher: dispatcher() }), OPENAI_RETRY_POLICY, { temperature: 0.95, top_k: 20 });
    expect(bodies[0].temperature).toBe(0.95);
    expect(bodies[1].temperature).toBe(expectedRetryTemperature(OPENAI_RETRY_POLICY));
    expect(bodies[1].temperature).not.toBe(0.95);
    expect(bodies[1].top_k).toBe(20);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/transports/extra-params-wire.test.ts src/analyzer/runner/payload-temperature.test.ts`
Expected: FAIL — `expected undefined to be 40` (payload not merged); temperature tests `expected 0.2 to be 0.95`.

- [ ] **Step 3: Implement**

`ollama-transport.ts` — immediately after PR 5a's reasoning block, change the `body:` passed to `undiciFetch` from `JSON.stringify(body)` to `JSON.stringify(mergeExtraParams('ollama', body as Record<string, unknown>, req.extraParams))`, with `import { mergeExtraParams } from '../runner/extra-params.js';`. Make the identical change to the `undiciFetch(`${url}/api/chat`, { … body: JSON.stringify(body) … })` call inside W4's `sendFreeText` (the persona branch); its `options.num_gpu: 0` for `onCpu` survives because `options` merges key by key and `options.num_gpu` is a protected key no saved payload can contain.

`gemini-transport.ts` — build the SDK request object and merge it:
```ts
      const request = mergeExtraParams(
        'gemini',
        { model: this.model, contents, config: configWithReasoning },
        req.extraParams,
      ) as unknown as GenerateContentParameters;
      const stream = await this.client.models.generateContentStream(request);
```
where `configWithReasoning` is the expression PR 5a passed as `config:`; import `mergeExtraParams` and `type GenerateContentParameters` (`@google/genai`).

`openai-transport.ts` — after PR 5a's reasoning `Object.assign`, pass `mergeExtraParams('openai', params, req.extraParams)` to `client.chat.completions.create(…, { signal })` instead of `params`.

`stage-runner.ts` — Task 5.1 already forwards `extraParams: s.extraParams` in two places. One is the private `send` helper, which `runStage`'s two attempts and `runSingleAttempt` share; the other is `runFreeText`. Only the validation retry must strip the payload temperature:
- give the helper a seventh parameter, `stripTemperature = false`;
- change its `extraParams` entry to:
```ts
      /* D9: a payload temperature sets attempt 1 only; on the validation retry
         the retry policy's temperature (req.temperature, applied natively) must win. */
      extraParams: stripTemperature ? stripPayloadTemperature(this.transport.kind, s.extraParams) : s.extraParams,
```
- pass `true` as the seventh argument only at `runStage`'s validation-retry call: `this.send(system, retry.messages, retry.temperature, structuredOutput, call, true, true)`.

`runSingleAttempt` and `runFreeText` are single attempts, so they keep the full payload. Import `stripPayloadTemperature` from `./extra-params.js`.

Settings closures: add an `extraParams:` entry to each. No wave 1–4 closure sets it, W3b's `OpenAIAnalyzer` included.
- `OllamaAnalyzer`: `extraParams: resolveExtraParamsSetting(getCachedUserSettings(), { engine: 'local' }),`
- `GeminiAnalyzer`: `extraParams: resolveExtraParamsSetting(getCachedUserSettings(), { engine: 'gemini' }),`
- `OpenAIAnalyzer`: `extraParams: resolveExtraParamsSetting(getCachedUserSettings(), { engine: 'openai', endpoint: opts.endpoint }),`
(import `resolveExtraParamsSetting` from `./runner/extra-params.js`).

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/transports src/analyzer/runner src/analyzer/ollama.test.ts src/analyzer/voice-style.test.ts` and `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`  Expected: PASS. Keeps green: every W1–W4 transport/runner suite (no payload → `mergeExtraParams` returns the native object), PR 5a's `reasoning-wire.test.ts`.

- [ ] **Step 5: Mutation proof**
1. In `stage-runner.ts` pass `false` instead of `true` as the seventh argument at `runStage`'s validation-retry `this.send(…)` call. Expected red: both `a payload temperature sets attempt 1 only` cases. Restore.
2. In `ollama-transport.ts` pass `JSON.stringify(body)` again in the streaming call. Expected red: `merges options key by key and keeps pipeline-owned options`. Restore.
2b. Same revert in `sendFreeText` only. Expected red: `the persona (free-text) call merges the payload too, keeping its own num_gpu and stream:false`. Restore.
3. In `extra-params.ts` change `OWNED_CONTAINERS.openai` to `[]` (so `chat_template_kwargs` is replaced wholesale). Expected red: `keeps enable_thinking from the reasoning level when the payload adds template kwargs`. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports server/src/analyzer/runner/stage-runner.ts server/src/analyzer/runner/payload-temperature.test.ts server/src/analyzer/ollama.ts server/src/analyzer/gemini.ts server/src/analyzer/openai.ts
git commit -m "feat(server): merge the custom payload last on every transport; retry temperature wins on attempt 2"
```

### Task 5.11: Redact payload values from upstream error text; prove the payload is never logged or persisted

**Files:**
- Modify: `server/src/analyzer/transports/ollama-transport.ts` — the streaming non-OK branch (moved from `ollama.ts:709-716`), the in-stream `parsed.error` branch (moved from `ollama.ts:792-794`), and W4's `sendFreeText` non-OK branch (the persona call's `if (!response.ok)`)
- Modify: `server/src/analyzer/transports/openai-transport.ts` — every `new AnalyzerHttpError(` (classification steps 4 and 5, research 04 "Consequences")
- Modify: `server/src/analyzer/transports/gemini-transport.ts` — the generic `catch` logging block (moved from `gemini.ts:844-861`)
- Modify: `server/src/routes/failure-taxonomy.ts:410-427` (`formatErrorDetail`, both `return` statements)
- Test: `server/src/analyzer/runner/extra-params-privacy.test.ts`

**Interfaces:**
- Consumes: Task 5.8 `redactPayloadValues`, `configuredPayloadsForRedaction`, `REDACTED`; `classifyAnalysisFailure` (`failure-taxonomy.ts:492`); `getCachedUserSettings`, `_setUserSettingsCacheForTest`.
- Produces: the privacy guarantee — no payload value (≥ 8 chars) in any `console.*` call, thrown error message, `AnalyzerHttpError.bodyExcerpt`, failure `userMessage`/`detail`, or file the analyzer writes.

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/runner/extra-params-privacy.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { z } from 'zod';
import type { GoogleGenAI } from '@google/genai';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY, OPENAI_RETRY_POLICY } from './retry-policy.js';
import { REDACTED } from './extra-params.js';
import { OllamaTransport } from '../transports/ollama-transport.js';
import { OpenAITransport } from '../transports/openai-transport.js';
import { GeminiTransport } from '../transports/gemini-transport.js';
import { AnalyzerHttpError } from '../errors.js';
import { geminiRateLimiter } from '../rate-limit.js';
import { analyzerEndpointSchema } from '../../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../../workspace/user-settings.js';
import { classifyAnalysisFailure } from '../../routes/failure-taxonomy.js';
import type { ChatTransport, TransportRequest } from './transport.js';

const SENTINEL = 'cw-sentinel-9f3a7c21';
const hoisted = vi.hoisted(() => ({ dirName: `castwright-w5b-privacy-${process.pid}-${Date.now()}` }));
const HANDOFF_DIR = join(tmpdir(), hoisted.dirName);
vi.mock('../../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../../handoff/protocol.js')>();
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const dir = path.join(os.tmpdir(), hoisted.dirName);
  await fs.mkdir(dir, { recursive: true });
  return {
    ...actual,
    writeInbox: async (m: string, k: string, body: string) => { const p = path.join(dir, `${m}-${k}.inbox.md`); await fs.writeFile(p, body); return p; },
    outboxPath: (m: string, k: string) => path.join(dir, `${m}-${k}.json`),
    errorPath: (m: string, k: string) => path.join(dir, `${m}-${k}.errors.json`),
    rawAttemptPath: (m: string, k: string, a: number) => path.join(dir, `${m}-${k}.attempt${a}.raw.txt`),
  };
});

const schema = z.object({ ok: z.literal(true) });
const spec = { manuscriptId: 'm1', key: 'review-ch1' as const, skillName: 'script_review' as const, promptMd: 'p', grammarSchema: schema, validationSchema: schema };
let server: Server | null = null;
const rawBodies: string[] = [];
let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

async function startServer(handler: (raw: string, n: number) => { status: number; type: string; body: string }): Promise<string> {
  server = createServer((r, res) => {
    let raw = '';
    r.on('data', (c) => (raw += c));
    r.on('end', () => {
      rawBodies.push(raw);
      const out = handler(raw, rawBodies.length);
      res.writeHead(out.status, { 'Content-Type': out.type });
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const dispatcher = () => new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });
const ollamaText = (content: string) =>
  JSON.stringify({ message: { role: 'assistant', content }, done: false }) + '\n' +
  JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n';

function everythingLogged(): string {
  return consoleSpies
    .flatMap((s) => s.mock.calls)
    .map((args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .join('\n');
}
function everythingPersisted(): string {
  return readdirSync(HANDOFF_DIR).map((f) => readFileSync(join(HANDOFF_DIR, f), 'utf8')).join('\n');
}
const runnerFor = (transport: ChatTransport, policy = OLLAMA_RETRY_POLICY, extraParams: Record<string, unknown>) =>
  new StageRunner({
    transport, policy,
    settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, reasoning: undefined, extraParams }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
beforeEach(() => {
  rawBodies.length = 0;
  _resetUserSettingsCache();
  geminiRateLimiter._reset();
  rmSync(HANDOFF_DIR, { recursive: true, force: true });
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(async () => {
  consoleSpies.forEach((s) => s.mockRestore());
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe('the custom payload is never logged or persisted', () => {
  it('a stage with a validation retry sends the payload but writes and logs none of it', async () => {
    const url = await startServer((_raw, n) => ({ status: 200, type: 'application/x-ndjson', body: ollamaText(n === 1 ? 'not json' : '{"ok":true}') }));
    const payload = { user_tag: SENTINEL, options: { note: SENTINEL } };
    await runnerFor(new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }), OLLAMA_RETRY_POLICY, payload).runStage(spec, {});
    expect(rawBodies.every((b) => b.includes(SENTINEL))).toBe(true); // the payload really was on the wire
    expect(readdirSync(HANDOFF_DIR).length).toBeGreaterThan(0); // inbox, raw attempt, errors and response were written
    expect(everythingPersisted()).not.toContain(SENTINEL);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it('Ollama: a 400 that echoes the request is redacted in the error, the log, and the failure copy', async () => {
    const url = await startServer((raw) => ({ status: 400, type: 'application/json', body: JSON.stringify({ error: `invalid options in ${raw}` }) }));
    const payload = { user_tag: SENTINEL };
    _setUserSettingsCacheForTest({ analyzerExtraParamsByEngine: { ollama: payload } });
    const err = await runnerFor(new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }), OLLAMA_RETRY_POLICY, payload)
      .runStage(spec, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect((err as AnalyzerHttpError).message).not.toContain(SENTINEL);
    expect((err as AnalyzerHttpError).bodyExcerpt).not.toContain(SENTINEL);
    expect((err as AnalyzerHttpError).message).toContain(REDACTED);
    const failure = classifyAnalysisFailure(err, 'Ollama (q:4b)');
    expect(`${failure.userMessage}\n${failure.detail ?? ''}`).not.toContain(SENTINEL);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it('Ollama persona (free-text) call: a 400 that echoes the request is redacted', async () => {
    const url = await startServer((raw) => ({ status: 400, type: 'application/json', body: JSON.stringify({ error: `invalid options in ${raw}` }) }));
    const req: TransportRequest = {
      system: '', messages: [{ role: 'user', content: 'persona please' }], structuredOutput: { mode: 'off' },
      temperature: 0.2, extraParams: { user_tag: SENTINEL }, estimatedInputTokens: 5, call: {}, freeText: { onCpu: false, keepAlive: 0 },
    };
    const err = await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect(rawBodies[0]).toContain(SENTINEL);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect(`${(err as AnalyzerHttpError).message}\n${(err as AnalyzerHttpError).bodyExcerpt}`).not.toContain(SENTINEL);
    expect((err as AnalyzerHttpError).message).toContain(REDACTED);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it('OpenAI-compatible: a 400 naming the parameter value is redacted', async () => {
    const base = await startServer(() => ({
      status: 400, type: 'application/json',
      body: JSON.stringify({ error: { message: `unsupported parameter user_tag=${SENTINEL}`, type: 'invalid_request_error' } }),
    }));
    const endpoint = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `${base}/v1`, gpu: 'none', contextTokens: 32768, extraParams: { user_tag: SENTINEL } });
    const req: TransportRequest = { system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2, extraParams: { user_tag: SENTINEL }, estimatedInputTokens: 5, call: {} };
    const err = await new OpenAITransport({ endpoint, apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect(`${(err as AnalyzerHttpError).message}\n${(err as AnalyzerHttpError).bodyExcerpt}`).not.toContain(SENTINEL);
    expect(everythingLogged()).not.toContain(SENTINEL);
    void OPENAI_RETRY_POLICY;
  });

  it('Gemini: the SDK error message is redacted before it is logged or rethrown', async () => {
    const client = {
      models: {
        generateContentStream: vi.fn(async () => {
          throw Object.assign(new Error(`got status: 400 INVALID_ARGUMENT. {"error":{"code":400,"message":"Unknown label ${SENTINEL}","status":"INVALID_ARGUMENT"}}`), { status: 400 });
        }),
      },
    } as unknown as GoogleGenAI;
    const req: TransportRequest = { system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2, extraParams: { config: { labels: { run: SENTINEL } } }, estimatedInputTokens: 5, call: {} };
    const err = await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client }).send(req).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(SENTINEL);
    expect((err as Error).message).toContain(REDACTED);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it('formatErrorDetail redacts configured payload values from the raw fallback and from details', () => {
    _setUserSettingsCacheForTest({ analyzerExtraParamsByEngine: { gemini: { config: { labels: { run: SENTINEL } } } } });
    const rawFallback = classifyAnalysisFailure(new Error(`${SENTINEL} got status: 400. {"error":{"code":400,"message":"bad request"}}`), 'Gemini 3.6 Flash');
    expect(rawFallback.detail).toContain(REDACTED);
    expect(rawFallback.detail).not.toContain(SENTINEL);
    const withDetails = classifyAnalysisFailure(
      new Error(`got status: 400. {"error":{"code":400,"message":"bad","status":"INVALID_ARGUMENT","details":[{"note":"${SENTINEL}"}]}}`),
      'Gemini 3.6 Flash',
    );
    expect(withDetails.detail).not.toContain(SENTINEL);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/runner/extra-params-privacy.test.ts`
Expected: the first case PASSES (nothing in the runner logs or persists request bodies today — it is the lock against a future regression); the Ollama, OpenAI, Gemini and `formatErrorDetail` cases FAIL with `expected '… cw-sentinel-9f3a7c21 …' not to contain 'cw-sentinel-9f3a7c21'`.

- [ ] **Step 3: Implement**

`ollama-transport.ts` — in the non-OK branch, redact the whole body before anything slices or embeds it:
```ts
        const text = redactPayloadValues(await response.text().catch(() => ''), req.extraParams);
```
(replacing W1's `const text = await response.text().catch(() => '');`; the following `new AnalyzerHttpError(…text.slice(0, 500)…)` is unchanged). Make the identical replacement of `const text = await response.text().catch(() => '');` inside W4's `sendFreeText` `if (!response.ok)` branch. In the in-stream error branch wrap the value W1 embeds: `redactPayloadValues(String(parsed.error), req.extraParams)`. Import `redactPayloadValues` from `../runner/extra-params.js`.

`openai-transport.ts` — for every `new AnalyzerHttpError('openai', status, bodyExcerpt, message)` in the classifier, pass `redactPayloadValues(bodyExcerpt, req.extraParams)` and `redactPayloadValues(message, req.extraParams)` (compute the unredacted strings first exactly as W3b does, then wrap them at the constructor call).

`gemini-transport.ts` — as the first statement after the abort/idle/truncation early-exits in the generic `catch (err)` block (i.e. directly before `const status = (err as { status?: number })?.status;`):
```ts
      /* D9 — the SDK embeds the upstream body in `.message`; redact payload
         values before the structured log below and before the rethrow that the
         failure taxonomy reads. */
      if (err instanceof Error && req.extraParams) {
        err.message = redactPayloadValues(err.message, req.extraParams);
      }
```

`failure-taxonomy.ts` — add `import { configuredPayloadsForRedaction, redactPayloadValues } from '../analyzer/runner/extra-params.js';` (PR 5a already imports `getCachedUserSettings`). In `formatErrorDetail` replace the two returns:
```ts
    return trimmed.trim() || undefined;
```
→
```ts
    const fallback = trimmed.trim();
    return fallback ? redactPayloadValues(fallback, configuredPayloadsForRedaction(getCachedUserSettings())) : undefined;
```
and
```ts
  return lines.join('\n');
```
→
```ts
  return redactPayloadValues(lines.join('\n'), configuredPayloadsForRedaction(getCachedUserSettings()));
```

- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/runner/extra-params-privacy.test.ts src/routes/failure-taxonomy.test.ts src/analyzer/transports` then `npm run check:cycles`
Expected: PASS; no new cycle. Keeps green: `failure-taxonomy.test.ts` detail-blob cases (no payload configured → `redactPayloadValues` returns the text unchanged), W1/W3 transport error-classification suites.

- [ ] **Step 5: Mutation proof**
1. Revert the Ollama `const text = redactPayloadValues(…)` line in the streaming branch. Expected red: `Ollama: a 400 that echoes the request is redacted …`. Restore.
1b. Revert the same line in `sendFreeText`. Expected red: `Ollama persona (free-text) call: a 400 that echoes the request is redacted`. Restore.
2. Delete the Gemini `err.message = redactPayloadValues(…)` block. Expected red: `Gemini: the SDK error message is redacted …`. Restore.
3. Revert either `formatErrorDetail` return. Expected red: `formatErrorDetail redacts configured payload values …`. Restore.
4. Unwrap the OpenAI `bodyExcerpt` argument. Expected red: `OpenAI-compatible: a 400 naming the parameter value is redacted`. Restore.
5. In `stage-runner.ts`, add a temporary `console.debug('[runner] request', JSON.stringify(s.extraParams));` before the first send. Expected red: `a stage with a validation retry sends the payload but writes and logs none of it`. Remove.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports server/src/routes/failure-taxonomy.ts server/src/analyzer/runner/extra-params-privacy.test.ts
git commit -m "feat(server): redact custom payload values from upstream error text and lock payload privacy"
```

### Task 5.12: Run label "+ custom params", payload editors, e2e

**Files:**
- Modify: W3c's server-side label composer, `toEntry` in `server/src/analyzer/catalog/analyzer-catalog.ts` (Task 3c.5; it sets each entry's `structuredOutput.label`), and its test file `server/src/analyzer/catalog/analyzer-catalog.test.ts`
- Modify: `openapi.yaml` `components.schemas.AnalyzerCatalogEntry` (Task 3c.6) — new optional `requestControlLabelParts`; regenerate `src/lib/api-types.ts`
- Modify: W3c's frontend run-label hook `runLabelSuffixes(entry)` in `src/lib/model-label.ts` (Task 3c.7; the phase chip and the default-model label both call it) and `src/lib/model-label.test.ts`
- Modify: the mock catalog's `entry(…)` helper in `mockGetAnalyzerModels` (`src/lib/api.ts`, Task 3c.6)
- Create: `src/lib/extra-params.ts`
- Modify: `src/components/settings/analyzer-request-controls.tsx` (+ test), W3d's endpoint form `src/components/settings/analyzer-endpoints-section.tsx` (+ `analyzer-endpoints-section.test.tsx`)
- Modify: `e2e/analyzer-endpoints.spec.ts` (W3d Task 3d.9's first test, "add an endpoint (context required), pick its model, and the label shows \"schema (not enforced)\" from a Test record")
- Create: `e2e/analyzer-request-controls.spec.ts`
- Test: `src/lib/extra-params.test.ts`

**Interfaces:**
- Consumes: Task 5.8 `requestControlsLabelParts`, `payloadControlsOutputCap`; shared fixture `extra-params-cases.json`; Task 5.6 component and `settingsIssueMessages`.
- Produces: frontend `parseExtraParamsText(text)`, `payloadSetsOutputCap(kind, params)`, `requestControlsLabelParts(kind, params)`; testids `analyzer-extra-params-ollama`, `analyzer-extra-params-gemini`, `analyzer-extra-params-<engine>-error`, `analyzer-extra-params-<engine>-cap-note`, `endpoint-extra-params`, `endpoint-extra-params-error`, `endpoint-max-output-controlled`.

- [ ] **Step 1: Write the failing tests**

`src/lib/extra-params.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import cases from '../../server/src/analyzer/__fixtures__/extra-params-cases.json';
import { parseExtraParamsText, payloadSetsOutputCap, requestControlsLabelParts, type PayloadKind } from './extra-params';

describe('frontend payload helpers match the server case table', () => {
  it.each(cases as Array<{ kind: PayloadKind; params: Record<string, unknown>; controlsOutputCap: boolean; labelParts: string[] }>)(
    '$kind $params',
    ({ kind, params, controlsOutputCap, labelParts }) => {
      expect(payloadSetsOutputCap(kind, params)).toBe(controlsOutputCap);
      expect(requestControlsLabelParts(kind, params)).toEqual(labelParts);
    },
  );
});

describe('parseExtraParamsText', () => {
  it('blank means no payload', () => expect(parseExtraParamsText('  ')).toEqual({ ok: true, value: undefined }));
  it('parses a JSON object', () => expect(parseExtraParamsText('{"top_k": 40}')).toEqual({ ok: true, value: { top_k: 40 } }));
  it('refuses invalid JSON and non-objects with a message', () => {
    expect(parseExtraParamsText('{top_k: 40}')).toEqual({ ok: false, error: 'Not valid JSON.' });
    expect(parseExtraParamsText('[1]')).toEqual({ ok: false, error: 'Must be a JSON object, for example {"top_k": 40}.' });
  });
});
```

Append to `src/components/settings/analyzer-request-controls.test.tsx`:
```tsx
describe('AnalyzerRequestControls — custom payload', () => {
  it('saves both engine payloads with the reasoning levels in one patch', async () => {
    mockPut.mockResolvedValue({} as never);
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-extra-params-ollama')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('analyzer-extra-params-ollama'), { target: { value: '{"options":{"min_p":0.05}}' } });
    fireEvent.change(screen.getByTestId('analyzer-extra-params-gemini'), { target: { value: '{"config":{"topK":40}}' } });
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0][0]).toEqual({
      analyzerReasoningByEngine: { ollama: 'off', gemini: {} },
      analyzerExtraParamsByEngine: { ollama: { options: { min_p: 0.05 } }, gemini: { config: { topK: 40 } } },
    });
  });
  it('blocks the save on invalid JSON and says why', async () => {
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-extra-params-ollama')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('analyzer-extra-params-ollama'), { target: { value: '{oops' } });
    expect(screen.getByTestId('analyzer-extra-params-ollama-error')).toHaveTextContent('Not valid JSON.');
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    expect(mockPut).not.toHaveBeenCalled();
  });
  it('notes when the payload takes over the output cap', async () => {
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-extra-params-gemini')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('analyzer-extra-params-gemini'), { target: { value: '{"config":{"maxOutputTokens":2048}}' } });
    expect(screen.getByTestId('analyzer-extra-params-gemini-cap-note')).toHaveTextContent('Max output tokens (Auto) is not used');
  });
});
```

Append to `src/components/settings/analyzer-endpoints-section.test.tsx` (W3d Task 3d.8; `renderSection()` renders the section, the `add-endpoint` button opens the editor):
```tsx
describe('endpoint form — custom payload', () => {
  it('disables the max output field when the payload sets the cap, and shows JSON errors', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    const payload = screen.getByTestId('endpoint-extra-params');
    fireEvent.change(payload, { target: { value: '{"max_completion_tokens": 4096}' } });
    expect(screen.getByTestId('endpoint-max-output-controlled')).toHaveTextContent('set by custom parameters');
    fireEvent.change(payload, { target: { value: '{bad' } });
    expect(screen.getByTestId('endpoint-extra-params-error')).toHaveTextContent('Not valid JSON.');
  });
});
```

Append to `server/src/analyzer/catalog/analyzer-catalog.test.ts` (W3c Task 3c.5), inside `describe('buildAnalyzerCatalog', …)`. It reuses that file's `deps()` and `settings()` helpers, its `lab` endpoint, and `import { DEFAULT_USER_SETTINGS, type UserSettings }`:
```ts
  it('entries carry the payload label parts: + custom params, and a payload output cap (#3084 wave 5)', async () => {
    const partsFor = async (over: Partial<UserSettings>) =>
      (await buildAnalyzerCatalog({ refresh: true }, deps({ settings: () => settings(over) }))).groups.map(
        (g) => g.models[0]?.requestControlLabelParts,
      );
    // groups: [ollama, gemini (fallback, no models), lab endpoint]
    expect(await partsFor({ analyzerExtraParamsByEngine: { ollama: { top_k: 40 } } })).toEqual([['+ custom params'], undefined, []]);
    expect(await partsFor({ analyzerExtraParamsByEngine: { ollama: { options: { num_predict: 2048 } } } })).toEqual([
      ['+ custom params', 'max output set by custom params'],
      undefined,
      [],
    ]);
    expect(await partsFor({ analyzerEndpoints: [{ ...lab, extraParams: { min_p: 0.05 } }] })).toEqual([[], undefined, ['+ custom params']]);
  });
```

Append to `src/lib/model-label.test.ts` (W3c Task 3c.7), inside `describe('modelLabel (#3084)', …)`, which already defines `catalog`:
```ts
  it('runLabelSuffixes appends the server-sent request-control parts after the structured-output label (#3084 wave 5)', () => {
    const entry = catalogEntryFor('openai:lab::qwen3-30b', catalog)!;
    expect(runLabelSuffixes({ ...entry, requestControlLabelParts: ['+ custom params', 'max output set by custom params'] })).toEqual([
      'schema (not enforced)',
      '+ custom params',
      'max output set by custom params',
    ]);
    expect(runLabelSuffixes({ ...entry, requestControlLabelParts: [] })).toEqual(['schema (not enforced)']);
    expect(runLabelSuffixes(entry)).toEqual(['schema (not enforced)']);
  });
```

In `e2e/analyzer-endpoints.spec.ts` (W3d Task 3d.9), edit its first test, "add an endpoint (context required), pick its model, and the label shows "schema (not enforced)" from a Test record":
- **Before the save.** Directly before the second `await page.getByTestId('endpoint-save').click();` (the one after `endpoint-context-tokens` is filled with `'32768'`), add:
```ts
  await page.getByTestId('endpoint-extra-params').fill('{"top_k": 40, "min_p": 0.05}');
```
- **The assertion.** Replace W3d's placeholder comment, `// Wave 5 appends "+ custom params" through runLabelSuffixes; asserted there, not here.` (the line after `await expect(label).toContainText('schema (not enforced)');`), with:
```ts
  await expect(label).toContainText('+ custom params');
```
`label` is W3d's `page.getByTestId('analyzer-default-model-label')`. It renders `runLabelSuffixes(catalogEntryFor(…))`. The mock catalog's `entry(…)` helper supplies `requestControlLabelParts` from the saved endpoint's `extraParams`. The section refetches the catalog (`fetchAnalyzerCatalog({ refresh: true })`) after a save.

`e2e/analyzer-request-controls.spec.ts`:
```ts
import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

async function readAccount(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __store__: { getState: () => { account: Record<string, unknown> } } };
    return w.__store__.getState().account;
  });
}

test.describe('#3084 wave 5 — Analyzer request controls (Advanced settings)', () => {
  test('saves an Ollama reasoning level and payload through the settings round-trip', async ({ page }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);
    const controls = page.getByTestId('analyzer-request-controls');
    await expect(controls).toBeVisible();
    await page.getByTestId('analyzer-reasoning-ollama').selectOption('on');
    await page.getByTestId('analyzer-extra-params-ollama').fill('{"options": {"min_p": 0.05}}');
    await page.getByTestId('analyzer-request-controls-save').click();
    await expect(controls.getByText(/^saved\.$/i)).toBeVisible({ timeout: 5_000 });
    await expect.poll(async () => (await readAccount(page)).analyzerReasoningByEngine).toEqual({ ollama: 'on', gemini: {} });
    await expect.poll(async () => (await readAccount(page)).analyzerExtraParamsByEngine).toEqual({ ollama: { options: { min_p: 0.05 } } });
  });

  test('invalid JSON blocks the save with a visible reason', async ({ page }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);
    await page.getByTestId('analyzer-extra-params-gemini').fill('{"config": ');
    await expect(page.getByTestId('analyzer-extra-params-gemini-error')).toHaveText('Not valid JSON.');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm test -- src/lib/extra-params.test.ts src/lib/model-label.test.ts src/components/settings/analyzer-request-controls.test.tsx src/components/settings/analyzer-endpoints-section.test.tsx` and `npm --prefix server run test -- src/analyzer/catalog/analyzer-catalog.test.ts`, then `npx playwright test --project=chromium e2e/analyzer-request-controls.spec.ts e2e/analyzer-endpoints.spec.ts`
Expected: FAIL, for these reasons:
- `Failed to resolve import "./extra-params"`.
- `Unable to find an element by: [data-testid="analyzer-extra-params-ollama"]`, and the same for `[data-testid="endpoint-extra-params"]`.
- The catalog test: `expected [ undefined, undefined, undefined ] to deeply equal [ [ '+ custom params' ], undefined, [] ]`.
- The model-label test: `expected [ 'schema (not enforced)' ] to deeply equal [ 'schema (not enforced)', '+ custom params', … ]`.
- e2e: `getByTestId('endpoint-extra-params')` not found, then a `toContainText('+ custom params')` timeout.

- [ ] **Step 3: Implement**

`src/lib/extra-params.ts`:
```ts
/* #3084 wave 5 — frontend payload helpers. Semantic validation (protected keys)
   is server-side; these only parse the textarea and mirror the output-cap/label
   rule, pinned to the server by the shared extra-params-cases.json fixture. */
export type PayloadKind = 'ollama' | 'gemini' | 'openai';
type Json = Record<string, unknown>;

export function parseExtraParamsText(text: string): { ok: true; value: Json | undefined } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Must be a JSON object, for example {"top_k": 40}.' };
  }
  return { ok: true, value: parsed as Json };
}

const OUTPUT_CAP: Record<PayloadKind, { container: string | null; keys: readonly string[] }> = {
  openai: { container: null, keys: ['max_tokens', 'max_completion_tokens'] },
  ollama: { container: 'options', keys: ['num_predict'] },
  gemini: { container: 'config', keys: ['maxOutputTokens'] },
};

export function payloadSetsOutputCap(kind: PayloadKind, params: Json | undefined): boolean {
  if (!params) return false;
  const { container, keys } = OUTPUT_CAP[kind];
  const scope = container === null ? params : params[container];
  return typeof scope === 'object' && scope !== null && !Array.isArray(scope) && keys.some((k) => Object.hasOwn(scope, k));
}

export function requestControlsLabelParts(kind: PayloadKind, params: Json | undefined): string[] {
  if (!params || Object.keys(params).length === 0) return [];
  return payloadSetsOutputCap(kind, params) ? ['+ custom params', 'max output set by custom params'] : ['+ custom params'];
}
```

`analyzer-request-controls.tsx` — add imports `import { parseExtraParamsText, payloadSetsOutputCap, type PayloadKind } from '../../lib/extra-params';`. Add state after the reasoning state:
```tsx
  const savedPayloads = useAppSelector((s) => s.account.analyzerExtraParamsByEngine);
  const [payloadText, setPayloadText] = useState<Record<'ollama' | 'gemini', string>>({
    ollama: savedPayloads?.ollama ? JSON.stringify(savedPayloads.ollama, null, 2) : '',
    gemini: savedPayloads?.gemini ? JSON.stringify(savedPayloads.gemini, null, 2) : '',
  });
  useEffect(() => {
    setPayloadText({
      ollama: savedPayloads?.ollama ? JSON.stringify(savedPayloads.ollama, null, 2) : '',
      gemini: savedPayloads?.gemini ? JSON.stringify(savedPayloads.gemini, null, 2) : '',
    });
  }, [savedPayloads]);
  const parsedPayloads = {
    ollama: parseExtraParamsText(payloadText.ollama),
    gemini: parseExtraParamsText(payloadText.gemini),
  };
```
Replace `onSave`'s body so the patch carries both halves and invalid JSON blocks it:
```tsx
  const onSave = async () => {
    setErrors([]);
    if (!parsedPayloads.ollama.ok || !parsedPayloads.gemini.ok) return;
    const geminiPatch = Object.fromEntries(Object.entries(gemini).filter(([, level]) => level !== 'model-default'));
    const analyzerExtraParamsByEngine: Record<string, Record<string, unknown>> = {};
    if (parsedPayloads.ollama.value) analyzerExtraParamsByEngine.ollama = parsedPayloads.ollama.value;
    if (parsedPayloads.gemini.value) analyzerExtraParamsByEngine.gemini = parsedPayloads.gemini.value;
    const action = await dispatch(
      saveAccountSettings({ analyzerReasoningByEngine: { ollama, gemini: geminiPatch }, analyzerExtraParamsByEngine }),
    );
    if (saveAccountSettings.rejected.match(action)) {
      setErrors(settingsIssueMessages(action.error.message ?? ''));
      return;
    }
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 2400);
  };
```
Update the Task 5.6 RTL expectation `saves the Ollama level and non-default Gemini levels only` to include `analyzerExtraParamsByEngine: {}` in the expected patch (the patch now always carries both halves). Render the two editors between the Gemini reasoning block and the errors list:
```tsx
      {(['ollama', 'gemini'] as const).map((engine) => {
        const kind: PayloadKind = engine;
        const parsed = parsedPayloads[engine];
        const label = engine === 'ollama' ? 'Ollama' : 'Gemini';
        return (
          <label key={engine} className="block">
            <span className="block text-sm font-medium text-ink">{label} custom parameters</span>
            <span className="block text-xs text-ink/55 mt-0.5">
              {engine === 'ollama'
                ? 'JSON merged last into every Ollama request, e.g. {"options": {"min_p": 0.05}}. "options" merges key by key; null removes a key. A temperature here sets the first attempt only.'
                : 'JSON with a "config" object merged key by key into every Gemini request, e.g. {"config": {"topK": 40}}. A temperature here sets the first attempt only.'}{' '}
              Keys Castwright controls are refused on save. Never logged; long string values are hidden in provider errors.
            </span>
            <textarea
              data-testid={`analyzer-extra-params-${engine}`}
              value={payloadText[engine]}
              onChange={(e) => setPayloadText((t) => ({ ...t, [engine]: e.target.value }))}
              rows={4}
              spellCheck={false}
              className="mt-2 w-full px-3 py-2 rounded-xl border border-ink/15 bg-white font-mono text-xs text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            />
            {!parsed.ok && (
              <span data-testid={`analyzer-extra-params-${engine}-error`} className="block text-xs text-rose-700 mt-1">
                {parsed.error}
              </span>
            )}
            {parsed.ok && payloadSetsOutputCap(kind, parsed.value) && (
              <span data-testid={`analyzer-extra-params-${engine}-cap-note`} className="block text-xs text-amber-800 mt-1">
                This sets the output cap: Max output tokens (Auto) is not used for {label}, and the run label says so.
              </span>
            )}
          </label>
        );
      })}
```

W3d endpoint form, `src/components/settings/analyzer-endpoints-section.tsx` (Task 3d.8, as extended by Task 5.6). Today its `validateEndpointDraft` copies `original?.extraParams` unchanged. Change it as follows:
- **Import.** Add `import { parseExtraParamsText, payloadSetsOutputCap } from '../../lib/extra-params';`.
- **`EndpointDraft`.** Add `extraParamsText: string;` after `reasoning: ReasoningLevel;`.
- **`DraftErrors`.** Add `'extraParams'` to its key union.
- **`draftFrom(e)`.** Add `extraParamsText: e?.extraParams ? JSON.stringify(e.extraParams, null, 2) : '',` after `reasoning`.
- **`validateEndpointDraft`, errors.** Before `if (Object.keys(errors).length > 0) return …`, add `const payload = parseExtraParamsText(d.extraParamsText);` and `if (!payload.ok) errors.extraParams = payload.error;`. Save is then refused while the JSON is invalid.
- **`validateEndpointDraft`, input.** In the `input` literal, replace `...(original?.extraParams ? { extraParams: original.extraParams } : {}),` with `...(payload.ok && payload.value ? { extraParams: payload.value } : {}),`. `extraParamsText` is never sent.
- **Render.** Directly after the "Reasoning" `FieldRow` from Task 5.6, render:
```tsx
        <FieldRow label="Custom parameters" sublabel='JSON merged last into every request to this endpoint, e.g. {"top_k": 20, "min_p": 0.05, "presence_penalty": 1.5}. chat_template_kwargs merges key by key; null removes a key. A temperature here sets the first attempt only. Keys Castwright controls are refused on save. Never logged; long string values are hidden in provider errors. OpenAI reasoning models need max_completion_tokens instead of max_tokens.'>
          <textarea
            data-testid="endpoint-extra-params"
            value={draft.extraParamsText}
            onChange={(e) => set('extraParamsText', e.target.value)}
            rows={4}
            spellCheck={false}
            className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white font-mono text-xs text-ink"
          />
          {!payloadParse.ok && (
            <span data-testid="endpoint-extra-params-error" className="block text-xs text-rose-700 mt-1">{payloadParse.error}</span>
          )}
        </FieldRow>
```
In `AnalyzerEndpointsSection`'s body (after the `hostChanged` memo), add `const payloadParse = parseExtraParamsText(draft.extraParamsText);` and `const payloadCapsOutput = payloadParse.ok && payloadSetsOutputCap('openai', payloadParse.value);`. On the existing `data-testid="endpoint-max-output-tokens"` input add `disabled={payloadCapsOutput}`, and directly after that input add:
```tsx
          {payloadCapsOutput && (
            <span data-testid="endpoint-max-output-controlled" className="block text-xs text-amber-800 mt-1">
              Output cap set by custom parameters — Auto is not used.
            </span>
          )}
```
The submit is W3d's `save()`, which sends `validateEndpointDraft(…).input`. After the changes above it refuses while `errors.extraParams` is set, sends `extraParams` from the parsed text, and never sends `extraParamsText`. Server validation messages already flow through `settingsIssueMessages` (Task 5.6).

Server label parts go in W3c's `toEntry` (`server/src/analyzer/catalog/analyzer-catalog.ts`). Its ctx already carries `endpoint` (Task 5.4). Add `import { requestControlsLabelParts, resolveExtraParamsSetting } from '../runner/extra-params.js';`, and add to its return object:
```ts
    requestControlLabelParts: requestControlsLabelParts(
      ctx.kind === 'endpoint' ? 'openai' : ctx.kind,
      resolveExtraParamsSetting(ctx.settings, { engine: ctx.engine, endpoint: ctx.endpoint }),
    ),
```
W3c's catalog emits no separate Auto max-output segment, so nothing else changes. The "max output set by custom params" part names a payload-set cap.

OpenAPI — in `components.schemas.AnalyzerCatalogEntry.properties` (Task 3c.6) add the property below, then run `npm run openapi:types`:
```yaml
        requestControlLabelParts:
          type: array
          items: { type: string }
          description: 'Run-label parts from the custom payload, e.g. "+ custom params", "max output set by custom params" (#3084 wave 5)'
```

Frontend hook — in `src/lib/model-label.ts` (W3c Task 3c.7), replace `runLabelSuffixes`'s body with the line below. In its doc comment, replace "W5 (custom payload) appends '+ custom params' here." with "Then the server-sent request-control parts (wave 5).".
```ts
  return entry ? [entry.structuredOutput.label, ...(entry.requestControlLabelParts ?? [])] : [];
```

Mock label — in the `entry(id, engine, model, mode, droppedIfSchema)` helper of `mockGetAnalyzerModels` (`src/lib/api.ts`, W3c Task 3c.6), add `import { requestControlsLabelParts } from './extra-params';` and add to the returned object:
```ts
      requestControlLabelParts: requestControlsLabelParts(
        engine === 'local' ? 'ollama' : engine,
        engine === 'openai'
          ? source.analyzerEndpoints?.find((e) => e.id === parseEndpointModelId(id)?.endpointId)?.extraParams
          : (MOCK_USER_SETTINGS.analyzerExtraParamsByEngine?.[engine === 'local' ? 'ollama' : 'gemini'] as Record<string, unknown> | undefined),
      ),
```

- [ ] **Step 4: Run and confirm they pass**
Run: `npm test -- src/lib/extra-params.test.ts src/components/settings/analyzer-request-controls.test.tsx src/views/advanced.test.tsx src/test/a11y.test.tsx src/lib/model-label.test.ts src/components/settings/analyzer-endpoints-section.test.tsx` and `npm --prefix server run test -- src/analyzer/catalog/analyzer-catalog.test.ts`, then `npm run openapi:types` and `npx playwright test --project=chromium e2e/analyzer-request-controls.spec.ts e2e/analyzer-endpoints.spec.ts e2e/advanced-settings.spec.ts`
Expected: PASS. Keeps green: Task 5.6 RTL cases (with the updated patch expectation), both Advanced e2e specs, the rest of W3d's `e2e/analyzer-endpoints.spec.ts`, W3c's `model-label.test.ts` and `analyzer-catalog.test.ts` cases (an entry without a payload gets `requestControlLabelParts: []`, so every existing label is unchanged).

- [ ] **Step 5: Mutation proof**
1. In `requestControlsLabelParts` (server, `runner/extra-params.ts`) return `[]` unconditionally. Expected red: `entries carry the payload label parts: + custom params, and a payload output cap (#3084 wave 5)`. Restore.
1a. In `runLabelSuffixes` (`src/lib/model-label.ts`) drop `...(entry.requestControlLabelParts ?? [])`. Expected red: `runLabelSuffixes appends the server-sent request-control parts after the structured-output label (#3084 wave 5)` and the e2e `toContainText('+ custom params')`. Restore.
2. In `analyzer-request-controls.tsx` `onSave`, delete `if (!parsedPayloads.ollama.ok || !parsedPayloads.gemini.ok) return;`. Expected red: `blocks the save on invalid JSON and says why`. Restore.
3. In the endpoint form remove `disabled={payloadCapsOutput}`'s companion note block. Expected red: `disables the max output field when the payload sets the cap, and shows JSON errors`. Restore.

- [ ] **Step 6: Commit**
```bash
git add src/lib/extra-params.ts src/lib/extra-params.test.ts src/components/settings/analyzer-request-controls.tsx src/components/settings/analyzer-request-controls.test.tsx src/lib/api.ts e2e/analyzer-request-controls.spec.ts e2e/analyzer-endpoints.spec.ts
git add src/components/settings/analyzer-endpoints-section.tsx src/components/settings/analyzer-endpoints-section.test.tsx src/lib/model-label.ts src/lib/model-label.test.ts src/lib/api-types.ts openapi.yaml server/src/analyzer/catalog/analyzer-catalog.ts server/src/analyzer/catalog/analyzer-catalog.test.ts
git commit -m "feat(frontend,server,e2e): custom payload editors and the + custom params run label"
```

### Task 5.13: Ship PR 5b (closes #3084)

**Files:**
- Modify: `docs/release-notes-next.md` (`## 🗣️ Analyzer, script review & manuscript`), `RELEASE_NOTES.md` (top section)
- Modify: `docs/testing/onbox-acceptance-register.md` (Groups A and E + At-a-glance), `docs/testing/onbox-acceptance-register-live-view.html`
- Modify: `docs/features/284-openai-compatible-analyzer.md` (Ship notes, invariants), `docs/features/INDEX.md` (its entry, only if the entry text states wave progress)
- Modify: `CLAUDE.md` — **no change**: this PR adds no new un-mocked frontend→local-machine call (Detect was added to the exception list in W3b).

- [ ] **Step 1: Derived artifacts**
Run: `npm run openapi:types` → `git diff --exit-code src/lib/api-types.ts` (exit 0); `npm run config:check` (no knobs added — must pass unchanged).

- [ ] **Step 2: Release notes (both files)**
`docs/release-notes-next.md`:
```markdown
- **Custom request parameters for every analyzer engine (#3084, wave 5b — closes #3084).** New `analyzerExtraParamsByEngine` (Ollama, Gemini) and per-endpoint `extraParams`: a JSON object merged last into the native request — top-level keys replace; the owned container (Ollama `options`, Gemini `config`, endpoint `chat_template_kwargs`) merges key by key; `null` removes a key but never a container. Pipeline-owned keys (spec §9, plus Gemini `model`/`contents` and `chat_template_kwargs.enable_thinking` under the `enable_thinking` style) are refused on save with a message naming them. A payload temperature sets attempt 1 only; the retry policy's temperature wins on the validation retry. A payload output cap disables Auto (the transport's `max_tokens` is dropped on endpoints) and the run label says so; any payload adds "+ custom params". Payloads are never logged or written to analyzer files; string values ≥ 8 characters are redacted from Ollama/OpenAI/Gemini error text and the failure detail blob. (#PR)
```
`RELEASE_NOTES.md`:
```markdown
- **Pass your own settings straight to the model.** Want `top_k`, `min_p` or a presence penalty on your local server, or `topK` on Gemini? Each analyzer engine and every OpenAI-compatible endpoint now takes a small block of custom parameters that Castwright adds to every request. It won't let you override the parts it depends on — the model name, the output format, reasoning, the context size — and tells you exactly which keys it refused. A temperature you set there shapes the first try, while a retry still uses Castwright's own. The run label shows "+ custom params" whenever they're in play, and your values never appear in logs; if a provider error repeats one back, Castwright hides it. This completes the OpenAI-compatible analyzer request that started it all.
```

- [ ] **Step 3: On-box acceptance rows**
Allocate from each group's `next-id` marker at ship time; bump the marker in the same commit.
- **Group A** (GPU box, llama-swap + Ollama): *"#3084 5b — custom payload on real servers."* Observe: an endpoint with `{"top_k": 20, "min_p": 0.05, "presence_penalty": 1.5}` completes a chapter and llama-swap's request log shows those fields; Ollama with `{"options": {"min_p": 0.05}}` completes a chapter; a payload with a deliberately unsupported long string (e.g. `{"grammar_note": "castwright-onbox-probe-value"}` on a server that rejects unknown fields, or `{"options": {"num_keep": "castwright-onbox-probe-value"}}` on Ollama) produces a failure whose on-screen text and `logs/server.log` show `[redacted]`, never the value; the run label reads "+ custom params".
- **Group E** (Gemini key): *"#3084 5b — Gemini config payload."* Observe: `{"config": {"topK": 40}}` completes a chapter; `{"config": {"maxOutputTokens": 2048}}` makes the label read "max output set by custom params"; a `config` field Gemini rejects returns `analyzer-request-rejected` with the value redacted.
Update At-a-glance counts (A +1, E +1); run `npm run register:build` and `npm run check:onbox-register`; edit the live-view html; run `npm run check:onbox-register -- --against-published <saved live page>`; publish the html to the recorded URL.

- [ ] **Step 4: Plan doc and index**
In `docs/features/284-openai-compatible-analyzer.md`: add the payload invariants (merge order, owned containers, protected keys, temperature precedence, output-cap/label rule, privacy/redaction) and fill **Ship notes** with every wave's PR number and merge SHA through this PR. Status stays **`active`** — the on-box rows from waves 2–5 are still owed, so CLAUDE.md step 8 (move to `archive/`, `stable`) does not apply yet; state that sentence in the Ship notes. In `docs/features/INDEX.md`, leave the entry under its area; update its one-line description only if it names wave progress.

- [ ] **Step 5: Verify**
Run: `npm run typecheck`, `npm run check:cycles`, `npm run verify:fast:branch`, `npx playwright test --project=chromium e2e/analyzer-request-controls.spec.ts e2e/analyzer-endpoints.spec.ts`  Expected: all PASS.

- [ ] **Step 6: Commit, push, PR, review gate**
```bash
git add docs/release-notes-next.md RELEASE_NOTES.md docs/testing/onbox-acceptance-register.md docs/testing/onbox-acceptance-register-live-view.html docs/features/284-openai-compatible-analyzer.md docs/features/INDEX.md
git commit -m "docs(docs): release notes, on-box rows and ship notes for custom analyzer payloads"
git push -u origin feat/server,frontend-3084-w5b-payload
```
PR title: `feat(server,frontend,openapi): custom request parameters for every analyzer engine`. Body: `## Summary` (release-notes-next entry + the four spec-gap resolutions at the top of PR 5b), `## Test plan` (task test files, the privacy test, both e2e specs, pasted mutation-proof red output from Tasks 5.8–5.12, the register row IDs), **`Closes #3084`** (this is the wave's last PR; owed on-box acceptance is recorded as rows, which never blocks a merge), and "Also fixed, found in passing: …" if any. Run `pr-review-gate` at **high** depth; fold findings per its loop.
