# OpenAI-compatible analyzer — Wave 2 plan

> Part of the [OpenAI-compatible analyzer implementation plan](2026-09-11-openai-compatible-analyzer.md). Read that file first: its Global Constraints, planning decisions (P1–P27) and interface contract bind every task below. Spec: [2026-09-10-openai-compatible-analyzer-design.md](../specs/2026-09-10-openai-compatible-analyzer-design.md).

## Wave 2 — Capacity model, Gemini Auto max output tokens, Gemini thinking visibility, reasoning-overflow rule

Spec decisions 6 and 7, §6 and §7. Wave 1 (PRs 1a, 1b) is assumed merged. This file uses wave 1's contract names: `ChatTransport`, `TransportRequest`, `TransportResult`, `StageRunner`, `EngineRequestSettings`, `mapFinish`, `stripThink`, `GeminiTransport`, `OllamaTransport`, `withTransportRetry` and `TransportKind`.

Every `file:line` below is as of `origin/main` 46e62a34, with two marked exceptions: `server/src/analyzer/attribution-eval/run-eval.ts` is cited as `origin/main` after PR #3199 (merge `839c65ac`), and the #3163 `rate-limit.ts` / `registry.ts` lines are cited as `origin/main` after that PR (merge `ade92d2b`). Wave 0 (#3139 → PR #3163, #3141) and wave 1 both edit files cited here. Before each task, re-locate every anchor with `git grep -n` on the current `main`. Code that wave 1 moved is cited twice: its 46e62a34 location, and the wave-1 file it now lives in. Facts about the openai SDK, local servers and the Gemini API are cited from `docs/superpowers/specs/2026-09-11-openai-compatible-analyzer-planning-facts.md` as "planning facts §A/§B/§C" plus the item number.

**Commands used throughout this wave** (from the worktree root; never `cd`):

| What | Command |
|---|---|
| One server test file (main pool) | `npm --prefix server run test -- src/analyzer/capacity.test.ts` |
| One server slow-lane file (listed in `server/vitest.config.slow.ts` `SLOW_FILES`, e.g. `src/analyzer/gemini.test.ts`, `src/routes/analysis-pipelining.test.ts`) | `npm --prefix server run test:slow -- src/analyzer/gemini.test.ts` |
| Check whether wave 1 moved a file into the slow lane | `Select-String -Path server/vitest.config.slow.ts -Pattern 'gemini-transport'` |
| One frontend test file | `npx vitest run src/data/help-failures.test.ts` |
| Typecheck (frontend + server; server tests are type-checked, `server/tsconfig.json:19` includes `src/**/*`) | `npm run typecheck` |
| Import-cycle baseline | `npm run check:cycles` |

---

### PR 2a — Chunk-budget pinning, capacity model

- **Branch:** `refactor/server-3084-w2a-capacity`. Create it with `node scripts/wt-new.mjs refactor/server-3084-w2a-capacity` off the latest `main`.
- **Delivers:**
  - A chunk-budget pinning fixture captured from unmodified code, plus its assertion.
  - `EngineCapacity` / `resolveCapacity` / `TODAY_LOCAL_CAPACITY` in `server/src/analyzer/capacity.ts`.
  - `resolveStage1ChunkCharBudget`, `resolveStage2ChunkCharBudget` and `chapterChunkBudget` taking a capacity instead of an engine name, with every caller updated.
- **Must NOT change:**
  - any chunk-budget value: the pinning fixture stays byte-identical after Task 2.1's commit;
  - the per-request input cap. `perRequestInputCap` is `analyzer.gemini.maxInputTokensPerRequest` alone, exactly today's value. The `min(cap, model TPM)` bound ships in PR 2b (Task 2.6): since #3163 a saved `rate.tpm.gemma` / `rate.tpm.gemma26` override below 12000 makes it reachable from Settings, so here it would be a silent budget change in a PR with no release note;
  - any registry knob's `env`, `type`, `min`/`max`, `default` or its `.env.example` line — **except** the six chunking/cap knobs' `help` strings, which Task 2.3 extends with a family-derivation sentence (F1); a `help`-only edit changes no runtime behaviour, no default and no `.env.example` line, so it does not reopen this constraint's reason (avoiding a silent budget change with no release note);
  - any request shape sent to Ollama or Gemini;
  - `maxOutputTokens` or the Gemini idle watchdog;
  - any failure-taxonomy outcome;
  - OpenAPI or any frontend file.
- **On-box acceptance never gates a chunk-size control (F1).** Every knob this
  wave touches — the six chunking/cap knobs above, `analyzer.gemini.maxOutputTokens`,
  `analyzer.gemini.thinkingIdleTimeoutMs`, `analyzer.gemini.requestCeilingMs` —
  stays a live, user-editable Advanced Settings row throughout both PRs. No
  task in this file locks, hides or defers any of them pending Task 2.10's
  on-box register rows; those rows measure real chapters so a LATER PR can
  tune a default, never so THIS wave can withhold an override.
- **Entry criteria:**
  - PRs 1a and 1b are merged, and so is wave 0: #3139 (PR #3163, merge `ade92d2b` — done) and #3141, whose live fix is **PR #3192** (open as of `4a545750`; the #3152–#3158 / #3167 / #3168 chain is design-time history, not the number to check).
  - #3196 (PR #3199, merge `839c65ac`) is merged to `main`. It makes `attribution-eval/run-eval.ts` pass its engine to `attributeChapterStage2`. Task 2.1's pinning capture must run on a `main` that includes it.
- **Exit criteria:**
  - `capacity-pinning.test.ts` is green.
  - `git log --format=%H -- server/src/analyzer/__fixtures__/capacity-pinning.json` shows exactly one commit (Task 2.1's).
  - `npm run typecheck` and `npm run check:cycles` are green.
  - `npm run verify:fast:branch` is green.
  - The `pr-review-gate` pass has run at depth `high` (a `refactor` PR).

### Task 2.1: Chunk-budget pinning fixture, captured from unmodified code

**Files:**
- Create: `server/src/analyzer/capacity-pinning.test.ts`
- Create (by the capture run, not by hand): `server/src/analyzer/__fixtures__/capacity-pinning.json`
- Test: `server/src/analyzer/capacity-pinning.test.ts`

**Interfaces:**
- Consumes (today's signatures, unmodified):
  - `resolveStage1ChunkCharBudget(engine?: 'gemini' | 'local', body?, runningRoster = [])` (`stage1-chunk.ts:95-125`);
  - `resolveStage2ChunkCharBudget(engine?, body?)` (`stage2-chunk.ts:70-82`);
  - `chapterChunkBudget(engine, reservedChars = 0, sampleText = '', reservedTokens = 0)` (`chapter-chunker.ts:130-139`);
  - `OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS` (`chapter-chunker.ts:112`);
  - `countCyrillic` (`token-budget.ts:12`) and `countCjkChars` (`server/src/util/cjk.ts:23`).
- Produces:
  - the committed fixture `capacity-pinning.json`, shaped `{ capturedFrom: string; cases: Array<{ id: string; resolver: Resolver; engine: EngineConfig; script: ScriptId; value: number }> }`;
  - the single adapter function `computeBudget(c, body)`, which Task 2.3 re-points at the capacity signatures without touching the fixture.

Case matrix:
- **Engines.** `local-qwen3.5:4b@32768` (`ANALYZER_NUM_CTX=32768`); `gemini-3.5-flash-lite@12000` (`ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST=12000`); and, only if Step 1's caller grep finds a production caller that passes no engine, `unset` (today's `engine === undefined` path). Since PR #3199, `attribution-eval/run-eval.ts` passes its engine, so the expected matrix has no `unset` column.
- **Scripts.** Chapter One of `server/src/__fixtures__/the-coalfall-commission.md` (Latin), `.ru.md` (Cyrillic), `.zh.md` (Han) and `.ja.md` (kana + kanji).
- **Resolvers, each as the real callers pass it:**
  - stage 1 without a roster, and with a 40-entry roster (`routes/analysis.ts:4496-4501`, `:7065-7070`);
  - stage 2 (`analysis.ts:2308`);
  - `chapterChunkBudget(engine, 0, body, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS)`, the emotion and instruct passes (`annotate-emotion.ts:178-183`, `instruct-annotation.ts:177-182`);
  - `chapterChunkBudget(engine, JSON.stringify(roster).length + 800, body, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS)`, script review (`script-review.ts:840-845`, `attribution-eval/review-run.ts:60-65`);
  - `chapterChunkBudget(engine)` with defaults (`chapter-chunker.test.ts:15`).

- [ ] **Step 1: Write the failing test**

First confirm the capture base. `main` must include PR #3199 (#3196), which makes `attribution-eval/run-eval.ts` pass its engine to `attributeChapterStage2`. This must exit 0:
```bash
git fetch origin
git merge-base --is-ancestor 839c65acc7a127817719502247b0514b7fe29cb9 origin/main
```

Then decide whether the `unset` engine is pinned at all. List every production caller of the three resolvers and of the stage-2 entry points:
```bash
git grep -n -E "resolveStage[12]ChunkCharBudget\(|chapterChunkBudget\(|attributeChapterStage2(WithEval)?\(" origin/main -- server/src ":!*.test.ts"
```
Read each call's arguments. On 46e62a34 plus PR #3199, every production caller passes an engine:
- `routes/analysis.ts` stage 1 (`:4496`, `:7065`, `selection.engine`);
- both `attributeChapterStage2WithEval` calls (`engine: phase1Selection.engine`, `:5461`, `:7360`);
- the `chapterChunkBudget` passes (`annotate-emotion.ts:178`, `instruct-annotation.ts:177`, `script-review.ts:840`, `attribution-eval/review-run.ts:60`);
- `attribution-eval/run-eval.ts` (`chunkEngine` declared at `:190`, passed as `engine: chunkEngine,` at `:200` and `:242`; `origin/main` after PR #3199).

Only test files call `attributeChapterStage2` without one. Choose by the grep:
- **No production caller omits the engine** (the expected result): keep `unset` out of `ENGINES`, as written below, and the fixture has 42 cases. The `undefined`-capacity branch that Task 2.3 keeps (`capacity?.family !== 'context'`) is then reached only from the test suites Task 2.3 Step 4 runs.
- **A production caller omits it:** append `'unset'` to `ENGINES` before capturing, giving 54 cases, and name that caller in the PR body.

Then confirm that the resolver sources are unmodified relative to `main`. This must print nothing and exit 0:
```bash
git fetch origin
git diff --exit-code origin/main -- server/src/analyzer/stage1-chunk.ts server/src/analyzer/stage2-chunk.ts server/src/analyzer/chapter-chunker.ts server/src/analyzer/token-budget.ts server/src/config/registry.ts server/src/analyzer/rate-limit.ts
```

`server/src/analyzer/capacity-pinning.test.ts`:
```ts
/* #3084 wave 2 — chunk-budget PINNING lock (spec §6, regression plan 284
   invariant 5). Wave 2 moves every chunk-budget resolver from an engine name
   onto an EngineCapacity descriptor; budgets for today's engines must stay
   byte-identical. The expected values are CAPTURED ONCE from unmodified main
   (CAPACITY_PINNING_CAPTURE=1, which refuses to overwrite an existing
   fixture) — never computed by hand. Only computeBudget() may change when the
   resolver signatures change; the fixture file must not. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';
import { resolveStage2ChunkCharBudget } from './stage2-chunk.js';
import { chapterChunkBudget, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS } from './chapter-chunker.js';
import { countCyrillic } from './token-budget.js';
import { countCjkChars } from '../util/cjk.js';
import type { CharacterOutput } from '../handoff/schemas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANUSCRIPTS = resolve(__dirname, '..', '__fixtures__');
const PIN_PATH = resolve(__dirname, '__fixtures__', 'capacity-pinning.json');

type EngineConfig = 'local-qwen3.5:4b@32768' | 'gemini-3.5-flash-lite@12000' | 'unset';
type Resolver =
  | 'stage1'
  | 'stage1+roster'
  | 'stage2'
  | 'chapter:defaults'
  | 'chapter:emotion-instruct'
  | 'chapter:script-review';
type ScriptId = 'latin' | 'cyrillic' | 'han' | 'kana';
interface PinCase {
  id: string;
  resolver: Resolver;
  engine: EngineConfig;
  script: ScriptId;
}

/* `unset` = the `undefined`-capacity path. Pinned ONLY if Step 1's caller grep
   found a production caller that passes no engine; then append 'unset' here
   before capturing. */
const ENGINES: EngineConfig[] = ['local-qwen3.5:4b@32768', 'gemini-3.5-flash-lite@12000'];
const RESOLVERS: Resolver[] = [
  'stage1',
  'stage1+roster',
  'stage2',
  'chapter:defaults',
  'chapter:emotion-instruct',
  'chapter:script-review',
];
const SCRIPT_FILES: Record<ScriptId, string> = {
  latin: 'the-coalfall-commission.md',
  cyrillic: 'the-coalfall-commission.ru.md',
  han: 'the-coalfall-commission.zh.md',
  kana: 'the-coalfall-commission.ja.md',
};

/* Chapter One's body: every line after the first `## ` heading up to the next
   `## ` heading. Split on \r?\n and re-joined with \n so a CRLF checkout pins
   the same values as an LF one. */
function chapterOne(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## '));
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join('\n')
    .trim();
}

const BODIES = Object.fromEntries(
  (Object.entries(SCRIPT_FILES) as Array<[ScriptId, string]>).map(([script, file]) => [
    script,
    chapterOne(readFileSync(resolve(MANUSCRIPTS, file), 'utf8')),
  ]),
) as Record<ScriptId, string>;

/* A 40-entry running roster in the compact shape stage-1's inbox renders. */
const ROSTER: CharacterOutput[] = Array.from({ length: 40 }, (_, i) => ({
  id: `character-${i}`,
  name: `Character Name ${i}`,
  role: 'supporting',
  color: '#ffffff',
}));

const CASES: PinCase[] = [];
for (const engine of ENGINES) {
  for (const resolver of RESOLVERS) {
    if (engine === 'unset' && resolver.startsWith('chapter:')) continue; // chapterChunkBudget requires an engine
    for (const script of Object.keys(SCRIPT_FILES) as ScriptId[]) {
      if (resolver === 'chapter:defaults' && script !== 'latin') continue; // takes no body
      CASES.push({ id: `${resolver}|${engine}|${script}`, resolver, engine, script });
    }
  }
}

/* ── The ONLY part of this file Task 2.3 changes. ─────────────────────────── */
function engineArg(engine: EngineConfig): 'local' | 'gemini' | undefined {
  if (engine === 'unset') return undefined;
  return engine.startsWith('local') ? 'local' : 'gemini';
}
function computeBudget(c: PinCase, body: string): number {
  const engine = engineArg(c.engine);
  switch (c.resolver) {
    case 'stage1':
      return resolveStage1ChunkCharBudget(engine, body);
    case 'stage1+roster':
      return resolveStage1ChunkCharBudget(engine, body, ROSTER);
    case 'stage2':
      return resolveStage2ChunkCharBudget(engine, body);
    case 'chapter:defaults':
      return chapterChunkBudget(engine!);
    case 'chapter:emotion-instruct':
      return chapterChunkBudget(engine!, 0, body, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS);
    case 'chapter:script-review':
      return chapterChunkBudget(
        engine!,
        JSON.stringify(ROSTER).length + 800,
        body,
        OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS,
      );
  }
}
/* ─────────────────────────────────────────────────────────────────────────── */

/* Every env var that feeds a pinned value. A developer's shell or server/.env
   must not leak into the comparison. */
const PINNED_ENV: Record<string, string | undefined> = {
  ANALYZER_NUM_CTX: '32768',
  ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST: '12000',
  STAGE1_CHUNK_CHAR_BUDGET: undefined,
  STAGE2_CHUNK_CHAR_BUDGET: undefined,
  ANALYZER_STAGE1_LOCAL_INPUT_FRACTION: undefined,
  ANALYZER_STAGE2_LOCAL_INPUT_FRACTION: undefined,
  ANALYZER_GEMINI_OUTPUT_HEAVY_CHUNK_CHARS: undefined,
  GEMINI_TPM_GEMINI_3_5_FLASH_LITE: undefined,
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [name, value] of Object.entries(PINNED_ENV)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface PinnedFile {
  capturedFrom: string;
  cases: Array<PinCase & { value: number }>;
}

describe('capacity pinning — chunk budgets stay byte-identical to main (#3084 wave 2)', () => {
  it('every resolver × engine × script equals the fixture captured from main', () => {
    const actual = CASES.map((c) => ({ ...c, value: computeBudget(c, BODIES[c.script]) }));
    if (process.env.CAPACITY_PINNING_CAPTURE === '1') {
      if (existsSync(PIN_PATH)) {
        throw new Error(
          `${PIN_PATH} already exists — pinning values are captured ONCE, from unmodified main. Never re-capture on a refactor branch.`,
        );
      }
      mkdirSync(dirname(PIN_PATH), { recursive: true });
      const file: PinnedFile = { capturedFrom: process.env.CAPACITY_PINNING_SHA ?? 'unknown', cases: actual };
      writeFileSync(PIN_PATH, `${JSON.stringify(file, null, 2)}\n`);
    }
    const pinned = JSON.parse(readFileSync(PIN_PATH, 'utf8')) as PinnedFile;
    expect(actual).toEqual(pinned.cases);
  });

  it('the extracted bodies are real chapters in the intended scripts (a degenerate body would pin nothing)', () => {
    for (const [script, body] of Object.entries(BODIES)) expect(body.length, script).toBeGreaterThan(1000);
    expect(countCyrillic(BODIES.cyrillic) / BODIES.cyrillic.length).toBeGreaterThan(0.5);
    expect(countCjkChars(BODIES.han) / BODIES.han.length).toBeGreaterThan(0.5);
    expect(countCjkChars(BODIES.kana) / BODIES.kana.length).toBeGreaterThan(0.5);
  });

  it('the pinned cloud budgets are script-sensitive (proves the fixture exercises charsPerTokenForText)', () => {
    const pinned = JSON.parse(readFileSync(PIN_PATH, 'utf8')) as PinnedFile;
    const value = (id: string): number => pinned.cases.find((c) => c.id === id)!.value;
    expect(value('stage1|gemini-3.5-flash-lite@12000|latin')).not.toBe(
      value('stage1|gemini-3.5-flash-lite@12000|cyrillic'),
    );
    expect(value('chapter:script-review|gemini-3.5-flash-lite@12000|latin')).not.toBe(
      value('chapter:script-review|gemini-3.5-flash-lite@12000|han'),
    );
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/capacity-pinning.test.ts`  Expected: FAIL with `ENOENT: no such file or directory, open '…capacity-pinning.json'` (tests 1 and 3; test 2 passes).
- [ ] **Step 3: Implement (capture, on unmodified code)**

This step produces the fixture from `main`'s resolvers. The Step 1 `git diff --exit-code` must still be clean.
```powershell
$env:CAPACITY_PINNING_CAPTURE = '1'
$env:CAPACITY_PINNING_SHA = (git rev-parse origin/main)
npm --prefix server run test -- src/analyzer/capacity-pinning.test.ts
Remove-Item Env:CAPACITY_PINNING_CAPTURE
Remove-Item Env:CAPACITY_PINNING_SHA
```
Expected: PASS, and `server/src/analyzer/__fixtures__/capacity-pinning.json` exists with 42 cases, or 54 if Step 1 added `unset`. The count is:
- `local` 21 = 4 × (stage1, stage1+roster, stage2, emotion-instruct, script-review) + 1 (defaults);
- `gemini` 21;
- `unset` 12 = 4 × (stage1, stage1+roster, stage2), only when Step 1 added it.

That totals 42, or 54 with `unset`. If the file holds a different count, the case loop was edited: stop and diff it against Step 1.

Open the fixture and read it:
- every `local-…@32768` stage-1/chapter value is `24000`, and every stage-2 value is `9000` (the registry ceilings bind at `num_ctx` 32768);
- the `gemini` values (and the `unset` values, when pinned) vary by script.

Record the case count and three sample values in the PR body.
- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/capacity-pinning.test.ts`  Expected: PASS (3 tests), with no env vars set.
- [ ] **Step 5: Mutation proof**
  1. In `server/src/analyzer/stage1-chunk.ts:60`, change `export const STAGE1_CLOUD_RESERVED_TOKENS = 7000;` to `= 7001;`.
  2. Run the Step 4 command. Expected red: `capacity pinning — chunk budgets stay byte-identical to main (#3084 wave 2) > every resolver × engine × script equals the fixture captured from main`.
  3. Restore `7000`, re-run to green, and confirm `git diff --exit-code server/src/analyzer/stage1-chunk.ts`.
  4. Also try re-capturing: run Step 3's commands again. Expected: FAIL `…already exists — pinning values are captured ONCE…`.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/capacity-pinning.test.ts server/src/analyzer/__fixtures__/capacity-pinning.json
git commit -m "test(server): pin analyzer chunk budgets captured from main (#3084)"
```

**Tests this task could break:** none; the files are new and no source changes.

### Task 2.2: `EngineCapacity` and `resolveCapacity`

**Files:**
- Create: `server/src/analyzer/capacity.ts`
- Test: `server/src/analyzer/capacity.test.ts`

**Interfaces:**
- Consumes:
  - `configValue<number>('analyzer.ollama.numCtx')` (the same read as `resolveAnalyzerNumCtx`, `ollama.ts:275-277`; `capacity.ts` must not import `ollama.ts`, because wave 2b's Ollama settings provider imports `capacity.ts`);
  - `resolveMaxInputTokensPerRequest()` (`token-budget.ts:30-32`).
- Produces, per the contract:
  - `export interface EngineCapacity { family: 'context' | 'requestCap'; contextTokens: number; maxOutputTokens: number | null; perRequestInputCap?: number }`;
  - `export function resolveCapacity(sel: { engine: 'local' | 'gemini'; model: string }): EngineCapacity`. Wave 3 widens `engine` to `AnalysisEngine` and adds `endpoint?: AnalyzerEndpoint`;
  - `export const TODAY_LOCAL_CAPACITY: (numCtx?: number) => EngineCapacity`;
  - `export const GEMINI_FALLBACK_MAX_OUTPUT_TOKENS = 8192`.

**No TPM bound in this PR.** Spec §6 sizes a Gemini request to `min(analyzer.gemini.maxInputTokensPerRequest, model TPM)`. That bound ships in PR 2b (Task 2.6), not here. At defaults it would change nothing: every `BUILTIN_LIMITS` TPM in `rate-limit.ts` is at least 16000, and `FALLBACK_LIMITS.tpm` is 100000. But it binds whenever a model's TPM is set below the 12000 cap — by a `GEMINI_TPM_<SLUG>` env var or, since #3163, by a saved `rate.tpm.gemma` / `rate.tpm.gemma26` override from Settings (`registry.ts:1027-1034`, `:1057-1064` on `origin/main`, resolved through `tpmLimit`, `rate-limit.ts:109-112` there). That is a silent budget change for an existing configuration, and `capacity-pinning.test.ts`'s `PINNED_ENV` would not see it, so it belongs in the PR that pins it with a test and announces it. Here `perRequestInputCap` is the registry cap alone, which is exactly what `cloudBodyCharBudget` uses today, and test 7 below pins that a low TPM does not move it.

- [ ] **Step 1: Write the failing test**
```ts
/* #3084 wave 2 — EngineCapacity resolution (spec §6). Ollama: context family,
   num_ctx as sent, no /api/show clamp. Gemini: request-cap family,
   perRequestInputCap = analyzer.gemini.maxInputTokensPerRequest (PR 2a keeps
   today's value; PR 2b bounds it by the model's TPM). */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveCapacity, TODAY_LOCAL_CAPACITY, GEMINI_FALLBACK_MAX_OUTPUT_TOKENS } from './capacity.js';

const ENV = ['ANALYZER_NUM_CTX', 'ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST', 'GEMINI_TPM_GEMINI_3_5_FLASH_LITE'];
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

describe('resolveCapacity — Ollama', () => {
  it('is the context family with num_ctx exactly as sent and no output limit', () => {
    expect(resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' })).toEqual({
      family: 'context',
      contextTokens: 32768,
      maxOutputTokens: null,
    });
  });

  it('follows analyzer.ollama.numCtx (no clamp to a model native context)', () => {
    process.env.ANALYZER_NUM_CTX = '8192';
    expect(resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' }).contextTokens).toBe(8192);
  });

  it('TODAY_LOCAL_CAPACITY defaults to the live knob and accepts an explicit num_ctx', () => {
    expect(TODAY_LOCAL_CAPACITY()).toEqual(resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' }));
    expect(TODAY_LOCAL_CAPACITY(16384).contextTokens).toBe(16384);
  });
});

describe('resolveCapacity — Gemini', () => {
  it('is the request-cap family at the 12000 default cap', () => {
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' })).toEqual({
      family: 'requestCap',
      contextTokens: 12000,
      maxOutputTokens: GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,
      perRequestInputCap: 12000,
    });
  });

  it('every model gets the 12000 default cap', () => {
    for (const model of [
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'gemma-4-31b-it',
      'gemma-4-26b-a4b-it',
      'some-unlisted-model',
    ]) {
      expect(resolveCapacity({ engine: 'gemini', model }).perRequestInputCap, model).toBe(12000);
    }
  });

  it('follows analyzer.gemini.maxInputTokensPerRequest', () => {
    process.env.ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST = '6000';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' }).perRequestInputCap).toBe(6000);
  });

  it("a model TPM below the cap does NOT move the cap in this PR (the TPM bound is PR 2b's)", () => {
    process.env.GEMINI_TPM_GEMINI_3_5_FLASH_LITE = '8000';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' }).perRequestInputCap).toBe(12000);
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/capacity.test.ts`  Expected: FAIL with `Failed to resolve import "./capacity.js"`
- [ ] **Step 3: Implement**

`server/src/analyzer/capacity.ts`:
```ts
/* #3084 wave 2 — EngineCapacity: the per-model sizing descriptor the chunk-
   budget resolvers take instead of an engine name (spec §6). It carries
   TODAY's formula family so budgets stay byte-identical
   (capacity-pinning.test.ts):
     context    — Ollama: analyzer.stage{1,2}.localInputFraction × contextTokens
                  at 2 chars/token, no reservation (stage1-chunk.ts,
                  stage2-chunk.ts).
     requestCap — Gemini: cloudBodyCharBudget at perRequestInputCap, with the
                  existing token/char reservations (token-budget.ts).
                  perRequestInputCap is analyzer.gemini.maxInputTokensPerRequest
                  alone here; PR 2b bounds it by the model's TPM.
   Ollama's contextTokens is num_ctx AS SENT — deliberately not clamped to
   /api/show's native context before on-box measurement (register row
   "Capacity recalibration"). Endpoints (context family + optional cap) arrive
   in wave 3. Must not import ollama.ts: ollama.ts's settings provider imports
   this module. */
import { configValue } from '../config/resolver.js';
import { resolveMaxInputTokensPerRequest } from './token-budget.js';

export interface EngineCapacity {
  family: 'context' | 'requestCap';
  contextTokens: number;
  /** The model's own output-token limit when known; null = unlimited/unknown (Ollama). */
  maxOutputTokens: number | null;
  /** Request-cap family: the per-request input-token cap budgets are sized to. */
  perRequestInputCap?: number;
}

/** Gemini's output cap when the model's limit is unknown (spec §7: "8192 when
    the listing is unavailable"). */
export const GEMINI_FALLBACK_MAX_OUTPUT_TOKENS = 8192;

export const TODAY_LOCAL_CAPACITY = (
  numCtx: number = configValue<number>('analyzer.ollama.numCtx'),
): EngineCapacity => ({ family: 'context', contextTokens: numCtx, maxOutputTokens: null });

export function resolveCapacity(sel: { engine: 'local' | 'gemini'; model: string }): EngineCapacity {
  if (sel.engine === 'local') return TODAY_LOCAL_CAPACITY();
  const cap = resolveMaxInputTokensPerRequest();
  return {
    family: 'requestCap',
    contextTokens: cap,
    maxOutputTokens: GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,
    perRequestInputCap: cap,
  };
}
```
- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/capacity.test.ts`  Expected: PASS (8 tests). Then run `npm run check:cycles`: PASS, with no new cycle.
- [ ] **Step 5: Mutation proof**
  1. In `capacity.ts`, replace `perRequestInputCap: cap,` with `perRequestInputCap: 12000,`. Expected red: `resolveCapacity — Gemini > follows analyzer.gemini.maxInputTokensPerRequest`. Restore it.
  2. Replace `perRequestInputCap: cap,` with `perRequestInputCap: Math.min(cap, Number(process.env.GEMINI_TPM_GEMINI_3_5_FLASH_LITE ?? Infinity)),`. Expected red: `resolveCapacity — Gemini > a model TPM below the cap does NOT move the cap in this PR (the TPM bound is PR 2b's)`. Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/capacity.ts server/src/analyzer/capacity.test.ts
git commit -m "refactor(server): add EngineCapacity and resolveCapacity (#3084)"
```

**Tests this task could break:** none; both files are new, and `rate-limit.ts` is untouched in PR 2a.

### Task 2.3: Chunk-budget resolvers take an `EngineCapacity`

**Files:**
- Modify: `server/src/analyzer/token-budget.ts:47-51` — `cloudBodyCharBudget` gains an optional cap.
- Modify: `server/src/analyzer/stage1-chunk.ts:95-125`
- Modify: `server/src/analyzer/stage2-chunk.ts:70-82`
- Modify: `server/src/analyzer/chapter-chunker.ts:130-139`
- Modify: `server/src/config/registry.ts:129` — the comment names `chapterChunkBudget('gemini')`, which no longer exists; and `:70-79`, `:82-91`, `:92-101`, `:102-111`, `:112-121`, `:122-131`, `:953-961` — `help` text for the six chunking/cap knobs plus `analyzer.ollama.numCtx`, naming each family's derivation formula (F1).
- Modify: `docs/wiki/Advanced-Settings.md` §2 — the five chunking rows' "What it does" column (F1, F3).
- Modify: `server/src/routes/analysis.ts:12` (import), `:2208-2212`, `:2308`, `:4496-4497`, `:5461`, `:7065-7066`, `:7360`
- Modify: `server/src/routes/annotate-emotion.ts:178-179` (+ import)
- Modify: `server/src/routes/instruct-annotation.ts:177-178` (+ import)
- Modify: `server/src/routes/script-review.ts:840-841` (+ import)
- Modify: `server/src/analyzer/attribution-eval/review-run.ts:47`, `:56`, `:60-61`
- Modify: `server/src/analyzer/attribution-eval/run-eval.ts:190`, `:200`, `:242` (`origin/main` after PR #3199) — the `chunkEngine` declaration (`:190`), its use in the `attributeChapterStage2({` call (`:192`, field at `:200`) and in the `runReviewOverChapter({` call (`:240`, field at `:242`); `configValue` is already imported at `:15`
- Test (modify):
  - `server/src/analyzer/capacity-pinning.test.ts` (the `computeBudget` block only);
  - `server/src/analyzer/chapter-chunker.test.ts:9-52`;
  - `server/src/analyzer/stage1-chunk.test.ts:136-141`, `:197`, `:234-235`;
  - `server/src/analyzer/stage2-chunk.test.ts:160-165`, `:195-217`;
  - `server/src/analyzer/output-heavy-tpm.test.ts:95-100`, `:121-125`, `:151-156`, `:177-179`;
  - `server/src/analyzer/attribution-eval/review-run.test.ts:55-60`, `:116`, `:144`, `:162`, `:205`, `:236`, `:299`, `:338`;
  - `server/src/analyzer/attribution-eval/run-eval.test.ts` — PR #3199's `engine parameter mapping to attributeChapterStage2` describe.

**Interfaces:**
- Consumes: `EngineCapacity`, `resolveCapacity`, `TODAY_LOCAL_CAPACITY` (Task 2.2).
- Produces (the contract signatures):
  - `resolveStage1ChunkCharBudget(capacity: EngineCapacity | undefined, body?: string, runningRoster: CharacterOutput[] = []): number`
  - `resolveStage2ChunkCharBudget(capacity: EngineCapacity | undefined, body?: string): number`
  - `chapterChunkBudget(capacity: EngineCapacity, reservedChars = 0, sampleText = '', reservedTokens = 0): number`
  - `cloudBodyCharBudget(body: string, reservedChars = 0, reservedTokens = 0, capTokens: number = resolveMaxInputTokensPerRequest()): number`
  - `attributeChapterStage2` opts field `capacity?: EngineCapacity`, which replaces `engine?`.
  - `runReviewOverChapter` opts field `capacity: EngineCapacity`, which replaces `engine`.

**`undefined` capacity** keeps today's `engine === undefined` behaviour. Today, `engine !== 'local'` is true for `undefined`, so an omitted engine takes the **cloud** branch at the registry cap. `capacity?.family !== 'context'` reproduces that. `stage1ChunkBudgetForEngine` and `stage2ChunkBudgetForEngine` keep their `engine` parameter unchanged: they are exported and tested (`stage1-chunk.test.ts:124-149`, `stage2-chunk.test.ts:145-173`), and the resolvers keep passing `'local'`.

- [ ] **Step 1: Write the failing test**

In `server/src/analyzer/capacity-pinning.test.ts`, replace everything between the two `/* ── … ── */` marker comments with the block below, and add the import. The fixture file is NOT touched.
```ts
import { resolveCapacity, type EngineCapacity } from './capacity.js';
```
```ts
/* ── The ONLY part of this file Task 2.3 changes. ─────────────────────────── */
function capacityArg(engine: EngineConfig): EngineCapacity | undefined {
  if (engine === 'unset') return undefined;
  return engine.startsWith('local')
    ? resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' })
    : resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' });
}
function computeBudget(c: PinCase, body: string): number {
  const capacity = capacityArg(c.engine);
  switch (c.resolver) {
    case 'stage1':
      return resolveStage1ChunkCharBudget(capacity, body);
    case 'stage1+roster':
      return resolveStage1ChunkCharBudget(capacity, body, ROSTER);
    case 'stage2':
      return resolveStage2ChunkCharBudget(capacity, body);
    case 'chapter:defaults':
      return chapterChunkBudget(capacity!);
    case 'chapter:emotion-instruct':
      return chapterChunkBudget(capacity!, 0, body, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS);
    case 'chapter:script-review':
      return chapterChunkBudget(
        capacity!,
        JSON.stringify(ROSTER).length + 800,
        body,
        OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS,
      );
  }
}
/* ─────────────────────────────────────────────────────────────────────────── */
```

`server/src/analyzer/chapter-chunker.test.ts` — replace lines 9-54 (the import of `resolveStage1ChunkCharBudget` through the end of the first `describe`) with:
```ts
import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';
import { resolveCapacity, TODAY_LOCAL_CAPACITY } from './capacity.js';

const S = (id: number, len = 10) => ({ id, text: 'x'.repeat(len) });
const gemini = () => resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' });

describe('chapterChunkBudget (Part 4 — finite Gemini budget for output-heavy passes)', () => {
  it('gemini is FINITE now (not MAX_SAFE_INTEGER) so a large chapter splits', () => {
    const budget = chapterChunkBudget(gemini());
    expect(budget).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(budget).toBe(32000); // registry default analyzer.gemini.outputHeavyChunkChars
  });

  it('local stays the num_ctx-derived stage-1 budget (unchanged behaviour)', () => {
    expect(chapterChunkBudget(TODAY_LOCAL_CAPACITY())).toBe(resolveStage1ChunkCharBudget(TODAY_LOCAL_CAPACITY()));
  });

  it('stage-1 cast detection now sizes gemini to a finite token-derived budget (no longer MAX_SAFE_INTEGER)', () => {
    expect(resolveStage1ChunkCharBudget(gemini(), 'x'.repeat(200000))).toBeLessThan(200000);
  });

  it('a Night-Watch-sized chapter yields >=2 gemini chunks (was exactly 1 under MAX_SAFE_INTEGER)', () => {
    const budget = chapterChunkBudget(gemini());
    // ~60k chars — 600 sentences of ~100 chars.
    const sentences = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, text: 'x'.repeat(100) }));
    const chunks = chunkSentencesByBudget(sentences, { charBudget: budget, overlap: 3, serialize: (s) => s.text });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Under the old MAX_SAFE_INTEGER budget this was exactly 1.
    const oneCall = chunkSentencesByBudget(sentences, { charBudget: Number.MAX_SAFE_INTEGER, overlap: 3, serialize: (s) => s.text });
    expect(oneCall.length).toBe(1);
  });

  it('gemini output-heavy budget shrinks as reserved (roster) chars grow', () => {
    const sample = 'а'.repeat(5000);
    const noRoster = chapterChunkBudget(gemini(), 0, sample);
    const bigRoster = chapterChunkBudget(gemini(), 14000, sample);
    expect(bigRoster).toBeLessThan(noRoster);
  });

  it('gemini output-heavy budget never exceeds outputHeavyChunkChars', () => {
    const sample = 'a'.repeat(5000);
    expect(chapterChunkBudget(gemini(), 0, sample)).toBeLessThanOrEqual(32000);
  });

  it('local output-heavy budget is unchanged (num_ctx-derived, roster ignored)', () => {
    expect(chapterChunkBudget(TODAY_LOCAL_CAPACITY(), 14000, 'x')).toBe(resolveStage1ChunkCharBudget(TODAY_LOCAL_CAPACITY()));
  });

  it('a request-cap capacity sizes the body to ITS perRequestInputCap, not the registry cap (#3084)', () => {
    const sample = 'a'.repeat(200000);
    const tight = { ...gemini(), perRequestInputCap: 6000 };
    expect(chapterChunkBudget(tight, 0, sample)).toBeLessThan(chapterChunkBudget(gemini(), 0, sample));
  });
});
```
(The original file's line 11, `const S = …`, is kept; it is included in the replacement above.)

`server/src/analyzer/stage1-chunk.test.ts`:
- **Import.** Add `import { resolveCapacity } from './capacity.js';` after line 22, and this helper after line 24:
```ts
const gemini = () => resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' });
```
- **Line 138.** `const budget = resolveStage1ChunkCharBudget('gemini', ruBody);` → `const budget = resolveStage1ChunkCharBudget(gemini(), ruBody);`
- **Line 197.** `resolveStage1ChunkCharBudget('gemini', 'а'.repeat(120000), roster)` → `resolveStage1ChunkCharBudget(gemini(), 'а'.repeat(120000), roster)`
- **Lines 234-235.** Replace `'gemini'` with `gemini()` in both calls.

`server/src/analyzer/stage2-chunk.test.ts`:
- **Import.** Add `import { resolveCapacity } from './capacity.js';` after line 19.
- **Lines 162, 198, 199, 209 and 210.** Replace each `resolveStage2ChunkCharBudget('gemini', X)` with `resolveStage2ChunkCharBudget(resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' }), X)`. At 209-210 the capacity must be resolved inline, AFTER line 206 sets the env; inline calls do that.

`server/src/analyzer/output-heavy-tpm.test.ts`:
- **Import.** Add `import { resolveCapacity } from './capacity.js';` after line 44.
- **Constant.** Add `const GEMMA = () => resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' });` after line 48. In PR 2a it resolves to the 12000 request cap. PR 2b bounds that cap by Gemma's 16000 TPM, which leaves it at 12000, so neither PR moves these locks.
- **Lines 96, 122, 152, 177 and 178.** Replace each first argument `'gemini'` with `GEMMA()`.

`server/src/analyzer/attribution-eval/review-run.test.ts`:
- **Import.** Add `import { resolveCapacity, TODAY_LOCAL_CAPACITY } from '../capacity.js';` after line 24.
- **Line 56.** `'local',` (the first `chapterChunkBudget` argument) → `TODAY_LOCAL_CAPACITY(),`
- **Lines 116, 144, 162, 205, 299 and 338.** `engine: 'local',` → `capacity: TODAY_LOCAL_CAPACITY(),`
- **Line 236.** `engine: 'gemini',` → `capacity: resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }),`

`server/src/analyzer/attribution-eval/run-eval.test.ts`. In PR #3199's `describe('engine parameter mapping to attributeChapterStage2', …)`, keep the `beforeEach` / `afterEach` spy and both `evalFixture({ … })` calls unchanged, and replace the two cases' names and assertions:
```ts
    it('passes qwen engine as a context-family capacity to attributeChapterStage2', async () => {
      await evalFixture({
        analyzer: fakeAnalyzer,
        manuscriptId: 'm', title: 'T', truth, roster, chapterId: 44,
        stageCall: { language: 'en' } as never,
        engine: 'qwen',
      });
      expect(attributeChapterStage2Spy).toHaveBeenCalledWith(
        expect.objectContaining({ capacity: expect.objectContaining({ family: 'context' }) }),
      );
      expect(attributeChapterStage2Spy.mock.calls[0][0]).not.toHaveProperty('engine');
    });

    it('passes gemma engine as a request-cap capacity to attributeChapterStage2', async () => {
      await evalFixture({
        analyzer: fakeAnalyzer,
        manuscriptId: 'm', title: 'T', truth, roster, chapterId: 44,
        stageCall: { language: 'en' } as never,
        engine: 'gemma',
      });
      expect(attributeChapterStage2Spy).toHaveBeenCalledWith(
        expect.objectContaining({ capacity: expect.objectContaining({ family: 'requestCap' }) }),
      );
      expect(attributeChapterStage2Spy.mock.calls[0][0]).not.toHaveProperty('engine');
    });
```

- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/capacity-pinning.test.ts src/analyzer/chapter-chunker.test.ts src/analyzer/attribution-eval/run-eval.test.ts`
Expected FAIL:
- both `engine parameter mapping to attributeChapterStage2` cases in `run-eval.test.ts`: `run-eval.ts` still passes `engine: chunkEngine`, and no `capacity`;
- the pinning test goes red. Today's resolvers compare `capacity !== 'local'`, so every `local-qwen3.5:4b@32768` case takes the cloud branch: for example `stage1|local…|latin` expected `24000`, received a cloud value;
- `chapterChunkBudget … > local stays the num_ctx-derived stage-1 budget`;
- `… > a request-cap capacity sizes the body to ITS perRequestInputCap`.

`npm run typecheck` also fails on every changed call site.
- [ ] **Step 3: Implement**

`server/src/analyzer/token-budget.ts:47-51`:
```ts
export function cloudBodyCharBudget(
  body: string,
  reservedChars = 0,
  reservedTokens = 0,
  capTokens: number = resolveMaxInputTokensPerRequest(),
): number {
  const availableTokens = Math.max(0, capTokens - reservedTokens);
  const perRequestChars = Math.floor(availableTokens * charsPerTokenForText(body));
  return Math.max(2000, perRequestChars - reservedChars);
}
```
Also extend the doc comment above it (`:34-46`) with one line: `capTokens — the per-request input-token cap (EngineCapacity.perRequestInputCap); defaults to analyzer.gemini.maxInputTokensPerRequest.` An explicit `undefined` argument takes the default, so callers that pass `capacity?.perRequestInputCap` get today's value.

`server/src/analyzer/stage1-chunk.ts`: add `import type { EngineCapacity } from './capacity.js';` after line 33, and replace lines 95-125 with:
```ts
export function resolveStage1ChunkCharBudget(
  capacity: EngineCapacity | undefined,
  body?: string,
  runningRoster: CharacterOutput[] = [],
): number {
  if (capacity?.family !== 'context') {
    // Request-cap family (Gemini) — and an omitted capacity, exactly as an
    // omitted engine behaved before #3084: size the BODY to the per-request
    // token cap MINUS stage-1's fixed system-instruction + scaffold overhead
    // (reserved in token space so the full request — not just the body — stays
    // under the finite TPM guard), and MINUS the injected running-roster's own
    // char footprint (reserved in char space via the reservedChars param
    // cloudBodyCharBudget exposes).
    // #1691: the roster accumulates the whole book's cast, so a fixed-only
    // reservation hit a wall (~130 speaking cast — past it the total estimate
    // crossed 16000 & RequestExceedsTpmError dropped the chapter). Reserving
    // the roster's actual rendered size keeps the worst-case estimate under the
    // guard across the cast sizes a book realistically accumulates (cloudBody-
    // CharBudget's 2000-char floor is the practical ceiling — past ~290 all-
    // Cyrillic cast the roster's own tokens dominate).
    return cloudBodyCharBudget(
      body ?? '',
      stage1RosterReservedChars(runningRoster),
      STAGE1_CLOUD_RESERVED_TOKENS,
      capacity?.perRequestInputCap,
    );
  }
  return stage1ChunkBudgetForEngine(
    configValue<number>('analyzer.stage1.chunkCharBudget'),
    capacity.contextTokens,
    'local',
    configValue<number>('analyzer.stage1.localInputFraction'),
  );
}
```

`server/src/analyzer/stage2-chunk.ts`: add `import type { EngineCapacity } from './capacity.js';` after line 30, and replace lines 70-82 with:
```ts
export function resolveStage2ChunkCharBudget(capacity: EngineCapacity | undefined, body?: string): number {
  const configured = configValue<number>('analyzer.stage2.chunkCharBudget');
  if (capacity?.family !== 'context') {
    // Request-cap family (and an omitted capacity): min(configured, token-cap-derived).
    return Math.min(configured, cloudBodyCharBudget(body ?? '', 0, 0, capacity?.perRequestInputCap));
  }
  return stage2ChunkBudgetForEngine(
    configured,
    capacity.contextTokens,
    'local',
    configValue<number>('analyzer.stage2.localInputFraction'),
  );
}
```

`server/src/analyzer/chapter-chunker.ts`: add `import type { EngineCapacity } from './capacity.js';` after line 22, and replace lines 130-139 with:
```ts
export function chapterChunkBudget(
  capacity: EngineCapacity,
  reservedChars = 0,
  sampleText = '',
  reservedTokens = 0,
): number {
  if (capacity.family === 'context') return resolveStage1ChunkCharBudget(capacity); // roster rides on num_ctx; local truncation is the stage-2 fraction knob's domain
  const outputCap = configValue<number>('analyzer.gemini.outputHeavyChunkChars');
  return Math.min(
    outputCap,
    cloudBodyCharBudget(sampleText, reservedChars, reservedTokens, capacity.perRequestInputCap),
  );
}
```
In the same file's comment at `:116-117`, change `- local  ⇒` to `- context capacity (local)  ⇒` and `- gemini ⇒` to `- request-cap capacity (gemini) ⇒`. Those two bullet labels named the removed engine argument.

`server/src/config/registry.ts:129`: `default: 32000, // ← chapterChunkBudget('gemini') in analyzer/chapter-chunker.ts` → `default: 32000, // ← chapterChunkBudget(request-cap capacity) in analyzer/chapter-chunker.ts`

**Help text: how the effective budget is derived per family (F1).** No chunk-size
control is locked, hidden or deferred pending on-box acceptance anywhere in
this wave — every knob below stays user-editable in Advanced Settings before
any on-box row runs; on-box measurement (Task 2.10, run sheet §3) only tunes
defaults. Update these five knobs' `help` in `server/src/config/registry.ts` so
each names its family's formula, matching what Task 2.3 just implemented:
- **`analyzer.stage1.chunkCharBudget`** (`:102-111` on 46e62a34) — replace the
  `help` string with: `"Maximum characters per stage-1 cast-detection chunk
  before the chapter is split. Local (context-family) engines derive the
  effective budget as min(analyzer.stage1.localInputFraction × Ollama num_ctx ×
  ~2 chars/token, this ceiling), so a large or non-Latin chapter can never
  overflow the context window. Cloud (Gemini) engines ignore this knob
  entirely: their body is sized instead from
  analyzer.gemini.maxInputTokensPerRequest alone, with no further ceiling
  (stage 1 is the one pass that has none — see that knob's own help)."`
- **`analyzer.stage1.localInputFraction`** (`:112-121`) — append to the existing
  `help`: `" Feeds the min(fraction × num_ctx × ~2 chars/token, analyzer.stage1.chunkCharBudget) formula above; local engines only — Gemini ignores this knob."`
- **`analyzer.stage2.chunkCharBudget`** (`:82-91`) — replace the `help` string
  with: `"Maximum characters per stage-2 attribution chunk before the chapter
  is pre-emptively split. This value is the ceiling for BOTH families: local
  (context-family) engines derive min(analyzer.stage2.localInputFraction ×
  Ollama num_ctx × ~2 chars/token, this ceiling); cloud (Gemini) engines derive
  min(this ceiling, the body sized from analyzer.gemini.maxInputTokensPerRequest)."`
- **`analyzer.stage2.localInputFraction`** (`:92-101`) — append: `" Feeds the
  min(fraction × num_ctx × ~2 chars/token, analyzer.stage2.chunkCharBudget)
  formula above; local engines only — Gemini ignores this knob."`
- **`analyzer.gemini.outputHeavyChunkChars`** (`:122-131`) — append one sentence
  to the existing `help`: `" Local (context-family) engines ignore this knob
  and use the stage-1 cast-detection budget instead (chapterChunkBudget
  delegates to resolveStage1ChunkCharBudget for that family)."`
- **`analyzer.gemini.maxInputTokensPerRequest`** (`:70-79`) — append one
  sentence to the existing `help`, without yet mentioning the model TPM (PR 2b,
  Task 2.6, adds that bound and edits this same string again): `" Feeds the
  request-cap family's body sizing directly in stage 1 (no further ceiling —
  cloudBodyCharBudget only floors at 2000 chars, per token-budget.ts:47-51);
  stage 2 and the output-heavy passes additionally cap the result at that
  pass's own char ceiling (analyzer.stage2.chunkCharBudget /
  analyzer.gemini.outputHeavyChunkChars)."` Stage 1's own resolver
  (`resolveStage1ChunkCharBudget`, `stage1-chunk.ts:95-117`) takes the cloud
  branch (`engine !== 'local'`) straight to `cloudBodyCharBudget(...)` with no
  `Math.min` against anything else — there IS no stage-1 ceiling to name.
- **`analyzer.ollama.numCtx`** (`registry.ts:953-961`) — F1 names this knob
  explicitly as one of the inputs to the effective chunk size (it is the
  context-family's `contextTokens`, feeding both `localInputFraction`
  formulas above). Append one sentence to its EXISTING `help` (do not replace
  it — the KV-cache-reload warning stays): `" Feeds
  min(analyzer.stage{1,2}.localInputFraction × this × ~2 chars/token,
  analyzer.stage{1,2}.chunkCharBudget) for local (context-family) engines;
  Gemini engines ignore this knob entirely."`

These are `help`-string-only edits (no `env`, `min`/`max`, `default` or `type`
changes) — `config:sync` (`server/scripts/sync-env-example.ts`) does not read
`help`, so `.env.example` is unaffected; confirmed by reading that script on
46e62a34, which builds each managed-block line from `env`/`default`/`label`
only. `docs/wiki/Advanced-Settings.md`'s "What it does" column is a paraphrase
of `help` per knob — update §2's five rows (Stage-1/Stage-2 chunk char
budget, Stage-1/Stage-2 local input fraction, Gemini output-heavy chunk
chars) to name the family split in one clause each, and §1's "Ollama num_ctx"
row to add the same one-clause pointer to the formula it feeds, in the same
commit.
`scripts/tests/knob-docs-sync.test.mjs` (#2012, run by `npm run test:hooks`)
fails if any registry knob's `label` has no row in that file — it does not
check `help` content, so it does not gate the wording itself, but every knob
touched here already has a row (this task only edits `help`, not `label`), so
the guard stays green; run it in Step 4 alongside the existing suites.

`server/src/routes/analysis.ts`:
- **Imports.** After line 12, add `import { resolveCapacity, type EngineCapacity } from '../analyzer/capacity.js';`.
- **Lines 2208-2212.** Replace with:
```ts
  /* Phase-1 analyzer capacity (#3084 wave 2) — sizes the chunk budget: a
     context-family capacity (local Ollama) derives it from num_ctx so a fat
     input chunk doesn't starve the output window (#528 follow-up; 2026-06-14
     qwen3.5:4b truncation). Omitted → the request-cap budget at the registry
     cap, as an omitted engine behaved before. */
  capacity?: EngineCapacity;
```
- **Line 2308.** `charBudget: resolveStage2ChunkCharBudget(opts.engine, opts.chapter.body),` → `charBudget: resolveStage2ChunkCharBudget(opts.capacity, opts.chapter.body),`
- **Lines 4410-4411.** Replace `resolveStage1ChunkCharBudget(\n                      selection.engine,` with:
```ts
                    charBudget: resolveStage1ChunkCharBudget(
                      resolveCapacity({ engine: selection.engine, model: selection.model }),
```
- **Line 5375.** `engine: phase1Selection.engine,` → `capacity: resolveCapacity({ engine: phase1Selection.engine, model: phase1Selection.model }),`
- **Lines 6926-6927.** Replace `selection.engine,` with `resolveCapacity({ engine: selection.engine, model: selection.model }),`.
- **Line 7221.** `engine: phase1Selection.engine,` → `capacity: resolveCapacity({ engine: phase1Selection.engine, model: phase1Selection.model }),`

Check first that 5375 and 7221 are the `attributeChapterStage2WithEval({` argument objects (`analysis.ts:5368`, `:7215`), and not the SSE `engine:` fields at `:6237` / `:7818`, which stay.

`server/src/routes/annotate-emotion.ts`:
- **Import.** Add `import { resolveCapacity } from '../analyzer/capacity.js';` beside the `chapter-chunker.js` import.
- **Line 179.** `selection.engine,` → `resolveCapacity({ engine: selection.engine, model: selection.model }),`

`server/src/routes/instruct-annotation.ts`: same import; line 178 `selection.engine,` → `resolveCapacity({ engine: selection.engine, model: selection.model }),`.

`server/src/routes/script-review.ts`: same import; line 823 `activeSelection.engine,` → `resolveCapacity({ engine: activeSelection.engine, model: activeSelection.model }),`.

`server/src/analyzer/attribution-eval/review-run.ts`:
- **Import.** Add `import type { EngineCapacity } from '../capacity.js';` after line 29.
- **Line 47.** `engine: 'local' | 'gemini';` → `capacity: EngineCapacity;`
- **Line 56.** In the destructure, `engine,` → `capacity,`
- **Line 61.** `engine,` → `capacity,`

`server/src/analyzer/attribution-eval/run-eval.ts`, as PR #3199 left it (lines on `origin/main`). That PR moved `chunkEngine` above the `attributeChapterStage2({ … })` call (`const chunkEngine` at `:190`, the call at `:192`), and it now feeds both that call (`engine: chunkEngine,` at `:200`) and the review call (`runReviewOverChapter({` at `:240`, `engine: chunkEngine,` at `:242`):
- **Import.** Add `import { resolveCapacity } from '../capacity.js';`.
- **Declaration.** Directly above `const result = await attributeChapterStage2({`, replace PR #3199's two comment lines and `const chunkEngine = opts.engine === 'qwen' ? 'local' : 'gemini';` with:
```ts
  // Map the eval engine ('qwen'/'gemma') to the chunk-budget capacity.
  // Used by both stage 2 (chunk sizing) and review (if enabled).
  const chunkCapacity =
    opts.engine === 'qwen'
      ? resolveCapacity({ engine: 'local', model: process.env.EVAL_QWEN_MODEL ?? 'qwen3.5:9b' })
      : resolveCapacity({ engine: 'gemini', model: configValue<string>('analyzer.gemini.model') });
```
- **Stage-2 call.** In `attributeChapterStage2({ … })`, change `engine: chunkEngine,` to `capacity: chunkCapacity,`.
- **Review call.** Change `engine: chunkEngine,` to `capacity: chunkCapacity,`. The model fallback mirrors `slotLabel` in `run-eval-cli.ts:30-33`.

- [ ] **Step 4: Run and confirm it passes**

Run, in order:
```
npm --prefix server run test -- src/analyzer/capacity-pinning.test.ts src/analyzer/capacity.test.ts src/analyzer/chapter-chunker.test.ts src/analyzer/stage1-chunk.test.ts src/analyzer/stage2-chunk.test.ts src/analyzer/output-heavy-tpm.test.ts src/analyzer/token-budget.test.ts src/analyzer/attribution-eval
npm --prefix server run test -- src/routes/annotate-emotion.test.ts src/routes/instruct-annotation.test.ts src/routes/script-review.test.ts src/routes/analysis.test.ts src/routes/analysis.structure-engine.test.ts src/routes/analysis.structure-fixture.test.ts
npm --prefix server run test:slow -- src/routes/analysis-pipelining.test.ts
npm run typecheck
npm run check:cycles
node scripts/tests/knob-docs-sync.test.mjs
git diff --exit-code -- server/src/analyzer/__fixtures__/capacity-pinning.json
```
Expected: all PASS, and the fixture shows no diff. `knob-docs-sync.test.mjs`
(#2012, also run by `npm run test:hooks`) checks that every registry knob's
`label` has a row in `docs/wiki/Advanced-Settings.md`; it does not check `help`
content, so it cannot fail from this task's help-text wording, but it does
confirm the six touched knobs still have their rows after this task's edits.
- [ ] **Step 5: Mutation proof**
  1. In `stage1-chunk.ts`, change `if (capacity?.family !== 'context') {` to `if (capacity === undefined) {`.
  2. Run `npm --prefix server run test -- src/analyzer/capacity-pinning.test.ts`. Expected red: `… every resolver × engine × script equals the fixture captured from main` (`stage1|gemini-3.5-flash-lite@12000|*` now takes the context branch with `contextTokens` 12000).
  3. Restore it.
  4. In `chapter-chunker.ts`, drop the fourth argument `capacity.perRequestInputCap`. Expected red: `chapterChunkBudget … > a request-cap capacity sizes the body to ITS perRequestInputCap`.
  5. Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/token-budget.ts server/src/analyzer/stage1-chunk.ts server/src/analyzer/stage2-chunk.ts server/src/analyzer/chapter-chunker.ts server/src/config/registry.ts server/src/routes/analysis.ts server/src/routes/annotate-emotion.ts server/src/routes/instruct-annotation.ts server/src/routes/script-review.ts server/src/analyzer/attribution-eval/review-run.ts server/src/analyzer/attribution-eval/run-eval.ts server/src/analyzer/attribution-eval/run-eval.test.ts server/src/analyzer/capacity-pinning.test.ts server/src/analyzer/chapter-chunker.test.ts server/src/analyzer/stage1-chunk.test.ts server/src/analyzer/stage2-chunk.test.ts server/src/analyzer/output-heavy-tpm.test.ts server/src/analyzer/attribution-eval/review-run.test.ts docs/wiki/Advanced-Settings.md
git commit -m "refactor(server): size analyzer chunk budgets from EngineCapacity (#3084)"
```

**Tests this task could break (all run in Step 4):**
- the chunk suites listed in Files;
- `token-budget.test.ts`;
- the `attribution-eval/*` suites, including PR #3199's `run-eval.test.ts` engine-mapping cases (updated in Step 1);
- the three passes' route tests (`annotate-emotion.test.ts:257`, `instruct-annotation.test.ts:302` and `script-review.test.ts:607`, which force a small `num_ctx`);
- the `attributeChapterStage2` suites (`analysis.test.ts:8290-8370`, `analysis.structure-engine.test.ts`, `analysis.structure-fixture.test.ts`; none pass `engine`, so they compile unchanged);
- slow `analysis-pipelining.test.ts`.

### Task 2.4: Ship PR 2a

**Files:** `docs/release-notes-next.md` and `RELEASE_NOTES.md` (Step 2, F1's help-text rewrites are user-visible); nothing else beyond Tasks 2.1–2.3.

- [ ] **Step 1: Derived artifacts.**
  - OpenAPI is untouched: no regen.
  - No knob is added or changed, so there is no `config:sync`. Confirm with `npm run config:check` (PASS; the registry diff is a comment only).
- [ ] **Step 2: Release notes.** The chunk-budget refactor itself is
  behaviour-preserving (pinned by `capacity-pinning.test.ts`), but Task 2.3's
  help-text rewrites are user-visible Advanced Settings copy — six knobs plus
  `analyzer.ollama.numCtx` now explain how the effective chunk size is
  derived (F1) — so this PR is NOT a no-op for release notes. Append to
  `docs/release-notes-next.md`'s `## 🗣️ Analyzer, script review & manuscript`
  section:
  ```markdown
  - **Advanced Settings explains how each chunk-size knob derives its effective budget** — `analyzer.stage1.chunkCharBudget`, `analyzer.stage2.chunkCharBudget`, both `localInputFraction` knobs, `analyzer.gemini.outputHeavyChunkChars`, `analyzer.gemini.maxInputTokensPerRequest` and `analyzer.ollama.numCtx` all gained a help-text sentence naming the formula for their engine family; no default or behaviour changed (pinned by `capacity-pinning.test.ts`). (#<2a>, #3084)
  ```
  and to `RELEASE_NOTES.md`'s in-progress version section:
  ```markdown
  - **Advanced Settings now explains what each chunk-size setting actually controls**, instead of leaving you to guess how it interacts with the others.
  ```
  Commit: `git add docs/release-notes-next.md RELEASE_NOTES.md && git commit -m "docs(docs): release notes for the chunking help-text rewrite (#3084)"`.
  (`docs: <subject>` with no scope is refused — only `chore:` is the no-scope
  catch-all, per `CONTRIBUTING.md:17`; `docs(docs):` is the correct scoped form
  for a docs-only change with no more specific scope.)
- [ ] **Step 3: On-box acceptance** — not applicable. PR 2a ships no behaviour that needs hardware to prove. The wave 2 rows and the run sheet `docs/testing/3084-openai-analyzer-onbox-acceptance.md` ship in PR 2b (Task 2.10).
- [ ] **Step 4: Regression plan** — `docs/features/284-openai-compatible-analyzer.md` already states invariant 5 (chunk budgets pinned), so it needs no edit. `docs/features/INDEX.md` needs none either.
- [ ] **Step 5: Verify**
Run: `npm run verify:fast:branch`  Expected: PASS.
- [ ] **Step 6: Push and open the PR**
```bash
git push -u origin refactor/server-3084-w2a-capacity
gh pr create --title "refactor(server): capacity model for analyzer chunk budgets (#3084 wave 2a)" --body-file <path-to-body.md>
```
Body (write to a scratch file):
```markdown
## Summary
- `EngineCapacity` / `resolveCapacity` (`server/src/analyzer/capacity.ts`): Ollama is the context family (`num_ctx` as sent, no `/api/show` clamp); Gemini is the request-cap family, with `perRequestInputCap = analyzer.gemini.maxInputTokensPerRequest`, today's value. The `min(cap, model TPM)` bound is deliberately left to PR 2b, which pins and announces it; here a `GEMINI_TPM_<SLUG>` env var or a saved `rate.tpm.gemma*` override below 12000 changes nothing (pinned by `capacity.test.ts`).
- `resolveStage1ChunkCharBudget`, `resolveStage2ChunkCharBudget` and `chapterChunkBudget` take a capacity instead of an engine name, and every caller is updated (analysis, annotate-emotion, instruct-annotation, script-review, attribution eval).
- A pinning fixture captured from unmodified `main`, which includes PR #3199. It has 42 cases: stage 1 ± roster, stage 2 and three `chapterChunkBudget` shapes, × local `qwen3.5:4b`@32768 / `gemini-3.5-flash-lite`@12000, × Coalfall Latin, Cyrillic, Han, kana. It has 54 cases, with an `unset` column, only if Task 2.1's caller grep found a production caller that passes no engine. State which case applies, and paste the grep output. The fixture is committed before the refactor and unchanged after it.

Also fixed, found in passing: `registry.ts:129` and `chapter-chunker.ts:116-117` comments named the removed engine argument.

Release notes: the chunk-budget refactor is behaviour-preserving, but Task
2.3's help-text rewrites are user-visible Settings copy — see both
release-notes files (Step 2).

## Test plan
- [ ] `capacity-pinning.test.ts` green; `git log -- server/src/analyzer/__fixtures__/capacity-pinning.json` shows one commit (capture SHA recorded in the fixture's `capturedFrom`)
- [ ] mutation proofs pasted (Tasks 2.1–2.3)
- [ ] `npm run typecheck`, `npm run check:cycles`, `npm run verify:fast:branch`

Refs #3084

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013DFfsAoY1LtxjDgnGPSZkc
```
- [ ] **Step 7: Review gate.** Run the `pr-review-gate` skill at depth **high** (a `refactor` PR). Fold findings and re-run per the skill before merging.

---

### PR 2b — Gemini catalog, Auto max output tokens, TPM-bound input cap, thought summaries, thinking window, request ceiling, reasoning overflow

- **Branch:** `feat/server-3084-w2b-output-cap`. Create it with `node scripts/wt-new.mjs feat/server-3084-w2b-output-cap` off the latest `main`, after PR 2a merges. **Branch names take a single scope** (`scripts/lib/branch-name.mjs`'s `SCOPE_GROUP`; CONTRIBUTING.md's comma-separated scope form is for commit subjects only, not branch names — `node scripts/wt-new.mjs feat/server,frontend-…` is refused). Task 2.9a lands real frontend component code too, but the branch stays single-scope `server`; the PR title and each commit subject use the multi-scope `feat(server,openapi,frontend):` form instead.
- **Delivers:**
  - `server/src/analyzer/catalog/gemini-catalog.ts`: a 10-minute cached `models.list`, filtered per planning facts §C.3, warmed before each request by a warm-up bounded at 10 s. The caller's abort signal releases that caller; the shared listing is cancelled only when no caller still waits (Task 2.5, P26).
  - `analyzer.gemini.maxOutputTokens` defaulting to 0 = Auto (the model's `outputTokenLimit`, else 8192), with manual values clamped to the known limit. The runner passes the resolved cap to both transports (Task 2.6).
  - The per-request input cap bounded by the model's TPM, `perRequestInputCap = min(analyzer.gemini.maxInputTokensPerRequest, resolveLimits(model).tpm)`, pinned by a test and announced in the release notes (Task 2.6).
  - Thinking Gemini models — decided by the static id rule in `geminiModelThinks`, never the live catalog (P27) — request `thinkingConfig.includeThoughts: true`. Thought parts feed the heartbeat, and `thoughtsTokenCount` becomes `usage.reasoningTokens` only on a request that asked for thoughts (Task 2.7).
  - A thinking window, `analyzer.gemini.thinkingIdleTimeoutMs` (env `GEMINI_THINKING_IDLE_MS`, integer 0–290 000; `0` = automatic: 120 000 ms for a thinking model, today's idle window for any other; a positive value applies to every model). It bounds every silent gap until the first answer text; after that, today's 45 s idle watchdog applies unchanged. A thinking-window timeout is `AnalyzerTimeoutError` (`analyzer-timeout`), not retried. Every Gemini request is bounded by `analyzer.gemini.requestCeilingMs` (30 min; `AnalyzerTimeoutError`). One timing line per attempt: time to first chunk, time to first answer text, thought parts before the answer (Task 2.8, P5).
  - The reasoning-overflow rule in `runner/finish.ts`, FailureCode `analyzer-reasoning-overflow` in all six places, and an overflow that stops new spend. It ends the analysis run, and the job then starts no new chapters, escalation windows or non-story classification calls. Chapters already in flight finish and cache for resume. It also stops a script-review pass, the emotion and instruct passes and the attribution eval's review run, as a content block or a daily quota does (Task 2.9, P20).
  - A reasoning-overflow failure names the chapter, model and engine (Task 2.9), and lists structured `fixes` — Gemini/Ollama settings to raise, each linking `#/advanced?focus=<key>` — rendered as a "How to fix" list and a persistent toast that survives navigating away, plus a new wiki section (Task 2.9a, F7).
  - On-box register rows "Gemini thinking-window timing", "Thinking-model output" and "Capacity recalibration", with the run sheet and live view rows (Task 2.10).
- **Must NOT change:**
  - any chunk budget at default settings (`capacity-pinning.test.ts` stays green, fixture untouched);
  - `analyzer.ollama.numPredict` or its semantics;
  - the Gemini structured-output mode (`json`), temperature, or either retry policy;
  - Gemini `thinkingLevel` (wave 5; `thinkingBudget` is retired, F2) and Ollama `think` (stays `false`);
  - the idle watchdog once a request's answer text has started (`resolveStreamIdleTimeoutMs()`, 45 s), and the whole watchdog of a model that does not think at the automatic thinking window;
  - anything endpoint-shaped (wave 3).
- **Entry criteria:**
  - PR 2a is merged.
  - `rate-limit.ts`'s limit resolver has been re-read on the current `main`: `function resolveLimits(model: string): ModelLimits` at `:95` after #3163 (`:76` on 46e62a34). Task 2.6 exports it under that name.
  - **P5 and P20 are approved by the owner (2026-09-13).** This PR is written to both:
    - **P5:** no probe gate, and a thinking window that bounds silence until the first answer text. Its automatic default is 120 000 ms (2 min); Advanced Settings can raise it to at most 290 000 ms.
    - **P20, "stop new spend," with a loud, actionable warning:** an overflow ends the run and stops new chapters, escalation windows, non-story calls and the output-heavy passes; chapters already in flight finish and cache. The failure names what happened and lists structured fixes the user can act on (Task 2.9a).
    - **P20 alternative (not chosen):** skip the overflowing chapter and continue.

    The master plan's gate for 2b is both approvals, and both are satisfied. A different P5 would change only Task 2.8 and run sheet §1; a different P20 would change only Task 2.9's run-stop edits, Task 2.9a's fixes, and their tests.
- **Exit criteria:**
  - All task tests and the mutation proofs are green.
  - `npm run openapi:types` output is committed.
  - `npm run config:check` is green after `npm run config:sync`.
  - `npm run register:build -- --check` (if the script exposes `--check`; otherwise `npm run register:build` followed by `git diff --exit-code`) and `npm run check:onbox-register` are green, and the live view is published.
  - `node scripts/tests/knob-docs-sync.test.mjs` (#2012) is green — every knob this PR adds or relabels (the thinking window, the request ceiling) has a row in `docs/wiki/Advanced-Settings.md`.
  - `npm run verify:fast:branch` is green.
  - `pr-review-gate` has run at depth `high` (the PR touches the server, openapi, frontend and docs scopes).

### Task 2.5: Cached Gemini model catalog, bounded warm-up, static thinking rule

**Files:**
- Create: `server/src/analyzer/catalog/gemini-catalog.ts`
- Test: `server/src/analyzer/catalog/gemini-catalog.test.ts`

**Interfaces:**
- Consumes:
  - `GoogleGenAI.models.list(params?: ListModelsParameters): Promise<Pager<Model>>` (`genai.d.ts:11032`). `Pager` is `AsyncIterable` (`:11581`).
  - `ListModelsParameters { config?: ListModelsConfig }` and `ListModelsConfig { httpOptions?: HttpOptions; abortSignal?: AbortSignal; … }` (`genai.d.ts:9390-9409`); `HttpOptions.timeout?: number`, "Timeout for the request in milliseconds" (`genai.d.ts:7735-7736`).
  - `Model.{name, displayName, inputTokenLimit, outputTokenLimit, supportedActions, thinking}` (`genai.d.ts:10790-10842`).
- Produces:
  - `export interface GeminiModelInfo { id: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; thinking?: boolean }` (contract)
  - `export async function listGeminiModels(apiKey: string, opts?: { refresh?: boolean; client?: GeminiModelsClient }): Promise<GeminiModelInfo[]>` (contract, plus a `client` injection seam; rejects on failure and after `GEMINI_CATALOG_WARM_TIMEOUT_MS`)
  - `export function getCachedGeminiModelInfo(model: string): GeminiModelInfo | undefined` (contract; answers only for the key most recently listed or warmed, N6)
  - `export async function warmGeminiCatalog(apiKey: string, opts?: { client?: GeminiModelsClient; signal?: AbortSignal }): Promise<void>` (the contract's signature plus `signal`, P26; never rejects; used before each stage call; an abort releases only that caller, and the shared listing is cancelled once no caller still waits)
  - `export function geminiModelThinks(model: string): boolean` (the static id rule only, P27)
  - `export function toGeminiModelInfo(m: GeminiListedModel): GeminiModelInfo | null`
  - `export type GeminiModelsClient = { models: { list: (params?: { config?: { httpOptions?: { timeout?: number }; abortSignal?: AbortSignal } }) => Promise<AsyncIterable<GeminiListedModel>> } }`
  - `export const GEMINI_CATALOG_TTL_MS = 600_000`, `export const GEMINI_CATALOG_WARM_TIMEOUT_MS = 10_000`
  - `export function _resetGeminiCatalogForTest(): void`

**Why the warm-up is bounded (P26).** `prepare()` (Task 2.6) awaits the warm-up before the limiter, the request ceiling and the idle watchdog exist. Concurrent requests share one listing, so a listing that never settles would hang every Gemini request behind it, and pause could not interrupt the wait. So:
- the listing is bounded at `GEMINI_CATALOG_WARM_TIMEOUT_MS` (10 s), and a timeout counts as a failed listing: the cache stays as it was, callers use the fallback limits (12000-token cap, 8192 output), and the 60 s failure back-off stops a request per stage call from re-waiting during an outage;
- concurrent requests share that one bounded listing;
- the caller's `signal` releases that caller's wait at once. The shared listing is cancelled only when no caller still waits: its SDK request is aborted, it caches nothing, and it starts no failure back-off, so a resumed request lists again at once;
- a successful listing resets the one-time failure warning, so a later outage warns again (N6);
- `getCachedGeminiModelInfo` answers only for the key most recently listed or warmed. After a key change, the previous key's limits are never served, even while the new key's listing fails; callers use the fallback limits until it succeeds (N6).

**How the installed SDK bounds a listing** (read from `server/node_modules/@google/genai/dist/node/index.mjs`):
- `Models.list(params)` merges `params.config` over `{ queryBase: true }` (`:15390-15398`) and pages through `listInternal`, which hands `config.httpOptions` and `config.abortSignal` to `apiClient.request` (`:16290-16298`). The pager re-uses the same `params` for later pages.
- `apiCall` builds a fresh signal per HTTP attempt from `httpOptions.timeout` and the caller's `abortSignal` (`createAttemptSignal`, `:13452-13476`, called at `:13871`).
- Side effect: a positive `httpOptions.timeout` makes the SDK raise the global undici dispatcher's headers and body timeouts to at least that value (`raiseUndiciTimeouts`, `:13430-13445`, called from `:13737-13740`). Undici's own defaults are 300 s, so a 10 s value changes nothing.

`listGeminiModels` passes both, and also races the whole listing (the call plus page iteration) against its own 10 s timer, which aborts the SDK signal when it fires. The own timer is what a non-cooperative client, or a test's client that ignores the config, cannot escape.

**Thinking rule (P27).** `geminiModelThinks(model)` is `^gemini-(?:2\.5-(?:pro|flash)(?!-lite)|[3-9])` and nothing else. It never reads the catalog's `thinking` flag, so a model's request shape (Task 2.7) and thinking window (Task 2.8) never change when a warm-up fails or a listing changes.
- Gemini 2.5 Pro and 2.5 Flash, and every Gemini 3.x+ model including Flash-Lite, count as thinking. Planning facts §C.2: 3.x cannot turn thinking off, and "minimal does not guarantee thinking is off".
- 2.5 Flash-Lite does not think by default, so it is excluded.
- `gemma-*` is outside the rule. Gemma 4 on the Gemini API has a thinking on/off control, but its default and whether `includeThoughts` applies to it are unconfirmed (planning facts §C.2). Wave 5 adds `includeThoughts` when a reasoning level turns Gemma's thinking on (P19).

- [ ] **Step 1: Write the failing test**
```ts
/* #3084 wave 2b — Gemini model catalog: models.list filter (planning facts §C.3:
   no output-modality field, so supportedActions + name exclusions), 10-minute
   cache, key-change refetch, in-flight dedupe, a warm-up bounded at 10 s whose
   caller's abort signal releases that caller and whose shared listing is
   cancelled once no caller waits (P26), a failure warning that re-arms after a
   success and cached limits keyed to the active key (N6), and the static
   thinking rule (P27). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listGeminiModels,
  getCachedGeminiModelInfo,
  warmGeminiCatalog,
  geminiModelThinks,
  toGeminiModelInfo,
  GEMINI_CATALOG_TTL_MS,
  GEMINI_CATALOG_WARM_TIMEOUT_MS,
  _resetGeminiCatalogForTest,
  type GeminiModelsClient,
} from './gemini-catalog.js';

const LISTED = [
  { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedActions: ['generateContent', 'countTokens'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, thinking: true },
  { name: 'models/gemma-4-31b-it', supportedActions: ['generateContent'], inputTokenLimit: 131_072, outputTokenLimit: 8_192 },
  { name: 'models/gemini-embedding-001', supportedActions: ['embedContent'] },
  { name: 'models/gemini-3.5-flash-preview-tts', supportedActions: ['generateContent'] },
  { name: 'models/imagen-4.0-generate-001', supportedActions: ['generateContent', 'predict'] },
  { name: 'models/gemini-3.6-flash-live', supportedActions: ['generateContent', 'bidiGenerateContent'] },
  { name: 'models/aqa', supportedActions: ['generateAnswer', 'generateContent'] },
];

type SpyClient = GeminiModelsClient & { models: { list: ReturnType<typeof vi.fn> } };

function fakeClient(models: object[] = LISTED): SpyClient {
  return {
    models: {
      list: vi.fn(async () =>
        (async function* () {
          yield* models;
        })(),
      ),
    },
  } as unknown as SpyClient;
}

/** A models.list() that never settles, like a stalled connection. */
function hungClient(): SpyClient {
  return { models: { list: vi.fn(() => new Promise<never>(() => {})) } } as unknown as SpyClient;
}

beforeEach(() => _resetGeminiCatalogForTest());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('toGeminiModelInfo / listGeminiModels filter', () => {
  it('keeps generateContent text models, strips models/, drops embedding/tts/image/live/aqa', async () => {
    const out = await listGeminiModels('k1', { client: fakeClient() });
    expect(out).toEqual([
      { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, thinking: true },
      { id: 'gemma-4-31b-it', displayName: undefined, inputTokenLimit: 131_072, outputTokenLimit: 8_192, thinking: undefined },
    ]);
  });

  it('rejects a model with no name', () => {
    expect(toGeminiModelInfo({ supportedActions: ['generateContent'] })).toBeNull();
  });
});

describe('cache', () => {
  it('serves a second call within 10 minutes from cache', async () => {
    const client = fakeClient();
    await listGeminiModels('k1', { client });
    await listGeminiModels('k1', { client });
    expect(client.models.list).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL', async () => {
    const client = fakeClient();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await listGeminiModels('k1', { client });
    now.mockReturnValue(1_000_000 + GEMINI_CATALOG_TTL_MS + 1);
    await listGeminiModels('k1', { client });
    expect(client.models.list).toHaveBeenCalledTimes(2);
  });

  it('refetches on refresh: true and on a different key', async () => {
    const client = fakeClient();
    await listGeminiModels('k1', { client });
    await listGeminiModels('k1', { client, refresh: true });
    await listGeminiModels('k2', { client });
    expect(client.models.list).toHaveBeenCalledTimes(3);
  });

  it('dedupes concurrent listings', async () => {
    const client = fakeClient();
    await Promise.all([listGeminiModels('k1', { client }), listGeminiModels('k1', { client })]);
    expect(client.models.list).toHaveBeenCalledTimes(1);
  });

  it('getCachedGeminiModelInfo answers synchronously after a listing', async () => {
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
    await listGeminiModels('k1', { client: fakeClient() });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')?.outputTokenLimit).toBe(65_536);
    expect(getCachedGeminiModelInfo('not-listed')).toBeUndefined();
  });

  it('asks the SDK to bound the request: httpOptions.timeout 10 s plus an abort signal (P26)', async () => {
    const client = fakeClient();
    await listGeminiModels('k1', { client });
    expect(GEMINI_CATALOG_WARM_TIMEOUT_MS).toBe(10_000);
    expect(client.models.list).toHaveBeenCalledWith({
      config: { httpOptions: { timeout: 10_000 }, abortSignal: expect.any(AbortSignal) },
    });
  });
});

describe('warmGeminiCatalog', () => {
  it('swallows a listing failure, warns once without the key, and leaves the cache empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { models: { list: vi.fn(async () => { throw new Error('bad key sk-SECRET-123'); }) } } as unknown as GeminiModelsClient;
    await expect(warmGeminiCatalog('sk-SECRET-123', { client })).resolves.toBeUndefined();
    await expect(warmGeminiCatalog('sk-SECRET-123', { client })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('sk-SECRET-123');
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
  });

  it('backs off listing for a minute after a failure (no request per stage call during an outage)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = vi.fn(async () => { throw new Error('offline'); });
    const client = { models: { list } } as unknown as GeminiModelsClient;
    await warmGeminiCatalog('k1', { client });
    await warmGeminiCatalog('k1', { client });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('a hung models.list() releases every waiting request after 10 s, on one shared listing, with the cache left empty (P26)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = hungClient();
    let released = 0;
    void warmGeminiCatalog('k1', { client }).then(() => { released += 1; });
    void warmGeminiCatalog('k1', { client }).then(() => { released += 1; });
    await vi.advanceTimersByTimeAsync(GEMINI_CATALOG_WARM_TIMEOUT_MS - 1);
    expect(released).toBe(0);
    expect(client.models.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(2);
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
  });

  it("the caller's abort signal releases its own wait at once; the shared listing still bounds the other request (P26)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = hungClient();
    const controller = new AbortController();
    let paused = false;
    let other = false;
    void warmGeminiCatalog('k1', { client, signal: controller.signal }).then(() => { paused = true; });
    void warmGeminiCatalog('k1', { client }).then(() => { other = true; });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(paused).toBe(true);
    expect(other).toBe(false);
    await vi.advanceTimersByTimeAsync(GEMINI_CATALOG_WARM_TIMEOUT_MS);
    expect(other).toBe(true);
    expect(client.models.list).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted signal returns without listing', async () => {
    const client = fakeClient();
    await warmGeminiCatalog('k1', { client, signal: AbortSignal.abort() });
    expect(client.models.list).not.toHaveBeenCalled();
  });

  it('when every waiting caller has released, the shared listing is cancelled: its SDK signal aborts, nothing is cached, and no back-off starts (P26)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = hungClient();
    const controller = new AbortController();
    let released = false;
    void warmGeminiCatalog('k1', { client, signal: controller.signal }).then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(true);
    const sdkSignal = (client.models.list.mock.calls[0][0] as { config: { abortSignal: AbortSignal } }).config.abortSignal;
    expect(sdkSignal.aborted).toBe(true);
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
    /* A cancel is not a failure: the next request lists again at once, and nothing was warned. */
    void warmGeminiCatalog('k1', { client });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.models.list).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GEMINI_CATALOG_WARM_TIMEOUT_MS);
  });

  it('a successful listing re-arms the failure warning, so a later outage warns again (N6)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const failing = { models: { list: vi.fn(async () => { throw new Error('offline'); }) } } as unknown as GeminiModelsClient;
    await warmGeminiCatalog('k1', { client: failing });
    expect(warn).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + 60_001); // past the failure back-off
    await warmGeminiCatalog('k1', { client: fakeClient() });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')?.outputTokenLimit).toBe(65_536);
    now.mockReturnValue(1_000_000 + 60_001 + GEMINI_CATALOG_TTL_MS + 1); // the listing has expired
    await warmGeminiCatalog('k1', { client: failing });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("after a key change the old key's cached limits are not served, even while the new key's listing fails (N6)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await listGeminiModels('k1', { client: fakeClient() });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')?.outputTokenLimit).toBe(65_536);
    const failing = { models: { list: vi.fn(async () => { throw new Error('bad key'); }) } } as unknown as GeminiModelsClient;
    await warmGeminiCatalog('k2', { client: failing });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
    /* Switching back to k1 serves its still-fresh listing again, with no new request. */
    const k1Client = fakeClient();
    await warmGeminiCatalog('k1', { client: k1Client });
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')?.outputTokenLimit).toBe(65_536);
    expect(k1Client.models.list).not.toHaveBeenCalled();
  });
});

describe('geminiModelThinks (P27)', () => {
  it('follows the static id rule', () => {
    expect(geminiModelThinks('gemini-3.6-flash')).toBe(true);
    expect(geminiModelThinks('gemini-3.5-flash-lite')).toBe(true);
    expect(geminiModelThinks('gemini-2.5-flash')).toBe(true);
    expect(geminiModelThinks('gemini-2.5-pro')).toBe(true);
    expect(geminiModelThinks('gemini-2.5-flash-lite')).toBe(false);
    expect(geminiModelThinks('gemma-4-31b-it')).toBe(false);
  });

  it('ignores the catalog thinking flag in both directions', async () => {
    await listGeminiModels('k1', {
      client: fakeClient([
        { name: 'models/gemma-4-31b-it', supportedActions: ['generateContent'], thinking: true },
        { name: 'models/gemini-3.6-flash', supportedActions: ['generateContent'], thinking: false },
      ]),
    });
    expect(geminiModelThinks('gemma-4-31b-it')).toBe(false);
    expect(geminiModelThinks('gemini-3.6-flash')).toBe(true);
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/catalog/gemini-catalog.test.ts --retry=0`  Expected: FAIL with `Failed to resolve import "./gemini-catalog.js"`
- [ ] **Step 3: Implement**
```ts
/* #3084 wave 2b — cached Gemini model catalog (spec §3, §6, §7).

   Feeds Auto max output tokens (outputTokenLimit) and the capacity
   descriptor's context/output limits. Wave 3's GET /api/analyzer/models reuses
   listGeminiModels.

   Filter (planning facts §C.3): models.list carries no output-modality field, so
   keep supportedActions ∋ generateContent and drop ids naming a non-text
   modality or product (embedding, -tts, -image, -live, imagen, veo, aqa).

   Caching: one listing per API key per GEMINI_CATALOG_TTL_MS, keyed by a
   SHA-256 of the key (the raw key is never stored here). Concurrent callers
   share one request. getCachedGeminiModelInfo stays SYNCHRONOUS so
   resolveCapacity / resolveGeminiMaxOutputTokens never await — the transport
   warms the cache (warmGeminiCatalog) before the runner reads its settings. It
   answers only for the key most recently listed or warmed, so a key change
   never reuses the previous key's limits, even while the new key's listing
   fails (N6).

   Bounded warm-up (P26): the warm-up runs before the limiter, ceiling and
   watchdog, so a listing is capped at GEMINI_CATALOG_WARM_TIMEOUT_MS (SDK
   httpOptions.timeout + abortSignal, and our own timer over the whole
   listing). A caller's signal releases that caller's wait at once. The shared
   listing is cancelled only when no caller still waits; a cancelled listing
   caches nothing and starts no back-off. A failed or timed-out listing leaves
   the cache as it was: callers fall back to today's values (12000-token cap,
   8192 output).

   Thinking (P27): geminiModelThinks is a static id rule and never reads the
   catalog, so request shape and the thinking window are stable per model. */
import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';

export interface GeminiModelInfo {
  id: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  thinking?: boolean;
}

export interface GeminiListedModel {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedActions?: string[];
  thinking?: boolean;
}

export type GeminiModelsClient = {
  models: {
    list: (params?: {
      config?: { httpOptions?: { timeout?: number }; abortSignal?: AbortSignal };
    }) => Promise<AsyncIterable<GeminiListedModel>>;
  };
};

export const GEMINI_CATALOG_TTL_MS = 10 * 60 * 1000;
export const GEMINI_CATALOG_WARM_TIMEOUT_MS = 10_000;
const FAILURE_BACKOFF_MS = 60 * 1000;
const EXCLUDED_ID = /embedding|-tts|-image|-live|imagen|veo|aqa/i;
const THINKING_ID_RULE = /^gemini-(?:2\.5-(?:pro|flash)(?!-lite)|[3-9])/;

interface CatalogState {
  keyHash: string;
  fetchedAt: number;
  models: GeminiModelInfo[];
}

/** One in-flight models.list, shared by every caller for the same key. */
interface SharedListing {
  keyHash: string;
  promise: Promise<GeminiModelInfo[]>;
  /** P26 — callers still waiting on it. */
  waiters: number;
  settled: boolean;
  /** P26 — abort the SDK request and reject `promise` with ListingAbandonedError. */
  cancel: () => void;
}

/** P26 — the listing was cancelled because no caller still waited: not a failure. */
class ListingAbandonedError extends Error {
  constructor() {
    super('models.list cancelled: no caller still waits');
    this.name = 'ListingAbandonedError';
  }
}

let state: CatalogState | null = null;
let inFlight: SharedListing | null = null;
let lastFailure: { keyHash: string; at: number } | null = null;
let warnedFailure = false;
/** N6 — the key most recently listed or warmed. getCachedGeminiModelInfo
    answers only for it. */
let activeKeyHash: string | null = null;

const hashKey = (apiKey: string): string => createHash('sha256').update(apiKey).digest('hex');

export function toGeminiModelInfo(m: GeminiListedModel): GeminiModelInfo | null {
  if (!m.name || !(m.supportedActions ?? []).includes('generateContent')) return null;
  const id = m.name.replace(/^models\//, '');
  if (EXCLUDED_ID.test(id)) return null;
  return {
    id,
    displayName: m.displayName,
    inputTokenLimit: m.inputTokenLimit,
    outputTokenLimit: m.outputTokenLimit,
    thinking: m.thinking,
  };
}

function freshListing(keyHash: string): GeminiModelInfo[] | null {
  return state && state.keyHash === keyHash && Date.now() - state.fetchedAt < GEMINI_CATALOG_TTL_MS
    ? state.models
    : null;
}

/** Join the in-flight listing for this key, or start one: bounded at
    GEMINI_CATALOG_WARM_TIMEOUT_MS, cancellable once abandoned (P26). */
function joinListing(
  apiKey: string,
  keyHash: string,
  opts: { refresh?: boolean; client?: GeminiModelsClient },
): SharedListing {
  if (!opts.refresh && inFlight && inFlight.keyHash === keyHash) return inFlight;

  const client = opts.client ?? (new GoogleGenAI({ apiKey }) as unknown as GeminiModelsClient);
  /* P26 — the SDK bounds each HTTP attempt (httpOptions.timeout, abortSignal);
     our own timer bounds the whole listing, pages included, and aborts the SDK
     signal when it fires. */
  const sdkAbort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: (err: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
    timer = setTimeout(() => {
      sdkAbort.abort();
      reject(new Error(`models.list did not finish within ${GEMINI_CATALOG_WARM_TIMEOUT_MS} ms`));
    }, GEMINI_CATALOG_WARM_TIMEOUT_MS);
  });
  const listing = (async () => {
    const pager = await client.models.list({
      config: { httpOptions: { timeout: GEMINI_CATALOG_WARM_TIMEOUT_MS }, abortSignal: sdkAbort.signal },
    });
    const models: GeminiModelInfo[] = [];
    for await (const listed of pager) {
      const info = toGeminiModelInfo(listed);
      if (info) models.push(info);
    }
    return models;
  })();
  /* A listing that settles after the deadline or a cancel already lost the
     race; its late rejection must not surface as an unhandled rejection. */
  listing.catch(() => undefined);

  let shared!: SharedListing;
  const promise = Promise.race([listing, stopped])
    .then((models) => {
      state = { keyHash, fetchedAt: Date.now(), models };
      lastFailure = null;
      /* N6 — a failure after this success warns again. */
      warnedFailure = false;
      return models;
    })
    .finally(() => {
      shared.settled = true;
      clearTimeout(timer);
      if (inFlight === shared) inFlight = null;
    });
  /* A cancelled listing may have no caller left to observe its rejection. */
  promise.catch(() => undefined);
  shared = {
    keyHash,
    promise,
    waiters: 0,
    settled: false,
    cancel: () => {
      sdkAbort.abort();
      stop(new ListingAbandonedError());
    },
  };
  inFlight = shared;
  return shared;
}

export async function listGeminiModels(
  apiKey: string,
  opts: { refresh?: boolean; client?: GeminiModelsClient } = {},
): Promise<GeminiModelInfo[]> {
  const keyHash = hashKey(apiKey);
  activeKeyHash = keyHash;
  const cached = opts.refresh ? null : freshListing(keyHash);
  if (cached) return cached;
  const shared = joinListing(apiKey, keyHash, opts);
  /* This caller has no signal, so it keeps the listing alive until it settles. */
  shared.waiters += 1;
  try {
    return await shared.promise;
  } finally {
    shared.waiters -= 1;
  }
}

export function getCachedGeminiModelInfo(model: string): GeminiModelInfo | undefined {
  /* N6 — only the active key's listing: a key change never reuses the previous
     key's limits. */
  if (!state || state.keyHash !== activeKeyHash) return undefined;
  return state.models.find((m) => m.id === model);
}

export async function warmGeminiCatalog(
  apiKey: string,
  opts: { client?: GeminiModelsClient; signal?: AbortSignal } = {},
): Promise<void> {
  if (opts.signal?.aborted) return;
  const keyHash = hashKey(apiKey);
  activeKeyHash = keyHash;
  if (freshListing(keyHash)) return;
  if (lastFailure && lastFailure.keyHash === keyHash && Date.now() - lastFailure.at < FAILURE_BACKOFF_MS) {
    return;
  }
  const shared = joinListing(apiKey, keyHash, { client: opts.client });
  shared.waiters += 1;
  let released = false;
  /* P26 — each caller releases its wait once; when no caller still waits, the
     shared listing is cancelled. */
  const release = () => {
    if (released) return;
    released = true;
    shared.waiters -= 1;
    if (shared.waiters === 0 && !shared.settled) shared.cancel();
  };
  const outcome = shared.promise.then(
    () => undefined,
    (err: unknown) => {
      /* P26 — cancelled because every caller left: not a failure, so no
         back-off and no warning. */
      if (err instanceof ListingAbandonedError) return;
      lastFailure = { keyHash, at: Date.now() };
      if (!warnedFailure) {
        warnedFailure = true;
        const message = ((err as Error)?.message ?? String(err)).split(apiKey).join('<redacted>');
        console.warn(
          `[gemini-catalog] models.list failed — using fallback limits (12000-token cap, 8192 output): ${message}`,
        );
      }
    },
  );
  const signal = opts.signal;
  if (!signal) {
    await outcome;
    release();
    return;
  }
  /* P26 — pause releases this caller's wait at once. */
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      release();
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void outcome.then(() => {
      signal.removeEventListener('abort', onAbort);
      release();
      resolve();
    });
  });
}

/** P27 — a static id rule, never the live catalog's `thinking` flag, so a
    model's request shape and thinking window never change between
    requests. Gemma is outside it. */
export function geminiModelThinks(model: string): boolean {
  return THINKING_ID_RULE.test(model);
}

export function _resetGeminiCatalogForTest(): void {
  state = null;
  inFlight = null;
  lastFailure = null;
  warnedFailure = false;
  activeKeyHash = null;
}

/** #3084 wave 2b, F7 — seeds the cache directly (no network, no mock client)
    so a test can make `getCachedGeminiModelInfo` answer for a known model
    without going through `listGeminiModels`. Used by Task 2.9a's guard test
    to force the CONDITIONAL `analyzer.gemini.maxOutputTokens` fix to actually
    appear (it only appears when the model's listed `outputTokenLimit` is
    known AND the configured value is below it). Mirrors the shape
    `listGeminiModels` itself writes at `:1498`/`:1530` above. */
export function _seedGeminiCatalogForTest(apiKey: string, models: GeminiModelInfo[]): void {
  const keyHash = hashKey(apiKey);
  state = { keyHash, fetchedAt: Date.now(), models };
  activeKeyHash = keyHash;
}
```
Test (append to `gemini-catalog.test.ts`):
```ts
describe('_seedGeminiCatalogForTest (#3084 wave 2b, F7)', () => {
  it('makes getCachedGeminiModelInfo answer synchronously, with no network call', () => {
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
    _seedGeminiCatalogForTest('test-key', [{ id: 'gemini-3.6-flash', outputTokenLimit: 65_536 }]);
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toEqual({ id: 'gemini-3.6-flash', outputTokenLimit: 65_536 });
  });

  it('a different key from listGeminiModels overwrites the seeded one, same as N6', async () => {
    _seedGeminiCatalogForTest('test-key', [{ id: 'gemini-3.6-flash', outputTokenLimit: 65_536 }]);
    await listGeminiModels('other-key', { client: fakeClient([]) }); // this file's existing client helper (`:1115`)
    expect(getCachedGeminiModelInfo('gemini-3.6-flash')).toBeUndefined();
  });
});
```
Mutation row (append to Task 2.5's Step 5): delete `activeKeyHash = keyHash;`
from `_seedGeminiCatalogForTest`. Expected red: `_seedGeminiCatalogForTest …
> makes getCachedGeminiModelInfo answer synchronously …` (`getCachedGeminiModelInfo`
reads `activeKeyHash`, still `null`, so it returns `undefined`). Restore it.
- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/catalog/gemini-catalog.test.ts`  Expected: PASS (18 tests). Then run `npm run check:cycles`: PASS.
- [ ] **Step 5: Mutation proof** (run each red with `--retry=0`)
  1. In `toGeminiModelInfo`, change `!(m.supportedActions ?? []).includes('generateContent')` to `false`. Expected red: `toGeminiModelInfo / listGeminiModels filter > keeps generateContent text models, strips models/, drops embedding/tts/image/live/aqa`. Restore it.
  2. Change `return THINKING_ID_RULE.test(model);` to `return getCachedGeminiModelInfo(model)?.thinking ?? THINKING_ID_RULE.test(model);`. Expected red: `geminiModelThinks (P27) > ignores the catalog thinking flag in both directions`. Restore it.
  3. In `listGeminiModels`, delete `httpOptions: { timeout: GEMINI_CATALOG_WARM_TIMEOUT_MS }, `. Expected red: `cache > asks the SDK to bound the request: httpOptions.timeout 10 s plus an abort signal (P26)`. Restore it.
  4. Replace `Promise.race([listing, stopped])` with `listing`. Expected red: `warmGeminiCatalog > a hung models.list() releases every waiting request after 10 s, …` (`expected 0 to be 2`) and `… the caller's abort signal releases its own wait at once; …` (`expected false to be true` for `other`). Restore it.
  5. In `warmGeminiCatalog`, delete `signal.addEventListener('abort', onAbort, { once: true });`. Expected red: `… the caller's abort signal releases its own wait at once; …` (`expected false to be true` for `paused`). Restore it.
  6. Delete `if (opts.signal?.aborted) return;`. Expected red: `… an already-aborted signal returns without listing`. Restore it.
  7. In `joinListing`'s success handler, delete `warnedFailure = false;`. Expected red: `warmGeminiCatalog > a successful listing re-arms the failure warning, so a later outage warns again (N6)` (`expected "spy" to be called 2 times, but got 1 times`). Restore it.
  8. In `getCachedGeminiModelInfo`, delete `if (!state || state.keyHash !== activeKeyHash) return undefined;` and change the next line to `return state?.models.find((m) => m.id === model);`. Expected red: `… after a key change the old key's cached limits are not served, even while the new key's listing fails (N6)`. Restore it.
  9. In `warmGeminiCatalog`'s `release`, delete `if (shared.waiters === 0 && !shared.settled) shared.cancel();`. Expected red: `… when every waiting caller has released, the shared listing is cancelled: …` (`sdkSignal.aborted` is `false`). Restore it.
  10. In `warmGeminiCatalog`'s rejection handler, delete `if (err instanceof ListingAbandonedError) return;`. Expected red: `… when every waiting caller has released, the shared listing is cancelled: …` (the cancel starts a back-off, so `models.list` is called 1 time, not 2). Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/catalog/gemini-catalog.ts server/src/analyzer/catalog/gemini-catalog.test.ts
git commit -m "feat(server): cache the Gemini model catalog with a bounded warm-up (#3084)"
```

**Tests this task could break:** none; the files are new.

### Task 2.6: Auto max output tokens and the TPM-bound input cap, warmed before each request

**Files:**
- Modify: `server/src/config/registry.ts:50-59` (the `analyzer.gemini.maxOutputTokens` knob) and `:70-79` (the `analyzer.gemini.maxInputTokensPerRequest` knob — lift `max` to `1_000_000` and extend `help` with the TPM bound, F1)
- Modify: `docs/wiki/Advanced-Settings.md` §1 — the "Gemini max output tokens" and "Gemini max input tokens per request" rows' default/range (F1, F3)
- Modify: `server/src/analyzer/rate-limit.ts` — export `resolveLimits` (`:95` on `origin/main` after #3163; `:76` on 46e62a34)
- Modify: `server/src/analyzer/capacity.ts` (the Gemini branch reads the catalog and the model's TPM; add `resolveGeminiMaxOutputTokens`)
- Modify: `server/src/analyzer/runner/transport.ts`: `ChatTransport` gains `prepare?(signal?: AbortSignal): Promise<void>` (the contract's `prepare?()` plus the caller's abort signal, P26).
- Modify: `server/src/analyzer/runner/stage-runner.ts`: the private `send(…)` (wave 1 Task 1.11) awaits `this.transport.prepare?.(call.signal)` before its settings read.
- Modify: `server/src/analyzer/transports/gemini-transport.ts`: keep the API key, add `prepare(signal)`, send `req.maxOutputTokens ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS`, delete the orphaned `DEFAULT_MAX_OUTPUT_TOKENS` / `resolveMaxOutputTokens`, fix the `MAX_RESPONSE_BYTES` comment.
- Modify: `server/src/analyzer/gemini.ts`: `GeminiAnalyzer`'s `settings` provider; drop the two deleted names from its re-export.
- Modify: `server/src/analyzer/ollama.ts`: `OllamaAnalyzer`'s `settings` provider.
- Modify: `server/.env.example:293` and `:301` (hand-written block outside the managed `BEGIN` marker at `:497`)
- Test (modify): `server/src/analyzer/capacity.test.ts`, `server/src/analyzer/runner/stage-runner.test.ts`, `server/src/analyzer/transports/gemini-transport.test.ts` (plus two bounded warm-up tests, P26), `server/src/analyzer/gemini.test.ts:55-74` and `:773-780`, `server/src/analyzer/ollama.test.ts`

`transports/ollama-transport.ts` needs no edit: wave 1 Task 1.8 already sends `num_predict: req.maxOutputTokens ?? resolveNumPredict()`.

**Wave 1's runner, as this task finds it** (Task 1.11). `StageRunner` has `readonly transport: ChatTransport`, `private readonly policy`, `private readonly settings: () => EngineRequestSettings` and `private readonly adaptSchema`. It reads settings in two places:
- `structuredOutput(key, grammarSchema)` is synchronous. `runStage` and `runSingleAttempt` call it before their first `send`, and it reads `this.settings().structuredOutput`;
- `send(system, messages, temperature, structuredOutput, call, withEvalTiming)` is `async`, runs once per request, and reads `this.settings().maxOutputTokens`.

Only `maxOutputTokens` depends on the catalog, so the warm-up goes into `send`, the async path every request already takes: `await this.transport.prepare?.(call.signal)`, then one `this.settings()` read. `structuredOutput()` stays synchronous, so its field must never depend on `prepare()`. The warm-up is bounded (Task 2.5, P26): it waits at most 10 s and returns at once when `call.signal` aborts, so a stalled listing never holds a request or a pause.

**Interfaces:**
- Consumes:
  - `getCachedGeminiModelInfo`, `warmGeminiCatalog` (bounded at 10 s, takes the caller's `signal`), `GeminiModelsClient` (Task 2.5);
  - `resolveNumPredict()` (`ollama-settings.ts`, wave 1 Task 1.8; `ollama.ts:289-294` on 46e62a34);
  - `resolveLimits(model: string): { rpm: number; tpm: number; rpd: number }` (`rate-limit.ts`, exported here);
  - `EngineRequestSettings.maxOutputTokens` and `TransportRequest.maxOutputTokens` (contract).
- Produces:
  - `export function resolveGeminiMaxOutputTokens(model: string): number` in `capacity.ts`;
  - `ChatTransport.prepare?(signal?: AbortSignal): Promise<void>` (the contract's `prepare?()` plus the caller's abort signal, P26);
  - `resolveCapacity({engine:'gemini'})` returns `contextTokens = inputTokenLimit ?? cap`, `maxOutputTokens = outputTokenLimit ?? 8192`, and `perRequestInputCap = min(cap, resolveLimits(model).tpm)`. Every built-in TPM is at least 16000 and the fallback is 100000, so at default settings `perRequestInputCap` stays 12000 and the pinning stays green.

**Semantics (spec §7):**
- **`0` (the new default).** Auto: the listed `outputTokenLimit`, else `8192`.
- **An explicit value** (env `ANALYZER_MAX_OUTPUT_TOKENS` or a Settings override) keeps its meaning, clamped to the listed limit when that is known.
- **Maximum.** Lifted to `1_048_576`, the largest listed Gemini context. The effective ceiling is the model's own limit, via the clamp.
- **Existing configurations.**
  - An env value of `0` used to be rejected (`< 256`, `resolver.ts:197`) and fell through to 8192; it now means Auto.
  - Values 1–255, which used to be rejected, are now accepted as written.
- **Ollama.** `analyzer.ollama.numPredict` is unchanged; the runner now carries its resolved value (`-1` = unlimited) in `TransportRequest.maxOutputTokens`.

**TPM bound (spec §6), a budget change this PR announces.** A model's TPM below the 12000 cap now shrinks the body budget to fit it. It is reachable from a `GEMINI_TPM_<SLUG>` env var or, since #3163, a saved `rate.tpm.gemma` / `rate.tpm.gemma26` override (`registry.ts:1027-1034`, `:1057-1064` on `origin/main`). Both resolve through `tpmLimit` (`rate-limit.ts:109-112` there), where `0` or `unlimited` means no gate (`Infinity`), which leaves the cap in charge. Task 2.10 announces it in both release-notes files.

- [ ] **Step 1: Write the failing test**

In `server/src/analyzer/capacity.test.ts`:
- **ENV list.** Add `'GEMINI_TPM_GEMMA_4_31B_IT'` to `ENV`.
- **Import.** Add `import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';`.
- **Replace** PR 2a's `a model TPM below the cap does NOT move the cap in this PR (the TPM bound is PR 2b's)` test with:
```ts
  it('a model TPM below the cap binds the per-request input cap (min, not the cap alone)', () => {
    process.env.GEMINI_TPM_GEMMA_4_31B_IT = '8000';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }).perRequestInputCap).toBe(8000);
  });

  it('an unlimited TPM (0) leaves the cap in charge', () => {
    process.env.GEMINI_TPM_GEMMA_4_31B_IT = '0';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }).perRequestInputCap).toBe(12000);
  });

  it('the TPM bound reaches the stage-1 body budget', () => {
    const body = 'a'.repeat(200_000);
    const atCap = resolveStage1ChunkCharBudget(resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }), body);
    process.env.GEMINI_TPM_GEMMA_4_31B_IT = '8000';
    const atTpm = resolveStage1ChunkCharBudget(resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }), body);
    expect(atTpm).toBeLessThan(atCap);
  });
```
- **Append** (merge into its import lines):
```ts
import { vi, beforeEach } from 'vitest';
import { resolveGeminiMaxOutputTokens } from './capacity.js';
import { listGeminiModels, _resetGeminiCatalogForTest, type GeminiModelsClient } from './catalog/gemini-catalog.js';
import { allKnobs } from '../config/registry.js';
import { coerceAndValidate } from '../config/resolver.js';

const catalogClient = (models: object[]): GeminiModelsClient =>
  ({
    models: {
      list: vi.fn(async () =>
        (async function* () {
          yield* models;
        })(),
      ),
    },
  }) as unknown as GeminiModelsClient;
const FLASH = { name: 'models/gemini-3.6-flash', supportedActions: ['generateContent'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, thinking: true };

describe('analyzer.gemini.maxOutputTokens knob (#3084 wave 2b)', () => {
  it('defaults to 0 = Auto, accepts 0, and lifts the max to 1048576', () => {
    const knob = allKnobs().find((k) => k.key === 'analyzer.gemini.maxOutputTokens')!;
    expect(knob).toMatchObject({ env: 'ANALYZER_MAX_OUTPUT_TOKENS', type: 'integer', min: 0, max: 1_048_576, default: 0 });
    expect(coerceAndValidate(knob, '0').ok).toBe(true);
    expect(coerceAndValidate(knob, '65536').ok).toBe(true);
  });
});

describe('analyzer.gemini.maxInputTokensPerRequest knob — max lifted for the TPM bound (#3084 wave 2b, F1)', () => {
  afterEach(() => {
    delete process.env.ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST;
  });

  it('keeps its 12000 default and 1000 minimum, but now accepts up to 1000000', () => {
    const knob = allKnobs().find((k) => k.key === 'analyzer.gemini.maxInputTokensPerRequest')!;
    expect(knob).toMatchObject({
      env: 'ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST',
      type: 'integer',
      min: 1000,
      max: 1_000_000,
      default: 12000,
    });
    expect(coerceAndValidate(knob, '1000000').ok).toBe(true);
    expect(coerceAndValidate(knob, '1000001').ok).toBe(false);
  });

  it('a saved value above the OLD 60000 ceiling is accepted, and is still bounded by the model TPM', () => {
    /* F1: lifting the registry max alone would let an operator size bodies
       past a model's real per-minute limit. This pins that the NEW ceiling
       cannot bypass the TPM bound Task 2.6 just added: a saved value of
       200000 on a model whose TPM is 16000 still yields the smaller cap. */
    process.env.ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST = '200000';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }).perRequestInputCap).toBe(16_000);
  });
});

describe('resolveGeminiMaxOutputTokens (#3084 wave 2b)', () => {
  beforeEach(() => {
    _resetGeminiCatalogForTest();
    delete process.env.ANALYZER_MAX_OUTPUT_TOKENS;
  });
  afterEach(() => {
    delete process.env.ANALYZER_MAX_OUTPUT_TOKENS;
  });

  it('Auto with no catalog entry → 8192', () => {
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(8192);
  });

  it('Auto → the listed outputTokenLimit', async () => {
    await listGeminiModels('k', { client: catalogClient([FLASH]) });
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(65_536);
  });

  it('an explicit value keeps its meaning', async () => {
    await listGeminiModels('k', { client: catalogClient([FLASH]) });
    process.env.ANALYZER_MAX_OUTPUT_TOKENS = '8192';
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(8192);
  });

  it('an explicit value above the listed limit is clamped to it', async () => {
    await listGeminiModels('k', { client: catalogClient([FLASH]) });
    process.env.ANALYZER_MAX_OUTPUT_TOKENS = '100000';
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(65_536);
  });

  it('an explicit value passes through when the limit is unknown', () => {
    process.env.ANALYZER_MAX_OUTPUT_TOKENS = '100000';
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(100_000);
  });

  it('resolveCapacity reports the listed limits but keeps sizing bodies to the request cap', async () => {
    await listGeminiModels('k', { client: catalogClient([FLASH]) });
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.6-flash' })).toEqual({
      family: 'requestCap',
      contextTokens: 1_048_576,
      maxOutputTokens: 65_536,
      perRequestInputCap: 12000,
    });
  });
});
```

In `server/src/analyzer/runner/stage-runner.test.ts` (wave 1 Task 1.11), add `'m_sr_prepare'` to `IDS` and append inside `describe('StageRunner (#3084 wave 1)', …)`:
```ts
  it('awaits transport.prepare(call.signal) before reading settings, on every send (#3084 wave 2b)', async () => {
    let warmed = false;
    const t = Object.assign(new FakeTransport(['{"a":1}', '{"a":"ok"}']), {
      prepare: vi.fn(async (_signal?: AbortSignal) => {
        await new Promise((r) => setTimeout(r, 5));
        warmed = true;
      }),
    });
    const runner = new StageRunner({
      transport: t,
      policy: GEMINI_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'json', maxOutputTokens: warmed ? 65_536 : 8192 }),
      adaptSchema: identitySchemaAdapter,
    });
    const controller = new AbortController();
    /* '{"a":1}' fails the z.string() schema, so the runner sends twice. */
    await expect(runner.runStage(spec('m_sr_prepare'), { signal: controller.signal })).resolves.toEqual({ a: 'ok' });
    expect(t.prepare).toHaveBeenCalledTimes(2);
    /* P26 — each warm-up gets the caller's signal, so pause can release it. */
    expect(t.prepare.mock.calls.map(([signal]) => signal)).toEqual([controller.signal, controller.signal]);
    expect(t.requests.map((r) => r.maxOutputTokens)).toEqual([65_536, 65_536]);
  });
```

In `server/src/analyzer/transports/gemini-transport.test.ts` (wave 1 Task 1.9):
- in `builds today's request: model turn mapping, verbatim system, json mime type, no thinkingConfig`, change `const { GeminiTransport, resolveMaxOutputTokens } = await import('./gemini-transport.js');` to `const { GeminiTransport } = await import('./gemini-transport.js');`, and change `expect(args.config.maxOutputTokens).toBe(resolveMaxOutputTokens());` to `expect(args.config.maxOutputTokens).toBe(8192); // no req.maxOutputTokens → GEMINI_FALLBACK_MAX_OUTPUT_TOKENS`;
- in the file's `afterEach`, add `vi.useRealTimers();` as its first statement;
- append the two tests below inside `describe('GeminiTransport (#3084 wave 1)', …)`. Each injects a client whose `list` never settles, like a stalled connection; `generateContentStream` is the file's mock and is not called.
```ts
  it('prepare(): a models.list() that never settles releases the request after 10 s, leaving Auto at the 8192 fallback (#3084 P26)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { GeminiTransport } = await import('./gemini-transport.js');
    const { _resetGeminiCatalogForTest } = await import('../catalog/gemini-catalog.js');
    const { resolveGeminiMaxOutputTokens } = await import('../capacity.js');
    _resetGeminiCatalogForTest();
    const list = vi.fn(() => new Promise<never>(() => {}));
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: { models: { generateContentStream, list } } as never });
    let released = false;
    void t.prepare().then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(8192);
  });

  it('prepare(signal): aborting (pause) releases the wait at once, and the SDK request carries the 10 s timeout and an abort signal (#3084 P26)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { GeminiTransport } = await import('./gemini-transport.js');
    const { _resetGeminiCatalogForTest } = await import('../catalog/gemini-catalog.js');
    _resetGeminiCatalogForTest();
    const list = vi.fn(() => new Promise<never>(() => {}));
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: { models: { generateContentStream, list } } as never });
    const controller = new AbortController();
    let released = false;
    void t.prepare(controller.signal).then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(released).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(true);
    expect(list).toHaveBeenCalledWith({ config: { httpOptions: { timeout: 10_000 }, abortSignal: expect.any(AbortSignal) } });
  });
```

In `server/src/analyzer/gemini.test.ts` (re-locate the mock block after wave 1; at 46e62a34 it is `:55-74`), replace lines 55-63 with:
```ts
const generateContentStream = vi.fn();
const listModels = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class {
      models = { generateContentStream, list: listModels };
    },
  };
});
```
and add to the `beforeEach` (`:65-74`), after `generateContentStream.mockReset();`:
```ts
  listModels.mockReset();
  listModels.mockRejectedValue(new Error('models.list is unavailable in tests'));
  const { _resetGeminiCatalogForTest } = await import('./catalog/gemini-catalog.js');
  _resetGeminiCatalogForTest();
```
Every Gemini test will now log one `[gemini-catalog] models.list failed` warning. Do not silence `console.warn` here: existing tests may spy on it.
Replace the test at `:773-780` (`sets an explicit maxOutputTokens on the request`) with:
```ts
  it('sends Auto max output tokens: 8192 while the model list is unavailable (#3084 wave 2b)', async () => {
    generateContentStream.mockResolvedValue(asyncFromArray([{ text: STAGE1_RESPONSE }]));
    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemma-4-31b-it' });
    await analyzer.runStage1('m_maxtok', '# stage 1 prompt', {});
    expect(generateContentStream.mock.calls[0][0].config.maxOutputTokens).toBe(8192);
  });

  it('sends Auto max output tokens = the listed outputTokenLimit — the catalog is warmed BEFORE the request is built', async () => {
    listModels.mockResolvedValue(
      asyncFromArray([
        { name: 'models/gemma-4-31b-it', supportedActions: ['generateContent'], inputTokenLimit: 131_072, outputTokenLimit: 32_768 },
      ]),
    );
    generateContentStream.mockResolvedValue(asyncFromArray([{ text: STAGE1_RESPONSE }]));
    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemma-4-31b-it' });
    await analyzer.runStage1('m_maxtok_auto', '# stage 1 prompt', {});
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(generateContentStream.mock.calls[0][0].config.maxOutputTokens).toBe(32_768);
  });
```
In that file's `afterAll` (`:805-827`) add:
```ts
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_maxtok_auto-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_maxtok_auto-stage1.json'), { force: true });
```

Append to `server/src/analyzer/ollama.test.ts`, which uses the file's existing `fetchMock`, `okResponse`, `ndjsonStream`, `chunksOf`, `VALID_RESPONSE` and `configValueMock`. If wave 1 moved the body-shape test at `:228-275`, place this block next to it.

This file mocks `configValue` for every test (`ollama.test.ts:177-203`). Its switch returns `-1` for `analyzer.ollama.numPredict` whatever the environment says, and `beforeEach` calls `configValueMock.mockReset()` (`:216`), which restores that switch before each test (`vi.fn(impl)` resets to `impl`: `resetToMockImplementation: true`, `server/node_modules/@vitest/spy/dist/index.js:185-188`, `:151-157`). So an `ANALYZER_NUM_PREDICT` env var would be ignored. The test sets the key on the mock itself, delegating every other key to the file's switch, and the next test's reset undoes it.
```ts
describe('OllamaAnalyzer — the runner-resolved output cap reaches the wire (#3084 wave 2b)', () => {
  afterAll(async () => {
    await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_ollama_num_predict-stage1-ch1.md'), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_ollama_num_predict-stage1-ch1.json'), { force: true });
  });

  it('sends options.num_predict from the settings provider (analyzer.ollama.numPredict = 4096)', async () => {
    const fileSwitch = configValueMock.getMockImplementation();
    expect(fileSwitch).toBeTypeOf('function'); // the reset at :216 restored the file-level switch
    configValueMock.mockImplementation((key: string) =>
      key === 'analyzer.ollama.numPredict' ? 4096 : fileSwitch!(key),
    );
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 64))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    await analyzer.runStage1Chapter('m_ollama_num_predict', 1, '# stage1 prompt', {});
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.options.num_predict).toBe(4096);
  });

  it('keeps -1 (predict until the context fills) by default', async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 64))));
    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    await analyzer.runStage1Chapter('m_ollama_num_predict', 1, '# stage1 prompt', {});
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.options.num_predict).toBe(-1);
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run:
```
npm --prefix server run test -- src/analyzer/capacity.test.ts src/analyzer/runner/stage-runner.test.ts src/analyzer/transports/gemini-transport.test.ts
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
```
Expected FAIL:
- `capacity.test.ts`: `resolveGeminiMaxOutputTokens is not a function`; `…knob > defaults to 0 = Auto…` (received `min: 256, max: 32768, default: 8192`); `a model TPM below the cap binds the per-request input cap` (received 12000) and `the TPM bound reaches the stage-1 body budget` (the two budgets are equal); `analyzer.gemini.maxInputTokensPerRequest knob … > keeps its 12000 default …` (received `max: 60000`) and `… > a saved value above the OLD 60000 ceiling is accepted …` (the env var falls back to the 12000 default since 200000 is out of today's range, so `perRequestInputCap` is 12000, not 16000);
- `stage-runner.test.ts`: `awaits transport.prepare(call.signal) before reading settings, on every send` (`prepare` called 0 times; `maxOutputTokens` `[8192, 8192]`);
- `gemini.test.ts`: `… the listed outputTokenLimit — the catalog is warmed BEFORE the request is built` (`listModels` called 0 times; `maxOutputTokens` 8192).
- `gemini-transport.test.ts`: both `prepare…` tests (`t.prepare is not a function`).

`ollama.test.ts`'s two new tests already pass: wave 1's transport falls back to `resolveNumPredict()`, which reads the same mocked key. Step 5 proves they pin the runner path.
- [ ] **Step 3: Implement**

`server/src/config/registry.ts:50-59`, replace the knob with:
```ts
  {
    key: 'analyzer.gemini.maxOutputTokens',
    env: 'ANALYZER_MAX_OUTPUT_TOKENS',
    group: 'analyzer-sampling',
    label: 'Gemini max output tokens',
    help: "Per-request output-token cap for Gemini, including the model's thinking tokens. 0 = Auto: the model's own output limit from Gemini's model list (8192 when the list is unavailable). A value above the model's limit is clamped to it; any other value is sent as set.",
    type: 'integer', min: 0, max: 1_048_576,
    default: 0, // ← 0 = Auto; resolved by resolveGeminiMaxOutputTokens() in analyzer/capacity.ts
    apply: 'live', risk: 'medium',
  },
```

`server/src/config/registry.ts:70-79` (F1) — lift the ceiling now that a request never sizes past the model's own TPM (Task 2.6's `perRequestInputCap = Math.min(cap, resolveLimits(sel.model).tpm)`, below). Replace the knob with:
```ts
  {
    key: 'analyzer.gemini.maxInputTokensPerRequest',
    env: 'ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST',
    group: 'analyzer-sampling',
    label: 'Gemini max input tokens per request',
    help: 'Per-request INPUT-token cap for cloud analyzer passes (stage-1, stage-2, script-review/emotion/instruct). Body chunks are sized to the smaller of this and the model TPM (Gemma free tier = 16000/min), so the system prompt + roster fit even when this is set higher than a given model allows. Raise it for a model with more headroom (Gemini 3.x accepts up to 1,000,000 input tokens). Feeds the request-cap family\'s body sizing in stage 1, stage 2 and the output-heavy passes (cloudBodyCharBudget), each bounded further by that pass\'s own char ceiling. Default 12000.',
    type: 'integer', min: 1000, max: 1_000_000,
    default: 12000,
    apply: 'live', risk: 'medium',
  },
```
This is the second edit to this knob's `help` in this wave: Task 2.3 (PR 2a) appended a shorter family-derivation clause without the TPM bound, since the bound does not exist until this task. The string above is the full, post-2.6 replacement — it supersedes 2a's wording rather than appending to it.

`server/src/analyzer/rate-limit.ts`: change `function resolveLimits(model: string): ModelLimits {` (`:95` on `origin/main`) to `export function resolveLimits(model: string): ModelLimits {`. If a later `main` has renamed or re-signatured it, export that resolver, use its name below, and record the name in the PR body.

`server/src/analyzer/capacity.ts`: add `import { resolveLimits } from './rate-limit.js';` and `import { getCachedGeminiModelInfo } from './catalog/gemini-catalog.js';` (`rate-limit.ts` imports only `errors.ts` and the config modules, so no cycle). Replace the Gemini return in `resolveCapacity` with the block below, and append the function after it:
```ts
  const cap = resolveMaxInputTokensPerRequest();
  const listed = getCachedGeminiModelInfo(sel.model);
  return {
    family: 'requestCap',
    contextTokens: listed?.inputTokenLimit ?? cap,
    maxOutputTokens: listed?.outputTokenLimit ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,
    /* #3084 wave 2b (spec §6) — size the request to the smaller of the registry
       cap and the model's per-minute token limit, so one request never exceeds
       a TPM an operator lowered (env GEMINI_TPM_<SLUG> or a saved rate.tpm.*
       override). tpm is Infinity for "unlimited", which leaves the cap. */
    perRequestInputCap: Math.min(cap, resolveLimits(sel.model).tpm),
  };
}

/** The maxOutputTokens a Gemini request sends (spec §7). 0 (the default) is
    Auto: the model's listed outputTokenLimit, else 8192. An explicit value keeps
    its meaning, clamped to the listed limit when known. Synchronous — the
    transport's prepare() warms the catalog before the runner reads settings. */
export function resolveGeminiMaxOutputTokens(model: string): number {
  const limit = getCachedGeminiModelInfo(model)?.outputTokenLimit;
  const configured = configValue<number>('analyzer.gemini.maxOutputTokens');
  if (configured === 0) return limit ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS;
  return limit !== undefined ? Math.min(configured, limit) : configured;
}
```
In the same file's header, replace the two lines `perRequestInputCap is analyzer.gemini.maxInputTokensPerRequest` / `alone here; PR 2b bounds it by the model's TPM.` with `perRequestInputCap = min(analyzer.gemini.maxInputTokensPerRequest,` / `model TPM) (#3084 wave 2b).`, and the sentence `Endpoints (context family + optional cap) arrive in wave 3.` with `Gemini's context/output limits come from the cached model list (catalog/gemini-catalog.ts); endpoints (context family + optional cap) arrive in wave 3.`

`server/src/analyzer/runner/transport.ts`: in `interface ChatTransport`, after `send(req: TransportRequest): Promise<TransportResult>;`, add:
```ts
  /** Optional async warm-up the runner awaits before reading EngineRequestSettings
      on every request — keeps settings resolution synchronous (e.g. the Gemini
      model catalog behind Auto max output tokens). Must never reject, must be
      bounded, and must return promptly when `signal` aborts (P26). */
  prepare?(signal?: AbortSignal): Promise<void>;
```

`server/src/analyzer/runner/stage-runner.ts`, in `private async send(…)`: insert directly above `const result = await this.transport.send({`:
```ts
    /* #3084 wave 2b — warm whatever settings resolution reads synchronously
       (the Gemini model catalog behind Auto max output tokens) BEFORE reading
       settings, on every request. The caller's signal lets pause release a
       warm-up (P26). structuredOutput() reads settings().structuredOutput
       before the first send without this await, so that field must never
       depend on prepare(). */
    await this.transport.prepare?.(call.signal);
    const settings = this.settings();
```
and in the same call change `maxOutputTokens: this.settings().maxOutputTokens,` to `maxOutputTokens: settings.maxOutputTokens,`. `structuredOutput()` is not edited.

`server/src/analyzer/transports/gemini-transport.ts`:
- **Imports.** Add `import { warmGeminiCatalog, type GeminiModelsClient } from '../catalog/gemini-catalog.js';` and `import { GEMINI_FALLBACK_MAX_OUTPUT_TOKENS } from '../capacity.js';`.
- **Constructor.** Wave 1's constructor does not keep the key. Add `private readonly apiKey: string;` beside `private readonly client: GoogleGenAI;`, and `this.apiKey = opts.apiKey;` after `this.model = opts.model;`.
- **`prepare(signal)`.** Add after the constructor:
```ts
  /** #3084 wave 2b — warm the model catalog (Auto max output tokens) before the
      runner reads settings. warmGeminiCatalog never rejects, waits at most
      10 s, and returns at once when `signal` aborts (P26). */
  prepare(signal?: AbortSignal): Promise<void> {
    return warmGeminiCatalog(this.apiKey, { client: this.client as unknown as GeminiModelsClient, signal });
  }
```
- **`config` literal.** In `generate(req)`'s `config: { … }` (wave 1 Task 1.9), change `maxOutputTokens: req.maxOutputTokens ?? resolveMaxOutputTokens(),` to `maxOutputTokens: req.maxOutputTokens ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,`.
- **Orphans.** Delete `DEFAULT_MAX_OUTPUT_TOKENS`, `resolveMaxOutputTokens` and their `#528` comment block (moved here verbatim from `gemini.ts:80-91` by wave 1).
- **Comment.** In the `MAX_RESPONSE_BYTES` comment (moved from `gemini.ts:62-64`), change ``The runtime `resolveMaxOutputTokens` cap is NOT visible to static analysis.`` to ``The runtime max-output cap (`resolveGeminiMaxOutputTokens`, analyzer/capacity.ts) is NOT visible to static analysis.``

`server/src/analyzer/gemini.ts`:
- **Re-export.** Remove `DEFAULT_MAX_OUTPUT_TOKENS,` and `resolveMaxOutputTokens,` from `export { … } from './transports/gemini-transport.js';`. Then `git grep -n "resolveMaxOutputTokens\|DEFAULT_MAX_OUTPUT_TOKENS" server/src` must print nothing.
- **Settings provider.** Delete wave 1's `const GEMINI_W1_SETTINGS: EngineRequestSettings = { structuredOutput: 'json', maxOutputTokens: undefined };` and its comment, and change `settings: () => GEMINI_W1_SETTINGS,` to:
```ts
        /* Structured output stays 'json' (wave 3 resolves it from
           analyzer.gemini.structuredOutput). maxOutputTokens reads the catalog
           the transport's prepare() warmed. */
        settings: () => ({ structuredOutput: 'json', maxOutputTokens: resolveGeminiMaxOutputTokens(opts.model) }),
```
  Import `resolveGeminiMaxOutputTokens` from `./capacity.js`; delete the `EngineRequestSettings` import if `npm run typecheck` reports it unused.

`server/src/analyzer/ollama.ts`: delete wave 1's `const OLLAMA_W1_SETTINGS: EngineRequestSettings = { structuredOutput: 'schema', maxOutputTokens: undefined };` and its comment, and change `settings: () => OLLAMA_W1_SETTINGS,` to:
```ts
        /* Structured output stays 'schema' (wave 3 resolves it from
           analyzer.ollama.structuredOutput); the output cap is num_predict,
           resolved per request. */
        settings: () => ({ structuredOutput: 'schema', maxOutputTokens: resolveNumPredict() }),
```
Import `resolveNumPredict` from `./ollama-settings.js` (merge it into that import if one exists); delete the `EngineRequestSettings` import if `npm run typecheck` reports it unused.

`server/.env.example:293`:
```
#       ANALYZER_MAX_OUTPUT_TOKENS  Gemini maxOutputTokens (default 0 = Auto: the model's own limit, 8192 if unknown)
```
and `:301`:
```
# ANALYZER_MAX_OUTPUT_TOKENS=0
```
The managed block line (`:507`) is regenerated in Task 2.10 by `npm run config:sync`.

`docs/wiki/Advanced-Settings.md` §1 (F1, F3) — same commit: update the "Gemini
max output tokens" row's Default/Range to `0` / `0–1048576`, and the "Gemini
max input tokens per request" row's Default/Range to `12000` / `1000–1000000`.
`scripts/tests/knob-docs-sync.test.mjs` (#2012, run by `npm run test:hooks`)
fails if either knob's `label` has no row here; both already have rows, so
this is a content update, not a new row, and the guard stays green either way
— run it in Step 4 to confirm.
- [ ] **Step 4: Run and confirm it passes**
Run:
```
npm --prefix server run test -- src/analyzer/capacity.test.ts src/analyzer/capacity-pinning.test.ts src/analyzer/stage1-chunk.test.ts src/analyzer/output-heavy-tpm.test.ts src/analyzer/rate-limit.test.ts src/analyzer/ollama.test.ts src/analyzer/catalog src/analyzer/runner src/analyzer/transports src/config
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
npm run typecheck
npm run check:cycles
node scripts/tests/knob-docs-sync.test.mjs
```
Expected: PASS. `src/config` covers `env-cleanup.test.ts`, whose "realistic .env" test derives candidates from registry defaults (`env-cleanup.test.ts:389-402`), so `ANALYZER_MAX_OUTPUT_TOKENS=8192` simply stops being a candidate. `knob-docs-sync.test.mjs` (#2012) confirms both touched Gemini knobs still have rows in `docs/wiki/Advanced-Settings.md` after this task's edits.
- [ ] **Step 5: Mutation proof**
  1. In `stage-runner.ts`'s `send`, delete `await this.transport.prepare?.(call.signal);`. Expected red: `StageRunner (#3084 wave 1) > awaits transport.prepare(call.signal) before reading settings, on every send (#3084 wave 2b)` and slow `… the catalog is warmed BEFORE the request is built` (`listModels` called 0 times). Restore it.
  2. Move `const settings = this.settings();` above the `prepare` line. Expected red: `… awaits transport.prepare(call.signal) before reading settings, on every send` (`maxOutputTokens` `[8192, 65536]`: each request reads the value from before its own warm-up). Restore it.
  3. In `capacity.ts`, change `return limit !== undefined ? Math.min(configured, limit) : configured;` to `return configured;`. Expected red: `resolveGeminiMaxOutputTokens > an explicit value above the listed limit is clamped to it`. Restore it.
  4. In `capacity.ts`, change `perRequestInputCap: Math.min(cap, resolveLimits(sel.model).tpm),` to `perRequestInputCap: cap,`. Expected red: `resolveCapacity — Gemini > a model TPM below the cap binds the per-request input cap (min, not the cap alone)` and `… > the TPM bound reaches the stage-1 body budget`. Restore it.
  5. In `ollama.ts`'s settings provider, set `maxOutputTokens: 123,`. Expected red: `OllamaAnalyzer — the runner-resolved output cap reaches the wire > sends options.num_predict from the settings provider (analyzer.ollama.numPredict = 4096)`. Restore it.
  6. In `stage-runner.ts`, change `prepare?.(call.signal)` to `prepare?.()`. Expected red: `… awaits transport.prepare(call.signal) before reading settings, on every send` (the recorded signals are `[undefined, undefined]`). Restore it.
  7. In `gemini-transport.ts`'s `prepare`, remove `signal` from the `warmGeminiCatalog` options. Expected red: `GeminiTransport (#3084 wave 1) > prepare(signal): aborting (pause) releases the wait at once, …` (`expected false to be true`). Restore it.
  8. In `registry.ts`, change the `analyzer.gemini.maxInputTokensPerRequest` knob's `max: 1_000_000` back to `max: 60_000`. Expected red: `analyzer.gemini.maxInputTokensPerRequest knob … > keeps its 12000 default … but now accepts up to 1000000` (`coerceAndValidate(knob, '1000000').ok` is `false`) and `… > a saved value above the OLD 60000 ceiling is accepted …` (the env override is refused again, so `perRequestInputCap` reads 12000, not 16000). Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/config/registry.ts server/src/analyzer/rate-limit.ts server/src/analyzer/capacity.ts server/src/analyzer/capacity.test.ts server/src/analyzer/runner/transport.ts server/src/analyzer/runner/stage-runner.ts server/src/analyzer/runner/stage-runner.test.ts server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/gemini-transport.test.ts server/src/analyzer/gemini.ts server/src/analyzer/ollama.ts server/src/analyzer/gemini.test.ts server/src/analyzer/ollama.test.ts server/.env.example docs/wiki/Advanced-Settings.md
git commit -m "feat(server): Gemini max output tokens default to Auto; input cap bounded by model TPM (#3084)"
```

**Tests this task could break:**
- `gemini.test.ts` (slow; every test now warms a catalog that fails once);
- `ollama.test.ts` and `ollama-timeout.test.ts`;
- wave 1's runner, transport and characterisation suites (`src/analyzer/runner`, `src/analyzer/transports`), including any fake `ChatTransport` without `prepare`, which the optional call tolerates;
- `rate-limit.test.ts` (export only) and `output-heavy-tpm.test.ts` (Gemma: `min(12000, 16000)` = 12000, unchanged);
- `src/config/*` (knob bounds, `env-example.test.ts`, `env-cleanup.test.ts`, and after #3146 `registry-knob-read.guard.test.ts`);
- `capacity-pinning.test.ts`.
- wave 1's `transports/gemini-transport.test.ts`: two tests appended and `vi.useRealTimers()` added to its `afterEach`; its existing tests call `send` directly, which never calls `prepare`.

### Task 2.7: Gemini thought summaries — `includeThoughts`, reasoning tokens, heartbeat

**Files:**
- Modify: `server/src/analyzer/transports/gemini-transport.ts`. The streaming method moved from `gemini.ts:678-866`: request `config` at today's `:728-734`, usage tracking at `:739-767`, and the text-less chunk skip at `:772`.
- Test: `server/src/analyzer/transports/gemini-transport-thinking.test.ts` (new)

**Interfaces:**
- Consumes:
  - `geminiModelThinks(model)` (Task 2.5: the static id rule, P27);
  - `listGeminiModels` and `_resetGeminiCatalogForTest` (Task 2.5), only to prove the catalog's `thinking` flag is ignored;
  - `GeminiTransport` constructor `{ apiKey, model, client? }` and `send(req: TransportRequest): Promise<TransportResult>` (contract);
  - `ThinkingConfig.includeThoughts` (`genai.d.ts:14398`) and `usageMetadata.thoughtsTokenCount` (`genai.d.ts:5917`).
- Produces:
  - Gemini requests carry `config.thinkingConfig = { includeThoughts: true }` exactly when `geminiModelThinks(this.model)` is true. The rule is static, so a model's request shape never changes between requests (P27). Gemma is outside it and never gets `includeThoughts` here; wave 5 adds it when a reasoning level turns Gemma's thinking on (P19). This key is transport-owned (decision 9); wave 5 adds `thinkingLevel` beside it (`thinkingBudget` is retired, F2).
  - `TransportResult.usage.reasoningTokens` = the last `thoughtsTokenCount` seen, **only on a request that asked for `includeThoughts`**; `undefined` otherwise.
  - Every chunk that carries thought parts but no answer text fires `call.onChunk` with `receivedBytes` / `receivedText` unchanged (P4), so the route heartbeat (`routes/analysis.ts:1184` `SILENCE_THRESHOLD_MS` warning at `:4417-4423`) sees activity during thinking.
  - Wave 1 already keeps thought text out of `text` and sets `reasoningSeen` (contract); this task pins both.

**Reasoning evidence for Gemini (P27).** `hasReasoningEvidence` (Task 2.9) stays engine-independent: `usage.reasoningTokens > 0`, or `reasoningSeen`. This transport decides what reaches `usage.reasoningTokens`:
- `reasoningSeen` (a thought part arrived) always counts;
- `thoughtsTokenCount` is reported as `reasoningTokens` only when the request asked for `includeThoughts`.

A Gemma response that reports `thoughtsTokenCount` without any thought part therefore carries no reasoning evidence. Its empty `MAX_TOKENS` keeps the #528 split recovery (`gemini.ts:784-804`) instead of stopping the run. Whether Gemma reports that count at all is unconfirmed (planning facts §C.2); register row `E<next+1>` (Task 2.10) checks on a real chapter that the Gemma split still recovers.

**Wave 1 compatibility (A5).** Wave 1's `gemini-transport.test.ts` test `thought parts set reasoningSeen, keep the idle watchdog alive, and never enter text` (Task 1.9) makes no `onChunk` assertion, so this task's heartbeat call leaves it green. The `onChunk` behaviour for thought-only chunks is pinned here, by `thought-only chunks feed the heartbeat with the answer byte count unchanged (P4)`.

- [ ] **Step 1: Write the failing test**
```ts
/* #3084 wave 2b — Gemini thinking visibility (spec §7). Drives GeminiTransport
   with an injected fake client (no vi.mock, no network). Chunks mirror the SDK:
   `text` is the concatenation of NON-thought text parts (the @google/genai
   GenerateContentResponse.text getter excludes thought parts), and the parts
   themselves carry `thought: true`. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GoogleGenAI } from '@google/genai';
import { GeminiTransport } from './gemini-transport.js';
import { geminiRateLimiter } from '../rate-limit.js';
import { listGeminiModels, _resetGeminiCatalogForTest, type GeminiModelsClient } from '../catalog/gemini-catalog.js';
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
async function* streamOf(items: unknown[], gapMs = 0, firstDelayMs = 0): AsyncGenerator<unknown> {
  if (firstDelayMs > 0) await new Promise((r) => setTimeout(r, firstDelayMs));
  for (const [i, item] of items.entries()) {
    if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    yield item;
  }
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

beforeEach(() => {
  geminiRateLimiter._reset();
  _resetGeminiCatalogForTest();
});
afterEach(() => {
  delete process.env.GEMINI_STREAM_IDLE_MS;
});

describe('GeminiTransport — thought summaries (#3084 wave 2b)', () => {
  it('asks a thinking model for thought summaries', async () => {
    const gen = vi.fn().mockResolvedValue(streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })]));
    await new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen) }).send(request());
    expect(gen.mock.calls[0][0].config.thinkingConfig).toEqual({ includeThoughts: true });
  });

  it('does not send thinkingConfig to a model that does not think (Gemma)', async () => {
    const gen = vi.fn().mockResolvedValue(streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })]));
    await new GeminiTransport({ apiKey: 'test-key', model: 'gemma-4-31b-it', client: clientWith(gen) }).send(request());
    expect(gen.mock.calls[0][0].config.thinkingConfig).toBeUndefined();
  });

  it('ignores the catalog thinking flag: a Gemma model listed as thinking still gets no thinkingConfig (P27)', async () => {
    const catalog = {
      models: {
        list: vi.fn(async () =>
          (async function* () {
            yield { name: 'models/gemma-4-31b-it', supportedActions: ['generateContent'], thinking: true };
          })(),
        ),
      },
    } as unknown as GeminiModelsClient;
    await listGeminiModels('test-key', { client: catalog });
    const gen = vi.fn().mockResolvedValue(streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })]));
    await new GeminiTransport({ apiKey: 'test-key', model: 'gemma-4-31b-it', client: clientWith(gen) }).send(request());
    expect(gen.mock.calls[0][0].config.thinkingConfig).toBeUndefined();
  });

  it('keeps thought text out of the answer, flags reasoning, and reports thoughtsTokenCount as reasoningTokens', async () => {
    const gen = vi.fn().mockResolvedValue(
      streamOf([
        chunk([{ thought: true, text: 'Let me consider the speakers…' }]),
        chunk([{ thought: true, text: 'Narrator opens the scene.' }]),
        chunk([{ text: ANSWER }], { finishReason: 'STOP', thoughtsTokenCount: 1234 }),
      ]),
    );
    const result = await new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen) }).send(request());
    expect(result.text).toBe(ANSWER);
    expect(result.reasoningSeen).toBe(true);
    expect(result.finish).toBe('stop');
    expect(result.usage?.reasoningTokens).toBe(1234);
  });

  it('a model that does not think reports no reasoningTokens, even when the response carries thoughtsTokenCount (P27)', async () => {
    const gen = vi.fn().mockResolvedValue(
      streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP', thoughtsTokenCount: 50 })]),
    );
    const result = await new GeminiTransport({ apiKey: 'test-key', model: 'gemma-4-31b-it', client: clientWith(gen) }).send(request());
    expect(result.reasoningSeen).toBe(false);
    expect(result.usage?.reasoningTokens).toBeUndefined();
  });

  it('thought-only chunks feed the heartbeat with the answer byte count unchanged (P4)', async () => {
    const onChunk = vi.fn();
    const gen = vi.fn().mockResolvedValue(
      streamOf([
        chunk([{ thought: true, text: 'thinking' }]),
        chunk([{ thought: true, text: 'still thinking' }]),
        chunk([{ text: ANSWER }], { finishReason: 'STOP' }),
      ]),
    );
    await new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen) }).send(
      request({ call: { onChunk } }),
    );
    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onChunk.mock.calls[0][0]).toMatchObject({ receivedBytes: 0, receivedText: '' });
    expect(onChunk.mock.calls[1][0]).toMatchObject({ receivedBytes: 0, receivedText: '' });
    expect(onChunk.mock.calls[2][0]).toMatchObject({ receivedBytes: ANSWER.length, receivedText: ANSWER });
  });
});
```
Task 2.8 appends a `describe` to this same file and reuses `chunk`, `streamOf`, `clientWith`, `request` and `ANSWER` from it.
- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/transports/gemini-transport-thinking.test.ts --retry=0`
Expected FAIL:
- `asks a thinking model for thought summaries` (received `undefined`);
- `… reports thoughtsTokenCount as reasoningTokens` (received `undefined`);
- `thought-only chunks feed the heartbeat with the answer byte count unchanged (P4)` (called 1 time).

`does not send thinkingConfig to a model that does not think (Gemma)`, `ignores the catalog thinking flag …` and `a model that does not think reports no reasoningTokens …` already pass on wave 1's code, which sends no `thinkingConfig` and reports no reasoning tokens; Step 5 proves each can fail. `keeps thought text out of the answer` may partly pass on wave 1's code.
- [ ] **Step 3: Implement**

In `gemini-transport.ts`, add `import { geminiModelThinks } from '../catalog/gemini-catalog.js';`, then make four edits. The names are today's `gemini.ts` locals, which wave 1 moved verbatim. If wave 1 renamed one, apply the same edit to its renamed counterpart.

1. In `generate(req)`, before the `try` (next to `const watchdog = new AbortController();`), add:
```ts
    /* #3084 P27 — decided once per request from the static id rule, never the
       live catalog, so a model's request shape and its reasoning evidence never
       change between requests. */
    const includeThoughts = geminiModelThinks(this.model);
```
   and in the request `config` object, after `temperature`, add:
```ts
          ...(includeThoughts ? { thinkingConfig: { includeThoughts: true } } : {}),
```
2. Usage:
   - In the chunk type cast (today `:751-756`), make `usageMetadata` read `{ promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }`, and make `candidates` read `Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>`.
   - Beside `let candidatesTokenCount: number | undefined;` (today `:740`), add `let thoughtsTokenCount: number | undefined;`.
   - After the `candidatesTokenCount` read (today `:765-767`), add:
```ts
        if (usage?.thoughtsTokenCount && Number.isFinite(usage.thoughtsTokenCount)) {
          thoughtsTokenCount = usage.thoughtsTokenCount;
        }
```
3. Replace wave 1's `const usage = { inputTokens: promptTokenCount, outputTokens: candidatesTokenCount };` (Task 1.9, added before today's `:783`) with:
```ts
      /* #3084 P27 — a thoughtsTokenCount is reasoning evidence only on a request
         that asked for thoughts. Gemma asks for none, so its empty MAX_TOKENS
         keeps the #528 split recovery even if the response reports a count. */
      const usage = {
        inputTokens: promptTokenCount,
        outputTokens: candidatesTokenCount,
        reasoningTokens: includeThoughts ? thoughtsTokenCount : undefined,
      };
```
4. Replace the text-less chunk skip (today `if (!text) continue;` at `:772`) with:
```ts
        if (!text) {
          /* #3084 wave 2b (P4) — a thought-only chunk (includeThoughts) is proof
             the model is alive: feed the route heartbeat with the answer buffer
             unchanged, so a long think does not read as a silent stream. The
             idle watchdog was already re-armed for this chunk above. */
          const chunkHadThought = (chunk.candidates?.[0]?.content?.parts ?? []).some((p) => p.thought === true);
          if (chunkHadThought) {
            const now = Date.now();
            onChunk?.({
              receivedBytes: buf.length,
              receivedText: buf,
              sinceLastChunkMs: now - lastChunkAt,
              elapsedMs: now - start,
            });
            lastChunkAt = now;
          }
          continue;
        }
```
- [ ] **Step 4: Run and confirm it passes**
Run:
```
npm --prefix server run test -- src/analyzer/transports/gemini-transport-thinking.test.ts src/analyzer/transports src/analyzer/runner
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
```
Expected: PASS: 6 tests in `gemini-transport-thinking.test.ts`, and every wave 1 suite under `src/analyzer/transports` and `src/analyzer/runner`. That includes `gemini-transport.test.ts`'s `thought parts set reasoningSeen, keep the idle watchdog alive, and never enter text`, which makes no `onChunk` assertion since its Task 1.9 retitle (A5), so the heartbeat call for its four thought-only chunks cannot turn it red.
- [ ] **Step 5: Mutation proof** (run each red with `--retry=0`)
  1. Replace `const includeThoughts = geminiModelThinks(this.model);` with `const includeThoughts = false;`. Expected red: `GeminiTransport — thought summaries (#3084 wave 2b) > asks a thinking model for thought summaries` and `… > keeps thought text out of the answer, flags reasoning, and reports thoughtsTokenCount as reasoningTokens`. Restore it.
  2. Replace `reasoningTokens: includeThoughts ? thoughtsTokenCount : undefined,` with `reasoningTokens: thoughtsTokenCount,`. Expected red: `… > a model that does not think reports no reasoningTokens, even when the response carries thoughtsTokenCount (P27)`. Restore it.
  3. Delete the `onChunk?.({…})` call inside `if (chunkHadThought)`. Expected red: `… > thought-only chunks feed the heartbeat with the answer byte count unchanged (P4)`. Restore it.
  4. In `catalog/gemini-catalog.ts` (Task 2.5), change `return THINKING_ID_RULE.test(model);` to `return getCachedGeminiModelInfo(model)?.thinking ?? THINKING_ID_RULE.test(model);`. Expected red: `… > ignores the catalog thinking flag: a Gemma model listed as thinking still gets no thinkingConfig (P27)`. Restore it.
  5. Replace `...(includeThoughts ? { thinkingConfig: { includeThoughts: true } } : {}),` with `thinkingConfig: { includeThoughts: true },`. Expected red: `… > does not send thinkingConfig to a model that does not think (Gemma)`. Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/gemini-transport-thinking.test.ts
git commit -m "feat(server): request Gemini thought summaries from thinking models (#3084)"
```

**Tests this task could break:**
- `gemini.test.ts` (slow): the `onChunk` count tests at `:83-117`. Their mock chunks carry no `candidates[].content.parts`, so `chunkHadThought` is false and the counts are unchanged;
- wave 1's `src/analyzer/transports` and `src/analyzer/runner` suites, including `gemini-transport.test.ts`'s thought-parts test (no `onChunk` assertion, per A5).

---

### Task 2.8: A thinking window and a request ceiling for every Gemini request; one timing line per attempt

**Files:**
- Modify: `server/src/analyzer/errors.ts` (append `AnalyzerTimeoutError`, contract shape plus the `'thinking-idle'` reason)
- Modify: `server/src/config/registry.ts`: add `analyzer.gemini.thinkingIdleTimeoutMs` and `analyzer.gemini.requestCeilingMs` after the `analyzer.gemini.maxInputTokensPerRequest` knob (`:70-79` on 46e62a34).
- Modify: `server/src/analyzer/transports/gemini-transport.ts`:
  - `GEMINI_THINKING_IDLE_TIMEOUT_MS`, `resolveGeminiThinkingIdleTimeoutMs(model)` and the private `geminiThinkingWindowApplies(model)`;
  - `GEMINI_RETRY_CLASSIFIER` (wave 1 Task 1.9): `AnalyzerTimeoutError` → `no-retry`;
  - constructor option `requestCeilingMs?: number` (contract);
  - in `generate(req)` (wave 1 Task 1.9; body moved from `gemini.ts:684-866`): the ceiling signal, the thinking-window arms, the answer-start re-arm, the timeout classification, and the per-attempt timing line.
- Modify: `server/.env.example`: the hand-written large-chapter block Task 2.6 edited (`:285-303` on 46e62a34)
- Modify: `docs/wiki/Advanced-Settings.md` §1 — two new rows, "Gemini thinking idle timeout (ms)" and "Gemini request ceiling (ms)" (F1, F3). These are NEW knob labels, so `scripts/tests/knob-docs-sync.test.mjs` (#2012, run by `npm run test:hooks`) fails without them — name it in Step 4.
- Modify: `server/src/routes/failure-taxonomy.ts:29-52` (union), `:98-140` (signature row), `:492-534` (classify branch)
- Modify: `server/src/routes/failure-remediations.ts:94-101` (add an entry after `analyzer-truncated`)
- Modify: `openapi.yaml:7049` (enum), and regenerate `src/lib/api-types.ts`.
- Modify: `src/data/help-failures.ts:28-55` (`CATEGORIES`), `:57-81` (`TITLES`)
- Test (modify): `server/src/analyzer/transports/gemini-transport-thinking.test.ts`; `server/src/analyzer/gemini.test.ts` (the `stream watchdog + abort` describe, `:618-705`, and the top-level `afterAll`); `server/src/routes/failure-taxonomy.test.ts:399-428` and new tests; `src/data/help-failures.test.ts:13` (23 → 24); `src/data/help-categories.test.ts:24` (49 → 50).

**Interfaces:**
- Consumes:
  - `geminiModelThinks(model)` (Task 2.5, the static id rule, P27);
  - `resolveStreamIdleTimeoutMs(): number` and `GeminiStreamIdleError(model, idleMs)` (`transports/gemini-transport.ts`, wave 1 Task 1.9; `gemini.ts:73-78`, `:118-127` on 46e62a34);
  - `GEMINI_RETRY_CLASSIFIER` (wave 1 Task 1.9: `GeminiStreamIdleError` → `idle`; anything without a status → `no-retry`);
  - `withTransportRetry` (wave 1 Task 1.9): an `idle` disposition logs `[gemini] stream idle … — retrying in …` and announces a backoff over 1 s through `onThrottle(…, 'retry-after')`; a `no-retry` disposition rethrows at once and does neither;
  - `TransportKind` (`errors.ts`, wave 1), `configValue`, `coerceAndValidate` (`config/resolver.ts:183`), `withCopy` (`failure-taxonomy.ts:481-483`).
- Produces:
  - `export const GEMINI_THINKING_IDLE_TIMEOUT_MS = 120_000`;
  - `export function resolveGeminiThinkingIdleTimeoutMs(model: string): number`;
  - `export class AnalyzerTimeoutError extends Error { readonly code = 'ANALYZER_TIMEOUT'; constructor(readonly transport: TransportKind, readonly model: string, readonly elapsedMs: number, readonly reason: 'ceiling' | 'connect-timeout' | 'thinking-idle') }`. This is the contract class pulled forward from wave 3, which reuses it and must not re-add it. `'thinking-idle'` widens the contract's reason union; the master plan's contract records it.
  - knob `analyzer.gemini.thinkingIdleTimeoutMs` (env `GEMINI_THINKING_IDLE_MS`, integer 0–290 000, default `0`);
  - knob `analyzer.gemini.requestCeilingMs` (env `ANALYZER_GEMINI_REQUEST_CEILING_MS`, default `1_800_000`). Neither Settings row needs a frontend change: `src/views/advanced.tsx` renders every knob from `GET /api/config` descriptors;
  - FailureCode `analyzer-timeout`, also pulled forward from wave 3;
  - the log line `[gemini] stream-timing model=<id> firstChunkMs=<ms|none> firstAnswerMs=<ms|none> thoughtPartsBeforeAnswer=<n>`, one `console.info` per request attempt.

**One knob, both defaults (P5).** `analyzer.gemini.thinkingIdleTimeoutMs` is an integer from `0` to `290_000`:
- **`0`, the default, is automatic per model:** `GEMINI_THINKING_IDLE_TIMEOUT_MS` (120 000 ms) when `geminiModelThinks(model)`; otherwise `resolveStreamIdleTimeoutMs()`, which is today's 45 000 ms, or `GEMINI_STREAM_IDLE_MS` when set (so every existing idle test keeps its behaviour).
- **A positive value applies to every Gemini model**, thinking or not.

One Settings row therefore expresses both defaults, and nobody needs to know the model list to keep today's behaviour. A per-model value table would be the verdict table P5 removed.

**Why the maximum is 290 000 ms.** The Gemini SDK streams over the global `fetch` (`server/node_modules/@google/genai/dist/node/index.mjs:13874`). Undici's global dispatcher ends a request after 300 s without response headers, or 300 s without body data. The SDK raises those two timeouts only when a request passes `httpOptions.timeout` (`raiseUndiciTimeouts`, `index.mjs:13425-13445`, called from `:13737-13740`). `GeminiTransport` passes none, and passing one would change the timeouts for every global-`fetch` user in the process. A window of 300 s or more could therefore never fire: undici would end the request first, as an unclassified network error. 290 s keeps this window the one that fires, and the knob's help text states the limit and its reason.

**Behaviour (P5):**
- **Every request** is bounded by `AbortSignal.timeout(requestCeilingMs)`, created inside the per-attempt `generate` call. That call runs after `withTransportRetry` acquires the limiter, so queue time is not charged (spec §1).
- **Until the first answer text arrives**, every silent gap is bounded by `resolveGeminiThinkingIdleTimeoutMs(model)`: the watchdog is armed with it at the stream call, and every chunk that arrives before answer text re-arms it with the same window. That includes each thought part (Task 2.7) and any chunk that carries no text.
- **From the first answer text on**, the watchdog is re-armed with `resolveStreamIdleTimeoutMs()` (45 s), exactly as today. The chunk that carries the first answer text re-arms it once its text is appended, and every later chunk re-arms it on arrival.
- **A timeout before answer text, when the thinking window applies** — the model thinks by the static id rule, or the knob is positive — raises `AnalyzerTimeoutError('gemini', model, elapsedMs, 'thinking-idle')`. `GEMINI_RETRY_CLASSIFIER` maps it to `no-retry`, so `withTransportRetry` rethrows it at once: there is no second attempt, no `stream idle … retrying` warning, and no `onThrottle` call. It maps to `analyzer-timeout`, whose copy names `analyzer.gemini.thinkingIdleTimeoutMs`. It is not retried because it already exceeds Gemini's 90 s retry budget (`maxTotalMs`).
- **A timeout before answer text on a model that does not think, at the automatic value**, uses a window equal to the idle window and stays today's `GeminiStreamIdleError`, retried under today's rules.
- **A timeout after answer text starts** is today's `GeminiStreamIdleError(model, idleMs)`, retried under today's rules.
- **Classification order in the `catch`:**
  1. watchdog fired while armed for the thinking window → `AnalyzerTimeoutError(…, 'thinking-idle')` (not retried);
  2. watchdog fired otherwise → `GeminiStreamIdleError` (retried);
  3. caller aborted → `AnalysisAbortedError`;
  4. ceiling aborted → `AnalyzerTimeoutError(…, 'ceiling')`, not retried and never a fallback.
- **One log line per request attempt,** from the `finally`: model, ms from the stream call to the first chunk, ms to the first answer text (`none` for either that never arrived), and the number of thought parts before the answer text. It never carries request or response content.
- **Trade-off (P5).** A stalled request on a thinking model — every Gemini 3.x, including the default `gemini-3.5-flash-lite` — fails once, after up to 120 s, instead of two 45 s attempts. The Analysing view's phase card shows it as stalled meanwhile. In return, a think that stays silent, or streams summaries, for up to 120 s at a time is not killed.
- **Known consequence.** Gemini's `maxTotalMs` stays 90 000 (contract). A mid-answer idle error after a long request is therefore not retried: the loop's elapsed check breaks first and the idle error is thrown, as today.

- [ ] **Step 1: Write the failing tests**

In `server/src/analyzer/transports/gemini-transport-thinking.test.ts` (Task 2.7), directly after the `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';` line, add the snippet below. Vitest hoists `vi.hoisted` above every import.
```ts
vi.hoisted(() => {
  /* BACKOFFS_MS is read at module load — zero it before transport-retry.ts
     evaluates so a 3-attempt idle exhaustion finishes in ~1 s, not ~9 s. The
     single-attempt case below re-imports with real backoffs. */
  process.env.GEMINI_RETRY_BACKOFFS_MS = '0,0';
});
```
Change its `./gemini-transport.js` import to `import { GeminiTransport, GEMINI_THINKING_IDLE_TIMEOUT_MS, resolveGeminiThinkingIdleTimeoutMs } from './gemini-transport.js';`, add `import { allKnobs } from '../../config/registry.js';` and `import { coerceAndValidate } from '../../config/resolver.js';`, and append:
```ts
describe('thinking window, request ceiling and the per-attempt timing log (#3084 wave 2b, P5)', () => {
  const transport = (model: string, gen: ReturnType<typeof vi.fn>, over: { requestCeilingMs?: number } = {}) =>
    new GeminiTransport({ apiKey: 'test-key', model, client: clientWith(gen), requestCeilingMs: 1_800_000, ...over });
  /** A stream whose chunks arrive at fixed offsets from the stream call. The
      timers are registered inside the mock, synchronously at call time, so a
      fake clock measures every offset from the stream call. */
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
  const answerAfter = (atMs: number) =>
    timedStream([{ atMs, item: chunk([{ text: ANSWER }], { finishReason: 'STOP' }) }]);
  const linesOf = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((call) => call.map(String).join(' '));
  const timingLines = (spy: ReturnType<typeof vi.spyOn>) =>
    linesOf(spy).filter((line) => line.startsWith('[gemini] stream-timing'));

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.GEMINI_THINKING_IDLE_MS;
  });

  it('resolves 0 (automatic) per model, and a positive knob value for every model', () => {
    expect(GEMINI_THINKING_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-3.6-flash')).toBe(120_000);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-3.5-flash-lite')).toBe(120_000);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it')).toBe(45_000);
    process.env.GEMINI_STREAM_IDLE_MS = '200';
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it')).toBe(200);
    /* 150000 is deliberately distinct from both the automatic thinking
       default (120000) and the automatic non-thinking default (200, set
       above): a value equal to either default would not prove the knob's
       override took effect rather than the automatic path. */
    process.env.GEMINI_THINKING_IDLE_MS = '150000';
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-3.6-flash')).toBe(150_000);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it')).toBe(150_000);
  });

  it('a thinking model whose thought parts arrive 60 s apart across multiple thinking windows, then answers, is not killed (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const thought = (n: number) => chunk([{ thought: true, text: `thought ${n}` }]);
    const gen = vi.fn().mockImplementation(
      timedStream([
        { atMs: 60_000, item: thought(1) },
        { atMs: 120_000, item: thought(2) },
        { atMs: 180_000, item: chunk([{ text: ANSWER }], { finishReason: 'STOP' }) },
      ]),
    );
    let text: string | undefined;
    const sent = transport('gemini-3.6-flash', gen).send(request()).then((r) => {
      text = r.text;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(gen).toHaveBeenCalledTimes(1); // precondition: the stream call happened before the clock moved
    await vi.advanceTimersByTimeAsync(179_999);
    expect(gen).toHaveBeenCalledTimes(1); // no watchdog kill, so no second attempt
    expect(text).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(text).toBe(ANSWER);
    await sent;
  });

  it('a thinking model silent for 121 s fails with AnalyzerTimeoutError after exactly ONE attempt: no retry warning, no onThrottle (fake clock)', async () => {
    /* Real backoffs for this case only: a regression that retried this error
       would log "retrying" and announce its >1 s backoff through onThrottle. */
    process.env.GEMINI_RETRY_BACKOFFS_MS = '6000,12000';
    vi.resetModules();
    const fresh = await import('./gemini-transport.js');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onThrottle = vi.fn();
    const gen = vi.fn().mockImplementation(answerAfter(121_000));
    let failure: unknown;
    const sent = new fresh.GeminiTransport({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      client: clientWith(gen),
      requestCeilingMs: 1_800_000,
    })
      .send(request({ call: { onThrottle } }))
      .catch((err: unknown) => {
        failure = err;
      });
    try {
      await vi.advanceTimersByTimeAsync(119_999);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toMatchObject({
        name: 'AnalyzerTimeoutError',
        reason: 'thinking-idle',
        transport: 'gemini',
        model: 'gemini-3.6-flash',
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gen).toHaveBeenCalledTimes(1);
      expect(linesOf(warn).filter((line) => line.includes('retrying'))).toEqual([]);
      expect(onThrottle).not.toHaveBeenCalled();
      await sent;
    } finally {
      process.env.GEMINI_RETRY_BACKOFFS_MS = '0,0';
    }
  });

  it('a model that does not think, whose first chunk would arrive at 46 s, is killed at 45 s and retried, as today (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gen = vi.fn().mockImplementation(answerAfter(46_000));
    let failure: unknown;
    const sent = transport('gemma-4-31b-it', gen).send(request()).catch((err: unknown) => {
      failure = err;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(gen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(gen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    /* Killed at 45 s, before its 46 s chunk: today's retry rules started attempt 2. */
    expect(gen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(46_000);
    /* Attempt 2 is killed at 90 s; Gemini's 90 s maxTotalMs then ends the loop. */
    expect(failure).toMatchObject({ name: 'GeminiStreamIdleError', idleMs: 45_000 });
    expect(gen).toHaveBeenCalledTimes(2);
    await sent;
  });

  it('after answer text starts, a 46 s gap on a thinking model is killed at 45 s and retried, as today (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gen = vi.fn().mockImplementation(
      timedStream([
        { atMs: 1_000, item: chunk([{ thought: true, text: 'thinking' }]) },
        { atMs: 2_000, item: chunk([{ text: '{"ok":' }]) },
        { atMs: 48_000, item: chunk([{ text: 'true}' }], { finishReason: 'STOP' }) },
      ]),
    );
    let failure: unknown;
    const sent = transport('gemini-3.6-flash', gen).send(request()).catch((err: unknown) => {
      failure = err;
    });
    await vi.advanceTimersByTimeAsync(46_999);
    expect(gen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    /* The answer text started at 2 s, so the 45 s idle window killed the gap at
       47 s, before the 48 s chunk, and today's retry rules started attempt 2. */
    expect(gen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(47_000);
    /* Attempt 2 (started at 47 s) is killed at 94 s; the 90 s maxTotalMs ends the loop. */
    expect(failure).toMatchObject({ name: 'GeminiStreamIdleError', idleMs: 45_000 });
    expect(gen).toHaveBeenCalledTimes(2);
    await sent;
  });

  it('a positive knob value applies to every model: it spares a model that does not think past its idle window, and ends either kind at its value, once', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '200';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.GEMINI_THINKING_IDLE_MS = '1000';
    const spared = vi.fn().mockImplementation(answerAfter(600));
    const result = await transport('gemma-4-31b-it', spared).send(request());
    expect(result.text).toBe(ANSWER);
    expect(spared).toHaveBeenCalledTimes(1);

    process.env.GEMINI_THINKING_IDLE_MS = '300';
    for (const model of ['gemini-3.6-flash', 'gemma-4-31b-it']) {
      const killed = vi.fn().mockImplementation(answerAfter(900));
      await expect(transport(model, killed).send(request())).rejects.toMatchObject({
        name: 'AnalyzerTimeoutError',
        reason: 'thinking-idle',
      });
      expect(killed).toHaveBeenCalledTimes(1);
    }
  });

  it('silence past the request ceiling fails as AnalyzerTimeoutError, once, never retried (a thinking model)', async () => {
    const gen = vi.fn().mockImplementation(answerAfter(2_000));
    await expect(transport('gemini-3.6-flash', gen, { requestCeilingMs: 300 }).send(request())).rejects.toMatchObject({
      name: 'AnalyzerTimeoutError',
      reason: 'ceiling',
      transport: 'gemini',
    });
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('the ceiling also bounds a model that does not think', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '5000';
    const gen = vi.fn().mockImplementation(answerAfter(2_000));
    await expect(transport('gemma-4-31b-it', gen, { requestCeilingMs: 300 }).send(request())).rejects.toMatchObject({
      name: 'AnalyzerTimeoutError',
      reason: 'ceiling',
      transport: 'gemini',
    });
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('a caller abort during the wait for the first chunk is an abort, not a timeout', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const gen = vi.fn().mockImplementation(answerAfter(2_000));
    await expect(
      transport('gemini-3.6-flash', gen).send(request({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AnalysisAbortedError' });
  });

  it('both knobs ship with their bounds and defaults; the thinking window refuses 290 001 ms and says why', () => {
    const thinking = allKnobs().find((k) => k.key === 'analyzer.gemini.thinkingIdleTimeoutMs')!;
    expect(thinking).toMatchObject({
      env: 'GEMINI_THINKING_IDLE_MS',
      type: 'integer',
      min: 0,
      max: 290_000,
      default: 0,
    });
    expect(coerceAndValidate(thinking, '290000').ok).toBe(true);
    expect(coerceAndValidate(thinking, '290001').ok).toBe(false);
    expect(thinking.help).toContain('Maximum 290000');
    expect(thinking.help).toContain('300 s');
    expect(allKnobs().find((k) => k.key === 'analyzer.gemini.requestCeilingMs')).toMatchObject({
      env: 'ANALYZER_GEMINI_REQUEST_CEILING_MS',
      type: 'integer',
      min: 60_000,
      max: 14_400_000,
      default: 1_800_000,
    });
  });

  it('logs one timing line per attempt: model, firstChunkMs, firstAnswerMs and thought parts before the answer — never request or response text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gen = vi.fn().mockResolvedValue(
      streamOf([
        chunk([{ thought: true, text: 'SECRET-THOUGHT-1' }]),
        chunk([{ thought: true, text: 'SECRET-THOUGHT-2' }]),
        chunk([{ text: ANSWER }], { finishReason: 'STOP' }),
      ]),
    );
    await transport('gemini-3.6-flash', gen).send(
      request({ system: 'SECRET-SYSTEM', messages: [{ role: 'user', content: 'SECRET-CHAPTER' }] }),
    );
    const lines = timingLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[gemini\] stream-timing model=gemini-3\.6-flash firstChunkMs=\d+ firstAnswerMs=\d+ thoughtPartsBeforeAnswer=2$/,
    );
    const everything = info.mock.calls.flat().map(String).join('\n');
    for (const secret of ['SECRET-THOUGHT', 'SECRET-SYSTEM', 'SECRET-CHAPTER', ANSWER]) expect(everything).not.toContain(secret);
  });

  it('firstAnswerMs is when the answer text arrived, not the first chunk (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gen = vi.fn().mockImplementation(
      timedStream([
        { atMs: 5_000, item: chunk([{ thought: true, text: 'thinking' }]) },
        { atMs: 9_000, item: chunk([{ text: ANSWER }], { finishReason: 'STOP' }) },
      ]),
    );
    const sent = transport('gemini-3.6-flash', gen).send(request());
    await vi.advanceTimersByTimeAsync(9_000);
    await sent;
    expect(timingLines(info)).toEqual([
      '[gemini] stream-timing model=gemini-3.6-flash firstChunkMs=5000 firstAnswerMs=9000 thoughtPartsBeforeAnswer=1',
    ]);
  });

  it('logs firstChunkMs=none firstAnswerMs=none for an attempt that never saw a chunk', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gen = vi.fn().mockImplementation(answerAfter(2_000));
    await transport('gemini-3.6-flash', gen, { requestCeilingMs: 300 }).send(request()).catch(() => undefined);
    expect(timingLines(info)).toEqual([
      '[gemini] stream-timing model=gemini-3.6-flash firstChunkMs=none firstAnswerMs=none thoughtPartsBeforeAnswer=0',
    ]);
  });
});
```

In `server/src/analyzer/gemini.test.ts`, inside `describe('stream watchdog + abort', …)` (`:618`; idle 120 ms and backoffs `40,80` from its `beforeEach`, `:621-624`), add directly after the `throws GeminiStreamIdleError when the stream goes silent for the watchdog window` test (`:655-673`). That existing test yields an answer chunk (`{ text: '{' }`) before it hangs, so it only ever exercised the after-answer window; these three stall before any answer text:
```ts
    /* #3084 P5 — the thinking window is automatic per model: today's idle
       window for a model that does not think, 120 s for a thinking model. */
    async function* hangBeforeFirstChunk(): AsyncGenerator<{ text: string }> {
      const hang = new AbortController();
      hangControllers.push(hang);
      await new Promise<void>((resolve) => {
        if (hang.signal.aborted) resolve();
        else hang.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { text: '{' };
    }

    it('a model that does not think: a stall BEFORE the first chunk throws GeminiStreamIdleError after 3 attempts (#3084 P5)', async () => {
      vi.resetModules();
      const { GeminiAnalyzer, GeminiStreamIdleError } = await import('./gemini.js');
      generateContentStream
        .mockResolvedValueOnce(hangBeforeFirstChunk())
        .mockResolvedValueOnce(hangBeforeFirstChunk())
        .mockResolvedValueOnce(hangBeforeFirstChunk());
      const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemma-4-31b-it' });
      await expect(analyzer.runStage1('m_idle_prestall', '# prompt', {})).rejects.toBeInstanceOf(GeminiStreamIdleError);
      expect(generateContentStream).toHaveBeenCalledTimes(3);
    }, 5_000);

    it('a thinking model: a pre-first-chunk wait longer than the idle window completes, inside its automatic 120 s thinking window (#3084 P5)', async () => {
      vi.resetModules();
      const { GeminiAnalyzer } = await import('./gemini.js');
      /* asyncFromArray (:76) sleeps delayMs before each item, the first included. */
      generateContentStream.mockResolvedValueOnce(asyncFromArray([{ text: STAGE1_RESPONSE }], 400));
      /* gemini-2.5-flash thinks by the static id rule (Task 2.5). */
      const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });
      const result = await analyzer.runStage1('m_idle_prewait', '# prompt', {});
      expect(result.characters).toHaveLength(3);
      expect(generateContentStream).toHaveBeenCalledTimes(1);
    }, 5_000);

    it('a thinking model: silence past its thinking window before any answer text fails once as AnalyzerTimeoutError, through the whole analyzer (#3084 P5)', async () => {
      process.env.GEMINI_THINKING_IDLE_MS = '300';
      try {
        vi.resetModules();
        const { GeminiAnalyzer } = await import('./gemini.js');
        generateContentStream.mockResolvedValueOnce(hangBeforeFirstChunk());
        const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });
        await expect(analyzer.runStage1('m_thinking_stall', '# prompt', {})).rejects.toMatchObject({
          name: 'AnalyzerTimeoutError',
          reason: 'thinking-idle',
        });
        expect(generateContentStream).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.GEMINI_THINKING_IDLE_MS;
      }
    }, 5_000);
```
In that file's top-level `afterAll` (`:805-827`) add:
```ts
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_idle_prestall-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_idle_prewait-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_idle_prewait-stage1.json'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_thinking_stall-stage1.md'), { force: true });
```

In `server/src/routes/failure-taxonomy.test.ts`:
- **Sorted list.** Add `'analyzer-timeout',` to the list at `:402-426`, after `'analyzer-rate-limit',`.
- **Import.** Add `AnalyzerTimeoutError` to the `../analyzer/errors.js` import.
- **New tests.** Append:
```ts
describe('AnalyzerTimeoutError (#3084 wave 2b)', () => {
  it('→ analyzer-timeout, naming the Gemini request ceiling setting', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerTimeoutError('gemini', 'gemini-3.6-flash', 1_800_000, 'ceiling'),
      'Gemini (gemini-3.6-flash)',
    );
    expect(r.code).toBe('analyzer-timeout');
    expect(r.userMessage).toContain('Gemini (gemini-3.6-flash)');
    expect(r.userMessage).toContain('Gemini request ceiling');
    expect(r.detail).toContain('reason=ceiling');
  });

  it('→ analyzer-timeout naming the thinking window setting and its 290 s maximum for a thinking-idle timeout, not the ceiling', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerTimeoutError('gemini', 'gemini-3.6-flash', 120_000, 'thinking-idle'),
      'Gemini (gemini-3.6-flash)',
    );
    expect(r.code).toBe('analyzer-timeout');
    expect(r.userMessage).toContain('Gemini (gemini-3.6-flash)');
    expect(r.userMessage).toContain('analyzer.gemini.thinkingIdleTimeoutMs');
    expect(r.userMessage).toContain('GEMINI_THINKING_IDLE_MS');
    expect(r.userMessage).toContain('290000');
    expect(r.userMessage).not.toContain('request ceiling');
    expect(r.remediation).toContain('analyzer.gemini.thinkingIdleTimeoutMs');
    expect(r.detail).toContain('reason=thinking-idle');
  });

  it('is matched by name in the signature scan and never reads as unreachable', () => {
    expect(classifyAnalysisError(new AnalyzerTimeoutError('gemini', 'gemini-3.6-flash', 1, 'ceiling')).code).toBe(
      'analyzer-timeout',
    );
  });
});
```
- **Counts.** In `src/data/help-failures.test.ts:13` change `.toBe(23)` to `.toBe(24)`; in `src/data/help-categories.test.ts:24` change `.toBe(49)` to `.toBe(50)`.

- [ ] **Step 2: Run it and confirm it fails**
Run:
```
npm --prefix server run test -- src/analyzer/transports/gemini-transport-thinking.test.ts src/routes/failure-taxonomy.test.ts --retry=0
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts --retry=0
npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts
```
Expected FAIL:
- `gemini-transport-thinking.test.ts`:
  - `resolves 0 (automatic) per model, …`: `resolveGeminiThinkingIdleTimeoutMs is not a function`;
  - `a thinking model whose thought parts arrive 60 s apart …`: `expected "spy" to be called 1 times, but got 2 times` (today's 45 s window killed the first 60 s wait and retried);
  - `a thinking model silent for 121 s fails with AnalyzerTimeoutError …`: `failure` is a `GeminiStreamIdleError` from today's 45 s window, or `undefined` while its retry backs off;
  - `after answer text starts, a 46 s gap …` already passes on today's code, which re-arms 45 s on every chunk; Step 5 proves it can fail;
  - `a positive knob value applies to every model …`: the spared Gemma request fails with `GeminiStreamIdleError` at 200 ms;
  - both ceiling tests: the promise resolves after 2 s (no ceiling);
  - `both knobs ship …`: `undefined`;
  - the three log tests: no `[gemini] stream-timing` line;
- slow `gemini.test.ts`: `a thinking model: a pre-first-chunk wait longer than the idle window completes …` (`GeminiStreamIdleError` after 3 attempts at 120 ms), and `… silence past its thinking window before any answer text fails once …` (`GeminiStreamIdleError`, 3 calls);
- `failure-remediations copy module … has exactly one entry per FailureCode`;
- `AnalyzerTimeoutError …` (`AnalyzerTimeoutError is not a constructor`);
- the two help counts (received 23 / 49).

These already pass because they pin today's behaviour: `a model that does not think, whose first chunk would arrive at 46 s, …`, `after answer text starts, a 46 s gap …`, the abort test, and slow `a model that does not think: a stall BEFORE the first chunk …`. Step 5 proves each can fail.
- [ ] **Step 3: Implement**

`server/src/analyzer/errors.ts` (append):
```ts
/* #3084 — a request ran past a time limit without finishing (spec §1 decision
   1c, spec §7). Wave 2 throws it from the Gemini transport for
   analyzer.gemini.requestCeilingMs ('ceiling') and for the thinking window,
   analyzer.gemini.thinkingIdleTimeoutMs ('thinking-idle'); wave 3 reuses it
   for OpenAI-compatible endpoints ('connect-timeout' too). Never retried, never
   a fallback: the upstream was reachable and did not finish. */
export class AnalyzerTimeoutError extends Error {
  readonly code = 'ANALYZER_TIMEOUT';
  constructor(
    public readonly transport: TransportKind,
    public readonly model: string,
    public readonly elapsedMs: number,
    public readonly reason: 'ceiling' | 'connect-timeout' | 'thinking-idle',
  ) {
    super(
      `${transport} ${model} request exceeded its ${
        reason === 'ceiling' ? 'time ceiling' : reason === 'thinking-idle' ? 'thinking window' : 'connect timeout'
      } after ${elapsedMs} ms.`,
    );
    this.name = 'AnalyzerTimeoutError';
  }
}
```

`server/src/config/registry.ts`, inserted after the `analyzer.gemini.maxInputTokensPerRequest` knob (ending `:79` on 46e62a34):
```ts
  {
    key: 'analyzer.gemini.thinkingIdleTimeoutMs',
    env: 'GEMINI_THINKING_IDLE_MS',
    group: 'analyzer-sampling',
    label: 'Gemini thinking idle timeout (ms)',
    help: "How long a Gemini analysis request may stay silent before its answer starts: the wait for the first streamed chunk, and each gap between the model's thought summaries. Automatic = 2 minutes (0, 120000 ms) for thinking models (Gemini 2.5 Pro and 2.5 Flash, and every Gemini 3.x model); non-thinking models keep the 45 s stream idle window. A positive value applies to every Gemini model. Raise it if long thinks time out; when this window runs out the request fails as analyzer-timeout and is not retried, while a model that does not think, at the automatic value, keeps today's idle retry instead. Once the answer starts, the 45 s idle window applies whatever this is set to. Maximum 290000 (290 seconds): the Gemini SDK streams over Node's built-in fetch, whose network layer ends a request after 300 s without data, so a longer value could never take effect.",
    type: 'integer', min: 0, max: 290_000,
    default: 0, // ← 0 = automatic; resolved by resolveGeminiThinkingIdleTimeoutMs() in analyzer/transports/gemini-transport.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.gemini.requestCeilingMs',
    env: 'ANALYZER_GEMINI_REQUEST_CEILING_MS',
    group: 'analyzer-sampling',
    label: 'Gemini request ceiling (ms)',
    help: "Absolute time limit for one Gemini analysis request attempt, counted after rate-limit waits and including the wait for the first chunk. A request that reaches it fails as analyzer-timeout and is not retried. Default 1800000 (30 min).",
    type: 'integer', min: 60_000, max: 14_400_000,
    default: 1_800_000,
    apply: 'live', risk: 'medium',
  },
```

`docs/wiki/Advanced-Settings.md` §1 (F1, F3, and the model-routing coordinator's
note on `knob-docs-sync.test.mjs`) — two new rows in the table, directly after
the "Gemini max input tokens per request" row:
```markdown
| Gemini thinking idle timeout (ms) | Silence allowed before a Gemini answer starts: the wait for the first chunk, and each gap between thought summaries. 0 = automatic: 2 min for thinking models, else the 45 s idle window | 0 | integer, 0–290000 | live | medium |
| Gemini request ceiling (ms) | Absolute time limit for one Gemini analysis request attempt | 1800000 | integer, 60000–14400000 | live | medium |
```
`scripts/tests/knob-docs-sync.test.mjs` (#2012, run by `npm run test:hooks`)
fails until both rows exist, since these are brand-new knob `label`s the guard
has never seen before this task — add them in this same step, not a later
one, and run the guard in Step 4.

**The intro sentence's count, too.** The same guard's `'the intro prose knob
count matches the real registry count (#2012 acceptance 4)'` test parses
`Advanced-Settings.md`'s intro paragraph — `"— N knobs across M groups in
total"` (`:14`) — and compares `N` against `allKnobs().length`. On `main` as
read for this task, that line reads **116 knobs across 12 groups**, not the
117 an earlier draft of this instruction assumed; re-read it at
implementation time in case another PR moved the count between now and then.
Task 2.8 adds exactly two knobs and no new group, so update it to **118
knobs across 12 groups** in this same step (Task 2.6 adds no knob — it only
lifts an existing one's `max` — so it changes no count). Getting this wrong
by one is not cosmetic: the guard fails the build.

`server/src/analyzer/transports/gemini-transport.ts`:
- **Imports.** Add `AnalyzerTimeoutError` to the `../errors.js` import. `configValue` (wave 1 Task 1.9) and `geminiModelThinks` (Task 2.7) are already imported.
- **Thinking window.** Add below `resolveStreamIdleTimeoutMs` (moved from `gemini.ts:73-78`):
```ts
/* #3084 P5 — how long a THINKING Gemini model may stay silent before its answer
   text starts. A long think can stream nothing, or only sparse thought
   summaries, before the answer, so the 45 s idle window would kill it. The
   knob's maximum is 290 000 ms: the SDK streams over the global fetch, whose
   undici headers/body timeouts are fixed at 300 s. The wave 2 on-box row (run
   sheet §1) measures real chapters to tune this default. */
export const GEMINI_THINKING_IDLE_TIMEOUT_MS = 120_000;

/** P5 — the silence allowed before a Gemini request's answer text starts: the
    wait for the first chunk and each gap between thought parts.
    analyzer.gemini.thinkingIdleTimeoutMs = 0 (the default) is automatic per
    model: 120 s for a model that thinks (static id rule, P27), otherwise the
    stream idle window. A positive value applies to every model. */
export function resolveGeminiThinkingIdleTimeoutMs(model: string): number {
  const configured = configValue<number>('analyzer.gemini.thinkingIdleTimeoutMs');
  if (configured > 0) return configured;
  return geminiModelThinks(model) ? GEMINI_THINKING_IDLE_TIMEOUT_MS : resolveStreamIdleTimeoutMs();
}

/** P5 — whether a timeout before answer text is a thinking-window timeout
    (AnalyzerTimeoutError, not retried) rather than today's idle timeout
    (GeminiStreamIdleError, retried): a model that thinks, or a positive knob. */
function geminiThinkingWindowApplies(model: string): boolean {
  return configValue<number>('analyzer.gemini.thinkingIdleTimeoutMs') > 0 || geminiModelThinks(model);
}
```
- **Classifier.** In `GEMINI_RETRY_CLASSIFIER.classify`, directly after `if (err instanceof AnalyzerTruncatedError) return 'no-retry';`, add:
```ts
    /* #3084 P5 — a thinking-window or ceiling timeout already exceeds the 90 s
       retry budget: rethrow at once, with no "retrying" warning and no
       onThrottle announcement for an attempt the loop would never start. */
    if (err instanceof AnalyzerTimeoutError) return 'no-retry';
```
- **Constructor.** Change the options type to `{ apiKey: string; model: string; client?: GoogleGenAI; requestCeilingMs?: number }`, add the field `private readonly requestCeilingMs: number | undefined;`, and assign `this.requestCeilingMs = opts.requestCeilingMs;`. It is a test seam; the knob's minimum is 60 000 ms.
- **Ceiling signal and timings.** In `generate`, replace the moved `gemini.ts:684-689`:
```ts
    const watchdog = new AbortController();
    let idleFired = false;

    const signals: AbortSignal[] = [watchdog.signal];
    if (callerSignal) signals.push(callerSignal);
    const combined = AbortSignal.any(signals);
```
with:
```ts
    const watchdog = new AbortController();
    let idleFired = false;
    /* #3084 P5 — every Gemini request is bounded by an absolute ceiling, created
       here inside the per-attempt call, which runs AFTER the limiter was
       acquired, so queue time is not charged. */
    const requestCeilingMs = this.requestCeilingMs ?? configValue<number>('analyzer.gemini.requestCeilingMs');
    const ceiling = AbortSignal.timeout(requestCeilingMs);
    const requestStartedAt = Date.now();
    /* #3084 P5 — measured for the per-attempt timing line (on-box tuning). */
    let firstChunkMs: number | null = null;
    let firstAnswerMs: number | null = null;
    let thoughtPartsBeforeAnswer = 0;

    const signals: AbortSignal[] = [watchdog.signal, ceiling];
    if (callerSignal) signals.push(callerSignal);
    const combined = AbortSignal.any(signals);
```
- **Watchdog windows.** Replace the moved `gemini.ts:691-699` (`const idleTimeoutMs = …` through the end of `armIdleTimer`) with:
```ts
    const idleTimeoutMs = resolveStreamIdleTimeoutMs();
    const thinkingIdleTimeoutMs = resolveGeminiThinkingIdleTimeoutMs(this.model);
    const thinkingWindowApplies = geminiThinkingWindowApplies(this.model);
    /* #3084 P5 — true while the pending timer bounds silence before the answer
       text with the thinking window, so its expiry is a thinking-window timeout
       (not retried) rather than an idle timeout (retried). */
    let armedForThinking = thinkingWindowApplies;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    /** Until the answer text starts, every gap gets the thinking window; from
        then on, the idle window. */
    const armIdleTimer = (answerStarted: boolean) => {
      if (idleTimer) clearTimeout(idleTimer);
      armedForThinking = !answerStarted && thinkingWindowApplies;
      idleTimer = setTimeout(
        () => {
          idleFired = true;
          watchdog.abort();
        },
        answerStarted ? idleTimeoutMs : thinkingIdleTimeoutMs,
      );
    };
```
  For a model that does not think, at the automatic value, `thinkingIdleTimeoutMs` equals `idleTimeoutMs` and `armedForThinking` stays `false`, so its watchdog behaves exactly as today.
- **Stream-call arm.** Replace the pre-stream `armIdleTimer();` (the first statement inside `try`, moved from `gemini.ts:724`) with:
```ts
      /* #3084 P5 — no answer text yet: bounded by the thinking window. */
      armIdleTimer(false);
```
- **Per-chunk arm and timings.** Replace the per-chunk `armIdleTimer();` (moved from `gemini.ts:758`) with `armIdleTimer(buf !== '');`. Directly after `const chunk = next.value;` and wave 1's `reasoningSeen` line, add:
```ts
        if (firstChunkMs === null) firstChunkMs = Date.now() - requestStartedAt;
        if (!buf) {
          thoughtPartsBeforeAnswer += (chunk.candidates?.[0]?.content?.parts ?? []).filter((p) => p.thought === true).length;
        }
```
- **Answer-start re-arm.** Directly after `buf = appendBounded(buf, text);` (moved from `gemini.ts:773`), add:
```ts
        if (firstAnswerMs === null) {
          firstAnswerMs = Date.now() - requestStartedAt;
          /* #3084 P5 — the answer has started: from this chunk on, the 45 s
             idle watchdog applies, as today. */
          armIdleTimer(true);
        }
```
- **Idle classification.** In the `catch`, replace `if (idleFired) { throw new GeminiStreamIdleError(this.model, idleTimeoutMs); }` (moved from `gemini.ts:824-826`) with:
```ts
      if (idleFired) {
        /* #3084 P5 — silence before any answer text, past the thinking window:
           not an idle stall to retry, but a timeout naming its setting. */
        if (armedForThinking) {
          throw new AnalyzerTimeoutError('gemini', this.model, Date.now() - requestStartedAt, 'thinking-idle');
        }
        throw new GeminiStreamIdleError(this.model, idleTimeoutMs);
      }
```
- **Ceiling classification.** In the `catch`, directly after the `if (callerSignal?.aborted) { … }` block (moved from `gemini.ts:827-831`), add:
```ts
      if (ceiling.aborted) {
        throw new AnalyzerTimeoutError('gemini', this.model, Date.now() - requestStartedAt, 'ceiling');
      }
```
- **Timing line.** In the `finally` (moved from `gemini.ts:862-865`), after `releaseAbortListener();`, add:
```ts
      /* #3084 P5 — one line per request attempt, for on-box tuning of the
         thinking window. Counts and timings only: never request or response
         content. */
      console.info(
        `[gemini] stream-timing model=${this.model} firstChunkMs=${firstChunkMs ?? 'none'} firstAnswerMs=${firstAnswerMs ?? 'none'} thoughtPartsBeforeAnswer=${thoughtPartsBeforeAnswer}`,
      );
```

`server/.env.example`, in the hand-written large-chapter block Task 2.6 edited: directly below the `#       ANALYZER_NUM_PREDICT        Ollama num_predict (default -1 = until ctx full)` line, add
```
#       GEMINI_THINKING_IDLE_MS     silence allowed before a Gemini answer starts (default 0 = automatic: 120000 for a thinking model, else the 45 s idle window; max 290000)
#       ANALYZER_GEMINI_REQUEST_CEILING_MS  time limit per Gemini request (default 1800000 = 30 min)
```
and directly below `# ANALYZER_NUM_PREDICT=-1`, add
```
# GEMINI_THINKING_IDLE_MS=0
# ANALYZER_GEMINI_REQUEST_CEILING_MS=1800000
```
The managed-block entries are generated by `npm run config:sync` in Task 2.10.

`server/src/routes/failure-taxonomy.ts`:
- **Union.** Add `| 'analyzer-timeout'` after `| 'analyzer-truncated'` (`:35`).
- **Import.** Change the errors import (`:26`) to `import { AnalyzerTimeoutError, AnalyzerTruncatedError } from '../analyzer/errors.js';`.
- **Signature row.** Insert after the `analyzer-truncated` signature row (`:103-109`). `fatal: true` mirrors `analyzer-unreachable`'s row and is inert: analysis never reads the flag, whose one reader is generation (`generation-error.ts:34` → `generation.ts:2179-2184`), and generation's `classifyFailure` never matches a `source: 'analysis'` row. Whether a timed-out chapter stops the run is decided by the analysis routes' catch sites, which this task does not change.
```ts
  {
    code: 'analyzer-timeout',
    fatal: true,
    source: 'analysis',
    matchName: 'AnalyzerTimeoutError',
    match: () => false,
  },
```
- **Classify branch.** Insert after the `AnalyzerTruncatedError` branch of `classifyAnalysisFailure` (`:526-534`):
```ts
  if (err instanceof AnalyzerTimeoutError) {
    const detail = `transport=${err.transport} model=${err.model} reason=${err.reason} elapsedMs=${err.elapsedMs}`;
    if (err.reason === 'thinking-idle') {
      /* #3084 P5 — silence before any answer text, past the thinking window. */
      return withCopy(
        'analyzer-timeout',
        `${modelLabel} sent no answer text and stayed silent longer than its thinking window, so the request was stopped after ${Math.round(err.elapsedMs / 1000)} s. Raise 'Gemini thinking idle timeout' (analyzer.gemini.thinkingIdleTimeoutMs, GEMINI_THINKING_IDLE_MS; at most 290000 ms), or pick a faster model, then retry.`,
        detail,
      );
    }
    const setting =
      err.transport === 'gemini'
        ? "'Gemini request ceiling' (ANALYZER_GEMINI_REQUEST_CEILING_MS)"
        : "this endpoint's request ceiling";
    return withCopy(
      'analyzer-timeout',
      `${modelLabel} did not finish within ${Math.round(err.elapsedMs / 1000)} s (the request ceiling). Raise ${setting}, or pick a faster model, then retry.`,
      detail,
    );
  }
```

`server/src/routes/failure-remediations.ts`, inserted after the `'analyzer-truncated'` entry (`:94-101`):
```ts
  'analyzer-timeout': {
    userMessage:
      'The analyzer request was stopped because it ran past a time limit without finishing, instead of ' +
      'being left to hang.',
    remediation:
      "Retry the chapter. If it recurs: when a thinking Gemini model stayed silent before answering, raise " +
      "'Gemini thinking idle timeout' (analyzer.gemini.thinkingIdleTimeoutMs, GEMINI_THINKING_IDLE_MS; at most " +
      "290000 ms, below the 300 s network timeout); when a request ran too long overall, raise 'Gemini request " +
      "ceiling' (ANALYZER_GEMINI_REQUEST_CEILING_MS) in Advanced Settings. Or switch to a faster analyzer model.",
  },
```

`openapi.yaml`: insert `        - analyzer-timeout` after `        - analyzer-content-blocked` (`:7049`), then run `npm run openapi:types`.

`src/data/help-failures.ts`: in `CATEGORIES`, add `'analyzer-timeout': 'analysis',` after `'analyzer-truncated': 'analysis',` (`:34`). In `TITLES`, add `'analyzer-timeout': 'Analyzer request ran past its time limit',` after `'analyzer-truncated': …` (`:63`).
- [ ] **Step 4: Run and confirm it passes**
Run:
```
npm run openapi:types
npm --prefix server run test -- src/analyzer/transports src/analyzer/runner src/analyzer/catalog src/routes/failure-taxonomy.test.ts src/config
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts
npm run typecheck
npm run check:cycles
node scripts/tests/knob-docs-sync.test.mjs
```
Expected: PASS. `knob-docs-sync.test.mjs` (#2012) is red until the two new
wiki rows land, since these are new knob labels the guard has never seen; add
them in the same step as the registry edit, not after. No existing test
changes behaviour:
- `gemini.test.ts`'s two stalling tests (`throws GeminiStreamIdleError when the stream goes silent for the watchdog window`, `:655-673`, and `aborts in-flight stream and throws AnalysisAbortedError when caller signal fires`, `:675-705`) use `gemini-2.5-flash`, a thinking model, but both yield the answer chunk `{ text: '{' }` before they stall, so the 120 ms after-answer window still fires, and the abort test is a caller abort. No existing test stalls before its answer text.
- Wave 1's `gemini-transport.test.ts` uses `gemma-gt-*` ids, which do not think. At the automatic value their thinking window equals the idle window they already set, and a timeout stays `GeminiStreamIdleError`. Its `thought parts set reasoningSeen, keep the idle watchdog alive, …` test spaces thought parts 100 ms apart under a 150 ms window, so it stays green.
- `transport-retry.test.ts` (wave 1) drives `withTransportRetry` with its own classifier and is untouched.
- [ ] **Step 5: Mutation proof** (run each red with `--retry=0`)
  1. In `resolveGeminiThinkingIdleTimeoutMs`, replace `GEMINI_THINKING_IDLE_TIMEOUT_MS : resolveStreamIdleTimeoutMs()` with `resolveStreamIdleTimeoutMs() : resolveStreamIdleTimeoutMs()`. Expected red: `thinking window, request ceiling and the per-attempt timing log (#3084 wave 2b, P5) > resolves 0 (automatic) per model, …`, `… > a thinking model whose thought parts arrive 60 s apart across multiple thinking windows, then answers, is not killed` (`text` stays `undefined`: the 45 s window ended the 60 s wait), and slow `a thinking model: a pre-first-chunk wait longer than the idle window completes …`. Restore it.
  2. Replace the per-chunk `armIdleTimer(buf !== '');` with `armIdleTimer(true);`. Expected red: `… > a thinking model whose thought parts arrive 60 s apart …` (`gen` called 2 times: the 60 s gap after the first thought part was killed at 45 s and retried). This is the N1 regression. Restore it.
  3. Delete the answer-start `armIdleTimer(true);`. Expected red: `… > after answer text starts, a 46 s gap on a thinking model is killed at 45 s and retried, as today` (`gen` called 1 time: the gap kept the 120 s window). Restore it.
  4. Delete `if (configured > 0) return configured;`. Expected red: `… > resolves 0 (automatic) per model, …` (received 120000, since the 150000 override is ignored and the thinking model falls through to the automatic value) and `… > a positive knob value applies to every model …` (the spared Gemma request dies at 200 ms). Restore it.
  5. Delete the `if (armedForThinking) { … }` block in the `catch`. Expected red: `… > a thinking model silent for 121 s fails with AnalyzerTimeoutError after exactly ONE attempt …` (`failure` is `undefined` while the idle retry backs off), `… > a positive knob value applies to every model …` (`GeminiStreamIdleError`, called 3 times), and slow `… silence past its thinking window before any answer text fails once as AnalyzerTimeoutError …`. Restore it.
  6. In `GEMINI_RETRY_CLASSIFIER`, change `if (err instanceof AnalyzerTimeoutError) return 'no-retry';` to `if (err instanceof AnalyzerTimeoutError) return 'idle';`. Expected red: `… > a thinking model silent for 121 s fails with AnalyzerTimeoutError after exactly ONE attempt: no retry warning, no onThrottle` (`expected undefined to match object`: the error surfaces only after a logged, `onThrottle`-announced backoff), and `… > a positive knob value applies to every model …` (called 3 times). This is the N2/N11 regression. Restore it.
  7. Change `geminiThinkingWindowApplies` to `return geminiModelThinks(model);`. Expected red: `… > a positive knob value applies to every model …` (Gemma ends as `GeminiStreamIdleError`, called 3 times). Restore it.
  8. Delete the `if (ceiling.aborted) { … }` block. Expected red: `… > silence past the request ceiling fails as AnalyzerTimeoutError, once, never retried (a thinking model)` and `… > the ceiling also bounds a model that does not think`. Restore it.
  9. Delete the `if (!buf) { thoughtPartsBeforeAnswer += …; }` block. Expected red: `… > logs one timing line per attempt: …` (`thoughtPartsBeforeAnswer=0`) and `… > firstAnswerMs is when the answer text arrived, …`. Restore it.
  10. Replace `firstAnswerMs = Date.now() - requestStartedAt;` with `firstAnswerMs = firstChunkMs;`. Expected red: `… > firstAnswerMs is when the answer text arrived, not the first chunk` (`firstAnswerMs=5000`). Restore it.
  11. Delete the `console.info(…)` call in the `finally`. Expected red: the three log tests. Restore it.
  12. In `registry.ts`, change the thinking knob's `max: 290_000` to `max: 14_400_000`. Expected red: `… > both knobs ship with their bounds and defaults; the thinking window refuses 290 001 ms and says why`. Restore it.
  13. In `classifyAnalysisFailure`, delete the `if (err.reason === 'thinking-idle') { … }` branch. Expected red: `AnalyzerTimeoutError (#3084 wave 2b) > → analyzer-timeout naming the thinking window setting …` (the ceiling copy names the request ceiling). Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/errors.ts server/src/config/registry.ts server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/gemini-transport-thinking.test.ts server/src/analyzer/gemini.test.ts server/.env.example server/src/routes/failure-taxonomy.ts server/src/routes/failure-remediations.ts server/src/routes/failure-taxonomy.test.ts openapi.yaml src/lib/api-types.ts src/data/help-failures.ts src/data/help-failures.test.ts src/data/help-categories.test.ts docs/wiki/Advanced-Settings.md
git commit -m "feat(server,openapi,frontend): bound Gemini's silence before an answer and every request's duration (#3084)"
```

**Tests this task could break:**
- `gemini.test.ts` idle tests (slow; unchanged, as Step 4 explains) and wave 1's transport suites, including `gemini-transport.test.ts` and `transport-retry.test.ts`;
- `failure-taxonomy.test.ts`, `help-failures.test.ts`, `help-categories.test.ts`;
- `src/config/*` (knob guards, `env-example.test.ts`; after #3146 `registry-knob-read.guard.test.ts` requires each knob's read, which the transport has);
- `src/views/help.tsx` consumers (`HELP_FAILURE_ENTRIES`).

### Task 2.9: Reasoning overflow fails instead of splitting

**Files:**
- Modify: `server/src/analyzer/errors.ts` (append `AnalyzerReasoningOverflowError`)
- Modify: `server/src/analyzer/types.ts` (`StageCall.onReasoningOverflow`; `StageCall` is `index.ts:47-85` on 46e62a34, moved verbatim by wave 1 Task 1.5)
- Modify: `server/src/analyzer/runner/stage-runner.ts` (wave 1 Task 1.11's `StageRunner.runSingleAttempt` `catch`: report an overflow through the hook before `return null`)
- Modify: `server/src/analyzer/runner/finish.ts` (`hasReasoningEvidence`; `mapFinish` rewritten so the `'length'` rule runs before Ollama's empty-response check)
- Modify: `server/src/analyzer/transports/ollama-transport.ts` (wave 1 Task 1.8's moved `chat()` body: `reasoningSeen` from `message.thinking`, and each thinking chunk calls `onChunk` with the answer byte count unchanged (P4); the empty-buffer early return logs its truncation)
- Modify: `server/src/routes/failure-taxonomy.ts:29-52` (union), `:98-140` (signature row), `:492-534` (classify branch)
- Modify: `server/src/routes/failure-remediations.ts:94-101` (add after `analyzer-truncated`)
- Modify: `openapi.yaml:7049` (enum), and regenerate `src/lib/api-types.ts`.
- Modify: `src/data/help-failures.ts:28-55`, `:57-81`
- Modify: `server/src/routes/analysis.ts:29` (import), `:2627-2663` (`AnalysisJob.reasoningOverflowed`), before `:2437` (`noteReasoningOverflow`, `buildNonStoryClassifier`), `:4550` (main route, Phase-0 per-chapter catch), `:5685-5689` (main route, Phase-1 pool catch), `:5814-5836` (main route, non-story classifier), `:7149` (subset route, Phase-0 per-chapter catch), `:7540-7566` (subset route, non-story classifier), `:5361-5363` (main route, Phase-1 `stage2Call`: escalation overflow hook), `:7363-7367` (subset route, Phase-1 inline `stageCall`: escalation overflow hook), `:4727-4738` (main route, `runPhase0Pool`'s `launchNextCast`: dispatch check), `:5252-5262` (main route, `runChapter`, after `awaitPhase1Dispatch`: dispatch check), `:7341-7345` (subset route, Phase-1 chapter loop: dispatch check), `:6444-6450` (main route terminal handler — pass `job.reasoningOverflowChapter` to `classifyAnalysisFailure`, F7) and the subset route's equivalent terminal handler (re-locate by the same pattern) — P20 run stop and "stop new spend"
- Modify: `server/src/routes/script-review.ts:40` (import), `:924` (capture variable), `:944-951` (catch), `:972-987` (terminal event) — P20 pass stop
- Modify: `server/src/routes/annotate-emotion.ts:19-20` (imports), `:243-259` (catch) — P20 pass stop
- Modify: `server/src/routes/instruct-annotation.ts` (imports, beside its `DailyQuotaExhaustedError` import), `:242-258` (catch) — P20 pass stop
- Modify: `server/src/analyzer/attribution-eval/review-run.ts:36` (import), `:118-136` (comment and terminal rethrow) — P20 eval stop
- Test:
  - Create: `server/src/analyzer/runner/finish-reasoning-overflow.test.ts`, `server/src/analyzer/transports/ollama-transport-overflow.test.ts`, `server/src/routes/analysis.reasoning-overflow.test.ts`
  - Modify:
    - `server/src/analyzer/runner/finish.test.ts` (wave 1 Task 1.7's `ollama EMPTY length …` case — a deliberate behaviour change, below);
    - `server/src/analyzer/runner/stage-runner.test.ts` (wave 1 Task 1.11; its `../errors.js` import and one escalation case);
    - `server/src/analyzer/dialogue-structure/escalation.test.ts` (imports `:1-12`; a two-window fixture after `buildFlaggedGuessOffWindowFixture`, `:238`; a new `describe` at the end of the file);
    - `server/src/analyzer/stage1-chunk.test.ts` (append to `describe('runStage1ChapterChunked')`);
    - `server/src/analyzer/stage2-chunk.test.ts` (append after `:243`);
    - `server/src/analyzer/gemini.test.ts` (the `GeminiAnalyzer — output truncation (#528)` describe at `:746`);
    - `server/src/analyzer/attribution-eval/review-run.test.ts` (import `:26`; a new case after `(e)`, `:222-244`);
    - `server/src/routes/analysis.phase-model.test.ts` (imports `:13`, `:19`; new `describe`s at the end);
    - `server/src/routes/script-review.test.ts` (a new case after `:411`);
    - `server/src/routes/annotate-emotion.test.ts` and `server/src/routes/instruct-annotation.test.ts` (a new case after each quota case, `:224-240` and `:269-285`);
    - `server/src/routes/failure-taxonomy.test.ts`;
    - `src/data/help-failures.test.ts:13`;
    - `src/data/help-categories.test.ts:24`.

**Interfaces:**
- Consumes:
  - `TransportResult` (with `usage.reasoningTokens` and `reasoningSeen`) and `mapFinish(r, ctx)` (contract);
  - `stripThink(raw): { text; unterminated }` (`runner/parse.ts`, wave 1);
  - `OllamaTransport` (`transports/ollama-transport.ts`, wave 1 Task 1.8), which already returns `finish: doneReason === 'length' ? 'length' : 'stop'` from its empty-buffer early return;
  - `AnalyzerTruncatedError`;
  - `withCopy`.
- Produces:
  - `export function hasReasoningEvidence(r: TransportResult): boolean` (contract);
  - `export class AnalyzerReasoningOverflowError extends Error { readonly code = 'ANALYZER_REASONING_OVERFLOW'; constructor(readonly transport: TransportKind, readonly model: string, readonly reasoningTokens: number | undefined) }` (contract);
  - `StageCall.onReasoningOverflow?: (err: AnalyzerReasoningOverflowError) => void` (`types.ts`, contract). Only `StageRunner.runSingleAttempt` calls it, just before it returns `null` for an overflow;
  - `AnalysisJob.reasoningOverflowError?: AnalyzerReasoningOverflowError` (`analysis.ts`), the first overflow `noteReasoningOverflow` saw. It is set together with the contract's `reasoningOverflowed`, so the chapter pools' dispatch check can rethrow the overflow that marked the job. **Contract addition (reported):** the master plan's contract lists only `reasoningOverflowed`;
  - FailureCode `analyzer-reasoning-overflow`.

**The rule (spec §7, Truncation):**

| `length` finish, and… | Result |
|---|---|
| answer text present, with or without reasoning evidence | `AnalyzerTruncatedError` (the chunk splits, as today) |
| no answer text, no reasoning evidence | `AnalyzerTruncatedError` — keeps the Gemma empty-`MAX_TOKENS` recovery (`gemini.ts:784-804`) |
| no answer text, with reasoning evidence | `AnalyzerReasoningOverflowError` — never splits |

Evidence is `usage.reasoningTokens > 0`, `reasoningSeen`, or an unterminated leading `<think>` block. "No answer text" means `stripThink(r.text).text.trim() === ''`.

The overflow error is not an `AnalyzerTruncatedError`, so both chunkers rethrow it on the first call (`stage1-chunk.ts:175`, `:198`; `stage2-chunk.ts:428`, `:553`), as does script review's force-split (`review-run.ts:99`).

**Gemma keeps its split recovery (P27).** Task 2.7 reports `thoughtsTokenCount` as `usage.reasoningTokens` only on a request that asked for `includeThoughts`, and Gemma never does: it is outside the static thinking rule. A Gemma empty `MAX_TOKENS` therefore has reasoning evidence only if a thought part arrived (`reasoningSeen`). Otherwise it stays `AnalyzerTruncatedError` and splits, even when the response reports a `thoughtsTokenCount`. `gemini.test.ts` pins both sides below (Gemma splits, `gemini-3.6-flash` overflows, on the same response), and register row `E<next+1>` (Task 2.10) checks on a real chapter that the Gemma split still recovers.

**Run stop (P20 — approved by the owner 2026-09-13: stop new spend, with a loud, actionable warning; see F7 and Task 2.9a).** A reasoning overflow is not a size problem. The same engine settings overflow again on the next chapter, and each attempt spends a full output budget on thinking — on `gemini-3.6-flash`, one of its 20 requests a day. The fix is a setting change, so the failure stops new spend — new chapters, escalation windows and non-story classification calls — and its copy names the engine's max-output and reasoning settings, with structured fixes (Task 2.9a) pointing at exactly which one to raise. **Alternative (not chosen):** skip the overflowing chapter and continue, which keeps chapters that fit but can spend a full thinking budget on each chapter that does not. This task is written to the recommendation:
- **Phase 0 (stage 1), main route.** The per-chapter catch rethrows `GeminiContentBlockedError` (`routes/analysis.ts:4550`) instead of recording a chapter failure. It rethrows `AnalyzerReasoningOverflowError` too, marking the job first (below).
- **Phase 0 (stage 1), subset (Retry) route.** The same, at `routes/analysis.ts:7149`.
- **Phase 1 (stage 2)** needs no new catch. `runPhase1Pool`'s pool catch marks the job on an overflow and rethrows the first chapter error, as today (`routes/analysis.ts:5680-5691`), to the job's terminal handler, which classifies it with `classifyAnalysisFailure` and ends the job with that code and copy (`:6444-6450`). The subset route's Phase-1 loop (around `:7215`) has no catch either. A test pins that a stage-2 overflow ends the run.
- **Chapters already in flight finish.** The job is not aborted. Both pools stop launching once a worker throws (`:4727-4738`, `:5680-5691`), and chapters already calling the model finish and write to the cache, so a resume picks up where the run stopped (`:5672-5675`). That includes another phase's model in pipelined mode (`:5700-5708`). Aborting them would discard work a resume must redo. `endJob` aborts nothing (`:3063`), and neither terminal catch changes. Step 1's route test pins that the job's `halted` snapshot and its code survive the late completion (N4).
- **No new spend after the overflow.** A per-job flag stops the calls those in-flight chapters, and the rest of the job, would otherwise still start:
  - **Home:** `AnalysisJob.reasoningOverflowed?: boolean` (`:2627-2663`). It is optional, so every existing job literal still compiles. The gates and the tests read this one field.
  - **Set** by `noteReasoningOverflow(job, structureBudget, err)` where the overflow is first rethrown: the main and subset Phase-0 per-chapter catches (`:4550`, `:7149`) and the main Phase-1 pool catch (`:5685-5689`). The subset route's Phase 1 attributes one chapter at a time (`:7341`) with nothing else in flight, so its rethrow needs no mark. Both routes also call it from `StageCall.onReasoningOverflow` on their Phase-1 `StageCall`, so an escalation overflow that the runner swallows marks the job too (below).
  - **Escalation windows** (up to 120 per chapter and 600 per book, `registry.ts:1335-1362`). The same call empties the book's escalation budget (`structureBudget.remainingWindows = 0`). Every chapter's `attributeChapterStage2` call shares that object (`:3692`, `:5462`; subset `:6805`, `:7361`), and `escalateFlaggedWindows` checks it before each window (`escalation.ts:235`). A chapter still in flight therefore starts no further window, with no change to `escalation.ts`.
  - **Non-story classification** (the swallowing catch at `:5831-5833`). `buildNonStoryClassifier` replaces the two inline classifiers (`:5814-5836`, `:7540-7566`). It returns `false` without a call once the job is marked. When a classification call itself overflows, it marks the job and reads as story, as today's catch does for any Signal-2 hiccup.
  - **New chapters.** An overflow a stage call rethrows stops them through the pool rethrows above, as for a content block. A mark with no rethrow does not: an escalation overflow the runner swallowed marks the job through the hook (below), but the pools stop only on a thrown error, so later chapters would still make stage-2 calls. Every chapter dispatch point that can run after such a mark therefore calls `throwIfReasoningOverflowed(job)` first. On a marked job it rethrows the recorded overflow (`job.reasoningOverflowError`), which ends the run through the same terminal handler a rethrown overflow reaches: code `analyzer-reasoning-overflow`, and a `halted` snapshot. The dispatch points:
    - **Main route, Phase 0:** `runPhase0Pool`'s `launchNextCast`, before each `runCastChapter(i)`. It is reachable only in pipelined mode, where Phase 1 escalates while Phase 0 is still dispatching.
    - **Main route, Phase 1:** `runChapter`, directly after `await watermark.awaitPhase1Dispatch(i);` and its `if (phase0FailedCount > 0) return;`. That is where a Phase-1 chapter actually starts. A check at the top of `launchNext`'s loop would miss a worker already parked on the watermark in pipelined mode. The throw goes through the pool catch, which sets `aborted` as for any chapter error.
    - **Subset route, Phase 1:** the top of the Phase-1 `for (let idx = 0; idx < toRun.length; idx++)` loop.

    The subset route's Phase-0 loop needs no check: it ends before the subset's first escalation call, and its own catch rethrows a stage-1 overflow. Chapters already dispatched are unaffected: they finish and cache.
- **Script review.** `routes/script-review.ts:924-987` captures a content block, stops the pass and sends one terminal `error` event. It does the same for an overflow, with code `analyzer-reasoning-overflow`. Its chunks run one at a time, and it already breaks out on `job.controller.signal.aborted` (`:936`).
- **Emotion and instruct passes.** Each catches per chapter and stops the whole pass on a daily quota (`annotate-emotion.ts:243-259`, `instruct-annotation.ts:242-258`). An overflow takes the same exit, with one terminal `error` event coded `analyzer-reasoning-overflow`. Both run one chapter and one request at a time, so nothing else is in flight.
- **Attribution eval.** `runReviewOverChapter` rethrows abort, quota and content block instead of dropping the chunk (`attribution-eval/review-run.ts:130-136`). It rethrows an overflow too.
- **Escalation still returns `null`, and now reports the overflow.** `StageRunner.runSingleAttempt` (wave 1 Task 1.11) returns `null` for every error its policy does not rethrow, and `GEMINI_RETRY_POLICY.escalationRethrows` stays abort-only, so an overflow from that one bounded call skips its window.
  - **The hook.** The runner swallows the error, so before returning `null` it calls a new optional hook, `StageCall.onReasoningOverflow`. The hook is added to `types.ts` in this task, not in wave 1: wave 1 has no overflow class and must stay behaviour-preserving.
  - **The wiring.** Both routes set the hook on the Phase-1 `StageCall` that `attributeChapterStage2` hands to `escalateFlaggedWindows` (`:2382`): the main route's `stage2Call` (`:5275`) and the subset route's inline `stageCall` (`:7224`). The hook calls `noteReasoningOverflow(job, structureBudget, err)`. The emptied book budget then stops the chapter's remaining windows, and any other in-flight chapter's (`escalation.ts:235`), with no change to `escalation.ts`. The dispatch check (**New chapters**, above) starts no later chapter, so no later stage-2 call is sent either. The `cloud` escalation analyzer gets the same `StageCall`, and `FallbackAnalyzer.runAttributionEscalation` (`index.ts:372-386`) forwards it unchanged.
  - **The tests.** `stage-runner.test.ts` pins the runner half. `escalation.test.ts` pins the runner and the window loop together. `analysis.reasoning-overflow.test.ts` pins the wiring on both routes, and the three dispatch checks: after one escalation overflow, no later chapter is started and the run halts with the overflow code.
  - **Not covered.** The attribution eval builds its own `StageCall` with no job (`attribution-eval/run-eval.ts:175`), so it passes no hook.
- **Timeouts are unchanged.** `AnalyzerTimeoutError` (Task 2.8), including a thinking-window timeout, keeps today's asymmetry, which this task does not touch: Phase 0's per-chapter catch records it as a failed chapter and the run continues (ending `cast_incomplete`), while Phase 1 rethrows it and the run ends with `analyzer-timeout`.

The two rethrown Phase-0 errors reach the same terminal handler, so the run ends with an `error` event whose `code` is `analyzer-reasoning-overflow` and whose `message` is the classified copy below.

The taxonomy's `fatal` flag plays no part in this. Analysis never reads it: the routes use `classifyAnalysisFailure`'s code and copy only. The flag's one reader is generation (`generation-error.ts:34` hands it to `recordNonFatal`, read at `generation.ts:2179-2184`), and generation's `classifyFailure` never matches a `source: 'analysis'` row.

**Ollama ordering — a deliberate change.** On 46e62a34 Ollama checks for an empty buffer before `done_reason` (`ollama.ts:829` throws `Ollama <model> returned an empty response.`; the `length` check is at `:838`), so an empty `done_reason: 'length'` stream fails as a generic empty response and never splits. Wave 1 preserved that order inside `mapFinish` (Task 1.7), while `OllamaTransport` already reports `finish: 'length'` for an empty `length` stream (Task 1.8). This task moves the `'length'` rule ahead of the empty check for every transport, so the table above applies to Ollama uniformly:
- empty `length`, no evidence → `AnalyzerTruncatedError` (0 bytes; the chunk splits);
- empty `length` after non-empty `message.thinking` chunks → `AnalyzerReasoningOverflowError` (`OllamaTransport` now sets `reasoningSeen` from `message.thinking`);
- empty `stop` → still today's `Ollama <model> returned an empty response.`

**Ollama copy names `num_ctx` (P6).** On Ollama the binding limit is the context window, not `num_predict`: `analyzer.ollama.numPredict` defaults to `-1`, "predict until the context window fills" (`resolveNumPredict`, `ollama-settings.ts`; `ollama.ts:283-294` on 46e62a34). So the Ollama overflow copy below tells the user to raise `'Ollama num_ctx'` (`ANALYZER_NUM_CTX`, the knob's label at `registry.ts:956`) and never mentions `num_predict`. The existing `analyzer-truncated` copy (`failure-remediations.ts:94-101`, `failure-taxonomy.ts:526-534`) names `STAGE2_CHUNK_CHAR_BUDGET`, not `num_predict`, and this task leaves it unchanged.

Help counts: Task 2.8 moved them to 24 / 50, so this task takes them to 25 / 51.

- [ ] **Step 1: Write the failing test**

`server/src/analyzer/runner/finish-reasoning-overflow.test.ts`:
```ts
/* #3084 wave 2b — reasoning overflow vs truncation (spec §7). A `length` finish
   with an empty answer and reasoning evidence cannot be fixed by splitting the
   chunk (splitting never shrinks reasoning), so it fails as its own class. With
   no evidence it stays AnalyzerTruncatedError: an empty MAX_TOKENS on a
   non-thinking model (Gemma, gemini.ts:784-804) IS a size problem. */
import { describe, it, expect } from 'vitest';
import { mapFinish, hasReasoningEvidence } from './finish.js';
import { AnalyzerReasoningOverflowError, AnalyzerTruncatedError } from '../errors.js';
import type { TransportResult } from './transport.js';

const ctx = { kind: 'gemini' as const, model: 'gemini-3.6-flash' };
const lengthResult = (over: Partial<TransportResult> = {}): TransportResult => ({
  text: '',
  reasoningSeen: false,
  finish: 'length',
  receivedBytes: 0,
  ...over,
});
const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('mapFinish — reasoning overflow vs truncation (#3084 wave 2b)', () => {
  it('length + empty answer + reasoning tokens → AnalyzerReasoningOverflowError carrying the count', () => {
    const err = thrownBy(() => mapFinish(lengthResult({ usage: { reasoningTokens: 8100 } }), ctx));
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect(err).toMatchObject({ transport: 'gemini', model: 'gemini-3.6-flash', reasoningTokens: 8100 });
  });

  it('length + empty answer + reasoningSeen (thought parts / reasoning deltas) → overflow', () => {
    expect(thrownBy(() => mapFinish(lengthResult({ reasoningSeen: true }), ctx))).toBeInstanceOf(
      AnalyzerReasoningOverflowError,
    );
  });

  it('length + only an unterminated <think> block → overflow', () => {
    const r = lengthResult({ text: '<think>The narrator speaks first, then', receivedBytes: 38 });
    expect(thrownBy(() => mapFinish(r, { kind: 'ollama', model: 'qwen3.5:4b' }))).toBeInstanceOf(
      AnalyzerReasoningOverflowError,
    );
  });

  it('length + empty answer + NO evidence (Gemma empty MAX_TOKENS) → AnalyzerTruncatedError, so the chunk still splits', () => {
    expect(thrownBy(() => mapFinish(lengthResult(), { kind: 'gemini', model: 'gemma-4-31b-it' }))).toBeInstanceOf(
      AnalyzerTruncatedError,
    );
  });

  it('length + whitespace-only answer + no evidence → AnalyzerTruncatedError', () => {
    expect(thrownBy(() => mapFinish(lengthResult({ text: '  \n', receivedBytes: 3 }), ctx))).toBeInstanceOf(
      AnalyzerTruncatedError,
    );
  });

  it('length + partial answer text, even with reasoning evidence → AnalyzerTruncatedError', () => {
    const r = lengthResult({ text: '{"characters":[{"id":"narr', receivedBytes: 26, usage: { reasoningTokens: 500 } });
    expect(thrownBy(() => mapFinish(r, ctx))).toBeInstanceOf(AnalyzerTruncatedError);
  });

  it('the overflow error is NOT an AnalyzerTruncatedError (no chunker may split it)', () => {
    expect(new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 1)).not.toBeInstanceOf(AnalyzerTruncatedError);
  });

  it('a stop finish still returns the answer text', () => {
    const r: TransportResult = { text: '{"ok":true}', reasoningSeen: true, finish: 'stop', receivedBytes: 11, usage: { reasoningTokens: 900 } };
    expect(mapFinish(r, ctx)).toBe('{"ok":true}');
  });
});

describe('hasReasoningEvidence', () => {
  it('is false with zero reasoning tokens and nothing seen', () => {
    expect(hasReasoningEvidence(lengthResult({ usage: { reasoningTokens: 0 } }))).toBe(false);
  });
  it('is true for reasoning tokens or reasoningSeen alone', () => {
    expect(hasReasoningEvidence(lengthResult({ usage: { reasoningTokens: 1 } }))).toBe(true);
    expect(hasReasoningEvidence(lengthResult({ reasoningSeen: true }))).toBe(true);
  });
});
```

`server/src/analyzer/transports/ollama-transport-overflow.test.ts` (real `http.createServer` + real undici `Agent`, per Global Constraints; every case returns before the VRAM sample and GPU-split detection, so the server only ever sees `/api/chat`):
```ts
/* #3084 wave 2b — Ollama's empty `length` stream (spec §7). On 46e62a34 an
   empty buffer was checked before done_reason (ollama.ts:829 vs :838), so an
   empty `length` finish failed as "returned an empty response". The overflow
   rule now applies uniformly: OllamaTransport reports finish 'length' (and
   reasoningSeen from message.thinking) and mapFinish decides. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { OllamaTransport } from './ollama-transport.js';
import { mapFinish } from '../runner/finish.js';
import { AnalyzerReasoningOverflowError, AnalyzerTruncatedError } from '../errors.js';
import type { TransportRequest } from '../runner/transport.js';

const MODEL = 'qwen3.5:4b';
let server: Server | null = null;
const agents: Agent[] = [];

async function serveNdjson(lines: object[]): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const request = (call: TransportRequest['call'] = {}): TransportRequest => ({
  system: 'sys',
  messages: [{ role: 'user', content: 'p' }],
  structuredOutput: { mode: 'json' },
  temperature: 0.2,
  estimatedInputTokens: 10,
  call,
});

async function sendTo(url: string, call: TransportRequest['call'] = {}) {
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });
  agents.push(dispatcher);
  return new OllamaTransport({ url, model: MODEL, dispatcher }).send(request(call));
}

const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

beforeAll(() => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
});
afterAll(() => {
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
});
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.destroy()));
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

describe('Ollama empty `length` stream (#3084 wave 2b)', () => {
  it('empty content, no message.thinking → finish length, and mapFinish splits it (AnalyzerTruncatedError)', async () => {
    const url = await serveNdjson([
      { message: { role: 'assistant', content: '' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' },
    ]);
    const r = await sendTo(url);
    expect(r).toMatchObject({ text: '', finish: 'length', reasoningSeen: false, receivedBytes: 0 });
    const err = thrownBy(() => mapFinish(r, { kind: 'ollama', model: MODEL }));
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).toMatchObject({ engine: 'ollama', reason: 'length', receivedBytes: 0 });
  });

  it('empty content after message.thinking chunks → reasoningSeen, and mapFinish fails it as reasoning overflow', async () => {
    const url = await serveNdjson([
      { message: { role: 'assistant', content: '', thinking: 'The narrator opens the scene, then' }, done: false },
      { message: { role: 'assistant', content: '', thinking: ' Mara answers.' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' },
    ]);
    const onChunk = vi.fn();
    const r = await sendTo(url, { onChunk });
    expect(r).toMatchObject({ text: '', finish: 'length', reasoningSeen: true, receivedBytes: 0 });
    // P4: each thinking chunk feeds the heartbeat with the answer byte count unchanged.
    expect(onChunk).toHaveBeenCalledTimes(2);
    for (const [info] of onChunk.mock.calls) expect(info).toMatchObject({ receivedBytes: 0, receivedText: '' });
    const err = thrownBy(() => mapFinish(r, { kind: 'ollama', model: MODEL }));
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect(err).toMatchObject({ transport: 'ollama', model: MODEL, reasoningTokens: undefined });
  });

  it('empty content on a `stop` stream is still the empty-response error', async () => {
    const url = await serveNdjson([{ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }]);
    const r = await sendTo(url);
    expect(r).toMatchObject({ text: '', finish: 'stop', receivedBytes: 0 });
    const err = thrownBy(() => mapFinish(r, { kind: 'ollama', model: MODEL }));
    expect(err).not.toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).not.toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect((err as Error).message).toBe(`Ollama ${MODEL} returned an empty response.`);
  });
});
```

In `server/src/analyzer/runner/finish.test.ts` (wave 1 Task 1.7), replace the whole `it('ollama EMPTY length is still the empty-response Error (emptiness is checked before done_reason)', …)` case with:
```ts
  it('ollama EMPTY length with no reasoning evidence is truncation with 0 bytes, not the empty-response Error (#3084 wave 2)', () => {
    const err = thrown(() => mapFinish(res({ finish: 'length', finishReason: 'length' }), OLLAMA));
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).toMatchObject({ engine: 'ollama', reason: 'length', receivedBytes: 0, outputTokens: undefined });
  });
```
Wave 1's `ollama empty stop throws the empty-response Error` case stays as it is.

Append to `describe('runStage1ChapterChunked', …)` in `server/src/analyzer/stage1-chunk.test.ts`. Add `AnalyzerReasoningOverflowError` to its `./errors.js` import.
```ts
  it('does NOT split on AnalyzerReasoningOverflowError — splitting cannot shrink reasoning (#3084)', async () => {
    const err = new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100);
    const callForBody = vi.fn(async (_subBody: string): Promise<{ characters: CharacterOutput[] }> => {
      throw err;
    });
    await expect(
      runStage1ChapterChunked({ body: bodyOfParas(6, 200), charBudget: 9000, callForBody, mergeRosters }),
    ).rejects.toBe(err);
    expect(callForBody).toHaveBeenCalledTimes(1);
  });
```

Append after `server/src/analyzer/stage2-chunk.test.ts:243`, inside the same `describe`. Add `AnalyzerReasoningOverflowError` to its `./errors.js` import.
```ts
  it('does NOT split on AnalyzerReasoningOverflowError — splitting cannot shrink reasoning (#3084)', async () => {
    const err = new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100);
    const call = vi.fn(async (_subBody: string, _preceding: string | null): Promise<{ sentences: SentenceOutput[] }> => {
      throw err;
    });
    await expect(
      runStage2ChapterChunked({ body: makeBody(10), charBudget: 10_000, coverageRetries: 1, callForBody: call }),
    ).rejects.toBe(err);
    expect(call).toHaveBeenCalledTimes(1);
  });
```

Append inside `describe('GeminiAnalyzer — output truncation (#528)', …)` in `server/src/analyzer/gemini.test.ts`:
```ts
  it('an empty MAX_TOKENS response WITH thoughtsTokenCount fails as reasoning overflow — no split, no retry (#3084)', async () => {
    generateContentStream.mockResolvedValue(
      asyncFromArray([
        { text: undefined, candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { thoughtsTokenCount: 50 } },
      ]),
    );
    const { GeminiAnalyzer } = await import('./gemini.js');
    const { AnalyzerReasoningOverflowError } = await import('./errors.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-3.6-flash' });
    await expect(analyzer.runStage1('m_overflow', '# stage 1 prompt', {})).rejects.toBeInstanceOf(
      AnalyzerReasoningOverflowError,
    );
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it('an empty MAX_TOKENS response with NO reasoning evidence still raises AnalyzerTruncatedError (Gemma size problem, gemini.ts:784-804)', async () => {
    generateContentStream.mockResolvedValue(
      asyncFromArray([{ text: undefined, candidates: [{ finishReason: 'MAX_TOKENS' }] }]),
    );
    const { GeminiAnalyzer } = await import('./gemini.js');
    const { AnalyzerTruncatedError } = await import('./errors.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemma-4-31b-it' });
    await expect(analyzer.runStage1('m_overflow_gemma', '# stage 1 prompt', {})).rejects.toBeInstanceOf(
      AnalyzerTruncatedError,
    );
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it('a Gemma empty MAX_TOKENS response WITH thoughtsTokenCount but no thought parts still splits — Gemma asked for no thoughts, so the count is not evidence (#3084 P27)', async () => {
    /* The same response the gemini-3.6-flash case above fails as an overflow. */
    generateContentStream.mockResolvedValue(
      asyncFromArray([
        { text: undefined, candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { thoughtsTokenCount: 50 } },
      ]),
    );
    const { GeminiAnalyzer } = await import('./gemini.js');
    const { AnalyzerTruncatedError } = await import('./errors.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemma-4-31b-it' });
    await expect(analyzer.runStage1('m_overflow_gemma_tokens', '# stage 1 prompt', {})).rejects.toBeInstanceOf(
      AnalyzerTruncatedError,
    );
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });
```
In that file's top-level `afterAll`, add:
```ts
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_overflow-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_overflow_gemma-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_overflow_gemma_tokens-stage1.md'), { force: true });
```

In `server/src/routes/failure-taxonomy.test.ts`:
- **Sorted list.** Add `'analyzer-reasoning-overflow',` to the list at `:402-426`.
- **Import.** Add `AnalyzerReasoningOverflowError` to the `../analyzer/errors.js` import.
- **New tests.** Append:
```ts
describe('AnalyzerReasoningOverflowError (#3084 wave 2b)', () => {
  it('→ analyzer-reasoning-overflow: userMessage is the what-happened headline only, remediation names the setting (#3084 F7)', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      'Gemini (gemini-3.6-flash)',
    );
    expect(r.code).toBe('analyzer-reasoning-overflow');
    expect(r.userMessage).toContain('Gemini (gemini-3.6-flash)');
    expect(r.detail).toContain('reasoningTokens=8100');
    // #3084 F7 — no "raise X" advice or "then retry" in userMessage; that
    // lives in remediation instead, which is static (per-code, not
    // per-instance) so it names the setting but not this chapter.
    expect(r.userMessage).not.toContain('Gemini max output tokens');
    expect(r.userMessage).not.toContain('retry');
    expect(r.remediation).toContain('Gemini max output tokens');
    // #3084 F2/#13 — no wave-5-only "reasoning level" control promised yet.
    expect(r.userMessage).not.toContain('reasoning level');
    expect(r.remediation).not.toContain('reasoning level');
    // #3084 F7 — the remediation step list ends with this sentence verbatim.
    expect(r.remediation.endsWith('Then resume — finished chapters are kept.')).toBe(true);
    // #3084 F7 — no chapter was passed, so the message never invents one.
    expect(r.userMessage).toContain('a chapter');
    expect(r.userMessage).not.toMatch(/chapter\s+"|chapter\s+\d/);
  });

  it('names the chapter by title when the caller passes one (#3084 F7)', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      'Gemini (gemini-3.6-flash)',
      { chapter: { id: 4, title: 'The Long Night' } },
    );
    expect(r.userMessage).toContain('chapter "The Long Night"');
    expect(r.detail).toContain('chapterId=4');
  });

  it('falls back to the bare chapter id when no title was passed (#3084 F7)', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      'Gemini (gemini-3.6-flash)',
      { chapter: { id: 7 } },
    );
    expect(r.userMessage).toContain('chapter 7');
    expect(r.detail).toContain('chapterId=7');
  });

  it('the static remediation names Ollama num_ctx (the binding limit), not num_predict, for an Ollama overflow (#3084 F7)', () => {
    /* #3084 F7 — userMessage is the what-happened headline only (Task 2.9's
       rewrite, this same round); it never names a setting. The setting comes
       from the STATIC remediation (failure-remediations.ts), which is the
       same for every AnalyzerReasoningOverflowError regardless of transport
       or model, so this asserts on remediation, not userMessage. Task 2.9a's
       own test (below, added when it lands `fixes`) additionally asserts the
       Ollama branch's `reasoningOverflowFixes` names `analyzer.ollama.numCtx`
       specifically — that is the per-instance, structured version of this
       same fact; this test is the static, prose version. */
    const r = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', undefined), 'Ollama (qwen3.5:4b)');
    expect(r.userMessage).not.toContain('num_ctx');
    expect(r.userMessage).not.toContain('num_predict');
    expect(r.remediation).toContain('Ollama num_ctx');
    expect(r.remediation).not.toContain('num_predict');
    expect(r.remediation).toContain('ANALYZER_NUM_CTX');
  });

  it('is matched by name in the signature scan', () => {
    expect(classifyAnalysisError(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', undefined)).code).toBe(
      'analyzer-reasoning-overflow',
    );
  });
});
```
- **Help counts.** In `src/data/help-failures.test.ts:13` change `.toBe(24)` to `.toBe(25)`, and in `src/data/help-categories.test.ts:24` change `.toBe(50)` to `.toBe(51)` (Task 2.8 moved them from 23 / 49).

Append to `server/src/routes/analysis.phase-model.test.ts`. Change its `./analysis.js` import (`:13`) to `import { buildNonStoryClassifier, noteReasoningOverflow, runMainAnalyzerJob, runSubsetAnalyzerJob, type AnalysisJob } from './analysis.js';`, and its `../analyzer/errors.js` import (`:19`) to `import { AnalysisAbortedError, AnalyzerReasoningOverflowError, GeminiContentBlockedError } from '../analyzer/errors.js';` (`AnalysisAbortedError` lives in `errors.ts` since wave 1 Task 1.4).
```ts
/* ── Suite: a reasoning overflow ends the run (#3084 P20) ─────────────── */

describe('a reasoning overflow ends the analysis run (#3084 P20)', () => {
  const MODEL = 'gemini-3.6-flash';
  const overflow = () => new AnalyzerReasoningOverflowError('gemini', MODEL, 8100);

  function overflowingPhase0Analyzer(): Analyzer {
    return {
      ...buildSpyPhase0Analyzer(),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        /* Same engine settings, same overflow on every chapter — must reach the
           terminal handler, not a per-chapter chapter-failed. */
        throw overflow();
      },
    };
  }

  function terminalError(events: CapturedEvent[]) {
    return events.find((e) => e.kind === 'error') as (CapturedEvent & { code?: string; message?: string }) | undefined;
  }

  it('stage 1 (Phase 0 cast detection, main route) → terminal analyzer-reasoning-overflow, not a per-chapter grind', async () => {
    const manuscriptId = `test-overflow-stage1-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const job = buildStubJob(manuscriptId);
    const events = attachEventCapture(job);

    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await runMainAnalyzerJob(job, recordRef as never, buildSelection(overflowingPhase0Analyzer(), MODEL), {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      const errorEvent = terminalError(events);
      expect(errorEvent?.code).toBe('analyzer-reasoning-overflow');
      expect(errorEvent?.message).toContain('Gemini max output tokens');
      expect(job.reasoningOverflowed).toBe(true); // P20: the first rethrow marks the job
      expect(job.controller.signal.aborted).toBe(false); // P20: new spend stops; the job is not aborted
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);

  it('stage 2 (Phase 1 attribution) → terminal analyzer-reasoning-overflow', async () => {
    const manuscriptId = `test-overflow-stage2-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    setPhase1Selection(
      buildSelection(
        {
          ...buildSpyPhase1Analyzer(),
          async runStage2Chapter(): Promise<Stage2ChapterOutput> {
            throw overflow();
          },
        },
        MODEL,
      ),
    );
    const job = buildStubJob(manuscriptId);
    const events = attachEventCapture(job);

    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await runMainAnalyzerJob(job, recordRef as never, buildSelection(buildSpyPhase0Analyzer(), 'gemma-phase0-test-model'), {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      const errorEvent = terminalError(events);
      expect(errorEvent?.code).toBe('analyzer-reasoning-overflow');
      expect(errorEvent?.message).toContain('Gemini max output tokens');
      expect(job.reasoningOverflowed).toBe(true); // P20: the first rethrow marks the job
      expect(job.controller.signal.aborted).toBe(false); // P20: new spend stops; the job is not aborted
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);

  it('stage 1 on the subset (Retry) route → terminal analyzer-reasoning-overflow', async () => {
    const manuscriptId = `test-overflow-subset-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    /* No cached stage 1, so the subset route runs Phase 0 (cast detection)
       through its own per-chapter catch (routes/analysis.ts:7144-7155). */
    await clearAnalysisCache(manuscriptId);
    const job = { ...buildStubJob(manuscriptId), kind: 'subset', subsetChapterIds: [1, 2] } as unknown as AnalysisJob;
    const events = attachEventCapture(job);

    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await runSubsetAnalyzerJob(
        job,
        recordRef as never,
        buildSelection(overflowingPhase0Analyzer(), MODEL),
        buildSelection(buildSpyPhase1Analyzer(), 'gemini-phase1-test-model'),
        recordRef.chapterHints,
        false,
      );

      expect(terminalError(events)?.code).toBe('analyzer-reasoning-overflow');
      expect(job.reasoningOverflowed).toBe(true); // P20: the subset Phase-0 catch marks the job
      expect(job.controller.signal.aborted).toBe(false);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 60_000);
});

/* ── Suite: "stop new spend" helpers (#3084 P20) ─────────────────────── */

describe('noteReasoningOverflow (#3084 P20)', () => {
  it('marks the job and empties the book escalation budget for a reasoning overflow only', () => {
    const job = buildStubJob('m-note-overflow');
    const budget = { remainingWindows: 600 };
    expect(noteReasoningOverflow(job, budget, new Error('503'))).toBe(false);
    expect(job.reasoningOverflowed).toBeUndefined();
    expect(budget.remainingWindows).toBe(600);
    expect(noteReasoningOverflow(job, budget, new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100))).toBe(true);
    expect(job.reasoningOverflowed).toBe(true);
    expect(budget.remainingWindows).toBe(0);
  });

  it('records the chapter it was told about (#3084 F7)', () => {
    const job = buildStubJob('m-note-overflow-chapter');
    const budget = { remainingWindows: 600 };
    noteReasoningOverflow(
      job,
      budget,
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      { id: 4, title: 'The Long Night' },
    );
    expect(job.reasoningOverflowChapter).toEqual({ id: 4, title: 'The Long Night' });
  });

  it('keeps the FIRST overflow chapter, like reasoningOverflowError, even when a later call names a different one', () => {
    const job = buildStubJob('m-note-overflow-first-wins');
    const budget = { remainingWindows: 600 };
    noteReasoningOverflow(
      job,
      budget,
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      { id: 4, title: 'The Long Night' },
    );
    noteReasoningOverflow(
      job,
      budget,
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 4200),
      { id: 5, title: 'The Fen' },
    );
    expect(job.reasoningOverflowChapter).toEqual({ id: 4, title: 'The Long Night' });
  });

  it('leaves reasoningOverflowChapter undefined when no chapter is passed', () => {
    const job = buildStubJob('m-note-overflow-no-chapter');
    const budget = { remainingWindows: 600 };
    noteReasoningOverflow(job, budget, new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', undefined));
    expect(job.reasoningOverflowChapter).toBeUndefined();
  });
});

describe('buildNonStoryClassifier — no non-story call after a reasoning overflow (#3084 P20)', () => {
  const chapter = (id: number) => ({ id, title: `Chapter ${id}`, body: 'An essay on the author.' });
  type NonStoryFn = NonNullable<Analyzer['runNonStoryClassification']>;
  const build = (job: AnalysisJob, budget: { remainingWindows: number }, run: ReturnType<typeof vi.fn>) =>
    buildNonStoryClassifier({
      job,
      structureBudget: budget,
      analyzer: { ...buildSpyPhase1Analyzer(), runNonStoryClassification: run as unknown as NonStoryFn },
      manuscriptId: job.manuscriptId,
      bookTitle: null,
      bookLanguage: 'en',
    })!;

  it('a classification call that overflows marks the job, reads as story, and no later chapter is classified', async () => {
    const run = vi.fn(async () => {
      throw new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100);
    });
    const job = buildStubJob('m-nonstory-overflow');
    const budget = { remainingWindows: 600 };
    const classify = build(job, budget, run);
    await expect(classify(chapter(1))).resolves.toBe(false);
    await expect(classify(chapter(2))).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(job.reasoningOverflowed).toBe(true);
    expect(budget.remainingWindows).toBe(0);
    // #3084 F7 — the classifier knows which chapter it was calling for (chapter 1's run).
    expect(job.reasoningOverflowChapter).toEqual({ id: 1, title: 'Chapter 1' });
  });

  it('a job already marked by an overflow elsewhere makes no classification call', async () => {
    const run = vi.fn(async () => ({ nonStory: true }));
    const job: AnalysisJob = { ...buildStubJob('m-nonstory-marked'), reasoningOverflowed: true };
    await expect(build(job, { remainingWindows: 0 }, run)(chapter(1))).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('with no overflow it classifies each chapter, and any other failure still reads as story (unchanged behaviour)', async () => {
    const run = vi.fn().mockResolvedValueOnce({ nonStory: true }).mockRejectedValueOnce(new Error('503'));
    const job = buildStubJob('m-nonstory-plain');
    const classify = build(job, { remainingWindows: 600 }, run);
    await expect(classify(chapter(1))).resolves.toBe(true);
    await expect(classify(chapter(2))).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(job.reasoningOverflowed).toBeUndefined();
  });

  it('an abort still propagates', async () => {
    const run = vi.fn(async () => {
      throw new AnalysisAbortedError('paused');
    });
    await expect(build(buildStubJob('m-nonstory-abort'), { remainingWindows: 600 }, run)(chapter(1))).rejects.toBeInstanceOf(
      AnalysisAbortedError,
    );
  });

  it('is undefined for an analyzer with no non-story classification', () => {
    expect(
      buildNonStoryClassifier({
        job: buildStubJob('m-nonstory-none'),
        structureBudget: { remainingWindows: 600 },
        analyzer: buildSpyPhase1Analyzer(),
        manuscriptId: 'm-nonstory-none',
        bookTitle: null,
        bookLanguage: 'en',
      }),
    ).toBeUndefined();
  });
});
```

Create `server/src/routes/analysis.reasoning-overflow.test.ts`. It needs a real workspace book: `endJob` persists the terminal snapshot only through a verified book directory (`persistTerminalSnapshot`, `analysis.ts:2875`), so `analysis.phase-model.test.ts`'s `bookDir: null` stub cannot show it. The harness follows `analysis.rename-midrun.test.ts:14-296`.
```ts
/* #3084 wave 2b, P20 — "stop new spend" after a reasoning overflow, driven
   through runMainAnalyzerJob against a real workspace book (the harness of
   analysis.rename-midrun.test.ts: a tmpdir workspace, the analyzer/GPU mocks,
   lazy imports). A stage-2 overflow in chapter 2 ends the run while chapter 1
   is still calling the model. Chapter 1 must still finish and cache for resume
   (the pools' design, analysis.ts:5672-5675), must start no escalation window,
   and its late completion must not overwrite the job's terminal `halted`
   snapshot or its code (N4).

   The deterministic structure engine stays ON (its default): the untagged
   quoted line below flags a crossExamine window, which is what sends a chapter
   to escalation (analysis.rename-midrun.test.ts:78-83). The positive control
   proves this fixture reaches escalation at all, so "no escalation call" in
   the overflow case cannot pass vacuously. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { AnalysisJob } from './analysis.js';

const { detectOllamaDeviceMock, setLastKnownAnalyzerDeviceMock } = vi.hoisted(() => ({
  detectOllamaDeviceMock: vi.fn(async (): Promise<'cuda' | 'cpu' | 'unknown'> => 'cuda'),
  setLastKnownAnalyzerDeviceMock: vi.fn(),
}));
vi.mock('./ollama-health.js', () => ({ detectOllamaDevice: detectOllamaDeviceMock }));
vi.mock('../gpu/analyzer-device-state.js', () => ({
  setLastKnownAnalyzerDevice: setLastKnownAnalyzerDeviceMock,
}));
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as Record<string, unknown>;
      if (opts.phase === 'phase1' && g.__overflow_spend_test_phase1_selection) {
        return g.__overflow_spend_test_phase1_selection;
      }
      return actual.selectAnalyzerForPhase(opts as Parameters<typeof actual.selectAnalyzerForPhase>[0]);
    },
    /* Sequential mode, unless a case sets __overflow_spend_test_pipelined: the
       Phase-0 dispatch check is reachable only in pipelined mode (P20). */
    isPerPhaseModelSelectionActive: () =>
      (globalThis as Record<string, unknown>).__overflow_spend_test_pipelined === true,
  };
});

const AUTHOR = 'Overflow Spend Author';
const SERIES = 'Standalones';
const MODEL = 'gemini-3.6-flash';
/* Untagged quoted dialogue. The evidence quote verbatim-matches each body, so
   Phase 0b keeps `nova`; the missing dialogue tag leaves a window crossExamine
   flags for escalation. Chapter 3 is used only by the pipelined Phase-0 case. */
const BODIES: Record<number, string> = {
  1: '"The plan is set." Silence followed.',
  2: '"The plan is set." Nobody moved.',
  3: '"The plan is set." Nobody spoke.',
};
const CHAPTER_TITLES: Record<number, string> = { 1: 'Chapter One', 2: 'Chapter Two', 3: 'Chapter Three' };

let workspaceRoot: string;
const originalConcurrency = process.env.ANALYZER_OLLAMA_CONCURRENCY;
const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-overflow-spend-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Both pools size from analyzerPoolWidth() (analysis.ts:1282-1285): 2 puts
     both chapters in flight at once. */
  process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
  process.env.STAGE2_COVERAGE_RETRIES = '0';
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  restoreEnv('ANALYZER_OLLAMA_CONCURRENCY', originalConcurrency);
  restoreEnv('STAGE2_COVERAGE_RETRIES', originalCoverageRetries);
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection;
  delete (globalThis as Record<string, unknown>).__overflow_spend_test_pipelined;
});

function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return { analyzer, engine: 'gemini', model, fallbackModel: null };
}

function stage2For(chapterId: number): Stage2ChapterOutput {
  return {
    sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: BODIES[chapterId] }],
  };
}

function stubAnalyzer(over: Partial<Analyzer>): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    async runStage2Chapter(_m: string, chapterId: number): Promise<Stage2ChapterOutput> {
      return stage2For(chapterId);
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
    ...over,
  };
}

/** A workspace book (chapters 1 and 2 unless `chapterIds` says otherwise), its ManuscriptRecord, a main job and the Phase-0 selection. */
async function seedBook(label: string, chapterIds: readonly number[] = [1, 2]): Promise<{
  manuscriptId: string;
  bookDir: string;
  job: AnalysisJob;
  phase0Selection: AnalyzerSelection;
}> {
  const manuscriptId = `test-overflow-spend-${label}-${Date.now()}-${Math.random()}`;
  const title = `Overflow Spend ${label}`;
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  rmSync(bookDir, { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  const { makeBookId } = await import('../workspace/paths.js');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: makeBookId(AUTHOR, SERIES, title),
      manuscriptId,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      language: 'en',
      chapters: chapterIds.map((id) => ({
        id,
        title: CHAPTER_TITLES[id],
        slug: `0${id}-${CHAPTER_TITLES[id].toLowerCase().replace(' ', '-')}`,
      })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, 'manuscript.md'),
    chapterIds.map((id) => `# ${CHAPTER_TITLES[id]}\n\n${BODIES[id]}\n`).join('\n'),
  );

  const { putManuscript } = await import('../store/manuscripts.js');
  putManuscript({
    manuscriptId,
    format: 'plaintext',
    title,
    wordCount: 12,
    byteSize: 100,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterIds.map((id) => BODIES[id]).join('\n\n'),
    chapterHints: chapterIds.map((id) => ({ id, title: CHAPTER_TITLES[id], body: BODIES[id] })),
    bookDir,
  });

  const phase0Analyzer = stubAnalyzer({
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      return {
        characters: [
          { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'The plan is set.' }] },
        ],
      };
    },
    runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
  });

  const job = {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind: 'main',
    bookDir,
    engine: 'gemini',
    replay: {
      logs: [],
      lastPhase: null,
      lastEta: null,
      lastCastUpdate: null,
      failedByChapterId: new Map(),
      lastSeriesPrior: null,
      warnings: new Map(),
    },
    lastDiskWriteAt: 0,
  } as unknown as AnalysisJob;

  return { manuscriptId, bookDir, job, phase0Selection: buildSelection(phase0Analyzer, 'phase0-model') };
}

interface CapturedEvent {
  kind: string;
  code?: string;
  [k: string]: unknown;
}

function captureEvents(job: AnalysisJob, onError?: () => void): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  const keepAlive = setInterval(() => {}, 100_000);
  clearInterval(keepAlive);
  job.subscribers.add({
    send: (payload: unknown) => {
      const ev = payload as CapturedEvent;
      events.push(ev);
      if (ev.kind === 'error') onError?.();
    },
    res: { end: () => {} } as unknown as import('express').Response,
    keepAlive,
  });
  return events;
}

describe('a reasoning overflow stops new spend, not work already in flight (#3084 P20, N4)', () => {
  it('positive control: with no overflow, this fixture reaches attribution escalation', async () => {
    const seed = await seedBook('control');
    const escalate = vi.fn(async () => null);
    (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = buildSelection(
      stubAnalyzer({ runAttributionEscalation: escalate }),
      MODEL,
    );
    const { runMainAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, seed.phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      /* If this fails, the fixture no longer flags a window: fix the fixture
         before trusting the overflow case's "no escalation call". */
      expect(escalate).toHaveBeenCalled();
    } finally {
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }, 30_000);

  it('after a stage-2 overflow in chapter 2, chapter 1 (already calling the model) finishes and caches, starts no escalation window, and the halted snapshot keeps its code (P20, N4)', async () => {
    const seed = await seedBook('overflow');
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const escalate = vi.fn(async () => null);
    let markChapterOneInFlight!: () => void;
    const chapterOneInFlight = new Promise<void>((resolve) => {
      markChapterOneInFlight = resolve;
    });
    let markRunEnded!: () => void;
    const runEnded = new Promise<void>((resolve) => {
      markRunEnded = resolve;
    });
    (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = buildSelection(
      stubAnalyzer({
        runAttributionEscalation: escalate,
        async runStage2Chapter(_m: string, chapterId: number, _p: string, _call: StageCall): Promise<Stage2ChapterOutput> {
          if (chapterId === 2) {
            await chapterOneInFlight;
            throw new AnalyzerReasoningOverflowError('gemini', MODEL, 8100);
          }
          markChapterOneInFlight();
          /* Chapter 1's model call returns only after the run has ended on chapter 2's overflow. */
          await runEnded;
          return stage2For(1);
        },
      }),
      MODEL,
    );
    const events = captureEvents(seed.job, markRunEnded);
    const { runMainAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache, loadAnalysisCache } = await import('../store/analysis-cache.js');
    const { analysisStateJsonPath } = await import('../workspace/paths.js');
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, seed.phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      /* The run ended on the overflow while chapter 1 was still in flight. */
      expect(events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
      expect(seed.job.reasoningOverflowed).toBe(true);
      // #3084 F7 — end to end through the real Phase-1 pool catch, not just the unit helper.
      expect(seed.job.reasoningOverflowChapter).toEqual({ id: 2, title: 'Chapter Two' });
      // #3084 F7 — the terminal handler passed that chapter to classifyAnalysisFailure,
      // so the SSE error's message names it by title rather than saying "a chapter".
      expect(events.find((e) => e.kind === 'error')!.message).toContain('chapter "Chapter Two"');

      /* P20 — chapter 1 still finishes and caches for resume. */
      await vi.waitFor(
        async () => expect((await loadAnalysisCache(seed.manuscriptId)).chapters[1]).toBeDefined(),
        { timeout: 10_000, interval: 50 },
      );
      /* P20 — but it started no escalation window, and nothing aborted the job. */
      expect(escalate).not.toHaveBeenCalled();
      expect(seed.job.controller.signal.aborted).toBe(false);
      expect(events.some((e) => e.kind === 'result')).toBe(false);

      /* N4 — read the persisted snapshot, not only the first event: chapter 1's
         late completion must not overwrite the terminal state or its code.
         endJob's snapshot write is fire-and-forget. */
      await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(analysisStateJsonPath(seed.bookDir))).toBe(true);
      expect(JSON.parse(readFileSync(analysisStateJsonPath(seed.bookDir), 'utf8'))).toMatchObject({
        state: 'halted',
        haltCode: 'analyzer-reasoning-overflow',
      });
    } finally {
      markRunEnded();
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }, 30_000);

  it('a direct stage-2 overflow on the subset (Retry) route names its chapter — no catch existed for this before (#3084 F7)', async () => {
    /* #3084 F7 — runSubsetAnalyzerJob's real signature at 46e62a34
       (analysis.ts:6746-6752): (job, record, selection, phase1Selection,
       toRun, allowStage1ShrinkSubset). Unlike runMainAnalyzerJob, it takes
       phase1Selection as a direct parameter (phase1Analyzer =
       phase1Selection.analyzer at :6799), so the stub goes there — no
       __overflow_spend_test_phase1_selection global hook needed here; that
       hook exists only for the main-route tests above, whose
       runMainAnalyzerJob resolves phase 1's selection internally. */
    const seed = await seedBook('subset-overflow', [1, 2]);
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runSubsetAnalyzerJob } = await import('./analysis.js');
    const record = getManuscript(seed.manuscriptId)!;
    const subsetJob = { ...seed.job, kind: 'subset' as const };
    const phase1Selection = buildSelection(
      stubAnalyzer({
        async runStage2Chapter(_m: string, chapterId: number, _p: string, _call: StageCall): Promise<Stage2ChapterOutput> {
          if (chapterId === 2) throw new AnalyzerReasoningOverflowError('gemini', MODEL, 8100);
          return stage2For(1);
        },
      }),
      MODEL,
    );
    const events = captureEvents(subsetJob, () => {});
    try {
      await runSubsetAnalyzerJob(
        subsetJob,
        record,
        seed.phase0Selection,
        phase1Selection,
        record.chapterHints, // toRun: both seeded chapters, matching seedBook('subset-overflow', [1, 2])
        false, // allowStage1ShrinkSubset
      );
      expect(events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
      // Before this task's fix, the subset route's Phase-1 loop had no catch
      // at all around attributeChapterStage2WithEval, so this throw reached
      // the terminal handler with reasoningOverflowChapter still unset.
      expect(subsetJob.reasoningOverflowChapter).toEqual({ id: 2, title: 'Chapter Two' });
      expect(events.find((e) => e.kind === 'error')!.message).toContain('chapter "Chapter Two"');
    } finally {
      removeManuscript(seed.manuscriptId);
    }
  }, 30_000);

  /* #3084 P20 — an escalation call that overflows is swallowed inside
     StageRunner.runSingleAttempt (it returns null), which first reports it
     through StageCall.onReasoningOverflow. These stubs honour that contract
     (stage-runner.test.ts and escalation.test.ts pin the runner half), so the
     cases below prove the ROUTE passes the hook and that the hook stops every
     later window. Pool width 1 runs the two chapters one after the other, so
     the first escalation call is the only one in flight when it overflows. */
  async function runEscalationCase(
    route: 'main' | 'subset',
    overflow: boolean,
  ): Promise<{
    escalate: ReturnType<typeof vi.fn>;
    stage2: ReturnType<typeof vi.fn>;
    job: AnalysisJob;
    events: CapturedEvent[];
    bookDir: string;
  }> {
    const seed = await seedBook(`esc-${route}-${overflow ? 'overflow' : 'control'}`);
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const escalate = vi.fn(async (_m: string, _chapterId: number, _w: number, _p: string, call: StageCall) => {
      if (overflow) call.onReasoningOverflow?.(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100));
      return null;
    });
    const stage2 = vi.fn(async (_m: string, chapterId: number): Promise<Stage2ChapterOutput> => stage2For(chapterId));
    const phase1Selection = buildSelection(stubAnalyzer({ runAttributionEscalation: escalate, runStage2Chapter: stage2 }), MODEL);
    const { runMainAnalyzerJob, runSubsetAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
    try {
      const record = getManuscript(seed.manuscriptId)!;
      if (route === 'main') {
        (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = phase1Selection;
        const events = captureEvents(seed.job);
        await runMainAnalyzerJob(seed.job, record as never, seed.phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });
        return { escalate, stage2, job: seed.job, events, bookDir: seed.bookDir };
      }
      /* No cached stage 1: the subset route runs Phase 0 itself, then attributes
         chapters 1 and 2 one at a time with its own inline Phase-1 StageCall. */
      const job = { ...seed.job, kind: 'subset', subsetChapterIds: [1, 2] } as unknown as AnalysisJob;
      const events = captureEvents(job);
      await runSubsetAnalyzerJob(job, record as never, seed.phase0Selection, phase1Selection, record.chapterHints, false);
      return { escalate, stage2, job, events, bookDir: seed.bookDir };
    } finally {
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  for (const route of ['main', 'subset'] as const) {
    it(`${route} route: after one escalation call overflows, no later chapter sends an escalation window (#3084 P20)`, async () => {
      /* Positive control: with no overflow, both chapters send at least one
         window, so "exactly one call" below cannot pass vacuously. */
      const control = await runEscalationCase(route, false);
      expect(new Set(control.escalate.mock.calls.map((c) => c[1]))).toEqual(new Set([1, 2]));
      expect(control.job.reasoningOverflowed).toBeUndefined();

      const { escalate, job } = await runEscalationCase(route, true);
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(job.reasoningOverflowed).toBe(true);
      expect(job.controller.signal.aborted).toBe(false);
    }, 60_000);

    /* #3084 P20 — the dispatch check. An overflow that only escalation saw is swallowed by
       the runner, so no pool rethrow stops the run; the check before each chapter dispatch
       does. Pool width 1: chapter 1 (whose escalation call overflowed) has finished and
       cached before chapter 2 is due. */
    it(`${route} route: after one escalation overflow in chapter 1, chapter 2's stage-2 call is never sent and the run halts with analyzer-reasoning-overflow (#3084 P20)`, async () => {
      /* Positive control: with no overflow, chapter 2's stage-2 call is sent, so "never
         sent" below cannot pass vacuously. */
      const control = await runEscalationCase(route, false);
      expect(new Set(control.stage2.mock.calls.map((c) => c[1]))).toEqual(new Set([1, 2]));

      const { stage2, events, job, bookDir } = await runEscalationCase(route, true);
      const stage2Chapters = stage2.mock.calls.map((c) => c[1]);
      expect(stage2Chapters).toContain(1);
      expect(stage2Chapters).not.toContain(2);
      expect(events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
      expect(events.some((e) => e.kind === 'result')).toBe(false);
      expect(job.controller.signal.aborted).toBe(false);
      /* endJob's snapshot write is fire-and-forget. */
      const { analysisStateJsonPath } = await import('../workspace/paths.js');
      await vi.waitFor(
        () =>
          expect(JSON.parse(readFileSync(analysisStateJsonPath(bookDir), 'utf8'))).toMatchObject({
            state: 'halted',
            haltCode: 'analyzer-reasoning-overflow',
          }),
        { timeout: 5_000, interval: 50 },
      );
    }, 60_000);
  }

  /* #3084 P20 — the Phase-0 dispatch check, reachable only in pipelined mode, where Phase 1
     escalates while Phase 0 is still dispatching cast chapters. Lag 0 and pool width 1:
     Phase 1 chapter 1 starts once Phase 0 chapter 1 completes. Phase 0 chapter 2's cast call
     is held until chapter 1's escalation call has run, so the Phase-0 pool's next dispatch
     (chapter 3) comes after the job is marked. A fail-safe timer opens the hold, so a fixture
     that never reaches escalation fails the control's assertions instead of hanging. */
  async function runPipelinedCase(overflow: boolean): Promise<{
    castCalls: number[];
    escalate: ReturnType<typeof vi.fn>;
    events: CapturedEvent[];
    job: AnalysisJob;
  }> {
    const seed = await seedBook(`pipelined-${overflow ? 'overflow' : 'control'}`, [1, 2, 3]);
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    let openChapterTwoCast!: () => void;
    const chapterTwoCastHeld = new Promise<void>((resolve) => {
      openChapterTwoCast = resolve;
    });
    const failSafe = setTimeout(() => openChapterTwoCast(), 20_000);
    const castCalls: number[] = [];
    const phase0Analyzer = stubAnalyzer({
      async runStage1Chapter(_m: string, chapterId: number): Promise<Stage1ChapterOutput> {
        castCalls.push(chapterId);
        if (chapterId === 2) await chapterTwoCastHeld;
        return {
          characters: [
            { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'The plan is set.' }] },
          ],
        };
      },
      runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
    });
    const escalate = vi.fn(async (_m: string, _chapterId: number, _w: number, _p: string, call: StageCall) => {
      if (overflow) call.onReasoningOverflow?.(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100));
      openChapterTwoCast();
      return null;
    });
    const g = globalThis as Record<string, unknown>;
    g.__overflow_spend_test_phase1_selection = buildSelection(stubAnalyzer({ runAttributionEscalation: escalate }), MODEL);
    g.__overflow_spend_test_pipelined = true;
    const originalMinLag = process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS;
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '0';
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
    const events = captureEvents(seed.job);
    const { runMainAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, buildSelection(phase0Analyzer, 'phase0-model'), {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      /* The run can end on Phase 1's own dispatch check while Phase 0 chapter 2 is still
         finishing. A Phase-0 dispatch the check failed to stop lands after that. */
      await new Promise((r) => setTimeout(r, 500));
      return { castCalls, escalate, events, job: seed.job };
    } finally {
      clearTimeout(failSafe);
      openChapterTwoCast();
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
      restoreEnv('ANALYZER_PHASE1_MIN_LAG_CHAPTERS', originalMinLag);
      delete g.__overflow_spend_test_pipelined;
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  it('pipelined main route: after an escalation overflow, Phase 0 starts no further cast chapter and the run halts with analyzer-reasoning-overflow (#3084 P20)', async () => {
    /* Positive control: with no overflow, the fixture reaches escalation in pipelined mode
       and Phase 0 casts chapter 3, so "never cast" below cannot pass vacuously. */
    const control = await runPipelinedCase(false);
    expect(control.escalate).toHaveBeenCalled();
    expect(control.castCalls).toContain(3);

    const run = await runPipelinedCase(true);
    expect(run.escalate).toHaveBeenCalledTimes(1);
    expect(run.castCalls).not.toContain(3);
    expect(run.events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
    expect(run.job.controller.signal.aborted).toBe(false);
  }, 90_000);
});
```

In `server/src/analyzer/dialogue-structure/escalation.test.ts`, change `:1` to `import { afterAll, describe, expect, it, vi } from 'vitest';` and add after `:12`:
```ts
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerReasoningOverflowError } from '../errors.js';
import { GEMINI_RETRY_POLICY } from '../runner/retry-policy.js';
import { StageRunner, identitySchemaAdapter } from '../runner/stage-runner.js';
import { TransportAnalyzer } from '../runner/transport-analyzer.js';
import type { ChatTransport, TransportRequest, TransportResult } from '../runner/transport.js';
```
Directly after `buildFlaggedGuessOffWindowFixture` (ends `:238`), add:
```ts
/** #3084 P20 — buildFixture's conversation, then a narration paragraph long
    enough to end a window (windows.ts NARRATION_BREAK_LENGTH = 200; this one is
    227 chars), then a second conversation of the same shape. Two windows, each
    with three anchored speakers (so alternation fill never engages) and two
    unanchored lines. */
function buildTwoWindowFixture() {
  const enIdx = buildNameIndex(
    [
      { id: 'anton', name: 'Anton' },
      { id: 'olga', name: 'Olga' },
      { id: 'boris', name: 'Boris' },
    ],
    conventionsFor('en')!,
  );
  const digression = 'The corridor ran on past shuttered doors and cold lamps. '.repeat(4).trim();
  const body = [
    'He waited quietly.',
    '"Ready?" said Anton.',
    '"Ready," said Olga.',
    '"Confirmed," said Boris.',
    '"Then let\'s go."',
    '"After you."',
    digression,
    '"Onward?" said Anton.',
    '"Onward," said Olga.',
    '"Agreed," said Boris.',
    '"Then we part."',
    '"Farewell."',
    'She smiled and walked ahead.',
  ].join('\n');
  const paras = parseChapterStructure(body, enIdx);
  resolveWindows(paras, { anton: 'male', olga: 'female', boris: 'male' }, null);
  const sentences: SentenceOutput[] = [
    { id: 1, chapterId: 1, characterId: 'anton', text: 'Ready?' },
    { id: 2, chapterId: 1, characterId: 'olga', text: 'Ready,' },
    { id: 3, chapterId: 1, characterId: 'boris', text: 'Confirmed,' },
    { id: 4, chapterId: 1, characterId: 'narrator', text: "Then let's go." },
    { id: 5, chapterId: 1, characterId: 'narrator', text: 'After you.' },
    { id: 6, chapterId: 1, characterId: 'anton', text: 'Onward?' },
    { id: 7, chapterId: 1, characterId: 'olga', text: 'Onward,' },
    { id: 8, chapterId: 1, characterId: 'boris', text: 'Agreed,' },
    { id: 9, chapterId: 1, characterId: 'narrator', text: 'Then we part.' },
    { id: 10, chapterId: 1, characterId: 'narrator', text: 'Farewell.' },
  ];
  const alignment = alignSentences(sentences, paras, body);
  const examined = crossExamine(alignment, {
    rosterIds: new Set(ROSTER),
    unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
    alignmentFloorPct: 80,
  });
  // Sanity-check the fixture: the two unanchored lines of each conversation are flagged.
  expect(examined.flags.map((f) => f.index)).toEqual([3, 4, 8, 9]);
  return { body, paras, sentences: examined.sentences, flags: examined.flags };
}
```
At the end of the file, add:
```ts
/* #3084 P20 — an escalation call that overflows still returns null, but the
   runner first reports it through StageCall.onReasoningOverflow. Driven through
   a real TransportAnalyzer + StageRunner over a transport that always
   overflows, so this pins the runner and the window loop together. The hook
   below does to the budget what the route's noteReasoningOverflow does; the
   route wiring is pinned in routes/analysis.reasoning-overflow.test.ts. */
describe('escalateFlaggedWindows — a reasoning overflow stops further windows (#3084 P20)', () => {
  const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'handoff');
  const OVERFLOW_ID = 'm_esc_overflow';

  afterAll(async () => {
    for (const ch of [1, 2]) {
      for (const w of [0, 1]) {
        await rm(resolve(HANDOFF_ROOT, 'inbox', `${OVERFLOW_ID}-stageescalation-ch${ch}-w${w}.md`), { force: true });
      }
    }
  });

  it('positive control: with no overflow, the two-window fixture queries both windows', async () => {
    const { body, paras, sentences, flags } = buildTwoWindowFixture();
    const runFn = vi.fn((_m: string, _c: number, _windowIndex: number) =>
      Promise.resolve<EscalationOutput | null>({ assignments: [] }),
    );
    const analyzer: Analyzer = { ...fakeAnalyzer(() => null), runAttributionEscalation: runFn };

    const outcome = await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    expect(runFn).toHaveBeenCalledTimes(2);
    expect(new Set(runFn.mock.calls.map((c) => c[2])).size).toBe(2);
    expect(outcome.attempted).toBe(2);
  });

  it("one overflowing call stops that chapter's second window and every later chapter's", async () => {
    const send = vi.fn(
      async (_req: TransportRequest): Promise<TransportResult> => ({
        text: '',
        reasoningSeen: true,
        finish: 'length',
        finishReason: 'MAX_TOKENS',
        receivedBytes: 0,
        usage: { reasoningTokens: 8100 },
      }),
    );
    const transport: ChatTransport = { kind: 'gemini', model: 'gemini-3.6-flash', send };
    const analyzer = new TransportAnalyzer(
      new StageRunner({
        transport,
        policy: GEMINI_RETRY_POLICY,
        settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined }),
        adaptSchema: identitySchemaAdapter,
      }),
    );
    const budget = { remainingWindows: 600 };
    const overflows: AnalyzerReasoningOverflowError[] = [];
    const stageCall: StageCall = {
      onReasoningOverflow: (err) => {
        overflows.push(err);
        budget.remainingWindows = 0;
      },
    };

    const chapterOne = buildTwoWindowFixture();
    const first = await escalateFlaggedWindows({
      ...baseOpts(),
      ...chapterOne,
      analyzer,
      manuscriptId: OVERFLOW_ID,
      chapterId: 1,
      stageCall,
      budget,
    });
    const chapterTwo = buildTwoWindowFixture();
    const second = await escalateFlaggedWindows({
      ...baseOpts(),
      ...chapterTwo,
      analyzer,
      manuscriptId: OVERFLOW_ID,
      chapterId: 2,
      stageCall,
      budget,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect(first.attempted).toBe(1);
    expect(second.attempted).toBe(0);
    expect(chapterOne.flags).toHaveLength(4); // the skipped window leaves every flag intact
    expect(chapterTwo.flags).toHaveLength(4);
  });
});
```

Append to `server/src/routes/script-review.test.ts`, directly after the content-block case (`:386-411`) and inside the same `describe`:
```ts
  it('a reasoning overflow fast-fails the whole pass with analyzer-reasoning-overflow — no per-chapter grind (#3084 P20)', async () => {
    /* Same reasoning as the content block above: the same settings overflow
       again on every chunk, each time spending a full output budget on
       thinking, so the FIRST overflow stops the pass with one terminal error. */
    writeBook(SENTENCES);
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    runReview.mockImplementation((): Promise<ScriptReviewOutput> =>
      Promise.reject(new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100)),
    );

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);

    const err = events.find((e) => e.kind === 'error') as
      | { code?: string; message?: string; model?: string; remediation?: string }
      | undefined;
    expect(err?.code).toBe('analyzer-reasoning-overflow');
    expect(err?.model).toBe('gemini-3.6-flash');
    expect(err?.remediation).toContain('Gemini max output tokens');
    expect(events.some((e) => e.kind === 'result')).toBe(false);
    expect(events.some((e) => e.kind === 'chapter-failed')).toBe(false);
  });
```

Append to `server/src/routes/annotate-emotion.test.ts`, directly after the quota case (`:224-240`) and inside the same `describe`:
```ts
  it('a reasoning overflow stops the pass like a daily quota: keeps streamed chapters, one analyzer-reasoning-overflow error, no chapter-failed (#3084 P20)', async () => {
    writeBook(SENTENCES);
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> => {
      if (chapterId === 1) return Promise.resolve({ annotations: [{ sentenceId: 2, emotion: 'angry' }] });
      return Promise.reject(new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100));
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);

    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(true);
    const err = events.find((e) => e.kind === 'error');
    expect(err).toMatchObject({ code: 'analyzer-reasoning-overflow', model: 'gemini-3.6-flash' });
    expect(String(err?.remediation)).toContain('Gemini max output tokens');
    expect(events.some((e) => e.kind === 'chapter-failed')).toBe(false);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
  });
```

Append to `server/src/routes/instruct-annotation.test.ts`, directly after the quota case (`:269-285`) and inside the same `describe`:
```ts
  it('a reasoning overflow stops the pass like a daily quota: keeps streamed chapters, one analyzer-reasoning-overflow error, no chapter-failed (#3084 P20)', async () => {
    writeBook(SENTENCES);
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    runStage3.mockImplementation((_m, chapterId): Promise<Stage3ChapterOutput> => {
      if (chapterId === 1) return Promise.resolve({ annotations: [{ sentenceId: 2, instruct: 'urgent' }] });
      return Promise.reject(new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100));
    });

    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    const events = parseSse(res.text);

    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(true);
    const err = events.find((e) => e.kind === 'error');
    expect(err).toMatchObject({ code: 'analyzer-reasoning-overflow', model: 'gemini-3.6-flash' });
    expect(String(err?.remediation)).toContain('Gemini max output tokens');
    expect(events.some((e) => e.kind === 'chapter-failed')).toBe(false);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
  });
```

In `server/src/analyzer/attribution-eval/review-run.test.ts`, change the `../errors.js` import (`:26`) to `import { AnalyzerReasoningOverflowError, AnalyzerTruncatedError } from '../errors.js';`, and append directly after case `(e)` (`:222-244`, which Task 2.3 already moved onto `capacity: resolveCapacity(…)`), inside the same `describe`:
```ts
  it('(f) rethrows a reasoning overflow instead of dropping the chunk and calling the model again (#3084 P20)', async () => {
    let calls = 0;
    const stub = {
      async runScriptReviewChapter(): Promise<ScriptReviewOutput> {
        calls += 1;
        throw new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100);
      },
    } as unknown as Analyzer;

    await expect(
      runReviewOverChapter({
        analyzer: stub,
        capacity: resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }),
        manuscriptId: MANUSCRIPT_ID,
        chapterId: CHAPTER_ID,
        sentences,
        roster,
        call,
      }),
    ).rejects.toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect(calls).toBe(1);
  });
```

In `server/src/analyzer/runner/stage-runner.test.ts` (wave 1 Task 1.11), add `'m_sr_overflow'` to `IDS`, change its `../errors.js` import to `import { AnalysisAbortedError, AnalyzerReasoningOverflowError } from '../errors.js';`, and append inside `describe('StageRunner (#3084 wave 1)', …)`. The transports below return a raw `TransportResult`; `mapFinish` inside the runner raises the overflow or the truncation:
```ts
  it('single attempt: a reasoning overflow resolves to null and calls onReasoningOverflow once; other failures do not call it (#3084 P20)', async () => {
    const single = { manuscriptId: 'm_sr_overflow', key: 'escalation-ch1-w0' as const, promptMd: 'p', grammarSchema: schema, validationSchema: schema };
    const lengthTransport = (over: Partial<TransportResult>): ChatTransport => ({
      kind: 'gemini',
      model: 'gemini-3.6-flash',
      send: async () => ({ text: '', reasoningSeen: false, finish: 'length', finishReason: 'MAX_TOKENS', receivedBytes: 0, ...over }),
    });

    /* Overflow: an empty answer at the output cap, with reasoning evidence. */
    const onReasoningOverflow = vi.fn();
    const overflowing = lengthTransport({ reasoningSeen: true, usage: { reasoningTokens: 8100 } });
    expect(await makeRunner(overflowing, GEMINI_RETRY_POLICY, JSON_MODE).runSingleAttempt(single, { onReasoningOverflow })).toBeNull();
    expect(onReasoningOverflow).toHaveBeenCalledTimes(1);
    expect(onReasoningOverflow.mock.calls[0][0]).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect(onReasoningOverflow.mock.calls[0][0]).toMatchObject({ model: 'gemini-3.6-flash', reasoningTokens: 8100 });

    /* Every other outcome leaves the hook alone: a swallowed transport error, a
       no-evidence truncation (AnalyzerTruncatedError, also swallowed),
       unparseable text, and an abort (rethrown). */
    const notCalled = vi.fn();
    const call = { onReasoningOverflow: notCalled };
    expect(await makeRunner(new FakeTransport([new Error('boom')]), GEMINI_RETRY_POLICY, JSON_MODE).runSingleAttempt(single, call)).toBeNull();
    expect(await makeRunner(lengthTransport({}), GEMINI_RETRY_POLICY, JSON_MODE).runSingleAttempt(single, call)).toBeNull();
    expect(await makeRunner(new FakeTransport(['not json']), GEMINI_RETRY_POLICY, JSON_MODE).runSingleAttempt(single, call)).toBeNull();
    await expect(
      makeRunner(new FakeTransport([new AnalysisAbortedError('gone')]), GEMINI_RETRY_POLICY, JSON_MODE).runSingleAttempt(single, call),
    ).rejects.toBeInstanceOf(AnalysisAbortedError);
    expect(notCalled).not.toHaveBeenCalled();
  });
```
- [ ] **Step 2: Run it and confirm it fails**
Run:
```
npm --prefix server run test -- src/analyzer/runner/finish-reasoning-overflow.test.ts src/analyzer/runner/finish.test.ts src/analyzer/runner/stage-runner.test.ts src/analyzer/transports/ollama-transport-overflow.test.ts src/analyzer/stage1-chunk.test.ts src/analyzer/stage2-chunk.test.ts src/analyzer/attribution-eval/review-run.test.ts src/routes/failure-taxonomy.test.ts src/routes/analysis.phase-model.test.ts src/routes/script-review.test.ts src/routes/annotate-emotion.test.ts src/routes/instruct-annotation.test.ts --retry=0
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts
```
Expected FAIL:
- `finish.test.ts > … ollama EMPTY length with no reasoning evidence is truncation with 0 bytes…` (received the plain `Error` "Ollama qwen3.5:9b returned an empty response.");
- `ollama-transport-overflow.test.ts`: the file fails to import `AnalyzerReasoningOverflowError`; once that export exists (Step 3's `errors.ts`), `empty content, no message.thinking …` still fails on the empty-response `Error` and `empty content after message.thinking chunks …` fails on `reasoningSeen` (received `false`), until the `finish.ts` and `ollama-transport.ts` edits land;
- every file that imports `AnalyzerReasoningOverflowError`: `does not provide an export named 'AnalyzerReasoningOverflowError'`, or `hasReasoningEvidence is not a function`;
- once `errors.ts` exports the class, the route cases still fail until Step 3's route edits and classify branch land: the main-route stage-1 case ends with code `cast_incomplete` (the Phase-0 catch records chapter failures), the subset stage-1 case ends with a code other than `analyzer-reasoning-overflow`, the stage-2 case lacks the `Gemini max output tokens` copy, and the script-review case emits a `chapter-failed` per chunk and no `error` event;
- `analysis.phase-model.test.ts`: the file fails to import `noteReasoningOverflow` / `buildNonStoryClassifier`; once they exist, the three overflow cases fail their `job.reasoningOverflowed` assertion until the marks land;
- `analysis.reasoning-overflow.test.ts`: the overflow case fails on `job.reasoningOverflowed` (`undefined`), and, with the marks but no emptied budget, on `escalate` being called. Its positive control and its N4 snapshot assertion already pass on today's code; Step 5 proves the snapshot assertion can fail. Both `… route: after one escalation call overflows, no later chapter sends an escalation window` cases fail on `escalate` being called more than once until the route passes the hook; the control run inside each already passes;
- `analysis.reasoning-overflow.test.ts`'s dispatch-check cases: both `… route: after one escalation overflow in chapter 1, chapter 2's stage-2 call is never sent …` cases fail on chapter 2's stage-2 call being sent (the run ends with a `result`, not the overflow error) until the Phase-1 dispatch checks land; `pipelined main route: …` fails on `castCalls` containing 3 until the Phase-0 check lands. The control run inside each already passes on today's code;
- `annotate-emotion.test.ts` and `instruct-annotation.test.ts`: the overflow case gets a `chapter-failed` event and a `result`, and no `error`;
- `review-run.test.ts`: `(f) …` resolves instead of rejecting;
- `stage-runner.test.ts`: `single attempt: a reasoning overflow resolves to null and calls onReasoningOverflow once …` fails to import `AnalyzerReasoningOverflowError`. Once `errors.ts` exports it, the case fails with `expected "spy" to be called 1 times, but got 0 times` until the `stage-runner.ts` edit lands. Its `toBeNull()` already holds, because wave 1 returns `null` for every error its policy does not rethrow;
- `escalation.test.ts`: the file fails to import `AnalyzerReasoningOverflowError`. Once that resolves, `… one overflowing call stops that chapter's second window and every later chapter's` fails with `send` called 4 times until the runner edit lands. Its positive control already passes on today's code;
- slow `gemini.test.ts`'s `a Gemma empty MAX_TOKENS response WITH thoughtsTokenCount but no thought parts still splits …` already passes on Task 2.7's transport. Step 5 proves it can fail;
- `failure-remediations copy module … has exactly one entry per FailureCode`;
- both help counts.
- [ ] **Step 3: Implement**

`server/src/analyzer/errors.ts` (append):
```ts
/* #3084 wave 2 — the model stopped at its OUTPUT cap with no answer text while
   there is evidence it was reasoning (reasoning tokens reported, thought parts
   or reasoning deltas seen, or an unterminated <think> block). Unlike
   AnalyzerTruncatedError this is NOT a size problem: splitting the chunk never
   shrinks reasoning, so no chunker catches it — runner/finish.ts raises it and
   the taxonomy maps it to analyzer-reasoning-overflow, naming the engine's
   max-output and reasoning settings. Deliberately not a subclass of
   AnalyzerTruncatedError. */
export class AnalyzerReasoningOverflowError extends Error {
  readonly code = 'ANALYZER_REASONING_OVERFLOW';
  constructor(
    public readonly transport: TransportKind,
    public readonly model: string,
    public readonly reasoningTokens: number | undefined,
  ) {
    super(
      `${transport} ${model} used its whole output budget on reasoning` +
        (reasoningTokens ? ` (${reasoningTokens} reasoning tokens)` : '') +
        ' and returned no answer — splitting the chunk cannot shrink reasoning.',
    );
    this.name = 'AnalyzerReasoningOverflowError';
  }
}
```

`server/src/analyzer/runner/finish.ts`:
- **Imports.** Add `AnalyzerReasoningOverflowError` to its `../errors.js` import, and `import { stripThink } from './parse.js';`.
- **Evidence helper.** Add:
```ts
/** Reasoning evidence for a completed response (spec §7): reported reasoning
    tokens, or reasoning the transport saw on the wire (Gemini thought parts,
    OpenAI reasoning deltas). The unterminated-<think> signal is read from the
    text in mapFinish. */
export function hasReasoningEvidence(r: TransportResult): boolean {
  return (r.usage?.reasoningTokens ?? 0) > 0 || r.reasoningSeen;
}
```
- **`mapFinish`.** Replace wave 1's whole function body with the version below. The `'length'` rule now runs before Ollama's empty-response check, for every transport. The other outcomes are unchanged: Ollama's non-empty truncation still carries no token count, because `OllamaTransport` sets no `usage`. Gemini's empty `stop` still returns `''`, and only Ollama throws on an empty `stop`.
```ts
export function mapFinish(r: TransportResult, ctx: { kind: TransportKind; model: string }): string {
  if (r.finish === 'blocked') throw new GeminiContentBlockedError(ctx.model, r.blockReason);
  /* #3084 wave 2 — the 'length' rule runs FIRST for every transport (spec §7).
     Wave 1 kept Ollama's pre-extraction order (empty check first; ollama.ts:829
     vs :838 on 46e62a34), which made an empty `length` stream the generic
     empty-response error instead of a split or a reasoning overflow. */
  if (r.finish === 'length') {
    const answer = stripThink(r.text);
    if (answer.text.trim() === '' && (hasReasoningEvidence(r) || answer.unterminated)) {
      throw new AnalyzerReasoningOverflowError(ctx.kind, ctx.model, r.usage?.reasoningTokens);
    }
    throw new AnalyzerTruncatedError(ctx.kind, r.finishReason ?? 'length', r.receivedBytes, r.usage?.outputTokens);
  }
  if (ctx.kind === 'ollama' && !r.text) throw new Error(`Ollama ${ctx.model} returned an empty response.`);
  return r.text;
}
```

`server/src/analyzer/transports/ollama-transport.ts` — edits to wave 1 Task 1.8's moved `chat()` body. The source anchors are the moved lines' positions in `ollama.ts` on 46e62a34; locate each by its text.
- **Evidence flag.** After `let buf = ''; // assembled assistant content` (`:724`), add:
```ts
      /* #3084 wave 2 — reasoning evidence for mapFinish: any non-empty
         message.thinking chunk (a thinking model, or one ignoring think:false). */
      let reasoningSeen = false;
```
- **Line type.** In the `let parsed: { … }` type (`:773-781`), change `message?: { content?: string };` to `message?: { content?: string; thinking?: string };`.
- **Read it.** Directly before `const piece = parsed.message?.content;` (`:807`), add:
```ts
            if (typeof parsed.message?.thinking === 'string' && parsed.message.thinking.length > 0) {
              reasoningSeen = true;
              /* P4 — a thinking chunk is activity. Feed the route heartbeat
                 (analysis.ts:1184, :4417-4423) with the answer byte count
                 unchanged, like Gemini thought-only chunks and OpenAI
                 reasoning deltas. */
              const now = Date.now();
              onChunk?.({
                receivedBytes: buf.length,
                receivedText: buf,
                sinceLastChunkMs: now - lastChunkAt,
                elapsedMs: now - start,
              });
              lastChunkAt = now;
            }
```
  Thinking text never enters `buf`. It calls `onChunk` with the unchanged `buf`, using the same fields and `lastChunkAt` bookkeeping as the answer-piece call at `:811-817`.
- **Returns.** In all three `TransportResult` returns wave 1 wrote (the replacements of `:829-831`, `:838-843` and `:923`), change `reasoningSeen: false` to `reasoningSeen`.
- **Empty-buffer early return.** The `length` finish must win over emptiness here, and the truncation must be logged, as the non-empty path's warn at `:839-841` does. Replace wave 1's `:829-831` replacement with:
```ts
      if (!buf) {
        if (doneReason === 'length') {
          console.warn(`[ollama] output truncated done_reason=length bytes=0 model=${this.model}`);
        }
        return { text: '', reasoningSeen, finish: doneReason === 'length' ? 'length' : 'stop', finishReason: doneReason, receivedBytes: 0 };
      }
```
  This still returns before the VRAM sample (`:846`), split detection (`:854`) and eval timing (`:916`), exactly as wave 1's early return did.

`server/src/routes/failure-taxonomy.ts`:
- **Union.** Add `| 'analyzer-reasoning-overflow'` after `| 'analyzer-truncated'`.
- **Import.** Add `AnalyzerReasoningOverflowError` to the `../analyzer/errors.js` import.
- **Signature row.** Insert after the `analyzer-truncated` row. `fatal: true` mirrors `analyzer-content-blocked`, the other whole-run-fatal analysis failure. The value is inert: nothing on the analysis path reads the flag (see "Run stop" above); the run stops because of the rethrows below.
```ts
  {
    code: 'analyzer-reasoning-overflow',
    fatal: true,
    source: 'analysis',
    matchName: 'AnalyzerReasoningOverflowError',
    match: () => false,
  },
```
- **Signature.** `classifyAnalysisFailure(err: unknown, modelLabel: string): AnalysisFailure` (`failure-taxonomy.ts:492`) gains a third, optional parameter: `classifyAnalysisFailure(err: unknown, modelLabel: string, ctx?: { chapter?: { id: number; title?: string } }): AnalysisFailure`. Every existing call site (the terminal handlers, `failure-taxonomy.test.ts`'s many two-arg calls) keeps compiling unchanged; only the `AnalyzerReasoningOverflowError` branch below reads `ctx`.
- **Classify branch.** Insert after the `AnalyzerTruncatedError` branch of `classifyAnalysisFailure`. On Ollama it names `num_ctx`, the binding limit (P6). F7 — the failure names the chapter when the caller passed one (below, wired from `job.reasoningOverflowChapter`), and never invents one when it did not:
```ts
  if (err instanceof AnalyzerReasoningOverflowError) {
    const chapter = ctx?.chapter;
    const chapterLabel = chapter ? (chapter.title ? `chapter "${chapter.title}"` : `chapter ${chapter.id}`) : 'a chapter';
    /* #3084 F7 — userMessage is the what-happened headline only: naming the
       chapter, model and engine. It carries no "raise X" advice and no
       "then retry" — that imperative lives in remediation instead (below),
       which is per-code, not per-instance, so it cannot itself name the
       chapter; naming happens here. */
    return withCopy(
      'analyzer-reasoning-overflow',
      `${modelLabel} spent its whole output budget reasoning on ${chapterLabel} and returned no answer, so the analysis stopped.`,
      `transport=${err.transport} model=${err.model}${chapter ? ` chapterId=${chapter.id}` : ''}${err.reasoningTokens ? ` reasoningTokens=${err.reasoningTokens}` : ''}`,
    );
  }
```

`server/src/routes/failure-remediations.ts`, inserted after `'analyzer-truncated'`:
```ts
  'analyzer-reasoning-overflow': {
    userMessage:
      'The analyzer model spent its whole output budget reasoning and returned no answer, so the analysis ' +
      'stopped: the same settings would overflow again on every chapter, and splitting never shrinks reasoning.',
    /* #3084 F7 — a step list, ending in the sentence F7 requires verbatim.
       No "lower the model's reasoning level" here in wave 2: that control
       does not exist until 5a (Task 5.5b) adds it; mentioning it now would
       promise a fix the UI cannot yet offer. "Switch to a different model"
       stands in its place. */
    remediation:
      "Give the model more room: for Gemini, raise 'Gemini max output tokens' in Advanced Settings (0 = Auto, " +
      "the model's own limit); for Ollama, raise 'Ollama num_ctx' (ANALYZER_NUM_CTX), the context window the " +
      'prompt and the whole reply must fit in. Or switch to a different analyzer model. Then resume — ' +
      'finished chapters are kept.',
  },
```

`openapi.yaml`: in `FailureCode.enum`, insert `        - analyzer-reasoning-overflow` after `        - analyzer-timeout` (which Task 2.8 inserted after `        - analyzer-content-blocked`). Then run `npm run openapi:types`.

`src/data/help-failures.ts`: in `CATEGORIES`, add `'analyzer-reasoning-overflow': 'analysis',` after `'analyzer-truncated': 'analysis',`. In `TITLES`, add `'analyzer-reasoning-overflow': 'Analyzer used its output limit on reasoning',` after the `'analyzer-truncated'` title.

**Run stop and "stop new spend" (P20)** — `server/src/routes/analysis.ts`:
- **Import.** Change `:29` to `import { AnalyzerReasoningOverflowError, GeminiContentBlockedError } from '../analyzer/errors.js';`.
- **The flag's home.** In `export interface AnalysisJob` (`:2627-2663`), directly after `lastDiskWriteAt: number;`, add:
```ts
  /** #3084 P20 — set the first time this job sees a reasoning overflow, by
      noteReasoningOverflow. From then on the job starts no new escalation
      window or non-story classification call; chapters already calling the
      model finish and cache. Optional, so every existing job literal compiles. */
  reasoningOverflowed?: boolean;
  /** #3084 P20 — the first overflow noteReasoningOverflow saw, set together with
      reasoningOverflowed. The chapter pools' dispatch check rethrows it, so a job
      marked by an overflow the runner swallowed ends exactly as a rethrown one does. */
  reasoningOverflowError?: AnalyzerReasoningOverflowError;
  /** #3084 P20/F7 — the chapter noteReasoningOverflow was told about when it
      first marked the job (set together with the two fields above). `title`
      is best-effort: some call sites (an escalation call, the non-story
      classifier) know only an id at the point they catch the error and would
      need an extra lookup for a title neither has any other reason to hold;
      those pass `{ id }` alone. Every call site below now passes a chapter
      (the main and subset routes' Phase 0/Phase 1 catches, both escalation
      hooks, and the non-story classifier), so the terminal handler's "a
      chapter" fallback is defence-in-depth for a call site a later change
      forgets to update, not an expected path. */
  reasoningOverflowChapter?: { id: number; title?: string };
```
- **The helpers.** Directly before the doc comment of `export function attributeChapterStage2WithEval` (`:2437`), add:
```ts
/** #3084 P20/F7 — "stop new spend". Marks the job and empties the book's
    escalation budget: the object every chapter's attributeChapterStage2 call
    shares (:3692, :6805), which escalateFlaggedWindows checks before each
    window (escalation.ts:235), so no chapter still in flight starts another
    window. Nothing is aborted: in-flight chapters finish and cache for resume,
    as the pools are designed to (:5672-5675). `chapter` records WHICH chapter
    was calling the model when the overflow happened, for the terminal
    failure's copy (F7 — "naming the chapter"); only the FIRST overflow's
    chapter is kept, mirroring `reasoningOverflowError`'s own ??=. Returns
    whether `err` was a reasoning overflow. */
export function noteReasoningOverflow(
  job: AnalysisJob,
  structureBudget: { remainingWindows: number },
  err: unknown,
  chapter?: { id: number; title?: string },
): boolean {
  if (!(err instanceof AnalyzerReasoningOverflowError)) return false;
  job.reasoningOverflowed = true;
  job.reasoningOverflowError ??= err;
  job.reasoningOverflowChapter ??= chapter;
  structureBudget.remainingWindows = 0;
  return true;
}

/** #3084 P20 — the chapter pools' dispatch check. A job marked by a reasoning
    overflow starts no further chapter: this rethrows the recorded overflow, so
    the pool ends through the same terminal handler (classifyAnalysisFailure →
    endJob → a `halted` snapshot) as an overflow a stage call rethrew. Without
    it, an overflow that only escalation saw (swallowed by the runner, reported
    through StageCall.onReasoningOverflow) would stop escalation windows but not
    the next chapter's stage-2 call. */
function throwIfReasoningOverflowed(job: AnalysisJob): void {
  if (job.reasoningOverflowed) throw job.reasoningOverflowError;
}

/** #3084 P20 — Signal-2 non-story classification for the third-party
    front-matter guard, shared by the main and subset jobs. It replaces their
    two inline copies (:5814-5836, :7540-7566) and keeps their behaviour. Once
    the job has seen a reasoning overflow it makes no further call. A call that
    overflows marks the job and reads as story, like any other Signal-2 hiccup. */
export function buildNonStoryClassifier(opts: {
  job: AnalysisJob;
  structureBudget: { remainingWindows: number };
  analyzer: Analyzer;
  manuscriptId: string;
  bookTitle: string | null;
  bookLanguage: string;
}): ((ch: ThirdPartyGuardChapter) => Promise<boolean>) | undefined {
  const { job, structureBudget, analyzer, manuscriptId, bookTitle, bookLanguage } = opts;
  if (!analyzer.runNonStoryClassification) return undefined;
  return async (ch: ThirdPartyGuardChapter): Promise<boolean> => {
    if (job.reasoningOverflowed) return false;
    const promptMd = `Title: ${ch.title ?? '(untitled)'}\n\n${ch.body}`;
    /* srv-61 — the SAME StageCall goes to the runner and withPassEval, so its
       fresh-per-call accumulator attaches to this call. */
    const nonStoryCall: StageCall = { language: bookLanguage };
    try {
      const out = await withPassEval(
        nonStoryCall,
        { manuscriptId, bookTitle, stage: 'nonstory', chapterId: ch.id },
        () => analyzer.runNonStoryClassification!(manuscriptId, ch.id, promptMd, nonStoryCall),
        () => null,
      );
      return out.nonStory;
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      /* #3084 F7 — this classifier already has the chapter (`ch`). */
      noteReasoningOverflow(job, structureBudget, err, { id: ch.id, title: ch.title });
      return false; // Signal-2 hiccup → treat as story, degrade to Signal-1-only
    }
  };
}
```
  `Analyzer` and `StageCall` (`:17`), `withPassEval` (`:65`), `ThirdPartyGuardChapter` and `AnalysisAbortedError` are already imported by `analysis.ts`; `npm run typecheck` confirms it.
- **Main route, Phase-0 per-chapter catch.** Directly after `if (chErr instanceof GeminiContentBlockedError) throw chErr;` (`:4550`), add:
```ts
          /* #3084 P20 — a reasoning overflow is whole-book-fatal too: the same
             engine settings overflow again on every chapter, each time spending
             a full output budget on thinking. Mark the job (no new escalation
             window or non-story call from here on) and rethrow to the terminal
             handler, whose analyzer-reasoning-overflow copy names the setting to
             change, instead of grinding chapter by chapter. `ch` (`ch.id`,
             `ch.title`) is already in scope here, from `const ch =
             recordRef.chapterHints[i];` at the top of `runCastChapter`. */
          if (noteReasoningOverflow(job, structureBudget, chErr, { id: ch.id, title: ch.title })) throw chErr;
```
- **Subset route, Phase-0 per-chapter catch.** Directly after `if (chErr instanceof GeminiContentBlockedError) throw chErr;` (`:7149`), add:
```ts
        /* #3084 P20/F7 — whole-book-fatal reasoning overflow; see the main
           route. `ch` is in scope here the same way. */
        if (noteReasoningOverflow(job, structureBudget, chErr, { id: ch.id, title: ch.title })) throw chErr;
```
- **Main route, Phase-1 pool catch.** In `runPhase1Pool`'s `launchNext` (`:5685-5689`), replace
```ts
          } catch (e) {
            inFlight.delete(i);
            aborted = true;
            throw e;
          }
```
with
```ts
          } catch (e) {
            inFlight.delete(i);
            aborted = true;
            /* #3084 P20/F7 — the chapters still running in the other workers
               start no further escalation window. They are not aborted, and
               still finish and cache (the pool comment above). `launchNext`
               has no `ch` of its own (unlike `runChapter`, which this `i`
               belongs to) — re-derive it the same way `runChapter` does. */
            noteReasoningOverflow(job, structureBudget, e, {
              id: recordRef.chapterHints[i].id,
              title: recordRef.chapterHints[i].title,
            });
            throw e;
          }
```
  The pool comment at `:5672-5675` ("already-running tasks finish their work and write to the cache") stays true and is not edited.
- **Dispatch checks** (see **New chapters** above). Three calls to `throwIfReasoningOverflowed(job)`; `job` is in scope at each.
  - **Main route, Phase 0.** In `runPhase0Pool`'s `launchNextCast` (`:4727-4738`), replace
```ts
            try {
              await runCastChapter(i);
            } catch (e) {
```
    with
```ts
            try {
              /* #3084 P20 — a job marked by a reasoning overflow starts no further cast
                 chapter. In pipelined mode, Phase 1 escalation can mark it mid-pool. */
              throwIfReasoningOverflowed(job);
              await runCastChapter(i);
            } catch (e) {
```
    The unchanged `catch` sets `castAborted` and rethrows, as for any error escaping `runCastChapter`.
  - **Main route, Phase 1.** In `runChapter` (`:5155`), directly after `if (phase0FailedCount > 0) return;` (`:5175`), add:
```ts
      /* #3084 P20 — checked here, after the watermark, rather than at the top of
         launchNext's loop: in pipelined mode a worker can be parked on
         awaitPhase1Dispatch when the job is marked. The pool catch below sets
         `aborted` and rethrows. */
      throwIfReasoningOverflowed(job);
```
  - **Subset route, Phase 1.** As the first statement of the Phase-1 loop body (`:7341`), directly above `const ch = toRun[idx];` in the loop whose next statement is `log(1, \`Chapter ${ch.id} — ${ch.title}: attributing sentences via ${phase1AnalyzerLabel}…\`);` (the Phase-0 loop at `:6878` opens the same way), add:
```ts
      /* #3084 P20 — no further chapter after an escalation overflow; the throw
         reaches this job's terminal catch, as a rethrown overflow does. */
      throwIfReasoningOverflowed(job);
```
  - **Subset route, Phase 1 — the direct stage-2 call has no catch (F7 finding).**
    Re-reading `analysis.ts:7341-7365` on 46e62a34: the loop's
    `attributeChapterStage2WithEval({ … })` call (`:7350` on) is awaited with
    NO surrounding `try`/`catch` at all — unlike the main route's `runChapter`,
    the subset route relies entirely on this call propagating to the route's
    own outer catch. That means a DIRECT stage-2 overflow (not one only an
    escalation call inside it saw) reaches the terminal handler with
    `job.reasoningOverflowChapter` still unset — the escalation hook
    (`onReasoningOverflow`) marks the job only when an escalation call inside
    this same stage-2 call overflows, not when the stage-2 call itself does.
    Wrap the call:
```ts
      let chapterSentences: Sentence[];
      let subsetCoverageVerdict: CoverageVerdict; // match the existing destructured names/types exactly when implementing
      let subsetChunkCount: number;
      let subsetStructureReport: StructureReport | undefined;
      try {
        ({
          sentences: chapterSentences,
          coverage: subsetCoverageVerdict,
          chunkCount: subsetChunkCount,
          structureReport: subsetStructureReport,
        } = await attributeChapterStage2WithEval({
          analyzer: phase1Analyzer,
          manuscriptId,
          title: record.title,
          stage1,
          chapter: ch,
          // … the rest of this call's existing options, unchanged
        }));
      } catch (err) {
        /* #3084 P20/F7 — mark the job with the chapter that was calling the
           model, then rethrow: the subset route has no other catch, so this
           reaches the terminal classifyAnalysisFailure call the same way an
           un-marked throw always has. noteReasoningOverflow is a no-op (and
           the chapter is not recorded) for any other error. */
        noteReasoningOverflow(job, structureBudget, err, { id: ch.id, title: ch.title });
        throw err;
      }
```
    Converting the original `const { … } = await …` into pre-declared `let`s
    assigned inside the `try` is the minimal change that lets a `catch` wrap
    it; keep every existing option in the `attributeChapterStage2WithEval({…})`
    call literal exactly as `:7350` on 46e62a34 already has it — only the
    destructuring assignment's shape changes, not the call's arguments. Test:
    a Retry-route (`/analysis/chapters`) stage-2 call that throws
    `AnalyzerReasoningOverflowError` directly (not via escalation) ends the
    subset job with `analyzer-reasoning-overflow`, and the SSE `error` event's
    `message` names the chapter that was running — mirroring the main route's
    `after a stage-2 overflow in chapter 2, …` test, but through
    `runSubsetAnalyzerJob` instead of `runMainAnalyzerJob`.
- **Non-story classification, main route.** Replace the whole `const classifyNonStory = analyzer.runNonStoryClassification ? async (ch: ThirdPartyGuardChapter): Promise<boolean> => { … } : undefined;` statement (`:5814-5836`) with:
```ts
    const classifyNonStory = buildNonStoryClassifier({
      job,
      structureBudget,
      analyzer,
      manuscriptId,
      bookTitle: recordRef.title ?? null,
      bookLanguage,
    });
```
- **Non-story classification, subset route.** Replace the same statement (`:7540-7566`; its srv-61 comment moves into the builder) with:
```ts
    const classifyNonStory = buildNonStoryClassifier({
      job,
      structureBudget,
      analyzer,
      manuscriptId,
      bookTitle: record.title ?? null,
      bookLanguage,
    });
```
- **No terminal-catch ABORT change.** Neither terminal catch (main `:6308-6365`, subset `:7867-7912`) aborts the job's controller or changes that behaviour. The subset route's Phase 1 attributes one chapter at a time (`:7341`) with nothing else in flight, and both routes' non-story pass runs after Phase 1. So the three marks above plus the builder cover every overflow that has other model calls behind it.
- **Terminal handler passes the chapter through (F7).** The main route's terminal handler (`:6444-6450`) destructures `classifyAnalysisFailure`'s result and calls `endJob`:
```ts
    const {
      code,
      userMessage: message,
      remediation,
      detail,
    } = classifyAnalysisFailure(e, analyzerLabel, { chapter: job.reasoningOverflowChapter });
    endJob(job, { kind: 'error', code, message, remediation, detail });
```
  (added: the third argument; nothing else on this snippet changes). The `chapter` field is a no-op for every non-`AnalyzerReasoningOverflowError` failure — the classifier ignores `ctx` unless `err` matches that branch — so this is safe to pass unconditionally rather than gating it on the error type here, which would duplicate the `instanceof` check the classifier already does. Find the subset route's equivalent terminal handler (same `classifyAnalysisFailure(e, …)` call, its own `job` in scope) and make the same one-argument addition.

`server/src/routes/script-review.ts`:
- **Import.** Change `:40` to `import { AnalyzerReasoningOverflowError, AnalyzerTruncatedError, GeminiContentBlockedError } from '../analyzer/errors.js';`.
- **Capture variable.** Directly after `let blockedErr: GeminiContentBlockedError | null = null;` (`:906`), add:
```ts
      /* #3084 P20 — a reasoning overflow fails the whole pass fast for the same
         reason: the same settings overflow again on every chunk. */
      let overflowErr: AnalyzerReasoningOverflowError | null = null;
```
- **Catch.** Directly after the `if (err instanceof GeminiContentBlockedError) { blockedErr = err; break; }` block (`:944-951`), add:
```ts
              if (err instanceof AnalyzerReasoningOverflowError) {
                overflowErr = err;
                break;
              }
```
- **Terminal event.** Directly after the `if (blockedErr) { … return; }` block (`:972-987`), add the block below. The casts mirror `blockedErr`'s: TypeScript narrows a variable assigned inside a closure to `null` at this point. The event's `code` is a plain string here (`content_blocked` and `quota_exhausted` are inline literals, `:962`, `:971`), so no union needs widening.
```ts
      if (overflowErr) {
        send({
          kind: 'error',
          code: 'analyzer-reasoning-overflow',
          message: (overflowErr as AnalyzerReasoningOverflowError).message,
          model: (overflowErr as AnalyzerReasoningOverflowError).model,
          remediation: FAILURE_REMEDIATIONS['analyzer-reasoning-overflow'].remediation,
        });
        for (const sub of job.subscribers) sub.res.end();
        return;
      }
```

`server/src/routes/annotate-emotion.ts` and `server/src/routes/instruct-annotation.ts` (the same edit in each):
- **Imports.** Add `import { AnalyzerReasoningOverflowError } from '../analyzer/errors.js';` and `import { FAILURE_REMEDIATIONS } from './failure-remediations.js';` (the sibling import `script-review.ts:42` already uses).
- **Catch.** Directly after the `if (err instanceof DailyQuotaExhaustedError) { … return; }` block (`annotate-emotion.ts:245-256`, `instruct-annotation.ts:244-255`), add:
```ts
          /* #3084 P20 — a reasoning overflow stops the pass exactly as a daily
             quota does: the same settings overflow again on every chapter, each
             time spending a full output budget on thinking. Already-streamed
             chapters stay applied client-side. One chapter runs at a time, so
             nothing else is in flight. */
          if (err instanceof AnalyzerReasoningOverflowError) {
            send({
              kind: 'error',
              code: 'analyzer-reasoning-overflow',
              message: err.message,
              model: err.model,
              remediation: FAILURE_REMEDIATIONS['analyzer-reasoning-overflow'].remediation,
            });
            clearInterval(keepAlive);
            if (!closed) res.end();
            return;
          }
```

`server/src/analyzer/attribution-eval/review-run.ts`:
- **Import.** `:36` → `import { AnalyzerReasoningOverflowError, AnalyzerTruncatedError, GeminiContentBlockedError } from '../errors.js';`
- **Comment.** At the end of the block comment above the chunk loop (`:111-121`), add the sentence `A reasoning overflow is terminal too (#3084 P20): the same settings overflow on every chunk.`
- **Terminal rethrow.** In the chunk loop's `catch` (`:130-136`), add `err instanceof AnalyzerReasoningOverflowError ||` directly after `err instanceof DailyQuotaExhaustedError ||`.

**Escalation reports its overflow (P20).** `runSingleAttempt` still returns `null` for an overflow, because `GEMINI_RETRY_POLICY.escalationRethrows` (wave 1 Task 1.10) stays abort-only. `escalation.ts` does not change. Before returning `null`, the runner now tells its caller through a `StageCall` hook, and each route marks the job from it.

`server/src/analyzer/types.ts` (wave 1 Task 1.5's leaf):
- **Import.** After the `import type { RawEvalTiming } …` line, add `import type { AnalyzerReasoningOverflowError } from './errors.js';`. `errors.ts` imports nothing, so this type edge closes no cycle; `npm run check:cycles` confirms it.
- **Field.** In `export interface StageCall`, directly after `onFallback?: (info: { reason: string }) => void;` (`index.ts:84` on 46e62a34), add:
```ts
  /** #3084 P20 — called by StageRunner.runSingleAttempt (attribution
      escalation) when its one call ends in a reasoning overflow, just before it
      returns null. The runner swallows that error, so without this hook the
      route never learns of it and the chapter keeps querying windows. The
      analysis routes pass noteReasoningOverflow here. runStage never calls it:
      its overflows propagate to the route. */
  onReasoningOverflow?: (err: AnalyzerReasoningOverflowError) => void;
```

`server/src/analyzer/runner/stage-runner.ts` — the wave 2 change to wave 1's runner (Task 1.11), by symbol:
- **Import.** Add `import { AnalyzerReasoningOverflowError } from '../errors.js';`.
- **`StageRunner.runSingleAttempt`**, in the `catch (err)` around `this.send(...)`, directly after `if (this.policy.escalationRethrows(err)) throw err;`, add:
```ts
      /* #3084 P20 — still skip the window, but report the overflow first: the
         same settings overflow on every later window, and only the route can
         stop them (it empties the book's escalation budget). */
      if (err instanceof AnalyzerReasoningOverflowError) call.onReasoningOverflow?.(err);
```
  The `console.warn` and `return null;` that follow do not change. `runStage`, `structuredOutput` and `send` are not touched.

`server/src/routes/analysis.ts`:
- **Main route, Phase-1 `stage2Call`.** Inside `const stage2Call: StageCall = {` (`:5275`), directly after `language: bookLanguage,` (`:5277`), add:
```ts
        /* #3084 P20/F7 — attributeChapterStage2 hands this StageCall to
           escalateFlaggedWindows (:2382). An escalation call that overflows
           returns null inside the runner and reports here: the job is marked and
           the book's escalation budget emptied, so neither this chapter nor any
           other sends a further window (escalation.ts:235). `ch` is in scope
           (this literal is built inside `runChapter`, same as `stage2Call`'s
           other fields). */
        onReasoningOverflow: (err) => noteReasoningOverflow(job, structureBudget, err, { id: ch.id, title: ch.title }),
```
- **Subset route, Phase-1 inline `stageCall`.** Inside the `stageCall: {` literal passed to `attributeChapterStage2WithEval` (`:7224`), directly after `language: bookLanguage,` (`:7226`), add:
```ts
            /* #3084 P20/F7 — escalation overflow hook; see the main route's
               stage2Call. `ch` is in scope (`const ch = toRun[idx];`, the
               same loop the "Subset route, Phase 1" dispatch-check bullet
               above adds throwIfReasoningOverflowed(job) to). */
            onReasoningOverflow: (err) => noteReasoningOverflow(job, structureBudget, err, { id: ch.id, title: ch.title }),
```
  `job` and `structureBudget` (`:3692`, `:6805`) are in scope at both sites, as they are at the pool catch above.
  - **Every escalation call gets the hook.** The `cloud` escalation analyzer receives the same `stageCall` (`:2382`). `withPassEval` only reassigns `onEvalTiming` on that object (`analyzer-eval-stats.ts:193`). The `stage2CallSeq` spread (`:2303`) copies the hook too, though no stage-2 call reads it.
  - **The return type fits.** `noteReasoningOverflow` returns a `boolean`, and a function returning a value is assignable to the hook's `void` return type.
- [ ] **Step 4: Run and confirm it passes**
Run:
```
npm run openapi:types
npm --prefix server run test -- src/analyzer/runner src/analyzer/transports src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts src/analyzer/stage1-chunk.test.ts src/analyzer/stage2-chunk.test.ts src/analyzer/attribution-eval src/routes/failure-taxonomy.test.ts src/analyzer/capacity-pinning.test.ts src/routes/analysis.phase-model.test.ts src/routes/script-review.test.ts src/routes/annotate-emotion.test.ts src/routes/instruct-annotation.test.ts src/routes/analysis.test.ts src/routes/analysis.reasoning-overflow.test.ts src/analyzer/dialogue-structure/escalation.test.ts
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts src/routes/analysis-pipelining.test.ts
npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts
npm run typecheck
```
Expected: PASS.
- [ ] **Step 5: Mutation proof**
  1. In `finish.ts`, change `(hasReasoningEvidence(r) || answer.unterminated)` to `answer.unterminated`. Expected red: `mapFinish — reasoning overflow vs truncation (#3084 wave 2b) > length + empty answer + reasoning tokens → AnalyzerReasoningOverflowError carrying the count`, and `GeminiAnalyzer — output truncation (#528) > an empty MAX_TOKENS response WITH thoughtsTokenCount fails as reasoning overflow …`. Restore it.
  2. Change the same condition to `true`. Expected red: `… length + empty answer + NO evidence (Gemma empty MAX_TOKENS) → AnalyzerTruncatedError, so the chunk still splits`. Restore it.
  3. Delete the `AnalyzerReasoningOverflowError` branch in `classifyAnalysisFailure`. Expected red: `AnalyzerReasoningOverflowError (#3084 wave 2b) > → analyzer-reasoning-overflow, naming the Gemini max-output setting…` (the static signature copy lacks the setting name). Restore it.
  3a. Change `const chapter = ctx?.chapter;` to `const chapter = undefined;`. Expected red: `… > names the chapter by title when the caller passes one (#3084 F7)` and `… > falls back to the bare chapter id when no title was passed (#3084 F7)` (both read `'a chapter'` instead of the passed chapter). Restore it.
  3b. Change `chapter.title ? … : \`chapter ${chapter.id}\`` to always take the `chapter.title` branch (drop the ternary's `false` arm, e.g. `` `chapter "${chapter.title}"` `` unconditionally). Expected red: `… > falls back to the bare chapter id when no title was passed (#3084 F7)` (`userMessage` reads `chapter "undefined"`, not `chapter 7`). Restore it.
  3c. In the terminal handler, drop the third argument from `classifyAnalysisFailure(e, analyzerLabel, { chapter: job.reasoningOverflowChapter })`. Expected red: `a reasoning overflow stops new spend, not work already in flight (#3084 P20, N4) > after a stage-2 overflow in chapter 2, chapter 1 (already calling the model) finishes and caches, …` (the SSE `error` event's `message` reads `'a chapter'`, not `'chapter "Chapter Two"'`). Restore it.
  4. In `finish.ts`, move `if (ctx.kind === 'ollama' && !r.text) throw …;` above the `if (r.finish === 'length') {` block. Expected red:
     - `Ollama empty \`length\` stream (#3084 wave 2b) > empty content, no message.thinking → finish length, and mapFinish splits it (AnalyzerTruncatedError)`;
     - `… > empty content after message.thinking chunks → reasoningSeen, and mapFinish fails it as reasoning overflow`;
     - `mapFinish — wave 1 … > ollama EMPTY length with no reasoning evidence is truncation with 0 bytes…`.

     Restore it.
  5. In `ollama-transport.ts`, delete `reasoningSeen = true;` inside the `message.thinking` check. Expected red: `… > empty content after message.thinking chunks → reasoningSeen, and mapFinish fails it as reasoning overflow` (received `reasoningSeen: false`). Restore it.
  6. In the empty-buffer early return, change `finish: doneReason === 'length' ? 'length' : 'stop'` to `finish: 'stop'`. Expected red: both `empty content …` `length` cases in `ollama-transport-overflow.test.ts`. The `stop` case stays green. Restore it.
  7. In `ollama-transport.ts`, delete the `onChunk?.({…})` call inside the `message.thinking` check (keep `reasoningSeen = true;`). Expected red: `… > empty content after message.thinking chunks → reasoningSeen, and mapFinish fails it as reasoning overflow` (`expected "spy" to be called 2 times, but got 0 times`). Restore it.
  8. In `routes/analysis.ts`, delete `if (noteReasoningOverflow(job, structureBudget, chErr)) throw chErr;` from the main route's Phase-0 catch. Expected red: `a reasoning overflow ends the analysis run (#3084 P20) > stage 1 (Phase 0 cast detection, main route) → terminal analyzer-reasoning-overflow, not a per-chapter grind` (received `cast_incomplete`). Then replace it with `if (chErr instanceof AnalyzerReasoningOverflowError) throw chErr;` (a rethrow without the mark). Expected red: the same case, on `job.reasoningOverflowed` (`undefined`). Restore it.
  9. Delete the same line from the subset route's Phase-0 catch. Expected red: `… > stage 1 on the subset (Retry) route → terminal analyzer-reasoning-overflow`. Then replace it with a rethrow without the mark. Expected red: the same case, on `job.reasoningOverflowed`. Restore it.
  10. Delete the `AnalyzerReasoningOverflowError` branch in `classifyAnalysisFailure` (as in 3) and run `npm --prefix server run test -- src/routes/analysis.phase-model.test.ts`. Expected red: `… > stage 2 (Phase 1 attribution) → terminal analyzer-reasoning-overflow` (with no branch to match it, the error falls through to the generic classifier and the run ends with `unknown` instead of `analyzer-reasoning-overflow`). Restore it.
  11. In `routes/script-review.ts`, delete the `if (err instanceof AnalyzerReasoningOverflowError) { … }` capture. Expected red: `… a reasoning overflow fast-fails the whole pass with analyzer-reasoning-overflow — no per-chapter grind (#3084 P20)` (a `chapter-failed` per chunk, no `error` event). Restore it.
  12. In `failure-remediations.ts`'s `'analyzer-reasoning-overflow'` entry, change `"raise 'Ollama num_ctx' (ANALYZER_NUM_CTX)"` to `"raise 'Ollama num_predict' (ANALYZER_NUM_PREDICT)"`. Expected red: `AnalyzerReasoningOverflowError (#3084 wave 2b) > the static remediation names Ollama num_ctx (the binding limit), not num_predict, for an Ollama overflow (#3084 F7)` (`r.remediation` now contains `num_predict` and no longer contains `Ollama num_ctx`). Restore it. **Task 2.9a adds a companion row** once `reasoningOverflowFixes` exists: change the Ollama branch's `settingKey: 'analyzer.ollama.numCtx'` to `settingKey: 'analyzer.ollama.numPredict'` — expected red on Task 2.9a's own Ollama-fixes test AND on the guard (`analyzer.ollama.numPredict` is a real key, so the guard alone would NOT catch a wrong-but-valid key; only the dedicated fixes-content test does — this is why the guard is necessary but not sufficient, and the wave 2.9a test exists in addition to it, not instead of it).
  13. In `runPhase1Pool`'s pool catch, delete `noteReasoningOverflow(job, structureBudget, e);`. Expected red: `a reasoning overflow ends the analysis run (#3084 P20) > stage 2 (Phase 1 attribution) → terminal analyzer-reasoning-overflow` (`job.reasoningOverflowed` is `undefined`), and `a reasoning overflow stops new spend, not work already in flight (#3084 P20, N4) > after a stage-2 overflow in chapter 2, …` (the same flag). Restore it.
  14. In `noteReasoningOverflow`, delete `structureBudget.remainingWindows = 0;`. Expected red: `noteReasoningOverflow (#3084 P20) > marks the job and empties the book escalation budget for a reasoning overflow only`, and `… > after a stage-2 overflow in chapter 2, chapter 1 (already calling the model) finishes and caches, starts no escalation window, …` (`escalate` called). The two `… route: after one escalation call overflows, no later chapter sends an escalation window` cases stay green: at pool width 1 the dispatch check now stops chapter 2 before it can send a window, so the emptied budget is proven by the two cases above, not by them. Restore it.
  15. In `annotate-emotion.ts`, delete the `if (err instanceof AnalyzerReasoningOverflowError) { … }` branch. Expected red: `annotate-emotion.test.ts`'s `a reasoning overflow stops the pass like a daily quota: …` (a `chapter-failed` event and a `result`). Restore it.
  16. Delete the same branch in `instruct-annotation.ts`. Expected red: `instruct-annotation.test.ts`'s `a reasoning overflow stops the pass like a daily quota: …`. Restore it.
  17. In `review-run.ts`, delete `err instanceof AnalyzerReasoningOverflowError ||`. Expected red: `runReviewOverChapter — route-parity chunk loop > (f) rethrows a reasoning overflow instead of dropping the chunk and calling the model again (#3084 P20)` (the promise resolves). Restore it.
  18. In `runner/retry-policy.ts`, change `GEMINI_RETRY_POLICY`'s `escalationRethrows: (err) => err instanceof AnalysisAbortedError,` to `escalationRethrows: (err) => err instanceof AnalysisAbortedError || err instanceof AnalyzerReasoningOverflowError,` (importing the class). Expected red: `StageRunner (#3084 wave 1) > single attempt: a reasoning overflow resolves to null and calls onReasoningOverflow once; other failures do not call it (#3084 P20)` (the promise rejects), and `escalateFlaggedWindows — a reasoning overflow stops further windows (#3084 P20) > one overflowing call stops that chapter's second window and every later chapter's` (the first `escalateFlaggedWindows` rejects). Restore it.
  19. In `gemini-transport.ts` (Task 2.7), replace `reasoningTokens: includeThoughts ? thoughtsTokenCount : undefined,` with `reasoningTokens: thoughtsTokenCount,`. Expected red: slow `GeminiAnalyzer — output truncation (#528) > a Gemma empty MAX_TOKENS response WITH thoughtsTokenCount but no thought parts still splits …` (received `AnalyzerReasoningOverflowError`). Restore it.
  20. In `buildNonStoryClassifier`, delete `if (job.reasoningOverflowed) return false;`. Expected red: `buildNonStoryClassifier — no non-story call after a reasoning overflow (#3084 P20) > a classification call that overflows marks the job, reads as story, and no later chapter is classified` (`run` called 2 times) and `… > a job already marked by an overflow elsewhere makes no classification call`. Restore it.
  21. In `buildNonStoryClassifier`'s `catch`, delete `noteReasoningOverflow(job, structureBudget, err);`. Expected red: `… > a classification call that overflows marks the job, …` (`job.reasoningOverflowed` is `undefined`). Restore it.
  22. N4 guard: in `runChapter`, directly after `await saveAnalysisCache(manuscriptId, cache);` (`routes/analysis.ts:5508`), add `void persistRunningSnapshot(job, true);` (an in-flight chapter rewriting the snapshot as it completes). Expected red: `a reasoning overflow stops new spend, not work already in flight (#3084 P20, N4) > after a stage-2 overflow in chapter 2, …` (the snapshot reads `state: 'running'`, not `halted`). Remove the line.
  23. The withdrawn design: in `runMainAnalyzerJob`'s terminal catch, directly after `endJob(job, { kind: 'error', code, message, remediation, detail });` (`:6364`), add `if (e instanceof AnalyzerReasoningOverflowError) job.controller.abort(e);`. Expected red: `… > after a stage-2 overflow in chapter 2, …` (`job.controller.signal.aborted` is `true`), and the `job.controller.signal.aborted` assertions in `a reasoning overflow ends the analysis run (#3084 P20) > stage 1 (Phase 0 cast detection, main route) …` and `… > stage 2 (Phase 1 attribution) …`. Remove the line.
  24. In `StageRunner.runSingleAttempt`'s `catch`, delete `if (err instanceof AnalyzerReasoningOverflowError) call.onReasoningOverflow?.(err);`. Expected red: `StageRunner (#3084 wave 1) > single attempt: a reasoning overflow resolves to null and calls onReasoningOverflow once; …` (`called 1 times, but got 0 times`), and `escalateFlaggedWindows — a reasoning overflow stops further windows (#3084 P20) > one overflowing call stops …` (`send` called 4 times). The route cases stay green, because their stub analyzers call the hook themselves and so pin only the wiring. Restore it.
  25. Replace that line with `call.onReasoningOverflow?.(err as AnalyzerReasoningOverflowError);`, so the hook fires for every swallowed error. Expected red: `… single attempt: a reasoning overflow resolves to null and calls onReasoningOverflow once; other failures do not call it …` (`notCalled` is called for the plain `Error` and for the no-evidence truncation). Restore it.
  26. In the main route's `stage2Call`, delete `onReasoningOverflow: (err) => noteReasoningOverflow(job, structureBudget, err),`. Expected red: `a reasoning overflow stops new spend, not work already in flight (#3084 P20, N4) > main route: after one escalation call overflows, no later chapter sends an escalation window (#3084 P20)` (`escalate` called more than once). Restore it.
  27. Delete the same line from the subset route's inline Phase-1 `stageCall`. Expected red: `… > subset route: after one escalation call overflows, no later chapter sends an escalation window (#3084 P20)`. Restore it.
  28. In `runChapter`, delete `throwIfReasoningOverflowed(job);` (the Phase-1 dispatch check). Expected red: `a reasoning overflow stops new spend, not work already in flight (#3084 P20, N4) > main route: after one escalation overflow in chapter 1, chapter 2's stage-2 call is never sent and the run halts with analyzer-reasoning-overflow (#3084 P20)` (chapter 2's stage-2 call is sent, and the run ends with a `result`). Restore it.
  29. Delete the same call from the subset route's Phase-1 loop. Expected red: `… > subset route: after one escalation overflow in chapter 1, chapter 2's stage-2 call is never sent …`. Restore it.
  30. Delete the same call from `runPhase0Pool`'s `launchNextCast`. Expected red: `… > pipelined main route: after an escalation overflow, Phase 0 starts no further cast chapter and the run halts with analyzer-reasoning-overflow (#3084 P20)` (`castCalls` contains 3). Restore it.
  31. In `noteReasoningOverflow`, delete `job.reasoningOverflowError ??= err;`. Expected red: the three dispatch-check cases of rows 28–30. The check still stops dispatch, but it throws `undefined`, which classifies as `unknown`, not `analyzer-reasoning-overflow`. Restore it.
  32. In `noteReasoningOverflow`, delete `job.reasoningOverflowChapter ??= chapter;`. Expected red: `noteReasoningOverflow (#3084 P20) > records the chapter it was told about (#3084 F7)` and `… > keeps the FIRST overflow chapter, …` (`job.reasoningOverflowChapter` is `undefined` in both). Restore it.
  33. Change `job.reasoningOverflowChapter ??= chapter;` to `job.reasoningOverflowChapter = chapter;` (drop the "first wins" guard). Expected red: `noteReasoningOverflow (#3084 P20) > keeps the FIRST overflow chapter, like reasoningOverflowError, even when a later call names a different one` (`job.reasoningOverflowChapter` reads chapter 5's, not chapter 4's). Restore it.
  34. In `buildNonStoryClassifier`'s catch, drop the third argument from `noteReasoningOverflow(job, structureBudget, err, { id: ch.id, title: ch.title })`. Expected red: `buildNonStoryClassifier — no non-story call after a reasoning overflow (#3084 P20) > a classification call that overflows marks the job, reads as story, …` (`job.reasoningOverflowChapter` is `undefined`). Restore it.
  35. In the subset route's Phase-1 loop, remove the `try`/`catch` wrapper around `attributeChapterStage2WithEval` (restore the bare `const { … } = await attributeChapterStage2WithEval({ … });`). Expected red: `a direct stage-2 overflow on the subset (Retry) route names its chapter — no catch existed for this before (#3084 F7)` (`job.reasoningOverflowChapter` is `undefined`, though the run still ends with `analyzer-reasoning-overflow` since the throw still reaches the route's outer catch — only the chapter-naming is lost). Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/errors.ts server/src/analyzer/types.ts server/src/analyzer/runner/stage-runner.ts server/src/analyzer/dialogue-structure/escalation.test.ts server/src/analyzer/runner/finish.ts server/src/analyzer/runner/finish-reasoning-overflow.test.ts server/src/analyzer/runner/finish.test.ts server/src/analyzer/runner/stage-runner.test.ts server/src/analyzer/transports/ollama-transport.ts server/src/analyzer/transports/ollama-transport-overflow.test.ts server/src/analyzer/stage1-chunk.test.ts server/src/analyzer/stage2-chunk.test.ts server/src/analyzer/gemini.test.ts server/src/analyzer/attribution-eval/review-run.ts server/src/analyzer/attribution-eval/review-run.test.ts server/src/routes/failure-taxonomy.ts server/src/routes/failure-remediations.ts server/src/routes/failure-taxonomy.test.ts server/src/routes/analysis.ts server/src/routes/analysis.phase-model.test.ts server/src/routes/analysis.reasoning-overflow.test.ts server/src/routes/script-review.ts server/src/routes/script-review.test.ts server/src/routes/annotate-emotion.ts server/src/routes/annotate-emotion.test.ts server/src/routes/instruct-annotation.ts server/src/routes/instruct-annotation.test.ts openapi.yaml src/lib/api-types.ts src/data/help-failures.ts src/data/help-failures.test.ts src/data/help-categories.test.ts
git commit -m "feat(server,openapi,frontend): fail reasoning overflow instead of splitting (#3084)"
```

**Tests this task could break:**
- wave 1's `runner/finish` / characterisation tests. Any empty-`length` case with reasoning evidence changes class, and that case did not exist before wave 2;
- wave 1's `finish.test.ts` case `ollama EMPTY length is still the empty-response Error…`, which is replaced in Step 1. This is the deliberate Ollama ordering change;
- `transports/ollama-transport.test.ts` (wave 1 Task 1.8). Its empty-stream case already expects `finish: 'length'` and `receivedBytes: 0`, and stays green; its `toEqual` results now also carry `reasoningSeen: false` from the variable, which is unchanged;
- `ollama.test.ts:650` `throws plain Error on empty body`. It stays green: it feeds `ndjsonStream([])` with no `done` line, so `doneReason` is `undefined`, `finish` is `'stop'`, and `mapFinish` still throws the empty-response error;
- the chunker suites;
- `review-run.test.ts`;
- `dialogue-structure/escalation.test.ts`, whose existing cases pass `StageCall`s without the new optional field, and every other `StageCall` test double, all of which keep compiling;
- `failure-taxonomy.test.ts`;
- the help tests and the `help.tsx` view;
- `routes/analysis.phase-model.test.ts` and the content-block suites in `routes/analysis.test.ts`, whose Phase-0 catches each gain one line;
- the non-story cases in `routes/analysis.test.ts` and slow `routes/analysis-pipelining.test.ts`, whose classifier is now `buildNonStoryClassifier` with unchanged behaviour, and `routes/analysis.rename-midrun.test.ts`, which drives the same pools. Those pools, and the subset Phase-1 loop, now call `throwIfReasoningOverflowed(job)` before each dispatch; no job in those suites is ever marked, so the check never throws there;
- `routes/script-review.test.ts`, whose content-block and quota cases share the edited loop.
- `routes/annotate-emotion.test.ts` and `routes/instruct-annotation.test.ts`, whose quota cases share the edited catch;
- `attribution-eval/review-run.test.ts`, whose `(e)` quota case shares the edited rethrow;
- `runner/stage-runner.test.ts`, whose `single attempt …` case runs the unchanged `GEMINI_RETRY_POLICY`.

### Task 2.9a: Structured fixes for a reasoning overflow — "How to fix", a persistent notification, and the Advanced Settings deep link (F7)

**Scope note.** This task implements the 2b slice of F7's staging ("2b: Gemini
and Ollama fixes, the field, router focus, rendering, notification, guard
test"). It is specified at a coarser grain than the rest of this file — one
combined test-first step per surface rather than a fully separate mutation row
for every line — because it touches many files across four layers (server
contract, the persistent stream middleware, the rejoin/last-outcome path, and
view components) with no existing precedent this file can extend
line-for-line. Flagged so the coordinator can dispatch a task-review pass at
higher scrutiny than usual.

**Router mechanism (confirmed).** `parseHash` does not exist in
`src/lib/router.ts` — a comment at `src/routes/index.tsx:1126` ("Replaces
parseHash's fallback to `{ kind: 'books' }`") confirms it was retired when the
router moved to react-router loaders; `stageToHash` and `stageEqual` are the
two functions that still exist there. The actual parse-side mechanism is
`useSearchParams()` read inside each route's loader component (e.g.
`HelpRoute`, `src/routes/index.tsx:491-495`, reads `?code=` into `focusCode`).
This task extends that mechanism for `advanced`'s new `?focus=` param, extends
`stageToHash`'s `'advanced'` case to serialize it back, and extends
`stageEqual` to compare it (below) — mirroring the `'help'`/`focusCode` case
all three already have. `router.ts` itself stays pure and unit-testable;
`AdvancedRoute` is not. **Merge readiness for wave 5:** Task 5.5c extends this
SAME `'advanced'` stage member with a second field, `reasoningFocus`, and this
task's `stageEqual` branch and `AdvancedRoute` are written so 5a extends them
in place rather than adding a second `'advanced'` branch or a second route
component — wave 5 is being told the same. Keep `focusKey`'s name exactly.

**Chapter naming is already done, elsewhere.** Task 2.9's
`noteReasoningOverflow` and `classifyAnalysisFailure` branch already carry and
name the chapter, and Task 2.9's `failure-remediations.ts` entry already ends
`remediation` with "Then resume — finished chapters are kept." (F7). This task
adds `fixes` on top of that copy — it does not touch chapter identity or the
copy's ending again.

**One home, one signature (per review).** `AnalysisFailureFix` and
`reasoningOverflowFixes` live in `server/src/routes/failure-taxonomy.ts`
itself — the master plan's contract (`docs/superpowers/plans/2026-09-11-openai-compatible-analyzer.md:277-291`)
names that file explicitly, and wave 3ab/wave 5 both assume it lives there
too. There is no separate `failure-taxonomy-fixes.ts` SOURCE file — only the
GUARD TEST file keeps that name (`failure-taxonomy-fixes.test.ts`), since it
tests a cross-cutting property (every fix's `settingKey`/`wikiPage` is real)
rather than one function's behaviour, and 3b/5a append to it rather than
writing a new one. The ctx shape, per the master plan and the PR review, is
`{ transport: TransportKind; model: string; endpointId?: string }` — the SAME
type the `AnalyzerReasoningOverflowError.transport` field already has, so the
classify branch passes `{ transport: err.transport, model: err.model }` with
**no cast**. `endpointId` is declared now but unused in 2b (`err` carries none
until 3b widens `AnalyzerReasoningOverflowError`); `reasoningLevel` is 5a's
addition to the same ctx type, not this task's.

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts` — add `AnalysisFailureFix` (interface, below) and `reasoningOverflowFixes(ctx)` near `withCopy`; extend the `AnalyzerReasoningOverflowError` branch's `return` (Task 2.9's edit) to attach `fixes` (below) — do not touch its `userMessage`/`chapter` logic, and do not touch `failure-remediations.ts`'s static entry (Task 2.9's "Then resume" ending stays put, unedited here).
- Create: `server/src/routes/failure-taxonomy-fixes.test.ts` — the guard (test-only; no matching source file)
- Modify: `server/src/routes/analysis.ts` — the two terminal handlers' destructure of `classifyAnalysisFailure`'s result gains `fixes` and the `endJob`/`send` call passes it through to the SSE `error` event. **`fixes` does NOT reach the `#3004` last-outcome record** (per review: nothing on the frontend reads the rejoin event's `priorOutcome` today — no consumer exists at 46e62a34 — so writing `fixes` there would be dead data with no reader; `endJob`'s last-outcome write and `buildRejoinMissEvent` are untouched by this task).
- Modify: `src/store/analysis-slice.ts` (46e62a34 `:173-181`) — `ActiveStreamSnapshot` gains `haltFixes?: AnalysisFailureFix[]`; `setHalted`'s payload type gains `fixes?: AnalysisFailureFix[]`, and the reducer sets `snap.haltFixes = action.payload.fixes;` alongside the existing `haltCode`/`haltReason` assignments — **not** a new field on a different record; this is the SAME halted-run state a user who navigates away and back in the same session (not a rejoin after the server restarts) sees rendered by the Analysing view.
- Modify: `openapi.yaml` — add `AnalysisFailureFix` schema (`wikiPage` not `wikiHref`, below) and a `fixes` array property on the analysis SSE error shape. **Finding, unchanged from the prior draft:** the analysis SSE stream's `error` event is NOT modelled in `openapi.yaml` today — `AnalysePhaseEvent` and `AnalyseWarningEvent` are the only two members of the `text/event-stream` `oneOf` at `/api/manuscripts/{manuscriptId}/analysis` (`:545-563`) and `/analysis/chapters` (`:578-611`); the real wire shape lives only in `src/lib/api.ts`'s local `AnalysisStreamEvent` interface. Add a new `AnalyseErrorEvent` schema (`kind`, `code`, `message`, `remediation`, `detail`, `fixes`) and append it to both `oneOf` lists.
- Modify: `src/lib/api-types.ts` (regenerate via `npm run openapi:types`); note for mocks: mock mode (`VITE_USE_MOCKS`) never calls a real analyzer, so it cannot organically emit `analyzer-reasoning-overflow` — the Playwright e2e task below (Step 8) hand-authors a mock SSE fixture that does, rather than trying to make the ordinary mock manuscript flow produce this failure.
- Modify: `src/lib/api.ts` — `AnalysisStreamEvent` (add `fixes?: AnalysisFailureFix[]`), `AnalysisError` (add `fixes` field + constructor param, carried from `payload.fixes` at BOTH terminal-error throw sites — the main route's and the subset route's, confirmed at `:2997-3005` and `:5714-5721` on the current checkout).
- **CRITICAL — the persistent notification lives in the middleware, not the view (review finding).** `src/store/analysis-stream-middleware.ts:220-230` on `46e62a34` (`git show 46e62a34:src/store/analysis-stream-middleware.ts`; the generic `if (e instanceof AnalysisError) { … }` branch, its `dispatch(setHalted)`/`dispatch(pushToast)` payload lines at `:221-228`, matching the review's own citation) is the stream that survives navigation — `analysing.tsx`'s OWN stream aborts on unmount (`:662-668` on the current checkout, `controller.abort()` in the effect cleanup), so a toast pushed from the view disappears the moment the user navigates away, defeating "survives navigation" outright. **Pin drift, noted once:** on the current checkout this same branch sits at `:267-277` — a `language_unset` special case (current `:223-245`ish) was added ahead of it after `46e62a34`, shifting every line below. Re-locate by the `if (e instanceof AnalysisError) {` text, not either line number, when implementing. Modify this branch:
  ```ts
  if (e instanceof AnalysisError) {
    dispatch(analysisActions.setHalted({ manuscriptId, code: e.code, message: e.message, fixes: e.fixes }));
    dispatch(
      e.code === 'analyzer-reasoning-overflow'
        ? notificationsActions.pushToast({
            kind: 'error',
            message: e.message,
            fixes: e.fixes,
            dedupeKey: 'analysis-stream',
          })
        : notificationsActions.pushToast({
            kind: 'error',
            message: e.message,
            dedupeKey: 'analysis-stream',
          }),
    );
    return;
  }
  ```
  Both branches share `dedupeKey: 'analysis-stream'` — the SAME key the
  `language_unset` branch above and the generic transport-failure branch
  below already use — so a reasoning-overflow toast REPLACES whatever plain
  toast this manuscript's stream already pushed (the slice's own dedupe-by-key
  merge in `pushToast`'s reducer already does this; no new merge logic is
  needed), rather than stacking a second toast. `ToastStack` routes a
  `t.fixes` toast to `<ReasoningOverflowToast>` instead of the generic
  6 s-auto-dismissing `ToastItem` (below) — that toast, not the plain one, is
  what "survives navigation" describes.
- Modify: `src/lib/types.ts:1073` (`{ kind: 'advanced' }` → `{ kind: 'advanced'; focusKey?: string }`)
- Modify: `src/lib/router.ts:49-50` (`stageToHash`'s `'advanced'` case, mirroring the `'help'` case's `?code=` pattern at `:45-48`) and `:79-97` (`stageEqual` — add an `'advanced'` branch comparing `focusKey`, mirroring the existing `'help'` branch at `:93-95` that compares `focusCode`)
- Modify: `src/routes/index.tsx:471-475` (`AdvancedRoute`, mirroring `HelpRoute` at `:491-495`)
- Modify: `src/store/notifications-slice.ts:43-55` (`Toast`, add `fixes?: AnalysisFailureFix[]`), `:63-69` (`PushToastPayload`, same), `:75-101` (`pushToast` reducer — `fixes` threads through the existing dedupe-merge path with no new branch: the reducer already overwrites `message`/`kind` on a dedupe hit, so add `existing.fixes = fixes;` beside those two lines)
- Modify: `src/components/toast-stack.tsx:32-34` (route a `t.fixes` toast to a new component, mirroring the `t.nudge` → `VoiceNudgeToast` branch — check `t.fixes` before `t.nudge` since a future toast could carry both, though none does yet)
- Create: `src/components/reasoning-overflow-toast.tsx` — no auto-dismiss timer (mirrors `VoiceNudgeToast`'s exemption from `ToastItem`'s 6 s timer), renders the "How to fix" list via `fixHref` + `wikiUrl`, a dismiss button
- Create: `src/lib/failure-fixes.ts` — `fixHref(fix)`, the ONE place that turns a structured fix's `settingKey` into a link (or `null` for a label-only fix). 3d adds an `endpointField` branch and 5a a `reasoningSetting` branch to this same function; neither renderer changes.
- Modify: `src/views/analysing.tsx` — `error` state type (add `fixes`), the catch block at `:648-660` on the current checkout (both `setHalted`'s payload AND `setError`'s object gain `fixes` from the caught `AnalysisError` — `const fixes = e instanceof AnalysisError ? e.fixes : undefined;`; the view's OWN `dispatch(analysisActions.setHalted({ manuscriptId, code, message, fixes }))` at `:648-654` must carry `fixes` too, so it agrees with the middleware's dispatch (both bullets above) rather than one of the two dispatchers silently omitting it), and the RUN-LEVEL "What to do:" block (`:1342-1344`) — see the next bullet for why the per-chapter block at `:1592-1594` is explicitly excluded. That run-level block ALSO renders `haltFixes` from the halted-run snapshot (`useAppSelector` on `activeStream.haltFixes`, guarded to the same manuscript) when `error` is null but the stream is halted — this is what lets a user who navigated away and back in the SAME session see the fixes without re-triggering the failure; a real cross-session rejoin does not carry them (see the last-outcome bullet above). **Add no new toast-pushing effect here (review correction).** `analysing.tsx` already pushes plain `kind: 'warn'` toasts of its own, unrelated to this task, at `:588` and `:893` on the current checkout (the `onWarning` handler's `cast_merge_base_stale` dedupe — untouched by this task). What this task drops is only the earlier draft's plan to ALSO add a `useEffect` dispatching the reasoning-overflow `pushToast` from this view; the middleware bullet above is the only place THAT toast is pushed. Do not add a second dispatch site for it here.
- **Per-chapter block excluded (review finding).** `analysing.tsx:1592-1594` is inside `failedChapters.map((f) => …)` — one row PER FAILED CHAPTER, not the run-level failure block. Task 2.9's reasoning-overflow rule rethrows at every dispatch point instead of ever recording a `chapter-failed` entry (the whole point of "stop new spend" is that it is RUN-fatal, not per-chapter), so `f.code` is never `analyzer-reasoning-overflow` and this block never has `fixes` to render. Render the "How to fix" list ONLY in the run-level block (`:1342`-area); add a `error.fixes && error.fixes.length > 0` guard there and touch the per-chapter block not at all.
- Modify: `src/views/advanced.tsx` — read `focusKey` from the hydrated stage, scroll the matching row into view and highlight it, mirroring `help.tsx`'s existing `focusCode` pattern (`ref` + a `scrolledForRef` once-per-focus guard + optional-chained `scrollIntoView?.()`, `help.tsx:220-233`) rather than `document.getElementById`.
- Modify: `docs/wiki/Analysis-and-the-Analyzer.md` — new section "When a model thinks past its output limit"
- Modify: `src/lib/wiki-links.ts` — add `export function isWikiPage(value: string): value is WikiPage`, checking membership in the existing `WikiPage` union (a `Set` built from the same literals, not `Object.values` — the union is type-only, not a runtime object). `'Analysis-and-the-Analyzer'` is already in the union (`:18`, confirmed by reading the file) — this task adds no new page there, only the guard function. 3d adds the new endpoints page name when it creates `docs/wiki/OpenAI-Compatible-Analyzer-Endpoints.md`.
- Test (create): `src/lib/router.test.ts` (or the existing router test file, if one already covers `stageToHash`) — `?focus=` round-trip and `stageEqual`; `src/lib/failure-fixes.test.ts` — `fixHref`; `server/src/routes/failure-taxonomy-fixes.test.ts` — the guard; `src/components/reasoning-overflow-toast.test.tsx`; extend `server/src/routes/failure-taxonomy.test.ts`'s `AnalyzerReasoningOverflowError` describe (Task 2.9) with a `fixes` assertion; extend `src/store/analysis-stream-middleware.test.ts` with the persistent-toast case (below); extend `src/routes/index.test.tsx` with a `renderAtAdvanced` helper (below); extend `src/lib/wiki-links.test.ts` with `isWikiPage` cases (below); e2e (Step 8, below).

**Interfaces:**
- Produces (all in `server/src/routes/failure-taxonomy.ts`):
  ```ts
  export interface AnalysisFailureFix {
    label: string;
    settingKey?: string;
    endpointField?: { endpointId: string; field: string };  // 3b+
    wikiPage?: string;   // a page NAME, e.g. 'Analysis-and-the-Analyzer' — never an #anchor
    reasoningSetting?: { engine: 'gemini' | 'ollama'; model: string };  // 5a
  }
  export function reasoningOverflowFixes(ctx: {
    transport: TransportKind;   // 'openai' returns [] until 3b
    model: string;
    endpointId?: string;        // unused in 2b; 3b starts passing it
  }): AnalysisFailureFix[];
  ```
  **Settled: no mirrored server union.** `wikiPage` is a plain `string` on the
  server, in `AnalysisFailureFix`, and in the OpenAPI schema — the server has
  no reason to import or duplicate the frontend's `WikiPage` literal union.
  The guard (below) is what keeps a server-side `wikiPage` honest: it asserts
  the named file exists under `docs/wiki/`, not that the string is a member of
  any TypeScript union. On the frontend, `fixHref`'s caller (each renderer)
  narrows the untyped `string` with `isWikiPage(value): value is WikiPage`
  (a new export from `src/lib/wiki-links.ts`, checking membership in the
  existing `WikiPage` union — e.g. `Object.values` isn't right for a type-only
  union; implement it as an explicit `Set` of the same literals, or a helper
  that checks `page in WIKI_PAGE_SET` where `WIKI_PAGE_SET` is built once from
  the union via a const array this task adds alongside it) BEFORE calling
  `wikiUrl(page)`. An unknown page renders NO wiki-link entry at all, rather
  than a broken URL.

  **The wiki link is its own fix entry, not a field tacked onto every fix
  (review).** A `wikiPage` value names a whole PAGE — it cannot point at the
  section the fix is actually about ("no anchors", `wiki-links.ts:1-4`) — so
  putting it on every fix would render the same page link N times with no way
  to say WHICH part of that page explains the failure. Instead, each engine's
  list ends with exactly ONE entry whose `label` names the section directly:
  `{ label: "Read: When a model thinks past its output limit", wikiPage: 'Analysis-and-the-Analyzer' }`.
  Every other fix in the list carries no `wikiPage` at all. The renderer shows
  a `wikiPage` entry as a wiki link (`isWikiPage` + `wikiUrl`, below); it shows
  a `settingKey` entry as an Advanced Settings link (`fixHref`); a fix with
  neither (the label-only "switch model" entry) renders as plain text. No
  entry ever carries both `settingKey` and `wikiPage`.
  - **Gemini fixes** (2b), in order: `{ label: 'Lower Gemini max input tokens per request', settingKey: 'analyzer.gemini.maxInputTokensPerRequest' }`; `{ label: 'Lower the Gemini output-heavy chunk size', settingKey: 'analyzer.gemini.outputHeavyChunkChars' }`; conditionally — only when `analyzer.gemini.maxOutputTokens` is a NON-ZERO configured value below the model's known limit (`getCachedGeminiModelInfo(model)?.outputTokenLimit`; omit entirely when Auto (`0`) or the limit is unknown) — `{ label: 'Raise Gemini max output tokens (or set it back to Auto)', settingKey: 'analyzer.gemini.maxOutputTokens' }`; label-only `{ label: 'Switch to a different analyzer model' }` (F13 — no `settingKey`, so `fixHref` returns `null` and it renders as plain text); and LAST, the one wiki-link entry, `{ label: 'Read: When a model thinks past its output limit', wikiPage: 'Analysis-and-the-Analyzer' }`.
  - **Ollama fixes** (2b), in order: `{ label: 'Raise Ollama num_ctx (the binding limit)', settingKey: 'analyzer.ollama.numCtx' }`; `{ label: 'Lower the stage-1 local input fraction', settingKey: 'analyzer.stage1.localInputFraction' }`; `{ label: 'Lower the stage-2 local input fraction', settingKey: 'analyzer.stage2.localInputFraction' }`; the same label-only `'Switch to a different analyzer model'` fix; and the SAME wiki-link entry last.
  - **`openai`** (2b): `return [];` — 3b (Task 3b.1b) adds the branch, ending with the endpoints page's own wiki-link entry (F3), not this one.
  - The thinking window (`analyzer.gemini.thinkingIdleTimeoutMs`) never appears in either branch: it bounds silence, not output room, so it cannot fix an overflow (F7).
- Consumes: `getCachedGeminiModelInfo` (Task 2.5), `allKnobs` (`server/src/config/registry.ts`), `AnalyzerReasoningOverflowError.transport` (`TransportKind`, contract).

**Guard test (server/src/routes/failure-taxonomy-fixes.test.ts) — proven able
to fail, and proven to actually exercise the conditional branch (review
finding: a guard that never seeds the catalog never makes the conditional
Gemini `maxOutputTokens` fix appear at all, so it would pass on a BROKEN
implementation of that branch just as readily as a correct one).**
```ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { reasoningOverflowFixes } from './failure-taxonomy.js';
import { allKnobs } from '../config/registry.js';
import { _seedGeminiCatalogForTest, _resetGeminiCatalogForTest } from './catalog/gemini-catalog.js';

/* #3084 F7 — resolved from this FILE's own location, never cwd-relative: the
   server test suite runs with cwd `server/`, so a bare 'docs/wiki/...' would
   resolve to `server/docs/wiki/...`, which does not exist. Mirrors
   `src/lib/wiki-links.test.ts:20-21`'s `fileURLToPath(import.meta.url)`
   pattern and W3cd's later append to this same file. */
const wikiDir = fileURLToPath(new URL('../../../docs/wiki/', import.meta.url));

const CONTEXTS = [
  { transport: 'gemini' as const, model: 'gemini-3.6-flash' },
  { transport: 'ollama' as const, model: 'qwen3.5:9b' },
  { transport: 'openai' as const, model: 'm', endpointId: 'lab' },
];

describe('reasoningOverflowFixes — every settingKey/wikiPage is real (#3084 wave 2b, F7)', () => {
  afterEach(() => {
    _resetGeminiCatalogForTest();
    delete process.env.ANALYZER_MAX_OUTPUT_TOKENS;
  });

  it('every settingKey allKnobs() actually has, across every branch including the conditional one', () => {
    const keys = new Set(allKnobs().map((k) => k.key));
    /* Seed the catalog with a KNOWN outputTokenLimit, then configure a value
       below it — only this combination makes the conditional Gemini
       maxOutputTokens fix actually appear. Without the seed,
       getCachedGeminiModelInfo(model) is undefined and that branch never
       runs at all, so its settingKey would never be checked by anything
       below — proving the seed is load-bearing, not decorative. */
    _seedGeminiCatalogForTest('test-key', [{ id: 'gemini-3.6-flash', outputTokenLimit: 65_536 }]);
    process.env.ANALYZER_MAX_OUTPUT_TOKENS = '4096'; // below the seeded 65536
    const gemini = reasoningOverflowFixes(CONTEXTS[0]);
    expect(gemini.some((f) => f.settingKey === 'analyzer.gemini.maxOutputTokens')).toBe(true);
    for (const ctx of CONTEXTS) {
      for (const fix of reasoningOverflowFixes(ctx)) {
        if (fix.settingKey) expect(keys.has(fix.settingKey), fix.settingKey).toBe(true);
      }
    }
  });

  it('every wikiPage names a file that exists under docs/wiki/ (resolved from this file, not cwd)', () => {
    for (const ctx of CONTEXTS) {
      for (const fix of reasoningOverflowFixes(ctx)) {
        if (fix.wikiPage) expect(existsSync(`${wikiDir}${fix.wikiPage}.md`), fix.wikiPage).toBe(true);
      }
    }
  });

  it('never offers the thinking window as a fix (it bounds time, not output room)', () => {
    for (const ctx of CONTEXTS) {
      expect(reasoningOverflowFixes(ctx).map((f) => f.settingKey)).not.toContain(
        'analyzer.gemini.thinkingIdleTimeoutMs',
      );
    }
  });

  it('openai returns no fixes yet (3b adds them)', () => {
    expect(reasoningOverflowFixes(CONTEXTS[2])).toEqual([]);
  });
});
```
Mutation row (proves the guard can actually fail, per review): change the
Gemini branch's `settingKey: 'analyzer.gemini.maxInputTokensPerRequest'` to
`settingKey: 'analyzer.gemini.doesNotExist'`. Expected red: `every settingKey
allKnobs() actually has, across every branch including the conditional one`
(`keys.has('analyzer.gemini.doesNotExist')` is `false`). Restore it. Each wave
that adds a fix (3b endpoints, 5a reasoning-level, 5b payload) appends to this
same guard file — record that convention in this task's PR body.

**Fixes-content tests (the guard checks every key is REAL; these check it is
the RIGHT one — a wrong-but-valid key, e.g. `numPredict` where `numCtx` is
meant, passes the guard and needs its own assertion, per review).** Append to
the guard test file:
```ts
describe('reasoningOverflowFixes — the RIGHT key, not just a valid one (#3084 wave 2b, F7)', () => {
  it('Ollama names numCtx, the binding limit — not numPredict', () => {
    const keys = reasoningOverflowFixes({ transport: 'ollama', model: 'qwen3.5:9b' }).map((f) => f.settingKey);
    expect(keys).toContain('analyzer.ollama.numCtx');
    expect(keys).not.toContain('analyzer.ollama.numPredict');
  });

  it('Gemini names maxInputTokensPerRequest and outputHeavyChunkChars', () => {
    const keys = reasoningOverflowFixes({ transport: 'gemini', model: 'gemini-3.6-flash' }).map((f) => f.settingKey);
    expect(keys).toContain('analyzer.gemini.maxInputTokensPerRequest');
    expect(keys).toContain('analyzer.gemini.outputHeavyChunkChars');
  });

  it('both engines end with a label-only "switch model" fix, then the ONE wiki-link entry, last (#3084 F7, review)', () => {
    for (const ctx of [{ transport: 'gemini' as const, model: 'gemini-3.6-flash' }, { transport: 'ollama' as const, model: 'qwen3.5:9b' }]) {
      const fixes = reasoningOverflowFixes(ctx);
      const last = fixes[fixes.length - 1];
      expect(last).toEqual({ label: 'Read: When a model thinks past its output limit', wikiPage: 'Analysis-and-the-Analyzer' });
      expect(fixes.some((f) => f.label === 'Switch to a different analyzer model' && !f.settingKey && !f.wikiPage)).toBe(true);
      // No fix ever names both a settingKey and a wikiPage — the wiki link is
      // its own entry, never a field bolted onto a setting-changing fix.
      for (const f of fixes) expect(f.settingKey && f.wikiPage, JSON.stringify(f)).toBeFalsy();
    }
  });
});
```
Mutation row (the companion to row 12 above): change the Ollama branch's
`settingKey: 'analyzer.ollama.numCtx'` to `settingKey: 'analyzer.ollama.numPredict'`.
Expected red: `Ollama names numCtx, the binding limit — not numPredict` (fails
BOTH assertions). The guard test above stays GREEN under this mutation —
`numPredict` is a real registry key — which is exactly why this content test
exists in addition to the guard, not instead of it. Restore it.

**Router (pure, tested).** `stageToHash`'s `'advanced'` case, built with
`URLSearchParams` from the start — per the wave 5 review, matching how the
existing `'ready'` case (`:59-66`) already builds its query string, and NOT a
template literal — because Task 5.5c adds `reasoningEngine`/`reasoningModel`
to this SAME builder rather than adding a second `'advanced'` case; a
template-literal `?focus=` string would need a second, incompatible
concatenation scheme bolted on later, while `URLSearchParams` just grows more
`.set()` calls:
```ts
    case 'advanced': {
      const q = new URLSearchParams();
      if (stage.focusKey) q.set('focus', stage.focusKey);
      const s = q.toString();
      return s ? `#/advanced?${s}` : '#/advanced';
    }
```
**5a extends this same builder** — when it lands, it adds
`if (stage.reasoningEngine) q.set('reasoningEngine', stage.reasoningEngine);`
(and the matching line for `reasoningModel`) to this SAME `case 'advanced':`
block, not a parallel one. Task 2.9a's own test suite is written so this
extension keeps the round-trip test green: it asserts on `URLSearchParams`
membership (`new URLSearchParams(href.split('?')[1] ?? '').get('focus')`), not
on the exact string layout, so a later query param appearing alongside
`focus=` does not break it.

Test (round-trip, no DOM): `stageToHash({ kind: 'advanced' })` → `'#/advanced'`;
`stageToHash({ kind: 'advanced', focusKey: 'analyzer.gemini.maxInputTokensPerRequest' })`
→ `'#/advanced?focus=analyzer.gemini.maxInputTokensPerRequest'` (`URLSearchParams`
encodes `.` unescaped, same as the literal did — confirm this in the test
rather than assume it, since it is exactly the kind of encoding detail that
differs between a hand-built template and `URLSearchParams`).

`stageEqual` (`:79-97`) gains a branch beside the existing `'help'` one
(`:93-95`, which compares `focusCode`):
```ts
  if (a.kind === 'advanced' && b.kind === 'advanced') {
    return a.focusKey === b.focusKey;
  }
```
placed directly after the `'help'` branch — this is the ONE `'advanced'`
branch wave 5's Task 5.5c extends (comparing `reasoningFocus` too) rather than
adding a second. Without it, navigating from one `#/advanced?focus=<key>`
link to a different key while already on the Advanced Settings view would
read as "the same stage" (today's `stageEqual` falls through to `return true`
for two same-`kind` stages once `bookId` matches, i.e. both `undefined`), so
the hydrate effect would not re-run and the scroll-and-highlight would not
fire for the second link. Test: `stageEqual({ kind: 'advanced', focusKey: 'a' }, { kind: 'advanced', focusKey: 'b' })`
→ `false`; `stageEqual({ kind: 'advanced' }, { kind: 'advanced' })` → `true`.

`AdvancedRoute` (`src/routes/index.tsx:471-475`) — the ONE route wave 5's Task
5.5c extends (reading `reasoningEngine`/`reasoningModel` too) rather than
adding a second — becomes:
```tsx
function AdvancedRoute() {
  const [searchParams] = useSearchParams();
  const focusKey = searchParams.get('focus') ?? undefined;
  useHydrateStage({ kind: 'advanced', focusKey }, [focusKey]);
  return <AdvancedView />;
}
```
mirroring `HelpRoute` (`:491-495`) exactly. Test (`src/routes/index.test.tsx`)
— 46e62a34 has ONLY `SetupRoute`/`AnalysingRoute`/`BooksRoute` describes with
`renderAtSetup`/`renderAtAnalysing` helpers and no `HelpRoute` case at all
(confirmed by reading the file — do not cite a `HelpRoute` test as precedent,
there isn't one), so this task adds the FIRST test for this pattern, modelled
on `renderAtAnalysing` (`:181-195`):
```tsx
function renderAtAdvanced(store: ReturnType<typeof makeStore>, path = '/advanced') {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={<div data-testid="suspense-loading" />}>
          <Routes>
            <Route path="/advanced" element={<AdvancedRoute />} />
          </Routes>
        </Suspense>
      </MemoryRouter>
    </Provider>,
  );
}

describe('AdvancedRoute — focus query param hydrates the stage (#3084 wave 2b, F7)', () => {
  it('reads ?focus= into ui.stage.focusKey', () => {
    const store = makeStore();
    renderAtAdvanced(store, '/advanced?focus=analyzer.gemini.maxInputTokensPerRequest');
    expect(store.getState().ui.stage).toMatchObject({
      kind: 'advanced',
      focusKey: 'analyzer.gemini.maxInputTokensPerRequest',
    });
  });

  it('omits focusKey with no query param', () => {
    const store = makeStore();
    renderAtAdvanced(store);
    expect(store.getState().ui.stage).toMatchObject({ kind: 'advanced' });
    expect((store.getState().ui.stage as { focusKey?: string }).focusKey).toBeUndefined();
  });
});
```

**Shared link helper (avoids duplicating the link logic in two renderers).**
`analysing.tsx`'s run-level "What to do:" block and the new toast component
both render the same "How to fix" list, and later waves add more fix shapes
(3d's `endpointField`, 5a's `reasoningSetting`) — each another kind of link.
Rather than branch on `fix.settingKey`/`fix.endpointField`/etc. inline in both
places, this task creates one small pure module both renderers call:
```ts
// src/lib/failure-fixes.ts
import { stageToHash } from './router.js';
import type { components } from './api-types.js';

type AnalysisFailureFix = components['schemas']['AnalysisFailureFix'];

/** #3084 F7 — one place that turns a structured fix's settingKey into a
    clickable link (or null, for a label-only fix, e.g. "switch model"). 3d
    adds the endpointField branch, 5a the reasoningSetting branch; neither
    renderer changes when they land. The wiki link (fix.wikiPage) is built
    separately by each renderer via wikiUrl() from src/lib/wiki-links.ts —
    that helper already exists and this module has no reason to wrap it. */
export function fixHref(fix: AnalysisFailureFix): string | null {
  if (fix.settingKey) return stageToHash({ kind: 'advanced', focusKey: fix.settingKey });
  return null;
}
```
Test (`src/lib/failure-fixes.test.ts`):
```ts
import { describe, it, expect } from 'vitest';
import { fixHref } from './failure-fixes.js';

describe('fixHref (#3084 wave 2b, F7)', () => {
  it('a settingKey fix links to the focused Advanced Settings row', () => {
    expect(fixHref({ label: 'Lower Gemini max input tokens per request', settingKey: 'analyzer.gemini.maxInputTokensPerRequest' })).toBe(
      '#/advanced?focus=analyzer.gemini.maxInputTokensPerRequest',
    );
  });

  it('a label-only fix (e.g. "switch model") returns null', () => {
    expect(fixHref({ label: 'Switch to a different analyzer model' })).toBeNull();
  });
});
```
Mutation row: change `if (fix.settingKey) return …;` to `return
stageToHash({ kind: 'advanced', focusKey: fix.settingKey });` unconditionally.
Expected red: `fixHref … > a label-only fix … returns null` (receives
`'#/advanced'` instead of `null` — `stageToHash`'s own `qs` logic treats an
`undefined` `focusKey` as "no query string" and still returns a valid, if
wrong, href rather than throwing, so only the return value catches this, not
a crash). Restore it.

**Rendering — run-level only (F7, per review).** In `analysing.tsx`'s
run-level "What to do:" block (`:1342`-area) only:
```tsx
{error.fixes && error.fixes.length > 0 && (
  <div className="mt-2">
    <span className="font-semibold">How to fix:</span>
    <ul className="list-disc pl-5">
      {error.fixes.map((f) => {
        /* #3084 F7 (review) — a fix is exactly one of: a setting link
           (settingKey), a wiki link (wikiPage, its OWN entry — never both
           on the same fix), or plain text (neither, e.g. "switch model"). */
        const settingHref = fixHref(f);
        const wiki = !settingHref && f.wikiPage && isWikiPage(f.wikiPage) ? f.wikiPage : null;
        return (
          <li key={f.label}>
            {settingHref ? (
              <a href={settingHref}>{f.label}</a>
            ) : wiki ? (
              <a href={wikiUrl(wiki)}>{f.label}</a>
            ) : (
              f.label
            )}
          </li>
        );
      })}
    </ul>
  </div>
)}
```
importing `wikiUrl` and `isWikiPage` from `../lib/wiki-links`. `f.wikiPage` is
an untyped `string` off the wire (server sends a plain string; see the
Interfaces section above) — `isWikiPage` narrows it to the frontend's
`WikiPage` union before `wikiUrl` ever sees it, so an unrecognised page
renders the fix's `label` as plain text with no link at all, rather than a
broken href. The per-chapter block (`:1592-1594`) is untouched — see the
Files list bullet above for why it can never have `fixes` to render.
`ReasoningOverflowToast` (below) imports `fixHref`/`wikiUrl`/`isWikiPage` the
same way and renders the identical branch.

Test (`src/views/analysing.test.tsx`, using whatever helper this file's other
error-rendering tests already use to drive the mocked stream into the catch
block that calls `setError`):
```tsx
it('renders a "How to fix" list in the run-level block: a setting link, a label-only fix, and the wiki link (#3084 F7)', async () => {
  mockAnalyseRejectsWith(
    new AnalysisError('boom', 'analyzer-reasoning-overflow', undefined, undefined, undefined, 'Then resume — finished chapters are kept.', [
      { label: 'Raise Ollama num_ctx (the binding limit)', settingKey: 'analyzer.ollama.numCtx' },
      { label: 'Switch to a different analyzer model' },
      { label: 'Read: When a model thinks past its output limit', wikiPage: 'Analysis-and-the-Analyzer' },
    ]),
  );
  renderAnalysingView(); // this file's existing render helper
  await screen.findByText('How to fix:');
  expect(screen.getByRole('link', { name: 'Raise Ollama num_ctx (the binding limit)' })).toHaveAttribute(
    'href',
    '#/advanced?focus=analyzer.ollama.numCtx',
  );
  expect(screen.getByText('Switch to a different analyzer model')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Switch to a different analyzer model' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Read: When a model thinks past its output limit' })).toHaveAttribute(
    'href',
    `${WIKI_BASE}/Analysis-and-the-Analyzer`,
  );
});

it('renders no "How to fix" list when the error carries no fixes (unchanged behaviour)', async () => {
  mockAnalyseRejectsWith(new AnalysisError('boom', 'cast_incomplete'));
  renderAnalysingView();
  await screen.findByText(/Analysis failed|Daily free-tier quota exhausted/);
  expect(screen.queryByText('How to fix:')).toBeNull();
});

it('a wiki-link fix with an unrecognised wikiPage renders its label as plain text, no link (#3084 F7, wiki-links review)', async () => {
  mockAnalyseRejectsWith(
    new AnalysisError('boom', 'analyzer-reasoning-overflow', undefined, undefined, undefined, 'x', [
      { label: 'Read: When a model thinks past its output limit', wikiPage: 'Not-A-Real-Wiki-Page' },
    ]),
  );
  renderAnalysingView();
  await screen.findByText('Read: When a model thinks past its output limit');
  expect(screen.queryByRole('link', { name: 'Read: When a model thinks past its output limit' })).toBeNull();
});

it('renders haltFixes from a halted-run snapshot when there is no live error (session-local, not a rejoin) (#3084 F7)', async () => {
  // Seed the store's activeStream snapshot directly, as if setHalted had
  // already fired earlier in this session (no live `error` state — the
  // component just mounted fresh on this manuscript).
  const store = makeStore({ /* whatever this file's other pre-seeded-store tests pass */ });
  store.dispatch(
    analysisActions.setHalted({
      manuscriptId: BOOK_ID, // this file's existing test manuscript id constant
      code: 'analyzer-reasoning-overflow',
      message: 'boom',
      fixes: [{ label: 'Raise Ollama num_ctx (the binding limit)', settingKey: 'analyzer.ollama.numCtx' }],
    }),
  );
  renderAnalysingView({ store }); // pass the pre-seeded store, matching this file's own render-helper signature
  await screen.findByText('How to fix:');
  expect(screen.getByRole('link', { name: 'Raise Ollama num_ctx (the binding limit)' })).toHaveAttribute(
    'href',
    '#/advanced?focus=analyzer.ollama.numCtx',
  );
});
```
Mutation row: delete the `haltFixes` rendering branch's read of
`activeStream.haltFixes` (fall back to always `undefined`). Expected red:
`renders haltFixes from a halted-run snapshot …` (`screen.findByText('How to
fix:')` never resolves). Restore it.

Direct unit test (`src/lib/wiki-links.test.ts`, extending the existing file):
```ts
describe('isWikiPage (#3084 wave 2b, F7)', () => {
  it('accepts every real page, including Analysis-and-the-Analyzer', () => {
    expect(isWikiPage('Analysis-and-the-Analyzer')).toBe(true);
    expect(isWikiPage('Advanced-Settings')).toBe(true);
  });

  it('rejects an unknown string', () => {
    expect(isWikiPage('Not-A-Real-Wiki-Page')).toBe(false);
  });
});
```
Mutation row: change `isWikiPage`'s body to `return true;` unconditionally.
Expected red: `isWikiPage … > rejects an unknown string` and the
`analysing.test.tsx` case above (a link now renders for the bogus page,
instead of plain text). Restore it.

`mockAnalyseRejectsWith`/`renderAnalysingView` are placeholders for whatever
this file's existing tests already call to inject a rejected analyse stream
and mount the view — match their real names at implementation time rather
than inventing new ones. `WIKI_BASE` is imported from `../lib/wiki-links`,
same as `wiki-links.test.ts` already imports it.

**The persistent toast — pushed from the middleware, not this view.** No
effect is added to `analysing.tsx` for this. The middleware bullet in Files
above is the ONLY dispatch site for the reasoning-overflow toast; `error`
state here exists purely for this view's own inline rendering while mounted.
`ToastStack` routes a `t.fixes` toast to `<ReasoningOverflowToast>` (new,
mirroring `VoiceNudgeToast`'s exemption from `ToastItem`'s 6 s
`AUTO_DISMISS_MS` timer): it renders the same "How to fix" list plus a
dismiss button (`dispatch(notificationsActions.dismissToast(toast.id))`).
Because toasts live in the global `notifications` slice and the middleware
(not the view) pushes this one, it is visible from any view until dismissed —
navigating away from the Analysing view neither removes it nor re-pushes it.

Test (`src/store/analysis-stream-middleware.test.ts`, extending the existing
suite — mirroring the real `flips state to halted when the SSE rejects with
AnalysisError code=attribution_drift` test at `:430-448` exactly: `buildStore()`,
`setActiveStream(baseSnapshot)`, `lastCall().reject(...)`, two
`await Promise.resolve()`, then read `store.getState()`):
```ts
it('a reasoning-overflow AnalysisError pushes ONE toast carrying fixes under dedupeKey analysis-stream (#3084 F7)', async () => {
  const store = buildStore();
  store.dispatch(analysisActions.setActiveStream(baseSnapshot));
  const fixes = [{ label: 'Raise Ollama num_ctx (the binding limit)', settingKey: 'analyzer.ollama.numCtx' }];
  lastCall().reject(new AnalysisError('boom', 'analyzer-reasoning-overflow', undefined, undefined, undefined, undefined, fixes));
  await Promise.resolve();
  await Promise.resolve();
  const toasts = store.getState().notifications.toasts;
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatchObject({ kind: 'error', dedupeKey: 'analysis-stream', fixes });
});

it('a non-reasoning-overflow AnalysisError still pushes the plain toast, with no fixes field (unchanged behaviour)', async () => {
  const store = buildStore();
  store.dispatch(analysisActions.setActiveStream(baseSnapshot));
  lastCall().reject(new AnalysisError('drift', 'attribution_drift'));
  await Promise.resolve();
  await Promise.resolve();
  const toasts = store.getState().notifications.toasts;
  expect(toasts).toHaveLength(1);
  expect(toasts[0].fixes).toBeUndefined();
});
```
Mutation row (a REAL red, not an equivalent mutant): in the middleware's
`AnalysisError` branch, delete `fixes: e.fixes` from the `pushToast` call
inside the `analyzer-reasoning-overflow` arm of the ternary. Expected red: `a
reasoning-overflow AnalysisError pushes ONE toast carrying fixes under
dedupeKey analysis-stream` (`toasts[0].fixes` is `undefined`, not the `fixes`
array). The second test stays green under this mutation (it never checks
`fixes` being PRESENT, only absent) — that asymmetry is why both tests exist:
the first proves the field is wired for the code that needs it, the second
proves the wiring didn't leak into a code that must never carry it. Restore it.

**Advanced Settings scroll-and-highlight — mirrors `help.tsx`'s existing
pattern exactly**, rather than `document.getElementById` (jsdom-unsafe
without the optional chaining `help.tsx:167,221` already establishes as this
codebase's convention):
```tsx
const focusedRef = useRef<HTMLDivElement | null>(null);
const scrolledForRef = useRef<string | undefined>(undefined);
useEffect(() => {
  if (!focusKey) return;
  if (scrolledForRef.current === focusKey) return;
  if (focusedRef.current) {
    focusedRef.current.scrollIntoView?.({ block: 'center' });
    scrolledForRef.current = focusKey;
  }
}, [focusKey, /* the section-expanded state, so this re-runs once the row actually mounts */]);
```
with `ref={d.key === focusKey ? focusedRef : undefined}` on the matching
`OverrideRow`/`PromptRow`, and **`data-highlighted="true"` set on that same
element** for ~2 s, keyed off `scrolledForRef.current === focusKey` (a
`useState<boolean>` toggle cleared by `setTimeout(2000)`, same shape as
`help.tsx`'s own highlight timer). The attribute, not a class name, is what
both the implementation and its test agree on — an explicit contract neither
side has to keep in sync with the other's CSS. If `focusKey`'s row's group
starts collapsed, this effect must also expand that group first — mirror
`help.tsx:210-218`'s late-hydration merge into `expanded` state.

Test (`src/views/advanced.test.tsx`):
```tsx
describe('Advanced Settings — scroll-and-highlight (#3084 wave 2b, F7)', () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  afterEach(() => {
    // jsdom has no scrollIntoView; other tests in this file, and other
    // files, must not inherit whatever this suite stubbed it to.
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it('scrolls the focused row into view and sets data-highlighted once', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderAdvancedAt({ focusKey: 'analyzer.gemini.maxInputTokensPerRequest' }); // use whatever render helper this file's other tests already use
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/Gemini max input tokens per request/i).closest('[data-highlighted="true"]')).toBeTruthy();
  });
});
```

**Wiki section.** `docs/wiki/Analysis-and-the-Analyzer.md`, new section "When
a model thinks past its output limit": what a reasoning overflow is (the model
spent its whole output budget on hidden reasoning and returned no answer text
— splitting the chapter cannot help, since the same settings overflow again on
a smaller chunk too), the settings that fix it per engine (mirroring
`reasoningOverflowFixes`'s branches, including "switch model"), and a note
that the thinking window is a different knob that bounds silence, not output
room. The endpoint half of this same heading is 3d's job (F3), not this
task's.

- [ ] **Step 1: Write the failing tests** — the guard test (proven able to
  fail, above); the router round-trip + `stageEqual`; the `AdvancedRoute`
  tests; `failure-taxonomy.test.ts`'s extended assertions; the middleware's
  two new cases; a `reasoning-overflow-toast.test.tsx` asserting no timer
  fires within 6 s of mount (fake clock) and that a dismiss button removes
  the toast; `analysing.test.tsx`'s run-level "How to fix" rendering case;
  `advanced.test.tsx`'s scroll-and-highlight case.
- [ ] **Step 2: Run and confirm each fails** — `reasoningOverflowFixes is not
  a function`; the router/`stageEqual` tests fail on the unchanged
  `'#/advanced'` case and the missing branch; the `AdvancedRoute` tests fail
  (stage never gains `focusKey`); `failure-taxonomy.test.ts`'s new assertions
  fail (`r.fixes` is `undefined`); the middleware tests fail (one toast, no
  `fixes`, for BOTH cases — the branch doesn't exist yet); the toast/view
  tests fail since neither component/behaviour exists yet.
- [ ] **Step 3: Implement** — per the Files/Interfaces above, in this order:
  `failure-taxonomy.ts`'s new exports → its branch edit → `analysis.ts`'s two
  terminal sites (SSE `error` event only — the `#3004` last-outcome path is
  explicitly NOT touched, per the Files list finding) → the openapi schema +
  `npm run openapi:types` → `types.ts` / `router.ts` / `routes/index.tsx` →
  `analysis-slice.ts` → the notifications-slice / toast-stack / new toast
  component → the middleware → `analysing.tsx` → `advanced.tsx` → the wiki
  section.
- [ ] **Step 4: Run and confirm it passes** —
  ```
  node scripts/tests/knob-docs-sync.test.mjs
  npm --prefix server run test -- src/routes/failure-taxonomy.test.ts src/routes/failure-taxonomy-fixes.test.ts src/routes/analysis.test.ts
  npm run openapi:types
  npx vitest run src/lib/router.test.ts src/lib/failure-fixes.test.ts src/lib/wiki-links.test.ts src/routes/index.test.tsx src/components/reasoning-overflow-toast.test.tsx src/views/analysing.test.tsx src/views/advanced.test.tsx src/store/notifications-slice.test.ts src/store/analysis-stream-middleware.test.ts src/store/analysis-slice.test.ts
  npm run typecheck
  ```
- [ ] **Step 5: Mutation proof** (lighter than usual, per the scope note; the
  guard's own mutation row and `fixHref`'s are already given above with their
  test blocks):
  1. In `reasoningOverflowFixes`, return `[]` unconditionally for every
     transport. Expected red: the extended `failure-taxonomy.test.ts`
     assertion (`r.fixes` is `[]`, no `maxInputTokensPerRequest` entry).
     Restore it.
  2. In `ToastStack`, remove the `t.fixes` branch so a fixes-toast falls
     through to plain `ToastItem`. Expected red: the toast test
     (`AUTO_DISMISS_MS` fires within 6 s). Restore it.
  3. In `stageToHash`'s `'advanced'` case, change `if (stage.focusKey) q.set('focus', stage.focusKey);` to a no-op. Expected red: the router round-trip test (`stageToHash({ kind: 'advanced', focusKey: '…' })` returns bare `'#/advanced'`). Restore it.
  4. (Superseded — see the dedicated mutation row given inline with the
     middleware test above, which deletes `fixes: e.fixes` rather than
     flipping the whole condition; that row is the real, non-equivalent
     mutant per review.)
  5. In `analysis-slice.ts`'s `setHalted` reducer, delete
     `snap.haltFixes = action.payload.fixes;`. Expected red: an
     `analysis-slice.test.ts` case asserting `setHalted({ …, fixes })` stores
     `activeStream.haltFixes` (add one, mirroring the existing `setHalted`
     tests' shape in that file), and the `analysing.test.tsx` case rendering
     `haltFixes` for a halted run with no live `error` (below).
  6. In `stageEqual`, delete the new `'advanced'` branch. Expected red:
     `stageEqual({ kind: 'advanced', focusKey: 'a' }, { kind: 'advanced', focusKey: 'b' })`
     reads `true` instead of `false`. Restore it.
  7. In `analysing.tsx`'s run-level block, change the guard from
     `error.fixes && error.fixes.length > 0` to `false`. Expected red:
     `renders a "How to fix" list in the run-level block when the error
     carries fixes (#3084 F7)` (`screen.findByText('How to fix:')` never
     resolves). Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy-fixes.test.ts server/src/routes/failure-taxonomy.test.ts server/src/routes/analysis.ts openapi.yaml src/lib/api-types.ts src/lib/api.ts src/lib/types.ts src/lib/router.ts src/lib/failure-fixes.ts src/lib/failure-fixes.test.ts src/lib/wiki-links.ts src/lib/wiki-links.test.ts src/routes/index.tsx src/routes/index.test.tsx src/store/analysis-slice.ts src/store/analysis-slice.test.ts src/store/notifications-slice.ts src/store/analysis-stream-middleware.ts src/store/analysis-stream-middleware.test.ts src/components/toast-stack.tsx src/components/reasoning-overflow-toast.tsx src/components/reasoning-overflow-toast.test.tsx src/views/analysing.tsx src/views/analysing.test.tsx src/views/advanced.tsx src/views/advanced.test.tsx docs/wiki/Analysis-and-the-Analyzer.md
git commit -m "feat(server,frontend,openapi): point a reasoning-overflow failure at the settings that fix it (#3084)"
```
- [ ] **Step 7: Regression plan.** Update `docs/features/284-openai-compatible-analyzer.md` with this behaviour (the "How to fix" list, the persistent notification, the deep link) as a new invariant.
- [ ] **Step 8: Playwright e2e (mock mode).** New spec under `e2e/`, in the
  existing mock-mode harness (port 5174): seed a mock SSE fixture (hand-authored,
  since ordinary mock data cannot organically produce this failure — see the
  `api-types.ts` Files bullet above) that emits a terminal `kind: 'error',
  code: 'analyzer-reasoning-overflow'` event carrying `fixes` for a book under
  test. Assert: (1) the Analysing view's run-level "What to do:" block shows a
  "How to fix" list with at least one link; (2) clicking a link navigates to
  `#/advanced` and the corresponding row is visible and carries the highlight
  marker within a short wait; (3) navigating back to the book list and then
  to a different view still shows the toast (or, if the toast auto-clears on
  a fresh mock-data reset between specs, assert it survives at least one
  in-app navigation within the same spec, since the mock harness may not
  preserve it across a full page reload the way a real backend's stream
  would — confirm which is actually the case for THIS harness before writing
  the assertion, rather than assuming). This spec is new coverage this task's
  earlier draft only promised in prose (the spec's own Testing section) without
  ever writing it.

**Tests this task could break:**
- `failure-taxonomy.test.ts`'s `AnalyzerReasoningOverflowError` describe (Task 2.9) — extended, not replaced;
- `src/routes/index.test.tsx` — the FIRST `AdvancedRoute` case in this file (there is no prior one to join);
- `toast-stack.test.tsx` (if one exists) and any test asserting `ToastStack`'s child count/shape for a plain error toast;
- `analysing.test.tsx`'s existing "What to do:" assertions, which must still pass with no `fixes` present;
- `analysis-stream-middleware.test.ts`'s existing generic-`AnalysisError` case, which must still push exactly one plain toast for a non-reasoning-overflow code;
- `analysis-slice.test.ts`'s existing `setHalted` cases, which must still pass with `fixes` absent (optional field, `haltFixes` stays `undefined`);
- anything importing `src/lib/router.ts` for its exports — `failure-fixes.ts` adds a new import of `stageToHash` from there; `npm run check:cycles` is worth an extra look even though `router.ts` imports nothing from `src/lib/`.

**Branch (settled).** The PR 2b branch is `feat/server-3084-w2b-output-cap` — unchanged; branch names are single-scope (`scripts/lib/branch-name.mjs`'s `SCOPE_GROUP`), so this task's frontend work does NOT widen it. Only the PR title and each commit subject use `feat(server,openapi,frontend):`.

### Task 2.10: Ship PR 2b

**Files:**
- Modify: `server/.env.example` (managed block, via `config:sync`)
- Modify: `docs/release-notes-next.md` (section `## 🗣️ Analyzer, script review & manuscript`, `:284`)
- Modify: `RELEASE_NOTES.md` (top of the `# Castwright 1.15.0` bullet list)
- Create: `docs/testing/3084-openai-analyzer-onbox-acceptance.md` (§1–§3). No earlier PR creates it: wave 1's row (PR 1b) has no run sheet, and PR 2a ships no row.
- Modify: `docs/testing/onbox-acceptance-register.md`:
  - "At a glance" table `:554-566`;
  - "Last change" block `:570`;
  - `## Group B` `:4507-4553`;
  - `## Group E` `:4924-…`.
- Modify: `docs/testing/onbox-acceptance-register-live-view.html` (`#gb` `:728-753`, `#ge` `:1019-…`)

**Row ids.** Three ids are minted at ship time from their groups' `next-id` markers (Group B's at `:4509`, Group E's at `:4926` on 46e62a34), checked by `npm run check:onbox-register`:
- `B<next>`: Group B's next id (capacity recalibration);
- `E<next>`: Group E's next id (thinking-window timing);
- `E<next+1>`: the Group E id after it (thinking-model output and the Gemma split).

Inside HTML they read `B&lt;next&gt;`, `E&lt;next&gt;` and `E&lt;next+1&gt;`. Write the minted ids in their place everywhere. In the same commit, bump Group B's marker by one and Group E's by two. PR 1b mints a Group B id too, so re-read the marker on the current `main`; ids are allocated once and never reused.

**Group choice.**
- **"Capacity recalibration" → Group B** ("local Ollama analyzer only, no TTS sidecar"). It needs the 16 GB card and Ollama.
- **"Gemini thinking-window timing" and "Thinking-model output" → Group E** ("not the GPU box"). Each needs only a Gemini key and a real chapter.

- [ ] **Step 1: Derived artifacts**
Run:
```
npm run openapi:types
npm run config:sync
npm run config:check
npm run check:cycles
git status --porcelain
```
Expected:
- `config:sync` rewrites only the managed block of `server/.env.example`: the `ANALYZER_MAX_OUTPUT_TOKENS` line's default becomes 0, and entries for `GEMINI_THINKING_IDLE_MS` and `ANALYZER_GEMINI_REQUEST_CEILING_MS` are added;
- `config:check` PASS;
- `src/lib/api-types.ts` unchanged since Task 2.9's commit.

Commit:
```bash
git add server/.env.example
git commit -m "chore(server): sync .env.example for Gemini output and timeout knobs (#3084)"
```
Settings rows need no frontend change: `src/views/advanced.tsx` renders every knob from `GET /api/config` descriptors.
- [ ] **Step 2: Release notes (both files)**

`docs/release-notes-next.md`, appended as the last bullet of `## 🗣️ Analyzer, script review & manuscript`. Use the real PR numbers of 2a and 2b.
```markdown
- **Gemini output cap is Auto, thinking models get a thinking window instead of the 45 s watchdog, requests have a ceiling, and reasoning overflow stops new spend** — `analyzer.gemini.maxOutputTokens` (`ANALYZER_MAX_OUTPUT_TOKENS`) now defaults to `0` = Auto: the model's `outputTokenLimit` from a 10-minute cached `models.list()` (`catalog/gemini-catalog.ts`), `8192` when the listing is unavailable; an explicit value keeps its meaning and is clamped to the listed limit. The listing is warmed before each request by a warm-up bounded at 10 s and shared by concurrent requests: pause releases that request at once, and the listing is cancelled only when no request still waits. A timeout falls back to `8192`, and cached limits are only ever served for the current API key. Thinking Gemini models (a static id rule: Gemini 2.5 Pro and 2.5 Flash, and every 3.x) request `thinkingConfig.includeThoughts`, so thought parts feed the chunk heartbeat; `thoughtsTokenCount` is recorded as reasoning tokens only on those requests. A new `analyzer.gemini.thinkingIdleTimeoutMs` (`GEMINI_THINKING_IDLE_MS`, default `0` = automatic, maximum 290 000 because the SDK's `fetch` carries undici's fixed 300 s timeouts) bounds every silent gap before a request's answer text starts, including the wait for the first chunk and each gap between thought parts: 120 000 ms for a thinking model, the existing 45 s idle window for any other; a positive value applies to every model. Running out of it fails once as `analyzer-timeout`, naming the setting, with no retry; a model that does not think keeps today's idle retry, and once the answer text starts the 45 s idle watchdog is unchanged. Every Gemini request attempt is bounded by `analyzer.gemini.requestCeilingMs` (`ANALYZER_GEMINI_REQUEST_CEILING_MS`, 30 min) and fails as `analyzer-timeout`. Each attempt logs `[gemini] stream-timing model=… firstChunkMs=… firstAnswerMs=… thoughtPartsBeforeAnswer=…`, with no request or response content. A `length`/`MAX_TOKENS` finish with no answer text and reasoning evidence fails as `analyzer-reasoning-overflow` instead of splitting, and stops new spend: the analysis run ends, and the job starts no new chapter, escalation window or non-story classification call, while chapters already calling the model finish and are cached for resume; script-review, emotion and instruct passes stop as they do on a content block or a daily quota; the attribution eval's review run rethrows it; an attribution-escalation call that overflows skips its window, stops every later escalation window in the job, and ends the run the same way: the job starts no further chapter in any pool (Phase 0, Phase 1 or the subset retry) and halts with `analyzer-reasoning-overflow`, while chapters already dispatched finish and cache. An empty `MAX_TOKENS` with no evidence (Gemma) still splits. An empty Ollama response at the context limit now splits the chunk (or fails as reasoning overflow when the model was thinking) instead of failing as an empty response; its copy names `num_ctx`, the binding limit. **Budget change:** the Gemini per-request input cap is now `min(analyzer.gemini.maxInputTokensPerRequest, the model's TPM)`, so a `GEMINI_TPM_<SLUG>` env var or a saved `rate.tpm.gemma*` override below 12000 now shrinks chunk bodies to fit it; defaults are unchanged. `analyzer.gemini.maxInputTokensPerRequest`'s own maximum is lifted from 60 000 to 1 000 000 to match, since Gemini 3.x accepts up to 1M input tokens. Chunk budgets resolve from an `EngineCapacity` descriptor, pinned byte-identical at defaults by a fixture captured from `main`. **The failure names what happened:** a reasoning-overflow failure now names the chapter, model and engine, and its `remediation` lists concrete settings to raise — each rendered in the Analysing view as a "How to fix" list of deep links straight to the relevant Advanced Settings row (`#/advanced?focus=<key>`, which scrolls to and briefly highlights that row), plus a persistent toast that survives navigating away until dismissed — ending "then resume — finished chapters are kept". (#<2a>, #<2b>, #3084)
```

`RELEASE_NOTES.md`, a new first bullet under `# Castwright 1.15.0`:
```markdown
- **A Gemini model that thinks before it answers no longer stalls on a long chapter.** Some Gemini models reason before replying, and that reasoning counted against a fixed 8,192-token reply limit — so on a big chapter the model could spend its whole allowance thinking and hand back nothing, and Castwright would keep cutting the chapter into smaller pieces without ever getting an answer. Castwright now lets each Gemini model reply up to its own limit, keeps showing activity while the model is thinking, and lets a thinking model stay quiet for up to two minutes at a time before its reply starts, instead of giving up after 45 seconds. When a model genuinely runs out of room while reasoning, Castwright stops starting new work, including the emotion and delivery passes, and says so plainly, naming the setting to raise, instead of grinding through every remaining chapter the same way. Chapters already in progress finish and are kept, so nothing is lost when you resume. The same goes for a local model that fills its context window before writing any answer: Castwright now splits the chapter, or tells you the model ran out of room while thinking, instead of reporting an empty reply. A Gemini request that stays silent past its thinking limit, or runs for more than half an hour, is stopped, and Castwright tells you which setting controls that limit. If you already set your own Gemini output limit, Castwright keeps it. And if you lowered a Gemma model's tokens-per-minute limit below 12,000, Castwright now sends it smaller pieces of each chapter so every request stays within that limit. When it does happen, Castwright now tells you exactly which chapter and model hit the limit, lists the settings that would fix it as clickable links straight to the right row in Advanced Settings, and keeps a notification on screen until you dismiss it — even if you've moved to another page — instead of a message that scrolls away.
```
- [ ] **Step 3: Run sheet**

Create `docs/testing/3084-openai-analyzer-onbox-acceptance.md`:
```markdown
# #3084 OpenAI-compatible analyzer — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run each
> section, on the stated hardware. Do not pre-fill them.
>
> Design of record: [`docs/superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md`](../superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md)
> Implementation plan: [`docs/superpowers/plans/2026-09-11-openai-compatible-analyzer.md`](../superpowers/plans/2026-09-11-openai-compatible-analyzer.md)
> Regression plan: [`docs/features/284-openai-compatible-analyzer.md`](../features/284-openai-compatible-analyzer.md)
> Issue: [#3084](https://github.com/dudarenok-maker/Castwright/issues/3084)

---

## 1. Gemini thinking-window timing on real chapters — register row E<next>

**A measurement that gates nothing.** Wave 2 gives a thinking Gemini model a
thinking window of 120 000 ms (`GEMINI_THINKING_IDLE_TIMEOUT_MS`): every silent
gap before its answer text starts, including the wait for the first chunk, may
last that long. Any other model keeps today's 45 s (plan decision P5). No real
chapter has measured those waits. This section records them and whether the
default should change; a change is its own follow-up PR, within the knob's
290 000 ms maximum.

**Hardware:** any machine with a Gemini API key; no GPU. **Quota:** one chapter
on each of three models. `gemini-3.6-flash` allows 20 requests a day, and §2
also uses it, so run §1 and §2 on different days.

### Preconditions

- [ ] A book with one chapter of 19,000–21,000 characters. Record its title,
      chapter id and exact character count.
- [ ] `GEMINI_THINKING_IDLE_MS` and `ANALYZER_MAX_OUTPUT_TOKENS` are unset
      in `server/.env`, and Advanced Settings has no override for "Gemini
      thinking idle timeout (ms)" or "Gemini max output tokens".
- [ ] The app is started with `npm start`, so that `logs/server.log` is written.
- [ ] A second terminal follows the log: `Get-Content logs/server.log -Wait`
      (PowerShell) or `tail -f logs/server.log` (Git Bash).

### Procedure

For each model in turn — `gemini-3.5-flash-lite`, `gemini-3.6-flash`,
`gemma-4-31b-it`:

1. Select the model for both analysis phases and start a fresh analysis of the
   chapter, so stage 1 (cast detection) and stage 2 (attribution) both call it.
2. Watch the Analysing view. When it moves from cast detection to attribution,
   note the last `[gemini] stream-timing` line printed so far: lines up to it
   are stage 1, lines after it are stage 2. If the view shows both phases
   running at once, record the two stages together and say so.
3. For each stage, record from its `[gemini] stream-timing model=<model> …` lines:
   - the number of lines (request attempts);
   - the largest and the median `firstChunkMs`, and the largest and the median
     `firstAnswerMs`;
   - the largest `thoughtPartsBeforeAnswer`;
   - every `firstAnswerMs=none` line, every `[gemini] stream idle` line, and
     every `analyzer-timeout` failure that names the thinking window.

### Decision

- **Lower the thinking default** if every thinking-model `firstAnswerMs` is far
  below 120 000; record the largest value seen.
- **Raise it, to at most 290 000,** if a thinking-model request failed with
  `analyzer-timeout` naming `analyzer.gemini.thinkingIdleTimeoutMs`. 290 000 is
  the knob's maximum: the SDK's `fetch` ends a request after undici's fixed
  300 s, so no higher value can take effect. If a request still fails at
  290 000, record that and recommend a design follow-up, not a larger value.
- Otherwise record **keep**.

### Result

`gemini-3.5-flash-lite` — Result:

`gemini-3.6-flash` — Result:

`gemma-4-31b-it` — Result:

Recommendation (keep / lower to … / raise to …, at most 290000):

Run by / date / SHA:

---

## 2. Thinking-model output with Auto max output tokens, and Gemma's split — register row E<next+1>

**Hardware:** any machine with a Gemini API key; no GPU. **Quota:**
`gemini-3.6-flash` allows 20 requests a day, and this section runs one chapter
on it twice (Auto, then the 8192 baseline). Start on a fresh daily quota.

### Preconditions

- [ ] The same chapter as §1 (19,000–21,000 characters). Record its title,
      chapter id and exact character count.
- [ ] `ANALYZER_MAX_OUTPUT_TOKENS` is unset in `server/.env`, and Advanced
      Settings has no override for "Gemini max output tokens" (Auto).
- [ ] The app is started with `npm start`, so that `logs/server.log` is written.

### Procedure

1. Analyse the chapter with `gemini-3.6-flash` at Auto.
2. From `logs/server.log` and the Analysing view, record:
   - the `firstChunkMs` and `firstAnswerMs` of each `[gemini] stream-timing` line;
   - whether the chunk heartbeat moved while the model was thinking;
   - every `[gemini] stream idle` line;
   - every `output truncated` line;
   - any `analyzer-reasoning-overflow` failure (it stops the run) and any
     `analyzer-timeout`;
   - the number of Gemini requests the chapter took (AI Studio's RPD counter
     before and after).
3. Set Advanced Settings → "Gemini max output tokens" to `8192`, re-run the
   same chapter, and record the same fields.
4. **Gemma split.** Select `gemma-4-31b-it` for both phases, set "Gemini max
   output tokens" to `64`, and analyse the same chapter. A 64-token cap is far
   below any chapter's reply, so Gemma must stop at `MAX_TOKENS`. Record:
   - every `[gemini] output truncated reason=MAX_TOKENS bytes=0` line;
   - whether a `section N/M` re-split log line follows each of them;
   - any `analyzer-reasoning-overflow` failure;
   - whether the chapter completes. At a 64-token cap it may not; that is
     recorded, not judged.

   **If no `bytes=0` line appears at `64`, this row FAILS.** Record the
   truncation lines that did appear and the SHA. The split recovery is unproven
   until an empty `MAX_TOKENS` has been reproduced.
5. Clear the override (back to Auto).

### Pass

- Auto completes the chapter with no `analyzer-timeout` and no
  reasoning-overflow failure.
- Auto uses no more requests than the 8192 run.
- On `gemma-4-31b-it` at `64`, at least one `bytes=0` truncation appears,
  every one is followed by a re-split, and no `analyzer-reasoning-overflow`
  failure occurs.
- A truncation or overflow in the 8192 run is the baseline being recorded, not
  a failure of this row.

### Result

Auto — Result:

8192 baseline — Result:

Gemma split — Result:

Run by / date / SHA:

---

## 3. Capacity recalibration before any capacity default changes — register row B<next>

**Not a pass/fail acceptance of shipped behaviour.** Wave 2 kept every chunk
budget byte-identical (`server/src/analyzer/capacity-pinning.test.ts`). This
section records the measurement that must exist **before** anyone changes a
capacity default: `analyzer.ollama.numCtx`, the two
`analyzer.stage{1,2}.localInputFraction` knobs, or a clamp to `/api/show`'s
native context (spec §6, "After measurement").

**Hardware:** the 16 GB card, a real Ollama daemon, no TTS engine resident.

### Preconditions

- [ ] A large-context local model is pulled. Record its tag and its
      `/api/show` `model_info.*.context_length`.
- [ ] At least two short-context tags are pulled whose native context is below
      32768. Record each tag and value.
- [ ] *Ночной дозор* (Night Watch), or another book with chapters over 60,000
      characters.

### Procedure

1. **Baseline.** Analyse three large chapters at today's defaults (`num_ctx`
   32768, fractions 0.7 / 0.3). Record per chapter:
   - stage-1 and stage-2 section counts (the "section N/M" log lines);
   - the `output truncated` line count;
   - attribution quality (`scripts/measure-attribution.mjs`, as in register
     row E9).
2. **Large context.** Set `analyzer.ollama.numCtx` to the large model's served
   context — no higher than fits the card; record the value and `ollama ps`
   VRAM. Re-run the same three chapters and record the same figures.
3. **Short-context tags.** For each short-context tag, record `num_ctx` sent
   (32768) against its native context. Run one chapter and record its
   truncation count.

### Result

Baseline — Result:

Large context — Result:

Short-context tags — Result:

Run by / date / SHA:
```
- [ ] **Step 4: Register rows (markdown)**

In `docs/testing/onbox-acceptance-register.md`:
1. **Group B.** Directly before `---` at the end of `## Group B` (after B1, `:4552`; after PR 1b's row if that has merged), insert:
```markdown
### B<next> · Capacity recalibration measured before any capacity default changes ([#3084](https://github.com/dudarenok-maker/Castwright/issues/3084), wave 2) · **the 16 GB card, Ollama only**

Wave 2 moved every chunk-budget resolver onto an `EngineCapacity` descriptor, with budgets pinned byte-identical to `main` (`server/src/analyzer/capacity-pinning.test.ts`). This row is therefore not a regression check. It is the measurement the design requires **before** any capacity default changes — `analyzer.ollama.numCtx`, the two `localInputFraction` knobs, or an `/api/show` context clamp.

On three large chapters, record stage-1/stage-2 section counts, truncation count and attribution quality twice:

- at today's defaults;
- with a large-context model at its served context.

For at least two short-context tags, also record `num_ctx` sent (32768) against `/api/show`'s native context, plus one chapter's truncation count.

Criteria and result lines: [`3084-openai-analyzer-onbox-acceptance.md` §3](3084-openai-analyzer-onbox-acceptance.md). Clears when §3's three `Result:` lines are filled.
```
2. **Group B marker.** Change the Group B marker from `<!-- next-id: B<next> -->` to the id after `B<next>`.
3. **Group E.** At the end of `## Group E`, after its last row and before the next `---`, insert both rows, in this order:
```markdown
### E<next> · Gemini thinking-window timing measured on real chapters ([#3084](https://github.com/dudarenok-maker/Castwright/issues/3084), wave 2) · **any machine with a Gemini key; no GPU**

Wave 2 bounds the silence before a Gemini request's answer text instead of probing each model: a thinking model gets a 120 s thinking window (`GEMINI_THINKING_IDLE_TIMEOUT_MS`, at most 290 s) for the wait for the first chunk and each gap between thought parts, any other model today's 45 s, and each attempt logs `[gemini] stream-timing model=… firstChunkMs=… firstAnswerMs=… thoughtPartsBeforeAnswer=…`. No real chapter has measured those waits. **This row is a measurement: it gates nothing, and it clears once recorded.**

On a 19,000–21,000-character chapter, for stage 1 and stage 2 separately, on `gemini-3.5-flash-lite`, `gemini-3.6-flash` and `gemma-4-31b-it`, record the request count, the largest and median `firstChunkMs` and `firstAnswerMs`, the largest `thoughtPartsBeforeAnswer`, and every `firstAnswerMs=none`, `stream idle` or thinking-window `analyzer-timeout` line. Then record whether the 120 s default should change; a raise goes no higher than 290 s.

Criteria and result lines: [`3084-openai-analyzer-onbox-acceptance.md` §1](3084-openai-analyzer-onbox-acceptance.md). Clears when §1's three `Result:` lines and its recommendation are filled.

### E<next+1> · A thinking Gemini model completes a 20,000-character chapter with Auto output, and Gemma still splits an empty MAX_TOKENS ([#3084](https://github.com/dudarenok-maker/Castwright/issues/3084), wave 2) · **any machine with a Gemini key; no GPU**

Wave 2 made four changes to Gemini analysis:

- the output cap is Auto (the model's own limit, not 8192);
- thinking models are asked for thought summaries and may stay silent for up to 120 s at a time before their answer text;
- an empty `MAX_TOKENS` response with reasoning evidence fails as `analyzer-reasoning-overflow` and stops the run instead of splitting;
- on Gemma, which asks for no thoughts, only a thought part counts as reasoning evidence, so its empty `MAX_TOKENS` still splits.

Unit tests drive all four against a mocked stream. Only a real `gemini-3.6-flash` run proves the #3084 reporter's stall is gone, and only a real `gemma-4-31b-it` run proves Gemma's split recovery survives whatever usage Gemma reports.

On a 19,000–21,000-character chapter, record on `gemini-3.6-flash`, once at Auto and once at `8192`: time to first chunk and to first answer text, whether the heartbeat moves during thinking, idle retries, `analyzer-timeout` failures, truncations, reasoning-overflow failures and request count. Then, on `gemma-4-31b-it` with "Gemini max output tokens" at `64`, record each `output truncated reason=MAX_TOKENS bytes=0` line, whether a re-split follows it, and any `analyzer-reasoning-overflow` failure.

**Pass:** Auto completes with no `analyzer-timeout` and no overflow, using no more requests than the 8192 run; and on Gemma at `64` at least one `bytes=0` truncation appears, each is followed by a re-split, and no `analyzer-reasoning-overflow` failure occurs. **The row fails if no `bytes=0` truncation can be reproduced at `64`.**

Criteria and result lines: [`3084-openai-analyzer-onbox-acceptance.md` §2](3084-openai-analyzer-onbox-acceptance.md).
```
4. **Group E marker.** Change the Group E marker from `<!-- next-id: E<next> -->` to the id two after `E<next>` (the id after `E<next+1>`).
5. **At a glance.** In the table, add 1 to the **B** row's count and 2 to the **E** row's. Add 3 to the `**N owed.**` total on the line after the table.
6. **Last change.** Replace the current `> **Last change: …**` blockquote's first line with a new blockquote. Date it with today's date. For N, use the owed total read from the file before step 5. Its text:
```markdown
> **Last change: <today> (#3084 wave 2b), N → N+3.** Rows **B<next>** (capacity recalibration — the measurement owed before any capacity default changes), **E<next>** (Gemini thinking-window timing on real chapters — a measurement that gates nothing) and **E<next+1>** (a thinking Gemini model on a 20,000-character chapter at Auto output, and Gemma's empty-`MAX_TOKENS` split) added from #3084 wave 2's run sheet (`3084-openai-analyzer-onbox-acceptance.md` §1–§3). Group B `next-id` marker bumped by one, Group E by two.
```
Keep the previous last-change text below it, in the form the file already uses for older entries.
- [ ] **Step 5: Live view rows**

In `docs/testing/onbox-acceptance-register-live-view.html`:
1. **Group B.** In `<section class="group" id="gb">`, insert before its closing `</section>` (today `:753`):
```html
    <details class="item">
      <summary><span class="num">B&lt;next&gt;</span><span class="iname">Capacity recalibration measured before any capacity default changes (#3084 wave 2)</span><span class="risk low">Measurement, 3 parts</span><span class="chev">›</span></summary>
      <div class="body">
        <p>Wave 2 moved every chunk-budget resolver onto an <code>EngineCapacity</code> descriptor, with budgets pinned byte-identical to <code>main</code> (<code>capacity-pinning.test.ts</code>). Nothing here is a regression check: it is the measurement the design requires <b>before</b> any capacity default changes.</p>
        <ul>
          <li><b>Baseline:</b> three large chapters at today's defaults (<code>num_ctx</code> 32768, fractions 0.7 / 0.3) — stage-1/stage-2 section counts, truncation count, attribution quality.</li>
          <li><b>Large context:</b> the same chapters with a large-context model at its served context on the 16 GB card — the same figures, plus <code>ollama ps</code> VRAM.</li>
          <li><b>Short-context tags:</b> for at least two tags, <code>num_ctx</code> sent (32768) against <code>/api/show</code> native context, and one chapter's truncation count.</li>
        </ul>
        <p class="src">The 16 GB card, Ollama only, no TTS engine · run sheet <code>docs/testing/3084-openai-analyzer-onbox-acceptance.md</code> §3 · <a href="https://github.com/dudarenok-maker/Castwright/issues/3084">#3084</a></p>
      </div>
    </details>
```
2. **Group E.** In `<section class="group" id="ge">`, insert both items before its closing `</section>`, in this order:
```html
    <details class="item">
      <summary><span class="num">E&lt;next&gt;</span><span class="iname">Gemini thinking-window timing measured on real chapters (#3084 wave 2)</span><span class="risk low">Measurement, gates nothing</span><span class="chev">›</span></summary>
      <div class="body">
        <p>Wave 2 gives a thinking Gemini model a 120 s thinking window (every silent gap before its answer text, at most 290 s) and any other model today's 45 s, and logs <code>firstChunkMs</code>, <code>firstAnswerMs</code> and <code>thoughtPartsBeforeAnswer</code> for every attempt. No real chapter has measured those waits; this row records them so the default can be tuned.</p>
        <ul>
          <li>On a 19,000–21,000-character chapter, for stage 1 and stage 2, on <code>gemini-3.5-flash-lite</code>, <code>gemini-3.6-flash</code> and <code>gemma-4-31b-it</code>: request count, largest and median <code>firstChunkMs</code> and <code>firstAnswerMs</code>, largest <code>thoughtPartsBeforeAnswer</code>, any <code>firstAnswerMs=none</code>, <code>stream idle</code> or thinking-window <code>analyzer-timeout</code> line.</li>
          <li><b>Record:</b> keep, lower, or raise (to at most 290 s) the 120 s default.</li>
        </ul>
        <p class="src">Any machine with a Gemini key; no GPU · run sheet <code>docs/testing/3084-openai-analyzer-onbox-acceptance.md</code> §1 · <a href="https://github.com/dudarenok-maker/Castwright/issues/3084">#3084</a></p>
      </div>
    </details>
    <details class="item">
      <summary><span class="num">E&lt;next+1&gt;</span><span class="iname">A thinking Gemini model completes a 20,000-character chapter with Auto output, and Gemma still splits (#3084 wave 2)</span><span class="risk hot">The reporter's stall</span><span class="chev">›</span></summary>
      <div class="body">
        <p>Wave 2 made Gemini's output cap Auto (the model's own limit, not 8192), asks thinking models for thought summaries and lets them stay silent for up to 120 s at a time before their answer text, and fails an empty <code>MAX_TOKENS</code> response with reasoning evidence as <code>analyzer-reasoning-overflow</code> instead of splitting. On Gemma only a thought part counts as evidence, so its empty <code>MAX_TOKENS</code> must still split. Unit tests drive all of this against a mocked stream; only real runs prove it.</p>
        <ul>
          <li>On a 19,000–21,000-character chapter at <b>Auto</b> on <code>gemini-3.6-flash</code>: time to first chunk and to first answer text, whether the heartbeat moves during thinking, idle retries, <code>analyzer-timeout</code> failures, truncations, reasoning-overflow failures, request count.</li>
          <li>The same chapter at <b>8192</b> (Advanced Settings → Gemini max output tokens) as the baseline.</li>
          <li><b>Gemma:</b> <code>gemma-4-31b-it</code> at a 64-token cap — at least one <code>bytes=0</code> truncation appears (the row fails if none can be reproduced), every one is followed by a re-split, and no <code>analyzer-reasoning-overflow</code> failure occurs.</li>
          <li><b>Pass:</b> Auto completes with no <code>analyzer-timeout</code> and no overflow, using no more requests than the 8192 run, and the Gemma check holds.</li>
        </ul>
        <p class="src">Any machine with a Gemini key; no GPU; two chapter runs within <code>gemini-3.6-flash</code>'s 20 requests a day · run sheet <code>docs/testing/3084-openai-analyzer-onbox-acceptance.md</code> §2 · <a href="https://github.com/dudarenok-maker/Castwright/issues/3084">#3084</a></p>
      </div>
    </details>
```
3. **Build and check.** Run the register's own procedure (its "Live view" section, `onbox-acceptance-register.md:24-120`):
```
git fetch origin
git merge origin/main
npm run register:build
npm run check:onbox-register
npm run stamp:publish-token
git add docs/testing/onbox-acceptance-register.md docs/testing/onbox-acceptance-register-live-view.html docs/testing/3084-openai-analyzer-onbox-acceptance.md
git commit -m "docs(docs): register on-box rows and run sheet for #3084 wave 2"
npm run check:onbox-register -- --stamped-since origin/main
```
Expected: every command PASS. If `register:build` rewrote the `gcount` spans and the summary strip, those changes are part of the commit.
4. **Publish.** Immediately before publishing:
   1. Read the live page with the `Artifact` tool (`action: "read"`, `url: https://claude.ai/code/artifact/adf22b7b-12dd-49fe-874c-4a340585b26a`); it returns the page's raw HTML saved to a local file.
   2. Run `npm run check:onbox-register -- --against-published <that file>`. Expected: PASS; the three new rows (`B<next>`, `E<next>`, `E<next+1>`) are reported as rows your register adds, which is the reason for publishing.
   3. Publish with the `Artifact` tool: `file_path` = this worktree's absolute `docs/testing/onbox-acceptance-register-live-view.html`, `url` = the URL above. Never publish the `.md`, and never publish without `url`.
- [ ] **Step 6: Verify**
Run: `npm run verify:fast:branch`  Expected: PASS.
- [ ] **Step 7: Push and open the PR**
```bash
git push -u origin feat/server-3084-w2b-output-cap
gh pr create --title "feat(server,openapi,frontend): Gemini Auto output tokens, thinking window, reasoning overflow (#3084 wave 2b)" --body-file <path-to-body.md>
```
Body:
```markdown
## Summary
- **Gemini catalog** (`server/src/analyzer/catalog/gemini-catalog.ts`): `models.list` filtered to `generateContent` text models, cached 10 min per key, warmed through `ChatTransport.prepare(signal)` before the runner reads settings. The warm-up is bounded at 10 s (the SDK's `httpOptions.timeout` and abort signal, plus its own timer), and shared by concurrent requests. Pause releases that request at once, and the listing is cancelled only when no request still waits. A failed or timed-out listing falls back to a 12000 cap and 8192 output, a successful one re-arms the failure warning, and cached limits are served only for the current key (P26, N6).
- **Auto max output tokens:** `analyzer.gemini.maxOutputTokens` default `0` = Auto (listed `outputTokenLimit`, else 8192), max lifted to 1048576, explicit values kept and clamped to the listed limit; the runner passes the resolved cap to both transports (Ollama keeps `numPredict`).
- **TPM-bound input cap (budget change):** `perRequestInputCap = min(analyzer.gemini.maxInputTokensPerRequest, resolveLimits(model).tpm)`. Defaults are unchanged (every built-in TPM is at least 16000); a `GEMINI_TPM_<SLUG>` env var or a saved `rate.tpm.gemma*` override below 12000 now shrinks chunk bodies to fit it. Pinned in `capacity.test.ts` and announced in both release-notes files.
- **Thinking visibility (P27):** thinking models, by a static id rule and never the live catalog, request `thinkingConfig.includeThoughts`; thought parts feed the heartbeat; `thoughtsTokenCount` → `usage.reasoningTokens` only on those requests, so Gemma keeps its split recovery.
- **Thinking window, request ceiling, timing log (P5):** `analyzer.gemini.thinkingIdleTimeoutMs` (`GEMINI_THINKING_IDLE_MS`, 0–290 000; `0` = automatic: 120 000 ms for a thinking model, the 45 s idle window otherwise; a positive value applies to every model) bounds every silent gap until the first answer text, thought parts included; after that the 45 s watchdog is unchanged. Running out of it before answer text raises `AnalyzerTimeoutError('thinking-idle')` → `analyzer-timeout` naming the setting, never retried, with no retry warning and no `onThrottle`. A model that does not think, at the automatic value, keeps today's retried `GeminiStreamIdleError`. The 290 000 maximum stays below undici's fixed 300 s timeouts on the SDK's global `fetch`. Every attempt is bounded by `analyzer.gemini.requestCeilingMs` (30 min) → `AnalyzerTimeoutError('ceiling')`; the class is pulled forward from wave 3. One `[gemini] stream-timing model=… firstChunkMs=… firstAnswerMs=… thoughtPartsBeforeAnswer=…` line per attempt. Trade-off: a stalled request on a thinking model fails once after up to 120 s instead of two 45 s attempts. Owner approved P5 on 2026-09-13: no probe gate; thinking window default 120 s, adjustable in Advanced Settings.
- **Reasoning overflow (P20):** `length` + no answer text + reasoning evidence → `AnalyzerReasoningOverflowError` / `analyzer-reasoning-overflow` (no split); an empty `MAX_TOKENS` with no evidence (Gemma) still splits. It stops new spend. Both routes' Phase-0 catches rethrow it and Phase 1 already ends the run on its first error; the first rethrow marks the job (`AnalysisJob.reasoningOverflowed`) and empties the book's escalation budget, so chapters still in flight start no escalation window, and `buildNonStoryClassifier` makes no further non-story call. Those chapters are not aborted: they finish and cache for resume, and the job's `halted` snapshot keeps its code (N4). Script-review, emotion and instruct passes stop as they do on a content block or daily quota; the attribution eval's review run rethrows it; an escalation call that overflows still returns `null`, but first reports through the new `StageCall.onReasoningOverflow`, which both routes wire to `noteReasoningOverflow`, so no further window is sent in that chapter or any other. Every chapter dispatch point (main Phase 0, main Phase 1 after the watermark, subset Phase 1) calls `throwIfReasoningOverflowed`, which rethrows the recorded overflow (`AnalysisJob.reasoningOverflowError`), so after an overflow only escalation saw, no later chapter starts and the run halts with the overflow code, as for a rethrown one. Alternative put to the owner (not chosen): skip the chapter and continue. The failure names what happened (chapter, model, engine); its `remediation` ends "Then resume — finished chapters are kept." (Task 2.9). Task 2.9a adds structured `fixes`, rendered as a "How to fix" list in the Analysing view's run-level block and, via `analysis-stream-middleware.ts`'s `AnalysisError` branch (not the view — the view's own stream aborts on unmount), a persistent toast that replaces the plain one under the same `dedupeKey` and survives navigation. Ollama now applies the same rule to an empty `done_reason: length` stream (previously the empty-response error), with `reasoningSeen` from `message.thinking`, and its copy names `num_ctx`. `AnalyzerTimeoutError` keeps its Phase 0 / Phase 1 asymmetry unchanged. Owner approved P20 on 2026-09-13: stop new spend, with a loud, actionable warning (F7).
- **On-box:** register rows **B<next>** (capacity recalibration), **E<next>** (Gemini thinking-window timing, a measurement that gates nothing) and **E<next+1>** (thinking-model output and the Gemma split) — write the minted ids — run sheet §1–§3 created, live view republished.

Also fixed, found in passing: `server/.env.example:293,301` stated the old 8192 default; the `MAX_RESPONSE_BYTES` comment (moved to `transports/gemini-transport.ts` by wave 1; `gemini.ts:62-64` on 46e62a34) named the removed `resolveMaxOutputTokens`.

## Test plan
- [ ] `gemini-catalog.test.ts` (bounded warm-up released per caller and cancelled once abandoned, failure warning re-armed, cache keyed to the active key, static thinking rule), `capacity.test.ts` (Auto and the TPM bound), `stage-runner.test.ts` (`prepare(call.signal)` before settings; escalation returns `null` on an overflow and calls `onReasoningOverflow` once, never for another failure), `escalation.test.ts` (a real runner over an overflowing transport: one overflow stops that chapter's second window and a later chapter's windows), `gemini-transport.test.ts` (`prepare` released after 10 s and on abort), `gemini-transport-thinking.test.ts` (`includeThoughts`, reasoning tokens, heartbeat; on a fake clock, 60 s thought-part gaps not killed, a 121 s silence failing once with no retry warning or `onThrottle`, and the after-answer idle watchdog; positive knob, 290 000 maximum, ceiling, timing line), `finish-reasoning-overflow.test.ts`, `ollama-transport-overflow.test.ts`, chunker no-split pins, `failure-taxonomy.test.ts`, help counts
- [ ] `gemini.test.ts` (slow): Auto wiring, a pre-answer stall for each kind of model and a thinking-window timeout that fails once through the whole analyzer, overflow on `gemini-3.6-flash` and a split on Gemma for the same response; `ollama.test.ts` num_predict wiring
- [ ] `analysis.phase-model.test.ts` (main-route stage 1, subset stage 1 and stage 2 overflows end the run and mark the job without aborting it; `noteReasoningOverflow`; `buildNonStoryClassifier` makes no call after an overflow), `analysis.reasoning-overflow.test.ts` (a positive control reaches escalation; after an overflow an in-flight chapter finishes and caches with no escalation window, and the `halted` snapshot keeps its code; on the main and subset routes, one overflowing escalation call stops every later window, chapter 2's stage-2 call is never sent, and the run halts with the overflow code in a `halted` snapshot; in pipelined mode, Phase 0 casts no further chapter), `script-review.test.ts`, `annotate-emotion.test.ts` and `instruct-annotation.test.ts` (an overflow ends the pass), `review-run.test.ts` (the eval rethrows)
- [ ] `capacity-pinning.test.ts` green, fixture untouched
- [ ] `failure-taxonomy-fixes.test.ts` (the guard: every `settingKey`/`wikiPage` real — `wikiPage` resolved from this test file's own `import.meta.url`, not cwd; the conditional `maxOutputTokens` branch forced to appear via `_seedGeminiCatalogForTest`; a bad `settingKey` proven red; `openai` returns `[]`; the thinking window never offered; the wiki-link entry is last, one per engine, never combined with a `settingKey` on the same fix; Ollama names `numCtx` not `numPredict`), `router.test.ts` (`?focus=` round-trip + `stageEqual`), `failure-fixes.test.ts` (`fixHref`: a settingKey fix links, a label-only fix returns `null`), `wiki-links.test.ts` (`isWikiPage` accepts real pages, rejects an unknown string), `routes/index.test.tsx` (new `renderAtAdvanced` helper; `AdvancedRoute` reads `focus`), `analysis-stream-middleware.test.ts` (a reasoning-overflow `AnalysisError` pushes one toast with `fixes` under `dedupeKey: 'analysis-stream'`, replacing the plain one; any other code still pushes the plain toast with no `fixes`), `analysis-slice.test.ts` (`setHalted({ …, fixes })` stores `activeStream.haltFixes`), `reasoning-overflow-toast.test.tsx` (no auto-dismiss, dismiss button works), `analysing.test.tsx` (run-level "How to fix" list rendering ONLY — the per-chapter block never has `fixes`; the wiki-link entry renders as a link, a `settingKey` entry links to Advanced Settings, a label-only entry is plain text; `haltFixes` renders for a halted run with no live `error`; an unrecognised `wikiPage` renders plain text, no link), `advanced.test.tsx` (scroll-and-highlight via `data-highlighted`, `help.tsx`-pattern ref + once-per-focus guard, `scrollIntoView` restored in `afterEach`), a subset-route (Retry) reasoning-overflow test naming its chapter, built on `runSubsetAnalyzerJob`'s real `(job, record, selection, phase1Selection, toRun, allowStage1ShrinkSubset)` signature (Task 2.9) (Task 2.9a, F7)
- [ ] mutation proofs pasted (Tasks 2.5–2.9, 2.9a)
- [ ] `npm run openapi:types`, `npm run config:check`, `npm run check:onbox-register`, `npm run verify:fast:branch`, `node scripts/tests/knob-docs-sync.test.mjs`
- [ ] `npm run test:e2e` — new mock-mode spec (Task 2.9a Step 8): a seeded reasoning-overflow failure shows the "How to fix" list, a link lands on the highlighted Advanced Settings row, and the toast persists across an in-app navigation
- [ ] On-box: owed as register rows B<next>, E<next> and E<next+1> (the minted ids; not run in this PR)

Refs #3084

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013DFfsAoY1LtxjDgnGPSZkc
```
Before pushing, replace every `<next>`, `<next+1>`, `<2a>`, `<2b>` and `<date>` marker with the minted id, PR number or approval date.
- [ ] **Step 8: Review gate.** Run the `pr-review-gate` skill at depth **high** (the PR spans the server, openapi, frontend and docs scopes). The reviewer confirms that the owner approved P5 and P20, which is the master plan's gate for 2b. Fold findings, then re-run per the skill before merging.
