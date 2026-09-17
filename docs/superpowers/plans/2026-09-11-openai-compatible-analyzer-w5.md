# OpenAI-compatible analyzer — Wave 5 plan

> Part of the [OpenAI-compatible analyzer implementation plan](2026-09-11-openai-compatible-analyzer.md). Read that file first: its Global Constraints, planning decisions (P1–P29) and interface contract bind every task below. Spec: [2026-09-10-openai-compatible-analyzer-design.md](../specs/2026-09-10-openai-compatible-analyzer-design.md).

## Wave 5 — Reasoning controls (D8, §8) and custom payload (D9, §9)

**Preconditions for the whole wave.** Waves 1–4 are merged. This plan is verified at `80be2f1d` (re-pinned from `46e62a34`); re-read any citation against current `main` before editing, since `main` moves. The wave 1–4 files (`runner/*`, `transports/*`, `capabilities.ts`, `analyzer-endpoints.ts`, `routes/analyzer-models.ts`, `routes/analyzer-endpoints.ts`, W3d's endpoint form) are cited by the **contract name**, because they do not exist at `80be2f1d` either — waves 1-4 land as their own PRs, after this plan's pin commit. Where this wave edits a wave 1–4 function whose body the contract does not pin, the step names the symbol to find (`git grep -n '<symbol>'`) and gives the full replacement text.

**Conventions used by every task below.**
- Commands run from the worktree root. Server single file: `npm --prefix server run test -- <path relative to server/>`. Frontend single file: `npm test -- <path>`. None of this wave's test files are in `server/vitest.config.slow.ts` `SLOW_FILES`; do not add assertions to `server/src/analyzer/gemini.test.ts` (slow lane).
- Every transport test uses a real `http.createServer` on `127.0.0.1:0` and the real undici `Agent` (pattern: `server/src/analyzer/ollama-timeout.test.ts:60-109`, including `process.env.CASTWRIGHT_VRAM_SAMPLE = '0'` in `beforeAll` and `closeAllConnections()` in `afterEach`).
- `openapi.yaml` enum values `off` / `on` are **always quoted** (`'off'`, `'on'`): an unquoted `off` is a YAML 1.1 boolean, and a boolean in a string enum breaks `openapi-typescript`.
- "Keeps green" lists name existing suites the task can break; run each one in Step 4.

---

### PR 5a — Reasoning levels, control styles, and their Test coverage

- **Branch:** `feat/server-3084-w5a-reasoning` — `node scripts/wt-new.mjs feat/server-3084-w5a-reasoning`.
- **Delivers:** `server/src/analyzer/reasoning.ts` (levels per engine family and endpoint control style, Gemini per-model table, wire fragments, control descriptions); `analyzerReasoningByEngine` user setting (Ollama and Gemini, each keyed by model id; P18) and endpoint `reasoning` validation; every transport sends the resolved level, with `includeThoughts` beside any Gemini level that thinks (P19); the Test action adds P7's level step (acceptance only) and keys schema probes by level; the pre-run check refuses a `rejected` level, or a stored level the rules no longer offer (P17), for analysis runs and persona generation; catalog entries carry `offeredReasoningLevels`; the reasoning-overflow message names the actual control; Advanced Settings and the endpoint form offer only offered levels.
- **Must NOT change:** today's wire defaults — Ollama still sends `think: false` for an untouched install; Gemini and endpoints send no reasoning field for an untouched install. No new `FailureCode`. No custom-payload code (PR 5b). No structured-output default change.
- **Entry:** waves 1–4 merged; `git grep -n -E "ReasoningLevel|extraParams" server/src/analyzer/runner` prints nothing (wave 1 declared neither; Task 5.1 adds them); W3c's `runModelTest`, `plannedTestRequestCount`, `assertConfiguredCapabilitiesAllowed` and the catalog route exist.
- **Exit:** all tasks' tests green; `npm run typecheck`, `npm run check:cycles`, `npm run verify:fast:branch` green; `pr-review-gate` pass at **high** depth (multi-scope `feat`); on-box rows added.

### Task 5.1: `reasoning.ts` — levels, Gemini table, wire fragments, control descriptions; request-control fields and runner forwarding

**Files:**
- Create: `server/src/analyzer/reasoning.ts`
- Create: `server/src/analyzer/reasoning-level.ts` (review pass 3, item 2) — import-free leaf: `REASONING_LEVELS`, `type ReasoningLevel`; both `reasoning.ts` and `errors.ts` import from it instead of `errors.ts` importing from `reasoning.ts`
- Create: `server/src/analyzer/__fixtures__/reasoning-style-levels.json`
- Create: `server/src/analyzer/ollama-tag.ts` — `normalizeModelTag` moved from W1's `server/src/analyzer/ollama-settings.ts` (body unchanged), plus `entryForModelTag` (N7)
- Create: `server/src/analyzer/__fixtures__/ollama-tag-cases.json` (shared with the frontend in Task 5.6)
- Modify: `server/src/analyzer/ollama-settings.ts` (W1 Task 1.8) — its `normalizeModelTag` definition becomes a re-export from `./ollama-tag.js`
- Modify: `server/src/analyzer/runner/transport.ts` — `TransportRequest` gains `reasoning?` and `extraParams?`
- Modify: `server/src/analyzer/runner/stage-runner.ts` — `EngineRequestSettings` gains `reasoning?` and `extraParams?`; the private `send` helper (W1 Task 1.11, with wave 2's warm-up) and `runFreeText` (W4 Task 4.1) forward both, and pass the resolved level to the two `AnalyzerReasoningOverflowError` throw sites below
- Modify: `server/src/analyzer/errors.ts` (3b.1b's Files — review pass 2 correction) — `AnalyzerReasoningOverflowError`'s `opts?: { endpointId?: string }` (3b, additive) gains a sibling field `reasoningLevel?: ReasoningLevel` in the same object; no 5th positional argument
- Modify: `server/src/analyzer/runner/finish.ts` (W2) — `mapFinish`'s `ctx` parameter gains `reasoningLevel?: ReasoningLevel`, and its `AnalyzerReasoningOverflowError` throw passes it through `opts`
- Test: `server/src/analyzer/reasoning.test.ts`, `server/src/analyzer/ollama-tag.test.ts`, `server/src/analyzer/runner/stage-runner.request-controls.test.ts`, `server/src/analyzer/runner/stage-runner.reasoning-overflow-level.test.ts` (new — see Step 1)

**Interfaces:**
- Consumes: `AnalysisEngine` (`server/src/analyzer/model-id.ts`, W3); `TransportKind` (`server/src/analyzer/errors.ts`, W1); `REASONING_STYLES` (`server/src/workspace/analyzer-endpoints.ts`, W3 — test-only import, see cycle note); `TransportRequest` (W1 Task 1.7, plus W4's `freeText` / optional `temperature`); `EngineRequestSettings`, `StageRunner` and its private `send(system, messages, temperature, structuredOutput, call, withEvalTiming)` helper (W1 Task 1.11), whose first two statements wave 2 made `await this.transport.prepare?.(call.signal);` and `const settings = this.settings();`, with `maxOutputTokens: settings.maxOutputTokens,` in its request literal (there is no `resolveSettings()` method); `StageRunner.runFreeText` (W4 Task 4.1), whose first statement is `await this.transport.prepare?.(input.signal);`; `geminiModelThinks(model)` (W2, `server/src/analyzer/catalog/gemini-catalog.ts`, the static id rule); `normalizeModelTag` (W1 moved it to `server/src/analyzer/ollama-settings.ts`).
- Produces (contract names, plus the additions marked **new**):
  - `ReasoningLevel`, declared here for the first time (wave 1 did not declare it), plus `offeredReasoningLevels`, `reasoningWireFragment`, `GEMINI_REASONING_TABLE` (contract);
  - the contract fields `TransportRequest.reasoning?: ReasoningLevel`, `TransportRequest.extraParams?: Record<string, unknown>`, `EngineRequestSettings.reasoning?: ReasoningLevel` and `EngineRequestSettings.extraParams?: Record<string, unknown>`. Wave 1 added none of them, and wave 4 forwards neither. Here they are optional, so every wave 1–4 settings closure and request literal compiles unchanged; an omitted value is the pre-W5 wire. No wave 1–4 code sets either field: W3b's `openAIRequestSettings` (`server/src/analyzer/openai.ts`, which `OpenAIAnalyzer`'s settings closure calls) and its OpenAI transport contract-suite `request()` helper set neither, and its `OpenAITransport` params object sends neither. Task 5.3 adds `reasoning` to the Ollama and Gemini `settings` closures, to `openAIRequestSettings`, and to the OpenAI params. Task 5.10 adds `extraParams` the same way. The contract-suite helper needs no edit, because both fields are optional;
  - runner forwarding of both fields on every transport request: `runStage` (both attempts), `runSingleAttempt` and `runFreeText`;
  - contract `defaultReasoningLevel(engine: AnalysisEngine)` and `geminiRequestThinks(model, level)` (P27);
  - **new** `REASONING_LEVELS`, `ReasoningStyle`, `levelsForReasoningStyle(style)`, `OLLAMA_NAMED_LEVELS`, `testableReasoningLevels(sel)`, `geminiReasoningRow(model)`, `resolveReasoningSetting(settings, sel)` (Ollama entries read through `normalizeModelTag`, N7), `reasoningControlDescription(kind, sel)`. No `GEMINI_THINKING_BUDGETS` (F2 — P9 and the `thinkingBudget` control are retired, not just left unused);
  - **new** leaf `server/src/analyzer/ollama-tag.ts`: `normalizeModelTag(tag)` (moved, body unchanged; `ollama-settings.ts` re-exports it) and `entryForModelTag(map, model)` (N7: one Ollama model id for every per-model map).

**Cycle note (why the types are structural).** `workspace/user-settings.ts` (Task 5.2) and `workspace/analyzer-request-controls.ts` import values from this file, and CLAUDE.md records that even `import type` closes a madge cycle. So `reasoning.ts` imports **no** workspace or capabilities module: the endpoint, record and settings parameters are structural types that `AnalyzerEndpoint`, `ModelCapabilityRecord` and `UserSettings` satisfy. The contract's `endpoint?: AnalyzerEndpoint` / `record?: ModelCapabilityRecord` call sites type-check unchanged. `runner/transport.ts` and `runner/stage-runner.ts` add an `import type { ReasoningLevel } from '../reasoning.js'` edge; `reasoning.ts` imports nothing from `runner/`, so no cycle closes.

`reasoning.ts` has exactly two value imports, both from import-free leaves:
- `geminiModelThinks` from `catalog/gemini-catalog.ts`, which imports only `node:crypto` and `@google/genai` (W2).
- `normalizeModelTag` and `entryForModelTag` from the new `ollama-tag.ts`, which imports nothing. `normalizeModelTag` cannot be imported from W1's `ollama-settings.ts`: that module imports `workspace/user-settings.ts`, which imports `workspace/analyzer-endpoints.ts` (W3b), which imports `reasoning.ts` (Task 5.2). That closes a cycle. So this task moves the function, body unchanged, into the leaf. `ollama-settings.ts` re-exports it, so every existing importer (the keep-alive resolvers, `ollama.ts`'s re-export) compiles unchanged.

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/__fixtures__/reasoning-style-levels.json`:
```json
{
  "reasoning_effort": ["model-default", "none", "minimal", "low", "medium", "high"],
  "enable_thinking": ["model-default", "off", "on"],
  "not_controllable": ["model-default"]
}
```

`server/src/analyzer/__fixtures__/ollama-tag-cases.json` (N7; the frontend mirror in Task 5.6 is pinned to the same table):
```json
[
  { "tag": "qwen3:latest", "normalized": "qwen3" },
  { "tag": "qwen3", "normalized": "qwen3" },
  { "tag": "qwen3.5:9b", "normalized": "qwen3.5:9b" },
  { "tag": "gemma4-e4b-8gb:latest", "normalized": "gemma4-e4b-8gb" },
  { "tag": "hf.co/org/model:latest", "normalized": "hf.co/org/model" },
  { "tag": "latest", "normalized": "latest" }
]
```

`server/src/analyzer/reasoning-level.test.ts` (review pass 3, item 2 — the leaf that lets `errors.ts` avoid importing `reasoning.ts`):
```ts
import { describe, it, expect } from 'vitest';
import { REASONING_LEVELS, type ReasoningLevel } from './reasoning-level.js';
import { REASONING_LEVELS as reExportedLevels } from './reasoning.js';

describe('reasoning-level.ts — the import-free leaf (#3084 wave 5)', () => {
  it('reasoning.ts re-exports the same array, not a copy', () => {
    expect(reExportedLevels).toBe(REASONING_LEVELS);
  });
  it('has the eight levels the rest of this wave assumes', () => {
    expect(REASONING_LEVELS).toEqual(['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high']);
  });
});
```

`server/src/analyzer/ollama-tag.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import cases from './__fixtures__/ollama-tag-cases.json' with { type: 'json' };
import { entryForModelTag, normalizeModelTag } from './ollama-tag.js';
import { normalizeModelTag as reExported } from './ollama-settings.js';

describe('normalizeModelTag — moved to a leaf, body unchanged (#3084 wave 5, N7)', () => {
  it.each(cases)('$tag → $normalized', ({ tag, normalized }) => {
    expect(normalizeModelTag(tag)).toBe(normalized);
  });
  it('ollama-settings re-exports the same function, so keep-alive and ollama.ts are unchanged', () => {
    expect(reExported).toBe(normalizeModelTag);
  });
});

describe('entryForModelTag — one Ollama model id per map (N7)', () => {
  it('finds an entry saved under either tag form, preferring the normalised key', () => {
    expect(entryForModelTag({ qwen3: 'a' }, 'qwen3:latest')).toBe('a');
    expect(entryForModelTag({ 'qwen3:latest': 'b' }, 'qwen3')).toBe('b');
    expect(entryForModelTag({ qwen3: 'a', 'qwen3:latest': 'b' }, 'qwen3:latest')).toBe('a');
    expect(entryForModelTag({ 'qwen3.5:4b': 'c' }, 'qwen3.5:9b')).toBeUndefined();
    expect(entryForModelTag(undefined, 'qwen3')).toBeUndefined();
  });
});
```

`server/src/analyzer/reasoning.test.ts`:
```ts
import { describe, it, expect, expectTypeOf } from 'vitest';
import styleLevels from './__fixtures__/reasoning-style-levels.json' with { type: 'json' };
import { REASONING_STYLES } from '../workspace/analyzer-endpoints.js';
import { geminiModelThinks } from './catalog/gemini-catalog.js';
import {
  GEMINI_REASONING_TABLE,
  REASONING_LEVELS,
  defaultReasoningLevel,
  geminiReasoningRow,
  geminiRequestThinks,
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

describe('GEMINI_REASONING_TABLE — 3.x Flash family only (F2, 2026-09-13); 2.5 ids get model default only', () => {
  const THREE_X_FULL: ReasoningLevel[] = ['model-default', 'minimal', 'low', 'medium', 'high'];
  const NO_MINIMAL: ReasoningLevel[] = ['model-default', 'low', 'medium', 'high'];
  /* defaultLevel — the level Google's docs name as each model's own default (review item 2, 2026-09-13):
     verified on ai.google.dev/gemini-api/docs/generate-content/thinking, two independent reads 2026-09-13.
     Used only to decide whether a model-default overflow still has a lower rung to suggest (Task 5.5b);
     the wire itself keeps omitting the field at model-default (unchanged). */
  it.each<[string, string | undefined, ReasoningLevel[], ReasoningLevel | undefined]>([
    ['gemini-3.6-flash', 'thinkingLevel', THREE_X_FULL, 'medium'],
    ['gemini-3.5-flash', 'thinkingLevel', THREE_X_FULL, 'medium'],
    ['gemini-3-flash-preview', 'thinkingLevel', THREE_X_FULL, 'high'],
    ['gemini-3.5-flash-lite', 'thinkingLevel', THREE_X_FULL, 'minimal'],
    ['gemini-3.1-flash-lite', 'thinkingLevel', THREE_X_FULL, 'minimal'],
    ['gemini-3.8-flash', 'thinkingLevel', NO_MINIMAL, 'medium'],
    ['gemini-3.7-flash', 'thinkingLevel', NO_MINIMAL, 'medium'],
    ['gemini-3.1-pro-preview', 'thinkingLevel', NO_MINIMAL, 'high'],
    ['gemma-4-31b-it', 'gemmaOnOff', ['model-default', 'off', 'on'], undefined],
    ['gemma-4-26b-a4b-it', 'gemmaOnOff', ['model-default', 'off', 'on'], undefined],
    ['models/gemini-3.6-flash', 'thinkingLevel', THREE_X_FULL, 'medium'],
    ['gemini-3.6-flash-lite', undefined, ['model-default'], undefined],
    ['gemini-9-ultra', undefined, ['model-default'], undefined],
    /* F2 — 2.5 is retired from the table; a 2.5 id gets model-default only, exactly like an unknown id. */
    ['gemini-2.5-flash', undefined, ['model-default'], undefined],
    ['gemini-2.5-flash-lite', undefined, ['model-default'], undefined],
    ['gemini-2.5-pro', undefined, ['model-default'], undefined],
  ])('%s → %s (defaultLevel %s)', (model, control, levels, defaultLevel) => {
    expect(geminiReasoningRow(model)?.control).toBe(control);
    expect(offeredReasoningLevels({ engine: 'gemini', model })).toEqual(levels);
    expect(geminiReasoningRow(model)?.defaultLevel).toBe(defaultLevel);
  });

  it('has exactly 6 rows: Flash-Lite, 3 Flash, 3.5/3.6 Flash, 3.7/3.8 Flash, 3.1 Pro, Gemma', () => {
    expect(GEMINI_REASONING_TABLE.length).toBe(6);
  });

  it('never sends thinkingBudget: no Gemini request ever carries it, in the fragment or the resolved settings (F2 — P9 retired)', () => {
    const ids = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemma-4-31b-it'];
    for (const model of ids) {
      for (const level of offeredReasoningLevels({ engine: 'gemini', model })) {
        const cfg = (reasoningWireFragment('gemini', { model }, level).thinkingConfig ?? {}) as Record<string, unknown>;
        expect('thinkingBudget' in cfg).toBe(false);
      }
    }
  });

  it('maps levels to the documented wire values', () => {
    expect(reasoningWireFragment('gemini', { model: 'gemini-3.6-flash' }, 'minimal')).toEqual({ thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: true } });
    expect(reasoningWireFragment('gemini', { model: 'gemini-3.6-flash' }, 'high')).toEqual({ thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } });
    expect(reasoningWireFragment('gemini', { model: 'gemma-4-31b-it' }, 'on')).toEqual({ thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } });
    expect(reasoningWireFragment('gemini', { model: 'gemma-4-31b-it' }, 'off')).toEqual({ thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    expect(reasoningWireFragment('gemini', { model: 'gemini-3.6-flash' }, 'model-default')).toEqual({});
    /* F2 — a 2.5 id has no row, so it offers model-default only and its fragment is always {}. */
    expect(reasoningWireFragment('gemini', { model: 'gemini-2.5-flash' }, 'model-default')).toEqual({});
  });

  it('every Gemini level that thinks carries includeThoughts; off never does (P19)', () => {
    for (const model of ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemma-4-31b-it']) {
      for (const level of offeredReasoningLevels({ engine: 'gemini', model })) {
        const cfg = reasoningWireFragment('gemini', { model }, level).thinkingConfig as Record<string, unknown> | undefined;
        if (level === 'model-default') expect(cfg, `${model} ${level}`).toBeUndefined();
        else if (level === 'off') expect(cfg !== undefined && 'includeThoughts' in cfg, `${model} ${level}`).toBe(false);
        else expect(cfg?.includeThoughts, `${model} ${level}`).toBe(true);
      }
    }
  });

  it('refuses a level the model does not offer instead of downgrading it', () => {
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-3.8-flash' }, 'minimal')).toThrow(/"minimal" is not available/);
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-9-ultra' }, 'low')).toThrow(/"low" is not available/);
    /* F2 — a 2.5 id has no row, so any non-default level is refused the same way an unknown id's would be. */
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-2.5-pro' }, 'high')).toThrow(/"high" is not available/);
  });
});

describe('geminiRequestThinks — per request (P27)', () => {
  it('the id rule decides the default; a level that turns thinking on or off decides the request', () => {
    expect(geminiRequestThinks('gemini-3.6-flash', undefined)).toBe(true);
    expect(geminiRequestThinks('gemini-3.6-flash', 'model-default')).toBe(true);
    expect(geminiRequestThinks('gemma-4-31b-it', undefined)).toBe(false);
    expect(geminiRequestThinks('gemma-4-31b-it', 'on')).toBe(true);
    expect(geminiRequestThinks('gemma-4-31b-it', 'off')).toBe(false);
    /* F2 — a 2.5 id has no row, so any level falls back to the static id rule, same as an unknown id. */
    expect(geminiRequestThinks('gemini-2.5-flash', 'off')).toBe(geminiModelThinks('gemini-2.5-flash'));
  });

  it('agrees with the wire for every offered level: a level thinks exactly when its fragment carries includeThoughts', () => {
    for (const model of ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemma-4-31b-it', 'gemini-9-ultra']) {
      for (const level of offeredReasoningLevels({ engine: 'gemini', model })) {
        const cfg = reasoningWireFragment('gemini', { model }, level).thinkingConfig as Record<string, unknown> | undefined;
        const expected = level === 'model-default' ? geminiModelThinks(model) : cfg?.includeThoughts === true;
        expect(geminiRequestThinks(model, level), `${model} ${level}`).toBe(expected);
      }
    }
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
  it('reads the saved setting per Ollama model, per Gemini model, and per endpoint (P18)', () => {
    const s = { analyzerReasoningByEngine: { ollama: { 'q:4b': 'on' as const }, gemini: { 'gemini-3.6-flash': 'low' as const } } };
    expect(resolveReasoningSetting(s, { engine: 'local', model: 'q:4b' })).toBe('on');
    expect(resolveReasoningSetting(s, { engine: 'local', model: 'q:9b' })).toBe('off'); // model A's level is never model B's
    expect(resolveReasoningSetting(s, { engine: 'gemini', model: 'gemini-3.6-flash' })).toBe('low');
    expect(resolveReasoningSetting(s, { engine: 'gemini', model: 'gemini-3.5-flash' })).toBe('model-default');
    expect(resolveReasoningSetting(s, { engine: 'openai', model: 'm', endpoint: { reasoning: 'none' } })).toBe('none');
  });
});

describe('stored values (N7, N10)', () => {
  it('reads an Ollama entry through normalizeModelTag, so a bare tag and its :latest form share one level (N7)', () => {
    const bare = { analyzerReasoningByEngine: { ollama: { qwen3: 'on' } } };
    expect(resolveReasoningSetting(bare, { engine: 'local', model: 'qwen3:latest' })).toBe('on');
    expect(resolveReasoningSetting(bare, { engine: 'local', model: 'qwen3' })).toBe('on');
    const latest = { analyzerReasoningByEngine: { ollama: { 'qwen3:latest': 'high' } } };
    expect(resolveReasoningSetting(latest, { engine: 'local', model: 'qwen3' })).toBe('high');
  });

  it('returns an unknown stored value as saved, so the pre-run check can refuse it (N10, P17)', () => {
    const s = { analyzerReasoningByEngine: { gemini: { 'gemini-3.6-flash': 'xhigh' } } };
    expect(resolveReasoningSetting(s, { engine: 'gemini', model: 'gemini-3.6-flash' })).toBe('xhigh');
    expect(offeredReasoningLevels({ engine: 'gemini', model: 'gemini-3.6-flash' })).not.toContain('xhigh');
  });
});

describe('reasoningControlDescription', () => {
  it('names the actual control per engine and style', () => {
    expect(reasoningControlDescription('ollama', { model: 'q:4b' })).toMatch(/Ollama reasoning setting.*"think"/);
    expect(reasoningControlDescription('gemini', { model: 'gemini-3.6-flash' })).toMatch(/thinkingLevel.*cannot turn thinking off/);
    expect(reasoningControlDescription('gemini', { model: 'gemma-4-31b-it' })).toMatch(/thinkingLevel.*"off" sends MINIMAL/);
    expect(reasoningControlDescription('gemini', { model: 'gemini-9-ultra' })).toMatch(/cannot be controlled/);
    /* F2 — a 2.5 id has no row, so it reads the same as an unknown id. */
    expect(reasoningControlDescription('gemini', { model: 'gemini-2.5-flash' })).toMatch(/cannot be controlled/);
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
  prepare?: (signal?: AbortSignal) => Promise<void>;
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

  it('the free-text path reads settings AFTER prepare(signal), and hands prepare the caller signal (P26)', async () => {
    const t = new RecordingTransport(['A voice.']);
    let level: 'low' | 'high' = 'low';
    const seen: Array<AbortSignal | undefined> = [];
    t.prepare = async (signal) => {
      seen.push(signal);
      level = 'high'; // a warm-up that changes what the settings resolve to, as the catalog warm-up does
    };
    const runner = new StageRunner({
      transport: t,
      policy: OLLAMA_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, reasoning: level }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    const ac = new AbortController();
    await runner.runFreeText({ prompt: 'persona please', signal: ac.signal });
    expect(t.requests[0].reasoning).toBe('high');
    expect(seen).toEqual([ac.signal]);
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
Run: `npm --prefix server run test -- src/analyzer/reasoning.test.ts src/analyzer/ollama-tag.test.ts src/analyzer/runner/stage-runner.request-controls.test.ts`
Expected: FAIL.
- `reasoning.test.ts` fails with `Failed to resolve import "./reasoning.js"`, and `ollama-tag.test.ts` with `Failed to resolve import "./ollama-tag.js"`.
- `stage-runner.request-controls.test.ts`: the first four cases fail, for example `expected [ undefined, undefined ] to deeply equal [ 'high', 'high' ]` and `expected undefined to be 'high'`. The runner does not forward either field yet, and vitest does not typecheck. The last case passes; it pins the default.

- [ ] **Step 3: Implement**

`ReasoningLevel` is declared here for the first time. Wave 1 declared no `ReasoningLevel`, and added no `reasoning` / `extraParams` to `TransportRequest` or `EngineRequestSettings`; wave 4 forwards neither. This task declares the type, adds both optional fields and adds the runner forwarding.

`server/src/analyzer/reasoning.ts`:
```ts
/* #3084 wave 5 (D8, spec §8) — reasoning levels per engine family and per
   endpoint control style. Pure: no settings, capabilities or workspace import
   (those modules import THIS one; see the plan's cycle note). Its two value
   imports are import-free leaves (catalog/gemini-catalog.ts, ollama-tag.ts).
   Every parameter type below is structural so AnalyzerEndpoint /
   ModelCapabilityRecord / UserSettings satisfy it.

   Sources:
   - Gemini levels per model: ai.google.dev/gemini-api/docs/generate-content/thinking
     and ai.google.dev/gemini-api/docs/latest-model (both re-verified 2026-09-13
     per owner feedback F2, which focuses this table on the current 3.x Flash
     family and retires the 2.5 thinkingBudget control): 3.8/3.7 Flash and
     3.1 Pro offer low/medium/high (MINIMAL is a 400); 3.6/3.5 Flash and
     3.5/3.1 Flash-Lite offer minimal/low/medium/high; no 3.x model can disable
     thinking. The two pages disagree on the 3.8/3.7 default (thinking page:
     low; 3.8 page: medium), so nothing here may depend on a default —
     `model-default` omits the field, same as an unknown id. Sending both
     `thinkingLevel` and `thinkingBudget` is a 400 — moot here, since this
     table never sends `thinkingBudget` (below). Gemma 4 on/off = thinkingLevel
     HIGH / MINIMAL: ai.google.dev/gemma/docs/core/gemma_on_gemini_api.
   - **2.5 is out of scope (F2).** Gemini 2.5 is legacy and Google is steering
     users to 3.x; the `thinkingBudget` control and its 1024/8192/24576 tier
     values are retired entirely, not just left unused. A 2.5 model id gets
     `model-default` only, exactly like an id this table has never heard of.
   - Ollama think values: true | false | "low" | "medium" | "high"; a level or
     true on a non-thinking model is a 400 (research 06 §16-17).
   - llama.cpp accepts reasoning_effort "none" (thinking off) and passes other
     strings to the template unvalidated; vLLM accepts none…high (research 06
     §3, §11). Help text must say a server may accept a level and ignore it. */

import type { AnalysisEngine } from './model-id.js';
import type { TransportKind } from './errors.js';
import { geminiModelThinks } from './catalog/gemini-catalog.js';
import { entryForModelTag } from './ollama-tag.js';
export { REASONING_LEVELS, type ReasoningLevel } from './reasoning-level.js'; // review pass 3, item 2 — moved to a leaf so errors.ts can import it with no cycle back through here
import { REASONING_LEVELS, type ReasoningLevel } from './reasoning-level.js';

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

/* F2 (2026-09-13) — 'thinkingBudget' is retired: the table covers only the
   3.x Flash family (thinkingLevel) and Gemma 4 (gemmaOnOff). A 2.5 id matches
   no row and offers model-default only, like any id this table has never
   heard of. */
type GeminiControl = 'thinkingLevel' | 'gemmaOnOff';
const LEVEL_FULL: ReasoningLevel[] = ['model-default', 'minimal', 'low', 'medium', 'high'];
const LEVEL_NO_MINIMAL: ReasoningLevel[] = ['model-default', 'low', 'medium', 'high'];

/* First match wins. Flash-Lite rows precede Flash rows, and every Flash row
   also carries (?!-lite), so a new "-lite" id never inherits a Flash row. An id
   that matches nothing — including every Gemini 2.5 id — offers model-default only. */
/* defaultLevel (review item 2, 2026-09-13; corrected review pass 2 per
   docs/superpowers/specs/2026-09-11-openai-compatible-analyzer-planning-facts.md §C.2, re-verified
   2026-09-13) — the level Google's docs name as the model's own default. It decides only whether a
   model-default overflow still has a lower rung to suggest (Task 5.5b's reasoningOverflowFixes); the
   wire keeps omitting the field at model-default regardless. Gemma's gemmaOnOff row carries none —
   its model-default is outside the thinking rule entirely (P27) and never gets a reasoning fix at all.
   3 Flash (bare, no dot-version — "gemini-3-flash-preview") defaults to `high`, distinct from 3.5/3.6
   Flash's `medium` (facts §C.2: "3.6 Flash / 3.5 Flash / 3 Flash: minimal supported; default medium
   (3.6/3.5), high (3 Flash)"), so it is its own row rather than sharing 3.5/3.6's. */
export const GEMINI_REASONING_TABLE: ReadonlyArray<{ match: RegExp; control: GeminiControl; levels: ReasoningLevel[]; defaultLevel?: ReasoningLevel }> = [
  { match: /^gemini-3\.(?:5|1)-flash-lite(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_FULL, defaultLevel: 'minimal' },
  { match: /^gemini-3-flash(?!-lite)(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_FULL, defaultLevel: 'high' },
  { match: /^gemini-3\.(?:5|6)-flash(?!-lite)(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_FULL, defaultLevel: 'medium' },
  { match: /^gemini-3\.(?:7|8)-flash(?!-lite)(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_NO_MINIMAL, defaultLevel: 'medium' },
  { match: /^gemini-3\.1-pro(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_NO_MINIMAL, defaultLevel: 'high' },
  { match: /^gemma-4-/, control: 'gemmaOnOff', levels: ['model-default', 'off', 'on'] },
];

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

/* The last-resort guard: a level only reaches it when a value slipped past every save rule and the
   pre-run check. Task 5.4 replaces this body so that throw is the coded AnalyzerReasoningUnavailableError
   marked `mid-run` (N10) — the class does not exist until that task, so PR 5a lands it in two steps. */
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
      /* P19: every request that thinks asks for thought summaries (they feed the heartbeat and never
         enter the answer). `off` (Gemma's MINIMAL — the only row with an `off` level; thinkingBudget
         is retired, F2) does not think, so it carries none. */
      const thoughts = level === 'off' ? {} : { includeThoughts: true };
      if (row.control === 'gemmaOnOff') {
        return { thinkingConfig: { thinkingLevel: level === 'on' ? 'HIGH' : 'MINIMAL', ...thoughts } };
      }
      /* F2 — 'thinkingBudget' is retired; every remaining row is 'thinkingLevel'. */
      return { thinkingConfig: { thinkingLevel: level.toUpperCase(), ...thoughts } };
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

/** P27 — whether ONE Gemini request thinks. The static id rule (W2's geminiModelThinks) decides the
    model's default; a level that turns thinking on (Gemma `on`, any 3.x level above `off`)
    makes the request a thinking request, and a level that turns it off (Gemma's `off`, i.e.
    MINIMAL) makes it a non-thinking one. A 2.5 id has no row, so any level falls back to the id
    rule (F2). Settings alone decide it, never the catalog. It agrees with
    reasoningWireFragment's includeThoughts for every offered level (reasoning.test.ts). A level the
    model does not offer falls back to the id rule: reasoningWireFragment refuses that request, and the
    pre-run check refuses the run (P17), before anything is sent. One function feeds both
    `includeThoughts` and the thinking window (Task 5.3). */
export function geminiRequestThinks(model: string, level: ReasoningLevel | undefined): boolean {
  if (level === undefined || level === 'model-default') return geminiModelThinks(model);
  const row = geminiReasoningRow(model);
  if (!row || !row.levels.includes(level)) return geminiModelThinks(model);
  return level !== 'off';
}

/* N10 — stored values are plain strings: a value this version does not know (e.g. `xhigh`) loads,
   and the pre-run check refuses it as stale (P17). */
interface ReasoningSettingsView {
  analyzerReasoningByEngine?: { ollama?: Record<string, string>; gemini?: Record<string, string> };
}

export function resolveReasoningSetting(
  settings: ReasoningSettingsView,
  sel: { engine: AnalysisEngine; model: string; endpoint?: { reasoning: string } },
): ReasoningLevel {
  switch (sel.engine) {
    case 'local':
      /* P18: per model. N7: one Ollama model id — a bare tag and its `:latest` form are the same model. */
      return (entryForModelTag(settings.analyzerReasoningByEngine?.ollama, sel.model) as ReasoningLevel | undefined) ?? defaultReasoningLevel('local');
    case 'gemini':
      return (settings.analyzerReasoningByEngine?.gemini?.[sel.model] as ReasoningLevel | undefined) ?? defaultReasoningLevel('gemini');
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
    /* F2 — a 2.5 id has no row (thinkingBudget is retired), so it reads the same as an unknown id. */
    if (!row) return `${where}) — this model's reasoning cannot be controlled from Castwright yet`;
    if (row.control === 'gemmaOnOff') return `${where}; sent as thinkingLevel — "off" sends MINIMAL)`;
    return `${where}; sent as thinkingLevel — this model cannot turn thinking off, the lowest level is ${row.levels[1]})`;
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

`server/src/analyzer/ollama-tag.ts` (new, import-free). Cut `normalizeModelTag` and its doc comment out of `server/src/analyzer/ollama-settings.ts` (W1 moved it there verbatim from `ollama.ts:202-206` at `80be2f1d`, re-pinned from `:201-205`; find it with `git grep -n "export function normalizeModelTag" -- server/src`), paste them here unchanged, and add `entryForModelTag`:
```ts
/* #3084 wave 5 (N7) — Ollama model tag identity. A leaf with no imports, so reasoning.ts, capabilities.ts,
   workspace/analyzer-request-controls.ts and user-settings.ts can all use the one normaliser without a cycle. */

/** Strip a trailing ':latest' only (Ollama treats bare == :latest). Leaves real
    tags like 'qwen3.5:9b' untouched. */
export function normalizeModelTag(tag: string): string {
  return tag.endsWith(':latest') ? tag.slice(0, -':latest'.length) : tag;
}

/** N7 — the entry a per-model map holds for an Ollama model, whichever tag form it was saved under.
    The normalised key wins when both forms are present. */
export function entryForModelTag<T>(map: Readonly<Record<string, T>> | undefined, model: string): T | undefined {
  if (!map) return undefined;
  const key = normalizeModelTag(model);
  if (Object.hasOwn(map, key)) return map[key];
  const hit = Object.entries(map).find(([saved]) => normalizeModelTag(saved) === key);
  return hit?.[1];
}
```
In `server/src/analyzer/ollama-settings.ts`, where the definition was, add:
```ts
import { normalizeModelTag } from './ollama-tag.js';
export { normalizeModelTag } from './ollama-tag.js';
```
Nothing else in `ollama-settings.ts` changes: `resolveKeepAliveSeconds` and `hasKeepAliveOverride` keep calling `normalizeModelTag`.

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
- **Stage requests.** `runStage`'s two attempts and `runSingleAttempt` reach the transport only through the private `send(system, messages, temperature, structuredOutput, call, withEvalTiming)` helper, so its one `this.transport.send({ … })` literal covers all three calls. There is no `resolveSettings()` method. Wave 2 already made the helper's first two statements:
```ts
    await this.transport.prepare?.(call.signal);
    const settings = this.settings();
```
  and its literal reads `maxOutputTokens: settings.maxOutputTokens,`. Leave both statements as they are. Directly after that `maxOutputTokens` entry, add:
```ts
      reasoning: settings.reasoning,
      extraParams: settings.extraParams,
```
  **Where the level actually reaches the overflow error (review pass 2, item 1; corrected review pass 3, item 4).** W1 Task 1.12 (`finish.ts`'s `withThinkEvidence`) already changed this helper's last statement to `return mapFinish(withThinkEvidence(result), { kind: this.transport.kind, model: this.transport.model });` (w1's exact text: "`runner/stage-runner.ts` — in `send`, import `withThinkEvidence` alongside `mapFinish` and change the last line to `return mapFinish(withThinkEvidence(result), { kind: this.transport.kind, model: this.transport.model });`") — **keep the `withThinkEvidence(result)` wrapper**; this task only adds `reasoningLevel` to the ctx object beside it, it does not touch the first argument. This is the ONLY throw site for `AnalyzerReasoningOverflowError` outside `runFreeText`'s own inline check (below). No transport throws it; `ollama-transport.ts`/`gemini-transport.ts` are untouched by this task. Change that call to:
```ts
    return mapFinish(withThinkEvidence(result), { kind: this.transport.kind, model: this.transport.model, reasoningLevel: settings.reasoning });
```
- **Free text.** In `runFreeText` (W4 Task 4.1), leave its first statement, `await this.transport.prepare?.(input.signal);`, as it is. It passes the caller's own signal, so a pause releases a stalled warm-up (P26). Directly after it, add:
```ts
    const settings = this.settings();
```
  Then, directly after the request literal's `maxOutputTokens: undefined,` entry, add:
```ts
      reasoning: settings.reasoning,
      extraParams: settings.extraParams,
```
  Free text still ignores `settings.maxOutputTokens`. W4's mutation proof pins that. Replace W4's comment above the `prepare` line, which says wave 5 adds this read, with `/* The runner awaits prepare(signal) before it reads settings, as wave 2's private send does (P26). */`.
  `runFreeText` does not call `mapFinish` — it has its own inline overflow check (W4 Task 4.1's `runFreeText` body, the line `throw new AnalyzerReasoningOverflowError(this.transport.kind, this.transport.model, answer.usage?.reasoningTokens);`, directly after `if (answer.finish === 'length' && answer.text.trim() === '' && hasReasoningEvidence(answer)) {`). Change that one throw to:
```ts
      throw new AnalyzerReasoningOverflowError(this.transport.kind, this.transport.model, answer.usage?.reasoningTokens, { reasoningLevel: settings.reasoning });
```

**`errors.ts` — one opts object, no 5th positional argument (review pass 2, item 2).** `AnalyzerReasoningOverflowError` is defined in `server/src/analyzer/errors.ts` (3b.1b's Files list — not `failure-taxonomy.ts`, which only reads `err.reasoningLevel`). 3b already widens its constructor with a 4th, optional `opts?: { endpointId?: string }` argument, `endpointId` stored as a **mutable** public field so `OpenAIAnalyzer`'s `withEndpointId` can attach it after construction (Task 3b.1b's plan text, `docs/superpowers/plans/2026-09-11-openai-compatible-analyzer-w3ab.md` — since that file is owned by a different fixer and its line numbers drift, confirm the landed shape with `git grep -n "opts" server/src/analyzer/errors.ts` rather than trusting a pinned line). This task adds `reasoningLevel?: ReasoningLevel` as a **sibling field inside that same `opts` object** — never a 5th positional argument:
```ts
// server/src/analyzer/errors.ts (2b's class, widened by 3b.1b with endpointId, by this task with reasoningLevel)
export class AnalyzerReasoningOverflowError extends Error {
  readonly code = 'ANALYZER_REASONING_OVERFLOW';
  public endpointId?: string;              // 3b.1b — mutable, attached post-construction by withEndpointId
  public readonly reasoningLevel?: ReasoningLevel; // 5a — the level the request actually ran at
  constructor(
    public readonly transport: TransportKind,
    public readonly model: string,
    public readonly reasoningTokens: number | undefined,
    opts?: { endpointId?: string; reasoningLevel?: ReasoningLevel },
  ) {
    super(
      `${transport} ${model} used its whole output budget on reasoning` +
        (reasoningTokens ? ` (${reasoningTokens} reasoning tokens)` : '') +
        ' and returned no answer — splitting the chunk cannot shrink reasoning.',
    );
    this.name = 'AnalyzerReasoningOverflowError';
    this.endpointId = opts?.endpointId;
    this.reasoningLevel = opts?.reasoningLevel;
  }
}
```
**Corrected — no `errors.ts` ↔ `reasoning.ts` cycle (review pass 3, item 2).** `errors.ts` cannot `import type { ReasoningLevel } from './reasoning.js'`: `reasoning.ts` already imports `type { TransportKind } from './errors.js'` (this file, line 483 above), and Task 5.4 turns that into a **value** import (it adds `AnalyzerReasoningUnavailableError` to the same `./errors.js` import, per that task's own Step 3). `errors.ts` importing anything from `reasoning.ts` — even `import type`, which madge counts — would close that cycle back on itself. So `ReasoningLevel` moves to a new leaf:
- **Create `server/src/analyzer/reasoning-level.ts`** — imports nothing, exports `REASONING_LEVELS` and `type ReasoningLevel`:
```ts
/* #3084 wave 5 — import-free leaf. errors.ts needs ReasoningLevel and reasoning.ts already imports
   (soon a VALUE import, Task 5.4) from errors.ts, so ReasoningLevel cannot live in reasoning.ts
   itself without closing a cycle back through errors.ts. Both files import this leaf instead. */
export const REASONING_LEVELS = ['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
```
- **`reasoning.ts`** deletes its own `export const REASONING_LEVELS = […]; export type ReasoningLevel = …;` (lines 487-488 above) and instead imports and re-exports them from the leaf: `export { REASONING_LEVELS, type ReasoningLevel } from './reasoning-level.js';` — every existing importer of `REASONING_LEVELS`/`ReasoningLevel` from `'./reasoning.js'` (or `'../reasoning.js'`, `'../../lib/reasoning-levels'` on the frontend, unaffected) keeps working unchanged, since the symbol is still available from the same path.
- **`errors.ts`** adds `import type { ReasoningLevel } from './reasoning-level.js';` — a one-way edge into the same leaf, not into `reasoning.ts`.

**`runner/finish.ts` — `mapFinish`'s ctx gains `reasoningLevel?`.** Change the signature and throw:
```ts
export function mapFinish(r: TransportResult, ctx: { kind: TransportKind; model: string; reasoningLevel?: ReasoningLevel }): string {
  …
  if (r.finish === 'length') {
    const answer = stripThink(r.text);
    if (answer.text.trim() === '' && (hasReasoningEvidence(r) || answer.unterminated)) {
      throw new AnalyzerReasoningOverflowError(ctx.kind, ctx.model, r.usage?.reasoningTokens, { reasoningLevel: ctx.reasoningLevel });
    }
    …
  }
  …
}
```
(the rest of the function body — the `blocked` branch, the truncation throw, the Ollama empty-response check, `return r.text` — is unchanged from W2's version.) Every other `mapFinish` call site (W1's transport `send` methods, if any still call it directly rather than through the runner) passes no third field, which is fine: it is optional.

**Test — the level really is set where the error is thrown (review pass 2, item 1).** Create `server/src/analyzer/runner/stage-runner.reasoning-overflow-level.test.ts`:
```ts
/* #3084 wave 5 — proves the runner forwards settings.reasoning to the overflow error for every
   transport kind: AnalyzerReasoningOverflowError.reasoningLevel is set AT THE THROW SITE (mapFinish,
   inside StageRunner's private send, and runFreeText's own inline check), from the level the request
   actually carried — never re-derived from live settings later (that would race a setting the user
   changes between the overflow and when the failure renders, Task 5.5b). The transport-specific WIRE
   mapping (which literal Ollama/Gemini/OpenAI-compatible field each level becomes) is Task 5.3's job,
   not this test's — a fake transport here only returns a fixed overflowing TransportResult, the same
   shape regardless of kind, so this test is scoped to the runner-to-error plumbing alone. */
import { describe, it, expect } from 'vitest';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './retry-policy.js';
import { AnalyzerReasoningOverflowError } from '../errors.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';
import { z } from 'zod';

const OVERFLOW: TransportResult = { text: '', reasoningSeen: true, finish: 'length', receivedBytes: 0, usage: { reasoningTokens: 900 } };
const schema = z.object({ ok: z.literal(true) });
/* Real HandoffKey/SkillName literals (W1's own tests use these exact values elsewhere:
   `key: '1-ch1' as const` at stage-runner.test.ts, `skillName: 'whole_book_stage1'` at
   transport-analyzer.ts's stage-1 call) — not placeholder strings, so this compiles against W1's
   actual unions rather than needing an `as never` escape. */
const stageSpec = { manuscriptId: 'm1', key: '1-ch1' as const, skillName: 'whole_book_stage1' as const, promptMd: 'p', grammarSchema: schema, validationSchema: schema };

function fakeTransport(kind: 'ollama' | 'gemini' | 'openai'): ChatTransport {
  return {
    kind,
    model: `${kind}-model`,
    async send(_req: TransportRequest): Promise<TransportResult> {
      return OVERFLOW;
    },
  };
}

describe.each(['ollama', 'gemini', 'openai'] as const)('%s: the runner forwards settings.reasoning to the overflow error', (kind) => {
  it('runStage', async () => {
    const runner = new StageRunner({
      transport: fakeTransport(kind),
      policy: OLLAMA_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, reasoning: 'high' }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    const err = await runner.runStage(stageSpec, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect((err as AnalyzerReasoningOverflowError).reasoningLevel).toBe('high');
  });

  it('runFreeText', async () => {
    const runner = new StageRunner({
      transport: fakeTransport(kind),
      policy: OLLAMA_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'off', maxOutputTokens: undefined, reasoning: 'medium' }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    const err = await runner.runFreeText({ prompt: 'p' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect((err as AnalyzerReasoningOverflowError).reasoningLevel).toBe('medium');
  });
});
```
Run it: expected FAIL before Step 3 (`reasoningLevel` is `undefined` on both throws, since neither `mapFinish` nor `runFreeText`'s inline throw pass it yet). After Step 3: PASS.
**Mutation:** in the private `send` helper's `mapFinish` call, drop `reasoningLevel: settings.reasoning`. Expected red: the `runStage` case of this new describe, for all three kinds. Restore. In `runFreeText`'s throw, drop the same field from its `opts`. Expected red: the `runFreeText` case, for all three kinds. Restore.

- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/reasoning.test.ts src/analyzer/reasoning-level.test.ts src/analyzer/ollama-tag.test.ts src/analyzer/runner/stage-runner.request-controls.test.ts src/analyzer/runner src/analyzer/transports src/analyzer/ollama.test.ts`, then `npm run typecheck` and `npm run check:cycles`.
Expected: PASS, and `check:cycles` prints its `OK` line with the count unchanged. If it reports a cycle through `catalog/gemini-catalog.ts`, `ollama-tag.ts` or the new `reasoning-level.ts`, stop and report it: all three must stay import-free leaves — `reasoning-level.ts` specifically must import nothing, since it is the leaf `errors.ts` now depends on directly (review pass 3, item 2), and if it imported anything from `errors.ts` or `reasoning.ts` the cycle this leaf exists to avoid would reopen. Keeps green:
- `ollama.test.ts`, whose keep-alive cases call `normalizeModelTag` through `ollama-settings.ts`'s re-export;
- W1's `stage-runner.test.ts`, whose settings closures omit both fields;
- W4's `stage-runner.free-text.test.ts`;
- every W1–W4 transport suite;
- `npm run typecheck`, since every existing `EngineRequestSettings` literal omits the optional fields.

- [ ] **Step 5: Mutation proof**
1. In the 3.7/3.8 row change `levels: LEVEL_NO_MINIMAL` → `LEVEL_FULL`. Expected red: `gemini-3.8-flash → thinkingLevel` and `refuses a level the model does not offer instead of downgrading it`. Restore.
2. In the `gemmaOnOff` branch swap `'HIGH' : 'MINIMAL'` → `'MINIMAL' : 'HIGH'`. Expected red: `maps levels to the documented wire values`. Restore.
3. Delete `(?!-lite)` from the 3.x Flash row (`/^gemini-3(?:\.(?:5|6))?-flash(?!-lite)(?:$|-)/` → `/^gemini-3(?:\.(?:5|6))?-flash(?:$|-)/`). Expected red: `gemini-3.6-flash-lite → undefined` (the Flash row now claims an unknown Flash-Lite id). Restore.
4. In `offeredReasoningLevels` `'local'` branch replace the filter with `...OLLAMA_NAMED_LEVELS`. Expected red: `offers model-default/off/on, plus named levels only when the Test record accepted them`. Restore.
5. In the private `send` helper delete `reasoning: settings.reasoning,`. Expected red: `first attempt and the validation retry both carry them` and `the escalation single attempt carries them`. Restore.
6. In `runFreeText` delete `extraParams: settings.extraParams,`. Expected red: `the persona free-text path carries them`. Restore.
7. In the `gemmaOnOff` branch drop `...thoughts`. Expected red: `maps levels to the documented wire values` and `every Gemini level that thinks carries includeThoughts; off never does (P19)`. Restore.
8. In `resolveReasoningSetting`'s `'local'` branch replace `entryForModelTag(settings.analyzerReasoningByEngine?.ollama, sel.model)` with `settings.analyzerReasoningByEngine?.ollama?.[Object.keys(settings.analyzerReasoningByEngine?.ollama ?? {})[0]]` (any saved Ollama entry). Expected red: `reads the saved setting per Ollama model, per Gemini model, and per endpoint (P18)` (`q:9b` resolves `on`). Restore.
9. In the same branch replace `entryForModelTag(settings.analyzerReasoningByEngine?.ollama, sel.model)` with `settings.analyzerReasoningByEngine?.ollama?.[sel.model]` (a raw lookup). Expected red: `reads an Ollama entry through normalizeModelTag, so a bare tag and its :latest form share one level (N7)`. Restore.
10. In `entryForModelTag` delete the `Object.entries(map).find(…)` fallback (`return map[key];` only). Expected red: `finds an entry saved under either tag form, preferring the normalised key` (`qwen3:latest` saved, `qwen3` asked). Restore.
11. In `geminiRequestThinks` replace `return level !== 'off';` with `return geminiModelThinks(model);`. Expected red: `the id rule decides the default; a level that turns thinking on or off decides the request` (Gemma `on`) and `agrees with the wire for every offered level…`. Restore.
12. In `runFreeText` move `const settings = this.settings();` above `await this.transport.prepare?.(input.signal);`. Expected red: `the free-text path reads settings AFTER prepare(signal)…` (`expected 'low' to be 'high'`). Restore.
13. In the 3.1 Pro row change `levels: LEVEL_NO_MINIMAL` → `LEVEL_FULL`. Expected red: `gemini-3.1-pro-preview → thinkingLevel (defaultLevel high)`. Restore.
14. In the Flash-Lite row change `defaultLevel: 'minimal'` → `'low'`. Expected red: `gemini-3.5-flash-lite → thinkingLevel (defaultLevel minimal)` and `gemini-3.1-flash-lite → thinkingLevel (defaultLevel minimal)` (both now report `low` where `minimal` is expected). Restore.
15. Add a seventh row matching `/^gemini-2\.5-/` (any control/levels). Expected red: `gemini-2.5-flash → undefined (defaultLevel undefined)`, `gemini-2.5-flash-lite → undefined (defaultLevel undefined)`, `gemini-2.5-pro → undefined (defaultLevel undefined)`, and `has exactly 6 rows…` (now 7). Restore.
16. **Corrected, review pass 3, item 8: name the exact row.** In the **3.5/3.6 Flash row** (not the bare 3 Flash row, which keeps its own `defaultLevel: 'high'` and is untouched by this mutation) change `defaultLevel: 'medium'` → `'minimal'`. Expected red: `gemini-3.6-flash → thinkingLevel (defaultLevel medium)` and `gemini-3.5-flash → thinkingLevel (defaultLevel medium)` (both now report `minimal`) — the bare-3-Flash case (`gemini-3-flash-preview → thinkingLevel (defaultLevel high)`) stays green, proving the two rows are independent. Restore.
17. In `reasoning-level.ts`, change the `reasoning.ts` re-export line to declare a second, separate `REASONING_LEVELS` array instead of re-exporting the leaf's. Expected red: `reasoning.ts re-exports the same array, not a copy` (`toBe` fails — different array identity even if the contents match). Restore.
Paste the seventeen red outputs into the PR body.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/reasoning.ts server/src/analyzer/reasoning-level.ts server/src/analyzer/reasoning-level.test.ts server/src/analyzer/reasoning.test.ts server/src/analyzer/__fixtures__/reasoning-style-levels.json server/src/analyzer/ollama-tag.ts server/src/analyzer/ollama-tag.test.ts server/src/analyzer/__fixtures__/ollama-tag-cases.json server/src/analyzer/ollama-settings.ts server/src/analyzer/runner/transport.ts server/src/analyzer/runner/stage-runner.ts server/src/analyzer/runner/stage-runner.request-controls.test.ts server/src/analyzer/errors.ts server/src/analyzer/runner/finish.ts server/src/analyzer/runner/stage-runner.reasoning-overflow-level.test.ts
git commit -m "feat(server): reasoning levels per engine and request-control fields on the stage runner"
```

### Task 5.2: Settings storage and write validation (`analyzerReasoningByEngine`, endpoint `reasoning`), OpenAPI, mocks

**Files:**
- Modify: `server/src/workspace/user-settings.ts:317` at `80be2f1d`, re-pinned from `:253` (schema, after `analyzerKeepAliveByModel`) and `:390` at `80be2f1d`, re-pinned from `:334` (defaults, after `analyzerKeepAliveByModel: {}`)
- Modify: `server/src/routes/user-settings.ts` — the `PUT /` handler (`:114`, its `try {` at `:115`, at `80be2f1d`, re-pinned from `:84-86`): write validation goes after #3192's `RETIRED_ANALYZER_FIELDS` early-reject block (`:117-129`), still before `writeUserSettings` (`:131`)
- Create: `server/src/workspace/analyzer-request-controls.ts`
- Modify: `server/src/workspace/analyzer-endpoints.ts` (W3b Task 3b.5) — `parseEndpointInput`: delete P23's `reasoning` refusal (the `notYet` push) and run the 5a level rule in its place
- Modify: `openapi.yaml` — `components.schemas` (new `ReasoningLevel`, `AnalyzerReasoningByEngine`), `UserSettings` (after `analyzerKeepAliveByModel`, `openapi.yaml:4822-4826` at `80be2f1d`, re-pinned from `:4758-4762` — `openapi.yaml` changed between `46e62a34` and `80be2f1d` (#3192), so this citation no longer holds unchanged; re-derived directly), `UserSettingsPatch` (after `:4938-4942` at `80be2f1d`, re-pinned from `:4865-4869`), W3's `AnalyzerEndpoint.reasoning`, W3c's catalog model entry schema, W3c's `ModelCapabilityRecord.reasoning`
- Regenerate: `src/lib/api-types.ts`
- Modify: `src/lib/api.ts:6980` at `80be2f1d`, re-pinned from `:6939` (`MOCK_USER_SETTINGS`), `:7394-7422` at `80be2f1d`, re-pinned from `:7312-7342` (`mockPutUserSettings` whitelist — #3192 inserted its `RETIRED_ANALYZER_FIELDS` mock-mirror block, plus a same-shaped 400 throw, ahead of it in the same function; the whitelist logic itself is unchanged), W3b Task 3b.9's `mockEndpointFromInput` (delete its `reasoning` `notYet` push, mirror the 5a level rule), W3c's `mockGetAnalyzerModels`
- Test: `server/src/workspace/analyzer-request-controls.test.ts`, `server/src/routes/user-settings.test.ts` (append), W3b's `server/src/routes/analyzer-endpoints.test.ts` (append, and flip its P23 case), W3b's `server/src/workspace/analyzer-endpoints.test.ts` (flip its P23 case), W3b's `src/lib/api-analyzer-endpoints-mock.test.ts` (flip its P23 case)

**Interfaces:**
- Consumes: Task 5.1 `REASONING_LEVELS`, `offeredReasoningLevels`, `testableReasoningLevels`, `levelsForReasoningStyle`, and the leaf's `normalizeModelTag` / `entryForModelTag`; `inferEngineFromModelId` (W3); `parseEndpointInput`, `AnalyzerEndpointRefusal` (W3b Task 3b.5); `capabilityRecordFor` (W3c, route only); `readUserSettings` (`user-settings.ts`) and `getResolvedOllamaUrl` (re-pinned to 80be2f1d, #3192, A1: `config/ollama-resolved.ts`, not `user-settings.ts`).
- Produces:
  - `UserSettings.analyzerReasoningByEngine: { ollama?: Record<string, string>; gemini?: Record<string, string> }`, both keyed by model id (P18). Stored values are strings (N10): the contract's `ReasoningLevel` is what a save accepts and what a run may send, and an unknown stored value is stale (P17).
  - `RequestControlsContext` and `analyzerRequestControlsPatchSchemaFor(ctx)` (**new**, extended by PR 5b), plus `analyzerRequestControlsPatchSchema`, the same rules with no Test records.
  - **new** `StoredRequestControls`, `changedRequestControls(patch, stored)` (N6) and `withNormalizedOllamaReasoningKeys(body)` (N7).
  - The endpoint level rule inside `parseEndpointInput` (extended by PR 5b); `MOCK_STYLE_LEVELS` in `src/lib/api.ts`; OpenAPI `ReasoningLevel`.
  - `parseEndpointInput(input: unknown, stored?: AnalyzerEndpoint)` — a second parameter `applyUpdate` passes (A7).

**Lifting P23's `reasoning` refusal.** W3b's endpoint routes never parse a schema themselves: `POST /` and `PUT /:endpointId` call `applyCreate` / `applyUpdate`, which call `parseEndpointInput` (w3ab Task 3b.5). Until this PR that function refuses any `reasoning` other than `model-default`, naming PR 5a. This task deletes that push and runs the offered-level rule in the same place, so both routes (and the mock) accept a level its control style offers. The rule lives in `analyzer-endpoints.ts` itself, not in `analyzer-request-controls.ts`: that module would import `analyzer-endpoints.ts` back, a cycle. `analyzer-endpoints.ts` → `analyzer/reasoning.ts` closes none, because `reasoning.ts` imports only types (`model-id.ts`, `errors.ts`). The `extraParams` refusal stays until PR 5b (Task 5.9).

**Why validation is NOT on the stored schema.** `readUserSettings` (`user-settings.ts:579-582` at `80be2f1d`, re-pinned from `:522-525`) falls back to **all defaults** when the stored JSON parses but fails `userSettingsSchema`. An unparseable file takes a different path and does not reject: it is recovered from its `.bak.N` backups, else it returns in-memory defaults with a corruption flag (`:536-555` at `80be2f1d`, re-pinned from `:479-498`). This argument rests on the schema case — the risk being avoided is a per-model refinement wiping a *valid* JSON file. A per-model refinement there would wipe every setting the day the Gemini table changes. The stored shape accepts any string for a level (N10). A value this version does not know, such as `xhigh` saved by a newer release before a rollback, loads, and the pre-run check refuses it as stale (P17, Task 5.4). The offered-level rules run on writes (the PUT route, endpoint create/update). The same applies to endpoints stored inside `analyzerEndpoints`.

**No migration (P18).** No release has stored a single-value `analyzerReasoningByEngine.ollama`. This PR introduces the field, keyed by model id from its first commit, so there is no legacy shape to read or convert. The frontend mocks need no data change either: `MOCK_USER_SETTINGS.analyzerReasoningByEngine` stays `{}`.

**Why the rule runs in the route.** A named Ollama level may be saved only for a model whose own Test record accepted it. The record lookup is W3c's `capabilityRecordFor`, and `capabilities.ts` imports `user-settings.ts`, so the check cannot run inside `writeUserSettings` without a cycle. It runs in the `PUT /api/user/settings` handler, before `writeUserSettings`, through `analyzerRequestControlsPatchSchemaFor(ctx)`. The schema module stays structural and imports neither.

**Judge only what the save changes (N6).** The Settings UI sends whole maps (Task 5.6 saves every Ollama and Gemini entry at once), `writeUserSettings` replaces each sent key wholesale, and a Test record is bound to its server URL. So after an Ollama URL change, re-judging every sent entry would refuse every later save while one stale entry remains. The route therefore judges `changedRequestControls(req.body, stored)`: only the reasoning entries whose value differs from the stored settings. An unchanged stale entry is saved back as it was, and the pre-run check still refuses a run that would send it (P17). `stored` comes from `await readUserSettings()`, never `getCachedUserSettings()`: the boot warm is not awaited — since #3174 it is `void bootWarmUserSettings()` (`server/src/index.ts:188`, which awaits `readUserSettings()` inside its own try/catch at `:135-144`) — so an early save can find the cache cold and judge against defaults with no Test records. **No new handling for a bad settings file.** A malformed file does not reject (`:536-555` at `80be2f1d`, re-pinned from `:479-498`: backup recovery, else defaults with a corruption flag), and a schema failure returns defaults (`:579-582` at `80be2f1d`, re-pinned from `:522-525`). The only rejection left is a locked or unreadable file, or a failed legacy migration — and the analysis POST already awaits `readUserSettings()` on `80be2f1d`, so that outcome is today's behaviour for a route that reads settings, not something this PR defines. Nothing is written either way, so the PUT fails closed.

**An endpoint update judges only what it changes (A7).** `parseEndpointInput` runs on every create and update, so on an update it re-judges a level that is already stored — which would refuse every later edit of an endpoint whose saved level a newer rule no longer offers (a level saved before its `reasoningStyle` changed, a table change), exactly the failure N6 avoids for the settings PUT. `applyUpdate` therefore passes the stored endpoint, and the level rule runs only when this save changes `reasoning`, or changes the `reasoningStyle` that decides which levels are offered. A create has no stored endpoint and is always judged. The run-time refusal (P17) still catches an unchanged stale level before the first call. `mockEndpointFromInput` mirrors the rule for parity but cannot exercise it: every mock write goes through the same check, so no mock endpoint can hold a stale level.

**One Ollama model id (N7).** Ollama reasoning keys are stored through `normalizeModelTag`, so `qwen3` and `qwen3:latest` are one entry. The route writes `withNormalizedOllamaReasoningKeys(req.body)`, and every read goes through `entryForModelTag` (Task 5.1).

- [ ] **Step 1: Write the failing tests**

`server/src/workspace/analyzer-request-controls.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  analyzerRequestControlsPatchSchema,
  analyzerRequestControlsPatchSchemaFor,
  changedRequestControls,
  withNormalizedOllamaReasoningKeys,
} from './analyzer-request-controls.js';
import { userSettingsSchema, DEFAULT_USER_SETTINGS } from './user-settings.js';

const messages = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof z.ZodError) return e.issues.map((i) => i.message); throw e; }
  return [];
};

describe('analyzerRequestControlsPatchSchemaFor — Ollama reasoning, per model (P18)', () => {
  const withRecords = (records: Record<string, Partial<Record<string, 'accepted' | 'rejected'>>>) =>
    analyzerRequestControlsPatchSchemaFor({ ollamaRecord: (model) => (records[model] ? { reasoning: records[model] } : undefined) });
  it('accepts model-default, off and on for any Ollama model with no Test record', () => {
    for (const level of ['model-default', 'off', 'on'] as const) {
      expect(messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': level } } }))).toEqual([]);
    }
  });
  it("refuses a named level without that model's accepted Test record, naming model and level", () => {
    expect(messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } }))).toEqual([
      'Ollama reasoning "low" for qwen3.5:4b needs a Test of that model that accepted it (offered now: model-default, off, on).',
    ]);
  });
  it("accepts a named level the model's own Test accepted, and refuses it for another model", () => {
    expect(
      messages(() => withRecords({ 'qwen3.5:4b': { low: 'accepted' } }).parse({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low', 'qwen3.5:9b': 'low' } } })),
    ).toEqual(['Ollama reasoning "low" for qwen3.5:9b needs a Test of that model that accepted it (offered now: model-default, off, on).']);
  });
  it('refuses Ollama levels that only endpoints have, and endpoint model ids as keys', () => {
    expect(
      messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'none', 'openai:lab::m': 'off' } } })),
    ).toEqual([
      'Ollama reasoning "none" for qwen3.5:4b is not an Ollama level (model-default, off, on, low, medium, high).',
      'Ollama reasoning map key "openai:lab::m" is an endpoint model id; endpoints carry their own Reasoning setting.',
    ]);
  });
});

describe('analyzerRequestControlsPatchSchema — Gemini reasoning', () => {
  it('refuses a Gemini level the model does not offer, naming model and level', () => {
    /* F2 — a 3.x id for the accepted half (gemini-3.8-flash rejects minimal; gemini-3.6-flash's own
       'low' is offered, so it produces no message). */
    expect(
      messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { gemini: { 'gemini-3.8-flash': 'minimal', 'gemini-3.6-flash': 'low' } } })),
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

describe('changedRequestControls — judge only what a save changes (N6)', () => {
  const stored = { analyzerReasoningByEngine: { ollama: { qwen3: 'low', 'q:9b': 'on' }, gemini: { 'gemini-3.8-flash': 'minimal' } } };
  it('keeps only reasoning entries whose value differs from the stored settings, comparing Ollama tags through normalizeModelTag', () => {
    expect(
      changedRequestControls(
        {
          displayName: 'x',
          analyzerReasoningByEngine: {
            ollama: { 'qwen3:latest': 'low', 'q:9b': 'off' },
            gemini: { 'gemini-3.8-flash': 'minimal', 'gemini-3.6-flash': 'low' },
          },
        },
        stored,
      ),
    ).toEqual({ displayName: 'x', analyzerReasoningByEngine: { ollama: { 'q:9b': 'off' }, gemini: { 'gemini-3.6-flash': 'low' } } });
  });
  it('returns a patch without reasoning maps as the same object', () => {
    const patch = { displayName: 'x' };
    expect(changedRequestControls(patch, stored)).toBe(patch);
  });
  it('an unchanged stale entry no longer blocks the rules; the same entry, changed, still does', () => {
    const body = { analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' }, gemini: { 'gemini-3.6-flash': 'low' } } };
    const staleStored = { analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } };
    expect(messages(() => analyzerRequestControlsPatchSchema.parse(changedRequestControls(body, staleStored)))).toEqual([]);
    expect(messages(() => analyzerRequestControlsPatchSchema.parse(changedRequestControls(body, {})))).toEqual([
      'Ollama reasoning "low" for qwen3.5:4b needs a Test of that model that accepted it (offered now: model-default, off, on).',
    ]);
  });
});

describe('withNormalizedOllamaReasoningKeys — one stored key per Ollama model (N7)', () => {
  it('rewrites Ollama reasoning keys through normalizeModelTag and leaves everything else as sent', () => {
    expect(
      withNormalizedOllamaReasoningKeys({
        displayName: 'x',
        analyzerReasoningByEngine: { ollama: { 'qwen3:latest': 'on', 'q:4b': 'off' }, gemini: { 'gemini-3.6-flash': 'low' } },
      }),
    ).toEqual({ displayName: 'x', analyzerReasoningByEngine: { ollama: { qwen3: 'on', 'q:4b': 'off' }, gemini: { 'gemini-3.6-flash': 'low' } } });
    const patch = { displayName: 'x' };
    expect(withNormalizedOllamaReasoningKeys(patch)).toBe(patch);
  });
});

describe('stored schema stays lenient', () => {
  it('loads a stored level the rules no longer offer, or one this version does not know (xhigh), without resetting settings (N10)', () => {
    const parsed = userSettingsSchema.safeParse({
      ...DEFAULT_USER_SETTINGS,
      displayName: 'Kept',
      analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'high' }, gemini: { 'gemini-3.8-flash': 'minimal', 'gemini-3.6-flash': 'xhigh' } },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.displayName).toBe('Kept');
    expect(parsed.success && parsed.data.analyzerReasoningByEngine.gemini?.['gemini-3.6-flash']).toBe('xhigh');
  });
  it('defaults to an empty map', () => {
    expect(DEFAULT_USER_SETTINGS.analyzerReasoningByEngine).toEqual({});
  });
});
```

Append to `server/src/routes/user-settings.test.ts` inside `describe('user-settings router', …)`. Import `_setUserSettingsCacheForTest` from `../workspace/user-settings.js` and `getResolvedOllamaUrl` from `../config/ollama-resolved.js` (re-pinned to 80be2f1d, #3192, A1 — the resolver no longer lives in `user-settings.js`), `mkdirSync` and `writeFileSync` from `node:fs`, and `dirname` from `node:path`, where the file does not already:
```ts
  it('PUT refuses a Gemini reasoning level the model does not offer and writes nothing', async () => {
    /* F2 — a 3.x id: gemini-3.8-flash rejects minimal (offered: model-default, low, medium, high). */
    const res = await request(app)
      .put('/api/user/settings')
      .send({ displayName: 'Changed', analyzerReasoningByEngine: { gemini: { 'gemini-3.8-flash': 'minimal' } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid user settings.');
    expect(res.body.issues.map((i: { message: string }) => i.message)).toEqual([
      'Gemini reasoning "minimal" is not available for gemini-3.8-flash (offered: model-default, low, medium, high).',
    ]);
    expect(existsSync(userSettingsPath)).toBe(false);
  });

  it('PUT persists analyzerReasoningByEngine and GET returns it', async () => {
    const put = await request(app)
      .put('/api/user/settings')
      .send({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'on' }, gemini: { 'gemini-3.6-flash': 'low' } } });
    expect(put.status).toBe(200);
    resetCache();
    const get = await request(app).get('/api/user/settings');
    expect(get.body.analyzerReasoningByEngine).toEqual({ ollama: { 'qwen3.5:4b': 'on' }, gemini: { 'gemini-3.6-flash': 'low' } });
  });

  it("PUT refuses a named Ollama level until that model's own Test accepted it (P18)", async () => {
    const refused = await request(app).put('/api/user/settings').send({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } });
    expect(refused.status).toBe(400);
    expect(refused.body.issues.map((i: { message: string }) => i.message)).toEqual([
      'Ollama reasoning "low" for qwen3.5:4b needs a Test of that model that accepted it (offered now: model-default, off, on).',
    ]);
    expect(existsSync(userSettingsPath)).toBe(false);
    _setUserSettingsCacheForTest({
      analyzerCapabilitiesByModel: {
        'qwen3.5:4b': { serverUrl: getResolvedOllamaUrl(), testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: {}, reasoning: { low: 'accepted' } },
      },
    });
    const accepted = await request(app).put('/api/user/settings').send({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } });
    expect(accepted.status).toBe(200);
  });

  it('PUT judges only what the save changes: a Gemini level saves while an unchanged stale Ollama entry stays (N6)', async () => {
    /* The record that accepted `low` was taken on another Ollama server, so capabilityRecordFor discards
       it for the current URL and the saved `low` is stale. The Settings UI still sends the whole map. */
    _setUserSettingsCacheForTest({
      analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } },
      analyzerCapabilitiesByModel: {
        'qwen3.5:4b': { serverUrl: 'http://old-ollama.invalid:11434', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: {}, reasoning: { low: 'accepted' } },
      },
    });
    const saved = await request(app)
      .put('/api/user/settings')
      .send({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' }, gemini: { 'gemini-3.6-flash': 'low' } } });
    expect(saved.status).toBe(200);
    expect(saved.body.analyzerReasoningByEngine).toEqual({ ollama: { 'qwen3.5:4b': 'low' }, gemini: { 'gemini-3.6-flash': 'low' } });
    /* An entry the save changes is still judged. */
    const changed = await request(app)
      .put('/api/user/settings')
      .send({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low', 'qwen3.5:9b': 'low' } } });
    expect(changed.status).toBe(400);
  });

  it('PUT reads the stored Test records before judging, even when the save arrives before the boot read (N6)', async () => {
    /* The boot read (server/src/index.ts) is not awaited, so an early PUT can find the cache cold. The
       record exists only on disk here: a check against the cold cache would refuse this save. */
    resetCache();
    const serverUrl = getResolvedOllamaUrl();
    mkdirSync(dirname(userSettingsPath), { recursive: true });
    writeFileSync(
      userSettingsPath,
      JSON.stringify({
        analyzerCapabilitiesByModel: {
          'qwen3.5:4b': { serverUrl, testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: {}, reasoning: { low: 'accepted' } },
        },
      }),
    );
    const res = await request(app).put('/api/user/settings').send({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } });
    expect(res.status).toBe(200);
  });

  it('PUT stores an Ollama reasoning level under the normalised tag (N7)', async () => {
    const put = await request(app).put('/api/user/settings').send({ analyzerReasoningByEngine: { ollama: { 'qwen3:latest': 'on' } } });
    expect(put.status).toBe(200);
    resetCache();
    expect((await request(app).get('/api/user/settings')).body.analyzerReasoningByEngine).toEqual({ ollama: { qwen3: 'on' } });
  });

  it('PUT replaces the whole analyzerReasoningByEngine map: an engine left out of the save loses its entries', async () => {
    /* `writeUserSettings` replaces each sent top-level key wholesale, which is what the OpenAPI
       description promises clients; a partial map is a removal, not a patch. */
    await request(app)
      .put('/api/user/settings')
      .send({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'on' }, gemini: { 'gemini-3.6-flash': 'low' } } });
    const put = await request(app).put('/api/user/settings').send({ analyzerReasoningByEngine: { gemini: { 'gemini-3.6-flash': 'low' } } });
    expect(put.status).toBe(200);
    resetCache();
    expect((await request(app).get('/api/user/settings')).body.analyzerReasoningByEngine).toEqual({ gemini: { 'gemini-3.6-flash': 'low' } });
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

**Flip W3b's P23 refusal tests (PR 5a lifts the `reasoning` half).** Each W3b case below refuses both a level and a payload. Replace it with a payload-only case, kept until PR 5b, and an acceptance case for the 5a rule. Keep every other case in those files.

In W3b's `server/src/workspace/analyzer-endpoints.test.ts`, inside `describe('create / update / delete / key decisions', …)`, replace the case `until PRs 5a/5b, refuses a non-default reasoning level and a non-empty payload, naming the PR that enables each (P23)` with:
```ts
  it('until PR 5b, refuses a non-empty payload, naming the PR that enables it (P23)', () => {
    const payload = refusal(() => applyUpdate(applyCreate(empty, base), 'lab', { ...base, extraParams: { top_k: 20 } }));
    expect(payload).toMatchObject({ status: 400, refusal: 'invalid' });
    expect(payload.details).toEqual(['extraParams: custom request parameters cannot be saved until PR 5b enables them']);
    expect(applyCreate(empty, { ...base, extraParams: {} }).analyzerEndpoints).toHaveLength(1);
  });
  it('accepts a reasoning level its control style offers, and refuses one it does not, naming the style (5a rules)', () => {
    expect(applyCreate(empty, { ...base, reasoningStyle: 'enable_thinking', reasoning: 'off' }).analyzerEndpoints[0].reasoning).toBe('off');
    expect(applyCreate(empty, { ...base, reasoningStyle: 'reasoning_effort', reasoning: 'none' }).analyzerEndpoints[0].reasoning).toBe('none');
    expect(applyCreate(empty, { ...base, reasoning: 'model-default' }).analyzerEndpoints[0].reasoning).toBe('model-default');
    const wrongStyle = refusal(() => applyCreate(empty, { ...base, reasoningStyle: 'enable_thinking', reasoning: 'none' }));
    expect(wrongStyle).toMatchObject({ status: 400, refusal: 'invalid' });
    expect(wrongStyle.details).toEqual([
      'reasoning: Reasoning "none" is not offered by the enable_thinking control style (offered: model-default, off, on).',
    ]);
    const notControllable = refusal(() => applyUpdate(applyCreate(empty, base), 'lab', { ...base, reasoning: 'high' }));
    expect(notControllable.details).toEqual([
      'reasoning: Reasoning "high" is not offered by the not_controllable control style (offered: model-default).',
    ]);
  });
  it('an update judges the level only when it changes: an unchanged stale level saves, a changed one is refused (A7)', () => {
    /* A level whose style changed under it (or a table change): stored, and no longer offered. */
    const created = applyCreate(empty, { ...base, reasoningStyle: 'reasoning_effort', reasoning: 'high' });
    const stale = { ...created, analyzerEndpoints: [{ ...created.analyzerEndpoints[0], reasoningStyle: 'not_controllable' as const }] };
    /* The same level sent back with a new name: not judged, so the edit saves. */
    expect(applyUpdate(stale, 'lab', { ...base, name: 'Lab renamed', reasoningStyle: 'not_controllable', reasoning: 'high' }).analyzerEndpoints[0]).toMatchObject({
      name: 'Lab renamed',
      reasoning: 'high',
    });
    /* Changing the level is judged. */
    expect(refusal(() => applyUpdate(stale, 'lab', { ...base, reasoningStyle: 'not_controllable', reasoning: 'low' })).details).toEqual([
      'reasoning: Reasoning "low" is not offered by the not_controllable control style (offered: model-default).',
    ]);
    /* So is changing the style that decides which levels are offered. */
    expect(refusal(() => applyUpdate(stale, 'lab', { ...base, reasoningStyle: 'enable_thinking', reasoning: 'high' })).details).toEqual([
      'reasoning: Reasoning "high" is not offered by the enable_thinking control style (offered: model-default, off, on).',
    ]);
  });
```

In W3b's `server/src/routes/analyzer-endpoints.test.ts`, inside `describe('POST /api/analyzer/endpoints', …)`, replace the case `until PRs 5a/5b, refuses a non-default reasoning level and a non-empty payload, on create and update (P23)` with:
```ts
  it('until PR 5b, refuses a non-empty payload on update (P23)', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    const payload = await request(app).put('/api/analyzer/endpoints/lab').send({ ...lab, extraParams: { top_k: 20 } });
    expect(payload.status).toBe(400);
    expect(payload.body.details).toEqual(['extraParams: custom request parameters cannot be saved until PR 5b enables them']);
    expect(JSON.parse(readFileSync(userSettingsPath, 'utf8')).analyzerEndpoints[0]).not.toHaveProperty('extraParams');
  });

  it('accepts a reasoning level its control style offers on create and update, validated by the 5a rules', async () => {
    const created = await request(app).post('/api/analyzer/endpoints').send({ ...lab, reasoningStyle: 'reasoning_effort', reasoning: 'high' });
    expect(created.status).toBe(201);
    expect(created.body.analyzerEndpoints[0]).toMatchObject({ reasoningStyle: 'reasoning_effort', reasoning: 'high' });
    const updated = await request(app).put('/api/analyzer/endpoints/lab').send({ ...lab, reasoningStyle: 'enable_thinking', reasoning: 'off' });
    expect(updated.status).toBe(200);
    expect(JSON.parse(readFileSync(userSettingsPath, 'utf8')).analyzerEndpoints[0]).toMatchObject({ reasoningStyle: 'enable_thinking', reasoning: 'off' });
  });
```

In W3b's `src/lib/api-analyzer-endpoints-mock.test.ts`, add `import styleLevels from '../../server/src/analyzer/__fixtures__/reasoning-style-levels.json';` below its `vitest` import. Inside `describe('mock analyzer endpoint API', …)`, replace the case `until PRs 5a/5b, refuses a non-default reasoning level and a non-empty payload, as the server does` with the two cases below. The mock ids stay inside `^[a-z0-9-]{1,40}$` (the longest is 36 characters):
```ts
  it('until PR 5b, refuses a non-empty payload, as the server does', async () => {
    const p = await refusal(api.createAnalyzerEndpoint({ ...input('m-payload'), extraParams: { top_k: 20 } }));
    expect(p.details).toEqual(['extraParams: custom request parameters cannot be saved until PR 5b enables them']);
  });

  it('accepts a reasoning level its control style offers and refuses one it does not, as the server does', async () => {
    const r = await refusal(api.createAnalyzerEndpoint({ ...input('m-reasoning'), reasoning: 'high' }));
    expect(r).toMatchObject({
      code: 'invalid',
      details: ['reasoning: Reasoning "high" is not offered by the not_controllable control style (offered: model-default).'],
    });
    /* The same table as the server (reasoning.ts, pinned to this fixture by reasoning.test.ts). */
    for (const [style, levels] of Object.entries(styleLevels)) {
      for (const level of ['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high']) {
        const id = `m-lvl-${style.replace(/_/g, '-')}-${level}`;
        const outcome = await api
          .createAnalyzerEndpoint({ ...input(id), reasoningStyle: style, reasoning: level } as never)
          .then(() => 'accepted', () => 'refused');
        expect([style, level, outcome]).toEqual([style, level, levels.includes(level) ? 'accepted' : 'refused']);
      }
    }
  });
```

- [ ] **Step 2: Run them and confirm they fail** (per-test outcomes corrected by A9)
Run: `npm --prefix server run test -- src/workspace/analyzer-request-controls.test.ts src/routes/user-settings.test.ts src/routes/analyzer-endpoints.test.ts src/workspace/analyzer-endpoints.test.ts` and `npm test -- src/lib/api-analyzer-endpoints-mock.test.ts`
Expected: FAIL.
- `analyzer-request-controls.test.ts`: every case fails at `Failed to resolve import "./analyzer-request-controls.js"`.
- In `server/src/routes/user-settings.test.ts`, where nothing judges the body yet and the stored schema still drops the field:
  - `PUT refuses a Gemini reasoning level the model does not offer and writes nothing` and `PUT refuses a named Ollama level until that model's own Test accepted it (P18)`: `expected 200 to be 400`;
  - `PUT persists analyzerReasoningByEngine and GET returns it`, `PUT stores an Ollama reasoning level under the normalised tag (N7)` and `PUT replaces the whole analyzerReasoningByEngine map…`: `expected undefined to deeply equal …` — the GET carries no such field;
  - `PUT judges only what the save changes: a Gemini level saves while an unchanged stale Ollama entry stays (N6)`: it cannot pass either — the saved body lacks the unstored field, and its second save is not refused (`expected 200 to be 400`);
  - **the one case that PASSES** is `PUT reads the stored Test records before judging, even when the save arrives before the boot read (N6)`: it expects 200, and nothing judges the body yet. Mutation 5 shows it can fail.
- `create refuses a reasoning level its control style does not offer` fails: the body carries P23's `only "model-default" can be saved until PR 5a` detail, not the 5a rule's.
- `accepts a reasoning level its control style offers…` fails in all three files: the workspace case throws `AnalyzerEndpointRefusal`, the route case gets `expected 400 to be 201`, and the mock case refuses `enable_thinking`/`off`.
- `an update judges the level only when it changes… (A7)` fails at its first assertion: P23 refuses the unchanged `high` outright (`AnalyzerEndpointRefusal`).
- The three `until PR 5b, refuses a non-empty payload…` cases PASS: they lock the payload refusal this PR keeps.

- [ ] **Step 3: Implement**

`server/src/workspace/analyzer-request-controls.ts`:
```ts
/* #3084 wave 5 — WRITE-time validation for analyzer request controls. Kept off
   userSettingsSchema on purpose: a SCHEMA failure on read resets every setting to
   defaults (user-settings.ts readUserSettings, :522-525; an unparseable file is recovered
   from backups or falls back with a corruption flag, :479-498), so rules that depend on
   tables that change (Gemini levels, protected keys)
   run only when a client writes. */
import { z } from 'zod';
import { REASONING_LEVELS, offeredReasoningLevels, testableReasoningLevels } from '../analyzer/reasoning.js';
import { inferEngineFromModelId } from '../analyzer/model-id.js';
import { entryForModelTag, normalizeModelTag } from '../analyzer/ollama-tag.js';

const OLLAMA_WRITABLE = testableReasoningLevels({ engine: 'local', model: '' });

/** What the write check needs from saved Test records. Structural: this module imports no
    capabilities or user-settings code (either would close a cycle through user-settings.ts). */
export interface RequestControlsContext {
  /** The Ollama model's Test record for the CURRENT Ollama URL (W3c's capabilityRecordFor), or undefined. */
  ollamaRecord(model: string): { reasoning?: Partial<Record<string, 'accepted' | 'rejected'>> } | undefined;
}

const reasoningByEngineInput = z
  .object({
    ollama: z.record(z.string(), z.enum(REASONING_LEVELS)).optional(),
    gemini: z.record(z.string(), z.enum(REASONING_LEVELS)).optional(),
  })
  .optional();

export function analyzerRequestControlsPatchSchemaFor(records: RequestControlsContext) {
  return z
    .object({ analyzerReasoningByEngine: reasoningByEngineInput })
    .superRefine((patch, ctx) => {
    const r = patch.analyzerReasoningByEngine;
    if (!r) return;
    /* P18: one level per Ollama model. model-default/off/on are always writable; low/medium/high
       only for a model whose own Test record accepted that level. */
    for (const [model, level] of Object.entries(r.ollama ?? {})) {
      const path = ['analyzerReasoningByEngine', 'ollama', model];
      if (inferEngineFromModelId(model) === 'openai') {
        ctx.addIssue({ code: 'custom', path, message: `Ollama reasoning map key "${model}" is an endpoint model id; endpoints carry their own Reasoning setting.` });
        continue;
      }
      if (!OLLAMA_WRITABLE.includes(level)) {
        ctx.addIssue({ code: 'custom', path, message: `Ollama reasoning "${level}" for ${model} is not an Ollama level (${OLLAMA_WRITABLE.join(', ')}).` });
        continue;
      }
      const offered = offeredReasoningLevels({ engine: 'local', model, record: records.ollamaRecord(model) });
      if (!offered.includes(level)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `Ollama reasoning "${level}" for ${model} needs a Test of that model that accepted it (offered now: ${offered.join(', ')}).`,
        });
      }
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
}

/** The same rules with no Test records: every named Ollama level is refused. */
export const analyzerRequestControlsPatchSchema = analyzerRequestControlsPatchSchemaFor({ ollamaRecord: () => undefined });

/** What changedRequestControls reads from the stored settings. Structural: no user-settings import. */
export interface StoredRequestControls {
  analyzerReasoningByEngine?: { ollama?: Record<string, string>; gemini?: Record<string, string> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** N6 — the part of a PUT body the rules judge: only reasoning entries whose value differs from the
    stored settings. The UI sends whole maps and Test records are bound to their server URL, so
    re-judging an unchanged stored entry would let one stale entry (an Ollama URL change, a Gemini table
    change, an unknown stored value) block every later save. Ollama keys compare through
    normalizeModelTag (N7). A patch without reasoning maps is returned as the same object. */
export function changedRequestControls(patch: unknown, stored: StoredRequestControls): unknown {
  if (!isRecord(patch) || !isRecord(patch.analyzerReasoningByEngine)) return patch;
  const sent = patch.analyzerReasoningByEngine;
  const judged: Record<string, unknown> = { ...sent };
  for (const engine of ['ollama', 'gemini'] as const) {
    const entries = sent[engine];
    if (!isRecord(entries)) continue;
    const before = stored.analyzerReasoningByEngine?.[engine];
    judged[engine] = Object.fromEntries(
      Object.entries(entries).filter(
        ([model, level]) => (engine === 'ollama' ? entryForModelTag(before, model) : before?.[model]) !== level,
      ),
    );
  }
  return { ...patch, analyzerReasoningByEngine: judged };
}

/** N7 — the body the route writes: Ollama reasoning keys through normalizeModelTag, so one model has one
    stored key (a later sent key wins when two normalise alike). Everything else is as sent; a body with
    no Ollama reasoning map is returned as the same object. */
export function withNormalizedOllamaReasoningKeys(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.analyzerReasoningByEngine) || !isRecord(body.analyzerReasoningByEngine.ollama)) {
    return body;
  }
  const ollama = Object.fromEntries(
    Object.entries(body.analyzerReasoningByEngine.ollama).map(([model, level]) => [normalizeModelTag(model), level]),
  );
  return { ...body, analyzerReasoningByEngine: { ...body.analyzerReasoningByEngine, ollama } };
}
```

`server/src/workspace/user-settings.ts` — no new import. After `analyzerKeepAliveByModel: z.record(z.string(), z.number().int()).default({}),` (`:317` at `80be2f1d`, re-pinned from `:253`):
```ts
  /* #3084 wave 5 — per-engine reasoning level, keyed by model id (P18; Ollama keys
     stored through normalizeModelTag, N7). Ollama: absent = 'off', today's
     think:false. Gemini: absent = 'model-default', no thinking field. Endpoints
     carry their own `reasoning`. Lenient on read: any string (N10), so a value
     this version does not know never resets the file; the pre-run check refuses
     it (P17). Offered-level rules run on write in the PUT handler
     (routes/user-settings.ts, via analyzer-request-controls.ts). */
  analyzerReasoningByEngine: z
    .object({
      ollama: z.record(z.string(), z.string()).optional(),
      gemini: z.record(z.string(), z.string()).optional(),
    })
    .default({}),
```
After `analyzerKeepAliveByModel: {},` in `DEFAULT_USER_SETTINGS` (`:390` at `80be2f1d`, re-pinned from `:334`):
```ts
  /* #3084 wave 5 — empty = today's behaviour (Ollama off, Gemini model-default). */
  analyzerReasoningByEngine: {},
```
`writeUserSettings` is unchanged. In `server/src/routes/user-settings.ts`:
- add `import { analyzerRequestControlsPatchSchemaFor, changedRequestControls, withNormalizedOllamaReasoningKeys } from '../workspace/analyzer-request-controls.js';` and `import { capabilityRecordFor } from '../analyzer/capabilities.js';`;
- **re-pinned to `80be2f1d` (#3192, A1): no import change needed here** — `getResolvedOllamaUrl` already has its own import, `import { getResolvedOllamaUrl } from '../config/ollama-resolved.js';` (`:30`), separate from `readUserSettings` (`:20`, still from `../workspace/user-settings.js`); this task adds nothing to either import.
- **re-pinned to `80be2f1d` (#3192): #3192 already inserted a `RETIRED_ANALYZER_FIELDS` early-reject block at the top of the `PUT /` handler's `try` (`userSettingsRouter.put('/', ...)` at `:114`, its `try {` at `:115`, the reject block through `:129`, `writeUserSettings` call at `:131`).** This task's validation goes immediately after that block (i.e. after the `if (offending.length > 0) { … }` check, replacing the plain `const updated = await writeUserSettings(req.body);` at `:131`), not at the very top of `try`:
```ts
  try {
    /* #3141 step 2's RETIRED_ANALYZER_FIELDS reject block runs first, unchanged — see routes/user-settings.ts:117-129 at 80be2f1d. This task's own validation follows it, still before writeUserSettings. */
    /* #3084 wave 5 — offered-level (and, from PR 5b, custom-payload) rules. They read the current Test
       records, so they run here rather than in writeUserSettings. N6: they judge only what this save
       changes, against the settings as stored. They read readUserSettings(), never the cache: the boot
       read (server/src/index.ts:188, `void bootWarmUserSettings()`) is not awaited, so an early save can
       find the cache cold. A ZodError
       maps to 400 + issues in the catch below, and nothing is written. N7: Ollama keys are written
       normalised. */
    const stored = await readUserSettings();
    analyzerRequestControlsPatchSchemaFor({
      /* No digest here (A3), deliberately: resolving one would add a network read to a settings save,
         which is worse than the lenience it would buy. capabilityRecordFor keeps a record when the
         digest is unknown, and the run-time check (runAnalyzerPreflight, Task 5.4) is the one that
         actually decides whether a re-pulled model's record still applies. */
      ollamaRecord: (model) => capabilityRecordFor(stored, model, getResolvedOllamaUrl()),
    }).parse(changedRequestControls(req.body ?? {}, stored));
    const updated = await writeUserSettings(withNormalizedOllamaReasoningKeys(req.body));
```

`server/src/workspace/analyzer-endpoints.ts` (W3b Task 3b.5) — add `import { levelsForReasoningStyle } from '../analyzer/reasoning.js';`. In `parseEndpointInput`, replace W3b's P23 block with the block below. The replaced text runs from the comment `/* #3084 P23 — until wave 5 exists, nothing validates a reasoning level or a` through `if (notYet.length > 0) { throw new AnalyzerEndpointRefusal(400, 'invalid', 'Invalid analyzer endpoint.', notYet); }`. The `unloadUrl` origin check after it is unchanged. `ep.reasoning` is `z.string()` in W3b's schema, hence the `readonly string[]` widening. Give the function a second parameter, `stored?: AnalyzerEndpoint` (A7), and in `applyUpdate` change `parseEndpointInput(isRecord(input) ? { ...input, id: endpointId } : input)` to `parseEndpointInput(isRecord(input) ? { ...input, id: endpointId } : input, state.analyzerEndpoints[idx])`. `applyCreate` passes nothing.
```ts
  /* #3084 PR 5a — a reasoning level must be one its control style offers. This
     replaces P23's "model-default only" refusal. It runs here because both endpoint
     routes and the mock reach every create and update through this function. The
     `extraParams` refusal stays until PR 5b replaces it with validateExtraParams. */
  const problems: string[] = [];
  /* A7 — judge the level only when this save changes it, or changes the style that decides which
     levels are offered. Re-judging an unchanged stored level would refuse every later edit of an
     endpoint whose saved level a newer rule no longer offers; P17 still refuses the run itself. */
  const levelChanged = !stored || stored.reasoning !== ep.reasoning || stored.reasoningStyle !== ep.reasoningStyle;
  const offeredLevels = levelsForReasoningStyle(ep.reasoningStyle);
  if (levelChanged && !(offeredLevels as readonly string[]).includes(ep.reasoning)) {
    problems.push(
      `reasoning: Reasoning "${ep.reasoning}" is not offered by the ${ep.reasoningStyle} control style (offered: ${offeredLevels.join(', ')}).`,
    );
  }
  if (ep.extraParams !== undefined && Object.keys(ep.extraParams).length > 0) {
    problems.push('extraParams: custom request parameters cannot be saved until PR 5b enables them');
  }
  if (problems.length > 0) {
    throw new AnalyzerEndpointRefusal(400, 'invalid', 'Invalid analyzer endpoint.', problems);
  }
```
`routes/analyzer-endpoints.ts` needs no change: its existing `AnalyzerEndpointRefusal` → `{ error, code, details }` branch carries the message.

Cycle check:
- `analyzer-request-controls.ts` imports `reasoning.ts`, `model-id.ts` and the import-free leaf `ollama-tag.ts`, and only `routes/user-settings.ts` imports it, alongside `capabilities.ts`. A route is a leaf, so it closes no cycle.
- `user-settings.ts` gains no import: its stored reasoning values are plain strings (N10).
- `analyzer-endpoints.ts` → `reasoning.ts` closes none either: `reasoning.ts` imports only types.
- `npm run check:cycles` confirms both.

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
          type: object
          additionalProperties:
            type: string
        gemini:
          type: object
          additionalProperties:
            type: string
      description: |
        #3084 — per-engine reasoning, keyed by model id. Ollama: absent = 'off';
        low / medium / high only for a model whose own Test accepted them; keys are
        stored through normalizeModelTag (`qwen3` and `qwen3:latest` are one model).
        Gemini: absent = 'model-default'. Values are strings: a save accepts only a
        ReasoningLevel the model offers, and a stored value this version no longer
        offers or does not know is returned as saved and refuses a run before it
        starts. A PUT replaces this map, and each engine map inside it, as a whole:
        send every engine's entries, because an engine left out of a sent map loses
        them.
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
In W3c's `mockGetAnalyzerModels` (`src/lib/api.ts`, Task 3c.6), extend its local `entry(id, engine, model, mode, droppedIfSchema)` helper so it gives every model entry `offeredReasoningLevels` so the Settings editor has something to offer in mock mode and e2e: Ollama entries `['model-default', 'off', 'on']`; `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3-flash-preview`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` → `['model-default', 'minimal', 'low', 'medium', 'high']`; `gemma-4-31b-it`, `gemma-4-26b-a4b-it` → `['model-default', 'off', 'on']`; endpoint entries → `MOCK_STYLE_LEVELS[endpoint.reasoningStyle]`, the map below. No `gemini-2.5-flash` entry (F2 — 2.5 is retired; if the mock catalog carries a 2.5 id elsewhere, give it `['model-default']`, like an id this table has never heard of).

`src/lib/api.ts` — directly below W3b's `mockOrigin` helper, add the control-style table. The mock endpoint rule and the mock catalog both read it. The mock test's table loop pins it to the server fixture.
```ts
/* #3084 PR 5a — the server's endpoint control-style levels (reasoning.ts levelsForReasoningStyle;
   fixture server/src/analyzer/__fixtures__/reasoning-style-levels.json). */
const MOCK_STYLE_LEVELS: Record<'reasoning_effort' | 'enable_thinking' | 'not_controllable', readonly string[]> = {
  reasoning_effort: ['model-default', 'none', 'minimal', 'low', 'medium', 'high'],
  enable_thinking: ['model-default', 'off', 'on'],
  not_controllable: ['model-default'],
};
```
In W3b Task 3b.9's `mockEndpointFromInput`, replace its P23 block with the block below. The replaced text runs from the comment `/* #3084 P23 — mirrors the server's parseEndpointInput until PRs 5a/5b. */` through `if (notYet.length > 0) throw new AnalyzerEndpointError(400, 'invalid', 'Invalid analyzer endpoint.', notYet);`. The `unloadUrl` check after it is unchanged.
```ts
  /* #3084 — mirrors the server's parseEndpointInput: PR 5a's level rule, and P23's
     payload refusal until PR 5b. */
  const controlProblems: string[] = [];
  const style = input.reasoningStyle ?? 'not_controllable';
  const level = input.reasoning ?? 'model-default';
  if (!MOCK_STYLE_LEVELS[style].includes(level)) {
    controlProblems.push(
      `reasoning: Reasoning "${level}" is not offered by the ${style} control style (offered: ${MOCK_STYLE_LEVELS[style].join(', ')}).`,
    );
  }
  if (input.extraParams !== undefined && Object.keys(input.extraParams).length > 0) {
    controlProblems.push('extraParams: custom request parameters cannot be saved until PR 5b enables them');
  }
  if (controlProblems.length > 0) throw new AnalyzerEndpointError(400, 'invalid', 'Invalid analyzer endpoint.', controlProblems);
```

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/workspace/analyzer-request-controls.test.ts src/routes/user-settings.test.ts src/routes/analyzer-endpoints.test.ts src/workspace/analyzer-endpoints.test.ts src/workspace/user-settings.test.ts` and `npm test -- src/lib/api-analyzer-endpoints-mock.test.ts`  Expected: PASS.
Then: `npm run typecheck` and `npm run check:cycles`  Expected: PASS, no new cycle.
Keeps green: `src/workspace/user-settings.test.ts` (writeUserSettings merge behaviour), `src/routes/user-settings.test.ts` (existing cases), `npm test -- src/store/account-slice.test.ts`.

- [ ] **Step 5: Mutation proof**
1. In the `PUT /` handler delete the whole `analyzerRequestControlsPatchSchemaFor({ ollamaRecord: … }).parse(changedRequestControls(req.body ?? {}, stored));` statement (and, if the compiler complains, the now-unused `stored` read). Expected red: `PUT refuses a Gemini reasoning level the model does not offer and writes nothing` and `PUT refuses a named Ollama level until that model's own Test accepted it (P18)`. Restore.
2. In `parseEndpointInput` replace `!(offeredLevels as readonly string[]).includes(ep.reasoning)` with `ep.reasoning !== 'model-default'` (P23's old rule). Expected red: `accepts a reasoning level its control style offers, and refuses one it does not, naming the style (5a rules)` and `accepts a reasoning level its control style offers on create and update, validated by the 5a rules`. Then replace it with `false` instead. Expected red: the same workspace case (its refusals), and `create refuses a reasoning level its control style does not offer`. Restore.
2c. In `parseEndpointInput` replace `levelChanged &&` with nothing (always judge). Expected red: `an update judges the level only when it changes… (A7)` at its first assertion. Then restore it and drop `|| stored.reasoningStyle !== ep.reasoningStyle`. Expected red: the same case's last assertion — a style change to `enable_thinking` saves a level that style does not offer. Restore.
2b. In `mockEndpointFromInput` replace `!MOCK_STYLE_LEVELS[style].includes(level)` with `level !== 'model-default'`. Expected red: `accepts a reasoning level its control style offers and refuses one it does not, as the server does`. Then change `MOCK_STYLE_LEVELS.enable_thinking` to `['model-default', 'on']`. Expected red: the same case, at `enable_thinking`/`off`. Restore.
3. In `analyzerRequestControlsPatchSchemaFor`, replace `offeredReasoningLevels({ engine: 'local', model, record: records.ollamaRecord(model) })` with `OLLAMA_WRITABLE`. Expected red: `refuses a named level without that model's accepted Test record…` and `accepts a named level the model's own Test accepted, and refuses it for another model`. Restore.
4. In the `PUT /` handler replace `changedRequestControls(req.body ?? {}, stored)` with `req.body ?? {}`. Expected red: `PUT judges only what the save changes: a Gemini level saves while an unchanged stale Ollama entry stays (N6)` (`expected 400 to be 200`). Restore.
5. In the `PUT /` handler replace `const stored = await readUserSettings();` with `const stored = getCachedUserSettings();` (importing it). Expected red: `PUT reads the stored Test records before judging, even when the save arrives before the boot read (N6)` (`expected 400 to be 200`). Restore.
6. In `changedRequestControls` replace `(engine === 'ollama' ? entryForModelTag(before, model) : before?.[model])` with `before?.[model]`. Expected red: `keeps only reasoning entries whose value differs…` (`qwen3:latest` survives). Restore.
7. In the `PUT /` handler write `req.body` instead of `withNormalizedOllamaReasoningKeys(req.body)`. Expected red: `PUT stores an Ollama reasoning level under the normalised tag (N7)`. Restore.
8. In `user-settings.ts` change both stored `z.record(z.string(), z.string())` back to `z.record(z.string(), z.enum(REASONING_LEVELS))` (importing it). Expected red: `loads a stored level the rules no longer offer, or one this version does not know (xhigh)…` (`success` false). Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/workspace/analyzer-request-controls.ts server/src/workspace/analyzer-request-controls.test.ts server/src/workspace/user-settings.ts server/src/routes/user-settings.ts server/src/routes/user-settings.test.ts server/src/workspace/analyzer-endpoints.ts server/src/workspace/analyzer-endpoints.test.ts server/src/routes/analyzer-endpoints.test.ts openapi.yaml src/lib/api-types.ts src/lib/api.ts src/lib/api-analyzer-endpoints-mock.test.ts
git commit -m "feat(server,openapi,mocks): store and validate analyzer reasoning levels"
```

### Task 5.3: Every transport sends the resolved level; the runner and the three analyzers pass it

**Files:**
- Modify: `server/src/analyzer/transports/ollama-transport.ts` — the streaming request-body literal (W1 moved it from `server/src/analyzer/ollama.ts:632-675` at `80be2f1d`, re-pinned from `:631-674`; the line to change is the moved `think: false,` from `ollama.ts:649-652` at `80be2f1d`, re-pinned from `:648-651`) **and** W4's non-streaming `sendFreeText` body literal (the persona branch moved from `ollama.ts:951-1028` at `80be2f1d`, re-pinned from `:950-1027`, which also hard-codes `think: false,`)
- Modify: `server/src/analyzer/transports/gemini-transport.ts` — the `config` literal (W1 moved it from `gemini.ts:728-734`; W2 added `thinkingConfig.includeThoughts`), and (N1, P27, A3) W4 Task 4.3's `includeThoughts` local in `generate` (`!req.freeText && geminiModelThinks(this.model)`, which gates both the wire and W2's `reasoningTokens`), its exported `resolveGeminiThinkingIdleTimeoutMs` and its private `geminiThinkingWindowApplies`, found by symbol
- Modify: `server/src/analyzer/transports/openai-transport.ts` — the chat-completions params object (W3b)
- Modify: the `settings: () => …` closure in the constructors of `OllamaAnalyzer` (`server/src/analyzer/ollama.ts`) and `GeminiAnalyzer` (`server/src/analyzer/gemini.ts`)
- Modify: W3b Task 3b.12's `openAIRequestSettings(endpoint, servedOutputLimit?)` (`server/src/analyzer/openai.ts`). `OpenAIAnalyzer`'s closure calls it, and W3c Task 3c.9 passes the served output limit into it. The closure itself is not edited.
- Test: `server/src/analyzer/transports/reasoning-wire.test.ts`, `server/src/analyzer/transports/gemini-request-thinks.test.ts`, `server/src/analyzer/gemini-reasoning-wiring.test.ts`, `server/src/analyzer/voice-style.test.ts` (append; the runner's forwarding is Task 5.1's `stage-runner.request-controls.test.ts`), W3b's `server/src/analyzer/openai-analyzer.test.ts` (update one assertion, append one case)

**Interfaces:**
- Consumes: Task 5.1 `reasoningWireFragment`, `resolveReasoningSetting`, `TransportRequest.reasoning` and `EngineRequestSettings.reasoning` (declared and forwarded by Task 5.1); `getCachedUserSettings` (`user-settings.ts:594` at `80be2f1d`, re-pinned from `:537`); `_setUserSettingsCacheForTest` (`user-settings.ts:1189` at `80be2f1d`, re-pinned from `:1155`).
- Produces:
  - `mergeGeminiThinkingConfig(config, fragment)` (**new** export of `gemini-transport.ts`; the fragment's `includeThoughts` decides whether the merged `thinkingConfig` carries one, P19);
  - wire behaviour: `req.reasoning === undefined` keeps the pre-W5 wire (Ollama `think:false`, others nothing); a defined level sends exactly `reasoningWireFragment(...)`;
  - **request thinking (N1, P27):** W2's `resolveGeminiThinkingIdleTimeoutMs(model)` becomes `resolveGeminiThinkingIdleTimeoutMs(model, level?)`, and W2's private `geminiThinkingWindowApplies` gains the same optional level. Both ask Task 5.1's `geminiRequestThinks(model, req.reasoning)`. Gemma 4 at `on` gets the thinking window and thought summaries; `off` gets today's idle window and none. A 2.5 id has no row (F2), so any saved level falls back to the id rule, exactly as with no level. With no level the id rule decides, exactly as in wave 2.
  - **the evidence gate (A3, P27):** the `includeThoughts` local that gates W2's `reasoningTokens` is read from the `thinkingConfig` the request actually sends, so the wire and the count can never disagree. A free-text (persona) request at `model-default` sends none and counts none; a level that thinks sends `includeThoughts` and counts its `thoughtsTokenCount`.
  - **Gemma at `on` (G1, P27 as amended):** it is a thinking request, so its thought tokens are reasoning evidence and an empty `MAX_TOKENS` finish there is a reasoning overflow (P6, P20) — the run stops, as for any thinking model. At Gemma's default level and at `off`, nothing asks for thoughts, no count is evidence, and the same finish still splits, keeping the #528 recovery. **Owed fact (A8):** `includeThoughts` on Gemma is unconfirmed; wave 5a's Group E row checks the `on` Test step. If the API refuses the pair, the `on` fragment drops `includeThoughts` and keeps `thinkingLevel: HIGH` (the thinking window still applies) — and record on that row that Gemma `on` then has no evidence source, so its truncations split like its default level, which is a decision to revisit rather than a silent change.
- Consumes (N1): Task 5.1's `geminiRequestThinks`; W2's `GEMINI_THINKING_IDLE_TIMEOUT_MS`, `resolveStreamIdleTimeoutMs`, `configValue('analyzer.gemini.thinkingIdleTimeoutMs')`.

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
  it('undefined and model-default leave config.thinkingConfig as W2 built it', async () => {
    const a: Array<{ config: Record<string, unknown> }> = [];
    const b: Array<{ config: Record<string, unknown> }> = [];
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(a) }).send(req(undefined));
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(b) }).send(req('model-default'));
    expect(b[0].config.thinkingConfig).toEqual(a[0].config.thinkingConfig);
  });
  it('mergeGeminiThinkingConfig: the fragment decides includeThoughts (P19)', () => {
    expect(mergeGeminiThinkingConfig({ temperature: 0.2, thinkingConfig: { includeThoughts: true } }, { thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } }))
      .toEqual({ temperature: 0.2, thinkingConfig: { includeThoughts: true, thinkingLevel: 'LOW' } });
    /* A model wave 2 does not treat as thinking (Gemma 4 at its default) gains summaries from its level. */
    expect(mergeGeminiThinkingConfig({ temperature: 0.2 }, { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } }))
      .toEqual({ temperature: 0.2, thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } });
    /* A model the catalog marks as thinking, turned off with Gemma's MINIMAL: nothing to summarise. */
    expect(mergeGeminiThinkingConfig({ thinkingConfig: { includeThoughts: true } }, { thinkingConfig: { thinkingLevel: 'MINIMAL' } }))
      .toEqual({ thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    const same = { temperature: 0.2 };
    expect(mergeGeminiThinkingConfig(same, {})).toBe(same);
  });

  /* F2 — 2.5 Flash-Lite dropped from the illustration (its thinkingBudget row is retired); a 3.x
     Flash-Lite id at 'low' demonstrates the same "gains includeThoughts from its level" behaviour. */
  it('Gemma 4 on and gemini-3.5-flash-lite low carry includeThoughts; Gemma 4 off does not (P19)', async () => {
    const cap: Array<{ config: Record<string, unknown> }> = [];
    await new GeminiTransport({ apiKey: 'k', model: 'gemma-4-31b-it', client: fakeClient(cap) }).send(req('on'));
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.5-flash-lite', client: fakeClient(cap) }).send(req('low'));
    await new GeminiTransport({ apiKey: 'k', model: 'gemma-4-31b-it', client: fakeClient(cap) }).send(req('off'));
    expect(cap[0].config.thinkingConfig).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true });
    expect(cap[1].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: true });
    expect(cap[2].config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
  });

  it('a free-text request sends no thinkingConfig at model-default, and only the level fragment otherwise', async () => {
    const cap: Array<{ config: Record<string, unknown> }> = [];
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(cap) });
    const free = (reasoning: ReasoningLevel | undefined): TransportRequest => ({ ...req(reasoning), system: '', temperature: undefined, freeText: {} });
    await t.send(free(undefined));
    await t.send(free('model-default'));
    await t.send(free('low'));
    expect('thinkingConfig' in cap[0].config).toBe(false);
    expect('thinkingConfig' in cap[1].config).toBe(false);
    expect(cap[2].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: true });
  });
});
```

`server/src/analyzer/transports/gemini-request-thinks.test.ts` (N1, P27; the helpers are copied verbatim from W2's `transports/gemini-transport.test.ts`):
```ts
/* #3084 wave 5 (P27, N1) — a Gemini request thinks when its level says so, not only when its id does.
   One function, geminiRequestThinks, decides both includeThoughts and the thinking window, so a Gemma 4
   request at `on` is not killed mid-think by the 45 s idle window, and a Gemma 4 request at `off` does
   not wait 120 s (F2, F6) on a request that never thinks. A 2.5 id has no row (F2) and always falls back
   to the static id rule, whatever level is saved for it. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* Zero retry backoffs, set before the transport module loads (W2's suite does the same). */
vi.hoisted(() => {
  process.env.GEMINI_RETRY_BACKOFFS_MS = '0,0';
});

import type { GoogleGenAI } from '@google/genai';
import { GeminiTransport, GEMINI_THINKING_IDLE_TIMEOUT_MS, resolveGeminiThinkingIdleTimeoutMs } from './gemini-transport.js';
import { mapFinish } from '../runner/finish.js';
import { AnalyzerReasoningOverflowError, AnalyzerTruncatedError } from '../errors.js';
import { geminiRateLimiter } from '../rate-limit.js';
import { _resetGeminiCatalogForTest } from '../catalog/gemini-catalog.js';
import type { TransportRequest } from '../runner/transport.js';

type Part = { text?: string; thought?: boolean };
function chunk(parts: Part[], extra: { finishReason?: string; thoughtsTokenCount?: number } = {}) {
  const answer = parts.filter((p) => p.thought !== true).map((p) => p.text ?? '').join('');
  return {
    text: answer === '' ? undefined : answer,
    candidates: [{ content: { parts }, ...(extra.finishReason ? { finishReason: extra.finishReason } : {}) }],
    ...(extra.thoughtsTokenCount !== undefined ? { usageMetadata: { thoughtsTokenCount: extra.thoughtsTokenCount } } : {}),
  };
}
function clientWith(generateContentStream: ReturnType<typeof vi.fn>): GoogleGenAI {
  return {
    models: { generateContentStream, list: vi.fn(async () => { throw new Error('offline'); }) },
  } as unknown as GoogleGenAI;
}
const request = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  system: 'system instruction',
  messages: [{ role: 'user', content: 'chapter' }],
  structuredOutput: { mode: 'json' },
  temperature: 0.2,
  maxOutputTokens: 8192,
  estimatedInputTokens: 50,
  call: {},
  ...over,
});
const ANSWER = '{"ok":true}';
/** Chunks arrive at fixed offsets from the stream call; the timers are registered synchronously at call time. */
const timedStream = (schedule: Array<{ atMs: number; item: unknown }>) => () => {
  const ready = schedule.map(({ atMs }) => new Promise<void>((resolve) => setTimeout(resolve, atMs)));
  return Promise.resolve(
    (async function* () {
      for (const [i, { item }] of schedule.entries()) {
        await ready[i];
        yield item;
      }
    })(),
  );
};
const answerAfter = (atMs: number) => timedStream([{ atMs, item: chunk([{ text: ANSWER }], { finishReason: 'STOP' }) }]);
const transport = (model: string, gen: ReturnType<typeof vi.fn>) =>
  new GeminiTransport({ apiKey: 'test-key', model, client: clientWith(gen), requestCeilingMs: 1_800_000 });

beforeEach(() => {
  geminiRateLimiter._reset();
  _resetGeminiCatalogForTest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.GEMINI_STREAM_IDLE_MS;
  delete process.env.GEMINI_THINKING_IDLE_MS;
});

describe('a Gemini request thinks per its level (P27, N1)', () => {
  it('resolves the window per request: Gemma 4 at on thinks, Gemma 4 at off does not, 3.6 Flash at low or model-default does', () => {
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it', 'on')).toBe(GEMINI_THINKING_IDLE_TIMEOUT_MS);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it', 'off')).toBe(45_000);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-3.6-flash', 'low')).toBe(GEMINI_THINKING_IDLE_TIMEOUT_MS);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-3.6-flash', 'model-default')).toBe(GEMINI_THINKING_IDLE_TIMEOUT_MS);
    /* No level: wave 2's id rule, unchanged. */
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it')).toBe(45_000);
    /* F2 — a 2.5 id has no row, so any saved level falls back to the id rule, same as no level at all. */
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-2.5-flash', 'off')).toBe(resolveGeminiThinkingIdleTimeoutMs('gemini-2.5-flash'));
  });

  it('Gemma 4 at on: the request asks for thought summaries, and a 60 s silent think is not killed (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const gen = vi.fn().mockImplementation(answerAfter(60_000));
    let text: string | undefined;
    const sent = transport('gemma-4-31b-it', gen)
      .send(request({ reasoning: 'on' }))
      .then((r) => {
        text = r.text;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(gen).toHaveBeenCalledTimes(1); // no watchdog kill, so no second attempt
    expect(text).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await sent;
    expect(text).toBe(ANSWER);
  });

  it('gemini-3.6-flash at model-default keeps the thinking window: a 60 s silence is not killed (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const gen = vi.fn().mockImplementation(answerAfter(60_000));
    let text: string | undefined;
    const sent = transport('gemini-3.6-flash', gen)
      .send(request({ reasoning: 'model-default' }))
      .then((r) => {
        text = r.text;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(gen.mock.calls[0][0].config.thinkingConfig).toEqual({ includeThoughts: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await sent;
    expect(gen).toHaveBeenCalledTimes(1);
    expect(text).toBe(ANSWER);
  });

  it("gemma-4-31b-it at off gets today's idle window and no thought summaries: a 60 s silence is killed at 45 s and retried (fake clock)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gen = vi.fn().mockImplementation(answerAfter(60_000));
    const sent = transport('gemma-4-31b-it', gen)
      .send(request({ reasoning: 'off' }))
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(gen.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(gen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(gen.mock.calls.length).toBeGreaterThan(1); // killed by the 45 s idle window, then retried
    await vi.advanceTimersByTimeAsync(600_000);
    await sent;
  });

  it('a Gemma 4 request at on reports thoughtsTokenCount as reasoning tokens; at off it does not (its request asked for no thoughts)', async () => {
    const withThoughts = () =>
      Promise.resolve(
        (async function* () {
          yield chunk([{ text: ANSWER }], { finishReason: 'STOP', thoughtsTokenCount: 321 });
        })(),
      );
    const on = await transport('gemma-4-31b-it', vi.fn().mockImplementation(withThoughts)).send(request({ reasoning: 'on' }));
    const off = await transport('gemma-4-31b-it', vi.fn().mockImplementation(withThoughts)).send(request({ reasoning: 'off' }));
    expect(on.usage?.reasoningTokens).toBe(321);
    expect(off.usage?.reasoningTokens).toBeUndefined();
  });

  it('a free-text request counts thoughtsTokenCount only when its own wire asked for thoughts (A3)', async () => {
    const withThoughts = () =>
      Promise.resolve(
        (async function* () {
          yield chunk([{ text: ANSWER }], { finishReason: 'STOP', thoughtsTokenCount: 321 });
        })(),
      );
    const free = (reasoning: 'model-default' | 'low') =>
      request({ system: '', structuredOutput: { mode: 'off' }, temperature: undefined, maxOutputTokens: undefined, freeText: {}, reasoning });
    const gen = vi.fn().mockImplementation(withThoughts);
    const t = transport('gemini-3.6-flash', gen);
    const atDefault = await t.send(free('model-default'));
    const atLow = await t.send(free('low'));
    /* A persona request at model-default sends no thinkingConfig (W4), so its count is not evidence… */
    expect('thinkingConfig' in (gen.mock.calls[0][0].config as Record<string, unknown>)).toBe(false);
    expect(atDefault.usage?.reasoningTokens).toBeUndefined();
    /* …while a level that thinks sends includeThoughts, and then it is. */
    expect(gen.mock.calls[1][0].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: true });
    expect(atLow.usage?.reasoningTokens).toBe(321);
  });
});

describe('an empty MAX_TOKENS finish: Gemma at on overflows, Gemma at off or its default splits (G1, P27 as amended)', () => {
  /* One stream for all three: an empty answer cut off at the cap, with thought tokens reported and no
     thought parts. Only the request's own level decides whether that count is reasoning evidence. */
  const truncatedAfterThinking = () =>
    Promise.resolve(
      (async function* () {
        yield chunk([], { finishReason: 'MAX_TOKENS', thoughtsTokenCount: 900 });
      })(),
    );
  const thrownFinish = async (reasoning: 'on' | 'off' | undefined): Promise<unknown> => {
    const result = await transport('gemma-4-31b-it', vi.fn().mockImplementation(truncatedAfterThinking)).send(request({ reasoning }));
    try {
      mapFinish(result, { kind: 'gemini', model: 'gemma-4-31b-it' });
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it('at on the thought tokens are evidence, so the finish is a reasoning overflow that stops the run (P6, P20)', async () => {
    const err = await thrownFinish('on');
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect((err as AnalyzerReasoningOverflowError).reasoningTokens).toBe(900);
  });

  it.each([['off'], [undefined]] as const)('at %s the request asked for no thoughts, so the same finish splits (#528 recovery)', async (reasoning) => {
    const err = await thrownFinish(reasoning);
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).not.toBeInstanceOf(AnalyzerReasoningOverflowError);
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
    /* F2 — a 3.x id, not 2.5 (2.5 offers model-default only). */
    _setUserSettingsCacheForTest({ analyzerReasoningByEngine: { gemini: { 'gemini-3.6-flash': 'low' } } });
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.6-flash' }).runAttributionEscalation('m1', 1, 0, 'prompt', {});
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.5-flash' }).runAttributionEscalation('m1', 1, 1, 'prompt', {});
    expect((captured[0].config.thinkingConfig as Record<string, unknown>).thinkingLevel).toBe('LOW');
    expect((captured[1].config.thinkingConfig as Record<string, unknown> | undefined)?.thinkingLevel).toBeUndefined();
  });

  it('Ollama: default install still sends think:false; a level saved for one model is sent for that model only (P18)', async () => {
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
    _setUserSettingsCacheForTest({ analyzerReasoningByEngine: { ollama: { 'q:4b': 'on' } } });
    await new OllamaAnalyzer({ url, model: 'q:4b' }).runAttributionEscalation('m1', 1, 1, 'prompt', {});
    await new OllamaAnalyzer({ url, model: 'q:9b' }).runAttributionEscalation('m1', 1, 2, 'prompt', {});
    expect(ollamaBodies.map((b) => b.think)).toEqual([false, true, false]);
  });

  it('Ollama, one model id (N7): a level saved under qwen3:latest reaches a run on qwen3, and one saved under qwen3 a run on qwen3:latest', async () => {
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
    _setUserSettingsCacheForTest({ analyzerReasoningByEngine: { ollama: { 'qwen3:latest': 'on' } } });
    await new OllamaAnalyzer({ url, model: 'qwen3' }).runAttributionEscalation('m1', 1, 3, 'prompt', {});
    _setUserSettingsCacheForTest({ analyzerReasoningByEngine: { ollama: { qwen3: 'high' } } });
    await new OllamaAnalyzer({ url, model: 'qwen3:latest' }).runAttributionEscalation('m1', 1, 4, 'prompt', {});
    expect(ollamaBodies.map((b) => b.think)).toEqual([true, 'high']);
  });
});
```
(`runAttributionEscalation` is used because it is one call with no skill file; its `null` result on `'{}'` is irrelevant — only the captured request is asserted.)

Append to `server/src/analyzer/voice-style.test.ts`. It reuses W4 Task 4.5's module mocks, `mockSettingsPatch` and `CHAR`:
```ts
describe("persona generation reads its own model's reasoning entry (#3084 wave 5, P18)", () => {
  afterEach(() => {
    delete process.env.PERSONA_GEN_ENGINE;
    delete process.env.PERSONA_GEN_LOCAL_MODEL;
    mockSettingsPatch = {};
    vi.restoreAllMocks();
  });

  it("the persona local model sends its own entry, not another model's", async () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    mockSettingsPatch = { analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'on', 'qwen3.5:9b': 'model-default' } } };
    const { OllamaTransport } = await import('./transports/ollama-transport.js');
    const send = vi
      .spyOn(OllamaTransport.prototype, 'send')
      .mockResolvedValue({ text: 'A voice.', reasoningSeen: false, finish: 'stop', receivedBytes: 8 });
    process.env.PERSONA_GEN_LOCAL_MODEL = 'qwen3.5:9b';
    await generateVoiceStylePersona(CHAR);
    process.env.PERSONA_GEN_LOCAL_MODEL = 'qwen3.5:4b';
    await generateVoiceStylePersona(CHAR);
    expect(send.mock.calls.map(([sent]) => sent.reasoning)).toEqual(['model-default', 'on']);
  });
});
```

In W3b's `server/src/analyzer/openai-analyzer.test.ts`, inside `describe('OpenAIAnalyzer (#3084 PR 3b)', …)`, reuse its `start`, `streamText`, `VALID`, `ID`, `bodies` and `endpoint(baseUrl, over)` helpers:
- In the case `resolves a numeric output cap for Auto and manual endpoints — never undefined (P24)`, change the first assertion to `expect(openAIRequestSettings(endpoint('http://127.0.0.1:8080/v1'))).toEqual({ structuredOutput: 'schema', maxOutputTokens: 29_491, reasoning: 'model-default' });`.
- Append:
```ts
  it("openAIRequestSettings resolves the endpoint's own reasoning level, and a stage sends it (#3084 wave 5)", async () => {
    expect(openAIRequestSettings(endpoint('http://127.0.0.1:8080/v1')).reasoning).toBe('model-default');
    expect(
      openAIRequestSettings(endpoint('http://127.0.0.1:8080/v1', { reasoningStyle: 'enable_thinking', reasoning: 'off' }), 8_192).reasoning,
    ).toBe('off');
    const url = await start((_n, res) => streamText(res, VALID));
    await new OpenAIAnalyzer({ endpoint: endpoint(url, { reasoningStyle: 'reasoning_effort', reasoning: 'none' }), apiKey: null, model: 'qwen3:30b' })
      .runStage1Chapter(ID, 1, '# p', {});
    expect((bodies[bodies.length - 1] as unknown as Record<string, unknown>).reasoning_effort).toBe('none');
  });
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/transports/reasoning-wire.test.ts src/analyzer/transports/gemini-request-thinks.test.ts src/analyzer/gemini-reasoning-wiring.test.ts src/analyzer/openai-analyzer.test.ts`
Expected: FAIL.
- `does not provide an export named 'mergeGeminiThinkingConfig'`.
- `gemini-request-thinks.test.ts`:
  - `resolves the window per request…` fails with `expected 45000 to be 120000` (Gemma at `on`; W2's resolver ignores the level; F6 — the automatic thinking window is 120 s/120 000 ms);
  - the Gemma `on` fake-clock case fails on its `thinkingConfig` (no level is sent yet) and on a second attempt at 45 s;
  - the Gemma 4 `off` fake-clock case fails only on `thinkingConfig` (`expected undefined to equal { thinkingLevel: 'MINIMAL' }`): the timing already passes, because W2's id rule already treats Gemma as non-thinking, so it already gets the 45 s idle window before this task's wire change;
  - the 3.6 Flash `model-default` case passes: it pins wave 2's behaviour;
  - `a free-text request counts thoughtsTokenCount only when its own wire asked for thoughts (A3)` fails on the level's wire (`expected undefined to deeply equal { thinkingLevel: 'LOW', includeThoughts: true }`); its `model-default` half already holds, because W4's flag is false on every free-text request;
  - `at on the thought tokens are evidence…` (G1) fails with an `AnalyzerTruncatedError`: no level reaches the wire yet, so Gemma reports no reasoning tokens. Its two `off` / default rows pass — they pin the #528 split.
- The `Ollama, one model id (N7)…` case fails with `expected [ false, false ] to deeply equal [ true, 'high' ]` (no closure sets `reasoning` yet).
- Ollama `on sends think=true` fails with `expected false to deeply equal true`.
- In `openai-analyzer.test.ts`, the P24 case fails `toEqual` (no `reasoning` key), and the new case gets `undefined` for both the setting and `reasoning_effort`.

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
The Gemini and OpenAI free-text requests need no separate change: W4 routes them through the same `config` literal / params object. On Gemini, W4 leaves a free-text `baseConfig` with no `thinkingConfig`. So `model-default` (an empty fragment) keeps the persona request's shape, and a non-default level adds exactly its fragment, `includeThoughts` included (test: `a free-text request sends no thinkingConfig at model-default…`).

`gemini-transport.ts` — add the exported helper and import:
```ts
import { reasoningWireFragment } from '../reasoning.js';

/** Merge a reasoning fragment's thinkingConfig into the request config built by
    W2 (which may already carry includeThoughts). The fragment decides
    includeThoughts (P19): reasoningWireFragment adds it to every level that
    thinks and leaves it off `off` (Gemma's MINIMAL — the only row with an
    `off` level), so it accompanies any request that thinks and never one
    that does not. The fragment never carries thinkingBudget at all — that
    control is retired (F2); reasoning.test.ts pins it. */
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
  if (add.includeThoughts !== true) delete merged.includeThoughts;
  return { ...config, thinkingConfig: merged };
}
```
Where the transport passes `config: { responseMimeType…, thinkingConfig… }` to `this.client.models.generateContentStream({ model, contents, config })`, hoist the literal into `const baseConfig: Record<string, unknown> = { …unchanged… };`, bind the merged config to a local (Task 5.10 merges the payload into the same request object), and pass it:
```ts
        const configWithReasoning = (req.reasoning === undefined
          ? baseConfig
          : mergeGeminiThinkingConfig(baseConfig, reasoningWireFragment('gemini', { model: this.model }, req.reasoning))) as GenerateContentConfig;
```
```ts
        config: configWithReasoning,
```
(`import type { GenerateContentConfig } from '@google/genai';` if not already imported.)

**Request thinking (N1, P27).** Wave 2 decides two things from the model id alone: whether a request asks for thought summaries, and which window bounds its silence before answer text. A level can turn thinking on for a model outside the id rule (Gemma 4 `on`) or off for one inside it (a 3.x model has no `off`, so this is Gemma-only in practice; a 2.5 id has no row at all — F2 — so any saved level falls back to the id rule). So both now ask one function, `geminiRequestThinks(this.model, req.reasoning)` (Task 5.1). The shape chosen is to **modify W2's resolver by symbol, adding an optional level**, rather than to wrap it. That keeps one resolver and one window rule, and W2's own calls and tests are unchanged, because `geminiRequestThinks(model, undefined)` is `geminiModelThinks(model)`. In `gemini-transport.ts`:
1. **Whether the request thinks.** In `generate(req)`, replace W4 Task 4.3's `const includeThoughts = !req.freeText && geminiModelThinks(this.model);` with:
```ts
    /* #3084 P27 — decided once per request from its settings, never the catalog: the id rule by default,
       or a level that turns thinking on or off (N1). */
    const requestThinks = geminiRequestThinks(this.model, req.reasoning);
```
2. **The config spread.** In the `baseConfig` literal, replace W4's `...(includeThoughts ? { thinkingConfig: { includeThoughts: true } } : {}),` with `...(!req.freeText && requestThinks ? { thinkingConfig: { includeThoughts: true } } : {}),`. At `model-default` the value is the same as W4's. At any other level `mergeGeminiThinkingConfig` then sets `includeThoughts` from the fragment.
2b. **The evidence gate (A3).** Directly after `configWithReasoning` (the hoist above), add the local W2's usage block reads:
```ts
    /* #3084 P27, A3 — one flag, read from the thinkingConfig this request actually sends: a
       thoughtsTokenCount is reasoning evidence only when the wire asked for thoughts. So a free-text
       (persona) request at model-default counts none, Gemma at `on` counts its own, and the wire and the
       count can never disagree (Task 5.1's `agrees with the wire…` case pins the fragment side). */
    const includeThoughts =
      (configWithReasoning.thinkingConfig as { includeThoughts?: unknown } | undefined)?.includeThoughts === true;
```
W2's `reasoningTokens: includeThoughts ? thoughtsTokenCount : undefined` keeps reading that name and needs no edit.
3. **W2's resolver.** Replace `resolveGeminiThinkingIdleTimeoutMs` with:
```ts
/** P5 — the silence allowed before a Gemini request's answer text starts: the
    wait for the first chunk and each gap between thought parts.
    analyzer.gemini.thinkingIdleTimeoutMs = 0 (the default) is automatic per
    request: 120 s (F6, approved by the owner 2026-09-13; was 240 s) for a
    request that thinks (P27: the static id rule by default, or a level that
    turns thinking on; geminiRequestThinks), otherwise the stream idle window.
    A positive value applies to every request. */
export function resolveGeminiThinkingIdleTimeoutMs(model: string, level?: ReasoningLevel): number {
  const configured = configValue<number>('analyzer.gemini.thinkingIdleTimeoutMs');
  if (configured > 0) return configured;
  return geminiRequestThinks(model, level) ? GEMINI_THINKING_IDLE_TIMEOUT_MS : resolveStreamIdleTimeoutMs();
}
```
4. **W2's private helper.** Replace `geminiThinkingWindowApplies` with:
```ts
/** P5 — whether a timeout before answer text is a thinking-window timeout
    (AnalyzerTimeoutError, not retried) rather than today's idle timeout
    (GeminiStreamIdleError, retried): a request that thinks (P27), or a positive knob. */
function geminiThinkingWindowApplies(model: string, level?: ReasoningLevel): boolean {
  return configValue<number>('analyzer.gemini.thinkingIdleTimeoutMs') > 0 || geminiRequestThinks(model, level);
}
```
5. **The call sites.** In `generate`'s watchdog block, pass the request's level at wave 2's two calls: `const thinkingIdleTimeoutMs = resolveGeminiThinkingIdleTimeoutMs(this.model, req.reasoning);` and `const thinkingWindowApplies = geminiThinkingWindowApplies(this.model, req.reasoning);`.
6. **Imports.** Import `geminiRequestThinks` and `type ReasoningLevel` from `../reasoning.js`, in the same statement as `reasoningWireFragment`. The three sites above were `geminiModelThinks`'s only uses in this file, so remove it from the `../catalog/gemini-catalog.js` import. `npm run typecheck` flags a leftover use.

`openai-transport.ts` — where W3b builds the params object for `client.chat.completions.create(params, { signal })`, after the object literal add:
```ts
    if (req.reasoning !== undefined) {
      Object.assign(params, reasoningWireFragment('openai', { model: this.model, endpoint: this.endpoint }, req.reasoning));
    }
```
with `import { reasoningWireFragment } from '../reasoning.js';`, typing `params` as `Record<string, unknown>` at declaration and casting at the `create(` call site (`params as unknown as ChatCompletionCreateParamsStreaming`) if W3b typed it as the SDK type.

`stage-runner.ts` needs no change here: Task 5.1 already forwards `reasoning: settings.reasoning` on every transport request.

Settings closures — in the `OllamaAnalyzer` and `GeminiAnalyzer` constructors' `new StageRunner({ … settings: () => ({ … }) })`, add a `reasoning:` entry. No wave 1–4 closure sets the field; it is optional since Task 5.1.
- `OllamaAnalyzer` (`ollama.ts`): `reasoning: resolveReasoningSetting(getCachedUserSettings(), { engine: 'local', model: opts.model }),`
- `GeminiAnalyzer` (`gemini.ts`): `reasoning: resolveReasoningSetting(getCachedUserSettings(), { engine: 'gemini', model: opts.model }),`
(`opts` = the constructor parameter; import `resolveReasoningSetting` from `./reasoning.js` and `getCachedUserSettings` from `../workspace/user-settings.js` where missing.) If W4 built a separate settings closure for persona generation, apply the line matching its engine there too.

`OpenAIAnalyzer` — W3b's closure is `settings: () => openAIRequestSettings(opts.endpoint, …)`, and W3c Task 3c.9 fills the second argument. Leave the closure alone and extend the function in `server/src/analyzer/openai.ts`. Replace W3b's two-line `/* No reasoning / extraParams: EngineRequestSettings has neither field until … */` comment with a `reasoning` entry, so the function reads:
```ts
export function openAIRequestSettings(endpoint: AnalyzerEndpoint, servedOutputLimit?: number): EngineRequestSettings {
  return {
    structuredOutput: endpoint.structuredOutput,
    maxOutputTokens: resolveEndpointMaxOutputTokens(endpoint, servedOutputLimit),
    /* #3084 wave 5 — an endpoint carries its own level. resolveReasoningSetting reads neither the
       settings file nor the model for engine 'openai', so neither is passed. Task 5.10 adds extraParams. */
    reasoning: resolveReasoningSetting({}, { engine: 'openai', model: '', endpoint }),
  };
}
```
Add `import { resolveReasoningSetting } from './reasoning.js';`. The function's doc comment stays.

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/transports/reasoning-wire.test.ts src/analyzer/transports/gemini-request-thinks.test.ts src/analyzer/runner/stage-runner.request-controls.test.ts src/analyzer/gemini-reasoning-wiring.test.ts src/analyzer/openai-analyzer.test.ts src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts src/analyzer/voice-style.test.ts src/analyzer/transports src/analyzer/runner`
Then: `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`
Expected: PASS. Keeps green: W1's transport and runner suites (default settings resolve to today's wire), `ollama.test.ts:386-410` (format body), W3's OpenAI transport contract suite, W4's persona tests (including `reports no reasoning tokens…`, whose free-text request still sends no `thinkingConfig`), W2's `transports/gemini-transport.test.ts` thinking-window and thought-summary cases, and the slow lane's `a Gemma empty MAX_TOKENS response WITH thoughtsTokenCount but no thought parts still splits` — all of them send no level, so the id rule still decides.

- [ ] **Step 5: Mutation proof**
1. In `ollama-transport.ts` delete `(body as Record<string, unknown>).think = false;`. Expected red: `undefined reasoning keeps think:false (pre-W5 behaviour)`. Restore.
1b. In `sendFreeText` delete the `Object.assign(body, reasoningWireFragment(…))` line (leaving the `else` empty). Expected red: `a saved level reaches the persona call; model-default omits think`. Restore. Also delete `body.think = false;` there. Expected red: `undefined reasoning keeps think:false on the persona call` (and W4's own free-text test that asserts `body.think === false`). Restore.
2. Runner forwarding is proven by Task 5.1's mutation proofs 5–6; it is not repeated here.
3. In `mergeGeminiThinkingConfig` replace `if (add.includeThoughts !== true) delete merged.includeThoughts;` with `if (false) delete merged.includeThoughts;` (never strips). Expected red: `mergeGeminiThinkingConfig: the fragment decides includeThoughts (P19)` — the MINIMAL case (`{ thinkingConfig: { includeThoughts: true } }` merged with `{ thinkingConfig: { thinkingLevel: 'MINIMAL' } }`) now wrongly keeps `includeThoughts: true`. Restore.
4. In `OllamaAnalyzer`'s closure replace the resolver with `reasoning: 'off',`. Expected red: `Ollama: default install still sends think:false; a level saved for one model is sent for that model only (P18)`. Restore.
5. In `reasoning.ts`'s `thinkingLevel` branch (`{ thinkingConfig: { thinkingLevel: level.toUpperCase(), ...thoughts } }`) drop `...thoughts`. Expected red: `Gemma 4 on and gemini-3.5-flash-lite low carry includeThoughts; Gemma 4 off does not (P19)`. Restore.
6. In `OllamaAnalyzer`'s closure replace `model: opts.model` with `model: 'qwen3.5:4b'`. Expected red: `the persona local model sends its own entry, not another model's`. Restore.
7. In `openAIRequestSettings` delete the `reasoning:` entry. Expected red: `openAIRequestSettings resolves the endpoint's own reasoning level, and a stage sends it` (both halves) and `resolves a numeric output cap for Auto and manual endpoints — never undefined (P24)` (`toEqual`). Restore. Then, in `OpenAIAnalyzer`'s closure, replace `openAIRequestSettings(…)` with `{ structuredOutput: opts.endpoint.structuredOutput, maxOutputTokens: undefined }`. Expected red: the wire half of the same case (`reasoning_effort` is `undefined`). Restore.
8. In `generate`, drop `req.reasoning` from both watchdog calls (`resolveGeminiThinkingIdleTimeoutMs(this.model)`, `geminiThinkingWindowApplies(this.model)`). Expected red: `Gemma 4 at on: the request asks for thought summaries, and a 60 s silent think is not killed` (a second attempt at 45 s). Restore.
9. In `resolveGeminiThinkingIdleTimeoutMs` replace `geminiRequestThinks(model, level)` with `geminiModelThinks(model)`. Expected red: `resolves the window per request…`. Restore.
10. Replace the `includeThoughts` local's expression with `geminiModelThinks(this.model)`. Expected red: `a Gemma 4 request at on reports thoughtsTokenCount as reasoning tokens…` (`expected undefined to be 321`) and `at on the thought tokens are evidence…` (an `AnalyzerTruncatedError`). Restore.
10b. Replace the same local with `requestThinks` (the request's level, not its wire). Expected red: `a free-text request counts thoughtsTokenCount only when its own wire asked for thoughts (A3)` (`expected 321 to be undefined`). Restore.
11. Task 5.1's mutation 9 (a raw Ollama lookup in `resolveReasoningSetting`) also turns `Ollama, one model id (N7)…` red here (`expected [ false, false ]…`); run it once against this suite.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports server/src/analyzer/ollama.ts server/src/analyzer/gemini.ts server/src/analyzer/openai.ts server/src/analyzer/gemini-reasoning-wiring.test.ts server/src/analyzer/voice-style.test.ts
git add server/src/analyzer/openai-analyzer.test.ts
git commit -m "feat(server): send the configured reasoning level on every analyzer transport"
```

### Task 5.4: Test action level step, level-keyed records, pre-run refusal of a stale level, catalog `offeredReasoningLevels`

**Files:**
- Modify: `server/src/analyzer/capabilities.ts` (W3c Tasks 3c.3–3c.4):
  - add the level step at `runModelTest`'s marked step-2 hook;
  - add two `ModelTestDeps` fields;
  - replace `plannedTestRequestCount`;
  - give the private `sendStep` and `modeStep` a reasoning level;
  - rename the private `isHttp400` to the exported `isProbeRejected`;
  - delete `defaultReasoningKey`, replaced by reasoning.ts `defaultReasoningLevel`.
- Modify: `server/src/analyzer/model-test-deps.ts` (W3c Task 3c.6, `modelTestDepsFor`) — the Test deps
- Modify: `server/src/analyzer/catalog/analyzer-catalog.ts` (W3c Task 3c.5, `toEntry` and `endpointGroup`) — `offeredReasoningLevels`, the level-keyed label, the test plan
- Modify: `server/src/analyzer/preflight.ts` (W3c Task 3c.10, `runAnalyzerPreflight`) — its three `assertConfiguredCapabilitiesAllowed(` calls
- Modify: `server/src/analyzer/errors.ts` — new `AnalyzerReasoningUnavailableError` (P17), with a `when` discriminator for the mid-run throw (N10)
- Modify: `server/src/analyzer/reasoning.ts` (Task 5.1) — `unavailable()` throws that coded error instead of a plain `Error` (N10)
- Modify: `server/src/analyzer/reasoning.test.ts` (Task 5.1) — the five `is not available` assertions, plus the mid-run case
- Create: `server/src/analyzer/capability-record-merge.ts` — import-free leaf: `sameServer` moved from W3c's `capabilities.ts` (body unchanged) and `mergeCapabilityRecords` (N14, A2)
- Modify: `openapi.yaml` — W3c's `ModelCapabilityRecord` already carries `digest` (3c, A3); this task adds `verdictTestedAt` (A2); regenerate `src/lib/api-types.ts`
- Modify: `server/src/workspace/user-settings.ts` (W3c Task 3c.3, `writeAnalyzerCapabilityRecord`) — merge a Test's verdicts into the model's record for the same server (N14)
- Modify: `server/src/routes/analyzer-models.ts` (W3c Task 3c.6, `POST /models/test`) — write the record under `capabilityRecordKey(modelId)` (N7)
- Modify: `server/src/analyzer/voice-style.ts` (W4 Task 4.5, `generateVoiceStylePersona`) and `server/src/routes/cast-design.ts` (W4 Task 4.6, `runPersonaPrePass`'s rethrow condition) — the persona pre-run refusal
- Test:
  - Create `server/src/analyzer/capabilities.reasoning.test.ts`, `server/src/routes/analyzer-models.reasoning.test.ts` and `server/src/analyzer/preflight.reasoning.test.ts`.
  - Append to `server/src/analyzer/voice-style.test.ts` and `server/src/routes/cast-design.test.ts`.
  - Create `server/src/analyzer/capability-record-merge.test.ts`.
  - Update W3c's `server/src/analyzer/capabilities.run-model-test.test.ts`, `server/src/analyzer/capabilities.test.ts`, `server/src/analyzer/model-test-deps.test.ts` and `server/src/analyzer/catalog/analyzer-catalog.test.ts`.

**Interfaces:**
- Consumes:
  - Task 5.1: `defaultReasoningLevel`, `testableReasoningLevels`, `offeredReasoningLevels`, `resolveReasoningSetting`, `ReasoningSelection`.
  - W3c Tasks 3c.3–3c.4:
    - `ModelTestDeps` (`transport`, `serverUrl`, `configuredMode`, `offeredModes`, `adaptSchema`, `probeLimits`, `signal?`, `now?`, `markerValue?`, `redact?`, `modelDigest?`);
    - `ModelCapabilityRecord` (already carrying 3c's `digest?`), `capabilityRecordFor(settings, modelId, serverUrl, currentDigest?)`, and `assertConfiguredCapabilitiesAllowed(record, { structuredOutput, reasoning }, modelId)`, which this task leaves unchanged (it already keys by the level a run sends);
    - `plannedTestRequestCount`, and `runModelTest` with its step-2 hook comment — its return already stamps `digest` from `deps.modelDigest` (3c A3);
    - the private `sendStep(deps, format, maxOutputTokens)`, `modeStep(modelId, mode, format, marker, cap, deps, redact)`, `isHttp400`, `providerText` and `throwIfAborted`;
    - the exported `namesContextOrTokenLimit`, `LIMIT_400_PATTERNS`, `ModelTestInconclusiveError(modelId, step, detail)`, `ModelTestControlFailedError`, `probeOutputCap`, `PROBE_PROMPT` and `defaultReasoningKey`.
  - W3c Task 3c.10: `runAnalyzerPreflight(targets, settings, digests?: ReadonlyMap<string, string | undefined>)` — this task reads its existing `digests` parameter (A3) rather than adding one; it does not touch `resolvePreflightDigests` or any call site's digest resolution.
  - W3b: `structuredOutputLabel(mode, dropped, record, reasoningKey)`.
  - Errors and ids: `AnalyzerCapabilityRejectedError`, `AnalyzerHttpError`, `AnalysisAbortedError`, `inferEngineFromModelId`, `parseEndpointModelId`.
  - W3c's `analyzerModelsRouter`, mounted at `/api/analyzer`.
- Produces:
  - **New** exports of `capabilities.ts`: `isProbeRejected(err)`, `reasoningLevelsToProbe(scope, sel, configured)`, `plannedReasoningProbeCount(levels, controlLevel)`, `probeReasoningLevels(levels, deps)`, `ReasoningLevelTestInconclusiveError`, `reasoningSelectionFor(settings, modelId, engine?, currentDigest?)`, `configuredReasoningFor(settings, modelId, engine?, currentDigest?)`, `assertConfiguredReasoningOffered(settings, modelId, engine?, currentDigest?)` (P17). `currentDigest` (A3) mirrors `capabilityRecordFor`'s own trailing parameter and passes through to it for the `local` engine only; `runAnalyzerPreflight` is the only pre-run caller and passes `digests?.get(target.modelId)` from the map W3c's `resolvePreflightDigests` already resolved (no new network read). Every other caller — `modelTestDepsFor`, the catalog's `toEntry`, persona generation — omits it and keeps `capabilityRecordFor`'s existing fail-open rule.
  - **New** in `errors.ts`: `AnalyzerReasoningUnavailableError(modelId, level, engine)` (contract).
  - **New** in `capabilities.ts`: `capabilityRecordKey(modelId)` (N7); `sameCapabilityRecordModel(a, b)` and `verdictTestedAtFor(record, cell)` (A2); `capabilityRecordFor` now also looks Ollama records up through `entryForModelTag` (N7), keeping 3c's `currentDigest` parameter and discard rule unchanged underneath.
  - **New** leaf `capability-record-merge.ts`: `sameServer(a, b)` (moved from `capabilities.ts`) and `mergeCapabilityRecords(previous, next)` (N14, A2).
  - `ModelCapabilityRecord` gains `verdictTestedAt?` (`digest?` already added by 3c); `writeAnalyzerCapabilityRecord` gains a `sameModel` predicate (A2).
  - **Removed:** `defaultReasoningKey`.
- `ModelTestDeps` gains `reasoningSelection` and `configuredReasoning`. `plannedTestRequestCount`'s deps become `Pick<ModelTestDeps, 'configuredMode' | 'offeredModes' | 'reasoningSelection' | 'configuredReasoning'>`.
- Record semantics: `record.reasoning[level]` is `accepted | rejected`, written only after the control succeeded. `record.structuredOutput[mode]` is keyed by the configured level the mode steps sent.
- **Merged, not replaced (N14).** A Test merges the verdicts it probed into the model's existing record for the same server URL. It replaces only the probed `reasoning` levels and the probed `structuredOutput[mode][level]` cells, and `testedAt` becomes the latest. So a `configured` Test, which probes one level, keeps the level verdicts an earlier `all` Test recorded. A record for another server URL is replaced whole, as `capabilityRecordFor` would discard it anyway.
- **Per-verdict dates (A2).** Because a merged record carries verdicts from more than one Test, each verdict keeps its own date in `verdictTestedAt`, and the pre-run refusal cites the date of the Test that recorded *that* verdict (`verdictTestedAtFor`), not the record's newest date. A verdict from a record written before this field existed takes that record's `testedAt`.
- **Model identity (A2).** 3c already stamps an Ollama record with the model's `digest` from `/api/tags` (verified against a live daemon: every entry has one) and discards a stored record outright when the digest no longer matches the installed model (`capabilityRecordFor`). This task adds the merge-time counterpart: a Test whose digest differs from the stored record's replaces the record instead of merging, so a tag re-pulled under the same name keeps no verdict that was never probed for the new build. A digest present on one side only proves nothing and also replaces; two records with no digest at all (endpoints, Gemini) merge on the server URL alone, as before. Endpoints expose no digest: a model remapped behind the same name is caught on the first call the new model refuses (`analyzer-request-rejected`), and the same holds for an Ollama tag re-pulled without a new Test.
- **One record per model (A2, N7).** The write looks the earlier record up through `normalizeModelTag` and removes every other key that names the same model, so a record W3c filed under `qwen3:latest` is found, merged into and rewritten under `qwen3`.
- **One Ollama model id (N7).** A record is saved under `capabilityRecordKey(modelId)` (an Ollama tag through `normalizeModelTag`; an endpoint id as is) and looked up through `entryForModelTag`, so a Test of `qwen3:latest` answers for a run on `qwen3`.

**Decisions this task encodes** (recorded so review does not re-litigate):
- **One default-level rule.** W3c's `defaultReasoningKey(kind)` and Task 5.1's `defaultReasoningLevel(engine)` return the same values: Ollama `off`, others `model-default`. This task deletes the former and uses the latter at every call site (`runModelTest`, `toEntry`, the preflight), so exactly one rule remains. `reasoning.test.ts`'s `defaults preserve today` pins the values.
- **The level step is W3c's marked step 2.** The ladder becomes three steps:
  1. control: `off` mode at the engine's default level;
  2. level step: `off` mode at the configured level, differing from the control only in `reasoning`;
  3. mode steps: the configured mode at the configured level.

  Every step goes through W3c's `sendStep`, so all of them share one prompt, one cap and the client's abort signal. A level equal to the control's level is recorded `accepted` without a second request.
- **Which levels and modes.** `scope: 'configured'` probes the configured level, and `scope: 'all'` probes every `testableReasoningLevels` entry. Mode steps run at the configured level only, in both scopes (no mode × level cross product). A mode record under another level is simply absent, so the label never claims "not enforced" for an untested level.
- **A rejected configured level** skips the mode steps: nothing could be attributed to them.
- **Level steps prove acceptance only (P7).** Any finish records `accepted`, `length` and `blocked` included. A thinking model spends the cap reasoning, so a `length` stop is the expected shape here. Only W3c's mode steps treat a `length` / `blocked` finish as inconclusive.
- **Failures on a level step (P7)** mirror W3c's `modeStep`:
  - A 400 records the level `rejected`, unless `namesContextOrTokenLimit(providerText(err))`. That case throws `ReasoningLevelTestInconclusiveError`, whose copy names the level ("The reasoning level "high" check…") and never says "The off check".
  - Any other failure (a 5xx after the transport's retries, a timeout, an unreachable server) throws the same class with the redacted message. It is a `ModelTestInconclusiveError`, so nothing is recorded and the route answers 502.
  - An abort rethrows.
- **Stop-the-run errors (P20).** Every catch this task adds passes `AnalyzerReasoningOverflowError` exactly where it passes `GeminiContentBlockedError`:
  - **The level step's catch** treats the two alike, as W3c's `modeStep` does: inconclusive, nothing recorded. Test: `a content block and a reasoning overflow from a probe are handled alike…`. Neither normally reaches this catch: a transport returns `blocked` / `length` as a finish, and only the runner's `mapFinish` raises these errors. A Test is not a run, so there is no run to stop.
  - **The pre-run stale-level check adds no catch.** `assertConfiguredReasoningOffered` throws before the first call, and W3c's new-job `try` in `routes/analysis.ts` classifies the error. No overflow can exist before a call.
  - **`runPersonaPrePass`** gains only `AnalyzerReasoningUnavailableError`. P20 keeps a pre-pass persona overflow a per-character failure, as a pre-pass content block is. On the lazy path a persona error is a **per-character** failure, as on `main` since `6222e483` (#3027 second half): it does not reach the design route's backstop, so W4 codes only the pre-pass's wholesale rethrows. A lazy `AnalyzerReasoningUnavailableError` therefore fails that one character and the job continues.
- **A failed control** is unchanged: W3c's `ModelTestControlFailedError`, and nothing is written.
- **A stored level no longer offered (P17).** A stored level that `offeredReasoningLevels` no longer offers refuses the run before its first call. Examples: a Gemini table change; an Ollama named level whose Test record is gone or was taken on another server; an endpoint `reasoning` saved before its style changed.
  - It throws `AnalyzerReasoningUnavailableError`, which Task 5.5 maps to `analyzer-request-rejected`.
  - It runs in `runAnalyzerPreflight` beside W3c's `rejected` check, with the target's own engine (`target.engine`, N5: a bare Ollama tag such as `llama2` infers as Gemini from its id), and in `generateVoiceStylePersona` right after `personaRunner`: after the missing-endpoint and key-origin refusals, before the prompt is built.
  - An unknown stored value (N10: stored levels are strings, e.g. `xhigh` from a newer release) is never offered, so it is refused the same way.
  - The design pre-pass ends the job once on it.
- **A level that reaches a call anyway (N10).** `reasoningWireFragment` is the last-resort guard, and it throws the same coded class with `when: 'mid-run'` instead of a plain `Error`, so a hand-edited value that slips past every save and the pre-run check still fails with a code and copy rather than an uncoded mid-run throw. Settings are read per call, so this is the only way a run reaches a call with an unoffered level: every save is validated, and a level saved mid-run is offered. Its `modelId` is the model the transport holds (for an endpoint, the bare model name), which is data for the log; the user-facing copy names the setting and the run's model label (Task 5.5).

**Entry check — W3c's ladder surface.** Before Step 1, run the command below. Every name must be found, with the shape W3c Tasks 3c.3–3c.4 give it (quoted in Step 3 wherever this task edits it). A symbol that moved is followed; one that changed shape is reported to the coordinator before editing.
```bash
git grep -n -E "export interface ModelTestDeps|probeLimits: \(\)|function sendStep|function modeStep|function isHttp400|function providerText|export function namesContextOrTokenLimit|class ModelTestInconclusiveError|class ModelTestControlFailedError|export function defaultReasoningKey|WAVE 5 \(Task 5a\) INSERTS THE LEVEL STEP HERE" -- server/src/analyzer/capabilities.ts
git grep -n "defaultReasoningKey" -- server/src src
```
The second command lists every use of `defaultReasoningKey`: `capabilities.ts` (the definition and `runModelTest`), `catalog/analyzer-catalog.ts` (`toEntry`), `preflight.ts` (three calls), `capabilities.test.ts` (its describe), and any comment that names it. This task removes every use, rewording a comment to name `defaultReasoningLevel`.

- [ ] **Step 1: Write the failing tests**

`server/src/analyzer/capabilities.reasoning.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../workspace/user-settings.js';
import {
  ALL_STRUCTURED_OUTPUT_MODES,
  assertConfiguredCapabilitiesAllowed,
  capabilityRecordFor,
  capabilityRecordKey,
  isProbeRejected,
  ModelTestInconclusiveError,
  plannedReasoningProbeCount,
  plannedTestRequestCount,
  probeReasoningLevels,
  ReasoningLevelTestInconclusiveError,
  reasoningLevelsToProbe,
  runModelTest,
  verdictTestedAtFor,
  type ModelCapabilityRecord,
  type ModelTestDeps,
} from './capabilities.js';
import { AnalysisAbortedError, AnalyzerHttpError, AnalyzerReasoningOverflowError, GeminiContentBlockedError } from './errors.js';
import { structuredOutputLabel } from './runner/schema-adapters.js';
import type { ChatTransport, TransportRequest, TransportResult } from './runner/transport.js';
import type { ReasoningLevel } from './reasoning.js';

const rec = (over: Partial<ModelCapabilityRecord> = {}): ModelCapabilityRecord => ({
  serverUrl: 'http://127.0.0.1:11434', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true },
  structuredOutput: {}, reasoning: {}, ...over,
});
const http400 = () => new AnalyzerHttpError('ollama', 400, '"q:4b" does not support thinking', 'Ollama returned 400');
const stop = (): TransportResult => ({ text: '{"ok":true}', reasoningSeen: false, finish: 'stop', receivedBytes: 11 });
const lengthStop = (): TransportResult => ({ text: '', reasoningSeen: true, finish: 'length', receivedBytes: 0, usage: { reasoningTokens: 900 } });

function recording(respond: (req: TransportRequest) => TransportResult) {
  const calls: TransportRequest[] = [];
  const transport: ChatTransport = {
    kind: 'ollama',
    model: 'q:4b',
    send: vi.fn(async (req: TransportRequest) => {
      calls.push(req);
      return respond(req);
    }),
  };
  return { calls, transport };
}

function ollamaDeps(transport: ChatTransport, over: Partial<ModelTestDeps> = {}): ModelTestDeps {
  return {
    transport,
    serverUrl: 'http://127.0.0.1:11434',
    configuredMode: 'off',
    offeredModes: ALL_STRUCTURED_OUTPUT_MODES,
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
    probeLimits: () => ({ contextTokens: 32768, maxOutputTokens: null }),
    reasoningSelection: () => ({ engine: 'local', model: 'q:4b' }),
    configuredReasoning: () => 'off',
    now: () => new Date('2026-09-11T10:00:00.000Z'),
    markerValue: () => 'mk-fixed',
    ...over,
  };
}

describe('isProbeRejected', () => {
  it('is true only for a 400 from any transport', () => {
    expect(isProbeRejected(http400())).toBe(true);
    expect(isProbeRejected(Object.assign(new Error('INVALID_ARGUMENT'), { status: 400 }))).toBe(true);
    expect(isProbeRejected(new AnalyzerHttpError('openai', 500, '', 'boom'))).toBe(false);
    expect(isProbeRejected(new Error('fetch failed'))).toBe(false);
  });
});

describe('probeReasoningLevels — the level step (P7)', () => {
  it('records accepted / rejected and skips the control level', async () => {
    const send = vi.fn(async (level: ReasoningLevel): Promise<TransportResult> => {
      if (level === 'on' || level === 'low') throw http400();
      return stop();
    });
    const out = await probeReasoningLevels(['model-default', 'off', 'on', 'low', 'medium', 'high'], { modelId: 'q:4b', controlLevel: 'off', send });
    expect(out).toEqual({ 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'rejected', medium: 'accepted', high: 'accepted' });
    expect(send.mock.calls.map(([level]) => level)).toEqual(['model-default', 'on', 'low', 'medium', 'high']);
  });
  it('a thinking model that hits length on a level probe records the level accepted (acceptance only)', async () => {
    const send = vi.fn(async (level: ReasoningLevel): Promise<TransportResult> =>
      level === 'high' ? lengthStop() : { text: '', reasoningSeen: false, finish: 'blocked', blockReason: 'SAFETY', receivedBytes: 0 },
    );
    await expect(probeReasoningLevels(['high', 'low'], { modelId: 'qwen3.5:4b', controlLevel: 'off', send })).resolves.toEqual({
      high: 'accepted',
      low: 'accepted',
    });
  });
  it('a 400 naming a context or token limit is inconclusive, with copy that names the level', async () => {
    const send = vi.fn(async (): Promise<TransportResult> => {
      throw new AnalyzerHttpError(
        'openai',
        400,
        "This model's maximum context length is 8192 tokens",
        "Endpoint m returned 400: This model's maximum context length is 8192 tokens",
      );
    });
    const err = await probeReasoningLevels(['high'], { modelId: 'openai:lab::m', controlLevel: 'model-default', send }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReasoningLevelTestInconclusiveError);
    expect(err).toBeInstanceOf(ModelTestInconclusiveError);
    expect((err as Error).message).toContain('The reasoning level "high" check for openai:lab::m was inconclusive');
    expect((err as Error).message).not.toContain('The off check');
  });
  it('a non-400 failure is inconclusive with the level named, never recorded', async () => {
    const send = vi.fn(async (): Promise<TransportResult> => {
      throw new AnalyzerHttpError('ollama', 500, '', 'boom');
    });
    const err = await probeReasoningLevels(['on'], { modelId: 'q:4b', controlLevel: 'off', send }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReasoningLevelTestInconclusiveError);
    expect((err as Error).message).toContain('The reasoning level "on" check for q:4b was inconclusive (boom)');
  });
  it('rethrows an abort', async () => {
    const send = vi.fn(async (): Promise<TransportResult> => {
      throw new AnalysisAbortedError('gone');
    });
    await expect(probeReasoningLevels(['on'], { modelId: 'q:4b', controlLevel: 'off', send })).rejects.toBeInstanceOf(AnalysisAbortedError);
  });
  it('a content block and a reasoning overflow from a probe are handled alike: inconclusive, nothing recorded (P20)', async () => {
    const thrown = [
      new GeminiContentBlockedError('gemini-3.6-flash', 'SAFETY'),
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 900),
    ];
    for (const failure of thrown) {
      const send = vi.fn(async (): Promise<TransportResult> => {
        throw failure;
      });
      const err = await probeReasoningLevels(['low'], { modelId: 'gemini-3.6-flash', controlLevel: 'model-default', send }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReasoningLevelTestInconclusiveError);
      expect((err as Error).message).toContain('The reasoning level "low" check for gemini-3.6-flash was inconclusive');
    }
  });
});

describe("runModelTest — the level step at W3c's step-2 hook", () => {
  it('the level step is the control request with only reasoning changed; mode steps run at the configured level', async () => {
    const { calls, transport } = recording(() => stop());
    const deps = ollamaDeps(transport, { configuredMode: 'json', configuredReasoning: () => 'on' });
    const record = await runModelTest({ modelId: 'q:4b', scope: 'configured' }, deps);
    expect(calls).toHaveLength(plannedTestRequestCount({ modelId: 'q:4b', scope: 'configured' }, deps));
    expect(calls.map((c) => [c.structuredOutput.mode, c.reasoning])).toEqual([
      ['off', 'off'],
      ['off', 'on'],
      ['json', 'on'],
    ]);
    const { reasoning: _controlLevel, ...control } = calls[0];
    const { reasoning: _probeLevel, ...probe } = calls[1];
    expect(probe).toEqual(control);
    expect(record.reasoning).toEqual({ on: 'accepted' });
    expect(record.structuredOutput).toEqual({ json: { on: 'accepted' } });
  });

  it('scope all on a thinking model: every level probe that stops with length is recorded accepted', async () => {
    const { transport } = recording((req) => (req.reasoning === 'off' ? stop() : lengthStop()));
    const record = await runModelTest({ modelId: 'q:4b', scope: 'all' }, ollamaDeps(transport, { offeredModes: ['off'] }));
    expect(record.control).toEqual({ ok: true });
    expect(record.reasoning).toEqual({ 'model-default': 'accepted', off: 'accepted', on: 'accepted', low: 'accepted', medium: 'accepted', high: 'accepted' });
  });

  it('a rejected configured level skips the mode steps: nothing could be attributed', async () => {
    const { calls, transport } = recording((req) => {
      if (req.reasoning === 'on') throw http400();
      return stop();
    });
    const record = await runModelTest({ modelId: 'q:4b', scope: 'configured' }, ollamaDeps(transport, { configuredMode: 'json', configuredReasoning: () => 'on' }));
    expect(record.reasoning).toEqual({ on: 'rejected' });
    expect(record.structuredOutput).toEqual({});
    expect(calls.map((c) => c.structuredOutput.mode)).toEqual(['off', 'off']);
  });
});

describe('levels to probe and counts', () => {
  it('configured probes one level; all probes every testable level; the plan counts the level step', () => {
    expect(reasoningLevelsToProbe('configured', { engine: 'local', model: 'q:4b' }, 'on')).toEqual(['on']);
    expect(reasoningLevelsToProbe('all', { engine: 'local', model: 'q:4b' }, 'off')).toEqual(['model-default', 'off', 'on', 'low', 'medium', 'high']);
    expect(plannedReasoningProbeCount(['model-default', 'off', 'on', 'low', 'medium', 'high'], 'off')).toBe(5);
    expect(plannedReasoningProbeCount(['model-default'], 'model-default')).toBe(0);
    const planDeps = {
      configuredMode: 'schema' as const,
      offeredModes: ALL_STRUCTURED_OUTPUT_MODES,
      reasoningSelection: () => ({ engine: 'local' as const, model: 'q:4b' }),
      configuredReasoning: () => 'off' as const,
    };
    expect(plannedTestRequestCount({ modelId: 'q:4b', scope: 'configured' }, planDeps)).toBe(2);
    expect(plannedTestRequestCount({ modelId: 'q:4b', scope: 'all' }, planDeps)).toBe(8);
  });
});

describe('one Ollama model id for Test records (N7)', () => {
  it('a record saved under either tag form answers for the other; an endpoint id is looked up exactly', () => {
    const s = { ...DEFAULT_USER_SETTINGS, analyzerCapabilitiesByModel: { 'qwen3:latest': rec(), 'openai:lab::m': rec() } } as UserSettings;
    expect(capabilityRecordFor(s, 'qwen3', 'http://127.0.0.1:11434')).toEqual(rec());
    expect(capabilityRecordFor(s, 'qwen3:latest', 'http://127.0.0.1:11434')).toEqual(rec());
    expect(capabilityRecordFor(s, 'openai:lab::m:latest', 'http://127.0.0.1:11434')).toBeUndefined();
    expect(capabilityRecordKey('qwen3:latest')).toBe('qwen3');
    expect(capabilityRecordKey('qwen3.5:4b')).toBe('qwen3.5:4b');
    expect(capabilityRecordKey('openai:lab::qwen3:latest')).toBe('openai:lab::qwen3:latest');
  });
});

describe("a refusal cites the verdict's own Test date (A2)", () => {
  it('reads verdictTestedAt for the rejected verdict, and the record date when it has none', () => {
    const dated = rec({
      testedAt: '2026-09-12T09:00:00.000Z',
      reasoning: { on: 'rejected' },
      verdictTestedAt: { reasoning: { on: '2026-09-10T08:00:00.000Z' } },
    });
    expect(verdictTestedAtFor(dated, { setting: 'reasoning', reasoning: 'on' })).toBe('2026-09-10T08:00:00.000Z');
    let thrown: unknown;
    try {
      assertConfiguredCapabilitiesAllowed(dated, { structuredOutput: 'off', reasoning: 'on' }, 'q:4b');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { testedAt: string }).testedAt).toBe('2026-09-10T08:00:00.000Z');
    /* A record written before per-verdict dates existed: its own testedAt stands in. */
    expect(verdictTestedAtFor(rec({ testedAt: '2026-09-12T09:00:00.000Z', reasoning: { on: 'rejected' } }), { setting: 'reasoning', reasoning: 'on' })).toBe(
      '2026-09-12T09:00:00.000Z',
    );
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
```

`server/src/routes/analyzer-models.reasoning.test.ts` goes black-box through W3c's routes. Its real Ollama-shaped server returns 400 on thinking, exactly as Ollama does for a non-thinking model (research 06 §16):
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
/* A2 — the model build /api/tags reports; a test flips it to stand for a re-pulled tag. */
let tagDigest = 'sha256-build-a';

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'w5a-models-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  delete process.env.GEMINI_API_KEY;
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/tags')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      /* A real /api/tags entry carries the build's digest (checked against a live daemon). */
      res.end(
        JSON.stringify({
          models: [
            { name: 'q:4b', model: 'q:4b', digest: tagDigest },
            { name: 'qwen3:latest', model: 'qwen3:latest', digest: tagDigest },
          ],
        }),
      );
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
  tagDigest = 'sha256-build-a';
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
    await settings.writeUserSettings({ analyzerReasoningByEngine: { ollama: { 'q:4b': 'model-default' } } });
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

  it('a configured Test merges its verdicts into the record an earlier all Test wrote for the same server (N14)', async () => {
    settings._setUserSettingsCacheForTest({ ...settings.getCachedUserSettings(), analyzerCapabilitiesByModel: {} });
    await settings.writeUserSettings({ analyzerReasoningByEngine: {} }); // configured level = Ollama's default, off
    expect((await request(app).post('/api/analyzer/models/test').send({ modelId: 'q:4b', scope: 'all' })).status).toBe(200);
    const configured = await request(app).post('/api/analyzer/models/test').send({ modelId: 'q:4b', scope: 'configured' });
    expect(configured.status).toBe(200);
    expect(configured.body.reasoning).toEqual({ off: 'accepted' });
    const stored = (await settings.readUserSettings()).analyzerCapabilitiesByModel['q:4b'];
    expect(stored.reasoning).toEqual({ 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'rejected', medium: 'rejected', high: 'rejected' });
    expect(stored.testedAt).toBe(configured.body.testedAt);
  });

  it('a Test record is saved under the normalised Ollama tag (N7)', async () => {
    settings._setUserSettingsCacheForTest({ ...settings.getCachedUserSettings(), analyzerCapabilitiesByModel: {} });
    const res = await request(app).post('/api/analyzer/models/test').send({ modelId: 'qwen3:latest', scope: 'configured' });
    expect(res.status).toBe(200);
    const records = (await settings.readUserSettings()).analyzerCapabilitiesByModel;
    expect(Object.keys(records)).toEqual(['qwen3']);
  });

  it('a Test whose digest (3c) differs from the stored record replaces it instead of merging, dropping verdicts never probed for the new build (A2)', async () => {
    settings._setUserSettingsCacheForTest({
      ...settings.getCachedUserSettings(),
      analyzerCapabilitiesByModel: {
        'q:4b': {
          serverUrl: ollamaUrl, testedAt: '2026-09-10T10:00:00.000Z', control: { ok: true }, structuredOutput: {},
          reasoning: { on: 'rejected', low: 'rejected' }, digest: 'sha256-build-old',
        },
      },
    });
    await settings.writeUserSettings({ analyzerReasoningByEngine: {} }); // configured level = Ollama's default, off
    const res = await request(app).post('/api/analyzer/models/test').send({ modelId: 'q:4b', scope: 'configured' });
    expect(res.status).toBe(200);
    expect(res.body.digest).toBe('sha256-build-a');
    const stored = (await settings.readUserSettings()).analyzerCapabilitiesByModel['q:4b'];
    /* The re-pulled build keeps no verdict it was never probed for. */
    expect(stored.reasoning).toEqual({ off: 'accepted' });
  });

  it('a record W3c saved under :latest is found, merged into and rewritten under the canonical tag, each verdict keeping its own date (A2, N7)', async () => {
    settings._setUserSettingsCacheForTest({
      ...settings.getCachedUserSettings(),
      analyzerCapabilitiesByModel: {
        'qwen3:latest': {
          serverUrl: ollamaUrl, testedAt: '2026-09-10T10:00:00.000Z', control: { ok: true }, structuredOutput: {},
          reasoning: { on: 'rejected' }, digest: 'sha256-build-a',
        },
      },
    });
    await settings.writeUserSettings({ analyzerReasoningByEngine: {} });
    expect((await request(app).post('/api/analyzer/models/test').send({ modelId: 'qwen3', scope: 'configured' })).status).toBe(200);
    const records = (await settings.readUserSettings()).analyzerCapabilitiesByModel;
    expect(Object.keys(records)).toEqual(['qwen3']);
    expect(records.qwen3.reasoning).toEqual({ on: 'rejected', off: 'accepted' });
    expect(records.qwen3.verdictTestedAt?.reasoning?.on).toBe('2026-09-10T10:00:00.000Z');
  });
});
```

`server/src/analyzer/capability-record-merge.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mergeCapabilityRecords, sameServer } from './capability-record-merge.js';

const record = (over: Record<string, unknown> = {}) => ({
  serverUrl: 'http://127.0.0.1:11434',
  testedAt: '2026-09-11T10:00:00.000Z',
  control: { ok: true as const },
  structuredOutput: {} as Record<string, Record<string, string>>,
  reasoning: {} as Record<string, string>,
  ...over,
});

describe('mergeCapabilityRecords (N14)', () => {
  it('a configured Test keeps the verdicts an earlier all Test recorded, replacing only what it probed', () => {
    const all = record({
      reasoning: { 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'accepted' },
      structuredOutput: { schema: { off: 'enforced', low: 'ignored' }, json: { off: 'accepted' } },
    });
    const configured = record({
      testedAt: '2026-09-12T09:00:00.000Z',
      reasoning: { low: 'rejected' },
      structuredOutput: { schema: { low: 'enforced' } },
    });
    expect(mergeCapabilityRecords(all, configured)).toEqual(
      record({
        testedAt: '2026-09-12T09:00:00.000Z',
        reasoning: { 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'rejected' },
        structuredOutput: { schema: { off: 'enforced', low: 'enforced' }, json: { off: 'accepted' } },
      }),
    );
  });

  it('testedAt is the latest of the two', () => {
    const newer = record({ testedAt: '2026-09-12T09:00:00.000Z' });
    const older = record({ testedAt: '2026-09-11T08:00:00.000Z' });
    expect(mergeCapabilityRecords(newer, older).testedAt).toBe('2026-09-12T09:00:00.000Z');
  });

  it('a record for another server URL is replaced, not merged; with no earlier record the new one is kept as is', () => {
    const elsewhere = record({ serverUrl: 'http://old-host:11434', reasoning: { on: 'rejected' } });
    const next = record({ reasoning: { off: 'accepted' } });
    expect(mergeCapabilityRecords(elsewhere, next)).toBe(next);
    expect(mergeCapabilityRecords(undefined, next)).toBe(next);
  });

  it('a digest that differs replaces the record; the same digest merges (A2)', () => {
    const built = (digest: string | undefined, over: Record<string, unknown> = {}) => record({ digest, ...over });
    const previous = built('sha256-a', { reasoning: { on: 'rejected' } });
    expect(mergeCapabilityRecords(previous, built('sha256-b', { reasoning: { off: 'accepted' } })).reasoning).toEqual({ off: 'accepted' });
    expect(mergeCapabilityRecords(previous, built('sha256-a', { reasoning: { off: 'accepted' } })).reasoning).toEqual({ on: 'rejected', off: 'accepted' });
    /* A digest on one side only (a record written before A2, or a listing that failed) proves nothing. */
    expect(mergeCapabilityRecords(built(undefined, { reasoning: { on: 'rejected' } }), built('sha256-a', { reasoning: { off: 'accepted' } })).reasoning).toEqual({
      off: 'accepted',
    });
    /* Two records with no digest (endpoints, Gemini) merge on the server URL alone, as before. */
    expect(mergeCapabilityRecords(built(undefined, { reasoning: { on: 'rejected' } }), built(undefined, { reasoning: { off: 'accepted' } })).reasoning).toEqual({
      on: 'rejected',
      off: 'accepted',
    });
  });

  it("every kept verdict keeps its own date; one with none takes its record's testedAt (A2)", () => {
    const previous = record({
      testedAt: '2026-09-10T10:00:00.000Z',
      reasoning: { on: 'rejected', low: 'accepted' },
      structuredOutput: { schema: { off: 'enforced' } },
    });
    const next = record({
      testedAt: '2026-09-12T09:00:00.000Z',
      reasoning: { low: 'rejected' },
      structuredOutput: { schema: { low: 'ignored' } },
      verdictTestedAt: { reasoning: { low: '2026-09-12T09:00:00.000Z' }, structuredOutput: { schema: { low: '2026-09-12T09:00:00.000Z' } } },
    });
    expect(mergeCapabilityRecords(previous, next).verdictTestedAt).toEqual({
      reasoning: { on: '2026-09-10T10:00:00.000Z', low: '2026-09-12T09:00:00.000Z' },
      structuredOutput: { schema: { off: '2026-09-10T10:00:00.000Z', low: '2026-09-12T09:00:00.000Z' } },
    });
  });

  it('sameServer ignores trailing slashes only (moved from capabilities.ts, body unchanged)', () => {
    expect(sameServer('http://127.0.0.1:11434/', 'http://127.0.0.1:11434')).toBe(true);
    expect(sameServer('http://127.0.0.1:11434', 'http://127.0.0.1:11435')).toBe(false);
  });
});
```

`server/src/analyzer/preflight.reasoning.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { preflightTargets, runAnalyzerPreflight } from './preflight.js';
import { AnalyzerReasoningUnavailableError } from './errors.js';
import { DEFAULT_USER_SETTINGS, userSettingsSchema, type UserSettings } from '../workspace/user-settings.js';
// Re-pinned to 80be2f1d (#3192, A1): getResolvedOllamaUrl moved to config/ollama-resolved.js.
import { getResolvedOllamaUrl } from '../config/ollama-resolved.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

const settings = (over: Partial<UserSettings>): UserSettings => ({ ...DEFAULT_USER_SETTINGS, ...over });
const thrown = (fn: () => void): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('runAnalyzerPreflight — stored reasoning level no longer offered (#3084 wave 5, P17)', () => {
  it('a Gemini level the table does not offer refuses the run, naming the model, the level and the engine', () => {
    const s = settings({ analyzerReasoningByEngine: { gemini: { 'gemini-3.8-flash': 'minimal' } } });
    const err = thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'gemini-3.8-flash', s), s));
    expect(err).toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(err).toMatchObject({ modelId: 'gemini-3.8-flash', level: 'minimal', engine: 'gemini' });
  });

  it('classifies by the target engine: a bare Ollama default tag with a stale named level is refused (N5)', () => {
    /* A bare tag (no ':') infers as Gemini from its id, but selection builds it as local (e.g. OLLAMA_MODEL=llama2). */
    const s = settings({ analyzerReasoningByEngine: { ollama: { llama2: 'low' } } });
    const err = thrown(() => runAnalyzerPreflight([{ modelId: 'llama2', source: 'env', engine: 'local' }], s));
    expect(err).toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(err).toMatchObject({ modelId: 'llama2', level: 'low', engine: 'local' });
  });

  it('an unknown stored value (xhigh) loads without resetting settings and refuses the run before its first call (N10)', () => {
    const s = settings({ analyzerReasoningByEngine: { gemini: { 'gemini-3.6-flash': 'xhigh' } } });
    expect(userSettingsSchema.safeParse(s).success).toBe(true);
    const err = thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'gemini-3.6-flash', s), s));
    expect(err).toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(err).toMatchObject({ modelId: 'gemini-3.6-flash', level: 'xhigh', engine: 'gemini' });
  });

  it('one Ollama model id (N7): a named level saved under qwen3 passes for runs on qwen3 and qwen3:latest, with the Test record saved under qwen3:latest', () => {
    const s = settings({
      analyzerReasoningByEngine: { ollama: { qwen3: 'low' } },
      analyzerCapabilitiesByModel: {
        'qwen3:latest': { serverUrl: getResolvedOllamaUrl(), testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: {}, reasoning: { low: 'accepted' } },
      },
    });
    expect(() => runAnalyzerPreflight([{ modelId: 'qwen3:latest', source: 'settings', engine: 'local' }], s)).not.toThrow();
    expect(() => runAnalyzerPreflight([{ modelId: 'qwen3', source: 'env', engine: 'local' }], s)).not.toThrow();
  });

  it('an Ollama named level with no accepted Test record refuses; a base level passes', () => {
    const stale = settings({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'qwen3.5:4b', stale), stale))).toBeInstanceOf(
      AnalyzerReasoningUnavailableError,
    );
    const ok = settings({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'on' } } });
    expect(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'qwen3.5:4b', ok), ok)).not.toThrow();
  });

  it('an installed digest that differs from the stored record discards it here too, agreeing with the structured-output check (A3)', () => {
    const stale = settings({
      analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } },
      analyzerCapabilitiesByModel: {
        'qwen3.5:4b': {
          serverUrl: getResolvedOllamaUrl(),
          digest: 'sha256:old',
          testedAt: '2026-09-11T10:00:00.000Z',
          control: { ok: true },
          structuredOutput: {},
          reasoning: { low: 'accepted' },
        },
      },
    });
    const targets = preflightTargets(['phase0'], 'qwen3.5:4b', stale);
    /* The installed model was re-pulled: the record's digest no longer matches. Discarded, so `low` is
       no longer offered — the same discard W3c's structured-output check already applies for this
       reason, so the two checks agree on one run rather than one trusting a record the other drops. */
    expect(thrown(() => runAnalyzerPreflight(targets, stale, new Map([['qwen3.5:4b', 'sha256:new']])))).toBeInstanceOf(
      AnalyzerReasoningUnavailableError,
    );
    /* Same digest: the record is kept. */
    expect(() => runAnalyzerPreflight(targets, stale, new Map([['qwen3.5:4b', 'sha256:old']]))).not.toThrow();
    /* No digest resolved (resolvePreflightDigests came back empty, or wasn't called): fail-open (A3), matching capabilityRecordFor's own rule. */
    expect(() => runAnalyzerPreflight(targets, stale)).not.toThrow();
  });

  it('an endpoint level saved under another control style refuses', () => {
    const endpoint = {
      ...analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'none', contextTokens: 32768 }),
      reasoning: 'high' as const,
    };
    const s = settings({ analyzerEndpoints: [endpoint] });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'openai:lab::m', s), s))).toMatchObject({
      level: 'high',
      engine: 'openai',
    });
  });
});
```

Append to `server/src/analyzer/voice-style.test.ts` (W4 Task 4.5's mocks, `mockSettingsPatch`, `ENDPOINT` and `CHAR`):
```ts
describe('persona generation refuses a stored reasoning level no longer offered (#3084 wave 5, P17)', () => {
  afterEach(() => {
    delete process.env.PERSONA_GEN_ENGINE;
    delete process.env.PERSONA_GEN_LOCAL_MODEL;
    mockSettingsPatch = {};
    vi.restoreAllMocks();
  });

  it('a named Ollama level with no accepted Test record refuses before any call', async () => {
    process.env.PERSONA_GEN_ENGINE = 'local';
    process.env.PERSONA_GEN_LOCAL_MODEL = 'qwen3.5:9b';
    mockSettingsPatch = { analyzerReasoningByEngine: { ollama: { 'qwen3.5:9b': 'low' } } };
    const { OllamaTransport } = await import('./transports/ollama-transport.js');
    const { AnalyzerReasoningUnavailableError } = await import('./errors.js');
    const send = vi.spyOn(OllamaTransport.prototype, 'send');
    const err = await generateVoiceStylePersona(CHAR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(err).toMatchObject({ modelId: 'qwen3.5:9b', level: 'low', engine: 'local' });
    expect(send).not.toHaveBeenCalled();
  });

  it('an endpoint persona whose saved level its control style does not offer refuses before any call', async () => {
    process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
    mockSettingsPatch = { analyzerEndpoints: [ENDPOINT({ reasoning: 'high' })] };
    const { OpenAITransport } = await import('./transports/openai-transport.js');
    const { AnalyzerReasoningUnavailableError } = await import('./errors.js');
    const send = vi.spyOn(OpenAITransport.prototype, 'send');
    await expect(generateVoiceStylePersona(CHAR)).rejects.toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(send).not.toHaveBeenCalled();
  });
});
```

Append to `server/src/routes/cast-design.test.ts`, inside `describe('cast-design persona pre-pass', …)` (W4 Task 4.6's mocks and helpers):
```ts
  it('a stored persona reasoning level no longer offered ends the design job once (#3084 wave 5, P17)', async () => {
    personaSharesGpuMock.mockReturnValue(true);

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: 0 });

    const vs = await import('../analyzer/voice-style.js');
    const { AnalyzerReasoningUnavailableError } = await import('../analyzer/errors.js');
    vi.spyOn(vs, 'generateVoiceStylePersona').mockRejectedValue(
      new AnalyzerReasoningUnavailableError('qwen3.5:9b', 'low', 'local'),
    );

    const qwen = await import('./qwen-voice.js');
    const designSpy = vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({ voiceId: 'qwen-hart', url: '/v/hart.mp3' });

    const extraChar = { id: 'nova', name: 'Nova', role: 'supporting', color: 'blue', voiceUuid: 'nova' };
    writeBookOnDisk([...characters, extraChar]);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['hart', 'nova'] });

    const events = parseSse(res.text);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.some((e) => e.type === 'character_failed')).toBe(false);
    expect(designSpy).not.toHaveBeenCalled();

    writeBookOnDisk(characters);
  });
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/capabilities.reasoning.test.ts src/routes/analyzer-models.reasoning.test.ts src/analyzer/preflight.reasoning.test.ts src/analyzer/voice-style.test.ts src/routes/cast-design.test.ts`
Expected: FAIL.
- `capabilities.reasoning.test.ts`: `does not provide an export named 'probeReasoningLevels'`.
- The preflight, persona and cast-design cases: `… 'AnalyzerReasoningUnavailableError'`.
- The route test: `expected {} to deeply equal { 'model-default': 'accepted', … }`, because W3c returns `reasoning: {}`; and `offeredReasoningLevels` is `undefined`. The N14 case fails on `stored.reasoning` (the configured Test replaced the record), and the N7 record-key case with `expected [ 'qwen3:latest' ] to deeply equal [ 'qwen3' ]`. The digest-replace case's own `res.body.digest` assertion already passes (3c stamps it pre-existing), but it still fails on `expected {} to deeply equal { off: 'accepted' }` (the reasoning ladder this task adds does not exist yet); the `:latest` merge case fails with `expected [ 'qwen3:latest', 'qwen3' ] to deeply equal [ 'qwen3' ]`.
- `capability-record-merge.test.ts`: `Failed to resolve import "./capability-record-merge.js"`. The N7 records case in `capabilities.reasoning.test.ts` fails on the import of `capabilityRecordKey`, and the A2 refusal-date case on the import of `verdictTestedAtFor`.
- `reasoning.test.ts`'s mid-run case (N10) fails on the import of `AnalyzerReasoningUnavailableError`; once that resolves, it fails because `unavailable()` still throws a plain `Error`.

- [ ] **Step 3: Implement**

`capabilities.ts` — imports. Add `AnalyzerReasoningUnavailableError` to W3c's `./errors.js` import, and add these, merging with any import of the same module W3c already has:
```ts
import {
  defaultReasoningLevel,
  offeredReasoningLevels,
  resolveReasoningSetting,
  testableReasoningLevels,
  type ReasoningLevel,
  type ReasoningSelection,
} from './reasoning.js';
import { inferEngineFromModelId, parseEndpointModelId, type AnalysisEngine } from './model-id.js';
// Re-pinned to 80be2f1d (#3192, A1): getResolvedOllamaUrl moved to config/ollama-resolved.js.
import { getResolvedOllamaUrl } from '../config/ollama-resolved.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { entryForModelTag, normalizeModelTag } from './ollama-tag.js';
import { sameServer } from './capability-record-merge.js';
```

`assertConfiguredCapabilitiesAllowed` (W3c Task 3c.3) — A2: its two `AnalyzerCapabilityRejectedError` throws pass `record.testedAt`. Replace that argument with the rejected verdict's own date: `verdictTestedAtFor(record, { setting: 'reasoning', reasoning: configured.reasoning })` in the reasoning branch, and `verdictTestedAtFor(record, { setting: 'structuredOutput', structuredOutput: configured.structuredOutput, reasoning: configured.reasoning })` in the structured-output branch. Nothing else in the function changes.

`capabilityRecordFor` and `sameServer` (W3c Task 3c.3) — delete W3c's private `sameServer` (it moves to the leaf below, body unchanged), and replace `capabilityRecordFor` with the version below, adding `capabilityRecordKey` beside it. **This keeps 3c's fourth parameter, `currentDigest`, and its discard rule (A3) unchanged — this task only widens the lookup itself to N7's `entryForModelTag`; it does not touch what happens once a record is found:**
```ts
/** N7 — the key a Test record is saved under: an Ollama tag through normalizeModelTag, so `qwen3` and
    `qwen3:latest` are one model; any other id (an endpoint id, a Gemini id) as is. */
export function capabilityRecordKey(modelId: string): string {
  return inferEngineFromModelId(modelId) === 'openai' ? modelId : normalizeModelTag(modelId);
}

/** A2 — whether two record keys name the same model, so the write can merge into the record saved under
    the other tag form and leave one key behind (an endpoint id is compared exactly; capabilityRecordKey
    leaves it as is). */
export function sameCapabilityRecordModel(a: string, b: string): boolean {
  return capabilityRecordKey(a) === capabilityRecordKey(b);
}

/** A2 — the date of the Test that recorded one verdict: its own `verdictTestedAt` entry, else the
    record's `testedAt` (a record written before per-verdict dates existed). The pre-run refusal cites
    this, never a newer date a later Test of another verdict brought in. */
export function verdictTestedAtFor(
  record: ModelCapabilityRecord,
  cell:
    | { setting: 'reasoning'; reasoning: string }
    | { setting: 'structuredOutput'; structuredOutput: StructuredOutputMode; reasoning: string },
): string {
  const own =
    cell.setting === 'reasoning'
      ? record.verdictTestedAt?.reasoning?.[cell.reasoning]
      : record.verdictTestedAt?.structuredOutput?.[cell.structuredOutput]?.[cell.reasoning];
  return own ?? record.testedAt;
}

export function capabilityRecordFor(
  settings: UserSettings,
  modelId: string,
  currentServerUrl: string,
  currentDigest?: string,
): ModelCapabilityRecord | undefined {
  /* N7 — an Ollama record saved under either tag form answers for the other; an endpoint id is exact. */
  const stored =
    inferEngineFromModelId(modelId) === 'openai'
      ? settings.analyzerCapabilitiesByModel[modelId]
      : entryForModelTag(settings.analyzerCapabilitiesByModel, modelId);
  if (!stored || !sameServer(stored.serverUrl, currentServerUrl)) return undefined;
  /* 3c (A3), unchanged — a record whose digest differs from the model installed now is discarded, unless
     either digest is unknown: an unknown current digest never invents a discard it cannot see a reason for. */
  if (stored.digest !== undefined && currentDigest !== undefined && stored.digest !== currentDigest) return undefined;
  return stored;
}
```

`server/src/analyzer/capability-record-merge.ts` (new, import-free, so `user-settings.ts` can use it without the `capabilities.ts` ↔ `user-settings.ts` cycle):
```ts
/* #3084 wave 5 (N14, A2) — pure Test-record helpers. Structural types: this module imports nothing. */

interface CapabilityRecordShape {
  serverUrl: string;
  testedAt: string;
  structuredOutput: object;
  reasoning: object;
  /** 3c (A3) — Ollama only: the model build's /api/tags digest when the Test ran. Mirrored here
      structurally, not imported, since this leaf imports nothing. */
  digest?: string;
  /** A2 — each verdict's own Test date, keyed like the verdicts. */
  verdictTestedAt?: { reasoning?: Record<string, string>; structuredOutput?: Record<string, Record<string, string>> };
}

/** Moved from capabilities.ts (W3c), body unchanged: a record belongs to the server it was taken on. */
export function sameServer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** A2 — the dates a record's verdicts carry: its own `verdictTestedAt`, with every verdict it does not
    name (a record written before that field existed) taking the record's own `testedAt`. */
function verdictDates(record: CapabilityRecordShape): {
  reasoning: Record<string, string>;
  structuredOutput: Record<string, Record<string, string>>;
} {
  const reasoning: Record<string, string> = {};
  for (const level of Object.keys(record.reasoning)) {
    reasoning[level] = record.verdictTestedAt?.reasoning?.[level] ?? record.testedAt;
  }
  const structuredOutput: Record<string, Record<string, string>> = {};
  for (const [mode, byLevel] of Object.entries(record.structuredOutput as Record<string, Record<string, string> | undefined>)) {
    structuredOutput[mode] = {};
    for (const level of Object.keys(byLevel ?? {})) {
      structuredOutput[mode][level] = record.verdictTestedAt?.structuredOutput?.[mode]?.[level] ?? record.testedAt;
    }
  }
  return { reasoning, structuredOutput };
}

/** N14 — a Test merges the verdicts it probed into the model's record for the same server URL: only the
    probed `reasoning` levels and `structuredOutput[mode][level]` cells are replaced, `testedAt` is the
    latest, and every kept verdict keeps its own date (A2). A record for another server, or one whose
    `digest` (3c) differs from this Test's (A2 — a re-pulled Ollama build; a digest present on one side
    only proves nothing), or none at all, is replaced by `next` as is. */
export function mergeCapabilityRecords<R extends CapabilityRecordShape>(previous: R | undefined, next: R): R {
  if (!previous || !sameServer(previous.serverUrl, next.serverUrl) || previous.digest !== next.digest) return next;
  const before = previous.structuredOutput as Record<string, Record<string, string> | undefined>;
  const structuredOutput: Record<string, Record<string, string>> = { ...(before as Record<string, Record<string, string>>) };
  for (const [mode, byLevel] of Object.entries(next.structuredOutput as Record<string, Record<string, string>>)) {
    structuredOutput[mode] = { ...(before[mode] ?? {}), ...byLevel };
  }
  const dates = { previous: verdictDates(previous), next: verdictDates(next) };
  const modeDates: Record<string, Record<string, string>> = { ...dates.previous.structuredOutput };
  for (const [mode, byLevel] of Object.entries(dates.next.structuredOutput)) {
    modeDates[mode] = { ...(dates.previous.structuredOutput[mode] ?? {}), ...byLevel };
  }
  return {
    ...next,
    testedAt: Date.parse(previous.testedAt) > Date.parse(next.testedAt) ? previous.testedAt : next.testedAt,
    structuredOutput,
    reasoning: { ...previous.reasoning, ...next.reasoning },
    verdictTestedAt: { reasoning: { ...dates.previous.reasoning, ...dates.next.reasoning }, structuredOutput: modeDates },
  } as R;
}
```

`server/src/workspace/user-settings.ts` — first extend W3c's `modelCapabilityRecordSchema` (Task 3c.3), which already carries `digest: z.string().optional()` (3c A3), or the new field below is stripped on write. After its `digest:` entry add:
```ts
  /* #3084 wave 5 (A2) — each verdict's own Test date, keyed like the verdicts, because a merged record
     carries verdicts from more than one Test. A verdict with no entry takes the record's testedAt. */
  verdictTestedAt: z
    .object({
      reasoning: z.record(z.string(), z.string()).optional(),
      structuredOutput: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    })
    .optional(),
```
Then replace W3c's `writeAnalyzerCapabilityRecord` with the version below, adding `import { mergeCapabilityRecords } from '../analyzer/capability-record-merge.js';` and `import { normalizeModelTag } from '../analyzer/ollama-tag.js';` (the import-free leaf). The read of the earlier record stays inside `mutateUserSettings`, so a merge never races another write:
```ts
/** #3084 — persist one Test-action record, merging the verdicts this Test probed into the model's earlier
    record for the same server and the same model build (N14, A2; mergeCapabilityRecords). Goes through
    mutateUserSettings so it serialises with endpoint and key writes. Only a completed test calls it: a
    failed control or an inconclusive step writes nothing, so the previous record stays (P7). Callers pass
    capabilityRecordKey(modelId) (N7) and `sameModel`, which accepts every saved key naming this same
    model — an Ollama tag in its other form (`qwen3` / `qwen3:latest`), an endpoint id exactly. Those keys
    are merged into and then removed, so one model keeps one record, under the canonical key. */
export async function writeAnalyzerCapabilityRecord(
  modelId: string,
  record: z.infer<typeof modelCapabilityRecordSchema>,
  sameModel: (savedKey: string) => boolean = (savedKey) => normalizeModelTag(savedKey) === normalizeModelTag(modelId),
): Promise<UserSettings> {
  const validated = modelCapabilityRecordSchema.parse(record);
  return mutateUserSettings((current) => {
    const stored = current.analyzerCapabilitiesByModel;
    const alias = Object.keys(stored).find((key) => key !== modelId && sameModel(key));
    const previous = stored[modelId] ?? (alias !== undefined ? stored[alias] : undefined);
    const kept = Object.fromEntries(Object.entries(stored).filter(([key]) => key !== modelId && !sameModel(key)));
    return { analyzerCapabilitiesByModel: { ...kept, [modelId]: mergeCapabilityRecords(previous, validated) } };
  });
}
```

`server/src/routes/analyzer-models.ts` (W3c Task 3c.6, `POST /models/test`) — replace `await writeAnalyzerCapabilityRecord(modelId, record);` with `await writeAnalyzerCapabilityRecord(capabilityRecordKey(modelId), record, (savedKey) => sameCapabilityRecordModel(savedKey, modelId));`, adding `capabilityRecordKey` and `sameCapabilityRecordModel` to its `../analyzer/capabilities.js` import. The response still returns the probed `record`.

`openapi.yaml` — W3c Task 3c.6's `components.schemas.ModelCapabilityRecord` already has a `digest` property (3c, A3); this task adds, under `properties` (not `required`):
```yaml
        verdictTestedAt:
          type: object
          properties:
            reasoning:
              type: object
              additionalProperties:
                type: string
                format: date-time
            structuredOutput:
              type: object
              additionalProperties:
                type: object
                additionalProperties:
                  type: string
                  format: date-time
          description: '#3084 — each verdict''s own Test date, keyed like the verdicts. A verdict with no entry was recorded by the Test the record''s testedAt names.'
```
Then run `npm run openapi:types`.

`defaultReasoningKey` — delete the function and its doc comment (W3c Task 3c.3). Its uses go in the `runModelTest`, `toEntry` and preflight edits below.

`isHttp400` — rename W3c's private function to the exported `isProbeRejected` (same body) and change its call in `modeStep`. Do not add a second copy:
```ts
/** A probe is `rejected` only on a 400 (AnalyzerHttpError from Ollama/OpenAI, or
    the Gemini SDK's ApiError status 400). */
export function isProbeRejected(err: unknown): boolean {
  if (err instanceof AnalyzerHttpError) return err.httpStatus === 400;
  return (err as { status?: unknown } | null)?.status === 400; // @google/genai ApiError
}
```

Directly below W3c's `ModelTestInconclusiveError` (a class must be declared before it is extended):
```ts
/** P7 — an inconclusive LEVEL step. It runs in `off` mode, but its copy names the level, never "The off check". */
export class ReasoningLevelTestInconclusiveError extends ModelTestInconclusiveError {
  constructor(
    modelId: string,
    readonly level: ReasoningLevel,
    detail: string,
  ) {
    super(modelId, 'off', detail);
    this.message = `The reasoning level "${level}" check for ${modelId} was inconclusive (${detail}). Nothing was recorded; any earlier test result is kept. Run the test again.`;
    this.name = 'ReasoningLevelTestInconclusiveError';
  }
}
```

Below `modeStep`, add:
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

/** The level step (spec §2, P7): `send(level)` sends the control request with only `reasoning`
    changed (runModelTest passes `sendStep(deps, { mode: 'off' }, cap, level)`). It proves
    acceptance only, and classifies failures exactly as W3c's modeStep does. */
export async function probeReasoningLevels(
  levels: readonly ReasoningLevel[],
  deps: {
    modelId: string;
    controlLevel: ReasoningLevel;
    send: (level: ReasoningLevel) => Promise<TransportResult>;
    redact?: (text: string) => string;
  },
): Promise<Partial<Record<ReasoningLevel, 'accepted' | 'rejected'>>> {
  const redact = deps.redact ?? ((t: string) => t);
  const out: Partial<Record<ReasoningLevel, 'accepted' | 'rejected'>> = {};
  for (const level of levels) {
    if (level === deps.controlLevel) {
      out[level] = 'accepted'; // the control request already ran at this level
      continue;
    }
    try {
      await deps.send(level);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      /* P20 — a GeminiContentBlockedError and an AnalyzerReasoningOverflowError are handled alike here,
         as W3c's modeStep handles them: inconclusive, below. A transport returns `blocked` / `length` as a
         finish (only the runner's mapFinish raises either error), and a Test is not a run to stop. */
      if (isProbeRejected(err)) {
        if (!namesContextOrTokenLimit(providerText(err))) {
          out[level] = 'rejected';
          continue;
        }
        /* P7: a 400 naming a context, token or length limit is about the request size, not the level. */
        throw new ReasoningLevelTestInconclusiveError(deps.modelId, level, 'the provider refused the request size, not the level');
      }
      /* P7: a 5xx after the transport's retries, a timeout or an unreachable server proves nothing about
         the level. Inconclusive: nothing is recorded and the route answers 502. */
      throw new ReasoningLevelTestInconclusiveError(deps.modelId, level, redact(err instanceof Error ? err.message : String(err)).slice(0, 300));
    }
    /* P7: the provider accepted the request. Any finish counts, `length` and `blocked` included:
       a thinking model spends the cap reasoning, which is the shape a level step expects. */
    out[level] = 'accepted';
  }
  return out;
}
```

`ModelTestDeps` — add two fields directly after W3c's `probeLimits` (3c already added `modelDigest?` beside it; this task does not touch that field):
```ts
  /** #3084 wave 5 — engine, bare model, endpoint and Test record for the id (reasoning.ts shape). */
  reasoningSelection: (modelId: string) => ReasoningSelection;
  /** #3084 wave 5 — the level the next run of this model would send (resolveReasoningSetting). */
  configuredReasoning: (modelId: string) => ReasoningLevel;
```

`sendStep` — W3c's `sendStep(deps, format, maxOutputTokens)` gains a fourth parameter, `reasoning: ReasoningLevel`, and its `transport.send({ … })` literal gains `reasoning,` directly after `signal: deps.signal,`. `modeStep` gains a `level: ReasoningLevel` parameter directly after `cap`, and passes it as `sendStep`'s fourth argument. Its stop rule and its size-limit handling stay: a mode step is the only ladder step that treats a `length` / `blocked` finish as inconclusive.

`runModelTest` — three edits to W3c's function; everything else in it stays:
1. Replace `/* P7: a record is keyed by the level its requests actually sent. */` and `const level = defaultReasoningKey(deps.transport.kind);` with:
```ts
  /* P7: the control runs at the engine's default level; the level step and the mode steps at the
     configured level. Every record is keyed by the level its requests actually sent. */
  const sel = deps.reasoningSelection(input.modelId);
  const controlLevel = defaultReasoningLevel(sel.engine);
  const configuredLevel = deps.configuredReasoning(input.modelId);
```
2. In step 1, `await sendStep(deps, control, cap);` becomes `await sendStep(deps, control, cap, controlLevel);`.
3. Replace the `/* Step 2 — WAVE 5 (Task 5a) INSERTS THE LEVEL STEP HERE: … */` comment, the step-3 loop and the `return` with:
```ts
  /* Step 2 — the level step (P7): `off` mode, differing from the control only in `reasoning`. */
  const reasoning = await probeReasoningLevels(reasoningLevelsToProbe(input.scope, sel, configuredLevel), {
    modelId: input.modelId,
    controlLevel,
    redact,
    send: (level) => sendStep(deps, control, cap, level),
  });

  /* Step 3 — one mode step per tested mode, at the configured level. An `off` step is the level
     step (or the control), already sent. A rejected configured level leaves nothing to attribute. */
  const structuredOutput: ModelCapabilityRecord['structuredOutput'] = {};
  if (reasoning[configuredLevel] !== 'rejected') {
    for (const mode of modes) {
      const format = stepFormats.get(mode);
      structuredOutput[mode] = {
        [configuredLevel]:
          format && mode !== 'off' ? await modeStep(input.modelId, mode, format, marker, cap, configuredLevel, deps, redact) : 'accepted',
      };
    }
  }
  /* 3c (A3) already computes `digest` from `deps.modelDigest` here; kept as is below only because this
     task replaces the whole return statement. This task's own addition is `verdictTestedAt`, each
     verdict's own date, so a later merge can keep a verdict without claiming this Test measured it. */
  const digest = await deps.modelDigest?.().catch(() => undefined);
  const verdictTestedAt = {
    reasoning: Object.fromEntries(Object.keys(reasoning).map((level) => [level, testedAt])),
    structuredOutput: Object.fromEntries(
      Object.entries(structuredOutput).map(([mode, byLevel]) => [mode, Object.fromEntries(Object.keys(byLevel ?? {}).map((level) => [level, testedAt]))]),
    ),
  };
  return {
    serverUrl: deps.serverUrl,
    testedAt,
    control: { ok: true },
    structuredOutput,
    reasoning,
    ...(digest !== undefined ? { digest } : {}),
    verdictTestedAt,
  };
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
  /* P7 ladder: the control; the level step's requests (every level other than the control's); one
     mode step per `schema` / `json` mode. A rejected configured level skips the mode steps, so this
     is the upper bound the confirmation shows. */
  return 1 + plannedReasoningProbeCount(levels, defaultReasoningLevel(sel.engine)) + modes.filter((mode) => mode !== 'off').length;
}
```

Selection helpers — add to `capabilities.ts`:
```ts
/** Engine, bare model, saved endpoint and Test record for a model id. `engine` defaults to the id
    inference; persona generation passes it, because a bare local tag (`llama2`) infers as Gemini.
    `currentDigest` (A3) is the local engine's installed-model digest, threaded to `capabilityRecordFor`
    exactly as W3c's own structured-output check already threads it, so the two checks discard the same
    stale record instead of disagreeing about which one applies. Only `runAnalyzerPreflight` has a digest
    to pass — it already resolved one per target before either check runs. Every other caller
    (`modelTestDepsFor`, the catalog's `toEntry`, persona generation) omits it, which is `capabilityRecordFor`'s
    own fail-open rule (kept when either digest is unknown), unchanged from 3c. Gemini and endpoints carry
    no digest, so `currentDigest` is passed to `capabilityRecordFor` only when `engine === 'local'`. */
export function reasoningSelectionFor(
  settings: UserSettings,
  modelId: string,
  engine: AnalysisEngine = inferEngineFromModelId(modelId),
  currentDigest?: string,
): ReasoningSelection & { endpoint?: AnalyzerEndpoint } {
  if (engine !== 'openai') {
    return {
      engine,
      model: modelId,
      record: capabilityRecordFor(
        settings,
        modelId,
        engine === 'local' ? getResolvedOllamaUrl() : 'gemini',
        engine === 'local' ? currentDigest : undefined,
      ),
    };
  }
  const parsed = parseEndpointModelId(modelId);
  const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
  return { engine, model: parsed?.model ?? modelId, endpoint, record: endpoint ? capabilityRecordFor(settings, modelId, endpoint.baseUrl) : undefined };
}

/** The reasoning level the next run of this model would send. `currentDigest` passes through to
    `reasoningSelectionFor` (A3); every existing caller omits it, so this adds no new argument at any
    call site until Task 5.4's `runAnalyzerPreflight` change below needs one. */
export function configuredReasoningFor(
  settings: UserSettings,
  modelId: string,
  engine: AnalysisEngine = inferEngineFromModelId(modelId),
  currentDigest?: string,
): ReasoningLevel {
  const sel = reasoningSelectionFor(settings, modelId, engine, currentDigest);
  return resolveReasoningSetting(settings, { engine: sel.engine, model: sel.model, endpoint: sel.endpoint });
}

/** P17 — the level the next run sends, refused before the first call when the current rules no
    longer offer it for this model (Gemini table, Ollama Test record, endpoint control style).
    `currentDigest` (A3) is the one pre-run caller's (`runAnalyzerPreflight`'s) way of keeping this
    check's Ollama record in step with the structured-output check's: both must discard a record
    stamped for a build the daemon no longer serves. Persona generation calls this with no digest and
    keeps today's fail-open behaviour, unchanged by this task. */
export function assertConfiguredReasoningOffered(
  settings: UserSettings,
  modelId: string,
  engine: AnalysisEngine = inferEngineFromModelId(modelId),
  currentDigest?: string,
): ReasoningLevel {
  const sel = reasoningSelectionFor(settings, modelId, engine, currentDigest);
  const level = resolveReasoningSetting(settings, { engine: sel.engine, model: sel.model, endpoint: sel.endpoint });
  /* N10: an unknown stored value (e.g. `xhigh`) is never offered, so it is refused here too. */
  if (!offeredReasoningLevels(sel).includes(level)) throw new AnalyzerReasoningUnavailableError(modelId, level, sel.engine);
  return level;
}
```

`model-test-deps.ts` (`modelTestDepsFor`, W3c Task 3c.6) — replace `const offered = { offeredModes: ALL_STRUCTURED_OUTPUT_MODES, redact };` with the block below, keeping `redact`, and add `configuredReasoningFor, reasoningSelectionFor` to its `./capabilities.js` import. Each of its three returned objects spreads `offered`, so all three gain the fields. `routes/analyzer-models.ts` needs no change.
```ts
  const offered = {
    offeredModes: ALL_STRUCTURED_OUTPUT_MODES,
    redact,
    reasoningSelection: (id: string) => reasoningSelectionFor(settings, id),
    configuredReasoning: (id: string) => configuredReasoningFor(settings, id),
  };
```
3c already wires `modelDigest: () => ollamaModelDigest(url, modelId)` into this function's Ollama branch, importing `ollamaModelDigest` from `./ollama-digest.js` — this task does not touch that wiring.

`catalog/analyzer-catalog.ts` (W3c Task 3c.5) — 3c's `listOllamaTags` already returns each tag's `digest` alongside its name (via the leaf `ollama-digest.ts`); this task adds no second `/api/tags` reader on top of it.

`catalog/analyzer-catalog.ts` (W3c Task 3c.5):
- **ctx.** `toEntry`'s `ctx` parameter type gains `endpoint?: AnalyzerEndpoint`, and `endpointGroup` passes `endpoint` in its `toEntry` ctx literal.
- **Locals.** In `toEntry`, replace these three lines with the block below:
  - `const planDeps = { ...OFFERED, configuredMode: ctx.mode };`
  - `/* P7: label from the record filed under the level a run of this model sends. */`
  - `const level = defaultReasoningKey(ctx.kind === 'endpoint' ? 'openai' : ctx.kind);`
```ts
  const sel = { engine: ctx.engine, model: raw.model, endpoint: ctx.endpoint, record: capability };
  /* P7: label from the record filed under the level a run of this model sends. */
  const level = resolveReasoningSetting(ctx.settings, sel);
  const planDeps = {
    configuredMode: ctx.mode,
    offeredModes: ALL_STRUCTURED_OUTPUT_MODES,
    reasoningSelection: () => sel,
    configuredReasoning: () => level,
  };
```
- **Return object.** Add `offeredReasoningLevels: offeredReasoningLevels(sel),`. The label call and both `testPlan` counts keep their W3c text; they now read the configured `level` and the reasoning-aware `planDeps`.
- **Clean-up.** Delete the now-unused `OFFERED` constant and the `defaultReasoningKey` import. Import `offeredReasoningLevels, resolveReasoningSetting` from `../reasoning.js`.

`preflight.ts` (`runAnalyzerPreflight`, W3c Task 3c.10) — its three `assertConfiguredCapabilitiesAllowed(` calls pass `reasoning: defaultReasoningKey('openai')`, `defaultReasoningKey('gemini')` and `defaultReasoningKey('ollama')`. Replace the openai and Gemini calls with `reasoning: assertConfiguredReasoningOffered(settings, target.modelId, target.engine)`, using the `settings` and `target` already in scope; neither branch has a digest, matching its own `capabilityRecordFor` call two lines above (endpoints and Gemini carry none). Replace the Ollama call with `reasoning: assertConfiguredReasoningOffered(settings, target.modelId, target.engine, digests?.get(target.modelId))` — `digests` is W3c's own third parameter, already in scope in this function and already read the same way by its neighbouring `capabilityRecordFor(settings, target.modelId, getResolvedOllamaUrl(), digests?.get(target.modelId))` call (A3): without this fourth argument, a record W3c's structured-output check discards for a re-pulled model would still be trusted by this reasoning check on the very same run. `target.engine` is the engine selection builds (N5): without it a bare Ollama tag such as `llama2` would infer as Gemini and resolve Gemini's level. In its `./capabilities.js` import, replace `defaultReasoningKey` with `assertConfiguredReasoningOffered`. The call returns the level the run sends, and first throws `AnalyzerReasoningUnavailableError` when that level is no longer offered (P17).

`errors.ts` — append:
```ts
/** #3084 wave 5 (P17) — a stored reasoning level the current rules no longer offer for this model
    (a Gemini table change, an Ollama named level without its accepted Test record, an endpoint level
    saved under another control style), or a stored value this version does not know (N10). Normally
    thrown before the run's first call; `reasoningWireFragment` throws it with `when: 'mid-run'` for a
    value that reached a call anyway (a hand-edited file), so that throw is coded too. Task 5.5 maps it
    to `analyzer-request-rejected`, and `engine` names where the setting lives. `level` and `when` are
    plain strings and `engine` spells out AnalysisEngine, so errors.ts imports nothing. */
export class AnalyzerReasoningUnavailableError extends Error {
  constructor(
    readonly modelId: string,
    readonly level: string,
    readonly engine: 'local' | 'gemini' | 'openai',
    readonly when: 'before-start' | 'mid-run' = 'before-start',
  ) {
    super(`Reasoning level "${level}" is not offered for ${modelId}.`);
    this.name = 'AnalyzerReasoningUnavailableError';
  }
}
```

`reasoning.ts` (Task 5.1) — N10: replace `unavailable`'s body so the last-resort guard throws the coded class instead of a plain `Error`, and change its return type to that class:
```ts
/* N10 — the guard `reasoningWireFragment` falls back on. A level only reaches it when a value slipped
   past every save rule AND the pre-run check (a hand-edited user-settings.json), so it is reported as
   the same coded refusal, marked `mid-run`: the failure taxonomy then names the setting instead of
   surfacing an uncoded throw from inside a request. `modelId` is the model the transport holds (for an
   endpoint, its bare model name). */
function unavailable(kind: TransportKind, model: string, level: ReasoningLevel): AnalyzerReasoningUnavailableError {
  return new AnalyzerReasoningUnavailableError(model, level, kind === 'ollama' ? 'local' : kind, 'mid-run');
}
```
Change its `./errors.js` import from a type-only import to one that also imports the class value. `errors.ts` imports nothing, so `analyzer-endpoints.ts` → `reasoning.ts` still closes no cycle (Task 5.2's cycle note); Step 4's `check:cycles` confirms it.

In Task 5.1's `server/src/analyzer/reasoning.test.ts`, the five `toThrow(/"<level>" is not available/)` assertions (three in `refuses a level the model does not offer instead of downgrading it`, one in `wire fragments`, one in `not_controllable refuses anything but model-default`) become `toThrow(AnalyzerReasoningUnavailableError)`, importing the class from `./errors.js`. Append this case:
```ts
describe('a level that reaches a call anyway is coded, not a bare Error (N10)', () => {
  it('reasoningWireFragment throws AnalyzerReasoningUnavailableError marked mid-run, with the engine of its transport', () => {
    const err = (() => {
      try {
        reasoningWireFragment('ollama', { model: 'q:4b' }, 'xhigh' as ReasoningLevel);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(err).toMatchObject({ modelId: 'q:4b', level: 'xhigh', engine: 'local', when: 'mid-run' });
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-2.5-pro' }, 'off')).toThrow(
      expect.objectContaining({ engine: 'gemini', when: 'mid-run' }),
    );
  });
});
```

Persona — `server/src/analyzer/voice-style.ts` (W4 Task 4.5):
- add `import { assertConfiguredReasoningOffered } from './capabilities.js';`;
- add `endpointModelId` to the `./model-id.js` import;
- in `generateVoiceStylePersona`, directly after `const runner = personaRunner(selection);`, add:
```ts
  /* P17 — refuse a stored reasoning level the rules no longer offer, before the prompt is built or any
     request exists (after personaRunner, so a missing endpoint or a foreign key reports first). */
  assertConfiguredReasoningOffered(
    getCachedUserSettings(),
    selection.engine === 'openai' ? endpointModelId(selection.endpointId, selection.model) : selection.model,
    selection.engine,
  );
```
`voice-style.ts` → `capabilities.ts` is a new import edge; Step 4's `npm run check:cycles` covers it.

Design pre-pass — in `server/src/routes/cast-design.ts`, `runPersonaPrePass`'s rethrow condition (W4 Task 4.6) gains `err instanceof AnalyzerReasoningUnavailableError ||`, imported from `../analyzer/errors.js`. Every character would be refused identically, so the job ends once.

Updates to W3c's tests (the behaviour this task changes):
- **`capabilities.run-model-test.test.ts`.** Its `deps(transport, over)` helper gains two entries: `reasoningSelection: () => ({ engine: 'openai', model: 'm', endpoint: { id: 'lab', name: 'Lab', reasoningStyle: 'not_controllable' } }),` and `configuredReasoning: () => 'model-default',`.
  - `not_controllable` offers only `model-default`, which is the control's level. So no level request is added, and every request count and record in the file stays as written.
  - A case whose transport `kind` is `'ollama'` passes `reasoningSelection: () => ({ engine: 'local', model: 'm' })` and `configuredReasoning: () => 'off'` in `over`, which keeps its `off` key.
- **`capabilities.test.ts`.**
  - In `describe('plannedTestRequestCount')`, its `deps` gains `reasoningSelection: () => ({ engine: 'openai' as const, model: 'm', endpoint: { id: 'lab', name: 'Lab', reasoningStyle: 'not_controllable' as const } })` and `configuredReasoning: () => 'model-default' as const`. Its expectations (2, 3 and the `off` case's 1) stay; the Ollama count is pinned in `capabilities.reasoning.test.ts`.
  - Delete `describe('defaultReasoningKey …')` and `defaultReasoningKey` from its import. `reasoning.test.ts`'s `defaults preserve today` pins the same values on `defaultReasoningLevel`.
- **`model-test-deps.test.ts`.** In its endpoint case, add `expect(d.configuredReasoning('openai:lab::qwen3-30b')).toBe('model-default');` and `expect(d.reasoningSelection('openai:lab::qwen3-30b')).toMatchObject({ engine: 'openai', model: 'qwen3-30b', endpoint: { id: 'lab' } });`.
- **`catalog/analyzer-catalog.test.ts`.** In its endpoint-group case (the `lab` endpoint fixture, `not_controllable` by default), add `expect(entry.offeredReasoningLevels).toEqual(['model-default']);`. The route test above pins the Ollama shape. Its Ollama-group cases stub `listOllamaTags` through `CatalogDeps`, whose signature is unchanged, so they stay green.
- **`analyzer-models.test.ts`.** It mocks `writeAnalyzerCapabilityRecord` and asserts `toHaveBeenCalledWith('openai:lab::m', RECORD)`; the route now passes a third argument, so that becomes `toHaveBeenCalledWith('openai:lab::m', RECORD, expect.any(Function))`.

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/analyzer/capabilities.reasoning.test.ts src/analyzer/capability-record-merge.test.ts src/routes/analyzer-models.reasoning.test.ts src/analyzer/preflight.reasoning.test.ts src/analyzer/reasoning.test.ts src/analyzer/voice-style.test.ts src/routes/cast-design.test.ts src/analyzer/capabilities.test.ts src/analyzer/capabilities.run-model-test.test.ts src/analyzer/model-test-deps.test.ts src/analyzer/catalog/analyzer-catalog.test.ts src/routes/analyzer-models.test.ts src/analyzer/preflight.test.ts src/workspace/user-settings.test.ts`, then `npm run openapi:types` and `git diff --exit-code src/lib/api-types.ts` (commit the regenerated file with this task). `capabilityRecordKey` leaves an endpoint id as is, so the route's key is unchanged; only its third argument is new (see the test updates above). Then run `npm run typecheck`, `npm run check:cycles` and `git grep -n defaultReasoningKey -- server/src src`.
Expected: PASS, and the grep finds nothing. Keeps green:
- W3c's `analyzer-models.test.ts` (it mocks `runModelTest` and `modelTestDepsFor`);
- `preflight.test.ts` (its settings store no reasoning level, so every target resolves its engine default, which is always offered and is the key W3c filed under).

- [ ] **Step 5: Mutation proof**
1. In `probeReasoningLevels` replace `if (!namesContextOrTokenLimit(providerText(err))) { … }` with `out[level] = 'rejected'; continue;`. Expected red: `a 400 naming a context or token limit is inconclusive, with copy that names the level`. Restore.
2. In `probeReasoningLevels` replace `await deps.send(level);` with `const r = await deps.send(level); if (r.finish !== 'stop') throw new ReasoningLevelTestInconclusiveError(deps.modelId, level, 'finish=' + r.finish);`. Expected red: `a thinking model that hits length on a level probe records the level accepted (acceptance only)` and `scope all on a thinking model: every level probe that stops with length is recorded accepted`. Restore.
3. In `probeReasoningLevels` replace the final `throw new ReasoningLevelTestInconclusiveError(… redact(…) …)` with `out[level] = 'rejected'; continue;`. Expected red: `a non-400 failure is inconclusive with the level named, never recorded`. Restore.
4. In `ReasoningLevelTestInconclusiveError` delete the `this.message = …` line. Expected red: `a 400 naming a context or token limit is inconclusive…` (the message reads "The off check…"). Restore.
5. In `runModelTest`'s level step replace `sendStep(deps, control, cap, level)` with `sendStep(deps, { mode: 'json' }, cap, level)`. Expected red: `the level step is the control request with only reasoning changed…`. Restore.
6. In `runModelTest` pass `controlLevel` instead of `configuredLevel` to `modeStep`. Expected red: `the level step is the control request with only reasoning changed; mode steps run at the configured level`. Restore.
7. In `runModelTest` drop the `if (reasoning[configuredLevel] !== 'rejected')` guard (keep its loop). Expected red: `a rejected configured level skips the mode steps…`. Restore.
8. In `runModelTest` move the level step above step 1. Expected red: `scope all records named levels rejected … only after a successful control` (the first think value is no longer `false`). Restore.
9. In `plannedTestRequestCount` drop the `plannedReasoningProbeCount(…)` term. Expected red: `configured probes one level; all probes every testable level; the plan counts the level step` (3, not 8) and `the level step is the control request…` (`toHaveLength`). Restore.
10. In `toEntry` replace `offeredReasoningLevels(sel)` with `offeredReasoningLevels({ engine: ctx.engine, model: raw.model })`. Expected red: `the catalog offers named Ollama levels only after a Test accepted them`. Restore.
11. In `assertConfiguredReasoningOffered` delete the `throw`. Expected red: every refusal case in `runAnalyzerPreflight — stored reasoning level no longer offered…` (the Gemini, Ollama, endpoint, N5 and N10 cases) and both persona refusal cases. Restore.
12. In `runAnalyzerPreflight`'s Gemini branch replace `assertConfiguredReasoningOffered(settings, target.modelId, target.engine)` with `defaultReasoningLevel('gemini')`. Expected red: `a Gemini level the table does not offer refuses the run, naming the model, the level and the engine`. Restore.
13. In `generateVoiceStylePersona` delete the `assertConfiguredReasoningOffered(…)` statement. Expected red: `a named Ollama level with no accepted Test record refuses before any call` (`send` called). Restore.
14. In `runPersonaPrePass` delete the `AnalyzerReasoningUnavailableError` alternative. Expected red: `a stored persona reasoning level no longer offered ends the design job once` (`character_failed` present). Restore.
15. In `probeReasoningLevels` add `if (err instanceof AnalyzerReasoningOverflowError) throw err;` directly after the abort rethrow (an overflow handled differently from a content block). Expected red: `a content block and a reasoning overflow from a probe are handled alike: inconclusive, nothing recorded (P20)`. Restore.
16. In `runAnalyzerPreflight`'s Ollama branch replace `target.engine` with `undefined` (`assertConfiguredReasoningOffered(settings, target.modelId, undefined, digests?.get(target.modelId))`). Expected red: `classifies by the target engine: a bare Ollama default tag with a stale named level is refused (N5)` (no throw: `llama2` infers as Gemini). Restore.
17. In `capabilityRecordFor` replace the `stored` ternary with `settings.analyzerCapabilitiesByModel[modelId]`. Expected red: `a record saved under either tag form answers for the other…` and `one Ollama model id (N7): a named level saved under qwen3 passes…` (the `qwen3` run is refused). Restore.
18. In `writeAnalyzerCapabilityRecord` store `validated` instead of `mergeCapabilityRecords(…)`. Expected red: `a configured Test merges its verdicts into the record an earlier all Test wrote for the same server (N14)`. Restore.
19. In `mergeCapabilityRecords` replace `reasoning: { ...previous.reasoning, ...next.reasoning }` with `reasoning: next.reasoning`. Expected red: `a configured Test keeps the verdicts an earlier all Test recorded…`. Restore. Then replace the `testedAt` ternary with `next.testedAt`. Expected red: `testedAt is the latest of the two`. Restore.
20. In `POST /models/test` write under `modelId` instead of `capabilityRecordKey(modelId)`. Expected red: `a Test record is saved under the normalised Ollama tag (N7)`. Restore.
21. In `mergeCapabilityRecords` drop `|| previous.digest !== next.digest`. Expected red: `a digest that differs replaces the record; the same digest merges (A2)` and `a Test whose digest (3c) differs from the stored record replaces it instead of merging, dropping verdicts never probed for the new build (A2)` (the old verdicts survive). Restore. (Digest itself — the `deps.modelDigest` call in `runModelTest` and the field in `modelTestDepsFor`'s Ollama branch — is 3c's own code and 3c's own mutation proof; this task's proof starts here, at the merge that reads it.)
22. In `writeAnalyzerCapabilityRecord` replace the `alias` / `kept` lookup with W3c's `current.analyzerCapabilitiesByModel[modelId]` and `{ ...current.analyzerCapabilitiesByModel }`. Expected red: `a record W3c saved under :latest is found, merged into and rewritten under the canonical tag… (A2, N7)` (two keys, and `on` is gone). Restore.
23. In `runModelTest` drop the `verdictTestedAt` entry. Expected red: the same `:latest` case (`verdictTestedAt?.reasoning?.on` is `undefined`). Then restore it and, in `verdictDates`, replace `?? record.testedAt` with `?? ''`. Expected red: `every kept verdict keeps its own date…`. Restore.
24. In `assertConfiguredCapabilitiesAllowed` pass `record.testedAt` again in the reasoning branch. Expected red: `reads verdictTestedAt for the rejected verdict, and the record date when it has none`. Restore.
25. In `reasoning.ts` make `unavailable` return a plain `new Error(...)` again. Expected red: `reasoningWireFragment throws AnalyzerReasoningUnavailableError marked mid-run…`. Then restore and pass no fourth argument to the constructor. Expected red: the same case (`when` is `before-start`). Restore.
26. In `runAnalyzerPreflight`'s Ollama branch drop the `digests?.get(target.modelId)` argument (`assertConfiguredReasoningOffered(settings, target.modelId, target.engine)`). Expected red: `an installed digest that differs from the stored record discards it here too, agreeing with the structured-output check (A3)` (the stale record is kept: no throw where one is expected). Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/capability-record-merge.ts server/src/analyzer/capability-record-merge.test.ts server/src/analyzer/reasoning.ts server/src/analyzer/reasoning.test.ts openapi.yaml src/lib/api-types.ts server/src/workspace/user-settings.ts server/src/routes/analyzer-models.ts server/src/analyzer/capabilities.ts server/src/analyzer/capabilities.reasoning.test.ts server/src/analyzer/capabilities.test.ts server/src/analyzer/capabilities.run-model-test.test.ts server/src/analyzer/model-test-deps.ts server/src/analyzer/model-test-deps.test.ts server/src/analyzer/catalog/analyzer-catalog.ts server/src/analyzer/catalog/analyzer-catalog.test.ts server/src/analyzer/preflight.ts server/src/routes/analyzer-models.reasoning.test.ts server/src/analyzer/preflight.reasoning.test.ts server/src/analyzer/errors.ts server/src/analyzer/voice-style.ts server/src/analyzer/voice-style.test.ts server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts
git commit -m "feat(server): Test action level step, and pre-run refusal of a rejected or stale reasoning level"
```

### Task 5.5: Failure copy names the actual reasoning control

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts` — W2's `AnalyzerReasoningOverflowError` branch in `classifyAnalysisFailure` (`:492` onward at `80be2f1d` — `failure-taxonomy.ts` is unchanged across `2b63b451..80be2f1d` (re-pinned from `46e62a34`, verified with no further diff to `80be2f1d`); W2 inserted it next to the `AnalyzerTruncatedError` branch at `:526-534`), and, only if Step 2 shows it red, W3's `AnalyzerCapabilityRejectedError` branch
- Modify: `server/src/routes/failure-taxonomy.ts` — a branch for Task 5.4's `AnalyzerReasoningUnavailableError` (P17)
- Test: `server/src/routes/failure-taxonomy.reasoning.test.ts`

**Interfaces:**
- Consumes: Task 5.1 `reasoningControlDescription`; `parseEndpointModelId` (W3); `getCachedUserSettings`, `_setUserSettingsCacheForTest`; `AnalyzerReasoningOverflowError(transport, model, reasoningTokens)` (W2); `AnalyzerCapabilityRejectedError` (W3).
- Produces: copy, and the `AnalyzerReasoningUnavailableError` → `analyzer-request-rejected` mapping (Task 5.4). No new `FailureCode`.

- [ ] **Step 1: Write the failing test**

`server/src/routes/failure-taxonomy.reasoning.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { classifyAnalysisFailure } from './failure-taxonomy.js';
import { AnalyzerCapabilityRejectedError, AnalyzerReasoningOverflowError, AnalyzerReasoningUnavailableError } from '../analyzer/errors.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

beforeEach(() => _resetUserSettingsCache());

describe('analyzer-reasoning-overflow names the reasoning control', () => {
  it('Ollama → the Ollama reasoning setting sent as think', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', 812), 'Ollama (qwen3.5:4b)');
    expect(f.code).toBe('analyzer-reasoning-overflow');
    expect(f.userMessage).toContain('the Ollama reasoning setting (Advanced settings → Analyzer request controls; sent as "think")');
  });
  it('Gemma 4 → thinkingLevel, off sends MINIMAL', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', 'gemma-4-31b-it', 8192), 'Gemma 4');
    expect(f.userMessage).toContain('sent as thinkingLevel — "off" sends MINIMAL');
  });
  it('Gemini 2.5 Flash → has no row (F2), reads the same as an unknown id', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', 'gemini-2.5-flash', 8192), 'Gemini 2.5 Flash');
    expect(f.userMessage).toContain("this model's reasoning cannot be controlled from Castwright yet");
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

describe('a level that reached a call mid-run is coded too (N10)', () => {
  it('names the setting and says the run stopped, not that it never started', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningUnavailableError('q:4b', 'xhigh', 'local', 'mid-run'), 'Ollama (q:4b)');
    expect(f.code).toBe('analyzer-request-rejected');
    expect(f.userMessage).toContain('stopped');
    expect(f.userMessage).not.toContain('was not started');
    expect(f.userMessage).toContain('"xhigh"');
    expect(f.userMessage).toContain('Advanced settings → Analyzer request controls');
  });
});

describe('a stored level no longer offered is refused before start (P17)', () => {
  it('maps a stored level no longer offered to analyzer-request-rejected before start, naming where the setting lives', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningUnavailableError('gemini-3.8-flash', 'minimal', 'gemini'), 'Gemini 3.8 Flash');
    expect(f.code).toBe('analyzer-request-rejected');
    expect(f.userMessage).toContain('was not started');
    expect(f.userMessage).toContain('"minimal"');
    expect(f.userMessage).toContain('Advanced settings → Analyzer request controls');
    const endpoint = classifyAnalysisFailure(new AnalyzerReasoningUnavailableError('openai:lab::m', 'xhigh', 'openai'), 'Lab · m');
    expect(endpoint.code).toBe('analyzer-request-rejected');
    expect(endpoint.userMessage).toContain("the endpoint's Reasoning setting");
    expect(endpoint.userMessage).not.toContain('Analyzer request controls');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/routes/failure-taxonomy.reasoning.test.ts`  Expected: the five overflow cases FAIL (`expected '<W2 message>' to contain 'the Ollama reasoning setting …'`). The pre-run refusal case may already PASS on W3's copy; if it does, leave W3's branch untouched in Step 3. The stale-level case FAILS: its code is not `analyzer-request-rejected`.

- [ ] **Step 3: Implement**

Add imports to `failure-taxonomy.ts` (after `:27`):
```ts
import { AnalyzerReasoningOverflowError, AnalyzerCapabilityRejectedError, AnalyzerReasoningUnavailableError } from '../analyzer/errors.js';
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

Add this branch beside W3's `AnalyzerCapabilityRejectedError` branch (always, not only when a test is red):
```ts
  if (err instanceof AnalyzerReasoningUnavailableError) {
    const where =
      err.engine === 'openai' ? "the endpoint's Reasoning setting" : 'Advanced settings → Analyzer request controls';
    /* N10 — the same refusal can arrive from the pre-run check or, for a value no save could produce,
       from the call itself. The copy must not claim a run never started when it did. */
    const outcome = err.when === 'mid-run' ? 'stopped' : 'was not started';
    return withCopy(
      'analyzer-request-rejected',
      `${modelLabel} ${outcome}: its saved reasoning level "${err.level}" is not offered for this model. Choose an offered level in ${where}, or run Test again.`,
      `setting=reasoning value=${err.level} engine=${err.engine} when=${err.when}`,
    );
  }
```

- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/routes/failure-taxonomy.reasoning.test.ts src/routes/failure-taxonomy.test.ts`  Then: `npm run check:cycles`
Expected: PASS; no new cycle (if madge reports `failure-taxonomy → user-settings → …`, pass the endpoints in instead: give `classifyAnalysisFailure` no new import, and have `reasoningControlFor` take `endpoints` from a module-level `setFailureTaxonomySettingsReader(() => getCachedUserSettings())` registered in `server/src/index.ts` at boot — the test then registers it in `beforeEach`). Keeps green: `failure-taxonomy.test.ts` (sorted key list unchanged, W2/W3 cases), and `npm test -- src/data/help-failures.test.ts src/data/help-categories.test.ts`, still at W3b's **28 / 54**. `AnalyzerReasoningUnavailableError` maps to the existing `analyzer-request-rejected`, and wave 5 adds no `FailureCode`, so none of the Global Constraints' six code places changes.

- [ ] **Step 5: Mutation proof**
Replace `${reasoningControlFor(err)}` with W2's original fixed phrase. Expected red: all five `analyzer-reasoning-overflow names the reasoning control` cases. Restore.
Delete the `AnalyzerReasoningUnavailableError` branch. Expected red: `maps a stored level no longer offered to analyzer-request-rejected before start` and `names the setting and says the run stopped, not that it never started`. Restore.
Replace `const outcome = err.when === 'mid-run' ? 'stopped' : 'was not started';` with `const outcome = 'was not started';`. Expected red: the mid-run case only. Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy.reasoning.test.ts
git commit -m "fix(server): name the actual reasoning control in reasoning-overflow and pre-run refusal copy"
```

### Task 5.5b: `reasoningOverflowFixes` — reasoning-level fixes (F7, owner-approved 2026-09-13; extension accepted 2026-09-13)

**Precondition:** wave 2 has landed `AnalysisFailureFix`, `reasoningOverflowFixes(ctx)` and its guard test (`server/src/routes/failure-taxonomy.ts`, per the master plan's P20/F7 contract) before this task starts. Re-read that file's actual shape before implementing; this task's Step 3 assumes the contract below.

**Resolution (coordinator, 2026-09-13).** The conflict this task originally reported — `AnalysisFailureFix.settingKey` names a registry key and `endpointField` names an endpoint field, and Gemini's/Ollama's per-model reasoning level (`analyzerReasoningByEngine`, Task 5.2) is neither — is resolved by **additively widening `AnalysisFailureFix`** with a third, non-registry pointer:
```ts
// server/src/routes/failure-taxonomy.ts — AnalysisFailureFix, widened (#3084 wave 5a, F7)
export interface AnalysisFailureFix {
  label: string;
  settingKey?: string;
  endpointField?: { endpointId: string; field: string };
  /** #3084 wave 5a (F7) — points at a per-model reasoning entry in `analyzerReasoningByEngine`
      (Task 5.2), which has no registry key and no endpoint. The frontend deep-links to
      `#/advanced?reasoningEngine=<engine>&reasoningModel=<model>` (Task 5.5c) and Task 5.6's
      per-engine reasoning editor scrolls to and highlights that model's row. */
  reasoningSetting?: { engine: 'gemini' | 'ollama'; model: string };
  wikiPage?: string;
}
```
This is additive to whatever wave 2 landed — no existing field renames or narrows. `wikiHref` is renamed to `wikiPage?: string` (wave 3 review, 2026-09-13): a bare page name under `docs/wiki/`, no `#anchor` — `src/lib/wiki-links.ts:1-4` pins the GitHub wiki base and forbids anchor fragments (slugging is fragile there), and the renderer builds the absolute URL from `WIKI_BASE` + the page name.

**CRITICAL, review pass 1 (2026-09-13): `'local'` is not a `TransportKind`.** The master contract's `TransportKind` is `'ollama' | 'gemini' | 'openai'` (`errors.ts`, W1). Every branch and test below uses `'ollama'`, never `'local'` — `'local'` is `AnalysisEngine`'s value (a different type, used by `resolveReasoningSetting`'s `engine` parameter), not a transport. This draft's first version mixed the two; it is corrected throughout below.

**CRITICAL, review pass 1: no fix at the default without a lower rung.** The fix is offered only when the level the failing request **actually ran at** has a lower rung available — never unconditionally, and never re-derived from live settings at display time (a race: the setting can change between the overflow and the moment the failure renders). Two additive pieces this task needs, both **set once, at throw time**:
- **`AnalyzerReasoningOverflowError` gains `reasoningLevel?: ReasoningLevel`, in `server/src/analyzer/errors.ts`.** Set at the actual throw site — `mapFinish` (called from `StageRunner`'s private `send`) and `runFreeText`'s own inline check — both in `server/src/analyzer/runner/stage-runner.ts` / `finish.ts`, per Task 5.1's edits above. **Corrected, review pass 2: no transport throws this error.** The earlier draft of this task said the transports set it; that was wrong (no `ollama-transport.ts`/`gemini-transport.ts` edit exists for this, and none is needed). It is additive beside 3b's `endpointId?`, inside the **same** `opts` object — `opts?: { endpointId?: string; reasoningLevel?: ReasoningLevel }` — never a 5th positional argument. Task 5.1 does this edit; this task only **reads** `err.reasoningLevel`.
- **`GEMINI_REASONING_TABLE` rows gain `defaultLevel?: ReasoningLevel`** (Task 5.1, already landed above) — the level Google's own docs name as the model's default, used only to decide whether a model-default overflow still has something lower to try.
- **`reasoningOverflowFixes(ctx)` reads `ctx.reasoningLevel`, never settings.** It no longer calls `resolveReasoningSetting`/`getCachedUserSettings` for this purpose — wave 2's call site builds `ctx` from the error instance (`{ transport: err.transport, model: err.model, endpointId: err.endpointId, reasoningLevel: err.reasoningLevel }`, mirroring 3b's existing `endpointId: err.endpointId` addition to that same call — confirm the landed call site with `git grep -n "reasoningOverflowFixes(" server/src/routes/failure-taxonomy.ts` rather than a pinned line in another wave's plan file), so the fix always reflects the request that actually overflowed, not whatever is saved right now. (The `openai` branch still resolves the endpoint object itself, from `ctx.endpointId` — see below — that is a settings *read*, not a settings *re-derivation of the level*, so it is unaffected by this rule.)

**Rule, Gemini (`ctx.transport === 'gemini'`):**
- `row = geminiReasoningRow(ctx.model)`. No row (a 2.5 id, F2) → no fix.
- **`row.control === 'gemmaOnOff'`:** `ctx.reasoningLevel === 'on'` → `Turn reasoning off for <model>`. `'off'` or unset (model-default) → no fix — Gemma at its default is outside the thinking rule entirely (P27) and cannot be the model that overflowed there.
- **`row.control === 'thinkingLevel'`:** `effective = ctx.reasoningLevel` when it is set and not `'model-default'`, otherwise `row.defaultLevel`. When `effective` is known and `row.levels.indexOf(effective) > 1`, offer `Set a lower reasoning level (try "<row.levels[indexOf(effective) - 1]>") for <model>`. When `effective` is unknown (a future row with no `defaultLevel`) at model-default, fall back to naming `row.levels[1]`, today's behaviour — but **only for a `thinkingLevel` row**; `gemmaOnOff` is handled entirely by the branch above and never falls into this one. One rule covers both an explicit level and a documented default: index 0 is `model-default` (nothing to lower to), index 1 is the lowest real rung (nothing below it), so only index ≥ 2 has a strictly lower rung at index − 1.
  - Flash-Lite at model-default (`defaultLevel: 'minimal'`, index 1) → no fix.
  - 3.8 Flash at model-default (`defaultLevel: 'medium'`, index 2 in `['model-default','low','medium','high']`) → `try "low"`.
  - 3.1 Pro at model-default (`defaultLevel: 'high'`, index 3) → `try "medium"`.
  - 3 Flash (`gemini-3-flash-preview`) at model-default (`defaultLevel: 'high'`, index 4 in the full 5-level list) → `try "medium"`.
  - 3.6 Flash at an explicit `medium` (index 3 in the full 5-level list) → `try "low"`.
  - Gemma at explicit `on` → the `gemmaOnOff` branch above, not this one.
- No `wikiPage` on this fix (item 10b, below).

**Rule, Ollama (`ctx.transport === 'ollama'`) — corrected, review pass 2, item 10a.** `Turn reasoning off for <model>` is offered when `ctx.reasoningLevel` is `'on'`, a named level (`'low' | 'medium' | 'high'`), **or `'model-default'`** — never when it is `'off'`, and never when it is unset (the pre-W5 wire: no level was ever configured for this call, so nothing to turn off). The `'model-default'` case is deliberately included: Ollama's `'model-default'` level sends **no `think` field at all** (`reasoningWireFragment('ollama', …, 'model-default')` returns `{}`), unlike `'off'` (`{ think: false }`) — an Ollama model can still think on its own, unprompted, when `think` is omitted, so `'model-default'` is genuinely ambiguous and worth offering the fix for. Only an explicit `'off'` (or no level at all, the same wire shape) rules the fix out — a model that overflows there is thinking despite an explicit request not to, and turning reasoning off again changes nothing; the other fixes (context, input tokens, switch model) still apply.

**Endpoints — no redeclared `endpoint` (corrected, review pass 3, item 5; review pass 2, item 8 retired).** 3b's `openai` branch already resolves `const endpoint = getCachedUserSettings().analyzerEndpoints.find((e) => e.id === ctx.endpointId);` inside `if (ctx.transport === 'openai' && ctx.endpointId)`. This task's endpoint fix lands inside that same block and reuses that `endpoint` — no second `const endpoint = …`, no separate `if (ctx.transport === 'openai' …)` (see the code below). Otherwise unchanged: `endpointField: { endpointId: ctx.endpointId, field: 'reasoning' }`. No `wikiPage` on this fix either (item 10b, below).

**Wiki link — its own list entry, not a `wikiPage` on each fix (review pass 2, item 10b).** `AnalysisFailureFix.wikiPage` names a page for a single, list-level "Read: <section>" entry appended once to the whole `fixes` array — not a property every individual fix repeats. For 5a's reasoning-overflow fixes, that entry ("When a model thinks past its output limit") is **already appended by 2b/3d**; this task adds no duplicate, and none of this task's own fix objects (Gemini's or Ollama's) carries `wikiPage`.

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts` — widen `AnalysisFailureFix` (above, `wikiPage` only, on the list-level entry — not per-fix), and extend `reasoningOverflowFixes(ctx)`'s `gemini` and `ollama` branches; extend the call site that builds `ctx` (wave 2's, alongside 3b's `endpointId: err.endpointId`) with `reasoningLevel: err.reasoningLevel`
- Modify: `server/src/routes/failure-taxonomy-fixes.test.ts` (wave 2's guard-test file for `reasoningOverflowFixes`, **not** `failure-taxonomy.reasoning.test.ts` — that file is Task 5.5's, for `classifyAnalysisFailure`'s copy) — append cases, extend the guard, add mutation rows
- Modify: `openapi.yaml` — the `AnalysisFailureFix` schema, adding `reasoningSetting`; regenerate `src/lib/api-types.ts` via `npm run openapi:types`
- Modify: `src/lib/api.ts` — wherever the mock SSE/analysis-failure builder constructs `fixes` entries, thread `reasoningSetting` through unchanged (same treatment as `endpointField`)
- (`server/src/analyzer/errors.ts` and `server/src/analyzer/runner/finish.ts`/`stage-runner.ts` are Task 5.1's Files, not this task's — this task only reads `err.reasoningLevel`.)

**Interfaces:**
- Consumes: `AnalysisFailureFix`, `reasoningOverflowFixes(ctx)`, `AnalyzerReasoningOverflowError` and its `endpointId?`/`reasoningLevel?` (wave 2, extended by 3b and Task 5.1 respectively); `geminiReasoningRow` and each row's `defaultLevel` (Task 5.1); `getCachedUserSettings` (`server/src/workspace/user-settings.ts`); `analyzerEndpointSchema` (W3b) for the guard test's field-existence check; Task 5.5c's `reasoningFocus` deep-link grammar (frontend only); the 3d.9a wiki-page-existence guard.
- Produces:
  - `AnalysisFailureFix.reasoningSetting?: { engine: 'gemini' | 'ollama'; model: string }`.
  - `reasoningOverflowFixes(ctx: { transport: TransportKind; model: string; endpointId?: string; reasoningLevel?: ReasoningLevel })` — the `gemini`/`ollama` rules above (no `wikiPage` on either).
- Guard-test extension: `reasoningSetting.engine` must be `'gemini'` or `'ollama'`; for every `(model, level)` pair the reasoning table can produce, the Gemini fix is present iff the rule above says it should be (no fix without a lower rung, none for `gemmaOnOff` at model-default); neither this task's Gemini nor Ollama fix ever carries a `wikiPage`.

- [ ] **Step 1: Write the failing test**
Append to `server/src/routes/failure-taxonomy-fixes.test.ts`:
```ts
describe('reasoningOverflowFixes — reasoning-level fixes (#3084 wave 5a, F7, extension accepted 2026-09-13)', () => {
  afterEach(() => _resetUserSettingsCache());

  /* err.reasoningLevel is set by Task 5.1 at the actual throw site (mapFinish / runFreeText); this
     test drives reasoningOverflowFixes the same way classifyAnalysisFailure's real call site does —
     through the error instance, never a hand-built ctx — so the opts-object shape cannot drift
     (review pass 2, item 1). */
  const overflow = (transport: TransportKind, model: string, reasoningLevel?: ReasoningLevel, endpointId?: string) =>
    classifyAnalysisFailure(new AnalyzerReasoningOverflowError(transport, model, 812, { endpointId, reasoningLevel }), model).fixes ?? [];

  it('an endpoint gets a fix pointing at its own reasoning field', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'none', contextTokens: 32768 })] });
    const fixes = overflow('openai', 'm', undefined, 'lab');
    const reasoningFix = fixes.find((f) => f.endpointField?.field === 'reasoning');
    expect(reasoningFix).toBeDefined();
    expect(reasoningFix?.endpointField).toEqual({ endpointId: 'lab', field: 'reasoning' });
    expect(reasoningFix?.wikiPage).toBeUndefined(); // review pass 2, item 10b — no per-fix wikiPage
  });

  /* Corrected, review pass 2, item 10a: 'model-default' also gets the fix (Ollama can still think
     with no `think` field sent), only an explicit 'off' or no level at all does not. */
  it('Ollama at on, a named level, or model-default gets a fix; at off or unset it does not', () => {
    expect(overflow('ollama', 'q:4b', 'on').find((f) => f.reasoningSetting)?.reasoningSetting).toEqual({ engine: 'ollama', model: 'q:4b' });
    expect(overflow('ollama', 'q:4b', 'medium').some((f) => f.reasoningSetting)).toBe(true);
    expect(overflow('ollama', 'q:4b', 'model-default').some((f) => f.reasoningSetting)).toBe(true);
    expect(overflow('ollama', 'q:4b', 'off').some((f) => f.reasoningSetting)).toBe(false);
    expect(overflow('ollama', 'q:4b', undefined).some((f) => f.reasoningSetting)).toBe(false);
  });

  it('Gemini at an explicit level with a lower rung gets a fix naming it; at the lowest rung it does not', () => {
    const medium = overflow('gemini', 'gemini-3.6-flash', 'medium');
    const fix = medium.find((f) => f.reasoningSetting);
    expect(fix?.reasoningSetting).toEqual({ engine: 'gemini', model: 'gemini-3.6-flash' });
    expect(fix?.label).toContain('"low"');
    expect(fix?.wikiPage).toBeUndefined(); // review pass 2, item 10b
    expect(overflow('gemini', 'gemini-3.8-flash', 'low').some((f) => f.reasoningSetting)).toBe(false);
  });

  it('Gemma 4 at explicit on gets the fix (lower to off); at off or model-default it does not', () => {
    expect(overflow('gemini', 'gemma-4-31b-it', 'on').some((f) => f.reasoningSetting)).toBe(true);
    expect(overflow('gemini', 'gemma-4-31b-it', 'off').some((f) => f.reasoningSetting)).toBe(false);
    expect(overflow('gemini', 'gemma-4-31b-it', undefined).some((f) => f.reasoningSetting)).toBe(false);
  });

  it('a 2.5 id (no row, F2) never gets a reasoning-level fix, at any level', () => {
    expect(overflow('gemini', 'gemini-2.5-flash', 'high').some((f) => f.reasoningSetting)).toBe(false);
  });

  /* Review pass 1 (2026-09-13) — the level actually run, via defaultLevel, decides model-default cases. */
  it('Flash-Lite at model-default (defaultLevel minimal) gets no level fix — already at the lowest rung', () => {
    expect(overflow('gemini', 'gemini-3.5-flash-lite', undefined).some((f) => f.reasoningSetting)).toBe(false);
  });

  it('3.8 Flash at model-default (defaultLevel medium) suggests trying low', () => {
    const fix = overflow('gemini', 'gemini-3.8-flash', undefined).find((f) => f.reasoningSetting);
    expect(fix?.label).toContain('"low"');
  });

  it('3.1 Pro at model-default (defaultLevel high) suggests trying medium', () => {
    const fix = overflow('gemini', 'gemini-3.1-pro-preview', undefined).find((f) => f.reasoningSetting);
    expect(fix?.label).toContain('"medium"');
  });

  /* review pass 2, item 7: 3 Flash (bare, no dot-version) has its own defaultLevel (high), distinct
     from 3.5/3.6 Flash's medium. */
  it('3 Flash (gemini-3-flash-preview) at model-default (defaultLevel high) suggests trying medium', () => {
    const fix = overflow('gemini', 'gemini-3-flash-preview', undefined).find((f) => f.reasoningSetting);
    expect(fix?.label).toContain('"medium"');
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run the guard-test file. Expected: FAIL — every case, including the endpoint one: `endpointField`/`reasoningSetting` fixes for `gemini`/`ollama`/`openai` are all added in Step 3 below, so nothing in this describe passes yet (this task's earlier draft wrongly claimed the endpoint case already passed; it did not — `reasoningOverflowFixes` had no `openai` branch before this task either).
- [ ] **Step 3: Implement**
`AnalyzerReasoningOverflowError.reasoningLevel` and its throw sites are Task 5.1's edits (`server/src/analyzer/errors.ts`, `runner/finish.ts`, `runner/stage-runner.ts`) — nothing to do here for that half. This task only extends `reasoningOverflowFixes` and its call site.

In wave 2's call site that builds `ctx` for `reasoningOverflowFixes` (the same one 3b already extended with `endpointId: err.endpointId`), add `reasoningLevel: err.reasoningLevel`:
```ts
reasoningOverflowFixes({ transport: err.transport, model: err.model, endpointId: err.endpointId, reasoningLevel: err.reasoningLevel })
```
In `reasoningOverflowFixes`, add an `ollama` branch:
```ts
  if (
    ctx.transport === 'ollama' &&
    (ctx.reasoningLevel === 'on' || ctx.reasoningLevel === 'model-default' ||
      ctx.reasoningLevel === 'low' || ctx.reasoningLevel === 'medium' || ctx.reasoningLevel === 'high')
  ) {
    fixes.push({
      label: `Turn reasoning off for ${ctx.model}`,
      reasoningSetting: { engine: 'ollama', model: ctx.model },
    });
  }
```
In the `gemini` branch, after computing whatever wave 2 already computes, add:
```ts
  const row = geminiReasoningRow(ctx.model);
  if (row) {
    if (row.control === 'gemmaOnOff') {
      if (ctx.reasoningLevel === 'on') {
        fixes.push({
          label: `Turn reasoning off for ${ctx.model}`,
          reasoningSetting: { engine: 'gemini', model: ctx.model },
        });
      }
      /* 'off' or unset (model-default): outside the thinking rule at default (P27); no fix. */
    } else {
      const explicit = ctx.reasoningLevel && ctx.reasoningLevel !== 'model-default' ? (ctx.reasoningLevel as ReasoningLevel) : undefined;
      const effective = explicit ?? row.defaultLevel;
      if (effective) {
        const idx = row.levels.indexOf(effective);
        if (idx > 1) {
          fixes.push({
            label: `Set a lower reasoning level (try "${row.levels[idx - 1]}") for ${ctx.model}`,
            reasoningSetting: { engine: 'gemini', model: ctx.model },
            wikiPage: 'Analysis-and-the-Analyzer',
          });
        }
      } else if (!explicit) {
        /* No defaultLevel known for this row (none exist today, F2's table); fall back to today's rule. */
        fixes.push({
          label: `Set a lower reasoning level (try "${row.levels[1]}") for ${ctx.model}`,
          reasoningSetting: { engine: 'gemini', model: ctx.model },
        });
      }
    }
  }
```
(Import `geminiReasoningRow` and `type ReasoningLevel` from `../analyzer/reasoning.js`. This branch reads no settings and no cache — `resolveReasoningSetting`/`getCachedUserSettings` are not imported for this purpose.)
**No redeclared `endpoint` (review pass 3, item 5).** 3b's `openai` branch already reads exactly this, inside `if (ctx.transport === 'openai' && ctx.endpointId) { const endpoint = getCachedUserSettings().analyzerEndpoints.find((e) => e.id === ctx.endpointId); const name = endpoint?.name ?? ctx.endpointId; fixes.push(…); }` (3b.1a's landed text — the exact shape, re-derived; do not assume a different one). This task's fix lands **inside that same block**, reusing its `endpoint`/`name` — no second `const endpoint = …`, no separate `if (ctx.transport === 'openai' …)`:
```ts
  fixes.push({
    label: `Lower "${name}"'s reasoning setting`,
    endpointField: { endpointId: ctx.endpointId, field: 'reasoning' },
  });
```
(No new import — `getCachedUserSettings` is already imported by 3b's branch. No `wikiPage` on this fix, item 10b.)
**OpenAPI:** add to the `AnalysisFailureFix` (or wave 2's actual schema name — `git grep -n "AnalysisFailureFix\|reasoningOverflowFixes" openapi.yaml` first) schema in `openapi.yaml`:
```yaml
        reasoningSetting:
          type: object
          required: [engine, model]
          properties:
            engine:
              type: string
              enum: ['gemini', 'ollama']
            model:
              type: string
```
Run `npm run openapi:types`. In `src/lib/api.ts`'s mock fixes builder, add `reasoningSetting` to whichever fixture entries need it, unchanged pass-through.
**Guard test.** Extend wave 2's guard test (the one asserting every `settingKey` is a registry key, every `endpointField.field` exists on `analyzerEndpointSchema`, and — per 3d.9a — every `wikiPage` names a file under `docs/wiki/`) to also check the claims this task's `reasoningOverflowFixes` rule makes, not just its `engine` enum:
```ts
it('every reasoningSetting.engine is gemini or ollama', () => {
  for (const fixes of ALL_FIXTURE_FIXES_LISTS) {
    for (const fix of fixes) {
      if (fix.reasoningSetting) expect(['gemini', 'ollama']).toContain(fix.reasoningSetting.engine);
    }
  }
});

/* Corrected, review pass 2, item 3: the earlier draft derived a model id from each row's regex
   SOURCE TEXT (stripping regex syntax characters), which resolves to strings like "gemini-3:51" that
   match no row at all — geminiReasoningRow(that) is undefined, so the "exhaustive" check silently
   checked nothing. Replaced with an explicit fixture: one real, verified model id per table row, in
   the SAME order as GEMINI_REASONING_TABLE. */
const ROW_FIXTURE_IDS = [
  'gemini-3.5-flash-lite',  // Flash-Lite (minimal/low/medium/high, defaultLevel minimal)
  'gemini-3-flash-preview', // 3 Flash, bare (minimal/low/medium/high, defaultLevel high)
  'gemini-3.6-flash',       // 3.5/3.6 Flash (minimal/low/medium/high, defaultLevel medium)
  'gemini-3.8-flash',       // 3.7/3.8 Flash (low/medium/high, defaultLevel medium)
  'gemini-3.1-pro',         // 3.1 Pro (low/medium/high, defaultLevel high)
  'gemma-4-31b-it',         // Gemma 4 (off/on, gemmaOnOff)
] as const;

describe('ROW_FIXTURE_IDS — one real id per GEMINI_REASONING_TABLE row', () => {
  it('the fixture has exactly one id per table row', () => {
    expect(ROW_FIXTURE_IDS.length).toBe(GEMINI_REASONING_TABLE.length);
  });
  it('every fixture id resolves back to its own row, by identity, in table order', () => {
    ROW_FIXTURE_IDS.forEach((id, i) => {
      expect(geminiReasoningRow(id), id).toBe(GEMINI_REASONING_TABLE[i]);
    });
  });
});

/* Review pass 1 (2026-09-13) — the guard checks the RULE, not just the engine enum: exhaustively,
   for every (row, level) the table can produce, a Gemini fix exists iff there is a strictly lower
   real rung to name, and never for gemmaOnOff at model-default. This is what would have caught the
   original "no-op fix at the default" defect. Runs against ROW_FIXTURE_IDS, not a derived id, so a
   future row with no fixture id fails the describe above before this one can silently check nothing. */
it('a Gemini reasoning fix exists iff a strictly lower rung is available for the level actually run', () => {
  GEMINI_REASONING_TABLE.forEach((row, i) => {
    const model = ROW_FIXTURE_IDS[i];
    const levelsToCheck: (ReasoningLevel | undefined)[] =
      row.control === 'gemmaOnOff' ? ['on', 'off', undefined] : [...row.levels.filter((l) => l !== 'model-default'), undefined];
    for (const level of levelsToCheck) {
      const fixes = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', model, 812, { reasoningLevel: level }), model).fixes ?? [];
      const hasFix = fixes.some((f) => f.reasoningSetting);
      if (row.control === 'gemmaOnOff') {
        expect(hasFix, `${model} at ${level}`).toBe(level === 'on');
      } else {
        const effective = level && level !== 'model-default' ? level : row.defaultLevel;
        const expectFix = effective !== undefined && row.levels.indexOf(effective) > 1;
        expect(hasFix, `${model} at ${level ?? 'model-default'}`).toBe(expectFix);
      }
    }
  });
});
```
(`ALL_FIXTURE_FIXES_LISTS` — reuse whatever the existing guard test already iterates; do not add a second enumeration mechanism.)
- [ ] **Step 4: Run and confirm it passes**
Run the guard-test file, then the full `failure-taxonomy` suite, then `npm run openapi:types && git diff --exit-code src/lib/api-types.ts`, then `npm run typecheck`.
- [ ] **Step 5: Mutation proof**
1. Delete the `ollama` branch's push. Expected red: `Ollama at on, a named level, or model-default gets a fix; at off or unset it does not`. Restore.
2. Drop `ctx.reasoningLevel === 'model-default' ||` from the `ollama` branch's condition (item 10a's correction). Expected red: `Ollama at on, a named level, or model-default gets a fix; at off or unset it does not`'s `'model-default'` case. Restore.
3. In the `thinkingLevel` branch, change `idx > 1` to `idx >= 1`. Expected red: `Gemini at an explicit level with a lower rung gets a fix naming it; at the lowest rung it does not` (the second half now wrongly gets a fix) and the exhaustive guard test's index-1 cases across every `thinkingLevel` row. Restore.
4. Change `idx > 1` to `idx > 0`. Expected red: the exhaustive guard test's index-1 cases across every `thinkingLevel` row (each now wrongly gets a fix at its lowest real rung). Restore.
5. In the Flash-Lite table row (Task 5.1), change `defaultLevel: 'minimal'` to `defaultLevel: 'low'`. Expected red: `Flash-Lite at model-default (defaultLevel minimal) gets no level fix` (now wrongly offers "try minimal") and the exhaustive guard test's Flash-Lite, model-default case. Restore.
6. **Corrected, review pass 2, item 9:** drop `row.control === 'gemmaOnOff'` from the `if` that gates the fallback "no defaultLevel known" branch, so it also fires for a `gemmaOnOff` row at model-default (Gemma's row has no `defaultLevel`, so today's `if (effective) {…} else if (!explicit) {…}` fallback would wrongly suggest `row.levels[1]` — `'off'` — for Gemma at model-default, where the rule requires no fix at all). Concretely: restructure so the fallback branch is reached only from the `thinkingLevel` arm, never from `gemmaOnOff`'s own arm (as Step 3's code already does — this mutation deliberately breaks that separation by merging the two arms). Expected red: `Gemma 4 at explicit on gets the fix…`'s `model-default` case (now wrongly offered, labelled "Set a lower reasoning level…" instead of absent). Restore.
7. Delete the endpoint fix's push (this task's `fixes.push({ label: 'Lower "${name}"'s reasoning setting', … })`, inside 3b's existing `if` block — leave 3b's own `endpoint`/`name`/`fixes.push(...)` lines untouched). Expected red: `an endpoint gets a fix pointing at its own reasoning field`. Restore.
8. Delete one entry from `ROW_FIXTURE_IDS`. Expected red: `the fixture has exactly one id per table row`. Restore.
9. Swap two adjacent entries in `ROW_FIXTURE_IDS`. Expected red: `every fixture id resolves back to its own row, by identity, in table order` (each swapped id now resolves to the row one position away, failing the `toBe` identity check against `GEMINI_REASONING_TABLE[i]`). Restore.
10. Delete the guard test's `reasoningSetting.engine` check body (make it a no-op). Expected red: none by itself (nothing to catch yet) — pair it with mutation 11 to prove the guard fires.
11. Temporarily push a fix with `reasoningSetting: { engine: 'openai' as any, model: 'm' }` into a fixture the guard test iterates. Expected red: `every reasoningSetting.engine is gemini or ollama`, only when mutation 10 is reverted. Restore both.
- [ ] **Step 6: Commit**
```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy-fixes.test.ts openapi.yaml src/lib/api-types.ts src/lib/api.ts
git commit -m "feat(server,frontend): reasoning-level fixes for Gemini and Ollama, gated on the level actually run having a lower rung"
```

### Task 5.5c: `reasoningFocus` router deep link (F7, mirrors wave 2's `?code=`/`focus` grammar)

**Resolved by the coordinator (2026-09-13):** Task 5.5b's `reasoningSetting` fix (below, rewritten) needs a frontend deep link into the per-model reasoning row Task 5.6 renders. `src/lib/router.ts` has no query parameter on the `'advanced'` stage today (`case 'advanced': return '#/advanced';`, confirmed at `80be2f1d` — unchanged from `46e62a34`) — wave 2's F7-staged `focusKey` stage field and its `?focus=<settingKey>` deep link for a registry knob are expected to add one first (per the master plan/w2's Task 2.9a). This task adds a **second, independent** query parameter on the same stage, `reasoningFocus`, following the identical pattern the codebase already uses for the Help view's `?code=` (`src/lib/types.ts`'s `{ kind: 'help'; focusCode? }`, `src/lib/router.ts`'s `'help'` case, `src/routes/index.tsx`'s `HelpRoute`) — the closest existing precedent for a stage-scoped, URL-borne focus value, and the one CLAUDE.md's "pure `parseHash`/`stageToHash`" language describes.

**Why two query params, not one packed string.** A Gemini model id never contains `:`, but an Ollama tag routinely does (`qwen3.5:4b`), and `engine` is one of exactly two literals. Packing `<engine>:<model>` into one value would need an unambiguous split rule for a value the URL itself does not need escaped. Two params (`reasoningEngine`, `reasoningModel`) avoid that: each is `encodeURIComponent`-safe on its own, matching the `q.set(...)`/`URLSearchParams` style `stageToHash`'s `'ready'` case already uses (`80be2f1d:src/lib/router.ts`, unchanged from `46e62a34`, the `q.set('chapter', …)` / `q.set('profile', …)` calls).

**Extends 2.9a's own code; does not add a parallel copy (review pass 1, 2026-09-13).** Wave 2's Task 2.9a is being told to write the `'advanced'` stage's `focusKey` field, its `AdvancedRoute` URL parsing and its `stageEqual` branch as the code this task extends — not as a separate mechanism this task duplicates beside. Concretely:
- `stageEqual` has **exactly one** `'advanced'` branch (2.9a's), comparing both `focusKey` and `reasoningFocus`: `if (a.kind === 'advanced' && b.kind === 'advanced') return a.focusKey === b.focusKey && a.reasoningFocus?.engine === b.reasoningFocus?.engine && a.reasoningFocus?.model === b.reasoningFocus?.model;` — this task extends that one return statement (2.9a's own `focusKey === focusKey` comparison, plus this task's two extra fields), never adds a second `if (a.kind === 'advanced' …)` block.
- `AdvancedRoute` is **one function reading three query params**: 2.9a's `focus` (→ `focusKey`) and this task's `reasoningEngine`/`reasoningModel` (→ `reasoningFocus`), hydrating one `{ kind: 'advanced', focusKey, reasoningFocus }` object in one `useHydrateStage` call — never two separate route functions or two separate hydrate calls.
- Tests use **2.9a's `renderAtAdvanced` helper** (2.9a adds it to `src/routes/index.test.tsx`, which at `80be2f1d` (unchanged from `46e62a34`, re-verified) has no `HelpRoute` describe at all — only `SetupRoute`/`AnalysingRoute`/`BooksRoute`, via `renderAtSetup`/`renderAtAnalysing`; confirmed by reading the pinned file directly). This task's earlier draft cited a nonexistent `HelpRoute` test case and a `renderAtHash`/`getHydratedStage` pair that do not exist at `80be2f1d` either — both are corrected below to `renderAtAdvanced`.

**Files:**
- Modify: `src/lib/types.ts:1073` — the `Stage` union's `{ kind: 'advanced' }` member: 2.9a adds `focusKey?: string`; this task adds `reasoningFocus?: { engine: 'gemini' | 'ollama'; model: string }` beside it, in the same PR ordering 2.9a establishes (confirm with `git grep -n "kind: 'advanced'" src/lib/types.ts` before editing — if 2.9a has not landed `focusKey` yet, stop and report the gap rather than adding `reasoningFocus` to a bare `{ kind: 'advanced' }` member that would need a second edit later).
- Modify: `src/lib/router.ts` — `stageToHash`'s `'advanced'` case (2.9a's version, which already emits `?focus=<focusKey>`; extend its `URLSearchParams` builder with `reasoningEngine`/`reasoningModel`, do not rebuild the case); `stageEqual`'s single `'advanced'` branch (2.9a's; extend the one boolean expression, per above).
- Modify: `src/routes/index.tsx` — `AdvancedRoute` (2.9a's version, which already reads `useSearchParams()` for `focus`; add `reasoningEngine`/`reasoningModel` reads to the same function and the same `useHydrateStage` call, combined into `reasoningFocus` only when `reasoningEngine` is `'gemini'` or `'ollama'` and `reasoningModel` is non-empty — an unrecognised or partial pair yields `undefined`, never a malformed object).
- Test: `src/lib/router.test.ts` (round-trip cases); `src/routes/index.test.tsx`, using 2.9a's `renderAtAdvanced` helper (append a case; do not add a second helper).
- Modify: `src/lib/failure-fixes.ts` — 2b's shared `fixHref(fix: AnalysisFailureFix): string | null`, which both "How to fix" renderers call (extended by 3d for the `endpointField` branch) — add the `reasoningSetting` branch. **No renderer changes and no inline link-building in this task or Task 5.6b:** every "How to fix" link, registry-knob, endpoint-field or reasoning-setting alike, is built by this one function; a renderer only calls `fixHref(fix)` and renders the result as an `<a href>` (or nothing, for `null`).
- Test: `src/lib/failure-fixes.test.ts` (append a case and a mutation row).

**Interfaces:**
- Consumes: `AnalysisFailureFix.reasoningSetting` (Task 5.5b); `fixHref(fix): string | null` (2b, extended by 3d for `endpointField`) — this task adds a third branch, alongside 2b's `settingKey` branch and 3d's `endpointField` branch. Otherwise nothing new from another wave; extends existing production code by symbol, same as wave 2's `focusKey` addition.
- Produces:
  ```ts
  // src/lib/types.ts — Stage union, 'advanced' member
  | { kind: 'advanced'; reasoningFocus?: { engine: 'gemini' | 'ollama'; model: string } }
  // (plus wave 2's `focusKey` field, Task 2.9a, serialized as `?focus=<settingKey>`)
  ```
  `stageToHash({ kind: 'advanced', reasoningFocus: { engine, model } })` → `#/advanced?reasoningEngine=<engine>&reasoningModel=<encodeURIComponent(model)>`; `stageToHash({ kind: 'advanced' })` → `#/advanced` (unchanged).
  `fixHref({ label: '…', reasoningSetting: { engine, model } })` → the same string as `stageToHash({ kind: 'advanced', reasoningFocus: { engine, model } })`; `fixHref` returns `null` only when a fix carries none of `settingKey`, `endpointField` or `reasoningSetting` (2b's existing fallback, unchanged).

- [ ] **Step 1: Write the failing tests**
`src/lib/router.test.ts`, append:
```ts
describe('advanced stage — reasoningFocus deep link (#3084 wave 5a, F7)', () => {
  it('round-trips engine and model through the hash', () => {
    const hash = stageToHash({ kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-3.6-flash' } });
    expect(hash).toBe('#/advanced?reasoningEngine=gemini&reasoningModel=gemini-3.6-flash');
  });
  it('encodes an Ollama tag containing a colon', () => {
    const hash = stageToHash({ kind: 'advanced', reasoningFocus: { engine: 'ollama', model: 'qwen3.5:4b' } });
    expect(hash).toBe('#/advanced?reasoningEngine=ollama&reasoningModel=qwen3.5%3A4b');
  });
  it('plain #/advanced is unchanged with no reasoningFocus', () => {
    expect(stageToHash({ kind: 'advanced' })).toBe('#/advanced');
  });
  it('stageEqual treats two different reasoningFocus values as different stages', () => {
    const a = { kind: 'advanced' as const, reasoningFocus: { engine: 'gemini' as const, model: 'gemini-3.6-flash' } };
    const b = { kind: 'advanced' as const, reasoningFocus: { engine: 'gemini' as const, model: 'gemini-3.5-flash' } };
    expect(stageEqual(a, b)).toBe(false);
    expect(stageEqual(a, a)).toBe(true);
  });
});
```
Append to `src/routes/index.test.tsx`, using 2.9a's `renderAtAdvanced` helper (there is no `HelpRoute` describe or `renderAtHash`/`getHydratedStage` pair in this file at `80be2f1d` — unchanged from `46e62a34` — the file's actual harness is `renderAtSetup`/`renderAtAnalysing`-shaped, and 2.9a adds `renderAtAdvanced` in that same style, presumably returning or letting the test read the store's resulting `ui.stage`). **Corrected, review pass 2, item 6: `renderAtAdvanced(store, path)` takes a full path** (mirroring `renderAtSetup`/`renderAtAnalysing`, which take a full path, not a bare query string) — pass `'/advanced?…'`, not `'?…'`:
```tsx
it('AdvancedRoute reads reasoningEngine/reasoningModel from the URL and hydrates reasoningFocus beside focusKey', () => {
  const store = makeStore();
  renderAtAdvanced(store, '/advanced?reasoningEngine=gemini&reasoningModel=gemini-3.6-flash');
  expect(store.getState().ui.stage).toEqual({ kind: 'advanced', focusKey: undefined, reasoningFocus: { engine: 'gemini', model: 'gemini-3.6-flash' } });
});
it('an unrecognised engine value hydrates no reasoningFocus', () => {
  const store = makeStore();
  renderAtAdvanced(store, '/advanced?reasoningEngine=openai&reasoningModel=m');
  expect(store.getState().ui.stage).toEqual({ kind: 'advanced', focusKey: undefined });
});
it('focus and reasoningEngine/reasoningModel both hydrate together', () => {
  const store = makeStore();
  renderAtAdvanced(store, '/advanced?focus=analyzer.gemini.maxInputTokensPerRequest&reasoningEngine=ollama&reasoningModel=qwen3.5:4b');
  expect(store.getState().ui.stage).toEqual({
    kind: 'advanced',
    focusKey: 'analyzer.gemini.maxInputTokensPerRequest',
    reasoningFocus: { engine: 'ollama', model: 'qwen3.5:4b' },
  });
});
```
(If 2.9a's `renderAtAdvanced` has a different exact signature or return shape than assumed here, match it — do not invent a second helper alongside it.)
- [ ] **Step 2: Run them and confirm they fail**
Expected: FAIL — `stageToHash` ignores `reasoningFocus` (returns plain `#/advanced?focus=…` with 2.9a's param only); `AdvancedRoute` hydrates `{ kind: 'advanced', focusKey }` with no `reasoningFocus`; `fixHref`'s two new cases fail with `expected null to be '#/advanced?…'` (no `reasoningSetting` branch yet) and pass respectively (the "no link" case already returns `null`).
- [ ] **Step 3: Implement**
In `src/lib/types.ts`, add `reasoningFocus?: { engine: 'gemini' | 'ollama'; model: string }` to the `'advanced'` union member, beside 2.9a's `focusKey?: string` — read the member's current shape first (`git grep`, above) and add only this one field.
In `src/lib/router.ts`'s `stageToHash`, **extend** 2.9a's `'advanced'` case (do not replace its `URLSearchParams` builder or its `focus` line — add two more `q.set` calls to the same `q`):
```ts
    case 'advanced': {
      const q = new URLSearchParams();
      if (stage.focusKey) q.set('focus', stage.focusKey); // 2.9a
      if (stage.reasoningFocus) {
        q.set('reasoningEngine', stage.reasoningFocus.engine);
        q.set('reasoningModel', stage.reasoningFocus.model);
      }
      const qs = q.toString();
      return `#/advanced${qs ? '?' + qs : ''}`;
    }
```
In `stageEqual`, **extend 2.9a's single `'advanced'` branch** (do not add a second `if (a.kind === 'advanced' …)`):
```ts
  if (a.kind === 'advanced' && b.kind === 'advanced') {
    return (
      a.focusKey === b.focusKey && // 2.9a
      a.reasoningFocus?.engine === b.reasoningFocus?.engine &&
      a.reasoningFocus?.model === b.reasoningFocus?.model
    );
  }
```
In `src/routes/index.tsx`'s `AdvancedRoute`, **extend 2.9a's function** (it already reads `useSearchParams()` for `focus`; add two more reads and fold all three into one `useHydrateStage` call):
```tsx
function AdvancedRoute() {
  const [searchParams] = useSearchParams();
  const focusKey = searchParams.get('focus') ?? undefined; // 2.9a
  const reasoningEngine = searchParams.get('reasoningEngine');
  const reasoningModel = searchParams.get('reasoningModel');
  const reasoningFocus =
    (reasoningEngine === 'gemini' || reasoningEngine === 'ollama') && reasoningModel
      ? { engine: reasoningEngine, model: reasoningModel }
      : undefined;
  useHydrateStage({ kind: 'advanced', focusKey, reasoningFocus }, [focusKey, reasoningEngine, reasoningModel]);
  return <AdvancedView />;
}
```
Also append, to `src/lib/failure-fixes.test.ts` (Step 1, continued):
```ts
describe('fixHref — reasoningSetting (#3084 wave 5a, F7)', () => {
  it('builds the same href stageToHash would for the matching reasoningFocus', () => {
    const fix: AnalysisFailureFix = { label: 'Lower the reasoning level for gemini-3.6-flash', reasoningSetting: { engine: 'gemini', model: 'gemini-3.6-flash' } };
    expect(fixHref(fix)).toBe(stageToHash({ kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-3.6-flash' } }));
    expect(fixHref(fix)).toBe('#/advanced?reasoningEngine=gemini&reasoningModel=gemini-3.6-flash');
  });
  it('a fix with none of settingKey/endpointField/reasoningSetting returns null', () => {
    expect(fixHref({ label: 'No link' })).toBeNull();
  });
});
```
(Both new tests fail alongside Step 2's cases: `fixHref` does not have a `reasoningSetting` branch yet.)
- [ ] **Step 3: Implement (continued) — `fixHref`'s `reasoningSetting` branch**
In `src/lib/failure-fixes.ts`, beside 2b's `settingKey` branch and 3d's `endpointField` branch, add:
```ts
  if (fix.reasoningSetting) {
    return stageToHash({ kind: 'advanced', reasoningFocus: fix.reasoningSetting });
  }
```
(Import `stageToHash` from `./router.js` if 2b's file does not already import it for the `settingKey`/`focusKey` branch — reuse that import rather than adding a second one.) No renderer is touched: both "How to fix" renderers already call `fixHref(fix)` and render its result (or nothing, for `null`); this branch only makes that one function return a non-null string for a `reasoningSetting` fix.
- [ ] **Step 4: Run and confirm they pass**
Run: `npm test -- src/lib/router.test.ts src/routes/index.test.tsx src/lib/failure-fixes.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Mutation proof**
1. In `stageToHash`'s `'advanced'` case, drop the `q.set('reasoningModel', …)` line. Expected red: `round-trips engine and model through the hash` (`reasoningModel` missing from the query string). Restore.
2. In `AdvancedRoute`, drop the `reasoningEngine === 'gemini' || reasoningEngine === 'ollama'` guard (accept any string). Expected red: `an unrecognised engine value hydrates no reasoningFocus`. Restore.
3. In `stageEqual`'s new branch, return `true` unconditionally. Expected red: `stageEqual treats two different reasoningFocus values as different stages`. Restore.
4. Delete the `fixHref` `reasoningSetting` branch. Expected red: `builds the same href stageToHash would for the matching reasoningFocus` (`fixHref` returns `null`). Restore.
- [ ] **Step 6: Commit**
```bash
git add src/lib/types.ts src/lib/router.ts src/lib/router.test.ts src/routes/index.tsx src/lib/failure-fixes.ts src/lib/failure-fixes.test.ts
git commit -m "feat(frontend): deep-link Advanced Settings to a model's reasoning row"
```

### Task 5.6: Settings UI — per-engine reasoning editor and endpoint-form reasoning fields

**Files:**
- Create: `src/lib/reasoning-levels.ts`, `src/lib/settings-issues.ts`, `src/components/settings/analyzer-request-controls.tsx`
- Modify: `src/views/advanced.tsx:497` (render the editor between the Reset-all row `:482-496` and `<SettingsAccordion` `:498`)
- Modify: W3d's endpoint form, `src/components/settings/analyzer-endpoints-section.tsx` (Task 3d.8: `AnalyzerEndpointsSection`, its `EndpointDraft` type, `draftFrom`, `validateEndpointDraft`, the `draft` / `setDraft` state and the `set(key, value)` setter, `saveError`) — adds reasoning-style and reasoning fields (3d.8 renders neither; `validateEndpointDraft` copies them from the saved endpoint today)
- Modify (harness only): `src/views/advanced.test.tsx:16-30` (api mock) and `:151-159` (`makeStore`), `src/test/a11y.test.tsx:55` (api mock object)
- Test: `src/lib/reasoning-levels.test.ts`, `src/lib/settings-issues.test.ts`, `src/components/settings/analyzer-request-controls.test.tsx`, `src/components/settings/analyzer-endpoints-section.test.tsx` (W3d Task 3d.8, append)

**Interfaces:**
- Consumes: `api.getAnalyzerModels` (W3c mock + real, operationId `getAnalyzerModels`); the account slice's `defaultAnalysisModel` (the current analysis model, `src/store/account-slice.ts`); `saveAccountSettings` (`src/store/account-slice.ts:53-58`); `useAppDispatch`/`useAppSelector` (`src/store`); `engineForModelId` (`src/lib/model-id.ts`, W3a); generated `components['schemas']['ReasoningLevel']`; server fixture `server/src/analyzer/__fixtures__/reasoning-style-levels.json`.
- Produces: `levelsForEndpointStyle`, `REASONING_LEVEL_LABELS`, `REASONING_STYLE_LABELS`, `REASONING_HELP`, `collectCatalogModels`, `ollamaReasoningRows` / `OllamaReasoningRow` (P18), `normalizeOllamaTag` and `normalizeOllamaReasoningMap` (N7: the frontend mirror of the server's `normalizeModelTag`, pinned to `server/src/analyzer/__fixtures__/ollama-tag-cases.json`) (`src/lib/reasoning-levels.ts`); `settingsIssueMessages` (`src/lib/settings-issues.ts`); `AnalyzerRequestControls` (PR 5b adds the payload half to the same component).
- Types (N10): the generated `UserSettings.analyzerReasoningByEngine` maps are `Record<string, string>` (Task 5.2), so the editor keeps saved values as strings and labels an unknown one with its raw value.

**Placement decision.** Advanced settings' sections are generated from `GET /api/config` registry groups (`advanced.tsx:498-636`), and neither setting is a registry knob. The editor therefore renders as its own card above the generated sections, not inside the `analyzer-models` group (which, in mock mode, is not guaranteed to exist). It reads the catalog through `collectCatalogModels`, typed on W3c's `AnalyzerCatalog` (master-contract shape: `groups[].{kind, id, label, status, error?, models[].{id, label, …, offeredReasoningLevels?}}`).

- [ ] **Step 1: Write the failing tests**

`src/lib/reasoning-levels.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import styleLevels from '../../server/src/analyzer/__fixtures__/reasoning-style-levels.json';
import tagCases from '../../server/src/analyzer/__fixtures__/ollama-tag-cases.json';
import {
  collectCatalogModels,
  levelsForEndpointStyle,
  normalizeOllamaReasoningMap,
  normalizeOllamaTag,
  ollamaReasoningRows,
  REASONING_LEVEL_LABELS,
  type ReasoningLevel,
  type ReasoningStyle,
} from './reasoning-levels';
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
      { id: 'q:4b', label: 'Qwen 4B', kind: 'ollama', offeredReasoningLevels: ['model-default', 'off', 'on'] },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', kind: 'gemini', offeredReasoningLevels: ['model-default', 'minimal'] },
    ]);
  });
});

describe('ollamaReasoningRows (P18)', () => {
  const models = [
    { id: 'q:4b', label: 'Qwen 4B', kind: 'ollama' as const, offeredReasoningLevels: ['model-default', 'off', 'on', 'low'] as ReasoningLevel[] },
    { id: 'q:9b', label: 'Qwen 9B', kind: 'ollama' as const, offeredReasoningLevels: ['model-default', 'off', 'on'] as ReasoningLevel[] },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', kind: 'gemini' as const, offeredReasoningLevels: ['model-default', 'minimal'] as ReasoningLevel[] },
  ];
  it('current model first, each model its own levels, and a saved model the catalog no longer lists keeps a row', () => {
    expect(ollamaReasoningRows(models, 'q:9b', { 'old:1b': 'on' })).toEqual([
      { id: 'q:9b', label: 'Qwen 9B', levels: ['model-default', 'off', 'on'], isCurrent: true },
      { id: 'q:4b', label: 'Qwen 4B', levels: ['model-default', 'off', 'on', 'low'], isCurrent: false },
      { id: 'old:1b', label: 'old:1b', levels: ['model-default', 'off', 'on'], isCurrent: false },
    ]);
  });
  it('a saved level stays visible on its own row even when that model no longer offers it', () => {
    expect(ollamaReasoningRows(models, undefined, { 'q:9b': 'low' }).find((r) => r.id === 'q:9b')?.levels).toEqual(['model-default', 'off', 'on', 'low']);
  });
  it('one row per Ollama model id: a catalog qwen3:latest, a saved qwen3 and a current qwen3:latest share one row (N7)', () => {
    const catalog = [
      { id: 'qwen3:latest', label: 'qwen3:latest', kind: 'ollama' as const, offeredReasoningLevels: ['model-default', 'off', 'on', 'low'] as ReasoningLevel[] },
    ];
    expect(ollamaReasoningRows(catalog, 'qwen3:latest', { qwen3: 'low' })).toEqual([
      { id: 'qwen3', label: 'qwen3:latest', levels: ['model-default', 'off', 'on', 'low'], isCurrent: true },
    ]);
  });
  it('a saved value this version does not know stays visible after the known levels (N10)', () => {
    expect(ollamaReasoningRows([], undefined, { 'q:4b': 'xhigh' })[0].levels).toEqual(['model-default', 'off', 'on', 'xhigh']);
  });
});

describe('Ollama tag identity (N7)', () => {
  it.each(tagCases)('normalizeOllamaTag: $tag → $normalized, as the server normaliser does', ({ tag, normalized }) => {
    expect(normalizeOllamaTag(tag)).toBe(normalized);
  });
  it('normalizeOllamaReasoningMap folds a :latest key into its bare tag, the bare key winning', () => {
    expect(normalizeOllamaReasoningMap({ 'qwen3:latest': 'on', qwen3: 'low', 'q:4b': 'off' })).toEqual({ qwen3: 'low', 'q:4b': 'off' });
    expect(normalizeOllamaReasoningMap(undefined)).toEqual({});
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
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'; // `act` added review pass 3, item 7 — the highlight-timer-must-not-stick test advances fake timers
import { accountSlice } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice'; // review pass 2, item 4 — Task 5.6b's stage-preloaded store
import type { Stage } from '../../lib/types';
import { AnalyzerRequestControls } from './analyzer-request-controls';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: { getAnalyzerModels: vi.fn(), putUserSettings: vi.fn() },
}));
const mockModels = vi.mocked(api.getAnalyzerModels);
const mockPut = vi.mocked(api.putUserSettings);

const CATALOG = {
  groups: [
    {
      kind: 'ollama',
      id: 'ollama',
      label: 'Local Ollama',
      status: 'ok',
      models: [
        { id: 'q:4b', label: 'Qwen 4B', offeredReasoningLevels: ['model-default', 'off', 'on', 'low'] },
        { id: 'q:9b', label: 'Qwen 9B', offeredReasoningLevels: ['model-default', 'off', 'on'] },
      ],
    },
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

/* `stage` defaults to a plain 'advanced' stage (no reasoningFocus) so every existing 5.6 case renders
   exactly as before; Task 5.6b's cases pass a stage carrying `reasoningFocus` through the same
   helper, so both share one store-construction path (review pass 2, item 4 — do not add a second
   `makeStore`-shaped helper elsewhere in this file). */
function renderControls(account: Record<string, unknown> = {}, stage: Stage = { kind: 'advanced' }) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer, ui: uiSlice.reducer },
    preloadedState: {
      account: { ...accountSlice.reducer(undefined, { type: '@@INIT' }), ...account },
      ui: { ...uiSlice.reducer(undefined, { type: '@@INIT' }), stage },
    } as never,
  });
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
  it('offers each model only its own levels, the current analysis model first (P18)', async () => {
    renderControls({ defaultAnalysisModel: 'q:9b' });
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-gemini-gemini-3.8-flash')).toBeInTheDocument());
    expect(screen.getAllByTestId(/^analyzer-reasoning-ollama-/).map((el) => el.getAttribute('data-model-id'))).toEqual(['q:9b', 'q:4b']);
    expect(optionValues('analyzer-reasoning-ollama-q:4b')).toEqual(['model-default', 'off', 'on', 'low']);
    expect(optionValues('analyzer-reasoning-ollama-q:9b')).toEqual(['model-default', 'off', 'on']); // low was accepted for q:4b only
    expect(optionValues('analyzer-reasoning-gemini-gemini-3.8-flash')).toEqual(['model-default', 'low', 'medium', 'high']);
    expect(optionValues('analyzer-reasoning-gemini-gemma-4-31b-it')).toEqual(['model-default', 'off', 'on']);
    expect(screen.queryByTestId('analyzer-reasoning-gemini-gemini-9-ultra')).toBeNull();
    expect((screen.getByTestId('analyzer-reasoning-ollama-q:9b') as HTMLSelectElement).value).toBe('off');
    expect(screen.getByText(/A server may accept a level and still ignore it/)).toBeInTheDocument();
  });

  it('saves non-default Ollama and Gemini levels per model only', async () => {
    mockPut.mockResolvedValue({} as never);
    renderControls({ analyzerReasoningByEngine: { ollama: { 'q:9b': 'on' } } });
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-gemini-gemini-3.8-flash')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('analyzer-reasoning-ollama-q:4b'), { target: { value: 'low' } });
    fireEvent.change(screen.getByTestId('analyzer-reasoning-ollama-q:9b'), { target: { value: 'off' } });
    fireEvent.change(screen.getByTestId('analyzer-reasoning-gemini-gemini-3.8-flash'), { target: { value: 'low' } });
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    /* Per model (P18). `off` is the Ollama default, so q:9b, set back to off, is not saved. */
    expect(mockPut.mock.calls[0][0]).toEqual({ analyzerReasoningByEngine: { ollama: { 'q:4b': 'low' }, gemini: { 'gemini-3.8-flash': 'low' } } });
  });

  it('shows the server validation messages when the save is refused', async () => {
    mockPut.mockRejectedValue(
      new Error('User settings save failed (400): {"error":"Invalid user settings.","issues":[{"message":"Gemini reasoning \\"minimal\\" is not available for gemini-3.8-flash (offered: model-default, low, medium, high)."}]}'),
    );
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-ollama-q:4b')).toBeInTheDocument());
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
import { engineForModelId } from './model-id';

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
  /** The catalog group the entry came from; an Ollama tag without ":" would infer as Gemini from its id. */
  kind: AnalyzerCatalog['groups'][number]['kind'];
  offeredReasoningLevels: ReasoningLevel[];
}

/** Every entry of a GET /api/analyzer/models response (W3c `AnalyzerCatalog`, contract
    shape `groups[].models[]`) that carries `offeredReasoningLevels`, in group order. */
export function collectCatalogModels(catalog: Pick<AnalyzerCatalog, 'groups'> | null | undefined): CatalogModelReasoning[] {
  return (catalog?.groups ?? []).flatMap((group) =>
    group.models.flatMap((m) =>
      m.offeredReasoningLevels
        ? [{ id: m.id, label: m.label, kind: group.kind, offeredReasoningLevels: m.offeredReasoningLevels as ReasoningLevel[] }]
        : [],
    ),
  );
}

const OLLAMA_BASE_LEVELS: ReasoningLevel[] = ['model-default', 'off', 'on'];
const LEVEL_ORDER: string[] = ['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high'];

/** N7 — the server's normalizeModelTag (server/src/analyzer/ollama-tag.ts): Ollama treats a bare tag and
    its `:latest` form as one model. Pinned to the server by the shared ollama-tag-cases.json fixture. */
export function normalizeOllamaTag(tag: string): string {
  return tag.endsWith(':latest') ? tag.slice(0, -':latest'.length) : tag;
}

/** N7 — a saved Ollama reasoning map keyed by normalised tag. The server stores it that way; a key saved
    before normalisation, or by hand, is folded in, and the normalised key wins. */
export function normalizeOllamaReasoningMap(saved: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tag, level] of Object.entries(saved ?? {})) {
    const key = normalizeOllamaTag(tag);
    if (tag === key || !(key in out)) out[key] = level;
  }
  return out;
}

export interface OllamaReasoningRow {
  id: string;
  label: string;
  levels: string[];
  isCurrent: boolean;
}

/** P18 — one row per Ollama model: the current analysis model first, then every other model the
    catalog lists, then any model a saved level names that neither covers. Each row offers ITS OWN
    model's levels (the catalog's `offeredReasoningLevels`, else model-default/off/on) plus its saved
    value, so a level accepted for one model is never offered for another, and a stale saved level
    stays visible (the pre-run check refuses it, naming the model). N7: rows are keyed by the
    normalised tag, so `qwen3` and `qwen3:latest` are one row. N10: a saved value this version does not
    know stays visible after the known levels. */
export function ollamaReasoningRows(
  models: CatalogModelReasoning[],
  currentModelId: string | undefined,
  saved: Record<string, string>,
): OllamaReasoningRow[] {
  const listed = models.filter((m) => m.kind === 'ollama');
  const savedByTag = normalizeOllamaReasoningMap(saved);
  const current = currentModelId === undefined ? undefined : normalizeOllamaTag(currentModelId);
  const currentIsOllama =
    currentModelId !== undefined &&
    (listed.some((m) => normalizeOllamaTag(m.id) === current) || engineForModelId(currentModelId) === 'local');
  const ids = [
    ...(currentIsOllama && current !== undefined ? [current] : []),
    ...listed.map((m) => normalizeOllamaTag(m.id)),
    ...Object.keys(savedByTag),
  ].filter((id, i, all) => all.indexOf(id) === i);
  return ids.map((id) => {
    const entry = listed.find((m) => normalizeOllamaTag(m.id) === id);
    const levels = new Set<string>([...(entry?.offeredReasoningLevels ?? OLLAMA_BASE_LEVELS), ...(savedByTag[id] ? [savedByTag[id]] : [])]);
    return {
      id,
      label: entry?.label ?? id,
      levels: [...LEVEL_ORDER.filter((l) => levels.has(l)), ...[...levels].filter((l) => !LEVEL_ORDER.includes(l))],
      isCurrent: id === current,
    };
  });
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
   engine and model (Ollama and Gemini both per model, P18). Saves a PARTIAL patch through
   the account save thunk; server-side validation messages are shown verbatim. */
import { useEffect, useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { saveAccountSettings } from '../../store/account-slice';
import { api } from '../../lib/api';
import {
  REASONING_HELP,
  REASONING_LEVEL_LABELS,
  collectCatalogModels,
  normalizeOllamaReasoningMap,
  ollamaReasoningRows,
  type CatalogModelReasoning,
  type ReasoningLevel,
} from '../../lib/reasoning-levels';
import { settingsIssueMessages } from '../../lib/settings-issues';

const SELECT_CLASS =
  'w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 min-h-[44px] fine-pointer:min-h-0';
export function AnalyzerRequestControls() {
  const dispatch = useAppDispatch();
  const currentModel = useAppSelector((s) => s.account.defaultAnalysisModel);
  const savedOllama = useAppSelector((s) => s.account.analyzerReasoningByEngine?.ollama);
  const savedGemini = useAppSelector((s) => s.account.analyzerReasoningByEngine?.gemini);
  const [models, setModels] = useState<CatalogModelReasoning[]>([]);
  /* N10: saved levels are strings; N7: Ollama rows and their state are keyed by the normalised tag. */
  const [ollama, setOllama] = useState<Record<string, string>>(normalizeOllamaReasoningMap(savedOllama));
  const [gemini, setGemini] = useState<Record<string, string>>(savedGemini ?? {});
  const [errors, setErrors] = useState<string[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => setOllama(normalizeOllamaReasoningMap(savedOllama)), [savedOllama]);
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

  /* P18: one row per Ollama model, each offering only ITS OWN levels; the current analysis model first. */
  const ollamaRows = useMemo(() => ollamaReasoningRows(models, currentModel, ollama), [models, currentModel, ollama]);
  const geminiModels = useMemo(
    () => models.filter((m) => m.kind === 'gemini' && m.offeredReasoningLevels.length > 1),
    [models],
  );

  const onSave = async () => {
    setErrors([]);
    const ollamaPatch = Object.fromEntries(Object.entries(ollama).filter(([, level]) => level !== 'off'));
    const geminiPatch = Object.fromEntries(Object.entries(gemini).filter(([, level]) => level !== 'model-default'));
    const action = await dispatch(saveAccountSettings({ analyzerReasoningByEngine: { ollama: ollamaPatch, gemini: geminiPatch } }));
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

      <div className="space-y-3">
        <span className="block text-sm font-medium text-ink">Ollama reasoning, per model</span>
        <span className="block text-xs text-ink/55">
          Sent as &quot;think&quot;. Off is today&apos;s default. Low / Medium / High appear for a model once that model&apos;s own Test accepted them; a model that doesn&apos;t think rejects On and every level.
        </span>
        {ollamaRows.map((row) => (
          <label key={row.id} className="block">
            <span className="block text-xs text-ink/70">
              {row.label}
              {row.isCurrent ? ' (current analysis model)' : ''}
            </span>
            <select
              data-testid={`analyzer-reasoning-ollama-${row.id}`}
              data-model-id={row.id}
              value={ollama[row.id] ?? 'off'}
              onChange={(e) => setOllama((o) => ({ ...o, [row.id]: e.target.value }))}
              className={`mt-1 ${SELECT_CLASS}`}
            >
              {row.levels.map((l) => (
                <option key={l} value={l}>
                  {REASONING_LEVEL_LABELS[l as ReasoningLevel] ?? l}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {geminiModels.length > 0 && (
        <div className="space-y-3">
          <span className="block text-sm font-medium text-ink">Gemini reasoning, per model</span>
          {geminiModels.map((m) => (
            <label key={m.id} className="block">
              <span className="block text-xs text-ink/70">{m.label}</span>
              <select
                data-testid={`analyzer-reasoning-gemini-${m.id}`}
                value={gemini[m.id] ?? 'model-default'}
                onChange={(e) => setGemini((g) => ({ ...g, [m.id]: e.target.value }))}
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

`src/views/advanced.test.tsx` — add `getAnalyzerModels: vi.fn(() => Promise.resolve({ groups: [] })),` and `putUserSettings: vi.fn(),` to the `api` mock object (`:17-29`; Task 3d.4c already added `getAnalyzerModels` there for the fallback picker — confirm with `git grep -n "getAnalyzerModels" src/views/advanced.test.tsx` rather than a pinned line in 3d.4c's own plan file, so keep its entry and add only `putUserSettings` — corrected 2026-09-13: this was wave 4's Task 4.7 in an earlier draft, but that task was rewritten to consume 3d.4c rather than add anything of its own); add `import { accountSlice } from '../store/account-slice';` and `account: accountSlice.reducer,` to `makeStore`'s reducer (`:153-157`).
`src/test/a11y.test.tsx` — add `getAnalyzerModels: () => Promise.resolve({ groups: [] }),` to the `api` object (`:55`; Task 3d.4c already added it — `git grep -n "getAnalyzerModels" src/test/a11y.test.tsx` confirms; keep that entry if present).

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
- **`ISSUE_FIELDS`/`ENDPOINT_FIELD_TEST_IDS` (review item 5, 2026-09-13).** 3d.8's own note already flags this: "a field with no control yet (`reasoning`, `extraParams` before wave 5) opens the editor without focusing" (`git grep -n "opens the editor without focusing" server/src/components/settings/analyzer-endpoints-section.tsx` locates it in the landed file — do not cite 3d.8's plan-doc line number, which drifts). This task supplies the control for `reasoning`, so it also closes that gap: add `'reasoning'` to `ISSUE_FIELDS` and `reasoning: 'endpoint-reasoning'` to `ENDPOINT_FIELD_TEST_IDS` (both in `src/components/settings/analyzer-endpoints-section.tsx` — `git grep -n "^const ISSUE_FIELDS\|^export const ENDPOINT_FIELD_TEST_IDS"` finds them), in the same file this task already edits. `extraParams` stays unfocusable until Task 5.12 (5b) adds its control.

Append to `src/components/settings/analyzer-endpoints-section.test.tsx`:
```tsx
it('a reasoning-overflow fix deep-link focuses the endpoint reasoning field (#3084 wave 5a)', async () => {
  renderSectionAtHash('#/models?endpoint=lab&field=reasoning'); // or whatever query grammar Task 3d.9's own focus tests already use — match it, don't invent a second one
  await screen.findByTestId('endpoint-row-lab');
  fireEvent.click(screen.getByTestId('endpoint-edit-lab'));
  expect(screen.getByTestId('endpoint-reasoning')).toHaveFocus();
});
```
(`renderSectionAtHash` — reuse whatever helper Task 3d.9's own `maxOutputTokens`/`contextTokens` focus tests already use for this exact mechanism; do not add a second one. If 3d.9's focus tests pre-open the editor rather than requiring the `endpoint-edit-<id>` click shown here, match that flow instead.)

- [ ] **Step 4: Run and confirm they pass**
Run: `npm test -- src/lib/reasoning-levels.test.ts src/lib/settings-issues.test.ts src/components/settings/analyzer-request-controls.test.tsx src/views/advanced.test.tsx src/test/a11y.test.tsx src/components/settings/analyzer-endpoints-section.test.tsx`
Then: `npx playwright test --project=chromium e2e/advanced-settings.spec.ts e2e/advanced-settings-save-error.spec.ts e2e/analyzer-endpoints.spec.ts`
Expected: PASS. Keeps green: `advanced.test.tsx` (group/OverrideRow cases), `a11y.test.tsx` (axe on AdvancedView — the new selects are labelled by their wrapping `<label>`), both Advanced e2e specs, W3d's `analyzer-endpoints-section.test.tsx` cases and `e2e/analyzer-endpoints.spec.ts` (a new endpoint still saves `not_controllable` / `model-default` by default).

- [ ] **Step 5: Mutation proof**
1. In `AnalyzerRequestControls` replace `m.offeredReasoningLevels.map` with `(['model-default','minimal','low','medium','high'] as ReasoningLevel[]).map`. Expected red: `offers each model only its own levels, the current analysis model first (P18)`. Restore.
2. In `onSave` replace `setErrors(settingsIssueMessages(action.error.message ?? ''))` with `setErrors([])`. Expected red: `shows the server validation messages when the save is refused`. Restore.
3. In `AnalyzerEndpointsSection`'s `endpoint-reasoning-style` `onChange`, replace the `levelsForEndpointStyle(reasoningStyle).includes(d.reasoning) ? d.reasoning : 'model-default'` ternary with `d.reasoning`. Expected red: `offers only the selected control style levels and resets an orphaned level`. Restore.
4. In `ollamaReasoningRows` replace `entry?.offeredReasoningLevels ?? OLLAMA_BASE_LEVELS` with `listed.flatMap((m) => m.offeredReasoningLevels)` (a union across models). Expected red: `current model first, each model its own levels…` and `offers each model only its own levels, the current analysis model first (P18)`. Restore.
5. In `onSave` drop the `level !== 'off'` filter from `ollamaPatch`. Expected red: `saves non-default Ollama and Gemini levels per model only` (`'q:9b': 'off'` appears). Restore.
6. In `normalizeOllamaTag` return `tag` unchanged. Expected red: `normalizeOllamaTag: qwen3:latest → qwen3…` and `one row per Ollama model id…` (two rows). Restore.
7. In `ollamaReasoningRows` drop `...[...levels].filter((l) => !LEVEL_ORDER.includes(l))`. Expected red: `a saved value this version does not know stays visible after the known levels (N10)`. Restore.
8. Remove `'reasoning'` from `ISSUE_FIELDS` (or drop the `reasoning` entry from `ENDPOINT_FIELD_TEST_IDS`). Expected red: `a reasoning-overflow fix deep-link focuses the endpoint reasoning field (#3084 wave 5a)`. Restore.

- [ ] **Step 6: Commit**
```bash
git add src/lib/reasoning-levels.ts src/lib/reasoning-levels.test.ts src/lib/settings-issues.ts src/lib/settings-issues.test.ts src/components/settings/analyzer-request-controls.tsx src/components/settings/analyzer-request-controls.test.tsx src/components/settings/analyzer-endpoints-section.tsx src/components/settings/analyzer-endpoints-section.test.tsx src/views/advanced.tsx src/views/advanced.test.tsx src/test/a11y.test.tsx
git add $(git grep -ln "createAnalyzerEndpoint" src/components)
git commit -m "feat(frontend): offer only takeable reasoning levels in Advanced settings and the endpoint form"
```

### Task 5.6b: `AnalyzerRequestControls` scrolls to and highlights a deep-linked model row (F7, Task 5.5c consumer)

**What this closes:** Task 5.5b's `reasoningSetting` fix and Task 5.5c's `#/advanced?reasoningEngine=&reasoningModel=` deep link both exist; this task is where the "How to fix" click actually lands.

**Corrected against the real component (review pass 1, 2026-09-13).** Task 5.6 declares `export function AnalyzerRequestControls()` with **no props** — it reads everything itself, via `useAppSelector`/`useAppDispatch` and an internal `useState<CatalogModelReasoning[]>` populated by an async `api.getAnalyzerModels()` effect (empty until that resolves). Its own tests render `<Provider store={store}><AnalyzerRequestControls /></Provider>`, with no props passed. This task therefore does **not** add a `focusReasoningSetting` prop:
- **Read the focus from the store**, the same way the component already reads `currentModel`/`savedOllama`/`savedGemini`: `const stage = useAppSelector((s) => s.ui.stage); const reasoningFocus = stage.kind === 'advanced' ? stage.reasoningFocus : undefined;` — `advanced.tsx` needs no change at all; it never held the stage or the models list to thread through as a prop.
- **Run the effect when the rows arrive, not only on mount.** The `models` list, and the `ollamaRows`/`geminiModels` derived from it, only exist after the async fetch resolves; a deep link that lands before that resolves must still scroll once the row appears. Depend the highlight effect on `[reasoningFocus, ollamaRows, geminiModels]`, not `[reasoningFocus]` alone.
- **Match an Ollama row by its normalised tag.** `ollamaRows`' ids are already `normalizeModelTag`-normalised (P18/N7, Task 5.6); `reasoningFocus.model` is whatever the URL carried, which may be a bare or `:latest` tag. Normalise it with `normalizeModelTag` (`src/lib/reasoning-levels.ts`, Task 5.6, the frontend mirror of the server's) before comparing.
- **`scrollIntoView` does not exist in jsdom** — call it as `el?.scrollIntoView?.({ block: 'center' })` (the same guarded-call pattern `help.tsx` already uses in this codebase for the same reason: `:167` and `:230` are its two guarded `scrollIntoView?.()` calls — `:221` is a comment, not code, review pass 3, item 8), never `el.scrollIntoView(...)` unguarded.
- **Scroll once per focus value, not on every re-render (review pass 2, item 4).** The stage's `reasoningFocus` persists across unrelated component updates (e.g. editing a different row's select while the deep-link stage is still active), and the effect's own dependency array (`[reasoningFocus, ollamaRows, geminiModels]`) re-runs whenever `ollamaRows`/`geminiModels` change identity — which happens on every keystroke in this component's own selects (they are `useMemo`'d off `models`/`ollama`/`gemini` state, and `ollama`/`gemini` change on every `onChange`). Without a guard, picking a level for one row would re-scroll to and re-highlight the *other*, deep-linked row on every edit. Guard it with a ref, the same pattern `help.tsx` uses for its own one-time scroll:
```tsx
const scrolledForRef = useRef<string | undefined>(undefined);
```
  and check/set it inside the effect (Step 3) so the same `reasoningFocus` value only scrolls once.
- **Corrected, review pass 3, item 7: the highlight must never stick.** The originally-drafted effect returned `() => clearTimeout(t)` as its own cleanup. A `useEffect` cleanup runs before every re-run of that same effect, not just on unmount — and this effect re-runs on every unrelated edit (its deps are `[reasoningFocus, ollamaRows, geminiModels]`, and `ollamaRows`/`geminiModels` change identity on every `onChange` in this component, per the bullet above). So the very first unrelated edit after the highlight lands cancels the pending removal timer in that re-run's cleanup — then the `scrolledForRef.current === key` guard returns early before a new timer is ever set, and the highlight class is never removed. Fix: hold the timer (paired with the element it targets) in a ref that survives re-runs; clear it only from a **separate, mount/unmount-only** effect (empty dependency array); and have the timer's own callback remove the class from its own captured `el`, regardless of how many times the main effect has re-run since it was set. Clear a still-pending previous timer before starting a new one, so back-to-back deep links to the same or a different row can't stack two removal timers. See Step 3.

**Files:**
- Modify: `src/components/settings/analyzer-request-controls.tsx` (Task 5.6) — read `reasoningFocus` from the store; give each rendered Gemini and Ollama `<label>` row a stable `id` (reusing its existing `data-testid` string, not a new format); add the highlight effect and its `scrolledForRef` guard.
- Modify: `src/components/settings/analyzer-request-controls.test.tsx` — extend Task 5.6's `renderControls(account, stage)` helper (Files note above; this task passes its `stage` argument, not a separately-built store).
- Test: `src/components/settings/analyzer-request-controls.test.tsx` (append, rendered via `renderControls(account, stage)`, `api.getAnalyzerModels` mocked, and awaited).

**Interfaces:**
- Consumes: `s.ui.stage` (`{ kind: 'advanced'; reasoningFocus?: { engine; model } }`, Task 5.5c); Task 5.6's `ollamaRows`/`geminiModels` (already computed in the component), `normalizeModelTag` (`src/lib/reasoning-levels.ts`, Task 5.6) and its own `renderControls(account, stage)` test helper (extended by this task, per Task 5.6's Files note — not a second helper).
- Produces: each Ollama `<label>` row gets `id={`analyzer-reasoning-ollama-${row.id}`}` (the same string its `data-testid` already uses); each Gemini `<label>` row gets `id={`analyzer-reasoning-gemini-${m.id}`}`. When `reasoningFocus` names a row present in `ollamaRows`/`geminiModels`, that row's element scrolls into view once per distinct `reasoningFocus` value and carries a highlight class for a few seconds (mirroring `onSave`'s own `setShowSaved` timeout pattern, `2400`ms, already in this file).

- [ ] **Step 1: Write the failing tests**
```tsx
it('scrolls to and highlights the deep-linked Gemini row once its data arrives', async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  mockModels.mockResolvedValue({
    groups: [{ kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok', models: [{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', offeredReasoningLevels: ['model-default', 'minimal', 'low'] }] }],
  } as never);
  renderControls({}, { kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-3.6-flash' } });
  await screen.findByTestId('analyzer-reasoning-gemini-gemini-3.6-flash');
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  expect(document.getElementById('analyzer-reasoning-gemini-gemini-3.6-flash')?.className).toMatch(/ring-2/);
});

it('matches an Ollama row by its normalised tag, not the raw URL value', async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  mockModels.mockResolvedValue({
    groups: [{ kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [{ id: 'qwen3.5:4b', label: 'qwen3.5:4b', offeredReasoningLevels: ['model-default', 'off', 'on'] }] }],
  } as never);
  renderControls({}, { kind: 'advanced', reasoningFocus: { engine: 'ollama', model: 'qwen3.5:4b:latest' } });
  await screen.findByTestId('analyzer-reasoning-ollama-qwen3.5:4b');
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
});

it('does nothing when the deep-linked row is not in the current lists', async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  mockModels.mockResolvedValue({ groups: [] } as never);
  renderControls({}, { kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-9-ultra' } });
  await waitFor(() => expect(mockModels).toHaveBeenCalled());
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it('does not re-scroll on an unrelated edit while the same deep-link stage persists', async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  mockModels.mockResolvedValue(CATALOG as never);
  renderControls({ defaultAnalysisModel: 'q:9b' }, { kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-3.8-flash' } });
  await screen.findByTestId('analyzer-reasoning-gemini-gemini-3.8-flash');
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByTestId('analyzer-reasoning-ollama-q:9b'), { target: { value: 'on' } });
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
});

it('still removes the highlight after an unrelated edit within the highlight window (review pass 3, item 7)', async () => {
  vi.useFakeTimers();
  try {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    mockModels.mockResolvedValue(CATALOG as never);
    renderControls({ defaultAnalysisModel: 'q:9b' }, { kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-3.8-flash' } });
    await screen.findByTestId('analyzer-reasoning-gemini-gemini-3.8-flash');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(document.getElementById('analyzer-reasoning-gemini-gemini-3.8-flash')?.className).toMatch(/ring-2/);
    // An unrelated edit re-runs the highlight effect (ollamaRows/geminiModels change identity)
    // while the removal timer is still pending — this is the exact re-run the old cleanup-based
    // timer could not survive.
    act(() => {
      fireEvent.change(screen.getByTestId('analyzer-reasoning-ollama-q:9b'), { target: { value: 'on' } });
    });
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(document.getElementById('analyzer-reasoning-gemini-gemini-3.8-flash')?.className).not.toMatch(/ring-2/);
  } finally {
    vi.useRealTimers();
  }
});
```
- [ ] **Step 2: Run them and confirm they fail**
Expected: FAIL — no row carries an `id` yet, `reasoningFocus` is read from nowhere, `scrollIntoView` is never called; the new highlight-removal test fails once the others are made to pass first (with the originally-drafted cleanup-based timer, the class is still present after the unrelated edit + advanced timers).
- [ ] **Step 3: Implement**
```tsx
const stage = useAppSelector((s) => s.ui.stage);
const reasoningFocus = stage.kind === 'advanced' ? stage.reasoningFocus : undefined;
const scrolledForRef = useRef<string | undefined>(undefined);
// review pass 3, item 7 — holds the pending removal timer (paired with the element it targets)
// across re-runs of the effect below, so a re-run's cleanup can no longer cancel it.
const highlightTimerRef = useRef<{ el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);

useEffect(() => {
  if (!reasoningFocus) return;
  const key = `${reasoningFocus.engine}:${reasoningFocus.model}`;
  if (scrolledForRef.current === key) return;
  const targetId =
    reasoningFocus.engine === 'ollama'
      ? `analyzer-reasoning-ollama-${normalizeModelTag(reasoningFocus.model)}`
      : `analyzer-reasoning-gemini-${reasoningFocus.model}`;
  const el = document.getElementById(targetId);
  if (!el) return;
  scrolledForRef.current = key;
  el.scrollIntoView?.({ block: 'center' });
  el.classList.add('ring-2', 'ring-magenta/60');
  if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current.timer); // don't stack a second pending removal
  const timer = setTimeout(() => {
    el.classList.remove('ring-2', 'ring-magenta/60');
  }, 2400);
  highlightTimerRef.current = { el, timer };
  // No cleanup returned here — review pass 3, item 7. A cleanup on THIS effect would run before
  // every re-run (not just unmount), which is exactly what let an unrelated edit (ollamaRows/
  // geminiModels changing identity) cancel the timer and then hit the scrolledForRef guard above,
  // so the class was never removed. The timer is cleared only on unmount, below.
}, [reasoningFocus, ollamaRows, geminiModels]);

useEffect(() => {
  return () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current.timer);
  };
}, []);
```
Add `import { normalizeModelTag } from '../../lib/reasoning-levels';` (Task 5.6 already exports it as the frontend mirror of the server's `normalizeModelTag`). On each Ollama `<label key={row.id} …>`, add `id={`analyzer-reasoning-ollama-${row.id}`}`. On each Gemini `<label key={m.id} …>`, add `id={`analyzer-reasoning-gemini-${m.id}`}`.
- [ ] **Step 4: Run and confirm they pass**
- [ ] **Step 5: Mutation proof**
1. Delete the `id={...}` attribute from the Gemini `<label>`. Expected red: `scrolls to and highlights the deep-linked Gemini row once its data arrives` (`getElementById` finds nothing). Restore.
2. Replace `document.getElementById(targetId)` with `document.getElementById(targetId) ?? document.body` (a fallback element that always exists). Expected red: `does nothing when the deep-linked row is not in the current lists` (`scrollIntoView` is now wrongly called, against `document.body`) — red on the assertion, not a `null` `TypeError`. Restore.
3. Remove `normalizeModelTag(...)` from the Ollama branch (compare the raw URL value against `row.id` directly). Expected red: `matches an Ollama row by its normalised tag, not the raw URL value` (`qwen3.5:4b:latest` never equals the normalised `qwen3.5:4b` id). Restore.
4. **Corrected, review pass 2, item 4: this mutation is deterministically red, not "flaky."** Delete the `if (scrolledForRef.current === key) return;` guard (and its `scrolledForRef.current = key;` set — leave the ref declared but unused). Expected red: `does not re-scroll on an unrelated edit while the same deep-link stage persists` (`scrollIntoView` is called a second time on the Ollama `onChange`, since `ollamaRows`/`geminiModels` change identity on every edit and the effect re-runs with no per-value guard to stop it). Restore.
5. **Review pass 3, item 7.** Revert the main effect to its originally-drafted shape: return `() => clearTimeout(t)` from it directly (the cleanup that runs on every re-run, not only unmount) instead of clearing `highlightTimerRef.current.timer` only from the separate mount/unmount-only effect. Expected red: `still removes the highlight after an unrelated edit within the highlight window` (the class is still present after the unrelated edit + `vi.advanceTimersByTime(2400)`, since the re-run's cleanup cancelled the timer and the `scrolledForRef` guard then blocked a new one). Restore.
- [ ] **Step 6: Commit**
```bash
git add src/components/settings/analyzer-request-controls.tsx src/components/settings/analyzer-request-controls.test.tsx
git commit -m "feat(frontend): scroll to and highlight a reasoning-overflow fix's model row in Advanced settings"
```

### Task 5.7: Ship PR 5a

**Files:**
- Modify: `docs/release-notes-next.md` (section `## 🗣️ Analyzer, script review & manuscript`, `:284`), `RELEASE_NOTES.md` (top `# Castwright <in-progress version>` section)
- Modify: `docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md` (F3's "Reasoning" subsection, per server), `docs/wiki/Advanced-Settings.md`, `docs/wiki/Analysis-and-the-Analyzer.md`
- Modify: `docs/testing/onbox-acceptance-register.md` (Groups A, B, E + At-a-glance table), `docs/testing/onbox-acceptance-register-live-view.html`
- Modify: `docs/features/284-openai-compatible-analyzer.md` (the #3084 regression plan created in an earlier wave) — add the reasoning invariants

- [ ] **Step 1: Regenerate and check derived artifacts**
Run: `npm run openapi:types` then `git diff --exit-code src/lib/api-types.ts` — Expected: exit 0 (committed in Task 5.2). No registry knob is added in this PR, so `npm run config:check` must pass unchanged — run it. No `FailureCode` is added either: `git diff --exit-code main -- src/data/help-failures.ts` exits 0, and `npm test -- src/data/help-failures.test.ts src/data/help-categories.test.ts` passes at 28 / 54.

- [ ] **Step 2: Release notes (both files)**
Append to `docs/release-notes-next.md` under `## 🗣️ Analyzer, script review & manuscript`:
```markdown
- **Reasoning controls for every analyzer engine (#3084, wave 5a).** New `analyzerReasoningByEngine` setting, keyed by model id for both engines (Ollama default `off` = today's `think:false`; Gemini default `model-default`) and per-endpoint `reasoningStyle` / `reasoning`. Levels are offered per Gemini model (`thinkingLevel` for the current 3.x Flash family — `minimal`/`low`/`medium`/`high` on 3.5/3.6 Flash and 3.5/3.1 Flash-Lite, `low`/`medium`/`high` on 3.7/3.8 Flash and 3.1 Pro; Gemma 4 on/off via HIGH/MINIMAL; never both `thinkingLevel` and a budget field — Gemini 2.5's `thinkingBudget` control is retired, and a 2.5 id offers `model-default` only, like an unknown id, per owner direction to focus on the current Flash family, F2), per endpoint style (`reasoning_effort` none…high, `chat_template_kwargs.enable_thinking`, not controllable), and for each Ollama model (`low`/`medium`/`high` only after that model's own Test accepted them). Gemini levels that think carry `includeThoughts`. The Test action adds a level step to its ladder: acceptance only, so a thinking model's `length` stop counts as `accepted`, and `rejected` only after a successful control. It also keys schema probes by level. A `rejected` level, or a stored level the rules no longer offer, refuses the run and persona generation before the first call. Stored levels are strings, so a value this version does not know loads without resetting settings and refuses the run too. Reasoning-overflow and pre-run refusal copy name the actual control, and the failure's structured `fixes` (F7) can now point straight at that model's reasoning row: at an explicit level with a real lower rung, Gemini offers a definite "lower the level"; at `model-default` (the common case, and a level Google's own docs don't pin down for every 3.x model) it offers a suggestion to try that model's lowest rung by name; Gemma at its default gets neither, since it is outside the thinking rule there; Ollama always offers "turn reasoning off". All three deep-link to Advanced Settings and scroll to and highlight the row. A Gemini request thinks per its level as well as its model id (P27): a level that turns thinking on (Gemma 4 `on`) gets thought summaries and the thinking window (120 s automatic, F6 — was 240 s), and `off` gets neither. Because Gemma 4 at `on` is then a thinking request, its thought tokens are reasoning evidence and an empty `MAX_TOKENS` answer there fails as `analyzer-reasoning-overflow` instead of splitting the chunk; at Gemma's default level and at `off` nothing asks for thoughts and the #528 split recovery is unchanged. A `thoughtsTokenCount` counts only on a request whose wire sent `includeThoughts`, so a persona (free-text) request at `model-default` counts none. A stored level that reaches a call anyway (a hand-edited settings file) fails that call with the same coded refusal, whose copy says the run stopped rather than that it never started. Saving request controls judges only the entries that change, against the stored settings, so one stale entry never blocks a save; an endpoint update likewise judges its level only when the level or its control style changes. Ollama reasoning keys and Test records use one model id through `normalizeModelTag` (`qwen3` = `qwen3:latest`). A Test merges the verdicts it probed into the model's record for the same server instead of replacing it, each verdict keeping the date of the Test that recorded it; a Test of a re-pulled Ollama tag replaces the record instead of merging into it, so it keeps no verdict that was never probed for the new build. A record W3c filed under `:latest` is found, merged into and rewritten under the canonical tag. (#PR)
```
Add to the top section of `RELEASE_NOTES.md`:
```markdown
- **You can now tell each analyzer how hard to think.** Thinking models spend part of their answer budget reasoning before they write a word, and on a long chapter that can leave nothing for the answer. Advanced settings now has an analyzer reasoning control for each Ollama and Gemini model, and every OpenAI-compatible endpoint has one too — offering only the levels that model or server can actually take. Nothing changes until you pick something: Ollama stays with thinking off, and everything else keeps its own default. The Test button now checks which levels a model accepts, and a level it refused stops a run before it starts instead of failing a chapter in. One honest caveat, shown right next to the setting: a server can accept a level and quietly ignore it, and Castwright has no way to see that. And when a model spends its whole answer budget thinking and writes nothing, Castwright says so and stops, instead of cutting the chapter into ever smaller pieces that fail the same way.
```
Replace `(#PR)` with the PR number once opened.

- [ ] **Step 2b: Wiki (F3)**
Add: `docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md` — a "Reasoning" subsection, per server (llama.cpp/llama-server, llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter — F3's outline §3), each saying which `reasoningStyle` to pick and with one worked example (a launch flag or request body showing the field this wave's `reasoningWireFragment` sends: `reasoning_effort` or `chat_template_kwargs.enable_thinking`). Take verified facts from `docs/superpowers/specs/2026-09-11-openai-compatible-analyzer-planning-facts.md`; mark anything unverified "verify at implementation"; each example records the tool version it was checked against (F3's acceptance criterion). **Corrected (review pass 1, 2026-09-13): add no second "When a model thinks past its output limit" heading.** Task 3d.9a already writes that heading on this same page (`git grep -n "When a model thinks past its output limit" docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md` confirms once 3d.9a has landed — do not cite a pinned line in 3d.9a's own plan file, which drifts), and Task 5.5b's endpoint reasoning fix points at the page via `wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints'` only (no anchor — `wikiHref` is retired, wave 3 review), so nothing here needs a matching anchor. This step's "Reasoning" subsection may itself cross-reference 3d.9a's existing heading in prose, but does not duplicate it.
Modify: `docs/wiki/Advanced-Settings.md` and `docs/wiki/Analysis-and-the-Analyzer.md`, wherever they document the Settings rows this wave adds — the per-engine reasoning editor (Task 5.6) and the endpoint form's Reasoning field — with the 3.x Flash levels (F2) and the note that Gemini 2.5 offers `model-default` only. `scripts/tests/knob-docs-sync.test.mjs` (#2012, `test:hooks`) checks registry-knob labels only, not this per-model editor, so it does not gate this step — but it does gate any registry knob this wave's tasks touch (none in 5a).
- [ ] **Step 3: On-box acceptance rows (CLAUDE.md Before-shipping step 3)**
Allocate each ID from its group's `<!-- next-id: … -->` marker **at ship time** (never a hard-coded number) and bump the marker in the same commit. Add one row per group:
- **Group E** (no GPU box; needs a Gemini API key): *"#3084 5a — Gemini reasoning levels take effect."* Observe: Test (`scope: all`) on `gemini-3.6-flash`, `gemini-3.8-flash` and `gemma-4-31b-it` records every offered level `accepted` (a `length` stop on a level step still counts; note `gemini-3.8-flash` correctly refuses `minimal`); a stage-2 chapter on `gemini-3.6-flash` at `model-default` reports `thoughtsTokenCount` per its id-rule default, and at `high` reports a larger count; `gemma-4-31b-it` at `off` vs `on` differs in thought tokens. A `gemini-2.5-*` id offers `model-default` only (F2 — 2.5's `thinkingBudget` control is retired) and needs no row here. **A8 — the owed fact:** record whether the Gemma `on` step is `accepted`, i.e. whether the API takes `thinkingLevel: HIGH` together with `includeThoughts` (unconfirmed; planning facts §C.2). If it is `rejected`, the `on` fragment must drop `includeThoughts` and keep `thinkingLevel: HIGH` — record that Gemma `on` then reports no thought tokens, so its truncations split like its default level (G1's overflow no longer applies there), which is a decision to reopen rather than a silent change. **G1:** on a chapter long enough to exhaust the cap, record what Gemma `on` does with an empty `MAX_TOKENS` answer (expected: `analyzer-reasoning-overflow`, the run stops) against the same chapter at Gemma's default level (expected: the chunk splits and recovers, #528). Criteria: this plan Task 5.1 table + spec §8.
- **Group B** (local Ollama only): *"#3084 5a — Ollama reasoning levels and Test attribution."* Observe: on a non-thinking tag, Test `scope: all` records `on`/`low`/`medium`/`high` `rejected` and `off`/`model-default` `accepted`; on a thinking tag (e.g. `qwen3.5:4b`), `low` is `accepted` and then appears in that model's own row of Advanced settings' Ollama reasoning list, and not in the non-thinking tag's row; a run with a `rejected` level fails before the first chapter with the refusal copy naming the level and the date of the Test that recorded that verdict. **A2 — the merge-replaces-on-digest-change rule on a real daemon:** after a Test (`scope: all`), re-pull the same tag so its build changes (`ollama pull <tag>`; confirm `ollama list` shows a new digest), then Test `scope: configured` and record that the stored record keeps only the verdict this Test probed — the earlier levels are gone rather than carried onto a different build.
- **Group A** (GPU box with llama-swap): *"#3084 5a — endpoint reasoning styles on llama-swap."* Observe: a `reasoning_effort` endpoint at `none` streams no `reasoning_content` deltas for a Qwen3.6 model and at `high` streams them (visible as `reasoningSeen` / the route heartbeat continuing before answer text); an `enable_thinking` endpoint at `off`/`on` shows the same split; the schema probe at `on` records `enforced` or `ignored` and the run label shows "schema (not enforced)" only for the level recorded `ignored`.
Update the At-a-glance `Rows` counts for A, B and E (+1 each), then run `npm run register:build` and `npm run check:onbox-register` (both must pass). Edit `docs/testing/onbox-acceptance-register-live-view.html` with the same three rows, then follow the register's "Live view" four-step procedure: save the page live at the recorded URL, run `npm run check:onbox-register -- --against-published <saved file>`, and publish **this html file** with that recorded `url` (never without it, never the `.md`).

- [ ] **Step 4: Plan doc**
In `docs/features/284-openai-compatible-analyzer.md`, add to its invariants section:
- levels offered per family/style (Task 5.1 table) and per Ollama model (P18);
- defaults preserve today's wire;
- the reasoning table covers only the 3.x Flash family and Gemma 4; `thinkingBudget`/2.5 is retired (F2), so a 2.5 id offers `model-default` only; `includeThoughts` beside every Gemini level that thinks (P19);
- level steps accept any finish (P7), and `rejected` is recorded only after a successful control;
- pre-run refusal of a `rejected` level or of a stored level no longer offered or unknown (P17, N10), for runs and personas, classified by the target's engine (N5);
- a Gemini request's thought summaries and thinking window follow `geminiRequestThinks(model, level)` (P27), and a `thoughtsTokenCount` is evidence only when that request's wire sent `includeThoughts` — so Gemma at `on` overflows where Gemma at its default level splits (G1, A3);
- a save judges only the request-control entries it changes, against `readUserSettings()` (N6), and an endpoint update only the level (and, from 5b, the payload) it changes (A7);
- one Ollama model id (`normalizeModelTag`) for reasoning keys, rows, record lookups and the persona model (N7);
- a Test merges its verdicts into the model's record for the same server (N14) and the same model build, each verdict keeping its own date, with a differing `digest` replacing the record (A2);
- a stored level that reaches a call anyway is the same coded refusal, marked `mid-run` (N10);
- reasoning-overflow structured fixes (F7): `AnalysisFailureFix.reasoningSetting` (additive widening of wave 2's type) names an engine/model pair with no registry key or endpoint; at an explicit Gemini level, "lower the level" is offered only when the row has a real level strictly below it (`row.levels.indexOf(current) > 1`); at `model-default` on a `thinkingLevel` row (the common case), a suggestion names that row's lowest rung (`row.levels[1]`) instead, since the default's own level is unstated; a `gemmaOnOff` row at `model-default` gets neither, being outside the thinking rule (P27); Ollama's "turn off" fix is unconditional; the endpoint fix is unchanged (`endpointField: { field: 'reasoning' }`); the frontend deep-links via Task 5.5c's `#/advanced?reasoningEngine=&reasoningModel=` and Task 5.6b's scroll-and-highlight;
- the three register row IDs. Status stays `active`.

- [ ] **Step 5: Verify**
Run: `npm run typecheck`, `npm run check:cycles`, `npm run verify:fast:branch`  Expected: all PASS.

- [ ] **Step 6: Commit, push, PR, review gate**
```bash
git add docs/release-notes-next.md RELEASE_NOTES.md docs/testing/onbox-acceptance-register.md docs/testing/onbox-acceptance-register-live-view.html docs/features/284-openai-compatible-analyzer.md
git commit -m "docs(docs): release notes, on-box rows and plan invariants for analyzer reasoning controls"
git push -u origin feat/server-3084-w5a-reasoning
```
PR title: `feat(server,frontend,openapi): reasoning controls for every analyzer engine`. Body: `## Summary` (the release-notes-next entry), `## Test plan` (each task's test files, the mutation-proof red outputs from Tasks 5.1–5.6, the three register rows with their IDs), `Refs #3084`, and "Also fixed, found in passing: …" if any finding was fixed. Run the `pr-review-gate` skill at **high** depth (multi-scope); fold findings, re-review per the skill's loop.

---

### PR 5b — Custom request payload

- **Branch:** `feat/server-3084-w5b-payload` — `node scripts/wt-new.mjs feat/server-3084-w5b-payload`, cut after PR 5a merges.
- **Delivers:** `server/src/analyzer/runner/extra-params.ts` (validation, merge, temperature precedence, output-cap detection, redaction); `analyzerExtraParamsByEngine` (Ollama, Gemini) and endpoint `extraParams` validated on save, an update judging its payload only when the payload or the reasoning style changes (A7); a persona (free-text) request carrying the payload without its output-cap keys (A4); every transport merges the payload last; a payload temperature sets attempt 1 only; a payload output cap (llama.cpp `n_predict` included) disables Auto, the label says so and overflow copy names the key; Gemini `safetySettings` shape and prototype keys (`__proto__`, `constructor`, `prototype`) validated at save and filtered at merge; payload string values ≥ 8 chars redacted from the errors of the request that carried them, in all three transports (P29), never through the global known secrets; payload never logged or persisted; editors in Advanced settings and the endpoint form; run label "+ custom params" with the e2e assertion; `Closes #3084`.
- **Must NOT change:** any request for a user with no payload (byte-identical bodies); reasoning or structured-output behaviour; the retry policies' own temperatures; persisted analyzer file formats.
- **Entry:** PR 5a merged.
- **Exit:** all tasks green; `npm run typecheck`, `npm run check:cycles`, `npm run verify:fast:branch`, `npx playwright test --project=chromium e2e/analyzer-endpoints.spec.ts` green; `pr-review-gate` at **high** depth; on-box rows added; issue #3084 closes on merge.

**Spec gaps this PR resolves (recorded, not re-litigated):**
- **Gemini top level and `config` (P16).** The SDK request's top-level keys are `model` and `contents` (both pipeline-owned) and `config`. So a Gemini payload may contain only `config`, and any other top-level key is refused, naming it. Inside `config` the payload is an allowlist (spec §9, `GEMINI_CONFIG_ALLOWLIST`).
- **`chat_template_kwargs` is merged key by key.** With `reasoningStyle: enable_thinking` the transport owns `chat_template_kwargs.enable_thinking` (a protected key). A top-level replace would silently delete it when a payload sets another template kwarg, so the OpenAI transport treats `chat_template_kwargs` as its owned container (merged key by key; `null` on the container refused), exactly like Ollama `options` / Gemini `config`.
- **Payload output cap on endpoints.** When a payload sets or nulls `max_tokens` or `max_completion_tokens`, the transport's own `max_tokens` is dropped before the merge — otherwise an OpenAI reasoning model receives both fields. For Ollama and Gemini the key-by-key merge already replaces or removes the native key.
- **Temperature precedence** is implemented by the runner removing the payload's temperature key from the attempt-2 request (`stripPayloadTemperature`), so the transport's native temperature — the retry policy's — stands. `TransportRequest` is unchanged.
- **Persona requests and the payload output cap (A4).** Free text takes the model's own length (W4), so a payload cap chosen for chapter work would silently truncate a voice description. `runFreeText` sends the payload through `withoutPayloadOutputCap`, which drops exactly the keys `payloadOutputCapKey` names, and keeps every other key. A persona length stop keeps today's behaviour: text is kept, and an empty answer with reasoning evidence is the overflow.

### Task 5.8: `extra-params.ts` — validation, merge, temperature, output cap, redaction

**Files:**
- Create: `server/src/analyzer/runner/extra-params.ts`
- Create: `server/src/analyzer/__fixtures__/extra-params-cases.json`
- Test: `server/src/analyzer/runner/extra-params.test.ts`

**Interfaces:**
- Consumes:
  - `TransportKind` (`errors.ts`);
  - W3b's `redactKnownSecrets` and `REDACTED` (`server/src/analyzer/redact.ts`, Task 3b.1). Payload values go through that one redaction function (same marker, same 8-character floor), passed per request (P29, Task 5.11), never through the global known-secrets list.
- Produces:
  - Contract:
    - `validateExtraParams`;
    - `mergeExtraParams(kind, native, params, ctx?)` — **contract extension**: an optional `ctx: { reasoningStyle? }`, so the merge can re-apply the `enable_thinking` rule;
    - `payloadControlsOutputCap`, `redactPayloadValues`;
    - `PROTECTED_KEYS` — Gemini lists only `model` and `contents`, because its `config` is an allowlist.
  - **New:**
    - `GEMINI_CONFIG_ALLOWLIST` (P16), `filterStoredPayload(kind, params, ctx?): { value, dropped }` (P17; `params` and `value` may be `undefined`, per the contract), `payloadOutputCap(kind, params): number | null | undefined` (P19; endpoints also recognise llama.cpp's `n_predict`, N9), `payloadSecretValues(params)` (P22, passed per request, P29);
    - `OWNED_CONTAINERS`, `stripPayloadTemperature(kind, params)`, `requestControlsLabelParts(kind, params)`, `resolveExtraParamsSetting(settings, sel)`, `payloadOutputCapKey(kind, params)` (N13: the payload key that sets the cap);
  - Save-time and merge-time rules added this round: a Gemini `config.safetySettings` must be an array of `{ category, threshold }` strings (N11), and `__proto__`, `constructor` and `prototype` keys are refused at save and dropped at merge at any depth (N12).
    - a re-export of W3b's `REDACTED`.

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
  { "kind": "openai", "params": { "n_predict": 1024 }, "controlsOutputCap": true, "labelParts": ["+ custom params", "max output set by custom params"] },
  { "kind": "ollama", "params": {}, "controlsOutputCap": false, "labelParts": [] }
]
```

`server/src/analyzer/runner/extra-params.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import cases from '../__fixtures__/extra-params-cases.json' with { type: 'json' };
import {
  GEMINI_CONFIG_ALLOWLIST,
  OWNED_CONTAINERS,
  PROTECTED_KEYS,
  REDACTED,
  filterStoredPayload,
  mergeExtraParams,
  payloadControlsOutputCap,
  payloadOutputCap,
  payloadOutputCapKey,
  payloadSecretValues,
  redactPayloadValues,
  requestControlsLabelParts,
  resolveExtraParamsSetting,
  stripPayloadTemperature,
  validateExtraParams,
} from './extra-params.js';
import type { TransportKind } from '../errors.js';

const geminiRefusal = (paths: string) =>
  `Gemini "config" accepts only temperature, topP, topK, maxOutputTokens, presencePenalty, frequencyPenalty, seed, safetySettings. Refused: ${paths}.`;

describe('protected keys are exactly spec §9; Gemini config is an allowlist (P16)', () => {
  it('per transport', () => {
    expect(PROTECTED_KEYS.openai).toEqual([
      'model', 'messages', 'stream', 'stream_options', 'n', 'stop', 'tools', 'tool_choice', 'response_format', 'grammar', 'json_schema',
      'reasoning_effort', 'reasoning', 'reasoning_format', 'reasoning_budget_tokens', 'thinking_budget_tokens', 'include_reasoning',
    ]);
    expect(PROTECTED_KEYS.ollama).toEqual(['model', 'messages', 'stream', 'format', 'think', 'keep_alive', 'tools', 'options.num_ctx', 'options.num_gpu', 'options.main_gpu', 'options.stop']);
    expect(PROTECTED_KEYS.gemini).toEqual(['model', 'contents']);
    expect(GEMINI_CONFIG_ALLOWLIST).toEqual(['temperature', 'topP', 'topK', 'maxOutputTokens', 'presencePenalty', 'frequencyPenalty', 'seed', 'safetySettings']);
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
      ok: false, errors: [geminiRefusal('config.thinkingConfig')],
    });
  });
  it('Gemini config is an allowlist: httpOptions (and everything nested in it) and stopSequences are refused by name (P16)', () => {
    expect(
      validateExtraParams(
        'gemini',
        { config: { httpOptions: { baseUrl: 'http://evil', headers: { 'x-goog-api-key': 'k' }, extraBody: { contents: [] }, retryOptions: { attempts: 5 }, timeout: 1 } } },
        {},
      ),
    ).toEqual({ ok: false, errors: [geminiRefusal('config.httpOptions')] });
    expect(validateExtraParams('gemini', { config: { stopSequences: ['}'] } }, {})).toEqual({ ok: false, errors: [geminiRefusal('config.stopSequences')] });
    const allowed = {
      config: {
        temperature: 0.4, topP: 0.9, topK: 40, maxOutputTokens: 2048, presencePenalty: 0.1, frequencyPenalty: 0.1, seed: 7,
        safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
      },
    };
    expect(validateExtraParams('gemini', allowed, {})).toEqual({ ok: true, value: allowed });
  });
  it('refuses every endpoint reasoning key and the added Ollama keys (A8)', () => {
    expect(
      validateExtraParams('openai', { reasoning: { effort: 'high' }, reasoning_format: 'none', reasoning_budget_tokens: 0, thinking_budget_tokens: 0, include_reasoning: false, top_k: 40 }, {}),
    ).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: reasoning, reasoning_format, reasoning_budget_tokens, thinking_budget_tokens, include_reasoning.'],
    });
    expect(validateExtraParams('ollama', { tools: [], options: { main_gpu: 1, min_p: 0.05 } }, {})).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: tools, options.main_gpu.'],
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

describe('Gemini safetySettings shape (N11)', () => {
  const REFUSAL = '"config.safetySettings" must be an array of objects with only a string "category" and a string "threshold".';
  it('refuses an entry with any other field, such as method, naming the key', () => {
    expect(
      validateExtraParams('gemini', { config: { safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE', method: 'SEVERITY' }] } }, {}),
    ).toEqual({ ok: false, errors: [REFUSAL] });
  });
  it('refuses a non-array and a non-string threshold, naming the key', () => {
    expect(validateExtraParams('gemini', { config: { safetySettings: { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' } } }, {})).toEqual({
      ok: false,
      errors: [REFUSAL],
    });
    expect(validateExtraParams('gemini', { config: { safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 4 }] } }, {})).toEqual({
      ok: false,
      errors: [REFUSAL],
    });
  });
  it('accepts an empty list, and null (which removes the key)', () => {
    expect(validateExtraParams('gemini', { config: { safetySettings: [] } }, {}).ok).toBe(true);
    expect(validateExtraParams('gemini', { config: { safetySettings: null } }, {}).ok).toBe(true);
  });
  it('drops a stored invalid safetySettings at merge and reports its path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = mergeExtraParams(
      'gemini',
      { model: 'g', config: { temperature: 0.2 } },
      { config: { safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE', method: 'SEVERITY' }], topK: 40 } },
    );
    expect(out).toEqual({ model: 'g', config: { temperature: 0.2, topK: 40 } });
    expect(String(warn.mock.calls[0][0])).toContain('config.safetySettings');
    warn.mockRestore();
  });
});

describe('prototype keys (N12)', () => {
  const poisoned = () =>
    JSON.parse('{"__proto__":{"polluted":true},"top_k":1,"nested":{"constructor":{"x":1},"ok":2},"list":[{"prototype":3,"k":4}]}') as Record<string, unknown>;
  it('filterStoredPayload drops them at any depth, reports each path, and never sets a prototype', () => {
    const { value, dropped } = filterStoredPayload('openai', poisoned());
    expect(dropped).toEqual(['__proto__', 'nested.constructor', 'list[0].prototype']);
    expect(JSON.stringify(value)).toBe('{"top_k":1,"nested":{"ok":2},"list":[{"k":4}]}');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect((value as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
  it('validateExtraParams refuses them, naming each path', () => {
    expect(validateExtraParams('openai', poisoned(), {})).toEqual({
      ok: false,
      errors: ['Keys named __proto__, constructor or prototype are not allowed: __proto__, nested.constructor, list[0].prototype.'],
    });
  });
  it('filterStoredPayload of no payload is no payload', () => {
    expect(filterStoredPayload('openai', undefined)).toEqual({ value: undefined, dropped: [] });
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
    /* N9 — llama.cpp's n_predict is an output cap too, so the transport's max_tokens gives way to it. */
    expect(mergeExtraParams('openai', { max_tokens: 8192 }, { n_predict: 1024 })).toEqual({ n_predict: 1024 });
  });
  it('returns the native request unchanged with no payload', () => {
    const native = { model: 'm' };
    expect(mergeExtraParams('openai', native, undefined)).toBe(native);
  });
});

describe('mergeExtraParams re-applies the rules to a stored payload (P16, P17)', () => {
  it('drops protected keys and logs their names, never their values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const native = { model: 'q', think: false, keep_alive: -1, options: { num_ctx: 32768, num_gpu: 0, temperature: 0.2 } };
    const out = mergeExtraParams('ollama', native, {
      think: true,
      keep_alive: 'stored-secret-keepalive',
      tools: [{ type: 'function' }],
      options: { num_ctx: 2048, num_gpu: 99, main_gpu: 1, min_p: 0.05 },
    });
    expect(out).toEqual({ model: 'q', think: false, keep_alive: -1, options: { num_ctx: 32768, num_gpu: 0, temperature: 0.2, min_p: 0.05 } });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    for (const name of ['think', 'keep_alive', 'tools', 'options.num_ctx', 'options.num_gpu', 'options.main_gpu']) expect(line).toContain(name);
    expect(line).not.toContain('stored-secret-keepalive');
    warn.mockRestore();
  });
  it('a stored null on an owned container is ignored: options keeps num_ctx and num_gpu 0', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mergeExtraParams('ollama', { options: { num_ctx: 32768, num_gpu: 0 } }, { options: null })).toEqual({ options: { num_ctx: 32768, num_gpu: 0 } });
    expect(mergeExtraParams('gemini', { model: 'g', config: { temperature: 0.2 } }, { config: null })).toEqual({ model: 'g', config: { temperature: 0.2 } });
    expect(mergeExtraParams('openai', { chat_template_kwargs: { enable_thinking: false } }, { chat_template_kwargs: null })).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    vi.restoreAllMocks();
  });
  it('Gemini: only allowlisted config keys survive; httpOptions, stopSequences and other top-level keys never do', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = mergeExtraParams(
      'gemini',
      { model: 'g', contents: [], config: { temperature: 0.2 } },
      { model: 'evil', labels: { a: 'b' }, config: { httpOptions: { baseUrl: 'http://evil' }, stopSequences: ['}'], topK: 40 } },
    );
    expect(out).toEqual({ model: 'g', contents: [], config: { temperature: 0.2, topK: 40 } });
    expect(JSON.stringify(out)).not.toContain('evil');
    vi.restoreAllMocks();
  });
  it('drops endpoint reasoning keys, and enable_thinking only under the enable_thinking style', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mergeExtraParams('openai', { reasoning_effort: 'none' }, { reasoning_effort: 'high', reasoning_budget_tokens: 9000, include_reasoning: true, top_k: 40 })).toEqual({
      reasoning_effort: 'none',
      top_k: 40,
    });
    const native = { chat_template_kwargs: { enable_thinking: false } };
    expect(mergeExtraParams('openai', native, { chat_template_kwargs: { enable_thinking: true } }, { reasoningStyle: 'enable_thinking' })).toEqual(native);
    expect(mergeExtraParams('openai', native, { chat_template_kwargs: { enable_thinking: true } }, { reasoningStyle: 'reasoning_effort' })).toEqual({
      chat_template_kwargs: { enable_thinking: true },
    });
    vi.restoreAllMocks();
  });
});

describe('payloadOutputCap (P19)', () => {
  it.each<[TransportKind, Record<string, unknown> | undefined, number | null | undefined]>([
    ['ollama', { options: { num_predict: 512 } }, 512],
    ['ollama', { options: { num_predict: -1 } }, null],
    ['ollama', { options: { min_p: 0.05 } }, undefined],
    ['openai', { max_completion_tokens: 4096 }, 4096],
    ['openai', { max_tokens: 8192, max_completion_tokens: 4096 }, 4096],
    ['openai', { max_tokens: null }, null],
    ['openai', { n_predict: 1024 }, 1024],
    ['openai', { n_predict: -1 }, null],
    ['gemini', { config: { maxOutputTokens: 2048 } }, 2048],
    ['gemini', undefined, undefined],
  ])('%s %j → %s', (kind, params, cap) => {
    expect(payloadOutputCap(kind, params)).toBe(cap);
  });
});

describe('payloadOutputCapKey (N13)', () => {
  it.each<[TransportKind, Record<string, unknown> | undefined, string | undefined]>([
    ['ollama', { options: { num_predict: 512 } }, 'options.num_predict'],
    ['gemini', { config: { maxOutputTokens: 2048 } }, 'config.maxOutputTokens'],
    ['openai', { max_tokens: 8192, max_completion_tokens: 4096 }, 'max_completion_tokens'],
    ['openai', { n_predict: 1024 }, 'n_predict'],
    ['openai', { max_tokens: null }, 'max_tokens'],
    ['openai', { top_k: 40 }, undefined],
    ['openai', undefined, undefined],
  ])('%s %j → %s', (kind, params, key) => {
    expect(payloadOutputCapKey(kind, params)).toBe(key);
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
  it("payloadSecretValues lists every string value and its escaped form (the 8-character floor is W3b's)", () => {
    expect(payloadSecretValues({ a: 'json', b: { c: ['say "hi" there'] } })).toEqual(['json', 'say "hi" there', 'say \\"hi\\" there']);
  });
});

describe('settings helpers', () => {
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
/* #3084 wave 5 (D9, spec §9) — custom request payload. No settings or I/O
   (the one log line is noted below). Every structural parameter type is satisfied by UserSettings
   / AnalyzerEndpoint without importing them (workspace/analyzer-request-controls
   imports this module).

   Privacy contract (spec §9, plan Global Constraints): callers never log a
   payload and never write one to an analyzer file; the error text a transport
   builds for a request is redacted against THAT request's payload values
   (payloadSecretValues, P29) before it is logged, thrown or displayed.
   The one log line: mergeExtraParams logs the NAMES of stored keys it drops
   (P17), never their values. */
import type { TransportKind } from '../errors.js';
import { redactKnownSecrets } from '../redact.js';

/* P22, P29: payload values are redacted by W3b's one mechanism (same marker, same 8-character floor), from the
   errors of the request that carried them only; they never join the global known-secrets list. */
export { REDACTED } from '../redact.js';

type ReasoningStyle = 'reasoning_effort' | 'enable_thinking' | 'not_controllable';
type Json = Record<string, unknown>;

/** The one container per transport that is merged key by key (never replaced). */
export const OWNED_CONTAINERS: Record<TransportKind, readonly string[]> = {
  ollama: ['options'],
  gemini: ['config'],
  openai: ['chat_template_kwargs'],
};

export const PROTECTED_KEYS: Record<TransportKind, readonly string[]> = {
  openai: [
    'model', 'messages', 'stream', 'stream_options', 'n', 'stop', 'tools', 'tool_choice', 'response_format', 'grammar', 'json_schema',
    'reasoning_effort', 'reasoning', 'reasoning_format', 'reasoning_budget_tokens', 'thinking_budget_tokens', 'include_reasoning',
  ],
  ollama: ['model', 'messages', 'stream', 'format', 'think', 'keep_alive', 'tools', 'options.num_ctx', 'options.num_gpu', 'options.main_gpu', 'options.stop'],
  /* Gemini's top level holds only these two; its `config` is an ALLOWLIST (GEMINI_CONFIG_ALLOWLIST, P16). */
  gemini: ['model', 'contents'],
};

/** P16 — the only `config` keys a Gemini payload may set. Everything else is refused, including
    `httpOptions` (the installed SDK applies its baseUrl / headers / extraBody / retryOptions / timeout
    per request, so it could send the API key to another host or reinject any owned field) and
    `stopSequences` (the parser owns where an answer ends). */
export const GEMINI_CONFIG_ALLOWLIST = [
  'temperature', 'topP', 'topK', 'maxOutputTokens', 'presencePenalty', 'frequencyPenalty', 'seed', 'safetySettings',
] as const;
const ENABLE_THINKING_KEY = 'chat_template_kwargs.enable_thinking';

function protectedKeySet(kind: TransportKind, ctx: { reasoningStyle?: ReasoningStyle }): Set<string> {
  const set = new Set<string>(PROTECTED_KEYS[kind]);
  if (kind === 'openai' && ctx.reasoningStyle === 'enable_thinking') set.add(ENABLE_THINKING_KEY);
  return set;
}

function geminiConfigAllows(key: string): boolean {
  return (GEMINI_CONFIG_ALLOWLIST as readonly string[]).includes(key);
}

/* N9 — llama.cpp's native `n_predict` is an endpoint output cap too: a payload that sets it disables Auto
   and feeds capacity, like `max_tokens` / `max_completion_tokens`. */
const OUTPUT_CAP: Record<TransportKind, { container: string | null; keys: readonly string[] }> = {
  openai: { container: null, keys: ['max_tokens', 'max_completion_tokens', 'n_predict'] },
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

/* N12 — keys that would reach an object's prototype instead of the object when assigned. */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** N12 — an own data property, never a setter: `target['__proto__'] = v` would set the prototype instead. */
function setOwn(target: Json, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** N12 — a copy of a payload value with `__proto__` / `constructor` / `prototype` keys removed at every
    depth; each removed key path is appended to `dropped` (array items as `list[0]`). */
function withoutPrototypeKeys(value: unknown, path: string, dropped: string[]): unknown {
  if (Array.isArray(value)) return value.map((item, i) => withoutPrototypeKeys(item, `${path}[${i}]`, dropped));
  if (!isPlainObject(value)) return value;
  const out: Json = {};
  for (const [key, inner] of Object.entries(value)) {
    const innerPath = path === '' ? key : `${path}.${key}`;
    if (PROTOTYPE_KEYS.has(key)) {
      dropped.push(innerPath);
      continue;
    }
    setOwn(out, key, withoutPrototypeKeys(inner, innerPath, dropped));
  }
  return out;
}

const SAFETY_SETTINGS_REFUSAL =
  '"config.safetySettings" must be an array of objects with only a string "category" and a string "threshold".';

/** N11 — the SDK sends each safetySettings entry as given, and an unknown field (e.g. `method`) or a
    non-array makes every request fail. Only an array of { category, threshold } strings is accepted. */
function isSafetySettings(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainObject(entry) &&
        Object.keys(entry).every((k) => k === 'category' || k === 'threshold') &&
        typeof entry.category === 'string' &&
        typeof entry.threshold === 'string',
    )
  );
}

export function validateExtraParams(
  kind: TransportKind,
  params: unknown,
  ctx: { reasoningStyle?: ReasoningStyle },
): { ok: true; value: Json } | { ok: false; errors: string[] } {
  if (!isPlainObject(params)) {
    return { ok: false, errors: ['Custom parameters must be a JSON object, for example {"top_k": 40}.'] };
  }
  const protectedSet = protectedKeySet(kind, ctx);
  const hits: string[] = [];
  const notAllowed: string[] = [];
  const errors: string[] = [];
  /* N12 — refused at save by path, at any depth; mergeExtraParams drops the same keys from a stored payload. */
  const prototypePaths: string[] = [];
  withoutPrototypeKeys(params, '', prototypePaths);
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
        const path = `${key}.${inner}`;
        if (kind === 'gemini') {
          if (!geminiConfigAllows(inner)) notAllowed.push(path);
          else if (inner === 'safetySettings' && value[inner] !== null && !isSafetySettings(value[inner])) {
            errors.push(SAFETY_SETTINGS_REFUSAL); // N11
          }
        } else if (protectedSet.has(path)) {
          hits.push(path);
        }
      }
      continue;
    }
    if (kind === 'gemini' && !PROTOTYPE_KEYS.has(key)) {
      errors.push(`"${key}" is not a Gemini request field — put generation options inside "config".`);
    }
  }
  if (prototypePaths.length > 0) {
    errors.push(`Keys named __proto__, constructor or prototype are not allowed: ${prototypePaths.join(', ')}.`);
  }
  if (notAllowed.length > 0) {
    errors.unshift(`Gemini "config" accepts only ${GEMINI_CONFIG_ALLOWLIST.join(', ')}. Refused: ${notAllowed.join(', ')}.`);
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

/** P19 — the output cap a payload imposes: the smallest positive integer it sets; `null` when it
    controls the cap without one (it removes the key, or Ollama's -1); `undefined` when it does not
    control the cap. */
export function payloadOutputCap(kind: TransportKind, params: Json | undefined): number | null | undefined {
  if (!params || !payloadControlsOutputCap(kind, params)) return undefined;
  const { container, keys } = OUTPUT_CAP[kind];
  const scope = (container === null ? params : params[container]) as Json;
  const caps = keys.map((k) => scope[k]).filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
  return caps.length > 0 ? Math.min(...caps) : null;
}

/** N13 — the payload key that sets the output cap (`options.num_predict`, `config.maxOutputTokens`,
    `max_completion_tokens`, `n_predict`, …), for failure copy: the key whose value is the cap, else the
    first cap key present (a `null` that removes the cap). `undefined` when the payload controls no cap. */
export function payloadOutputCapKey(kind: TransportKind, params: Json | undefined): string | undefined {
  if (!params || !payloadControlsOutputCap(kind, params)) return undefined;
  const { container, keys } = OUTPUT_CAP[kind];
  const scope = (container === null ? params : params[container]) as Json;
  const present = keys.filter((k) => Object.hasOwn(scope, k));
  const cap = payloadOutputCap(kind, params);
  const key = (cap === null ? undefined : present.find((k) => scope[k] === cap)) ?? present[0];
  return container === null ? key : `${container}.${key}`;
}

/** P17 — split a stored payload into what may reach the wire and the key paths that may not. Save-time
    validation refuses the same paths; this re-applies the rules to a payload stored before a rule
    existed, or written straight to user-settings.json. A non-object (e.g. a stored `null`) on an owned
    container is dropped, so it never removes the container. N11: a Gemini `config.safetySettings` that
    is not an array of { category, threshold } strings is dropped. N12: `__proto__`, `constructor` and
    `prototype` keys are dropped at any depth, and every kept key is defined as an own data property. */
export function filterStoredPayload(
  kind: TransportKind,
  params: Json | undefined,
  ctx: { reasoningStyle?: ReasoningStyle } = {},
): { value: Json | undefined; dropped: string[] } {
  if (!params) return { value: undefined, dropped: [] };
  const dropped: string[] = [];
  const clean = withoutPrototypeKeys(params, '', dropped) as Json;
  const protectedSet = protectedKeySet(kind, ctx);
  const value: Json = {};
  for (const [key, entry] of Object.entries(clean)) {
    if (protectedSet.has(key)) {
      dropped.push(key);
      continue;
    }
    if (OWNED_CONTAINERS[kind].includes(key)) {
      if (!isPlainObject(entry)) {
        dropped.push(key);
        continue;
      }
      const inner: Json = {};
      for (const [innerKey, innerValue] of Object.entries(entry)) {
        const path = `${key}.${innerKey}`;
        const allowed =
          kind === 'gemini'
            ? geminiConfigAllows(innerKey) &&
              (innerKey !== 'safetySettings' || innerValue === null || isSafetySettings(innerValue))
            : !protectedSet.has(path);
        if (allowed) setOwn(inner, innerKey, innerValue);
        else dropped.push(path);
      }
      setOwn(value, key, inner);
      continue;
    }
    if (kind === 'gemini') {
      dropped.push(key);
      continue;
    }
    setOwn(value, key, entry);
  }
  return { value, dropped };
}

/** Merged LAST into the native request, after filterStoredPayload (P17). Top-level keys replace;
    the owned container merges key by key; `null` removes a key inside it. Never mutates `native`. */
export function mergeExtraParams(
  kind: TransportKind,
  native: Json,
  params: Json | undefined,
  ctx: { reasoningStyle?: ReasoningStyle } = {},
): Json {
  if (!params) return native;
  const { value: allowed = {}, dropped } = filterStoredPayload(kind, params, ctx);
  if (dropped.length > 0) {
    /* P17: names only — a payload value never reaches a log. */
    console.warn(`[extra-params] ${kind}: ignored stored custom parameters Castwright controls or does not allow: ${dropped.join(', ')}`);
  }
  const out: Json = { ...native };
  if (kind === 'openai' && payloadControlsOutputCap(kind, allowed)) {
    delete out.max_tokens;
    delete out.max_completion_tokens;
  }
  for (const [key, value] of Object.entries(allowed)) {
    if (OWNED_CONTAINERS[kind].includes(key)) {
      const base: Json = isPlainObject(out[key]) ? { ...(out[key] as Json) } : {};
      for (const [innerKey, innerValue] of Object.entries(value as Json)) {
        if (innerValue === null) delete base[innerKey];
        else setOwn(base, innerKey, innerValue); // N12: never a prototype setter
      }
      setOwn(out, key, base);
      continue;
    }
    if (value === null) delete out[key];
    else setOwn(out, key, value);
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
    /* W3b's redactKnownSecrets applies the 8-character floor, so short values ("json", "auto") survive. */
    out.push(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) out.push(escaped);
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

/** Every string value in a payload, plus its JSON-escaped form. Each transport adds the values of the
    payload ITS OWN request carried to the secrets W3b redacts that request's errors against (P22, scoped
    per request by P29, Task 5.11). They never join the global knownAnalyzerSecrets() list. */
export function payloadSecretValues(params: unknown): string[] {
  const values: string[] = [];
  collectRedactable(params, values);
  return [...new Set(values)];
}

export function redactPayloadValues(text: string, params: unknown): string {
  if (!text || params === undefined || params === null) return text;
  return redactKnownSecrets(text, payloadSecretValues(params));
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
- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/runner/extra-params.test.ts`  Expected: PASS.

- [ ] **Step 5: Mutation proof**
1. In `validateExtraParams` delete `if (kind === 'openai' && ctx.reasoningStyle === 'enable_thinking') protectedSet.add(ENABLE_THINKING_KEY);`. Expected red: `protects chat_template_kwargs.enable_thinking only for the enable_thinking style`. Restore.
2. In `mergeExtraParams` change `if (OWNED_CONTAINERS[kind].includes(key))` to `if (false)`. Expected red: `merges the owned container key by key` and `keeps the reasoning-owned enable_thinking …`. Restore.
3. In W3b's `redactKnownSecrets` (`server/src/analyzer/redact.ts`) remove `.sort((a, b) => b.length - a.length)`. Expected red: `replaces the longest value first …` (and W3b's own redaction test). Restore.
4. In W3b's `redactKnownSecrets` change `s.length >= 8` to `s.length >= 4`. Expected red: `redacts string values of 8+ characters anywhere in the payload, not shorter ones` (`json`/`auto` get blanked). Restore.
5. In `mergeExtraParams` delete the `payloadControlsOutputCap` block. Expected red: `drops the native max_tokens when the payload controls the endpoint output cap`. Restore.
6. Add `'httpOptions'` to `GEMINI_CONFIG_ALLOWLIST`. Expected red: `Gemini config is an allowlist: httpOptions … refused by name (P16)` and `Gemini: only allowlisted config keys survive…`. Restore.
7. In `mergeExtraParams` iterate `params` instead of `allowed` (both in the loop and in the `payloadControlsOutputCap` check). Expected red: `drops protected keys and logs their names, never their values`, `a stored null on an owned container is ignored…` and `Gemini: only allowlisted config keys survive…`. Restore.
8. In `filterStoredPayload` replace `if (!isPlainObject(entry)) { dropped.push(key); continue; }` with `if (!isPlainObject(entry)) { setOwn(value, key, entry); continue; }`. Expected red: `a stored null on an owned container is ignored…` (the merge then deletes `options`). Restore.
9. Remove `'options.main_gpu'` from `PROTECTED_KEYS.ollama`, then (separately) `'reasoning_budget_tokens'` from `PROTECTED_KEYS.openai`. Expected red each time: `refuses every endpoint reasoning key and the added Ollama keys (A8)`. Restore.
10. Append `${JSON.stringify(params)}` to the `console.warn` line. Expected red: `drops protected keys and logs their names, never their values`. Restore.
11. In `payloadOutputCap` return `undefined` instead of `null`. Expected red: `ollama {"options":{"num_predict":-1}} → null` and `openai {"max_tokens":null} → null`. Restore.
12. Remove `'n_predict'` from `OUTPUT_CAP.openai.keys`. Expected red: `openai {"n_predict":1024} → 1024`, the `openai {"n_predict":1024}` case-table row, and `drops the native max_tokens when the payload controls the endpoint output cap` (N9). Restore.
13. In `validateExtraParams` delete the `else if (inner === 'safetySettings' …) { … }` branch. Expected red: `refuses an entry with any other field, such as method, naming the key` and `refuses a non-array and a non-string threshold, naming the key` (N11). Restore.
14. In `filterStoredPayload` replace the Gemini `allowed` expression with `geminiConfigAllows(innerKey)`. Expected red: `drops a stored invalid safetySettings at merge and reports its path` (N11). Restore.
15. In `withoutPrototypeKeys` delete the `if (PROTOTYPE_KEYS.has(key)) { … }` block. Expected red: `filterStoredPayload drops them at any depth…` and `validateExtraParams refuses them, naming each path` (N12). Restore.
16. In `payloadOutputCapKey` return `present[0]` for every payload (drop the `find`). Expected red: `openai {"max_tokens":8192,"max_completion_tokens":4096} → max_completion_tokens` (N13). Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/runner/extra-params.ts server/src/analyzer/runner/extra-params.test.ts server/src/analyzer/__fixtures__/extra-params-cases.json
git commit -m "feat(server): custom payload validation, merge, temperature precedence and redaction"
```

### Task 5.9: Storage and save-time validation (`analyzerExtraParamsByEngine`, endpoint `extraParams`), OpenAPI, mocks

**Files:**
- Modify: `server/src/workspace/user-settings.ts` (schema after PR 5a's `analyzerReasoningByEngine`; `DEFAULT_USER_SETTINGS`)
- Modify: `server/src/workspace/analyzer-request-controls.ts` (the patch schema from Task 5.2)
- Modify: `server/src/workspace/analyzer-endpoints.ts` (W3b Task 3b.5) — `parseEndpointInput`: delete P23's `extraParams` refusal and validate the payload in its place
- Modify: `openapi.yaml` (`AnalyzerExtraParamsByEngine`; `UserSettings`, `UserSettingsPatch`; W3's `AnalyzerEndpoint.extraParams`); regenerate `src/lib/api-types.ts`
- Modify: `src/lib/api.ts` (`MOCK_USER_SETTINGS`, `mockPutUserSettings` whitelist, W3b Task 3b.9's `mockEndpointFromInput`: delete its `extraParams` push)
- Test: `server/src/workspace/analyzer-request-controls.test.ts` (append), `server/src/routes/user-settings.test.ts` (append), `server/src/routes/analyzer-endpoints.test.ts` (append, and flip the payload case), `server/src/workspace/analyzer-endpoints.test.ts` (flip the payload case), `src/lib/api-analyzer-endpoints-mock.test.ts` (flip the payload case)

**Interfaces:**
- Consumes: Task 5.8 `validateExtraParams`; Task 5.2's patch schema, `StoredRequestControls` and `changedRequestControls` (N6), and the level rule it put in `parseEndpointInput` / `mockEndpointFromInput`.

**Judge only changed payloads (N6).** The Settings UI sends both engine payloads on every save (Task 5.12). A stored payload that a newer rule refuses, such as a `safetySettings` saved before N11, must not block every later save. `changedRequestControls` therefore also leaves out a sent engine payload whose JSON equals the stored one. `mergeExtraParams` still drops the refused keys at run time (P17).

**The same rule for an endpoint update (A7).** `parseEndpointInput` received the stored endpoint in Task 5.2 for the level rule. The payload rule uses it the same way: on an update, validate `extraParams` only when this save changes the payload, or changes the `reasoningStyle` that decides whether `chat_template_kwargs.enable_thinking` is protected. A create is always judged, and `mergeExtraParams` still filters a stale stored payload at run time (P17).

**Lifting P23's `extraParams` refusal.** After PR 5a, `parseEndpointInput` and `mockEndpointFromInput` still refuse any non-empty payload, naming PR 5b. This task deletes those pushes. The server validates the payload with `validateExtraParams` under the endpoint's reasoning style, in the same place. `analyzer-endpoints.ts` → `analyzer/runner/extra-params.ts` closes no cycle: that module imports only `errors.ts` types and `analyzer/redact.ts`. The mock accepts a payload without checking protected keys: those are refused by the server only (Task 5.12's `src/lib/extra-params.ts` notes the same split).
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

describe('stored schema stays lenient for payloads', () => {
  it('loads a stored payload that a newer protected-key list would refuse', () => {
    const parsed = userSettingsSchema.safeParse({ ...DEFAULT_USER_SETTINGS, analyzerExtraParamsByEngine: { ollama: { think: true } } });
    expect(parsed.success).toBe(true);
    expect(DEFAULT_USER_SETTINGS.analyzerExtraParamsByEngine).toEqual({});
  });
});

describe('changedRequestControls — payloads (N6)', () => {
  it('leaves out a sent engine payload identical to the stored one, and keeps a changed one', () => {
    const stored = { analyzerExtraParamsByEngine: { gemini: { config: { safetySettings: { category: 'X' } } } } };
    expect(
      changedRequestControls(
        { analyzerExtraParamsByEngine: { gemini: { config: { safetySettings: { category: 'X' } } }, ollama: { top_k: 1 } } },
        stored,
      ),
    ).toEqual({ analyzerExtraParamsByEngine: { ollama: { top_k: 1 } } });
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
  it('PUT refuses a Gemini payload that sets config.httpOptions, naming it (P16)', async () => {
    const res = await request(app)
      .put('/api/user/settings')
      .send({ analyzerExtraParamsByEngine: { gemini: { config: { httpOptions: { baseUrl: 'http://evil' } } } } });
    expect(res.status).toBe(400);
    expect(res.body.issues.map((i: { message: string }) => i.message)).toEqual([
      'Gemini custom parameters: Gemini "config" accepts only temperature, topP, topK, maxOutputTokens, presencePenalty, frequencyPenalty, seed, safetySettings. Refused: config.httpOptions.',
    ]);
    expect(existsSync(userSettingsPath)).toBe(false);
  });
  it('PUT persists a valid payload and GET returns it', async () => {
    const payload = { ollama: { options: { min_p: 0.05 } }, gemini: { config: { topK: 40 } } };
    expect((await request(app).put('/api/user/settings').send({ analyzerExtraParamsByEngine: payload })).status).toBe(200);
    resetCache();
    expect((await request(app).get('/api/user/settings')).body.analyzerExtraParamsByEngine).toEqual(payload);
  });
  it('PUT: an unchanged stored payload a newer rule refuses does not block saving a reasoning level (N6)', async () => {
    _setUserSettingsCacheForTest({
      analyzerExtraParamsByEngine: { gemini: { config: { safetySettings: { category: 'HARM_CATEGORY_HARASSMENT' } } } },
    });
    const res = await request(app)
      .put('/api/user/settings')
      .send({
        analyzerReasoningByEngine: { gemini: { 'gemini-3.6-flash': 'low' } },
        analyzerExtraParamsByEngine: { gemini: { config: { safetySettings: { category: 'HARM_CATEGORY_HARASSMENT' } } } },
      });
    expect(res.status).toBe(200);
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

**Flip the payload refusal tests Task 5.2 kept.**

In `server/src/workspace/analyzer-endpoints.test.ts`, inside `describe('create / update / delete / key decisions', …)`, replace the case `until PR 5b, refuses a non-empty payload, naming the PR that enables it (P23)` with:
```ts
  it('accepts a custom payload and refuses a protected key, validated by validateExtraParams', () => {
    expect(
      applyUpdate(applyCreate(empty, base), 'lab', { ...base, extraParams: { top_k: 20, min_p: 0.05, presence_penalty: 1.5 } }).analyzerEndpoints[0]
        .extraParams,
    ).toEqual({ top_k: 20, min_p: 0.05, presence_penalty: 1.5 });
    const refused = refusal(() =>
      applyCreate(empty, { ...base, reasoningStyle: 'enable_thinking', reasoning: 'off', extraParams: { chat_template_kwargs: { enable_thinking: true } } }),
    );
    expect(refused).toMatchObject({ status: 400, refusal: 'invalid' });
    expect(refused.details).toEqual([
      'extraParams: These keys are controlled by Castwright and cannot be set here: chat_template_kwargs.enable_thinking.',
    ]);
    /* The key is protected only under the enable_thinking style, so the reasoning style reaches the check. */
    expect(applyCreate(empty, { ...base, extraParams: { chat_template_kwargs: { enable_thinking: true } } }).analyzerEndpoints).toHaveLength(1);
  });
  it('an update judges the payload only when it changes: an unchanged stale payload saves, a changed one is refused (A7)', () => {
    /* A payload stored before a rule existed (or written straight into user-settings.json). */
    const created = applyCreate(empty, { ...base, extraParams: { top_k: 20 } });
    const stale = {
      ...created,
      analyzerEndpoints: [{ ...created.analyzerEndpoints[0], extraParams: { response_format: { type: 'text' } } }],
    };
    expect(
      applyUpdate(stale, 'lab', { ...base, name: 'Lab renamed', extraParams: { response_format: { type: 'text' } } }).analyzerEndpoints[0],
    ).toMatchObject({ name: 'Lab renamed' });
    expect(refusal(() => applyUpdate(stale, 'lab', { ...base, extraParams: { response_format: { type: 'json_object' } } })).details).toEqual([
      'extraParams: These keys are controlled by Castwright and cannot be set here: response_format.',
    ]);
  });
```

In `server/src/routes/analyzer-endpoints.test.ts`, inside `describe('POST /api/analyzer/endpoints', …)`, replace the case `until PR 5b, refuses a non-empty payload on update (P23)` with:
```ts
  it('accepts a custom payload on create and update, validated by validateExtraParams', async () => {
    const created = await request(app).post('/api/analyzer/endpoints').send({ ...lab, extraParams: { top_k: 20 } });
    expect(created.status).toBe(201);
    const updated = await request(app).put('/api/analyzer/endpoints/lab').send({ ...lab, extraParams: { top_k: 20, min_p: 0.05 } });
    expect(updated.status).toBe(200);
    expect(JSON.parse(readFileSync(userSettingsPath, 'utf8')).analyzerEndpoints[0].extraParams).toEqual({ top_k: 20, min_p: 0.05 });
  });
```

In `src/lib/api-analyzer-endpoints-mock.test.ts`, inside `describe('mock analyzer endpoint API', …)`, replace the case `until PR 5b, refuses a non-empty payload, as the server does` with:
```ts
  it('accepts a custom payload and returns it; protected keys are refused by the server only', async () => {
    const s = await api.createAnalyzerEndpoint({ ...input('m-payload'), extraParams: { top_k: 20 } });
    expect(s.analyzerEndpoints?.find((e) => e.id === 'm-payload')?.extraParams).toEqual({ top_k: 20 });
  });
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/workspace/analyzer-request-controls.test.ts src/routes/user-settings.test.ts src/routes/analyzer-endpoints.test.ts src/workspace/analyzer-endpoints.test.ts` and `npm test -- src/lib/api-analyzer-endpoints-mock.test.ts`
Expected: FAIL.
- The new patch-schema cases get `[]` messages, or `expected 200 to be 400`.
- The lenient-read case fails with `expected undefined to deeply equal {}`.
- The three flipped cases fail on P23's refusal: an `AnalyzerEndpointRefusal` naming PR 5b, `expected 400 to be 201`, and an `AnalyzerEndpointError`.
- `update refuses a protected endpoint payload key` fails `toContain`: the body names PR 5b, not `response_format`.
- `an update judges the payload only when it changes… (A7)` fails at its first assertion: P23 refuses the unchanged stale payload outright.

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

`analyzer-request-controls.ts` — add `import { validateExtraParams } from '../analyzer/runner/extra-params.js';`. In `analyzerRequestControlsPatchSchemaFor` (Task 5.2), replace its `.object({ analyzerReasoningByEngine: reasoningByEngineInput })` with:
```ts
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

In the same file, replace Task 5.2's `StoredRequestControls` and `changedRequestControls` with the versions below, which also leave out an unchanged payload (N6):
```ts
/** What changedRequestControls reads from the stored settings. Structural: no user-settings import. */
export interface StoredRequestControls {
  analyzerReasoningByEngine?: { ollama?: Record<string, string>; gemini?: Record<string, string> };
  analyzerExtraParamsByEngine?: { ollama?: Record<string, unknown>; gemini?: Record<string, unknown> };
}

/** N6 — the part of a PUT body the rules judge: only reasoning entries whose value differs from the
    stored settings, and only engine payloads whose JSON differs from the stored payload. The UI sends
    whole maps and both payloads, and Test records are bound to their server URL, so re-judging unchanged
    stored values would let one stale entry block every later save. Ollama keys compare through
    normalizeModelTag (N7). A patch with neither map is returned as the same object. */
export function changedRequestControls(patch: unknown, stored: StoredRequestControls): unknown {
  if (!isRecord(patch)) return patch;
  let judged: Record<string, unknown> = patch;
  if (isRecord(patch.analyzerReasoningByEngine)) {
    const sent = patch.analyzerReasoningByEngine;
    const reasoning: Record<string, unknown> = { ...sent };
    for (const engine of ['ollama', 'gemini'] as const) {
      const entries = sent[engine];
      if (!isRecord(entries)) continue;
      const before = stored.analyzerReasoningByEngine?.[engine];
      reasoning[engine] = Object.fromEntries(
        Object.entries(entries).filter(
          ([model, level]) => (engine === 'ollama' ? entryForModelTag(before, model) : before?.[model]) !== level,
        ),
      );
    }
    judged = { ...judged, analyzerReasoningByEngine: reasoning };
  }
  if (isRecord(patch.analyzerExtraParamsByEngine)) {
    const payloads: Record<string, unknown> = { ...patch.analyzerExtraParamsByEngine };
    for (const engine of ['ollama', 'gemini'] as const) {
      if (engine in payloads && JSON.stringify(payloads[engine]) === JSON.stringify(stored.analyzerExtraParamsByEngine?.[engine])) {
        delete payloads[engine];
      }
    }
    judged = { ...judged, analyzerExtraParamsByEngine: payloads };
  }
  return judged;
}
```
The route (Task 5.2) already judges `changedRequestControls(req.body ?? {}, stored)`, and `stored` is a `UserSettings`, which satisfies the widened interface.
`analyzer-endpoints.ts` (W3b Task 3b.5, as Task 5.2 left `parseEndpointInput`) — add `import { validateExtraParams } from '../analyzer/runner/extra-params.js';`. Replace Task 5.2's payload refusal:
```ts
  if (ep.extraParams !== undefined && Object.keys(ep.extraParams).length > 0) {
    problems.push('extraParams: custom request parameters cannot be saved until PR 5b enables them');
  }
```
with:
```ts
  /* #3084 PR 5b — P23's payload refusal, lifted: a payload must pass validateExtraParams under this
     endpoint's reasoning style (chat_template_kwargs.enable_thinking is protected only under
     enable_thinking). A7: on an update, only when this save changes the payload or that style; an
     unchanged stale payload must not block every later edit, and mergeExtraParams still filters it. */
  const payloadChanged =
    !stored ||
    stored.reasoningStyle !== ep.reasoningStyle ||
    JSON.stringify(stored.extraParams) !== JSON.stringify(ep.extraParams);
  if (ep.extraParams !== undefined && payloadChanged) {
    const payload = validateExtraParams('openai', ep.extraParams, { reasoningStyle: ep.reasoningStyle });
    if (!payload.ok) for (const error of payload.errors) problems.push(`extraParams: ${error}`);
  }
```
In the comment above the block, delete its last sentence (`The \`extraParams\` refusal stays until PR 5b replaces it with validateExtraParams.`).

`src/lib/api.ts` — in `mockEndpointFromInput` (as Task 5.2 left it), delete:
```ts
  if (input.extraParams !== undefined && Object.keys(input.extraParams).length > 0) {
    controlProblems.push('extraParams: custom request parameters cannot be saved until PR 5b enables them');
  }
```
and change its comment to `/* #3084 — mirrors the server's parseEndpointInput level rule (PR 5a). A payload is accepted as sent: protected keys are refused by the server only. */`. W3b's mock returns `{ ...input, … }`, so `extraParams` is stored and returned as sent.

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
          description: Only `config` is allowed, and inside it only temperature, topP, topK, maxOutputTokens, presencePenalty, frequencyPenalty, seed and safetySettings (P16); safetySettings must be an array of objects with only a string category and a string threshold (N11). It merges key by key into the Gemini request config.
      description: |
        #3084 — custom request parameters per engine. Protected keys, and keys
        named __proto__, constructor or prototype at any depth, are refused on
        save with a message naming them; `null` removes a key but never an
        owned container. A PUT replaces this map, and each engine's payload
        inside it, as a whole: send both engines' payloads, because one left
        out of a sent map loses its payload. Not a place for credentials: an
        endpoint key belongs in its API key field (P29). Never logged; string
        values of 8+ characters are redacted from the errors of the request
        that carried them.
```
In `UserSettings.properties` and `UserSettingsPatch.properties`, after `analyzerReasoningByEngine`:
```yaml
        analyzerExtraParamsByEngine:
          $ref: '#/components/schemas/AnalyzerExtraParamsByEngine'
```
Confirm W3's `AnalyzerEndpoint.extraParams` is `type: object` + `additionalProperties: true`; if not, set it to exactly that with description `Custom request parameters merged last; protected keys refused on save.` Run `npm run openapi:types`.

`src/lib/api.ts` — `MOCK_USER_SETTINGS`: add `analyzerExtraParamsByEngine: {},` after `analyzerReasoningByEngine: {},`; `mockPutUserSettings`: add `analyzerExtraParamsByEngine,` to both the destructuring and the object literal after `analyzerReasoningByEngine,`. (The mock endpoint half is above.)

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/workspace/analyzer-request-controls.test.ts src/routes/user-settings.test.ts src/routes/analyzer-endpoints.test.ts src/workspace/analyzer-endpoints.test.ts src/workspace/user-settings.test.ts` and `npm test -- src/lib/api-analyzer-endpoints-mock.test.ts`, then `npm run typecheck` and `npm run check:cycles`  Expected: PASS, no new cycle.

- [ ] **Step 5: Mutation proof**
1. In the patch schema's payload loop replace `if (!result.ok)` with `if (false)`. Expected red: `PUT refuses a protected payload key and names it` and `PUT refuses a Gemini payload that sets config.httpOptions, naming it (P16)`. Restore.
2. In `parseEndpointInput` replace `if (!payload.ok)` with `if (false)`. Expected red: `accepts a custom payload and refuses a protected key, validated by validateExtraParams` and `update refuses a protected endpoint payload key`. Restore.
3. In `parseEndpointInput` pass `{}` instead of `{ reasoningStyle: ep.reasoningStyle }`. Expected red: `accepts a custom payload and refuses a protected key…` (`enable_thinking` is no longer protected under its style). Restore.
3b. In `parseEndpointInput` replace `&& payloadChanged` with nothing (always judge). Expected red: `an update judges the payload only when it changes… (A7)` at its first assertion. Then restore it and drop `stored.reasoningStyle !== ep.reasoningStyle ||` from `payloadChanged`. Expected red: `accepts a custom payload and refuses a protected key…` is unaffected, and the A7 case stays green, so add the style-change row from Task 5.2's level case as the proof instead: an update that only switches `reasoningStyle` to `enable_thinking` while keeping `extraParams: { chat_template_kwargs: { enable_thinking: true } }` is then accepted. Restore.
4. Restore Task 5.2's `extraParams` refusal push in `parseEndpointInput`. Expected red: `accepts a custom payload on create and update, validated by validateExtraParams`. Restore it in `mockEndpointFromInput` instead. Expected red: `accepts a custom payload and returns it; protected keys are refused by the server only`. Remove both.
5. In `changedRequestControls` delete the `if (isRecord(patch.analyzerExtraParamsByEngine)) { … }` block. Expected red: `leaves out a sent engine payload identical to the stored one…` and `PUT: an unchanged stored payload a newer rule refuses does not block saving a reasoning level (N6)` (`expected 400 to be 200`). Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/workspace/user-settings.ts server/src/workspace/analyzer-request-controls.ts server/src/workspace/analyzer-request-controls.test.ts server/src/workspace/analyzer-endpoints.ts server/src/workspace/analyzer-endpoints.test.ts server/src/routes/user-settings.test.ts server/src/routes/analyzer-endpoints.test.ts openapi.yaml src/lib/api-types.ts src/lib/api.ts src/lib/api-analyzer-endpoints-mock.test.ts
git commit -m "feat(server,openapi,mocks): store and validate custom analyzer request payloads"
```

### Task 5.10: Transports merge the payload last; runner applies temperature precedence; analyzers pass the payload

**Files:**
- Modify: `server/src/analyzer/transports/ollama-transport.ts` (streaming body **and** W4's non-streaming `sendFreeText` body), `gemini-transport.ts`, `openai-transport.ts` (request construction, after PR 5a's reasoning block)
- Modify: `server/src/analyzer/runner/stage-runner.ts` (the private `send` helper's `extraParams` entry, added by Task 5.1, plus a `stripTemperature` parameter; and `runFreeText`'s `extraParams` entry, which drops the payload's output-cap keys, A4)
- Modify: `server/src/analyzer/runner/extra-params.ts` (Task 5.8) — new `withoutPayloadOutputCap` (A4)
- Modify: the settings closures in `OllamaAnalyzer` and `GeminiAnalyzer`, and W3b's `openAIRequestSettings` (`server/src/analyzer/openai.ts`, as Task 5.3 left it). Each gains an `extraParams:` entry and a payload output cap (P19). `OpenAIAnalyzer`'s closure is not edited.
- Modify: `server/src/analyzer/capacity.ts` (W2 `resolveCapacity`, widened by W3c Task 3c.9) — a payload output cap becomes `EngineCapacity.maxOutputTokens` (P19)
- Modify: `server/src/analyzer/capabilities.ts` (`ModelTestDeps`, `sendStep`) and `server/src/analyzer/model-test-deps.ts` (`modelTestDepsFor`) — Test probes carry the configured payload and size against its output cap (P19)
- Modify: `server/src/routes/failure-taxonomy.ts` — W2's `AnalyzerReasoningOverflowError` branch (as Task 5.5 left it): the copy names the payload key when a payload set the output cap (N13)
- Test: `server/src/analyzer/transports/extra-params-wire.test.ts`, `server/src/analyzer/runner/payload-temperature.test.ts`, `server/src/analyzer/payload-output-cap.test.ts`, `server/src/analyzer/gemini-payload-allowlist.test.ts`, `server/src/analyzer/capabilities.payload.test.ts`, `server/src/routes/failure-taxonomy.payload-cap.test.ts`; extend W3c's `server/src/analyzer/model-test-deps.test.ts` and W3b's `server/src/analyzer/openai-analyzer.test.ts`

**Interfaces:**
- Consumes: Task 5.8 `mergeExtraParams`, `stripPayloadTemperature`, `resolveExtraParamsSetting`, `payloadOutputCap`; W3b Task 3b.12's `openAIRequestSettings(endpoint, servedOutputLimit?)` and Task 3b.11's `resolveEndpointMaxOutputTokens`; `OLLAMA_RETRY_POLICY`, `OPENAI_RETRY_POLICY`, `GEMINI_RETRY_POLICY` (contract); `parseAndValidate` (`runner/parse.ts`); W3c's `ModelTestDeps`, `sendStep`, `modelTestDepsFor`, and `resolveCapacity` as Task 3c.9 left it.
- Produces:
  - wire behaviour — the payload is merged after the native request and the reasoning fragment, and attempt 2 of a validation retry sends it without its temperature key;
  - a stored protected key never reaches the wire;
  - the payload's output cap is `EngineCapacity.maxOutputTokens` and the request's `maxOutputTokens`;
  - Test probes carry the payload;
  - a persona (free-text) request carries the payload **without its output-cap keys**, so a payload cap meant for chapter work never shortens a voice description (A4, P19);
  - **new** `requestMaxOutputTokens(kind, extraParams, resolve)` in `capacity.ts`, and **new** `withoutPayloadOutputCap(kind, params)` in `runner/extra-params.ts`.

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

  it('the persona (free-text) call drops the payload output cap and keeps every other key (A4)', async () => {
    const url = await startCapture('application/json', JSON.stringify({ message: { role: 'assistant', content: 'A warm voice.' }, done: true, done_reason: 'stop' }));
    /* runFreeText strips the cap keys; what reaches the transport is the rest of the payload. */
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send({
      ...req({ top_k: 40, options: { min_p: 0.05 } }),
      maxOutputTokens: undefined,
      freeText: { onCpu: false, keepAlive: 0 },
    });
    const options = bodies[0].options as Record<string, unknown>;
    expect(bodies[0].top_k).toBe(40);
    expect(options.min_p).toBe(0.05);
    expect('num_predict' in options).toBe(false);
  });

  it('a request with no payload is byte-identical to one with an empty payload', async () => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    const t = new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() });
    await t.send(req(undefined));
    await t.send(req({}));
    expect(JSON.stringify(bodies[1])).toBe(JSON.stringify(bodies[0]));
  });

  it('a stored options:null is ignored: pipeline-owned options stay (P17)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req({ options: null }));
    const options = bodies[0].options as Record<string, unknown>;
    expect(typeof options.num_ctx).toBe('number');
    expect(options.temperature).toBe(0.2);
    vi.restoreAllMocks();
  });

  it('the persona call ignores a stored options:null and a stored options.num_gpu, and keeps num_gpu 0 (P17)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = await startCapture('application/json', JSON.stringify({ message: { role: 'assistant', content: 'A warm voice.' }, done: true, done_reason: 'stop' }));
    const t = new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() });
    await t.send({ ...req({ options: null }), freeText: { onCpu: true, keepAlive: 0 } });
    await t.send({ ...req({ options: { num_gpu: 99 } }), freeText: { onCpu: true, keepAlive: 0 } });
    expect(bodies.map((b) => (b.options as Record<string, unknown>).num_gpu)).toEqual([0, 0]);
    vi.restoreAllMocks();
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
  it('drops a stored chat_template_kwargs.enable_thinking under the enable_thinking style (P17)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'enable_thinking'), apiKey: null, model: 'm', dispatcher: dispatcher() })
      .send(req({ chat_template_kwargs: { enable_thinking: true } }, 'off'));
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    vi.restoreAllMocks();
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
import { GEMINI_RETRY_POLICY, OLLAMA_RETRY_POLICY, OPENAI_RETRY_POLICY, type ValidationRetryPolicy } from './retry-policy.js';
import { parseAndValidate } from './parse.js';
import { OllamaTransport } from '../transports/ollama-transport.js';
import { OpenAITransport } from '../transports/openai-transport.js';
import { GeminiTransport } from '../transports/gemini-transport.js';
import { geminiRateLimiter } from '../rate-limit.js';
import type { GoogleGenAI } from '@google/genai';
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
    if (r.method === 'GET') {
      /* #3084 P15 — the runner awaits OpenAITransport.prepare(), which lists the served models first. */
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
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

  it('Gemini policy: attempt 2 uses the retry policy temperature, other payload config keys survive', async () => {
    const captured: Array<{ config: Record<string, unknown> }> = [];
    const texts = ['not json', '{"ok":true}'];
    const client = {
      models: {
        generateContentStream: vi.fn(async (params: { config: Record<string, unknown> }) => {
          captured.push(params);
          const text = texts[captured.length - 1];
          return (async function* () {
            yield { text, candidates: [{ finishReason: 'STOP' }] };
          })();
        }),
      },
    } as unknown as GoogleGenAI;
    geminiRateLimiter._reset();
    await runWith(new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client }), GEMINI_RETRY_POLICY, { config: { temperature: 0.95, topK: 40 } });
    expect(captured[0].config.temperature).toBe(0.95);
    expect(captured[1].config.temperature).toBe(expectedRetryTemperature(GEMINI_RETRY_POLICY));
    expect(captured[1].config.temperature).not.toBe(0.95);
    expect(captured[1].config.topK).toBe(40);
  });
});

```

`server/src/analyzer/runner/free-text-payload.test.ts` (A4 — the strip itself, per transport kind):
```ts
/* #3084 wave 5 (A4) — a persona request carries the engine's payload, minus the keys that set the
   output cap: a cap chosen for chapter work must not shorten a voice description. P19 keeps every
   other key, and the stage path (the control below) keeps the cap. */
import { describe, it, expect } from 'vitest';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './retry-policy.js';
import { withoutPayloadOutputCap } from './extra-params.js';
import type { TransportKind } from '../errors.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';

class Recording implements ChatTransport {
  readonly requests: TransportRequest[] = [];
  constructor(readonly kind: TransportKind, readonly model = 'm') {}
  async send(req: TransportRequest): Promise<TransportResult> {
    this.requests.push(req);
    return { text: 'A warm voice.', reasoningSeen: false, finish: 'stop', receivedBytes: 13 };
  }
}
const runnerFor = (transport: ChatTransport, extraParams: Record<string, unknown>) =>
  new StageRunner({
    transport,
    policy: OLLAMA_RETRY_POLICY,
    settings: () => ({ structuredOutput: 'off', maxOutputTokens: 4096, extraParams }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });

describe('withoutPayloadOutputCap', () => {
  it('drops every cap key of that kind and nothing else', () => {
    expect(withoutPayloadOutputCap('openai', { max_tokens: 64, max_completion_tokens: 64, n_predict: 64, top_k: 20 })).toEqual({ top_k: 20 });
    expect(withoutPayloadOutputCap('ollama', { top_k: 40, options: { num_predict: 64, min_p: 0.05 } })).toEqual({ top_k: 40, options: { min_p: 0.05 } });
    expect(withoutPayloadOutputCap('gemini', { config: { maxOutputTokens: 64, topK: 40 } })).toEqual({ config: { topK: 40 } });
    /* A cap the payload removes (`null`) is a cap key too. */
    expect(withoutPayloadOutputCap('openai', { max_tokens: null, top_k: 20 })).toEqual({ top_k: 20 });
  });
  it('returns the same object when the payload sets no cap, and undefined for none', () => {
    const params = { top_k: 20 };
    expect(withoutPayloadOutputCap('openai', params)).toBe(params);
    expect(withoutPayloadOutputCap('ollama', undefined)).toBeUndefined();
  });
});

describe('runFreeText and the payload output cap (A4)', () => {
  it('sends the payload without its cap keys, and still no engine output cap of its own', async () => {
    const transport = new Recording('ollama');
    await runnerFor(transport, { top_k: 40, options: { num_predict: 64, min_p: 0.05 } }).runFreeText({ prompt: 'persona please' });
    expect(transport.requests[0].extraParams).toEqual({ top_k: 40, options: { min_p: 0.05 } });
    expect(transport.requests[0].maxOutputTokens).toBeUndefined();
  });

  it('the escalation single attempt keeps the payload cap (CONTROL: only free text strips it)', async () => {
    const transport = new Recording('ollama');
    await runnerFor(transport, { options: { num_predict: 64, min_p: 0.05 } }).runSingleAttempt({
      system: '',
      messages: [{ role: 'user', content: 'p' }],
      call: {},
    });
    expect((transport.requests[0].extraParams as { options: Record<string, unknown> }).options.num_predict).toBe(64);
  });
});
```
(`runSingleAttempt` is the control because it is the runner's other single-attempt path and writes no handoff file, so this suite needs no `handoff/protocol.js` mock. Match its real W1 signature when writing the call; the stage path's cap is pinned separately by Task 5.10's `payload-output-cap.test.ts` and `extra-params-wire.test.ts`.)

`server/src/analyzer/payload-output-cap.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../handoff/protocol.js')>();
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  const dir = join(tmpdir(), `castwright-w5b-cap-${process.pid}`);
  await mkdir(dir, { recursive: true });
  return { ...actual, writeInbox: async () => join(dir, 'inbox.md'), outboxPath: () => join(dir, 'out.json'), errorPath: () => join(dir, 'err.json'), rawAttemptPath: () => join(dir, 'raw.txt') };
});

import { resolveCapacity, TODAY_LOCAL_CAPACITY } from './capacity.js';
import { OllamaAnalyzer } from './ollama.js';
import { OllamaTransport } from './transports/ollama-transport.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

beforeEach(() => _resetUserSettingsCache());
afterEach(() => vi.restoreAllMocks());

describe('a payload output cap is the cap every consumer uses (#3084 wave 5, P19)', () => {
  it('options.num_predict 512: capacity reports 512, and the request the overflow rule judges carries 512', async () => {
    _setUserSettingsCacheForTest({ analyzerExtraParamsByEngine: { ollama: { options: { num_predict: 512 } } } });
    /* Chunk sizing (W2 Task 2.3), the catalog's outputTokens and the Test probe cap receive this EngineCapacity. */
    expect(resolveCapacity({ engine: 'local', model: 'q:4b' })).toEqual({ ...TODAY_LOCAL_CAPACITY(), maxOutputTokens: 512 });
    const send = vi
      .spyOn(OllamaTransport.prototype, 'send')
      .mockResolvedValue({ text: '{}', reasoningSeen: false, finish: 'stop', receivedBytes: 2 });
    await new OllamaAnalyzer({ url: 'http://ollama.test', model: 'q:4b' }).runAttributionEscalation('m1', 1, 0, 'prompt', {});
    expect(send.mock.calls[0][0].maxOutputTokens).toBe(512);
  });

  it('an endpoint payload max_completion_tokens replaces the saved cap', () => {
    const lab = analyzerEndpointSchema.parse({
      id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'none', contextTokens: 32768, maxOutputTokens: 8192,
      extraParams: { max_completion_tokens: 4096 },
    });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab] });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::m' }).maxOutputTokens).toBe(4096);
  });

  it('no payload leaves capacity exactly as W2 resolves it', () => {
    _setUserSettingsCacheForTest({});
    expect(resolveCapacity({ engine: 'local', model: 'q:4b' })).toEqual(TODAY_LOCAL_CAPACITY());
  });
});
```

`server/src/analyzer/gemini-payload-allowlist.test.ts` injects a refused payload straight into settings. The save-time half is Task 5.9's `PUT refuses a Gemini payload that sets config.httpOptions, naming it (P16)`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured: Array<Record<string, unknown>> = [];
vi.mock('@google/genai', async (orig) => {
  const actual = await orig<typeof import('@google/genai')>();
  class FakeGoogleGenAI {
    models = {
      generateContentStream: async (params: Record<string, unknown>) => {
        captured.push(params);
        return (async function* () {
          yield { text: '{}', candidates: [{ finishReason: 'STOP' }] };
        })();
      },
    };
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});
vi.mock('../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../handoff/protocol.js')>();
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  const dir = join(tmpdir(), `castwright-w5b-allowlist-${process.pid}`);
  await mkdir(dir, { recursive: true });
  return { ...actual, writeInbox: async () => join(dir, 'inbox.md'), outboxPath: () => join(dir, 'out.json'), errorPath: () => join(dir, 'err.json'), rawAttemptPath: () => join(dir, 'raw.txt') };
});

import { GeminiAnalyzer } from './gemini.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { geminiRateLimiter } from './rate-limit.js';

beforeEach(() => {
  captured.length = 0;
  geminiRateLimiter._reset();
  _resetUserSettingsCache();
});

describe('a stored Gemini httpOptions payload never reaches generateContentStream (#3084 wave 5, P16)', () => {
  it('is dropped at merge when injected straight into settings, while allowlisted keys still apply', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setUserSettingsCacheForTest({
      analyzerExtraParamsByEngine: { gemini: { config: { httpOptions: { baseUrl: 'http://evil', headers: { 'x-evil': '1' } }, topK: 40 } } },
    });
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.6-flash' }).runAttributionEscalation('m1', 1, 0, 'prompt', {});
    const params = captured[0] as { config: Record<string, unknown> };
    expect(params.config).not.toHaveProperty('httpOptions');
    expect(params.config.topK).toBe(40);
    expect(JSON.stringify(params)).not.toContain('evil');
    expect(String(warn.mock.calls[0][0])).toContain('config.httpOptions');
    warn.mockRestore();
  });
});
```

`server/src/analyzer/capabilities.payload.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { runModelTest } from './capabilities.js';
import type { ChatTransport, TransportRequest, TransportResult } from './runner/transport.js';

describe('Test probes carry the configured payload (#3084 wave 5, P19)', () => {
  it('every ladder request sends the payload a run would send', async () => {
    const calls: TransportRequest[] = [];
    const transport: ChatTransport = {
      kind: 'ollama',
      model: 'q:4b',
      send: vi.fn(async (req: TransportRequest): Promise<TransportResult> => {
        calls.push(req);
        return { text: '{"ok":true}', reasoningSeen: false, finish: 'stop', receivedBytes: 11 };
      }),
    };
    const payload = { options: { min_p: 0.05 } };
    await runModelTest(
      { modelId: 'q:4b', scope: 'all' },
      {
        transport,
        serverUrl: 'http://127.0.0.1:11434',
        configuredMode: 'json',
        offeredModes: ['json', 'off'],
        adaptSchema: (s) => ({ schema: s, dropped: [] }),
        probeLimits: () => ({ contextTokens: 32768, maxOutputTokens: null }),
        reasoningSelection: () => ({ engine: 'local', model: 'q:4b' }),
        configuredReasoning: () => 'off',
        extraParams: payload,
        now: () => new Date('2026-09-11T10:00:00.000Z'),
      },
    );
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((c) => c.extraParams === payload)).toBe(true);
  });
});
```

In W3c's `server/src/analyzer/model-test-deps.test.ts`, add a case to its endpoint describe. Give the file's `lab` endpoint fixture `extraParams: { max_completion_tokens: 2048 }` in that case's settings, then assert `expect(d.extraParams).toEqual({ max_completion_tokens: 2048 });` and `expect(d.probeLimits().maxOutputTokens).toBe(2048);`.

In W3b's `server/src/analyzer/openai-analyzer.test.ts`, append inside `describe('OpenAIAnalyzer (#3084 PR 3b)', …)`. It reuses the file's `start`, `streamText`, `VALID`, `ID`, `bodies` and `endpoint(baseUrl, over)` helpers. `29_491` is W3b's own Auto value for this fixture, from its P24 case.
```ts
  it('openAIRequestSettings carries the endpoint payload, whose output cap replaces Auto and the served limit (#3084 wave 5, P19)', async () => {
    const lab = 'http://127.0.0.1:8080/v1';
    expect(openAIRequestSettings(endpoint(lab, { extraParams: { top_k: 20 } }))).toEqual({
      structuredOutput: 'schema',
      maxOutputTokens: 29_491,
      reasoning: 'model-default',
      extraParams: { top_k: 20 },
    });
    expect(
      openAIRequestSettings(endpoint(lab, { maxOutputTokens: 8_192, extraParams: { max_completion_tokens: 4_096 } }), 16_384).maxOutputTokens,
    ).toBe(4_096);
    expect(openAIRequestSettings(endpoint(lab, { extraParams: { max_tokens: null } }), 16_384).maxOutputTokens).toBeUndefined();
    const url = await start((_n, res) => streamText(res, VALID));
    await new OpenAIAnalyzer({ endpoint: endpoint(url, { extraParams: { top_k: 20 } }), apiKey: null, model: 'qwen3:30b' }).runStage1Chapter(ID, 1, '# p', {});
    expect((bodies[bodies.length - 1] as unknown as Record<string, unknown>).top_k).toBe(20);
  });
```

`server/src/routes/failure-taxonomy.payload-cap.test.ts` (N13):
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { classifyAnalysisFailure } from './failure-taxonomy.js';
import { AnalyzerReasoningOverflowError } from '../analyzer/errors.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

beforeEach(() => _resetUserSettingsCache());

describe('analyzer-reasoning-overflow names a payload key that set the output cap (#3084 wave 5, N13)', () => {
  it('Ollama: options.num_predict in the Ollama custom parameters, not num_ctx', () => {
    _setUserSettingsCacheForTest({ analyzerExtraParamsByEngine: { ollama: { options: { num_predict: 512 } } } });
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', 400), 'Ollama (qwen3.5:4b)');
    expect(f.code).toBe('analyzer-reasoning-overflow');
    expect(f.userMessage).toContain('Raise the custom parameter "options.num_predict" in the Ollama custom parameters');
    expect(f.userMessage).not.toContain('num_ctx');
  });

  it("an endpoint: the payload key in that endpoint's custom parameters, not its max output tokens", () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [
        analyzerEndpointSchema.parse({
          id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'any', contextTokens: 32768,
          extraParams: { max_completion_tokens: 4096 },
        }),
      ],
    });
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('openai', 'openai:lab::qwen3-30b', undefined), 'Lab box · qwen3-30b');
    expect(f.userMessage).toContain('Raise the custom parameter "max_completion_tokens" in the "Lab box" endpoint\'s custom parameters');
    expect(f.userMessage).not.toContain("this endpoint's max output tokens");
  });

  it('a payload that sets no output cap keeps the max-output setting in the copy', () => {
    _setUserSettingsCacheForTest({ analyzerExtraParamsByEngine: { gemini: { config: { topK: 40 } } } });
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', 'gemini-2.5-flash', 8192), 'Gemini 2.5 Flash');
    expect(f.userMessage).toContain("'Gemini max output tokens'");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**
Run: `npm --prefix server run test -- src/analyzer/transports/extra-params-wire.test.ts src/analyzer/runner/payload-temperature.test.ts src/analyzer/runner/free-text-payload.test.ts`
Expected: FAIL — `expected undefined to be 40` (payload not merged); temperature tests `expected 0.2 to be 0.95`; `free-text-payload.test.ts` fails at `does not provide an export named 'withoutPayloadOutputCap'`, and (once it exists) `sends the payload without its cap keys…` fails with `expected { top_k: 40, options: { num_predict: 64, min_p: 0.05 } } to deeply equal { top_k: 40, options: { min_p: 0.05 } }`. Its CONTROL case passes from the start. Also run `npm --prefix server run test -- src/analyzer/payload-output-cap.test.ts src/analyzer/gemini-payload-allowlist.test.ts src/analyzer/capabilities.payload.test.ts src/analyzer/model-test-deps.test.ts src/analyzer/openai-analyzer.test.ts`. Those FAIL with `maxOutputTokens` `null` / `-1`, `httpOptions` present, and `extraParams` `undefined`. The new `openai-analyzer.test.ts` case fails `toEqual`: `extraParams` is missing. Also run `npm --prefix server run test -- src/routes/failure-taxonomy.payload-cap.test.ts`: its first two cases FAIL with `expected '…' to contain 'Raise the custom parameter …'`, and its third passes (it pins the unchanged copy).

- [ ] **Step 3: Implement**

`ollama-transport.ts` — immediately after PR 5a's reasoning block, change the `body:` passed to `undiciFetch` from `JSON.stringify(body)` to `JSON.stringify(mergeExtraParams('ollama', body as Record<string, unknown>, req.extraParams))`, with `import { mergeExtraParams } from '../runner/extra-params.js';`. Make the identical change to the `undiciFetch(`${url}/api/chat`, { … body: JSON.stringify(body) … })` call inside W4's `sendFreeText` (the persona branch); its `options.num_gpu: 0` for `onCpu` survives for two reasons:
- `options` merges key by key;
- `mergeExtraParams` drops `options.num_gpu`, a protected key, from any payload that still carries it (one saved before the rule existed, or written straight to `user-settings.json`), and ignores a stored `options: null` (Task 5.8, P17).

`the persona call ignores a stored options:null and a stored options.num_gpu, and keeps num_gpu 0` pins it.

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

`openai-transport.ts` — after PR 5a's reasoning `Object.assign`, pass `mergeExtraParams('openai', params, req.extraParams, { reasoningStyle: this.endpoint.reasoningStyle })` to `client.chat.completions.create(…, { signal })` instead of `params`. The `ctx` lets the merge drop a stored `chat_template_kwargs.enable_thinking` under the `enable_thinking` style.

`stage-runner.ts` — Task 5.1 already forwards `extraParams: settings.extraParams` in two places. One is the private `send` helper, which `runStage`'s two attempts and `runSingleAttempt` share; the other is `runFreeText`. Only the validation retry must strip the payload temperature:
- give the helper a seventh parameter, `stripTemperature = false`;
- change its `extraParams` entry to:
```ts
      /* D9: a payload temperature sets attempt 1 only; on the validation retry
         the retry policy's temperature (req.temperature, applied natively) must win. */
      extraParams: stripTemperature ? stripPayloadTemperature(this.transport.kind, settings.extraParams) : settings.extraParams,
```
- pass `true` as the seventh argument only at `runStage`'s validation-retry call: `this.send(system, retry.messages, retry.temperature, structuredOutput, call, true, true)`.

`runSingleAttempt` is a single attempt, so it keeps the full payload. `runFreeText` (W4 Task 4.1) is a single attempt too, but its `extraParams` entry (Task 5.1) becomes:
```ts
      /* A4 — a persona request carries the engine's payload WITHOUT its output-cap keys: free text
         takes the model's own length (W4), and a cap chosen for chapter work would truncate a voice
         description. Every other payload key applies (P19). */
      extraParams: withoutPayloadOutputCap(this.transport.kind, settings.extraParams),
```
Import `stripPayloadTemperature` and `withoutPayloadOutputCap` from `./extra-params.js`.

`extra-params.ts` (Task 5.8) — add beside `payloadOutputCapKey`, reusing the same `OUTPUT_CAP` table, so the keys the copy names and the keys a persona drops can never diverge:
```ts
/** A4 — `params` without the keys that set the output cap (`payloadOutputCapKey`'s table): what a
    persona (free-text) request sends. The same object when the payload sets no cap; `undefined` for
    no payload. Never mutates `params`. */
export function withoutPayloadOutputCap(kind: TransportKind, params: Json | undefined): Json | undefined {
  if (!params || !payloadControlsOutputCap(kind, params)) return params;
  const { container, keys } = OUTPUT_CAP[kind];
  if (container === null) return Object.fromEntries(Object.entries(params).filter(([key]) => !keys.includes(key))) as Json;
  const inner = params[container] as Json;
  return {
    ...params,
    [container]: Object.fromEntries(Object.entries(inner).filter(([key]) => !keys.includes(key))),
  };
}
```

Settings closures: add an `extraParams:` entry to each. No wave 1–4 closure sets it, and neither does W3b's `openAIRequestSettings`.
- `OllamaAnalyzer`: `extraParams: resolveExtraParamsSetting(getCachedUserSettings(), { engine: 'local' }),`
- `GeminiAnalyzer`: `extraParams: resolveExtraParamsSetting(getCachedUserSettings(), { engine: 'gemini' }),`
- `OpenAIAnalyzer`: no closure edit. `openAIRequestSettings` gains the entry (see **Closures** below).
(import `resolveExtraParamsSetting` from `./runner/extra-params.js`).

**Payload output cap (P19).** The wire already carries a payload cap, because the merge replaces or removes the native key. These edits make every budget agree with it.

`capacity.ts`:
- Rename W2's `resolveCapacity` (as W3c Task 3c.9 widened it) to a private `resolveEngineCapacity`, body unchanged.
- Add `import { payloadOutputCap, resolveExtraParamsSetting } from './runner/extra-params.js';` and `import type { TransportKind } from './errors.js';`.
- Export:
```ts
/** P19 — a custom payload that sets or removes the output cap is the cap every consumer sizes against:
    chunk sizing, the catalog's `outputTokens` and the Test action's probe cap. An endpoint request's own
    cap is openAIRequestSettings', which applies the same rule through requestMaxOutputTokens.
    No payload → W2/W3c's value. */
export function resolveCapacity(sel: { engine: AnalysisEngine; model: string; endpoint?: AnalyzerEndpoint }): EngineCapacity {
  const capacity = resolveEngineCapacity(sel);
  const settings = getCachedUserSettings();
  const endpoint =
    sel.engine === 'openai'
      ? (sel.endpoint ?? settings.analyzerEndpoints.find((e) => e.id === parseEndpointModelId(sel.model)?.endpointId))
      : undefined;
  const cap = payloadOutputCap(sel.engine === 'local' ? 'ollama' : sel.engine, resolveExtraParamsSetting(settings, { engine: sel.engine, endpoint }));
  return cap === undefined ? capacity : { ...capacity, maxOutputTokens: cap };
}

/** P19 — a request's maxOutputTokens: the payload's cap when the payload controls it (`null`, a removed
    key, becomes `undefined`, the transport default the merge then strips), else the engine's resolver. */
export function requestMaxOutputTokens(
  kind: TransportKind,
  extraParams: Record<string, unknown> | undefined,
  resolve: () => number | undefined,
): number | undefined {
  const cap = payloadOutputCap(kind, extraParams);
  return cap === undefined ? resolve() : (cap ?? undefined);
}
```
W2's pinning test and W3c's capacity tests set no payload, so they stay green.

Closures:
- **`OllamaAnalyzer` and `GeminiAnalyzer`.** Make each closure's first statement the `extraParams` read above (`() => ({ … })` becomes `() => { const extraParams = resolveExtraParamsSetting(…); return { … }; }`), set `extraParams,`, and replace wave 2's output cap entry:
  - Ollama: `maxOutputTokens: requestMaxOutputTokens('ollama', extraParams, resolveNumPredict),`
  - Gemini: `maxOutputTokens: requestMaxOutputTokens('gemini', extraParams, () => resolveGeminiMaxOutputTokens(opts.model)),`
- **`OpenAIAnalyzer`.** Its closure calls W3b's `openAIRequestSettings(opts.endpoint, <served output limit>)`; W3c Task 3c.9 supplies the second argument from `getEndpointServedLimits`. Leave the closure alone. In `server/src/analyzer/openai.ts`, replace the function as Task 5.3 left it with:
```ts
export function openAIRequestSettings(endpoint: AnalyzerEndpoint, servedOutputLimit?: number): EngineRequestSettings {
  const extraParams = resolveExtraParamsSetting({}, { engine: 'openai', endpoint });
  return {
    structuredOutput: endpoint.structuredOutput,
    /* P19 — a payload that sets or removes max_tokens / max_completion_tokens is the request's cap and
       the overflow rule's budget; otherwise P24's manual value or Auto. */
    maxOutputTokens: requestMaxOutputTokens('openai', extraParams, () => resolveEndpointMaxOutputTokens(endpoint, servedOutputLimit)),
    /* #3084 wave 5 — an endpoint carries its own level. resolveReasoningSetting reads neither the
       settings file nor the model for engine 'openai', so neither is passed. */
    reasoning: resolveReasoningSetting({}, { engine: 'openai', model: '', endpoint }),
    /* The payload as saved. mergeExtraParams filters it again at send time (P17). */
    extraParams,
  };
}
```
  Add `import { resolveExtraParamsSetting } from './runner/extra-params.js';` and `import { requestMaxOutputTokens } from './capacity.js';`.

**Test probes carry the payload (P19, spec §9 "Test action").**
- `capabilities.ts` (W3c/Task 5.4):
  - `ModelTestDeps` gains `extraParams?: Record<string, unknown>;` directly after `configuredReasoning`.
  - The `sendStep` literal gains `extraParams: deps.extraParams,` directly after `reasoning,`.
- `model-test-deps.ts`, in `modelTestDepsFor`:
  - Make `const extraParams = resolveExtraParamsSetting(settings, reasoningSelectionFor(settings, modelId));` its first statement, and add `extraParams,` to the `offered` object.
  - Wrap each of the three returned `probeLimits` closures as `probeLimits: withPayloadCap('<kind>', extraParams, <W3c's closure>)`, where `<kind>` is `'openai'`, `'gemini'` or `'ollama'` for that branch.
  - Import `payloadOutputCap, resolveExtraParamsSetting` from `./runner/extra-params.js`, and add in the same file:
```ts
/** P19 — Test probes size against the payload's output cap when it sets or removes one. */
function withPayloadCap(
  kind: 'openai' | 'gemini' | 'ollama',
  extraParams: Record<string, unknown> | undefined,
  limits: () => { contextTokens: number; maxOutputTokens: number | null },
): () => { contextTokens: number; maxOutputTokens: number | null } {
  return () => {
    const base = limits();
    const cap = payloadOutputCap(kind, extraParams);
    return cap === undefined ? base : { ...base, maxOutputTokens: cap };
  };
}
```

**Overflow copy names a payload cap key (N13).** In `server/src/routes/failure-taxonomy.ts`, add `import { payloadOutputCapKey, resolveExtraParamsSetting } from '../analyzer/runner/extra-params.js';` (a pure module: no cycle) and this helper beside Task 5.5's `reasoningControlFor`:
```ts
/* #3084 wave 5 (N13) — when a custom payload key set the output cap, that key is the setting to raise: the
   engine's max-output setting is overridden by it (P19), so naming the setting would send the user to a
   control that changes nothing. */
/** Exported (review item 6, 2026-09-13) so Task 5.11b's endpoint payload fix can build the same
    "custom parameter … in …" phrase this overflow copy uses, instead of hand-typing a second copy
    of it in the fixes list. */
export function customParamsWhere(transport: TransportKind, endpointName: string | undefined): string {
  return transport === 'openai'
    ? endpointName
      ? `the "${endpointName}" endpoint's custom parameters`
      : "this endpoint's custom parameters"
    : `the ${transport === 'ollama' ? 'Ollama' : 'Gemini'} custom parameters (Advanced settings → Analyzer request controls)`;
}

function payloadCapSettingFor(err: AnalyzerReasoningOverflowError): string | undefined {
  const settings = getCachedUserSettings();
  const parsed = err.transport === 'openai' ? parseEndpointModelId(err.model) : null;
  const endpoint = parsed ? settings.analyzerEndpoints?.find((e) => e.id === parsed.endpointId) : undefined;
  const engine = err.transport === 'ollama' ? ('local' as const) : err.transport;
  const key = payloadOutputCapKey(err.transport, resolveExtraParamsSetting(settings, { engine, endpoint }));
  if (!key) return undefined;
  return `the custom parameter "${key}" in ${customParamsWhere(err.transport, endpoint?.name)}`;
}
```
In W2's `AnalyzerReasoningOverflowError` branch, change `const outputSetting =` to `const outputSetting = payloadCapSettingFor(err) ??`, keeping W2's three-way ternary as the right-hand operand (wrap it in parentheses). The copy then reads `Raise ${outputSetting}, …` with the payload key when one set the cap.

- [ ] **Step 4: Run and confirm they pass**
Run: `npm --prefix server run test -- src/routes/failure-taxonomy.payload-cap.test.ts src/routes/failure-taxonomy.reasoning.test.ts src/routes/failure-taxonomy.test.ts src/analyzer/transports src/analyzer/runner src/analyzer/ollama.test.ts src/analyzer/voice-style.test.ts src/analyzer/payload-output-cap.test.ts src/analyzer/gemini-payload-allowlist.test.ts src/analyzer/capabilities.payload.test.ts src/analyzer/model-test-deps.test.ts src/analyzer/capacity.test.ts src/analyzer/capacity-pinning.test.ts src/analyzer/openai-analyzer.test.ts` and `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts`, then `npm run check:cycles`  Expected: PASS; no new cycle. `capacity.ts` → `runner/extra-params.ts` is safe, because that module imports only `errors.ts` types and `redact.ts`. `openai.ts` → `capacity.ts` is a new edge. If madge reports a cycle through it, move `requestMaxOutputTokens` into `runner/extra-params.ts` (it needs only `payloadOutputCap`), import it from there in `capacity.ts` and `openai.ts`, and re-run. Keeps green: every W1–W4 transport/runner suite (no payload → `mergeExtraParams` returns the native object), PR 5a's `reasoning-wire.test.ts`.

- [ ] **Step 5: Mutation proof**
1. In `stage-runner.ts` pass `false` instead of `true` as the seventh argument at `runStage`'s validation-retry `this.send(…)` call. Expected red: all three `a payload temperature sets attempt 1 only` cases (Ollama, OpenAI, Gemini). Restore.
2. In `ollama-transport.ts` pass `JSON.stringify(body)` again in the streaming call. Expected red: `merges options key by key and keeps pipeline-owned options`. Restore.
2b. Same revert in `sendFreeText` only. Expected red: `the persona (free-text) call merges the payload too, keeping its own num_gpu and stream:false`. Restore.
2c. In `runFreeText` replace `withoutPayloadOutputCap(this.transport.kind, settings.extraParams)` with `settings.extraParams`. Expected red: `sends the payload without its cap keys, and still no engine output cap of its own` and `the persona (free-text) call drops the payload output cap and keeps every other key (A4)`. Restore.
2d. In `withoutPayloadOutputCap` drop the `payloadControlsOutputCap` guard and always rebuild. Expected red: `returns the same object when the payload sets no cap, and undefined for none` (`toBe`). Restore. Then make it filter only `keys[0]`. Expected red: `drops every cap key of that kind and nothing else` (openai keeps `max_completion_tokens`). Restore.
3. In `extra-params.ts` change `OWNED_CONTAINERS.openai` to `[]` (so `chat_template_kwargs` is replaced wholesale). Expected red: `keeps enable_thinking from the reasoning level when the payload adds template kwargs`. Restore.
4. In `openai-transport.ts` drop the `{ reasoningStyle: this.endpoint.reasoningStyle }` argument. Expected red: `drops a stored chat_template_kwargs.enable_thinking under the enable_thinking style (P17)`. Restore.
5. In `resolveCapacity` return `capacity` unconditionally. Expected red: `options.num_predict 512: capacity reports 512…` and `an endpoint payload max_completion_tokens replaces the saved cap`. Restore.
6. In `OllamaAnalyzer`'s closure replace `requestMaxOutputTokens('ollama', extraParams, resolveNumPredict)` with `resolveNumPredict()`. Expected red: `options.num_predict 512…` (the request carries W2's value). Restore.
7. In `sendStep` delete `extraParams: deps.extraParams,`. Expected red: `every ladder request sends the payload a run would send`. Restore.
8. In `modelTestDepsFor` pass W3c's endpoint closure without `withPayloadCap(…)`. Expected red: the `model-test-deps.test.ts` payload case (`probeLimits().maxOutputTokens`). Restore.
9. In `gemini-transport.ts` build the request as `{ model: this.model, contents, config: { ...configWithReasoning, ...((req.extraParams?.config as object) ?? {}) } }` instead of `mergeExtraParams(…)`. Expected red: `is dropped at merge when injected straight into settings, while allowlisted keys still apply`. Restore.
10. In `openAIRequestSettings` replace the `requestMaxOutputTokens('openai', extraParams, () => …)` call with `resolveEndpointMaxOutputTokens(endpoint, servedOutputLimit)`. Expected red: `openAIRequestSettings carries the endpoint payload, whose output cap replaces Auto and the served limit…` (8_192, not 4_096). Restore.
11. In `openAIRequestSettings` delete the `extraParams,` entry. Expected red: the same case (its `toEqual`, and the wire's `top_k` is `undefined`). Restore.
12. In the overflow branch replace `payloadCapSettingFor(err) ?? (…)` with W2's ternary alone. Expected red: `Ollama: options.num_predict in the Ollama custom parameters, not num_ctx` and `an endpoint: the payload key in that endpoint's custom parameters…` (N13). Restore.

- [ ] **Step 6: Commit**
```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy.payload-cap.test.ts server/src/analyzer/transports server/src/analyzer/runner/stage-runner.ts server/src/analyzer/runner/extra-params.ts server/src/analyzer/runner/extra-params.test.ts server/src/analyzer/runner/free-text-payload.test.ts server/src/analyzer/runner/payload-temperature.test.ts server/src/analyzer/ollama.ts server/src/analyzer/gemini.ts server/src/analyzer/openai.ts server/src/analyzer/capacity.ts server/src/analyzer/capabilities.ts server/src/analyzer/model-test-deps.ts server/src/analyzer/model-test-deps.test.ts server/src/analyzer/payload-output-cap.test.ts server/src/analyzer/gemini-payload-allowlist.test.ts server/src/analyzer/capabilities.payload.test.ts server/src/analyzer/openai-analyzer.test.ts
git commit -m "feat(server): merge the custom payload last on every transport; retry temperature wins on attempt 2"
```

### Task 5.11: Redact payload values from upstream error text; prove the payload is never logged or persisted

**Files:**
- Modify: `server/src/analyzer/transports/ollama-transport.ts` — W3b Task 3b.6a's construction-time redaction in the streaming non-OK branch, the same line W4 Task 4.2 put in `sendFreeText`'s non-OK branch, and the in-stream `parsed.error` branch (moved from `ollama.ts:793-795` at `80be2f1d`, re-pinned from `:792-794`)
- Modify: `server/src/analyzer/transports/gemini-transport.ts` — W3b Task 3b.6a's `redactGeminiError(err, …)` call in `generate`'s `catch`
- Modify: `server/src/analyzer/transports/openai-transport.ts` — W3b Task 3b.11's per-attempt `secrets` array in `send()`, which feeds `classifyOpenAIOutcome`'s `OutcomeContext.secrets`
- No change: `server/src/workspace/user-settings.ts` (`knownAnalyzerSecrets()`), `server/src/analyzer/known-secrets-gate.ts` (how the failure taxonomy reaches that list), `server/src/routes/failure-taxonomy.ts`, `server/src/analyzer/transports/allowlisted-fetch.ts`, and W3b's Detect (`server/src/analyzer/endpoint-detect.ts`). See Step 3.
- Test: `server/src/analyzer/runner/extra-params-privacy.test.ts`

**Scope (P29, N15).** Payload values are redacted only from the errors of the request that carried that payload. Each transport adds `payloadSecretValues(req.extraParams)` to the secrets W3b already builds for that request, on every path W3b redacts:
- Ollama and Gemini: Task 3b.6a's construction-time redaction;
- OpenAI: the excerpt, the unreachable error's `causeCode`, and rule 7's `AnalyzerTransportError` rebuild through `sanitizeCauseCode`.

The values never join `knownAnalyzerSecrets()`, which the failure taxonomy reads through `known-secrets-gate.ts` for every engine's errors. There, a Gemini payload's `BLOCK_NONE` would blank that word in an unrelated Ollama or endpoint error.

**Interfaces:**
- Consumes:
  - Task 5.8's `payloadSecretValues` and `REDACTED` (its `redactPayloadValues` is not used here: every site appends to the secrets list W3b already builds, rather than redacting against the payload alone);
  - W3b's `redactKnownSecrets` (`analyzer/redact.ts`), `loadKnownAnalyzerSecrets` and `knownAnalyzerSecrets` (`user-settings.ts`; the taxonomy reaches the latter through `known-secrets-gate.ts`), `redactGeminiError` (Task 3b.6a), `classifyOpenAIOutcome`, `sanitizeCauseCode` and `AnalyzerTransportError(transport, model, message, causeCode)` (Tasks 3b.1, 3b.11). All are unchanged here;
  - `ApiError` (`@google/genai`), `classifyAnalysisFailure` (`failure-taxonomy.ts:492`), `_setUserSettingsCacheForTest`.
- Produces the privacy guarantee. For the request that carried it, no payload value (≥ 8 chars) appears in any of these: a `console.*` call, a thrown error's message or stack, `AnalyzerHttpError.bodyExcerpt`, a `causeCode`, a failure's `userMessage`/`detail`, or a file the analyzer writes. And no payload value is redacted from any other request's error.
- Rebuilt errors: this task rebuilds and wraps no error of its own. The Gemini rebuild stays W3b's `redactGeminiError` (an `ApiError` rebuilt as an `ApiError` with its status, no `cause`). The OpenAI rebuild stays rule 7's `AnalyzerTransportError`, with a names-only message and no `cause`.

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/runner/extra-params-privacy.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { z } from 'zod';
import { ApiError, type GoogleGenAI } from '@google/genai';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY, OPENAI_RETRY_POLICY } from './retry-policy.js';
import { REDACTED } from './extra-params.js';
import { OllamaTransport } from '../transports/ollama-transport.js';
import { OpenAITransport } from '../transports/openai-transport.js';
import { GeminiTransport } from '../transports/gemini-transport.js';
import { AnalyzerHttpError } from '../errors.js';
import { geminiRateLimiter } from '../rate-limit.js';
import { analyzerEndpointSchema } from '../../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest, knownAnalyzerSecrets } from '../../workspace/user-settings.js';
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
  /* The mock created this directory once, at import. Recreate it per test, or a stage case fails in
     writeInbox (ENOENT) before it ever reaches the transport it is meant to exercise. */
  mkdirSync(HANDOFF_DIR, { recursive: true });
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
    /* No saved settings: the values reach the redaction from this request's own payload (P29). */
    const payload = { user_tag: SENTINEL };
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

  it("Ollama in-stream error: the daemon's echo is redacted against the payload AND the saved secrets (P22, P29)", async () => {
    const SAVED = 'AIzaSy-privacy-saved-secret-1';
    _setUserSettingsCacheForTest({ geminiApiKey: SAVED });
    /* An error line inside an open 200 stream, echoing the request body and a saved key. */
    const url = await startServer((raw) => ({
      status: 200,
      type: 'application/x-ndjson',
      body: `${JSON.stringify({ error: `bad options ${raw} for key ${SAVED}` })}\n`,
    }));
    const req: TransportRequest = {
      system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' },
      temperature: 0.2, extraParams: { user_tag: SENTINEL }, estimatedInputTokens: 5, call: {},
    };
    const err = await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect((err as Error).message).toContain('stream error:');
    expect((err as Error).message).not.toContain(SENTINEL); // this task adds the payload values
    expect((err as Error).message).not.toContain(SAVED); // PR 3b's known secrets are still redacted
    expect((err as Error).message).toContain(REDACTED);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it('OpenAI-compatible: a 400 naming the parameter value is redacted', async () => {
    const base = await startServer(() => ({
      status: 400, type: 'application/json',
      body: JSON.stringify({ error: { message: `unsupported parameter user_tag=${SENTINEL}`, type: 'invalid_request_error' } }),
    }));
    const endpoint = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `${base}/v1`, gpu: 'none', contextTokens: 32768, extraParams: { user_tag: SENTINEL } });
    /* No saved settings: this request's payload values join the attempt's secrets (P29), which W3b's
       classifyOpenAIOutcome applies to the excerpt, the causeCode and rule 7's rebuild alike. */
    const req: TransportRequest = { system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2, extraParams: { user_tag: SENTINEL }, estimatedInputTokens: 5, call: {} };
    const err = await new OpenAITransport({ endpoint, apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect(`${(err as AnalyzerHttpError).message}\n${(err as AnalyzerHttpError).bodyExcerpt}`).not.toContain(SENTINEL);
    expect(everythingLogged()).not.toContain(SENTINEL);
    void OPENAI_RETRY_POLICY;
  });

  it('Gemini: the SDK error is rebuilt with a redacted message AND stack before it is logged or rethrown', async () => {
    const client = {
      models: {
        generateContentStream: vi.fn(async () => {
          throw new ApiError({
            status: 400,
            message: `got status: 400 INVALID_ARGUMENT. {"error":{"code":400,"message":"Invalid value at 'safety_settings[0].category' (${SENTINEL})","status":"INVALID_ARGUMENT"}}`,
          });
        }),
      },
    } as unknown as GoogleGenAI;
    const req: TransportRequest = {
      system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2,
      extraParams: { config: { safetySettings: [{ category: SENTINEL, threshold: 'BLOCK_NONE' }] } }, estimatedInputTokens: 5, call: {},
    };
    const err = await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client }).send(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError); // W3b's redactGeminiError rebuilds an ApiError as an ApiError
    expect((err as { status?: number }).status).toBe(400); // the retry classifier and the taxonomy still read it
    expect((err as Error).message).not.toContain(SENTINEL);
    expect((err as Error).message).toContain(REDACTED);
    expect((err as Error).stack ?? '').not.toContain(SENTINEL);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it("a Gemini error from a payload-carrying request stays redacted through classifyAnalysisFailure's envelope detail", async () => {
    const client = {
      models: {
        generateContentStream: vi.fn(async () => {
          throw new ApiError({
            status: 400,
            message: `got status: 400 INVALID_ARGUMENT. {"error":{"code":400,"message":"bad","status":"INVALID_ARGUMENT","details":[{"note":"${SENTINEL}"}]}}`,
          });
        }),
      },
    } as unknown as GoogleGenAI;
    const req: TransportRequest = {
      system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2,
      extraParams: { config: { safetySettings: [{ category: SENTINEL, threshold: 'BLOCK_NONE' }] } }, estimatedInputTokens: 5, call: {},
    };
    const err = await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client }).send(req).catch((e: unknown) => e);
    const failure = classifyAnalysisFailure(err, 'Gemini 3.6 Flash');
    expect(`${failure.userMessage}\n${failure.detail ?? ''}`).not.toContain(SENTINEL);
  });

  it('OpenAI-compatible: a value straddling the 500-character excerpt cut leaves no fragment', async () => {
    const LONG = `cw-straddle-${'x'.repeat(40)}`;
    const base = await startServer(() => ({
      status: 400, type: 'application/json',
      body: JSON.stringify({ error: { message: `${'p'.repeat(470)}${LONG}`, type: 'invalid_request_error' } }),
    }));
    const endpoint = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `${base}/v1`, gpu: 'none', contextTokens: 32768, extraParams: { user_tag: LONG } });
    /* This request's payload feeds the attempt's secrets, which classifyOpenAIOutcome applies to the whole body before it slices. */
    const req: TransportRequest = { system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2, extraParams: { user_tag: LONG }, estimatedInputTokens: 5, call: {} };
    const err = await new OpenAITransport({ endpoint, apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    /* Sliced first, the excerpt ends inside the value, and a partial value matches no redaction. */
    expect(`${(err as AnalyzerHttpError).message}\n${(err as AnalyzerHttpError).bodyExcerpt}`).not.toContain('cw-');
  });

  it("payload values are redacted only from their own request's errors: BLOCK_NONE stays in an unrelated engine's error (N15, P29)", async () => {
    _setUserSettingsCacheForTest({
      analyzerExtraParamsByEngine: { gemini: { config: { safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }] } } },
    });
    expect(knownAnalyzerSecrets()).not.toContain('BLOCK_NONE');
    const url = await startServer(() => ({ status: 400, type: 'application/json', body: JSON.stringify({ error: 'unsupported safety threshold BLOCK_NONE' }) }));
    const req: TransportRequest = {
      system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2, estimatedInputTokens: 5, call: {},
    };
    const err = await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect((err as AnalyzerHttpError).message).toContain('BLOCK_NONE');
    expect((err as AnalyzerHttpError).message).not.toContain(REDACTED);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/runner/extra-params-privacy.test.ts`
Expected:
- The first case PASSES: nothing in the runner logs or persists request bodies today, so it is the lock against a future regression.
- The Ollama, Ollama persona, Ollama in-stream, OpenAI, Gemini and Gemini-through-the-taxonomy cases FAIL with `expected '… cw-sentinel-9f3a7c21 …' not to contain 'cw-sentinel-9f3a7c21'`. W3b redacts only the known secrets, and no payload value is among them. In the in-stream case the `not.toContain(SAVED)` assertion already holds: it pins 3b's redaction, which this task must keep.
- The straddle case FAILS too.
- The N15 case PASSES: payload values are not global today. It locks the scope; mutation 4 shows it can fail.

Every stage case reaches its transport: the directory is recreated after `rmSync`, so none fails in `writeInbox` with ENOENT.

- [ ] **Step 3: Implement**

`ollama-transport.ts` — W3b Task 3b.6a built the streaming non-OK excerpt as `redactKnownSecrets(text, await loadKnownAnalyzerSecrets()).slice(0, 500)`. Replace that line with the one below, which adds this request's payload values to the list and still redacts before slicing:
```ts
        const bodyExcerpt = redactKnownSecrets(text, [...(await loadKnownAnalyzerSecrets()), ...payloadSecretValues(req.extraParams)]).slice(0, 500);
```
Make the identical replacement in W4's `sendFreeText` `if (!response.ok)` branch, where W4 Task 4.2 carried that same 3b line through the move.

In the in-stream error branch, PR 3b already redacts the daemon's echo (Task 3b.6a built `const streamError = redactKnownSecrets(String(parsed.error), await loadKnownAnalyzerSecrets());`). Append this request's payload values to 3b's list there too, rather than replacing that call:
```ts
              const streamError = redactKnownSecrets(String(parsed.error), [
                ...(await loadKnownAnalyzerSecrets()),
                ...payloadSecretValues(req.extraParams),
              ]);
```
**All three Ollama sites keep 3b's `loadKnownAnalyzerSecrets()` term; this task only appends to the list.** Dropping it would trade one leak for another: a saved key echoed back would stop being redacted. Import `payloadSecretValues` from `../runner/extra-params.js` (`redactPayloadValues` is not needed here — it would replace 3b's list instead of extending it).

`gemini-transport.ts` — in `generate`'s `catch`, W3b Task 3b.6a's tail reads `const safe = redactGeminiError(err, await loadKnownAnalyzerSecrets());`. Replace that statement with:
```ts
        /* #3084 P22, P29 — redacted before it is logged or rethrown: every known analyzer secret, plus the values
           of the payload THIS request carried (never another request's). */
        const safe = redactGeminiError(err, [...(await loadKnownAnalyzerSecrets()), ...payloadSecretValues(req.extraParams)]);
```
W3b's `redactGeminiError` already does the rebuilding, so do not add a second rebuilder:
- it rebuilds an `ApiError` as an `ApiError` with its status and the redacted message, so the new stack is built from the redacted text;
- it attaches no `cause`;
- it returns an error with nothing to redact as the same object.

Import `payloadSecretValues` from `../runner/extra-params.js`.

`openai-transport.ts` — in `send()`, W3b Task 3b.11 builds each attempt's secrets as `const secrets = [...(this.apiKey ? [this.apiKey] : []), ...(await loadKnownAnalyzerSecrets())];` and passes them as `OutcomeContext.secrets`. Replace it with:
```ts
    /* P22, P29 — every error this attempt builds is redacted against this endpoint's key, every saved
       analyzer secret, and the values of the payload THIS request carries. */
    const secrets = [
      ...(this.apiKey ? [this.apiKey] : []),
      ...(await loadKnownAnalyzerSecrets()),
      ...payloadSecretValues(req.extraParams),
    ];
```
That one array feeds every redaction path `classifyOpenAIOutcome` has:
- the `AnalyzerHttpError` excerpt, redacted before it is sliced;
- the unreachable error's `causeCode`, through `sanitizeCauseCode(unreachableCode, ctx.secrets)`;
- rule 7's `AnalyzerTransportError(transport, model, message, causeCode)`, through `sanitizeCauseCode(codes[0], ctx.secrets)`.

Rule 7's rebuild keeps its names-only message (`chainClassNames`) and attaches no `cause`, and this task changes neither. `req` is `send`'s request parameter. Import `payloadSecretValues` from `../runner/extra-params.js`. The transport's `fetch` stays W3b's `allowlistedFetch` from `transports/allowlisted-fetch.ts`, untouched.

**No change elsewhere.**
- **Global secrets.** `knownAnalyzerSecrets()` (`user-settings.ts`) and the taxonomy's `known-secrets-gate.ts` stay payload-free (P29). A transport has already redacted the error it builds for its own request, so `classifyAnalysisFailure`'s `raw` and detail blob carry no payload value. An error that never passed through a transport did not come from a request that carried a payload.
- **Detect.** W3b's Detect (`detectServedContext`, Task 3b.8) sends a bare `GET /props`, with no request body and no payload. No payload value can reach its error text, so P29 gives it nothing to redact. It keeps `secrets: await loadKnownAnalyzerSecrets()`.


- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/runner/extra-params-privacy.test.ts src/routes/failure-taxonomy.test.ts src/analyzer/transports` then `npm run check:cycles`
Expected: PASS; no new cycle. Keeps green:
- `failure-taxonomy.test.ts` detail-blob cases: `knownAnalyzerSecrets()` is unchanged;
- W3b's `transport-redaction.test.ts` (Task 3b.6a): with no payload on the request, the secrets list is W3b's own;
- the W1/W3 transport error-classification suites;
- W3b's OpenAI transport contract suite, including its redaction and "no raw cause" cases.

- [ ] **Step 5: Mutation proof**
1. In the Ollama streaming non-OK line drop `...payloadSecretValues(req.extraParams)`. Expected red: `Ollama: a 400 that echoes the request is redacted …`. Restore.
1b. Drop the same term in `sendFreeText`. Expected red: `Ollama persona (free-text) call: a 400 that echoes the request is redacted`. Restore.
1c. Drop the same term from the in-stream `streamError` list. Expected red: `Ollama in-stream error: the daemon's echo is redacted against the payload AND the saved secrets`. Restore.
1d. At each of the three Ollama sites in turn, replace 3b's list with `payloadSecretValues(req.extraParams)` alone (dropping `await loadKnownAnalyzerSecrets()`). Expected red each time: W3b's own `transport-redaction.test.ts` cases (a 500 body, an in-stream line, the persona body echoing a saved secret), and for the in-stream site also this task's `not.toContain(SAVED)` assertion. Restore.
2. In the Gemini `catch`, drop `...payloadSecretValues(req.extraParams)` from `redactGeminiError`'s list. Expected red: `Gemini: the SDK error is rebuilt with a redacted message AND stack…` and `a Gemini error from a payload-carrying request stays redacted through classifyAnalysisFailure's envelope detail`. Restore.
3. In `OpenAITransport.send()` drop `...payloadSecretValues(req.extraParams)` from `secrets`. Expected red: `OpenAI-compatible: a 400 naming the parameter value is redacted` and `OpenAI-compatible: a value straddling the 500-character excerpt cut leaves no fragment`. Restore.
3a. In W3b's `classifyOpenAIOutcome`, slice before redacting: `redactKnownSecrets(JSON.stringify(err.error ?? err.message).slice(0, 500), ctx.secrets)`. Expected red: `OpenAI-compatible: a value straddling the 500-character excerpt cut leaves no fragment` (the cut leaves an 18-character fragment that matches no secret). Restore.
4. Make payload values global: in W3b's `knownAnalyzerSecrets()` add `out.push(...payloadSecretValues(cached?.analyzerExtraParamsByEngine?.gemini));` before `return out;` (importing `payloadSecretValues`). Expected red: `payload values are redacted only from their own request's errors: BLOCK_NONE stays in an unrelated engine's error (N15, P29)` (`knownAnalyzerSecrets()` contains `BLOCK_NONE`, and the Ollama error reads `[redacted]`). Remove.
5. In `stage-runner.ts`, add a temporary `console.debug('[runner] request', JSON.stringify(settings.extraParams));` before the first send. Expected red: `a stage with a validation retry sends the payload but writes and logs none of it`. Remove.

- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports server/src/analyzer/runner/extra-params-privacy.test.ts
git commit -m "feat(server): redact custom payload values from upstream error text and lock payload privacy"
```

### Task 5.11b: `reasoningOverflowFixes` — endpoint payload `max_tokens` fix (F7)

**Precondition:** Task 5.5b's endpoint reasoning fix is in place; this task adds a second endpoint fix beside it, for the endpoint's custom payload, once that payload can affect the output cap (Task 5.8's `payloadOutputCapKey`).

**Corrected (review pass 1 + wave 3 review + review pass 2, 2026-09-13):** `payloadOutputCapKey` takes the transport kind as its first argument (`payloadOutputCapKey(kind: TransportKind, params: Json | undefined): string | undefined`, Task 5.8) — an earlier draft called it with one argument. The payload itself is resolved through `resolveExtraParamsSetting(settings, { engine, endpoint })` (Task 5.8), the same call Task 5.11's `payloadCapSettingFor` already makes. **No redeclared `endpoint` (corrected, review pass 3, item 5; review pass 2, item 8 retired).** 3b's `openai` branch already resolves `const endpoint = getCachedUserSettings().analyzerEndpoints.find((e) => e.id === ctx.endpointId);` inside `if (ctx.transport === 'openai' && ctx.endpointId)`; this task's fix lands inside that same block and reuses that `endpoint` — no second `const endpoint = …`, no separate `if (ctx.transport === 'openai' …)` (see Step 3 below, "do not resolve it twice"). The fix's phrase reuses Task 5.11's own `customParamsWhere(transport, endpointName)` instead of hand-typing a second copy of "the … endpoint's custom parameters". **The payload fix itself carries no `wikiPage` (review pass 2, item 10b)** — `wikiPage` names a single, list-level "Read: <section>" entry, not a property every fix repeats (Task 5.5b's rule, same here). Instead, when the payload fix applies, this task appends **one additional, separate entry, into `reads` rather than `fixes` (review pass 3, item 1)**: `{ label: 'Read: Custom payload', wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints' }` — the page's "Custom payload" section (created in this same PR, Task 5.12, so the page exists when the fix ships).

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts` — extend `reasoningOverflowFixes(ctx)`'s `openai` branch with the payload fix and the "Read: Custom payload" entry; export `customParamsWhere` from Task 5.11's helper if it is not already exported there
- Modify: `server/src/routes/failure-taxonomy-fixes.test.ts` (Task 5.5b's guard-test file) — append cases, extend the guard's page-existence check, and add mutation rows

**Interfaces:**
- Consumes: `payloadOutputCapKey(kind, params)` and `resolveExtraParamsSetting(settings, sel)` (Task 5.8, `server/src/analyzer/runner/extra-params.ts`); `customParamsWhere(transport, endpointName)` (Task 5.11, `server/src/routes/failure-taxonomy.ts`); `getCachedUserSettings` (`server/src/workspace/user-settings.ts`); `analyzerEndpointSchema`'s `extraParams` field; 3d.9a's wiki-page-existence guard (extended here with this task's `wikiPage` value).
- Produces: for `ctx.transport === 'openai'`, when the endpoint's saved `extraParams` (via `resolveExtraParamsSetting`) sets an output-cap key (`payloadOutputCapKey` returns one), `reasoningOverflowFixes` appends `{ label: 'Raise the custom parameter "<key>" in <customParamsWhere(...)>', endpointField: { endpointId: ctx.endpointId, field: 'extraParams' } }` (no `wikiPage`) **and** `{ label: 'Read: Custom payload', wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints' }`. The `endpointField` shape is the same `field: 'extraParams'` Task 5.11's redaction and Task 5.9's validation already treat as one endpoint field — the fix names the specific key inside it in its `label` only, since `endpointField.field` must be a schema key, not a path into one.

- [ ] **Step 1: Write the failing test**
```ts
describe('reasoningOverflowFixes — endpoint custom-payload output cap (#3084 wave 5b, F7)', () => {
  afterEach(() => _resetUserSettingsCache());

  it("names the endpoint's own payload key when its custom parameters set the output cap, and links Custom payload", () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [analyzerEndpointSchema.parse({
        id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'none', contextTokens: 32768,
        extraParams: { max_completion_tokens: 4096 },
      })],
    });
    const fixes = reasoningOverflowFixes({ transport: 'openai', model: 'm', endpointId: 'lab' });
    const payloadFix = fixes.find((f) => f.label.includes('max_completion_tokens'));
    expect(payloadFix?.endpointField).toEqual({ endpointId: 'lab', field: 'extraParams' });
    expect(payloadFix?.wikiPage).toBeUndefined(); // review pass 2, item 10b — no per-fix wikiPage
    expect(payloadFix?.label).toMatch(/"Lab box".*custom parameters/);
    const readFix = fixes.find((f) => f.label === 'Read: Custom payload');
    expect(readFix?.wikiPage).toBe('OpenAI-Compatible-Analyzer-Endpoints');
  });

  it('adds no payload fix, and no Read: Custom payload entry, when the endpoint sets no output-cap key', () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'none', contextTokens: 32768 })],
    });
    const fixes = reasoningOverflowFixes({ transport: 'openai', model: 'm', endpointId: 'lab' });
    expect(fixes.some((f) => f.endpointField?.field === 'extraParams')).toBe(false);
    expect(fixes.some((f) => f.label === 'Read: Custom payload')).toBe(false);
  });
});

/* Review pass 3, item 1: wave 2 changed `reasoningOverflowFixes` to build two internal arrays —
   `fixes` (actionable) and `reads` (the `Read: …` list-level entries) — and return
   `[...fixes, ...reads]`, so every actionable fix precedes every Read: entry (there may be more
   than one Read: entry). This task's own payload fix (`fixes.push`) and its "Read: Custom
   payload" entry (`reads.push`) are one instance of that contract; Task 5.5b's Gemini/Ollama/
   endpoint reasoning fixes (all `fixes.push`, no Read: entries of their own) are another. This
   guard proves the contract holds across every fixture the guard test already iterates, not just
   this task's own two cases above. */
describe('fixes-then-reads ordering (#3084 wave 5, review pass 3, item 1)', () => {
  it('no actionable fix (5a/5b or otherwise) ever appears after a Read: entry', () => {
    for (const fixes of ALL_FIXTURE_FIXES_LISTS) {
      const firstReadIdx = fixes.findIndex((f) => f.label.startsWith('Read: '));
      if (firstReadIdx === -1) continue; // no Read: entry in this fixture — nothing to check
      const tail = fixes.slice(firstReadIdx);
      expect(tail.every((f) => f.label.startsWith('Read: ')), JSON.stringify(tail)).toBe(true);
    }
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Expected: FAIL — the first case finds no `payloadFix` and no `readFix`; the second already passes; the ordering guard passes vacuously until this task's fixture (added below) exercises a `reads` entry.
- [ ] **Step 3: Implement**
In `reasoningOverflowFixes`'s `openai` branch, after Task 5.5b's reasoning fix (`endpoint` is the same resolved value that fix already computes — do not resolve it twice):
```ts
  const capKey = payloadOutputCapKey('openai', resolveExtraParamsSetting(getCachedUserSettings(), { engine: 'openai', endpoint }));
  if (capKey) {
    fixes.push({
      label: `Raise the custom parameter "${capKey}" in ${customParamsWhere('openai', endpoint?.name)}`,
      endpointField: { endpointId: ctx.endpointId!, field: 'extraParams' },
    });
    reads.push({ label: 'Read: Custom payload', wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints' }); // review pass 3, item 1 — Read: entries go in `reads`, not `fixes`, so `reasoningOverflowFixes` can return `[...fixes, ...reads]`
  }
```
(Import `payloadOutputCapKey`, `resolveExtraParamsSetting` from `../analyzer/runner/extra-params.js` and `customParamsWhere` from this same file's Task 5.11 export.)
**Guard test (3d.9a extension).** The page-existence guard needs a `reasoningOverflowFixes` call whose result carries this "Read: Custom payload" entry, so it actually checks `'OpenAI-Compatible-Analyzer-Endpoints'` — extend whichever fixture list the guard iterates (`ALL_FIXTURE_FIXES_LISTS` or equivalent, Task 5.5b) with an `openai` ctx whose endpoint sets an output-cap key.
- [ ] **Step 4: Run and confirm it passes**
- [ ] **Step 5: Mutation proof**
1. Delete the `if (capKey)` block entirely. Expected red: both new cases (`names the endpoint's own payload key…` and the `Read: Custom payload` half of `adds no payload fix…`). Restore.
2. Delete only the `reads.push({ label: 'Read: Custom payload', … })` line, keeping the payload fix's own `fixes.push(...)`. Expected red: `names the endpoint's own payload key…`'s `readFix` assertion only (the payload fix half stays green, proving the two pushes are independently tested). Restore.
3. Add `wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints'` back onto the payload fix's own push (undoing item 10b). Expected red: `names the endpoint's own payload key…`'s `expect(payloadFix?.wikiPage).toBeUndefined()`. Restore.
4. Change the `Read: Custom payload` entry's `wikiPage` to a nonexistent page name. Expected red: the extended 3d.9a guard's page-existence check. Restore.
5. Temporarily add `reads.push({ label: 'Bogus extra fix' })` right after this task's own two pushes (a non-`Read:`-labelled entry landing in `reads`, after the genuine `Read: Custom payload` entry). Expected red: `no actionable fix (5a/5b or otherwise) ever appears after a Read: entry` — the tail after the first `Read:` entry now contains a non-`Read:`-labelled item. Restore.
- [ ] **Step 6: Commit**
```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy-fixes.test.ts
git commit -m "feat(server): point the reasoning-overflow fix list at an endpoint's own payload output cap"
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
      analyzerReasoningByEngine: { ollama: {}, gemini: {} },
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
    /* P29 — both payload editors say a payload is not a place for credentials. */
    expect(screen.getAllByText(/Not a place for credentials/)).toHaveLength(2);
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
    expect(screen.getByText(/Not a place for credentials: put this endpoint key in the API key field/)).toBeInTheDocument(); // P29
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
    /* P18: one select per Ollama model; set the first one the mock catalog lists. */
    const ollamaReasoning = page.locator('[data-testid^="analyzer-reasoning-ollama-"]').first();
    const modelId = await ollamaReasoning.getAttribute('data-model-id');
    expect(modelId).toBeTruthy();
    await ollamaReasoning.selectOption('on');
    await page.getByTestId('analyzer-extra-params-ollama').fill('{"options": {"min_p": 0.05}}');
    await page.getByTestId('analyzer-request-controls-save').click();
    await expect(controls.getByText(/^saved\.$/i)).toBeVisible({ timeout: 5_000 });
    await expect.poll(async () => (await readAccount(page)).analyzerReasoningByEngine).toEqual({ ollama: { [modelId!]: 'on' }, gemini: {} });
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
  openai: { container: null, keys: ['max_tokens', 'max_completion_tokens', 'n_predict'] }, // N9: llama.cpp's n_predict
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
Update the Task 5.6 RTL expectation `saves non-default Ollama and Gemini levels per model only` to include `analyzerExtraParamsByEngine: {}` in the expected patch (the patch now always carries both halves). Render the two editors between the Gemini reasoning block and the errors list:
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
                : 'JSON with a "config" object merged key by key into every Gemini request, e.g. {"config": {"topK": 40}}. Only temperature, topP, topK, maxOutputTokens, presencePenalty, frequencyPenalty, seed and safetySettings are accepted. A temperature here sets the first attempt only.'}{' '}
              Keys Castwright controls are refused on save. Never logged; long string values are hidden in provider errors. Not a place for credentials: keys belong in their own fields (the endpoint API key field, or the Gemini API key).
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
        <FieldRow label="Custom parameters" sublabel='JSON merged last into every request to this endpoint, e.g. {"top_k": 20, "min_p": 0.05, "presence_penalty": 1.5}. chat_template_kwargs merges key by key; null removes a key. A temperature here sets the first attempt only. Keys Castwright controls are refused on save. Never logged; long string values are hidden in provider errors. Not a place for credentials: put this endpoint key in the API key field above. OpenAI reasoning models need max_completion_tokens instead of max_tokens; llama.cpp n_predict also sets the output cap.'>
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

**`ISSUE_FIELDS`/`ENDPOINT_FIELD_TEST_IDS` (review item 5, 2026-09-13).** 3d.8's own note flags `extraParams` by name as unfocusable "before wave 5" (`git grep -n "extraParams" server/src/components/settings/analyzer-endpoints-section.tsx` locates it in the landed file, not a pinned plan-doc line); this task supplies its control, so it also closes that gap: add `'extraParams'` to `ISSUE_FIELDS` and `extraParams: 'endpoint-extra-params'` to `ENDPOINT_FIELD_TEST_IDS` (both in `src/components/settings/analyzer-endpoints-section.tsx`), in the same file this task already edits.

Append to `src/components/settings/analyzer-endpoints-section.test.tsx`:
```tsx
it("a payload-fix deep-link focuses the endpoint's custom parameters field (#3084 wave 5b)", async () => {
  renderSectionAtHash('#/models?endpoint=lab&field=extraParams'); // match Task 5.6's/3d.9's own focus-test grammar
  await screen.findByTestId('endpoint-row-lab');
  fireEvent.click(screen.getByTestId('endpoint-edit-lab'));
  expect(screen.getByTestId('endpoint-extra-params')).toHaveFocus();
});
```

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
4. Delete the `Not a place for credentials…` sentence from the Ollama/Gemini editor help. Expected red: `notes when the payload takes over the output cap` (`toHaveLength(2)`). Delete it from the endpoint form's sublabel instead. Expected red: `disables the max output field when the payload sets the cap, and shows JSON errors`. Restore both (P29).
5. Remove `'n_predict'` from the frontend `OUTPUT_CAP.openai.keys`. Expected red: `frontend payload helpers match the server case table` at the `openai {"n_predict":1024}` row (N9). Restore.
6. Remove `'extraParams'` from `ISSUE_FIELDS` (or drop its `ENDPOINT_FIELD_TEST_IDS` entry). Expected red: `a payload-fix deep-link focuses the endpoint's custom parameters field (#3084 wave 5b)`. Restore.

- [ ] **Step 6: Commit**
```bash
git add src/lib/extra-params.ts src/lib/extra-params.test.ts src/components/settings/analyzer-request-controls.tsx src/components/settings/analyzer-request-controls.test.tsx src/lib/api.ts e2e/analyzer-request-controls.spec.ts e2e/analyzer-endpoints.spec.ts
git add src/components/settings/analyzer-endpoints-section.tsx src/components/settings/analyzer-endpoints-section.test.tsx src/lib/model-label.ts src/lib/model-label.test.ts src/lib/api-types.ts openapi.yaml server/src/analyzer/catalog/analyzer-catalog.ts server/src/analyzer/catalog/analyzer-catalog.test.ts
git commit -m "feat(frontend,server,e2e): custom payload editors and the + custom params run label"
```

### Task 5.13: Ship PR 5b (closes #3084)

**Files:**
- Modify: `docs/release-notes-next.md` (`## 🗣️ Analyzer, script review & manuscript`), `RELEASE_NOTES.md` (top section)
- Modify: `docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md` (F3's "Custom payload" subsection, per server)
- Modify: `docs/testing/onbox-acceptance-register.md` (Groups A and E + At-a-glance), `docs/testing/onbox-acceptance-register-live-view.html`
- Modify: `docs/features/284-openai-compatible-analyzer.md` (Ship notes, invariants), `docs/features/INDEX.md` (its entry, only if the entry text states wave progress)
- Modify: `CLAUDE.md` — **no change**: this PR adds no new un-mocked frontend→local-machine call (Detect was added to the exception list in W3b).

- [ ] **Step 1: Derived artifacts**
Run: `npm run openapi:types` → `git diff --exit-code src/lib/api-types.ts` (exit 0); `npm run config:check` (no knobs added — must pass unchanged); no `FailureCode` added, so `git diff --exit-code main -- src/data/help-failures.ts` exits 0 and `npm test -- src/data/help-failures.test.ts src/data/help-categories.test.ts` passes at 28 / 54.

- [ ] **Step 2: Release notes (both files)**
`docs/release-notes-next.md`:
```markdown
- **Custom request parameters for every analyzer engine (#3084, wave 5b — closes #3084).** New `analyzerExtraParamsByEngine` (Ollama, Gemini) and per-endpoint `extraParams`: a JSON object merged last into the native request — top-level keys replace; the owned container (Ollama `options`, Gemini `config`, endpoint `chat_template_kwargs`) merges key by key; `null` removes a key but never a container. Pipeline-owned keys (spec §9, including the endpoint reasoning fields and Ollama `tools` / `options.main_gpu`, plus `chat_template_kwargs.enable_thinking` under the `enable_thinking` style) are refused on save with a message naming them. They are dropped again at merge time from a payload stored before a rule existed (the names are logged, never the values), and a stored `null` on an owned container is ignored. A Gemini payload is an allowlist: only `config`, and inside it only `temperature`, `topP`, `topK`, `maxOutputTokens`, `presencePenalty`, `frequencyPenalty`, `seed` and `safetySettings`. `httpOptions`, which could redirect the API key, and `stopSequences` are refused, and `safetySettings` must be an array of `{ category, threshold }` strings. Keys named `__proto__`, `constructor` or `prototype` are refused on save and dropped at merge, at any depth. A payload temperature sets attempt 1 only; the retry policy's temperature wins on the validation retry. A payload output cap (`max_tokens`, `max_completion_tokens`, llama.cpp's `n_predict`, Ollama `options.num_predict`, Gemini `config.maxOutputTokens`) does three things. It disables Auto (the transport's `max_tokens` is dropped on endpoints). It becomes the cap that chunk sizing, the Test action and the overflow rule size against. And the run label says so, and a reasoning-overflow failure names that payload key. Test probes carry the configured payload; any payload adds "+ custom params". A persona request carries the payload without its output-cap keys, so a cap meant for chapter work never shortens a voice description, and every other payload key still applies. Saving request controls judges only the payloads that change, and an endpoint update judges its payload only when the payload or its reasoning style changes. Payloads are never logged or written to analyzer files, and are not a place for credentials. Their string values of 8 or more characters are redacted from the errors of the request that carried them, in all three transports, and never from another request's errors (P29). That covers the whole body before any excerpt is cut, a Gemini error's message and stack, and an endpoint error's cause code. (#PR)
```
`RELEASE_NOTES.md`:
```markdown
- **Pass your own settings straight to the model.** Want `top_k`, `min_p` or a presence penalty on your local server, or `topK` on Gemini? Each analyzer engine and every OpenAI-compatible endpoint now takes a small block of custom parameters that Castwright adds to every request. It won't let you override the parts it depends on — the model name, the output format, reasoning, the context size, and on Gemini anything outside a short list of generation settings — and tells you exactly which keys it refused. A temperature you set there shapes the first try, while a retry still uses Castwright's own. The run label shows "+ custom params" whenever they're in play, and your values never appear in logs; if a provider error repeats one back, Castwright hides it. Keys and passwords don't belong there: each has its own field. This completes the OpenAI-compatible analyzer request that started it all.
```

- [ ] **Step 2b: Wiki — "Custom payload" (F3)**
Add **one top-level `## Custom payload` section** to `docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md` — this is the page Task 5.11b's payload fix names in its label ("… under 'Custom payload'") and points at via `wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints'`; the section must exist by the time this PR ships (it does, ship being this PR's last task) and must not collide with 3d.9a's existing top-level headings on the same page. Per-server detail lands as `###` subsections **under** that one heading — llama.cpp/llama-server, llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter — with worked examples: vLLM's `max_completion_tokens`, llama.cpp's sampler keys (`min_p`, `top_k`, `n_predict`), and one example per remaining server, each showing a request body or config snippet this wave's `mergeExtraParams`/`payloadOutputCapKey` actually recognises. Include the protected-key list (spec §9's pipeline-owned keys, restated here for endpoints) and the credential warning (P29 — payloads are not a place for API keys, and their string values are redacted from that request's own errors only). Take verified facts from `docs/superpowers/specs/2026-09-11-openai-compatible-analyzer-planning-facts.md`; mark anything else "verify at implementation"; each example records the tool version it was checked against.

- [ ] **Step 3: On-box acceptance rows**
Allocate from each group's `next-id` marker at ship time; bump the marker in the same commit.
- **Group A** (GPU box, llama-swap + Ollama): *"#3084 5b — custom payload on real servers."* Observe: an endpoint with `{"top_k": 20, "min_p": 0.05, "presence_penalty": 1.5}` completes a chapter and llama-swap's request log shows those fields; Ollama with `{"options": {"min_p": 0.05}}` completes a chapter; a payload with a deliberately unsupported long string (e.g. `{"grammar_note": "castwright-onbox-probe-value"}` on a server that rejects unknown fields, or `{"options": {"num_keep": "castwright-onbox-probe-value"}}` on Ollama) produces a failure whose on-screen text and `logs/server.log` show `[redacted]`, never the value; the run label reads "+ custom params".
- **Group E** (Gemini key): *"#3084 5b — Gemini config payload."* Observe: `{"config": {"topK": 40}}` completes a chapter; `{"config": {"maxOutputTokens": 2048}}` makes the label read "max output set by custom params"; `{"config": {"safetySettings": [{"category": "castwright-onbox-probe-value", "threshold": "BLOCK_NONE"}]}}` (a value Gemini rejects) returns `analyzer-request-rejected`, with the value redacted on screen and in `logs/server.log`; saving `{"config": {"httpOptions": {"baseUrl": "http://127.0.0.1:1"}}}` is refused, naming `config.httpOptions`.
Update At-a-glance counts (A +1, E +1); run `npm run register:build` and `npm run check:onbox-register`; edit the live-view html; run `npm run check:onbox-register -- --against-published <saved live page>`; publish the html to the recorded URL.

- [ ] **Step 4: Plan doc and index**
In `docs/features/284-openai-compatible-analyzer.md`: add the payload invariants (merge order; owned containers; protected keys re-applied at merge; the Gemini `config` allowlist; temperature precedence; the output-cap, label and budget rule; Test probes carrying the payload; the `safetySettings` shape and prototype-key rules; changed-only save validation; privacy, and redaction of payload values only from the errors of the request that carried them (P29)) and fill **Ship notes** with every wave's PR number and merge SHA through this PR. Status stays **`active`** — the on-box rows from waves 2–5 are still owed, so CLAUDE.md step 8 (move to `archive/`, `stable`) does not apply yet; state that sentence in the Ship notes. In `docs/features/INDEX.md`, leave the entry under its area; update its one-line description only if it names wave progress.

- [ ] **Step 5: Verify**
Run: `npm run typecheck`, `npm run check:cycles`, `npm run verify:fast:branch`, `npx playwright test --project=chromium e2e/analyzer-request-controls.spec.ts e2e/analyzer-endpoints.spec.ts`  Expected: all PASS.

- [ ] **Step 6: Commit, push, PR, review gate**
```bash
git add docs/release-notes-next.md RELEASE_NOTES.md docs/testing/onbox-acceptance-register.md docs/testing/onbox-acceptance-register-live-view.html docs/features/284-openai-compatible-analyzer.md docs/features/INDEX.md
git commit -m "docs(docs): release notes, on-box rows and ship notes for custom analyzer payloads"
git push -u origin feat/server-3084-w5b-payload
```
PR title: `feat(server,frontend,openapi): custom request parameters for every analyzer engine`. Body: `## Summary` (release-notes-next entry + the four spec-gap resolutions at the top of PR 5b), `## Test plan` (task test files, the privacy test, both e2e specs, pasted mutation-proof red output from Tasks 5.8–5.12, the register row IDs), **`Closes #3084`** (this is the wave's last PR; owed on-box acceptance is recorded as rows, which never blocks a merge), and "Also fixed, found in passing: …" if any. Run `pr-review-gate` at **high** depth; fold findings per its loop.
